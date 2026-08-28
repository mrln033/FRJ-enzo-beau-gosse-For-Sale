const COMMENT_MAX_LENGTH = 500;

const STATUS_LABELS = Object.freeze({
  submitted: "Transmise",
  viewed: "Consultée",
  preparing: "À préparer",
  ready: "Prête",
  completed: "Terminée",
  cancelled: "Annulée",
  expired: "Expirée"
});

const CLIENT_ACTIONS = new Set(["submitted", "proposal-accepted", "client-cancelled"]);
const ADMIN_ACTIONS = new Set(["status-changed", "proposal-changed", "proposal-line-changed"]);
const HIDDEN_ACTIONS = new Set(["history-comment-updated", "pricing-confirmed-backfill"]);
const SYNCED_ACTIONS = new Set([
  "submitted",
  "gas-fallback-synchronized",
  "proposal-changed",
  "proposal-line-changed",
  "status-changed",
  "proposal-accepted",
  "client-cancelled"
]);
const ORDER_STATUSES = new Set([
  "submitted", "viewed", "preparing", "ready", "completed", "cancelled", "expired"
]);

export function orderHistoryActor(action) {
  if (CLIENT_ACTIONS.has(action)) return "client";
  if (ADMIN_ACTIONS.has(action)) return "admin";
  if (action === "gas-fallback-synchronized") return "gas";
  return "system";
}

export function isVisibleOrderHistoryAction(action) {
  return !String(action || "").startsWith("discord-") && !HIDDEN_ACTIONS.has(action);
}

export function automaticOrderHistoryComment(action, details = {}) {
  if (action === "submitted") return "Demande transmise par le client.";
  if (action === "gas-fallback-synchronized") return "Demande reçue depuis le secours GAS.";
  if (action === "proposal-changed") return "Proposition modifiée par l’administrateur.";
  if (action === "proposal-line-changed") {
    return details.itemName
      ? `Proposition modifiée pour « ${details.itemName} ».`
      : "Une ligne de la proposition a été modifiée.";
  }
  if (action === "proposal-accepted") return "Proposition acceptée par le client.";
  if (action === "client-cancelled") return "Demande annulée par le client.";
  if (action === "status-changed") {
    const from = STATUS_LABELS[details.from] || details.from || "Inconnu";
    const to = STATUS_LABELS[details.to] || details.to || "Inconnu";
    return `Statut modifié : ${from} → ${to}.`;
  }
  return `Événement : ${String(action || "inconnu")}.`;
}

export function normalizeOrderHistoryComment(value) {
  if (typeof value !== "string") throw new TypeError("Le commentaire doit être du texte");
  const comment = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (comment.length > COMMENT_MAX_LENGTH) {
    throw new RangeError(`Le commentaire ne peut pas dépasser ${COMMENT_MAX_LENGTH} caractères`);
  }
  return comment || null;
}

export function parseOrderHistoryDetails(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function mapOrderHistoryEvent(row) {
  const details = parseOrderHistoryDetails(row.details);
  const automaticComment = automaticOrderHistoryComment(row.action, details);
  return {
    id: Number(row.id),
    eventKey: row.event_key || `d1-${row.id}`,
    action: row.action,
    actor: row.actor || orderHistoryActor(row.action),
    newStatus: details.to
      || (row.action === "client-cancelled" ? "cancelled" : null)
      || (row.action === "submitted" || row.action === "gas-fallback-synchronized" ? "submitted" : null),
    comment: row.comment || automaticComment,
    automaticComment,
    commentUpdatedAt: row.comment_updated_at
      ? normalizeHistoryTimestamp(row.comment_updated_at, "Date de commentaire invalide")
      : null,
    createdAt: normalizeHistoryTimestamp(row.created_at, "Date d’événement invalide"),
    details
  };
}

export function normalizeSyncedOrderHistoryEvent(value) {
  const source = value && typeof value === "object" ? value : {};
  const eventKey = String(source.eventKey || "").trim().toLowerCase();
  const orderId = String(source.orderId || "").trim().toLowerCase();
  const action = String(source.action || "").trim();
  const actor = String(source.actor || "").trim();
  if (!/^(?:d1-\d+|gas-[a-f0-9-]{36}|[a-f0-9-]{36})$/i.test(eventKey)) {
    throw new TypeError("Clé d’événement invalide");
  }
  if (!/^[a-f0-9-]{36}$/i.test(orderId)) throw new TypeError("Identifiant de demande invalide");
  if (!SYNCED_ACTIONS.has(action)) throw new TypeError("Action d’historique invalide");
  if (!["admin", "client", "system", "gas"].includes(actor)) throw new TypeError("Auteur d’historique invalide");

  const details = parseOrderHistoryDetails(source.details);
  const newStatus = source.newStatus || details.to || null;
  if (newStatus && !ORDER_STATUSES.has(newStatus)) throw new TypeError("Nouveau statut invalide");
  if (newStatus) details.to = newStatus;
  const createdAt = normalizeHistoryTimestamp(source.createdAt, "Date d’événement invalide");
  const commentUpdatedAt = source.commentUpdatedAt
    ? normalizeHistoryTimestamp(source.commentUpdatedAt, "Date de commentaire invalide")
    : null;
  return {
    eventKey,
    orderId,
    action,
    actor,
    newStatus,
    comment: normalizeOrderHistoryComment(String(source.comment || "")),
    details,
    createdAt,
    commentUpdatedAt
  };
}

function normalizeHistoryTimestamp(value, message) {
  const source = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(value || ""))
    ? `${String(value).replace(" ", "T")}Z`
    : value;
  const date = new Date(source);
  if (!value || Number.isNaN(date.getTime())) throw new TypeError(message);
  return date.toISOString();
}

export function prepareOrderHistoryEvent(env, { orderId, action, details = {}, actor, comment }) {
  const visible = isVisibleOrderHistoryAction(action);
  const storedComment = comment === undefined
    ? (visible ? automaticOrderHistoryComment(action, details) : null)
    : comment;
  return env.DB.prepare(`
    INSERT INTO purchase_order_events (order_id, event_key, action, actor, comment, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    orderId,
    crypto.randomUUID(),
    action,
    actor || orderHistoryActor(action),
    storedComment,
    JSON.stringify(details)
  );
}

export function prepareSyncedOrderHistoryEvent(env, event) {
  return env.DB.prepare(`
    INSERT INTO purchase_order_events (
      order_id, event_key, action, actor, comment, details, created_at, comment_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.orderId,
    event.eventKey,
    event.action,
    event.actor,
    event.comment,
    JSON.stringify(event.details),
    event.createdAt,
    event.commentUpdatedAt
  );
}
