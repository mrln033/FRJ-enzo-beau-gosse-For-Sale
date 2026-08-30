import { ApiError } from "./http.js";
import {
  businessDateInParis,
  collectEligiblePromotionPairs,
  planDailyPromotion,
  validateDailyPromotionChange,
  validateSaleChange
} from "./discounts.js";

export async function readDiscountAdministration(env) {
  const [config, campaigns, items] = await Promise.all([
    env.DB.prepare(`
      SELECT automatic_promotions_enabled, default_promotion_rate, selection_seed, updated_at
      FROM discount_config WHERE singleton = 1
    `).first(),
    env.DB.prepare(`
      SELECT id, campaign_type, starts_on, ends_on, storage, aisle, discount_rate,
             enabled, origin, eligible_pair_count, candidate_pair_count,
             generation_seed, created_at, updated_at
      FROM discount_campaigns
      ORDER BY starts_on DESC, campaign_type, id
      LIMIT 500
    `).all(),
    readAllPromotableItems(env)
  ]);
  return {
    config: mapDiscountConfig(config),
    campaigns: campaigns.results.map(mapDiscountCampaign),
    eligiblePairs: collectEligiblePromotionPairs(items).map(({ storage, aisle, promotableItems }) => ({
      storage, aisle, promotableItems
    }))
  };
}

export async function updateDiscountConfig(env, payload) {
  const enabled = payload?.automaticPromotionsEnabled === true ? 1
    : (payload?.automaticPromotionsEnabled === false ? 0 : null);
  const rate = Number(payload?.defaultPromotionRate);
  if (enabled === null) throw new ApiError(400, "Activation automatique invalide");
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
    throw new ApiError(400, "Le taux de promotion doit être compris entre 0 et 1");
  }
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE discount_config
    SET automatic_promotions_enabled = ?, default_promotion_rate = ?, updated_at = ?
    WHERE singleton = 1
  `).bind(enabled, rate, updatedAt).run();
  return { ok: true, config: mapDiscountConfig(await env.DB.prepare(`
    SELECT automatic_promotions_enabled, default_promotion_rate, selection_seed, updated_at
    FROM discount_config WHERE singleton = 1
  `).first()) };
}

export async function createDiscountCampaign(env, payload) {
  const type = normalizeCampaignType(payload?.type);
  const id = crypto.randomUUID();
  const candidate = type === "daily_promo"
    ? await validateAdminDailyPromotion(env, { ...payload, id, origin: "manual" })
    : await validateAdminSale(env, { ...payload, id, origin: "manual" });
  const timestamp = new Date().toISOString();
  await insertCampaign(env, { ...candidate, id, type, origin: "manual", createdAt: timestamp, updatedAt: timestamp });
  return { ok: true, campaign: await readCampaign(env, id) };
}

export async function updateDiscountCampaign(env, id, payload) {
  const existing = await readCampaign(env, id);
  if (!existing) throw new ApiError(404, "Campagne de remise introuvable");
  if (payload?.type && normalizeCampaignType(payload.type) !== existing.type) {
    throw new ApiError(400, "Le type d'une campagne ne peut pas être modifié");
  }
  const merged = { ...existing, ...payload, id, type: existing.type, origin: existing.origin };
  const candidate = existing.type === "daily_promo"
    ? await validateAdminDailyPromotion(env, merged)
    : await validateAdminSale(env, merged);
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE discount_campaigns
    SET starts_on = ?, ends_on = ?, storage = ?, aisle = ?, discount_rate = ?,
        enabled = ?, updated_at = ?
    WHERE id = ?
  `).bind(
    candidate.startsOn, candidate.endsOn, candidate.storage, candidate.aisle,
    candidate.discountRate, candidate.enabled ? 1 : 0, updatedAt, id
  ).run();
  return { ok: true, campaign: await readCampaign(env, id) };
}

