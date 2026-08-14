import { computeWeightedMarkup, normalizeInventoryRows, normalizeMarketRows } from "./domain.js";
import {
  catalogContentHash,
  catalogRowsWithKeys,
  inventoryContentHash,
  inventoryRowsWithKeys,
  mapCatalogDbRow,
  mapInventoryDbRow,
  mapMarketDbRow,
  marketRowKey,
  marketContentHash,
  mergeMarketRows,
  normalizeSyncTimestamp,
  shouldSignalSyncAfterImport
} from "./sync.js";
import {
  normalizeOrderSubmission,
  priceOrderLines,
  reviseOrderLine,
  validateOrderStatus
} from "./orders.js";
import { sendOrUpdateDiscordOrder } from "./discord.js";

const MAX_IMPORT_BYTES = 1_800_000;
const MAX_OBSERVATION_BYTES = 2_200_000;
const MAX_ORDER_BYTES = 80_000;
const SYNC_AUDIT_RETENTION_COUNT = 500;

const PUBLIC_ORIGINS = new Set([
  "https://mrln033.github.io",
  "http://localhost:8787",
  "http://127.0.0.1:8787"
]);

const AVATAR_SHEETS = {
  enzo: "Inventaire Enzo",
  arkaman: "Inventaire ArkaMan",
  kenza: "Inventaire Kenza",
  nocturnal: "Inventaire Nocturnal"
};
const SYNC_DATASETS = new Set(["catalog", "mu", ...Object.keys(AVATAR_SHEETS).map((avatar) => `inventory:${avatar}`)]);

