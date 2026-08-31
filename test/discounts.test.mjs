import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  addDiscountDays,
  DAILY_PROMO_COOLDOWN_DAYS,
  DAILY_PROMO_MINIMUM_ELIGIBLE_PAIRS,
  DISCOUNT_TIME_ZONE,
  collectEligiblePromotionPairs,
  computeDiscountedMarkup,
  planDailyPromotion,
  resolveActiveDiscount,
  validateDailyPromotionChange,
  validateSaleChange
} from "../cloudflare/for-sale-api/src/discounts.js";

const gasContext = { Array, Date, Error, JSON, Map, Math, Number, Object, Set, String };
vm.createContext(gasContext);
vm.runInContext(fs.readFileSync(new URL("../gas/Discounts.gs", import.meta.url), "utf8"), gasContext);

const plain = (value) => JSON.parse(JSON.stringify(value));
const item = (index, overrides = {}) => ({
  itemName: `Item ${index}`,
  storage: `Category ${index}`,
  aisle: `Aisle ${index}`,
  quantity: 1,
  markupKind: "percent",
  markupValue: 1.1,
  ...overrides
});
const sevenPairs = () => Array.from({ length: 7 }, (_, index) => item(index + 1));

test("d.9.1 fixe le contrat à sept couples et au fuseau de Paris", () => {
  assert.equal(DAILY_PROMO_MINIMUM_ELIGIBLE_PAIRS, 7);
  assert.equal(DAILY_PROMO_COOLDOWN_DAYS, 7);
  assert.equal(DISCOUNT_TIME_ZONE, "Europe/Paris");
  assert.deepEqual(plain(gasContext.FRJ_DISCOUNT_CONFIG), {
    timeZone: "Europe/Paris",
    minimumEligiblePairs: 7,
    cooldownDays: 7
  });
});

test("T-005 calcule demain sans erreur aux changements de mois et d'année", () => {
  assert.equal(addDiscountDays("2026-08-31", 1), "2026-09-01");
  assert.equal(addDiscountDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDiscountDays("2028-02-28", 1), "2028-02-29");
  assert.equal(gasContext.frjAddDiscountDays_("2026-12-31", 1), "2027-01-01");
});

test("un couple exige au moins un article en stock avec un MU valide", () => {
  const pairs = collectEligiblePromotionPairs([
    item(1),
    item(1, { itemName: "Second", quantity: 2, markupKind: "ped", markupValue: 0.5 }),
    item(2, { quantity: 0 }),
    item(3, { markupKind: "none", markupValue: null }),
    item(4, { markupKind: "percent", markupValue: 0.95 }),
    item(5, { markupKind: "ped", markupValue: -0.01 })
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].promotableItems, 2);
});

test("sept articles dont deux MU invalides ne représentent que cinq couples éligibles", () => {
  const items = sevenPairs();
  items[5].markupKind = "none";
  items[5].markupValue = null;
  items[6].markupValue = 0.9;
  const result = planDailyPromotion({ date: "2026-08-29", items });
  assert.equal(result.reason, "INSUFFICIENT_ELIGIBLE_PAIRS");
  assert.equal(result.eligiblePairCount, 5);
  assert.equal(result.campaign, null);
});

test("sept couples éligibles permettent un tirage reproductible", () => {
  const options = { date: "2026-08-29", items: sevenPairs(), defaultRate: 0.05, seed: "rotation-1" };
  const first = planDailyPromotion(options);
  const second = planDailyPromotion({ ...options, items: [...options.items].reverse() });
  assert.equal(first.reason, "GENERATED");
  assert.equal(first.eligiblePairCount, 7);
  assert.equal(first.candidatePairCount, 7);
  assert.deepEqual(second, first);
});

test("le taux automatique vaut 5 % sans confirmation Admin", () => {
  const result = planDailyPromotion({ date: "2026-08-29", items: sevenPairs() });
  assert.equal(result.reason, "GENERATED");
  assert.equal(result.campaign.discountRate, 0.05);
  assert.equal(result.campaign.origin, "automatic");
});

test("un couple tiré à J-6 est bloqué mais redevient disponible à J-7", () => {
  const dailyPromotions = [
    { date: "2026-08-07", storage: "Category 1", aisle: "Aisle 1", discountRate: 0.05 },
    { date: "2026-08-06", storage: "Category 2", aisle: "Aisle 2", discountRate: 0.05 },
    { date: "2026-08-05", storage: "Category 3", aisle: "Aisle 3", discountRate: 0.05 },
    { date: "2026-08-04", storage: "Category 4", aisle: "Aisle 4", discountRate: 0.05 },
    { date: "2026-08-03", storage: "Category 5", aisle: "Aisle 5", discountRate: 0.05 },
    { date: "2026-08-02", storage: "Category 6", aisle: "Aisle 6", discountRate: 0.05 },
    { date: "2026-08-01", storage: "Category 7", aisle: "Aisle 7", discountRate: 0.05 }
  ];
  const result = planDailyPromotion({
    date: "2026-08-08",
    items: sevenPairs(),
    dailyPromotions,
    seed: "rotation-1"
  });
  assert.equal(result.candidatePairCount, 1);
  assert.equal(result.campaign.storage, "CATEGORY 7");
});

