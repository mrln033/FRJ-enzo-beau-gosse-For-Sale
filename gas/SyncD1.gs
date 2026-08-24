var FRJ_SYNC_CONFIG = Object.freeze({
  d1Url: "https://frj-for-sale-api.merlin-merzhin-lesage.workers.dev",
  appSpreadsheetId: "13r_PzIZE8dJiPFU8w7UXxtEednHhS-yijNgTiYLqYP0",
  catalogSheetName: "BDD_APP",
  inventorySpreadsheetId: "1C-TWYWKI7Vge3wywEUHjYAKm3GOBP4rgiaBbAch0Jng",
  marketSpreadsheetId: "13r_PzIZE8dJiPFU8w7UXxtEednHhS-yijNgTiYLqYP0",
  marketSheetName: "MU_Pondérés",
  tokenProperty: "FRJ_D1_SYNC_TOKEN",
  basePropertyPrefix: "FRJ_SYNC_BASE_",
  syncDelayMs: 5 * 60 * 1000,
  auditDelayMs: 30 * 60 * 1000,
  dailyAuditHour: 2,
  schedulerVersion: "2026-08-13-v3",
  outboxProperty: "FRJ_GAS_OUTBOX",
  inventorySheets: {
    enzo: "Inventaire Enzo",
    arkaman: "Inventaire ArkaMan",
    kenza: "Inventaire Kenza",
    nocturnal: "Inventaire Nocturnal"
  }
});

/**
 * À exécuter une seule fois depuis l'éditeur Apps Script.
 * Demande le jeton privé, crée les triggers événementiels et lance un audit initial.
 */
function configureFrjBidirectionalSync() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt(
    "Synchronisation GAS ↔ D1",
    "Colle le jeton de synchronisation Cloudflare :",
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return "Configuration annulée";

  var token = String(response.getResponseText() || "").trim();
  if (!token) throw new Error("Jeton de synchronisation vide");
  PropertiesService.getScriptProperties().setProperty(FRJ_SYNC_CONFIG.tokenProperty, token);
  installFrjBidirectionalSync();
  return runFrjSyncAuditNow();
}

/** Utilisé uniquement par le déploiement automatisé clasp. */
function setFrjSyncTokenForDeployment(token) {
  token = String(token || "").trim();
  if (token.length < 32) throw new Error("Jeton de synchronisation invalide");
  PropertiesService.getScriptProperties().setProperty(FRJ_SYNC_CONFIG.tokenProperty, token);
  return installFrjBidirectionalSync();
}

function installFrjBidirectionalSync() {
  frjRequireSyncToken_();
  var handlers = frjOwnedTriggerHandlers_();
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });

  [FRJ_SYNC_CONFIG.appSpreadsheetId, FRJ_SYNC_CONFIG.inventorySpreadsheetId].forEach(function(spreadsheetId) {
    ScriptApp.newTrigger("frjSpreadsheetChangedTrigger").forSpreadsheet(spreadsheetId).onEdit().create();
    ScriptApp.newTrigger("frjSpreadsheetChangedTrigger").forSpreadsheet(spreadsheetId).onChange().create();
  });
  ScriptApp.newTrigger("frjDailyAuditTrigger")
    .timeBased()
    .atHour(FRJ_SYNC_CONFIG.dailyAuditHour)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone("Europe/Paris")
    .create();
  // Ce trigger ne synchronise pas les données : il ne lit qu'un petit marqueur D1.
  ScriptApp.newTrigger("frjD1SignalPollTrigger").timeBased().everyMinutes(5).create();

  var properties = PropertiesService.getScriptProperties();
  properties.deleteProperty("FRJ_SYNC_TRIGGER_AT");
  properties.deleteProperty("FRJ_AUDIT_TRIGGER_AT");
  properties.setProperties({
    FRJ_SYNC_INSTALLED_AT: new Date().toISOString(),
    FRJ_SYNC_SCHEDULER_VERSION: FRJ_SYNC_CONFIG.schedulerVersion
  });
  var now = Date.now();
  var dirtyAt = Number(properties.getProperty("FRJ_SYNC_DIRTY_AT") || 0);
  if (dirtyAt) {
    frjScheduleOneShot_(
      "frjDeferredSyncTrigger",
      frjComputeSyncRunAt_(dirtyAt, now),
      "FRJ_SYNC_TRIGGER_AT",
      true
    );
  }
  var lastRunAt = Number(properties.getProperty("FRJ_SYNC_LAST_RUN_AT") || 0);
  if (lastRunAt) {
    frjScheduleOneShot_(
      "frjDeferredAuditTrigger",
      Math.max(now + 1000, lastRunAt + FRJ_SYNC_CONFIG.auditDelayMs),
      "FRJ_AUDIT_TRIGGER_AT"
    );
  }
  return getFrjSyncStatus();
}

/** Point d'entrée recommandé pour un projet Apps Script autonome. */
function activateFrjBidirectionalSync() {
  installFrjBidirectionalSync();
  return runFrjSyncAuditNow();
}

function removeFrjBidirectionalSync() {
  var handlers = frjOwnedTriggerHandlers_();
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });
  return "Triggers de synchronisation supprimés";
}

function frjOwnedTriggerHandlers_() {
  return [
    "frjSyncFastTrigger", "frjSyncAuditTrigger",
    "frjSpreadsheetChangedTrigger", "frjDeferredSyncTrigger",
    "frjDeferredAuditTrigger", "frjDailyAuditTrigger", "frjD1SignalPollTrigger"
  ];
}

