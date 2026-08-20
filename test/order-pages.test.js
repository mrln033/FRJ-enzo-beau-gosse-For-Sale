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

test("la Console Admin applique les contraintes de saisie d.7", () => {
  assert.match(adminSource, /quantity\.min = "1"/);
  assert.match(adminSource, /quantity\.step = "1"/);
  assert.match(adminSource, /amount\.step = "0\.000001"/);
  assert.match(adminSource, /Number\.isInteger\(quantity\)/);
  assert.match(adminSource, /hasAtMostDecimals\(markupAmount, 6\)/);
  assert.match(adminSource, /await loadOrders\(\)/);
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

test("la Console Admin enregistre la précision autorisée puis recharge D1", async () => {
  const ids = ["ordersList", "ordersSummary", "ordersError", "ordersFilters", "refreshOrders"];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  const created = [];
  const requests = [];
  const order = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    publicReference: "FRJ-20260820-ABC123",
    buyerAvatar: "Test Player",
    status: "submitted",
    approvalRequired: false,
    proposalVersion: 0,
    createdAt: "2026-08-20T10:00:00Z",
    updatedAt: "2026-08-20T10:00:00Z",
    totalSalePed: 11.51,
    items: [{
      lineNo: 1,
      itemName: "Item A",
      storage: "ARMORS",
      aisle: "PARTS",
      quantity: 1000,
      unitTtPed: 0.01,
      markupKind: "percent",
      markupValue: 1.15123456,
      lineSalePed: 11.51
    }]
  };
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: () => {
      const element = new FakeElement();
      created.push(element);
      return element;
    }
  };
  const window = {
    FRJ_ADMIN: { require: () => true },
    FRJ_API: {
      fetchD1Admin: async (path, options) => {
        requests.push({ path, options });
        if (options?.method === "POST") return { json: async () => ({ ok: true }) };
        return { json: async () => ({ orders: [order], enabled: true, generatedAt: order.updatedAt }) };
      }
    },
    localStorage: createStorage(),
    alert: () => {}
  };
  const context = vm.createContext({ window, document, console });
  vm.runInContext(commonSource, context);
  vm.runInContext(adminSource, context);
  await settle();

  const quantity = created.find((element) => element.attributes.get("aria-label") === "Quantité Item A");
  const amount = created.find((element) => element.attributes.get("aria-label") === "Valeur du MU Item A");
  const save = created.find((element) => element.textContent === "Enregistrer les modifications");
  assert.equal(quantity.step, "1");
  assert.equal(amount.step, "0.000001");
  assert.equal(amount.value, "115.123456");

  amount.value = "115.123455";
  amount.listeners.get("input")();
  await save.listeners.get("click")();
  await settle();

  const post = requests.find((request) => request.options?.method === "POST");
  assert.equal(JSON.parse(post.options.body).items[0].markupAmount, 115.123455);
  assert.equal(requests.filter((request) => request.path === "/admin/orders").length, 2);
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
