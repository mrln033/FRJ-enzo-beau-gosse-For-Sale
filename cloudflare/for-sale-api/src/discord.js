const DISCORD_RESPONSE_LIMIT = 20_000;
const ADMIN_ORDERS_URL = "https://mrln033.github.io/FRJ-enzo-beau-gosse-For-Sale/commandes.html?admin=1";

const STATUS_LABELS = {
  submitted: "Demande transmise",
  awaiting_approval: "À valider par le client",
  viewed: "Demande consultée",
  preparing: "Préparation en cours",
  ready: "Prête",
  completed: "Terminée",
  cancelled: "Annulée",
  expired: "Expirée"
};

const STATUS_COLORS = {
  submitted: 0xC89222,
  awaiting_approval: 0x8B5CF6,
  viewed: 0x3578C4,
  preparing: 0xD87818,
  ready: 0x27834A,
  completed: 0x166534,
  cancelled: 0xB43C34,
  expired: 0x777777
};

export function buildDiscordOrderPayload(order, items) {
  const status = String(order?.status || "submitted").toLowerCase();
  const memberLabel = order?.frjMember ? "MU FRJ" : "MU";
  const fields = [
    { name: "Avatar", value: discordText(order?.buyerAvatar || "—", 1024), inline: true },
    { name: "Statut", value: STATUS_LABELS[status] || discordText(status, 1024), inline: true },
    { name: "Total estimé", value: `${formatNumber(order?.totalSalePed)} PED`, inline: true },
    { name: "Contact", value: discordText(order?.buyerContact || "Non renseigné", 1024), inline: true },
    {
      name: "Origine",
      value: order?.sourceBackend === "gas-fallback" ? "Secours GAS" : "Cloudflare D1",
      inline: true
    },
    { name: "Profil tarifaire", value: order?.frjMember ? "Membre FRJ" : "Public", inline: true }
  ];

  buildItemFields(items, memberLabel).forEach((field) => fields.push(field));
  if (order?.buyerComment) {
    fields.push({ name: "Commentaire", value: discordText(order.buyerComment, 900), inline: false });
  }

  return {
    username: "FRJ — For Sale",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `🛒 ${discordText(order?.publicReference || "Nouvelle demande", 220)}`,
      url: ADMIN_ORDERS_URL,
      description: `État actuel : **${STATUS_LABELS[status] || discordText(status, 200)}**`,
      color: STATUS_COLORS[status] || STATUS_COLORS.submitted,
      fields,
      footer: { text: `Demande ${discordText(order?.id || "sans identifiant", 180)}` },
      timestamp: normalizeTimestamp(order?.updatedAt || order?.createdAt)
    }]
  };
}

export async function sendOrUpdateDiscordOrder(options) {
  const webhookUrl = normalizeWebhookUrl(options?.webhookUrl);
  if (!webhookUrl) return { ok: false, skipped: true, reason: "webhook-not-configured" };

  const fetchImpl = options.fetchImpl || fetch;
  const payload = buildDiscordOrderPayload(options.order, options.items || []);
  const messageId = normalizeMessageId(options.messageId);

  if (messageId) {
    const editUrl = new URL(webhookUrl);
    editUrl.pathname = `${editUrl.pathname.replace(/\/+$/, "")}/messages/${messageId}`;
    const editPayload = { allowed_mentions: payload.allowed_mentions, embeds: payload.embeds };
    const edited = await discordRequest(fetchImpl, editUrl, "PATCH", editPayload);
    if (edited.response.status !== 404) {
      if (!edited.response.ok) throw discordError("mise à jour", edited.response, edited.body);
      return { ok: true, action: "updated", messageId: normalizeMessageId(edited.body?.id) || messageId };
    }
  }

  const createUrl = new URL(webhookUrl);
  createUrl.searchParams.set("wait", "true");
  const created = await discordRequest(fetchImpl, createUrl, "POST", payload);
  if (!created.response.ok) throw discordError("publication", created.response, created.body);
  const createdMessageId = normalizeMessageId(created.body?.id);
  if (!createdMessageId) throw new Error("Discord n'a pas retourné l'identifiant du message");
  return { ok: true, action: messageId ? "recreated" : "created", messageId: createdMessageId };
}

function buildItemFields(items, memberLabel) {
  const lines = (Array.isArray(items) ? items : []).map((item) => {
    const markup = item?.markupDisplay || "à confirmer";
    return `• ${formatNumber(item?.quantity, 4)} × ${discordText(item?.itemName || "Article", 180)} — ${formatNumber(item?.lineSalePed)} PED (${memberLabel} : ${discordText(markup, 80)})`;
  });
  const chunks = [];
  let current = "";
  let included = 0;
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= 980 && chunks.length < 4) {
      current = candidate;
      included++;
      continue;
    }
    if (current && chunks.length < 4) chunks.push(current);
    if (chunks.length >= 4) break;
    current = line.length <= 980 ? line : `${line.slice(0, 977)}…`;
    included++;
  }
  if (current && chunks.length < 4) chunks.push(current);
  const omitted = Math.max(0, lines.length - included);
  if (omitted && chunks.length) {
    const suffix = `\n… et ${omitted} autre(s) article(s)`;
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1].slice(0, 980 - suffix.length)}${suffix}`;
  }
  return chunks.map((value, index) => ({
    name: index === 0 ? `Articles (${lines.length})` : "Articles — suite",
    value: value || "—",
    inline: false
  }));
}

async function discordRequest(fetchImpl, url, method, payload) {
  const response = await fetchImpl(url.toString(), {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const raw = await readLimitedText(response, DISCORD_RESPONSE_LIMIT);
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { message: raw }; }
  return { response, body };
}

async function readLimitedText(response, limit) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel("Réponse Discord trop volumineuse");
      throw new Error("Réponse Discord trop volumineuse");
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

function normalizeWebhookUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let url;
  try { url = new URL(text); } catch { throw new Error("Webhook Discord invalide"); }
  if (url.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(url.hostname)) {
    throw new Error("Webhook Discord invalide");
  }
  if (!/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+\/?$/.test(url.pathname)) {
    throw new Error("Webhook Discord invalide");
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeMessageId(value) {
  const text = String(value || "").trim();
  return /^\d{15,22}$/.test(text) ? text : "";
}

function discordError(action, response, body) {
  const detail = discordText(body?.message || "", 300);
  return new Error(`Discord : ${action} impossible (HTTP ${response.status})${detail ? ` — ${detail}` : ""}`);
}

function discordText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/@/g, "@\u200b")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeTimestamp(value) {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function formatNumber(value, decimals = 2) {
  const number = Number(value || 0);
  return number.toLocaleString("fr-FR", { maximumFractionDigits: decimals, minimumFractionDigits: decimals === 2 ? 2 : 0 });
}
