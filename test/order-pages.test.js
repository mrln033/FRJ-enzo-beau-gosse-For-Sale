import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const commonSource = await readFile(new URL("../js/common/order-ui.js", import.meta.url), "utf8");
const adminSource = await readFile(new URL("../js/pages/commandes.js", import.meta.url), "utf8");
const trackingSource = await readFile(new URL("../js/pages/suivi-commande.js", import.meta.url), "utf8");
const shortTrackingSource = await readFile(new URL("../js/pages/short-tracking.js", import.meta.url), "utf8");
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

  reset() {}
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

test("T-018 duplication : profil, remises, stock, MU absent et en-tête éditable avant création", async () => {
  const ids = ["ordersList", "ordersSummary", "ordersError", "ordersFilters", "refreshOrders",
    "newOrderToggle", "newOrderPanel", "newOrderForm", "newOrderAvatar", "newOrderProfile", "newOrderContact", "newOrderAdminQuote",
    "newOrderLines", "newOrderAddLine", "newOrderTotal", "newOrderTotalTt", "newOrderTotalMarkup",
    "newOrderFeedback", "newOrderCancel", "newOrderSave", "newOrderResult"];
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  const created = [];
  const requests = [];
  const catalog = [
    { itemName: "Armor", storage: "ARMORS", aisle: "PARTS", availableStock: 2, unitTtPed: 10,
      markupKind: "percent", markupValue: 1.2, discountRate: 0.25, discountKind: "daily_promo", discountCampaignId: "promo" },
    { itemName: "Unknown MU", storage: "ARMORS", aisle: "PARTS", availableStock: 1, unitTtPed: 5,
      markupKind: "none", markupValue: null }
  ];
  const source = { id: "123e4567-e89b-42d3-a456-426614174000", publicReference: "FRJ-20260911-ABC123",
    buyerAvatar: " Soc ", buyerContact: "old contact", frjMember: true, sourceBackend: "d1-admin",
    status: "admin_quote", items: [
      { ...catalog[0], quantity: 4, markupValue: 99 },
      { ...catalog[1], quantity: 1 },
      { itemName: "Missing", storage: "ARMORS", aisle: "PARTS", quantity: 1 }
    ] };
  const original = JSON.stringify(source);
  const makeElement = () => { const element = new FakeElement(); created.push(element); return element; };
  const document = { getElementById: id => elements.get(id), createElement: makeElement,
    createTextNode: text => ({ textContent: text }) };
  const window = {
    location: { href: "https://example.test/commandes.html" }, FRJ_ADMIN: { require: () => true },
    localStorage: createStorage(), confirm: () => true, alert: message => { throw new Error(message); },
    navigator: { clipboard: { writeText: async () => {} } },
    FRJ_API: {
      shortTrackingUrl: ref => `https://example.test/s.html#${ref}`,
      fetchD1Admin: async (path, options) => {
        requests.push({ path, options });
        if (path.endsWith("/duplicate-preview")) return { json: async () => ({ source, catalog: { items: catalog } }) };
        if (path.endsWith("/catalog")) return { json: async () => ({ items: catalog }) };
        if (options?.method === "POST") return { json: async () => ({
          order: { publicReference: "FRJ-20260911-DEF456" },
          trackingPath: "suivi-commande.html?ref=FRJ-20260911-DEF456"
        }) };
        return { json: async () => ({ orders: [source, { ...source, id: "other", buyerAvatar: "Client", status:"submitted" },
          { ...source, id: "public-order", sourceBackend: "d1", buyerAvatar: "Public",status:"submitted" }],
          enabled: true, generatedAt: "2026-09-11T10:00:00Z" }) };
      }
    }
  };
  const context = vm.createContext({ window, document, console, URL });
  vm.runInContext(commonSource, context);
  vm.runInContext(adminSource, context);
  await settle(); await settle();
  const walk = element => [element, ...(element.children || []).flatMap(walk)];
  const avatar = elements.get("newOrderAvatar"), quoteChoice = elements.get("newOrderAdminQuote");
  const profile = elements.get("newOrderProfile");
  assert.equal(avatar.required, true);
  avatar.value = "Personnalisé";
  profile.value = "public";
  quoteChoice.checked = true;
  quoteChoice.listeners.get("change")();
  assert.equal(avatar.required, false);
  assert.match(avatar.placeholder, /Public/);
  profile.value = "frj";
  profile.listeners.get("change")({target:profile});
  assert.match(avatar.placeholder, /Membre Soc/);
  assert.equal(avatar.value, "Personnalisé");
  quoteChoice.checked = false;
  quoteChoice.listeners.get("change")();
  assert.equal(avatar.required, true);
  const buttons = walk(elements.get("ordersList")).filter(e => e.textContent === "Dupliquer ce devis");
  assert.equal(buttons.length, 1);
  const origins=walk(elements.get("ordersList")).filter(e=>String(e.textContent || "").startsWith("Origine : ")).map(e=>e.textContent);
  assert.deepEqual(origins,["Origine : Admin","Origine : Admin","Origine : Client"]);
  const deleteButtons=walk(elements.get("ordersList")).filter(e=>e.textContent==="Supprimer définitivement");
  assert.equal(deleteButtons.length,1);
  window.confirm=()=>false;
  await deleteButtons[0].listeners.get("click")();
  assert.equal(requests.some(r=>r.options?.method==="DELETE"),false);
  window.confirm=()=>true;
  await buttons[0].listeners.get("click")();
  const rows = elements.get("newOrderLines").children.slice(1);
  const control = (row, label) => walk(row).find(e => e.attributes?.get("aria-label") === label);
  const amount = row => control(row, "Valeur de MU de la demande directe");
  assert.equal(control(rows[0], "Quantité de la demande directe").value, "2");
  assert.equal(amount(rows[0]).value, "107.50");
  assert.ok(walk(rows[0]).some(e => /réduite de 4 à 2/.test(e.textContent)));
  assert.equal(amount(rows[1]).value, "");
  assert.equal(rows[2].classList.contains("direct-order-line-error"), true);
  assert.equal(elements.get("newOrderSave").disabled, true);
  assert.equal(requests.some(r => r.options?.method === "POST"), false);
  elements.get("newOrderProfile").value = "public";
  elements.get("newOrderProfile").listeners.get("change")({ target: elements.get("newOrderProfile") });
  assert.equal(amount(rows[0]).value, "115.00");
  amount(rows[1]).value = "105";
  amount(rows[1]).listeners.get("input")();
  walk(rows[2]).find(e => e.textContent === "Retirer").listeners.get("click")();
  assert.equal(elements.get("newOrderSave").disabled, false);
  elements.get("newOrderAvatar").value = "Real Buyer";
  elements.get("newOrderContact").value = "Discord: buyer";
  await elements.get("newOrderForm").listeners.get("submit")({ preventDefault() {} });
  const post = requests.find(r => r.options?.method === "POST");
  const body = JSON.parse(post.options.body);
  assert.equal(body.buyerAvatar, "Real Buyer");
  assert.equal(body.buyerContact, "Discord: buyer");
  assert.equal(body.frjMember, false);
  assert.equal(body.duplicateSourceId, source.id);
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].markupAmount, 115);
  assert.equal(body.items[0].catalogSnapshot.markupValue, 1.2);
  assert.equal(JSON.stringify(source), original);
});

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
  assert.match(adminSource, /method: "DELETE"/);
  assert.match(adminSource, /removeOrderItem\(order, item, remove\)/);
  assert.match(adminSource, /MU Total \(%\)/);
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
  assert.equal(elements.get("ordersFilters").children.length, 10);
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
    pricingStatus: "estimated",
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
    createTextNode: (value) => Object.assign(new FakeElement(), { textContent: String(value) }),
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
  const pricing = created.find((element) => element.className === "order-price-status estimated");
  assert.equal(pricing.textContent, "Prix estimés");

  amount.value = "115.123455";
  amount.listeners.get("input")();
  await save.listeners.get("click")();
  await settle();

  const post = requests.find((request) => request.options?.method === "POST");
  assert.equal(JSON.parse(post.options.body).items[0].markupAmount, 115.123455);
  assert.equal(requests.filter((request) => request.path === "/admin/orders").length, 2);
});

