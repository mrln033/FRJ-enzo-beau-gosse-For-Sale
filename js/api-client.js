(function initFrjApi(global) {
  "use strict";

  const GAS_URL = "https://script.google.com/macros/s/AKfycbxD_sOPcjLT-eWPrDMfLgaSx16yAeH17SCd8xByP2faU24z8ge5AiAWOueVBRanHjGx/exec";
  const D1_URL = "https://frj-for-sale-api.merlin-merzhin-lesage.workers.dev";
  const ADMIN_TOKEN_KEY = "FRJ_D1_ADMIN_TOKEN";
  const requestedBackend = new URLSearchParams(global.location.search).get("backend");
  const preferredBackend = requestedBackend === "d1" ? "d1" : "gas";
  let activeBackend = preferredBackend;

  const backends = {
    gas: GAS_URL,
    d1: D1_URL
  };

  async function request(query, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const isWrite = method !== "GET" && method !== "HEAD";

    if (isWrite) {
      return requestWrite(query, options);
    }

    const fallbackBackend = preferredBackend === "d1" ? "gas" : "d1";
    let lastError;

    for (const backend of [preferredBackend, fallbackBackend]) {
      try {
        const response = await global.fetch(buildUrl(backend, query), options);
        if (!response.ok) {
          throw new Error(`${backend.toUpperCase()} répond ${response.status}`);
        }
        setActiveBackend(backend);
        return response;
      } catch (error) {
        lastError = error;
        console.warn(`Lecture ${backend.toUpperCase()} indisponible, tentative de repli.`, error);
      }
    }

    throw lastError || new Error("Aucun backend disponible");
  }

  async function requestWrite(query, options) {
    const headers = new Headers(options.headers || {});

    if (preferredBackend === "d1") {
      headers.set("Authorization", `Bearer ${getAdminToken()}`);
    }

    const response = await global.fetch(buildUrl(preferredBackend, query), {
      ...options,
      headers
    });

    if (preferredBackend === "d1" && response.status === 401) {
      clearAdminToken();
      throw new Error("Jeton administrateur refusé. Recharge la page et saisis le nouveau jeton.");
    }

    if (!response.ok) {
      const details = await response.text();
      throw new Error(details || `${preferredBackend.toUpperCase()} répond ${response.status}`);
    }

    setActiveBackend(preferredBackend);
    return response;
  }

  function setActiveBackend(backend) {
    activeBackend = backend;
    global.dispatchEvent(new CustomEvent("frj:backendchange", {
      detail: { backend }
    }));
  }

  function buildUrl(backend, query) {
    const suffix = String(query || "");
    if (suffix.startsWith("?") || suffix.startsWith("/")) {
      return `${backends[backend]}${suffix}`;
    }
    return `${backends[backend]}/${suffix}`;
  }

  function getAdminToken() {
    let token = "";
    try {
      token = global.sessionStorage.getItem(ADMIN_TOKEN_KEY) || "";
    } catch (error) {
      console.warn("sessionStorage indisponible pour le jeton administrateur.", error);
    }

    if (!token) {
      token = String(global.prompt("Jeton administrateur D1 :") || "").trim();
      if (!token) throw new Error("Import annulé : aucun jeton administrateur fourni.");
      try {
        global.sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
      } catch (error) {
        console.warn("Le jeton restera en mémoire uniquement pour cet envoi.", error);
      }
    }

    return token;
  }

  function clearAdminToken() {
    try {
      global.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    } catch (error) {
      console.warn("Impossible d'effacer le jeton de session.", error);
    }
  }

  function preserveBackendInAdminLinks() {
    if (preferredBackend !== "d1") return;
    document.querySelectorAll(".nav-admin a").forEach((link) => {
      const url = new URL(link.href, global.location.href);
      url.searchParams.set("backend", "d1");
      link.href = url.toString();
    });
  }

  global.FRJ_API = Object.freeze({
    fetch: request,
    backend: preferredBackend,
    get activeBackend() { return activeBackend; },
    label: preferredBackend === "d1" ? "Cloudflare D1" : "Google Sheets / GAS",
    clearAdminToken,
    preserveBackendInAdminLinks
  });
})(window);
