import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../js/common/import-feedback.js", import.meta.url), "utf8");

function loadFormatter() {
  const window = {};
  vm.runInContext(source, vm.createContext({ window }));
  return window.FRJ_IMPORTS.formatOutcome;
}

test("le bilan distingue GAS et D1", () => {
  const formatOutcome = loadFormatter();
  const message = formatOutcome({
    ok: true,
    partial: false,
    results: [
      { backend: "gas", ok: true, message: "12 lignes" },
      { backend: "d1", ok: true, message: "12 lignes" }
    ]
  });

  assert.match(message, /✅ GAS : 12 lignes/);
  assert.match(message, /✅ D1 : 12 lignes/);
});

test("un succès partiel annonce la réparation par synchronisation", () => {
  const formatOutcome = loadFormatter();
  const message = formatOutcome({
    ok: true,
    partial: true,
    results: [{ backend: "d1", ok: true, message: "Import terminé" }]
  });

  assert.match(message, /Import partiel/);
  assert.match(message, /synchronisation/);
});

test("un double échec précise que le CSV est conservé", () => {
  const formatOutcome = loadFormatter();
  const message = formatOutcome({
    ok: false,
    partial: false,
    results: [{ backend: "gas", ok: false, message: "Indisponible" }]
  });

  assert.match(message, /CSV est conservé/);
});