test("ouvre et copie directement le lien court d'une demande Admin", async () => {
  const ids = ["ordersList", "ordersSummary", "ordersError", "ordersFilters", "refreshOrders"];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  const created = [];
  const requests = [];
  const copied = [];
  const popups = [];
  const order = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    publicReference: "FRJ-20260829-ABC123",
    buyerAvatar: "Test Player",
    status: "submitted",
    pricingStatus: "estimated",
    createdAt: "2026-08-29T10:00:00Z",
    updatedAt: "2026-08-29T10:00:00Z",
    totalSalePed: 10,
    items: []
  };
  const accessToken = `${"a".repeat(36)}-${"b".repeat(36)}`;
  const trackingPath = `suivi-commande.html?ref=${order.publicReference}`;
  const shortTrackingUrl = `https://example.test/s.html#${order.publicReference}`;
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: () => {
      const element = new FakeElement();
      created.push(element);
      return element;
    }
  };
  const window = {
    location: { href: "https://example.test/commandes.html?backend=d1" },
    FRJ_ADMIN: { require: () => true },
    FRJ_API: {
      fetchD1Admin: async (path, options) => {
        requests.push({ path, options });
        if (path === "/admin/orders") {
          return { json: async () => ({ orders: [order], enabled: true, generatedAt: order.updatedAt }) };
        }
        return { json: async () => ({ ok: true, publicReference: order.publicReference, trackingPath }) };
      },
      shortTrackingUrl: () => shortTrackingUrl
    },
    localStorage: createStorage(),
    navigator: { clipboard: { writeText: async (value) => copied.push(value) } },
    open: () => {
      const popup = { location: { href: "about:blank" }, opener: window, close: () => {} };
      popups.push(popup);
      return popup;
    },
    alert: () => {}
  };
  const context = vm.createContext({ window, document, console, URL });
  vm.runInContext(commonSource, context);
  vm.runInContext(adminSource, context);
  await settle();

  const button = created.find((element) => element.className === "order-tracking-button");
  await button.listeners.get("click")();
  await settle();
  const trackingRequests = requests.filter((request) => request.path.endsWith("/tracking-link"));
  const expectedUrl = shortTrackingUrl;
  assert.equal(trackingRequests.length, 0);
  assert.equal(popups[0].location.href, expectedUrl);
  assert.equal(popups[0].opener, null);
  assert.deepEqual(copied, [expectedUrl]);
  assert.equal(button.textContent, "Ouvrir à nouveau");
  const feedback = created.find((element) => element.className === "order-tracking-feedback success");
  assert.equal(feedback.hidden, false);
  assert.equal(feedback.children[1].href, expectedUrl);

  await button.listeners.get("click")();
  await settle();
  assert.equal(requests.filter((request) => request.path.endsWith("/tracking-link")).length, 0);
  assert.deepEqual(copied, [expectedUrl, expectedUrl]);
  assert.equal(popups[1].location.href, expectedUrl);
});

