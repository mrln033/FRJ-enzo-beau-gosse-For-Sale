import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../gas/Catalog.gs", import.meta.url), "utf8");

function createCache() {
  const values = new Map();
  return {
    values,
    service: {
      get(key) {
        return values.get(key) ?? null;
      },
      getAll(keys) {
        return Object.fromEntries(keys.filter(key => values.has(key)).map(key => [key, values.get(key)]));
      },
      put(key, value) {
        values.set(key, value);
      },
      putAll(entries) {
        Object.entries(entries).forEach(([key, value]) => values.set(key, value));
      }
    }
  };
}

function loadCatalog(overrides = {}) {
  const cache = createCache();
  const context = vm.createContext({
    CacheService: { getScriptCache: () => cache.service },
    SpreadsheetApp: overrides.SpreadsheetApp || { openById: () => { throw new Error("lecture inattendue"); } },
    Utilities: { formatDate: () => "" },
    Session: { getScriptTimeZone: () => "Europe/Paris" },
    console
  });
  new vm.Script(source, { filename: "Catalog.gs" }).runInContext(context);
  return { context, cache };
}

test("d.6.4 lit seulement la tranche utile de BDD_APP puis met les catégories en cache", () => {
  const ranges = [];
  const rows = [
    ["STORAGE", "RAYON", "ITEM", "QUANTITE", "PRIX_UNITAIRE", "IMAGE", "WIKI"],
    ["armors", "body", "Armor A", 2, 1, "", ""],
    ["weapons", "rifle", "Weapon A", 0, 2, "", ""],
    ["materials", "ore", "Material A", 3, 3, "", ""]
  ];
  const sheet = {
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    getRange(row, column, rowCount, columnCount) {
      ranges.push([row, column, rowCount, columnCount]);
      return {
        getValues: () => rows.slice(row - 1, row - 1 + rowCount)
          .map(values => values.slice(column - 1, column - 1 + columnCount))
      };
    }
  };
  let openings = 0;
  const { context } = loadCatalog({
    SpreadsheetApp: {
      openById: () => {
        openings++;
        return { getSheetByName: () => sheet };
      }
    }
  });

  assert.deepEqual(Array.from(context.getAvailableCategories()), ["ARMORS", "MATERIALS"]);
  assert.deepEqual(ranges, [[1, 1, 1, 7], [2, 1, 3, 4]]);
  assert.equal(openings, 1);

  assert.deepEqual(Array.from(context.getAvailableCategories()), ["ARMORS", "MATERIALS"]);
  assert.equal(openings, 1, "le second appel ne doit plus ouvrir Google Sheets");
});

test("d.6.4 mutualise les variantes de casse d'une catégorie dans une même entrée", () => {
  const { context } = loadCatalog();
  let reads = 0;
  context.getBDDAppData = category => {
    reads++;
    return [{ STORAGE: category, ITEM: "Armor A" }];
  };

  const first = context.getDataFast(" armors ");
  const second = context.getDataFast("ARMORS");

  assert.equal(reads, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), [{ STORAGE: "ARMORS", ITEM: "Armor A" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(second)), [{ STORAGE: "ARMORS", ITEM: "Armor A" }]);
});

test("d.6.4 découpe et recompose une catégorie dépassant une entrée de cache", () => {
  const { context, cache } = loadCatalog();
  let reads = 0;
  const largeResult = [{ STORAGE: "BLUEPRINTS", DESCRIPTION: "é".repeat(70000) }];
  context.getBDDAppData = () => {
    reads++;
    return largeResult;
  };

  context.getDataFast("BLUEPRINTS");
  const manifest = JSON.parse(cache.values.get("catalog_v2_category_BLUEPRINTS"));
  assert.ok(manifest.frjChunks >= 3);
  assert.ok([...cache.values.keys()].some(key => key.endsWith("_0")));

  const cached = context.getDataFast("blueprints");
  assert.equal(reads, 1);
  assert.equal(cached[0].DESCRIPTION.length, 70000);
});
