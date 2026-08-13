var FRJ_SYNC_CONFIG = Object.freeze({
  d1Url: "https://frj-for-sale-api.merlin-merzhin-lesage.workers.dev",
  appSpreadsheetId: "13r_PzIZE8dJiPFU8w7UXxtEednHhS-yijNgTiYLqYP0",
  catalogSheetName: "BDD_APP",
  inventorySpreadsheetId: "1C-TWYWKI7Vge3wywEUHjYAKm3GOBP4rgiaBbAch0Jng",
  marketSpreadsheetId: "13r_PzIZE8dJiPFU8w7UXxtEednHhS-yijNgTiYLqYP0",
  marketSheetName: "MU_Pondérés",
  tokenProperty: "FRJ_D1_SYNC_TOKEN",
  basePropertyPrefix: "FRJ_SYNC_BASE_",
  inventorySheets: {
    enzo: "Inventaire Enzo",
    arkaman: "Inventaire ArkaMan",
    kenza: "Inventaire Kenza",
    nocturnal: "Inventaire Nocturnal"
  }
});

/**
 * À exécuter une seule fois depuis l'éditeur Apps Script.
 * Demande le jeton privé, crée les triggers 15/30 minutes et lance un audit initial.
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
  var handlers = ["frjSyncFastTrigger", "frjSyncAuditTrigger"];
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });

  ScriptApp.newTrigger("frjSyncFastTrigger").timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger("frjSyncAuditTrigger").timeBased().everyMinutes(30).create();
  PropertiesService.getScriptProperties().setProperty("FRJ_SYNC_INSTALLED_AT", new Date().toISOString());
  return getFrjSyncStatus();
}

/** Point d'entrée recommandé pour un projet Apps Script autonome. */
function activateFrjBidirectionalSync() {
  installFrjBidirectionalSync();
  return runFrjSyncAuditNow();
}

function removeFrjBidirectionalSync() {
  var handlers = ["frjSyncFastTrigger", "frjSyncAuditTrigger"];
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });
  return "Triggers de synchronisation supprimés";
}

function frjSyncFastTrigger() {
  return frjRunSync_(false);
}

function frjSyncAuditTrigger() {
  return frjRunSync_(true);
}

function runFrjSyncNow() {
  return frjRunSync_(false);
}

function runFrjSyncAuditNow() {
  return frjRunSync_(true);
}

function getFrjSyncStatus() {
  var properties = PropertiesService.getScriptProperties();
  var triggers = ScriptApp.getProjectTriggers().filter(function(trigger) {
    return ["frjSyncFastTrigger", "frjSyncAuditTrigger"].indexOf(trigger.getHandlerFunction()) !== -1;
  }).map(function(trigger) {
    return { handler: trigger.getHandlerFunction(), id: trigger.getUniqueId() };
  });

  return {
    configured: Boolean(properties.getProperty(FRJ_SYNC_CONFIG.tokenProperty)),
    installedAt: properties.getProperty("FRJ_SYNC_INSTALLED_AT") || "",
    lastSuccess: properties.getProperty("FRJ_SYNC_LAST_SUCCESS") || "",
    lastError: properties.getProperty("FRJ_SYNC_LAST_ERROR") || "",
    lastSummary: properties.getProperty("FRJ_SYNC_LAST_SUMMARY") || "",
    triggers: triggers
  };
}

