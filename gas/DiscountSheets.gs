var FRJ_DISCOUNT_SHEETS = Object.freeze({
  campaigns: "CAMPAGNES_REMISE",
  config: "CONFIG_REMISES",
  campaignHeaders: ["ID", "TYPE", "DEBUT", "FIN", "CATEGORIE", "RAYON", "TAUX", "ACTIVE", "ORIGINE", "NB_ELIGIBLES", "NB_CANDIDATS", "MAJ_LE"],
  configHeaders: ["AUTOMATIQUE", "TAUX_DEFAUT", "GRAINE", "MAJ_LE"]
});

function frjEnsureDiscountSheets_() {
  var spreadsheet = SpreadsheetApp.openById(FRJ_SYNC_CONFIG.appSpreadsheetId);
  var campaigns = spreadsheet.getSheetByName(FRJ_DISCOUNT_SHEETS.campaigns) || spreadsheet.insertSheet(FRJ_DISCOUNT_SHEETS.campaigns);
  var config = spreadsheet.getSheetByName(FRJ_DISCOUNT_SHEETS.config) || spreadsheet.insertSheet(FRJ_DISCOUNT_SHEETS.config);
  if (campaigns.getLastRow() === 0) campaigns.getRange(1, 1, 1, 12).setValues([FRJ_DISCOUNT_SHEETS.campaignHeaders]);
  if (config.getLastRow() === 0) config.getRange(1, 1, 2, 4).setValues([
    FRJ_DISCOUNT_SHEETS.configHeaders, [true, 0.05, "frj-daily-promo", new Date()]
  ]);
  return { campaigns: campaigns, config: config };
}

function frjReadLocalDiscountCampaigns_() {
  var sheet = frjEnsureDiscountSheets_().campaigns;
  var values = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 12).getValues() : [];
  var rows = values.filter(function(row) { return String(row[0] || "").trim(); }).map(function(row) {
    return {
      id: String(row[0]).trim(), type: String(row[1]).trim(), startsOn: frjDiscountSheetDate_(row[2]),
      endsOn: frjDiscountSheetDate_(row[3]), storage: frjNullableText_(row[4]), aisle: frjNullableText_(row[5]),
      discountRate: Number(row[6]), enabled: row[7] === true, origin: String(row[8] || "manual"),
      eligiblePairCount: frjNullableNumber_(row[9]), candidatePairCount: frjNullableNumber_(row[10]),
      updatedAt: frjToIso_(row[11], "1970-01-01T00:00:00.000Z")
    };
  });
  var latest = rows.reduce(function(value, row) { return frjCompareDates_(row.updatedAt, value) > 0 ? row.updatedAt : value; }, "1970-01-01T00:00:00.000Z");
  return { rows: rows, hash: frjHashDiscountCampaigns_(rows), updatedAt: latest };
}

function frjWriteLocalDiscountCampaigns_(snapshot) {
  var sheet = frjEnsureDiscountSheets_().campaigns;
  var data = snapshot.rows.map(function(row) { return [
    row.id, row.type, new Date(row.startsOn + "T12:00:00Z"), new Date(row.endsOn + "T12:00:00Z"),
    row.storage || "", row.aisle || "", Number(row.discountRate), row.enabled === true,
    row.origin || "manual", row.eligiblePairCount == null ? "" : Number(row.eligiblePairCount),
    row.candidatePairCount == null ? "" : Number(row.candidatePairCount), new Date(row.updatedAt)
  ]; });
  if (sheet.getMaxRows() > 1) sheet.getRange(2, 1, sheet.getMaxRows() - 1, 12).clearContent();
  if (data.length) sheet.getRange(2, 1, data.length, 12).setValues(data);
  SpreadsheetApp.flush();
}

function frjReadLocalDiscountConfig_() {
  var sheet = frjEnsureDiscountSheets_().config;
  var row = sheet.getRange(2, 1, 1, 4).getValues()[0];
  var rows = [{
    id: "config", automaticPromotionsEnabled: row[0] === true,
    defaultPromotionRate: Number(row[1]) || 0.05, selectionSeed: String(row[2] || "frj-daily-promo"),
    updatedAt: frjToIso_(row[3], new Date().toISOString())
  }];
  return { rows: rows, hash: frjHashDiscountConfig_(rows), updatedAt: rows[0].updatedAt };
}

