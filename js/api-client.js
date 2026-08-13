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
      headers.set("Authorization", `Bearer ${await getAdminToken()}`);
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

  async function requestD1Admin(query, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${await getAdminToken()}`);
    const response = await global.fetch(buildUrl("d1", query), {
      ...options,
      headers
    });

    if (response.status === 401) {
      clearAdminToken();
      throw new Error("Jeton administrateur refusé. Recharge la page et saisis le nouveau jeton.");
    }
    if (!response.ok) {
      const details = await response.text();
      throw new Error(details || `D1 répond ${response.status}`);
    }

    setActiveBackend("d1");
    return response;
  }

  async function requestSynchronization(dataset, reason) {
    return requestD1Admin("/admin/sync-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset, reason })
    });
  }

  async function publishGasObservation(dataset, raw) {
    const eventId = global.crypto?.randomUUID
      ? global.crypto.randomUUID()
      : `gas-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return requestD1Admin("/admin/sync-observation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset, raw, eventId })
    });
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

  async function getAdminToken() {
    let token = readStoredToken(global.sessionStorage, "sessionStorage");
    if (!token) token = readStoredToken(global.localStorage, "localStorage");

    if (token) return token;

    const credentials = await requestAdminToken();
    token = credentials.token;
    if (!token) throw new Error("Import annulé : aucun jeton administrateur fourni.");

    const storage = credentials.persist ? global.localStorage : global.sessionStorage;
    try {
      storage.setItem(ADMIN_TOKEN_KEY, token);
    } catch (error) {
      console.warn("Impossible d'enregistrer le jeton administrateur dans le stockage demandé.", error);
    }
    return token;
  }

  function readStoredToken(storage, storageName) {
    try {
      return storage?.getItem(ADMIN_TOKEN_KEY) || "";
    } catch (error) {
      console.warn(`${storageName} indisponible pour le jeton administrateur.`, error);
      return "";
    }
  }

  function requestAdminToken() {
    if (typeof document === "undefined" || !document.body) {
      return Promise.resolve({
        token: String(global.prompt("Jeton administrateur D1 :") || "").trim(),
        persist: false
      });
    }

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "admin-token-overlay";
      const form = document.createElement("form");
      form.className = "admin-token-dialog";
      form.innerHTML = `
        <h2>Accès administrateur D1</h2>
        <label class="admin-token-field">
          Jeton administrateur
          <input type="password" name="token" autocomplete="current-password" required>
        </label>
        <label class="admin-token-persist">
          <input type="checkbox" name="persist">
          Enregistrer sur cette machine
        </label>
        <p class="admin-token-help">Décoché : le jeton est oublié à la fermeture de cet onglet.</p>
        <div class="admin-token-actions">
          <button type="button" class="secondary" data-action="cancel">Annuler</button>
          <button type="submit">Valider</button>
        </div>`;
      overlay.appendChild(form);
      document.body.appendChild(overlay);

      const finish = (result) => {
        overlay.remove();
        resolve(result);
      };
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const data = new FormData(form);
        finish({
          token: String(data.get("token") || "").trim(),
          persist: data.get("persist") === "on"
        });
      });
      form.querySelector('[data-action="cancel"]').addEventListener("click", () => {
        finish({ token: "", persist: false });
      });
      form.querySelector('input[name="token"]').focus();
    });
  }

  function clearAdminToken() {
    for (const [storage, storageName] of [
      [global.sessionStorage, "sessionStorage"],
      [global.localStorage, "localStorage"]
    ]) {
      try {
        storage?.removeItem(ADMIN_TOKEN_KEY);
      } catch (error) {
        console.warn(`Impossible d'effacer le jeton de ${storageName}.`, error);
      }
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
    fetchD1Admin: requestD1Admin,
    requestSynchronization,
    publishGasObservation,
    backend: preferredBackend,
    get activeBackend() { return activeBackend; },
    label: preferredBackend === "d1" ? "Cloudflare D1" : "Google Sheets / GAS",
    clearAdminToken,
    preserveBackendInAdminLinks
  });
})(window);
