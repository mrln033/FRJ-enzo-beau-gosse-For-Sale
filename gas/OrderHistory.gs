/** Modèle Google Sheets de l'historique des demandes d'achat. */
function purchaseOrderHistoryHeaders_() {
  return [
    "EVENT_KEY", "ORDER_ID", "ACTION", "ACTOR", "NOUVEAU_STATUT", "COMMENTAIRE",
    "DETAILS_JSON", "DATE_CREATION", "DATE_COMMENTAIRE_MAJ", "SYNCED_D1_AT", "SYNC_ERROR"
  ];
}

function getOrCreatePurchaseOrderHistorySheet_(ss) {
  var sheet = ss.getSheetByName("COMMANDES_HISTORIQUE");
  if (!sheet) sheet = ss.insertSheet("COMMANDES_HISTORIQUE");
  var headers = purchaseOrderHistoryHeaders_();
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  var current = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0]
    : [];
  if (headers.some(function(header, index) { return current[index] !== header; })) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function purchaseCreateHistoryEvent_(orderId, action, actor, details, newStatus) {
  var normalizedDetails = details && typeof details === "object" ? details : {};
  if (newStatus) normalizedDetails.to = newStatus;
  return {
    eventKey: "gas-" + Utilities.getUuid().toLowerCase(),
    orderId: String(orderId || "").trim().toLowerCase(),
    action: String(action || "").trim(),
    actor: String(actor || "system").trim(),
    newStatus: newStatus || normalizedDetails.to || null,
    comment: purchaseAutomaticHistoryComment_(action, normalizedDetails),
    details: normalizedDetails,
    createdAt: new Date().toISOString(),
    commentUpdatedAt: null
  };
}

function purchaseAppendHistoryEvent_(ss, event) {
  var sheet = getOrCreatePurchaseOrderHistorySheet_(ss);
  sheet.appendRow(purchaseHistoryRow_(event, false, ""));
  return event;
}

function purchaseHistoryRow_(event, synced, error) {
  return [
    String(event.eventKey || "").trim().toLowerCase(),
    String(event.orderId || "").trim().toLowerCase(),
    String(event.action || "").trim(),
    String(event.actor || "system").trim(),
    String(event.newStatus || "").trim(),
    String(event.comment || ""),
    JSON.stringify(event.details && typeof event.details === "object" ? event.details : {}),
    purchaseHistoryDateValue_(event.createdAt),
    event.commentUpdatedAt ? purchaseHistoryDateValue_(event.commentUpdatedAt) : "",
    synced ? new Date() : "",
    String(error || "")
  ];
}

function purchaseHistoryEventFromRow_(row, indexes) {
  var details = {};
  try { details = JSON.parse(String(row[indexes.DETAILS_JSON] || "{}")); } catch (ignored) {}
  return {
    eventKey: String(row[indexes.EVENT_KEY] || "").trim().toLowerCase(),
    orderId: String(row[indexes.ORDER_ID] || "").trim().toLowerCase(),
    action: String(row[indexes.ACTION] || "").trim(),
    actor: String(row[indexes.ACTOR] || "system").trim(),
    newStatus: String(row[indexes.NOUVEAU_STATUT] || "").trim() || null,
    comment: String(row[indexes.COMMENTAIRE] || ""),
    details: details,
    createdAt: purchaseHistoryIso_(row[indexes.DATE_CREATION]),
    commentUpdatedAt: row[indexes.DATE_COMMENTAIRE_MAJ]
      ? purchaseHistoryIso_(row[indexes.DATE_COMMENTAIRE_MAJ])
      : null
  };
}

