ALTER TABLE inventory_imports ADD COLUMN content_checksum TEXT;
ALTER TABLE inventory_imports ADD COLUMN source_updated_at TEXT;
ALTER TABLE inventory_imports ADD COLUMN source_origin TEXT;

ALTER TABLE market_imports ADD COLUMN content_checksum TEXT;
ALTER TABLE market_imports ADD COLUMN source_updated_at TEXT;
ALTER TABLE market_imports ADD COLUMN source_origin TEXT;

CREATE TABLE sync_state (
  dataset_key TEXT PRIMARY KEY,
  content_checksum TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  source_origin TEXT NOT NULL,
  import_id TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
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
