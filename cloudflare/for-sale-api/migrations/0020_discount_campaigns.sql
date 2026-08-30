-- Campagnes de remise d.9 : promotions quotidiennes et soldes.
-- La table historique reste disponible en lecture sous son ancien nom grâce à une vue.

ALTER TABLE promotions RENAME TO promotions_legacy;

CREATE TABLE discount_campaigns (
  id TEXT PRIMARY KEY,
  campaign_type TEXT NOT NULL CHECK (campaign_type IN ('daily_promo', 'sale')),
  starts_on TEXT NOT NULL CHECK (starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(starts_on) = starts_on),
  ends_on TEXT NOT NULL CHECK (ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(ends_on) = ends_on),
  storage TEXT,
  aisle TEXT,
  discount_rate REAL NOT NULL CHECK (discount_rate > 0 AND discount_rate <= 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'automatic', 'legacy')),
  eligible_pair_count INTEGER CHECK (eligible_pair_count IS NULL OR eligible_pair_count >= 0),
  candidate_pair_count INTEGER CHECK (candidate_pair_count IS NULL OR candidate_pair_count >= 0),
  generation_seed TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (ends_on >= starts_on),
  CHECK (
    (campaign_type = 'daily_promo' AND starts_on = ends_on AND length(trim(storage)) > 0 AND length(trim(aisle)) > 0)
    OR
    (campaign_type = 'sale' AND storage IS NULL AND aisle IS NULL)
  )
);

INSERT INTO discount_campaigns (
  id, campaign_type, starts_on, ends_on, storage, aisle,
  discount_rate, enabled, origin, created_at, updated_at
)
SELECT
  printf('legacy-promo-%d', id), 'daily_promo', promotion_date, promotion_date,
  upper(trim(storage)), upper(trim(aisle)), discount_rate,
  CASE WHEN row_number() OVER (PARTITION BY promotion_date ORDER BY id) = 1 THEN 1 ELSE 0 END,
  'legacy', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM promotions_legacy
WHERE discount_rate > 0 AND discount_rate <= 1
  AND date(promotion_date) = promotion_date
  AND length(trim(storage)) > 0
  AND length(trim(aisle)) > 0;

CREATE UNIQUE INDEX discount_campaigns_one_daily_promo_idx
  ON discount_campaigns(starts_on)
  WHERE campaign_type = 'daily_promo' AND enabled = 1;

CREATE INDEX discount_campaigns_active_dates_idx
  ON discount_campaigns(campaign_type, enabled, starts_on, ends_on);

CREATE INDEX discount_campaigns_pair_rotation_idx
  ON discount_campaigns(storage, aisle, starts_on)
  WHERE campaign_type = 'daily_promo' AND enabled = 1;

CREATE TABLE discount_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  automatic_promotions_enabled INTEGER NOT NULL DEFAULT 1 CHECK (automatic_promotions_enabled IN (0, 1)),
  default_promotion_rate REAL NOT NULL DEFAULT 0.05 CHECK (default_promotion_rate > 0 AND default_promotion_rate <= 1),
  selection_seed TEXT NOT NULL DEFAULT 'frj-daily-promo',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO discount_config (singleton) VALUES (1);

CREATE VIEW promotions AS
SELECT
  id,
  starts_on AS promotion_date,
  storage,
  aisle,
  discount_rate
FROM discount_campaigns
WHERE campaign_type = 'daily_promo' AND enabled = 1;
