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
