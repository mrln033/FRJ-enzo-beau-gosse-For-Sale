import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  handleAdminGet,
  handleAdminPost,
  handlePublicOrderAcceptance,
  handlePublicOrderCancellation,
  handleSyncGet,
  handleSyncPost
} from "../src/application.js";
import {
  automaticOrderHistoryComment,
  isVisibleOrderHistoryAction,
  normalizeOrderHistoryComment,
  orderHistoryActor
} from "../src/order-history.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

class D1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new D1Statement(this.database, this.sql, values);
  }

  first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  execute() {
    return /^\s*(SELECT|WITH)\b/i.test(this.sql) ? this.all() : this.run();
  }
}

function makeD1(database) {
  return {
    prepare(sql) {
      return new D1Statement(database, sql);
    },
    batch(statements) {
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function applyMigration(database, name) {
  database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
}

function insertOrder(database) {
  database.prepare(`
    INSERT INTO purchase_orders (
      id, public_reference, access_token_hash, buyer_avatar,
      total_tt_ped, total_sale_ped
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(ORDER_ID, "FRJ-20260827-ABC123", "a".repeat(64), "Enzo", 10, 11);
}

function insertOrderItem(database, orderId = ORDER_ID, priceStatus = "estimated") {
  database.prepare(`
    INSERT INTO purchase_order_items (
      order_id, line_no, item_name, storage, aisle, quantity, stock_at_submission,
      unit_tt_ped, markup_kind, unit_sale_ped, line_tt_ped, line_sale_ped, price_status
    ) VALUES (?, 1, 'Item A', 'ARMORS', 'PARTS', 1, 1, 10, 'percent', 11, 10, 11, ?)
  `).run(orderId, priceStatus);
}

test("d.11 reprend les prix des demandes ayant déjà atteint la préparation", () => {
  const database = new DatabaseSync(":memory:");
  applyMigration(database, "0007_purchase_requests.sql");
  applyMigration(database, "0016_purchase_order_history.sql");
  insertOrder(database);
  insertOrderItem(database);
  database.prepare(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?`).run(ORDER_ID);
  database.prepare(`
    INSERT INTO purchase_order_events (order_id, event_key, action, actor, details)
    VALUES (?, 'event-preparing', 'status-changed', 'admin', '{"from":"submitted","to":"preparing"}')
  `).run(ORDER_ID);

  const directCancelledId = "22222222-2222-4222-8222-222222222222";
  database.prepare(`
    INSERT INTO purchase_orders (
      id, public_reference, access_token_hash, status, buyer_avatar,
      total_tt_ped, total_sale_ped
    ) VALUES (?, 'FRJ-20260828-DEF456', ?, 'cancelled', 'Enzo', 10, 11)
  `).run(directCancelledId, "b".repeat(64));
  insertOrderItem(database, directCancelledId, "to-confirm");
  database.prepare(`
    INSERT INTO purchase_order_events (order_id, event_key, action, actor, details)
    VALUES (?, 'event-legacy-invalid', 'status-changed', 'admin', 'ancienne donnée non JSON')
  `).run(directCancelledId);

  applyMigration(database, "0017_confirm_purchase_order_prices.sql");
  assert.equal(database.prepare(`SELECT pricing_status FROM purchase_orders WHERE id = ?`).get(ORDER_ID)
    .pricing_status, "confirmed");
  assert.equal(database.prepare(`SELECT price_status FROM purchase_order_items WHERE order_id = ?`).get(ORDER_ID)
    .price_status, "confirmed");
  assert.equal(database.prepare(`SELECT pricing_status FROM purchase_orders WHERE id = ?`).get(directCancelledId)
    .pricing_status, "estimated");
  assert.equal(database.prepare(`SELECT price_status FROM purchase_order_items WHERE order_id = ?`).get(directCancelledId)
    .price_status, "to-confirm");
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM purchase_order_events
    WHERE order_id = ? AND action = 'pricing-confirmed-backfill'
  `).get(ORDER_ID).count, 1);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM purchase_order_events
    WHERE order_id = ? AND action = 'pricing-confirmed-backfill'
  `).get(directCancelledId).count, 0);
});

