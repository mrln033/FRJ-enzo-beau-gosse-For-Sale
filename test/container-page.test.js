import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../js/pages/conteneurs.js", import.meta.url), "utf8");
const html = await readFile(new URL("../conteneurs.html", import.meta.url), "utf8");
const menu = await readFile(new URL("../js/admin-menu.js", import.meta.url), "utf8");

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
    this.value = "";
    this.checked = false;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }
}

function loadPage() {
  const ids = [
    "containerAvatar", "containerSearch", "containerFilter", "reloadContainers",
    "clearContainersToken", "containersLoading", "containersError", "containersContent",
    "containersSummary", "containersSaveStatus", "saveContainers", "containersList"
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  elements.get("containerFilter").value = "all";
  elements.get("containersContent").hidden = true;
  elements.get("containersError").hidden = true;
  const requests = [];
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: () => new FakeElement()
  };
  const window = {
    FRJ_ADMIN: { require: () => true },
    FRJ_API: {
      clearAdminToken: () => {},
      fetchD1Admin: async (path, options = {}) => {
        requests.push({ path, options });
        if (options.method === "POST") return { json: async () => ({ ok: true, changed: 1 }) };
        return {
          json: async () => ({
            avatar: "enzo",
            avatars: [
              { id: "enzo", sheet: "Inventaire Enzo" },
              { id: "kenza", sheet: "Inventaire Kenza" }
            ],
            containers: [
              { containerKey: "carried", container: "CARRIED", enabled: false, updatedAt: null },
              { containerKey: "ni armors", container: "NI Armors", enabled: true, updatedAt: null }
            ]
          })
        };
      }
    },
    addEventListener: () => {},
    confirm: () => true
  };
  vm.runInContext(source, vm.createContext({ window, document, console, encodeURIComponent }));
  return { elements, requests };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("conteneurs.html sépare le HTML, les styles et le contrôleur", () => {
  assert.match(html, /css\/pages\/conteneurs\.css/);
  assert.match(html, /js\/pages\/conteneurs\.js/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.match(menu, /Conteneurs D1/);
});

test("la page charge et rend la configuration D1 d'Enzo", async () => {
  const page = loadPage();
  await settle();

  assert.equal(page.requests[0].path, "/admin/containers?avatar=enzo");
  assert.equal(page.elements.get("containersContent").hidden, false);
  assert.equal(page.elements.get("containersList").children.length, 2);
  assert.equal(page.elements.get("containersSummary").textContent, "1 activé sur 2 — 2 affichés");
  assert.equal(page.elements.get("saveContainers").disabled, true);
});

test("la page envoie uniquement le choix modifié", async () => {
  const page = loadPage();
  await settle();
  const checkbox = page.elements.get("containersList").children[0].children[0];
  checkbox.checked = true;
  checkbox.listeners.get("change")();

  assert.equal(page.elements.get("saveContainers").disabled, false);
  await page.elements.get("saveContainers").listeners.get("click")();
  const request = page.requests.find((entry) => entry.options.method === "POST");
  assert.equal(request.path, "/admin/containers");
  assert.deepEqual(JSON.parse(request.options.body), {
    avatar: "enzo",
    containers: [{ containerKey: "carried", enabled: true }]
  });
  assert.equal(page.elements.get("saveContainers").disabled, true);
});
