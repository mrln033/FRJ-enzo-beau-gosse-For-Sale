import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  handleAdminVisitStatisticsGet,
  handleVisitCounterGet,
  handleVisitPost
} from "../src/visits.js";

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

function makeEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../migrations/0019_visit_statistics.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../migrations/0022_visit_category_statistics.sql", import.meta.url), "utf8"));
  return { database, env: { DB: makeD1(database), VISIT_STATS_SALT: "test-salt-ne-jamais-stocker" } };
}

function visitPayload(overrides = {}) {
  return {
    eventId: crypto.randomUUID(),
    sessionId: "11111111-1111-4111-8111-111111111111",
    visitorId: "22222222-2222-4222-8222-222222222222",
    page: "catalog",
    admin: false,
    ...overrides
  };
}

async function record(env, payload) {
  const request = new Request("https://api.example/visits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const response = await handleVisitPost(request, env);
  return { response, result: await response.json() };
}

test("d.13 journalise anonymement et déduplique chaque événement", async () => {
  const { database, env } = makeEnv();
  const payload = visitPayload();
  const first = await record(env, payload);
  const duplicate = await record(env, payload);

  assert.equal(first.result.recorded, true);
  assert.equal(duplicate.result.recorded, false);
  assert.equal(duplicate.result.counter.visits, 1);
  const row = database.prepare(`SELECT * FROM visit_events`).get();
  assert.equal(row.event_id, payload.eventId);
  assert.equal(row.page_key, "catalog");
  assert.equal(row.event_type, "page_view");
  assert.equal(row.category_key, null);
  assert.equal(row.audience, "PUBLIC");
  assert.notEqual(row.session_hash, payload.sessionId);
  assert.notEqual(row.visitor_hash, payload.visitorId);
  assert.match(row.session_hash, /^[a-f0-9]{64}$/);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM visit_events`).get().count, 1);
});

test("d.13 distingue pages vues, sessions, visiteurs quotidiens et audience Admin", async () => {
  const { env } = makeEnv();
  const first = visitPayload();
  await record(env, first);
  await record(env, visitPayload({ page: "cart-help" }));
  await record(env, visitPayload({
    sessionId: "33333333-3333-4333-8333-333333333333"
  }));
  await record(env, visitPayload({
    sessionId: "44444444-4444-4444-8444-444444444444",
    page: "admin-orders",
    admin: true
  }));

  const counterResponse = await handleVisitCounterGet(env);
  const counter = await counterResponse.json();
  assert.equal(counter.visits, 2);
  assert.match(counter.startDate, /^\d{4}-\d{2}-\d{2}$/);

  const day = counter.startDate;
  const response = await handleAdminVisitStatisticsGet(
    new URL(`https://api.example/admin/visit-statistics?startDate=${day}&endDate=${day}`),
    env
  );
  const report = await response.json();
  assert.deepEqual(report.totals, { pageViews: 4, visits: 3, uniqueVisitors: 2 });
  assert.equal(report.publicCounter.visits, 2);
  const publicTotal = report.rows.find((row) => row.page === "__TOTAL__" && row.audience === "PUBLIC");
  assert.deepEqual(
    { pageViews: publicTotal.pageViews, visits: publicTotal.visits, uniqueVisitors: publicTotal.uniqueVisitors },
    { pageViews: 3, visits: 2, uniqueVisitors: 1 }
  );
  const admin = report.rows.find((row) => row.page === "admin-orders");
  assert.equal(admin.audience, "ADMIN");
  assert.equal(admin.pageViews, 1);
});

test("les catégories affichées sont classées sans gonfler les pages vues", async () => {
  const { env } = makeEnv();
  await record(env, visitPayload());
  await record(env, visitPayload({ eventType: "category_view", category: "ARMORS" }));
  await record(env, visitPayload({ eventType: "category_view", category: "ARMORS" }));
  await record(env, visitPayload({
    eventType: "category_view",
    category: "ARMORS",
    sessionId: "44444444-4444-4444-8444-444444444444",
    visitorId: "55555555-5555-4555-8555-555555555555",
    admin: true
  }));
  await record(env, visitPayload({
    eventType: "category_view",
    category: "WEAPONS",
    sessionId: "33333333-3333-4333-8333-333333333333"
  }));

  const counter = await (await handleVisitCounterGet(env)).json();
  const report = await (await handleAdminVisitStatisticsGet(
    new URL(`https://api.example/admin/visit-statistics?startDate=${counter.startDate}&endDate=${counter.startDate}&audience=PUBLIC`),
    env
  )).json();

  assert.deepEqual(report.totals, { pageViews: 1, visits: 1, uniqueVisitors: 1 });
  assert.deepEqual(report.categoryRows, [
    {
      category: "ARMORS",
      publicViews: 2, publicVisits: 1, publicUniqueVisitors: 1,
      adminViews: 1, adminVisits: 1, adminUniqueVisitors: 1
    },
    {
      category: "WEAPONS",
      publicViews: 1, publicVisits: 1, publicUniqueVisitors: 1,
      adminViews: 0, adminVisits: 0, adminUniqueVisitors: 0
    }
  ]);
});

test("d.13 valide les pages et les filtres de statistiques", async () => {
  const { env } = makeEnv();
  const discountVisit = await record(env, visitPayload({ page: "admin-discounts", admin: true }));
  assert.equal(discountVisit.result.recorded, true);
  await assert.rejects(
    () => record(env, visitPayload({ page: "page-inventée" })),
    /Page de visite invalide/
  );
  await assert.rejects(
    () => record(env, visitPayload({ eventType: "category_view", category: "catégorie-inventée" })),
    /Catégorie de visite invalide/
  );
  await assert.rejects(
    () => record(env, visitPayload({ eventType: "category_view", category: "ARMORS", page: "cart-help" })),
    /Catégorie de visite invalide/
  );
  await assert.rejects(
    () => handleAdminVisitStatisticsGet(
      new URL("https://api.example/admin/visit-statistics?startDate=2026-08-30&endDate=2026-08-29"),
      env
    ),
    /date de début/
  );
});
