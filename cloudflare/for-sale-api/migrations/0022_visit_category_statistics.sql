-- Distingue les chargements de page des catégories réellement affichées.
-- Les anciennes lignes restent des vues de page et ne peuvent pas être ventilées rétroactivement.

ALTER TABLE visit_events
  ADD COLUMN event_type TEXT NOT NULL DEFAULT 'page_view'
  CHECK (event_type IN ('page_view', 'category_view'));

ALTER TABLE visit_events
  ADD COLUMN category_key TEXT;

CREATE INDEX visit_events_category_stats_idx
  ON visit_events(event_day DESC, audience, event_type, category_key);
