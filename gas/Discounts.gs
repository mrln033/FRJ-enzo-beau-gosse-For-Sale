var FRJ_DISCOUNT_CONFIG = Object.freeze({
  timeZone: "Europe/Paris",
  minimumEligiblePairs: 7,
  cooldownDays: 7
});

function frjIsValidPromotionMarkup_(kind, rawValue) {
  var value = frjDiscountOptionalNumber_(rawValue);
  if (value === null) return false;
  if (kind === "percent") return value >= 1;
  if (kind === "ped") return value >= 0;
  return false;
}

function frjCollectEligiblePromotionPairs_(items) {
  var pairs = {};
  (Array.isArray(items) ? items : []).forEach(function(item) {
    var storage = frjNormalizePromotionPairPart_(item && item.storage);
    var aisle = frjNormalizePromotionPairPart_(item && item.aisle);
    var quantity = frjPromotionAvailableQuantity_(item);
    if (!storage || !aisle || quantity <= 0) return;
    if (!frjIsValidPromotionMarkup_(item && item.markupKind, item && item.markupValue)) return;

    var key = frjPromotionPairKey_(storage, aisle);
    if (!pairs[key]) pairs[key] = { key: key, storage: storage, aisle: aisle, promotableItems: 0 };
    pairs[key].promotableItems += 1;
  });
  return Object.keys(pairs).map(function(key) { return pairs[key]; }).sort(function(left, right) {
    return left.key < right.key ? -1 : (left.key > right.key ? 1 : 0);
  });
}

function frjResolveActiveDiscount_(options) {
  var businessDate = frjNormalizeDiscountDate_(options.date);
  var sales = Array.isArray(options.sales) ? options.sales : [];
  var activeSales = sales.filter(function(sale) { return sale && sale.enabled !== false; })
    .map(frjNormalizeSale_)
    .filter(function(sale) { return sale.startsOn <= businessDate && sale.endsOn >= businessDate; });
  if (activeSales.length > 1) throw new Error("Plusieurs périodes de soldes se chevauchent le " + businessDate);
  if (activeSales.length === 1) return Object.assign({ kind: "sale" }, activeSales[0]);

  var pairKey = frjPromotionPairKey_(options.storage, options.aisle);
  var promotions = Array.isArray(options.dailyPromotions) ? options.dailyPromotions : [];
  var activePromotions = promotions.filter(function(promotion) { return promotion && promotion.enabled !== false; })
    .map(frjNormalizeDailyPromotion_)
    .filter(function(promotion) { return promotion.date === businessDate && promotion.key === pairKey; });
  if (activePromotions.length > 1) throw new Error("Plusieurs promotions ciblent le même couple le " + businessDate);
  return activePromotions.length === 1
    ? Object.assign({ kind: "daily_promo" }, activePromotions[0])
    : null;
}

function frjValidateDailyPromotionChange_(options) {
  var promotion = options.promotion;
  var normalized = frjNormalizeDailyPromotion_(promotion);
  var enabled = !promotion || promotion.enabled !== false;
  if (!enabled) return Object.assign({}, normalized, { enabled: false });

  var sale = frjResolveActiveDiscount_({ date: normalized.date, sales: options.sales || [] });
  if (sale && sale.kind === "sale") {
    throw new Error("Une promotion ne peut pas être activée pendant les soldes du " + normalized.date);
  }

  var eligibleKeys = {};
  frjCollectEligiblePromotionPairs_(options.items || []).forEach(function(pair) { eligibleKeys[pair.key] = true; });
  if (!eligibleKeys[normalized.key]) {
    throw new Error("Le couple choisi ne contient aucun article disponible avec un MU valide");
  }

  var promotionId = String(promotion && promotion.id || "");
  var collision = (Array.isArray(options.dailyPromotions) ? options.dailyPromotions : [])
    .filter(function(other) {
      return other && other.enabled !== false && (!promotionId || String(other.id || "") !== promotionId);
    })
    .map(frjNormalizeDailyPromotion_)
    .find(function(other) {
      return other.key === normalized.key
        && Math.abs(frjDifferenceInDiscountDays_(other.date, normalized.date)) < FRJ_DISCOUNT_CONFIG.cooldownDays;
    });
  if (collision) throw new Error("Ce couple est déjà utilisé dans la fenêtre de 7 jours (" + collision.date + ")");
  return Object.assign({}, normalized, { enabled: true });
}

function frjValidateSaleChange_(options) {
  var sale = options.sale;
  var normalized = frjNormalizeSale_(sale);
  var enabled = !sale || sale.enabled !== false;
  if (!enabled) return Object.assign({}, normalized, { enabled: false });

  var saleId = String(sale && sale.id || "");
  var overlap = (Array.isArray(options.sales) ? options.sales : [])
    .filter(function(other) {
      return other && other.enabled !== false && (!saleId || String(other.id || "") !== saleId);
    })
    .map(frjNormalizeSale_)
    .find(function(other) {
      return other.startsOn <= normalized.endsOn && other.endsOn >= normalized.startsOn;
    });
  if (overlap) throw new Error("Deux périodes de soldes actives ne peuvent pas se chevaucher");
  return Object.assign({}, normalized, { enabled: true });
}

function frjComputeDiscountedMarkup_(options) {
  if (!frjIsValidPromotionMarkup_(options.kind, options.value)) return { kind: "none", value: null };
  var rate = frjNormalizeDiscountRate_(options.discountRate === undefined ? 0 : options.discountRate, true);
  var profileFactor = options.frjMember === true ? 0.5 : 1;
  var campaignFactor = 1 - rate;
  return options.kind === "percent"
    ? { kind: options.kind, value: 1 + ((Number(options.value) - 1) * profileFactor * campaignFactor) }
    : { kind: options.kind, value: Number(options.value) * profileFactor * campaignFactor };
}

