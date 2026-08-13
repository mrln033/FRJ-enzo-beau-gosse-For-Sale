import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalCatalogPayload,
  canonicalInventoryPayload,
  canonicalMarketPayload,
  aggregateInventoryRows,
  inventoryContentHash,
  mergeMarketRows
} from "../src/sync.js";

test("l'empreinte inventaire ignore l'ordre et les numéros de ligne", async () => {
  const first = {
    lineNo: 2, sourceId: "1", itemName: "Item A", quantity: 2,
    valuePed: 1.5, container: "STORAGE (Calypso)", containerRefId: "10"
  };
  const second = { ...first, lineNo: 99, itemName: "Item B" };

  assert.equal(
    await inventoryContentHash([first, second]),
    await inventoryContentHash([{ ...second, lineNo: 3 }, { ...first, lineNo: 8 }])
  );
  assert.match(canonicalInventoryPayload([first]), /Item A/);
});

test("l'inventaire fusionne avatar/item/container et additionne quantité et valeur PED", async () => {
  const rows = [
    {
      sourceId: "id-1", itemName: "Item A", quantity: 2, valuePed: 1.25,
      container: "Storage (Calypso)", containerRefId: "ref-1"
    },
    {
      sourceId: "id-2", itemName: "item a", quantity: 3, valuePed: 2.75,
      container: "storage (calypso)", containerRefId: "ref-2"
    },
    { sourceId: "id-3", itemName: "Item A", quantity: 4, valuePed: null, container: "Carried" }
  ];

  const aggregated = aggregateInventoryRows(rows);
  assert.equal(aggregated.length, 2);
  const storage = aggregated.find((row) => row.container.toLowerCase() === "storage (calypso)");
  assert.equal(storage.quantity, 5);
  assert.equal(storage.valuePed, 4);
  assert.equal(storage.sourceId, null);
  assert.equal(storage.containerRefId, null);
  assert.equal(
    await inventoryContentHash(rows),
    await inventoryContentHash(aggregated)
  );
});

test("la fusion MU remplace l'article reçu et conserve les autres", () => {
  const current = [
    { itemName: "Item A", dayMarkup: "101%", observedAt: "2026-08-01T00:00:00Z" },
    { itemName: "Item B", dayMarkup: "102%", observedAt: "2026-08-01T00:00:00Z" }
  ];
  const incoming = [
    { itemName: "item a", dayMarkup: "110%", observedAt: "2026-08-02T00:00:00Z" }
  ];

  const merged = mergeMarketRows(current, incoming);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((row) => row.itemName.toLowerCase() === "item a").dayMarkup, "110%");
  assert.equal(merged.find((row) => row.itemName === "Item B").dayMarkup, "102%");
});

test("le payload MU inclut la date propre à chaque article", () => {
  const payload = canonicalMarketPayload([
    { itemName: "Item A", observedAt: "2026-08-01T12:00:00+02:00" }
  ]);
  assert.match(payload, /2026-08-01T10:00:00.000Z/);
});

test("le payload catalogue normalise rayons, prix et activation", () => {
  const payload = canonicalCatalogPayload([{
    itemName: "Item A", storage: "armors", aisle: "parts ( f )",
    unitPricePed: "4.00", image: "a.png", wikiUrl: "https://example.test", enabled: true
  }]);
  assert.match(payload, /ARMORS/);
  assert.match(payload, /PARTS \( F \)/);
  assert.match(payload, /"4"/);
});
