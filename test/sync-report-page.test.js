import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../js/pages/rapport-sync.js", import.meta.url), "utf8");
const html = await readFile(new URL("../rapport-sync.html", import.meta.url), "utf8");

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.children = [];
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.className = "";
    this.title = "";
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }
}

const sampleReport = {
  status: "ok",
  generatedAt: "2026-08-20T10:00:00Z",
  lastGasRunAt: "2026-08-20T09:55:00Z",
  datasets: [
    {
      dataset: "catalog",
      gas: { rowCount: 10, updatedAt: "2026-08-20T09:00:00Z", hash: "abcdef1234567890" },
      d1: { rowCount: 10, updatedAt: "2026-08-20T09:00:00Z", hash: "abcdef1234567890" },
      concordance: "verified",
      lastAudit: { createdAt: "2026-08-20T09:30:00Z" }
    },
    {
      dataset: "containers",
      gas: { rowCount: 89, updatedAt: "2026-08-20T09:00:00Z", hash: "containers123456" },
      d1: { rowCount: 89, updatedAt: "2026-08-20T09:00:00Z", hash: "containers123456" },
      concordance: "verified",
      lastAudit: { createdAt: "2026-08-20T09:30:00Z" }
    }
  ],
  events: [{
    createdAt: "2026-08-20T09:30:00Z",
    dataset: "catalog",
    direction: "GAS → D1",
    action: "sync-run-completed",
    details: { rows: 10 }
  }]
};

function loadPage({ report = sampleReport, loadError = null } = {}) {
  const ids = [
    "refreshReport",
    "clearReportToken",
    "auditNow",
    "auditNowStatus",
    "reportLoading",
    "reportError",
    "reportContent",
    "syncSummary",
    "datasetRows",
    "eventRows"
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  elements.get("reportContent").hidden = true;
  elements.get("reportError").hidden = true;
  const documentListeners = new Map();
  const document = {
    hidden: true,
    getElementById: (id) => elements.get(id),
    createElement: () => new FakeElement(),
    addEventListener: (type, listener) => documentListeners.set(type, listener)
  };
  const requests = [];
  let tokenCleared = false;
  const window = {
    FRJ_ADMIN: { require: () => true },
    FRJ_API: {
      clearAdminToken: () => { tokenCleared = true; },
      fetchD1Admin: async (path, options = {}) => {
        requests.push({ path, options });
        if (path.includes("sync-audit-now")) {
          return { json: async () => ({ summary: [{ action: "identique" }] }) };
        }
        if (loadError) throw loadError;
        return { json: async () => report };
      }
    },
    setTimeout: () => 1,
    clearTimeout: () => {}
  };

  vm.runInContext(source, vm.createContext({ window, document, console }));
  return {
    elements,
    requests,
    documentListeners,
    get tokenCleared() { return tokenCleared; }
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("rapport-sync.html charge uniquement son contrôleur externe", () => {
  assert.match(html, /src="\.\/js\/pages\/rapport-sync\.js/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
});

test("le rapport D1 rend le résumé, les datasets et les événements", async () => {
  const page = loadPage();
  await settle();

  assert.equal(page.requests[0].path, "/admin/sync-report?limit=100");
  assert.equal(page.elements.get("reportLoading").hidden, true);
  assert.equal(page.elements.get("reportContent").hidden, false);
  assert.equal(page.elements.get("syncSummary").children.length, 4);

  const datasetRow = page.elements.get("datasetRows").children[0];
  assert.equal(datasetRow.children[0].textContent, "Catalogue");
  assert.equal(datasetRow.children[3].textContent, "abcdef123456");
  assert.equal(datasetRow.children[7].textContent, "Identique — vérifié");
  assert.equal(page.elements.get("datasetRows").children[1].children[0].textContent, "Configuration des conteneurs");

  const eventRow = page.elements.get("eventRows").children[0];
  assert.equal(eventRow.children[3].textContent, "Synchronisation terminée");
  assert.equal(eventRow.children[4].textContent, JSON.stringify({ rows: 10 }));
});

test("l'audit immédiat utilise la route Admin puis recharge le rapport", async () => {
  const page = loadPage();
  await settle();
  await page.elements.get("auditNow").listeners.get("click")();

  const auditRequest = page.requests.find((request) => request.path.includes("sync-audit-now"));
  assert.equal(auditRequest.options.method, "POST");
  assert.match(auditRequest.options.body, /audit-force-rapport/);
  assert.equal(page.elements.get("auditNowStatus").textContent, "Audit terminé : bases identiques et vérifiées.");
  assert.equal(page.elements.get("auditNow").disabled, false);
  assert.equal(page.requests.filter((request) => request.path.includes("sync-report")).length, 2);
});

test("une erreur de chargement masque le rapport et affiche son message", async () => {
  const page = loadPage({ loadError: new Error("D1 indisponible") });
  await settle();

  assert.equal(page.elements.get("reportContent").hidden, true);
  assert.equal(page.elements.get("reportError").hidden, false);
  assert.equal(page.elements.get("reportError").textContent, "D1 indisponible");
});
