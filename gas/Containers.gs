var FRJ_CONTAINER_CONFIG = Object.freeze({
  sheetName: "CONFIG_CONTAINER",
  catalogSheetName: "BDD_APP",
  catalogItemHeader: "ITEM",
  catalogQuantityHeader: "QUANTITE",
  avatars: ["enzo", "arkaman", "kenza", "nocturnal"],
  readinessProperty: "FRJ_CONTAINER_CONFIG_VERSION",
  readinessVersion: "2026-08-24-v1"
});

/**
 * Migration à lancer une fois après le déploiement de d.8.5.
 * Elle conserve les choix existants, découvre les quatre inventaires et
 * remplace les anciennes formules de quantité codées en dur.
 */
function prepareFrjContainerConfiguration() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return frjPrepareContainerConfigurationUnlocked_();
  } finally {
    lock.releaseLock();
  }
}

// La synchronisation détient déjà le verrou global : cette variante permet au
// premier passage de production d'effectuer la migration sans double verrou.
function frjPrepareContainerConfigurationUnlocked_() {
  var schema = frjEnsureContainerConfigSchema_();
  var result = {
    migrated: schema.migrated,
    avatars: {}
  };

  FRJ_CONTAINER_CONFIG.avatars.forEach(function(avatar) {
    result.avatars[avatar] = frjRefreshContainerConfig_(avatar, schema.sheet);
  });
  result.formulaRows = frjInstallContainerQuantityFormulas_();
  PropertiesService.getScriptProperties().setProperty(
    FRJ_CONTAINER_CONFIG.readinessProperty,
    FRJ_CONTAINER_CONFIG.readinessVersion
  );
  return result;
}

function frjEnsureContainerConfigurationReady_() {
  var properties = PropertiesService.getScriptProperties();
  if (properties.getProperty(FRJ_CONTAINER_CONFIG.readinessProperty) === FRJ_CONTAINER_CONFIG.readinessVersion) {
    return null;
  }
  return frjPrepareContainerConfigurationUnlocked_();
}

/** Ajoute les conteneurs inconnus d'un inventaire sans jamais en supprimer. */
function frjRefreshContainerConfigurationAfterInventory_(avatar) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return frjRefreshContainerConfigurationAfterInventoryUnlocked_(avatar);
  } finally {
    lock.releaseLock();
  }
}

// Le moteur de synchronisation possède déjà le verrou global lorsqu'il appelle
// cette variante ; reprendre le même verrou dans une exécution créerait un blocage.
function frjRefreshContainerConfigurationAfterInventoryUnlocked_(avatar) {
  var schema = frjEnsureContainerConfigSchema_();
  var result = frjRefreshContainerConfig_(avatar, schema.sheet);
  if (schema.migrated) result.formulaRows = frjInstallContainerQuantityFormulas_();
  return result;
}

function frjEnsureContainerConfigSchema_() {
  var spreadsheet = SpreadsheetApp.openById(FRJ_SYNC_CONFIG.appSpreadsheetId);
  var sheet = spreadsheet.getSheetByName(FRJ_CONTAINER_CONFIG.sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(FRJ_CONTAINER_CONFIG.sheetName);

  if (sheet.getMaxColumns() < 3) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), 3 - sheet.getMaxColumns());
  }

  var lastRow = Math.max(sheet.getLastRow(), 1);
  var headerWidth = Math.min(sheet.getMaxColumns(), 3);
  var headers = sheet.getRange(1, 1, 1, headerWidth).getValues()[0].map(function(value) {
    return String(value || "").trim().toLowerCase();
  });
  var migrated = false;
  var initialized = false;

  if (headers[0] === "container" && headers[1] === "enabled") {
    // Insérer la colonne Avatar déplace les données et les cases à cocher sans
    // réécrire les 76 choix existants.
    sheet.insertColumnBefore(1);
    sheet.getRange(1, 1, 1, 3).setValues([["Avatar", "Container", "Enabled"]]);
    if (lastRow > 1) {
      var avatars = [];
      for (var row = 2; row <= lastRow; row++) avatars.push(["enzo"]);
      sheet.getRange(2, 1, avatars.length, 1).setValues(avatars);
    }
    migrated = true;
  } else if (headers.every(function(header) { return !header; })) {
    sheet.getRange(1, 1, 1, 3).setValues([["Avatar", "Container", "Enabled"]]);
    initialized = true;
  } else if (!(headers[0] === "avatar" && headers[1] === "container" && headers[2] === "enabled")) {
    throw new Error("Structure inattendue dans CONFIG_CONTAINER : migration annulée");
  }

  if (migrated || initialized) frjApplyContainerCheckboxValidation_(sheet);
  return { sheet: sheet, migrated: migrated };
}

