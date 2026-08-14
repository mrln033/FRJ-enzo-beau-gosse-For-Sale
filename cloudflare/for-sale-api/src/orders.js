const ORDER_STATUSES = new Set([
  "submitted", "viewed", "preparing", "ready", "completed", "cancelled", "expired"
]);
const EDITABLE_ORDER_STATUSES = new Set(["submitted", "viewed"]);
const CLIENT_CANCELLABLE_STATUSES = new Set(["submitted", "viewed"]);

export function canReviseOrder(status, approvalRequired = false) {
  return approvalRequired === true || Number(approvalRequired || 0) === 1
    || EDITABLE_ORDER_STATUSES.has(String(status || "").trim().toLowerCase());
}

export function canClientCancelOrder(status, approvalRequired = false) {
  return approvalRequired === true || Number(approvalRequired || 0) === 1
    || CLIENT_CANCELLABLE_STATUSES.has(String(status || "").trim().toLowerCase());
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
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
      throw new Error(`Quantité invalide pour ${itemName}`);
    }
    const observedUnitTtPed = optionalNumber(item?.unitTtPed);
    const observedMarkupKind = normalizeMarkupKind(item?.markupKind);
    const observedMarkupValue = observedMarkupKind === "none" ? null : optionalNumber(item?.markupValue);
    return {
      itemName, storage, aisle, quantity: roundPed(quantity, 4),
      observedUnitTtPed,
      observedMarkupKind,
      observedMarkupValue
    };
  });

  return {
    id, publicReference, accessToken, buyerAvatar, buyerContact, buyerComment,
    language, frjMember, clientCreatedAt, items
  };
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
        markupDisplay: formatMarkup(currentMarkupKind, currentMarkupValue)
      });
      return;
    }
    const effectiveMarkup = applyMemberDiscount(currentMarkupKind, currentMarkupValue, frjMember);
    const unitSale = saleUnitPrice(unitTt, effectiveMarkup.kind, effectiveMarkup.value);
    const lineTt = roundPed(unitTt * requested.quantity);
    const lineSale = roundPed(unitSale * requested.quantity);
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
      unitSalePed: roundPed(unitSale),
      lineTtPed: lineTt,
      lineSalePed: lineSale,
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
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
    throw new Error(`Quantité invalide pour ${itemName}`);
  }
  if (quantity > stock) {
    throw new Error(`Stock insuffisant pour ${itemName} (${stock} disponible)`);
  }

  const markupKind = normalizeMarkupKind(payload?.markupKind);
  const rawAmount = markupKind === "none" ? null : Number(payload?.markupAmount);
  if (markupKind !== "none" && (!Number.isFinite(rawAmount) || rawAmount < 0 || rawAmount > 1_000_000)) {
    throw new Error(`MU invalide pour ${itemName}`);
  }
  const markupValue = markupKind === "percent" ? roundPed(rawAmount / 100, 4) : rawAmount;
  const unitTtPed = Math.max(0, Number(existingLine?.unitTtPed ?? existingLine?.unit_tt_ped) || 0);
  const unitSalePed = roundPed(saleUnitPrice(unitTtPed, markupKind, markupValue));
  const roundedQuantity = roundPed(quantity, 4);

  return {
    quantity: roundedQuantity,
    stockAtSubmission: stock,
    markupKind,
    markupValue,
    markupDisplay: formatMarkup(markupKind, markupValue),
    unitSalePed,
    lineTtPed: roundPed(unitTtPed * roundedQuantity),
    lineSalePed: roundPed(unitSalePed * roundedQuantity),
    priceStatus: markupKind === "none" ? "to-confirm" : "estimated"
  };
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

function formatMarkup(kind, value) {
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
