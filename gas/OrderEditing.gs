/** Edition des demandes : le JSON miroir reste la base, jamais la file d'envoi. */
function frjOrderLineHeaders_() {
  return ["ORDER_ID", "LIGNE", "ARTICLE", "CATEGORIE", "RAYON", "QUANTITE", "MU_TYPE", "MU_SAISI",
    "RETIRER", "TT_UNITAIRE", "TOTAL_TT", "TOTAL_VENTE"];
}
function frjOrderIndexes_(headers) {
  var result = {};
  headers.forEach(function(name,index) { result[String(name)] = index; });
  return result;
}
function frjOrderBoolean_(value) {
  if (value === true || value === 1 || /^(true|vrai|oui|1)$/i.test(String(value))) return true;
  if (value === false || value === 0 || /^(false|faux|non|0|)$/i.test(String(value))) return false;
  throw new Error("Booléen invalide : utiliser TRUE/FALSE ou une case à cocher.");
}
function frjOrderNumber_(value) {
  if (value === "" || value === null || value === undefined) return null;
  return Number(String(value).replace(",", "."));
}
function frjOrderEnsureRows_(sheet, lastRow) {
  if (lastRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(),lastRow-sheet.getMaxRows());
}
function frjOrderLineRows_(snapshot) {
  return (snapshot.items || []).map(function(item) {
    var kind = item.markupKind || "none";
    var amount = item.markupValue == null ? "" : Number((kind === "percent" ? item.markupValue * 100 : item.markupValue).toFixed(6));
    return [snapshot.id, item.lineNo, item.itemName, item.storage, item.aisle, item.quantity,
      kind, amount, false, item.unitTtPed, item.lineTtPed, item.lineSalePed];
  });
}
function frjOrderDraft_(row, indexes, lines) {
  var value = function(name) { return row[indexes[name]]; };
  var draft = {
    buyerAvatar: String(value("AVATAR_ACHETEUR") || "").trim(),
    buyerContact: String(value("CONTACT") || "").trim(),
    buyerComment: String(value("COMMENTAIRE") || "").trim(),
    language: String(value("LANGUE") || "FR").trim().toUpperCase(),
    frjMember: frjOrderBoolean_(value("MEMBRE_FRJ")),
    status: String(value("STATUT") || "").trim().toLowerCase(),
    items: lines.filter(function(line) { return !frjOrderBoolean_(line[8]); }).map(function(line) {
      var kind = String(line[6] || "none").trim().toLowerCase();
      if (kind === "%") kind = "percent";
      return { lineNo: Number(line[1]), itemName: String(line[2] || "").trim(),
        storage: String(line[3] || "").trim().toUpperCase(), aisle: String(line[4] || "").trim().toUpperCase(),
        quantity: frjOrderNumber_(line[5]), markupKind: kind,
        markupAmount: kind === "none" || kind === "auto" ? null : frjOrderNumber_(line[7]) };
    }).sort(function(a,b) { return a.lineNo - b.lineNo; })
  };
  return draft;
}
function frjOrderBaseDraft_(snapshot) {
  var headers = ["AVATAR_ACHETEUR","CONTACT","COMMENTAIRE","LANGUE","MEMBRE_FRJ","STATUT"];
  return frjOrderDraft_([snapshot.buyerAvatar, snapshot.buyerContact, snapshot.buyerComment,
    snapshot.language, snapshot.frjMember, snapshot.status], frjOrderIndexes_(headers), frjOrderLineRows_(snapshot));
}
function frjOrderBook_() {
  return SpreadsheetApp.openById(FRJ_SYNC_CONFIG.appSpreadsheetId);
}
function frjOrderSheetState_() {
  var ss = frjOrderBook_();
  var sheet = getOrCreatePurchaseOrderSheet_(ss);
  var values = sheet.getDataRange().getValues();
  var linesSheet = ss.getSheetByName("COMMANDES_LIGNES");
  var lines = linesSheet && linesSheet.getLastRow() > 1
    ? linesSheet.getRange(2,1,linesSheet.getLastRow()-1,12).getValues() : [];
  return { ss:ss, sheet:sheet, values:values, indexes:frjOrderIndexes_(values[0]),
    linesSheet:linesSheet, lines:lines };
}
function frjEnsureOrderEditing_(alreadyLocked) {
  if (PropertiesService.getScriptProperties().getProperty("FRJ_ORDER_EDITING_VERSION") === "20260912-2") return;
  if (alreadyLocked) return frjInitializeOrderEditing_();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return frjInitializeOrderEditing_(); } finally { lock.releaseLock(); }
}
function frjInitializeOrderEditing_() {
  var properties = PropertiesService.getScriptProperties();
  if (properties.getProperty("FRJ_ORDER_EDITING_VERSION") === "20260912-2") return;
  var ss = frjOrderBook_();
  var orders = getOrCreatePurchaseOrderSheet_(ss);
  var sheet = ss.getSheetByName("COMMANDES_LIGNES");
  if (!sheet) sheet = ss.insertSheet("COMMANDES_LIGNES");
  if (sheet.getLastRow() && String(sheet.getRange(1,1).getValue()) !== "ORDER_ID") {
    throw new Error("COMMANDES_LIGNES existe déjà avec un autre contenu ; initialisation interrompue.");
  }
  sheet.getRange(1,1,1,12).setValues([frjOrderLineHeaders_()]);
  sheet.setFrozenRows(1);
  sheet.getRange(1,1,1,12).setFontWeight("bold").setBackground("#e8edf4");
  var existing = sheet.getLastRow() > 1 ? sheet.getRange(2,1,sheet.getLastRow()-1,12).getValues() : [];
  var ids = {};
  existing.forEach(function(row) { ids[String(row[0])] = true; });
  var data = orders.getDataRange().getValues();
  var index = frjOrderIndexes_(data[0]);
  var additions = [];
  data.slice(1).forEach(function(row) {
    if (!row[index.SYNC_PAYLOAD_JSON] || ids[String(row[index.ORDER_ID])]) return;
    var payload = JSON.parse(String(row[index.SYNC_PAYLOAD_JSON]));
    additions = additions.concat(frjOrderLineRows_({ id:payload.order.id, items:payload.items }));
  });
  if (additions.length) {
    frjOrderEnsureRows_(sheet,sheet.getLastRow()+additions.length);
    sheet.getRange(sheet.getLastRow()+1,1,additions.length,12).setValues(additions);
  }
  sheet.getRange("A:B").setBackground("#eef0f2");
  sheet.getRange("J:L").setBackground("#eef0f2");
  sheet.getRange("C:I").setBackground("#fffdf2");
  sheet.getRange("I2:I").setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  sheet.getRange("G2:G").setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(["percent","ped","none","auto"],true).setAllowInvalid(false).build());
  sheet.getRange("H2:H").setNumberFormat("0.######");
  sheet.getRange("J2:L").setNumberFormat("0.######");
  ["A:B","J:L"].forEach(function(range) {
    sheet.getRange(range).protect().setDescription("FRJ : champs techniques ou calculés").setWarningOnly(true);
  });
  orders.getRange("A:B").protect().setDescription("FRJ : identifiants").setWarningOnly(true);
  orders.getRange("I:W").protect().setDescription("FRJ : calculs et synchronisation").setWarningOnly(true);
  orders.getRange("A1:W1").setFontWeight("bold");
  orders.setFrozenRows(1);
  orders.getRange("X1").setFontWeight("bold");
  orders.getRange("X2:X").setBackground("#fffdf2").setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(["SYNCHRONISER","AJOUTER ARTICLE","RECHARGER D1 (ABANDON LOCAL)","REAPPLIQUER SHEETS SUR D1"],true)
    .setAllowInvalid(false).build());
  orders.getRange("X1").setNote("RECHARGER D1 abandonne les saisies locales. REAPPLIQUER conserve les saisies Sheets sur la version D1 actuelle, sous réserve des règles métier.");
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "frjOrderEditingOpenTrigger") ScriptApp.deleteTrigger(trigger);
  });
  properties.setProperty("FRJ_ORDER_EDITING_VERSION","20260912-2");
  // Une seule relecture de l'historique pour fournir les révisions aux anciens miroirs.
  properties.setProperty("FRJ_D1_ORDERS_EVENT_CURSOR","0");
}
function frjOrderLinesFor_(state,id) {
  return state.lines.filter(function(row) { return String(row[0]).toLowerCase() === String(id).toLowerCase(); });
}
function frjOrderEditableLines_(state,base) {
  var lines = frjOrderLinesFor_(state,base.order.id);
  // Un secours GAS tout juste transféré n'a pas encore reçu ses lignes du miroir.
  return !lines.length && base.order.editRevision == null
    ? frjOrderLineRows_({id:base.order.id,items:base.items}) : lines;
}
function frjScanOrderEdits_(state) {
  var pending = [];
  state.values.slice(1).forEach(function(row,offset) {
    var i = state.indexes, rowNumber = offset+2;
    if (!row[i.SYNC_PAYLOAD_JSON]) return;
    try {
      var base = JSON.parse(String(row[i.SYNC_PAYLOAD_JSON]));
      if (!base.order || !Array.isArray(base.items)) return;
      var technical = { ORDER_ID:base.order.id, REFERENCE:base.order.publicReference,
        TOTAL_TT_PED:Number(base.order.totalTtPed || 0), TOTAL_VENTE_PED:Number(base.order.totalSalePed || 0),
        PRIX_STATUT:base.order.pricingStatus || "estimated", PROPOSAL_VERSION:Number(base.order.proposalVersion || 0),
        APPROVAL_REQUIRED:base.order.approvalRequired ? "TRUE" : "FALSE" };
      Object.keys(technical).forEach(function(name) {
        if (i[name] !== undefined && String(row[i[name]]) !== String(technical[name])) {
          state.sheet.getRange(rowNumber,i[name]+1).setValue(technical[name]);
        }
      });
      // Les nouvelles demandes GAS non encore transférées utilisent d'abord le circuit de secours.
      if (!row[i.SYNCED_D1_AT] && base.order.sourceBackend === "gas-fallback" && base.order.editRevision == null) return;
      var draft = frjOrderDraft_(row,i,frjOrderEditableLines_(state,base));
      var baseline = frjOrderBaseDraft_({ id:base.order.id, items:base.items,
        buyerAvatar:base.order.buyerAvatar, buyerContact:base.order.buyerContact, buyerComment:base.order.buyerComment,
        language:base.order.language, frjMember:base.order.frjMember, status:base.order.status });
      var stored = row[i.EDITION_JSON] ? JSON.parse(String(row[i.EDITION_JSON])) : null;
      if (JSON.stringify(draft) === JSON.stringify(baseline) && !stored) return;
      if (!stored || JSON.stringify(stored.draft) !== JSON.stringify(draft)) {
        stored = { operationId:"sheet-"+Utilities.getUuid().toLowerCase(), orderId:base.order.id,
          baseRevision:base.order.editRevision, draft:draft };
        state.sheet.getRange(rowNumber,i.EDITION_JSON+1).setValue(JSON.stringify(stored));
        state.sheet.getRange(rowNumber,i.EDITION_ERREUR+1).clearContent();
        row[i.EDITION_ERREUR] = "";
      }
      if (draft.items.some(function(item) { return !item.itemName || !item.storage || !item.aisle; })) {
        throw new Error("Compléter Article, Catégorie et Rayon avant synchronisation.");
      }
      if (!row[i.EDITION_ERREUR] && stored.baseRevision != null) pending.push({ rowNumber:rowNumber, payload:stored });
    } catch (error) {
      state.sheet.getRange(rowNumber,state.indexes.EDITION_ERREUR+1).setValue(String(error.message).slice(0,500));
    }
  });
  return pending;
}
function frjSyncEditableOrders_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return 0;
  try {
    frjEnsureOrderEditing_(true);
    frjProcessOrderActions_();
    var state = frjOrderSheetState_();
    var pending = frjScanOrderEdits_(state).slice(0,10);
    var updated = 0;
    pending.forEach(function(entry) {
      try {
        var result = frjD1Request_("/sync/order-edit", { method:"post", payload:JSON.stringify(entry.payload) });
        var latest = frjOrderSheetState_();
        var latestRow = latest.values[entry.rowNumber-1];
        // Une saisie faite pendant la requête reste intacte et sera examinée au passage suivant.
        var unchanged = latestRow && String(latestRow[latest.indexes.ORDER_ID]) === entry.payload.orderId
          && JSON.stringify(frjOrderDraft_(latestRow,latest.indexes,frjOrderLinesFor_(latest,entry.payload.orderId)))
            === JSON.stringify(entry.payload.draft);
        if (!unchanged) return;
        if (!result.ok) {
          state.sheet.getRange(entry.rowNumber,state.indexes.EDITION_ERREUR+1).setValue(result.error || "Conflit avec D1");
          if (result.snapshot) state.sheet.getRange(entry.rowNumber,state.indexes.D1_CONFLIT_JSON+1).setValue(JSON.stringify(result.snapshot));
          return;
        }
        upsertPurchaseOrderMirror_(result.snapshot, true);
        updated++;
      } catch (error) {
        if (error.frjStatus >= 400 && error.frjStatus < 500 && error.frjStatus !== 429) {
          state.sheet.getRange(entry.rowNumber,state.indexes.EDITION_ERREUR+1).setValue(String(error.message).slice(0,500));
        } else {
          // Garder l'opération identique pour une reprise idempotente après panne réseau.
          state.sheet.getRange(entry.rowNumber,state.indexes.SYNC_ERROR+1).setValue(String(error.message).slice(0,500));
        }
      }
    });
    return updated;
  } finally { lock.releaseLock(); }
}
function frjPreserveLocalOrderEdit_(row,indexes,snapshot,sheet,rowNumber) {
  if (row[indexes.ACTION_EDITION]) return true;
  if (!row[indexes.SYNC_PAYLOAD_JSON]) return false;
  try {
    var state = frjOrderSheetState_();
    var base = JSON.parse(String(row[indexes.SYNC_PAYLOAD_JSON]));
    var draft = frjOrderDraft_(row,indexes,frjOrderEditableLines_(state,base));
    var baseline = frjOrderBaseDraft_(Object.assign({},base.order,{items:base.items}));
    if (!row[indexes.EDITION_JSON] && JSON.stringify(draft) === JSON.stringify(baseline)) return false;
    if (row[indexes.EDITION_JSON]) {
      var operation = JSON.parse(String(row[indexes.EDITION_JSON]));
      if (operation.baseRevision === snapshot.editRevision) return true;
    }
    sheet.getRange(rowNumber,indexes.D1_CONFLIT_JSON+1).setValue(JSON.stringify(snapshot));
    sheet.getRange(rowNumber,indexes.EDITION_ERREUR+1).setValue(
      "Modifications Sheets conservées. Colonne ACTION_EDITION : recharger D1 ou réappliquer explicitement.");
    return true;
  } catch (error) {
    sheet.getRange(rowNumber,indexes.EDITION_ERREUR+1).setValue("Lecture locale impossible : "+error.message);
    return true;
  }
}
function frjWriteOrderLines_(snapshot) {
  var ss = frjOrderBook_(), sheet = ss.getSheetByName("COMMANDES_LIGNES");
  if (!sheet) return;
  var rows = sheet.getLastRow()>1 ? sheet.getRange(2,1,sheet.getLastRow()-1,12).getValues() : [];
  var targets = [];
  rows.forEach(function(row,index) { if (String(row[0]) === snapshot.id) targets.push(index+2); });
  var updated = frjOrderLineRows_(snapshot);
  updated.forEach(function(row,index) {
    var at = targets[index] || sheet.getLastRow()+1;
    frjOrderEnsureRows_(sheet,at);
    if (!targets[index] || JSON.stringify(rows[at-2]) !== JSON.stringify(row)) sheet.getRange(at,1,1,12).setValues([row]);
  });
  targets.slice(updated.length).forEach(function(at) { sheet.getRange(at,1,1,12).clearContent(); });
}
function synchroniserDemandesFRJ() { return frjSyncEditableOrders_(); }
function frjProcessOrderActions_() {
  var state = frjOrderSheetState_(), i = state.indexes, processed = 0;
  state.values.slice(1).forEach(function(row,index) {
    var action = String(row[i.ACTION_EDITION] || "").trim(), id = String(row[i.ORDER_ID] || "");
    if (!action || processed >= 10) return;
    processed++;
    var actionCell = state.sheet.getRange(index+2,i.ACTION_EDITION+1);
    // Une action choisie est consommée une fois, avant toute requête réseau.
    actionCell.clearContent();
    try {
      if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Identifiant de demande invalide");
      if (action === "SYNCHRONISER") return;
      if (action === "AJOUTER ARTICLE") {
        var lines = frjOrderLinesFor_(state,id);
        var next = lines.reduce(function(n,line) { return Math.max(n,Number(line[1])||0); },0)+1;
        state.linesSheet.appendRow([id,next,"","","",1,"auto","",false,"","",""]);
        return;
      }
      var keepLocal = action === "REAPPLIQUER SHEETS SUR D1";
      if (!keepLocal && action !== "RECHARGER D1 (ABANDON LOCAL)") throw new Error("Action inconnue");
      var draft = keepLocal ? frjOrderDraft_(row,i,frjOrderLinesFor_(state,id)) : null;
      var remote = frjD1Request_("/sync/order-edit?id="+encodeURIComponent(id)).snapshot;
      if (!keepLocal) { upsertPurchaseOrderMirror_(remote,true); return; }
      var operation = { operationId:"sheet-"+Utilities.getUuid().toLowerCase(),orderId:id,
        baseRevision:remote.editRevision,draft:draft };
      state.sheet.getRange(index+2,i.EDITION_JSON+1).setValue(JSON.stringify(operation));
      state.sheet.getRange(index+2,i.EDITION_ERREUR+1).clearContent();
    } catch (error) {
      state.sheet.getRange(index+2,i.EDITION_ERREUR+1).setValue("Action non terminée, à relancer : "+error.message);
    }
  });
}
