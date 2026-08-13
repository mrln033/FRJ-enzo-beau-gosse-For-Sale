const MARKET_FIELDS = [
  "itemName", "tier",
  "dayMarkup", "daySales",
  "weekMarkup", "weekSales",
  "monthMarkup", "monthSales",
  "yearMarkup", "yearSales",
  "decadeMarkup", "decadeSales"
];

export async function inventoryContentHash(rows) {
  return sha256(canonicalInventoryPayload(rows));
}

export async function marketContentHash(rows) {
  return sha256(canonicalMarketPayload(rows));
}

export async function catalogContentHash(rows) {
  return sha256(canonicalCatalogPayload(rows));
}

export function canonicalInventoryPayload(rows) {
  return rows.map((row) => JSON.stringify([
    cleanText(row.sourceId),
    cleanText(row.itemName),
    cleanNumber(row.quantity),
    cleanNullableNumber(row.valuePed),
    cleanText(row.container),
    cleanText(row.containerRefId)
  ])).sort().join("\n");
}

export function canonicalMarketPayload(rows) {
  return rows.map((row) => JSON.stringify([
    ...MARKET_FIELDS.map((field) => cleanText(row[field])),
    cleanTimestamp(row.observedAt)
  ])).sort().join("\n");
}

export function canonicalCatalogPayload(rows) {
  return rows.map((row) => JSON.stringify([
    cleanText(row.itemName),
    cleanText(row.storage).toUpperCase(),
    cleanText(row.aisle).toUpperCase(),
    cleanNullableNumber(row.unitPricePed),
    cleanText(row.image),
    cleanText(row.wikiUrl),
    Number(row.enabled) === 0 ? "0" : "1"
  ])).sort().join("\n");
}

export function mergeMarketRows(currentRows, incomingRows) {
  const rowsByItem = new Map();

  for (const row of currentRows) {
    const key = cleanText(row.itemName).toLocaleLowerCase("en-US");
    if (key) rowsByItem.set(key, row);
  }

  for (const row of incomingRows) {
    const key = cleanText(row.itemName).toLocaleLowerCase("en-US");
    if (key) rowsByItem.set(key, row);
  }

  return [...rowsByItem.values()]
    .sort((left, right) => cleanText(left.itemName).localeCompare(cleanText(right.itemName), "en", {
      sensitivity: "base"
    }))
    .map((row, index) => ({ ...row, lineNo: index + 2 }));
}

export function normalizeSyncTimestamp(value, fallback = new Date().toISOString()) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

export function mapInventoryDbRow(row) {
  return {
    lineNo: Number(row.line_no),
    sourceId: row.source_id ?? null,
    itemName: String(row.item_name || ""),
    quantity: Number(row.quantity || 0),
    valuePed: row.value_ped === null || row.value_ped === undefined ? null : Number(row.value_ped),
    container: row.container ?? null,
    containerRefId: row.container_ref_id ?? null
  };
}

export function mapMarketDbRow(row) {
  return {
    lineNo: Number(row.line_no),
    itemName: String(row.item_name || ""),
    tier: row.tier ?? null,
    dayMarkup: row.day_markup ?? null,
    daySales: row.day_sales ?? null,
    weekMarkup: row.week_markup ?? null,
    weekSales: row.week_sales ?? null,
    monthMarkup: row.month_markup ?? null,
    monthSales: row.month_sales ?? null,
    yearMarkup: row.year_markup ?? null,
    yearSales: row.year_sales ?? null,
    decadeMarkup: row.decade_markup ?? null,
    decadeSales: row.decade_sales ?? null,
    weightedKind: row.weighted_kind ?? null,
    weightedValue: row.weighted_value === null || row.weighted_value === undefined
      ? null
      : Number(row.weighted_value),
    weightedDisplay: row.weighted_display ?? null,
    observedAt: normalizeSyncTimestamp(row.observed_at, "1970-01-01T00:00:00.000Z")
  };
}

export function mapCatalogDbRow(row) {
  return {
    lineNo: Number(row.line_no || 0),
    itemName: String(row.item_name || ""),
    storage: String(row.storage || ""),
    aisle: String(row.aisle || ""),
    unitPricePed: row.unit_price_ped === null || row.unit_price_ped === undefined
      ? null
      : Number(row.unit_price_ped),
    image: row.image ?? null,
    wikiUrl: row.wiki_url ?? null,
    enabled: Number(row.enabled) === 0 ? 0 : 1
  };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function cleanNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "0";
}

function cleanNullableNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "";
}

function cleanTimestamp(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