test("d.11 confirme atomiquement les prix lors d'un changement de statut Admin", async () => {
  const database = new DatabaseSync(":memory:");
  applyMigration(database, "0007_purchase_requests.sql");
  applyMigration(database, "0008_order_discord_notifications.sql");
  applyMigration(database, "0009_order_proposals.sql");
  applyMigration(database, "0016_purchase_order_history.sql");
  insertOrder(database);
  insertOrderItem(database, ORDER_ID, "to-confirm");
  const env = { DB: makeD1(database), CART_ENABLED: "true" };
  const statusUrl = new URL(`https://api.example/admin/orders/${ORDER_ID}/status`);

  await handleAdminPost(
    new Request(statusUrl, { method: "POST", body: JSON.stringify({ status: "viewed" }) }),
    statusUrl,
    env
  );
  assert.equal(database.prepare(`SELECT pricing_status FROM purchase_orders WHERE id = ?`).get(ORDER_ID)
    .pricing_status, "estimated");
  assert.equal(database.prepare(`SELECT price_status FROM purchase_order_items WHERE order_id = ?`).get(ORDER_ID)
    .price_status, "to-confirm");

  await handleAdminPost(
    new Request(statusUrl, { method: "POST", body: JSON.stringify({ status: "preparing" }) }),
    statusUrl,
    env
  );
  assert.equal(database.prepare(`SELECT pricing_status FROM purchase_orders WHERE id = ?`).get(ORDER_ID)
    .pricing_status, "confirmed");
  assert.equal(database.prepare(`SELECT price_status FROM purchase_order_items WHERE order_id = ?`).get(ORDER_ID)
    .price_status, "confirmed");
  const eventDetails = JSON.parse(database.prepare(`
    SELECT details FROM purchase_order_events WHERE action = 'status-changed' ORDER BY id DESC LIMIT 1
  `).get().details);
  assert.equal(eventDetails.pricingConfirmed, true);
});

test("la migration enrichit les événements existants sans les perdre", () => {
  const database = new DatabaseSync(":memory:");
  applyMigration(database, "0007_purchase_requests.sql");
  insertOrder(database);
  database.prepare(`
    INSERT INTO purchase_order_events (order_id, action, details)
    VALUES (?, 'status-changed', '{"from":"submitted","to":"viewed"}')
  `).run(ORDER_ID);

  applyMigration(database, "0016_purchase_order_history.sql");
  const row = database.prepare(`SELECT * FROM purchase_order_events`).get();
  assert.equal(row.event_key, `d1-${row.id}`);
  assert.equal(row.actor, "admin");
  assert.equal(row.comment, null);
  assert.throws(() => database.prepare(`
    INSERT INTO purchase_order_events (order_id, event_key, action, actor)
    VALUES (?, ?, 'submitted', 'client')
  `).run(ORDER_ID, row.event_key), /UNIQUE/);
});

test("les commentaires automatiques et leur validation suivent le contrat", () => {
  assert.equal(orderHistoryActor("proposal-accepted"), "client");
  assert.equal(orderHistoryActor("status-changed"), "admin");
  assert.equal(isVisibleOrderHistoryAction("discord-updated"), false);
  assert.equal(isVisibleOrderHistoryAction("pricing-confirmed-backfill"), false);
  assert.equal(
    automaticOrderHistoryComment("status-changed", { from: "submitted", to: "preparing" }),
    "Statut modifié : Transmise → À préparer."
  );
  assert.equal(normalizeOrderHistoryComment("  À appeler\n demain  "), "À appeler demain");
  assert.equal(normalizeOrderHistoryComment("   "), null);
  assert.throws(() => normalizeOrderHistoryComment("x".repeat(501)), /500 caractères/);
});

