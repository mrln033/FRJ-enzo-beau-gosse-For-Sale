-- Liens de suivi secondaires créés depuis la Console Admin.
-- Comme pour le lien client original, seul le SHA-256 du jeton est conservé.

CREATE TABLE purchase_order_tracking_tokens (
  token_hash TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
);

CREATE INDEX purchase_order_tracking_tokens_order_idx
  ON purchase_order_tracking_tokens(order_id, created_at DESC);
