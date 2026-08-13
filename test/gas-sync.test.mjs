import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import {
  catalogContentHash,
  inventoryContentHash,
  marketContentHash
} from "../cloudflare/for-sale-api/src/sync.js";

const context = {
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
  encodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: "sha256" },
    Charset: { UTF_8: "utf8" },
    computeDigest(_algorithm, value) {
      return [...crypto.createHash("sha256").update(value, "utf8").digest()]
        .map((byte) => byte > 127 ? byte - 256 : byte);
    }
  }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL("../gas/SyncD1.gs", import.meta.url), "utf8"), context);

test("GAS et Worker calculent la même empreinte d'inventaire", async () => {
  const rows = [{
    sourceId: "123",
    itemName: "Pixie Arm Guards, Adjusted (F)",
    quantity: 2,
    valuePed: 1.25,
    container: "Pitbull Mk. 1 (C,L)",
    containerRefId: "456"
  }];
  assert.equal(context.frjHashInventory_(rows), await inventoryContentHash(rows));
});

test("GAS et Worker calculent la même empreinte MU", async () => {
  const rows = [{
    itemName: "Item A", tier: "1", dayMarkup: "101%", daySales: "2 PED",
    weekMarkup: "102%", weekSales: "4 PED", monthMarkup: "103%", monthSales: "8 PED",
    yearMarkup: "104%", yearSales: "16 PED", decadeMarkup: "105%", decadeSales: "32 PED",
    observedAt: "2026-08-13T10:00:00+02:00"
  }];
  assert.equal(context.frjHashMarket_(rows), await marketContentHash(rows));
});

test("GAS et Worker calculent la même empreinte catalogue", async () => {
  const rows = [{
    itemName: "Pixie Arm Guards, Adjusted (F)",
    storage: "armors",
    aisle: "pixie",
    unitPricePed: 1.25,
    image: "https://example.invalid/pixie.png",
    wikiUrl: "https://example.invalid/pixie",
    enabled: 1
  }];
  assert.equal(context.frjHashCatalog_(rows), await catalogContentHash(rows));
});

test("la fusion à trois voies conserve les changements indépendants", () => {
  const base = [
    { sourceId: "1", itemName: "A", quantity: 1 },
    { sourceId: "2", itemName: "B", quantity: 1 }
  ];
  const local = [
    { sourceId: "1", itemName: "A", quantity: 2 },
    { sourceId: "2", itemName: "B", quantity: 1 }
  ];
  const remote = [
    { sourceId: "1", itemName: "A", quantity: 1 },
    { sourceId: "2", itemName: "B", quantity: 3 }
  ];

  const merged = context.frjThreeWayMerge_("inventory:enzo", base, local, remote, "remote");
  assert.equal(merged.find((row) => row.sourceId === "1").quantity, 2);
  assert.equal(merged.find((row) => row.sourceId === "2").quantity, 3);
});

test("la fusion propage une suppression si l'autre côté n'a pas modifié la ligne", () => {
  const base = [
    { sourceId: "1", itemName: "A", quantity: 1 },
    { sourceId: "2", itemName: "B", quantity: 1 }
  ];
  const local = [{ sourceId: "2", itemName: "B", quantity: 1 }];
  const remote = [
    { sourceId: "1", itemName: "A", quantity: 1 },
    { sourceId: "2", itemName: "B", quantity: 4 }
  ];

  const merged = context.frjThreeWayMerge_("inventory:enzo", base, local, remote, "remote");
  assert.equal(merged.some((row) => row.sourceId === "1"), false);
  assert.equal(merged.find((row) => row.sourceId === "2").quantity, 4);
});

test("une modification récente programme la synchronisation cinq minutes plus tard", () => {
  const changedAt = Date.parse("2026-08-13T12:00:00+02:00");
  assert.equal(context.frjComputeSyncRunAt_(changedAt, changedAt), changedAt + 5 * 60 * 1000);
});

test("un signal D1 déjà âgé de cinq minutes déclenche la synchronisation sans nouvelle attente", () => {
  const changedAt = Date.parse("2026-08-13T12:00:00+02:00");
  const detectedAt = changedAt + 5 * 60 * 1000;
  assert.equal(context.frjComputeSyncRunAt_(changedAt, detectedAt), detectedAt + 1000);
});
