import { ApiError, json, readTextBody, sha256 } from "./http.js";

const MAX_VISIT_BODY_BYTES = 5_000;
const TOTAL_PAGE_KEY = "__TOTAL__";
const PAGE_VIEW_EVENT = "page_view";
const CATEGORY_VIEW_EVENT = "category_view";

export const VISIT_PAGES = Object.freeze({
  catalog: "Catalogue",
  "cart-help": "Aide du panier",
  "order-tracking": "Suivi de demande",
  "admin-orders": "Demandes d'achat",
  "admin-containers": "Conteneurs D1",
  "admin-discounts": "Promotions et soldes",
  "sync-report": "Rapport de synchronisation",
  "inventory-import": "Mise à jour inventaire",
  "markup-import": "Mise à jour MU",
  "visit-statistics": "Statistiques des visites"
});

export const VISIT_CATEGORIES = Object.freeze([
  "MONEY AND DEEDS", "CLOTHES", "ARMORS", "WEAPONS", "TOOLS", "MINDFORCE",
  "MATERIALS", "RESOURCES", "BLUEPRINTS", "VEHICLES", "MISCELLANEOUS"
]);

const VISIT_ID_PATTERN = /^[a-f0-9-]{32,80}$/i;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function handleVisitPost(request, env) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_VISIT_BODY_BYTES) throw new ApiError(413, "Événement de visite trop volumineux");
  const payload = parseVisitPayload(await readTextBody(request, MAX_VISIT_BODY_BYTES));
  const salt = String(env.VISIT_STATS_SALT || "").trim();
  if (!salt) throw new ApiError(503, "Statistiques de visites non configurées");

  const eventDay = currentParisDay();
  const [sessionHash, visitorHash] = await Promise.all([
    sha256(`${salt}\nsession\n${payload.sessionId}`),
    sha256(`${salt}\nvisitor\n${payload.visitorId}`)
  ]);
  const audience = payload.admin === true ? "ADMIN" : "PUBLIC";
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO visit_events (
      event_id, event_day, session_hash, visitor_hash, page_key, audience,
      event_type, category_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    payload.eventId,
    eventDay,
    sessionHash,
    visitorHash,
    payload.page,
    audience,
    payload.eventType,
    payload.category
  ).run();
  const counter = await readPublicVisitCounter(env);
  const response = json({
    ok: true,
    recorded: Number(result.meta?.changes || 0) === 1,
    counter
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function handleVisitCounterGet(env) {
  const response = json(await readPublicVisitCounter(env));
  response.headers.set("Cache-Control", "public, max-age=30, s-maxage=60");
  return response;
}

export async function handleAdminVisitStatisticsGet(url, env) {
  const filters = normalizeAdminFilters(url);
  const conditions = ["event_type = 'page_view'", "event_day >= ?", "event_day <= ?"];
  const values = [filters.startDate, filters.endDate];
  if (filters.audience !== "ALL") {
    conditions.push("audience = ?");
    values.push(filters.audience);
  }
  if (filters.page !== "ALL") {
    conditions.push("page_key = ?");
    values.push(filters.page);
  }
  const where = conditions.join(" AND ");
  const categoryConditions = ["event_type = 'category_view'", "event_day >= ?", "event_day <= ?"];
  const categoryValues = [filters.startDate, filters.endDate];
  if (filters.audience !== "ALL") {
    categoryConditions.push("audience = ?");
    categoryValues.push(filters.audience);
  }
  const categoryWhere = categoryConditions.join(" AND ");
  const [rowsResult, totalsResult, uniqueResult, counterResult, categoryResult] = await env.DB.batch([
    env.DB.prepare(`
      WITH filtered AS (
        SELECT event_day, session_hash, visitor_hash, page_key, audience
        FROM visit_events
        WHERE ${where}
      ), rollup AS (
        SELECT
          event_day, page_key, audience,
          COUNT(*) AS page_views,
          COUNT(DISTINCT session_hash) AS visits,
          COUNT(DISTINCT visitor_hash) AS unique_visitors
        FROM filtered
        GROUP BY event_day, page_key, audience
        UNION ALL
        SELECT
          event_day, '${TOTAL_PAGE_KEY}' AS page_key, audience,
          COUNT(*) AS page_views,
          COUNT(DISTINCT session_hash) AS visits,
          COUNT(DISTINCT visitor_hash) AS unique_visitors
        FROM filtered
        GROUP BY event_day, audience
      )
      SELECT event_day, page_key, audience, page_views, visits, unique_visitors
      FROM rollup
      ORDER BY event_day DESC,
               CASE WHEN page_key = '${TOTAL_PAGE_KEY}' THEN 0 ELSE 1 END,
               audience,
               page_key
    `).bind(...values),
    env.DB.prepare(`
      SELECT COUNT(*) AS page_views, COUNT(DISTINCT session_hash) AS visits
      FROM visit_events
      WHERE ${where}
    `).bind(...values),
    env.DB.prepare(`
      SELECT COALESCE(SUM(unique_visitors), 0) AS unique_visitors
      FROM (
        SELECT event_day, audience, COUNT(DISTINCT visitor_hash) AS unique_visitors
        FROM visit_events
        WHERE ${where}
        GROUP BY event_day, audience
      )
    `).bind(...values),
    env.DB.prepare(`
      SELECT COUNT(DISTINCT session_hash) AS visits, MIN(event_day) AS start_date
      FROM visit_events
      WHERE audience = 'PUBLIC'
    `),
    env.DB.prepare(`
      WITH filtered AS (
        SELECT event_day, session_hash, visitor_hash, category_key, audience
        FROM visit_events
        WHERE ${categoryWhere}
      ), category_totals AS (
        SELECT category_key,
               COUNT(*) AS category_views,
               COUNT(DISTINCT session_hash) AS visits
        FROM filtered
        GROUP BY category_key
      ), daily_unique AS (
        SELECT category_key, event_day, audience,
               COUNT(DISTINCT visitor_hash) AS unique_visitors
        FROM filtered
        GROUP BY category_key, event_day, audience
      ), unique_totals AS (
        SELECT category_key, SUM(unique_visitors) AS unique_visitors
        FROM daily_unique
        GROUP BY category_key
      )
      SELECT category_totals.category_key,
             category_totals.category_views,
             category_totals.visits,
             COALESCE(unique_totals.unique_visitors, 0) AS unique_visitors
      FROM category_totals
      LEFT JOIN unique_totals USING (category_key)
      ORDER BY category_totals.category_views DESC,
               category_totals.visits DESC,
               category_totals.category_key
    `).bind(...categoryValues)
  ]);
  const totals = totalsResult.results[0] || {};
  const unique = uniqueResult.results[0] || {};
  const publicCounter = counterResult.results[0] || {};
  return json({
    generatedAt: new Date().toISOString(),
    filters,
    pages: Object.entries(VISIT_PAGES).map(([key, label]) => ({ key, label })),
    totals: {
      pageViews: Number(totals.page_views || 0),
      visits: Number(totals.visits || 0),
      uniqueVisitors: Number(unique.unique_visitors || 0)
    },
    publicCounter: mapVisitCounter(publicCounter),
    categoryRows: categoryResult.results.map((row) => ({
      category: row.category_key,
      views: Number(row.category_views || 0),
      visits: Number(row.visits || 0),
      uniqueVisitors: Number(row.unique_visitors || 0)
    })),
    rows: rowsResult.results.map((row) => ({
      date: row.event_day,
      page: row.page_key,
      audience: row.audience,
      pageViews: Number(row.page_views || 0),
      visits: Number(row.visits || 0),
      uniqueVisitors: Number(row.unique_visitors || 0)
    }))
  });
}

function parseVisitPayload(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new ApiError(400, "Événement de visite invalide");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError(400, "Événement de visite invalide");
  }
  const eventId = validateVisitId(payload.eventId, "événement");
  const sessionId = validateVisitId(payload.sessionId, "session");
  const visitorId = validateVisitId(payload.visitorId, "visiteur");
  const page = String(payload.page || "").trim();
  if (!Object.hasOwn(VISIT_PAGES, page)) throw new ApiError(400, "Page de visite invalide");
  const eventType = String(payload.eventType || PAGE_VIEW_EVENT).trim();
  if (![PAGE_VIEW_EVENT, CATEGORY_VIEW_EVENT].includes(eventType)) {
    throw new ApiError(400, "Type d’événement de visite invalide");
  }
  let category = null;
  if (eventType === CATEGORY_VIEW_EVENT) {
    category = String(payload.category || "").trim().toUpperCase();
    if (page !== "catalog" || !VISIT_CATEGORIES.includes(category)) {
      throw new ApiError(400, "Catégorie de visite invalide");
    }
  }
  return { eventId, sessionId, visitorId, page, eventType, category, admin: payload.admin === true };
}

function validateVisitId(value, label) {
  const id = String(value || "").trim();
  if (!VISIT_ID_PATTERN.test(id)) throw new ApiError(400, `Identifiant de ${label} invalide`);
  return id;
}

function normalizeAdminFilters(url) {
  const today = new Date();
  const defaultStart = new Date(today);
  defaultStart.setUTCDate(defaultStart.getUTCDate() - 29);
  const startDate = normalizeDay(url.searchParams.get("startDate"), currentParisDay(defaultStart));
  const endDate = normalizeDay(url.searchParams.get("endDate"), currentParisDay(today));
  if (startDate > endDate) throw new ApiError(400, "La date de début doit précéder la date de fin");
  const audience = String(url.searchParams.get("audience") || "ALL").trim().toUpperCase();
  if (!["ALL", "PUBLIC", "ADMIN"].includes(audience)) throw new ApiError(400, "Audience invalide");
  const page = String(url.searchParams.get("page") || "ALL").trim();
  if (page !== "ALL" && !Object.hasOwn(VISIT_PAGES, page)) throw new ApiError(400, "Filtre de page invalide");
  return { startDate, endDate, audience, page };
}

function normalizeDay(value, fallback) {
  const day = String(value || "").trim() || fallback;
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!DAY_PATTERN.test(day) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new ApiError(400, "Date de statistiques invalide");
  }
  return day;
}

function currentParisDay(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function readPublicVisitCounter(env) {
  const row = await env.DB.prepare(`
    SELECT COUNT(DISTINCT session_hash) AS visits, MIN(event_day) AS start_date
    FROM visit_events
    WHERE audience = 'PUBLIC'
  `).first();
  return mapVisitCounter(row || {});
}

function mapVisitCounter(row) {
  return {
    visits: Number(row.visits || 0),
    startDate: row.start_date || null
  };
}
