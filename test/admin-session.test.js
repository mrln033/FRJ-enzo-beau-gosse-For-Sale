import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../js/admin-session.js", import.meta.url), "utf8");

function loadSession({ search = "", stored = false } = {}) {
  const values = new Map(stored ? [["FRJ_ADMIN_MODE_V1", "1"]] : []);
  let replacedUrl = "";
  let redirectedUrl = "";
  const window = {
    location: {
      pathname: "/FRJ/index.html",
      search,
      hash: "#catalogue",
      replace: (url) => { redirectedUrl = url; }
    },
    history: {
      state: null,
      replaceState: (_state, _title, url) => { replacedUrl = url; }
    },
    sessionStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    }
  };
  vm.runInContext(source, vm.createContext({ window, URLSearchParams }));
  return { window, values, get replacedUrl() { return replacedUrl; }, get redirectedUrl() { return redirectedUrl; } };
}

test("admin=1 active la session et disparaît de l'URL", () => {
  const page = loadSession({ search: "?admin=1&backend=d1" });
  assert.equal(page.window.FRJ_ADMIN.active, true);
  assert.equal(page.values.get("FRJ_ADMIN_MODE_V1"), "1");
  assert.equal(page.replacedUrl, "/FRJ/index.html?backend=d1#catalogue");
});

test("la session admin reste active pendant la navigation de l'onglet", () => {
  const page = loadSession({ stored: true });
  assert.equal(page.window.FRJ_ADMIN.active, true);
  assert.equal(page.replacedUrl, "");
});

test("une page admin sans session est renvoyée vers le catalogue", () => {
  const page = loadSession();
  assert.equal(page.window.FRJ_ADMIN.require(), false);
  assert.equal(page.redirectedUrl, "./");
});
