function processPurchaseOrderRequest(rawBody) {
  var featureValue = PropertiesService.getScriptProperties().getProperty("FRJ_CART_ENABLED");
  if (String(featureValue || "true").toLowerCase() === "false") {
    return purchaseJsonOutput_({ ok: false, error: "Transmission des paniers désactivée" });
  }

  var payload;
  try { payload = JSON.parse(String(rawBody || "")); } catch (error) {
    return purchaseJsonOutput_({ ok: false, error: "Demande d'achat invalide" });
  }

  try {
    var normalized = normalizePurchaseOrderPayload_(payload);
    var priced = pricePurchaseOrderFromSheet_(normalized);
    if (priced.discrepancies.length) {
      return purchaseJsonOutput_({
        ok: false,
        code: "stock-changed",
        error: "Le stock, le prix affiché ou le MU a changé. Actualise le panier avant de confirmer.",
        discrepancies: priced.discrepancies
      });
    }

    var ss = SpreadsheetApp.openById("13r_PzIZE8dJiPFU8w7UXxtEednHhS-yijNgTiYLqYP0");
    var sheet = getOrCreatePurchaseOrderSheet_(ss);
    var existing = sheet.getLastRow() > 1
      ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues().flat().indexOf(normalized.id)
      : -1;
    if (existing !== -1) {
      return purchaseJsonOutput_({
        ok: true,
        duplicate: true,
        order: { id: normalized.id, publicReference: normalized.publicReference, status: "submitted" }
      });
    }

    var accessTokenHash = purchaseSha256_(normalized.accessToken);
    var order = {
      id: normalized.id,
      publicReference: normalized.publicReference,
      accessTokenHash: accessTokenHash,
      status: "submitted",
      buyerAvatar: normalized.buyerAvatar,
      buyerContact: normalized.buyerContact,
      buyerComment: normalized.buyerComment,
      language: normalized.language,
      frjMember: normalized.frjMember,
      sourceBackend: "gas-fallback",
      totalTtPed: priced.totalTtPed,
      totalSalePed: priced.totalSalePed,
      pricingStatus: priced.pricingStatus,
      clientCreatedAt: normalized.clientCreatedAt,
      discordMessageId: null
    };
    sheet.appendRow([
      order.id, order.publicReference, order.buyerAvatar, order.buyerContact || "",
      order.buyerComment || "", order.language, order.frjMember ? "TRUE" : "FALSE",
      order.status, order.totalTtPed, order.totalSalePed, order.pricingStatus,
      order.clientCreatedAt || "", new Date(), "", "", "", "", "", "FALSE", 0
    ]);
    var orderRow = sheet.getLastRow();
    var discordResult = purchasePublishDiscord_(order, priced.lines);
    if (discordResult.ok) order.discordMessageId = discordResult.messageId;
    var syncPayload = JSON.stringify({ order: order, items: priced.lines });
    sheet.getRange(orderRow, 14).setValue(syncPayload);
    if (discordResult.messageId) sheet.getRange(orderRow, 17).setValue(discordResult.messageId);
    if (discordResult.error) sheet.getRange(orderRow, 18).setValue(discordResult.error);
    return purchaseJsonOutput_({
      ok: true,
      duplicate: false,
      order: {
        id: order.id,
        publicReference: order.publicReference,
        status: order.status,
        totalTtPed: order.totalTtPed,
        totalSalePed: order.totalSalePed,
        pricingStatus: order.pricingStatus
      }
    });
  } catch (error) {
    return purchaseJsonOutput_({ ok: false, error: error.message || String(error) });
  }
}