test("la Console Admin charge l'historique à la demande et modifie un commentaire", async () => {
  const ids = ["ordersList", "ordersSummary", "ordersError", "ordersFilters", "refreshOrders"];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  const created = [];
  const requests = [];
  const order = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    publicReference: "FRJ-20260827-ABC123",
    buyerAvatar: "Test Player",
    status: "viewed",
    pricingStatus: "confirmed",
    createdAt: "2026-08-27T10:00:00Z",
    updatedAt: "2026-08-27T10:30:00Z",
    totalSalePed: 10,
    items: []
  };
  const historyEvent = {
    id: 7,
    actor: "admin",
    newStatus: "viewed",
    comment: "Statut modifié : Transmise → Vue.",
    createdAt: "2026-08-27T10:30:00Z"
  };
  const previousHistoryEvent = {
    id: 6,
    actor: "client",
    newStatus: "submitted",
    comment: "Demande transmise par le client.",
    createdAt: "2026-08-27T10:00:00Z"
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
      shortTrackingUrl: (reference) => `https://example.test/s.html#${reference}`,
      fetchD1Admin: async (path, options) => {
        requests.push({ path, options });
        if (path === "/admin/orders") {
          return { json: async () => ({ orders: [order], enabled: true, generatedAt: order.updatedAt }) };
        }
        if (path.endsWith("/history")) {
          return { json: async () => ({ events: [previousHistoryEvent, historyEvent] }) };
        }
        return { json: async () => ({ ok: true, event: { ...historyEvent, comment: "Client prévenu" } }) };
      }
    },
    localStorage: createStorage(),
    alert: () => {}
  };
  const context = vm.createContext({ window, document, console });
  vm.runInContext(commonSource, context);
  vm.runInContext(adminSource, context);
  await settle();

  assert.equal(requests.some((request) => request.path.endsWith("/history")), false);
  const toggle = created.find((element) => element.className === "order-history-toggle");
  await toggle.listeners.get("click")();
  await settle();
  assert.equal(requests[1].path, `/admin/orders/${order.id}/history`);

  const historyList = created.find((element) => element.className === "order-history-list");
  assert.equal(historyList.reversed, true);
  assert.equal(historyList.start, 2);
  assert.match(historyList.children[0].children[0].textContent, /Nouveau statut : Vue/);
  assert.match(historyList.children[1].children[0].textContent, /Nouveau statut : Transmise/);
  const orderTable = created.find((element) => element.innerHTML.includes("<thead>"));
  assert.match(orderTable.innerHTML, /<th>Prix de vente<\/th>/);

  const textarea = created.find((element) => String(element.attributes.get("aria-label") || "")
    .startsWith("Commentaire historique du"));
  const save = created.find((element) => element.textContent === "Enregistrer le commentaire");
  const meta = created.find((element) => element.className === "order-history-meta");
  assert.match(meta.textContent, /Administrateur/);
  assert.match(meta.textContent, /Nouveau statut : Vue/);
  assert.equal(textarea.value, historyEvent.comment);

  textarea.value = "Client prévenu";
  textarea.listeners.get("input")();
  assert.equal(save.disabled, false);
  await save.listeners.get("click")();
  await settle();
  const post = requests.find((request) => request.options?.method === "POST");
  assert.equal(post.path, `/admin/orders/${order.id}/history/${historyEvent.id}/comment`);
  assert.deepEqual(JSON.parse(post.options.body), { comment: "Client prévenu" });
});

