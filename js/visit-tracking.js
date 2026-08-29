(function initVisitTracking(global) {
  "use strict";

  const VISITOR_KEY = "FRJ_VISIT_VISITOR_ID_V1";
  const SESSION_KEY = "FRJ_VISIT_SESSION_V1";
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  let lastCounter = null;

  function createId() {
    if (typeof global.crypto?.randomUUID === "function") return global.crypto.randomUUID();
    if (typeof global.crypto?.getRandomValues !== "function") {
      throw new Error("Générateur aléatoire sécurisé indisponible");
    }
    const bytes = global.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function readStorage(key) {
    for (const storage of [global.localStorage, global.sessionStorage]) {
      try {
        const value = storage?.getItem(key);
        if (value) return value;
      } catch {}
    }
    return "";
  }

  function writeStorage(key, value) {
    for (const storage of [global.localStorage, global.sessionStorage]) {
      try {
        storage?.setItem(key, value);
        return;
      } catch {}
    }
  }

  function visitContext() {
    const now = Date.now();
    let visitorId = readStorage(VISITOR_KEY);
    if (!visitorId) {
      visitorId = createId();
      writeStorage(VISITOR_KEY, visitorId);
    }
    let session = {};
    try {
      session = JSON.parse(readStorage(SESSION_KEY) || "{}");
    } catch {}
    if (!session.id || !session.lastActivity || now - Number(session.lastActivity) > SESSION_TIMEOUT_MS) {
      session.id = createId();
    }
    session.lastActivity = now;
    writeStorage(SESSION_KEY, JSON.stringify(session));
    return { visitorId, sessionId: session.id };
  }

  function currentLanguage() {
    try {
      return global.localStorage?.getItem("lang") === "FR" ? "FR" : "EN";
    } catch {
      return "EN";
    }
  }

  function renderCounter(counter = lastCounter) {
    const element = document.getElementById("publicVisitCounter");
    if (!element || !counter) return;
    lastCounter = counter;
    const visits = Number(counter.visits || 0);
    const language = currentLanguage();
    element.textContent = language === "FR"
      ? `${visits.toLocaleString("fr-FR")} ${visits > 1 ? "visites" : "visite"}`
      : `${visits.toLocaleString("en-US")} ${visits === 1 ? "visit" : "visits"}`;
    if (counter.startDate) {
      const date = new Date(`${counter.startDate}T00:00:00Z`);
      const label = Number.isNaN(date.getTime())
        ? counter.startDate
        : date.toLocaleDateString(language === "FR" ? "fr-FR" : "en-GB", { timeZone: "UTC" });
      element.title = language === "FR"
        ? `Comptabilisées depuis le ${label}`
        : `Counted since ${label}`;
    }
  }

  async function record() {
    const page = String(document.body?.dataset?.visitModule || "").trim();
    if (!page || typeof global.FRJ_API?.recordVisit !== "function") return;
    try {
      const context = visitContext();
      const result = await global.FRJ_API.recordVisit({
        eventId: createId(),
        visitorId: context.visitorId,
        sessionId: context.sessionId,
        page,
        admin: global.FRJ_ADMIN?.active === true
      });
      renderCounter(result.counter);
    } catch (error) {
      console.warn("Comptage de visite indisponible :", error);
      if (typeof global.FRJ_API?.getVisitCounter === "function") {
        try {
          renderCounter(await global.FRJ_API.getVisitCounter());
        } catch {}
      }
    }
  }

  global.FRJ_VISITS = Object.freeze({ refreshCounterLabel: () => renderCounter() });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", record);
  else record();
})(window);
