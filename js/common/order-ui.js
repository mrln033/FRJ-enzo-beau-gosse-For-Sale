// T-027: decimal operations on the decimal representation of finite Numbers.
// BigInts stay internal: APIs, SQLite and Sheets continue receiving Numbers.
function createPedMath() {
  const parts = value => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("Montant non fini");
    const [mantissa, exponent = "0"] = String(number).split("e");
    const scale = (mantissa.split(".")[1] || "").length - Number(exponent);
    return { n: BigInt(mantissa.replace(".", "")), scale };
  };
  const number = (n, scale) => Number(String(n) + "e" + (-scale));
  const add = (a, b) => {
    const x = parts(a), y = parts(b), scale = Math.max(x.scale, y.scale);
    return number(x.n * BigInt(10) ** BigInt(scale - x.scale) + y.n * BigInt(10) ** BigInt(scale - y.scale), scale);
  };
  const multiply = (a, b) => {
    const x = parts(a), y = parts(b);
    return number(x.n * y.n, x.scale + y.scale);
  };
  const round = (value, decimals = 2) => {
    const x = parts(value);
    if (x.scale <= decimals) return Number(value);
    const divisor = BigInt(10) ** BigInt(x.scale - decimals);
    const sign = x.n < BigInt(0) ? -BigInt(1) : BigInt(1), abs = x.n * sign;
    return number(sign * ((abs + divisor / BigInt(2)) / divisor), decimals);
  };
  const format = (value, language = "EN") => {
    const x = parts(value || 0), negative = x.n < BigInt(0);
    let digits = String(negative ? -x.n : x.n);
    if (x.scale < 0) digits += "0".repeat(-x.scale);
    else digits = digits.padStart(x.scale + 1, "0");
    const split = x.scale > 0 ? digits.length - x.scale : digits.length;
    const integer = digits.slice(0, split);
    const fraction = digits.slice(split).replace(/0+$/, "").padEnd(2, "0");
    return (negative ? "-" : "") + integer + (language === "FR" ? "," : ".") + fraction;
  };
  const markup = (kind, value, member = false, rate = 0) => {
    if (!["percent", "ped"].includes(kind) || value == null || !Number.isFinite(Number(value))) return {kind:"none",value:null};
    const factor = multiply(member ? 0.5 : 1, add(1, -Number(rate || 0)));
    return {kind, value: kind === "percent" ? add(1, multiply(add(value, -1), factor)) : multiply(value, factor)};
  };
  const price = (unit, quantity, kind, value) => {
    const sale = kind === "percent" ? multiply(unit, value) : kind === "ped" ? add(unit, value) : Number(unit);
    return {unitSalePed:sale, lineTtPed:multiply(unit, quantity), lineSalePed:multiply(sale, quantity)};
  };
  return Object.freeze({add, multiply, round, format, markup, price, sum: values => values.reduce(add, 0)});
}

