(function initOrderUi(global) {
  "use strict";

  const statusDefinitions = Object.freeze({
    awaiting_approval: Object.freeze({ admin: "À valider", FR: "À valider", EN: "Approval required" }),
    submitted: Object.freeze({ admin: "Transmise", FR: "Demande transmise", EN: "Request submitted" }),
    viewed: Object.freeze({ admin: "Vue", FR: "Demande consultée", EN: "Request viewed" }),
    preparing: Object.freeze({ admin: "À préparer", FR: "Préparation en cours", EN: "Being prepared" }),
    ready: Object.freeze({ admin: "Prête", FR: "Prête", EN: "Ready" }),
    completed: Object.freeze({ admin: "Terminée", FR: "Terminée", EN: "Completed" }),
    cancelled: Object.freeze({ admin: "Annulée", FR: "Annulée", EN: "Cancelled" }),
    expired: Object.freeze({ admin: "Expirée", FR: "Expirée", EN: "Expired" })
  });
  const statusKeys = Object.freeze(Object.keys(statusDefinitions));
  const pricingDefinitions = Object.freeze({
    estimated: Object.freeze({ admin: "Prix estimés", FR: "Prix estimés", EN: "Estimated prices" }),
    "to-confirm": Object.freeze({ admin: "Prix à confirmer", FR: "Prix à confirmer", EN: "Prices to confirm" }),
    confirmed: Object.freeze({ admin: "Prix confirmés", FR: "Prix confirmés", EN: "Confirmed prices" })
  });
  const editableStatuses = new Set(["awaiting_approval", "submitted", "viewed"]);
  const hideableStatuses = new Set(["completed", "cancelled", "expired"]);

  function normalizeLanguage(language) {
    return language === "FR" ? "FR" : "EN";
  }

  function statusLabel(status, language = "FR", variant = "tracking") {
    const definition = statusDefinitions[status];
    if (!definition) return status || "—";
    return variant === "admin" ? definition.admin : definition[normalizeLanguage(language)];
  }

  function pricingLabel(status, language = "FR", variant = "tracking") {
    const definition = pricingDefinitions[status] || pricingDefinitions.estimated;
    return variant === "admin" ? definition.admin : definition[normalizeLanguage(language)];
  }

  function formatPed(value, language = "FR") {
    return Number(value || 0).toLocaleString(normalizeLanguage(language) === "FR" ? "fr-FR" : "en-GB", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatQuantity(value, language = "FR") {
    return Number(value || 0).toLocaleString(normalizeLanguage(language) === "FR" ? "fr-FR" : "en-GB", {
      maximumFractionDigits: 0
    });
  }

  function formatDate(value, language = "FR") {
    if (!value) return "—";
    return new Date(value).toLocaleString(normalizeLanguage(language) === "FR" ? "fr-FR" : "en-GB", {
      dateStyle: "short",
      timeStyle: "short"
    });
  }

  function roundPed(value, decimals = 2) {
    const factor = 10 ** decimals;
    return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
  }

  // Avant la préparation, une proposition peut encore être modifiée par l'Admin ou annulée par le client.
  const canEditProposal = (status) => editableStatuses.has(status);
  const canCancel = (status) => editableStatuses.has(status);
  const canHide = (status) => hideableStatuses.has(status);

  global.FRJ_ORDER_UI = Object.freeze({
    statusKeys,
    statusLabel,
    pricingLabel,
    formatPed,
    formatQuantity,
    formatDate,
    roundPed,
    canEditProposal,
    canCancel,
    canHide
  });
})(window);