test("d.12 crée une demande directe et propose son lien de suivi", async () => {
  const ids = [
    "newOrderTotalTt", "newOrderTotalMarkup",
    "ordersList", "ordersSummary", "ordersError", "ordersFilters", "refreshOrders",
    "newOrderToggle", "newOrderPanel", "newOrderForm", "newOrderAvatar", "newOrderProfile",
    "newOrderLines", "newOrderAddLine", "newOrderTotal", "newOrderFeedback", "newOrderCancel",
    "newOrderSave", "newOrderResult"
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  elements.get("newOrderPanel").hidden = true;
  elements.get("newOrderAvatar").value = "Direct Buyer";
  elements.get("newOrderProfile").value = "frj";
  const created = [];
  const requests = [];
  const token = `${"a".repeat(36)}-${"b".repeat(36)}`;
  const catalog = [
    {
      itemName: "Zulu Item", storage: "ARMORS", aisle: "PARTS", availableStock: 2, unitTtPed: 20,
      markupKind: "ped", markupValue: 1
    },
    {
      itemName: "Item A", storage: "ARMORS", aisle: "PARTS", availableStock: 5, unitTtPed: 10,
      markupKind: "percent", markupValue: 1.2
    }
  ];
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: () => {
      const element = new FakeElement();
      created.push(element);
      return element;
    }
  };
  const window = {
    location: { href: "https://example.test/commandes.html" },
    FRJ_ADMIN: { require: () => true },
    FRJ_API: {
      shortTrackingUrl: (reference) => `https://example.test/s.html#${reference}`,
      fetchD1Admin: async (path, options) => {
        requests.push({ path, options });
        if (path === "/admin/orders/catalog") return { json: async () => ({ items: catalog }) };
        if (path === "/admin/orders" && options?.method === "POST") {
          return { json: async () => ({
            order: { id: "123e4567-e89b-42d3-a456-426614174000", publicReference: "FRJ-20260829-ABC123" },
            accessToken: token,
            trackingPath: "suivi-commande.html?ref=FRJ-20260829-ABC123"
          }) };
        }
        return { json: async () => ({ orders: [], enabled: true, generatedAt: "2026-08-29T12:00:00Z" }) };
      }
    },
    localStorage: createStorage(),
    navigator: { clipboard: { writeText: async () => {} } },
    alert: () => {}
  };
  const context = vm.createContext({ window, document, console, URL });
  vm.runInContext(commonSource, context);
  vm.runInContext(adminSource, context);
  await settle();
  await settle();

  elements.get("newOrderToggle").listeners.get("click")();
  const linesHeader = elements.get("newOrderLines").children[0];
  assert.equal(linesHeader.className, "direct-order-lines-header");
  assert.deepEqual(linesHeader.children.slice(0, 4).map((cell) => cell.textContent), [
    "Article", "Quantité", "MU", "Détails de la ligne"
  ]);
  const article = created.find((element) => element.attributes.get("aria-label") === "Article de la demande directe");
  const amount = created.find((element) => element.attributes.get("aria-label") === "Valeur de MU de la demande directe");
  const datalist = created.find((element) => element.id === article.attributes.get("list"));
  assert.equal(article.type, "search");
  assert.equal(article.value, "");
  assert.match(article.placeholder, /Choisissez un article/);
  assert.match(datalist.children[0].value, /^Item A/);
  assert.match(datalist.children[1].value, /^Zulu Item/);
  assert.equal(amount.value, "");
  article.value = datalist.children[0].value;
  article.listeners.get("input")();
  assert.equal(amount.step, "0.01");
  assert.equal(amount.value, "110.00");
  assert.match(elements.get("newOrderTotalTt").textContent, /10,00 PED/);
  assert.match(elements.get("newOrderTotalMarkup").textContent, /1,00 PED \(10,00 %\)/);
  elements.get("newOrderProfile").value = "public";
  elements.get("newOrderProfile").listeners.get("change")({ target: elements.get("newOrderProfile") });
  assert.equal(amount.value, "120.00");
  assert.match(elements.get("newOrderTotalMarkup").textContent, /2,00 PED \(20,00 %\)/);
  elements.get("newOrderProfile").value = "frj";
  elements.get("newOrderProfile").listeners.get("change")({ target: elements.get("newOrderProfile") });
  assert.equal(amount.value, "110.00");
  await elements.get("newOrderForm").listeners.get("submit")({ preventDefault() {} });
  await settle();

  const post = requests.find((request) => request.path === "/admin/orders" && request.options?.method === "POST");
  const body = JSON.parse(post.options.body);
  assert.equal(body.buyerAvatar, "Direct Buyer");
  assert.equal(body.frjMember, true);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].markupKind, "percent");
  assert.equal(body.items[0].markupAmount, 110);
  assert.equal(elements.get("newOrderResult").hidden, false);
  assert.match(elements.get("newOrderResult").children[0].textContent, /FRJ-20260829-ABC123/);
  assert.equal(
    elements.get("newOrderResult").children[1].href,
    "https://example.test/s.html#FRJ-20260829-ABC123"
  );
  elements.get("newOrderToggle").listeners.get("click")();
  assert.equal(elements.get("newOrderResult").hidden, true);
  assert.equal(elements.get("newOrderResult").children.length, 0);
  elements.get("newOrderToggle").listeners.get("click")();
  assert.equal(elements.get("newOrderResult").hidden, true);
});

