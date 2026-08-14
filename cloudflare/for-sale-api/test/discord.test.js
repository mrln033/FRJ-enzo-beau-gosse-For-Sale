import test from "node:test";
import assert from "node:assert/strict";
import { buildDiscordOrderPayload, sendOrUpdateDiscordOrder } from "../src/discord.js";

const webhookUrl = "https://discord.com/api/webhooks/123456789012345678/test_token";
const order = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  publicReference: "FRJ-20260814-A1B2C3",
  status: "submitted",
  buyerAvatar: "Buyer @everyone",
  buyerContact: "Discord: buyer",
  sourceBackend: "d1",
  totalSalePed: 24,
  frjMember: true,
  createdAt: "2026-08-14T10:00:00.000Z"
};
const items = [{ itemName: "Item A", quantity: 2, lineSalePed: 24, markupDisplay: "110,00 %" }];

test("construit un message Discord sans mention active", () => {
  const payload = buildDiscordOrderPayload(order, items);
  assert.equal(payload.allowed_mentions.parse.length, 0);
  assert.match(payload.embeds[0].title, /FRJ-20260814-A1B2C3/);
  assert.match(payload.embeds[0].fields[0].value, /@\u200beveryone/);
  assert.match(payload.embeds[0].fields.find((field) => field.name.startsWith("Articles")).value, /MU FRJ/);
});

test("affiche explicitement une proposition à valider", () => {
  const payload = buildDiscordOrderPayload({ ...order, status: "awaiting_approval" }, items);
  assert.match(payload.embeds[0].description, /À valider par le client/);
});

test("publie avec wait=true et récupère l'identifiant Discord", async () => {
  let request;
  const result = await sendOrUpdateDiscordOrder({
    webhookUrl,
    order,
    items,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ id: "1537723733966458999" }), { status: 200 });
    }
  });
  assert.equal(result.action, "created");
  assert.equal(result.messageId, "1537723733966458999");
  assert.equal(new URL(request.url).searchParams.get("wait"), "true");
  assert.equal(request.options.method, "POST");
});

test("modifie le message existant", async () => {
  let request;
  const result = await sendOrUpdateDiscordOrder({
    webhookUrl,
    messageId: "1537723733966458999",
    order: { ...order, status: "ready" },
    items,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ id: "1537723733966458999" }), { status: 200 });
    }
  });
  assert.equal(result.action, "updated");
  assert.match(request.url, /\/messages\/1537723733966458999$/);
  assert.equal(request.options.method, "PATCH");
  assert.equal(JSON.parse(request.options.body).username, undefined);
});

test("recrée un message Discord supprimé", async () => {
  const methods = [];
  const result = await sendOrUpdateDiscordOrder({
    webhookUrl,
    messageId: "1537723733966458999",
    order,
    items,
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return options.method === "PATCH"
        ? new Response(JSON.stringify({ message: "Unknown Message" }), { status: 404 })
        : new Response(JSON.stringify({ id: "1537723733966458000" }), { status: 200 });
    }
  });
  assert.equal(result.action, "recreated");
  assert.deepEqual(methods, ["PATCH", "POST"]);
});
