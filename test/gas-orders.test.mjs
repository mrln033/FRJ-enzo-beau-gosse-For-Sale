import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  normalizeOrderSubmission,
  priceOrderLines
} from "../cloudflare/for-sale-api/src/orders.js";

const source = fs.readFileSync(new URL("../gas/PurchaseOrders.gs", import.meta.url), "utf8");

function loadPurchaseOrders(catalogRows = []) {
  const context = vm.createContext({
    console,
    Date,
    JSON,
    Object,
    String,
    Number,
    Boolean,
    Array,
    Math,
    isFinite,
    isNaN,
    getBDDAppData: () => catalogRows
  });
  vm.runInContext(source, context, { filename: "PurchaseOrders.gs" });
  return context;
}

function validPayload(quantity = 2) {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    publicReference: "FRJ-20260820-A1B2C3",
    accessToken: "123e4567-e89b-42d3-a456-426614174000-123e4567-e89b-42d3-a456-426614174001",
    buyerAvatar: "Test Player",
    language: "EN",
    items: [{
      itemName: "Item A",
      storage: "ARMORS",
      aisle: "PARTS",
      quantity,
      unitTtPed: 0.01,
      markupKind: "percent",
      markupValue: 1.1
    }]
  };
}

test("le secours GAS refuse aussi les quantités décimales", () => {
  const context = loadPurchaseOrders();
  assert.equal(context.normalizePurchaseOrderPayload_(validPayload()).items[0].quantity, 2);
  assert.throws(
    () => context.normalizePurchaseOrderPayload_(validPayload(1.5)),
    /entière/
  );
});

test("le secours GAS conserve six décimales pour les petits prix", () => {
  const context = loadPurchaseOrders([{
    ITEM: "Item A",
    STORAGE: "ARMORS",
    RAYON: "PARTS",
    QUANTITE: 1000,
    PRIX_UNITAIRE: 0.01,
    MU: "110,00 %"
  }]);
  const normalized = context.normalizePurchaseOrderPayload_(validPayload(1000));
  const priced = context.pricePurchaseOrderFromSheet_(normalized);

  assert.equal(priced.discrepancies.length, 0);
  assert.equal(priced.lines[0].unitSalePed, 0.011);
  assert.equal(priced.lines[0].lineSalePed, 11);
  assert.equal(priced.lines[0].markupDisplay, "110,00 %");
  assert.equal(priced.totalSalePed, 11);
});

test("le secours GAS aligne le calcul membre et l'arrondi final sur D1", () => {
  const context = loadPurchaseOrders([{
    ITEM: "Item A",
    STORAGE: "ARMORS",
    RAYON: "PARTS",
    QUANTITE: 1000,
    PRIX_UNITAIRE: 0.01,
    MU: "115,12 %"
  }]);
  const payload = validPayload(1000);
  payload.language = "FR";
  payload.frjMember = true;
  payload.items[0].markupValue = 1.1512;
  const priced = context.pricePurchaseOrderFromSheet_(
    context.normalizePurchaseOrderPayload_(payload)
  );

  assert.equal(priced.lines[0].markupDisplay, "107,56 %");
  assert.equal(priced.lines[0].unitSalePed, 0.010756);
  assert.equal(priced.lines[0].lineSalePed, 10.76);
  assert.equal(context.purchaseRound_(1.23456789, 6), 1.234568);
});

test("GAS et D1 produisent la même estimation de demande", () => {
  const gasCatalog = [{
    ITEM: "Item A",
    STORAGE: "ARMORS",
    RAYON: "PARTS",
    QUANTITE: 1000,
    PRIX_UNITAIRE: 0.01,
    MU: "115,12 %"
  }];
  const d1Catalog = [{
    itemName: "Item A",
    storage: "ARMORS",
    aisle: "PARTS",
    stock: 1000,
    unitTtPed: 0.01,
    markupKind: "percent",
    markupValue: 1.1512
  }];
  const payload = validPayload(1000);
  payload.language = "FR";
  payload.frjMember = true;
  payload.items[0].markupValue = 1.1512;

  const context = loadPurchaseOrders(gasCatalog);
  const gasResult = context.pricePurchaseOrderFromSheet_(
    context.normalizePurchaseOrderPayload_(payload)
  );
  const d1Result = priceOrderLines(
    normalizeOrderSubmission(payload).items,
    d1Catalog,
    { frjMember: true }
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(gasResult)),
    JSON.parse(JSON.stringify(d1Result))
  );
});