export async function generateDailyPromotion(env, requestedDate = null) {
  const date = requestedDate ? String(requestedDate) : businessDateInParis();
  const configRow = await env.DB.prepare(`
    SELECT automatic_promotions_enabled, default_promotion_rate, selection_seed
    FROM discount_config WHERE singleton = 1
  `).first();
  if (Number(configRow?.automatic_promotions_enabled ?? 1) !== 1) {
    return { reason: "AUTOMATION_DISABLED", date, campaign: null };
  }
  const [items, campaigns] = await Promise.all([readAllPromotableItems(env), readCampaignRows(env)]);
  const result = planDailyPromotion({
    date,
    items,
    dailyPromotions: campaigns.filter((campaign) => campaign.type === "daily_promo"),
    sales: campaigns.filter((campaign) => campaign.type === "sale"),
    defaultRate: Number(configRow?.default_promotion_rate ?? 0.05),
    seed: String(configRow?.selection_seed || "frj-daily-promo")
  });
  if (result.reason !== "GENERATED") return result;

  const campaign = result.campaign;
  const id = `daily-promo-${date}`;
  const timestamp = new Date().toISOString();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO discount_campaigns (
      id, campaign_type, starts_on, ends_on, storage, aisle, discount_rate,
      enabled, origin, eligible_pair_count, candidate_pair_count,
      generation_seed, created_at, updated_at
    ) VALUES (?, 'daily_promo', ?, ?, ?, ?, ?, 1, 'automatic', ?, ?, ?, ?, ?)
  `).bind(
    id, date, date, campaign.storage, campaign.aisle, campaign.discountRate,
    result.eligiblePairCount, result.candidatePairCount,
    String(configRow?.selection_seed || "frj-daily-promo"), timestamp, timestamp
  ).run();
  return { ...result, campaign: await readCampaign(env, id) };
}

async function validateAdminDailyPromotion(env, payload) {
  const date = String(payload.date ?? payload.startsOn ?? "");
  const normalizedPayload = {
    id: payload.id,
    date,
    storage: payload.storage,
    aisle: payload.aisle,
    discountRate: payload.discountRate,
    enabled: payload.enabled !== false,
    origin: payload.origin || "manual"
  };
  const [items, campaigns] = await Promise.all([
    readPromotionPairItems(env, normalizedPayload.storage, normalizedPayload.aisle),
    readCampaignRows(env)
  ]);
  try {
    const validated = validateDailyPromotionChange({
      promotion: normalizedPayload,
      dailyPromotions: campaigns.filter((campaign) => campaign.type === "daily_promo"),
      sales: campaigns.filter((campaign) => campaign.type === "sale"),
      items
    });
    return {
      startsOn: validated.date,
      endsOn: validated.date,
      storage: validated.storage,
      aisle: validated.aisle,
      discountRate: validated.discountRate,
      enabled: validated.enabled
    };
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "Promotion invalide");
  }
}

async function validateAdminSale(env, payload) {
  const sale = {
    id: payload.id,
    startsOn: payload.startsOn,
    endsOn: payload.endsOn,
    discountRate: payload.discountRate,
    enabled: payload.enabled !== false,
    origin: payload.origin || "manual"
  };
  try {
    const campaigns = await readCampaignRows(env);
    const validated = validateSaleChange({
      sale,
      sales: campaigns.filter((campaign) => campaign.type === "sale")
    });
    return {
      startsOn: validated.startsOn,
      endsOn: validated.endsOn,
      storage: null,
      aisle: null,
      discountRate: validated.discountRate,
      enabled: validated.enabled
    };
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "Période de soldes invalide");
  }
}

async function readPromotionPairItems(env, storage, aisle) {
  const result = await env.DB.prepare(`
    SELECT l.item_name AS itemName, l.storage AS storage, l.aisle AS aisle,
           SUM(ii.quantity) AS quantity,
           CASE WHEN datetime(mc.observed_at) >= datetime('now', '-7 days') THEN mc.weighted_kind ELSE NULL END AS markupKind,
           CASE WHEN datetime(mc.observed_at) >= datetime('now', '-7 days') THEN mc.weighted_value ELSE NULL END AS markupValue
    FROM catalog_listings l
    JOIN saleable_inventory ii
      ON ii.avatar_id = 'enzo' AND ii.item_name = l.item_name COLLATE NOCASE
    LEFT JOIN market_current mc ON mc.item_name = l.item_name COLLATE NOCASE
    WHERE l.enabled = 1 AND l.storage = ? COLLATE NOCASE AND l.aisle = ? COLLATE NOCASE
    GROUP BY l.item_name, l.storage, l.aisle, mc.weighted_kind, mc.weighted_value, mc.observed_at
    HAVING SUM(ii.quantity) > 0
  `).bind(String(storage || ""), String(aisle || "")).all();
  return result.results;
}

async function readAllPromotableItems(env) {
  const result = await env.DB.prepare(`
    SELECT l.item_name AS itemName, l.storage AS storage, l.aisle AS aisle,
           SUM(ii.quantity) AS quantity,
           CASE WHEN datetime(mc.observed_at) >= datetime('now', '-7 days') THEN mc.weighted_kind ELSE NULL END AS markupKind,
           CASE WHEN datetime(mc.observed_at) >= datetime('now', '-7 days') THEN mc.weighted_value ELSE NULL END AS markupValue
    FROM catalog_listings l
    JOIN saleable_inventory ii
      ON ii.avatar_id = 'enzo' AND ii.item_name = l.item_name COLLATE NOCASE
    LEFT JOIN market_current mc ON mc.item_name = l.item_name COLLATE NOCASE
    WHERE l.enabled = 1
    GROUP BY l.item_name, l.storage, l.aisle, mc.weighted_kind, mc.weighted_value, mc.observed_at
    HAVING SUM(ii.quantity) > 0
  `).all();
  return result.results;
}

async function readCampaignRows(env) {
  const result = await env.DB.prepare(`
    SELECT id, campaign_type, starts_on, ends_on, storage, aisle,
           discount_rate, enabled, origin, created_at, updated_at
    FROM discount_campaigns
  `).all();
  return result.results.map(mapDiscountCampaign);
}

async function insertCampaign(env, campaign) {
  await env.DB.prepare(`
    INSERT INTO discount_campaigns (
      id, campaign_type, starts_on, ends_on, storage, aisle,
      discount_rate, enabled, origin, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    campaign.id, campaign.type, campaign.startsOn, campaign.endsOn,
    campaign.storage, campaign.aisle, campaign.discountRate,
    campaign.enabled ? 1 : 0, campaign.origin, campaign.createdAt, campaign.updatedAt
  ).run();
}

