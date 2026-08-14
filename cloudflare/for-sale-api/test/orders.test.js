import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOrderSubmission, priceOrderLines, validateOrderStatus } from "../src/orders.js";

const validPayload = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  publicReference: "FRJ-20260814-A1B2C3",
  accessToken: "123e4567-e89b-42d3-a456-426614174000-123e4567-e89b-42d3-a456-426614174001",
  buyerAvatar: "Buyer Avatar",
  language: "FR",
  frjMember: true,
  items: [{
    itemName: "Item A", storage: "Armors", aisle: "Parts", quantity: 2,
    unitTtPed: 10, markupKind: "percent", markupValue: 1.2
  }]
};

const normalizedItems = () => normalizeOrderSubmission(validPayload).items;

test("normalise une demande et ne conserve membre FRJ qu'en français", () => {
  assert.equal(normalizeOrderSubmission(validPayload).frjMember, true);
  assert.equal(normalizeOrderSubmission({ ...validPayload, language: "EN" }).frjMember, false);
});

test("refuse le honeypot et les paniers vides", () => {
  assert.throws(() => normalizeOrderSubmission({ ...validPayload, website: "spam" }), /refusée/);
  assert.throws(() => normalizeOrderSubmission({ ...validPayload, items: [] }), /entre 1 et 30/);
});

test("calcule les prix pour MU pourcentage et remise membre", () => {
  const catalog = [{
    itemName: "Item A", storage: "ARMORS", aisle: "PARTS", stock: 5,
    unitTtPed: 10, markupKind: "percent", markupValue: 1.2
  }];
  const normal = priceOrderLines(normalizedItems(), catalog);
  const member = priceOrderLines(normalizedItems(), catalog, { frjMember: true });
  assert.equal(normal.totalSalePed, 24);
  assert.equal(member.totalSalePed, 22);
});

test("calcule un MU PED par unité", () => {
  const requested = normalizeOrderSubmission({
    ...validPayload,
    items: [{ ...validPayload.items[0], unitTtPed: 3, markupKind: "ped", markupValue: 0.5 }]
  }).items;
  const result = priceOrderLines(requested, [{
    itemName: "Item A", storage: "ARMORS", aisle: "PARTS", stock: 5,
    unitTtPed: 3, markupKind: "ped", markupValue: 0.5
  }]);
  assert.equal(result.totalTtPed, 6);
  assert.equal(result.totalSalePed, 7);
});

test("signale un stock insuffisant sans enregistrer la ligne", () => {
  const requested = normalizeOrderSubmission({
    ...validPayload,
    items: [{ ...validPayload.items[0], quantity: 6 }]
  }).items;
  const result = priceOrderLines(requested, [{
    itemName: "Item A", storage: "ARMORS", aisle: "PARTS", stock: 5,
    unitTtPed: 3, markupKind: "none", markupValue: null
  }]);
  assert.equal(result.lines.length, 0);
  assert.equal(result.discrepancies[0].reason, "insufficient-stock");
});

test("demande une nouvelle confirmation si le prix affiché a changé", () => {
  const result = priceOrderLines(normalizedItems(), [{
    itemName: "Item A", storage: "ARMORS", aisle: "PARTS", stock: 5,
    unitTtPed: 11, markupKind: "percent", markupValue: 1.2
  }]);
  assert.equal(result.lines.length, 0);
  assert.equal(result.discrepancies[0].reason, "price-changed");
  assert.equal(result.discrepancies[0].unitTtPed, 11);
});

test("calcule avec le MU arrondi exactement comme sur la tuile", () => {
  const result = priceOrderLines(normalizedItems(), [{
    itemName: "Item A", storage: "ARMORS", aisle: "PARTS", stock: 5,
    unitTtPed: 10, markupKind: "percent", markupValue: 1.200049
  }]);
  assert.equal(result.discrepancies.length, 0);
  assert.equal(result.totalSalePed, 24);
});

test("valide uniquement les statuts connus", () => {
  assert.equal(validateOrderStatus("READY"), "ready");
  assert.throws(() => validateOrderStatus("deleted"), /invalide/);
});