function processPurchaseOrderCancellation(rawBody) {
  var payload;
  try { payload = JSON.parse(String(rawBody || "")); } catch (error) {
    return purchaseJsonOutput_({ ok: false, error: "Annulation de demande invalide" });
  }
  var accessToken = String(payload && payload.accessToken || "").trim();
  if (!/^[a-f0-9-]{70,80}$/i.test(accessToken)) {
    return purchaseJsonOutput_({ ok: false, error: "Jeton de suivi invalide" });
  }

  try {
    var tokenHash = purchaseSha256_(accessToken);
    var ss = SpreadsheetApp.openById("13r_PzIZE8dJiPFU8w7UXxtEednHhS-yijNgTiYLqYP0");
    var sheet = getOrCreatePurchaseOrderSheet_(ss);
    if (sheet.getLastRow() < 2) return purchaseJsonOutput_({ ok: false, error: "Demande introuvable" });
    var values = sheet.getDataRange().getValues();
    var headers = values[0].map(function(value) { return String(value || "").trim(); });
    var indexes = {};
    headers.forEach(function(header, index) { indexes[header] = index; });
    var found = null;

    for (var rowIndex = 1; rowIndex < values.length; rowIndex++) {
      var rawSync = String(values[rowIndex][indexes.SYNC_PAYLOAD_JSON] || "");
      if (!rawSync) continue;
      var syncPayload;
      try { syncPayload = JSON.parse(rawSync); } catch (error) { continue; }
      var order = syncPayload && syncPayload.order;
      if (!order || String(order.accessTokenHash || "").toLowerCase() !== tokenHash.toLowerCase()) continue;
      found = { rowIndex: rowIndex, payload: syncPayload, order: order };
      break;
    }
    if (!found) return purchaseJsonOutput_({ ok: false, error: "Demande introuvable" });
    var canCancel = found.order.approvalRequired === true
      || found.order.status === "submitted" || found.order.status === "viewed";
    if (!canCancel) {
      return purchaseJsonOutput_({ ok: false, error: "Cette demande ne peut plus être annulée par le client" });
    }

    found.order.status = "cancelled";
    found.order.approvalRequired = false;
    var targetRow = found.rowIndex + 1;
    sheet.getRange(targetRow, indexes.STATUT + 1).setValue("cancelled");
    sheet.getRange(targetRow, indexes.SYNC_PAYLOAD_JSON + 1).setValue(JSON.stringify(found.payload));
    sheet.getRange(targetRow, indexes.SYNCED_D1_AT + 1).clearContent();
    sheet.getRange(targetRow, indexes.SYNC_ERROR + 1).clearContent();
    sheet.getRange(targetRow, indexes.APPROVAL_REQUIRED + 1).setValue("FALSE");
    return purchaseJsonOutput_({ ok: true, status: "cancelled" });
  } catch (error) {
    return purchaseJsonOutput_({ ok: false, error: error.message || String(error) });
  }
}

function normalizePurchaseOrderPayload_(payload) {
  var id = String(payload && payload.id || "").trim().toLowerCase();
  var publicReference = String(payload && payload.publicReference || "").trim().toUpperCase();
  var accessToken = String(payload && payload.accessToken || "").trim();
  var buyerAvatar = purchaseCleanText_(payload && payload.buyerAvatar, 80);
  var language = String(payload && payload.language || "EN").toUpperCase() === "FR" ? "FR" : "EN";
  var items = payload && Array.isArray(payload.items) ? payload.items : [];
  if (String(payload && payload.website || "").trim()) throw new Error("Demande refusée");
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Identifiant de demande invalide");
  if (!/^FRJ-\d{8}-[A-F0-9]{6}$/.test(publicReference)) throw new Error("Référence de demande invalide");
  if (!/^[a-f0-9-]{70,80}$/i.test(accessToken)) throw new Error("Jeton de suivi invalide");
  if (!buyerAvatar) throw new Error("L'avatar en jeu est obligatoire");
  if (!items.length || items.length > 10) throw new Error("Le panier doit contenir entre 1 et 10 articles");
  return {
    id: id,
    publicReference: publicReference,
    accessToken: accessToken,
    buyerAvatar: buyerAvatar,
    buyerContact: purchaseCleanText_(payload.buyerContact, 160) || null,
    buyerComment: purchaseCleanText_(payload.buyerComment, 800) || null,
    language: language,
    frjMember: payload.frjMember === true && language === "FR",
    clientCreatedAt: purchaseIsoDate_(payload.clientCreatedAt),
    items: items.map(function(item) {
      var quantity = Number(item.quantity);
      var normalizedItem = {
        itemName: purchaseCleanText_(item.itemName, 180),
        storage: purchaseCleanText_(item.storage, 80).toUpperCase(),
        aisle: purchaseCleanText_(item.aisle, 120).toUpperCase(),
        quantity: quantity,
        observedUnitTtPed: purchaseOptionalNumber_(item.unitTtPed),
        observedMarkupKind: item.markupKind === "percent" || item.markupKind === "ped" ? item.markupKind : "none",
        observedMarkupValue: purchaseOptionalNumber_(item.markupValue)
      };
      if (!normalizedItem.itemName || !normalizedItem.storage || !normalizedItem.aisle) throw new Error("Article de panier incomplet");
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1000000) {
        throw new Error("La quantité de " + normalizedItem.itemName + " doit être entière et positive");
      }
      return normalizedItem;
    })
  };
}

