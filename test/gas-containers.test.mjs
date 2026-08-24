import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = {
  Object,
  String,
  Number,
  Array,
  Math
};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(new URL("../gas/Containers.gs", import.meta.url), "utf8"),
  context
);

context.FRJ_SYNC_CONFIG = {
  inventorySpreadsheetId: "inventory-sheet-id",
  inventorySheets: {
    enzo: "Inventaire Enzo",
    arkaman: "Inventaire ArkaMan",
    kenza: "Inventaire Kenza",
    nocturnal: "Inventaire Nocturnal"
  }
};

test("d.8.5 ajoute les conteneurs inconnus désactivés sans retirer les anciens", () => {
  const existing = [
    ["enzo", "Carried", true],
    ["enzo", "Longreach II (L)", false],
    ["kenza", "Carried", false]
  ];
  const inventory = [[" carried "], ["New Storage"], ["NEW STORAGE"], [""]];
  const additions = context.frjFindMissingContainerRows_("enzo", existing, inventory);

  assert.deepEqual(JSON.parse(JSON.stringify(additions)), [["enzo", "New Storage", false]]);
  assert.equal(existing.some((row) => row[1] === "Longreach II (L)"), true);
});

test("d.8.5 construit une formule pilotée par CONFIG_CONTAINER", () => {
  const formula = context.frjBuildContainerQuantityFormula_(2, 3);

  assert.match(formula, /^=IF\(C2=/);
  assert.match(formula, /CONFIG_CONTAINER!\$A\$2:\$A="enzo"/);
  assert.match(formula, /CONFIG_CONTAINER!\$C\$2:\$C=TRUE/);
  assert.match(formula, /Inventaire Enzo/);
  assert.doesNotMatch(formula, /calypso|pitbull|limited/i);
});

test("d.8.5 prépare les quatre avatars", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.FRJ_CONTAINER_CONFIG.avatars)),
    ["enzo", "arkaman", "kenza", "nocturnal"]
  );
});

test("d.8.7 initialise automatiquement CONFIG_CONTAINER une seule fois par version", () => {
  const properties = new Map();
  let preparations = 0;
  context.PropertiesService = {
    getScriptProperties() {
      return {
        getProperty: (key) => properties.get(key) || null
      };
    }
  };
  context.frjPrepareContainerConfigurationUnlocked_ = () => {
    preparations += 1;
    properties.set(
      context.FRJ_CONTAINER_CONFIG.readinessProperty,
      context.FRJ_CONTAINER_CONFIG.readinessVersion
    );
    return { migrated: true };
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.frjEnsureContainerConfigurationReady_())),
    { migrated: true }
  );
  assert.equal(context.frjEnsureContainerConfigurationReady_(), null);
  assert.equal(preparations, 1);
});
