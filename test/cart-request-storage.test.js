import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../js/cart.js", import.meta.url), "utf8");

function loadCartHelpers() {
  const instrumented = source.replace(
    "  global.FRJ_CART = Object.freeze({",
    "  global.__FRJ_CART_TEST__ = { mergeRequests, requestIdentifier, trackingUrl };\n\n  global.FRJ_CART = Object.freeze({"
  );
  const storage = new Map();
  const localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  };
  const window = {
    FRJ_FEATURES: { cart: false },
    FRJ_API: {
      activeBackend: "d1",
      shortTrackingUrl: (reference, backend) => `https://example.test/s.html#${reference}:${backend}`
    },
    localStorage,
    location: { href: "https://example.test/index.html" }
  };
  vm.runInContext(instrumented, vm.createContext({ window, URL, console }));
  return window.__FRJ_CART_TEST__;
}

test("le panier conserve une demande ouverte par sa référence, même sans jeton", () => {
  const helpers = loadCartHelpers();
  const requests = helpers.mergeRequests([{
    reference: "frj-20260910-abc123",
    accessToken: "",
    backend: "d1",
    catalogBackend: "d1",
    submittedAt: "2026-09-10T10:00:00.000Z",
    status: "viewed"
  }]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].reference, "FRJ-20260910-ABC123");
  assert.equal(requests[0].accessToken, "");
  assert.equal(helpers.requestIdentifier(requests[0]), "FRJ-20260910-ABC123");
  assert.equal(
    helpers.trackingUrl(requests[0]),
    "https://example.test/s.html#FRJ-20260910-ABC123:d1"
  );
});

test("une mise à jour par référence ne fait pas perdre un éventuel jeton historique", () => {
  const helpers = loadCartHelpers();
  const token = `${"a".repeat(36)}-${"b".repeat(36)}`;
  const requests = helpers.mergeRequests(
    [{
      reference: "FRJ-20260910-ABC123",
      accessToken: token,
      backend: "gas",
      submittedAt: "2026-09-10T09:00:00.000Z",
      status: "submitted"
    }],
    [{
      reference: "FRJ-20260910-ABC123",
      accessToken: "",
      backend: "d1",
      submittedAt: "2026-09-10T09:00:00.000Z",
      updatedAt: "2026-09-10T10:00:00.000Z",
      status: "viewed"
    }]
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].accessToken, token);
  assert.equal(requests[0].status, "viewed");
  assert.equal(requests[0].backend, "d1");
});
