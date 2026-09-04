import { computeWeightedMarkup, normalizeInventoryRows, normalizeMarketRows } from "./domain.js";
import {
  catalogContentHash,
  catalogRowsWithKeys,
  containerContentHash,
  discountCampaignContentHash,
  discountConfigContentHash,
  inventoryContentHash,
  inventoryRowsWithKeys,
  mapCatalogDbRow,
  mapContainerSyncDbRow,
  mapInventoryDbRow,
  mapMarketDbRow,
  marketRowKey,
  marketContentHash,
  mergeMarketRows,
  normalizeSyncTimestamp,
  shouldSignalSyncAfterImport
} from "./sync.js";
import {
  canClientCancelOrder,
  canReviseOrder,
  confirmsOrderPricing,
  hasSameOrderTerms,
  normalizeAdminOrderDraft,
  normalizeAdminOrderLine,
  normalizeOrderSubmission,
  orderItemKey,
  formatMarkup,
  priceOrderLine,
  priceOrderLines,
  reviseOrderLine,
  validateOrderStatus
} from "./orders.js";
import { sendOrUpdateDiscordOrder } from "./discord.js";
import { diffContainerConfig, mapContainerConfigRow, normalizeContainerConfigPayload } from "./containers.js";
import { businessDateInParis, computeDiscountedMarkup } from "./discounts.js";
import {
  createDiscountCampaign,
  generateDailyPromotion,
  readDiscountAdministration,
  refreshTomorrowDailyPromotion,
  updateDiscountCampaign,
  updateDiscountConfig
} from "./discount-admin.js";
import {
  isVisibleOrderHistoryAction,
  mapOrderHistoryEvent,
  normalizeOrderHistoryComment,
  normalizeSyncedOrderHistoryEvent,
  prepareOrderHistoryEvent,
  prepareSyncedOrderHistoryEvent
} from "./order-history.js";
import {
  MAX_IMPORT_BYTES,
  MAX_OBSERVATION_BYTES,
  MAX_ORDER_BYTES,
  SYNC_AUDIT_RETENTION_COUNT,
  AVATAR_SHEETS,
  SYNC_DATASETS
} from "./config.js";
import {
  ApiError,
  cleanNullableNumber,
  cleanNullableText,
  formatFrenchDateTime,
  formatInventoryDate,
  json,
  legacyText,
  parseImport,
  publicJson,
  readTextBody,
  sha256,
  timingSafeEqual
} from "./http.js";

