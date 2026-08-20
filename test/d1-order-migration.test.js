import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const purchaseSchema = await readFile(
  new URL("../cloudflare/for-sale-api/migrations/0007_purchase_requests.sql", import.meta.url),
  "utf8"
);
const migration = await readFile(
  new URL("../cloudflare/for-sale-api/migrations/0010_recalculate_order_estimates.sql", import.meta.url),
  "utf8"
);

function insertOrder(database, id, totalTtPed, totalSalePed) {
  database.prepare(`
    INSERT INTO purchase_orders (
      id, public_reference, access_token_hash, buyer_avatar,
      total_tt_ped, total_sale_ped
    ) VALUES (?, ?, ?, 'Test Player', ?, ?)
  `).run(id, `FRJ-20260820-${id}`, `token-${id}`, totalTtPed, totalSalePed);
}

function insertItem(database, values) {
  database.prepare(`
    INSERT INTO purchase_order_items (
      order_id, line_no, item_name, storage, aisle, quantity,
      stock_at_submission, unit_tt_ped, markup_kind, markup_value,
      markup_display, unit_sale_ped, line_tt_ped, line_sale_ped
    ) VALUES (?, ?, ?, 'ARMORS', 'PARTS', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.orderId, values.lineNo, values.itemName, values.quantity,
    values.quantity, values.unitTtPed, values.markupKind, values.markupValue,
    values.markupDisplay, values.unitSalePed, values.lineTtPed, values.lineSalePed
  );
}

test("la migration d.7.3 recalcule les lignes et totaux historiques", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(purchaseSchema);
  insertOrder(database, "ORDER01", 10.01, 10.01);
  insertItem(database, {
    orderId: "ORDER01", lineNo: 1, itemName: "Tiny Percent", quantity: 1000,
    unitTtPed: 0.01, markupKind: "percent", markupValue: 1.1,
    markupDisplay: "110,00 %", unitSalePed: 0.01, lineTtPed: 10, lineSalePed: 10
  });
  insertItem(database, {
    orderId: "ORDER01", lineNo: 2, itemName: "Precise PED", quantity: 100000,
    unitTtPed: 0.01, markupKind: "ped", markupValue: 0.000001,
    markupDisplay: "0,00 PED", unitSalePed: 0.01, lineTtPed: 0.01, lineSalePed: 0.01
  });

  database.exec(migration);

  const items = database.prepare(`
    SELECT unit_sale_ped, line_tt_ped, line_sale_ped
    FROM purchase_order_items ORDER BY line_no
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(items, [
    { unit_sale_ped: 0.011, line_tt_ped: 10, line_sale_ped: 11 },
    { unit_sale_ped: 0.010001, line_tt_ped: 1000, line_sale_ped: 1000.1 }
  ]);
  assert.deepEqual(
    { ...database.prepare("SELECT total_tt_ped, total_sale_ped FROM purchase_orders").get() },
    { total_tt_ped: 1010, total_sale_ped: 1011.1 }
  );

  // Le script reste stable si son contenu est rejoué sur une copie ou un test.
  database.exec(migration);
  assert.equal(
    database.prepare("SELECT total_sale_ped FROM purchase_orders").get().total_sale_ped,
    1011.1
  );
  database.close();
});

test("la migration conserve les quantités historiques", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(purchaseSchema);
  insertOrder(database, "ORDER02", 0, 0);
  insertItem(database, {
    orderId: "ORDER02", lineNo: 1, itemName: "Legacy Fraction", quantity: 2.5,
    unitTtPed: 1, markupKind: "none", markupValue: null,
    markupDisplay: null, unitSalePed: 1, lineTtPed: 0, lineSalePed: 0
  });

  database.exec(migration);

  assert.deepEqual(
    { ...database.prepare("SELECT quantity, line_tt_ped, line_sale_ped FROM purchase_order_items").get() },
    { quantity: 2.5, line_tt_ped: 2.5, line_sale_ped: 2.5 }
  );
  database.close();
});
