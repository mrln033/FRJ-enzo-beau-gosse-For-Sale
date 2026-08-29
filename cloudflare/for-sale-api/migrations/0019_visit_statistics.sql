-- Statistiques de visites anonymisées.
-- Les identifiants navigateur et session ne sont jamais stockés en clair.

CREATE TABLE visit_events (
  event_id TEXT PRIMARY KEY,
  event_day TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_hash TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  page_key TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('PUBLIC', 'ADMIN'))
);

CREATE INDEX visit_events_stats_idx
  ON visit_events(event_day DESC, audience, page_key);

CREATE INDEX visit_events_session_idx
  ON visit_events(audience, session_hash);

CREATE INDEX visit_events_daily_visitor_idx
  ON visit_events(event_day, audience, visitor_hash);