function withFrjDataLock_(callback) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Une autre importation ou synchronisation est déjà en cours");
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function frjRunSync_(forceAudit) {
  return withFrjDataLock_(function() {
    var properties = PropertiesService.getScriptProperties();
    var summary = [];
    try {
      var remoteStates = frjD1Request_("/sync/state").datasets || {};
      Object.keys(FRJ_SYNC_CONFIG.inventorySheets).forEach(function(avatar) {
        var dataset = "inventory:" + avatar;
        summary.push(frjSynchronizeDataset_(dataset, remoteStates[dataset], forceAudit, 0));
      });
      summary.push(frjSynchronizeDataset_("mu", remoteStates.mu, forceAudit, 0));
      summary.push(frjSynchronizeDataset_("catalog", remoteStates.catalog, forceAudit, 0));

      var completedAt = new Date().toISOString();
      properties.setProperties({
        FRJ_SYNC_LAST_SUCCESS: completedAt,
        FRJ_SYNC_LAST_ERROR: "",
        FRJ_SYNC_LAST_SUMMARY: JSON.stringify(summary)
      });
      console.log(JSON.stringify({ message: "Synchronisation FRJ terminée", audit: forceAudit, summary: summary }));
      return summary;
    } catch (error) {
      properties.setProperty("FRJ_SYNC_LAST_ERROR", new Date().toISOString() + " — " + error.message);
      console.error(JSON.stringify({ message: "Synchronisation FRJ échouée", error: error.message }));
      throw error;
    }
  });
}

function frjSynchronizeDataset_(dataset, remoteState, forceAudit, retryCount) {
  if (!remoteState) throw new Error("État D1 absent pour " + dataset);

  var local = frjReadLocalDataset_(dataset);
  var remoteSnapshot = forceAudit ? frjReadRemoteDataset_(dataset) : null;
  if (remoteSnapshot) {
    var verifiedRemoteHash = frjHashDataset_(dataset, remoteSnapshot.rows);
    if (verifiedRemoteHash !== remoteState.hash) {
      throw new Error("Empreinte D1 incohérente pour " + dataset);
    }
  }

  if (local.hash === remoteState.hash) {
    frjSetBaseHash_(dataset, local.hash);
    if (forceAudit) frjReportAudit_(dataset, "verified", local.hash, remoteState.hash, { rows: local.rows.length });
    return { dataset: dataset, action: "identique", rows: local.rows.length, hash: local.hash };
  }

  var baseHash = frjGetBaseHash_(dataset);
  var localChanged = !baseHash || local.hash !== baseHash;
  var remoteChanged = !baseHash || remoteState.hash !== baseHash;
  var direction;
  var mergeCandidate = null;

  if (dataset === "catalog") {
    // BDD_APP reste pour l'instant le référentiel maître : ses colonnes E:G sont des formules IMPORTRANGE.
    direction = "gas-to-d1";
  } else if (localChanged && !remoteChanged) {
    direction = "gas-to-d1";
  } else if (remoteChanged && !localChanged) {
    direction = "d1-to-gas";
  } else if (baseHash) {
    remoteSnapshot = remoteSnapshot || frjReadRemoteDataset_(dataset);
    try {
      var baseSnapshot = frjReadRemoteDatasetByHash_(dataset, baseHash);
      var mergedRows = frjThreeWayMerge_(
        dataset,
        baseSnapshot.rows,
        local.rows,
        remoteSnapshot.rows,
        frjCompareDates_(local.updatedAt, remoteState.updatedAt) >= 0 ? "local" : "remote"
      );
      mergeCandidate = {
        rows: mergedRows,
        hash: frjHashDataset_(dataset, mergedRows),
        updatedAt: frjCompareDates_(local.updatedAt, remoteState.updatedAt) >= 0
          ? local.updatedAt
          : remoteState.updatedAt
      };
      direction = "fusion-gas-d1";
    } catch (error) {
      if (error.frjStatus !== 404) throw error;
      direction = frjCompareDates_(local.updatedAt, remoteState.updatedAt) > 0 ? "gas-to-d1" : "d1-to-gas";
    }
  } else {
    direction = frjCompareDates_(local.updatedAt, remoteState.updatedAt) > 0 ? "gas-to-d1" : "d1-to-gas";
  }

  try {
    if (direction === "fusion-gas-d1") {
      if (frjReadLocalDataset_(dataset).hash !== local.hash) {
        return frjRetryDatasetAfterConcurrentChange_(dataset, forceAudit, retryCount);
      }
      var mergedResult = frjPushDataset_(dataset, mergeCandidate, remoteState.hash);
      frjWriteLocalDataset_(dataset, { state: mergedResult.state, rows: mergeCandidate.rows });
      frjSetBaseHash_(dataset, mergedResult.state.hash);
    } else if (direction === "gas-to-d1") {
      if (frjReadLocalDataset_(dataset).hash !== local.hash) {
        return frjRetryDatasetAfterConcurrentChange_(dataset, forceAudit, retryCount);
      }
      var pushed = frjPushDataset_(dataset, local, remoteState.hash);
      frjSetBaseHash_(dataset, pushed.state.hash);
    } else {
      remoteSnapshot = remoteSnapshot || frjReadRemoteDataset_(dataset);
      if (frjReadLocalDataset_(dataset).hash !== local.hash) {
        return frjRetryDatasetAfterConcurrentChange_(dataset, forceAudit, retryCount);
      }
      frjWriteLocalDataset_(dataset, remoteSnapshot);
      var reloaded = frjReadLocalDataset_(dataset);
      if (reloaded.hash !== remoteSnapshot.state.hash) {
        throw new Error("Échec de vérification après écriture GAS pour " + dataset);
      }
      frjSetBaseHash_(dataset, reloaded.hash);
    }
  } catch (error) {
    if (error.frjStatus === 409 && retryCount < 1) {
      var refreshedStates = frjD1Request_("/sync/state").datasets || {};
      return frjSynchronizeDataset_(dataset, refreshedStates[dataset], forceAudit, retryCount + 1);
    }
    throw error;
  }

  var finalLocal = frjReadLocalDataset_(dataset);
  var finalRemote = frjReadRemoteDataset_(dataset);
  var finalRemoteHash = frjHashDataset_(dataset, finalRemote.rows);
  if (finalLocal.hash !== finalRemote.state.hash || finalRemoteHash !== finalRemote.state.hash) {
    throw new Error("Réconciliation incomplète pour " + dataset);
  }

  frjReportAudit_(dataset, "reconciled", finalLocal.hash, finalRemote.state.hash, {
    direction: direction,
    rows: finalLocal.rows.length,
    conflict: localChanged && remoteChanged
  });
  frjClearCatalogCache_();
  return {
    dataset: dataset,
    action: direction,
    conflict: localChanged && remoteChanged,
    rows: finalLocal.rows.length,
    hash: finalLocal.hash
  };
}

