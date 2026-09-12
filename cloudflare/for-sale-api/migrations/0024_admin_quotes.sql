-- Etat métier indépendant du parcours commercial, sans reconstruire les tables.
ALTER TABLE purchase_orders ADD COLUMN admin_quote INTEGER NOT NULL DEFAULT 0 CHECK (admin_quote IN (0, 1));

-- Les modèles ne demandent jamais d'approbation et restent hors progression.
CREATE TRIGGER purchase_admin_quote_guard_insert BEFORE INSERT ON purchase_orders
WHEN NEW.admin_quote = 1 AND (NEW.status <> 'submitted' OR NEW.approval_required <> 0)
BEGIN SELECT RAISE(ABORT, 'Devis Admin hors progression commerciale'); END;
CREATE TRIGGER purchase_admin_quote_guard_update BEFORE UPDATE ON purchase_orders
WHEN NEW.admin_quote = 1 AND (NEW.status <> 'submitted' OR NEW.approval_required <> 0)
BEGIN SELECT RAISE(ABORT, 'Devis Admin hors progression commerciale'); END;
