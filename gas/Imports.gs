function processMU(csv) {

  const SS_ID = "13r_PzIZE8dJiPFU8w7UXxtEednHhS-yijNgTiYLqYP0";
  const SHEET_NAME = "MU_Pondérés";

  const sheet = SpreadsheetApp.openById(SS_ID).getSheetByName(SHEET_NAME);

  const lines = csv.trim().split("\n");
  const headers = lines[0].split("\t");
  const data = lines.slice(1).map(line => line.split("\t"));

  const sheetData = sheet.getDataRange().getValues();

  const now = new Date();

  // Résoudre les colonnes par leur nom rend l'import indépendant de leur position.
  const colIndex = {};
  headers.forEach((h, i) => colIndex[h.trim()] = i);

  // Indexer les articles existants évite une recherche complète pour chaque ligne importée.
  const itemMap = {};

  // Réutiliser les lignes libres préserve les formules et la structure de la feuille.
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

    // Un article connu remplace sa ligne actuelle.
    if (itemMap[item]) {
      sheet.getRange(itemMap[item], 1, 1, newRow.length).setValues([newRow]);
      updates++;
    }

    // Un nouvel article utilise la première ligne libre existante.
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

  const expectedHeaders = ["Id", "Name", "Quantity", "Value(PED)", "Container", "ContainerRefId"];
  const actualHeaders = data[0].map(value => String(value || "").trim());
  if (actualHeaders.length !== expectedHeaders.length || actualHeaders.some((value, index) => value !== expectedHeaders[index])) {
    throw new Error("Colonnes inventaire MindArk invalides : " + actualHeaders.join(" | "));
  }

  const sheetData = frjNormalizeInventorySheetData_(data);
  const numRows = sheetData.length;
  const numCols = sheetData[0].length;

  // Agrandir avant l'écriture évite une troncature lorsque l'import dépasse la feuille.
  if (sheet.getMaxRows() < numRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), numRows - sheet.getMaxRows());
  }

  if (sheet.getMaxColumns() < numCols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), numCols - sheet.getMaxColumns());
  }

  // Effacer seulement les cellules de données conserve le format de la feuille.
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearContent();

  // Écrire le tableau complet en une opération limite les appels Google Sheets.
  if (numRows > 1) {
    // Contrat historique : Value(PED) reste du texte avec un point décimal.
    sheet.getRange(2, 4, numRows - 1, 1).setNumberFormat("@");
  }
  sheet.getRange(1, 1, numRows, numCols).setValues(sheetData);

  // Exception historique au TSV MindArk : B1 contient la date/heure d'import,
  // tandis que les articles restent en colonne B à partir de la ligne 2.
  const cell = sheet.getRange("B1");
  cell.setValue(new Date());
  cell.setNumberFormat("dd/MM/yyyy - HH:mm:ss");

  // La configuration évolue uniquement par ajout ; les choix existants restent intacts.
  // Le verrou global est déjà détenu par frjMainDoPost_ pendant cet import.
  // Le reprendre ici faisait expirer la requête après une écriture pourtant réussie.
  frjRefreshContainerConfigurationAfterInventoryUnlocked_(inventoryId);

  return `✅ Import inventaire OK dans ${SHEET_NAME} (${numRows} lignes)`;
}

function frjNormalizeInventorySheetData_(data) {
  return data.map((row, index) => {
    if (row.length !== 6) {
      throw new Error("Ligne inventaire MindArk " + (index + 1) + " invalide : " + row.length + " colonnes");
    }
    if (index === 0) return row;
    return [
      frjInventoryNumberOrTextCell_(row[0]),
      row[1],
      frjInventoryRequiredNumberCell_(row[2], "Quantity", index + 1),
      frjInventoryPedTextCell_(row[3], index + 1),
      row[4],
      frjInventoryNumberOrTextCell_(row[5])
    ];
  });
}

function frjInventoryRequiredNumberCell_(value, column, lineNumber) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  const number = Number(text);
  if (!text || !isFinite(number)) {
    throw new Error(column + " invalide à la ligne " + lineNumber + " : " + text);
  }
  return number;
}

function frjInventoryPedTextCell_(value, lineNumber) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  const number = Number(text);
  if (!text || !isFinite(number)) {
    throw new Error("Value(PED) invalide à la ligne " + lineNumber + " : " + text);
  }
  return number.toFixed(4);
}

function frjInventoryNumberOrTextCell_(value) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (!text || text.toLowerCase() === "null") return text;
  const number = Number(text);
  return isFinite(number) ? number : text;
}