function frjRetryDatasetAfterConcurrentChange_(dataset, forceAudit, retryCount) {
  if (retryCount >= 1) {
    throw new Error("Le dataset GAS a changé pendant la synchronisation : " + dataset);
  }
  var refreshedStates = frjD1Request_("/sync/state").datasets || {};
  return frjSynchronizeDataset_(dataset, refreshedStates[dataset], forceAudit, retryCount + 1);
}

function frjReadLocalDataset_(dataset) {
  if (dataset === "catalog") return frjReadLocalCatalog_();
  if (dataset === "mu") return frjReadLocalMarket_();
  return frjReadLocalInventory_(dataset.slice("inventory:".length));
}

function frjReadRemoteDataset_(dataset) {
  if (dataset === "catalog") return frjD1Request_("/sync/catalog");
  if (dataset === "mu") return frjD1Request_("/sync/mu");
  return frjD1Request_("/sync/inventory?avatar=" + encodeURIComponent(dataset.slice("inventory:".length)));
}

function frjReadRemoteDatasetByHash_(dataset, hash) {
  if (dataset === "catalog") return frjD1Request_("/sync/catalog?hash=" + encodeURIComponent(hash));
  if (dataset === "mu") return frjD1Request_("/sync/mu?hash=" + encodeURIComponent(hash));
  return frjD1Request_(
    "/sync/inventory?avatar=" + encodeURIComponent(dataset.slice("inventory:".length)) +
    "&hash=" + encodeURIComponent(hash)
  );
}

function frjWriteLocalDataset_(dataset, snapshot) {
  if (dataset === "catalog") throw new Error("BDD_APP est actuellement le référentiel maître du catalogue");
  if (dataset === "mu") return frjWriteLocalMarket_(snapshot);
  return frjWriteLocalInventory_(dataset.slice("inventory:".length), snapshot);
}

