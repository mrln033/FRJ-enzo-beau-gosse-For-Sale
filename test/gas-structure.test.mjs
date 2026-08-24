import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const gasDirectory = new URL("../gas/", import.meta.url);
const expectedFiles = [
  "Catalog.gs",
  "Code.gs",
  "Containers.gs",
  "Imports.gs",
  "PurchaseOrders.gs",
  "SyncD1.gs",
  "SyncEngine.gs",
  "SyncOrders.gs",
  "SyncSheets.gs",
  "SyncTransport.gs",
  "WebApp.gs"
];

const sources = Object.fromEntries(expectedFiles.map((fileName) => [
  fileName,
  fs.readFileSync(new URL(fileName, gasDirectory), "utf8")
]));

test("tous les fichiers GAS sont syntaxiquement valides", () => {
  Object.entries(sources).forEach(([fileName, source]) => {
    assert.doesNotThrow(() => new vm.Script(source, { filename: fileName }));
  });
});

test("les fonctions GAS ne sont définies qu'une seule fois", () => {
  const owners = new Map();
  Object.entries(sources).forEach(([fileName, source]) => {
    for (const match of source.matchAll(/^function\s+([A-Za-z0-9_]+)\s*\(/gm)) {
      const previousOwner = owners.get(match[1]);
      assert.equal(previousOwner, undefined, `${match[1]} existe dans ${previousOwner} et ${fileName}`);
      owners.set(match[1], fileName);
    }
  });
});

test("les points d'entrée GAS restent dans leurs fichiers stables", () => {
  assert.match(sources["Code.gs"], /^function doGet\(e\)/m);
  assert.match(sources["Code.gs"], /^function frjMainDoPost_\(e\)/m);
  assert.match(sources["WebApp.gs"], /^function doPost\(e\)/m);
  assert.equal(Object.values(sources).join("\n").match(/^function doGet\(e\)/gm)?.length, 1);
  assert.equal(Object.values(sources).join("\n").match(/^function doPost\(e\)/gm)?.length, 1);
});

test("la route des catégories ouvre explicitement le classeur BDD_APP", () => {
  assert.doesNotMatch(sources["Catalog.gs"], /SpreadsheetApp\.getActiveSpreadsheet\(\)/);
  assert.match(sources["Catalog.gs"], /function getAvailableCategories\(\)[\s\S]*SpreadsheetApp\.openById\(FRJ_APP_SPREADSHEET_ID\)/);
});

test("d.8.5 conserve les choix GAS et découvre uniquement par ajout", () => {
  const source = sources["Containers.gs"];
  assert.match(source, /insertColumnBefore\(1\)/);
  assert.match(source, /additions\.push\(\[avatar, container, false\]\)/);
  assert.doesNotMatch(source, /deleteRow|deleteRows|clearContent/);
  assert.match(sources["Imports.gs"], /frjRefreshContainerConfigurationAfterInventory_\(inventoryId\)/);
  assert.match(sources["SyncSheets.gs"], /frjRefreshContainerConfigurationAfterInventoryUnlocked_\(avatar\)/);
});