export async function handleGet(url, env) {
  if (url.pathname === "/health") {
    const row = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM catalog_items) AS items,
        (SELECT COUNT(*) FROM catalog_listings) AS listings
    `).first();
    return json({ ok: true, catalogItems: row?.items || 0, catalogListings: row?.listings || 0 });
  }

  const action = url.searchParams.get("action");

  if (action === "features") {
    return publicJson({ cart: isCartEnabled(env) });
  }

  if (action === "categories") {
    const result = await env.DB.prepare(`
      SELECT DISTINCT l.storage
      FROM catalog_listings l
      WHERE l.enabled = 1
        AND l.storage <> ''
        AND l.aisle <> ''
        AND EXISTS (
          SELECT 1
          FROM saleable_inventory ii
          WHERE ii.avatar_id = 'enzo'
            AND ii.item_name = l.item_name COLLATE NOCASE
          GROUP BY ii.item_name COLLATE NOCASE
          HAVING SUM(ii.quantity) > 0
        )
      ORDER BY l.storage
    `).all();
    return publicJson(result.results.map((row) => row.storage));
  }

  if (action === "inventoryDate") {
    const row = await env.DB.prepare(`
      SELECT source_updated_at AS imported_at
      FROM sync_state
      WHERE dataset_key = 'inventory:enzo'
    `).first();
    return publicJson({ inventoryDate: row ? formatInventoryDate(row.imported_at) : "" });
  }

  if (action === "inventoryTarget") {
    const avatar = url.searchParams.get("avatar") || "enzo";
    return publicJson({ avatar, sheet: AVATAR_SHEETS[avatar] || "" });
  }

  const category = String(url.searchParams.get("category") || "").trim().toUpperCase();
  if (!category) return publicJson([]);

  const businessDate = businessDateInParis();
  const result = await env.DB.prepare(`
    SELECT
      l.storage AS STORAGE,
      l.aisle AS RAYON,
      c.name AS ITEM,
      SUM(ii.quantity) AS QUANTITE,
      c.unit_price_ped AS PRIX_UNITAIRE,
      c.image AS IMAGE,
      c.wiki_url AS LIEN_WIKI,
      mo.observed_at AS DATE_MU_ISO,
      mo.weighted_display AS MU,
      COALESCE(s.discount_rate, p.discount_rate, '') AS Remise_Promo,
      COALESCE(s.campaign_type, p.campaign_type, '') AS REMISE_TYPE,
      COALESCE(s.id, p.id, '') AS REMISE_ID,
      COALESCE(s.starts_on, p.starts_on, '') AS REMISE_DEBUT,
      COALESCE(s.ends_on, p.ends_on, '') AS REMISE_FIN
    FROM catalog_listings l
    JOIN catalog_items c ON c.name = l.item_name COLLATE NOCASE
    JOIN saleable_inventory ii
      ON ii.avatar_id = 'enzo'
     AND ii.item_name = c.name COLLATE NOCASE
    LEFT JOIN market_current mo
      ON mo.item_name = c.name COLLATE NOCASE
     AND datetime(mo.observed_at) >= datetime('now', '-7 days')
    LEFT JOIN discount_campaigns s
      ON s.campaign_type = 'sale' AND s.enabled = 1
     AND ? BETWEEN s.starts_on AND s.ends_on
    LEFT JOIN discount_campaigns p
      ON p.campaign_type = 'daily_promo' AND p.enabled = 1
     AND p.starts_on = ?
     AND p.storage = l.storage
     AND p.aisle = l.aisle
    WHERE l.enabled = 1
      AND l.storage = ? COLLATE NOCASE
    GROUP BY
      l.storage, l.aisle, c.name, c.unit_price_ped, c.image, c.wiki_url,
      mo.observed_at, mo.weighted_display,
      s.discount_rate, s.campaign_type, s.id, s.starts_on, s.ends_on,
      p.discount_rate, p.campaign_type, p.id, p.starts_on, p.ends_on
    HAVING SUM(ii.quantity) > 0
    ORDER BY c.name COLLATE NOCASE
  `).bind(businessDate, businessDate, category).all();

  const rows = result.results.map(({ DATE_MU_ISO, ...row }) => ({
    ...row,
    DATE_MU: DATE_MU_ISO ? formatFrenchDateTime(DATE_MU_ISO) : "",
    TOTAL: Number(row.QUANTITE || 0) * Number(row.PRIX_UNITAIRE || 0)
  }));
  return publicJson(rows);
}

export async function handleAdminGet(url, env) {
  if (url.pathname === "/admin/discounts") {
    return json(await readDiscountAdministration(env));
  }
  if (url.pathname === "/admin/orders") {
    return json(await readAdminOrders(env));
  }
  if (url.pathname === "/admin/orders/catalog") {
    return json(await readAdminOrderCatalog(env));
  }
  const orderHistoryMatch = url.pathname.match(/^\/admin\/orders\/([a-f0-9-]{36})\/history$/i);
  if (orderHistoryMatch) {
    return json(await readOrderHistory(env, orderHistoryMatch[1].toLowerCase()));
  }
  if (url.pathname === "/admin/containers") {
    return json(await readContainerConfig(env, url.searchParams.get("avatar")));
  }
  if (url.pathname !== "/admin/sync-report") {
    return json({ error: "Endpoint administrateur inconnu" }, 404);
  }

  // Garantit la présence du référentiel dans le rapport dès le premier
  // affichage, y compris avant la toute première synchronisation GAS.
  await readContainerSnapshot(env);

  const requestedLimit = Number(url.searchParams.get("limit") || 100);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 100, 20), 200);
  const [statesResult, latestResult, eventsResult, latestRunResult, observedResult] = await env.DB.batch([
    env.DB.prepare(`
      SELECT
        dataset_key, content_checksum, source_updated_at, source_origin,
        import_id, row_count, synchronized_at
      FROM sync_state
      ORDER BY dataset_key
    `),
    env.DB.prepare(`
      WITH latest_ids AS (
        SELECT (
          SELECT id
          FROM sync_audit
          WHERE dataset_key = state.dataset_key
            AND action IN ('verified', 'reconciled')
          ORDER BY id DESC
          LIMIT 1
        ) AS id
        FROM sync_state AS state

        UNION ALL

        SELECT (
          SELECT id
          FROM sync_audit
          WHERE dataset_key = '_system'
          ORDER BY id DESC
          LIMIT 1
        ) AS id
      )
      SELECT
        audit.id, audit.dataset_key, audit.direction, audit.action,
        audit.source_checksum, audit.target_checksum, audit.details, audit.created_at
      FROM latest_ids
      JOIN sync_audit AS audit ON audit.id = latest_ids.id
      WHERE latest_ids.id IS NOT NULL
      ORDER BY audit.dataset_key
    `),
    env.DB.prepare(`
      SELECT
        id, dataset_key, direction, action, source_checksum, target_checksum,
        details, created_at
      FROM sync_audit
      ORDER BY id DESC
      LIMIT ?
    `).bind(limit),
    env.DB.prepare(`
      SELECT id, details, created_at
      FROM sync_audit INDEXED BY idx_sync_audit_completed_run_id
      WHERE dataset_key = '_system'
        AND action = 'sync-run-completed'
      ORDER BY id DESC
      LIMIT 1
    `),
    env.DB.prepare(`
      SELECT dataset_key, content_checksum, row_count, source_updated_at,
             observed_at, event_id, provisional
      FROM sync_observed_state
      WHERE side = 'gas'
    `)
  ]);

  const latestByDataset = Object.fromEntries(
    latestResult.results.map((row) => [row.dataset_key, mapSyncAuditRow(row)])
  );
  const latestRun = latestRunResult.results[0] || null;
  let latestRunDetails = {};
  try { latestRunDetails = latestRun?.details ? JSON.parse(latestRun.details) : {}; } catch {}
  const gasFromRuns = Object.fromEntries(
    (Array.isArray(latestRunDetails.datasets) ? latestRunDetails.datasets : [])
      .filter((item) => item?.dataset)
      .map((item) => [item.dataset, {
        hash: String(item.hash || ""),
        rowCount: Number(item.rows || 0),
        updatedAt: normalizeSyncTimestamp(item.updatedAt || latestRunDetails.completedAt || latestRun?.created_at),
        observedAt: normalizeSyncTimestamp(latestRunDetails.completedAt || latestRun?.created_at)
      }])
  );
  const gasByDataset = { ...gasFromRuns };
  observedResult.results.forEach((row) => {
    const observed = {
      hash: String(row.content_checksum || ""),
      rowCount: Number(row.row_count || 0),
      updatedAt: normalizeSyncTimestamp(row.source_updated_at),
      observedAt: normalizeSyncTimestamp(row.observed_at),
      eventId: row.event_id || null,
      provisional: Number(row.provisional || 0) === 1
    };
    const fromRun = gasByDataset[row.dataset_key];
    if (!fromRun || new Date(observed.observedAt).getTime() >= new Date(fromRun.observedAt).getTime()) {
      gasByDataset[row.dataset_key] = observed;
    }
  });
  const datasets = statesResult.results.map((row) => {
    const d1 = {
      ...mapSyncState(row),
      synchronizedAt: normalizeSyncTimestamp(row.synchronized_at)
    };
    const lastAudit = latestByDataset[row.dataset_key] || null;
    const gas = gasByDataset[row.dataset_key] || (lastAudit?.sourceHash ? {
      hash: lastAudit.sourceHash,
      rowCount: Number(lastAudit.details?.rows || 0),
      updatedAt: lastAudit.createdAt,
      observedAt: lastAudit.createdAt
    } : null);
    const hashesMatch = Boolean(!gas?.provisional && gas?.hash && d1.hash && gas.hash === d1.hash);
    const auditMatchesCurrent = Boolean(
      hashesMatch
      && lastAudit?.action === "verified"
      && lastAudit.sourceHash === gas.hash
      && lastAudit.targetHash === d1.hash
    );
    return {
      dataset: row.dataset_key,
      gas,
      d1,
      concordance: !gas ? "unknown" : (gas.provisional ? "change-observed" : (auditMatchesCurrent ? "verified" : (hashesMatch ? "pending-audit" : "different"))),
      lastAudit
    };
  });
  const system = latestByDataset._system || null;
  const lastGasObservationAt = Object.values(gasByDataset).reduce((latest, state) => {
    const value = state?.observedAt || "";
    return !latest || new Date(value).getTime() > new Date(latest).getTime() ? value : latest;
  }, "");

  return json({
    generatedAt: new Date().toISOString(),
    status: !system ? "pending" : (system.action === "sync-run-failed" ? "error" : "ok"),
    system,
    lastGasRunAt: lastGasObservationAt || normalizeSyncTimestamp(latestRunDetails.completedAt || latestRun?.created_at),
    datasets,
    events: eventsResult.results.map(mapSyncAuditRow)
  });
}

export async function handlePost(request, url, env) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_IMPORT_BYTES) throw new ApiError(413, "Import trop volumineux");

  const type = url.searchParams.get("type");
  const shouldSignalSync = shouldSignalSyncAfterImport(url.searchParams.get("paired"));
  const body = await readTextBody(request, MAX_IMPORT_BYTES);

  if (type === "inventory") {
    const avatar = url.searchParams.get("avatar") || "enzo";
    if (!AVATAR_SHEETS[avatar]) return json({ error: `Avatar inconnu : ${avatar}` }, 400);

    const rows = parseImport(() => normalizeInventoryRows(body));
    if (rows.length === 0) return json({ error: "Inventaire vide" }, 400);
    const datasetKey = inventoryDatasetKey(avatar);
    const rawChecksum = await sha256(body);
    if (await isRepeatedRawImport(env, datasetKey, rawChecksum)) {
      const currentState = await readSyncState(env, datasetKey);
      return legacyText(
        `✅ Import inventaire déjà traité dans ${AVATAR_SHEETS[avatar]} (${rows.length + 1} lignes, 0 écriture D1)`,
        currentState?.importId || "unchanged"
      );
    }
    const contentHash = await inventoryContentHash(rows);
    const currentState = await readSyncState(env, datasetKey);
    if (currentState?.hash === contentHash) {
      return legacyText(
        `✅ Import inventaire identique dans ${AVATAR_SHEETS[avatar]} (${rows.length + 1} lignes, 0 écriture D1)`,
        currentState.importId
      );
    }
    const result = await storeInventorySnapshot(env, {
      avatar,
      rows,
      rawChecksum,
      sourceOrigin: "d1",
      sourceUpdatedAt: new Date().toISOString(),
      contentHash
    });
    if (avatar === "enzo") {
      await refreshTomorrowAfterEligibilityChange(env, "reevaluation-promotion-demain-apres-inventaire");
    }
    if (shouldSignalSync) {
      await notifyGasDataChanged(env, `inventory:${avatar}`, "import-d1-inventory");
    }

    return legacyText(
      `✅ Import inventaire OK dans ${AVATAR_SHEETS[avatar]} (${rows.length + 1} lignes)`,
      result.importId,
      result.rowsWritten
    );
  }

  if (type === "mu") {
    const observedAt = new Date().toISOString();
    const incomingRows = parseImport(() => normalizeMarketRows(body, observedAt));
    if (incomingRows.length === 0) return json({ error: "Import MU vide" }, 400);
    const rawChecksum = await sha256(body);
    if (await isRepeatedRawImport(env, "mu", rawChecksum)) {
      const currentState = await readSyncState(env, "mu");
      return legacyText(`Import MU déjà traité (0 écriture D1)`, currentState?.importId || "unchanged");
    }

    const currentRows = (await readMarketSnapshot(env)).rows;
    const existingItems = new Set(currentRows.map((row) => row.itemName.toLocaleLowerCase("en-US")));
    const rows = mergeMarketRows(currentRows, incomingRows);
    const updates = incomingRows.filter((row) => existingItems.has(row.itemName.toLocaleLowerCase("en-US"))).length;
    const inserts = incomingRows.length - updates;
    const contentHash = await marketContentHash(rows);
    const currentState = await readSyncState(env, "mu");
    if (currentState?.hash === contentHash) {
      return legacyText(`${updates} MAJ / ${inserts} AJOUTS (données identiques, 0 écriture D1)`, currentState.importId);
    }
    const result = await storeMarketSnapshot(env, {
      rows,
      rawChecksum,
      sourceOrigin: "d1",
      sourceUpdatedAt: observedAt,
      contentHash
    });
    await refreshTomorrowAfterEligibilityChange(env, "reevaluation-promotion-demain-apres-mu");
    if (shouldSignalSync) {
      await notifyGasDataChanged(env, "mu", "import-d1-mu");
    }

    return legacyText(`${updates} MAJ / ${inserts} AJOUTS`, result.importId, result.rowsWritten);
  }

  return json({ error: `Type inconnu : ${type || "absent"}` }, 400);
}

export async function handleSyncGet(url, env) {
  if (url.pathname === "/sync/orders") {
    return json(await readOrdersForGasMirror(env, url));
  }

  if (url.pathname === "/sync/pending") {
    const row = await env.DB.prepare(`
      SELECT id, details, created_at
      FROM sync_audit INDEXED BY idx_sync_audit_pending_signal_id
      WHERE dataset_key = '_system'
        AND direction = 'signal'
        AND action = 'sync-requested'
      ORDER BY id DESC
      LIMIT 1
    `).first();
    let details = {};
    try { details = row?.details ? JSON.parse(row.details) : {}; } catch {}
    return json({
      request: row ? {
        id: Number(row.id),
        createdAt: normalizeSyncTimestamp(row.created_at),
        dataset: String(details.dataset || ""),
        reason: String(details.reason || "")
      } : null
    });
  }

  if (url.pathname === "/sync/state") {
    return json({ datasets: await readAllSyncStates(env) });
  }

  if (url.pathname === "/sync/inventory") {
    const avatar = url.searchParams.get("avatar") || "enzo";
    if (!AVATAR_SHEETS[avatar]) throw new ApiError(400, `Avatar inconnu : ${avatar}`);
    const snapshot = await readInventorySnapshot(env, avatar, url.searchParams.get("hash"));
    if (!snapshot.state) throw new ApiError(404, "Snapshot inventaire introuvable");
    return json(snapshot);
  }

  if (url.pathname === "/sync/mu") {
    const snapshot = await readMarketSnapshot(env, url.searchParams.get("hash"));
    if (!snapshot.state) throw new ApiError(404, "Snapshot MU introuvable");
    return json(snapshot);
  }

  if (url.pathname === "/sync/catalog") {
    const snapshot = await readCatalogSnapshot(env, url.searchParams.get("hash"));
    if (!snapshot.state) throw new ApiError(404, "Snapshot catalogue introuvable");
    return json(snapshot);
  }

  if (url.pathname === "/sync/containers") {
    const snapshot = await readContainerSnapshot(env, url.searchParams.get("hash"));
    if (!snapshot.state) throw new ApiError(404, "Snapshot des conteneurs introuvable");
    return json(snapshot);
  }

  if (url.pathname === "/sync/discounts") {
    return json(await readDiscountSyncSnapshot(env, url.searchParams.get("hash")));
  }
  if (url.pathname === "/sync/discount-config") {
    return json(await readDiscountConfigSyncSnapshot(env, url.searchParams.get("hash")));
  }

  return json({ error: "Endpoint de synchronisation inconnu" }, 404);
}

export async function handleSyncPost(request, url, env) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_IMPORT_BYTES) throw new ApiError(413, "Synchronisation trop volumineuse");

  const body = await readTextBody(request, MAX_IMPORT_BYTES);
  const payload = parseJsonBody(body);
  const expectedHash = String(request.headers.get("X-Expected-Hash") || "").trim();

  if (url.pathname === "/sync/order") {
    if (!isCartEnabled(env)) throw new ApiError(503, "Transmission des paniers désactivée");
    return json(await importGasFallbackOrder(env, payload));
  }

  if (url.pathname === "/sync/order-history") {
    if (!isCartEnabled(env)) throw new ApiError(503, "Suivi des demandes désactivé");
    return json(await importGasOrderHistory(env, payload));
  }

  if (url.pathname === "/sync/observation") {
    return json(await storeGasObservation(env, payload));
  }
  if (url.pathname === "/sync/observations") {
    const observations = Array.isArray(payload.observations) ? payload.observations : [];
    if (observations.length === 0 || observations.length > SYNC_DATASETS.size) {
      throw new ApiError(400, "Lot d'observations GAS invalide");
    }
    const results = [];
    for (const observation of observations) results.push(await storeGasObservation(env, observation));
    return json({ ok: true, results });
  }

  if (url.pathname === "/sync/inventory") {
    const avatar = url.searchParams.get("avatar") || "enzo";
    if (!AVATAR_SHEETS[avatar]) throw new ApiError(400, `Avatar inconnu : ${avatar}`);
    const datasetKey = inventoryDatasetKey(avatar);
    await assertExpectedHash(env, datasetKey, expectedHash);
    const rows = normalizeSyncedInventoryRows(payload.rows);
    if (rows.length === 0) throw new ApiError(400, "Inventaire synchronisé vide");

    const sourceUpdatedAt = normalizeSyncTimestamp(payload.updatedAt);
    const contentHash = await inventoryContentHash(rows);
    const currentState = await readSyncState(env, datasetKey);
    if (currentState?.hash === contentHash) {
      return json({ ok: true, noChange: true, state: currentState });
    }

    const result = await storeInventorySnapshot(env, {
      avatar,
      rows,
      rawChecksum: await sha256(body),
      sourceOrigin: "gas",
      sourceUpdatedAt,
      contentHash
    });
    if (avatar === "enzo") {
      await refreshTomorrowAfterEligibilityChange(env, "reevaluation-promotion-demain-apres-inventaire");
    }
    return json({ ok: true, noChange: false, state: result.state, rowsWritten: result.rowsWritten });
  }

  if (url.pathname === "/sync/mu") {
    const datasetKey = "mu";
    await assertExpectedHash(env, datasetKey, expectedHash);
    const rows = normalizeSyncedMarketRows(payload.rows);
    if (rows.length === 0) throw new ApiError(400, "Snapshot MU synchronisé vide");

    const sourceUpdatedAt = normalizeSyncTimestamp(payload.updatedAt);
    const contentHash = await marketContentHash(rows);
    const currentState = await readSyncState(env, datasetKey);
    if (currentState?.hash === contentHash) {
      return json({ ok: true, noChange: true, state: currentState });
    }

    const result = await storeMarketSnapshot(env, {
      rows,
      rawChecksum: await sha256(body),
      sourceOrigin: "gas",
      sourceUpdatedAt,
      contentHash
    });
    await refreshTomorrowAfterEligibilityChange(env, "reevaluation-promotion-demain-apres-mu");
    return json({ ok: true, noChange: false, state: result.state, rowsWritten: result.rowsWritten });
  }

  if (url.pathname === "/sync/catalog") {
    const datasetKey = "catalog";
    await assertExpectedHash(env, datasetKey, expectedHash);
    const rows = normalizeSyncedCatalogRows(payload.rows);
    if (rows.length === 0) throw new ApiError(400, "Snapshot catalogue synchronisé vide");

    const sourceUpdatedAt = normalizeSyncTimestamp(payload.updatedAt);
    const contentHash = await catalogContentHash(rows);
    const currentState = await readSyncState(env, datasetKey);
    if (currentState?.hash === contentHash) {
      return json({ ok: true, noChange: true, state: currentState });
    }

    const result = await storeCatalogSnapshot(env, {
      rows,
      sourceOrigin: "gas",
      sourceUpdatedAt,
      contentHash
    });
    await refreshTomorrowAfterEligibilityChange(env, "reevaluation-promotion-demain-apres-catalogue");
    return json({ ok: true, noChange: false, state: result.state, rowsWritten: result.rowsWritten });
  }

  if (url.pathname === "/sync/containers") {
    const datasetKey = "containers";
    await assertExpectedHash(env, datasetKey, expectedHash);
    const rows = normalizeSyncedContainerRows(payload.rows);
    if (rows.length === 0) throw new ApiError(400, "Configuration des conteneurs vide");

    const sourceUpdatedAt = normalizeSyncTimestamp(payload.updatedAt);
    const contentHash = await containerContentHash(rows);
    const currentState = await readSyncState(env, datasetKey);
    if (currentState?.hash === contentHash) {
      return json({ ok: true, noChange: true, state: currentState });
    }

    const result = await storeContainerSnapshot(env, {
      rows,
      sourceOrigin: "gas",
      sourceUpdatedAt,
      contentHash
    });
    await refreshTomorrowAfterEligibilityChange(env, "reevaluation-promotion-demain-apres-conteneurs");
    return json({ ok: true, noChange: false, state: result.state, rowsWritten: result.rowsWritten });
  }

  if (url.pathname === "/sync/discounts") {
    await assertExpectedHash(env, "discounts", expectedHash);
    const result = await storeDiscountSyncSnapshot(env, payload);
    result.ordersRefreshed = (await refreshMutableOrderDiscounts(env)).length;
    return json(result);
  }
  if (url.pathname === "/sync/discount-config") {
    await assertExpectedHash(env, "discount-config", expectedHash);
    return json(await storeDiscountConfigSyncSnapshot(env, payload));
  }

  if (url.pathname === "/sync/ack") {
    const datasetKey = String(payload.dataset || "").trim();
    const acknowledgedHash = String(payload.hash || "").trim().toLowerCase();
    if (!SYNC_DATASETS.has(datasetKey)) throw new ApiError(400, `Dataset inconnu : ${datasetKey || "absent"}`);
    if (!acknowledgedHash) throw new ApiError(400, "Empreinte reconnue absente");
    const current = await readCurrentDatasetSnapshot(env, datasetKey);
    if (!current.state || current.state.hash !== acknowledgedHash) {
      throw new ApiError(409, `Le dataset ${datasetKey} a changé avant reconnaissance`);
    }
    const result = await baselineStatement(env, current.state, current.rows).run();
    return json({ ok: true, noChange: Number(result.meta?.rows_written || 0) === 0, rowsWritten: Number(result.meta?.rows_written || 0) });
  }

  if (url.pathname === "/sync/audit") {
    const datasetKey = String(payload.dataset || "").trim();
    if (!datasetKey) throw new ApiError(400, "Dataset d'audit absent");
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO sync_audit (
          dataset_key, direction, action, source_checksum, target_checksum, details
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        datasetKey,
        String(payload.direction || "audit"),
        String(payload.action || "verified"),
        payload.sourceHash || null,
        payload.targetHash || null,
        payload.details ? JSON.stringify(payload.details) : null
      ),
      syncAuditRetentionStatement(env, datasetKey)
    ]);
    return json({ ok: true });
  }

  return json({ error: "Endpoint de synchronisation inconnu" }, 404);
}

async function storeInventorySnapshot(env, options) {
  const importedAt = new Date().toISOString();
  const importId = crypto.randomUUID();
  const contentHash = options.contentHash || await inventoryContentHash(options.rows);
  const sourceUpdatedAt = normalizeSyncTimestamp(options.sourceUpdatedAt, importedAt);
  const datasetKey = inventoryDatasetKey(options.avatar);
  const consolidatedRows = inventoryRowsWithKeys(options.rows);
  const payload = JSON.stringify(consolidatedRows);

  const dataResults = await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM inventory_current
      WHERE avatar_id = ?
        AND row_key NOT IN (
          SELECT json_extract(value, '$.rowKey') FROM json_each(?)
        )
    `).bind(options.avatar, payload),
    env.DB.prepare(`
      INSERT INTO inventory_current (
        avatar_id, row_key, line_no, source_id, item_name, quantity,
        value_ped, container, container_ref_id
      )
      SELECT
        ?,
        json_extract(value, '$.rowKey'),
        CAST(json_extract(value, '$.lineNo') AS INTEGER),
        json_extract(value, '$.sourceId'),
        json_extract(value, '$.itemName'),
        CAST(json_extract(value, '$.quantity') AS REAL),
        CAST(json_extract(value, '$.valuePed') AS REAL),
        json_extract(value, '$.container'),
        json_extract(value, '$.containerRefId')
      FROM json_each(?)
      WHERE true
      ON CONFLICT (avatar_id, row_key) DO UPDATE SET
        source_id = excluded.source_id,
        item_name = excluded.item_name,
        quantity = excluded.quantity,
        value_ped = excluded.value_ped,
        container = excluded.container,
        container_ref_id = excluded.container_ref_id
      WHERE inventory_current.source_id IS NOT excluded.source_id
         OR inventory_current.item_name IS NOT excluded.item_name
         OR inventory_current.quantity IS NOT excluded.quantity
         OR inventory_current.value_ped IS NOT excluded.value_ped
         OR inventory_current.container IS NOT excluded.container
         OR inventory_current.container_ref_id IS NOT excluded.container_ref_id
    `).bind(options.avatar, payload),
    syncStateStatement(env, {
      datasetKey,
      hash: contentHash,
      updatedAt: sourceUpdatedAt,
      origin: options.sourceOrigin,
      importId,
      rowCount: consolidatedRows.length
    }),
    importGuardStatement(env, datasetKey, options.rawChecksum)
  ]);
  const dataRowsWritten = sumRowsWritten(dataResults);
  const auditResults = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO sync_audit (
        dataset_key, direction, action, source_checksum, target_checksum, details
      ) VALUES (?, ?, 'current-updated', ?, ?, ?)
    `).bind(
      datasetKey,
      options.sourceOrigin === "gas" ? "gas-to-d1" : "d1-local",
      contentHash,
      contentHash,
      JSON.stringify({ importId, rows: consolidatedRows.length, rowsWritten: dataRowsWritten })
    ),
    syncAuditRetentionStatement(env, datasetKey)
  ]);

  return {
    importId,
    state: {
      dataset: datasetKey,
      hash: contentHash,
      updatedAt: sourceUpdatedAt,
      origin: options.sourceOrigin,
      importId,
      rowCount: consolidatedRows.length
    },
    rowsWritten: dataRowsWritten + sumRowsWritten(auditResults)
  };
}

async function storeMarketSnapshot(env, options) {
  const importedAt = new Date().toISOString();
  const importId = crypto.randomUUID();
  const contentHash = options.contentHash || await marketContentHash(options.rows);
  const sourceUpdatedAt = normalizeSyncTimestamp(options.sourceUpdatedAt, importedAt);
  const keyedRows = options.rows.map((row) => ({ ...row, itemKey: marketRowKey(row) }));
  const payload = JSON.stringify(keyedRows);

  const dataResults = await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM market_current
      WHERE item_key NOT IN (
        SELECT json_extract(value, '$.itemKey') FROM json_each(?)
      )
    `).bind(payload),
    env.DB.prepare(`
      INSERT INTO market_current (
        item_key, line_no, item_name, tier,
        day_markup, day_sales, week_markup, week_sales,
        month_markup, month_sales, year_markup, year_sales,
        decade_markup, decade_sales,
        weighted_kind, weighted_value, weighted_display, observed_at
      )
      SELECT
        json_extract(value, '$.itemKey'),
        CAST(json_extract(value, '$.lineNo') AS INTEGER),
        json_extract(value, '$.itemName'),
        json_extract(value, '$.tier'),
        json_extract(value, '$.dayMarkup'),
        json_extract(value, '$.daySales'),
        json_extract(value, '$.weekMarkup'),
        json_extract(value, '$.weekSales'),
        json_extract(value, '$.monthMarkup'),
        json_extract(value, '$.monthSales'),
        json_extract(value, '$.yearMarkup'),
        json_extract(value, '$.yearSales'),
        json_extract(value, '$.decadeMarkup'),
        json_extract(value, '$.decadeSales'),
        json_extract(value, '$.weightedKind'),
        CAST(json_extract(value, '$.weightedValue') AS REAL),
        json_extract(value, '$.weightedDisplay'),
        json_extract(value, '$.observedAt')
      FROM json_each(?)
      WHERE true
      ON CONFLICT (item_key) DO UPDATE SET
        item_name = excluded.item_name,
        tier = excluded.tier,
        day_markup = excluded.day_markup,
        day_sales = excluded.day_sales,
        week_markup = excluded.week_markup,
        week_sales = excluded.week_sales,
        month_markup = excluded.month_markup,
        month_sales = excluded.month_sales,
        year_markup = excluded.year_markup,
        year_sales = excluded.year_sales,
        decade_markup = excluded.decade_markup,
        decade_sales = excluded.decade_sales,
        weighted_kind = excluded.weighted_kind,
        weighted_value = excluded.weighted_value,
        weighted_display = excluded.weighted_display,
        observed_at = excluded.observed_at
      WHERE market_current.item_name IS NOT excluded.item_name
         OR market_current.tier IS NOT excluded.tier
         OR market_current.day_markup IS NOT excluded.day_markup
         OR market_current.day_sales IS NOT excluded.day_sales
         OR market_current.week_markup IS NOT excluded.week_markup
         OR market_current.week_sales IS NOT excluded.week_sales
         OR market_current.month_markup IS NOT excluded.month_markup
         OR market_current.month_sales IS NOT excluded.month_sales
         OR market_current.year_markup IS NOT excluded.year_markup
         OR market_current.year_sales IS NOT excluded.year_sales
         OR market_current.decade_markup IS NOT excluded.decade_markup
         OR market_current.decade_sales IS NOT excluded.decade_sales
         OR market_current.observed_at IS NOT excluded.observed_at
    `).bind(payload),
    syncStateStatement(env, {
      datasetKey: "mu",
      hash: contentHash,
      updatedAt: sourceUpdatedAt,
      origin: options.sourceOrigin,
      importId,
      rowCount: options.rows.length
    }),
    importGuardStatement(env, "mu", options.rawChecksum)
  ]);
  const dataRowsWritten = sumRowsWritten(dataResults);
  const auditResults = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO sync_audit (
        dataset_key, direction, action, source_checksum, target_checksum, details
      ) VALUES ('mu', ?, 'current-updated', ?, ?, ?)
    `).bind(
      options.sourceOrigin === "gas" ? "gas-to-d1" : "d1-local",
      contentHash,
      contentHash,
      JSON.stringify({ importId, rows: options.rows.length, rowsWritten: dataRowsWritten })
    ),
    syncAuditRetentionStatement(env, "mu")
  ]);

  return {
    importId,
    state: {
      dataset: "mu",
      hash: contentHash,
      updatedAt: sourceUpdatedAt,
      origin: options.sourceOrigin,
      importId,
      rowCount: options.rows.length
    },
    rowsWritten: dataRowsWritten + sumRowsWritten(auditResults)
  };
}

async function storeCatalogSnapshot(env, options) {
  const importedAt = new Date().toISOString();
  const importId = crypto.randomUUID();
  const contentHash = options.contentHash || await catalogContentHash(options.rows);
  const sourceUpdatedAt = normalizeSyncTimestamp(options.sourceUpdatedAt, importedAt);
  const payload = JSON.stringify(catalogRowsWithKeys(options.rows));

  const dataResults = await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM catalog_current
      WHERE row_key NOT IN (
        SELECT json_extract(value, '$.rowKey') FROM json_each(?)
      )
    `).bind(payload),
    env.DB.prepare(`
      INSERT INTO catalog_current (
        row_key, line_no, item_name, storage, aisle,
        unit_price_ped, image, wiki_url, enabled
      )
      SELECT
        json_extract(value, '$.rowKey'),
        CAST(json_extract(value, '$.lineNo') AS INTEGER),
        json_extract(value, '$.itemName'),
        upper(trim(json_extract(value, '$.storage'))),
        upper(trim(json_extract(value, '$.aisle'))),
        CAST(json_extract(value, '$.unitPricePed') AS REAL),
        json_extract(value, '$.image'),
        json_extract(value, '$.wikiUrl'),
        CAST(json_extract(value, '$.enabled') AS INTEGER)
      FROM json_each(?)
      WHERE true
      ON CONFLICT (row_key) DO UPDATE SET
        item_name = excluded.item_name,
        storage = excluded.storage,
        aisle = excluded.aisle,
        unit_price_ped = excluded.unit_price_ped,
        image = excluded.image,
        wiki_url = excluded.wiki_url,
        enabled = excluded.enabled
      WHERE catalog_current.item_name IS NOT excluded.item_name
         OR catalog_current.storage IS NOT excluded.storage
         OR catalog_current.aisle IS NOT excluded.aisle
         OR catalog_current.unit_price_ped IS NOT excluded.unit_price_ped
         OR catalog_current.image IS NOT excluded.image
         OR catalog_current.wiki_url IS NOT excluded.wiki_url
         OR catalog_current.enabled IS NOT excluded.enabled
    `).bind(payload),
    env.DB.prepare(`
      INSERT INTO catalog_items (name, unit_price_ped, image, wiki_url, created_at, updated_at)
      SELECT
        json_extract(value, '$.itemName'),
        MAX(CAST(json_extract(value, '$.unitPricePed') AS REAL)),
        MAX(json_extract(value, '$.image')),
        MAX(json_extract(value, '$.wikiUrl')),
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM json_each(?)
      WHERE trim(json_extract(value, '$.itemName')) <> ''
      GROUP BY json_extract(value, '$.itemName') COLLATE NOCASE
      ON CONFLICT (name) DO UPDATE SET
        unit_price_ped = excluded.unit_price_ped,
        image = excluded.image,
        wiki_url = excluded.wiki_url,
        updated_at = CURRENT_TIMESTAMP
      WHERE catalog_items.unit_price_ped IS NOT excluded.unit_price_ped
         OR catalog_items.image IS NOT excluded.image
         OR catalog_items.wiki_url IS NOT excluded.wiki_url
    `).bind(payload),
    env.DB.prepare(`
      INSERT INTO catalog_listings (item_name, storage, aisle, enabled)
      SELECT DISTINCT
        json_extract(value, '$.itemName'),
        upper(trim(json_extract(value, '$.storage'))),
        upper(trim(json_extract(value, '$.aisle'))),
        CAST(json_extract(value, '$.enabled') AS INTEGER)
      FROM json_each(?)
      WHERE trim(json_extract(value, '$.itemName')) <> ''
        AND trim(json_extract(value, '$.storage')) <> ''
        AND trim(json_extract(value, '$.aisle')) <> ''
      ON CONFLICT (item_name, storage, aisle) DO UPDATE SET
        enabled = excluded.enabled
      WHERE catalog_listings.enabled IS NOT excluded.enabled
    `).bind(payload),
    env.DB.prepare(`
      DELETE FROM catalog_listings AS listing
      WHERE NOT EXISTS (
        SELECT 1
        FROM catalog_current AS current
        WHERE current.item_name = listing.item_name
          AND current.storage = listing.storage
          AND current.aisle = listing.aisle
      )
    `),
    env.DB.prepare(`
      DELETE FROM catalog_items
      WHERE NOT EXISTS (
        SELECT 1 FROM catalog_listings l
        WHERE l.item_name = catalog_items.name COLLATE NOCASE
      )
    `),
    syncStateStatement(env, {
      datasetKey: "catalog",
      hash: contentHash,
      updatedAt: sourceUpdatedAt,
      origin: options.sourceOrigin,
      importId,
      rowCount: options.rows.length
    })
  ]);
  const dataRowsWritten = sumRowsWritten(dataResults);
  const auditResults = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO sync_audit (
        dataset_key, direction, action, source_checksum, target_checksum, details
      ) VALUES ('catalog', ?, 'current-updated', ?, ?, ?)
    `).bind(
      options.sourceOrigin === "gas" ? "gas-to-d1" : "d1-bootstrap",
      contentHash,
      contentHash,
      JSON.stringify({ importId, rows: options.rows.length, rowsWritten: dataRowsWritten })
    ),
    syncAuditRetentionStatement(env, "catalog")
  ]);

  return {
    importId,
    state: {
      dataset: "catalog",
      hash: contentHash,
      updatedAt: sourceUpdatedAt,
      origin: options.sourceOrigin,
      importId,
      rowCount: options.rows.length
    },
    rowsWritten: dataRowsWritten + sumRowsWritten(auditResults)
  };
}

// Le cron doit publier le même signal de synchronisation qu'une génération
// lancée depuis l'Admin. Sans cela, la campagne existerait dans D1 mais GAS ne
// la découvrirait qu'au prochain audit complet.
export async function handleScheduledDiscountGeneration(env, requestedBusinessDate = null) {
  const businessDate = requestedBusinessDate ? String(requestedBusinessDate) : businessDateInParis();
  const today = await generateDailyPromotion(env, businessDate);
  const tomorrow = await refreshTomorrowDailyPromotion(env, businessDate);
  const generatedDates = [today, tomorrow]
    .filter((result) => result.reason === "GENERATED" || result.reason === "REPLACED")
    .map((result) => result.date);
  if (generatedDates.length) {
    await readDiscountSyncSnapshot(env);
    await notifyGasDataChanged(env, "discounts", "generation-promotion-planifiee-d1");
  }
  const refreshedOrderIds = await refreshMutableOrderDiscounts(env);
  return {
    reason: generatedDates.length ? "GENERATED" : tomorrow.reason,
    date: tomorrow.date,
    campaign: tomorrow.campaign,
    businessDate,
    today,
    tomorrow,
    generatedDates,
    ordersRefreshed: refreshedOrderIds.length
  };
}

async function refreshTomorrowAfterEligibilityChange(env, reason) {
  const result = await refreshTomorrowDailyPromotion(env);
  if (result.changed) {
    await readDiscountSyncSnapshot(env);
    await notifyGasDataChanged(env, "discounts", reason);
  }
  return result;
}

async function storeContainerSnapshot(env, options) {
  const importedAt = new Date().toISOString();
  const importId = crypto.randomUUID();
  const sourceUpdatedAt = normalizeSyncTimestamp(options.sourceUpdatedAt, importedAt);
  const payload = JSON.stringify(options.rows);

  const dataResults = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO container_config (
        avatar_id, container_key, container, enabled, discovered_at, updated_at
      )
      SELECT
        lower(trim(json_extract(value, '$.avatar'))),
        lower(trim(json_extract(value, '$.containerKey'))),
        trim(json_extract(value, '$.container')),
        CAST(json_extract(value, '$.enabled') AS INTEGER),
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM json_each(?)
      WHERE trim(json_extract(value, '$.container')) <> ''
      ON CONFLICT (avatar_id, container_key) DO UPDATE SET
        container = excluded.container,
        enabled = excluded.enabled,
        updated_at = CURRENT_TIMESTAMP
      WHERE container_config.container IS NOT excluded.container
         OR container_config.enabled IS NOT excluded.enabled
    `).bind(payload)
  ]);

  // La règle métier interdit les suppressions : les anciennes lignes D1
  // absentes du snapshot reçu restent dans le référentiel canonique.
  const currentResult = await env.DB.prepare(`
    SELECT avatar_id, container_key, container, enabled
    FROM container_config
    ORDER BY avatar_id, container_key
  `).all();
  const rows = currentResult.results.map(mapContainerSyncDbRow);
  const contentHash = await containerContentHash(rows);
  const state = {
    datasetKey: "containers",
    hash: contentHash,
    updatedAt: sourceUpdatedAt,
    origin: options.sourceOrigin,
    importId,
    rowCount: rows.length
  };
  const stateResults = await env.DB.batch([
    syncStateStatement(env, state),
    env.DB.prepare(`
      INSERT INTO sync_audit (
        dataset_key, direction, action, source_checksum, target_checksum, details
      ) VALUES ('containers', ?, 'current-updated', ?, ?, ?)
    `).bind(
      options.sourceOrigin === "gas" ? "gas-to-d1" : "d1-local",
      contentHash,
      contentHash,
      JSON.stringify({ importId, rows: rows.length, rowsWritten: sumRowsWritten(dataResults) })
    ),
    syncAuditRetentionStatement(env, "containers")
  ]);

  return {
    importId,
    state: {
      dataset: "containers",
      hash: contentHash,
      updatedAt: sourceUpdatedAt,
      origin: options.sourceOrigin,
      importId,
      rowCount: rows.length
    },
    rows,
    rowsWritten: sumRowsWritten(dataResults) + sumRowsWritten(stateResults)
  };
}

