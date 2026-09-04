import { PUBLIC_ORIGINS } from "./config.js";

export function cleanNullableText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function cleanNullableNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function isAuthorized(request, configuredToken) {
  if (!configuredToken) return false;
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!supplied) return false;
  return timingSafeEqual(supplied, configuredToken);
}

export async function timingSafeEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function formatFrenchDateTime(value) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(value)).map((part) => [part.type, part.value])
  );
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatInventoryDate(value) {
  const date = new Date(value);
  const formatted = formatFrenchDateTime(date).replace(" ", " - ");
  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    timeZoneName: "longOffset"
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value || "GMT+00:00";
  return `${formatted} (${offsetName.replace("GMT", "UTC")})`;
}

export function publicJson(data) {
  const response = json(data);
  response.headers.set("Cache-Control", "public, max-age=60, s-maxage=300");
  return response;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" }
  });
}

export function legacyText(message, importId, rowsWritten = 0) {
  return new Response(message, {
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      "X-Import-Id": importId,
      "X-D1-Rows-Written": String(rowsWritten)
    }
  });
}

export function corsPreflight(origin) {
  if (!PUBLIC_ORIGINS.has(origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    }
  });
}

export function withCors(response, origin) {
  if (PUBLIC_ORIGINS.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Expose-Headers", "X-Import-Id, X-D1-Rows-Written");
    response.headers.set("Vary", "Origin");
  }
  return response;
}

export async function readTextBody(request, limit) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let byteCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > limit) {
      await reader.cancel("Import trop volumineux");
      throw new ApiError(413, "Import trop volumineux");
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

export function parseImport(parser) {
  try {
    return parser();
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "Import invalide");
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