function pricePurchaseOrderFromSheet_(submission) {
  var rows = getBDDAppData();
  var catalog = {};
  rows.forEach(function(row) {
    catalog[purchaseItemKey_(row.ITEM, row.STORAGE, row.RAYON)] = row;
  });
  var discrepancies = [];
  var lines = [];
  submission.items.forEach(function(requested, index) {
    var current = catalog[purchaseItemKey_(requested.itemName, requested.storage, requested.aisle)];
    var stock = current ? Math.max(0, Number(current.QUANTITE) || 0) : 0;
    if (!current || requested.quantity > stock) {
      discrepancies.push({
        itemName: requested.itemName,
        storage: requested.storage,
        aisle: requested.aisle,
        reason: current ? "insufficient-stock" : "unavailable",
        requestedQuantity: requested.quantity,
        availableQuantity: stock
      });
      return;
    }
    var unitTt = Math.max(0, Number(current.PRIX_UNITAIRE) || 0);
    var markup = purchaseParseMarkup_(current.MU);
    if (!purchaseSameNumber_(requested.observedUnitTtPed, unitTt)
        || requested.observedMarkupKind !== markup.kind
        || !purchaseSameNumber_(requested.observedMarkupValue, markup.value)) {
      discrepancies.push({
        itemName: requested.itemName,
        storage: requested.storage,
        aisle: requested.aisle,
        reason: "price-changed",
        requestedQuantity: requested.quantity,
        availableQuantity: stock,
        unitTtPed: purchaseRound_(unitTt),
        markupKind: markup.kind,
        markupValue: markup.value,
        markupDisplay: markup.kind === "percent"
          ? (markup.value * 100).toFixed(2).replace(".", ",") + " %"
          : (markup.kind === "ped" ? markup.value.toFixed(2).replace(".", ",") + " PED" : null)
      });
      return;
    }
    if (submission.frjMember && markup.kind === "percent") markup.value = 1 + ((markup.value - 1) / 2);
    if (submission.frjMember && markup.kind === "ped") markup.value = markup.value / 2;
    var prices = purchasePriceOrderLine_(unitTt, requested.quantity, markup.kind, markup.value);
    lines.push({
      lineNo: index + 1,
      itemName: String(current.ITEM),
      storage: String(current.STORAGE).toUpperCase(),
      aisle: String(current.RAYON).toUpperCase(),
      quantity: requested.quantity,
      stockAtSubmission: stock,
      unitTtPed: purchaseRound_(unitTt),
      markupKind: markup.kind,
      markupValue: markup.value,
      markupDisplay: markup.kind === "percent"
        ? (markup.value * 100).toFixed(2).replace(".", ",") + " %"
        : (markup.kind === "ped" ? markup.value.toFixed(2).replace(".", ",") + " PED" : null),
      unitSalePed: prices.unitSalePed,
      lineTtPed: prices.lineTtPed,
      lineSalePed: prices.lineSalePed,
      priceStatus: markup.kind === "none" ? "to-confirm" : "estimated"
    });
  });
  return {
    lines: lines,
    discrepancies: discrepancies,
    totalTtPed: purchaseRound_(lines.reduce(function(sum, line) { return sum + line.lineTtPed; }, 0)),
    totalSalePed: purchaseRound_(lines.reduce(function(sum, line) { return sum + line.lineSalePed; }, 0)),
    pricingStatus: lines.some(function(line) { return line.priceStatus === "to-confirm"; }) ? "to-confirm" : "estimated"
  };
}

