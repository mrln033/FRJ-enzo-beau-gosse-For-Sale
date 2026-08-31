import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const source = await readFile(new URL("../js/pages/index.js", import.meta.url), "utf8");
const cartSource = await readFile(new URL("../js/cart.js", import.meta.url), "utf8");
const languagesSource = await readFile(new URL("../js/langues.js", import.meta.url), "utf8");

test("index.html charge le contrôleur avant le panier et sans gestionnaire inline", () => {
  const controllerPosition = html.indexOf("./js/pages/index.js");
  const cartPosition = html.indexOf("./js/cart.js");
  assert.ok(controllerPosition > 0);
  assert.ok(controllerPosition < cartPosition);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /\son(?:click|change|input)=/i);
  assert.doesNotMatch(source, /\son(?:click|change|input)=/i);
  assert.match(source, /FRJ_VISITS\?\.recordCategoryView\?\.\(category\)/);
  assert.match(source, /FRJ_VISITS\?\.resetCategoryView\?\.\(\)/);
});

function loadCatalogController(search = "") {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const logo = { style: {} };
  const document = {
    addEventListener: (type, listener) => documentListeners.set(type, listener),
    getElementById: (id) => id === "logoLink" ? logo : null,
    querySelector: () => null
  };
  const window = {
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    location: { search, href: `https://example.test/${search}` },
    history: { replaceState: () => {} }
  };
  window.self = window;
  window.top = window;
  const context = vm.createContext({
    window,
    document,
    console,
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: {},
    setTimeout: () => 1,
    CustomEvent: class CustomEvent {},
    URL,
    URLSearchParams
  });
  vm.runInContext(source, context);
  return { context, documentListeners };
}

test("le contrôleur expose les règles de calcul historiques après extraction", () => {
  const { context } = loadCatalogController();
  const percent = vm.runInContext('parseMU("125 %")', context);
  const ped = vm.runInContext('parseMU("2,50 PED")', context);

  assert.equal(percent.type, "percent");
  assert.equal(percent.value, 1.25);
  assert.equal(ped.type, "ped");
  assert.equal(ped.value, 2.5);
  assert.equal(vm.runInContext('formatNumber("12.5")', context), "12.50");
  assert.equal(vm.runInContext('formatRayon("NEW OXFORD")', context), "New Oxford");
});

test("un lien public peut sélectionner directement une catégorie", () => {
  const { context } = loadCatalogController("?backend=d1&category=weapons");
  assert.equal(vm.runInContext("getCategoryFromUrl()", context), "WEAPONS");

  context.window.location.search = "?backend=d1&category=inconnue";
  assert.equal(vm.runInContext("getCategoryFromUrl()", context), "");
});

test("le démarrage du catalogue reste attaché à DOMContentLoaded", () => {
  const { documentListeners } = loadCatalogController();
  assert.equal(typeof documentListeners.get("DOMContentLoaded"), "function");
  assert.equal(typeof documentListeners.get("click"), "function");
});

test("le calculateur et le panier utilisent uniquement des quantités entières", () => {
  assert.match(source, /min="1"[^>]+step="1"/);
  assert.match(source, /Math\.floor\(Number\(item\.QUANTITE\)/);
  assert.match(cartSource, /min="1"[^>]+step="1"/);
  assert.match(cartSource, /Math\.floor\(quantity\)/);
  assert.match(cartSource, /maximumFractionDigits: 0/);
});

test("le catalogue démarre avec les traductions et les catégories disponibles", async () => {
  class Element {
    constructor() {
      this.children = [];
      this.listeners = new Map();
      this.dataset = {};
      this.style = {};
      this.value = "";
      this.innerHTML = "";
      this.innerText = "";
      const classes = new Set();
      this.classList = {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name)
      };
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
  }

  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const documentListeners = new Map();
  const filter = new Element();
  const document = {
    body: new Element(),
    addEventListener: (type, listener) => documentListeners.set(type, listener),
    getElementById: getElement,
    createElement: () => new Element(),
    createTextNode: (text) => ({ textContent: text }),
    querySelector: (selector) => selector === ".filter" ? filter : null
  };
  const storage = new Map([["lang", "EN"]]);
  const localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value))
  };
  const apiCalls = [];
  const FRJ_API = {
    activeBackend: "gas",
    fetch: async (query) => {
      apiCalls.push(query);
      if (query.includes("categories")) return { json: async () => ["ARMORS"] };
      return { json: async () => ({ inventoryDate: "20/08/2026" }) };
    }
  };
  const windowListeners = new Map();
  const window = {
    FRJ_API,
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    dispatchEvent: () => {},
    isSecureContext: true,
    location: { search: "", href: "https://example.test/" },
    history: { replaceState: () => {} }
  };
  window.self = window;
  window.top = window;
  const context = vm.createContext({
    window,
    document,
    localStorage,
    FRJ_API,
    navigator: { clipboard: { writeText: async () => {} } },
    console,
    setTimeout: () => 1,
    CustomEvent: class CustomEvent {},
    URL,
    URLSearchParams
  });
  vm.runInContext(languagesSource, context);
  vm.runInContext(source, context);
  documentListeners.get("DOMContentLoaded")();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(apiCalls.sort(), ["?action=categories", "?action=inventoryDate"]);
  assert.equal(getElement("rayonImages").children.length, 1);
  assert.equal(getElement("rayonFilter").listeners.has("change"), true);
  assert.equal(getElement("btnFR").listeners.has("click"), true);
  assert.equal(getElement("loadingState").style.display, "none");
});
