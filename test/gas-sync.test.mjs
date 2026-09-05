import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { normalizeInventoryRows } from "../cloudflare/for-sale-api/src/domain.js";
import {
  catalogContentHash,
  containerContentHash,
  discountCampaignContentHash,
  discountConfigContentHash,
  inventoryContentHash,
  marketContentHash
} from "../cloudflare/for-sale-api/src/sync.js";

const scriptProperties = new Map();
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
    },
    getUuid: () => crypto.randomUUID()
  },
  PropertiesService: {
    getScriptProperties() {
      return {
        getProperty: (key) => scriptProperties.get(key) || null,
        setProperty: (key, value) => scriptProperties.set(key, String(value)),
        deleteProperty: (key) => scriptProperties.delete(key)
      };
    }
  }
};
vm.createContext(context);
[
  "Containers.gs",
  "DiscountSheets.gs",
  "Imports.gs",
  "SyncD1.gs",
  "SyncOrders.gs",
  "SyncEngine.gs",
  "SyncSheets.gs",
  "SyncTransport.gs"
].forEach((fileName) => {
  vm.runInContext(fs.readFileSync(new URL(`../gas/${fileName}`, import.meta.url), "utf8"), context);
});

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

test("GAS et Worker calculent la même empreinte de conteneurs", async () => {
  const rows = [
    { avatar: "enzo", containerKey: "carried", container: "CARRIED", enabled: true },
    { avatar: "kenza", containerKey: "storage", container: "Storage", enabled: false }
  ];
  assert.equal(context.frjHashContainerConfig_(rows), await containerContentHash(rows));
});

test("GAS et Worker calculent la même empreinte des campagnes de remise", async () => {
  const rows = [{
    id: "daily-promo-2026-08-30", type: "daily_promo", startsOn: "2026-08-30", endsOn: "2026-08-30",
    storage: "ARMORS", aisle: "PARTS", discountRate: 0.05, enabled: true, origin: "automatic",
    eligiblePairCount: 8, candidatePairCount: 2, updatedAt: "2026-08-30T00:05:00.000Z"
  }];
  assert.equal(context.frjHashDiscountCampaigns_(rows), await discountCampaignContentHash(rows));
});

