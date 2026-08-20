function frjSha256_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  ).map(function(byte) {
    return ((byte + 256) % 256).toString(16).padStart(2, "0");
  }).join("");
}

function frjD1Request_(path, options) {
  options = options || {};
  var requestOptions = {
    method: options.method || "get",
    muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + frjRequireSyncToken_() }
  };
  if (options.expectedHash) requestOptions.headers["X-Expected-Hash"] = options.expectedHash;
  if (options.payload !== undefined) {
    requestOptions.contentType = "application/json; charset=UTF-8";
    requestOptions.payload = options.payload;
  }

  var response = UrlFetchApp.fetch(FRJ_SYNC_CONFIG.d1Url + path, requestOptions);
  var status = response.getResponseCode();
  var text = response.getContentText();
  var data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { error: text || "Réponse D1 non JSON" };
  }
  if (status < 200 || status >= 300) {
    var requestError = new Error("D1 HTTP " + status + " : " + (data.error || text));
    requestError.frjStatus = status;
    throw requestError;
  }
  return data;
}

function frjReportAudit_(dataset, action, sourceHash, targetHash, details) {
  try {
    frjD1Request_("/sync/audit", {
      method: "post",
      payload: JSON.stringify({
        dataset: dataset,
        direction: "gas-audit",
        action: action,
        sourceHash: sourceHash,
        targetHash: targetHash,
        details: details || {}
      })
    });
  } catch (error) {
    console.error(JSON.stringify({ message: "Audit D1 non enregistré", dataset: dataset, error: error.message }));
  }
}

function frjRequireSyncToken_() {
  var token = PropertiesService.getScriptProperties().getProperty(FRJ_SYNC_CONFIG.tokenProperty) || "";
  if (!token) throw new Error("Jeton FRJ_D1_SYNC_TOKEN non configuré");
  return token;
}

function frjGetBaseHash_(dataset) {
  return PropertiesService.getScriptProperties().getProperty(FRJ_SYNC_CONFIG.basePropertyPrefix + dataset) || "";
}

function frjSetBaseHash_(dataset, hash) {
  frjD1Request_("/sync/ack", {
    method: "post",
    payload: JSON.stringify({ dataset: dataset, hash: hash })
  });
  PropertiesService.getScriptProperties().setProperty(FRJ_SYNC_CONFIG.basePropertyPrefix + dataset, hash);
}

function frjClearCatalogCache_() {
  CacheService.getScriptCache().removeAll([
    "cat_ARMORS", "cat_BLUEPRINTS", "cat_CLOTHES", "cat_MATERIALS", "cat_MINDFORCE",
    "cat_MISCELLANEOUS", "cat_RESOURCES", "cat_TOOLS", "cat_VEHICLES", "cat_WEAPONS"
  ]);
}

function frjCompareDates_(left, right) {
  var leftTime = new Date(left || 0).getTime();
  var rightTime = new Date(right || 0).getTime();
  return leftTime === rightTime ? 0 : (leftTime > rightTime ? 1 : -1);
}

function frjToIso_(value, fallback) {
  var date = value instanceof Date ? value : new Date(value || "");
  return isNaN(date.getTime()) ? fallback : date.toISOString();
}

function frjText_(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function frjNumber_(value) {
  var number = Number(value);
  return isFinite(number) ? String(number) : "0";
}

function frjNullableNumberText_(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  var number = Number(value);
  return isFinite(number) ? String(number) : "";
}

function frjNullableText_(value) {
  var text = frjText_(value);
  return text || null;
}

function frjNullableNumber_(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  var number = Number(value);
  return isFinite(number) ? number : null;
}