function getOrCreatePurchaseOrderSheet_(ss) {
  var sheet = ss.getSheetByName("COMMANDES_APP");
  if (!sheet) sheet = ss.insertSheet("COMMANDES_APP");
  var headers = [
    "ORDER_ID", "REFERENCE", "AVATAR_ACHETEUR", "CONTACT", "COMMENTAIRE", "LANGUE",
    "MEMBRE_FRJ", "STATUT", "TOTAL_TT_PED", "TOTAL_VENTE_PED", "PRIX_STATUT",
    "DATE_CLIENT", "DATE_RECEPTION", "SYNC_PAYLOAD_JSON", "SYNCED_D1_AT", "SYNC_ERROR",
    "DISCORD_MESSAGE_ID", "DISCORD_ERROR", "APPROVAL_REQUIRED", "PROPOSAL_VERSION"
  ];
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  var currentHeaders = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0]
    : [];
  if (headers.some(function(header, index) { return currentHeaders[index] !== header; })) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

function upsertPurchaseOrderMirror_(snapshot) {
  var order = snapshot && snapshot.order ? snapshot.order : snapshot;
  var items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : (Array.isArray(order && order.items) ? order.items : []);
  var orderId = String(order && order.id || "").trim().toLowerCase();
  if (!/^[a-f0-9-]{36}$/.test(orderId)) throw new Error("Commande D1 invalide");

  var ss = SpreadsheetApp.openById("13r_PzIZE8dJiPFU8w7UXxtEednHhS-yijNgTiYLqYP0");
  var sheet = getOrCreatePurchaseOrderSheet_(ss);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var indexes = {};
  headers.forEach(function(header, index) { indexes[String(header || "").trim()] = index; });
  var values = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
    : [];
  var existingIndex = values.findIndex(function(row) { return String(row[indexes.ORDER_ID] || "").trim().toLowerCase() === orderId; });
  var row = existingIndex >= 0 ? values[existingIndex].slice() : new Array(headers.length).fill("");
  var set = function(name, value) { if (indexes[name] !== undefined) row[indexes[name]] = value; };

  set("ORDER_ID", orderId);
  set("REFERENCE", order.publicReference || "");
  set("AVATAR_ACHETEUR", order.buyerAvatar || "");
  set("CONTACT", order.buyerContact || "");
  set("COMMENTAIRE", order.buyerComment || "");
  set("LANGUE", order.language === "FR" ? "FR" : "EN");
  set("MEMBRE_FRJ", order.frjMember === true ? "TRUE" : "FALSE");
  set("STATUT", order.status || "submitted");
  set("TOTAL_TT_PED", Number(order.totalTtPed || 0));
  set("TOTAL_VENTE_PED", Number(order.totalSalePed || 0));
  set("PRIX_STATUT", order.pricingStatus || "estimated");
  set("DATE_CLIENT", order.clientCreatedAt || "");
  if (!row[indexes.DATE_RECEPTION]) set("DATE_RECEPTION", order.createdAt ? new Date(order.createdAt) : new Date());
  set("SYNC_PAYLOAD_JSON", JSON.stringify({
    order: {
      id: orderId,
      publicReference: order.publicReference,
      accessTokenHash: order.accessTokenHash,
      status: order.status,
      buyerAvatar: order.buyerAvatar,
      buyerContact: order.buyerContact,
      buyerComment: order.buyerComment,
      language: order.language,
      frjMember: order.frjMember === true,
      sourceBackend: order.sourceBackend || "d1",
      totalTtPed: Number(order.totalTtPed || 0),
      totalSalePed: Number(order.totalSalePed || 0),
      pricingStatus: order.pricingStatus || "estimated",
      clientCreatedAt: order.clientCreatedAt || null,
      discordMessageId: order.discordMessageId || null,
      approvalRequired: order.approvalRequired === true,
      proposalVersion: Number(order.proposalVersion || 0)
    },
    items: items
  }));
  set("SYNCED_D1_AT", new Date());
  set("SYNC_ERROR", "");
  set("DISCORD_MESSAGE_ID", order.discordMessageId || "");
  set("APPROVAL_REQUIRED", order.approvalRequired === true ? "TRUE" : "FALSE");
  set("PROPOSAL_VERSION", Number(order.proposalVersion || 0));

  var targetRow = existingIndex >= 0 ? existingIndex + 2 : sheet.getLastRow() + 1;
  sheet.getRange(targetRow, 1, 1, headers.length).setValues([row]);
  return targetRow;
}

