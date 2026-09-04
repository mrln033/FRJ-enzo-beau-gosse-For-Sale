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

export async function containerContentHash(rows) {
  return sha256(canonicalContainerPayload(rows));
}

export async function discountCampaignContentHash(rows) {
  return sha256(rows.map((row) => JSON.stringify([
    cleanText(row.id), cleanText(row.type), cleanText(row.startsOn), cleanText(row.endsOn),
    cleanText(row.storage), cleanText(row.aisle), cleanNumber(row.discountRate),
    row.enabled === true || Number(row.enabled) === 1 ? "1" : "0", cleanText(row.origin || "manual"),
    cleanNullableNumber(row.eligiblePairCount), cleanNullableNumber(row.candidatePairCount), cleanTimestamp(row.updatedAt)
  ])).sort().join("\n"));
}

export async function discountConfigContentHash(rows) {
  const row = rows[0] || {};
  return sha256(JSON.stringify([
    row.automaticPromotionsEnabled === true || Number(row.automaticPromotionsEnabled) === 1 ? "1" : "0",
    cleanNumber(row.defaultPromotionRate), cleanText(row.selectionSeed || "frj-daily-promo"), cleanTimestamp(row.updatedAt)
  ]));
}

export function shouldSignalSyncAfterImport(pairedBackend) {
  return String(pairedBackend || "").toLowerCase() !== "gas";
}

export function canonicalInventoryPayload(rows) {
  return inventoryRowsWithKeys(rows).map((row) => JSON.stringify([
    cleanText(row.sourceId), cleanText(row.itemName),
    cleanNumber(row.quantity),
    cleanNullableNumber(row.valuePed),
    cleanText(row.container), cleanText(row.containerRefId)
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

export function canonicalContainerPayload(rows) {
  return rows.map((row) => JSON.stringify([
    cleanText(row.avatar).toLocaleLowerCase("en-US"),
    cleanText(row.containerKey || row.container).toLocaleLowerCase("en-US"),
    cleanText(row.container),
    row.enabled === true || Number(row.enabled) === 1 ? "1" : "0"
  ])).sort().join("\n");
}

export function inventoryRowsWithKeys(rows) {
  const occurrences = new Map();
  return rows.map((row, index) => {
    const baseKey = inventoryRowKey(row);
    const occurrence = (occurrences.get(baseKey) || 0) + 1;
    occurrences.set(baseKey, occurrence);
    const quantity = Number(row.quantity);
    return {
      lineNo: Number(row.lineNo) || index + 2,
      sourceId: cleanText(row.sourceId) || null,
      itemName: cleanText(row.itemName),
      quantity: Number.isFinite(quantity) ? quantity : 0,
      valuePed: cleanOptionalNumber(row.valuePed),
      container: cleanText(row.container) || null,
      containerRefId: cleanText(row.containerRefId) || null,
      rowKey: `${baseKey}#${occurrence}`
    };
  });
}

export function inventoryRowKey(row) {
  const sourceId = cleanText(row.sourceId).toLocaleLowerCase("en-US");
  if (sourceId) return `inventory:id:${sourceId}`;
  return `inventory:${[
    cleanText(row.itemName).toLocaleLowerCase("en-US"),
    cleanText(row.container).toLocaleLowerCase("en-US")
  ].join("\u001f")}`;
}

export function marketRowKey(row) {
  return `item:${cleanText(row.itemName).toLocaleLowerCase("en-US")}`;
}

export function catalogRowsWithKeys(rows) {
  const occurrences = new Map();
  return rows.map((row) => {
    const baseKey = `listing:${[
      cleanText(row.itemName).toLocaleLowerCase("en-US"),
      cleanText(row.storage).toLocaleLowerCase("en-US"),
      cleanText(row.aisle).toLocaleLowerCase("en-US")
    ].join("|")}`;
    const occurrence = (occurrences.get(baseKey) || 0) + 1;
    occurrences.set(baseKey, occurrence);
    return { ...row, rowKey: `${baseKey}#${occurrence}` };
  });
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

export function mapContainerSyncDbRow(row) {
  return {
    avatar: String(row.avatar_id || "").trim().toLocaleLowerCase("en-US"),
    containerKey: String(row.container_key || "").trim().toLocaleLowerCase("en-US"),
    container: String(row.container || "").trim(),
    enabled: Number(row.enabled || 0) === 1
  };
}

function cleanOptionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanTimestamp(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