function frjPushDataset_(dataset, local, expectedHash) {
  var path = dataset === "catalog"
    ? "/sync/catalog"
    : (dataset === "mu"
      ? "/sync/mu"
      : "/sync/inventory?avatar=" + encodeURIComponent(dataset.slice("inventory:".length)));
  return frjD1Request_(path, {
    method: "post",
    expectedHash: expectedHash,
    payload: JSON.stringify({ rows: local.rows, updatedAt: local.updatedAt })
  });
}

function frjThreeWayMerge_(dataset, baseRows, localRows, remoteRows, conflictWinner) {
  var base = frjRowsByStableKey_(dataset, baseRows);
  var local = frjRowsByStableKey_(dataset, localRows);
  var remote = frjRowsByStableKey_(dataset, remoteRows);
  var keys = {};
  Object.keys(base).concat(Object.keys(local), Object.keys(remote)).forEach(function(key) { keys[key] = true; });

  return Object.keys(keys).sort().map(function(key) {
    var baseRow = base[key];
    var localRow = local[key];
    var remoteRow = remote[key];
    var baseSignature = frjRowSignature_(dataset, baseRow);
    var localSignature = frjRowSignature_(dataset, localRow);
    var remoteSignature = frjRowSignature_(dataset, remoteRow);

    if (localSignature === remoteSignature) return localRow;
    if (localSignature === baseSignature) return remoteRow;
    if (remoteSignature === baseSignature) return localRow;
    return conflictWinner === "local" ? localRow : remoteRow;
  }).filter(function(row) { return row !== undefined; });
}

function frjRowsByStableKey_(dataset, rows) {
  var result = {};
  var occurrences = {};
  rows.forEach(function(row) {
    var baseKey;
    if (dataset === "mu") {
      baseKey = "item:" + frjText_(row.itemName).toLowerCase();
    } else if (dataset === "catalog") {
      baseKey = "listing:" + [
        frjText_(row.itemName).toLowerCase(),
        frjText_(row.storage).toLowerCase(),
        frjText_(row.aisle).toLowerCase()
      ].join("|");
    } else if (frjText_(row.sourceId)) {
      baseKey = "id:" + frjText_(row.sourceId);
    } else {
      baseKey = "fallback:" + [
        frjText_(row.itemName).toLowerCase(),
        frjText_(row.container).toLowerCase(),
        frjText_(row.containerRefId)
      ].join("|");
    }
    occurrences[baseKey] = (occurrences[baseKey] || 0) + 1;
    result[baseKey + "#" + occurrences[baseKey]] = row;
  });
  return result;
}

function frjRowSignature_(dataset, row) {
  if (row === undefined) return "__ABSENT__";
  if (dataset === "mu") {
    return JSON.stringify([
      frjText_(row.itemName), frjText_(row.tier),
      frjText_(row.dayMarkup), frjText_(row.daySales),
      frjText_(row.weekMarkup), frjText_(row.weekSales),
      frjText_(row.monthMarkup), frjText_(row.monthSales),
      frjText_(row.yearMarkup), frjText_(row.yearSales),
      frjText_(row.decadeMarkup), frjText_(row.decadeSales),
      frjToIso_(row.observedAt, "")
    ]);
  }
  if (dataset === "catalog") {
    return JSON.stringify([
      frjText_(row.itemName), frjText_(row.storage).toUpperCase(), frjText_(row.aisle).toUpperCase(),
      frjNullableNumberText_(row.unitPricePed), frjText_(row.image), frjText_(row.wikiUrl),
      Number(row.enabled) === 0 ? "0" : "1"
    ]);
  }
  return JSON.stringify([
    frjText_(row.sourceId), frjText_(row.itemName), frjNumber_(row.quantity),
    frjNullableNumberText_(row.valuePed), frjText_(row.container), frjText_(row.containerRefId)
  ]);
}