async function readInventorySnapshot(env, avatar, requestedHash = null) {
  const datasetKey = inventoryDatasetKey(avatar);
  if (requestedHash) return readBaselineSnapshot(env, datasetKey, requestedHash);
  let state = await readStoredSyncState(env, datasetKey);
  const rowsResult = await env.DB.prepare(`
    SELECT
      line_no, source_id, item_name, quantity,
      value_ped, container, container_ref_id
    FROM inventory_current
    WHERE avatar_id = ?
    ORDER BY line_no
  `).bind(avatar).all();
  const rows = rowsResult.results.map(mapInventoryDbRow);
  if (!rows.length) return { state: null, rows: [] };
  const actualHash = await inventoryContentHash(rows);
  if (!state) state = await bootstrapCurrentState(env, datasetKey, rows, actualHash, "d1-seed");
  if (state.hash !== actualHash || state.rowCount !== rows.length) {
    state.hash = actualHash;
    state.rowCount = rows.length;
    await env.DB.batch([
      syncStateStatement(env, {
        datasetKey,
        hash: actualHash,
        updatedAt: state.updatedAt,
        origin: state.origin,
        importId: state.importId,
        rowCount: rows.length
      }),
      env.DB.prepare(`
        UPDATE sync_baseline
        SET content_checksum = ?, row_count = ?, rows_json = ?, acknowledged_at = CURRENT_TIMESTAMP
        WHERE dataset_key = ?
      `).bind(actualHash, rows.length, JSON.stringify(rows), datasetKey)
    ]);
  }
  return { state, rows };
}

async function readMarketSnapshot(env, requestedHash = null) {
  if (requestedHash) return readBaselineSnapshot(env, "mu", requestedHash);
  let state = await readStoredSyncState(env, "mu");
  const rowsResult = await env.DB.prepare(`
    SELECT
      line_no, item_name, tier,
      day_markup, day_sales, week_markup, week_sales,
      month_markup, month_sales, year_markup, year_sales,
      decade_markup, decade_sales,
      weighted_kind, weighted_value, weighted_display, observed_at
    FROM market_current
    ORDER BY line_no
  `).all();
  const rows = rowsResult.results.map(mapMarketDbRow);
  if (!rows.length) return { state: null, rows: [] };
  if (!state) {
    const updatedAt = rows.reduce((latest, row) => frjLaterTimestamp(latest, row.observedAt), "");
    state = await bootstrapCurrentState(env, "mu", rows, await marketContentHash(rows), "d1-seed", updatedAt);
  }
  return { state, rows };
}

async function readCatalogSnapshot(env, requestedHash = null) {
  if (requestedHash) return readBaselineSnapshot(env, "catalog", requestedHash);
  let state = await readStoredSyncState(env, "catalog");
  const rowsResult = await env.DB.prepare(`
    SELECT
      line_no, item_name, storage, aisle,
      unit_price_ped, image, wiki_url, enabled
    FROM catalog_current
    ORDER BY line_no
  `).all();
  const rows = rowsResult.results.map(mapCatalogDbRow);
  if (!rows.length) return { state: null, rows: [] };
  if (!state) state = await bootstrapCurrentState(env, "catalog", rows, await catalogContentHash(rows), "d1-seed");
  return { state, rows };
}

async function readContainerSnapshot(env, requestedHash = null) {
  if (requestedHash) return readBaselineSnapshot(env, "containers", requestedHash);
  let state = await readStoredSyncState(env, "containers");
  const rowsResult = await env.DB.prepare(`
    SELECT avatar_id, container_key, container, enabled, updated_at
    FROM container_config
    ORDER BY avatar_id, container_key
  `).all();
  const rows = rowsResult.results.map(mapContainerSyncDbRow);
  if (!rows.length) return { state: null, rows: [] };

  const actualHash = await containerContentHash(rows);
  const updatedAt = rowsResult.results.reduce(
    (latest, row) => frjLaterTimestamp(latest, normalizeSyncTimestamp(row.updated_at)),
    ""
  );
  if (!state) {
    state = await bootstrapCurrentState(env, "containers", rows, actualHash, "d1-seed", updatedAt);
  } else if (state.hash !== actualHash || state.rowCount !== rows.length) {
    // Les triggers liés aux inventaires découvrent des conteneurs sans requête
    // HTTP ; leur ajout doit donc également faire évoluer l'état de sync.
    state = {
      dataset: "containers",
      hash: actualHash,
      updatedAt,
      origin: "d1",
      importId: `current:${crypto.randomUUID()}`,
      rowCount: rows.length
    };
    await syncStateStatement(env, {
      datasetKey: state.dataset,
      hash: state.hash,
      updatedAt: state.updatedAt,
      origin: state.origin,
      importId: state.importId,
      rowCount: state.rowCount
    }).run();
  }
  return { state, rows };
}

async function readDiscountSyncSnapshot(env, requestedHash = null) {
  if (requestedHash) return readBaselineSnapshot(env, "discounts", requestedHash);
  const result = await env.DB.prepare(`SELECT id, campaign_type, starts_on, ends_on, storage, aisle,
    discount_rate, enabled, origin, eligible_pair_count, candidate_pair_count, updated_at
    FROM discount_campaigns ORDER BY id`).all();
  const rows = result.results.map((row) => ({
    id: row.id, type: row.campaign_type, startsOn: row.starts_on, endsOn: row.ends_on,
    storage: row.storage, aisle: row.aisle, discountRate: Number(row.discount_rate), enabled: Number(row.enabled) === 1,
    origin: row.origin, eligiblePairCount: row.eligible_pair_count == null ? null : Number(row.eligible_pair_count),
    candidatePairCount: row.candidate_pair_count == null ? null : Number(row.candidate_pair_count),
    updatedAt: normalizeSyncTimestamp(row.updated_at)
  }));
  const hash = await discountCampaignContentHash(rows);
  let state = await readStoredSyncState(env, "discounts");
  if (!state) state = await bootstrapCurrentState(env, "discounts", rows, hash, "d1-seed");
  else if (state.hash !== hash || state.rowCount !== rows.length) {
    state = { dataset: "discounts", hash, updatedAt: new Date().toISOString(), origin: "d1", importId: `current:${crypto.randomUUID()}`, rowCount: rows.length };
    await syncStateStatement(env, { datasetKey: state.dataset, hash, updatedAt: state.updatedAt, origin: state.origin, importId: state.importId, rowCount: rows.length }).run();
  }
  return { state, rows };
}

async function readDiscountConfigSyncSnapshot(env, requestedHash = null) {
  if (requestedHash) return readBaselineSnapshot(env, "discount-config", requestedHash);
  const row = await env.DB.prepare(`SELECT automatic_promotions_enabled, default_promotion_rate, selection_seed, updated_at
    FROM discount_config WHERE singleton = 1`).first();
  const rows = [{ id: "config", automaticPromotionsEnabled: Number(row.automatic_promotions_enabled) === 1,
    defaultPromotionRate: Number(row.default_promotion_rate), selectionSeed: row.selection_seed,
    updatedAt: normalizeSyncTimestamp(row.updated_at) }];
  const hash = await discountConfigContentHash(rows);
  let state = await readStoredSyncState(env, "discount-config");
  if (!state) state = await bootstrapCurrentState(env, "discount-config", rows, hash, "d1-seed", rows[0].updatedAt);
  else if (state.hash !== hash) {
    state = { dataset: "discount-config", hash, updatedAt: rows[0].updatedAt, origin: "d1", importId: `current:${crypto.randomUUID()}`, rowCount: 1 };
    await syncStateStatement(env, { datasetKey: state.dataset, hash, updatedAt: state.updatedAt, origin: state.origin, importId: state.importId, rowCount: 1 }).run();
  }
  return { state, rows };
}

