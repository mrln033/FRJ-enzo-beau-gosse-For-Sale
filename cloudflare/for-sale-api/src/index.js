import { normalizeInventoryRows, normalizeMarketRows } from "./domain.js";

const MAX_IMPORT_BYTES = 1_800_000;
const INVENTORY_RETENTION_COUNT = 5;

const PUBLIC_ORIGINS = new Set([
  "https://mrln033.github.io",
  "http://localhost:8787",
  "http://127.0.0.1:8787"
]);

const AVATAR_SHEETS = {
  enzo: "Inventaire Enzo",
  arkaman: "Inventaire ArkaMan",
  kenza: "Inventaire Kenza",
  nocturnal: "Inventaire Nocturnal"
};

const SALEABLE_CONTAINER_SQL = `(
  lower(coalesce(ii.container, '')) LIKE '%calypso%'
  OR lower(coalesce(ii.container, '')) LIKE '%carried%'
  OR lower(coalesce(ii.container, '')) IN (
    'pitbull mk. 1 (c,l)',
    'pitbull mk. 2 (c,l)',
    'personal avatar',
    'ni armors',
    'ni tailoring/textiles',
    'blueprints: a.r.c.',
    'blueprints: cyrene',
    'kulokhar tall urn'
  )
  OR lower(coalesce(ii.container, '')) LIKE '%limited%'
)`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return corsPreflight(origin);
    }

    try {
      const url = new URL(request.url);

      if (request.method === "GET") {
        return withCors(await handleGet(url, env), origin);
      }

      if (request.method === "POST") {
        if (!(await isAuthorized(request, env.ADMIN_TOKEN))) {
          return withCors(json({ error: "Unauthorized" }, 401), origin);
        }
        return withCors(await handlePost(request, url, env), origin);
      }

      return withCors(json({ error: "Method not allowed" }, 405), origin);
    } catch (error) {
      if (error instanceof ApiError) {
        return withCors(json({ error: error.message }, error.status), origin);
      }

      console.error(JSON.stringify({
        message: "Unhandled API error",
        method: request.method,
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error)
      }));
      return withCors(json({ error: "Erreur interne" }, 500), origin);
    }
  }
};