function purchasePublishDiscord_(order, items) {
  var webhook = String(PropertiesService.getScriptProperties().getProperty("FRJ_DISCORD_ORDER_WEBHOOK_URL") || "").trim();
  if (!webhook) return { ok: false, skipped: true };
  if (!/^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+\/?$/.test(webhook)) {
    return { ok: false, error: "Webhook Discord invalide" };
  }
  try {
    var response = UrlFetchApp.fetch(webhook.replace(/\/+$/, "") + "?wait=true", {
      method: "post",
      contentType: "application/json; charset=UTF-8",
      payload: JSON.stringify(purchaseDiscordPayload_(order, items)),
      muteHttpExceptions: true
    });
    var status = response.getResponseCode();
    var raw = response.getContentText();
    var data;
    try { data = raw ? JSON.parse(raw) : {}; } catch (parseError) { data = {}; }
    if (status < 200 || status >= 300) {
      return { ok: false, error: "Discord HTTP " + status };
    }
    var messageId = String(data.id || "").trim();
    if (!/^\d{15,22}$/.test(messageId)) return { ok: false, error: "ID du message Discord absent" };
    return { ok: true, messageId: messageId };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 500) };
  }
}

function purchaseDiscordPayload_(order, items) {
  var statusLabels = {
    submitted: "Demande transmise", viewed: "Demande consultée", preparing: "Préparation en cours",
    ready: "Prête", completed: "Terminée", cancelled: "Annulée", expired: "Expirée"
  };
  var statusColors = {
    submitted: 13144610, viewed: 3504324, preparing: 14186520,
    ready: 2589514, completed: 1467700, cancelled: 11811892, expired: 7829367
  };
  var status = String(order.status || "submitted").toLowerCase();
  var memberLabel = order.frjMember ? "MU FRJ" : "MU";
  var fields = [
    { name: "Avatar", value: purchaseDiscordText_(order.buyerAvatar || "—", 1024), inline: true },
    { name: "Statut", value: statusLabels[status] || status, inline: true },
    { name: "Total estimé", value: purchaseDiscordNumber_(order.totalSalePed, 2) + " PED", inline: true },
    { name: "Contact", value: purchaseDiscordText_(order.buyerContact || "Non renseigné", 1024), inline: true },
    { name: "Origine", value: "Secours GAS", inline: true },
    { name: "Profil tarifaire", value: order.frjMember ? "Membre FRJ" : "Public", inline: true }
  ];
  purchaseDiscordItemFields_(items, memberLabel).forEach(function(field) { fields.push(field); });
  if (order.buyerComment) {
    fields.push({ name: "Commentaire", value: purchaseDiscordText_(order.buyerComment, 900), inline: false });
  }
  return {
    username: "FRJ — For Sale",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "🛒 " + purchaseDiscordText_(order.publicReference || "Nouvelle demande", 220),
      url: "https://mrln033.github.io/FRJ-enzo-beau-gosse-For-Sale/commandes.html",
      description: "État actuel : **" + (statusLabels[status] || status) + "**",
      color: statusColors[status] || statusColors.submitted,
      fields: fields,
      footer: { text: "Demande " + purchaseDiscordText_(order.id || "sans identifiant", 180) },
      timestamp: new Date().toISOString()
    }]
  };
}