async function storeDiscountSyncSnapshot(env, payload) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const updatedAt = normalizeSyncTimestamp(payload.updatedAt);
  const hash = await discountCampaignContentHash(rows);
  const statements = [env.DB.prepare(`DELETE FROM discount_campaigns`)];
  rows.forEach((row) => statements.push(env.DB.prepare(`INSERT INTO discount_campaigns
    (id,campaign_type,starts_on,ends_on,storage,aisle,discount_rate,enabled,origin,eligible_pair_count,candidate_pair_count,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(row.id,row.type,row.startsOn,row.endsOn,row.storage||null,row.aisle||null,
      Number(row.discountRate),row.enabled?1:0,row.origin||"manual",row.eligiblePairCount??null,row.candidatePairCount??null,
      normalizeSyncTimestamp(row.updatedAt))));
  const state = { dataset:"discounts", hash, updatedAt, origin:"gas", importId:`sync:${crypto.randomUUID()}`, rowCount:rows.length };
  statements.push(syncStateStatement(env,{datasetKey:state.dataset,hash,updatedAt,origin:"gas",importId:state.importId,rowCount:rows.length}));
  statements.push(baselineStatement(env,state,rows));
  await env.DB.batch(statements);
  return { ok:true, noChange:false, state };
}

async function storeDiscountConfigSyncSnapshot(env, payload) {
  const row = Array.isArray(payload.rows) ? payload.rows[0] : null;
  if (!row) throw new ApiError(400,"Configuration des promotions absente");
  const updatedAt = normalizeSyncTimestamp(payload.updatedAt);
  const rows = [{...row,id:"config",updatedAt:normalizeSyncTimestamp(row.updatedAt)}];
  const hash = await discountConfigContentHash(rows);
  const state = { dataset:"discount-config",hash,updatedAt,origin:"gas",importId:`sync:${crypto.randomUUID()}`,rowCount:1 };
  await env.DB.batch([
    env.DB.prepare(`UPDATE discount_config SET automatic_promotions_enabled=?,default_promotion_rate=?,selection_seed=?,updated_at=? WHERE singleton=1`)
      .bind(row.automaticPromotionsEnabled?1:0,Number(row.defaultPromotionRate),row.selectionSeed||"frj-daily-promo",rows[0].updatedAt),
    syncStateStatement(env,{datasetKey:state.dataset,hash,updatedAt,origin:"gas",importId:state.importId,rowCount:1}),
    baselineStatement(env,state,rows)
  ]);
  return {ok:true,noChange:false,state};
}

async function bootstrapCurrentState(env, datasetKey, rows, hash, origin, updatedAt = new Date().toISOString()) {
  const state = {
    dataset: datasetKey,
    hash,
    updatedAt: normalizeSyncTimestamp(updatedAt),
    origin,
    importId: `current:${crypto.randomUUID()}`,
    rowCount: rows.length
  };
  await env.DB.batch([
    syncStateStatement(env, {
      datasetKey,
      hash,
      updatedAt: state.updatedAt,
      origin,
      importId: state.importId,
      rowCount: rows.length
    }),
    baselineStatement(env, state, rows)
  ]);
  return state;
}

function frjLaterTimestamp(left, right) {
  return !left || new Date(right).getTime() > new Date(left).getTime() ? right : left;
}

async function readBaselineSnapshot(env, datasetKey, requestedHash) {
  const row = await env.DB.prepare(`
    SELECT dataset_key, content_checksum, source_updated_at, row_count, rows_json
    FROM sync_baseline
    WHERE dataset_key = ? AND content_checksum = ?
  `).bind(datasetKey, requestedHash).first();
  if (!row) return { state: null, rows: [] };
  let rows;
  try {
    rows = JSON.parse(row.rows_json);
  } catch {
    throw new ApiError(500, `Base commune invalide pour ${datasetKey}`);
  }
  return {
    state: {
      dataset: datasetKey,
      hash: row.content_checksum,
      updatedAt: normalizeSyncTimestamp(row.source_updated_at),
      origin: "common-baseline",
      importId: `baseline:${datasetKey}`,
      rowCount: Number(row.row_count || rows.length)
    },
    rows
  };
}

async function readCurrentDatasetSnapshot(env, datasetKey) {
  if (datasetKey === "catalog") return readCatalogSnapshot(env);
  if (datasetKey === "mu") return readMarketSnapshot(env);
  if (datasetKey === "containers") return readContainerSnapshot(env);
  if (datasetKey === "discounts") return readDiscountSyncSnapshot(env);
  if (datasetKey === "discount-config") return readDiscountConfigSyncSnapshot(env);
  return readInventorySnapshot(env, datasetKey.slice("inventory:".length));
}

async function readStoredSyncState(env, datasetKey) {
  const row = await env.DB.prepare(`
    SELECT dataset_key, content_checksum, source_updated_at, source_origin, import_id, row_count
    FROM sync_state
    WHERE dataset_key = ?
  `).bind(datasetKey).first();
  return row ? mapSyncState(row) : null;
}

async function readAllSyncStates(env) {
  const result = await env.DB.prepare(`
    SELECT dataset_key, content_checksum, source_updated_at, source_origin, import_id, row_count
    FROM sync_state
  `).all();
  const states = Object.fromEntries(result.results.map((row) => {
    const state = mapSyncState(row);
    return [state.dataset, state];
  }));

  for (const avatar of Object.keys(AVATAR_SHEETS)) {
    const datasetKey = inventoryDatasetKey(avatar);
    if (!states[datasetKey]) {
      const snapshot = await readInventorySnapshot(env, avatar);
      if (snapshot.state) states[datasetKey] = snapshot.state;
    }
  }

  if (!states.mu) {
    const snapshot = await readMarketSnapshot(env);
    if (snapshot.state) states.mu = snapshot.state;
  }

  if (!states.catalog) {
    const snapshot = await readCatalogSnapshot(env);
    if (snapshot.state) states.catalog = snapshot.state;
  }

  // Toujours relire ce dataset : un trigger D1 peut l'avoir enrichi depuis la
  // dernière écriture de sync_state.
  const containerSnapshot = await readContainerSnapshot(env);
  if (containerSnapshot.state) states.containers = containerSnapshot.state;
  states.discounts = (await readDiscountSyncSnapshot(env)).state;
  states["discount-config"] = (await readDiscountConfigSyncSnapshot(env)).state;

  return states;
}

async function readSyncState(env, datasetKey) {
  if (datasetKey === "containers") return (await readContainerSnapshot(env)).state;
  if (datasetKey === "discounts") return (await readDiscountSyncSnapshot(env)).state;
  if (datasetKey === "discount-config") return (await readDiscountConfigSyncSnapshot(env)).state;
  const state = await readStoredSyncState(env, datasetKey);
  if (state) return state;

  if (datasetKey === "mu") return (await readMarketSnapshot(env)).state;
  if (datasetKey === "catalog") return (await readCatalogSnapshot(env)).state;
  if (datasetKey.startsWith("inventory:")) {
    return (await readInventorySnapshot(env, datasetKey.slice("inventory:".length))).state;
  }
  return null;
}

async function assertExpectedHash(env, datasetKey, expectedHash) {
  if (!expectedHash) throw new ApiError(428, "X-Expected-Hash requis");
  const state = await readSyncState(env, datasetKey);
  if (!state || state.hash !== expectedHash) {
    throw new ApiError(409, `Le dataset ${datasetKey} a changé pendant la synchronisation`);
  }
}

function syncStateStatement(env, state) {
  return env.DB.prepare(`
    INSERT INTO sync_state (
      dataset_key, content_checksum, source_updated_at, source_origin, import_id, row_count, synchronized_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (dataset_key) DO UPDATE SET
      content_checksum = excluded.content_checksum,
      source_updated_at = excluded.source_updated_at,
      source_origin = excluded.source_origin,
      import_id = excluded.import_id,
      row_count = excluded.row_count,
      synchronized_at = CURRENT_TIMESTAMP
  `).bind(
    state.datasetKey,
    state.hash,
    state.updatedAt,
    state.origin,
    state.importId,
    state.rowCount
  );
}

function syncAuditRetentionStatement(env, datasetKey) {
  return env.DB.prepare(`
    DELETE FROM sync_audit
    WHERE dataset_key = ?
      AND id < COALESCE((
        SELECT id
        FROM sync_audit
        WHERE dataset_key = ?
        ORDER BY id DESC
        LIMIT 1 OFFSET ?
      ), 0)
  `).bind(datasetKey, datasetKey, SYNC_AUDIT_RETENTION_COUNT - 1);
}

function baselineStatement(env, state, rows) {
  return env.DB.prepare(`
    INSERT INTO sync_baseline (
      dataset_key, content_checksum, source_updated_at, row_count, rows_json, acknowledged_at
    ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (dataset_key) DO UPDATE SET
      content_checksum = excluded.content_checksum,
      source_updated_at = excluded.source_updated_at,
      row_count = excluded.row_count,
      rows_json = excluded.rows_json,
      acknowledged_at = CURRENT_TIMESTAMP
    WHERE sync_baseline.content_checksum IS NOT excluded.content_checksum
       OR sync_baseline.row_count IS NOT excluded.row_count
       OR sync_baseline.rows_json IS NOT excluded.rows_json
  `).bind(state.dataset, state.hash, state.updatedAt, rows.length, JSON.stringify(rows));
}

async function isRepeatedRawImport(env, datasetKey, rawChecksum) {
  const row = await env.DB.prepare(`
    SELECT raw_checksum FROM import_guard WHERE dataset_key = ?
  `).bind(datasetKey).first();
  return Boolean(row?.raw_checksum && row.raw_checksum === rawChecksum);
}

function importGuardStatement(env, datasetKey, rawChecksum) {
  return env.DB.prepare(`
    INSERT INTO import_guard (dataset_key, raw_checksum, received_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (dataset_key) DO UPDATE SET
      raw_checksum = excluded.raw_checksum,
      received_at = CURRENT_TIMESTAMP
    WHERE import_guard.raw_checksum IS NOT excluded.raw_checksum
  `).bind(datasetKey, String(rawChecksum || ""));
}

function sumRowsWritten(results) {
  return (Array.isArray(results) ? results : [results]).reduce(
    (total, result) => total + Number(result?.meta?.rows_written || 0),
    0
  );
}

function normalizeSyncedInventoryRows(rows) {
  if (!Array.isArray(rows)) throw new ApiError(400, "Lignes inventaire invalides");
  return rows.map((row, index) => ({
    lineNo: index + 2,
    sourceId: cleanNullableText(row?.sourceId),
    itemName: String(row?.itemName || "").trim(),
    quantity: Number(row?.quantity),
    valuePed: cleanNullableNumber(row?.valuePed),
    container: cleanNullableText(row?.container),
    containerRefId: cleanNullableText(row?.containerRefId)
  })).filter((row) => row.itemName && Number.isFinite(row.quantity));
}

function normalizeSyncedMarketRows(rows) {
  if (!Array.isArray(rows)) throw new ApiError(400, "Lignes MU invalides");
  return rows.map((row, index) => {
    const normalized = {
      lineNo: index + 2,
      itemName: String(row?.itemName || "").trim(),
      tier: cleanNullableText(row?.tier),
      dayMarkup: cleanNullableText(row?.dayMarkup),
      daySales: cleanNullableText(row?.daySales),
      weekMarkup: cleanNullableText(row?.weekMarkup),
      weekSales: cleanNullableText(row?.weekSales),
      monthMarkup: cleanNullableText(row?.monthMarkup),
      monthSales: cleanNullableText(row?.monthSales),
      yearMarkup: cleanNullableText(row?.yearMarkup),
      yearSales: cleanNullableText(row?.yearSales),
      decadeMarkup: cleanNullableText(row?.decadeMarkup),
      decadeSales: cleanNullableText(row?.decadeSales),
      observedAt: normalizeSyncTimestamp(row?.observedAt)
    };
    const weighted = computeWeightedMarkup({
      "Day Markup": normalized.dayMarkup,
      "Day Sales": normalized.daySales,
      "Week Markup": normalized.weekMarkup,
      "Week Sales": normalized.weekSales,
      "Month Markup": normalized.monthMarkup,
      "Month Sales": normalized.monthSales,
      "Year Markup": normalized.yearMarkup,
      "Year Sales": normalized.yearSales
    });
    return {
      ...normalized,
      weightedKind: weighted.kind,
      weightedValue: weighted.value,
      weightedDisplay: weighted.display
    };
  }).filter((row) => row.itemName);
}

function normalizeSyncedCatalogRows(rows) {
  if (!Array.isArray(rows)) throw new ApiError(400, "Lignes catalogue invalides");
  return rows.map((row, index) => ({
    lineNo: index + 2,
    itemName: String(row?.itemName || "").trim(),
    storage: String(row?.storage || "").trim().toUpperCase(),
    aisle: String(row?.aisle || "").trim().toUpperCase(),
    unitPricePed: cleanNullableNumber(row?.unitPricePed),
    image: cleanNullableText(row?.image),
    wikiUrl: cleanNullableText(row?.wikiUrl),
    enabled: Number(row?.enabled) === 0 ? 0 : 1
  })).filter((row) => row.itemName);
}

function normalizeSyncedContainerRows(rows) {
  if (!Array.isArray(rows)) throw new ApiError(400, "Lignes de conteneurs invalides");
  const seen = new Set();
  return rows.map((row) => {
    const avatar = String(row?.avatar || "").trim().toLowerCase();
    const container = String(row?.container || "").trim();
    const containerKey = String(row?.containerKey || container).trim().toLowerCase();
    if (!AVATAR_SHEETS[avatar]) throw new ApiError(400, `Avatar inconnu : ${avatar || "absent"}`);
    if (!container || !containerKey) throw new ApiError(400, "Conteneur synchronisé invalide");
    if (typeof row?.enabled !== "boolean") throw new ApiError(400, `État invalide : ${avatar}/${containerKey}`);
    const stableKey = `${avatar}\u001f${containerKey}`;
    if (seen.has(stableKey)) throw new ApiError(400, `Conteneur synchronisé dupliqué : ${avatar}/${containerKey}`);
    seen.add(stableKey);
    return { avatar, containerKey, container, enabled: row.enabled };
  });
}

function parseJsonBody(body) {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("objet attendu");
    return parsed;
  } catch (error) {
    throw new ApiError(400, `JSON de synchronisation invalide : ${error.message}`);
  }
}

function inventoryDatasetKey(avatar) {
  return `inventory:${avatar}`;
}

function mapSyncState(row) {
  return {
    dataset: row.dataset_key,
    hash: row.content_checksum,
    updatedAt: normalizeSyncTimestamp(row.source_updated_at),
    origin: row.source_origin,
    importId: row.import_id,
    rowCount: Number(row.row_count || 0)
  };
}

async function updateOrderProposal(env, orderId, requestedItems) {
  const [orderResult, itemsResult] = await env.DB.batch([
    env.DB.prepare(`
      SELECT id, status, approval_required, proposal_version, frj_member
      FROM purchase_orders WHERE id = ?
    `).bind(orderId),
    env.DB.prepare(`
      SELECT order_id, line_no, item_name, storage, aisle, unit_tt_ped,
             quantity, markup_kind, markup_value, discount_rate
      FROM purchase_order_items WHERE order_id = ? ORDER BY line_no
    `).bind(orderId)
  ]);
  const order = orderResult.results[0];
  if (!order) throw new ApiError(404, "Demande introuvable");
  if (!canReviseOrder(order.status, order.approval_required)) {
    throw new ApiError(409, "Les quantités et MU ne sont plus modifiables à partir du statut À préparer");
  }
  const existingByLine = new Map(itemsResult.results.map((item) => [Number(item.line_no), item]));
  const requestedLineNumbers = new Set();
  requestedItems.forEach((item) => {
    const lineNo = Number(item?.lineNo);
    if (!Number.isInteger(lineNo) || !existingByLine.has(lineNo) || requestedLineNumbers.has(lineNo)) {
      throw new ApiError(400, "Ligne de proposition invalide ou dupliquée");
    }
    requestedLineNumbers.add(lineNo);
  });

  const itemNames = [...new Set(itemsResult.results.map((item) => String(item.item_name)))];
  const stocksResult = await env.DB.prepare(`
    WITH requested AS (
      SELECT CAST(value AS TEXT) AS item_name FROM json_each(?)
    )
    SELECT r.item_name, COALESCE(SUM(ii.quantity), 0) AS stock
    FROM requested r
    LEFT JOIN saleable_inventory ii
      ON ii.avatar_id = 'enzo'
     AND ii.item_name = r.item_name COLLATE NOCASE
    GROUP BY r.item_name COLLATE NOCASE
  `).bind(JSON.stringify(itemNames)).all();
  const stocks = new Map(stocksResult.results.map((row) => [String(row.item_name).toLocaleLowerCase("en-US"), Number(row.stock || 0)]));
  const changed = [];

  requestedItems.forEach((requested) => {
    const existing = existingByLine.get(Number(requested.lineNo));
    const stock = stocks.get(String(existing.item_name).toLocaleLowerCase("en-US")) || 0;
    const revised = parseOrderValue(() => reviseOrderLine(existing, requested, stock));
    const noChange = hasSameOrderTerms(existing, revised);
    if (!noChange) changed.push({
      existing,
      revised,
      baseMarkup: deriveBaseMarkup(
        revised.markupKind,
        revised.markupValue,
        Number(order.frj_member || 0) === 1,
        existing.discount_rate
      )
    });
  });

  if (!changed.length) {
    return {
      ok: true,
      noChange: true,
      status: Number(order.approval_required || 0) === 1 ? "awaiting_approval" : order.status,
      proposalVersion: Number(order.proposal_version || 0)
    };
  }

  const nextVersion = Number(order.proposal_version || 0) + 1;
  const statements = changed.map(({ existing, revised, baseMarkup }) => env.DB.prepare(`
    UPDATE purchase_order_items
    SET quantity = ?, stock_at_submission = ?, markup_kind = ?, markup_value = ?,
        markup_display = ?, unit_sale_ped = ?, line_tt_ped = ?, line_sale_ped = ?, price_status = ?,
        base_markup_kind = ?, base_markup_value = ?, base_markup_profiled = 0
    WHERE order_id = ? AND line_no = ?
  `).bind(
    revised.quantity, revised.stockAtSubmission, revised.markupKind, revised.markupValue,
    revised.markupDisplay, revised.unitSalePed, revised.lineTtPed, revised.lineSalePed,
    revised.priceStatus, baseMarkup.kind, baseMarkup.value, orderId, Number(existing.line_no)
  ));
  statements.push(
    env.DB.prepare(`
      UPDATE purchase_orders
      SET status = 'submitted', approval_required = 1,
          proposal_version = proposal_version + 1,
          total_tt_ped = (SELECT ROUND(COALESCE(SUM(line_tt_ped), 0), 2) FROM purchase_order_items WHERE order_id = ?),
          total_sale_ped = (SELECT ROUND(COALESCE(SUM(line_sale_ped), 0), 2) FROM purchase_order_items WHERE order_id = ?),
          pricing_status = CASE WHEN EXISTS (
            SELECT 1 FROM purchase_order_items WHERE order_id = ? AND price_status = 'to-confirm'
          ) THEN 'to-confirm' ELSE 'estimated' END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(orderId, orderId, orderId, orderId),
    prepareOrderHistoryEvent(env, { orderId, action: "proposal-changed", details: {
      proposalVersion: nextVersion,
      lines: changed.map(({ existing, revised }) => ({ lineNo: Number(existing.line_no), itemName: existing.item_name, revised }))
    } })
  );
  await env.DB.batch(statements);
  const discord = await synchronizeDiscordOrder(env, orderId);
  return {
    ok: true,
    noChange: false,
    status: "awaiting_approval",
    proposalVersion: nextVersion,
    changedLines: changed.length,
    discord: publicDiscordResult(discord)
  };
}

export async function handleAdminPost(request, url, env) {
  if (url.pathname === "/admin/discounts/generate") {
    const payload = parseJsonBody(await readTextBody(request, 20_000));
    const result = payload.date
      ? await generateDailyPromotion(env, payload.date)
      : await handleScheduledDiscountGeneration(env);
    await readDiscountSyncSnapshot(env);
    if (payload.date && result.reason === "GENERATED") {
      await notifyGasDataChanged(env, "discounts", "generation-promotion-d1");
    }
    if (payload.date) result.ordersRefreshed = (await refreshMutableOrderDiscounts(env)).length;
    return json(result);
  }
  if (url.pathname === "/admin/discounts/config") {
    const payload = parseJsonBody(await readTextBody(request, 20_000));
    const result = await updateDiscountConfig(env, payload);
    await readDiscountConfigSyncSnapshot(env);
    await notifyGasDataChanged(env, "discount-config", "configuration-remises-d1");
    return json(result);
  }

  if (url.pathname === "/admin/discounts/campaigns") {
    const payload = parseJsonBody(await readTextBody(request, 20_000));
    const result = await createDiscountCampaign(env, payload);
    await readDiscountSyncSnapshot(env);
    await notifyGasDataChanged(env, "discounts", "creation-campagne-d1");
    result.ordersRefreshed = (await refreshMutableOrderDiscounts(env)).length;
    return json(result, 201);
  }

  const discountCampaignMatch = url.pathname.match(/^\/admin\/discounts\/campaigns\/([a-z0-9_-]{1,180})$/i);
  if (discountCampaignMatch) {
    const payload = parseJsonBody(await readTextBody(request, 20_000));
    const result = await updateDiscountCampaign(env, discountCampaignMatch[1], payload);
    await readDiscountSyncSnapshot(env);
    await notifyGasDataChanged(env, "discounts", "modification-campagne-d1");
    result.ordersRefreshed = (await refreshMutableOrderDiscounts(env)).length;
    return json(result);
  }

  if (url.pathname === "/admin/containers") {
    const payload = parseJsonBody(await readTextBody(request, 100_000));
    return json(await updateContainerConfig(env, payload));
  }

  if (url.pathname === "/admin/orders") {
    const payload = parseJsonBody(await readTextBody(request, 100_000));
    return json(await createAdminOrder(env, payload), 201);
  }

  const orderTrackingLinkMatch = url.pathname.match(
    /^\/admin\/orders\/([a-f0-9-]{36})\/tracking-link$/i
  );
  if (orderTrackingLinkMatch) {
    if (!isCartEnabled(env)) throw new ApiError(503, "Suivi de panier désactivé");
    const orderId = orderTrackingLinkMatch[1].toLowerCase();
    const existing = await env.DB.prepare(`SELECT id FROM purchase_orders WHERE id = ?`)
      .bind(orderId).first();
    if (!existing) throw new ApiError(404, "Demande introuvable");

    const accessToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO purchase_order_tracking_tokens (token_hash, order_id)
      VALUES (?, ?)
    `).bind(await sha256(accessToken), orderId).run();
    const response = json({
      ok: true,
      orderId,
      accessToken,
      trackingPath: `suivi-commande.html?token=${encodeURIComponent(accessToken)}`
    }, 201);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const historyCommentMatch = url.pathname.match(
    /^\/admin\/orders\/([a-f0-9-]{36})\/history\/(\d+)\/comment$/i
  );
  if (historyCommentMatch) {
    const payload = parseJsonBody(await readTextBody(request, 20_000));
    const comment = parseOrderValue(() => normalizeOrderHistoryComment(payload.comment));
    return json(await updateOrderHistoryComment(
      env,
      historyCommentMatch[1].toLowerCase(),
      Number(historyCommentMatch[2]),
      comment
    ));
  }

  const orderProposalMatch = url.pathname.match(/^\/admin\/orders\/([a-f0-9-]{36})\/proposal$/i);
  if (orderProposalMatch) {
    const payload = parseJsonBody(await readTextBody(request, 40_000));
    const requestedItems = Array.isArray(payload.items) ? payload.items : [];
    // Les nouvelles demandes sont limitées à 10 lignes, mais les demandes
    // historiques pouvaient en contenir jusqu'à 30 et doivent rester éditables.
    if (requestedItems.length < 1 || requestedItems.length > 30) {
      throw new ApiError(400, "La proposition doit contenir entre 1 et 30 articles");
    }
    return json(await updateOrderProposal(env, orderProposalMatch[1].toLowerCase(), requestedItems));
  }

  const orderItemAdditionMatch = url.pathname.match(/^\/admin\/orders\/([a-f0-9-]{36})\/items$/i);
  if (orderItemAdditionMatch) {
    const payload = parseJsonBody(await readTextBody(request, 20_000));
    return json(await addAdminOrderItem(env, orderItemAdditionMatch[1].toLowerCase(), payload), 201);
  }

  const orderItemMatch = url.pathname.match(/^\/admin\/orders\/([a-f0-9-]{36})\/items\/(\d+)$/i);
  if (orderItemMatch) {
    const body = await readTextBody(request, 20_000);
    const payload = parseJsonBody(body);
    const orderId = orderItemMatch[1].toLowerCase();
    const lineNo = Number(orderItemMatch[2]);
    const existing = await env.DB.prepare(`
      SELECT oi.order_id, oi.line_no, oi.item_name, oi.storage, oi.aisle, oi.unit_tt_ped,
             oi.quantity, oi.markup_kind, oi.markup_value, oi.discount_rate,
             po.status, po.approval_required, po.frj_member
      FROM purchase_order_items oi
      JOIN purchase_orders po ON po.id = oi.order_id
      WHERE oi.order_id = ? AND oi.line_no = ?
    `).bind(orderId, lineNo).first();
    if (!existing) throw new ApiError(404, "Article de demande introuvable");
    if (!canReviseOrder(existing.status, existing.approval_required)) {
      throw new ApiError(409, "Les quantités et MU ne sont plus modifiables à partir du statut À préparer");
    }

    const stockRow = await env.DB.prepare(`
      SELECT COALESCE(SUM(ii.quantity), 0) AS stock
      FROM saleable_inventory ii
      WHERE ii.avatar_id = 'enzo'
        AND ii.item_name = ? COLLATE NOCASE
    `).bind(existing.item_name).first();
    const revised = parseOrderValue(() => reviseOrderLine(existing, payload, Number(stockRow?.stock || 0)));
    if (hasSameOrderTerms(existing, revised)) {
      return json({ ok: true, noChange: true });
    }
    const baseMarkup = deriveBaseMarkup(
      revised.markupKind,
      revised.markupValue,
      Number(existing.frj_member || 0) === 1,
      existing.discount_rate
    );
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE purchase_order_items
        SET quantity = ?, stock_at_submission = ?, markup_kind = ?, markup_value = ?,
            markup_display = ?, unit_sale_ped = ?, line_tt_ped = ?, line_sale_ped = ?, price_status = ?,
            base_markup_kind = ?, base_markup_value = ?, base_markup_profiled = 0
        WHERE order_id = ? AND line_no = ?
      `).bind(
        revised.quantity, revised.stockAtSubmission, revised.markupKind, revised.markupValue,
        revised.markupDisplay, revised.unitSalePed, revised.lineTtPed, revised.lineSalePed,
        revised.priceStatus, baseMarkup.kind, baseMarkup.value, orderId, lineNo
      ),
      env.DB.prepare(`
        UPDATE purchase_orders
        SET status = 'submitted', approval_required = 1,
            proposal_version = proposal_version + 1,
            total_tt_ped = (SELECT ROUND(COALESCE(SUM(line_tt_ped), 0), 2) FROM purchase_order_items WHERE order_id = ?),
            total_sale_ped = (SELECT ROUND(COALESCE(SUM(line_sale_ped), 0), 2) FROM purchase_order_items WHERE order_id = ?),
            pricing_status = CASE WHEN EXISTS (
              SELECT 1 FROM purchase_order_items WHERE order_id = ? AND price_status = 'to-confirm'
            ) THEN 'to-confirm' ELSE 'estimated' END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(orderId, orderId, orderId, orderId),
      prepareOrderHistoryEvent(env, {
        orderId,
        action: "proposal-line-changed",
        details: { lineNo, itemName: existing.item_name, revised }
      })
    ]);
    const discord = await synchronizeDiscordOrder(env, orderId);
    return json({ ok: true, status: "awaiting_approval", discord: publicDiscordResult(discord) });
  }

  const orderStatusMatch = url.pathname.match(/^\/admin\/orders\/([a-f0-9-]{36})\/status$/i);
  if (orderStatusMatch) {
    const body = await readTextBody(request, 20_000);
    const payload = parseJsonBody(body);
    const status = parseOrderValue(() => validateOrderStatus(payload.status));
    const existing = await env.DB.prepare(`SELECT id, status, approval_required FROM purchase_orders WHERE id = ?`)
      .bind(orderStatusMatch[1].toLowerCase()).first();
    if (!existing) throw new ApiError(404, "Demande introuvable");
    if (existing.status === status && Number(existing.approval_required || 0) === 0) {
      return json({ ok: true, noChange: true, status });
    }
    const confirmsPricing = confirmsOrderPricing(status);
    if (confirmsPricing && canReviseOrder(existing.status, existing.approval_required)) {
      await refreshMutableOrderDiscounts(env, existing.id);
    }
    const statements = [
      env.DB.prepare(`
        UPDATE purchase_orders
        SET status = ?, approval_required = 0,
            pricing_status = CASE WHEN ? = 1 THEN 'confirmed' ELSE pricing_status END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(status, confirmsPricing ? 1 : 0, existing.id)
    ];
    if (confirmsPricing) {
      statements.push(env.DB.prepare(`
        UPDATE purchase_order_items SET price_status = 'confirmed' WHERE order_id = ?
      `).bind(existing.id));
    }
    statements.push(
      prepareOrderHistoryEvent(env, {
        orderId: existing.id,
        action: "status-changed",
        details: { from: existing.status, to: status, pricingConfirmed: confirmsPricing }
      })
    );
    await env.DB.batch(statements);
    const discord = await synchronizeDiscordOrder(env, existing.id);
    return json({ ok: true, noChange: false, status, discord: publicDiscordResult(discord) });
  }

  if (url.pathname === "/admin/sync-audit-now") {
    const body = await readTextBody(request, 20_000);
    const payload = parseJsonBody(body);
    return json(await runImmediateGasAudit(env, payload));
  }

  if (url.pathname === "/admin/sync-observation") {
    const body = await readTextBody(request, MAX_OBSERVATION_BYTES);
    const payload = parseJsonBody(body);
    const dataset = String(payload.dataset || "").trim();
    const raw = String(payload.raw || "");
    const eventId = String(payload.eventId || crypto.randomUUID()).trim();
    const shouldSignalObservation = shouldSignalSyncAfterImport(payload.paired === true ? "gas" : null);
    const observedAt = new Date().toISOString();
    let rows;
    let hash;
    let provisional = false;

    if (dataset.startsWith("inventory:")) {
      const avatar = dataset.slice("inventory:".length);
      if (!AVATAR_SHEETS[avatar]) throw new ApiError(400, `Dataset inconnu : ${dataset}`);
      rows = inventoryRowsWithKeys(parseImport(() => normalizeInventoryRows(raw)));
      hash = await inventoryContentHash(rows);
    } else if (dataset === "mu") {
      const incomingRows = parseImport(() => normalizeMarketRows(raw, observedAt));
      rows = mergeMarketRows((await readMarketSnapshot(env)).rows, incomingRows);
      hash = await marketContentHash(rows);
      // Le timestamp exact est créé par GAS : l'outbox remplacera cette observation
      // prévisionnelle par l'empreinte relue dans Google Sheets au prochain contrôle.
      provisional = true;
    } else {
      throw new ApiError(400, `Dataset d'import GAS inconnu : ${dataset || "absent"}`);
    }

    const observation = await storeGasObservation(env, {
      dataset,
      hash,
      rowCount: rows.length,
      updatedAt: observedAt,
      observedAt,
      eventId,
      provisional
    });
    const signal = shouldSignalObservation
      ? await notifyGasDataChanged(env, dataset, `import-gas-${dataset === "mu" ? "mu" : "inventory"}`)
      : { ok: true, skipped: true, reason: "paired-import-already-current" };
    return json({ ok: true, observation, signal });
  }

  if (url.pathname !== "/admin/sync-request") return json({ error: "Endpoint administrateur inconnu" }, 404);
  const body = await readTextBody(request, 20_000);
  const payload = parseJsonBody(body);
  const dataset = String(payload.dataset || "").trim();
  const reason = String(payload.reason || "modification-gas").trim();
  return json(await notifyGasDataChanged(env, dataset, reason));
}

async function readContainerConfig(env, requestedAvatar) {
  const avatar = String(requestedAvatar || "enzo").trim().toLowerCase();
  if (!AVATAR_SHEETS[avatar]) throw new ApiError(400, `Avatar inconnu : ${avatar || "absent"}`);
  const result = await env.DB.prepare(`
    SELECT container_key, container, enabled, updated_at
    FROM container_config
    WHERE avatar_id = ?
    ORDER BY container COLLATE NOCASE
  `).bind(avatar).all();
  return {
    avatar,
    avatars: Object.entries(AVATAR_SHEETS).map(([id, sheet]) => ({ id, sheet })),
    containers: result.results.map(mapContainerConfigRow)
  };
}

async function updateContainerConfig(env, payload) {
  let normalized;
  try {
    normalized = normalizeContainerConfigPayload(payload, AVATAR_SHEETS);
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "Configuration de conteneurs invalide");
  }

  const current = await readContainerSnapshot(env);
  if (!current.state) throw new ApiError(409, "Configuration des conteneurs introuvable");
  const selectedRows = current.rows
    .filter((row) => row.avatar === normalized.avatar)
    .map((row) => ({ container_key: row.containerKey, enabled: row.enabled ? 1 : 0 }));
  const { changed, missing } = diffContainerConfig(normalized.changes, selectedRows);
  if (missing.length) {
    throw new ApiError(409, "La liste des conteneurs a changé ; rechargez-la avant d'enregistrer");
  }

  if (!changed.length) return { ok: true, avatar: normalized.avatar, changed: 0, noChange: true };

  const changesByKey = new Map(changed.map((entry) => [entry.containerKey, entry.enabled]));
  const rows = current.rows.map((row) => ({
    ...row,
    enabled: row.avatar === normalized.avatar && changesByKey.has(row.containerKey)
      ? changesByKey.get(row.containerKey)
      : row.enabled
  }));
  const stored = await storeContainerSnapshot(env, {
    rows,
    sourceOrigin: "d1",
    sourceUpdatedAt: new Date().toISOString()
  });
  if (normalized.avatar === "enzo") {
    await refreshTomorrowAfterEligibilityChange(env, "reevaluation-promotion-demain-apres-conteneurs");
  }
  const signal = await notifyGasDataChanged(env, "containers", "modification-d1-containers");
  return {
    ok: true,
    avatar: normalized.avatar,
    changed: changed.length,
    noChange: false,
    state: stored.state,
    signal
  };
}

export async function handlePublicOrderGet(url, env) {
  if (!isCartEnabled(env)) throw new ApiError(404, "Suivi de panier désactivé");
  const match = url.pathname.match(/^\/orders\/status\/([a-f0-9-]{70,80})$/i);
  if (!match) throw new ApiError(404, "Demande introuvable");
  const tokenHash = await sha256(match[1]);
  const orderId = await resolveOrderIdByTrackingToken(env, tokenHash);
  if (!orderId) throw new ApiError(404, "Demande introuvable");
  await refreshMutableOrderDiscounts(env, orderId);
  const order = await env.DB.prepare(`
    SELECT id, public_reference, status, approval_required, proposal_version, buyer_avatar, language, frj_member,
           total_tt_ped, total_sale_ped, pricing_status, created_at, updated_at
    FROM purchase_orders
    WHERE id = ?
  `).bind(orderId).first();
  const items = await env.DB.prepare(`
    SELECT line_no, item_name, storage, aisle, quantity, stock_at_submission,
           unit_tt_ped, markup_kind, markup_value, markup_display, unit_sale_ped,
           line_tt_ped, line_sale_ped, price_status,
           base_markup_kind, base_markup_value, base_markup_profiled,
           discount_campaign_id, discount_kind, discount_rate
    FROM purchase_order_items WHERE order_id = ? ORDER BY line_no
  `).bind(order.id).all();
  return json({ order: mapPublicOrder(order, items.results) });
}

export async function handlePublicOrderAcceptance(request, url, env) {
  if (!isCartEnabled(env)) throw new ApiError(503, "Suivi de panier désactivé");
  const match = url.pathname.match(/^\/orders\/status\/([a-f0-9-]{70,80})\/accept$/i);
  if (!match) throw new ApiError(404, "Demande introuvable");
  const payload = parseJsonBody(await readTextBody(request, 20_000));
  const proposalVersion = Number(payload.proposalVersion);
  if (!Number.isInteger(proposalVersion) || proposalVersion < 1) {
    throw new ApiError(400, "Version de proposition invalide");
  }
  const tokenHash = await sha256(match[1]);
  const orderId = await resolveOrderIdByTrackingToken(env, tokenHash);
  if (!orderId) throw new ApiError(404, "Demande introuvable");
  const order = await env.DB.prepare(`
    SELECT id, status, approval_required, proposal_version
    FROM purchase_orders WHERE id = ?
  `).bind(orderId).first();
  if (Number(order.approval_required || 0) !== 1) {
    return json({ ok: true, noChange: true, status: order.status });
  }
  if (Number(order.proposal_version || 0) !== proposalVersion) {
    throw new ApiError(409, "La proposition a changé. Actualisez la page avant de l’accepter.");
  }
  const [result] = await env.DB.batch([
    env.DB.prepare(`
      UPDATE purchase_orders
      SET status = 'submitted', approval_required = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND approval_required = 1 AND proposal_version = ?
    `).bind(order.id, proposalVersion),
    env.DB.prepare(`
      INSERT INTO purchase_order_events (order_id, event_key, action, actor, comment, details)
      SELECT ?, ?, 'proposal-accepted', 'client', ?, ?
      WHERE changes() = 1
    `).bind(
      order.id,
      crypto.randomUUID(),
      "Proposition acceptée par le client.",
      JSON.stringify({ proposalVersion, to: "submitted" })
    )
  ]);
  if (Number(result.meta?.changes || 0) !== 1) {
    throw new ApiError(409, "La proposition a changé. Actualisez la page avant de l’accepter.");
  }
  const discord = await synchronizeDiscordOrder(env, order.id);
  return json({ ok: true, noChange: false, status: "submitted", discord: publicDiscordResult(discord) });
}

export async function handlePublicOrderCancellation(url, env) {
  if (!isCartEnabled(env)) throw new ApiError(503, "Suivi de panier désactivé");
  const match = url.pathname.match(/^\/orders\/status\/([a-f0-9-]{70,80})\/cancel$/i);
  if (!match) throw new ApiError(404, "Demande introuvable");
  const tokenHash = await sha256(match[1]);
  const orderId = await resolveOrderIdByTrackingToken(env, tokenHash);
  if (!orderId) throw new ApiError(404, "Demande introuvable");
  const order = await env.DB.prepare(`
    SELECT id, status, approval_required
    FROM purchase_orders WHERE id = ?
  `).bind(orderId).first();
  if (!canClientCancelOrder(order.status, order.approval_required)) {
    throw new ApiError(409, "Cette demande ne peut plus être annulée par le client");
  }

  const [result] = await env.DB.batch([
    env.DB.prepare(`
      UPDATE purchase_orders
      SET status = 'cancelled', approval_required = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND (approval_required = 1 OR status IN ('submitted', 'viewed'))
    `).bind(order.id),
    env.DB.prepare(`
      INSERT INTO purchase_order_events (order_id, event_key, action, actor, comment, details)
      SELECT ?, ?, 'client-cancelled', 'client', ?, ?
      WHERE changes() = 1
    `).bind(
      order.id,
      crypto.randomUUID(),
      "Demande annulée par le client.",
      JSON.stringify({ to: "cancelled" })
    )
  ]);
  if (Number(result.meta?.changes || 0) !== 1) {
    throw new ApiError(409, "Le statut de la demande a changé. Actualisez le panier.");
  }
  const discord = await synchronizeDiscordOrder(env, order.id);
  return json({ ok: true, status: "cancelled", discord: publicDiscordResult(discord) });
}

export async function handlePublicOrderPost(request, env) {
  if (!isCartEnabled(env)) throw new ApiError(503, "Transmission des paniers désactivée");
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_ORDER_BYTES) throw new ApiError(413, "Panier trop volumineux");
  const body = await readTextBody(request, MAX_ORDER_BYTES);
  const rawPayload = parseJsonBody(body);
  const submission = parseOrderValue(() => normalizeOrderSubmission(rawPayload));
  const accessTokenHash = await sha256(submission.accessToken);
  const duplicate = await env.DB.prepare(`
    SELECT id, public_reference, access_token_hash, status, approval_required, proposal_version,
           total_tt_ped, total_sale_ped,
           pricing_status, created_at, updated_at, buyer_avatar, language, frj_member,
           discord_message_id
    FROM purchase_orders WHERE id = ? OR public_reference = ?
  `).bind(submission.id, submission.publicReference).first();
  if (duplicate) {
    if (!(await timingSafeEqual(String(duplicate.access_token_hash), accessTokenHash))) {
      throw new ApiError(409, "Référence de demande déjà utilisée");
    }
    const discord = duplicate.discord_message_id
      ? { ok: true, action: "already-published", messageId: duplicate.discord_message_id }
      : await synchronizeDiscordOrder(env, duplicate.id);
    return json({
      ok: true,
      duplicate: true,
      order: mapPublicOrder(duplicate, []),
      discord: publicDiscordResult(discord)
    });
  }

  const submitterHash = await orderSubmitterHash(request, env);
  const recentCount = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM purchase_orders
    WHERE submitter_hash = ? AND datetime(created_at) >= datetime('now', '-1 hour')
  `).bind(submitterHash).first();
  if (Number(recentCount?.total || 0) >= 8) {
    throw new ApiError(429, "Trop de demandes récentes. Réessaie dans un moment.");
  }

  const catalogRows = await readOrderCatalogRows(env, submission.items);
  const pricing = priceOrderLines(submission.items, catalogRows, { frjMember: submission.frjMember });
  if (pricing.discrepancies.length) {
    return json({
      error: "Le stock, le prix affiché ou le MU a changé. Actualise le panier avant de confirmer.",
      discrepancies: pricing.discrepancies
    }, 409);
  }

  const order = {
    id: submission.id,
    publicReference: submission.publicReference,
    accessTokenHash,
    status: "submitted",
    buyerAvatar: submission.buyerAvatar,
    buyerContact: submission.buyerContact,
    buyerComment: submission.buyerComment,
    language: submission.language,
    frjMember: submission.frjMember,
    sourceBackend: "d1",
    totalTtPed: pricing.totalTtPed,
    totalSalePed: pricing.totalSalePed,
    pricingStatus: pricing.pricingStatus,
    submitterHash,
    clientCreatedAt: submission.clientCreatedAt
  };
  await storePurchaseOrder(env, order, pricing.lines, "submitted");
  const discord = await synchronizeDiscordOrder(env, order.id);
  return json({
    ok: true,
    duplicate: false,
    order: mapPublicOrder(order, pricing.lines),
    discord: publicDiscordResult(discord)
  }, 201);
}

async function readOrderCatalogRows(env, requestedItems) {
  const requestedJson = JSON.stringify(requestedItems);
  const businessDate = businessDateInParis();
  const result = await env.DB.prepare(`
    WITH requested AS (
      SELECT
        json_extract(value, '$.itemName') AS item_name,
        upper(trim(json_extract(value, '$.storage'))) AS storage,
        upper(trim(json_extract(value, '$.aisle'))) AS aisle
      FROM json_each(?)
    ), inventory AS (
      SELECT ii.item_name, SUM(ii.quantity) AS stock
      FROM saleable_inventory ii
      WHERE ii.avatar_id = 'enzo'
      GROUP BY ii.item_name COLLATE NOCASE
    )
    SELECT
      c.name AS item_name,
      l.storage,
      l.aisle,
      inventory.stock,
      c.unit_price_ped,
      CASE WHEN datetime(mc.observed_at) >= datetime('now', '-7 days') THEN mc.weighted_kind ELSE NULL END AS markup_kind,
       CASE WHEN datetime(mc.observed_at) >= datetime('now', '-7 days') THEN mc.weighted_value ELSE NULL END AS markup_value,
       COALESCE(s.campaign_type, p.campaign_type) AS discount_kind,
       COALESCE(s.id, p.id) AS discount_campaign_id,
       COALESCE(s.discount_rate, p.discount_rate) AS discount_rate
    FROM requested r
    JOIN catalog_listings l
      ON l.item_name = r.item_name COLLATE NOCASE
     AND l.storage = r.storage COLLATE NOCASE
     AND l.aisle = r.aisle COLLATE NOCASE
     AND l.enabled = 1
    JOIN catalog_items c ON c.name = l.item_name COLLATE NOCASE
    JOIN inventory ON inventory.item_name = c.name COLLATE NOCASE
    LEFT JOIN market_current mc ON mc.item_name = c.name COLLATE NOCASE
    LEFT JOIN discount_campaigns s
      ON s.campaign_type = 'sale' AND s.enabled = 1 AND ? BETWEEN s.starts_on AND s.ends_on
    LEFT JOIN discount_campaigns p
      ON p.campaign_type = 'daily_promo' AND p.enabled = 1 AND p.starts_on = ?
     AND p.storage = l.storage AND p.aisle = l.aisle
    WHERE inventory.stock > 0
  `).bind(requestedJson, businessDate, businessDate).all();
  return result.results.map((row) => ({
    itemName: row.item_name,
    storage: row.storage,
    aisle: row.aisle,
    stock: Number(row.stock || 0),
    unitTtPed: Number(row.unit_price_ped || 0),
    markupKind: row.markup_kind || "none",
    markupValue: row.markup_value === null || row.markup_value === undefined ? null : Number(row.markup_value),
    discountKind: row.discount_kind || null,
    discountCampaignId: row.discount_campaign_id || null,
    discountRate: row.discount_rate === null || row.discount_rate === undefined ? null : Number(row.discount_rate)
  }));
}

async function storePurchaseOrder(env, order, items, eventAction, syncedEvent = null) {
  const statements = [
    env.DB.prepare(`
      INSERT INTO purchase_orders (
        id, public_reference, access_token_hash, status, buyer_avatar, buyer_contact,
        buyer_comment, language, frj_member, source_backend, total_tt_ped,
        total_sale_ped, pricing_status, submitter_hash, client_created_at,
        discord_message_id, approval_required, proposal_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      order.id, order.publicReference, order.accessTokenHash, order.status || "submitted",
      order.buyerAvatar, order.buyerContact || null, order.buyerComment || null,
      order.language || "EN", order.frjMember ? 1 : 0, order.sourceBackend || "d1",
      Number(order.totalTtPed || 0), Number(order.totalSalePed || 0),
      order.pricingStatus || "estimated", order.submitterHash || null, order.clientCreatedAt || null,
      order.discordMessageId || null, order.approvalRequired ? 1 : 0,
      Number(order.proposalVersion || 0)
    ),
    ...items.map((item, index) => env.DB.prepare(`
      INSERT INTO purchase_order_items (
        order_id, line_no, item_name, storage, aisle, quantity, stock_at_submission,
        unit_tt_ped, markup_kind, markup_value, markup_display, unit_sale_ped,
        line_tt_ped, line_sale_ped, price_status, base_markup_kind, base_markup_value,
        base_markup_profiled, discount_campaign_id, discount_kind, discount_rate
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      order.id, Number(item.lineNo || index + 1), item.itemName, item.storage, item.aisle,
      Number(item.quantity), Number(item.stockAtSubmission), Number(item.unitTtPed),
      item.markupKind || "none", item.markupValue ?? null, item.markupDisplay || null,
      Number(item.unitSalePed), Number(item.lineTtPed), Number(item.lineSalePed),
      item.priceStatus || "estimated", item.baseMarkupKind || item.markupKind || "none",
      item.baseMarkupValue ?? item.markupValue ?? null, item.baseMarkupProfiled ? 1 : 0,
      item.discountCampaignId || null,
      item.discountKind || null, item.discountRate ?? null
    )),
    syncedEvent
      ? prepareSyncedOrderHistoryEvent(env, syncedEvent)
      : prepareOrderHistoryEvent(env, {
        orderId: order.id,
        action: eventAction,
        actor: order.eventActor,
        details: order.eventDetails || { sourceBackend: order.sourceBackend || "d1", to: order.status || "submitted" }
      })
  ];
  await env.DB.batch(statements);
}

async function importGasFallbackOrder(env, payload) {
  const order = payload?.order;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!order || items.length < 1 || items.length > 30) throw new ApiError(400, "Demande GAS de secours invalide");
  const id = String(order.id || "").trim().toLowerCase();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new ApiError(400, "Identifiant de demande invalide");
  const existing = await env.DB.prepare(`SELECT id FROM purchase_orders WHERE id = ?`).bind(id).first();
  if (existing) return { ok: true, duplicate: true, id };
  const canonical = {
    id,
    publicReference: String(order.publicReference || "").trim().toUpperCase(),
    accessTokenHash: String(order.accessTokenHash || "").trim().toLowerCase(),
    status: order.status === "cancelled" ? "cancelled" : "submitted",
    buyerAvatar: String(order.buyerAvatar || "").trim().slice(0, 80),
    buyerContact: String(order.buyerContact || "").trim().slice(0, 160) || null,
    buyerComment: String(order.buyerComment || "").trim().slice(0, 800) || null,
    language: order.language === "FR" ? "FR" : "EN",
    frjMember: order.frjMember === true,
    sourceBackend: "gas-fallback",
    totalTtPed: Number(order.totalTtPed || 0),
    totalSalePed: Number(order.totalSalePed || 0),
    pricingStatus: order.pricingStatus || "estimated",
    clientCreatedAt: order.clientCreatedAt || null,
    discordMessageId: /^\d{15,22}$/.test(String(order.discordMessageId || ""))
      ? String(order.discordMessageId)
      : null
  };
  if (!/^FRJ-\d{8}-[A-F0-9]{6}$/.test(canonical.publicReference)) throw new ApiError(400, "Référence GAS invalide");
  if (!/^[a-f0-9]{64}$/.test(canonical.accessTokenHash)) throw new ApiError(400, "Jeton GAS invalide");
  if (!canonical.buyerAvatar) throw new ApiError(400, "Avatar GAS absent");
  const incomingHistory = Array.isArray(payload?.historyEvents) ? payload.historyEvents[0] : null;
  const syncedEvent = incomingHistory
    ? parseOrderValue(() => normalizeSyncedOrderHistoryEvent(incomingHistory))
    : null;
  if (syncedEvent && syncedEvent.orderId !== canonical.id) {
    throw new ApiError(400, "Historique GAS rattaché à une autre demande");
  }
  if (syncedEvent && syncedEvent.action !== "gas-fallback-synchronized") {
    throw new ApiError(400, "Événement initial GAS invalide");
  }
  await storePurchaseOrder(env, canonical, items, "gas-fallback-synchronized", syncedEvent);
  // Rejouer systématiquement l'état canonique dans Discord : la demande a pu
  // être annulée côté secours GAS avant son premier transfert vers D1.
  const discord = await synchronizeDiscordOrder(env, canonical.id);
  return { ok: true, duplicate: false, id, discord: publicDiscordResult(discord) };
}

async function importGasOrderHistory(env, payload) {
  const sourceEvents = Array.isArray(payload?.events) ? payload.events : [];
  if (sourceEvents.length < 1 || sourceEvents.length > 50) {
    throw new ApiError(400, "Lot d’historique GAS invalide");
  }

  const results = [];
  const discordOrderIds = new Set();
  for (const sourceEvent of sourceEvents) {
    const eventKey = String(sourceEvent?.eventKey || "").trim().toLowerCase();
    try {
      const event = parseOrderValue(() => normalizeSyncedOrderHistoryEvent(sourceEvent));
      const result = await importGasOrderHistoryEvent(env, event);
      results.push({ eventKey: event.eventKey, ok: true, event: result.event, changed: result.changed });
      if (result.orderUpdated) discordOrderIds.add(event.orderId);
    } catch (error) {
      results.push({
        eventKey,
        ok: false,
        error: error instanceof Error ? error.message : "Événement GAS invalide"
      });
    }
  }

  for (const orderId of discordOrderIds) await synchronizeDiscordOrder(env, orderId);
  return { ok: results.every((result) => result.ok), results };
}

async function importGasOrderHistoryEvent(env, event) {
  const row = await env.DB.prepare(`
    SELECT po.id AS purchase_order_id, po.status AS purchase_order_status,
           po.updated_at AS purchase_order_updated_at,
           history.id, history.order_id, history.event_key, history.action, history.actor,
           history.comment, history.details, history.created_at, history.comment_updated_at
    FROM purchase_orders AS po
    LEFT JOIN purchase_order_events AS history ON history.event_key = ?
    WHERE po.id = ?
  `).bind(event.eventKey, event.orderId).first();
  if (!row) throw new ApiError(404, "Demande GAS introuvable dans D1");
  if (row.id && row.order_id !== event.orderId) {
    throw new ApiError(409, "Clé d’historique déjà utilisée par une autre demande");
  }

  if (row.id) {
    const incomingDate = event.commentUpdatedAt || "";
    const storedDate = row.comment_updated_at ? normalizeSyncTimestamp(row.comment_updated_at) : "";
    const commentChanged = event.comment !== row.comment;
    if (incomingDate && incomingDate > storedDate && commentChanged) {
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE purchase_order_events
          SET comment = ?, comment_updated_at = ?
          WHERE id = ? AND order_id = ?
        `).bind(event.comment, incomingDate, row.id, event.orderId),
        prepareOrderHistoryEvent(env, {
          orderId: event.orderId,
          action: "history-comment-updated",
          actor: "gas",
          details: { targetEventKey: event.eventKey }
        })
      ]);
      const updated = { ...row, comment: event.comment, comment_updated_at: incomingDate };
      return { event: mapOrderHistoryEvent(updated), changed: true, orderUpdated: false };
    }
    return { event: mapOrderHistoryEvent(row), changed: false, orderUpdated: false };
  }

  const statements = [];
  const orderUpdatedAt = normalizeSyncTimestamp(row.purchase_order_updated_at, "");
  const shouldUpdateOrder = Boolean(
    event.newStatus
    && event.newStatus !== row.purchase_order_status
    && (!orderUpdatedAt || event.createdAt > orderUpdatedAt)
  );
  if (shouldUpdateOrder) {
    const confirmsPricing = confirmsOrderPricing(event.newStatus);
    statements.push(env.DB.prepare(`
      UPDATE purchase_orders
      SET status = ?, approval_required = 0,
          pricing_status = CASE WHEN ? = 1 THEN 'confirmed' ELSE pricing_status END,
          updated_at = ?
      WHERE id = ?
    `).bind(event.newStatus, confirmsPricing ? 1 : 0, event.createdAt, event.orderId));
    if (confirmsPricing) {
      statements.push(env.DB.prepare(`
        UPDATE purchase_order_items SET price_status = 'confirmed' WHERE order_id = ?
      `).bind(event.orderId));
    }
  }
  statements.push(prepareSyncedOrderHistoryEvent(env, event));
  await env.DB.batch(statements);
  return {
    event: mapOrderHistoryEvent({
      id: 0,
      order_id: event.orderId,
      event_key: event.eventKey,
      action: event.action,
      actor: event.actor,
      comment: event.comment,
      details: JSON.stringify(event.details),
      created_at: event.createdAt,
      comment_updated_at: event.commentUpdatedAt
    }),
    changed: true,
    orderUpdated: shouldUpdateOrder
  };
}