function frjWriteLocalDiscountConfig_(snapshot) {
  var sheet = frjEnsureDiscountSheets_().config;
  var row = snapshot.rows[0];
  sheet.getRange(2, 1, 1, 4).setValues([[
    row.automaticPromotionsEnabled === true, Number(row.defaultPromotionRate),
    row.selectionSeed || "frj-daily-promo", new Date(row.updatedAt)
  ]]);
  SpreadsheetApp.flush();
}

function frjHashDiscountCampaigns_(rows) {
  return frjSha256_(rows.map(function(row) { return JSON.stringify([
    row.id, row.type, row.startsOn, row.endsOn, row.storage || "", row.aisle || "", String(Number(row.discountRate)),
    row.enabled === true ? "1" : "0", row.origin || "manual", row.eligiblePairCount == null ? "" : String(row.eligiblePairCount),
    row.candidatePairCount == null ? "" : String(row.candidatePairCount), frjToIso_(row.updatedAt, "")
  ]); }).sort().join("\n"));
}

function frjHashDiscountConfig_(rows) {
  var row = rows[0] || {};
  return frjSha256_(JSON.stringify([row.automaticPromotionsEnabled === true ? "1" : "0", String(Number(row.defaultPromotionRate)), row.selectionSeed || "frj-daily-promo", frjToIso_(row.updatedAt, "")]));
}

function frjDiscountSheetDate_(value) {
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) return Utilities.formatDate(value, "Europe/Paris", "yyyy-MM-dd");
  return String(value || "").trim();
}

function frjGenerateDailyPromotionFromGas_() {
  var config = frjReadLocalDiscountConfig_().rows[0];
  var businessDate = Utilities.formatDate(new Date(), "Europe/Paris", "yyyy-MM-dd");
  var tomorrowDate = frjAddDiscountDays_(businessDate, 1);
  if (!config.automaticPromotionsEnabled) {
    return {
      reason: "AUTOMATION_DISABLED", businessDate: businessDate,
      today: { reason: "AUTOMATION_DISABLED", date: businessDate, campaign: null },
      tomorrow: { reason: "AUTOMATION_DISABLED", date: tomorrowDate, campaign: null },
      generatedDates: []
    };
  }
  var campaigns = frjReadLocalDiscountCampaigns_();
  var sheet = SpreadsheetApp.openById(FRJ_SYNC_CONFIG.appSpreadsheetId).getSheetByName(FRJ_SYNC_CONFIG.catalogSheetName);
  var values = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).getValues() : [];
  var items = values.map(function(row) {
    var parsed = frjParsePromotionMarkup_(row[8]);
    return { storage: row[0], aisle: row[1], quantity: Number(row[3]), markupKind: parsed.kind, markupValue: parsed.value };
  });
  function generateForDate(date) {
    var result = frjPlanDailyPromotion_({
      date: date, items: items,
      dailyPromotions: campaigns.rows.filter(function(row) { return row.type === "daily_promo"; }),
      sales: campaigns.rows.filter(function(row) { return row.type === "sale"; }),
      defaultRate: config.defaultPromotionRate, seed: config.selectionSeed
    });
    if (result.reason !== "GENERATED") return result;
    var campaign = result.campaign;
    campaigns.rows.push({
      id: "daily-promo-" + date, type: "daily_promo", startsOn: date, endsOn: date,
      storage: campaign.storage, aisle: campaign.aisle, discountRate: campaign.discountRate,
      enabled: true, origin: "automatic", eligiblePairCount: result.eligiblePairCount,
      candidatePairCount: result.candidatePairCount, updatedAt: new Date().toISOString()
    });
    return result;
  }
  var today = generateForDate(businessDate);
  var tomorrow = generateForDate(tomorrowDate);
  var generatedDates = [today, tomorrow].filter(function(result) {
    return result.reason === "GENERATED";
  }).map(function(result) { return result.date; });
  if (generatedDates.length) {
    frjWriteLocalDiscountCampaigns_({ rows: campaigns.rows });
    frjClearCatalogCache_();
    frjRequestSynchronization_("generation-promotion-aujourdhui-demain", FRJ_SYNC_CONFIG.appSpreadsheetId);
  }
  return {
    reason: generatedDates.length ? "GENERATED" : tomorrow.reason,
    businessDate: businessDate, today: today, tomorrow: tomorrow, generatedDates: generatedDates
  };
}

function frjParsePromotionMarkup_(value) {
  var text = String(value || "").trim().toUpperCase();
  if (/%$/.test(text)) return { kind: "percent", value: Number(text.replace("%", "").replace(",", ".")) / 100 };
  if (/PED$/.test(text)) return { kind: "ped", value: Number(text.replace(/PED$/, "").replace(",", ".")) };
  return { kind: "none", value: null };
}