test("T-005 répare le jour courant sans réutiliser le couple déjà prévu demain", () => {
  const result = planDailyPromotion({
    date: "2026-08-30",
    items: sevenPairs(),
    dailyPromotions: [{
      date: "2026-08-31", storage: "Category 1", aisle: "Aisle 1", discountRate: 0.05
    }],
    seed: "rotation-1"
  });
  assert.equal(result.reason, "GENERATED");
  assert.equal(result.candidatePairCount, 6);
  assert.notEqual(result.campaign.storage, "CATEGORY 1");
  assert.deepEqual(plain(gasContext.frjPlanDailyPromotion_({
    date: "2026-08-30",
    items: sevenPairs(),
    dailyPromotions: [{
      date: "2026-08-31", storage: "Category 1", aisle: "Aisle 1", discountRate: 0.05
    }],
    seed: "rotation-1"
  })), result);
});

test("aucune promotion n'est générée pendant une période de soldes", () => {
  const result = planDailyPromotion({
    date: "2026-08-29",
    items: sevenPairs(),
    sales: [{ startsOn: "2026-08-25", endsOn: "2026-08-31", discountRate: 0.1 }]
  });
  assert.equal(result.reason, "SALE_ACTIVE");
  assert.equal(result.campaign, null);
});

test("une relance conserve la promotion déjà matérialisée", () => {
  const existing = {
    date: "2026-08-29", storage: "Armors", aisle: "Parts",
    discountRate: 0.07, origin: "automatic"
  };
  const result = planDailyPromotion({
    date: "2026-08-29",
    items: [],
    dailyPromotions: [existing]
  });
  assert.equal(result.reason, "ALREADY_GENERATED");
  assert.equal(result.campaign.discountRate, 0.07);
});

test("les soldes oblitèrent une promotion pour la résolution du tarif", () => {
  const active = resolveActiveDiscount({
    date: "2026-08-29",
    storage: "Armors",
    aisle: "Parts",
    dailyPromotions: [{ date: "2026-08-29", storage: "Armors", aisle: "Parts", discountRate: 0.05 }],
    sales: [{ startsOn: "2026-08-29", endsOn: "2026-08-30", discountRate: 0.1 }]
  });
  assert.equal(active.kind, "sale");
  assert.equal(active.discountRate, 0.1);
});

test("la remise porte sur la marge et conserve l'avantage FRJ", () => {
  assert.deepEqual(
    computeDiscountedMarkup({ kind: "percent", value: 1.2, frjMember: true, discountRate: 0.05 }),
    { kind: "percent", value: 1.095 }
  );
  assert.deepEqual(
    computeDiscountedMarkup({ kind: "ped", value: 2, frjMember: true, discountRate: 0.05 }),
    { kind: "ped", value: 0.95 }
  );
});

test("l'Admin peut modifier une promo automatique sous les mêmes contraintes", () => {
  const promotion = {
    id: "promo-1", date: "2026-08-29", storage: "Category 7", aisle: "Aisle 7",
    discountRate: 0.08, origin: "automatic", enabled: true
  };
  const validated = validateDailyPromotionChange({
    promotion,
    items: sevenPairs(),
    dailyPromotions: [{
      id: "promo-1", date: "2026-08-29", storage: "Category 1", aisle: "Aisle 1",
      discountRate: 0.05, origin: "automatic"
    }]
  });
  assert.equal(validated.storage, "CATEGORY 7");
  assert.equal(validated.discountRate, 0.08);
  assert.equal(validated.origin, "automatic");

  assert.throws(() => validateDailyPromotionChange({
    promotion,
    items: sevenPairs(),
    dailyPromotions: [{
      id: "promo-2", date: "2026-08-24", storage: "Category 7", aisle: "Aisle 7", discountRate: 0.05
    }]
  }), /fenêtre de 7 jours/);
});

test("l'Admin ne peut activer ni un couple inéligible ni une promo sous soldes", () => {
  const promotion = { date: "2026-08-29", storage: "Category 7", aisle: "Aisle 7", discountRate: 0.05 };
  assert.throws(() => validateDailyPromotionChange({
    promotion,
    items: sevenPairs().slice(0, 6)
  }), /aucun article disponible/);
  assert.throws(() => validateDailyPromotionChange({
    promotion,
    items: sevenPairs(),
    sales: [{ startsOn: "2026-08-29", endsOn: "2026-08-30", discountRate: 0.1 }]
  }), /pendant les soldes/);
});

test("les soldes sont entièrement configurables par l'Admin sans chevauchement", () => {
  const sale = validateSaleChange({
    sale: { id: "sale-2", startsOn: "2026-09-01", endsOn: "2026-09-07", discountRate: 0.15 },
    sales: [{ id: "sale-1", startsOn: "2026-08-25", endsOn: "2026-08-31", discountRate: 0.1 }]
  });
  assert.equal(sale.discountRate, 0.15);
  assert.throws(() => validateSaleChange({
    sale: { startsOn: "2026-08-31", endsOn: "2026-09-03", discountRate: 0.15 },
    sales: [{ startsOn: "2026-08-25", endsOn: "2026-08-31", discountRate: 0.1 }]
  }), /ne peuvent pas se chevaucher/);
});

test("GAS et le Worker produisent exactement le même tirage et le même tarif", () => {
  const planningOptions = {
    date: "2026-08-29",
    items: sevenPairs(),
    dailyPromotions: [{ date: "2026-08-28", storage: "Category 1", aisle: "Aisle 1", discountRate: 0.05 }],
    defaultRate: 0.08,
    seed: "rotation-partagée"
  };
  assert.deepEqual(
    plain(gasContext.frjPlanDailyPromotion_(planningOptions)),
    planDailyPromotion(planningOptions)
  );
  assert.deepEqual(
    plain(gasContext.frjComputeDiscountedMarkup_({
      kind: "percent", value: 1.25, frjMember: true, discountRate: 0.08
    })),
    computeDiscountedMarkup({ kind: "percent", value: 1.25, frjMember: true, discountRate: 0.08 })
  );
});
