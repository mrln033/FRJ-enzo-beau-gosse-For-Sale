function doPost(e) {
  var type = String(e && e.parameter ? e.parameter.type || "" : "");
  if (!type || type === "syncAudit") return frjHandleImmediateAuditPost_(e);
  if (typeof frjMainDoPost_ === "function") return frjMainDoPost_(e);
  return frjJsonOutput_({ ok: false, error: "Type inconnu : " + type });
}