test("GAS et Worker calculent la même empreinte de configuration des remises", async () => {
  const rows = [{
    id: "config", automaticPromotionsEnabled: true, defaultPromotionRate: 0.05,
    selectionSeed: "frj-daily-promo", updatedAt: "2026-08-30T00:00:00.000Z"
  }];
  assert.equal(context.frjHashDiscountConfig_(rows), await discountConfigContentHash(rows));
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

test("la fusion des conteneurs conserve les lignes absentes d'un seul côté", () => {
  const base = [{ avatar: "enzo", containerKey: "carried", container: "CARRIED", enabled: true }];
  const local = [];
  const remote = [
    ...base,
    { avatar: "enzo", containerKey: "storage", container: "Storage", enabled: false }
  ];
  const merged = context.frjThreeWayMerge_("containers", base, local, remote, "remote");
  assert.equal(merged.length, 2);
  assert.equal(merged.some((row) => row.containerKey === "carried"), true);
  assert.equal(merged.some((row) => row.containerKey === "storage"), true);
});

test("le moteur GAS suit la configuration des conteneurs", () => {
  assert.equal(context.frjDatasetKeys_().includes("containers"), true);
});

test("le moteur GAS synchronise les campagnes et leur configuration", () => {
  assert.equal(context.frjDatasetKeys_().includes("discounts"), true);
  assert.equal(context.frjDatasetKeys_().includes("discount-config"), true);
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

test("l'outbox GAS conserve les datasets non traités et acquitte les autres", () => {
  context.frjWriteGasOutbox_([
    { id: "evt-mu", dataset: "mu", hash: "hash-mu" },
    { id: "evt-enzo", dataset: "inventory:enzo", hash: "hash-enzo" }
  ]);
  const remaining = context.frjAcknowledgeGasOutbox_([{ dataset: "mu" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(remaining)), [
    { id: "evt-enzo", dataset: "inventory:enzo", hash: "hash-enzo" }
  ]);
  assert.equal(context.frjReadGasOutbox_()[0].id, "evt-enzo");
});

test("T-009 conserve les métadonnées d'inventaire et les apostrophes", async () => {
  const row = {
    sourceId: "item-123",
    itemName: "Serpent's Scale",
    quantity: 7,
    valuePed: 3.5,
    container: "STORAGE (Calypso)",
    containerRefId: "container-456"
  };
  assert.notEqual(
    context.frjHashInventory_([row]),
    context.frjHashInventory_([{ ...row, sourceId: null, containerRefId: null }])
  );
  const importsSource = fs.readFileSync(new URL("../gas/Imports.gs", import.meta.url), "utf8");
  assert.match(importsSource, /frjRefreshContainerConfigurationAfterInventoryUnlocked_\(inventoryId\)/);
  assert.doesNotMatch(importsSource, /frjRefreshContainerConfigurationAfterInventory_\(inventoryId\)/);
});

test("T-009 répare les métadonnées depuis le côté le plus complet", () => {
  const syncEngineSource = fs.readFileSync(new URL("../gas/SyncEngine.gs", import.meta.url), "utf8");
  const applicationSource = fs.readFileSync(new URL("../cloudflare/for-sale-api/src/application.js", import.meta.url), "utf8");
  const complete = [{ sourceId: "1", itemName: "A", quantity: 1, valuePed: 0.1, containerRefId: "null" }];
  const incomplete = [{ sourceId: null, itemName: "A", quantity: 1, valuePed: 0.1, containerRefId: null }];
  assert.ok(context.frjInventoryMetadataScore_(complete) > context.frjInventoryMetadataScore_(incomplete));
  assert.match(syncEngineSource, /localMetadataScore > remoteMetadataScore[\s\S]*"gas-to-d1"/);
  assert.match(syncEngineSource, /remoteMetadataScore > localMetadataScore[\s\S]*"d1-to-gas"/);
  assert.match(syncEngineSource, /local\.hash === remoteState\.hash[\s\S]*frjWriteLocalDataset_\(dataset, \{ state: remoteState, rows: local\.rows \}\)/);
  scriptProperties.clear();
  assert.equal(context.frjInventoryMetadataSchemaIsCurrent_("inventory:enzo"), false);
  context.frjMarkInventoryMetadataSchemaCurrent_("inventory:enzo");
  assert.equal(context.frjInventoryMetadataSchemaIsCurrent_("inventory:enzo"), true);
  assert.match(applicationSource, /const snapshot = await readInventorySnapshot\(env, avatar\)/);
});

test("un guillemet MindArk non refermé ne fusionne pas les articles GAS ou D1", () => {
  const raw = [
    'Id\tName\tQuantity\tValue(PED)\tContainer\tContainerRefId',
    '1851\t"Umbranoid ""Medicine""\t1\t0.1000\tCARRIED\tnull',
    '1852\tUniversal Ammo\t45\t0.0000\tCARRIED\tnull',
    '1861\tVehicle Parts (Vol. 1)\t1\t1.0000\t"Pitbull Mk. 1 (C,L)"\t1398'
  ].join("\r\n") + "\r\n";
  const gas = context.frjNormalizeInventorySheetData_(context.frjParseInventoryTsv_(raw)).slice(1);
  const d1 = normalizeInventoryRows(raw);
  assert.equal(gas.length, 3);
  assert.equal(d1.length, 3);
  assert.equal(d1[0].itemName, 'Umbranoid "Medicine"');
  assert.equal(d1[1].itemName, 'Universal Ammo');
  assert.equal(d1[2].container, 'Pitbull Mk. 1 (C,L)');
  for (let i = 0; i < gas.length; i++) {
    assert.equal(gas[i][1], d1[i].itemName);
    assert.equal(gas[i][2], d1[i].quantity);
    assert.equal(Number(gas[i][3]), d1[i].valuePed);
    assert.equal(gas[i][4], d1[i].container);
  }
  assert.throws(() => normalizeInventoryRows(raw + "999\tArticle incomplet"), /2 colonnes/);
});

test("T-009 écrit les types de cellules comme un collage MindArk", () => {
  const rows = context.frjNormalizeInventorySheetData_([
    ["Id", "Name", "Quantity", "Value(PED)", "Container", "ContainerRefId"],
    ["1", "Article A", "2", "0.1000", "STORAGE (Calypso)", "807"],
    ["2", "Article B", "1", "4.0000", "STORAGE (Calypso)", "null"]
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    ["Id", "Name", "Quantity", "Value(PED)", "Container", "ContainerRefId"],
    [1, "Article A", 2, "0.1000", "STORAGE (Calypso)", 807],
    [2, "Article B", 1, "4.0000", "STORAGE (Calypso)", "null"]
  ]);
});

test("l'import ignore les lignes vides mais refuse une ligne article incomplète avant écriture", () => {
  const header = ["Id", "Name", "Quantity", "Value(PED)", "Container", "ContainerRefId"];
  const row = ["1", "Serpent's Scale", "2", "0.1000", "STORAGE (Calypso)", "null"];
  const original = { parseCsv: context.Utilities.parseCsv, SpreadsheetApp: context.SpreadsheetApp, getInventorySheetName: context.getInventorySheetName, refresh: context.frjRefreshContainerConfigurationAfterInventoryUnlocked_ };
  let writes = 0;
  let written;
  const range = { clearContent() {}, setNumberFormat() {}, setValue() {}, setValues(values) { writes++; written = values; } };
  const sheet = { getMaxRows: () => 2000, getMaxColumns: () => 6, getRange: () => range };
  context.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
  context.getInventorySheetName = () => "Inventaire Enzo";
  context.frjRefreshContainerConfigurationAfterInventoryUnlocked_ = () => {};
  context.Utilities.parseCsv = (text) => {
    assert.equal(text.startsWith('\uFEFF'), false);
    assert.equal(text.includes('\r'), false);
    assert.equal(text.endsWith('\n'), false);
    return text.split('\n').map(line => line.split('\t'));
  };
  try {
    const input = '\uFEFF' + header.join('\t') + '\r\n\r\n' + row.join('\t') + '\r\n';
    assert.match(context.processInventory(input, 'enzo'), /Import inventaire OK/);
    assert.equal(written.length, 2);
    assert.equal(written[1][1], "Serpent's Scale");
    assert.equal(written[1][3], '0.1000');
    writes = 0;
    assert.throws(() => context.processInventory(header.join('\t') + '\n1\tArticle', 'enzo'), /2 colonnes/);
    assert.equal(writes, 0);
  } finally {
    context.Utilities.parseCsv = original.parseCsv;
    context.SpreadsheetApp = original.SpreadsheetApp;
    context.getInventorySheetName = original.getInventorySheetName;
    context.frjRefreshContainerConfigurationAfterInventoryUnlocked_ = original.refresh;
  }
});