async function synchronizeDiscordOrder(env, orderId) {
  const webhookUrl = String(env.DISCORD_ORDER_WEBHOOK_URL || "").trim();
  if (!webhookUrl) return { ok: false, skipped: true, reason: "webhook-not-configured" };

  const [orderResult, itemsResult] = await env.DB.batch([
    env.DB.prepare(`
      SELECT id, public_reference, status, approval_required, proposal_version,
             buyer_avatar, buyer_contact, buyer_comment,
             language, frj_member, source_backend, total_tt_ped, total_sale_ped,
             pricing_status, created_at, updated_at, discord_message_id
      FROM purchase_orders WHERE id = ?
    `).bind(orderId),
    env.DB.prepare(`
      SELECT line_no, item_name, storage, aisle, quantity, stock_at_submission,
             unit_tt_ped, markup_kind, markup_value, markup_display, unit_sale_ped,
             line_tt_ped, line_sale_ped, price_status,
             base_markup_kind, base_markup_value, base_markup_profiled,
             discount_campaign_id, discount_kind, discount_rate
      FROM purchase_order_items WHERE order_id = ? ORDER BY line_no
    `).bind(orderId)
  ]);
  const row = orderResult.results[0];
  if (!row) return { ok: false, skipped: true, reason: "order-not-found" };
  const order = mapAdminOrder(row);
  const items = itemsResult.results.map(mapOrderItem);

  try {
    const result = await sendOrUpdateDiscordOrder({
      webhookUrl,
      messageId: row.discord_message_id,
      order,
      items
    });
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE purchase_orders
        SET discord_message_id = ?, discord_synced_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(result.messageId, orderId),
      prepareOrderHistoryEvent(env, {
        orderId,
        action: `discord-${result.action}`,
        details: { messageId: result.messageId }
      })
    ]);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "Notification Discord impossible", orderId, error: message }));
    await prepareOrderHistoryEvent(env, {
      orderId,
      action: "discord-notification-failed",
      details: { error: message.slice(0, 500) }
    }).run();
    return { ok: false, error: message };
  }
}