function frjPlanDailyPromotion_(options) {
  options = options || {};
  var businessDate = frjNormalizeDiscountDate_(options.date);
  var rate = frjNormalizeDiscountRate_(options.defaultRate === undefined ? 0.05 : options.defaultRate, false);
  var activeSale = frjResolveActiveDiscount_({ date: businessDate, sales: options.sales || [] });
  if (activeSale && activeSale.kind === "sale") {
    return frjPromotionPlanResult_("SALE_ACTIVE", businessDate, 0, 0, null);
  }

  var promotions = (Array.isArray(options.dailyPromotions) ? options.dailyPromotions : [])
    .filter(function(promotion) { return promotion && promotion.enabled !== false; })
    .map(frjNormalizeDailyPromotion_);
  var existing = promotions.find(function(promotion) { return promotion.date === businessDate; });
  if (existing) {
    return frjPromotionPlanResult_("ALREADY_GENERATED", businessDate, 0, 0, {
      type: "daily_promo",
      date: businessDate,
      storage: existing.storage,
      aisle: existing.aisle,
      discountRate: existing.discountRate,
      origin: existing.origin
    });
  }

  var eligiblePairs = frjCollectEligiblePromotionPairs_(options.items || []);
  if (eligiblePairs.length < FRJ_DISCOUNT_CONFIG.minimumEligiblePairs) {
    return frjPromotionPlanResult_("INSUFFICIENT_ELIGIBLE_PAIRS", businessDate, eligiblePairs.length, 0, null);
  }

  var blockedKeys = {};
  promotions.forEach(function(promotion) {
    var age = frjDifferenceInDiscountDays_(promotion.date, businessDate);
    if (age >= 1 && age < FRJ_DISCOUNT_CONFIG.cooldownDays) blockedKeys[promotion.key] = true;
  });
  var candidates = eligiblePairs.filter(function(pair) { return !blockedKeys[pair.key]; });
  if (candidates.length === 0) {
    return frjPromotionPlanResult_("NO_AVAILABLE_PAIR_AFTER_COOLDOWN", businessDate, eligiblePairs.length, 0, null);
  }

  var seed = options.seed === undefined ? "frj-daily-promo" : String(options.seed);
  var material = [businessDate, seed].concat(candidates.map(function(pair) { return pair.key; })).join("\u001e");
  var selected = candidates[frjStablePromotionHash_(material) % candidates.length];
  return frjPromotionPlanResult_("GENERATED", businessDate, eligiblePairs.length, candidates.length, {
    type: "daily_promo",
    date: businessDate,
    storage: selected.storage,
    aisle: selected.aisle,
    discountRate: rate,
    origin: "automatic"
  });
}

function frjPromotionPlanResult_(reason, date, eligiblePairCount, candidatePairCount, campaign) {
  return { reason: reason, date: date, eligiblePairCount: eligiblePairCount, candidatePairCount: candidatePairCount, campaign: campaign };
}

function frjNormalizeSale_(sale) {
  var startsOn = frjNormalizeDiscountDate_(sale && (sale.startsOn || sale.startDate));
  var endsOn = frjNormalizeDiscountDate_(sale && (sale.endsOn || sale.endDate));
  if (endsOn < startsOn) throw new Error("La fin des soldes précède leur début");
  return {
    startsOn: startsOn,
    endsOn: endsOn,
    discountRate: frjNormalizeDiscountRate_(sale && sale.discountRate, false),
    origin: String(sale && sale.origin || "manual")
  };
}

function frjNormalizeDailyPromotion_(promotion) {
  var storage = frjNormalizePromotionPairPart_(promotion && promotion.storage);
  var aisle = frjNormalizePromotionPairPart_(promotion && promotion.aisle);
  if (!storage || !aisle) throw new Error("Couple catégorie/rayon incomplet");
  return {
    date: frjNormalizeDiscountDate_(promotion && (promotion.date || promotion.promotionDate || promotion.startsOn)),
    storage: storage,
    aisle: aisle,
    key: frjPromotionPairKey_(storage, aisle),
    discountRate: frjNormalizeDiscountRate_(promotion && promotion.discountRate, false),
    origin: String(promotion && promotion.origin || "manual")
  };
}

function frjNormalizeDiscountRate_(rawValue, allowZero) {
  var value = frjDiscountOptionalNumber_(rawValue);
  var minimum = allowZero ? 0 : Number.EPSILON;
  if (value === null || value < minimum || value > 1) throw new Error("Le taux de remise doit être compris entre 0 et 1");
  return value;
}

function frjNormalizeDiscountDate_(rawValue) {
  var value = String(rawValue || "").trim();
  var match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("Date métier invalide : " + (value || "absente"));
  var date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) throw new Error("Date métier invalide : " + value);
  return value;
}

function frjDifferenceInDiscountDays_(earlier, later) {
  return (Date.parse(later + "T00:00:00Z") - Date.parse(earlier + "T00:00:00Z")) / 86400000;
}

function frjNormalizePromotionPairPart_(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function frjPromotionPairKey_(storage, aisle) {
  return frjNormalizePromotionPairPart_(storage) + "\u001f" + frjNormalizePromotionPairPart_(aisle);
}

function frjPromotionAvailableQuantity_(item) {
  var value = item && item.availableQuantity !== undefined ? item.availableQuantity
    : (item && item.stock !== undefined ? item.stock : (item && item.quantity));
  var number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function frjDiscountOptionalNumber_(value) {
  if (value === null || value === undefined || value === "") return null;
  var number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function frjStablePromotionHash_(value) {
  var hash = 0x811c9dc5;
  for (var index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
