PRAGMA foreign_keys = ON;

CREATE TABLE avatars (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  legacy_sheet_name TEXT NOT NULL
);

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
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  UNIQUE (item_name, storage, aisle)
);

CREATE INDEX idx_catalog_listings_storage_aisle
  ON catalog_listings (storage, aisle, enabled);

CREATE TABLE inventory_imports (
  id TEXT PRIMARY KEY,
  avatar_id TEXT NOT NULL REFERENCES avatars(id),
  imported_at TEXT NOT NULL,
  source_row_count INTEGER NOT NULL CHECK (source_row_count >= 0),
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_inventory_imports_avatar_date
  ON inventory_imports (avatar_id, imported_at DESC);

CREATE TABLE inventory_items (
  import_id TEXT NOT NULL REFERENCES inventory_imports(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  source_id TEXT,
  item_name TEXT NOT NULL COLLATE NOCASE,
  quantity REAL NOT NULL,
  value_ped REAL,
  container TEXT,
  container_ref_id TEXT,
  PRIMARY KEY (import_id, line_no)
);

CREATE INDEX idx_inventory_items_import_name
  ON inventory_items (import_id, item_name);

CREATE TABLE active_inventory (
  avatar_id TEXT PRIMARY KEY REFERENCES avatars(id),
  import_id TEXT NOT NULL UNIQUE REFERENCES inventory_imports(id)
);

CREATE TABLE market_imports (
  id TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  source_row_count INTEGER NOT NULL CHECK (source_row_count >= 0),
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE market_observations (
  import_id TEXT NOT NULL REFERENCES market_imports(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  item_name TEXT NOT NULL COLLATE NOCASE,
  tier TEXT,
  day_markup TEXT,
  day_sales TEXT,
  week_markup TEXT,
  week_sales TEXT,
  month_markup TEXT,
  month_sales TEXT,
  year_markup TEXT,
  year_sales TEXT,
  decade_markup TEXT,
  decade_sales TEXT,
  weighted_kind TEXT CHECK (weighted_kind IN ('percent', 'ped')),
  weighted_value REAL,
  weighted_display TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (import_id, line_no)
);

CREATE INDEX idx_market_item_date
  ON market_observations (item_name, observed_at DESC);

CREATE TABLE active_market_import (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  import_id TEXT NOT NULL UNIQUE REFERENCES market_imports(id)
);

CREATE TABLE promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_date TEXT NOT NULL,
  storage TEXT NOT NULL,
  aisle TEXT NOT NULL,
  discount_rate REAL NOT NULL CHECK (discount_rate >= 0 AND discount_rate <= 1),
  UNIQUE (promotion_date, storage, aisle)
);

INSERT INTO avatars (id, display_name, legacy_sheet_name) VALUES
  ('enzo', 'enzo beau gosse', 'Inventaire Enzo'),
  ('arkaman', 'FRJ enzo ArkaMan', 'Inventaire ArkaMan'),
  ('kenza', 'kenza la belle', 'Inventaire Kenza'),
  ('nocturnal', 'Nocturnal enzo FRJ', 'Inventaire Nocturnal');
