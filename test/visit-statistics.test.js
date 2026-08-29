import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const trackingSource = await readFile(new URL("../js/visit-tracking.js", import.meta.url), "utf8");
const adminSource = await readFile(new URL("../js/pages/statistiques-visites.js", import.meta.url), "utf8");
const adminHtml = await readFile(new URL("../statistiques-visites.html", import.meta.url), "utf8");
const menuSource = await readFile(new URL("../js/admin-menu.js", import.meta.url), "utf8");
const publicHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
const trackedPages = await Promise.all([
  "index.html", "aide-panier.html", "suivi-commande.html", "commandes.html",
  "conteneurs.html", "rapport-sync.html", "maj_inventaire-enzo.html", "maj_mu.html",
  "statistiques-visites.html"
].map(async (name) => ({ name, content: await readFile(new URL(`../${name}`, import.meta.url), "utf8") })));

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.children = [];
    this.listeners = new Map();
    this.hidden = false;
    this.textContent = "";
    this.className = "";
    this.value = "";
    this.title = "";
    this.dataset = {};
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [...children];
  }
}

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("d.13 place un compteur discret sous le catalogue et suit toutes les pages", () => {
  assert.match(publicHtml, /<footer class="site-visit-footer">[\s\S]*id="publicVisitCounter"/);
  assert.doesNotMatch(publicHtml, /site-visit-footer[^}]*position:\s*fixed/);
  trackedPages.forEach(({ name, content }) => {
    assert.match(content, /data-visit-module="[^"]+"/, `${name} doit déclarer son module`);
    assert.match(content, /js\/visit-tracking\.js\?v=20260829-1/, `${name} doit charger le suivi commun`);
  });
});

test("d.13 conserve une session 30 minutes et rend le compteur bilingue", async () => {
  const counter = new FakeElement("publicVisitCounter");
  const localStorage = storage();
  const sessionStorage = storage();
  const payloads = [];
  let sequence = 0;
  const document = {
    readyState: "complete",
    body: { dataset: { visitModule: "catalog" } },
    getElementById: (id) => id === "publicVisitCounter" ? counter : null
  };
  const window = {
    document,
    localStorage,
    sessionStorage,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` },
    FRJ_ADMIN: { active: false },
    FRJ_API: {
      recordVisit: async (payload) => {
        payloads.push(payload);
        return { counter: { visits: 1, startDate: "2026-08-29" } };
      }
    }
  };
  vm.runInContext(trackingSource, vm.createContext({ window, document, console, Date, Uint8Array }));
  await settle();

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].page, "catalog");
  assert.equal(payloads[0].admin, false);
  assert.match(payloads[0].visitorId, /^[a-f0-9-]{36}$/);
  assert.match(payloads[0].sessionId, /^[a-f0-9-]{36}$/);
  assert.equal(counter.textContent, "1 visit");
  assert.match(localStorage.getItem("FRJ_VISIT_SESSION_V1"), /lastActivity/);

  localStorage.setItem("lang", "FR");
  window.FRJ_VISITS.refreshCounterLabel();
  assert.equal(counter.textContent, "1 visite");
  assert.match(counter.title, /29\/08\/2026/);
});

test("d.13 réserve le tableau détaillé au menu Admin et rend ses indicateurs", async () => {
  assert.match(adminHtml, /js\/admin-session\.js/);
  assert.match(adminHtml, /css\/pages\/statistiques-visites\.css/);
  assert.doesNotMatch(adminHtml, /<script(?![^>]*\bsrc=)/i);
  assert.match(menuSource, /Statistiques des visites/);

  const ids = [
    "visitStatisticsFilters", "visitStartDate", "visitEndDate", "visitAudience", "visitPage",
    "clearVisitStatsToken", "visitStatisticsLoading", "visitStatisticsError",
    "visitStatisticsContent", "visitPublicTotal", "visitPeriodVisits", "visitPageViews",
    "visitUniqueVisitors", "visitStatisticsRows"
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  elements.get("visitAudience").value = "ALL";
  elements.get("visitPage").value = "ALL";
  const requests = [];
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: () => new FakeElement()
  };
  const report = {
    publicCounter: { visits: 12 },
    totals: { visits: 4, pageViews: 7, uniqueVisitors: 3 },
    rows: [
      { date: "2026-08-29", page: "__TOTAL__", audience: "PUBLIC", pageViews: 7, visits: 4, uniqueVisitors: 3 },
      { date: "2026-08-29", page: "catalog", audience: "PUBLIC", pageViews: 7, visits: 4, uniqueVisitors: 3 }
    ]
  };
  const window = {
    FRJ_ADMIN: { require: () => true },
    FRJ_API: {
      fetchD1Admin: async (path, options) => {
        requests.push({ path, options });
        return { json: async () => report };
      },
      clearAdminToken: () => {}
    },
    location: { reload: () => {} }
  };
  vm.runInContext(adminSource, vm.createContext({ window, document, console, Date, URLSearchParams }));
  await settle();

  assert.match(requests[0].path, /^\/admin\/visit-statistics\?/);
  assert.match(requests[0].path, /audience=ALL/);
  assert.equal(elements.get("visitPublicTotal").textContent, "12");
  assert.equal(elements.get("visitPeriodVisits").textContent, "4");
  assert.equal(elements.get("visitPageViews").textContent, "7");
  assert.equal(elements.get("visitUniqueVisitors").textContent, "3");
  assert.equal(elements.get("visitStatisticsRows").children.length, 2);
  assert.equal(elements.get("visitStatisticsRows").children[0].className, "visit-statistics-total-row");
  assert.equal(elements.get("visitStatisticsContent").hidden, false);
});
