import { computeWeightedMarkup, normalizeInventoryRows, normalizeMarketRows } from "./domain.js";
import {
  catalogContentHash,
  inventoryContentHash,
  mapCatalogDbRow,
  mapInventoryDbRow,
  mapMarketDbRow,
  marketContentHash,
  mergeMarketRows,
  normalizeSyncTimestamp
} from "./sync.js";

const MAX_IMPORT_BYTES = 1_800_000;
const INVENTORY_RETENTION_COUNT = 5;
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

      if (isSyncRequest && !(await isAuthorized(request, env.SYNC_TOKEN || env.ADMIN_TOKEN))) {
        return withCors(json({ error: "Unauthorized" }, 401), origin);
      }

      if (isAdminRequest && !(await isAuthorized(request, env.ADMIN_TOKEN))) {
        return withCors(json({ error: "Unauthorized" }, 401), origin);
      }

      if (request.method === "GET") {
        if (isSyncRequest) return withCors(await handleSyncGet(url, env), origin);
        if (isAdminRequest) return withCors(await handleAdminGet(url, env), origin);
        return withCors(await handleGet(url, env), origin);
      }

      if (request.method === "POST") {
        if (isSyncRequest) return withCors(await handleSyncPost(request, url, env), origin);
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

  if (action === "categories") {
    const result = await env.DB.prepare(`
      SELECT l.storage
      FROM catalog_listings l
      JOIN catalog_items c ON c.name = l.item_name COLLATE NOCASE
      JOIN active_inventory ai ON ai.avatar_id = 'enzo'
      JOIN inventory_items ii
        ON ii.import_id = ai.import_id
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
      SELECT i.imported_at
      FROM active_inventory a
      JOIN inventory_imports i ON i.id = a.import_id
      WHERE a.avatar_id = 'enzo'
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
      FROM inventory_items ii
      JOIN active_inventory ai ON ai.import_id = ii.import_id
      WHERE ai.avatar_id = 'enzo'
        AND ${SALEABLE_CONTAINER_SQL}
      GROUP BY ii.item_name COLLATE NOCASE
    ),
    recent_market AS (
      SELECT
        mo.item_name,
        mo.weighted_display,
        mo.observed_at
      FROM market_observations mo
      JOIN active_market_import ami ON ami.import_id = mo.import_id
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
  if (url.pathname !== "/admin/sync-report") {
    return json({ error: "Endpoint administrateur inconnu" }, 404);
  }

  const requestedLimit = Number(url.searchParams.get("limit") || 100);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 100, 20), 200);
  const [statesResult, latestResult, eventsResult, latestRunResult] = await env.DB.batch([
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
    `)
  ]);

  const latestByDataset = Object.fromEntries(
    latestResult.results.map((row) => [row.dataset_key, mapSyncAuditRow(row)])
  );
  const latestRun = latestRunResult.results[0] || null;
  let latestRunDetails = {};
  try { latestRunDetails = latestRun?.details ? JSON.parse(latestRun.details) : {}; } catch {}
  const gasByDataset = Object.fromEntries(
    (Array.isArray(latestRunDetails.datasets) ? latestRunDetails.datasets : [])
      .filter((item) => item?.dataset)
      .map((item) => [item.dataset, {
        hash: String(item.hash || ""),
        rowCount: Number(item.rows || 0),
        updatedAt: normalizeSyncTimestamp(item.updatedAt || latestRunDetails.completedAt || latestRun?.created_at),
        observedAt: normalizeSyncTimestamp(latestRunDetails.completedAt || latestRun?.created_at)
      }])
  );
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
    const hashesMatch = Boolean(gas?.hash && d1.hash && gas.hash === d1.hash);
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
      concordance: !gas ? "unknown" : (auditMatchesCurrent ? "verified" : (hashesMatch ? "pending-audit" : "different")),
      lastAudit
    };
  });
  const system = latestByDataset._system || null;

  return json({
    generatedAt: new Date().toISOString(),
    status: !system ? "pending" : (system.action === "sync-run-failed" ? "error" : "ok"),
    system,
    lastGasRunAt: normalizeSyncTimestamp(latestRunDetails.completedAt || latestRun?.created_at),
    datasets,
    events: eventsResult.results.map(mapSyncAuditRow)
  });
}

