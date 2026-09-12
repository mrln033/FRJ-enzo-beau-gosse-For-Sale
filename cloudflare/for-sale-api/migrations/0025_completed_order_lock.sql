-- Une conversion ne doit pas contourner le verrouillage des demandes avancées.
CREATE TRIGGER purchase_advanced_quote_conversion BEFORE UPDATE ON purchase_orders
WHEN OLD.status IN ('preparing', 'ready', 'completed') AND OLD.admin_quote = 0 AND NEW.admin_quote = 1
BEGIN SELECT RAISE(ABORT, 'Demande avancee : conversion Devis Admin interdite'); END;

-- Verrouillage métier définitif. Les accusés Discord/synchronisation restent autorisés.
CREATE TRIGGER purchase_completed_header_update BEFORE UPDATE ON purchase_orders
WHEN OLD.status = 'completed' AND (
  NEW.id IS NOT OLD.id OR
  NEW.public_reference IS NOT OLD.public_reference OR
  NEW.access_token_hash IS NOT OLD.access_token_hash OR
  NEW.status IS NOT OLD.status OR
  NEW.buyer_avatar IS NOT OLD.buyer_avatar OR
  NEW.buyer_contact IS NOT OLD.buyer_contact OR
  NEW.buyer_comment IS NOT OLD.buyer_comment OR
  NEW.language IS NOT OLD.language OR
  NEW.frj_member IS NOT OLD.frj_member OR
  NEW.source_backend IS NOT OLD.source_backend OR
  NEW.total_tt_ped IS NOT OLD.total_tt_ped OR
  NEW.total_sale_ped IS NOT OLD.total_sale_ped OR
  NEW.pricing_status IS NOT OLD.pricing_status OR
  NEW.client_created_at IS NOT OLD.client_created_at OR
  NEW.created_at IS NOT OLD.created_at OR
  NEW.approval_required IS NOT OLD.approval_required OR
  NEW.proposal_version IS NOT OLD.proposal_version OR
  NEW.admin_quote IS NOT OLD.admin_quote
)
BEGIN SELECT RAISE(ABORT, 'Demande Terminee : donnees verrouillees'); END;
CREATE TRIGGER purchase_completed_header_delete BEFORE DELETE ON purchase_orders
WHEN OLD.status = 'completed'
BEGIN SELECT RAISE(ABORT, 'Demande Terminee : historique conserve'); END;
CREATE TRIGGER purchase_completed_item_insert BEFORE INSERT ON purchase_order_items
WHEN EXISTS (SELECT 1 FROM purchase_orders WHERE id=NEW.order_id AND status='completed')
BEGIN SELECT RAISE(ABORT, 'Demande Terminee : articles verrouilles'); END;
CREATE TRIGGER purchase_completed_item_update BEFORE UPDATE ON purchase_order_items
WHEN EXISTS (SELECT 1 FROM purchase_orders WHERE id IN (OLD.order_id,NEW.order_id) AND status='completed')
BEGIN SELECT RAISE(ABORT, 'Demande Terminee : articles verrouilles'); END;
CREATE TRIGGER purchase_completed_item_delete BEFORE DELETE ON purchase_order_items
WHEN EXISTS (SELECT 1 FROM purchase_orders WHERE id=OLD.order_id AND status='completed')
BEGIN SELECT RAISE(ABORT, 'Demande Terminee : articles verrouilles'); END;
CREATE TRIGGER purchase_completed_history_update BEFORE UPDATE ON purchase_order_events
WHEN EXISTS (SELECT 1 FROM purchase_orders WHERE id IN (OLD.order_id,NEW.order_id) AND status='completed')
BEGIN SELECT RAISE(ABORT, 'Demande Terminee : historique verrouille'); END;
CREATE TRIGGER purchase_completed_history_delete BEFORE DELETE ON purchase_order_events
WHEN EXISTS (SELECT 1 FROM purchase_orders WHERE id=OLD.order_id AND status='completed')
BEGIN SELECT RAISE(ABORT, 'Demande Terminee : historique conserve'); END;
