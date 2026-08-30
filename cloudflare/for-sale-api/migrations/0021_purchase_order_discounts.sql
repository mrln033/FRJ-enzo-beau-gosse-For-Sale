-- Instantané tarifaire d.9 : une campagne ne modifie jamais rétroactivement une demande.
ALTER TABLE purchase_order_items ADD COLUMN base_markup_kind TEXT CHECK (base_markup_kind IS NULL OR base_markup_kind IN ('none', 'percent', 'ped'));
ALTER TABLE purchase_order_items ADD COLUMN base_markup_value REAL;
ALTER TABLE purchase_order_items ADD COLUMN discount_campaign_id TEXT;
ALTER TABLE purchase_order_items ADD COLUMN discount_kind TEXT CHECK (discount_kind IS NULL OR discount_kind IN ('daily_promo', 'sale'));
ALTER TABLE purchase_order_items ADD COLUMN discount_rate REAL CHECK (discount_rate IS NULL OR (discount_rate > 0 AND discount_rate <= 1));

UPDATE purchase_order_items
SET base_markup_kind = markup_kind, base_markup_value = markup_value
WHERE base_markup_kind IS NULL;
