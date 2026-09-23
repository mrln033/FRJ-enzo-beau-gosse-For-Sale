import { ApiError } from "./http.js";
import { isAdminQuote } from "./admin-quotes.js";
import { readSheetOrder } from "./order-sheet-sync.js";
import { computeDiscountedMarkup } from "./discounts.js";
import { priceOrderLine, formatMarkup } from "./orders.js";

// Le dernier contrôle est conservé dans l'historique existant : pas de nouvelle table.
export const quoteMarkupReportSql = `CASE WHEN admin_quote = 1 THEN (
  SELECT json_extract(e.details, '$.markupRefresh') FROM purchase_order_events e
  WHERE e.order_id = purchase_orders.id AND e.action = 'proposal-changed'
    AND json_extract(e.details, '$.markupRefresh') IS NOT NULL
  ORDER BY e.id DESC LIMIT 1) ELSE NULL END`;
export const orderEditRevisionSql = `(SELECT COALESCE(MAX(e.id),0) FROM purchase_order_events e
  WHERE e.order_id = purchase_orders.id AND e.action NOT LIKE 'discord-%')`;

export async function refreshQuoteMarkups(env, id, payload, helpers) {
  const operationId = String(payload?.operationId || "");
  const expected = payload?.baseRevision;
  if (!/^[a-f0-9-]{36}$/i.test(operationId) || !Number.isSafeInteger(expected) || expected < 0) {
    throw new ApiError(400, "Actualisez la liste avant de mettre les MU à jour.");
  }
  const receipt = await env.DB.prepare("SELECT order_id, details FROM purchase_order_events WHERE event_key = ?")
    .bind(operationId).first();
  if (receipt) {
    const report = JSON.parse(receipt.details || "{}").markupRefresh;
    if (receipt.order_id !== id || !report) throw new ApiError(409, "Identifiant d’opération déjà utilisé.");
    return { ok: true, duplicate: true, report };
  }
  const current = await readSheetOrder(env, id, helpers);
  if (!isAdminQuote(current.row) || current.row.status === "completed") {
    throw new ApiError(409, "Cette action est réservée aux Devis Admin.");
  }
  if (current.snapshot.editRevision !== expected) throw new ApiError(409, "Le devis a changé. Actualisez la liste.");
  // Recherche par noms indexés, indépendante du stock, des rayons et des promotions.
  const names = [...new Set(current.items.map(item => item.item_name))];
  const market = await env.DB.prepare(`
    SELECT c.name, mc.weighted_kind AS kind, mc.weighted_value AS value,
      CASE WHEN datetime(mc.observed_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END AS fresh
    FROM catalog_items c LEFT JOIN market_current mc ON mc.item_name = c.name COLLATE NOCASE
    WHERE c.name COLLATE NOCASE IN (SELECT value FROM json_each(?))
  `).bind(JSON.stringify(names)).all();
  const byName = new Map(market.results.map(row => [row.name.toLocaleLowerCase("en-US"), row]));
  const report = { checkedAt: new Date().toISOString(), profile: current.snapshot.frjMember ? "frj" : "public",
    changed: 0, unchanged: 0, missing: [] };
  const changed = [];
  for (const item of current.items) {
    const row = byName.get(item.item_name.toLocaleLowerCase("en-US"));
    const mu = row?.fresh === 1 && row.value !== null
      ? computeDiscountedMarkup({ kind: row.kind, value: row.value, frjMember: current.snapshot.frjMember, discountRate: 0 })
      : { kind: "none", value: null };
    if (mu.kind === "none" || !Number.isFinite(mu.value)) {
      report.missing.push({ lineNo: Number(item.line_no), itemName: item.item_name, storage: item.storage, aisle: item.aisle,
        reason: !row ? "article-absent" : row.fresh !== 1 ? "mu-absent-ou-expire" : "mu-invalide" });
      continue;
    }
    const prices = priceOrderLine(Number(item.unit_tt_ped), Number(item.quantity), mu.kind, mu.value);
    const next = { markup_kind: mu.kind, markup_value: mu.value, markup_display: formatMarkup(mu.kind, mu.value),
      unit_sale_ped: prices.unitSalePed, line_sale_ped: prices.lineSalePed,
      base_markup_kind: row.kind, base_markup_value: Number(row.value), base_markup_profiled: 0,
      discount_campaign_id: null, discount_kind: null, discount_rate: null };
    if (Object.keys(next).every(key => (item[key] ?? null) === next[key])) { report.unchanged++; continue; }
    next.price_status = "estimated";
    changed.push({ item, next });
    report.changed++;
  }
  // Le reçu sert de garde dans le même batch : révision concurrente => aucune écriture.
  const details = { markupRefresh: report, baseRevision: expected,
    previous: changed.map(({ item }) => ({ ...item })) };
  const guard = "EXISTS (SELECT 1 FROM purchase_order_events WHERE event_key = ? AND order_id = ?)";
  const statements = [env.DB.prepare(`
    INSERT INTO purchase_order_events (order_id, action, actor, event_key, comment, details)
    SELECT id, 'proposal-changed', 'admin', ?, ?, ? FROM purchase_orders
    WHERE id = ? AND admin_quote = 1 AND status != 'completed' AND ${orderEditRevisionSql} = ?
  `).bind(operationId, `MU du devis actualisés (${report.profile === "frj" ? "FRJ" : "Public"}, hors promotion) : ${report.changed} modifiés, ${report.unchanged} inchangés, ${report.missing.length} à renseigner.`,
    JSON.stringify(details), id, expected)];
  for (const { item, next } of changed) {
    const columns = Object.keys(next);
    statements.push(env.DB.prepare(`UPDATE purchase_order_items SET ${columns.map(key => key + "=?").join(",")}
      WHERE order_id=? AND line_no=? AND ${guard}`)
      .bind(...columns.map(key => next[key]), id, item.line_no, operationId, id));
  }
  statements.push(env.DB.prepare(`UPDATE purchase_orders SET
    total_sale_ped=CASE WHEN ?=0 THEN total_sale_ped ELSE
      (SELECT ROUND(COALESCE(SUM(line_sale_ped),0),2) FROM purchase_order_items WHERE order_id=?) END,
    pricing_status=CASE WHEN ?=0 THEN pricing_status WHEN EXISTS (
      SELECT 1 FROM purchase_order_items WHERE order_id=? AND price_status='to-confirm'
    ) THEN 'to-confirm' ELSE 'estimated' END,
    proposal_version=proposal_version+?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND ${guard}`).bind(changed.length, id, changed.length, id, changed.length ? 1 : 0, id, operationId, id));
  let results;
  try { results = await env.DB.batch(statements); }
  catch (error) {
    // Une reprise simultanée avec la même clé peut rencontrer la contrainte UNIQUE.
    const saved = await env.DB.prepare("SELECT order_id, details FROM purchase_order_events WHERE event_key=?").bind(operationId).first();
    if (saved?.order_id === id && JSON.parse(saved.details || "{}").markupRefresh) {
      return { ok: true, duplicate: true, report: JSON.parse(saved.details).markupRefresh };
    }
    throw error;
  }
  if (!Number(results[0].meta?.changes)) throw new ApiError(409, "Le devis a changé pendant l’actualisation. Rechargez la liste.");
  const discord = await helpers.synchronizeDiscordOrder(env, id);
  return { ok: true, report, discord };
}
