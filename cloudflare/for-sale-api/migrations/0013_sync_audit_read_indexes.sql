-- Les lectures d'audit utilisent l'identifiant croissant, qui représente aussi
-- l'ordre d'insertion. Cet index remplace celui sur created_at et évite les tris
-- temporaires lors de la rétention et de la recherche du dernier événement.
DROP INDEX IF EXISTS idx_sync_audit_dataset_date;

CREATE INDEX idx_sync_audit_dataset_id
  ON sync_audit (dataset_key, id DESC);

-- Ces index partiels restent petits : seules les lignes effectivement lues par
-- le rapport ou le poll GAS y sont ajoutées.
CREATE INDEX idx_sync_audit_verified_dataset_id
  ON sync_audit (dataset_key, id DESC)
  WHERE action IN ('verified', 'reconciled');

CREATE INDEX idx_sync_audit_pending_signal_id
  ON sync_audit (id DESC)
  WHERE dataset_key = '_system'
    AND direction = 'signal'
    AND action = 'sync-requested';

CREATE INDEX idx_sync_audit_completed_run_id
  ON sync_audit (id DESC)
  WHERE dataset_key = '_system'
    AND action = 'sync-run-completed';