function publicDiscordResult(result) {
  return {
    ok: result?.ok === true,
    action: result?.action || null,
    skipped: result?.skipped === true
  };
}

async function readAdminOrderCatalog(env) {
  const businessDate = businessDateInParis();
  const result = await env.DB.prepare(`
    WITH stock AS (
      SELECT item_name, SUM(quantity) AS available_stock
      FROM saleable_inventory
      WHERE avatar_id = 'enzo'
      GROUP BY item_name COLLATE NOCASE
    )
    SELECT
      l.item_name,
      l.storage,
      l.aisle,
      c.unit_price_ped,
      stock.available_stock,
      CASE WHEN datetime(mc.observed_at) >= datetime('now', '-7 days') THEN mc.weighted_kind ELSE NULL END AS markup_kind,
      CASE WHEN datetime(mc.observed_at) >= datetime('now', '-7 days') THEN mc.weighted_value ELSE NULL END AS markup_value,
      COALESCE(s.campaign_type, p.campaign_type) AS discount_kind,
      COALESCE(s.id, p.id) AS discount_campaign_id,
      COALESCE(s.discount_rate, p.discount_rate) AS discount_rate
    FROM catalog_listings l
    JOIN catalog_items c ON c.name = l.item_name COLLATE NOCASE
    JOIN stock ON stock.item_name = l.item_name COLLATE NOCASE
    LEFT JOIN market_current mc ON mc.item_name = l.item_name COLLATE NOCASE
    LEFT JOIN discount_campaigns s
      ON s.campaign_type = 'sale' AND s.enabled = 1
     AND ? BETWEEN s.starts_on AND s.ends_on
    LEFT JOIN discount_campaigns p
      ON p.campaign_type = 'daily_promo' AND p.enabled = 1
     AND p.starts_on = ? AND p.storage = l.storage AND p.aisle = l.aisle
    WHERE l.enabled = 1
      AND stock.available_stock > 0
      AND c.unit_price_ped IS NOT NULL
    ORDER BY l.storage, l.aisle, l.item_name COLLATE NOCASE
  `).bind(businessDate, businessDate).all();
  return {
    generatedAt: new Date().toISOString(),
    items: result.results.map((row) => ({
      itemName: row.item_name,
      storage: row.storage,
      aisle: row.aisle,
      availableStock: Number(row.available_stock || 0),
      unitTtPed: Number(row.unit_price_ped || 0),
      markupKind: row.markup_kind || "none",
      markupValue: row.markup_value === null || row.markup_value === undefined
        ? null
        : Number(row.markup_value),
      discountKind: row.discount_kind || null,
      discountCampaignId: row.discount_campaign_id || null,
      discountRate: row.discount_rate === null || row.discount_rate === undefined
        ? null
        : Number(row.discount_rate)
    }))
  };
}

