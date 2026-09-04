const ORDER_STATUSES = new Set([
  "submitted", "viewed", "preparing", "ready", "completed", "cancelled", "expired"
]);
const EDITABLE_ORDER_STATUSES = new Set(["submitted", "viewed"]);
const CLIENT_CANCELLABLE_STATUSES = new Set(["submitted", "viewed"]);
const PRICE_CONFIRMING_ORDER_STATUSES = new Set(["preparing", "ready", "completed"]);

export function canReviseOrder(status, approvalRequired = false) {
  return approvalRequired === true || Number(approvalRequired || 0) === 1
    || EDITABLE_ORDER_STATUSES.has(String(status || "").trim().toLowerCase());
}

export function canClientCancelOrder(status, approvalRequired = false) {
  return approvalRequired === true || Number(approvalRequired || 0) === 1
    || CLIENT_CANCELLABLE_STATUSES.has(String(status || "").trim().toLowerCase());
}

export function confirmsOrderPricing(status) {
  return PRICE_CONFIRMING_ORDER_STATUSES.has(String(status || "").trim().toLowerCase());
}

export function normalizeOrderSubmission(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Demande d'achat invalide");
  }

  const id = String(payload.id || "").trim().toLowerCase();
  const publicReference = String(payload.publicReference || "").trim().toUpperCase();
  const accessToken = String(payload.accessToken || "").trim();
  const buyerAvatar = cleanText(payload.buyerAvatar, 80);
  const buyerContact = cleanOptionalText(payload.buyerContact, 160);
  const buyerComment = cleanOptionalText(payload.buyerComment, 800);
  const language = String(payload.language || "EN").trim().toUpperCase() === "FR" ? "FR" : "EN";
  const frjMember = payload.frjMember === true && language === "FR";
  const clientCreatedAt = normalizeOptionalDate(payload.clientCreatedAt);
  const honeypot = String(payload.website || "").trim();

  if (honeypot) throw new Error("Demande refusée");
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Identifiant de demande invalide");
  if (!/^FRJ-\d{8}-[A-F0-9]{6}$/.test(publicReference)) throw new Error("Référence de demande invalide");
  if (!/^[a-f0-9-]{70,80}$/i.test(accessToken)) throw new Error("Jeton de suivi invalide");
  if (!buyerAvatar) throw new Error("L'avatar en jeu est obligatoire");

  const sourceItems = Array.isArray(payload.items) ? payload.items : [];
  if (sourceItems.length < 1 || sourceItems.length > 10) {
    throw new Error("Le panier doit contenir entre 1 et 10 articles");
  }

  const items = sourceItems.map((item) => {
    const itemName = cleanText(item?.itemName, 180);
    const storage = cleanText(item?.storage, 80).toUpperCase();
    const aisle = cleanText(item?.aisle, 120).toUpperCase();
    const quantity = Number(item?.quantity);
    if (!itemName || !storage || !aisle) throw new Error("Article de panier incomplet");
    validateOrderQuantity(quantity, itemName);
    const observedUnitTtPed = optionalNumber(item?.unitTtPed);
    const observedMarkupKind = normalizeMarkupKind(item?.markupKind);
    const observedMarkupValue = observedMarkupKind === "none" ? null : optionalNumber(item?.markupValue);
    const observedDiscountKind = ["daily_promo", "sale"].includes(item?.discountKind) ? item.discountKind : null;
    const observedDiscountCampaignId = cleanOptionalText(item?.discountCampaignId, 180);
    const observedDiscountRate = optionalNumber(item?.discountRate);
    return {
      itemName, storage, aisle, quantity,
      observedUnitTtPed,
      observedMarkupKind,
      observedMarkupValue, observedDiscountKind, observedDiscountCampaignId, observedDiscountRate
    };
  });

  return {
    id, publicReference, accessToken, buyerAvatar, buyerContact, buyerComment,
    language, frjMember, clientCreatedAt, items
  };
}

