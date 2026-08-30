import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleAdminGet, handleAdminPost } from "../src/application.js";
import { normalizeAdminOrderDraft, normalizeAdminOrderLine } from "../src/orders.js";

class D1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new D1Statement(this.database, this.sql, values);
  }

  first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  execute() {
    return /^\s*(SELECT|WITH)\b/i.test(this.sql) ? this.all() : this.run();
  }
}

function makeD1(database) {
  return {
    prepare(sql) {
      return new D1Statement(database, sql);
    },
    batch(statements) {
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function applyMigration(database, name) {
  database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
}

function setupDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE avatars (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, legacy_sheet_name TEXT NOT NULL);
    CREATE TABLE catalog_items (
      name TEXT PRIMARY KEY COLLATE NOCASE,
      unit_price_ped REAL,
      image TEXT,
      wiki_url TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE catalog_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_name TEXT NOT NULL COLLATE NOCASE REFERENCES catalog_items(name),
      storage TEXT NOT NULL,
      aisle TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE (item_name, storage, aisle)
    );
    CREATE TABLE inventory_current (
      avatar_id TEXT NOT NULL REFERENCES avatars(id),
      row_key TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      source_id TEXT,
      item_name TEXT NOT NULL COLLATE NOCASE,
      quantity REAL NOT NULL,
      value_ped REAL,
      container TEXT,
      container_ref_id TEXT,
      PRIMARY KEY (avatar_id, row_key)
    ) WITHOUT ROWID;
    CREATE TABLE container_config (
      avatar_id TEXT NOT NULL REFERENCES avatars(id),
      container_key TEXT NOT NULL,
      container TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (avatar_id, container_key)
    ) WITHOUT ROWID;
    CREATE VIEW saleable_inventory AS
      SELECT ii.* FROM inventory_current ii
      JOIN container_config cc
        ON cc.avatar_id = ii.avatar_id
       AND cc.container_key = lower(trim(coalesce(ii.container, '')))
        AND cc.enabled = 1;
    CREATE TABLE market_current (
      item_name TEXT PRIMARY KEY COLLATE NOCASE,
      weighted_kind TEXT,
      weighted_value REAL,
      observed_at TEXT
    );
  `);
  applyMigration(database, "0007_purchase_requests.sql");
  applyMigration(database, "0008_order_discord_notifications.sql");
  applyMigration(database, "0009_order_proposals.sql");
  applyMigration(database, "0016_purchase_order_history.sql");
  applyMigration(database, "0018_purchase_order_tracking_tokens.sql");
  applyMigration(database, "0021_purchase_order_discounts.sql");
  database.exec(`
    INSERT INTO avatars VALUES ('enzo', 'Enzo', 'Inventaire Enzo');
    INSERT INTO catalog_items (name, unit_price_ped) VALUES ('Item A', 10), ('Item B', 5), ('Sans stock', 2);
    INSERT INTO catalog_listings (item_name, storage, aisle) VALUES
      ('Item A', 'ARMORS', 'PARTS'),
      ('Item B', 'MATERIALS', 'MINERALS'),
      ('Sans stock', 'MATERIALS', 'MINERALS');
    INSERT INTO container_config (avatar_id, container_key, container, enabled)
      VALUES ('enzo', 'carried', 'Carried', 1);
    INSERT INTO inventory_current (avatar_id, row_key, line_no, item_name, quantity, container) VALUES
      ('enzo', 'a', 1, 'Item A', 5, 'Carried'),
      ('enzo', 'b', 2, 'Item B', 3, 'Carried'),
      ('enzo', 'c', 3, 'Sans stock', 0, 'Carried');
    INSERT INTO market_current (item_name, weighted_kind, weighted_value, observed_at) VALUES
      ('Item A', 'percent', 1.2, CURRENT_TIMESTAMP),
      ('Item B', 'ped', 2.5, CURRENT_TIMESTAMP);
  `);
  return database;
}

const lineA = { itemName: "Item A", storage: "ARMORS", aisle: "PARTS", quantity: 2, markupKind: "percent", markupAmount: 110 };
const lineB = { itemName: "Item B", storage: "MATERIALS", aisle: "MINERALS", quantity: 1, markupKind: "ped", markupAmount: 1.25 };

test("d.12 valide les saisies directes et limite la MU à deux décimales", () => {
  assert.equal(normalizeAdminOrderDraft({ buyerAvatar: " Enzo ", frjMember: true, items: [lineA] }).buyerAvatar, "Enzo");
  assert.throws(() => normalizeAdminOrderLine({ ...lineA, markupAmount: 1.234 }), /2 décimales/);
  assert.throws(() => normalizeAdminOrderLine({ ...lineA, markupKind: "none" }), /Type de MU/);
  assert.throws(() => normalizeAdminOrderDraft({ buyerAvatar: "Enzo", items: [lineA, lineA] }), /une seule fois/);
});

test("d.12 expose seulement les listings possédant un stock vendable", async () => {
  const database = setupDatabase();
  const response = await handleAdminGet(new URL("https://api.example/admin/orders/catalog"), { DB: makeD1(database) });
  const result = await response.json();
  assert.deepEqual(result.items.map((item) => item.itemName), ["Item A", "Item B"]);
  assert.equal(result.items[0].availableStock, 5);
  assert.deepEqual(
    result.items.map(({ markupKind, markupValue }) => ({ markupKind, markupValue })),
    [
      { markupKind: "percent", markupValue: 1.2 },
      { markupKind: "ped", markupValue: 2.5 }
    ]
  );
});

test("d.12 crée atomiquement une demande directe à valider et son lien privé", async () => {
  const database = setupDatabase();
  const env = { DB: makeD1(database), CART_ENABLED: "true" };
  const url = new URL("https://api.example/admin/orders");
  const response = await handleAdminPost(new Request(url, {
    method: "POST",
    body: JSON.stringify({ buyerAvatar: "Direct Buyer", frjMember: true, items: [lineA, lineB] })
  }), url, env);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.match(result.order.publicReference, /^FRJ-\d{8}-[A-F0-9]{6}$/);
  assert.equal(result.order.status, "awaiting_approval");
  assert.equal(result.order.proposalVersion, 1);
  assert.equal(result.order.totalSalePed, 28.25);
  assert.match(result.accessToken, /^[a-f0-9-]{70,80}$/i);
  assert.match(result.trackingPath, /^suivi-commande\.html\?token=/);

  const stored = database.prepare(`SELECT * FROM purchase_orders`).get();
  assert.equal(stored.source_backend, "d1-admin");
  assert.equal(stored.status, "submitted");
  assert.equal(stored.approval_required, 1);
  assert.equal(stored.proposal_version, 1);
  assert.equal(stored.access_token_hash, createHash("sha256").update(result.accessToken).digest("hex"));
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM purchase_order_items`).get().count, 2);
  const history = database.prepare(`SELECT action, actor FROM purchase_order_events WHERE action = 'admin-created'`).get();
  assert.equal(history.action, "admin-created");
  assert.equal(history.actor, "admin");
});