test("d.12 ajoute un article à une proposition existante", async () => {
  const ids = [
    "ordersList", "ordersSummary", "ordersError", "ordersFilters", "refreshOrders",
    "newOrderToggle", "newOrderPanel", "newOrderForm", "newOrderAvatar", "newOrderProfile",
    "newOrderLines", "newOrderAddLine", "newOrderTotal", "newOrderFeedback", "newOrderCancel",
    "newOrderSave", "newOrderResult"
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  const created = [];
  const requests = [];
  const order = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    publicReference: "FRJ-20260829-ABC123",
    buyerAvatar: "Direct Buyer",
    frjMember: true,
    status: "submitted",
    pricingStatus: "estimated",
    createdAt: "2026-08-29T12:00:00Z",
    updatedAt: "2026-08-29T12:00:00Z",
    totalSalePed: 10,
    items: [{
      lineNo: 1, itemName: "Item A", storage: "ARMORS", aisle: "PARTS", quantity: 1,
      unitTtPed: 10, markupKind: "percent", markupValue: 1, lineSalePed: 10
    }]
  };
  const catalog = [
    { itemName: "Item A", storage: "ARMORS", aisle: "PARTS", availableStock: 5, unitTtPed: 10 },
    {
      itemName: "Item B", storage: "MATERIALS", aisle: "MINERALS", availableStock: 3, unitTtPed: 5,
      markupKind: "ped", markupValue: 2.5
    }
  ];
  const document = {
    getElementById: (id) => elements.get(id),
    createTextNode: (value) => Object.assign(new FakeElement(), { textContent: String(value) }),
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
        if (path === "/admin/orders/catalog") return { json: async () => ({ items: catalog }) };
        if (path.endsWith("/items") && options?.method === "POST") return { json: async () => ({ ok: true }) };
        return { json: async () => ({ orders: [order], enabled: true, generatedAt: order.updatedAt }) };
      }
    },
    localStorage: createStorage(),
    alert: () => {}
  };
  const context = vm.createContext({ window, document, console, URL });
  vm.runInContext(commonSource, context);
  vm.runInContext(adminSource, context);
  await settle();
  await settle();

  const toggle = created.filter((element) => element.className === "order-add-item-toggle").at(-1);
  assert.equal(toggle.disabled, false);
  toggle.listeners.get("click")();
  const form = created.filter((element) => element.className === "order-add-item-form").at(-1);
  assert.equal(form.hidden, false);
  toggle.listeners.get("click")();
  assert.equal(form.hidden, true);
  toggle.listeners.get("click")();
  const cancel = created.filter((element) => element.textContent === "Annuler").at(-1);
  cancel.listeners.get("click")();
  assert.equal(form.hidden, true);
  toggle.listeners.get("click")();
  const save = created.filter((element) => element.textContent === "Ajouter à la proposition").at(-1);
  const article = created.filter((element) => element.attributes.get("aria-label") === "Article de la demande directe").at(-1);
  const datalist = created.find((element) => element.id === article.attributes.get("list"));
  assert.equal(save.disabled, true);
  article.value = datalist.children[0].value;
  article.listeners.get("input")();
  assert.equal(save.disabled, false);
  await save.listeners.get("click")();
  await settle();
  const post = requests.find((request) => request.path.endsWith(`/admin/orders/${order.id}/items`) || request.path === `/admin/orders/${order.id}/items`);
  assert.equal(post.path, `/admin/orders/${order.id}/items`);
  assert.equal(post.options.method, "POST");
  const body = JSON.parse(post.options.body);
  assert.equal(body.itemName, "Item B");
  assert.equal(body.markupKind, "ped");
  assert.equal(body.markupAmount, 1.25);
});

