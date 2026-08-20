import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const commonSource = await readFile(new URL("../js/common/order-ui.js", import.meta.url), "utf8");
const adminSource = await readFile(new URL("../js/pages/commandes.js", import.meta.url), "utf8");
const trackingSource = await readFile(new URL("../js/pages/suivi-commande.js", import.meta.url), "utf8");
const adminHtml = await readFile(new URL("../commandes.html", import.meta.url), "utf8");
const trackingHtml = await readFile(new URL("../suivi-commande.html", import.meta.url), "utf8");

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
    this.innerHTML = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name)
    };
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

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("les deux pages ne chargent plus que des scripts externes", () => {
  assert.match(adminHtml, /src="\.\/js\/pages\/commandes\.js/);
  assert.match(trackingHtml, /src="\.\/js\/pages\/suivi-commande\.js/);
  assert.match(adminHtml, /src="\.\/js\/common\/order-ui\.js/);
  assert.match(trackingHtml, /src="\.\/js\/common\/order-ui\.js/);
  assert.doesNotMatch(adminHtml, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(trackingHtml, /<script(?![^>]*\bsrc=)/i);
});

test("la console Admin charge et filtre une liste vide", async () => {
  const ids = ["ordersList", "ordersSummary", "ordersError", "ordersFilters", "refreshOrders"];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  const requests = [];
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: () => new FakeElement()
  };
  const window = {
    FRJ_ADMIN: { require: () => true },
    FRJ_API: {
      fetchD1Admin: async (path, options) => {
        requests.push({ path, options });
        return { json: async () => ({ orders: [], enabled: true, generatedAt: "2026-08-20T12:00:00Z" }) };
      }
    },
    localStorage: createStorage(),
    alert: () => {}
  };
  const context = vm.createContext({ window, document, console });
  vm.runInContext(commonSource, context);
  vm.runInContext(adminSource, context);
  await settle();

  assert.equal(requests[0].path, "/admin/orders");
  assert.equal(elements.get("ordersFilters").children.length, 9);
  assert.match(elements.get("ordersSummary").textContent, /0 demande\(s\) affichée\(s\) sur 0/);
  assert.equal(elements.get("ordersList").children[0].textContent, "Aucune demande transmise.");
  assert.equal(elements.get("ordersError").hidden, true);
});

test("le suivi public rend une demande et la mémorise localement", async () => {
  const token = "a".repeat(72);
  const ids = ["catalogReturnLink", "catalogLink", "pageTitle", "pageSubtitle", "trackingContent"];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  const storage = createStorage({ lang: "EN" });
  const document = {
    hidden: false,
    title: "",
    documentElement: { lang: "fr" },
    getElementById: (id) => elements.get(id),
    createElement: () => new FakeElement()
  };
  const order = {
    publicReference: "FRJ-20260820-ABC123",
    buyerAvatar: "Test Player",
    language: "EN",
    status: "submitted",
    createdAt: "2026-08-20T10:00:00Z",
    updatedAt: "2026-08-20T11:00:00Z",
    frjMember: false,
    totalSalePed: 12.5,
    items: []
  };
  const window = {
    location: {
      search: `?token=${token}&backend=d1`,
      href: `https://example.test/suivi-commande.html?token=${token}&backend=d1`
    },
    localStorage: storage,
    FRJ_API: { getOrderStatus: async () => order },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval: () => 1,
    confirm: () => true,
    alert: () => {}
  };
  const context = vm.createContext({ window, document, console, URLSearchParams });
  vm.runInContext(commonSource, context);
  vm.runInContext(trackingSource, context);
  await settle();

  assert.equal(elements.get("catalogReturnLink").href, "./?backend=d1");
  assert.equal(elements.get("trackingContent").className, "tracking-body");
  assert.equal(elements.get("trackingContent").children[0].children[0].textContent, "Request submitted");
  assert.equal(document.documentElement.lang, "en");
  const remembered = JSON.parse(storage.getItem("FRJ_PURCHASE_REQUESTS_V1"));
  assert.equal(remembered[0].accessToken, token);
  assert.equal(remembered[0].status, "submitted");
});

test("un lien de suivi incomplet affiche l'erreur sans appeler l'API", async () => {
  const ids = ["catalogReturnLink", "catalogLink", "pageTitle", "pageSubtitle", "trackingContent"];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  let apiCalled = false;
  const document = {
    hidden: false,
    title: "",
    documentElement: { lang: "fr" },
    getElementById: (id) => elements.get(id),
    createElement: () => new FakeElement()
  };
  const window = {
    location: { search: "?token=invalide", href: "https://example.test/suivi-commande.html?token=invalide" },
    localStorage: createStorage({ lang: "FR" }),
    FRJ_API: { getOrderStatus: async () => { apiCalled = true; } },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval: () => 1,
    confirm: () => true,
    alert: () => {}
  };
  const context = vm.createContext({ window, document, console, URLSearchParams });
  vm.runInContext(commonSource, context);
  vm.runInContext(trackingSource, context);
  await settle();

  assert.equal(apiCalled, false);
  assert.equal(elements.get("trackingContent").className, "tracking-message error");
  assert.equal(elements.get("trackingContent").textContent, "Lien de suivi invalide ou incomplet.");
});
