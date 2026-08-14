-- Associe chaque demande à son message Discord afin de le mettre à jour.

ALTER TABLE purchase_orders ADD COLUMN discord_message_id TEXT;
ALTER TABLE purchase_orders ADD COLUMN discord_synced_at TEXT;
