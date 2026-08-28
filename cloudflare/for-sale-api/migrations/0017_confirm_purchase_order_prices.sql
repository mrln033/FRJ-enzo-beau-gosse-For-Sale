-- Confirme les prix des demandes ayant atteint le début de la préparation.
-- L'historique permet de conserver cette confirmation même si le statut courant
-- est ensuite devenu Annulée ou Expirée.

UPDATE purchase_order_items
SET price_status = 'confirmed'
WHERE order_id IN (
  SELECT orders.id
  FROM purchase_orders AS orders
  WHERE orders.status IN ('preparing', 'ready', 'completed')
     OR EXISTS (
       SELECT 1
       FROM purchase_order_events AS events
       WHERE events.order_id = orders.id
         AND events.action = 'status-changed'
         AND json_extract(
           CASE WHEN json_valid(events.details) THEN events.details ELSE '{}' END,
           '$.to'
         ) IN ('preparing', 'ready', 'completed')
     )
);

UPDATE purchase_orders
SET pricing_status = 'confirmed'
WHERE status IN ('preparing', 'ready', 'completed')
   OR EXISTS (
     SELECT 1
     FROM purchase_order_events
     WHERE purchase_order_events.order_id = purchase_orders.id
       AND purchase_order_events.action = 'status-changed'
       AND json_extract(
         CASE
           WHEN json_valid(purchase_order_events.details) THEN purchase_order_events.details
           ELSE '{}'
         END,
         '$.to'
       ) IN ('preparing', 'ready', 'completed')
   );

-- Le curseur GAS transporte les commandes à partir des nouveaux événements.
-- Ce signal technique, masqué de l'historique Admin, lui fait donc relire les
-- demandes reprises par la migration sans inventer un changement de statut.
INSERT INTO purchase_order_events (
  order_id, event_key, action, actor, comment, details
)
SELECT
  id,
  lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' ||
    hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))
  ),
  'pricing-confirmed-backfill',
  'system',
  NULL,
  '{"reason":"d.11-migration"}'
FROM purchase_orders
WHERE pricing_status = 'confirmed'
  AND NOT EXISTS (
    SELECT 1
    FROM purchase_order_events
    WHERE purchase_order_events.order_id = purchase_orders.id
      AND purchase_order_events.action = 'pricing-confirmed-backfill'
  );
