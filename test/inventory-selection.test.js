import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../maj_inventaire-enzo.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .find((source) => source.includes("renderInventorySelection"));

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
    elements.set(id, { id, innerText: "", placeholder: "", value: "", disabled: false });
  }

  let replacedUrl = "";
  const window = {
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
    alert: () => {},
    FRJ_API: {}
  });
  vm.runInContext(script, context);
  return { context, document, elements, inventoryLinks, get replacedUrl() { return replacedUrl; } };
}

test("la page ouverte depuis le menu ne présélectionne aucun inventaire", () => {
  const page = loadPage("?admin=1");
  assert.equal(page.elements.get("sendButton").disabled, true);
  assert.match(page.elements.get("title").innerText, /Choisis l'inventaire/);
  assert.equal(page.inventoryLinks.some((link) => link.classList.contains("active")), false);
});

test("un avatar explicite sélectionne uniquement son bouton", () => {
  const page = loadPage("?admin=1&avatar=kenza");
  assert.equal(page.elements.get("sendButton").disabled, false);
  assert.equal(page.elements.get("btnINV-kenza").classList.contains("active"), true);
  assert.equal(page.elements.get("btnINV-enzo").classList.contains("active"), false);
});

test("la remise à zéro retire l'avatar, la sélection et désactive l'envoi", () => {
  const page = loadPage("?admin=1&avatar=enzo");
  vm.runInContext("resetInventorySelection()", page.context);
  assert.equal(page.replacedUrl, "/maj_inventaire-enzo.html?admin=1");
  assert.equal(page.elements.get("sendButton").disabled, true);
  assert.equal(page.inventoryLinks.some((link) => link.classList.contains("active")), false);
});
