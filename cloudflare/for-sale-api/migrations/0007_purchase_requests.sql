-- Demandes d'achat isolées du catalogue et des inventaires.
-- La fonctionnalité peut être désactivée sans supprimer ces tables.

CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  public_reference TEXT NOT NULL UNIQUE,
  access_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'viewed', 'preparing', 'ready', 'completed', 'cancelled', 'expired')),
  buyer_avatar TEXT NOT NULL,
  buyer_contact TEXT,
  buyer_comment TEXT,
  language TEXT NOT NULL DEFAULT 'EN' CHECK (language IN ('FR', 'EN')),
  frj_member INTEGER NOT NULL DEFAULT 0 CHECK (frj_member IN (0, 1)),
  source_backend TEXT NOT NULL DEFAULT 'd1',
  total_tt_ped REAL NOT NULL,
  total_sale_ped REAL NOT NULL,
  pricing_status TEXT NOT NULL DEFAULT 'estimated',
  submitter_hash TEXT,
  client_created_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE purchase_order_items (
  order_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  storage TEXT NOT NULL,
  aisle TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  stock_at_submission REAL NOT NULL,
  unit_tt_ped REAL NOT NULL,
  markup_kind TEXT NOT NULL DEFAULT 'none',
  markup_value REAL,
  markup_display TEXT,
  unit_sale_ped REAL NOT NULL,
  line_tt_ped REAL NOT NULL,
  line_sale_ped REAL NOT NULL,
  price_status TEXT NOT NULL DEFAULT 'estimated',
  PRIMARY KEY (order_id, line_no),
  FOREIGN KEY (order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
);

CREATE TABLE purchase_order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
);

CREATE INDEX purchase_orders_status_created_idx
  ON purchase_orders(status, created_at DESC);
CREATE INDEX purchase_orders_submitter_created_idx
  ON purchase_orders(submitter_hash, created_at DESC);
CREATE INDEX purchase_order_events_order_idx
  ON purchase_order_events(order_id, id DESC);