async function handlePost(request, url, env) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_IMPORT_BYTES) throw new ApiError(413, "Import trop volumineux");

  const type = url.searchParams.get("type");
  const body = await readTextBody(request, MAX_IMPORT_BYTES);

  if (type === "inventory") {
    const avatar = url.searchParams.get("avatar") || "enzo";
    if (!AVATAR_SHEETS[avatar]) return json({ error: `Avatar inconnu : ${avatar}` }, 400);

    const rows = parseImport(() => normalizeInventoryRows(body));
    if (rows.length === 0) return json({ error: "Inventaire vide" }, 400);
    const result = await storeInventorySnapshot(env, {
      avatar,
      rows,
      rawChecksum: await sha256(body),
      sourceOrigin: "d1",
      sourceUpdatedAt: new Date().toISOString()
    });
    await notifyGasDataChanged(env, `inventory:${avatar}`, "import-d1-inventory");

    return legacyText(
      `✅ Import inventaire OK dans ${AVATAR_SHEETS[avatar]} (${rows.length + 1} lignes)`,
      result.importId
    );
  }

  if (type === "mu") {
    const observedAt = new Date().toISOString();
    const incomingRows = parseImport(() => normalizeMarketRows(body, observedAt));
    if (incomingRows.length === 0) return json({ error: "Import MU vide" }, 400);

    const currentRows = (await readMarketSnapshot(env)).rows;
    const existingItems = new Set(currentRows.map((row) => row.itemName.toLocaleLowerCase("en-US")));
    const rows = mergeMarketRows(currentRows, incomingRows);
    const updates = incomingRows.filter((row) => existingItems.has(row.itemName.toLocaleLowerCase("en-US"))).length;
    const inserts = incomingRows.length - updates;
    const result = await storeMarketSnapshot(env, {
      rows,
      rawChecksum: await sha256(body),
      sourceOrigin: "d1",
      sourceUpdatedAt: observedAt
    });
    await notifyGasDataChanged(env, "mu", "import-d1-mu");

    return legacyText(`${updates} MAJ / ${inserts} AJOUTS`, result.importId);
  }

  return json({ error: `Type inconnu : ${type || "absent"}` }, 400);
}

async function handleSyncGet(url, env) {
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
    return json({ ok: true, noChange: false, state: result.state });
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
    return json({ ok: true, noChange: false, state: result.state });
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
    return json({ ok: true, noChange: false, state: result.state });
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
  const payload = JSON.stringify(options.rows);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO inventory_imports (
        id, avatar_id, imported_at, source_row_count, checksum,
        content_checksum, source_updated_at, source_origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      importId,
      options.avatar,
      importedAt,
      options.rows.length,
      options.rawChecksum,
      contentHash,
      sourceUpdatedAt,
      options.sourceOrigin
    ),
    env.DB.prepare(`
      INSERT INTO inventory_items (
        import_id, line_no, source_id, item_name, quantity, value_ped, container, container_ref_id
      )
      SELECT
        ?,
        CAST(json_extract(value, '$.lineNo') AS INTEGER),
        json_extract(value, '$.sourceId'),
        json_extract(value, '$.itemName'),
        CAST(json_extract(value, '$.quantity') AS REAL),
        CAST(json_extract(value, '$.valuePed') AS REAL),
        json_extract(value, '$.container'),
        json_extract(value, '$.containerRefId')
      FROM json_each(?)
    `).bind(importId, payload),
    env.DB.prepare(`
      INSERT INTO active_inventory (avatar_id, import_id) VALUES (?, ?)
      ON CONFLICT (avatar_id) DO UPDATE SET import_id = excluded.import_id
    `).bind(options.avatar, importId),
    syncStateStatement(env, {
      datasetKey,
      hash: contentHash,
      updatedAt: sourceUpdatedAt,
      origin: options.sourceOrigin,
      importId,
      rowCount: options.rows.length
    }),
    env.DB.prepare(`
      INSERT INTO sync_audit (
        dataset_key, direction, action, source_checksum, target_checksum, details
      ) VALUES (?, ?, 'snapshot-imported', ?, ?, ?)
    `).bind(
      datasetKey,
      options.sourceOrigin === "gas" ? "gas-to-d1" : "d1-local",
      contentHash,
      contentHash,
      JSON.stringify({ importId, rows: options.rows.length })
    ),
    env.DB.prepare(`
      DELETE FROM inventory_imports
      WHERE avatar_id = ?
        AND id NOT IN (
          SELECT id
          FROM inventory_imports
          WHERE avatar_id = ?
          ORDER BY datetime(imported_at) DESC, created_at DESC, id DESC
          LIMIT ?
        )
        AND id NOT IN (
          SELECT import_id
          FROM active_inventory
          WHERE avatar_id = ?
        )
    `).bind(options.avatar, options.avatar, INVENTORY_RETENTION_COUNT, options.avatar),
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
      rowCount: options.rows.length
    }
  };
}

