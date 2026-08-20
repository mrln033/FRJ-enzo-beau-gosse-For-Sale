// Fonction pour afficher la page HTML
function doGet(e) {
  const action = e.parameter.action;

  if (action === "categories") {
    const cats = getAvailableCategories();
    return ContentService
      .createTextOutput(JSON.stringify(cats))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (action === "inventoryDate") {
    return ContentService
      .createTextOutput(JSON.stringify({ inventoryDate: getInventoryDate() }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (action === "inventoryTarget") {
    const avatar = e.parameter.avatar || "enzo";
    return ContentService
      .createTextOutput(JSON.stringify({
        avatar: avatar,
        sheet: getInventorySheetName(avatar)
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const category = e.parameter.category || null;

  if (!category) {
    return ContentService
      .createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const data = getDataFast(category);

  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function frjMainDoPost_(e) {
  const type = e.parameter.type;
  if (type === "syncAudit") return frjHandleImmediateAuditPost_(e);

  return withFrjDataLock_(function() {
    if (type === "order") {
      return processPurchaseOrderRequest(e.postData && e.postData.contents);
    }
    if (type === "orderCancel") {
      return processPurchaseOrderCancellation(e.postData && e.postData.contents);
    }

    if (type === "mu") {
      return ContentService.createTextOutput(processMU(e.postData.contents));
    }

    if (type === "inventory") {
      return ContentService.createTextOutput(processInventory(e.postData.contents, e.parameter.avatar));
    }

    return ContentService.createTextOutput("❌ Type reçu: " + type);
  });
}
