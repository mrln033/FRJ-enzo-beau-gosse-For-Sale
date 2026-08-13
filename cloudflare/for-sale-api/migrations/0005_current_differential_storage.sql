-- Remplace les snapshots complets par un état courant différentiel.
-- Les anciennes tables restent temporairement en lecture seule afin de permettre
-- un déploiement sans perte et un retour arrière du Worker si nécessaire.

CREATE TABLE inventory_current (
  avatar_id TEXT NOT NULL REFERENCES avatars(id),
  row_key TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  source_id TEXT,
  item_name TEXT NOT NULL COLLATE NOCASE,
  quantity REAL NOT NULL,
  value_ped REAL,
  container TEXT,
  container_ref_id TEXT,
  PRIMARY KEY (avatar_id, row_key)
) WITHOUT ROWID;

CREATE INDEX idx_inventory_current_avatar_item
  ON inventory_current (avatar_id, item_name);

WITH grouped_rows AS (
  SELECT
    ai.avatar_id,
    MIN(ii.line_no) AS line_no,
    ii.item_name,
    SUM(ii.quantity) AS quantity,
    CASE WHEN COUNT(ii.value_ped) = 0 THEN NULL ELSE SUM(ii.value_ped) END AS value_ped,
    ii.container,
    'inventory:' || lower(trim(ii.item_name)) || char(31) ||
      lower(trim(coalesce(ii.container, ''))) AS base_key
  FROM active_inventory ai
  JOIN inventory_items ii ON ii.import_id = ai.import_id
  GROUP BY ai.avatar_id, lower(trim(ii.item_name)), lower(trim(coalesce(ii.container, '')))
)
INSERT INTO inventory_current (
  avatar_id, row_key, line_no, source_id, item_name, quantity,
  value_ped, container, container_ref_id
)
SELECT
  avatar_id, base_key, line_no, NULL, item_name,
  quantity, value_ped, container, NULL
FROM grouped_rows;

UPDATE sync_state
SET row_count = (
  SELECT COUNT(*)
  FROM inventory_current ic
  WHERE ic.avatar_id = substr(sync_state.dataset_key, length('inventory:') + 1)
)
WHERE dataset_key LIKE 'inventory:%';

CREATE TABLE market_current (
  item_key TEXT PRIMARY KEY,
  line_no INTEGER NOT NULL,
  item_name TEXT NOT NULL COLLATE NOCASE,
  tier TEXT,
  day_markup TEXT,
  day_sales TEXT,
  week_markup TEXT,
  week_sales TEXT,
  month_markup TEXT,
  month_sales TEXT,
  year_markup TEXT,
  year_sales TEXT,
  decade_markup TEXT,
  decade_sales TEXT,
  weighted_kind TEXT CHECK (weighted_kind IN ('percent', 'ped')),
  weighted_value REAL,
  weighted_display TEXT,
  observed_at TEXT NOT NULL
) WITHOUT ROWID;

INSERT INTO market_current (
  item_key, line_no, item_name, tier,
  day_markup, day_sales, week_markup, week_sales,
  month_markup, month_sales, year_markup, year_sales,
  decade_markup, decade_sales,
  weighted_kind, weighted_value, weighted_display, observed_at
)
SELECT
  'item:' || lower(trim(mo.item_name)), mo.line_no, mo.item_name, mo.tier,
  mo.day_markup, mo.day_sales, mo.week_markup, mo.week_sales,
  mo.month_markup, mo.month_sales, mo.year_markup, mo.year_sales,
  mo.decade_markup, mo.decade_sales,
  mo.weighted_kind, mo.weighted_value, mo.weighted_display, mo.observed_at
FROM active_market_import ami
JOIN market_observations mo ON mo.import_id = ami.import_id
WHERE ami.singleton = 1;