async function handleGet(url, env) {
  if (url.pathname === "/health") {
    const row = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM catalog_items) AS items,
        (SELECT COUNT(*) FROM catalog_listings) AS listings
    `).first();
    return json({ ok: true, catalogItems: row?.items || 0, catalogListings: row?.listings || 0 });
  }

  const action = url.searchParams.get("action");

  if (action === "categories") {
    const result = await env.DB.prepare(`
      SELECT l.storage
      FROM catalog_listings l
      JOIN catalog_items c ON c.name = l.item_name COLLATE NOCASE
      JOIN active_inventory ai ON ai.avatar_id = 'enzo'
      JOIN inventory_items ii
        ON ii.import_id = ai.import_id
       AND ii.item_name = c.name COLLATE NOCASE
      WHERE l.enabled = 1
        AND l.storage <> ''
        AND l.aisle <> ''
        AND ${SALEABLE_CONTAINER_SQL}
      GROUP BY l.storage
      HAVING SUM(ii.quantity) > 0
      ORDER BY l.storage
    `).all();
    return publicJson(result.results.map((row) => row.storage));
  }

  if (action === "inventoryDate") {
    const row = await env.DB.prepare(`
      SELECT i.imported_at
      FROM active_inventory a
      JOIN inventory_imports i ON i.id = a.import_id
      WHERE a.avatar_id = 'enzo'
    `).first();
    return publicJson({ inventoryDate: row ? formatInventoryDate(row.imported_at) : "" });
  }

  if (action === "inventoryTarget") {
    const avatar = url.searchParams.get("avatar") || "enzo";
    return publicJson({ avatar, sheet: AVATAR_SHEETS[avatar] || "" });
  }

  const category = String(url.searchParams.get("category") || "").trim().toUpperCase();
  if (!category) return publicJson([]);

  const result = await env.DB.prepare(`
    WITH inventory AS (
      SELECT ii.item_name, SUM(ii.quantity) AS quantity
      FROM inventory_items ii
      JOIN active_inventory ai ON ai.import_id = ii.import_id
      WHERE ai.avatar_id = 'enzo'
        AND ${SALEABLE_CONTAINER_SQL}
      GROUP BY ii.item_name COLLATE NOCASE
    ),
    recent_market AS (
      SELECT
        mo.item_name,
        mo.weighted_display,
        mo.observed_at,
        ROW_NUMBER() OVER (
          PARTITION BY mo.item_name COLLATE NOCASE
          ORDER BY datetime(mo.observed_at) DESC, mo.line_no DESC
        ) AS row_number
      FROM market_observations mo
      WHERE datetime(mo.observed_at) >= datetime('now', '-7 days')
    )
    SELECT
      l.storage AS STORAGE,
      l.aisle AS RAYON,
      c.name AS ITEM,
      inventory.quantity AS QUANTITE,
      c.unit_price_ped AS PRIX_UNITAIRE,
      c.image AS IMAGE,
      c.wiki_url AS LIEN_WIKI,
      recent_market.observed_at AS DATE_MU_ISO,
      recent_market.weighted_display AS MU,
      COALESCE(p.discount_rate, '') AS Remise_Promo
    FROM catalog_listings l
    JOIN catalog_items c ON c.name = l.item_name COLLATE NOCASE
    JOIN inventory ON inventory.item_name = c.name COLLATE NOCASE
    LEFT JOIN recent_market
      ON recent_market.item_name = c.name COLLATE NOCASE
     AND recent_market.row_number = 1
    LEFT JOIN promotions p
      ON p.promotion_date = date('now')
     AND p.storage = l.storage
     AND p.aisle = l.aisle
    WHERE l.enabled = 1
      AND l.storage = ? COLLATE NOCASE
      AND inventory.quantity > 0
    ORDER BY c.name COLLATE NOCASE
  `).bind(category).all();

  const rows = result.results.map(({ DATE_MU_ISO, ...row }) => ({
    ...row,
    DATE_MU: DATE_MU_ISO ? formatFrenchDateTime(DATE_MU_ISO) : "",
    TOTAL: Number(row.QUANTITE || 0) * Number(row.PRIX_UNITAIRE || 0)
  }));
  return publicJson(rows);
}

async function handlePost(request, url, env) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_IMPORT_BYTES) throw new ApiError(413, "Import trop volumineux");

  const type = url.searchParams.get("type");
  const body = await readTextBody(request, MAX_IMPORT_BYTES);

  if (type === "inventory") {
    const avatar = url.searchParams.get("avatar") || "enzo";
    if (!AVATAR_SHEETS[avatar]) return json({ error: `Avatar inconnu : ${avatar}` }, 400);

    const rows = parseImport(() => normalizeInventoryRows(body));
    if (rows.length === 0) return json({ error: "Inventaire vide" }, 400);

    const importedAt = new Date().toISOString();
    const importId = crypto.randomUUID();
    const checksum = await sha256(body);
    const payload = JSON.stringify(rows);

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO inventory_imports (id, avatar_id, imported_at, source_row_count, checksum)
        VALUES (?, ?, ?, ?, ?)
      `).bind(importId, avatar, importedAt, rows.length, checksum),
      env.DB.prepare(`
        INSERT INTO inventory_items (
          import_id, line_no, source_id, item_name, quantity, value_ped, container, container_ref_id
        )
        SELECT
          ?,
          CAST(json_extract(value, '$.lineNo') AS INTEGER),
          json_extract(value, '$.sourceId'),
          json_extract(value, '$.itemName'),
          CAST(json_extract(value, '$.quantity') AS REAL),
          CAST(json_extract(value, '$.valuePed') AS REAL),
          json_extract(value, '$.container'),
          json_extract(value, '$.containerRefId')
        FROM json_each(?)
      `).bind(importId, payload),
      env.DB.prepare(`
        INSERT INTO active_inventory (avatar_id, import_id) VALUES (?, ?)
        ON CONFLICT (avatar_id) DO UPDATE SET import_id = excluded.import_id
      `).bind(avatar, importId),
      env.DB.prepare(`
        DELETE FROM inventory_imports
        WHERE avatar_id = ?
          AND id NOT IN (
            SELECT id
            FROM inventory_imports
            WHERE avatar_id = ?
            ORDER BY datetime(imported_at) DESC, created_at DESC, id DESC
            LIMIT ?
          )
          AND id NOT IN (
            SELECT import_id
            FROM active_inventory
            WHERE avatar_id = ?
          )
      `).bind(avatar, avatar, INVENTORY_RETENTION_COUNT, avatar)
    ]);

    return legacyText(
      `✅ Import inventaire OK dans ${AVATAR_SHEETS[avatar]} (${rows.length + 1} lignes)`,
      importId
    );
  }

  if (type === "mu") {
    const observedAt = new Date().toISOString();
    const rows = parseImport(() => normalizeMarketRows(body, observedAt));
    if (rows.length === 0) return json({ error: "Import MU vide" }, 400);

    const importId = crypto.randomUUID();
    const checksum = await sha256(body);
    const payload = JSON.stringify(rows);

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO market_imports (id, imported_at, source_row_count, checksum)
        VALUES (?, ?, ?, ?)
      `).bind(importId, observedAt, rows.length, checksum),
      env.DB.prepare(`
        INSERT INTO market_observations (
          import_id, line_no, item_name, tier,
          day_markup, day_sales, week_markup, week_sales,
          month_markup, month_sales, year_markup, year_sales,
          decade_markup, decade_sales,
          weighted_kind, weighted_value, weighted_display, observed_at
        )
        SELECT
          ?,
          CAST(json_extract(value, '$.lineNo') AS INTEGER),
          json_extract(value, '$.itemName'),
          json_extract(value, '$.tier'),
          json_extract(value, '$.dayMarkup'),
          json_extract(value, '$.daySales'),
          json_extract(value, '$.weekMarkup'),
          json_extract(value, '$.weekSales'),
          json_extract(value, '$.monthMarkup'),
          json_extract(value, '$.monthSales'),
          json_extract(value, '$.yearMarkup'),
          json_extract(value, '$.yearSales'),
          json_extract(value, '$.decadeMarkup'),
          json_extract(value, '$.decadeSales'),
          json_extract(value, '$.weightedKind'),
          CAST(json_extract(value, '$.weightedValue') AS REAL),
          json_extract(value, '$.weightedDisplay'),
          json_extract(value, '$.observedAt')
        FROM json_each(?)
      `).bind(importId, payload),
      env.DB.prepare(`
        INSERT INTO active_market_import (singleton, import_id) VALUES (1, ?)
        ON CONFLICT (singleton) DO UPDATE SET import_id = excluded.import_id
      `).bind(importId)
    ]);

    return legacyText(`${rows.length} MAJ / 0 AJOUTS`, importId);
  }

  return json({ error: `Type inconnu : ${type || "absent"}` }, 400);
}

async function isAuthorized(request, configuredToken) {
  if (!configuredToken) return false;
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!supplied) return false;
  return timingSafeEqual(supplied, configuredToken);
}

async function timingSafeEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatFrenchDateTime(value) {
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

function formatInventoryDate(value) {
  const date = new Date(value);
  const formatted = formatFrenchDateTime(date).replace(" ", " - ");
  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    timeZoneName: "longOffset"
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value || "GMT+00:00";
  return `${formatted} (${offsetName.replace("GMT", "UTC")})`;
}

function publicJson(data) {
  const response = json(data);
  response.headers.set("Cache-Control", "public, max-age=60, s-maxage=300");
  return response;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" }
  });
}

function legacyText(message, importId) {
  return new Response(message, {
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      "X-Import-Id": importId
    }
  });
}

function corsPreflight(origin) {
  if (!PUBLIC_ORIGINS.has(origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    }
  });
}

function withCors(response, origin) {
  if (PUBLIC_ORIGINS.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Vary", "Origin");
  }
  return response;
}

async function readTextBody(request, limit) {
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

function parseImport(parser) {
  try {
    return parser();
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "Import invalide");
  }
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
