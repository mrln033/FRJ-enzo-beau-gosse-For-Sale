-- d.8.2 : remplacer le filtre de conteneurs codé dans le Worker par une
-- jointure centralisée. Le plan utilise les index existants sur l'inventaire
-- et sur le référentiel de d.8.1, sans index supplémentaire à maintenir.

CREATE VIEW saleable_inventory AS
SELECT ii.*
FROM inventory_current ii
JOIN container_config cc
  ON cc.avatar_id = ii.avatar_id
 AND cc.container_key = lower(trim(coalesce(ii.container, '')))
 AND cc.enabled = 1;

PRAGMA optimize;
