import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../js/api-client.js", import.meta.url), "utf8");

function loadClient(search, fetchImpl, promptImpl = () => "") {
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
  return { api: window.FRJ_API, events, values };
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