function frjReadLocalInventory_(avatar) {
  var sheetName = FRJ_SYNC_CONFIG.inventorySheets[avatar];
  if (!sheetName) throw new Error("Avatar inconnu : " + avatar);
  var sheet = SpreadsheetApp.openById(FRJ_SYNC_CONFIG.inventorySpreadsheetId).getSheetByName(sheetName);
  if (!sheet) throw new Error("Feuille introuvable : " + sheetName);
  var lastRow = Math.max(sheet.getLastRow(), 1);
  var values = sheet.getRange(1, 1, lastRow, 6).getValues();
  var rows = [];

  for (var index = 1; index < values.length; index++) {
    var itemName = String(values[index][1] || "").trim();
    var quantity = Number(values[index][2]);
    if (!itemName || !isFinite(quantity)) continue;
    rows.push({
      sourceId: frjNullableText_(values[index][0]),
      itemName: itemName,
      quantity: quantity,
      valuePed: frjNullableNumber_(values[index][3]),
      container: frjNullableText_(values[index][4]),
      containerRefId: frjNullableText_(values[index][5])
    });
  }

  if (!rows.length) throw new Error("Inventaire local vide : " + sheetName);
  var updatedAt = frjToIso_(values[0][1], "1970-01-01T00:00:00.000Z");
  return { rows: rows, hash: frjHashInventory_(rows), updatedAt: updatedAt };
}

function frjReadLocalCatalog_() {
  var spreadsheet = SpreadsheetApp.openById(FRJ_SYNC_CONFIG.appSpreadsheetId);
  var sheet = spreadsheet.getSheetByName(FRJ_SYNC_CONFIG.catalogSheetName);
  if (!sheet) throw new Error("Feuille BDD_APP introuvable");
  var lastRow = Math.max(sheet.getLastRow(), 1);
  var values = sheet.getRange(1, 1, lastRow, 7).getValues();
  var rows = [];

  for (var index = 1; index < values.length; index++) {
    var itemName = String(values[index][2] || "").trim();
    if (!itemName) continue;
    rows.push({
      itemName: itemName,
      storage: String(values[index][0] || "").trim().toUpperCase(),
      aisle: String(values[index][1] || "").trim().toUpperCase(),
      unitPricePed: frjNullableNumber_(values[index][4]),
      image: frjNullableText_(values[index][5]),
      wikiUrl: frjNullableText_(values[index][6]),
      enabled: 1
    });
  }

  if (!rows.length) throw new Error("Catalogue BDD_APP vide");
  var updatedAt = DriveApp.getFileById(FRJ_SYNC_CONFIG.appSpreadsheetId).getLastUpdated().toISOString();
  return { rows: rows, hash: frjHashCatalog_(rows), updatedAt: updatedAt };
}

function frjWriteLocalInventory_(avatar, snapshot) {
  var sheetName = FRJ_SYNC_CONFIG.inventorySheets[avatar];
  var sheet = SpreadsheetApp.openById(FRJ_SYNC_CONFIG.inventorySpreadsheetId).getSheetByName(sheetName);
  if (!sheet) throw new Error("Feuille introuvable : " + sheetName);
  var rowCount = snapshot.rows.length + 1;
  if (sheet.getMaxRows() < rowCount) sheet.insertRowsAfter(sheet.getMaxRows(), rowCount - sheet.getMaxRows());
  if (sheet.getMaxColumns() < 6) sheet.insertColumnsAfter(sheet.getMaxColumns(), 6 - sheet.getMaxColumns());

  var updatedAt = new Date(snapshot.state.updatedAt);
  var data = [["Id", updatedAt, "Quantity", "Value(PED)", "Container", "ContainerRefId"]];
  snapshot.rows.forEach(function(row) {
    data.push([
      row.sourceId || "",
      row.itemName,
      Number(row.quantity),
      row.valuePed === null || row.valuePed === undefined ? "" : Number(row.valuePed),
      row.container || "",
      row.containerRefId || ""
    ]);
  });

  sheet.getRange(1, 1, sheet.getMaxRows(), 6).clearContent();
  sheet.getRange(1, 1, data.length, 6).setValues(data);
  sheet.getRange("B1").setNumberFormat("dd/MM/yyyy - HH:mm:ss");
  SpreadsheetApp.flush();
}

