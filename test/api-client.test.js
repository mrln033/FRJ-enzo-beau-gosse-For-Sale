import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../js/api-client.js", import.meta.url), "utf8");

function loadClient(search, fetchImpl, promptImpl = () => "", localValues = new Map()) {
  const values = new Map();
  const events = [];
  const window = {
    location: { search, href: `https://mrln033.github.io/app/${search}` },
    fetch: fetchImpl,
    dispatchEvent: (event) => events.push(event),
    prompt: promptImpl,
    sessionStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key)
    },
    localStorage: {
      getItem: (key) => localValues.get(key) || null,
      setItem: (key, value) => localValues.set(key, value),
      removeItem: (key) => localValues.delete(key)
    }
  };
  const context = vm.createContext({
    window,
    console,
    URL,
    URLSearchParams,
    Headers,
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    }
  });
  vm.runInContext(source, context);
  return { api: window.FRJ_API, events, localValues, values };
}

test("GAS reste le backend de lecture par défaut", async () => {
  const urls = [];
  const { api, events } = loadClient("", async (url) => {
    urls.push(url);
    return new Response("[]", { status: 200 });
  });

  await api.fetch("?action=categories");
  assert.equal(api.backend, "gas");
  assert.equal(api.activeBackend, "gas");
  assert.equal(events.at(-1).detail.backend, "gas");
  assert.match(urls[0], /^https:\/\/script\.google\.com\//);
});

test("une lecture D1 en échec se replie sur GAS", async () => {
  const urls = [];
  const { api, events } = loadClient("?backend=d1", async (url) => {
    urls.push(url);
    if (urls.length === 1) throw new Error("D1 indisponible");
    return new Response("[]", { status: 200 });
  });

  await api.fetch("?action=categories");
  assert.match(urls[0], /workers\.dev/);
  assert.match(urls[1], /^https:\/\/script\.google\.com\//);
  assert.equal(api.activeBackend, "gas");
  assert.equal(events.at(-1).detail.backend, "gas");
});

test("une écriture D1 envoie le jeton sans repli automatique", async () => {
  const requests = [];
  const { api, values } = loadClient("?backend=d1", async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }, () => "jeton-test");

  await assert.rejects(
    api.fetch("?type=mu", { method: "POST", body: "test" }),
    /Jeton administrateur refusé/
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.get("Authorization"), "Bearer jeton-test");
  assert.equal(values.size, 0);
});

test("le rapport administrateur lit uniquement D1 avec le jeton", async () => {
  const requests = [];
  let promptCount = 0;
  const { api } = loadClient("?admin=1", async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ status: "ok", datasets: [], events: [] }), { status: 200 });
  }, () => {
    promptCount++;
    return "jeton-rapport";
  });

  const response = await api.fetchD1Admin("/admin/sync-report");
  await api.fetchD1Admin("/admin/sync-report?limit=20");
  assert.equal(response.status, 200);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /workers\.dev\/admin\/sync-report$/);
  assert.equal(requests[0].options.headers.get("Authorization"), "Bearer jeton-rapport");
  assert.equal(requests[1].options.headers.get("Authorization"), "Bearer jeton-rapport");
  assert.equal(promptCount, 1);
  assert.equal(api.activeBackend, "d1");
});

test("un jeton enregistré sur cette machine est réutilisé sans nouvelle saisie", async () => {
  const localValues = new Map([["FRJ_D1_ADMIN_TOKEN", "jeton-persistant"]]);
  let promptCount = 0;
  const { api } = loadClient("?admin=1&backend=d1", async (_url, options) => {
    assert.equal(options.headers.get("Authorization"), "Bearer jeton-persistant");
    return new Response("[]", { status: 200 });
  }, () => {
    promptCount++;
    return "autre-jeton";
  }, localValues);

  await api.fetchD1Admin("/admin/sync-report");
  assert.equal(promptCount, 0);
  api.clearAdminToken();
  assert.equal(localValues.size, 0);
});

test("un import GAS enregistre une demande de synchronisation côté D1", async () => {
  const requests = [];
  const { api } = loadClient("?admin=1", async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true, requestId: 42 }), { status: 200 });
  }, () => "jeton-sync");

  await api.requestSynchronization("inventory:enzo", "import-gas-inventory");
  assert.match(requests[0].url, /workers\.dev\/admin\/sync-request$/);
  assert.equal(requests[0].options.headers.get("Authorization"), "Bearer jeton-sync");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    dataset: "inventory:enzo",
    reason: "import-gas-inventory"
  });
});

test("un import GAS publie immédiatement son observation sans écrire le snapshot D1", async () => {
  const requests = [];
  const { api } = loadClient("?admin=1", async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, () => "jeton-observation");

  await api.publishGasObservation("mu", "Item\tTier\nTest\t1");
  assert.match(requests[0].url, /workers\.dev\/admin\/sync-observation$/);
  assert.equal(requests[0].options.headers.get("Authorization"), "Bearer jeton-observation");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.dataset, "mu");
  assert.equal(payload.raw, "Item\tTier\nTest\t1");
  assert.match(payload.eventId, /^gas-/);
});
