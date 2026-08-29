import { PUBLIC_ORIGINS } from "./config.js";
import {
  handleAdminGet,
  handleAdminPost,
  handleGet,
  handlePost,
  handlePublicOrderAcceptance,
  handlePublicOrderCancellation,
  handlePublicOrderGet,
  handlePublicOrderPost,
  handleSyncGet,
  handleSyncPost
} from "./application.js";
import { ApiError, corsPreflight, isAuthorized, json, withCors } from "./http.js";
import {
  handleAdminVisitStatisticsGet,
  handleVisitCounterGet,
  handleVisitPost
} from "./visits.js";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return corsPreflight(origin);
    }

    try {
      const url = new URL(request.url);
      const isSyncRequest = url.pathname.startsWith("/sync/");
      const isAdminRequest = url.pathname.startsWith("/admin/");
      const isPublicOrderRequest = url.pathname === "/orders" || url.pathname.startsWith("/orders/status/");

      if (isSyncRequest && !(await isAuthorized(request, env.SYNC_TOKEN || env.ADMIN_TOKEN))) {
        return withCors(json({ error: "Unauthorized" }, 401), origin);
      }

      if (isAdminRequest && !(await isAuthorized(request, env.ADMIN_TOKEN))) {
        return withCors(json({ error: "Unauthorized" }, 401), origin);
      }

      if (request.method === "GET") {
        if (isSyncRequest) return withCors(await handleSyncGet(url, env), origin);
        if (url.pathname === "/admin/visit-statistics") {
          return withCors(await handleAdminVisitStatisticsGet(url, env), origin);
        }
        if (isAdminRequest) return withCors(await handleAdminGet(url, env), origin);
        if (url.pathname === "/visits/counter") return withCors(await handleVisitCounterGet(env), origin);
        if (isPublicOrderRequest) return withCors(await handlePublicOrderGet(url, env), origin);
        return withCors(await handleGet(url, env), origin);
      }

      if (request.method === "POST") {
        if (isSyncRequest) return withCors(await handleSyncPost(request, url, env), origin);
        if (url.pathname === "/visits") {
          if (!PUBLIC_ORIGINS.has(String(origin || ""))) {
            return withCors(json({ error: "Origine non autorisée" }, 403), origin);
          }
          return withCors(await handleVisitPost(request, env), origin);
        }
        if (/^\/orders\/status\/[a-f0-9-]{70,80}\/(?:accept|cancel)$/i.test(url.pathname)) {
          if (!PUBLIC_ORIGINS.has(String(origin || ""))) {
            return withCors(json({ error: "Origine non autorisée" }, 403), origin);
          }
          if (url.pathname.toLowerCase().endsWith("/cancel")) {
            return withCors(await handlePublicOrderCancellation(url, env), origin);
          }
          return withCors(await handlePublicOrderAcceptance(request, url, env), origin);
        }
        if (url.pathname === "/orders") {
          if (!PUBLIC_ORIGINS.has(String(origin || ""))) {
            return withCors(json({ error: "Origine non autorisée" }, 403), origin);
          }
          return withCors(await handlePublicOrderPost(request, env), origin);
        }
        if (!(await isAuthorized(request, env.ADMIN_TOKEN))) {
          return withCors(json({ error: "Unauthorized" }, 401), origin);
        }
        if (isAdminRequest) return withCors(await handleAdminPost(request, url, env), origin);
        return withCors(await handlePost(request, url, env), origin);
      }

      return withCors(json({ error: "Method not allowed" }, 405), origin);
    } catch (error) {
      if (error instanceof ApiError) {
        return withCors(json({ error: error.message }, error.status), origin);
      }

      console.error(JSON.stringify({
        message: "Unhandled API error",
        method: request.method,
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error)
      }));
      return withCors(json({ error: "Erreur interne" }, 500), origin);
    }
  }
};
