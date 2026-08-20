import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const script = await readFile(
  new URL("../js/pages/maj_inventaire-enzo.js", import.meta.url),
  "utf8"
);

function loadPage(search) {
  const elements = new Map();
  const inventoryLinks = ["enzo", "arkaman", "kenza", "nocturnal"].map((avatar) => {
    const classes = new Set(["inventory-link"]);
    const link = {
      id: `btnINV-${avatar}`,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name)
      }
    };
    elements.set(link.id, link);
    return link;
  });
  for (const id of ["title", "subtitle", "csvInput", "sendButton"]) {
    const listeners = new Map();
    elements.set(id, {
      id,
      innerText: "",
      placeholder: "",
      value: "",
      disabled: false,
      addEventListener: (type, listener) => listeners.set(type, listener),
      listeners
    });
  }

  let replacedUrl = "";
  const api = {
    importToBoth: async () => ({
      ok: true,
      partial: false,
      results: [{ backend: "gas", ok: true, message: "Import terminé" }]
    }),
    fetchGas: async () => new Response(JSON.stringify({}))
  };
  const window = {
    FRJ_ADMIN: { active: true, require: () => true },
    FRJ_API: api,
    FRJ_IMPORTS: { formatOutcome: () => "Import terminé" },
    location: {
      search,
      href: `https://example.test/maj_inventaire-enzo.html${search}`
    },
    history: {
      replaceState: (_state, _title, url) => { replacedUrl = url; }
    }
  };
  const document = {
    title: "",
    getElementById: (id) => elements.get(id),
    querySelectorAll: (selector) => selector === ".inventory-link" ? inventoryLinks : []
  };
  const context = vm.createContext({
    window,
    document,
    URL,
    URLSearchParams,
    alert: () => {}
  });
  vm.runInContext(script, context);
  return { context, document, elements, inventoryLinks, get replacedUrl() { return replacedUrl; } };
}

test("la page ouverte depuis le menu ne présélectionne aucun inventaire", () => {
  const page = loadPage("");
  assert.equal(page.elements.get("sendButton").disabled, true);
  assert.match(page.elements.get("title").innerText, /Choisis l'inventaire/);
  assert.equal(page.inventoryLinks.some((link) => link.classList.contains("active")), false);
});

test("un avatar explicite sélectionne uniquement son bouton", () => {
  const page = loadPage("?avatar=kenza");
  assert.equal(page.elements.get("sendButton").disabled, false);
  assert.equal(page.elements.get("btnINV-kenza").classList.contains("active"), true);
  assert.equal(page.elements.get("btnINV-enzo").classList.contains("active"), false);
});

test("un import réussi retire l'avatar, la sélection et désactive l'envoi", async () => {
  const page = loadPage("?avatar=enzo");
  page.elements.get("csvInput").value = "csv valide";
  await page.elements.get("sendButton").listeners.get("click")();
  assert.equal(page.replacedUrl, "/maj_inventaire-enzo.html");
  assert.equal(page.elements.get("csvInput").value, "");
  assert.equal(page.elements.get("sendButton").disabled, true);
  assert.equal(page.inventoryLinks.some((link) => link.classList.contains("active")), false);
});