export function normalizeAdminOrderDraft(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Demande directe invalide");
  }
  const buyerAvatar = cleanText(payload.buyerAvatar, 80);
  if (!buyerAvatar) throw new Error("L'avatar en jeu est obligatoire");
  const sourceItems = Array.isArray(payload.items) ? payload.items : [];
  if (sourceItems.length < 1 || sourceItems.length > 10) {
    throw new Error("La demande directe doit contenir entre 1 et 10 articles");
  }
  const items = sourceItems.map(normalizeAdminOrderLine);
  const keys = new Set(items.map(orderItemKey));
  if (keys.size !== items.length) throw new Error("Un article ne peut apparaître qu'une seule fois");
  return {
    buyerAvatar,
    frjMember: payload.frjMember === true,
    items
  };
}

export function normalizeAdminOrderLine(payload) {
  const itemName = cleanText(payload?.itemName, 180);
  const storage = cleanText(payload?.storage, 80).toUpperCase();
  const aisle = cleanText(payload?.aisle, 120).toUpperCase();
  const quantity = Number(payload?.quantity);
  if (!itemName || !storage || !aisle) throw new Error("Article de demande directe incomplet");
  validateOrderQuantity(quantity, itemName);
  const markupKind = String(payload?.markupKind || "").trim().toLowerCase();
  if (!["percent", "ped"].includes(markupKind)) throw new Error(`Type de MU invalide pour ${itemName}`);
  const markupAmount = Number(payload?.markupAmount);
  if (!Number.isFinite(markupAmount) || markupAmount < 0 || markupAmount > 1_000_000) {
    throw new Error(`MU invalide pour ${itemName}`);
  }
  if (!hasAtMostDecimals(markupAmount, 2)) {
    throw new Error(`La MU de ${itemName} est limitée à 2 décimales`);
  }
  return { itemName, storage, aisle, quantity, markupKind, markupAmount };
}

