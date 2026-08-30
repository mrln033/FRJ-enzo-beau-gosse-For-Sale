export const DISCOUNT_TIME_ZONE = "Europe/Paris";
export const DAILY_PROMO_MINIMUM_ELIGIBLE_PAIRS = 7;
export const DAILY_PROMO_COOLDOWN_DAYS = 7;

export function businessDateInParis(value = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: DISCOUNT_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isValidPromotionMarkup(kind, rawValue) {
  const value = optionalNumber(rawValue);
  if (value === null) return false;
  if (kind === "percent") return value >= 1;
  if (kind === "ped") return value >= 0;
  return false;
}

export function collectEligiblePromotionPairs(items) {
  const pairs = new Map();

  (Array.isArray(items) ? items : []).forEach((item) => {
    const storage = normalizePairPart(item?.storage);
    const aisle = normalizePairPart(item?.aisle);
    const quantity = availableQuantity(item);
    if (!storage || !aisle || quantity <= 0) return;
    if (!isValidPromotionMarkup(item?.markupKind, item?.markupValue)) return;

    const key = promotionPairKey(storage, aisle);
    if (!pairs.has(key)) {
      pairs.set(key, { key, storage, aisle, promotableItems: 0 });
    }
    pairs.get(key).promotableItems += 1;
  });

  return [...pairs.values()].sort((left, right) => left.key < right.key ? -1 : (left.key > right.key ? 1 : 0));
}

export function resolveActiveDiscount({ date, sales = [], dailyPromotions = [], storage, aisle }) {
  const businessDate = normalizeIsoDate(date);
  const activeSales = sales
    .filter((sale) => sale && sale.enabled !== false)
    .map(normalizeSale)
    .filter((sale) => sale.startsOn <= businessDate && sale.endsOn >= businessDate);

  if (activeSales.length > 1) {
    throw new Error(`Plusieurs périodes de soldes se chevauchent le ${businessDate}`);
  }
  if (activeSales.length === 1) {
    return { kind: "sale", ...activeSales[0] };
  }

  const pairKey = promotionPairKey(storage, aisle);
  const activePromotions = dailyPromotions
    .filter((promotion) => promotion && promotion.enabled !== false)
    .map(normalizeDailyPromotion)
    .filter((promotion) => promotion.date === businessDate && promotion.key === pairKey);

  if (activePromotions.length > 1) {
    throw new Error(`Plusieurs promotions ciblent le même couple le ${businessDate}`);
  }
  return activePromotions.length === 1
    ? { kind: "daily_promo", ...activePromotions[0] }
    : null;
}

export function validateDailyPromotionChange({ promotion, dailyPromotions = [], items = [], sales = [] }) {
  const normalized = normalizeDailyPromotion(promotion);
  const enabled = promotion?.enabled !== false;
  if (!enabled) return { ...normalized, enabled: false };

  const sale = resolveActiveDiscount({ date: normalized.date, sales });
  if (sale?.kind === "sale") {
    throw new Error(`Une promotion ne peut pas être activée pendant les soldes du ${normalized.date}`);
  }

  const eligibleKeys = new Set(collectEligiblePromotionPairs(items).map((pair) => pair.key));
  if (!eligibleKeys.has(normalized.key)) {
    throw new Error("Le couple choisi ne contient aucun article disponible avec un MU valide");
  }

  const promotionId = String(promotion?.id || "");
  const collision = (Array.isArray(dailyPromotions) ? dailyPromotions : [])
    .filter((other) => other && other.enabled !== false
      && (!promotionId || String(other.id || "") !== promotionId))
    .map(normalizeDailyPromotion)
    .find((other) => other.key === normalized.key
      && Math.abs(differenceInCalendarDays(other.date, normalized.date)) < DAILY_PROMO_COOLDOWN_DAYS);
  if (collision) {
    throw new Error(`Ce couple est déjà utilisé dans la fenêtre de 7 jours (${collision.date})`);
  }
  return { ...normalized, enabled: true };
}

export function validateSaleChange({ sale, sales = [] }) {
  const normalized = normalizeSale(sale);
  const enabled = sale?.enabled !== false;
  if (!enabled) return { ...normalized, enabled: false };

  const saleId = String(sale?.id || "");
  const overlap = (Array.isArray(sales) ? sales : [])
    .filter((other) => other && other.enabled !== false
      && (!saleId || String(other.id || "") !== saleId))
    .map(normalizeSale)
    .find((other) => other.startsOn <= normalized.endsOn && other.endsOn >= normalized.startsOn);
  if (overlap) throw new Error("Deux périodes de soldes actives ne peuvent pas se chevaucher");
  return { ...normalized, enabled: true };
}

export function computeDiscountedMarkup({ kind, value, frjMember = false, discountRate = 0 }) {
  if (!isValidPromotionMarkup(kind, value)) return { kind: "none", value: null };
  const rate = normalizeDiscountRate(discountRate, true);
  const profileFactor = frjMember === true ? 0.5 : 1;
  const campaignFactor = 1 - rate;
  return kind === "percent"
    ? { kind, value: 1 + ((Number(value) - 1) * profileFactor * campaignFactor) }
    : { kind, value: Number(value) * profileFactor * campaignFactor };
}

export function planDailyPromotion({
  date,
  items = [],
  dailyPromotions = [],
  sales = [],
  defaultRate = 0.05,
  seed = "frj-daily-promo"
}) {
  const businessDate = normalizeIsoDate(date);
  const rate = normalizeDiscountRate(defaultRate, false);
  const activeSale = resolveActiveDiscount({ date: businessDate, sales });
  if (activeSale?.kind === "sale") {
    return planResult("SALE_ACTIVE", businessDate, 0, 0, null);
  }

  const normalizedPromotions = (Array.isArray(dailyPromotions) ? dailyPromotions : [])
    .filter((promotion) => promotion && promotion.enabled !== false)
    .map(normalizeDailyPromotion);
  const existing = normalizedPromotions.find((promotion) => promotion.date === businessDate);
  if (existing) {
    return planResult("ALREADY_GENERATED", businessDate, 0, 0, {
      type: "daily_promo",
      date: businessDate,
      storage: existing.storage,
      aisle: existing.aisle,
      discountRate: existing.discountRate,
      origin: existing.origin
    });
  }

  const eligiblePairs = collectEligiblePromotionPairs(items);
  if (eligiblePairs.length < DAILY_PROMO_MINIMUM_ELIGIBLE_PAIRS) {
    return planResult("INSUFFICIENT_ELIGIBLE_PAIRS", businessDate, eligiblePairs.length, 0, null);
  }

  const blockedKeys = new Set(normalizedPromotions
    .filter((promotion) => {
      const age = differenceInCalendarDays(promotion.date, businessDate);
      return age >= 1 && age < DAILY_PROMO_COOLDOWN_DAYS;
    })
    .map((promotion) => promotion.key));
  const candidates = eligiblePairs.filter((pair) => !blockedKeys.has(pair.key));

  if (candidates.length === 0) {
    return planResult("NO_AVAILABLE_PAIR_AFTER_COOLDOWN", businessDate, eligiblePairs.length, 0, null);
  }

  const selectionMaterial = [businessDate, String(seed), ...candidates.map((pair) => pair.key)].join("\u001e");
  const selected = candidates[stableHash(selectionMaterial) % candidates.length];
  return planResult("GENERATED", businessDate, eligiblePairs.length, candidates.length, {
    type: "daily_promo",
    date: businessDate,
    storage: selected.storage,
    aisle: selected.aisle,
    discountRate: rate,
    origin: "automatic"
  });
}

function planResult(reason, date, eligiblePairCount, candidatePairCount, campaign) {
  return { reason, date, eligiblePairCount, candidatePairCount, campaign };
}

function normalizeSale(sale) {
  const startsOn = normalizeIsoDate(sale?.startsOn ?? sale?.startDate);
  const endsOn = normalizeIsoDate(sale?.endsOn ?? sale?.endDate);
  if (endsOn < startsOn) throw new Error("La fin des soldes précède leur début");
  return {
    startsOn,
    endsOn,
    discountRate: normalizeDiscountRate(sale?.discountRate, false),
    origin: String(sale?.origin || "manual")
  };
}

function normalizeDailyPromotion(promotion) {
  const storage = normalizePairPart(promotion?.storage);
  const aisle = normalizePairPart(promotion?.aisle);
  if (!storage || !aisle) throw new Error("Couple catégorie/rayon incomplet");
  return {
    date: normalizeIsoDate(promotion?.date ?? promotion?.promotionDate ?? promotion?.startsOn),
    storage,
    aisle,
    key: promotionPairKey(storage, aisle),
    discountRate: normalizeDiscountRate(promotion?.discountRate, false),
    origin: String(promotion?.origin || "manual")
  };
}

function normalizeDiscountRate(rawValue, allowZero) {
  const value = optionalNumber(rawValue);
  const minimum = allowZero ? 0 : Number.EPSILON;
  if (value === null || value < minimum || value > 1) {
    throw new Error("Le taux de remise doit être compris entre 0 et 1");
  }
  return value;
}

function normalizeIsoDate(rawValue) {
  const value = String(rawValue || "").trim();
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Date métier invalide : ${value || "absente"}`);
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(timestamp);
  if (date.toISOString().slice(0, 10) !== value) throw new Error(`Date métier invalide : ${value}`);
  return value;
}

function differenceInCalendarDays(earlier, later) {
  return (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000;
}

function normalizePairPart(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function promotionPairKey(storage, aisle) {
  return `${normalizePairPart(storage)}\u001f${normalizePairPart(aisle)}`;
}

function availableQuantity(item) {
  const value = item?.availableQuantity ?? item?.stock ?? item?.quantity;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
