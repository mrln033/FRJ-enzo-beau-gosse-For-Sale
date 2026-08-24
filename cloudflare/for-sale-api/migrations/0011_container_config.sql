-- d.8.1 : référentiel des conteneurs pris en compte dans les quantités.
-- La table est commune aux quatre avatars, mais chaque choix reste indépendant.

CREATE TABLE container_config (
  avatar_id TEXT NOT NULL REFERENCES avatars(id),
  container_key TEXT NOT NULL,
  container TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (avatar_id, container_key),
  CHECK (container_key <> ''),
  CHECK (trim(container) <> '')
) WITHOUT ROWID;

CREATE INDEX idx_container_config_avatar_enabled
  ON container_config (avatar_id, enabled, container_key);

-- Initialiser depuis l'état courant D1. Pour Enzo, les choix reproduisent
-- exactement l'ancien filtre codé en dur afin que d.8.2 puisse le remplacer
-- sans modifier silencieusement les quantités publiées. Les autres avatars
-- sont préparés mais désactivés par défaut.
WITH discovered AS (
  SELECT
    avatar_id,
    lower(trim(container)) AS container_key,
    MIN(trim(container)) AS container
  FROM inventory_current
  WHERE trim(coalesce(container, '')) <> ''
  GROUP BY avatar_id, lower(trim(container))
)
INSERT INTO container_config (avatar_id, container_key, container, enabled)
SELECT
  avatar_id,
  container_key,
  container,
  CASE
    WHEN avatar_id = 'enzo' AND (
      container_key LIKE '%calypso%'
      OR container_key LIKE '%carried%'
      OR container_key IN (
        'pitbull mk. 1 (c,l)',
        'pitbull mk. 2 (c,l)',
        'personal avatar',
        'ni armors',
        'ni tailoring/textiles',
        'blueprints: a.r.c.',
        'blueprints: cyrene',
        'kulokhar tall urn'
      )
      OR container_key LIKE '%limited%'
    ) THEN 1
    ELSE 0
  END
FROM discovered;

-- Un import ajoute les conteneurs inconnus sans toucher aux choix existants.
-- L'absence volontaire de trigger DELETE conserve les anciennes entrées.
CREATE TRIGGER discover_container_config_after_inventory_insert
AFTER INSERT ON inventory_current
WHEN trim(coalesce(NEW.container, '')) <> ''
BEGIN
  INSERT OR IGNORE INTO container_config (
    avatar_id, container_key, container, enabled
  ) VALUES (
    NEW.avatar_id,
    lower(trim(NEW.container)),
    trim(NEW.container),
    0
  );
END;

CREATE TRIGGER discover_container_config_after_inventory_update
AFTER UPDATE OF container ON inventory_current
WHEN trim(coalesce(NEW.container, '')) <> ''
BEGIN
  INSERT OR IGNORE INTO container_config (
    avatar_id, container_key, container, enabled
  ) VALUES (
    NEW.avatar_id,
    lower(trim(NEW.container)),
    trim(NEW.container),
    0
  );
END;
