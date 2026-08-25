-- Un UPSERT en masse sur inventory_current propage sa politique de conflit
-- aux instructions des triggers. INSERT OR IGNORE ne suffit alors plus à
-- protéger deux lignes qui découvrent le même conteneur pendant l'import.

DROP TRIGGER IF EXISTS discover_container_config_after_inventory_insert;
DROP TRIGGER IF EXISTS discover_container_config_after_inventory_update;

CREATE TRIGGER discover_container_config_after_inventory_insert
AFTER INSERT ON inventory_current
WHEN trim(coalesce(NEW.container, '')) <> ''
BEGIN
  INSERT INTO container_config (
    avatar_id, container_key, container, enabled
  ) VALUES (
    NEW.avatar_id,
    lower(trim(NEW.container)),
    trim(NEW.container),
    0
  )
  ON CONFLICT (avatar_id, container_key) DO NOTHING;
END;

CREATE TRIGGER discover_container_config_after_inventory_update
AFTER UPDATE OF container ON inventory_current
WHEN trim(coalesce(NEW.container, '')) <> ''
BEGIN
  INSERT INTO container_config (
    avatar_id, container_key, container, enabled
  ) VALUES (
    NEW.avatar_id,
    lower(trim(NEW.container)),
    trim(NEW.container),
    0
  )
  ON CONFLICT (avatar_id, container_key) DO NOTHING;
END;