function upsertPurchaseOrderHistoryMirror_(events) {
  if (!Array.isArray(events) || !events.length) return 0;
  var ss = SpreadsheetApp.openById(FRJ_SYNC_CONFIG.appSpreadsheetId);
  var sheet = getOrCreatePurchaseOrderHistorySheet_(ss);
  var headers = purchaseOrderHistoryHeaders_();
  var values = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
    : [];
  var indexes = {};
  headers.forEach(function(header, index) { indexes[header] = index; });
  var rowsByKey = {};
  values.forEach(function(row, index) {
    var key = String(row[indexes.EVENT_KEY] || "").trim().toLowerCase();
    if (key) rowsByKey[key] = index + 2;
  });

  var additions = [];
  events.forEach(function(event) {
    var row = purchaseHistoryRow_(event, true, "");
    var key = String(event.eventKey || "").trim().toLowerCase();
    var targetRow = rowsByKey[key];
    if (targetRow) sheet.getRange(targetRow, 1, 1, headers.length).setValues([row]);
    else {
      additions.push(row);
      rowsByKey[key] = sheet.getLastRow() + additions.length;
    }
  });
  if (additions.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, additions.length, headers.length).setValues(additions);
  }
  return events.length;
}

function purchaseReadPendingHistoryEvents_() {
  var ss = SpreadsheetApp.openById(FRJ_SYNC_CONFIG.appSpreadsheetId);
  var sheet = getOrCreatePurchaseOrderHistorySheet_(ss);
  if (sheet.getLastRow() < 2) return { sheet: sheet, indexes: {}, entries: [] };
  var headers = purchaseOrderHistoryHeaders_();
  var indexes = {};
  headers.forEach(function(header, index) { indexes[header] = index; });
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  var entries = [];
  values.forEach(function(row, index) {
    if (entries.length >= 50 || row[indexes.SYNCED_D1_AT] || !row[indexes.EVENT_KEY]) return;
    entries.push({ rowNumber: index + 2, event: purchaseHistoryEventFromRow_(row, indexes) });
  });
  return { sheet: sheet, indexes: indexes, entries: entries };
}

function purchaseMarkHistorySyncResult_(pending, results) {
  var resultsByKey = {};
  (results || []).forEach(function(result) { resultsByKey[String(result.eventKey || "").toLowerCase()] = result; });
  var canonicalEvents = [];
  pending.entries.forEach(function(entry) {
    var result = resultsByKey[entry.event.eventKey];
    if (result && result.ok && result.event) {
      canonicalEvents.push(result.event);
      return;
    }
    var message = result && result.error ? result.error : "Réponse D1 absente";
    pending.sheet.getRange(entry.rowNumber, pending.indexes.SYNC_ERROR + 1)
      .setValue(new Date().toISOString() + " — " + message);
  });
  if (canonicalEvents.length) upsertPurchaseOrderHistoryMirror_(canonicalEvents);
  return canonicalEvents.length;
}

/** Capture uniquement les changements autorisés : statut de commande ou commentaire d'historique. */
function frjCapturePurchaseOrderEdit_(e) {
  var range = e && e.range;
  if (!range || range.getNumRows() !== 1 || range.getNumColumns() !== 1 || range.getRow() < 2) return false;
  var sheet = range.getSheet();
  var sheetName = sheet.getName();
  if (sheetName === "COMMANDES_APP") return purchaseCaptureOrderStatusEdit_(e, sheet, range);
  if (sheetName === "COMMANDES_HISTORIQUE") return purchaseCaptureHistoryCommentEdit_(sheet, range);
  return false;
}

function purchaseStatusConfirmsPricing_(status) {
  return ["preparing", "ready", "completed"].indexOf(
    String(status || "").trim().toLowerCase()
  ) !== -1;
}

function purchaseConfirmPricingInPayload_(payload) {
  if (!payload || !payload.order) return false;
  payload.order.pricingStatus = "confirmed";
  (Array.isArray(payload.items) ? payload.items : []).forEach(function(item) {
    if (item && typeof item === "object") item.priceStatus = "confirmed";
  });
  return true;
}

