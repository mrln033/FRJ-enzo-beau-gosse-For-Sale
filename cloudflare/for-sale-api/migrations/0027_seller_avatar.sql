-- Demandes multi-vendeurs : traçabilité de l'avatar vendeur (enzo par défaut, nocturnal, etc.).
ALTER TABLE purchase_orders ADD COLUMN seller_avatar TEXT NOT NULL DEFAULT 'enzo';
