import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleAdminGet, handleAdminPost, handleScheduledDiscountGeneration } from "../src/application.js";

class Statement {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  first() { return this.db.prepare(this.sql).get(...this.values) || null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.values) }; }
  run() { const result = this.db.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
  execute() { return /^\s*(SELECT|WITH)\b/i.test(this.sql) ? this.all() : this.run(); }
}

function makeD1(db) {
  return {
    prepare: (sql) => new Statement(db, sql),
    batch(statements) {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promotion_date TEXT NOT NULL, storage TEXT NOT NULL, aisle TEXT NOT NULL,
      discount_rate REAL NOT NULL CHECK(discount_rate >= 0 AND discount_rate <= 1),
      UNIQUE(promotion_date, storage, aisle)
    );
    CREATE TABLE catalog_listings (
      item_name TEXT NOT NULL COLLATE NOCASE, storage TEXT NOT NULL, aisle TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, UNIQUE(item_name, storage, aisle)
    );
    CREATE TABLE inventory_current (
      avatar_id TEXT NOT NULL, row_key TEXT NOT NULL, item_name TEXT NOT NULL COLLATE NOCASE,
      quantity REAL NOT NULL, container TEXT, PRIMARY KEY(avatar_id, row_key)
    ) WITHOUT ROWID;
    CREATE TABLE container_config (
      avatar_id TEXT NOT NULL, container_key TEXT NOT NULL, enabled INTEGER NOT NULL,
      PRIMARY KEY(avatar_id, container_key)
    ) WITHOUT ROWID;
    CREATE VIEW saleable_inventory AS
      SELECT ii.* FROM inventory_current ii JOIN container_config cc
      ON cc.avatar_id = ii.avatar_id AND cc.container_key = lower(trim(coalesce(ii.container, ''))) AND cc.enabled = 1;
    CREATE TABLE market_current (
      item_name TEXT PRIMARY KEY COLLATE NOCASE, weighted_kind TEXT, weighted_value REAL, observed_at TEXT
    );
    CREATE TABLE sync_state (
      dataset_key TEXT PRIMARY KEY, content_checksum TEXT NOT NULL, source_updated_at TEXT NOT NULL,
      source_origin TEXT NOT NULL, import_id TEXT NOT NULL, row_count INTEGER NOT NULL,
      synchronized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sync_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_key TEXT NOT NULL, direction TEXT NOT NULL,
      action TEXT NOT NULL, source_checksum TEXT, target_checksum TEXT, details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sync_baseline (
      dataset_key TEXT PRIMARY KEY, content_checksum TEXT NOT NULL, source_updated_at TEXT NOT NULL,
      row_count INTEGER NOT NULL, rows_json TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) WITHOUT ROWID;
    INSERT INTO promotions(promotion_date, storage, aisle, discount_rate)
      VALUES ('2026-08-20', 'Armors', 'Parts', 0.05);
    INSERT INTO container_config VALUES ('enzo', 'carried', 1);
    INSERT INTO catalog_listings VALUES ('Item A', 'ARMORS', 'PARTS', 1), ('Item B', 'MATERIALS', 'ORES', 1);
    INSERT INTO inventory_current VALUES ('enzo', 'a', 'Item A', 2, 'Carried'), ('enzo', 'b', 'Item B', 3, 'Carried');
    INSERT INTO market_current VALUES
      ('Item A', 'percent', 1.2, CURRENT_TIMESTAMP), ('Item B', 'ped', 1.5, CURRENT_TIMESTAMP);
  `);
  db.exec(readFileSync(new URL("../migrations/0020_discount_campaigns.sql", import.meta.url), "utf8"));
  return db;
}

async function post(env, path, payload) {
  const url = new URL(`https://api.example${path}`);
  return handleAdminPost(new Request(url, { method: "POST", body: JSON.stringify(payload) }), url, env);
}

test("d.9.2 migre la promotion historique et conserve la vue compatible", () => {
  const db = setup();
  const row = db.prepare("SELECT promotion_date, storage, aisle, discount_rate FROM promotions").get();
  assert.deepEqual({ ...row }, { promotion_date: "2026-08-20", storage: "ARMORS", aisle: "PARTS", discount_rate: 0.05 });
  assert.equal(db.prepare("SELECT default_promotion_rate FROM discount_config").get().default_promotion_rate, 0.05);
  db.close();
});

test("d.9.2 expose et modifie la configuration Admin", async () => {
  const db = setup();
  const env = { DB: makeD1(db) };
  let response = await handleAdminGet(new URL("https://api.example/admin/discounts"), env);
  assert.equal((await response.json()).config.defaultPromotionRate, 0.05);
  response = await post(env, "/admin/discounts/config", {
    automaticPromotionsEnabled: false, defaultPromotionRate: 0.08
  });
  assert.deepEqual((await response.json()).config.automaticPromotionsEnabled, false);
  assert.equal(db.prepare("SELECT default_promotion_rate FROM discount_config").get().default_promotion_rate, 0.08);
  db.close();
});

test("d.9.2 crée et modifie une promotion manuelle éligible", async () => {
  const db = setup();
  const env = { DB: makeD1(db) };
  let response = await post(env, "/admin/discounts/campaigns", {
    type: "daily_promo", date: "2026-08-30", storage: "Armors", aisle: "Parts", discountRate: 0.07
  });
  assert.equal(response.status, 201);
  const created = (await response.json()).campaign;
  assert.equal(created.origin, "manual");
  response = await post(env, `/admin/discounts/campaigns/${created.id}`, { discountRate: 0.09 });
  assert.equal((await response.json()).campaign.discountRate, 0.09);
  db.close();
});

test("une campagne passée est exposée en lecture seule et ne peut plus être modifiée", async () => {
  const db = setup();
  const env = { DB: makeD1(db) };
  const administration = await (await handleAdminGet(new URL("https://api.example/admin/discounts"), env)).json();
  const legacy = administration.campaigns.find((campaign) => campaign.id === "legacy-promo-1");
  assert.equal(legacy.editable, false);
  await assert.rejects(
    () => post(env, "/admin/discounts/campaigns/legacy-promo-1", { discountRate: 0.09 }),
    /terminée.*lecture seule/
  );
  assert.equal(db.prepare("SELECT discount_rate FROM discount_campaigns WHERE id = 'legacy-promo-1'").get().discount_rate, 0.05);
  db.close();
});

test("d.9.2 refuse couple inéligible, répétition et soldes chevauchantes", async () => {
  const db = setup();
  const env = { DB: makeD1(db) };
  await assert.rejects(() => post(env, "/admin/discounts/campaigns", {
    type: "daily_promo", date: "2026-08-30", storage: "VOID", aisle: "NONE", discountRate: 0.05
  }), /aucun article disponible/);
  await post(env, "/admin/discounts/campaigns", {
    type: "sale", startsOn: "2026-09-01", endsOn: "2026-09-07", discountRate: 0.1
  });
  await assert.rejects(() => post(env, "/admin/discounts/campaigns", {
    type: "sale", startsOn: "2026-09-07", endsOn: "2026-09-10", discountRate: 0.15
  }), /ne peuvent pas se chevaucher/);
  db.close();
});

test("d.9.4 le cron matérialise la promotion et signale sa synchronisation", async () => {
  const db = setup();
  for (let index = 3; index <= 7; index += 1) {
    db.prepare("INSERT INTO catalog_listings VALUES (?, ?, ?, 1)").run(`Item ${index}`, `CAT ${index}`, `AISLE ${index}`);
    db.prepare("INSERT INTO inventory_current VALUES ('enzo', ?, ?, 1, 'Carried')").run(`row-${index}`, `Item ${index}`);
    db.prepare("INSERT INTO market_current VALUES (?, 'percent', 1.1, CURRENT_TIMESTAMP)").run(`Item ${index}`);
  }
  const result = await handleScheduledDiscountGeneration({ DB: makeD1(db) });
  assert.equal(result.reason, "GENERATED");
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM discount_campaigns WHERE origin = 'automatic'").get().total, 1);
  const signal = db.prepare("SELECT details FROM sync_audit WHERE action = 'sync-requested' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(signal.details).dataset, "discounts");
  db.close();
});
