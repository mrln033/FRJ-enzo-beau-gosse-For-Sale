import test from "node:test";
import assert from "node:assert/strict";
import {
  computeWeightedMarkup,
  normalizeInventoryRows,
  parseMarkup,
  parsePedVolume,
  parseTsv
} from "../src/domain.js";

test("parseTsv conserve les colonnes attendues", () => {
  const parsed = parseTsv("Item\tQuantity\r\nItem A\t2\r\n");
  assert.deepEqual(parsed.headers, ["Item", "Quantity"]);
  assert.equal(parsed.rows[0].Quantity, "2");
});

test("parsePedVolume normalise PEC, PED, K et M", () => {
  assert.equal(parsePedVolume("91.000 PEC"), 0.91);
  assert.equal(parsePedVolume("2.400K PED"), 2400);
  assert.equal(parsePedVolume("1.5M PED"), 1_500_000);
});

test("parseMarkup distingue pourcentage et PED", () => {
  assert.deepEqual(parseMarkup("108.330%"), { kind: "percent", value: 1.0833 });
  assert.deepEqual(parseMarkup("2,10 PED"), { kind: "ped", value: 2.1 });
});

test("computeWeightedMarkup reproduit la pondération Google Sheet", () => {
  const result = computeWeightedMarkup({
    "Day Markup": "N/A", "Day Sales": "0.000 PEC",
    "Week Markup": "N/A", "Week Sales": "0.000 PEC",
    "Month Markup": "108.330%", "Month Sales": "144.000 PED",
    "Year Markup": "118.440%", "Year Sales": "2.400K PED"
  });
  assert.equal(result.kind, "percent");
  assert.equal(result.display, "117,87 %");
});

test("normalizeInventoryRows refuse un format incomplet", () => {
  assert.throws(() => normalizeInventoryRows("Item\tQuantity\nA\t1"), /Colonnes inventaire manquantes/);
});

test("normalizeInventoryRows accepte la date GAS comme en-tête de la colonne Item", () => {
  const rows = normalizeInventoryRows([
    "Id\t12/08/2026 - 08:55:55\tQuantity\tValue(PED)\tContainer\tContainerRefId",
    "1\tA.R.C. Guardian Arm Guards (F)\t1\t4.0000\tSTORAGE (Calypso)\tnull"
  ].join("\n"));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].itemName, "A.R.C. Guardian Arm Guards (F)");
  assert.equal(rows[0].quantity, 1);
});

test("normalizeInventoryRows accepte Name comme alias de Item", () => {
  const rows = normalizeInventoryRows([
    "Id\tName\tQuantity\tValue(PED)\tContainer\tContainerRefId",
    "1\tItem A\t2\t1.25\tCARRIED\tnull"
  ].join("\n"));

  assert.equal(rows[0].itemName, "Item A");
});