-- Une seule base de fusion commune par dataset. Le JSON reste très inférieur à
-- la limite d'une ligne D1 (le plus gros inventaire actuel fait environ 465 Ko).
CREATE TABLE sync_baseline (
  dataset_key TEXT PRIMARY KEY,
  content_checksum TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  rows_json TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

CREATE TABLE import_guard (
  dataset_key TEXT PRIMARY KEY,
  raw_checksum TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

INSERT INTO import_guard (dataset_key, raw_checksum)
SELECT 'inventory:' || ai.avatar_id, ii.checksum
FROM active_inventory ai
JOIN inventory_imports ii ON ii.id = ai.import_id
UNION ALL
SELECT 'mu', mi.checksum
FROM active_market_import ami
JOIN market_imports mi ON mi.id = ami.import_id
WHERE ami.singleton = 1;

INSERT INTO sync_baseline (
  dataset_key, content_checksum, source_updated_at, row_count, rows_json
)
SELECT
  s.dataset_key,
  s.content_checksum,
  s.source_updated_at,
  s.row_count,
  coalesce((
    SELECT json_group_array(json(row_json))
    FROM (
      SELECT json_object(
        'lineNo', ic.line_no,
        'sourceId', ic.source_id,
        'itemName', ic.item_name,
        'quantity', ic.quantity,
        'valuePed', ic.value_ped,
        'container', ic.container,
        'containerRefId', ic.container_ref_id
      ) AS row_json
      FROM inventory_current ic
      WHERE ic.avatar_id = substr(s.dataset_key, length('inventory:') + 1)
      ORDER BY ic.line_no
    )
  ), '[]')
FROM sync_state s
WHERE s.dataset_key LIKE 'inventory:%';

INSERT INTO sync_baseline (
  dataset_key, content_checksum, source_updated_at, row_count, rows_json
)
SELECT
  s.dataset_key,
  s.content_checksum,
  s.source_updated_at,
  s.row_count,
  coalesce((
    SELECT json_group_array(json(row_json))
    FROM (
      SELECT json_object(
        'lineNo', mc.line_no,
        'itemName', mc.item_name,
        'tier', mc.tier,
        'dayMarkup', mc.day_markup,
        'daySales', mc.day_sales,
        'weekMarkup', mc.week_markup,
        'weekSales', mc.week_sales,
        'monthMarkup', mc.month_markup,
        'monthSales', mc.month_sales,
        'yearMarkup', mc.year_markup,
        'yearSales', mc.year_sales,
        'decadeMarkup', mc.decade_markup,
        'decadeSales', mc.decade_sales,
        'weightedKind', mc.weighted_kind,
        'weightedValue', mc.weighted_value,
        'weightedDisplay', mc.weighted_display,
        'observedAt', mc.observed_at
      ) AS row_json
      FROM market_current mc
      ORDER BY mc.line_no
    )
  ), '[]')
FROM sync_state s
WHERE s.dataset_key = 'mu';

INSERT INTO sync_baseline (
  dataset_key, content_checksum, source_updated_at, row_count, rows_json
)
SELECT
  s.dataset_key,
  s.content_checksum,
  s.source_updated_at,
  s.row_count,
  coalesce((
    SELECT json_group_array(json(row_json))
    FROM (
      SELECT json_object(
        'lineNo', ROW_NUMBER() OVER (
          ORDER BY c.name COLLATE NOCASE, l.storage, l.aisle
        ) + 1,
        'itemName', c.name,
        'storage', l.storage,
        'aisle', l.aisle,
        'unitPricePed', c.unit_price_ped,
        'image', c.image,
        'wikiUrl', c.wiki_url,
        'enabled', l.enabled
      ) AS row_json
      FROM catalog_items c
      JOIN catalog_listings l ON l.item_name = c.name COLLATE NOCASE
      ORDER BY c.name COLLATE NOCASE, l.storage, l.aisle
    )
  ), '[]')
FROM sync_state s
WHERE s.dataset_key = 'catalog';