function frjRefreshContainerConfig_(avatar, configSheet) {
  avatar = String(avatar || "").trim().toLowerCase();
  var inventorySheetName = FRJ_SYNC_CONFIG.inventorySheets[avatar];
  if (!inventorySheetName) throw new Error("Avatar d'inventaire inconnu : " + avatar);

  var inventorySheet = SpreadsheetApp.openById(FRJ_SYNC_CONFIG.inventorySpreadsheetId)
    .getSheetByName(inventorySheetName);
  if (!inventorySheet) throw new Error("Feuille introuvable : " + inventorySheetName);

  var configLastRow = Math.max(configSheet.getLastRow(), 1);
  var existingRows = configLastRow > 1
    ? configSheet.getRange(2, 1, configLastRow - 1, 3).getValues()
    : [];
  var inventoryLastRow = Math.max(inventorySheet.getLastRow(), 1);
  var inventoryContainers = inventoryLastRow > 1
    ? inventorySheet.getRange(2, 5, inventoryLastRow - 1, 1).getValues()
    : [];
  var additions = frjFindMissingContainerRows_(avatar, existingRows, inventoryContainers);

  if (additions.length) {
    var targetRow = configLastRow + 1;
    var requiredLastRow = targetRow + additions.length - 1;
    if (configSheet.getMaxRows() < requiredLastRow) {
      configSheet.insertRowsAfter(configSheet.getMaxRows(), requiredLastRow - configSheet.getMaxRows());
    }
    configSheet.getRange(targetRow, 1, additions.length, 3).setValues(additions);
    frjApplyContainerCheckboxValidation_(configSheet);
  }

  return {
    discovered: inventoryContainers.length,
    added: additions.length,
    total: existingRows.filter(function(row) {
      return String(row[0] || "").trim().toLowerCase() === avatar;
    }).length + additions.length
  };
}

function frjFindMissingContainerRows_(avatar, existingRows, inventoryContainers) {
  var existing = {};
  existingRows.forEach(function(row) {
    var rowAvatar = String(row[0] || "").trim().toLowerCase();
    var key = frjNormalizeContainerKey_(row[1]);
    if (rowAvatar && key) existing[rowAvatar + "\u001f" + key] = true;
  });

  var additions = [];
  inventoryContainers.forEach(function(row) {
    var container = String(row[0] || "").trim();
    var key = frjNormalizeContainerKey_(container);
    var compoundKey = avatar + "\u001f" + key;
    if (!key || existing[compoundKey]) return;
    existing[compoundKey] = true;
    additions.push([avatar, container, false]);
  });
  return additions;
}

function frjNormalizeContainerKey_(container) {
  return String(container || "").trim().toLowerCase();
}

function frjReadLocalContainerConfig_() {
  var schema = frjEnsureContainerConfigSchema_();
  var sheet = schema.sheet;
  var lastRow = Math.max(sheet.getLastRow(), 1);
  var values = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 3).getValues() : [];
  var rows = frjNormalizeContainerRows_(values.map(function(row) {
    return {
      avatar: row[0],
      container: row[1],
      enabled: row[2] === true || Number(row[2]) === 1
    };
  }));
  if (!rows.length) throw new Error("Configuration locale des conteneurs vide");
  return {
    rows: rows,
    hash: frjHashContainerConfig_(rows),
    updatedAt: DriveApp.getFileById(FRJ_SYNC_CONFIG.appSpreadsheetId).getLastUpdated().toISOString()
  };
}

function frjWriteLocalContainerConfig_(snapshot) {
  var schema = frjEnsureContainerConfigSchema_();
  var sheet = schema.sheet;
  var lastRow = Math.max(sheet.getLastRow(), 1);
  var currentValues = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 3).getValues() : [];
  var currentRows = frjNormalizeContainerRows_(currentValues.map(function(row) {
    return { avatar: row[0], container: row[1], enabled: row[2] === true || Number(row[2]) === 1 };
  }));
  var incomingRows = frjNormalizeContainerRows_(snapshot.rows || []);
  var merged = currentRows.slice();
  var positions = {};
  merged.forEach(function(row, index) {
    positions[row.avatar + "\u001f" + row.containerKey] = index;
  });
  incomingRows.forEach(function(row) {
    var key = row.avatar + "\u001f" + row.containerKey;
    if (positions[key] === undefined) {
      positions[key] = merged.length;
      merged.push(row);
    } else {
      merged[positions[key]] = row;
    }
  });

  var requiredLastRow = merged.length + 1;
  if (sheet.getMaxRows() < requiredLastRow) {
    sheet.insertRowsAfter(sheet.getMaxRows(), requiredLastRow - sheet.getMaxRows());
  }
  sheet.getRange(2, 1, merged.length, 3).setValues(merged.map(function(row) {
    return [row.avatar, row.container, row.enabled];
  }));
  frjApplyContainerCheckboxValidation_(sheet);
  SpreadsheetApp.flush();
}

