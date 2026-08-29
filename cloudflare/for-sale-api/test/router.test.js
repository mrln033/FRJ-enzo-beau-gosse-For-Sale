import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("conserve le refus CORS des commandes publiques", async () => {
  const request = new Request("https://api.example/orders", {
    method: "POST",
    headers: { Origin: "https://example.invalid" }
  });
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Origine non autorisée" });
});

test("conserve la protection des routes administrateur", async () => {
  const request = new Request("https://api.example/admin/orders", {
    headers: { Origin: "https://mrln033.github.io" }
  });
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://mrln033.github.io");
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("protège aussi l'historique détaillé d'une demande", async () => {
  const request = new Request(
    "https://api.example/admin/orders/11111111-1111-4111-8111-111111111111/history",
    { headers: { Origin: "https://mrln033.github.io" } }
  );
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("protège la création d'un lien de suivi secondaire", async () => {
  const request = new Request(
    "https://api.example/admin/orders/11111111-1111-4111-8111-111111111111/tracking-link",
    { method: "POST", headers: { Origin: "https://mrln033.github.io" } }
  );
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("protège les statistiques détaillées des visites", async () => {
  const request = new Request("https://api.example/admin/visit-statistics", {
    headers: { Origin: "https://mrln033.github.io" }
  });
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("refuse l'enregistrement public d'une visite depuis une origine inconnue", async () => {
  const request = new Request("https://api.example/visits", {
    method: "POST",
    headers: { Origin: "https://example.invalid" }
  });
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Origine non autorisée" });
});

test("conserve le contrat de pré-vérification CORS", async () => {
  const request = new Request("https://api.example/health", {
    method: "OPTIONS",
    headers: { Origin: "https://mrln033.github.io" }
  });
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
});

test("conserve la réponse pour une méthode non autorisée", async () => {
  const request = new Request("https://api.example/health", { method: "PUT" });
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: "Method not allowed" });
});