test("l'API admin lit l'historique métier et modifie seulement son commentaire", async () => {
  const database = new DatabaseSync(":memory:");
  applyMigration(database, "0007_purchase_requests.sql");
  applyMigration(database, "0008_order_discord_notifications.sql");
  applyMigration(database, "0009_order_proposals.sql");
  applyMigration(database, "0016_purchase_order_history.sql");
  insertOrder(database);
  database.prepare(`
    INSERT INTO purchase_order_events
      (order_id, event_key, action, actor, comment, details)
    VALUES
      (?, 'evt-visible', 'status-changed', 'admin', NULL, '{"from":"submitted","to":"viewed"}'),
      (?, 'evt-technique', 'discord-created', 'system', NULL, '{}')
  `).run(ORDER_ID, ORDER_ID);
  const env = { DB: makeD1(database) };

  const getResponse = await handleAdminGet(
    new URL(`https://api.example/admin/orders/${ORDER_ID}/history`),
    env
  );
  assert.equal(getResponse.status, 200);
  const history = await getResponse.json();
  assert.equal(history.events.length, 1);
  assert.equal(history.events[0].newStatus, "viewed");
  assert.equal(history.events[0].comment, "Statut modifié : Transmise → Consultée.");

  const postResponse = await handleAdminPost(
    new Request(`https://api.example/admin/orders/${ORDER_ID}/history/1/comment`, {
      method: "POST",
      body: JSON.stringify({ comment: "Client prévenu" })
    }),
    new URL(`https://api.example/admin/orders/${ORDER_ID}/history/1/comment`),
    env
  );
  assert.equal(postResponse.status, 200);
  const updated = await postResponse.json();
  assert.equal(updated.event.comment, "Client prévenu");
  assert.equal(database.prepare(`SELECT action FROM purchase_order_events ORDER BY id DESC LIMIT 1`).get().action,
    "history-comment-updated");
});

test("l'acceptation et l'annulation client écrivent leur événement dans le même lot", async () => {
  const database = new DatabaseSync(":memory:");
  applyMigration(database, "0007_purchase_requests.sql");
  applyMigration(database, "0008_order_discord_notifications.sql");
  applyMigration(database, "0009_order_proposals.sql");
  applyMigration(database, "0016_purchase_order_history.sql");
  insertOrder(database);
  const token = "b".repeat(72);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  database.prepare(`
    UPDATE purchase_orders
    SET access_token_hash = ?, approval_required = 1, proposal_version = 2
    WHERE id = ?
  `).run(tokenHash, ORDER_ID);
  const env = { DB: makeD1(database), CART_ENABLED: "true" };

  const acceptUrl = new URL(`https://api.example/orders/status/${token}/accept`);
  const acceptResponse = await handlePublicOrderAcceptance(
    new Request(acceptUrl, { method: "POST", body: JSON.stringify({ proposalVersion: 2 }) }),
    acceptUrl,
    env
  );
  assert.equal(acceptResponse.status, 200);
  assert.equal(database.prepare(`SELECT approval_required FROM purchase_orders WHERE id = ?`).get(ORDER_ID)
    .approval_required, 0);
  assert.equal(database.prepare(`SELECT action FROM purchase_order_events ORDER BY id DESC LIMIT 1`).get().action,
    "proposal-accepted");

  const cancelUrl = new URL(`https://api.example/orders/status/${token}/cancel`);
  const cancelResponse = await handlePublicOrderCancellation(cancelUrl, env);
  assert.equal(cancelResponse.status, 200);
  assert.equal(database.prepare(`SELECT status FROM purchase_orders WHERE id = ?`).get(ORDER_ID).status, "cancelled");
  assert.equal(database.prepare(`SELECT action FROM purchase_order_events ORDER BY id DESC LIMIT 1`).get().action,
    "client-cancelled");
});

