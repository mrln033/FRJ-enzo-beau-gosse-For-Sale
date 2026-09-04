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
      frjInventoryNumberOrTextCell_(row.sourceId),
      row.itemName,
      Number(row.quantity),
      row.valuePed === null || row.valuePed === undefined ? "" : Number(row.valuePed).toFixed(4),
      row.container || "",
      frjInventoryNumberOrTextCell_(row.containerRefId)
    ]);
  });

  // La feuille est un miroir du TSV MindArk réutilisé par d'autres classeurs :
  // ne conserver aucune colonne ou cellule technique en dehors de ces six champs.
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearContent();
  if (data.length > 1) sheet.getRange(2, 4, data.length - 1, 1).setNumberFormat("@");
  sheet.getRange(1, 1, data.length, 6).setValues(data);
  sheet.getRange("B1").setNumberFormat("dd/MM/yyyy - HH:mm:ss");
  SpreadsheetApp.flush();
  // frjRunSync_ détient déjà le verrou global pendant cette écriture.
  frjRefreshContainerConfigurationAfterInventoryUnlocked_(avatar);
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
  if (dataset === "containers") return frjHashContainerConfig_(rows);
  if (dataset === "discounts") return frjHashDiscountCampaigns_(rows);
  if (dataset === "discount-config") return frjHashDiscountConfig_(rows);
  return dataset === "mu" ? frjHashMarket_(rows) : frjHashInventory_(rows);
}

function frjHashInventory_(rows) {
  var payload = (rows || []).map(function(row) {
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
