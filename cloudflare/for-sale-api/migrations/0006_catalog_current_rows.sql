-- Conserve toutes les lignes BDD_APP pour la synchronisation, y compris les
-- doublons normalisés par catalog_listings pour l'affichage public.

CREATE TABLE catalog_current (
  row_key TEXT PRIMARY KEY,
  line_no INTEGER NOT NULL,
  item_name TEXT NOT NULL COLLATE NOCASE,
  storage TEXT NOT NULL,
  aisle TEXT NOT NULL,
  unit_price_ped REAL,
  image TEXT,
  wiki_url TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
) WITHOUT ROWID;

WITH legacy_rows AS (
  SELECT
    csr.*,
    'listing:' || lower(trim(csr.item_name)) || '|' ||
      lower(trim(csr.storage)) || '|' || lower(trim(csr.aisle)) AS base_key
  FROM active_catalog_import aci
  JOIN catalog_snapshot_rows csr ON csr.import_id = aci.import_id
  WHERE aci.singleton = 1
), keyed_rows AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY base_key
    ORDER BY line_no
  ) AS occurrence
  FROM legacy_rows
)
INSERT INTO catalog_current (
  row_key, line_no, item_name, storage, aisle,
  unit_price_ped, image, wiki_url, enabled
)
SELECT
  base_key || '#' || occurrence, line_no, item_name, storage, aisle,
  unit_price_ped, image, wiki_url, enabled
FROM keyed_rows;

UPDATE sync_baseline
SET
  row_count = (SELECT COUNT(*) FROM catalog_current),
  rows_json = coalesce((
    SELECT json_group_array(json(row_json))
    FROM (
      SELECT json_object(
        'lineNo', line_no,
        'itemName', item_name,
        'storage', storage,
        'aisle', aisle,
        'unitPricePed', unit_price_ped,
        'image', image,
        'wikiUrl', wiki_url,
        'enabled', enabled
      ) AS row_json
      FROM catalog_current
      ORDER BY line_no
    )
  ), '[]')
WHERE dataset_key = 'catalog';
