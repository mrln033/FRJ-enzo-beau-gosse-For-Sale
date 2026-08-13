const [baseUrl, token, mode = "read"] = process.argv.slice(2);

if (!baseUrl || !token) {
  console.error("Usage: node tools/sync-smoke.mjs <base-url> <token> [write]");
  process.exit(2);
}

const headers = { Authorization: `Bearer ${token}` };

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { status: response.status, body };
}

const unauthorized = await fetch(`${baseUrl}/sync/state`);
if (unauthorized.status !== 401) throw new Error(`Accès privé inattendu : ${unauthorized.status}`);

const state = await request("/sync/state");
if (state.status !== 200 || Object.keys(state.body.datasets || {}).length !== 6) {
  throw new Error(`État de synchronisation invalide : ${JSON.stringify(state)}`);
}

const inventory = await request("/sync/inventory?avatar=enzo");
const market = await request("/sync/mu");
const catalog = await request("/sync/catalog");
if (inventory.status !== 200 || !inventory.body.rows?.length) throw new Error("Snapshot Enzo vide");
if (market.status !== 200 || !market.body.rows?.length) throw new Error("Snapshot MU vide");
if (catalog.status !== 200 || !catalog.body.rows?.length) throw new Error("Snapshot catalogue vide");

const sameInventory = await request("/sync/inventory?avatar=enzo", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Expected-Hash": inventory.body.state.hash
  },
  body: JSON.stringify({ rows: inventory.body.rows, updatedAt: inventory.body.state.updatedAt })
});
if (sameInventory.status !== 200 || !sameInventory.body.noChange) {
  throw new Error(`Détection no-change inventaire échouée : ${JSON.stringify(sameInventory)}`);
}

const staleWrite = await request("/sync/inventory?avatar=enzo", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Expected-Hash": "stale" },
  body: JSON.stringify({ rows: inventory.body.rows, updatedAt: inventory.body.state.updatedAt })
});
if (staleWrite.status !== 409) throw new Error(`Conflit attendu, reçu ${staleWrite.status}`);

if (mode === "write") {
  const changedRows = structuredClone(inventory.body.rows);
  changedRows[0].quantity = Number(changedRows[0].quantity) + 1;
  const changed = await request("/sync/inventory?avatar=enzo", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Expected-Hash": inventory.body.state.hash
    },
    body: JSON.stringify({ rows: changedRows, updatedAt: new Date().toISOString() })
  });
  if (changed.status !== 200 || changed.body.noChange) throw new Error("Écriture de test non appliquée");

  const historical = await request(
    `/sync/inventory?avatar=enzo&hash=${encodeURIComponent(inventory.body.state.hash)}`
  );
  if (historical.status !== 200 || historical.body.state.hash !== inventory.body.state.hash) {
    throw new Error("Lecture du snapshot de base par empreinte échouée");
  }

  const restored = await request("/sync/inventory?avatar=enzo", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Expected-Hash": changed.body.state.hash
    },
    body: JSON.stringify({ rows: inventory.body.rows, updatedAt: inventory.body.state.updatedAt })
  });
  if (restored.status !== 200 || restored.body.state.hash !== inventory.body.state.hash) {
    throw new Error("Restauration du snapshot de test échouée");
  }
}

console.log(JSON.stringify({
  ok: true,
  datasets: Object.keys(state.body.datasets).sort(),
  inventoryRows: inventory.body.rows.length,
  marketRows: market.body.rows.length,
  catalogRows: catalog.body.rows.length,
  noChange: sameInventory.body.noChange,
  staleWriteStatus: staleWrite.status,
  writeRoundTrip: mode === "write"
}, null, 2));