async function createAdminOrder(env, payload) {
  if (!isCartEnabled(env)) throw new ApiError(503, "Transmission des paniers désactivée");
  const draft = parseOrderValue(() => normalizeAdminOrderDraft(payload));
  const catalog = await readAdminOrderCatalog(env);
  const lines = priceAdminOrderLines(draft.items, catalog.items, draft.frjMember);
  const totals = orderLineTotals(lines);
  const now = new Date().toISOString();
  const identity = await createUniqueAdminOrderIdentity(env);
  const accessToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const order = {
    id: identity.id,
    publicReference: identity.publicReference,
    accessTokenHash: await sha256(accessToken),
    status: "submitted",
    approvalRequired: true,
    proposalVersion: 1,
    buyerAvatar: draft.buyerAvatar,
    buyerContact: null,
    buyerComment: null,
    language: "FR",
    frjMember: draft.frjMember,
    sourceBackend: "d1-admin",
    totalTtPed: totals.totalTtPed,
    totalSalePed: totals.totalSalePed,
    pricingStatus: totals.pricingStatus,
    submitterHash: null,
    clientCreatedAt: now,
    eventActor: "admin",
    eventDetails: { sourceBackend: "d1-admin", approvalRequired: true, proposalVersion: 1 }
  };
  await storePurchaseOrder(env, order, lines, "admin-created");
  const discord = await synchronizeDiscordOrder(env, order.id);
  return {
    ok: true,
    order: mapPublicOrder(order, lines),
    accessToken,
    trackingPath: `suivi-commande.html?token=${encodeURIComponent(accessToken)}`,
    discord: publicDiscordResult(discord)
  };
}

async function addAdminOrderItem(env, orderId, payload) {
  if (!isCartEnabled(env)) throw new ApiError(503, "Transmission des paniers désactivée");
  const requested = parseOrderValue(() => normalizeAdminOrderLine(payload));
  const [orderResult, itemsResult] = await env.DB.batch([
    env.DB.prepare(`
      SELECT id, status, approval_required, proposal_version, frj_member
      FROM purchase_orders WHERE id = ?
    `).bind(orderId),
    env.DB.prepare(`
      SELECT line_no, item_name, storage, aisle
      FROM purchase_order_items WHERE order_id = ? ORDER BY line_no
    `).bind(orderId)
  ]);
  const order = orderResult.results[0];
  if (!order) throw new ApiError(404, "Demande introuvable");
  if (!canReviseOrder(order.status, order.approval_required)) {
    throw new ApiError(409, "Un article ne peut être ajouté qu'aux demandes À valider, Transmises ou Vues");
  }
  if (itemsResult.results.length >= 10) throw new ApiError(409, "La demande contient déjà le maximum de 10 articles");
  const requestedKey = orderItemKey(requested);
  if (itemsResult.results.some((item) => orderItemKey({
    itemName: item.item_name,
    storage: item.storage,
    aisle: item.aisle
  }) === requestedKey)) {
    throw new ApiError(409, "Cet article est déjà présent : modifie sa ligne existante");
  }
  const catalog = await readAdminOrderCatalog(env);
  const line = priceAdminOrderLines([requested], catalog.items, Number(order.frj_member || 0) === 1)[0];
  const lineNo = Math.max(0, ...itemsResult.results.map((item) => Number(item.line_no || 0))) + 1;
  line.lineNo = lineNo;
  const nextVersion = Number(order.proposal_version || 0) + 1;
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO purchase_order_items (
        order_id, line_no, item_name, storage, aisle, quantity, stock_at_submission,
        unit_tt_ped, markup_kind, markup_value, markup_display, unit_sale_ped,
        line_tt_ped, line_sale_ped, price_status, base_markup_kind, base_markup_value,
        base_markup_profiled, discount_campaign_id, discount_kind, discount_rate
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      orderId, lineNo, line.itemName, line.storage, line.aisle, line.quantity,
      line.stockAtSubmission, line.unitTtPed, line.markupKind, line.markupValue,
      line.markupDisplay, line.unitSalePed, line.lineTtPed, line.lineSalePed, line.priceStatus,
      line.baseMarkupKind, line.baseMarkupValue, line.baseMarkupProfiled ? 1 : 0,
      line.discountCampaignId, line.discountKind, line.discountRate
    ),
    env.DB.prepare(`
      UPDATE purchase_orders
      SET status = 'submitted', approval_required = 1,
          proposal_version = proposal_version + 1,
          total_tt_ped = (SELECT ROUND(COALESCE(SUM(line_tt_ped), 0), 2) FROM purchase_order_items WHERE order_id = ?),
          total_sale_ped = (SELECT ROUND(COALESCE(SUM(line_sale_ped), 0), 2) FROM purchase_order_items WHERE order_id = ?),
          pricing_status = CASE WHEN EXISTS (
            SELECT 1 FROM purchase_order_items WHERE order_id = ? AND price_status = 'to-confirm'
          ) THEN 'to-confirm' ELSE 'estimated' END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(orderId, orderId, orderId, orderId),
    prepareOrderHistoryEvent(env, {
      orderId,
      action: "proposal-line-added",
      actor: "admin",
      details: { lineNo, itemName: line.itemName, proposalVersion: nextVersion }
    })
  ]);
  const discord = await synchronizeDiscordOrder(env, orderId);
  return {
    ok: true,
    status: "awaiting_approval",
    proposalVersion: nextVersion,
    line,
    discord: publicDiscordResult(discord)
  };
}

function priceAdminOrderLines(requestedItems, catalogItems, frjMember = false) {
  const catalog = new Map(catalogItems.map((item) => [orderItemKey(item), item]));
  return requestedItems.map((requested, index) => {
    const current = catalog.get(orderItemKey(requested));
    if (!current) throw new ApiError(409, `Article indisponible : ${requested.itemName}`);
    const revised = parseOrderValue(() => reviseOrderLine(
      { itemName: current.itemName, unitTtPed: current.unitTtPed },
      requested,
      current.availableStock
    ));
    const baseMarkup = deriveBaseMarkup(
      revised.markupKind,
      revised.markupValue,
      frjMember,
      current.discountRate
    );
    return {
      lineNo: index + 1,
      itemName: current.itemName,
      storage: current.storage,
      aisle: current.aisle,
      unitTtPed: current.unitTtPed,
      baseMarkupKind: baseMarkup.kind,
      baseMarkupValue: baseMarkup.value,
      baseMarkupProfiled: false,
      discountKind: current.discountKind || null,
      discountCampaignId: current.discountCampaignId || null,
      discountRate: current.discountRate ?? null,
      ...revised
    };
  });
}

function deriveBaseMarkup(kind, effectiveValue, frjMember, discountRate) {
  if (kind !== "percent" && kind !== "ped") return { kind: "none", value: null };
  const rate = Number(discountRate);
  const campaignFactor = Number.isFinite(rate) && rate > 0 && rate <= 1 ? 1 - rate : 1;
  const profileFactor = frjMember === true ? 0.5 : 1;
  const factor = profileFactor * campaignFactor;
  const effective = Number(effectiveValue);
  if (!Number.isFinite(effective) || factor <= 0) return { kind: "none", value: null };
  return kind === "percent"
    ? { kind, value: 1 + ((effective - 1) / factor) }
    : { kind, value: effective / factor };
}

function orderLineTotals(lines) {
  return {
    totalTtPed: roundOrderPed(lines.reduce((sum, line) => sum + line.lineTtPed, 0)),
    totalSalePed: roundOrderPed(lines.reduce((sum, line) => sum + line.lineSalePed, 0)),
    pricingStatus: lines.some((line) => line.priceStatus === "to-confirm") ? "to-confirm" : "estimated"
  };
}

export async function refreshMutableOrderDiscounts(env, orderId = null) {
  const schema = await env.DB.prepare(`
    SELECT COUNT(*) AS table_count
    FROM sqlite_master
    WHERE type = 'table' AND name IN ('purchase_orders', 'purchase_order_items', 'discount_campaigns')
  `).first();
  if (Number(schema?.table_count || 0) !== 3) return [];
  const businessDate = businessDateInParis();
  const orderFilter = orderId ? "AND po.id = ?" : "";
  const statement = env.DB.prepare(`
    SELECT
      oi.order_id, oi.line_no, oi.quantity, oi.unit_tt_ped,
      oi.markup_kind, oi.markup_value, oi.line_sale_ped, oi.discount_campaign_id,
      oi.discount_kind, oi.discount_rate,
      COALESCE(oi.base_markup_kind, oi.markup_kind, 'none') AS base_markup_kind,
      COALESCE(oi.base_markup_value, oi.markup_value) AS base_markup_value,
      COALESCE(oi.base_markup_profiled, 0) AS base_markup_profiled,
      po.frj_member,
      COALESCE(s.campaign_type, p.campaign_type) AS current_discount_kind,
      COALESCE(s.id, p.id) AS current_discount_campaign_id,
      COALESCE(s.discount_rate, p.discount_rate) AS current_discount_rate
    FROM purchase_order_items oi
    JOIN purchase_orders po ON po.id = oi.order_id
    LEFT JOIN discount_campaigns s
      ON s.campaign_type = 'sale' AND s.enabled = 1
     AND ? BETWEEN s.starts_on AND s.ends_on
    LEFT JOIN discount_campaigns p
      ON p.campaign_type = 'daily_promo' AND p.enabled = 1
     AND p.starts_on = ? AND p.storage = oi.storage AND p.aisle = oi.aisle
    WHERE (po.approval_required = 1 OR po.status IN ('submitted', 'viewed'))
      ${orderFilter}
    ORDER BY oi.order_id, oi.line_no
  `);
  const bindings = orderId ? [businessDate, businessDate, orderId] : [businessDate, businessDate];
  const result = await statement.bind(...bindings).all();
  const changedByOrder = new Map();
  const updates = [];

  result.results.forEach((row) => {
    const baseKind = row.base_markup_kind || "none";
    const baseValue = row.base_markup_value === null || row.base_markup_value === undefined
      ? null
      : Number(row.base_markup_value);
    const discountRate = row.current_discount_rate === null || row.current_discount_rate === undefined
      ? null
      : Number(row.current_discount_rate);
    const effective = computeDiscountedMarkup({
      kind: baseKind,
      value: baseValue,
      frjMember: Number(row.base_markup_profiled || 0) === 1 ? false : Number(row.frj_member || 0) === 1,
      discountRate: discountRate || 0
    });
    const prices = priceOrderLine(Number(row.unit_tt_ped || 0), Number(row.quantity || 0), effective.kind, effective.value);
    const changed = String(row.markup_kind || "none") !== effective.kind
      || !sameNullableNumber(row.markup_value, effective.value)
      || String(row.discount_kind || "") !== String(row.current_discount_kind || "")
      || String(row.discount_campaign_id || "") !== String(row.current_discount_campaign_id || "")
      || !sameNullableNumber(row.discount_rate, discountRate)
      || !sameNullableNumber(row.line_sale_ped, prices.lineSalePed);
    if (!changed) return;
    updates.push(env.DB.prepare(`
      UPDATE purchase_order_items
      SET markup_kind = ?, markup_value = ?, markup_display = ?, unit_sale_ped = ?,
          line_tt_ped = ?, line_sale_ped = ?, price_status = ?,
          discount_campaign_id = ?, discount_kind = ?, discount_rate = ?
      WHERE order_id = ? AND line_no = ?
    `).bind(
      effective.kind, effective.value, formatMarkup(effective.kind, effective.value), prices.unitSalePed,
      prices.lineTtPed, prices.lineSalePed, effective.kind === "none" ? "to-confirm" : "estimated",
      row.current_discount_campaign_id || null, row.current_discount_kind || null, discountRate,
      row.order_id, Number(row.line_no)
    ));
    const lines = changedByOrder.get(row.order_id) || [];
    lines.push(Number(row.line_no));
    changedByOrder.set(row.order_id, lines);
  });

  changedByOrder.forEach((lineNumbers, changedOrderId) => {
    updates.push(env.DB.prepare(`
      UPDATE purchase_orders
      SET total_tt_ped = (SELECT ROUND(COALESCE(SUM(line_tt_ped), 0), 2) FROM purchase_order_items WHERE order_id = ?),
          total_sale_ped = (SELECT ROUND(COALESCE(SUM(line_sale_ped), 0), 2) FROM purchase_order_items WHERE order_id = ?),
          proposal_version = proposal_version + CASE WHEN approval_required = 1 THEN 1 ELSE 0 END,
          pricing_status = CASE WHEN EXISTS (
            SELECT 1 FROM purchase_order_items WHERE order_id = ? AND price_status = 'to-confirm'
          ) THEN 'to-confirm' ELSE 'estimated' END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(changedOrderId, changedOrderId, changedOrderId, changedOrderId));
    updates.push(prepareOrderHistoryEvent(env, {
      orderId: changedOrderId,
      action: "discount-refreshed",
      details: { businessDate, lineNumbers }
    }));
  });

  if (updates.length) await env.DB.batch(updates);
  for (const changedOrderId of changedByOrder.keys()) await synchronizeDiscordOrder(env, changedOrderId);
  return [...changedByOrder.keys()];
}