test("le suivi public rend une demande et la mémorise une seule fois malgré plusieurs liens", async () => {
  const token = "a".repeat(72);
  const ids = ["catalogReturnLink", "catalogLink", "pageTitle", "pageSubtitle", "trackingContent"];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  const otherHiddenToken = "b".repeat(72);
  const duplicateToken = "c".repeat(72);
  const otherRequestToken = "d".repeat(72);
  const storage = createStorage({
    lang: "EN",
    FRJ_HIDDEN_PURCHASE_REQUESTS_V1: JSON.stringify([otherHiddenToken, token]),
    FRJ_PURCHASE_REQUESTS_V1: JSON.stringify([
      {
        reference: "FRJ-20260820-ABC123", accessToken: duplicateToken, backend: "d1",
        submittedAt: "2026-08-20T10:00:00Z", updatedAt: "2026-08-20T11:00:00Z", status: "submitted"
      },
      {
        reference: "FRJ-20260819-OTHER1", accessToken: otherRequestToken, backend: "d1",
        submittedAt: "2026-08-19T10:00:00Z", updatedAt: "2026-08-19T11:00:00Z", status: "viewed"
      }
    ])
  });
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
    pricingStatus: "confirmed",
    createdAt: "2026-08-20T10:00:00Z",
    updatedAt: "2026-08-20T11:00:00Z",
    frjMember: false,
    totalSalePed: 12.5,
    totalTtPed: 10,
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
  const context = vm.createContext({ window, document, console, URL, URLSearchParams });
  vm.runInContext(commonSource, context);
  vm.runInContext(trackingSource, context);
  await settle();

  assert.equal(elements.get("catalogReturnLink").href, "./?backend=d1");
  assert.equal(elements.get("trackingContent").className, "tracking-body");
  const statuses = elements.get("trackingContent").children[0].children[0];
  assert.equal(statuses.children[0].textContent, "Request submitted");
  assert.equal(statuses.children[1].textContent, "Confirmed prices");
  assert.equal(statuses.children[1].className, "tracking-price-status confirmed");
  const trackingTable = elements.get("trackingContent").children[2].children[0];
  assert.match(trackingTable.innerHTML, /<th>Sale price<\/th>/);
  const trackingTotals = elements.get("trackingContent").children[3];
  assert.equal(trackingTotals.className, "tracking-totals");
  assert.equal(trackingTotals.children[0].children[0].textContent, "Total TT");
  assert.equal(trackingTotals.children[0].children[1].textContent, "10.00 PED");
  assert.equal(trackingTotals.children[1].children[0].textContent, "Total MU (%)");
  assert.equal(trackingTotals.children[1].children[1].textContent, "2.50 PED (25.00 %)");
  assert.equal(trackingTotals.children[2].children[0].textContent, "Total sale price");
  const note = elements.get("trackingContent").children.at(-1);
  assert.equal(note.textContent, "The prices in this request are confirmed. Stock is not reserved by this request.");
  assert.equal(document.documentElement.lang, "en");
  const remembered = JSON.parse(storage.getItem("FRJ_PURCHASE_REQUESTS_V1"));
  assert.equal(remembered.length, 2);
  assert.equal(remembered[0].accessToken, token);
  assert.equal(remembered[0].status, "submitted");
  assert.equal(remembered.filter((request) => request.reference === order.publicReference).length, 1);
  assert.equal(JSON.parse(storage.getItem("FRJ_LAST_PURCHASE_REQUEST")).accessToken, token);
  assert.deepEqual(JSON.parse(storage.getItem("FRJ_HIDDEN_PURCHASE_REQUESTS_V1")), [otherHiddenToken]);
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
    history: { replaceState: () => {} },
    localStorage: createStorage({ lang: "FR" }),
    FRJ_API: { getOrderStatus: async () => { apiCalled = true; } },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval: () => 1,
    confirm: () => true,
    alert: () => {}
  };
  const context = vm.createContext({ window, document, console, URL, URLSearchParams });
  vm.runInContext(commonSource, context);
  vm.runInContext(trackingSource, context);
  await settle();

  assert.equal(apiCalled, false);
  assert.equal(elements.get("catalogReturnLink").href, "./");
  assert.equal(elements.get("trackingContent").className, "tracking-message error");
  assert.equal(elements.get("trackingContent").textContent, "Lien de suivi invalide ou incomplet.");
});