const SALEABLE_CONTAINER_SQL = `(
  lower(coalesce(ii.container, '')) LIKE '%calypso%'
  OR lower(coalesce(ii.container, '')) LIKE '%carried%'
  OR lower(coalesce(ii.container, '')) IN (
    'pitbull mk. 1 (c,l)',
    'pitbull mk. 2 (c,l)',
    'personal avatar',
    'ni armors',
    'ni tailoring/textiles',
    'blueprints: a.r.c.',
    'blueprints: cyrene',
    'kulokhar tall urn'
  )
  OR lower(coalesce(ii.container, '')) LIKE '%limited%'
)`;

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
        if (isAdminRequest) return withCors(await handleAdminGet(url, env), origin);
        if (isPublicOrderRequest) return withCors(await handlePublicOrderGet(url, env), origin);
        return withCors(await handleGet(url, env), origin);
      }

      if (request.method === "POST") {
        if (isSyncRequest) return withCors(await handleSyncPost(request, url, env), origin);
        if (/^\/orders\/status\/[a-f0-9-]{70,80}\/accept$/i.test(url.pathname)) {
          if (!PUBLIC_ORIGINS.has(String(origin || ""))) {
            return withCors(json({ error: "Origine non autorisée" }, 403), origin);
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

async function handleGet(url, env) {
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
      SELECT l.storage
      FROM catalog_listings l
      JOIN catalog_items c ON c.name = l.item_name COLLATE NOCASE
      JOIN inventory_current ii
        ON ii.avatar_id = 'enzo'
       AND ii.item_name = c.name COLLATE NOCASE
      WHERE l.enabled = 1
        AND l.storage <> ''
        AND l.aisle <> ''
        AND ${SALEABLE_CONTAINER_SQL}
      GROUP BY l.storage
      HAVING SUM(ii.quantity) > 0
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

  const result = await env.DB.prepare(`
    WITH inventory AS (
      SELECT ii.item_name, SUM(ii.quantity) AS quantity
      FROM inventory_current ii
      WHERE ii.avatar_id = 'enzo'
        AND ${SALEABLE_CONTAINER_SQL}
      GROUP BY ii.item_name COLLATE NOCASE
    ),
    recent_market AS (
      SELECT
        mo.item_name,
        mo.weighted_display,
        mo.observed_at
      FROM market_current mo
      WHERE datetime(mo.observed_at) >= datetime('now', '-7 days')
    )
    SELECT
      l.storage AS STORAGE,
      l.aisle AS RAYON,
      c.name AS ITEM,
      inventory.quantity AS QUANTITE,
      c.unit_price_ped AS PRIX_UNITAIRE,
      c.image AS IMAGE,
      c.wiki_url AS LIEN_WIKI,
      recent_market.observed_at AS DATE_MU_ISO,
      recent_market.weighted_display AS MU,
      COALESCE(p.discount_rate, '') AS Remise_Promo
    FROM catalog_listings l
    JOIN catalog_items c ON c.name = l.item_name COLLATE NOCASE
    JOIN inventory ON inventory.item_name = c.name COLLATE NOCASE
    LEFT JOIN recent_market
      ON recent_market.item_name = c.name COLLATE NOCASE
    LEFT JOIN promotions p
      ON p.promotion_date = date('now')
     AND p.storage = l.storage
     AND p.aisle = l.aisle
    WHERE l.enabled = 1
      AND l.storage = ? COLLATE NOCASE
      AND inventory.quantity > 0
    ORDER BY c.name COLLATE NOCASE
  `).bind(category).all();

  const rows = result.results.map(({ DATE_MU_ISO, ...row }) => ({
    ...row,
    DATE_MU: DATE_MU_ISO ? formatFrenchDateTime(DATE_MU_ISO) : "",
    TOTAL: Number(row.QUANTITE || 0) * Number(row.PRIX_UNITAIRE || 0)
  }));
  return publicJson(rows);
}

async function handleAdminGet(url, env) {
  if (url.pathname === "/admin/orders") {
    return json(await readAdminOrders(env));
  }
  if (url.pathname !== "/admin/sync-report") {
    return json({ error: "Endpoint administrateur inconnu" }, 404);
  }

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
      WITH ranked AS (
        SELECT
          id, dataset_key, direction, action, source_checksum, target_checksum,
          details, created_at,
          ROW_NUMBER() OVER (PARTITION BY dataset_key ORDER BY id DESC) AS rank
        FROM sync_audit
        WHERE dataset_key = '_system'
           OR action IN ('verified', 'reconciled')
      )
      SELECT
        id, dataset_key, direction, action, source_checksum, target_checksum,
        details, created_at
      FROM ranked
      WHERE rank = 1
      ORDER BY dataset_key
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
      FROM sync_audit
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

async function handlePost(request, url, env) {
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
    if (shouldSignalSync) {
      await notifyGasDataChanged(env, "mu", "import-d1-mu");
    }

    return legacyText(`${updates} MAJ / ${inserts} AJOUTS`, result.importId, result.rowsWritten);
  }

  return json({ error: `Type inconnu : ${type || "absent"}` }, 400);
}

async function handleSyncGet(url, env) {
  if (url.pathname === "/sync/orders") {
    return json(await readOrdersForGasMirror(env, url));
  }

  if (url.pathname === "/sync/pending") {
    const row = await env.DB.prepare(`
      SELECT id, details, created_at
      FROM sync_audit
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

  return json({ error: "Endpoint de synchronisation inconnu" }, 404);
}

async function handleSyncPost(request, url, env) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_IMPORT_BYTES) throw new ApiError(413, "Synchronisation trop volumineuse");

  const body = await readTextBody(request, MAX_IMPORT_BYTES);
  const payload = parseJsonBody(body);
  const expectedHash = String(request.headers.get("X-Expected-Hash") || "").trim();

  if (url.pathname === "/sync/order") {
    if (!isCartEnabled(env)) throw new ApiError(503, "Transmission des paniers désactivée");
    return json(await importGasFallbackOrder(env, payload));
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
    return json({ ok: true, noChange: false, state: result.state, rowsWritten: result.rowsWritten });
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
        SELECT 1 FROM json_each(?) incoming
        WHERE lower(trim(json_extract(incoming.value, '$.itemName'))) = lower(listing.item_name)
          AND upper(trim(json_extract(incoming.value, '$.storage'))) = listing.storage
          AND upper(trim(json_extract(incoming.value, '$.aisle'))) = listing.aisle
      )
    `).bind(payload),
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

  return states;
}

async function readSyncState(env, datasetKey) {
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
      AND id NOT IN (
        SELECT id FROM sync_audit
        WHERE dataset_key = ?
        ORDER BY id DESC
        LIMIT ?
      )
  `).bind(datasetKey, datasetKey, SYNC_AUDIT_RETENTION_COUNT);
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
      SELECT id, status, approval_required, proposal_version
      FROM purchase_orders WHERE id = ?
    `).bind(orderId),
    env.DB.prepare(`
      SELECT order_id, line_no, item_name, storage, aisle, unit_tt_ped,
             quantity, markup_kind, markup_value
      FROM purchase_order_items WHERE order_id = ? ORDER BY line_no
    `).bind(orderId)
  ]);
  const order = orderResult.results[0];
  if (!order) throw new ApiError(404, "Demande introuvable");
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
    LEFT JOIN inventory_current ii
      ON ii.avatar_id = 'enzo'
     AND ii.item_name = r.item_name COLLATE NOCASE
     AND ${SALEABLE_CONTAINER_SQL}
    GROUP BY r.item_name COLLATE NOCASE
  `).bind(JSON.stringify(itemNames)).all();
  const stocks = new Map(stocksResult.results.map((row) => [String(row.item_name).toLocaleLowerCase("en-US"), Number(row.stock || 0)]));
  const changed = [];

  requestedItems.forEach((requested) => {
    const existing = existingByLine.get(Number(requested.lineNo));
    const stock = stocks.get(String(existing.item_name).toLocaleLowerCase("en-US")) || 0;
    const revised = parseOrderValue(() => reviseOrderLine(existing, requested, stock));
    const sameMarkupValue = revised.markupValue === null
      ? existing.markup_value === null || existing.markup_value === undefined
      : Math.abs(Number(existing.markup_value) - revised.markupValue) <= 0.0001;
    const noChange = Math.abs(Number(existing.quantity) - revised.quantity) <= 0.0001
      && String(existing.markup_kind || "none") === revised.markupKind
      && sameMarkupValue;
    if (!noChange) changed.push({ existing, revised });
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
  const statements = changed.map(({ existing, revised }) => env.DB.prepare(`
    UPDATE purchase_order_items
    SET quantity = ?, stock_at_submission = ?, markup_kind = ?, markup_value = ?,
        markup_display = ?, unit_sale_ped = ?, line_tt_ped = ?, line_sale_ped = ?, price_status = ?
    WHERE order_id = ? AND line_no = ?
  `).bind(
    revised.quantity, revised.stockAtSubmission, revised.markupKind, revised.markupValue,
    revised.markupDisplay, revised.unitSalePed, revised.lineTtPed, revised.lineSalePed,
    revised.priceStatus, orderId, Number(existing.line_no)
  ));
  statements.push(
    env.DB.prepare(`
      UPDATE purchase_orders
      SET status = 'submitted', approval_required = 1,
          proposal_version = proposal_version + 1,
          total_tt_ped = (SELECT COALESCE(SUM(line_tt_ped), 0) FROM purchase_order_items WHERE order_id = ?),
          total_sale_ped = (SELECT COALESCE(SUM(line_sale_ped), 0) FROM purchase_order_items WHERE order_id = ?),
          pricing_status = CASE WHEN EXISTS (
            SELECT 1 FROM purchase_order_items WHERE order_id = ? AND price_status = 'to-confirm'
          ) THEN 'to-confirm' ELSE 'estimated' END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(orderId, orderId, orderId, orderId),
    env.DB.prepare(`
      INSERT INTO purchase_order_events (order_id, action, details)
      VALUES (?, 'proposal-changed', ?)
    `).bind(orderId, JSON.stringify({
      proposalVersion: nextVersion,
      lines: changed.map(({ existing, revised }) => ({ lineNo: Number(existing.line_no), itemName: existing.item_name, revised }))
    }))
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

async function handleAdminPost(request, url, env) {
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

  const orderItemMatch = url.pathname.match(/^\/admin\/orders\/([a-f0-9-]{36})\/items\/(\d+)$/i);
  if (orderItemMatch) {
    const body = await readTextBody(request, 20_000);
    const payload = parseJsonBody(body);
    const orderId = orderItemMatch[1].toLowerCase();
    const lineNo = Number(orderItemMatch[2]);
    const existing = await env.DB.prepare(`
      SELECT oi.order_id, oi.line_no, oi.item_name, oi.storage, oi.aisle, oi.unit_tt_ped,
             oi.quantity, oi.markup_kind, oi.markup_value
      FROM purchase_order_items oi
      JOIN purchase_orders po ON po.id = oi.order_id
      WHERE oi.order_id = ? AND oi.line_no = ?
    `).bind(orderId, lineNo).first();
    if (!existing) throw new ApiError(404, "Article de demande introuvable");

    const stockRow = await env.DB.prepare(`
      SELECT COALESCE(SUM(ii.quantity), 0) AS stock
      FROM inventory_current ii
      WHERE ii.avatar_id = 'enzo'
        AND ii.item_name = ? COLLATE NOCASE
        AND ${SALEABLE_CONTAINER_SQL}
    `).bind(existing.item_name).first();
    const revised = parseOrderValue(() => reviseOrderLine(existing, payload, Number(stockRow?.stock || 0)));
    const sameMarkupValue = revised.markupValue === null
      ? existing.markup_value === null || existing.markup_value === undefined
      : Math.abs(Number(existing.markup_value) - revised.markupValue) <= 0.0001;
    if (
      Math.abs(Number(existing.quantity) - revised.quantity) <= 0.0001
      && String(existing.markup_kind || "none") === revised.markupKind
      && sameMarkupValue
    ) {
      return json({ ok: true, noChange: true });
    }
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE purchase_order_items
        SET quantity = ?, stock_at_submission = ?, markup_kind = ?, markup_value = ?,
            markup_display = ?, unit_sale_ped = ?, line_tt_ped = ?, line_sale_ped = ?, price_status = ?
        WHERE order_id = ? AND line_no = ?
      `).bind(
        revised.quantity, revised.stockAtSubmission, revised.markupKind, revised.markupValue,
        revised.markupDisplay, revised.unitSalePed, revised.lineTtPed, revised.lineSalePed,
        revised.priceStatus, orderId, lineNo
      ),
      env.DB.prepare(`
        UPDATE purchase_orders
        SET status = 'submitted', approval_required = 1,
            proposal_version = proposal_version + 1,
            total_tt_ped = (SELECT COALESCE(SUM(line_tt_ped), 0) FROM purchase_order_items WHERE order_id = ?),
            total_sale_ped = (SELECT COALESCE(SUM(line_sale_ped), 0) FROM purchase_order_items WHERE order_id = ?),
            pricing_status = CASE WHEN EXISTS (
              SELECT 1 FROM purchase_order_items WHERE order_id = ? AND price_status = 'to-confirm'
            ) THEN 'to-confirm' ELSE 'estimated' END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(orderId, orderId, orderId, orderId),
      env.DB.prepare(`
        INSERT INTO purchase_order_events (order_id, action, details)
        VALUES (?, 'proposal-line-changed', ?)
      `).bind(orderId, JSON.stringify({ lineNo, itemName: existing.item_name, revised }))
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
    await env.DB.batch([
      env.DB.prepare(`UPDATE purchase_orders SET status = ?, approval_required = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(status, existing.id),
      env.DB.prepare(`INSERT INTO purchase_order_events (order_id, action, details) VALUES (?, 'status-changed', ?)`)
        .bind(existing.id, JSON.stringify({ from: existing.status, to: status }))
    ]);
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

async function handlePublicOrderGet(url, env) {
  if (!isCartEnabled(env)) throw new ApiError(404, "Suivi de panier désactivé");
  const match = url.pathname.match(/^\/orders\/status\/([a-f0-9-]{70,80})$/i);
  if (!match) throw new ApiError(404, "Demande introuvable");
  const tokenHash = await sha256(match[1]);
  const order = await env.DB.prepare(`
    SELECT id, public_reference, status, approval_required, proposal_version, buyer_avatar, language, frj_member,
           total_tt_ped, total_sale_ped, pricing_status, created_at, updated_at
    FROM purchase_orders
    WHERE access_token_hash = ?
  `).bind(tokenHash).first();
  if (!order) throw new ApiError(404, "Demande introuvable");
  const items = await env.DB.prepare(`
    SELECT line_no, item_name, storage, aisle, quantity, stock_at_submission,
           unit_tt_ped, markup_kind, markup_value, markup_display, unit_sale_ped,
           line_tt_ped, line_sale_ped, price_status
    FROM purchase_order_items WHERE order_id = ? ORDER BY line_no
  `).bind(order.id).all();
  return json({ order: mapPublicOrder(order, items.results) });
}

async function handlePublicOrderAcceptance(request, url, env) {
  if (!isCartEnabled(env)) throw new ApiError(503, "Suivi de panier désactivé");
  const match = url.pathname.match(/^\/orders\/status\/([a-f0-9-]{70,80})\/accept$/i);
  if (!match) throw new ApiError(404, "Demande introuvable");
  const payload = parseJsonBody(await readTextBody(request, 20_000));
  const proposalVersion = Number(payload.proposalVersion);
  if (!Number.isInteger(proposalVersion) || proposalVersion < 1) {
    throw new ApiError(400, "Version de proposition invalide");
  }
  const tokenHash = await sha256(match[1]);
  const order = await env.DB.prepare(`
    SELECT id, status, approval_required, proposal_version
    FROM purchase_orders WHERE access_token_hash = ?
  `).bind(tokenHash).first();
  if (!order) throw new ApiError(404, "Demande introuvable");
  if (Number(order.approval_required || 0) !== 1) {
    return json({ ok: true, noChange: true, status: order.status });
  }
  if (Number(order.proposal_version || 0) !== proposalVersion) {
    throw new ApiError(409, "La proposition a changé. Actualisez la page avant de l’accepter.");
  }
  const result = await env.DB.prepare(`
    UPDATE purchase_orders
    SET status = 'submitted', approval_required = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND approval_required = 1 AND proposal_version = ?
  `).bind(order.id, proposalVersion).run();
  if (Number(result.meta?.changes || 0) !== 1) {
    throw new ApiError(409, "La proposition a changé. Actualisez la page avant de l’accepter.");
  }
  await env.DB.prepare(`
    INSERT INTO purchase_order_events (order_id, action, details)
    VALUES (?, 'proposal-accepted', ?)
  `).bind(order.id, JSON.stringify({ proposalVersion })).run();
  const discord = await synchronizeDiscordOrder(env, order.id);
  return json({ ok: true, noChange: false, status: "submitted", discord: publicDiscordResult(discord) });
}

async function handlePublicOrderPost(request, env) {
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
  const result = await env.DB.prepare(`
    WITH requested AS (
      SELECT
        json_extract(value, '$.itemName') AS item_name,
        upper(trim(json_extract(value, '$.storage'))) AS storage,
        upper(trim(json_extract(value, '$.aisle'))) AS aisle
      FROM json_each(?)
    ), inventory AS (
      SELECT ii.item_name, SUM(ii.quantity) AS stock
      FROM inventory_current ii
      WHERE ii.avatar_id = 'enzo' AND ${SALEABLE_CONTAINER_SQL}
      GROUP BY ii.item_name COLLATE NOCASE
    )
    SELECT
      c.name AS item_name,
      l.storage,
      l.aisle,
      inventory.stock,
      c.unit_price_ped,
      CASE WHEN datetime(mc.observed_at) >= datetime('now', '-7 days') THEN mc.weighted_kind ELSE NULL END AS markup_kind,
      CASE WHEN datetime(mc.observed_at) >= datetime('now', '-7 days') THEN mc.weighted_value ELSE NULL END AS markup_value
    FROM requested r
    JOIN catalog_listings l
      ON l.item_name = r.item_name COLLATE NOCASE
     AND l.storage = r.storage COLLATE NOCASE
     AND l.aisle = r.aisle COLLATE NOCASE
     AND l.enabled = 1
    JOIN catalog_items c ON c.name = l.item_name COLLATE NOCASE
    JOIN inventory ON inventory.item_name = c.name COLLATE NOCASE
    LEFT JOIN market_current mc ON mc.item_name = c.name COLLATE NOCASE
    WHERE inventory.stock > 0
  `).bind(requestedJson).all();
  return result.results.map((row) => ({
    itemName: row.item_name,
    storage: row.storage,
    aisle: row.aisle,
    stock: Number(row.stock || 0),
    unitTtPed: Number(row.unit_price_ped || 0),
    markupKind: row.markup_kind || "none",
    markupValue: row.markup_value === null || row.markup_value === undefined ? null : Number(row.markup_value)
  }));
}

async function storePurchaseOrder(env, order, items, eventAction) {
  const statements = [
    env.DB.prepare(`
      INSERT INTO purchase_orders (
        id, public_reference, access_token_hash, status, buyer_avatar, buyer_contact,
        buyer_comment, language, frj_member, source_backend, total_tt_ped,
        total_sale_ped, pricing_status, submitter_hash, client_created_at,
        discord_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      order.id, order.publicReference, order.accessTokenHash, order.status || "submitted",
      order.buyerAvatar, order.buyerContact || null, order.buyerComment || null,
      order.language || "EN", order.frjMember ? 1 : 0, order.sourceBackend || "d1",
      Number(order.totalTtPed || 0), Number(order.totalSalePed || 0),
      order.pricingStatus || "estimated", order.submitterHash || null, order.clientCreatedAt || null,
      order.discordMessageId || null
    ),
    ...items.map((item, index) => env.DB.prepare(`
      INSERT INTO purchase_order_items (
        order_id, line_no, item_name, storage, aisle, quantity, stock_at_submission,
        unit_tt_ped, markup_kind, markup_value, markup_display, unit_sale_ped,
        line_tt_ped, line_sale_ped, price_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      order.id, Number(item.lineNo || index + 1), item.itemName, item.storage, item.aisle,
      Number(item.quantity), Number(item.stockAtSubmission), Number(item.unitTtPed),
      item.markupKind || "none", item.markupValue ?? null, item.markupDisplay || null,
      Number(item.unitSalePed), Number(item.lineTtPed), Number(item.lineSalePed),
      item.priceStatus || "estimated"
    )),
    env.DB.prepare(`INSERT INTO purchase_order_events (order_id, action, details) VALUES (?, ?, ?)`)
      .bind(order.id, eventAction, JSON.stringify({ sourceBackend: order.sourceBackend || "d1" }))
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
    status: "submitted",
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
  await storePurchaseOrder(env, canonical, items, "gas-fallback-synchronized");
  const discord = canonical.discordMessageId
    ? { ok: true, action: "imported", messageId: canonical.discordMessageId }
    : await synchronizeDiscordOrder(env, canonical.id);
  return { ok: true, duplicate: false, id, discord: publicDiscordResult(discord) };
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
             line_tt_ped, line_sale_ped, price_status
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
      env.DB.prepare(`
        INSERT INTO purchase_order_events (order_id, action, details)
        VALUES (?, ?, ?)
      `).bind(orderId, `discord-${result.action}`, JSON.stringify({ messageId: result.messageId }))
    ]);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "Notification Discord impossible", orderId, error: message }));
    await env.DB.prepare(`
      INSERT INTO purchase_order_events (order_id, action, details)
      VALUES (?, 'discord-notification-failed', ?)
    `).bind(orderId, JSON.stringify({ error: message.slice(0, 500) })).run();
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

async function readAdminOrders(env) {
  if (!isCartEnabled(env)) return { enabled: false, generatedAt: new Date().toISOString(), orders: [] };
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
             oi.line_tt_ped, oi.line_sale_ped, oi.price_status
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

async function readOrdersForGasMirror(env, url) {
  const afterEventId = Number(url.searchParams.get("afterEventId") || 0);
  if (!Number.isInteger(afterEventId) || afterEventId < 0) {
    throw new ApiError(400, "Curseur de commandes invalide");
  }
  const eventsResult = await env.DB.prepare(`
    SELECT id, order_id
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
  const [ordersResult, itemsResult] = await env.DB.batch([
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
             line_tt_ped, line_sale_ped, price_status
      FROM purchase_order_items
      WHERE order_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      ORDER BY order_id, line_no
    `).bind(idsJson)
  ]);
  const itemsByOrder = {};
  itemsResult.results.forEach((item) => {
    (itemsByOrder[item.order_id] ||= []).push(mapOrderItem(item));
  });
  const orders = ordersResult.results.map((row) => ({
    ...mapAdminOrder(row),
    accessTokenHash: row.access_token_hash,
    items: itemsByOrder[row.id] || []
  }));
  return {
    orders,
    cursor: Math.max(...eventsResult.results.map((row) => Number(row.id))),
    hasMore: eventsResult.results.length === 500
  };
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
    markupValue: item.markup_value ?? item.markupValue ?? null
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

function cleanNullableText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function cleanNullableNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function isAuthorized(request, configuredToken) {
  if (!configuredToken) return false;
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!supplied) return false;
  return timingSafeEqual(supplied, configuredToken);
}

async function timingSafeEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatFrenchDateTime(value) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(value)).map((part) => [part.type, part.value])
  );
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function formatInventoryDate(value) {
  const date = new Date(value);
  const formatted = formatFrenchDateTime(date).replace(" ", " - ");
  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    timeZoneName: "longOffset"
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value || "GMT+00:00";
  return `${formatted} (${offsetName.replace("GMT", "UTC")})`;
}

function publicJson(data) {
  const response = json(data);
  response.headers.set("Cache-Control", "public, max-age=60, s-maxage=300");
  return response;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" }
  });
}

function legacyText(message, importId, rowsWritten = 0) {
  return new Response(message, {
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      "X-Import-Id": importId,
      "X-D1-Rows-Written": String(rowsWritten)
    }
  });
}

function corsPreflight(origin) {
  if (!PUBLIC_ORIGINS.has(origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    }
  });
}

function withCors(response, origin) {
  if (PUBLIC_ORIGINS.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Expose-Headers", "X-Import-Id, X-D1-Rows-Written");
    response.headers.set("Vary", "Origin");
  }
  return response;
}

async function readTextBody(request, limit) {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let byteCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    byteCount += value.byteLength;
    if (byteCount > limit) {
      await reader.cancel("Import trop volumineux");
      throw new ApiError(413, "Import trop volumineux");
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

function parseImport(parser) {
  try {
    return parser();
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "Import invalide");
  }
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
