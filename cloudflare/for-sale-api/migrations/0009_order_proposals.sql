-- Proposition ponctuelle admin, sans modifier le catalogue ni le référentiel MU.
ALTER TABLE purchase_orders ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 0
  CHECK (approval_required IN (0, 1));
ALTER TABLE purchase_orders ADD COLUMN proposal_version INTEGER NOT NULL DEFAULT 0;
