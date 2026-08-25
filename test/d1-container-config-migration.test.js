import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migration = await readFile(
  new URL("../cloudflare/for-sale-api/migrations/0011_container_config.sql", import.meta.url),
  "utf8"
);
const idempotentDiscoveryMigration = await readFile(
  new URL("../cloudflare/for-sale-api/migrations/0015_idempotent_container_discovery.sql", import.meta.url),
  "utf8"
);

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE avatars (id TEXT PRIMARY KEY);
    INSERT INTO avatars (id) VALUES ('enzo'), ('arkaman'), ('kenza'), ('nocturnal');
    CREATE TABLE inventory_current (
      avatar_id TEXT NOT NULL REFERENCES avatars(id),
      row_key TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      item_name TEXT NOT NULL COLLATE NOCASE,
      quantity REAL NOT NULL,
      container TEXT,
      PRIMARY KEY (avatar_id, row_key)
    ) WITHOUT ROWID;
  `);
  return database;
}

function insertInventory(database, avatar, rowKey, item, container) {
  database.prepare(`
    INSERT INTO inventory_current (
      avatar_id, row_key, line_no, item_name, quantity, container
    ) VALUES (?, ?, 1, ?, 1, ?)
  `).run(avatar, rowKey, item, container);
}

test("d.8.1 initialise les conteneurs sans changer le filtre D1 actuel", () => {
  const database = createDatabase();
  insertInventory(database, "enzo", "enzo-1", "Item A", "STORAGE (Calypso)");
  insertInventory(database, "enzo", "enzo-2", "Item B", "storage (calypso)");
  insertInventory(database, "enzo", "enzo-3", "Item C", "Blueprints: Cyrene Redux");
  insertInventory(database, "enzo", "enzo-4", "Item D", "Arkadia Limited (C)");
  insertInventory(database, "arkaman", "arkaman-1", "Item E", "CARRIED");

  database.exec(migration);

  const rows = database.prepare(`
    SELECT avatar_id, container_key, container, enabled
    FROM container_config
    ORDER BY avatar_id, container_key
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    {
      avatar_id: "arkaman",
      container_key: "carried",
      container: "CARRIED",
      enabled: 0
    },
    {
      avatar_id: "enzo",
      container_key: "arkadia limited (c)",
      container: "Arkadia Limited (C)",
      enabled: 1
    },
    {
      avatar_id: "enzo",
      container_key: "blueprints: cyrene redux",
      container: "Blueprints: Cyrene Redux",
      enabled: 0
    },
    {
      avatar_id: "enzo",
      container_key: "storage (calypso)",
      container: "STORAGE (Calypso)",
      enabled: 1
    }
  ]);
  assert.throws(
    () => database.prepare("UPDATE container_config SET enabled = 2").run(),
    /CHECK constraint failed/
  );
  database.close();
});

test("d.8.1 découvre uniquement par ajout et conserve les anciens conteneurs", () => {
  const database = createDatabase();
  insertInventory(database, "enzo", "enzo-1", "Item A", "CARRIED");
  database.exec(migration);
  database.prepare(`
    UPDATE container_config
    SET enabled = 1
    WHERE avatar_id = 'enzo' AND container_key = 'carried'
  `).run();

  insertInventory(database, "enzo", "enzo-2", "Item B", "Nouveau Coffre");
  database.prepare(`
    UPDATE inventory_current
    SET container = 'Coffre Renommé'
    WHERE avatar_id = 'enzo' AND row_key = 'enzo-2'
  `).run();
  database.prepare(`
    DELETE FROM inventory_current
    WHERE avatar_id = 'enzo'
  `).run();

  const rows = database.prepare(`
    SELECT container, enabled
    FROM container_config
    WHERE avatar_id = 'enzo'
    ORDER BY container_key
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { container: "CARRIED", enabled: 1 },
    { container: "Coffre Renommé", enabled: 0 },
    { container: "Nouveau Coffre", enabled: 0 }
  ]);
  database.close();
});

test("la découverte reste idempotente pendant un UPSERT groupé d'inventaire", () => {
  const database = createDatabase();
  insertInventory(database, "enzo", "enzo-1", "Item A", "CARRIED");
  database.exec(migration);
  database.exec(idempotentDiscoveryMigration);
  database.prepare(`
    UPDATE container_config
    SET enabled = 1
    WHERE avatar_id = 'enzo' AND container_key = 'carried'
  `).run();

  const rows = JSON.stringify([
    { rowKey: "enzo-1", lineNo: 1, itemName: "Item A", quantity: 2, container: "CARRIED" },
    { rowKey: "enzo-2", lineNo: 2, itemName: "Item B", quantity: 1, container: "Nouveau Coffre" },
    { rowKey: "enzo-3", lineNo: 3, itemName: "Item C", quantity: 1, container: " nouveau coffre " }
  ]);
  database.prepare(`
    INSERT INTO inventory_current (
      avatar_id, row_key, line_no, item_name, quantity, container
    )
    SELECT
      'enzo',
      json_extract(value, '$.rowKey'),
      CAST(json_extract(value, '$.lineNo') AS INTEGER),
      json_extract(value, '$.itemName'),
      CAST(json_extract(value, '$.quantity') AS REAL),
      json_extract(value, '$.container')
    FROM json_each(?)
    WHERE true
    ON CONFLICT (avatar_id, row_key) DO UPDATE SET
      item_name = excluded.item_name,
      quantity = excluded.quantity,
      container = excluded.container
  `).run(rows);

  const containers = database.prepare(`
    SELECT container_key, container, enabled
    FROM container_config
    WHERE avatar_id = 'enzo'
    ORDER BY container_key
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(containers, [
    { container_key: "carried", container: "CARRIED", enabled: 1 },
    { container_key: "nouveau coffre", container: "Nouveau Coffre", enabled: 0 }
  ]);
  database.close();
});