async function readCampaign(env, id) {
  const row = await env.DB.prepare(`
    SELECT id, campaign_type, starts_on, ends_on, storage, aisle, discount_rate,
           enabled, origin, eligible_pair_count, candidate_pair_count,
           generation_seed, created_at, updated_at
    FROM discount_campaigns WHERE id = ?
  `).bind(id).first();
  return row ? mapDiscountCampaign(row) : null;
}

function normalizeCampaignType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (type !== "daily_promo" && type !== "sale") throw new ApiError(400, "Type de campagne invalide");
  return type;
}

function mapDiscountConfig(row) {
  return {
    automaticPromotionsEnabled: Number(row?.automatic_promotions_enabled ?? 1) === 1,
    defaultPromotionRate: Number(row?.default_promotion_rate ?? 0.05),
    selectionSeed: String(row?.selection_seed || "frj-daily-promo"),
    updatedAt: row?.updated_at || null
  };
}

function mapDiscountCampaign(row) {
  return {
    id: String(row.id),
    type: row.campaign_type,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    date: row.campaign_type === "daily_promo" ? row.starts_on : null,
    storage: row.storage || null,
    aisle: row.aisle || null,
    discountRate: Number(row.discount_rate),
    enabled: Number(row.enabled) === 1,
    origin: row.origin,
    eligiblePairCount: row.eligible_pair_count === null || row.eligible_pair_count === undefined ? null : Number(row.eligible_pair_count),
    candidatePairCount: row.candidate_pair_count === null || row.candidate_pair_count === undefined ? null : Number(row.candidate_pair_count),
    generationSeed: row.generation_seed || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}
