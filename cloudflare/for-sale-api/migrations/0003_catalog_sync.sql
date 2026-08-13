CREATE TABLE catalog_imports (
  id TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  source_row_count INTEGER NOT NULL CHECK (source_row_count >= 0),
  content_checksum TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  source_origin TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE catalog_snapshot_rows (
  import_id TEXT NOT NULL REFERENCES catalog_imports(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  item_name TEXT NOT NULL COLLATE NOCASE,
  storage TEXT NOT NULL,
  aisle TEXT NOT NULL,
  unit_price_ped REAL,
  image TEXT,
  wiki_url TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  PRIMARY KEY (import_id, line_no)
);

CREATE INDEX idx_catalog_snapshot_import_item
  ON catalog_snapshot_rows (import_id, item_name);

CREATE TABLE active_catalog_import (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  import_id TEXT NOT NULL UNIQUE REFERENCES catalog_imports(id)
);