test("d.12 ajoute une ligne, recalcule la proposition et refuse les doublons", async () => {
  const database = setupDatabase();
  const env = { DB: makeD1(database), CART_ENABLED: "true" };
  const createUrl = new URL("https://api.example/admin/orders");
  const created = await (await handleAdminPost(new Request(createUrl, {
    method: "POST",
    body: JSON.stringify({ buyerAvatar: "Direct Buyer", frjMember: false, items: [lineA] })
  }), createUrl, env)).json();
  const addUrl = new URL(`https://api.example/admin/orders/${created.order.id}/items`);
  const response = await handleAdminPost(new Request(addUrl, {
    method: "POST",
    body: JSON.stringify(lineB)
  }), addUrl, env);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.proposalVersion, 2);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM purchase_order_items`).get().count, 2);
  const stored = database.prepare(`SELECT total_sale_ped, approval_required, proposal_version FROM purchase_orders`).get();
  assert.equal(stored.total_sale_ped, 28.25);
  assert.equal(stored.approval_required, 1);
  assert.equal(stored.proposal_version, 2);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM purchase_order_events WHERE action = 'proposal-line-added'`).get().count, 1);

  await assert.rejects(
    () => handleAdminPost(new Request(addUrl, { method: "POST", body: JSON.stringify(lineB) }), addUrl, env),
    (error) => error.status === 409 && /déjà présent/.test(error.message)
  );
});
