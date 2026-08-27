import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../gas/OrderHistory.gs", import.meta.url), "utf8");

function loadHistory() {
  const context = vm.createContext({
    Date,
    JSON,
    String,
    Number,
    Array,
    Object,
    isNaN,
    Utilities: { getUuid: () => "22222222-2222-4222-8222-222222222222" }
  });
  vm.runInContext(source, context, { filename: "OrderHistory.gs" });
  return context;
}

class FakeRange {
  constructor(sheet, row, column, rows = 1, columns = 1) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rows = rows;
    this.columns = columns;
  }
  getValue() { return this.sheet.data[this.row - 1][this.column - 1]; }
  getValues() {
    return this.sheet.data.slice(this.row - 1, this.row - 1 + this.rows)
      .map((row) => row.slice(this.column - 1, this.column - 1 + this.columns));
  }
  getDisplayValues() { return this.getValues().map((row) => row.map(String)); }
  setValue(value) { this.sheet.data[this.row - 1][this.column - 1] = value; return this; }
  setValues(values) {
    values.forEach((sourceRow, rowOffset) => sourceRow.forEach((value, columnOffset) => {
      while (!this.sheet.data[this.row - 1 + rowOffset]) this.sheet.data.push([]);
      this.sheet.data[this.row - 1 + rowOffset][this.column - 1 + columnOffset] = value;
    }));
    return this;
  }
  clearContent() { return this.setValue(""); }
  getColumn() { return this.column; }
  getRow() { return this.row; }
}

class FakeSheet {
  constructor(name, data) { this.name = name; this.data = data; this.parent = null; }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return Math.max(...this.data.map((row) => row.length)); }
  getMaxColumns() { return this.getLastColumn(); }
  getRange(row, column, rows, columns) { return new FakeRange(this, row, column, rows, columns); }
  appendRow(row) { this.data.push(row.slice()); }
  setFrozenRows() {}
  getParent() { return this.parent; }
}

test("GAS crée une clé stable et le commentaire automatique d'un changement de statut", () => {
  const context = loadHistory();
  const event = context.purchaseCreateHistoryEvent_(
    "11111111-1111-4111-8111-111111111111",
    "status-changed",
    "admin",
    { from: "submitted", to: "preparing" },
    "preparing"
  );
  assert.equal(event.eventKey, "gas-22222222-2222-4222-8222-222222222222");
  assert.equal(event.comment, "Statut modifié : Transmise → À préparer.");
  assert.equal(event.newStatus, "preparing");
});

test("une ligne COMMANDES_HISTORIQUE conserve le contrat échangé avec D1", () => {
  const context = loadHistory();
  const event = {
    eventKey: "d1-7",
    orderId: "11111111-1111-4111-8111-111111111111",
    action: "status-changed",
    actor: "admin",
    newStatus: "viewed",
    comment: "Client prévenu.",
    details: { from: "submitted", to: "viewed" },
    createdAt: "2026-08-27T10:00:00.000Z",
    commentUpdatedAt: "2026-08-27T10:05:00.000Z"
  };
  const row = context.purchaseHistoryRow_(event, false, "");
  const headers = context.purchaseOrderHistoryHeaders_();
  const indexes = Object.fromEntries(headers.map((header, index) => [header, index]));
  const restored = context.purchaseHistoryEventFromRow_(row, indexes);
  assert.deepEqual(
    JSON.parse(JSON.stringify(restored)),
    event
  );
  assert.equal(row[indexes.SYNCED_D1_AT], "");
});

test("une modification de statut dans COMMANDES_APP crée immédiatement son historique GAS", () => {
  const context = loadHistory();
  const orderHeaders = [
    "ORDER_ID", "REFERENCE", "AVATAR_ACHETEUR", "CONTACT", "COMMENTAIRE", "LANGUE",
    "MEMBRE_FRJ", "STATUT", "TOTAL_TT_PED", "TOTAL_VENTE_PED", "PRIX_STATUT",
    "DATE_CLIENT", "DATE_RECEPTION", "SYNC_PAYLOAD_JSON", "SYNCED_D1_AT", "SYNC_ERROR",
    "DISCORD_MESSAGE_ID", "DISCORD_ERROR", "APPROVAL_REQUIRED", "PROPOSAL_VERSION"
  ];
  const orderId = "11111111-1111-4111-8111-111111111111";
  const orderRow = new Array(orderHeaders.length).fill("");
  orderRow[orderHeaders.indexOf("ORDER_ID")] = orderId;
  orderRow[orderHeaders.indexOf("STATUT")] = "viewed";
  orderRow[orderHeaders.indexOf("SYNC_PAYLOAD_JSON")] = JSON.stringify({
    order: { id: orderId, status: "submitted", approvalRequired: false }, items: []
  });
  orderRow[orderHeaders.indexOf("SYNCED_D1_AT")] = new Date();
  const orders = new FakeSheet("COMMANDES_APP", [orderHeaders, orderRow]);
  const historyHeaders = context.purchaseOrderHistoryHeaders_();
  const history = new FakeSheet("COMMANDES_HISTORIQUE", [historyHeaders]);
  const spreadsheet = {
    getSheetByName: (name) => name === "COMMANDES_HISTORIQUE" ? history : orders,
    insertSheet: () => { throw new Error("Feuille déjà créée"); }
  };
  orders.parent = spreadsheet;
  history.parent = spreadsheet;
  const range = orders.getRange(2, orderHeaders.indexOf("STATUT") + 1);

  assert.equal(context.purchaseCaptureOrderStatusEdit_({ oldValue: "submitted" }, orders, range), true);
  assert.equal(history.data.length, 2);
  assert.equal(history.data[1][historyHeaders.indexOf("NOUVEAU_STATUT")], "viewed");
  assert.equal(history.data[1][historyHeaders.indexOf("ACTION")], "status-changed");
  assert.equal(orderRow[orderHeaders.indexOf("SYNCED_D1_AT")], "");
  assert.equal(JSON.parse(orderRow[orderHeaders.indexOf("SYNC_PAYLOAD_JSON")]).order.status, "viewed");
});