function frjNormalizeContainerRows_(rows) {
  var seen = {};
  return (rows || []).map(function(row) {
    var avatar = String(row.avatar || "").trim().toLowerCase();
    var container = String(row.container || "").trim();
    if (!avatar && !container) return null;
    if (!FRJ_SYNC_CONFIG.inventorySheets[avatar]) throw new Error("Avatar inconnu dans CONFIG_CONTAINER : " + avatar);
    var containerKey = frjNormalizeContainerKey_(row.containerKey || container);
    if (!containerKey) throw new Error("Conteneur vide dans CONFIG_CONTAINER");
    var stableKey = avatar + "\u001f" + containerKey;
    if (seen[stableKey]) throw new Error("Conteneur dupliqué dans CONFIG_CONTAINER : " + avatar + "/" + container);
    seen[stableKey] = true;
    return {
      avatar: avatar,
      containerKey: containerKey,
      container: container,
      enabled: row.enabled === true || Number(row.enabled) === 1
    };
  }).filter(function(row) { return row !== null; });
}

function frjHashContainerConfig_(rows) {
  var payload = frjNormalizeContainerRows_(rows).map(function(row) {
    return JSON.stringify([
      row.avatar,
      row.containerKey,
      row.container,
      row.enabled ? "1" : "0"
    ]);
  }).sort().join("\n");
  return frjSha256_(payload);
}

function frjApplyContainerCheckboxValidation_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var checkboxRule = SpreadsheetApp.newDataValidation()
    .requireCheckbox()
    .setAllowInvalid(false)
    .build();
  // setDataValidation conserve les TRUE/FALSE déjà présents.
  sheet.getRange(2, 3, lastRow - 1, 1).setDataValidation(checkboxRule);
}

function frjInstallContainerQuantityFormulas_() {
  var appSpreadsheet = SpreadsheetApp.openById(FRJ_SYNC_CONFIG.appSpreadsheetId);
  var sheet = appSpreadsheet.getSheetByName(FRJ_CONTAINER_CONFIG.catalogSheetName);
  if (!sheet) throw new Error("Feuille BDD_APP introuvable");

  var lastColumn = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function(value) {
    return String(value || "").trim().toUpperCase();
  });
  var itemColumn = headers.indexOf(FRJ_CONTAINER_CONFIG.catalogItemHeader) + 1;
  var quantityColumn = headers.indexOf(FRJ_CONTAINER_CONFIG.catalogQuantityHeader) + 1;
  if (!itemColumn || !quantityColumn) throw new Error("Colonnes ITEM/QUANTITE introuvables dans BDD_APP");

  // getLastRow inclut la plage historique de formules et conserve donc sa
  // capacité à accueillir de futurs articles sans nouvelle intervention.
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var formulas = [];
  for (var row = 2; row <= lastRow; row++) {
    formulas.push([frjBuildContainerQuantityFormula_(row, itemColumn)]);
  }
  sheet.getRange(2, quantityColumn, formulas.length, 1).setFormulas(formulas);
  return formulas.length;
}

function frjBuildContainerQuantityFormula_(row, itemColumn) {
  var itemCell = frjColumnLetter_(itemColumn) + row;
  var inventoryId = FRJ_SYNC_CONFIG.inventorySpreadsheetId;
  var inventorySheet = FRJ_SYNC_CONFIG.inventorySheets.enzo.replace(/'/g, "''");
  return '=IF(' + itemCell + '="","",IFERROR(LET(' +
    'inventory,IMPORTRANGE("' + inventoryId + '","\'' + inventorySheet + '\'!B2:E"),' +
    'itemNames,INDEX(inventory,0,1),' +
    'quantities,INDEX(inventory,0,2),' +
    'containerNames,INDEX(inventory,0,4),' +
    'enabledContainers,FILTER(' + FRJ_CONTAINER_CONFIG.sheetName + '!$B$2:$B,' +
      FRJ_CONTAINER_CONFIG.sheetName + '!$A$2:$A="enzo",' +
      FRJ_CONTAINER_CONFIG.sheetName + '!$C$2:$C=TRUE),' +
    'SUM(FILTER(quantities,' +
      'LOWER(TRIM(itemNames))=LOWER(TRIM(' + itemCell + ')),' +
      'ISNUMBER(MATCH(LOWER(TRIM(containerNames)),LOWER(TRIM(enabledContainers)),0))))' +
  '),0))';
}

function frjColumnLetter_(column) {
  var value = Number(column);
  var result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}
