import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const applicationSource = await readFile(
  new URL("../cloudflare/for-sale-api/src/application.js", import.meta.url),
  "utf8"
);

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE catalog_items (
      name TEXT PRIMARY KEY COLLATE NOCASE,
      unit_price_ped REAL,
      image TEXT,
      wiki_url TEXT
    );
    CREATE TABLE catalog_listings (
      id INTEGER PRIMARY KEY,
      item_name TEXT NOT NULL COLLATE NOCASE,
      storage TEXT NOT NULL,
      aisle TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      UNIQUE (item_name, storage, aisle)
    );
    CREATE INDEX idx_catalog_listings_storage_aisle
      ON catalog_listings (storage, aisle, enabled);
    CREATE TABLE inventory_current (
      avatar_id TEXT NOT NULL,
      row_key TEXT NOT NULL,
      item_name TEXT NOT NULL COLLATE NOCASE,
      quantity REAL NOT NULL,
      container TEXT,
      PRIMARY KEY (avatar_id, row_key)
    ) WITHOUT ROWID;
    CREATE INDEX idx_inventory_current_avatar_item
      ON inventory_current (avatar_id, item_name);
    CREATE TABLE container_config (
      avatar_id TEXT NOT NULL,
      container_key TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      PRIMARY KEY (avatar_id, container_key)
    ) WITHOUT ROWID;
    CREATE TABLE market_current (
      item_name TEXT PRIMARY KEY COLLATE NOCASE,
      weighted_display TEXT,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE promotions (
      promotion_date TEXT NOT NULL,
      storage TEXT NOT NULL,
      aisle TEXT NOT NULL,
      discount_rate REAL NOT NULL,
      UNIQUE (promotion_date, storage, aisle)
    );
    CREATE VIEW saleable_inventory AS
    SELECT ii.*
    FROM inventory_current ii
    JOIN container_config cc
      ON cc.avatar_id = ii.avatar_id
     AND cc.container_key = lower(trim(coalesce(ii.container, '')))
     AND cc.enabled = 1;

    INSERT INTO catalog_items VALUES
      ('Item A', 2.5, 'a.png', 'https://example.test/a'),
      ('Item B', 3, 'b.png', NULL),
      ('Item C', 4, NULL, 'https://example.test/c'),
      ('Item D', 5, NULL, NULL);
    INSERT INTO catalog_listings (item_name, storage, aisle, enabled) VALUES
      ('Item A', 'ARMORS', 'PARTS', 1),
      ('Item B', 'ARMORS', 'PARTS', 1),
      ('Item C', 'WEAPONS', 'LASER', 1),
      ('Item D', 'MISCELLANEOUS', 'OTHER', 1);
    INSERT INTO container_config VALUES
      ('enzo', 'carried', 1),
      ('enzo', 'storage', 1),
      ('enzo', 'hidden', 0);
    INSERT INTO inventory_current VALUES
      ('enzo', 'a-1', 'Item A', 2, 'CARRIED'),
      ('enzo', 'a-2', 'item a', 3, 'Storage'),
      ('enzo', 'a-hidden', 'Item A', 10, 'Hidden'),
      ('enzo', 'b-1', 'Item B', 0, 'CARRIED'),
      ('enzo', 'c-1', 'Item C', 1, 'CARRIED'),
      ('enzo', 'd-1', 'Item D', -1, 'CARRIED');
    INSERT INTO market_current VALUES
      ('Item A', '105,00 %', datetime('now')),
      ('Item C', '110,00 %', datetime('now', '-8 days'));
    INSERT INTO promotions VALUES (date('now'), 'ARMORS', 'PARTS', 0.05);
  `);
  return database;
}

const legacyCategorySql = `
  SELECT l.storage
  FROM catalog_listings l
  JOIN catalog_items c ON c.name = l.item_name COLLATE NOCASE
  JOIN saleable_inventory ii
    ON ii.avatar_id = 'enzo'
   AND ii.item_name = c.name COLLATE NOCASE
  WHERE l.enabled = 1 AND l.storage <> '' AND l.aisle <> ''
  GROUP BY l.storage
  HAVING SUM(ii.quantity) > 0
  ORDER BY l.storage
`;

const optimizedCategorySql = `
  SELECT DISTINCT l.storage
  FROM catalog_listings l
  WHERE l.enabled = 1 AND l.storage <> '' AND l.aisle <> ''
    AND EXISTS (
      SELECT 1 FROM saleable_inventory ii
      WHERE ii.avatar_id = 'enzo'
        AND ii.item_name = l.item_name COLLATE NOCASE
      GROUP BY ii.item_name COLLATE NOCASE
      HAVING SUM(ii.quantity) > 0
    )
  ORDER BY l.storage
`;

function detailSql(optimized) {
  if (!optimized) return `
    WITH inventory AS (
      SELECT ii.item_name, SUM(ii.quantity) AS quantity
      FROM saleable_inventory ii
      WHERE ii.avatar_id = 'enzo'
      GROUP BY ii.item_name COLLATE NOCASE
    ), recent_market AS (
      SELECT item_name, weighted_display, observed_at FROM market_current
      WHERE datetime(observed_at) >= datetime('now', '-7 days')
    )
    SELECT l.storage AS STORAGE, l.aisle AS RAYON, c.name AS ITEM,
      inventory.quantity AS QUANTITE, c.unit_price_ped AS PRIX_UNITAIRE,
      c.image AS IMAGE, c.wiki_url AS LIEN_WIKI,
      recent_market.observed_at AS DATE_MU_ISO,
      recent_market.weighted_display AS MU,
      COALESCE(p.discount_rate, '') AS Remise_Promo
    FROM catalog_listings l
    JOIN catalog_items c ON c.name = l.item_name COLLATE NOCASE
    JOIN inventory ON inventory.item_name = c.name COLLATE NOCASE
    LEFT JOIN recent_market ON recent_market.item_name = c.name COLLATE NOCASE
    LEFT JOIN promotions p ON p.promotion_date = date('now')
      AND p.storage = l.storage AND p.aisle = l.aisle
    WHERE l.enabled = 1 AND l.storage = ? COLLATE NOCASE
      AND inventory.quantity > 0
    ORDER BY c.name COLLATE NOCASE
  `;
  return `
    SELECT l.storage AS STORAGE, l.aisle AS RAYON, c.name AS ITEM,
      SUM(ii.quantity) AS QUANTITE, c.unit_price_ped AS PRIX_UNITAIRE,
      c.image AS IMAGE, c.wiki_url AS LIEN_WIKI,
      mo.observed_at AS DATE_MU_ISO, mo.weighted_display AS MU,
      COALESCE(p.discount_rate, '') AS Remise_Promo
    FROM catalog_listings l
    JOIN catalog_items c ON c.name = l.item_name COLLATE NOCASE
    JOIN saleable_inventory ii ON ii.avatar_id = 'enzo'
      AND ii.item_name = c.name COLLATE NOCASE
    LEFT JOIN market_current mo ON mo.item_name = c.name COLLATE NOCASE
      AND datetime(mo.observed_at) >= datetime('now', '-7 days')
    LEFT JOIN promotions p ON p.promotion_date = date('now')
      AND p.storage = l.storage AND p.aisle = l.aisle
    WHERE l.enabled = 1 AND l.storage = ? COLLATE NOCASE
    GROUP BY l.storage, l.aisle, c.name, c.unit_price_ped, c.image, c.wiki_url,
      mo.observed_at, mo.weighted_display, p.discount_rate
    HAVING SUM(ii.quantity) > 0
    ORDER BY c.name COLLATE NOCASE
  `;
}

test("d.6.3 branche les lectures publiques sur les recherches ciblées", () => {
  assert.match(applicationSource, /SELECT DISTINCT l\.storage/);
  assert.match(applicationSource, /JOIN saleable_inventory ii[\s\S]*HAVING SUM\(ii\.quantity\) > 0/);
  assert.doesNotMatch(applicationSource, /WITH inventory AS \(/);
});

test("d.6.3 conserve les catégories publiques", () => {
  const database = createDatabase();
  const legacy = database.prepare(legacyCategorySql).all().map((row) => row.storage);
  const optimized = database.prepare(optimizedCategorySql).all().map((row) => row.storage);
  assert.deepEqual(optimized, legacy);
  assert.deepEqual(optimized, ["ARMORS", "WEAPONS"]);
  database.close();
});

test("d.6.3 conserve toutes les colonnes du détail d'une catégorie", () => {
  const database = createDatabase();
  const legacy = database.prepare(detailSql(false)).all("ARMORS").map((row) => ({ ...row }));
  const optimized = database.prepare(detailSql(true)).all("ARMORS").map((row) => ({ ...row }));
  assert.deepEqual(optimized, legacy);
  assert.deepEqual(optimized.map((row) => ({ item: row.ITEM, quantity: row.QUANTITE })), [
    { item: "Item A", quantity: 5 }
  ]);
  database.close();
});