test("l'historique GAS met à jour D1 puis revient par le curseur sans doublon", async () => {
  const database = new DatabaseSync(":memory:");
  applyMigration(database, "0007_purchase_requests.sql");
  applyMigration(database, "0008_order_discord_notifications.sql");
  applyMigration(database, "0009_order_proposals.sql");
  applyMigration(database, "0016_purchase_order_history.sql");
  insertOrder(database);
  insertOrderItem(database);
  database.prepare(`UPDATE purchase_orders SET updated_at = ? WHERE id = ?`)
    .run("2026-08-27 10:00:00", ORDER_ID);
  const env = { DB: makeD1(database), CART_ENABLED: "true" };
  const event = {
    eventKey: "gas-22222222-2222-4222-8222-222222222222",
    orderId: ORDER_ID,
    action: "status-changed",
    actor: "admin",
    newStatus: "preparing",
    comment: "Préparation commencée.",
    details: { from: "submitted", to: "preparing" },
    createdAt: "2026-08-27T12:00:00.000Z",
    commentUpdatedAt: null
  };
  const syncUrl = new URL("https://api.example/sync/order-history");
  const firstResponse = await handleSyncPost(
    new Request(syncUrl, { method: "POST", body: JSON.stringify({ events: [event] }) }),
    syncUrl,
    env
  );
  const firstResult = await firstResponse.json();
  assert.equal(firstResult.ok, true);
  assert.equal(database.prepare(`SELECT status FROM purchase_orders WHERE id = ?`).get(ORDER_ID).status, "preparing");
  assert.equal(database.prepare(`SELECT pricing_status FROM purchase_orders WHERE id = ?`).get(ORDER_ID)
    .pricing_status, "confirmed");
  assert.equal(database.prepare(`SELECT price_status FROM purchase_order_items WHERE order_id = ?`).get(ORDER_ID)
    .price_status, "confirmed");
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM purchase_order_events WHERE event_key = ?`)
    .get(event.eventKey).count, 1);

  const mirrorResponse = await handleSyncGet(new URL("https://api.example/sync/orders?afterEventId=0"), env);
  const mirror = await mirrorResponse.json();
  assert.equal(mirror.orders[0].historyEvents[0].eventKey, event.eventKey);
  assert.equal(mirror.orders[0].historyEvents[0].newStatus, "preparing");
  const firstCursor = mirror.cursor;

  const edited = {
    ...event,
    comment: "Client prévenu, préparation commencée.",
    commentUpdatedAt: "2026-08-27T12:05:00.000Z"
  };
  const editedResponse = await handleSyncPost(
    new Request(syncUrl, { method: "POST", body: JSON.stringify({ events: [edited] }) }),
    syncUrl,
    env
  );
  assert.equal((await editedResponse.json()).results[0].changed, true);
  assert.equal(database.prepare(`SELECT comment FROM purchase_order_events WHERE event_key = ?`)
    .get(event.eventKey).comment, edited.comment);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM purchase_order_events WHERE event_key = ?`)
    .get(event.eventKey).count, 1);

  const editedMirrorResponse = await handleSyncGet(
    new URL(`https://api.example/sync/orders?afterEventId=${firstCursor}`),
    env
  );
  const editedMirror = await editedMirrorResponse.json();
  assert.equal(editedMirror.orders[0].historyEvents[0].eventKey, event.eventKey);
  assert.equal(editedMirror.orders[0].historyEvents[0].comment, edited.comment);

  const olderCommentResponse = await handleSyncPost(
    new Request(syncUrl, {
      method: "POST",
      body: JSON.stringify({ events: [{ ...edited, comment: "Ancienne version", commentUpdatedAt: "2026-08-27T12:04:00.000Z" }] })
    }),
    syncUrl,
    env
  );
  assert.equal((await olderCommentResponse.json()).results[0].changed, false);
  assert.equal(database.prepare(`SELECT comment FROM purchase_order_events WHERE event_key = ?`)
    .get(event.eventKey).comment, edited.comment);

  const staleStatusEvent = {
    ...event,
    eventKey: "gas-33333333-3333-4333-8333-333333333333",
    newStatus: "cancelled",
    comment: "Ancienne annulation retardée.",
    details: { from: "submitted", to: "cancelled" },
    createdAt: "2026-08-27T11:00:00.000Z"
  };
  await handleSyncPost(
    new Request(syncUrl, { method: "POST", body: JSON.stringify({ events: [staleStatusEvent] }) }),
    syncUrl,
    env
  );
  assert.equal(database.prepare(`SELECT status FROM purchase_orders WHERE id = ?`).get(ORDER_ID).status, "preparing");
});
