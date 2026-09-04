-- T-007 : les remises suivent les campagnes jusqu'au statut « À préparer ».
-- Les anciennes demandes directes stockaient déjà une MU adaptée au profil ;
-- ce témoin empêche de leur appliquer une seconde fois l'avantage membre.
ALTER TABLE purchase_order_items
  ADD COLUMN base_markup_profiled INTEGER NOT NULL DEFAULT 0
  CHECK (base_markup_profiled IN (0, 1));

UPDATE purchase_order_items
SET base_markup_profiled = 1
WHERE order_id IN (
  SELECT id FROM purchase_orders WHERE source_backend = 'd1-admin'
);
