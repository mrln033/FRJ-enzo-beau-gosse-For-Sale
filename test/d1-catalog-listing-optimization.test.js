import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migration = await readFile(
  new URL("../cloudflare/for-sale-api/migrations/0014_catalog_listing_lookup.sql", import.meta.url),
  "utf8"
);
const applicationSource = await readFile(
  new URL("../cloudflare/for-sale-api/src/application.js", import.meta.url),
  "utf8"
);

const incomingRows = [
  {
    rowKey: "listing:item a|armors|parts#1",
    lineNo: 1,
    itemName: "item a",
    storage: "ARMORS",
    aisle: "PARTS",
    enabled: 1
  },
  {
    rowKey: "listing:item a|armors|parts#2",
    lineNo: 2,
    itemName: "Item A",
    storage: "ARMORS",
    aisle: "PARTS",
    enabled: 0
  },
  {
    rowKey: "listing:item c|weapons|laser#1",
    lineNo: 3,
    itemName: "Item C",
    storage: "WEAPONS",
    aisle: "LASER",
    enabled: 1
  }
];

function createDatabase(withIndex) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE catalog_current (
      row_key TEXT PRIMARY KEY,
      line_no INTEGER NOT NULL,
      item_name TEXT NOT NULL COLLATE NOCASE,
      storage TEXT NOT NULL,
      aisle TEXT NOT NULL,
      enabled INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE catalog_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_name TEXT NOT NULL COLLATE NOCASE,
      storage TEXT NOT NULL,
      aisle TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      UNIQUE (item_name, storage, aisle)
    );
    INSERT INTO catalog_listings (item_name, storage, aisle, enabled) VALUES
      ('Item A', 'ARMORS', 'PARTS', 1),
      ('Item B', 'ARMORS', 'PLATES', 1),
      ('Item C', 'WEAPONS', 'LASER', 1),
      ('Item C', 'WEAPONS', 'BLADES', 1);
  `);
  const insert = database.prepare(`
    INSERT INTO catalog_current (
      row_key, line_no, item_name, storage, aisle, enabled
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  incomingRows.forEach((row) => insert.run(
    row.rowKey, row.lineNo, row.itemName, row.storage, row.aisle, row.enabled
  ));
  if (withIndex) database.exec(migration);
  return database;
}

function listingKeys(database) {
  return database.prepare(`
    SELECT lower(item_name) || '|' || storage || '|' || aisle AS listing_key
    FROM catalog_listings
    ORDER BY listing_key
  `).all().map((row) => row.listing_key);
}

test("d.6.2 branche le Worker sur le snapshot courant plutôt que sur le JSON", () => {
  assert.match(applicationSource, /FROM catalog_current AS current/);
  assert.doesNotMatch(applicationSource, /SELECT 1 FROM json_each\(\?\) incoming/);
});

test("d.6.2 conserve exactement les mêmes listings que la comparaison JSON", () => {
  const legacy = createDatabase(false);
  const optimized = createDatabase(true);
  const payload = JSON.stringify(incomingRows);

  legacy.prepare(`
    DELETE FROM catalog_listings AS listing
    WHERE NOT EXISTS (
      SELECT 1 FROM json_each(?) incoming
      WHERE lower(trim(json_extract(incoming.value, '$.itemName'))) = lower(listing.item_name)
        AND upper(trim(json_extract(incoming.value, '$.storage'))) = listing.storage
        AND upper(trim(json_extract(incoming.value, '$.aisle'))) = listing.aisle
    )
  `).run(payload);

  optimized.exec(`
    DELETE FROM catalog_listings AS listing
    WHERE NOT EXISTS (
      SELECT 1
      FROM catalog_current AS current
      WHERE current.item_name = listing.item_name
        AND current.storage = listing.storage
        AND current.aisle = listing.aisle
    )
  `);

  assert.deepEqual(listingKeys(optimized), listingKeys(legacy));
  assert.deepEqual(listingKeys(optimized), [
    "item a|ARMORS|PARTS",
    "item c|WEAPONS|LASER"
  ]);
  legacy.close();
  optimized.close();
});

test("d.6.2 recherche chaque listing par l'index du snapshot courant", () => {
  const database = createDatabase(true);
  const plan = database.prepare(`
    EXPLAIN QUERY PLAN
    DELETE FROM catalog_listings AS listing
    WHERE NOT EXISTS (
      SELECT 1
      FROM catalog_current AS current
      WHERE current.item_name = listing.item_name
        AND current.storage = listing.storage
        AND current.aisle = listing.aisle
    )
  `).all().map((row) => row.detail).join("\n");

  assert.match(plan, /idx_catalog_current_listing_key/);
  database.close();
});