export function priceOrderLines(requestedItems, catalogRows, options = {}) {
  const frjMember = options.frjMember === true;
  const catalog = new Map(catalogRows.map((row) => [orderItemKey(row), row]));
  const discrepancies = [];
  const lines = [];

  requestedItems.forEach((requested, index) => {
    const current = catalog.get(orderItemKey(requested));
    if (!current) {
      discrepancies.push({
        itemName: requested.itemName,
        storage: requested.storage,
        aisle: requested.aisle,
        reason: "unavailable",
        requestedQuantity: requested.quantity,
        availableQuantity: 0
      });
      return;
    }

    const stock = Math.max(0, Number(current.stock) || 0);
    if (requested.quantity > stock) {
      discrepancies.push({
        itemName: requested.itemName,
        storage: requested.storage,
        aisle: requested.aisle,
        reason: "insufficient-stock",
        requestedQuantity: requested.quantity,
        availableQuantity: stock
      });
      return;
    }

    const unitTt = Math.max(0, Number(current.unitTtPed) || 0);
    const currentMarkupKind = normalizeMarkupKind(current.markupKind);
    // Le catalogue affiche le MU avec 2 décimales. Le panier et le serveur
    // utilisent exactement cette valeur visible, pas la précision interne D1.
    const currentMarkupValue = displayedMarkupValue(currentMarkupKind, current.markupValue);
    if (
      !sameOptionalNumber(requested.observedUnitTtPed, unitTt)
      || requested.observedMarkupKind !== currentMarkupKind
      || !sameOptionalNumber(requested.observedMarkupValue, currentMarkupValue)
      || requested.observedDiscountKind !== (current.discountKind || null)
      || requested.observedDiscountCampaignId !== (current.discountCampaignId || null)
      || !sameOptionalNumber(requested.observedDiscountRate, current.discountRate ?? null)
    ) {
      discrepancies.push({
        itemName: requested.itemName,
        storage: requested.storage,
        aisle: requested.aisle,
        reason: "price-changed",
        requestedQuantity: requested.quantity,
        availableQuantity: stock,
        unitTtPed: roundPed(unitTt),
        markupKind: currentMarkupKind,
        markupValue: currentMarkupValue,
        markupDisplay: formatMarkup(currentMarkupKind, currentMarkupValue),
        discountKind: current.discountKind || null,
        discountCampaignId: current.discountCampaignId || null,
        discountRate: current.discountRate ?? null
      });
      return;
    }
    const effectiveMarkup = applyCampaignDiscount(
      applyMemberDiscount(currentMarkupKind, currentMarkupValue, frjMember),
      current.discountRate
    );
    const prices = priceOrderLine(unitTt, requested.quantity, effectiveMarkup.kind, effectiveMarkup.value);
    lines.push({
      lineNo: index + 1,
      itemName: String(current.itemName || requested.itemName),
      storage: String(current.storage || requested.storage).toUpperCase(),
      aisle: String(current.aisle || requested.aisle).toUpperCase(),
      quantity: requested.quantity,
      stockAtSubmission: stock,
      unitTtPed: roundPed(unitTt),
      markupKind: effectiveMarkup.kind,
      markupValue: effectiveMarkup.value,
      markupDisplay: formatMarkup(effectiveMarkup.kind, effectiveMarkup.value),
      baseMarkupKind: currentMarkupKind,
      baseMarkupValue: currentMarkupValue,
      discountKind: current.discountKind || null,
      discountCampaignId: current.discountCampaignId || null,
      discountRate: current.discountRate ?? null,
      unitSalePed: prices.unitSalePed,
      lineTtPed: prices.lineTtPed,
      lineSalePed: prices.lineSalePed,
      priceStatus: effectiveMarkup.kind === "none" ? "to-confirm" : "estimated"
    });
  });

  return {
    lines,
    discrepancies,
    totalTtPed: roundPed(lines.reduce((sum, line) => sum + line.lineTtPed, 0)),
    totalSalePed: roundPed(lines.reduce((sum, line) => sum + line.lineSalePed, 0)),
    pricingStatus: lines.some((line) => line.priceStatus === "to-confirm") ? "to-confirm" : "estimated"
  };
}

export function validateOrderStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!ORDER_STATUSES.has(normalized)) throw new Error("Statut de demande invalide");
  return normalized;
}

export function reviseOrderLine(existingLine, payload, availableStock) {
  const itemName = String(existingLine?.itemName || existingLine?.item_name || "Article");
  const quantity = Number(payload?.quantity);
  const stock = Math.max(0, Number(availableStock) || 0);
  validateOrderQuantity(quantity, itemName);
  if (quantity > stock) {
    throw new Error(`Stock insuffisant pour ${itemName} (${stock} disponible)`);
  }

  const markupKind = normalizeMarkupKind(payload?.markupKind);
  const rawAmount = markupKind === "none" ? null : Number(payload?.markupAmount);
  if (markupKind !== "none" && (!Number.isFinite(rawAmount) || rawAmount < 0 || rawAmount > 1_000_000)) {
    throw new Error(`MU invalide pour ${itemName}`);
  }
  if (markupKind !== "none" && !hasAtMostDecimals(rawAmount, 6)) {
    throw new Error(`La MU de ${itemName} est limitée à 6 décimales`);
  }
  // Une saisie en pourcentage à 6 décimales nécessite 8 décimales une fois
  // convertie en coefficient (115,123456 % devient 1,15123456).
  const markupValue = markupKind === "percent"
    ? roundPed(rawAmount / 100, 8)
    : (markupKind === "ped" ? roundPed(rawAmount, 6) : null);
  const unitTtPed = Math.max(0, Number(existingLine?.unitTtPed ?? existingLine?.unit_tt_ped) || 0);
  const prices = priceOrderLine(unitTtPed, quantity, markupKind, markupValue);

  return {
    quantity,
    stockAtSubmission: stock,
    markupKind,
    markupValue,
    markupDisplay: formatMarkup(markupKind, markupValue),
    unitSalePed: prices.unitSalePed,
    lineTtPed: prices.lineTtPed,
    lineSalePed: prices.lineSalePed,
    priceStatus: markupKind === "none" ? "to-confirm" : "estimated"
  };
}