async function storeMarketSnapshot(env, options) {
  const importedAt = new Date().toISOString();
  const importId = crypto.randomUUID();
  const contentHash = options.contentHash || await marketContentHash(options.rows);
  const sourceUpdatedAt = normalizeSyncTimestamp(options.sourceUpdatedAt, importedAt);
  const payload = JSON.stringify(options.rows);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO market_imports (
        id, imported_at, source_row_count, checksum,
        content_checksum, source_updated_at, source_origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      importId,
      importedAt,
      options.rows.length,
      options.rawChecksum,
      contentHash,
      sourceUpdatedAt,
      options.sourceOrigin
    ),
    env.DB.prepare(`
      INSERT INTO market_observations (
        import_id, line_no, item_name, tier,
        day_markup, day_sales, week_markup, week_sales,
        month_markup, month_sales, year_markup, year_sales,
        decade_markup, decade_sales,
        weighted_kind, weighted_value, weighted_display, observed_at
      )
      SELECT
        ?,
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
    `).bind(importId, payload),
    env.DB.prepare(`
      INSERT INTO active_market_import (singleton, import_id) VALUES (1, ?)
      ON CONFLICT (singleton) DO UPDATE SET import_id = excluded.import_id
    `).bind(importId),
    syncStateStatement(env, {
      datasetKey: "mu",
      hash: contentHash,
      updatedAt: sourceUpdatedAt,
      origin: options.sourceOrigin,
      importId,
      rowCount: options.rows.length
    }),
    env.DB.prepare(`
      INSERT INTO sync_audit (
        dataset_key, direction, action, source_checksum, target_checksum, details
      ) VALUES ('mu', ?, 'snapshot-imported', ?, ?, ?)
    `).bind(
      options.sourceOrigin === "gas" ? "gas-to-d1" : "d1-local",
      contentHash,
      contentHash,
      JSON.stringify({ importId, rows: options.rows.length })
    ),
    env.DB.prepare(`
      DELETE FROM market_imports
      WHERE id NOT IN (
        SELECT id FROM market_imports
        ORDER BY datetime(imported_at) DESC, created_at DESC, id DESC
        LIMIT ?
      )
        AND id NOT IN (SELECT import_id FROM active_market_import WHERE singleton = 1)
    `).bind(INVENTORY_RETENTION_COUNT),
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
    }
  };
}

