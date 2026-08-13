CREATE TABLE sync_observed_state (
  dataset_key TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('gas', 'd1')),
  content_checksum TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  source_updated_at TEXT,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_id TEXT,
  provisional INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dataset_key, side)
);

CREATE UNIQUE INDEX idx_sync_observed_state_event
  ON sync_observed_state (event_id)
  WHERE event_id IS NOT NULL;