test("la page courte du domaine applicatif redirige la référence vers le suivi", () => {
  let redirectedTo = "";
  const status = new FakeElement("shortTrackingStatus");
  const window = {
    location: {
      href: "https://example.test/s.html#FRJ-20260910-ABC123",
      search: "",
      hash: "#FRJ-20260910-ABC123",
      replace: (url) => { redirectedTo = url; }
    },
    document: { getElementById: () => status }
  };
  vm.runInContext(shortTrackingSource, vm.createContext({ window, URL, URLSearchParams }));
  assert.equal(
    redirectedTo,
"https://example.test/suivi-commande.html?ref=FRJ-20260910-ABC123"
  );
});

test("T-024 : les anciens liens courts explicites restent compatibles", () => {
  for (const backend of ["d1", "gas", "inconnu"]) {
    let destination;
    const window = {
      location: {
        href: `https://example.test/s.html?backend=${backend}#FRJ-20260910-ABC123`,
        search: `?backend=${backend}`, hash: "#FRJ-20260910-ABC123",
        replace: url => { destination = new URL(url); }
      },
      document: { getElementById: () => ({}) }
    };
    vm.runInContext(shortTrackingSource, vm.createContext({ window, URL, URLSearchParams }));
    assert.equal(destination.searchParams.get("backend"), backend === "inconnu" ? null : backend);
    assert.equal(destination.searchParams.get("ref"), "FRJ-20260910-ABC123");
  }
});
