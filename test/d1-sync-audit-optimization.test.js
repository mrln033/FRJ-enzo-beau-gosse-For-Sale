import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migration = await readFile(
  new URL("../cloudflare/for-sale-api/migrations/0013_sync_audit_read_indexes.sql", import.meta.url),
  "utf8"
);

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE sync_state (
      dataset_key TEXT PRIMARY KEY,
      content_checksum TEXT NOT NULL DEFAULT '',
      source_updated_at TEXT NOT NULL DEFAULT '',
      source_origin TEXT NOT NULL DEFAULT '',
      import_id TEXT NOT NULL DEFAULT '',
      row_count INTEGER NOT NULL DEFAULT 0,
      synchronized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sync_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_key TEXT NOT NULL,
      direction TEXT NOT NULL,
      action TEXT NOT NULL,
      source_checksum TEXT,
      target_checksum TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_sync_audit_dataset_date
      ON sync_audit (dataset_key, created_at DESC);
  `);
  database.exec(migration);
  return database;
}

test("d.6.1 crée les index ciblés utilisés par le poll et le rapport", () => {
  const database = createDatabase();
  const indexes = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'sync_audit'
    ORDER BY name
  `).all().map((row) => row.name);

  assert.deepEqual(indexes, [
    "idx_sync_audit_completed_run_id",
    "idx_sync_audit_dataset_id",
    "idx_sync_audit_pending_signal_id",
    "idx_sync_audit_verified_dataset_id"
  ]);

  const pendingPlan = database.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id, details, created_at
    FROM sync_audit INDEXED BY idx_sync_audit_pending_signal_id
    WHERE dataset_key = '_system'
      AND direction = 'signal'
      AND action = 'sync-requested'
    ORDER BY id DESC
    LIMIT 1
  `).all().map((row) => row.detail).join("\n");
  assert.match(pendingPlan, /idx_sync_audit_pending_signal_id/);

  const reportPlan = database.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id
    FROM sync_audit
    WHERE dataset_key = 'catalog'
      AND action IN ('verified', 'reconciled')
    ORDER BY id DESC
    LIMIT 1
  `).all().map((row) => row.detail).join("\n");
  assert.match(reportPlan, /idx_sync_audit_verified_dataset_id/);

  const completedPlan = database.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id, details, created_at
    FROM sync_audit INDEXED BY idx_sync_audit_completed_run_id
    WHERE dataset_key = '_system'
      AND action = 'sync-run-completed'
    ORDER BY id DESC
    LIMIT 1
  `).all().map((row) => row.detail).join("\n");
  assert.match(completedPlan, /idx_sync_audit_completed_run_id/);
  database.close();
});

test("d.6.1 conserve exactement les 500 derniers événements d'un dataset", () => {
  const database = createDatabase();
  const insert = database.prepare(`
    INSERT INTO sync_audit (dataset_key, direction, action)
    VALUES ('catalog', 'test', 'verified')
  `);
  for (let index = 0; index < 505; index += 1) insert.run();

  database.prepare(`
    DELETE FROM sync_audit
    WHERE dataset_key = ?
      AND id < COALESCE((
        SELECT id
        FROM sync_audit
        WHERE dataset_key = ?
        ORDER BY id DESC
        LIMIT 1 OFFSET ?
      ), 0)
  `).run("catalog", "catalog", 499);

  const retained = database.prepare(`
    SELECT COUNT(*) AS count, MIN(id) AS oldest, MAX(id) AS newest
    FROM sync_audit WHERE dataset_key = 'catalog'
  `).get();
  assert.deepEqual({ ...retained }, { count: 500, oldest: 6, newest: 505 });
  database.close();
});
