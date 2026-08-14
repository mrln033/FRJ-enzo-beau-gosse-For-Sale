(function initFrjApi(global) {
  "use strict";

  const GAS_URL = "https://script.google.com/macros/s/AKfycbxD_sOPcjLT-eWPrDMfLgaSx16yAeH17SCd8xByP2faU24z8ge5AiAWOueVBRanHjGx/exec";
  const GAS_ORDER_URL = "https://script.google.com/macros/s/AKfycbxa0B_4R6tsn8aQCLy1Y3LEqbDj4SY22xbascJfMRd1I1thQkCRPySAjszdHoxX1h2a/exec";
  const D1_URL = "https://frj-for-sale-api.merlin-merzhin-lesage.workers.dev";
  const ADMIN_TOKEN_KEY = "FRJ_D1_ADMIN_TOKEN";
  const requestedBackend = new URLSearchParams(global.location.search).get("backend");
  const preferredBackend = requestedBackend === "d1" ? "d1" : "gas";
  let activeBackend = preferredBackend;

  reflectBackend(preferredBackend);

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
        setActiveBackend(backend);
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

    setActiveBackend(preferredBackend);
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
    setActiveBackend("d1");
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
      let message = details;
      try { message = JSON.parse(details)?.error || details; } catch {}
      const error = new Error(message || `D1 répond ${response.status}`);
      error.status = response.status;
      throw error;
    }

    setActiveBackend("d1");
    return response;
  }

  async function requestGas(query, options = {}) {
    setActiveBackend("gas");
    const response = await global.fetch(buildUrl("gas", query), options);
    if (!response.ok) {
      const details = await response.text();
      throw new Error(details || `GAS répond ${response.status}`);
    }
    setActiveBackend("gas");
    return response;
  }

  async function submitOrder(payload) {
    const body = JSON.stringify(payload);
    try {
      const response = await global.fetch(`${D1_URL}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      const result = await readJsonResponse(response);
      if (response.ok) return { ...result, backend: "d1" };
      if (response.status < 500) {
        const error = new Error(result.error || `D1 répond ${response.status}`);
        error.status = response.status;
        error.details = result;
        throw error;
      }
      throw new Error(result.error || `D1 répond ${response.status}`);
    } catch (d1Error) {
      if (d1Error?.status && d1Error.status < 500) throw d1Error;
      try {
        setActiveBackend("gas");
        const response = await global.fetch(`${GAS_ORDER_URL}?type=order`, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body
        });
        const result = await readJsonResponse(response);
        if (result.ok !== true) {
          const error = new Error(result.error || "GAS a refusé la demande");
          if (result.code === "stock-changed") {
            error.status = 409;
            error.details = result;
          }
          throw error;
        }
        return { ...result, backend: "gas" };
      } catch (gasError) {
        if (gasError?.status === 409) throw gasError;
        const error = new Error(`D1 indisponible (${errorMessage(d1Error)}) ; secours GAS impossible (${errorMessage(gasError)})`);
        error.cause = { d1Error, gasError };
        throw error;
      }
    }
  }

  async function getOrderStatus(accessToken) {
    const token = String(accessToken || "").trim();
    if (!/^[a-f0-9-]{70,80}$/i.test(token)) {
      const error = new Error("Lien de suivi invalide");
      error.status = 400;
      throw error;
    }
    const response = await global.fetch(`${D1_URL}/orders/status/${encodeURIComponent(token)}`, {
      method: "GET",
      cache: "no-store"
    });
    const result = await readJsonResponse(response);
    if (!response.ok) {
      const error = new Error(result.error || `D1 répond ${response.status}`);
      error.status = response.status;
      error.details = result;
      throw error;
    }
    return result.order;
  }

  async function acceptOrderProposal(accessToken, proposalVersion) {
    const token = String(accessToken || "").trim();
    const version = Number(proposalVersion);
    if (!/^[a-f0-9-]{70,80}$/i.test(token) || !Number.isInteger(version) || version < 1) {
      const error = new Error("Proposition de demande invalide");
      error.status = 400;
      throw error;
    }
    const response = await global.fetch(`${D1_URL}/orders/status/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalVersion: version })
    });
    const result = await readJsonResponse(response);
    if (!response.ok) {
      const error = new Error(result.error || `D1 répond ${response.status}`);
      error.status = response.status;
      error.details = result;
      throw error;
    }
    return result;
  }

  async function cancelOrder(accessToken, sourceBackend = "d1") {
    const token = String(accessToken || "").trim();
    if (!/^[a-f0-9-]{70,80}$/i.test(token)) {
      const error = new Error("Lien de suivi invalide");
      error.status = 400;
      throw error;
    }
    const response = await global.fetch(`${D1_URL}/orders/status/${encodeURIComponent(token)}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const result = await readJsonResponse(response);
    if (response.ok) return result;
    if (sourceBackend === "gas" && (response.status === 404 || response.status >= 500)) {
      const gasResponse = await global.fetch(`${GAS_ORDER_URL}?type=orderCancel`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ accessToken: token })
      });
      const gasResult = await readJsonResponse(gasResponse);
      if (gasResponse.ok && gasResult.ok === true) return { ...gasResult, backend: "gas" };
      const gasError = new Error(gasResult.error || "GAS a refusé l’annulation");
      gasError.status = gasResponse.status;
      throw gasError;
    }
    {
      const error = new Error(result.error || `D1 répond ${response.status}`);
      error.status = response.status;
      error.details = result;
      throw error;
    }
  }

  async function readJsonResponse(response) {
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { error: text || `Réponse ${response.status}` };
    }
  }

  async function importToBoth(query, options = {}, config = {}) {
    const body = options.body;
    const results = [];

    try {
      if (typeof config.beforeGas === "function") await config.beforeGas();
      const response = await requestGas(query, options);
      results.push({ backend: "gas", ok: true, message: await readImportMessage(response, "GAS") });
    } catch (error) {
      results.push({ backend: "gas", ok: false, message: errorMessage(error) });
    }

    const gasResult = results.find((result) => result.backend === "gas");
    const d1Query = gasResult?.ok ? appendQueryParameter(query, "paired", "gas") : query;
    try {
      const response = await requestD1Admin(d1Query, options);
      results.push({ backend: "d1", ok: true, message: await readImportMessage(response, "D1") });
    } catch (error) {
      results.push({ backend: "d1", ok: false, message: errorMessage(error) });
    }

    const d1Result = results.find((result) => result.backend === "d1");
    if (gasResult?.ok && d1Result?.ok && config.dataset && typeof body === "string") {
      try {
        await publishGasObservation(config.dataset, body, { paired: true });
      } catch (error) {
        gasResult.warning = `État GAS non publié immédiatement dans le rapport : ${errorMessage(error)}`;
      }
    }

    return {
      ok: results.every((result) => result.ok),
      partial: results.some((result) => result.ok) && results.some((result) => !result.ok),
      results
    };
  }

  async function readImportMessage(response, backend) {
    const message = String(await response.text()).trim();
    if (backend === "GAS" && (/^<!doctype html/i.test(message) || /<title>Erreur<\/title>/i.test(message))) {
      const plainText = message.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      throw new Error(plainText || "GAS a retourné une page d’erreur");
    }
    if (/^❌/.test(message)) throw new Error(message);
    return message || `Import ${backend} terminé`;
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function appendQueryParameter(query, name, value) {
    const source = String(query || "");
    const separator = source.includes("?") ? "&" : "?";
    return `${source}${separator}${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  }

  async function requestSynchronization(dataset, reason) {
    return requestD1Admin("/admin/sync-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset, reason })
    });
  }

  async function publishGasObservation(dataset, raw, options = {}) {
    const eventId = global.crypto?.randomUUID
      ? global.crypto.randomUUID()
      : `gas-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return requestD1Admin("/admin/sync-observation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset, raw, eventId, paired: options.paired === true })
    });
  }

  function setActiveBackend(backend) {
    activeBackend = backend;
    reflectBackend(backend);
    global.dispatchEvent(new CustomEvent("frj:backendchange", {
      detail: { backend }
    }));
  }

  function reflectBackend(backend) {
    const root = global.document?.documentElement;
    if (root) root.dataset.frjBackend = backend;
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
    fetchGas: requestGas,
    fetchD1Admin: requestD1Admin,
    importToBoth,
    requestSynchronization,
    publishGasObservation,
    submitOrder,
    getOrderStatus,
    acceptOrderProposal,
    cancelOrder,
    backend: preferredBackend,
    get activeBackend() { return activeBackend; },
    label: preferredBackend === "d1" ? "Cloudflare D1" : "Google Sheets / GAS",
    clearAdminToken,
    preserveBackendInAdminLinks
  });
})(window);
