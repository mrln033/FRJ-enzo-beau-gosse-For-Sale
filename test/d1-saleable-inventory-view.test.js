import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrations = await Promise.all([
  "0011_container_config.sql",
  "0012_saleable_inventory_view.sql"
].map((name) => readFile(
  new URL(`../cloudflare/for-sale-api/migrations/${name}`, import.meta.url),
  "utf8"
)));

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE avatars (id TEXT PRIMARY KEY);
    INSERT INTO avatars (id) VALUES ('enzo'), ('arkaman');
    CREATE TABLE inventory_current (
      avatar_id TEXT NOT NULL REFERENCES avatars(id),
      row_key TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      item_name TEXT NOT NULL COLLATE NOCASE,
      quantity REAL NOT NULL,
      container TEXT,
      PRIMARY KEY (avatar_id, row_key)
    ) WITHOUT ROWID;
    CREATE INDEX idx_inventory_current_avatar_item
      ON inventory_current (avatar_id, item_name);
    INSERT INTO inventory_current (
      avatar_id, row_key, line_no, item_name, quantity, container
    ) VALUES
      ('enzo', 'enzo-1', 1, 'Item A', 2, 'CARRIED'),
      ('enzo', 'enzo-2', 2, 'Item A', 3, 'Blueprints: Cyrene Redux'),
      ('enzo', 'enzo-3', 3, 'Item B', 4, 'Storage (Calypso)'),
      ('arkaman', 'arkaman-1', 1, 'Item A', 20, 'CARRIED');
  `);
  migrations.forEach((migration) => database.exec(migration));
  return database;
}

function saleableQuantities(database, avatar = "enzo") {
  return database.prepare(`
    SELECT item_name, SUM(quantity) AS quantity
    FROM saleable_inventory
    WHERE avatar_id = ?
    GROUP BY item_name COLLATE NOCASE
    ORDER BY item_name COLLATE NOCASE
  `).all(avatar).map((row) => ({ ...row }));
}

test("d.8.2 conserve exactement les quantités de l'ancien filtre", () => {
  const database = createDatabase();

  assert.deepEqual(saleableQuantities(database), [
    { item_name: "Item A", quantity: 2 },
    { item_name: "Item B", quantity: 4 }
  ]);
  assert.deepEqual(saleableQuantities(database, "arkaman"), []);
  database.close();
});

test("d.8.2 applique immédiatement la configuration sans modifier le Worker", () => {
  const database = createDatabase();
  database.prepare(`
    UPDATE container_config
    SET enabled = 1
    WHERE avatar_id = 'enzo'
      AND container_key = 'blueprints: cyrene redux'
  `).run();

  assert.deepEqual(saleableQuantities(database), [
    { item_name: "Item A", quantity: 5 },
    { item_name: "Item B", quantity: 4 }
  ]);
  database.close();
});
