var FRJ_APP_SPREADSHEET_ID = "13r_PzIZE8dJiPFU8w7UXxtEednHhS-yijNgTiYLqYP0";
var FRJ_CATALOG_CACHE_TTL_SECONDS = 300;
var FRJ_CATALOG_CACHE_CHUNK_SIZE = 30000;
var FRJ_CATALOG_CACHE_PREFIX = "catalog_v2_";

// Lit BDD_APP en un seul lot, puis normalise les lignes exposées par l'API.
function getBDDAppData(category = null) {
  const sheet = SpreadsheetApp.openById(FRJ_APP_SPREADSHEET_ID).getSheetByName("BDD_APP");
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow < 2) return [];

  // Une lecture groupée limite les appels et les quotas Google Sheets.
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  const headers = data[0];

  // Les positions viennent des en-têtes afin de tolérer leur ordre dans la feuille.
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

    // Conserver les colonnes source permet au frontend d'utiliser le même contrat historique.
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
  const normalizedCategory = String(category || "").trim().toUpperCase();
  const key = FRJ_CATALOG_CACHE_PREFIX + "category_" + normalizedCategory;
  const cached = frjReadCatalogCache_(key);
  if (cached !== null) return cached;

  const data = getBDDAppData(normalizedCategory);
  frjWriteCatalogCache_(key, data);
  return data;
}

function getAvailableCategories() {
  const cacheKey = FRJ_CATALOG_CACHE_PREFIX + "categories";
  const cached = frjReadCatalogCache_(cacheKey);
  if (cached !== null) return cached;

  // Une Web App autonome n'a pas de classeur actif : ouvrir explicitement BDD_APP.
  const ss = SpreadsheetApp.openById(FRJ_APP_SPREADSHEET_ID);
  const sheet = ss.getSheetByName("BDD_APP");

  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];

  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];

  const storageIndex = headers.indexOf("STORAGE");
  const rayonIndex = headers.indexOf("RAYON");
  const qtyIndex = headers.indexOf("QUANTITE");
  if (storageIndex < 0 || rayonIndex < 0 || qtyIndex < 0) return [];

  // Ne transférer que la tranche contenant les trois colonnes nécessaires.
  const firstIndex = Math.min(storageIndex, rayonIndex, qtyIndex);
  const lastIndex = Math.max(storageIndex, rayonIndex, qtyIndex);
  const data = sheet.getRange(2, firstIndex + 1, lastRow - 1, lastIndex - firstIndex + 1).getValues();

  const categories = new Set();

  data.forEach(row => {
    const storage = (row[storageIndex - firstIndex] || "").toString().trim().toUpperCase();
    const rayon = row[rayonIndex - firstIndex];
    const qty = parseFloat(row[qtyIndex - firstIndex]);

    if (!storage) return;
    if (!rayon) return;
    if (!qty || qty === 0) return;

    categories.add(storage);
  });

  const result = [...categories];
  frjWriteCatalogCache_(cacheKey, result);
  return result;
}

// Cache découpé pour rester sous la limite par entrée, y compris pour les grosses catégories.
function frjReadCatalogCache_(key) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(key);
  if (!cached) return null;

  const value = JSON.parse(cached);
  if (!value || !value.frjChunks) return value;

  const keys = [];
  for (let index = 0; index < value.frjChunks; index++) keys.push(key + "_" + index);
  const chunks = cache.getAll(keys);
  if (keys.some(chunkKey => typeof chunks[chunkKey] !== "string")) return null;
  return JSON.parse(keys.map(chunkKey => chunks[chunkKey]).join(""));
}

function frjWriteCatalogCache_(key, value) {
  const cache = CacheService.getScriptCache();
  const json = JSON.stringify(value);
  if (json.length <= FRJ_CATALOG_CACHE_CHUNK_SIZE) {
    cache.put(key, json, FRJ_CATALOG_CACHE_TTL_SECONDS);
    return;
  }

  const entries = {};
  let chunkCount = 0;
  for (let offset = 0; offset < json.length; offset += FRJ_CATALOG_CACHE_CHUNK_SIZE) {
    entries[key + "_" + chunkCount] = json.slice(offset, offset + FRJ_CATALOG_CACHE_CHUNK_SIZE);
    chunkCount++;
  }
  entries[key] = JSON.stringify({ frjChunks: chunkCount });
  cache.putAll(entries, FRJ_CATALOG_CACHE_TTL_SECONDS);
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