function purchaseCaptureOrderStatusEdit_(e, sheet, range) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var indexes = {};
  headers.forEach(function(header, index) { indexes[String(header || "").trim()] = index; });
  if (range.getColumn() !== indexes.STATUT + 1) return false;
  var newStatus = String(range.getValue() || "").trim().toLowerCase();
  var allowed = ["submitted", "viewed", "preparing", "ready", "completed", "cancelled", "expired"];
  if (allowed.indexOf(newStatus) === -1) {
    if (e.oldValue !== undefined) range.setValue(e.oldValue);
    throw new Error("Statut de demande invalide : " + newStatus);
  }
  var row = sheet.getRange(range.getRow(), 1, 1, headers.length).getValues()[0];
  var orderId = String(row[indexes.ORDER_ID] || "").trim().toLowerCase();
  if (!/^[a-f0-9-]{36}$/.test(orderId)) throw new Error("Identifiant de demande invalide");
  var payload = {};
  try { payload = JSON.parse(String(row[indexes.SYNC_PAYLOAD_JSON] || "{}")); } catch (ignored) {}
  var previousStatus = String(e.oldValue || (payload.order && payload.order.status) || "submitted").trim().toLowerCase();
  if (previousStatus === newStatus) return false;
  var pricingConfirmed = purchaseStatusConfirmsPricing_(newStatus);
  if (payload.order) {
    payload.order.status = newStatus;
    payload.order.approvalRequired = false;
    if (pricingConfirmed) purchaseConfirmPricingInPayload_(payload);
    sheet.getRange(range.getRow(), indexes.SYNC_PAYLOAD_JSON + 1).setValue(JSON.stringify(payload));
  }
  if (pricingConfirmed && indexes.PRIX_STATUT !== undefined) {
    sheet.getRange(range.getRow(), indexes.PRIX_STATUT + 1).setValue("confirmed");
  }
  if (indexes.APPROVAL_REQUIRED !== undefined) {
    sheet.getRange(range.getRow(), indexes.APPROVAL_REQUIRED + 1).setValue("FALSE");
  }
  if (indexes.SYNCED_D1_AT !== undefined) sheet.getRange(range.getRow(), indexes.SYNCED_D1_AT + 1).clearContent();
  if (indexes.SYNC_ERROR !== undefined) sheet.getRange(range.getRow(), indexes.SYNC_ERROR + 1).clearContent();
  var event = purchaseCreateHistoryEvent_(
    orderId,
    "status-changed",
    "admin",
    { from: previousStatus, to: newStatus, pricingConfirmed: pricingConfirmed },
    newStatus
  );
  purchaseAppendHistoryEvent_(sheet.getParent(), event);
  return true;
}

function purchaseCaptureHistoryCommentEdit_(sheet, range) {
  var headers = purchaseOrderHistoryHeaders_();
  var indexes = {};
  headers.forEach(function(header, index) { indexes[header] = index; });
  if (range.getColumn() !== indexes.COMMENTAIRE + 1) return false;
  var row = sheet.getRange(range.getRow(), 1, 1, headers.length).getValues()[0];
  if (!row[indexes.EVENT_KEY] || !row[indexes.ORDER_ID]) return false;
  sheet.getRange(range.getRow(), indexes.DATE_COMMENTAIRE_MAJ + 1).setValue(new Date());
  sheet.getRange(range.getRow(), indexes.SYNCED_D1_AT + 1).clearContent();
  sheet.getRange(range.getRow(), indexes.SYNC_ERROR + 1).clearContent();
  return true;
}

function purchaseAutomaticHistoryComment_(action, details) {
  var labels = {
    submitted: "Transmise", viewed: "Consultée", preparing: "À préparer", ready: "Prête",
    completed: "Terminée", cancelled: "Annulée", expired: "Expirée"
  };
  if (action === "submitted") return "Demande transmise par le client.";
  if (action === "gas-fallback-synchronized") return "Demande reçue depuis le secours GAS.";
  if (action === "proposal-changed") return "Proposition modifiée par l’administrateur.";
  if (action === "proposal-line-changed") return details.itemName
    ? "Proposition modifiée pour « " + details.itemName + " »."
    : "Une ligne de la proposition a été modifiée.";
  if (action === "proposal-accepted") return "Proposition acceptée par le client.";
  if (action === "client-cancelled") return "Demande annulée par le client.";
  if (action === "status-changed") {
    return "Statut modifié : " + (labels[details.from] || details.from || "Inconnu")
      + " → " + (labels[details.to] || details.to || "Inconnu") + ".";
  }
  return "Événement : " + String(action || "inconnu") + ".";
}

function purchaseHistoryDateValue_(value) {
  var date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? new Date() : date;
}

function purchaseHistoryIso_(value) {
  return purchaseHistoryDateValue_(value).toISOString();
}
