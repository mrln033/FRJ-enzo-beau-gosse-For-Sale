-- catalog_current contient le snapshot entrant complet avant la mise à jour de
-- catalog_listings. Cet index permet de vérifier directement qu'un listing est
-- encore présent, sans reparcourir le JSON complet pour chaque ligne existante.
CREATE INDEX idx_catalog_current_listing_key
  ON catalog_current (item_name COLLATE NOCASE, storage, aisle);
