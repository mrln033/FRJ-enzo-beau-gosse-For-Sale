import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../js/common/order-ui.js", import.meta.url), "utf8");

function loadOrderUi() {
  const window = {};
  vm.runInContext(source, vm.createContext({ window }));
  return window.FRJ_ORDER_UI;
}

test("les statuts partagés conservent les libellés Admin, FR et EN", () => {
  const ui = loadOrderUi();
  assert.equal(ui.statusLabel("submitted", "FR", "admin"), "Transmise");
  assert.equal(ui.statusLabel("submitted", "FR"), "Demande transmise");
  assert.equal(ui.statusLabel("submitted", "EN"), "Request submitted");
  assert.equal(ui.statusKeys.length, 8);
});

test("les statuts de prix partagent leurs libellés Admin, FR et EN", () => {
  const ui = loadOrderUi();
  assert.equal(ui.pricingLabel("estimated", "FR", "admin"), "Prix estimés");
  assert.equal(ui.pricingLabel("to-confirm", "FR"), "Prix à confirmer");
  assert.equal(ui.pricingLabel("confirmed", "EN"), "Confirmed prices");
  assert.equal(ui.pricingLabel("inconnu", "EN"), "Estimated prices");
});

test("les règles d'action changent au début de la préparation", () => {
  const ui = loadOrderUi();
  assert.equal(ui.canEditProposal("viewed"), true);
  assert.equal(ui.canCancel("viewed"), true);
  assert.equal(ui.canEditProposal("preparing"), false);
  assert.equal(ui.canCancel("preparing"), false);
  assert.equal(ui.canHide("completed"), true);
});

test("les formats PED et quantité respectent la langue", () => {
  const ui = loadOrderUi();
  assert.match(ui.formatPed(1234.5, "FR"), /1.234,50/u);
  assert.match(ui.formatPed(1234.5, "EN"), /1,234\.50/);
  assert.equal(ui.formatQuantity(1234, "FR"), "1 234");
  assert.equal(ui.formatQuantity(1.6, "EN"), "2");
  assert.equal(ui.roundPed(1.005), 1.01);
});
