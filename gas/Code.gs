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

  if (action === "inventoryTarget") {
    const avatar = e.parameter.avatar || "enzo";
    return ContentService
      .createTextOutput(JSON.stringify({
        avatar: avatar,
        sheet: getInventorySheetName(avatar)
      }))
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

function processInventory(csv, avatar) {

  const SS_ID = "1C-TWYWKI7Vge3wywEUHjYAKm3GOBP4rgiaBbAch0Jng";
  const inventoryId = avatar || "enzo";
  const SHEET_NAME = getInventorySheetName(inventoryId);

  if (!SHEET_NAME) {
    throw new Error("Avatar d'inventaire inconnu : " + inventoryId);
  }

  const sheet = SpreadsheetApp.openById(SS_ID).getSheetByName(SHEET_NAME);

  if (!sheet) {
    throw new Error("Feuille introuvable : " + SHEET_NAME);
  }

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

  return `✅ Import inventaire OK dans ${SHEET_NAME} (${numRows} lignes)`;
}

function processPurchaseOrderRequest(rawBody) {
  var featureValue = PropertiesService.getScriptProperties().getProperty("FRJ_CART_ENABLED");
  if (String(featureValue || "true").toLowerCase() === "false") {
    return purchaseJsonOutput_({ ok: false, error: "Transmission des paniers désactivée" });
  }

  var payload;
  try { payload = JSON.parse(String(rawBody || "")); } catch (error) {
    return purchaseJsonOutput_({ ok: false, error: "Demande d'achat invalide" });
  }

  try {
    var normalized = normalizePurchaseOrderPayload_(payload);
    var priced = pricePurchaseOrderFromSheet_(normalized);
    if (priced.discrepancies.length) {
      return purchaseJsonOutput_({
        ok: false,
        code: "stock-changed",
        error: "Le stock, le prix affiché ou le MU a changé. Actualise le panier avant de confirmer.",
        discrepancies: priced.discrepancies
      });
    }

    var ss = SpreadsheetApp.openById("13r_PzIZE8dJiPFU8w7UXxtEednHhS-yijNgTiYLqYP0");
    var sheet = getOrCreatePurchaseOrderSheet_(ss);
    var existing = sheet.getLastRow() > 1
      ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues().flat().indexOf(normalized.id)
      : -1;
    if (existing !== -1) {
      return purchaseJsonOutput_({
        ok: true,
        duplicate: true,
        order: { id: normalized.id, publicReference: normalized.publicReference, status: "submitted" }
      });
    }

    var accessTokenHash = purchaseSha256_(normalized.accessToken);
    var order = {
      id: normalized.id,
      publicReference: normalized.publicReference,
      accessTokenHash: accessTokenHash,
      status: "submitted",
      buyerAvatar: normalized.buyerAvatar,
      buyerContact: normalized.buyerContact,
      buyerComment: normalized.buyerComment,
      language: normalized.language,
      frjMember: normalized.frjMember,
      sourceBackend: "gas-fallback",
      totalTtPed: priced.totalTtPed,
      totalSalePed: priced.totalSalePed,
      pricingStatus: priced.pricingStatus,
      clientCreatedAt: normalized.clientCreatedAt
    };
    var syncPayload = JSON.stringify({ order: order, items: priced.lines });
    sheet.appendRow([
      order.id, order.publicReference, order.buyerAvatar, order.buyerContact || "",
      order.buyerComment || "", order.language, order.frjMember ? "TRUE" : "FALSE",
      order.status, order.totalTtPed, order.totalSalePed, order.pricingStatus,
      order.clientCreatedAt || "", new Date(), syncPayload, "", ""
    ]);
    return purchaseJsonOutput_({
      ok: true,
      duplicate: false,
      order: {
        id: order.id,
        publicReference: order.publicReference,
        status: order.status,
        totalTtPed: order.totalTtPed,
        totalSalePed: order.totalSalePed,
        pricingStatus: order.pricingStatus
      }
    });
  } catch (error) {
    return purchaseJsonOutput_({ ok: false, error: error.message || String(error) });
  }
}

function normalizePurchaseOrderPayload_(payload) {
  var id = String(payload && payload.id || "").trim().toLowerCase();
  var publicReference = String(payload && payload.publicReference || "").trim().toUpperCase();
  var accessToken = String(payload && payload.accessToken || "").trim();
  var buyerAvatar = purchaseCleanText_(payload && payload.buyerAvatar, 80);
  var language = String(payload && payload.language || "EN").toUpperCase() === "FR" ? "FR" : "EN";
  var items = payload && Array.isArray(payload.items) ? payload.items : [];
  if (String(payload && payload.website || "").trim()) throw new Error("Demande refusée");
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Identifiant de demande invalide");
  if (!/^FRJ-\d{8}-[A-F0-9]{6}$/.test(publicReference)) throw new Error("Référence de demande invalide");
  if (!/^[a-f0-9-]{70,80}$/i.test(accessToken)) throw new Error("Jeton de suivi invalide");
  if (!buyerAvatar) throw new Error("L'avatar en jeu est obligatoire");
  if (!items.length || items.length > 30) throw new Error("Le panier doit contenir entre 1 et 30 articles");
  return {
    id: id,
    publicReference: publicReference,
    accessToken: accessToken,
    buyerAvatar: buyerAvatar,
    buyerContact: purchaseCleanText_(payload.buyerContact, 160) || null,
    buyerComment: purchaseCleanText_(payload.buyerComment, 800) || null,
    language: language,
    frjMember: payload.frjMember === true && language === "FR",
    clientCreatedAt: purchaseIsoDate_(payload.clientCreatedAt),
    items: items.map(function(item) {
      var quantity = Number(item.quantity);
      var normalizedItem = {
        itemName: purchaseCleanText_(item.itemName, 180),
        storage: purchaseCleanText_(item.storage, 80).toUpperCase(),
        aisle: purchaseCleanText_(item.aisle, 120).toUpperCase(),
        quantity: quantity,
        observedUnitTtPed: purchaseOptionalNumber_(item.unitTtPed),
        observedMarkupKind: item.markupKind === "percent" || item.markupKind === "ped" ? item.markupKind : "none",
        observedMarkupValue: purchaseOptionalNumber_(item.markupValue)
      };
      if (!normalizedItem.itemName || !normalizedItem.storage || !normalizedItem.aisle) throw new Error("Article de panier incomplet");
      if (!isFinite(quantity) || quantity <= 0 || quantity > 1000000) throw new Error("Quantité invalide pour " + normalizedItem.itemName);
      return normalizedItem;
    })
  };
}

function pricePurchaseOrderFromSheet_(submission) {
  var rows = getBDDAppData();
  var catalog = {};
  rows.forEach(function(row) {
    catalog[purchaseItemKey_(row.ITEM, row.STORAGE, row.RAYON)] = row;
  });
  var discrepancies = [];
  var lines = [];
  submission.items.forEach(function(requested, index) {
    var current = catalog[purchaseItemKey_(requested.itemName, requested.storage, requested.aisle)];
    var stock = current ? Math.max(0, Number(current.QUANTITE) || 0) : 0;
    if (!current || requested.quantity > stock) {
      discrepancies.push({
        itemName: requested.itemName,
        storage: requested.storage,
        aisle: requested.aisle,
        reason: current ? "insufficient-stock" : "unavailable",
        requestedQuantity: requested.quantity,
        availableQuantity: stock
      });
      return;
    }
    var unitTt = Math.max(0, Number(current.PRIX_UNITAIRE) || 0);
    var markup = purchaseParseMarkup_(current.MU);
    if (!purchaseSameNumber_(requested.observedUnitTtPed, unitTt)
        || requested.observedMarkupKind !== markup.kind
        || !purchaseSameNumber_(requested.observedMarkupValue, markup.value)) {
      discrepancies.push({
        itemName: requested.itemName,
        storage: requested.storage,
        aisle: requested.aisle,
        reason: "price-changed",
        requestedQuantity: requested.quantity,
        availableQuantity: stock,
        unitTtPed: purchaseRound_(unitTt),
        markupKind: markup.kind,
        markupValue: markup.value,
        markupDisplay: markup.kind === "percent"
          ? (markup.value * 100).toFixed(2).replace(".", ",") + " %"
          : (markup.kind === "ped" ? markup.value.toFixed(2).replace(".", ",") + " PED" : null)
      });
      return;
    }
    if (submission.frjMember && markup.kind === "percent") markup.value = 1 + ((markup.value - 1) / 2);
    if (submission.frjMember && markup.kind === "ped") markup.value = markup.value / 2;
    var unitSale = unitTt;
    if (markup.kind === "percent") unitSale = unitTt * markup.value;
    if (markup.kind === "ped") unitSale = unitTt + markup.value;
    var lineTt = purchaseRound_(unitTt * requested.quantity);
    var lineSale = purchaseRound_(unitSale * requested.quantity);
    lines.push({
      lineNo: index + 1,
      itemName: String(current.ITEM),
      storage: String(current.STORAGE).toUpperCase(),
      aisle: String(current.RAYON).toUpperCase(),
      quantity: requested.quantity,
      stockAtSubmission: stock,
      unitTtPed: purchaseRound_(unitTt),
      markupKind: markup.kind,
      markupValue: markup.value,
      markupDisplay: markup.kind === "percent"
        ? (markup.value * 100).toFixed(2).replace(".", ",") + " %"
        : (markup.kind === "ped" ? markup.value.toFixed(2).replace(".", ",") + " PED" : null),
      unitSalePed: purchaseRound_(unitSale),
      lineTtPed: lineTt,
      lineSalePed: lineSale,
      priceStatus: markup.kind === "none" ? "to-confirm" : "estimated"
    });
  });
  return {
    lines: lines,
    discrepancies: discrepancies,
    totalTtPed: purchaseRound_(lines.reduce(function(sum, line) { return sum + line.lineTtPed; }, 0)),
    totalSalePed: purchaseRound_(lines.reduce(function(sum, line) { return sum + line.lineSalePed; }, 0)),
    pricingStatus: lines.some(function(line) { return line.priceStatus === "to-confirm"; }) ? "to-confirm" : "estimated"
  };
}

function getOrCreatePurchaseOrderSheet_(ss) {
  var sheet = ss.getSheetByName("COMMANDES_APP");
  if (!sheet) sheet = ss.insertSheet("COMMANDES_APP");
  var headers = [
    "ORDER_ID", "REFERENCE", "AVATAR_ACHETEUR", "CONTACT", "COMMENTAIRE", "LANGUE",
    "MEMBRE_FRJ", "STATUT", "TOTAL_TT_PED", "TOTAL_VENTE_PED", "PRIX_STATUT",
    "DATE_CLIENT", "DATE_RECEPTION", "SYNC_PAYLOAD_JSON", "SYNCED_D1_AT", "SYNC_ERROR"
  ];
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sheet;
}

function purchaseParseMarkup_(raw) {
  var text = String(raw || "").trim();
  if (/%$/.test(text)) {
    var percent = Number(text.replace("%", "").replace(",", "."));
    return isFinite(percent) ? { kind: "percent", value: percent / 100 } : { kind: "none", value: null };
  }
  if (/PED$/i.test(text)) {
    var ped = Number(text.replace(/PED$/i, "").trim().replace(",", "."));
    return isFinite(ped) ? { kind: "ped", value: ped } : { kind: "none", value: null };
  }
  return { kind: "none", value: null };
}

function purchaseOptionalNumber_(value) {
  if (value === null || value === undefined || value === "") return null;
  var number = Number(value);
  return isFinite(number) ? number : null;
}

function purchaseSameNumber_(left, right) {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= 0.0001;
}

function purchaseItemKey_(item, storage, aisle) {
  return [item, storage, aisle].map(function(value) { return String(value || "").trim().toLowerCase(); }).join("\u001f");
}

function purchaseSha256_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map(function(byte) { return (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, "0"); }).join("");
}

function purchaseCleanText_(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function purchaseIsoDate_(value) {
  var date = new Date(String(value || ""));
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function purchaseRound_(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function purchaseJsonOutput_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function frjMainDoPost_(e) {
  const type = e.parameter.type;
  if (type === "syncAudit") return frjHandleImmediateAuditPost_(e);

  return withFrjDataLock_(function() {
    if (type === "order") {
      return processPurchaseOrderRequest(e.postData && e.postData.contents);
    }

    if (type === "mu") {
      return ContentService.createTextOutput(processMU(e.postData.contents));
    }

    if (type === "inventory") {
      return ContentService.createTextOutput(processInventory(e.postData.contents, e.parameter.avatar));
    }

    return ContentService.createTextOutput("❌ Type reçu: " + type);
  });
}
