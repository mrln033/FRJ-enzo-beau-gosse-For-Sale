/** Aucun contenu du devis conservé : uniquement un identifiant anti-résurrection. */
function frjOrderWasDeleted_(id) {
  return PropertiesService.getScriptProperties().getProperty("FRJ_DELETED_ORDER_"+String(id).toLowerCase()) === "1";
}
function frjPurgeQuoteMirror_(id) {
  if (!/^[a-f0-9-]{36}$/i.test(String(id))) throw new Error("Identifiant de suppression invalide");
  id=String(id).toLowerCase();
  var ss=SpreadsheetApp.openById(FRJ_SYNC_CONFIG.appSpreadsheetId);
  var targets=["COMMANDES_APP","COMMANDES_LIGNES","COMMANDES_HISTORIQUE"].map(function(name) {
    var sheet=ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow()<2) return null;
    var rows=sheet.getDataRange().getValues();
    var column=rows[0].indexOf("ORDER_ID");
    if(column<0) throw new Error(name+" : colonne ORDER_ID absente, suppression interrompue");
    return {sheet:sheet,rows:rows,column:column};
  });
  PropertiesService.getScriptProperties().setProperty("FRJ_DELETED_ORDER_"+id,"1");
  targets.forEach(function(target) {
    if(!target) return;
    for(var row=target.rows.length-1;row>=1;row--) {
      if(String(target.rows[row][target.column]).trim().toLowerCase()===id) target.sheet.deleteRow(row+1);
    }
  });
}
function frjProcessPendingQuoteDeletions_() {
  return withFrjDataLock_(function() {
    var pending=frjD1Request_("/sync/order-deletions").deletions || [];
    pending.forEach(function(entry) {
      frjPurgeQuoteMirror_(entry.id);
      SpreadsheetApp.flush();
      frjD1Request_("/sync/order-deletions/ack",{method:"post",payload:JSON.stringify({id:entry.id})});
    });
    return pending.length;
  });
}
