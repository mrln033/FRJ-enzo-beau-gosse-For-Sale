function doPost(e) {
  try {
    var type = String(e && e.parameter ? e.parameter.type || "" : "");
    if (!type || type === "syncAudit") return frjHandleImmediateAuditPost_(e);
    if (typeof frjMainDoPost_ === "function") return frjMainDoPost_(e);
    return frjJsonOutput_({ ok: false, error: "Type inconnu : " + type });
  } catch (error) {
    // Une exception Web App non interceptée renvoie une page Google sans CORS :
    // le navigateur ne voit alors que « Failed to fetch ». La référence publique
    // permet de retrouver le détail dans les journaux privés sans l'exposer.
    var reference = Utilities.getUuid().slice(0, 8).toUpperCase();
    var message = error && error.message ? error.message : String(error || "Erreur GAS inconnue");
    console.error("POST " + reference + " : " + (error && error.stack ? error.stack : message));
    var phases = {
      "INV-OPEN": "accès à la feuille d'inventaire",
      "INV-DATA": "validation du fichier MindArk",
      "INV-WRITE": "écriture de la feuille d'inventaire",
      "INV-CONTAINERS": "mise à jour de la configuration des conteneurs"
    };
    var code = error && phases[error.frjPublicCode] ? error.frjPublicCode : "POST";
    var publicMessage = phases[code] || "traitement interne GAS";
    return ContentService.createTextOutput(
      "❌ GAS : échec pendant " + publicMessage + " [" + code + "] (référence " + reference + ")"
    );
  }
}
