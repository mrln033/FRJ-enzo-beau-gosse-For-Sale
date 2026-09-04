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
  "OrderHistory.gs",
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
  assert.match(sources["Imports.gs"], /frjRefreshContainerConfigurationAfterInventoryUnlocked_\(inventoryId\)/);
  assert.match(sources["SyncSheets.gs"], /frjRefreshContainerConfigurationAfterInventoryUnlocked_\(avatar\)/);
});

test("le correctif d.6.4 réinstalle automatiquement les formules au prochain poll", () => {
  assert.match(
    sources["SyncD1.gs"],
    /function frjD1SignalPollTrigger\(\)[\s\S]*frjEnsureContainerConfigurationReady_\(\)/
  );
});

test("d.10.3 raccorde l'historique GAS au canal bidirectionnel des commandes", () => {
  assert.match(sources["OrderHistory.gs"], /"COMMANDES_HISTORIQUE"/);
  assert.match(sources["OrderHistory.gs"], /function frjCapturePurchaseOrderEdit_\(e\)/);
  assert.match(sources["PurchaseOrders.gs"], /purchaseAppendHistoryEvent_\(ss, historyEvent\)/);
  assert.match(sources["SyncOrders.gs"], /\/sync\/order-history/);
  assert.match(sources["SyncOrders.gs"], /upsertPurchaseOrderHistoryMirror_\(order\.historyEvents \|\| \[\]\)/);
  assert.match(sources["SyncD1.gs"], /frjPushPendingPurchaseOrderHistory_\(\)/);
});

test("d.11.2 applique dans GAS la confirmation permanente des prix", () => {
  assert.match(sources["OrderHistory.gs"], /function purchaseStatusConfirmsPricing_\(status\)/);
  assert.match(sources["OrderHistory.gs"], /payload\.order\.pricingStatus = "confirmed"/);
  assert.match(sources["OrderHistory.gs"], /item\.priceStatus = "confirmed"/);
  assert.match(sources["OrderHistory.gs"], /pricingConfirmed: pricingConfirmed/);
  assert.match(sources["PurchaseOrders.gs"], /set\("PRIX_STATUT", order\.pricingStatus \|\| "estimated"\)/);
  assert.match(sources["PurchaseOrders.gs"], /pricingStatus: order\.pricingStatus \|\| "estimated"/);
});

test("T-009 conserve la feuille d'inventaire au format MindArk exact", () => {
  assert.match(
    sources["Imports.gs"],
    /expectedHeaders = \["Id", "Name", "Quantity", "Value\(PED\)", "Container", "ContainerRefId"\]/
  );
  assert.match(sources["Imports.gs"], /getRange\("B1"\)/);
  assert.match(sources["Imports.gs"], /setNumberFormat\("dd\/MM\/yyyy - HH:mm:ss"\)/);
  assert.match(
    sources["SyncSheets.gs"],
    /var data = \[\["Id", updatedAt, "Quantity", "Value\(PED\)", "Container", "ContainerRefId"\]\]/
  );
  assert.match(sources["SyncSheets.gs"], /setNumberFormat\("0\.0000"\)/);
  assert.match(sources["SyncSheets.gs"], /getRange\("B1"\)\.setNumberFormat\("dd\/MM\/yyyy - HH:mm:ss"\)/);
  assert.match(sources["SyncSheets.gs"], /sheet\.getMaxColumns\(\)\)\.clearContent\(\)/);
  assert.match(sources["Catalog.gs"], /function getInventoryDate\(\)[\s\S]*getRange\("B1"\)/);
});