function purchaseDiscordItemFields_(items, memberLabel) {
  var lines = (items || []).map(function(item) {
    return "• " + purchaseDiscordNumber_(item.quantity, 4) + " × "
      + purchaseDiscordText_(item.itemName || "Article", 180) + " — "
      + purchaseDiscordNumber_(item.lineSalePed, 2) + " PED (" + memberLabel + " : "
      + purchaseDiscordText_(item.markupDisplay || "à confirmer", 80) + ")";
  });
  var chunks = [];
  var current = "";
  var included = 0;
  for (var index = 0; index < lines.length; index++) {
    var candidate = current ? current + "\n" + lines[index] : lines[index];
    if (candidate.length <= 980 && chunks.length < 4) {
      current = candidate;
      included++;
      continue;
    }
    if (current && chunks.length < 4) chunks.push(current);
    if (chunks.length >= 4) break;
    current = lines[index].slice(0, 980);
    included++;
  }
  if (current && chunks.length < 4) chunks.push(current);
  var omitted = Math.max(0, lines.length - included);
  if (omitted && chunks.length) {
    var suffix = "\n… et " + omitted + " autre(s) article(s)";
    chunks[chunks.length - 1] = chunks[chunks.length - 1].slice(0, 980 - suffix.length) + suffix;
  }
  return chunks.map(function(value, index) {
    return { name: index === 0 ? "Articles (" + lines.length + ")" : "Articles — suite", value: value || "—", inline: false };
  });
}

function purchaseDiscordText_(value, maxLength) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/@/g, "@\u200b")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function purchaseDiscordNumber_(value, decimals) {
  var number = Number(value || 0);
  return number.toFixed(decimals).replace(".", ",").replace(/,?0+$/, "");
}

function purchaseParseMarkup_(raw) {
  var text = String(raw || "").trim();
  if (/%$/.test(text)) {
    var percent = Number(text.replace("%", "").replace(",", "."));
    return isFinite(percent) ? { kind: "percent", value: percent / 100 } : { kind: "none", value: null };
  }
  if (/PED$/i.test(text)) {
    var ped = Number(text.replace(/PED$/i, "").trim().replace(",", "."));
    return isFinite(ped) ? { kind: "ped", value: ped } : { kind: "none", value: null };
  }
  return { kind: "none", value: null };
}

function purchaseOptionalNumber_(value) {
  if (value === null || value === undefined || value === "") return null;
  var number = Number(value);
  return isFinite(number) ? number : null;
}

function purchaseSameNumber_(left, right) {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= 0.0001;
}

function purchasePriceOrderLine_(unitTt, quantity, markupKind, markupValue) {
  var unitSale = unitTt;
  if (markupKind === "percent") unitSale = unitTt * markupValue;
  if (markupKind === "ped") unitSale = unitTt + markupValue;
  return {
    unitSalePed: purchaseRound_(unitSale, 6),
    lineTtPed: purchaseRound_(unitTt * quantity),
    lineSalePed: purchaseRound_(unitSale * quantity)
  };
}

function purchaseItemKey_(item, storage, aisle) {
  return [item, storage, aisle].map(function(value) { return String(value || "").trim().toLowerCase(); }).join("\u001f");
}

function purchaseSha256_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map(function(byte) { return (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, "0"); }).join("");
}

function purchaseCleanText_(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function purchaseIsoDate_(value) {
  var date = new Date(String(value || ""));
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function purchaseRound_(value, decimals) {
  var precision = decimals === undefined ? 2 : decimals;
  var factor = Math.pow(10, precision);
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function purchaseJsonOutput_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
