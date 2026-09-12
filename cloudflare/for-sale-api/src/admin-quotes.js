import { ApiError } from './http.js';

export function isAdminQuote(order) {
  return Number(order?.admin_quote ?? order?.adminQuote ?? 0) === 1 || order?.status === 'admin_quote';
}

export function requireQuoteTransition(current, next) {
  if (isAdminQuote(current) && next !== 'admin_quote') {
    throw new ApiError(409, 'Un Devis Admin reste un modèle : dupliquez-le pour créer une demande normale.');
  }
}
