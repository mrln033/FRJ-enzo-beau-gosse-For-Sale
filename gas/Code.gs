// Fonction pour récupérer les données de la table BDD_APP
function getBDDAppData(category = null) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("BDD_APP");
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow < 2) return [];

  // 🔥 lecture en 1 seule fois
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  const headers = data[0];

  // 🔥 index colonnes (ultra rapide)
  const idx = {};
  headers.forEach((h, i) => idx[h] = i);

  const result = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    const storage = (row[idx["STORAGE"]] || "").toString().trim().toUpperCase();
    if (category && storage !== category) continue;

    const rayon = row[idx["RAYON"]];
    if (!rayon) continue;

    const qty = parseFloat(row[idx["QUANTITE"]]);
    if (!qty) continue;

    const obj = {};

    // 🔥 copie rapide (moins de logique)
    for (let j = 0; j < headers.length; j++) {
      let val = row[j];

      if (val instanceof Date) {
        val = Utilities.formatDate(val, Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss");
      }

      obj[headers[j]] = val;
    }

    obj.STORAGE = storage;
    obj.RAYON = rayon.toString().trim().toUpperCase();
    obj.TOTAL = qty * (parseFloat(row[idx["PRIX_UNITAIRE"]]) || 0);

    result.push(obj);
  }

  return result;
}

function getDataFast(category) {
  const cache = CacheService.getScriptCache();
  const key = "cat_" + category;

  const cached = cache.get(key);
  if (cached) {
    return JSON.parse(cached);
  }

  const data = getBDDAppData(category);

  cache.put(key, JSON.stringify(data), 300); // 5 min

  return data;
}

function getCachedData(category) {
  const cache = CacheService.getScriptCache();
  const key = "cat_" + category;

  const cached = cache.get(key);
  if (cached) {
    return JSON.parse(cached);
  }

  const data = getBDDAppData(category);

  cache.put(key, JSON.stringify(data), 300); // 5 min

  return data;
}

function getAvailableCategories() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("BDD_APP");

  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data.shift();

  const storageIndex = headers.indexOf("STORAGE");
  const rayonIndex = headers.indexOf("RAYON");
  const qtyIndex = headers.indexOf("QUANTITE");

  const categories = new Set();

  data.forEach(row => {
    const storage = (row[storageIndex] || "").toString().trim().toUpperCase();
    const rayon = row[rayonIndex];
    const qty = parseFloat(row[qtyIndex]);

    if (!storage) return;
    if (!rayon) return;
    if (!qty || qty === 0) return;

    categories.add(storage);
  });

  return [...categories];
}

function getInventoryDate() {
  const SS_ID = "1C-TWYWKI7Vge3wywEUHjYAKm3GOBP4rgiaBbAch0Jng";
  const SHEET_NAME = "Inventaire Enzo";

  const sheet = SpreadsheetApp.openById(SS_ID).getSheetByName(SHEET_NAME);
  if (!sheet) return "";

  return sheet.getRange("B1").getDisplayValue();
}

function processMU(csv) {

  const SS_ID = "13r_PzIZE8dJiPFU8w7UXxtEednHhS-yijNgTiYLqYP0";
  const SHEET_NAME = "MU_Pondérés";

  const sheet = SpreadsheetApp.openById(SS_ID).getSheetByName(SHEET_NAME);

  const lines = csv.trim().split("\n");
  const headers = lines[0].split("\t");
  const data = lines.slice(1).map(line => line.split("\t"));

  const sheetData = sheet.getDataRange().getValues();

  const now = new Date();

  // 🔎 index CSV
  const colIndex = {};
  headers.forEach((h, i) => colIndex[h.trim()] = i);

  // 🔥 map items existants
  const itemMap = {};

  // 🔥 liste des lignes libres (col B vide)
  const freeRows = [];

  for (let i = 1; i < sheetData.length; i++) {

    const item = sheetData[i][1]; // colonne B

    if (item) {
      itemMap[item] = i + 1;
    } else {
      freeRows.push(i + 1);
    }
  }

  let updates = 0;
  let inserts = 0;

  data.forEach(row => {

    const item = row[colIndex["Item"]];
    if (!item) return;

    const newRow = [
      now,
      row[colIndex["Item"]],
      row[colIndex["Tier"]],
      row[colIndex["Day Markup"]],
      row[colIndex["Day Sales"]],
      row[colIndex["Week Markup"]],
      row[colIndex["Week Sales"]],
      row[colIndex["Month Markup"]],
      row[colIndex["Month Sales"]],
      row[colIndex["Year Markup"]],
      row[colIndex["Year Sales"]],
      row[colIndex["Decade Markup"]],
      row[colIndex["Decade Sales"]],
    ];

    // ✅ UPDATE
    if (itemMap[item]) {
      sheet.getRange(itemMap[item], 1, 1, newRow.length).setValues([newRow]);
      updates++;
    }

    // ✅ INSERT dans une ligne libre EXISTANTE
    else {

      if (freeRows.length === 0) {
        throw new Error("❌ Plus de lignes libres disponibles !");
      }

      const targetRow = freeRows.shift(); // 🔥 prend la première libre

      sheet.getRange(targetRow, 1, 1, newRow.length).setValues([newRow]);

      inserts++;
    }

  });

  return `${updates} MAJ / ${inserts} AJOUTS`;
}

// Fonction pour afficher la page HTML
function doGet(e) {
  const action = e.parameter.action;

  if (action === "categories") {
    const cats = getAvailableCategories();
    return ContentService
      .createTextOutput(JSON.stringify(cats))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (action === "inventoryDate") {
    return ContentService
      .createTextOutput(JSON.stringify({ inventoryDate: getInventoryDate() }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const category = e.parameter.category || null;

  if (!category) {
    return ContentService
      .createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const data = getDataFast(category);

  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function processInventory(csv) {

  const SS_ID = "1C-TWYWKI7Vge3wywEUHjYAKm3GOBP4rgiaBbAch0Jng";
  const SHEET_NAME = "Inventaire Enzo";

  const sheet = SpreadsheetApp.openById(SS_ID).getSheetByName(SHEET_NAME);

  const data = Utilities.parseCsv(csv, "\t");

  if (!data || data.length === 0) {
    return "CSV vide";
  }

  const numRows = data.length;
  const numCols = data[0].length;

  // 🔥 resize sheet si besoin (évite erreurs silencieuses)
  if (sheet.getMaxRows() < numRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), numRows - sheet.getMaxRows());
  }

  if (sheet.getMaxColumns() < numCols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), numCols - sheet.getMaxColumns());
  }

  // 🔥 clear uniquement zone utile (plus rapide que clear total)
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearContent();

  // 🔥 batch write
  sheet.getRange(1, 1, numRows, numCols).setValues(data);

  // 🔥 date formatée en B1
  const cell = sheet.getRange("B1");
  cell.setValue(new Date());
  cell.setNumberFormat("dd/MM/yyyy - HH:mm:ss");

  return `✅ Import inventaire OK (${numRows} lignes)`;
}

function doPost(e) {
  const type = e.parameter.type;

  if (type === "mu") {
    return ContentService.createTextOutput(processMU(e.postData.contents));
  }

  if (type === "inventory") {
    return ContentService.createTextOutput(processInventory(e.postData.contents));
  }

  return ContentService.createTextOutput("❌ Type reçu: " + type);
}
