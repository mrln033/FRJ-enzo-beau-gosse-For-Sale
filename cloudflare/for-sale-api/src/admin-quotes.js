import { ApiError } from './http.js';

export function isAdminQuote(order) {
  return Number(order?.admin_quote ?? order?.adminQuote ?? 0) === 1 || order?.status === 'admin_quote';
}

export function requireQuoteTransition(current, next) {
  if (next === 'admin_quote' && ['preparing', 'ready', 'completed'].includes(current.status)) {
    throw new ApiError(409, 'Une demande À préparer, Prête ou Terminée ne peut pas devenir un Devis Admin.');
  }
  if (current.status === "completed" && next !== "completed") {
    throw new ApiError(409, "Demande Terminée : livrée et payée, elle est définitivement verrouillée.");
  }
  if (isAdminQuote(current) && next !== 'admin_quote') {
    throw new ApiError(409, 'Un Devis Admin reste un modèle : dupliquez-le pour créer une demande normale.');
  }
}
