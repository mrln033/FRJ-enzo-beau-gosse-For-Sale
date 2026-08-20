// Fonction pour récupérer les données de la table BDD_APP
function getBDDAppData(category = null) {
  const sheet = SpreadsheetApp.openById("13r_PzIZE8dJiPFU8w7UXxtEednHhS-yijNgTiYLqYP0").getSheetByName("BDD_APP");
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
  const TIMEZONE = "Europe/Paris";

  const sheet = SpreadsheetApp.openById(SS_ID).getSheetByName(SHEET_NAME);
  if (!sheet) return "";

  const cell = sheet.getRange("B1");
  const date = cell.getValue();
  const displayDate = cell.getDisplayValue();

  if (!(date instanceof Date)) {
    return displayDate;
  }

  const offset = Utilities.formatDate(date, TIMEZONE, "Z");
  const offsetLabel = `UTC${offset.slice(0, 3)}:${offset.slice(3)}`;

  return `${displayDate} (${offsetLabel})`;
}

function getInventorySheetName(avatar) {
  const inventorySheets = {
    enzo: "Inventaire Enzo",
    arkaman: "Inventaire ArkaMan",
    kenza: "Inventaire Kenza",
    nocturnal: "Inventaire Nocturnal"
  };

  return inventorySheets[avatar || "enzo"] || "";
}