async function storeCatalogSnapshot(env, options) {
  const importedAt = new Date().toISOString();
  const importId = crypto.randomUUID();
  const contentHash = options.contentHash || await catalogContentHash(options.rows);
  const sourceUpdatedAt = normalizeSyncTimestamp(options.sourceUpdatedAt, importedAt);
  const payload = JSON.stringify(options.rows);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO catalog_imports (
        id, imported_at, source_row_count, content_checksum, source_updated_at, source_origin
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(importId, importedAt, options.rows.length, contentHash, sourceUpdatedAt, options.sourceOrigin),
    env.DB.prepare(`
      INSERT INTO catalog_snapshot_rows (
        import_id, line_no, item_name, storage, aisle,
        unit_price_ped, image, wiki_url, enabled
      )
      SELECT
        ?, CAST(json_extract(value, '$.lineNo') AS INTEGER),
        json_extract(value, '$.itemName'), json_extract(value, '$.storage'),
        json_extract(value, '$.aisle'), CAST(json_extract(value, '$.unitPricePed') AS REAL),
        json_extract(value, '$.image'), json_extract(value, '$.wikiUrl'),
        CAST(json_extract(value, '$.enabled') AS INTEGER)
      FROM json_each(?)
    `).bind(importId, payload),
    env.DB.prepare(`
      INSERT INTO active_catalog_import (singleton, import_id) VALUES (1, ?)
      ON CONFLICT (singleton) DO UPDATE SET import_id = excluded.import_id
    `).bind(importId),
    env.DB.prepare("DELETE FROM catalog_listings"),
    env.DB.prepare("DELETE FROM catalog_items"),
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
    `).bind(payload),
    syncStateStatement(env, {
      datasetKey: "catalog",
      hash: contentHash,
      updatedAt: sourceUpdatedAt,
      origin: options.sourceOrigin,
      importId,
      rowCount: options.rows.length
    }),
    env.DB.prepare(`
      INSERT INTO sync_audit (
        dataset_key, direction, action, source_checksum, target_checksum, details
      ) VALUES ('catalog', ?, 'snapshot-imported', ?, ?, ?)
    `).bind(
      options.sourceOrigin === "gas" ? "gas-to-d1" : "d1-bootstrap",
      contentHash,
      contentHash,
      JSON.stringify({ importId, rows: options.rows.length })
    ),
    env.DB.prepare(`
      DELETE FROM catalog_imports
      WHERE id NOT IN (
        SELECT id FROM catalog_imports
        ORDER BY datetime(imported_at) DESC, created_at DESC, id DESC
        LIMIT ?
      )
        AND id NOT IN (SELECT import_id FROM active_catalog_import WHERE singleton = 1)
    `).bind(INVENTORY_RETENTION_COUNT),
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
    }
  };
}

async function readInventorySnapshot(env, avatar, requestedHash = null) {
  const datasetKey = inventoryDatasetKey(avatar);
  const metaStatement = requestedHash
    ? env.DB.prepare(`
        SELECT
          i.id AS import_id, i.imported_at, i.content_checksum,
          i.source_updated_at, i.source_origin, i.source_row_count,
          NULL AS state_checksum, NULL AS state_updated_at, NULL AS state_origin
        FROM inventory_imports i
        WHERE i.avatar_id = ? AND i.content_checksum = ?
        ORDER BY datetime(i.imported_at) DESC, i.id DESC
        LIMIT 1
      `).bind(avatar, requestedHash)
    : env.DB.prepare(`
        SELECT
          i.id AS import_id, i.imported_at, i.content_checksum,
          i.source_updated_at, i.source_origin, i.source_row_count,
          s.content_checksum AS state_checksum,
          s.source_updated_at AS state_updated_at,
          s.source_origin AS state_origin
        FROM active_inventory ai
        JOIN inventory_imports i ON i.id = ai.import_id
        LEFT JOIN sync_state s ON s.dataset_key = ?
        WHERE ai.avatar_id = ?
      `).bind(datasetKey, avatar);

  const meta = await metaStatement.first();
  if (!meta) return { state: null, rows: [] };
  const rowsResult = await env.DB.prepare(`
    SELECT
      line_no, source_id, item_name, quantity,
      value_ped, container, container_ref_id
    FROM inventory_items
    WHERE import_id = ?
    ORDER BY line_no
  `).bind(meta.import_id).all();
  const rows = rowsResult.results.map(mapInventoryDbRow);
  const hash = meta.state_checksum || meta.content_checksum || await inventoryContentHash(rows);
  const updatedAt = normalizeSyncTimestamp(meta.state_updated_at || meta.source_updated_at || meta.imported_at);
  const origin = meta.state_origin || meta.source_origin || "d1";
  const state = {
    dataset: datasetKey,
    hash,
    updatedAt,
    origin,
    importId: meta.import_id,
    rowCount: rows.length
  };

  if (!requestedHash && (!meta.state_checksum || !meta.content_checksum)) {
    await persistDerivedSyncState(env, state, "inventory_imports");
  }

  return { state, rows };
}

async function readMarketSnapshot(env, requestedHash = null) {
  const metaStatement = requestedHash
    ? env.DB.prepare(`
        SELECT
          i.id AS import_id, i.imported_at, i.content_checksum,
          i.source_updated_at, i.source_origin, i.source_row_count,
          NULL AS state_checksum, NULL AS state_updated_at, NULL AS state_origin
        FROM market_imports i
        WHERE i.content_checksum = ?
        ORDER BY datetime(i.imported_at) DESC, i.id DESC
        LIMIT 1
      `).bind(requestedHash)
    : env.DB.prepare(`
        SELECT
          i.id AS import_id, i.imported_at, i.content_checksum,
          i.source_updated_at, i.source_origin, i.source_row_count,
          s.content_checksum AS state_checksum,
          s.source_updated_at AS state_updated_at,
          s.source_origin AS state_origin
        FROM active_market_import ai
        JOIN market_imports i ON i.id = ai.import_id
        LEFT JOIN sync_state s ON s.dataset_key = 'mu'
        WHERE ai.singleton = 1
      `);

  const meta = await metaStatement.first();
  if (!meta) return { state: null, rows: [] };
  const rowsResult = await env.DB.prepare(`
    SELECT
      line_no, item_name, tier,
      day_markup, day_sales, week_markup, week_sales,
      month_markup, month_sales, year_markup, year_sales,
      decade_markup, decade_sales,
      weighted_kind, weighted_value, weighted_display, observed_at
    FROM market_observations
    WHERE import_id = ?
    ORDER BY line_no
  `).bind(meta.import_id).all();
  const rows = rowsResult.results.map(mapMarketDbRow);
  const hash = meta.state_checksum || meta.content_checksum || await marketContentHash(rows);
  const updatedAt = normalizeSyncTimestamp(meta.state_updated_at || meta.source_updated_at || meta.imported_at);
  const origin = meta.state_origin || meta.source_origin || "d1";
  const state = {
    dataset: "mu",
    hash,
    updatedAt,
    origin,
    importId: meta.import_id,
    rowCount: rows.length
  };

  if (!requestedHash && (!meta.state_checksum || !meta.content_checksum)) {
    await persistDerivedSyncState(env, state, "market_imports");
  }

  return { state, rows };
}

async function readCatalogSnapshot(env, requestedHash = null) {
  const metaStatement = requestedHash
    ? env.DB.prepare(`
        SELECT id AS import_id, content_checksum, source_updated_at, source_origin, source_row_count
        FROM catalog_imports
        WHERE content_checksum = ?
        ORDER BY datetime(imported_at) DESC, id DESC
        LIMIT 1
      `).bind(requestedHash)
    : env.DB.prepare(`
        SELECT i.id AS import_id, i.content_checksum, i.source_updated_at, i.source_origin, i.source_row_count
        FROM active_catalog_import ai
        JOIN catalog_imports i ON i.id = ai.import_id
        WHERE ai.singleton = 1
      `);
  const meta = await metaStatement.first();

  if (!meta && !requestedHash) {
    const current = await env.DB.prepare(`
      SELECT
        ROW_NUMBER() OVER (ORDER BY c.name COLLATE NOCASE, l.storage, l.aisle) + 1 AS line_no,
        c.name AS item_name, l.storage, l.aisle,
        c.unit_price_ped, c.image, c.wiki_url, l.enabled
      FROM catalog_items c
      JOIN catalog_listings l ON l.item_name = c.name COLLATE NOCASE
      ORDER BY c.name COLLATE NOCASE, l.storage, l.aisle
    `).all();
    const rows = current.results.map(mapCatalogDbRow);
    if (!rows.length) return { state: null, rows: [] };
    const stored = await storeCatalogSnapshot(env, {
      rows,
      sourceOrigin: "d1",
      sourceUpdatedAt: new Date().toISOString()
    });
    return { state: stored.state, rows };
  }

  if (!meta) return { state: null, rows: [] };
  const rowsResult = await env.DB.prepare(`
    SELECT
      line_no, item_name, storage, aisle,
      unit_price_ped, image, wiki_url, enabled
    FROM catalog_snapshot_rows
    WHERE import_id = ?
    ORDER BY line_no
  `).bind(meta.import_id).all();
  const rows = rowsResult.results.map(mapCatalogDbRow);
  return {
    state: {
      dataset: "catalog",
      hash: meta.content_checksum,
      updatedAt: normalizeSyncTimestamp(meta.source_updated_at),
      origin: meta.source_origin,
      importId: meta.import_id,
      rowCount: rows.length
    },
    rows
  };
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
  const row = await env.DB.prepare(`
    SELECT dataset_key, content_checksum, source_updated_at, source_origin, import_id, row_count
    FROM sync_state
    WHERE dataset_key = ?
  `).bind(datasetKey).first();
  if (row) return mapSyncState(row);

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

async function persistDerivedSyncState(env, state, tableName) {
  const updateSql = tableName === "inventory_imports"
    ? `UPDATE inventory_imports
       SET content_checksum = ?, source_updated_at = COALESCE(source_updated_at, ?),
           source_origin = COALESCE(source_origin, ?)
       WHERE id = ?`
    : `UPDATE market_imports
       SET content_checksum = ?, source_updated_at = COALESCE(source_updated_at, ?),
           source_origin = COALESCE(source_origin, ?)
       WHERE id = ?`;

  await env.DB.batch([
    env.DB.prepare(updateSql).bind(state.hash, state.updatedAt, state.origin, state.importId),
    syncStateStatement(env, {
      datasetKey: state.dataset,
      hash: state.hash,
      updatedAt: state.updatedAt,
      origin: state.origin,
      importId: state.importId,
      rowCount: state.rowCount
    })
  ]);
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

async function handleAdminPost(request, url, env) {
  if (url.pathname !== "/admin/sync-request") {
    return json({ error: "Endpoint administrateur inconnu" }, 404);
  }
  const body = await readTextBody(request, 20_000);
  const payload = parseJsonBody(body);
  const dataset = String(payload.dataset || "").trim();
  const reason = String(payload.reason || "modification-gas").trim();
  return json(await notifyGasDataChanged(env, dataset, reason));
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

function legacyText(message, importId) {
  return new Response(message, {
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      "X-Import-Id": importId
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
