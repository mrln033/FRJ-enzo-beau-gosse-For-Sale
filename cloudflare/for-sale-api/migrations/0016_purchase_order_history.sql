-- Enrichit le journal technique existant pour l'utiliser comme historique métier.
-- event_key servira de clé de déduplication lors de la future synchronisation GAS.

ALTER TABLE purchase_order_events ADD COLUMN event_key TEXT;
ALTER TABLE purchase_order_events ADD COLUMN actor TEXT NOT NULL DEFAULT 'system'
  CHECK (actor IN ('admin', 'client', 'system', 'gas'));
ALTER TABLE purchase_order_events ADD COLUMN comment TEXT;
ALTER TABLE purchase_order_events ADD COLUMN comment_updated_at TEXT;

UPDATE purchase_order_events
SET event_key = 'd1-' || id,
    actor = CASE
      WHEN action IN ('submitted', 'proposal-accepted', 'client-cancelled') THEN 'client'
      WHEN action IN ('status-changed', 'proposal-changed', 'proposal-line-changed') THEN 'admin'
      WHEN action = 'gas-fallback-synchronized' THEN 'gas'
      ELSE 'system'
    END
WHERE event_key IS NULL;

CREATE UNIQUE INDEX purchase_order_events_key_idx
  ON purchase_order_events(event_key)
  WHERE event_key IS NOT NULL;
