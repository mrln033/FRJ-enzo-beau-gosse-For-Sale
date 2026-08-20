import test from "node:test";
import assert from "node:assert/strict";
import {
  canClientCancelOrder,
  canReviseOrder,
  hasSameOrderTerms,
  normalizeOrderSubmission,
  priceOrderLines,
  reviseOrderLine,
  validateOrderStatus
} from "../src/orders.js";

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
  assert.throws(() => normalizeOrderSubmission({ ...validPayload, items: [] }), /entre 1 et 10/);
});

test("limite les nouvelles demandes à 10 lignes", () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    ...validPayload.items[0], itemName: `Item ${index + 1}`
  }));
  assert.equal(normalizeOrderSubmission({ ...validPayload, items }).items.length, 10);
  assert.throws(
    () => normalizeOrderSubmission({ ...validPayload, items: [...items, { ...items[0], itemName: "Item 11" }] }),
    /entre 1 et 10/
  );
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

test("accepte uniquement des quantités entières", () => {
  assert.equal(normalizeOrderSubmission(validPayload).items[0].quantity, 2);
  assert.throws(
    () => normalizeOrderSubmission({
      ...validPayload,
      items: [{ ...validPayload.items[0], quantity: 1.5 }]
    }),
    /entière/
  );
});

test("autorise les propositions uniquement avant la préparation", () => {
  assert.equal(canReviseOrder("submitted"), true);
  assert.equal(canReviseOrder("viewed"), true);
  assert.equal(canReviseOrder("submitted", 1), true);
  assert.equal(canReviseOrder("preparing"), false);
  assert.equal(canReviseOrder("ready"), false);
  assert.equal(canReviseOrder("completed"), false);
  assert.equal(canReviseOrder("cancelled"), false);
  assert.equal(canReviseOrder("expired"), false);
});

test("autorise le client à annuler uniquement avant la préparation", () => {
  assert.equal(canClientCancelOrder("submitted"), true);
  assert.equal(canClientCancelOrder("viewed"), true);
  assert.equal(canClientCancelOrder("submitted", 1), true);
  assert.equal(canClientCancelOrder("preparing"), false);
  assert.equal(canClientCancelOrder("ready"), false);
  assert.equal(canClientCancelOrder("completed"), false);
  assert.equal(canClientCancelOrder("cancelled"), false);
  assert.equal(canClientCancelOrder("expired"), false);
});

test("recalcule une proposition ponctuelle en pourcentage affiché", () => {
  const revised = reviseOrderLine({ itemName: "Item A", unitTtPed: 10 }, {
    quantity: 3,
    markupKind: "percent",
    markupAmount: 115
  }, 5);
  assert.equal(revised.markupValue, 1.15);
  assert.equal(revised.markupDisplay, "115,00 %");
  assert.equal(revised.lineSalePed, 34.5);
});

test("recalcule une proposition ponctuelle en PED et contrôle le stock", () => {
  const revised = reviseOrderLine({ itemName: "Item A", unitTtPed: 3 }, {
    quantity: 2,
    markupKind: "ped",
    markupAmount: 0.75
  }, 2);
  assert.equal(revised.lineSalePed, 7.5);
  assert.throws(() => reviseOrderLine({ itemName: "Item A", unitTtPed: 3 }, {
    quantity: 3,
    markupKind: "none"
  }, 2), /Stock insuffisant/);
});

test("calcule les petites valeurs avant l'arrondi monétaire final", () => {
  const revised = reviseOrderLine({ itemName: "Item A", unitTtPed: 0.01 }, {
    quantity: 1000,
    markupKind: "percent",
    markupAmount: 110
  }, 1000);
  assert.equal(revised.unitSalePed, 0.011);
  assert.equal(revised.lineSalePed, 11);
});

test("conserve aussi la précision d'une petite valeur à la création", () => {
  const requested = normalizeOrderSubmission({
    ...validPayload,
    items: [{
      ...validPayload.items[0], quantity: 1000, unitTtPed: 0.01,
      markupKind: "percent", markupValue: 1.1
    }]
  }).items;
  const priced = priceOrderLines(requested, [{
    itemName: "Item A", storage: "ARMORS", aisle: "PARTS", stock: 1000,
    unitTtPed: 0.01, markupKind: "percent", markupValue: 1.1
  }]);
  assert.equal(priced.lines[0].unitSalePed, 0.011);
  assert.equal(priced.lines[0].lineSalePed, 11);
  assert.equal(priced.totalSalePed, 11);
});

test("conserve une MU saisie avec jusqu'à six décimales", () => {
  const revised = reviseOrderLine({ itemName: "Item A", unitTtPed: 0.01 }, {
    quantity: 1000,
    markupKind: "percent",
    markupAmount: 115.123456
  }, 1000);
  assert.equal(revised.markupValue, 1.15123456);
  assert.equal(revised.markupDisplay, "115,12 %");
  assert.equal(revised.unitSalePed, 0.011512);
  assert.equal(revised.lineSalePed, 11.51);

  assert.throws(() => reviseOrderLine({ itemName: "Item A", unitTtPed: 1 }, {
    quantity: 1,
    markupKind: "ped",
    markupAmount: 0.1234567
  }, 1), /6 décimales/);
});

test("détecte une modification portant sur la sixième décimale de MU", () => {
  const existing = { quantity: 2, markup_kind: "percent", markup_value: 1.15123455 };
  const revised = { quantity: 2, markupKind: "percent", markupValue: 1.15123456 };
  assert.equal(hasSameOrderTerms(existing, revised), false);
  assert.equal(hasSameOrderTerms(existing, { ...revised, markupValue: 1.15123455 }), true);
});

test("refuse une quantité décimale dans une proposition Admin", () => {
  assert.throws(() => reviseOrderLine({ itemName: "Item A", unitTtPed: 1 }, {
    quantity: 1.5,
    markupKind: "none"
  }, 5), /entière/);
});