export function hasSameOrderTerms(existingLine, revisedLine) {
  const existingMarkup = existingLine?.markup_value ?? existingLine?.markupValue;
  const revisedMarkup = revisedLine?.markupValue ?? revisedLine?.markup_value;
  const sameMarkupValue = revisedMarkup === null || revisedMarkup === undefined
    ? existingMarkup === null || existingMarkup === undefined
    : existingMarkup !== null && existingMarkup !== undefined
      && Math.abs(Number(existingMarkup) - Number(revisedMarkup)) <= 1e-9;
  return Number(existingLine?.quantity) === Number(revisedLine?.quantity)
    && String(existingLine?.markup_kind ?? existingLine?.markupKind ?? "none")
      === String(revisedLine?.markupKind ?? revisedLine?.markup_kind ?? "none")
    && sameMarkupValue;
}

export function orderItemKey(row) {
  return [row?.itemName, row?.storage, row?.aisle]
    .map((value) => String(value || "").trim().toLocaleLowerCase("en-US"))
    .join("\u001f");
}

function applyMemberDiscount(kind, rawValue, member) {
  const normalizedKind = normalizeMarkupKind(kind);
  const value = Number(rawValue);
  if (normalizedKind === "none" || !Number.isFinite(value)) return { kind: "none", value: null };
  if (!member) return { kind: normalizedKind, value };
  return normalizedKind === "percent"
    ? { kind: "percent", value: 1 + ((value - 1) / 2) }
    : { kind: "ped", value: value / 2 };
}

function applyCampaignDiscount(markup, rawRate) {
  const rate = optionalNumber(rawRate);
  if (rate === null || rate <= 0 || rate > 1 || markup.kind === "none") return markup;
  return markup.kind === "percent"
    ? { kind: "percent", value: 1 + ((markup.value - 1) * (1 - rate)) }
    : { kind: "ped", value: markup.value * (1 - rate) };
}

function normalizeMarkupKind(kind) {
  return kind === "percent" || kind === "ped" ? kind : "none";
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameOptionalNumber(left, right) {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= 0.0001;
}

function displayedMarkupValue(kind, value) {
  const number = optionalNumber(value);
  if (number === null || kind === "none") return null;
  return kind === "percent" ? roundPed(number, 4) : roundPed(number, 2);
}

function saleUnitPrice(unitTt, kind, value) {
  if (kind === "percent") return unitTt * value;
  if (kind === "ped") return unitTt + value;
  return unitTt;
}

export function priceOrderLine(unitTt, quantity, markupKind, markupValue) {
  const unitSale = saleUnitPrice(unitTt, markupKind, markupValue);
  return {
    // La précision de travail est conservée en base pour les petits prix.
    // Les montants de ligne restent des montants monétaires à 2 décimales.
    unitSalePed: roundPed(unitSale, 6),
    lineTtPed: roundPed(unitTt * quantity),
    lineSalePed: roundPed(unitSale * quantity)
  };
}

function validateOrderQuantity(quantity, itemName) {
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1_000_000) {
    throw new Error(`La quantité de ${itemName} doit être entière et positive`);
  }
}

function hasAtMostDecimals(value, decimals) {
  return Math.abs(Number(value) - roundPed(value, decimals)) <= 1e-9;
}

export function formatMarkup(kind, value) {
  if (!Number.isFinite(value)) return null;
  if (kind === "percent") return `${(value * 100).toFixed(2).replace(".", ",")} %`;
  if (kind === "ped") return `${value.toFixed(2).replace(".", ",")} PED`;
  return null;
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanOptionalText(value, maxLength) {
  return cleanText(value, maxLength) || null;
}

function normalizeOptionalDate(value) {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function roundPed(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