function sameNullableNumber(left, right) {
  if (left === null || left === undefined || left === "") {
    return right === null || right === undefined || right === "";
  }
  if (right === null || right === undefined || right === "") return false;
  return Math.abs(Number(left) - Number(right)) <= 1e-9;
}

async function createUniqueAdminOrderIdentity(env) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = crypto.randomUUID();
    const publicReference = `FRJ-${currentParisDateKey()}-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const existing = await env.DB.prepare(`SELECT id FROM purchase_orders WHERE public_reference = ?`)
      .bind(publicReference).first();
    if (!existing) return { id, publicReference };
  }
  throw new ApiError(503, "Impossible de générer une référence de demande unique");
}

function currentParisDateKey(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function roundOrderPed(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

async function readAdminOrders(env) {
  if (!isCartEnabled(env)) return { enabled: false, generatedAt: new Date().toISOString(), orders: [] };
  await refreshMutableOrderDiscounts(env);
  const [ordersResult, itemsResult] = await env.DB.batch([
    env.DB.prepare(`
      SELECT id, public_reference, status, approval_required, proposal_version,
             buyer_avatar, buyer_contact, buyer_comment,
             language, frj_member, source_backend, total_tt_ped, total_sale_ped,
             pricing_status, client_created_at, created_at, updated_at
      FROM purchase_orders ORDER BY created_at DESC LIMIT 200
    `),
    env.DB.prepare(`
      SELECT oi.order_id, oi.line_no, oi.item_name, oi.storage, oi.aisle, oi.quantity,
              oi.stock_at_submission, oi.unit_tt_ped, oi.markup_kind, oi.markup_value,
              oi.markup_display, oi.unit_sale_ped,
             oi.line_tt_ped, oi.line_sale_ped, oi.price_status,
             oi.base_markup_kind, oi.base_markup_value, oi.base_markup_profiled,
             oi.discount_campaign_id, oi.discount_kind, oi.discount_rate
      FROM purchase_order_items oi
      JOIN (SELECT id FROM purchase_orders ORDER BY created_at DESC LIMIT 200) recent
        ON recent.id = oi.order_id
      ORDER BY oi.order_id, oi.line_no
    `)
  ]);
  const itemsByOrder = {};
  itemsResult.results.forEach((item) => {
    (itemsByOrder[item.order_id] ||= []).push(mapOrderItem(item));
  });
  return {
    enabled: true,
    generatedAt: new Date().toISOString(),
    orders: ordersResult.results.map((order) => ({
      ...mapAdminOrder(order),
      items: itemsByOrder[order.id] || []
    }))
  };
}

async function readOrderHistory(env, orderId) {
  const [orderResult, eventsResult] = await env.DB.batch([
    env.DB.prepare(`SELECT id FROM purchase_orders WHERE id = ?`).bind(orderId),
    env.DB.prepare(`
      SELECT id, order_id, event_key, action, actor, comment, details,
             created_at, comment_updated_at
      FROM (
        SELECT id, order_id, event_key, action, actor, comment, details,
               created_at, comment_updated_at
        FROM purchase_order_events
        WHERE order_id = ?
          AND action NOT LIKE 'discord-%'
          AND action <> 'history-comment-updated'
        ORDER BY id DESC
        LIMIT 200
      )
      ORDER BY datetime(created_at), id
    `).bind(orderId)
  ]);
  if (!orderResult.results.length) throw new ApiError(404, "Demande introuvable");
  return {
    orderId,
    events: eventsResult.results.map(mapOrderHistoryEvent)
  };
}

async function updateOrderHistoryComment(env, orderId, eventId, comment) {
  const existing = await env.DB.prepare(`
    SELECT id, order_id, event_key, action, actor, comment, details,
           created_at, comment_updated_at
    FROM purchase_order_events
    WHERE id = ? AND order_id = ?
  `).bind(eventId, orderId).first();
  if (!existing || !isVisibleOrderHistoryAction(existing.action)) {
    throw new ApiError(404, "Événement d’historique introuvable");
  }

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE purchase_order_events
      SET comment = ?, comment_updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND order_id = ?
    `).bind(comment, eventId, orderId),
    prepareOrderHistoryEvent(env, {
      orderId,
      action: "history-comment-updated",
      actor: "admin",
      details: { targetEventKey: existing.event_key || `d1-${existing.id}` }
    })
  ]);

  const updated = await env.DB.prepare(`
    SELECT id, order_id, event_key, action, actor, comment, details,
           created_at, comment_updated_at
    FROM purchase_order_events
    WHERE id = ? AND order_id = ?
  `).bind(eventId, orderId).first();
  return { ok: true, event: mapOrderHistoryEvent(updated) };
}

async function readOrdersForGasMirror(env, url) {
  const afterEventId = Number(url.searchParams.get("afterEventId") || 0);
  if (!Number.isInteger(afterEventId) || afterEventId < 0) {
    throw new ApiError(400, "Curseur de commandes invalide");
  }
  const eventsResult = await env.DB.prepare(`
    SELECT id, order_id, event_key, action, actor, comment, details,
           created_at, comment_updated_at
    FROM purchase_order_events
    WHERE id > ?
    ORDER BY id
    LIMIT 500
  `).bind(afterEventId).all();
  if (!eventsResult.results.length) {
    return { orders: [], cursor: afterEventId, hasMore: false };
  }

  const orderIds = [...new Set(eventsResult.results.map((row) => String(row.order_id)))];
  const idsJson = JSON.stringify(orderIds);
  const targetKeys = eventsResult.results
    .filter((row) => row.action === "history-comment-updated")
    .map((row) => parseOrderHistoryTargetKey(row.details))
    .filter(Boolean);
  const [ordersResult, itemsResult, targetEventsResult] = await env.DB.batch([
    env.DB.prepare(`
      SELECT id, public_reference, access_token_hash, status, approval_required, proposal_version,
             buyer_avatar, buyer_contact, buyer_comment, language, frj_member, source_backend,
             total_tt_ped, total_sale_ped, pricing_status, client_created_at, created_at, updated_at,
             discord_message_id
      FROM purchase_orders
      WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
    `).bind(idsJson),
    env.DB.prepare(`
      SELECT order_id, line_no, item_name, storage, aisle, quantity, stock_at_submission,
             unit_tt_ped, markup_kind, markup_value, markup_display, unit_sale_ped,
             line_tt_ped, line_sale_ped, price_status,
             base_markup_kind, base_markup_value, base_markup_profiled,
             discount_campaign_id, discount_kind, discount_rate
      FROM purchase_order_items
      WHERE order_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      ORDER BY order_id, line_no
    `).bind(idsJson),
    targetKeys.length
      ? env.DB.prepare(`
        SELECT id, order_id, event_key, action, actor, comment, details,
               created_at, comment_updated_at
        FROM purchase_order_events
        WHERE event_key IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      `).bind(JSON.stringify(targetKeys))
      : env.DB.prepare(`
        SELECT id, order_id, event_key, action, actor, comment, details,
               created_at, comment_updated_at
        FROM purchase_order_events WHERE 0
      `)
  ]);
  const itemsByOrder = {};
  itemsResult.results.forEach((item) => {
    (itemsByOrder[item.order_id] ||= []).push(mapOrderItem(item));
  });
  const historyByOrder = {};
  const historyKeys = new Set();
  [...eventsResult.results, ...targetEventsResult.results].forEach((event) => {
    if (!isVisibleOrderHistoryAction(event.action) || historyKeys.has(event.event_key)) return;
    historyKeys.add(event.event_key);
    (historyByOrder[event.order_id] ||= []).push(mapOrderHistoryEvent(event));
  });
  const orders = ordersResult.results.map((row) => ({
    ...mapAdminOrder(row),
    accessTokenHash: row.access_token_hash,
    items: itemsByOrder[row.id] || [],
    historyEvents: historyByOrder[row.id] || []
  }));
  return {
    orders,
    cursor: Math.max(...eventsResult.results.map((row) => Number(row.id))),
    hasMore: eventsResult.results.length === 500
  };
}

function parseOrderHistoryTargetKey(details) {
  try {
    return String(JSON.parse(details || "{}").targetEventKey || "").trim();
  } catch {
    return "";
  }
}

function mapPublicOrder(order, items) {
  const approvalRequired = Number(order.approval_required ?? order.approvalRequired ?? 0) === 1;
  return {
    id: order.id,
    publicReference: order.public_reference || order.publicReference,
    status: approvalRequired ? "awaiting_approval" : (order.status || "submitted"),
    approvalRequired,
    proposalVersion: Number(order.proposal_version ?? order.proposalVersion ?? 0),
    buyerAvatar: order.buyer_avatar || order.buyerAvatar,
    language: order.language || "EN",
    frjMember: Number(order.frj_member ?? order.frjMember ?? 0) === 1 || order.frjMember === true,
    totalTtPed: Number(order.total_tt_ped ?? order.totalTtPed ?? 0),
    totalSalePed: Number(order.total_sale_ped ?? order.totalSalePed ?? 0),
    pricingStatus: order.pricing_status || order.pricingStatus || "estimated",
    createdAt: normalizeSyncTimestamp(order.created_at || order.createdAt || new Date().toISOString()),
    updatedAt: normalizeSyncTimestamp(order.updated_at || order.updatedAt || order.created_at || new Date().toISOString()),
    items: items.map(mapOrderItem)
  };
}

function mapAdminOrder(order) {
  return {
    ...mapPublicOrder(order, []),
    buyerContact: order.buyer_contact || null,
    buyerComment: order.buyer_comment || null,
    sourceBackend: order.source_backend || "d1",
    clientCreatedAt: order.client_created_at ? normalizeSyncTimestamp(order.client_created_at) : null,
    discordMessageId: order.discord_message_id || null
  };
}

function mapOrderItem(item) {
  return {
    lineNo: Number(item.line_no ?? item.lineNo ?? 0),
    itemName: item.item_name || item.itemName,
    storage: item.storage,
    aisle: item.aisle,
    quantity: Number(item.quantity || 0),
    stockAtSubmission: Number(item.stock_at_submission ?? item.stockAtSubmission ?? 0),
    unitTtPed: Number(item.unit_tt_ped ?? item.unitTtPed ?? 0),
    markupDisplay: item.markup_display || item.markupDisplay || null,
    unitSalePed: Number(item.unit_sale_ped ?? item.unitSalePed ?? 0),
    lineTtPed: Number(item.line_tt_ped ?? item.lineTtPed ?? 0),
    lineSalePed: Number(item.line_sale_ped ?? item.lineSalePed ?? 0),
    priceStatus: item.price_status || item.priceStatus || "estimated",
    markupKind: item.markup_kind || item.markupKind || "none",
    markupValue: item.markup_value ?? item.markupValue ?? null,
    baseMarkupKind: item.base_markup_kind || item.baseMarkupKind || item.markup_kind || item.markupKind || "none",
    baseMarkupValue: item.base_markup_value ?? item.baseMarkupValue ?? item.markup_value ?? item.markupValue ?? null,
    baseMarkupProfiled: Number(item.base_markup_profiled ?? item.baseMarkupProfiled ?? 0) === 1,
    discountCampaignId: item.discount_campaign_id || item.discountCampaignId || null,
    discountKind: item.discount_kind || item.discountKind || null,
    discountRate: item.discount_rate ?? item.discountRate ?? null
  };
}

function parseOrderValue(callback) {
  try {
    return callback();
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "Demande invalide");
  }
}

async function orderSubmitterHash(request, env) {
  const address = String(request.headers.get("CF-Connecting-IP") || "unknown");
  const salt = String(env.ADMIN_TOKEN || env.SYNC_TOKEN || "frj-order-rate-limit");
  return sha256(`${salt}\n${address}`);
}

function isCartEnabled(env) {
  return String(env.CART_ENABLED ?? "true").toLowerCase() !== "false";
}

async function resolveOrderIdByTrackingToken(env, tokenHash) {
  const row = await env.DB.prepare(`
    SELECT id
    FROM purchase_orders
    WHERE access_token_hash = ?
    UNION ALL
    SELECT order_id AS id
    FROM purchase_order_tracking_tokens
    WHERE token_hash = ?
    LIMIT 1
  `).bind(tokenHash, tokenHash).first();
  return row?.id || null;
}

async function runImmediateGasAudit(env, payload) {
  const gasSyncUrl = String(env.GAS_SYNC_URL || "").trim();
  const syncToken = String(env.SYNC_TOKEN || env.ADMIN_TOKEN || "").trim();
  if (!gasSyncUrl || !syncToken) throw new ApiError(503, "Relais d'audit GAS non configuré");

  const reason = String(payload.reason || "audit-force-rapport").trim() || "audit-force-rapport";
  const requestId = await recordSystemAudit(env, "manual-audit-requested", { reason });

  try {
    const response = await fetch(gasSyncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: syncToken, reason })
    });
    const raw = await readTextBody(response, 100_000);
    let result;
    try {
      result = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error("Réponse GAS non JSON");
    }
    if (!response.ok || result.ok !== true) {
      throw new Error(result.error || `GAS répond ${response.status}`);
    }

    await recordSystemAudit(env, "manual-audit-completed", { reason, requestId });
    return { ok: true, requestId, reason, summary: result.summary || [] };
  } catch (error) {
    await recordSystemAudit(env, "manual-audit-failed", {
      reason,
      requestId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw new ApiError(502, `Audit GAS impossible : ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function storeGasObservation(env, payload) {
  const dataset = String(payload.dataset || "").trim();
  const hash = String(payload.hash || "").trim().toLowerCase();
  const rowCount = Number(payload.rowCount);
  const eventId = String(payload.eventId || "").trim() || null;
  const updatedAt = normalizeSyncTimestamp(payload.updatedAt || payload.observedAt);
  const observedAt = normalizeSyncTimestamp(payload.observedAt);
  const provisional = payload.provisional === true || Number(payload.provisional || 0) === 1;
  if (!SYNC_DATASETS.has(dataset)) throw new ApiError(400, `Dataset inconnu : ${dataset || "absent"}`);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new ApiError(400, "Empreinte GAS invalide");
  if (!Number.isInteger(rowCount) || rowCount < 0) throw new ApiError(400, "Nombre de lignes GAS invalide");

  if (eventId) {
    const duplicate = await env.DB.prepare(`
      SELECT dataset_key FROM sync_observed_state WHERE event_id = ? LIMIT 1
    `).bind(eventId).first();
    if (duplicate) return { ok: true, duplicate: true, dataset };
  }

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO sync_observed_state (
        dataset_key, side, content_checksum, row_count, source_updated_at,
        observed_at, event_id, provisional
      ) VALUES (?, 'gas', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dataset_key, side) DO UPDATE SET
        content_checksum = excluded.content_checksum,
        row_count = excluded.row_count,
        source_updated_at = excluded.source_updated_at,
        observed_at = excluded.observed_at,
        event_id = excluded.event_id,
        provisional = excluded.provisional
    `).bind(dataset, hash, rowCount, updatedAt, observedAt, eventId, provisional ? 1 : 0),
    env.DB.prepare(`
      INSERT INTO sync_audit (
        dataset_key, direction, action, source_checksum, target_checksum, details
      ) VALUES (?, 'gas-observation', 'gas-state-observed', ?, NULL, ?)
    `).bind(dataset, hash, JSON.stringify({ rowCount, updatedAt, observedAt, eventId, provisional })),
    syncAuditRetentionStatement(env, dataset)
  ]);
  return { ok: true, duplicate: false, dataset, hash, rowCount, updatedAt, observedAt, provisional };
}

async function notifyGasDataChanged(env, dataset, reason) {
  const requestId = await recordSystemAudit(env, "sync-requested", { dataset, reason });
  return { ok: true, dataset, reason, requestId };
}

async function recordSystemAudit(env, action, details) {
  const [result] = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO sync_audit (
        dataset_key, direction, action, source_checksum, target_checksum, details
      ) VALUES ('_system', 'signal', ?, NULL, NULL, ?)
    `).bind(action, JSON.stringify(details || {})),
    syncAuditRetentionStatement(env, "_system")
  ]);
  return Number(result.meta?.last_row_id || 0);
}

function mapSyncAuditRow(row) {
  let details = null;
  if (row.details) {
    try {
      details = JSON.parse(row.details);
    } catch {
      details = { raw: String(row.details) };
    }
  }
  return {
    id: Number(row.id),
    dataset: row.dataset_key,
    direction: row.direction,
    action: row.action,
    sourceHash: row.source_checksum,
    targetHash: row.target_checksum,
    details,
    createdAt: normalizeSyncTimestamp(row.created_at)
  };
}