function frjReadLocalMarket_() {
  var sheet = SpreadsheetApp.openById(FRJ_SYNC_CONFIG.marketSpreadsheetId)
    .getSheetByName(FRJ_SYNC_CONFIG.marketSheetName);
  if (!sheet) throw new Error("Feuille MU introuvable");
  var lastRow = Math.max(sheet.getLastRow(), 1);
  var values = sheet.getRange(1, 1, lastRow, 13).getValues();
  var rows = [];
  var latest = "1970-01-01T00:00:00.000Z";

  for (var index = 1; index < values.length; index++) {
    var itemName = String(values[index][1] || "").trim();
    if (!itemName) continue;
    var observedAt = frjToIso_(values[index][0], "1970-01-01T00:00:00.000Z");
    if (frjCompareDates_(observedAt, latest) > 0) latest = observedAt;
    rows.push({
      itemName: itemName,
      tier: frjNullableText_(values[index][2]),
      dayMarkup: frjNullableText_(values[index][3]),
      daySales: frjNullableText_(values[index][4]),
      weekMarkup: frjNullableText_(values[index][5]),
      weekSales: frjNullableText_(values[index][6]),
      monthMarkup: frjNullableText_(values[index][7]),
      monthSales: frjNullableText_(values[index][8]),
      yearMarkup: frjNullableText_(values[index][9]),
      yearSales: frjNullableText_(values[index][10]),
      decadeMarkup: frjNullableText_(values[index][11]),
      decadeSales: frjNullableText_(values[index][12]),
      observedAt: observedAt
    });
  }

  if (!rows.length) throw new Error("Snapshot MU local vide");
  return { rows: rows, hash: frjHashMarket_(rows), updatedAt: latest };
}

function frjWriteLocalMarket_(snapshot) {
  var sheet = SpreadsheetApp.openById(FRJ_SYNC_CONFIG.marketSpreadsheetId)
    .getSheetByName(FRJ_SYNC_CONFIG.marketSheetName);
  if (!sheet) throw new Error("Feuille MU introuvable");
  var rowCount = snapshot.rows.length + 1;
  if (sheet.getMaxRows() < rowCount) sheet.insertRowsAfter(sheet.getMaxRows(), rowCount - sheet.getMaxRows());
  if (sheet.getMaxColumns() < 13) sheet.insertColumnsAfter(sheet.getMaxColumns(), 13 - sheet.getMaxColumns());

  var data = snapshot.rows.map(function(row) {
    return [
      new Date(row.observedAt), row.itemName, row.tier || "",
      row.dayMarkup || "", row.daySales || "",
      row.weekMarkup || "", row.weekSales || "",
      row.monthMarkup || "", row.monthSales || "",
      row.yearMarkup || "", row.yearSales || "",
      row.decadeMarkup || "", row.decadeSales || ""
    ];
  });

  if (sheet.getMaxRows() > 1) sheet.getRange(2, 1, sheet.getMaxRows() - 1, 13).clearContent();
  if (data.length) {
    sheet.getRange(2, 1, data.length, 13).setValues(data);
    sheet.getRange(2, 1, data.length, 1).setNumberFormat("dd/MM/yyyy HH:mm:ss");
  }
  SpreadsheetApp.flush();
}

function frjHashDataset_(dataset, rows) {
  if (dataset === "catalog") return frjHashCatalog_(rows);
  return dataset === "mu" ? frjHashMarket_(rows) : frjHashInventory_(rows);
}

function frjHashInventory_(rows) {
  var payload = rows.map(function(row) {
    return JSON.stringify([
      frjText_(row.sourceId), frjText_(row.itemName), frjNumber_(row.quantity),
      frjNullableNumberText_(row.valuePed), frjText_(row.container), frjText_(row.containerRefId)
    ]);
  }).sort().join("\n");
  return frjSha256_(payload);
}

function frjHashMarket_(rows) {
  var fields = [
    "itemName", "tier", "dayMarkup", "daySales", "weekMarkup", "weekSales",
    "monthMarkup", "monthSales", "yearMarkup", "yearSales", "decadeMarkup", "decadeSales"
  ];
  var payload = rows.map(function(row) {
    var values = fields.map(function(field) { return frjText_(row[field]); });
    values.push(frjToIso_(row.observedAt, ""));
    return JSON.stringify(values);
  }).sort().join("\n");
  return frjSha256_(payload);
}

