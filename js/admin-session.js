(function initAdminSession(global) {
  "use strict";

  const SESSION_KEY = "FRJ_ADMIN_MODE_V1";
  const params = new URLSearchParams(global.location.search);
  const requested = params.get("admin") === "1";
  let active = requested;

  try {
    if (requested) global.sessionStorage.setItem(SESSION_KEY, "1");
    active = global.sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    // Le paramètre reste utilisable pour la page courante si le stockage est bloqué.
  }

  if (params.has("admin")) {
    params.delete("admin");
    const query = params.toString();
    const cleanUrl = `${global.location.pathname}${query ? `?${query}` : ""}${global.location.hash || ""}`;
    global.history.replaceState(global.history.state, "", cleanUrl);
  }

  function requireAdminSession() {
    if (!active) global.location.replace("./");
    return active;
  }

  global.FRJ_ADMIN = Object.freeze({ active, require: requireAdminSession });
})(window);
