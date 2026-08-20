function frjPushPendingPurchaseOrders_() {
  var featureValue = PropertiesService.getScriptProperties().getProperty("FRJ_CART_ENABLED");
  if (String(featureValue || "true").toLowerCase() === "false") return 0;
  var ss = SpreadsheetApp.openById(FRJ_SYNC_CONFIG.appSpreadsheetId);
  var sheet = ss.getSheetByName("COMMANDES_APP");
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function(value) { return String(value || "").trim(); });
  var payloadIndex = headers.indexOf("SYNC_PAYLOAD_JSON");
  var syncedIndex = headers.indexOf("SYNCED_D1_AT");
  var errorIndex = headers.indexOf("SYNC_ERROR");
  if (payloadIndex < 0 || syncedIndex < 0 || errorIndex < 0) return 0;

  var pushed = 0;
  for (var rowIndex = 1; rowIndex < values.length && pushed < 20; rowIndex++) {
    if (values[rowIndex][syncedIndex] || !values[rowIndex][payloadIndex]) continue;
    try {
      frjD1Request_("/sync/order", {
        method: "post",
        payload: String(values[rowIndex][payloadIndex])
      });
      sheet.getRange(rowIndex + 1, syncedIndex + 1).setValue(new Date());
      sheet.getRange(rowIndex + 1, errorIndex + 1).clearContent();
      pushed++;
    } catch (error) {
      sheet.getRange(rowIndex + 1, errorIndex + 1).setValue(new Date().toISOString() + " — " + error.message);
    }
  }
  return pushed;
}

function frjPullPurchaseOrdersFromD1_() {
  var properties = PropertiesService.getScriptProperties();
  var cursorKey = "FRJ_D1_ORDERS_EVENT_CURSOR";
  var cursor = Number(properties.getProperty(cursorKey) || 0);
  if (!isFinite(cursor) || cursor < 0) cursor = 0;
  var pulled = 0;

  for (var page = 0; page < 5; page++) {
    var response = frjD1Request_("/sync/orders?afterEventId=" + encodeURIComponent(String(cursor)));
    var orders = response && Array.isArray(response.orders) ? response.orders : [];
    orders.forEach(function(order) {
      upsertPurchaseOrderMirror_(order);
      pulled++;
    });
    var nextCursor = Number(response && response.cursor || cursor);
    if (isFinite(nextCursor) && nextCursor >= cursor) {
      cursor = nextCursor;
      properties.setProperty(cursorKey, String(cursor));
    }
    if (!response || response.hasMore !== true) break;
  }
  return pulled;
}