function frjHashCatalog_(rows) {
  var payload = rows.map(function(row) {
    return JSON.stringify([
      frjText_(row.itemName), frjText_(row.storage).toUpperCase(), frjText_(row.aisle).toUpperCase(),
      frjNullableNumberText_(row.unitPricePed), frjText_(row.image), frjText_(row.wikiUrl),
      Number(row.enabled) === 0 ? "0" : "1"
    ]);
  }).sort().join("\n");
  return frjSha256_(payload);
}

function frjSha256_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  ).map(function(byte) {
    return ((byte + 256) % 256).toString(16).padStart(2, "0");
  }).join("");
}

function frjD1Request_(path, options) {
  options = options || {};
  var requestOptions = {
    method: options.method || "get",
    muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + frjRequireSyncToken_() }
  };
  if (options.expectedHash) requestOptions.headers["X-Expected-Hash"] = options.expectedHash;
  if (options.payload !== undefined) {
    requestOptions.contentType = "application/json; charset=UTF-8";
    requestOptions.payload = options.payload;
  }

  var response = UrlFetchApp.fetch(FRJ_SYNC_CONFIG.d1Url + path, requestOptions);
  var status = response.getResponseCode();
  var text = response.getContentText();
  var data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { error: text || "Réponse D1 non JSON" };
  }
  if (status < 200 || status >= 300) {
    var requestError = new Error("D1 HTTP " + status + " : " + (data.error || text));
    requestError.frjStatus = status;
    throw requestError;
  }
  return data;
}

function frjReportAudit_(dataset, action, sourceHash, targetHash, details) {
  try {
    frjD1Request_("/sync/audit", {
      method: "post",
      payload: JSON.stringify({
        dataset: dataset,
        direction: "gas-audit",
        action: action,
        sourceHash: sourceHash,
        targetHash: targetHash,
        details: details || {}
      })
    });
  } catch (error) {
    console.error(JSON.stringify({ message: "Audit D1 non enregistré", dataset: dataset, error: error.message }));
  }
}

function frjRequireSyncToken_() {
  var token = PropertiesService.getScriptProperties().getProperty(FRJ_SYNC_CONFIG.tokenProperty) || "";
  if (!token) throw new Error("Jeton FRJ_D1_SYNC_TOKEN non configuré");
  return token;
}

function frjGetBaseHash_(dataset) {
  return PropertiesService.getScriptProperties().getProperty(FRJ_SYNC_CONFIG.basePropertyPrefix + dataset) || "";
}

function frjSetBaseHash_(dataset, hash) {
  PropertiesService.getScriptProperties().setProperty(FRJ_SYNC_CONFIG.basePropertyPrefix + dataset, hash);
}

function frjClearCatalogCache_() {
  CacheService.getScriptCache().removeAll([
    "cat_ARMORS", "cat_BLUEPRINTS", "cat_CLOTHES", "cat_MATERIALS", "cat_MINDFORCE",
    "cat_MISCELLANEOUS", "cat_RESOURCES", "cat_TOOLS", "cat_VEHICLES", "cat_WEAPONS"
  ]);
}

function frjCompareDates_(left, right) {
  var leftTime = new Date(left || 0).getTime();
  var rightTime = new Date(right || 0).getTime();
  return leftTime === rightTime ? 0 : (leftTime > rightTime ? 1 : -1);
}

function frjToIso_(value, fallback) {
  var date = value instanceof Date ? value : new Date(value || "");
  return isNaN(date.getTime()) ? fallback : date.toISOString();
}

function frjText_(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function frjNumber_(value) {
  var number = Number(value);
  return isFinite(number) ? String(number) : "0";
}

function frjNullableNumberText_(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  var number = Number(value);
  return isFinite(number) ? String(number) : "";
}

function frjNullableText_(value) {
  var text = frjText_(value);
  return text || null;
}

function frjNullableNumber_(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  var number = Number(value);
  return isFinite(number) ? number : null;
}