(function initOrderUi(global) {
  "use strict";
  const math = createPedMath();

  const statusDefinitions = Object.freeze({
    admin_quote: Object.freeze({ admin: "Devis Admin", FR: "Devis Admin", EN: "Admin quote" }),
    awaiting_approval: Object.freeze({ admin: "À valider", FR: "À valider", EN: "Approval required" }),
    submitted: Object.freeze({ admin: "Transmise", FR: "Demande transmise", EN: "Request submitted" }),
    viewed: Object.freeze({ admin: "Vue", FR: "Demande consultée", EN: "Request viewed" }),
    preparing: Object.freeze({ admin: "À préparer", FR: "Préparation en cours", EN: "Being prepared" }),
    ready: Object.freeze({ admin: "Prête", FR: "Prête", EN: "Ready" }),
    completed: Object.freeze({ admin: "Terminée", FR: "Terminée", EN: "Completed" }),
    cancelled: Object.freeze({ admin: "Annulée", FR: "Annulée", EN: "Cancelled" }),
    expired: Object.freeze({ admin: "Expirée", FR: "Expirée", EN: "Expired" })
  });
  const statusKeys = Object.freeze(Object.keys(statusDefinitions));
  const pricingDefinitions = Object.freeze({
    estimated: Object.freeze({ admin: "Prix estimés", FR: "Prix estimés", EN: "Estimated prices" }),
    "to-confirm": Object.freeze({ admin: "Prix à confirmer", FR: "Prix à confirmer", EN: "Prices to confirm" }),
    confirmed: Object.freeze({ admin: "Prix confirmés", FR: "Prix confirmés", EN: "Confirmed prices" })
  });
  const editableStatuses = new Set(["awaiting_approval", "submitted", "viewed"]);
  const hideableStatuses = new Set(["completed", "cancelled", "expired"]);

  function normalizeLanguage(language) {
    return language === "FR" ? "FR" : "EN";
  }

  function statusLabel(status, language = "FR", variant = "tracking") {
    const definition = statusDefinitions[status];
    if (!definition) return status || "—";
    return variant === "admin" ? definition.admin : definition[normalizeLanguage(language)];
  }

  function pricingLabel(status, language = "FR", variant = "tracking") {
    const definition = pricingDefinitions[status] || pricingDefinitions.estimated;
    return variant === "admin" ? definition.admin : definition[normalizeLanguage(language)];
  }

  function formatPed(value, language = "FR") {
    return math.round(Number(value || 0)).toLocaleString(normalizeLanguage(language) === "FR" ? "fr-FR" : "en-GB", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatQuantity(value, language = "FR") {
    return Number(value || 0).toLocaleString(normalizeLanguage(language) === "FR" ? "fr-FR" : "en-GB", {
      maximumFractionDigits: 0
    });
  }

  function formatDate(value, language = "FR") {
    if (!value) return "—";
    return new Date(value).toLocaleString(normalizeLanguage(language) === "FR" ? "fr-FR" : "en-GB", {
      dateStyle: "short",
      timeStyle: "short"
    });
  }

  function roundPed(value, decimals = 2) {
    return math.round(Number(value || 0), decimals === undefined ? 2 : decimals);
  }

  function orderMarkupTotals(totalTtPed, totalSalePed) {
    const totalTt = roundPed(totalTtPed);
    const totalSale = roundPed(totalSalePed);
    const markupPed = roundPed(totalSale - totalTt);
    const markupPercent = totalTt > 0 ? roundPed((markupPed / totalTt) * 100) : 0;
    return {
      totalTtPed: totalTt,
      markupPed,
      markupPercent,
      totalSalePed: totalSale
    };
  }

  function discountMarker(item, language = "FR") {
    const kind = item?.discountKind;
    const rate = Number(item?.discountRate);
    if (!["daily_promo", "sale"].includes(kind) || !Number.isFinite(rate) || rate <= 0 || rate > 1) return "";
    const percent = (rate * 100).toLocaleString(normalizeLanguage(language) === "FR" ? "fr-FR" : "en-GB", {
      maximumFractionDigits: 2
    });
    return `${kind === "sale" ? "S" : "P"}-${percent}`;
  }

  // Avant la préparation, une proposition peut encore être modifiée par l'Admin ou annulée par le client.
  const canEditProposal = (status) => status === "admin_quote" || editableStatuses.has(status);
  const canCancel = (status) => editableStatuses.has(status);
  const canHide = (status) => hideableStatuses.has(status);

  global.FRJ_ORDER_UI = Object.freeze({
    statusKeys,
    statusLabel,
    pricingLabel,
    formatPed,
    formatUnitPed: (value, language = "FR") => math.format(value, language),
    math,
    formatQuantity,
    formatDate,
    roundPed,
    discountMarker,
    orderMarkupTotals,
    canEditProposal,
    canCancel,
    canHide
  });
})(window);