// Compatibilité transitoire : les anciens triggers 15/30 min se remplacent eux-mêmes
// dès leur prochaine exécution après la publication de cette version.
function frjSyncFastTrigger() {
  return installFrjBidirectionalSync();
}

function frjSyncAuditTrigger() {
  return installFrjBidirectionalSync();
}

function frjSpreadsheetChangedTrigger(e) {
  frjEnsureSchedulerVersion_();
  var sourceId = "";
  try { sourceId = e && e.source ? e.source.getId() : ""; } catch (ignored) {}
  var outbox = frjCaptureGasOutbox_();
  frjPublishGasObservations_(outbox);
  return frjRequestSynchronization_("modification-google-sheet", sourceId);
}

function frjDeferredSyncTrigger() {
  var properties = PropertiesService.getScriptProperties();
  properties.deleteProperty("FRJ_SYNC_TRIGGER_AT");
  var dirtyAt = Number(properties.getProperty("FRJ_SYNC_DIRTY_AT") || 0);
  if (!dirtyAt) return "Aucune modification en attente";

  var summary;
  try {
    summary = frjRunSync_(false);
  } catch (error) {
    // La demande reste marquée comme sale et sera retentée cinq minutes plus tard.
    frjScheduleOneShot_(
      "frjDeferredSyncTrigger",
      Date.now() + FRJ_SYNC_CONFIG.syncDelayMs,
      "FRJ_SYNC_TRIGGER_AT",
      true
    );
    throw error;
  }
  var completedAt = Date.now();
  frjAcknowledgeGasOutbox_(summary);
  properties.setProperty("FRJ_SYNC_LAST_RUN_AT", String(completedAt));
  if (Number(properties.getProperty("FRJ_SYNC_DIRTY_AT") || 0) <= dirtyAt) {
    properties.deleteProperty("FRJ_SYNC_DIRTY_AT");
    properties.deleteProperty("FRJ_SYNC_DIRTY_REASON");
  } else {
    var latestDirtyAt = Number(properties.getProperty("FRJ_SYNC_DIRTY_AT") || completedAt);
    frjScheduleOneShot_(
      "frjDeferredSyncTrigger",
      frjComputeSyncRunAt_(latestDirtyAt, completedAt),
      "FRJ_SYNC_TRIGGER_AT",
      true
    );
  }
  frjScheduleIntegrityAudit_(completedAt);
  return summary;
}

function frjDeferredAuditTrigger() {
  var properties = PropertiesService.getScriptProperties();
  properties.deleteProperty("FRJ_AUDIT_TRIGGER_AT");
  var lastRunAt = Number(properties.getProperty("FRJ_SYNC_LAST_RUN_AT") || 0);
  var dueAt = lastRunAt + FRJ_SYNC_CONFIG.auditDelayMs;
  if (lastRunAt && Date.now() + 1000 < dueAt) {
    frjScheduleOneShot_("frjDeferredAuditTrigger", dueAt, "FRJ_AUDIT_TRIGGER_AT");
    return "Audit replanifié après la dernière synchronisation";
  }
  return frjRunIntegrityAudit_("audit-integrite-30-minutes");
}

function frjDailyAuditTrigger() {
  frjEnsureSchedulerVersion_();
  return frjRunIntegrityAudit_("audit-quotidien-02h");
}

function frjD1SignalPollTrigger() {
  frjEnsureSchedulerVersion_();
  var properties = PropertiesService.getScriptProperties();
  // Le poll régulier applique aussi une préparation locale devenue nécessaire
  // après un déploiement, même lorsqu'aucun dataset n'attend de synchronisation.
  frjEnsureContainerConfigurationReady_();
  var outbox = frjCaptureGasOutbox_();
  frjPublishGasObservations_(outbox);
  var scheduled = [];

  // La détection locale reste opérationnelle même si Cloudflare/D1 est indisponible.
  if (outbox.length) {
    var datasets = outbox.map(function(entry) { return entry.dataset; }).join(",");
    var alreadyWaitedAt = new Date(Date.now() - FRJ_SYNC_CONFIG.syncDelayMs).toISOString();
    frjRequestSynchronization_("gas-outbox", datasets, alreadyWaitedAt, true);
    scheduled.push("GAS:" + datasets);
  }

  try {
    var pending = frjD1Request_("/sync/pending").request;
    var lastSeen = Number(properties.getProperty("FRJ_D1_LAST_REQUEST_ID") || 0);
    if (pending && pending.id && pending.id > lastSeen) {
      properties.setProperty("FRJ_D1_LAST_REQUEST_ID", String(pending.id));
      frjRequestSynchronization_(pending.reason || "modification-d1", pending.dataset || "", pending.createdAt);
      scheduled.push("D1:" + (pending.dataset || "tous"));
    }
    var ordersPushed = frjPushPendingPurchaseOrders_();
    if (ordersPushed) scheduled.push("COMMANDES:" + ordersPushed);
    var ordersPulled = frjPullPurchaseOrdersFromD1_();
    if (ordersPulled) scheduled.push("COMMANDES-D1:" + ordersPulled);
    properties.deleteProperty("FRJ_D1_POLL_LAST_ERROR");
  } catch (error) {
    properties.setProperty("FRJ_D1_POLL_LAST_ERROR", new Date().toISOString() + " — " + error.message);
    console.error(JSON.stringify({ message: "D1 indisponible pendant le contrôle de l'outbox", error: error.message }));
  }

  return scheduled.length ? "Synchronisation programmée : " + scheduled.join(" / ") : "Aucune modification détectée";
}
