-- Marqueurs techniques sans contenu métier ; empêchent les résurrections GAS.
CREATE TABLE purchase_order_deletions (
  order_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  gas_done INTEGER NOT NULL DEFAULT 0,
  discord_message_id TEXT
);
CREATE INDEX purchase_order_deletions_pending ON purchase_order_deletions(deleted_at,order_id)
WHERE gas_done=0 OR discord_message_id IS NOT NULL;
CREATE TRIGGER purchase_deleted_no_insert BEFORE INSERT ON purchase_orders
WHEN EXISTS (SELECT 1 FROM purchase_order_deletions WHERE order_id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'Devis definitivement supprime'); END;
CREATE TRIGGER purchase_deleted_no_update BEFORE UPDATE ON purchase_orders
WHEN EXISTS (SELECT 1 FROM purchase_order_deletions WHERE order_id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'Devis definitivement supprime'); END;
