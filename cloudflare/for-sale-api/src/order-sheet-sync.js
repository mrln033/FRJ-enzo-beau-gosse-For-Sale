import { ApiError, sha256 } from "./http.js";
import { requireQuoteTransition } from "./admin-quotes.js";
import { canReviseOrder, confirmsOrderPricing, validateOrderStatus, orderItemKey, reviseOrderLine, priceOrderLine, formatMarkup } from "./orders.js";
import { computeDiscountedMarkup, businessDateInParis } from "./discounts.js";

const UUID = /^[a-f0-9-]{36}$/i;
const revisionSql = "(SELECT COALESCE(MAX(id),0) FROM purchase_order_events WHERE order_id = po.id AND action NOT LIKE 'discord-%')";
export async function readSheetOrder(env, id, helpers) {
  if (!UUID.test(String(id))) throw new ApiError(400, "Identifiant de demande invalide");
  const [orders, items] = await env.DB.batch([
    env.DB.prepare(`SELECT po.*, ${revisionSql} AS edit_revision FROM purchase_orders po WHERE po.id = ?`).bind(id),
    env.DB.prepare("SELECT * FROM purchase_order_items WHERE order_id = ? ORDER BY line_no").bind(id)
  ]);
  const row = orders.results[0];
  if (!row) throw new ApiError(404, "Demande introuvable");
  return { row, items: items.results, snapshot: {
    ...helpers.mapAdminOrder(row), accessTokenHash: row.access_token_hash,
    editRevision: Number(row.edit_revision), items: items.results.map(helpers.mapOrderItem)
  } };
}

function text(value, max, required = false) {
  if (typeof value !== "string") throw new ApiError(400, "Texte invalide");
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (clean.length > max || (required && !clean)) throw new ApiError(400, "Texte absent ou trop long");
  return clean;
}
function validStatus(value) {
  try { return validateOrderStatus(value); }
  catch (error) { throw new ApiError(400,error.message); }
}
export function editableSheetDraft(snapshot) {
  return {
    buyerAvatar: snapshot.buyerAvatar || "", buyerContact: snapshot.buyerContact || "",
    buyerComment: snapshot.buyerComment || "", language: snapshot.language || "FR",
    frjMember: snapshot.frjMember === true, status: snapshot.status,
    items: snapshot.items.map(item => ({
      lineNo: Number(item.lineNo), itemName: item.itemName, storage: item.storage, aisle: item.aisle,
      quantity: Number(item.quantity), markupKind: item.markupKind || "none",
      markupAmount: item.markupValue == null ? null : Number(
        (item.markupKind === "percent" ? Number(item.markupValue) * 100 : Number(item.markupValue)).toFixed(6))
    }))
  };
}

export async function applySheetOrder(env, payload, helpers) {
  const id = String(payload?.orderId || "").toLowerCase();
  const operationId = String(payload?.operationId || "").toLowerCase();
  if (!UUID.test(id) || !/^sheet-[a-f0-9-]{36}$/.test(operationId)) throw new ApiError(400, "Opération invalide");
  const expected = Number(payload.baseRevision);
  if (!Number.isSafeInteger(expected) || expected < 0) throw new ApiError(400, "Version de base manquante");
  const digest = await sha256(JSON.stringify(payload.draft));
  const receipt = await env.DB.prepare("SELECT order_id, details FROM purchase_order_events WHERE event_key = ?")
    .bind(operationId).first();
  if (receipt) {
    if (receipt.order_id !== id || JSON.parse(receipt.details || "{}").digest !== digest) {
      throw new ApiError(409, "Identifiant d'opération déjà utilisé");
    }
    return { ok: true, duplicate: true, snapshot: (await readSheetOrder(env, id, helpers)).snapshot };
  }
  const current = await readSheetOrder(env, id, helpers);
  if (current.snapshot.editRevision !== expected) {
    return { ok: false, conflict: true, error: "D1 a changé : choisissez quelle version conserver.", snapshot: current.snapshot };
  }
  if (current.row.status === "completed") {
    if (JSON.stringify(payload.draft) === JSON.stringify(editableSheetDraft(current.snapshot))) return {ok:true,noChange:true,snapshot:current.snapshot};
    throw new ApiError(409,"Demande Terminée : coordonnées, statut et articles définitivement verrouillés.");
  }
  const source = payload.draft;
  if (!source || typeof source.frjMember !== "boolean") throw new ApiError(400, "Profil invalide");
  const draft = {
    buyerAvatar: text(source.buyerAvatar, 80, true),
    buyerContact: text(source.buyerContact, 160), buyerComment: text(source.buyerComment, 800),
    language: text(source.language, 2).toUpperCase(), frjMember: source.frjMember,
    status: source.status === "awaiting_approval" ? "awaiting_approval" : validStatus(source.status),
    items: source.items
  };
  if (!["FR", "EN"].includes(draft.language)) throw new ApiError(400, "Langue : FR ou EN");
  if (!Array.isArray(draft.items) || !draft.items.length || draft.items.length > 30) throw new ApiError(400, "1 à 30 articles requis");
  draft.items = draft.items.map(item => {
    if (!Number.isInteger(item.lineNo) || item.lineNo < 1 || item.lineNo > 10000) throw new ApiError(400, "Numéro de ligne invalide");
    if (!["none", "percent", "ped", "auto"].includes(item.markupKind)) throw new ApiError(400, "Type MU invalide");
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000000) throw new ApiError(400, "Quantité invalide");
    if (!["none", "auto"].includes(item.markupKind) && (item.markupAmount === null || item.markupAmount === "" ||
      !Number.isFinite(Number(item.markupAmount)))) throw new ApiError(400, "MU à renseigner");
    return { lineNo: item.lineNo, itemName: text(item.itemName, 180, true),
      storage: text(item.storage, 80, true).toUpperCase(), aisle: text(item.aisle, 120, true).toUpperCase(),
      quantity: item.quantity, markupKind: item.markupKind,
      markupAmount: ["none", "auto"].includes(item.markupKind) ? null : Number(item.markupAmount) };
  }).sort((a,b) => a.lineNo - b.lineNo);
  if (new Set(draft.items.map(item => item.lineNo)).size !== draft.items.length ||
    new Set(draft.items.map(orderItemKey)).size !== draft.items.length) throw new ApiError(400, "Lignes ou articles dupliqués");
  const base = editableSheetDraft(current.snapshot);
  const profileChanged = draft.frjMember !== base.frjMember;
  const termsChanged = JSON.stringify(draft.items) !== JSON.stringify(base.items) || profileChanged;
  const statusChanged = draft.status !== base.status;
  requireQuoteTransition(current.row,draft.status);
  const adminQuote = draft.status === "admin_quote";
  const mutable = canReviseOrder(current.row.status, current.row.approval_required);
  if (termsChanged && !mutable) throw new ApiError(409, "Prix et quantités verrouillés : rouvrir la demande depuis l'application avant modification.");
  if (termsChanged && statusChanged && draft.status !== "awaiting_approval") {
    throw new ApiError(400, "Enregistrez les nouveaux prix séparément du changement de statut.");
  }
  if (JSON.stringify(draft) === JSON.stringify(base)) return { ok: true, noChange: true, snapshot: current.snapshot };
  const confirming = statusChanged && confirmsOrderPricing(draft.status);
  let priced = current.items.map(item => ({ ...item }));
  if (termsChanged) {
    const catalog = await helpers.readAdminOrderCatalog(env, draft.items);
    const catalogByKey = new Map(catalog.items.map(item => [orderItemKey(item), item]));
    const oldByNo = new Map(current.items.map(item => [Number(item.line_no), item]));
    priced = draft.items.map(item => {
      const old = oldByNo.get(item.lineNo);
      const oldDraft = base.items.find(line => line.lineNo === item.lineNo);
      if (!profileChanged && !confirming && oldDraft && JSON.stringify(item) === JSON.stringify(oldDraft)) return { ...old };
      const now = catalogByKey.get(orderItemKey(item));
      if (!now) throw new ApiError(409, "Article indisponible : " + item.itemName);
      const unchangedMarkup = oldDraft && item.markupKind === oldDraft.markupKind && item.markupAmount === oldDraft.markupAmount
        && orderItemKey(item) === orderItemKey(oldDraft);
      let kind = item.markupKind, amount = item.markupAmount;
      if (kind === "auto" || (unchangedMarkup && (profileChanged || confirming))) {
        const oldBase = old && Number(old.base_markup_profiled) === 1
          ? helpers.deriveBaseMarkup(old.markup_kind,old.markup_value,base.frjMember,old.discount_rate)
          : old ? {kind:old.base_markup_kind || old.markup_kind,value:old.base_markup_value ?? old.markup_value} : null;
        const computed = computeDiscountedMarkup({ kind: kind === "auto" ? now.markupKind : old.base_markup_kind || old.markup_kind,
          value: kind === "auto" ? now.markupValue : oldBase.value,
          frjMember: draft.frjMember, discountRate: now.discountRate || 0 });
        kind = computed.kind;
        if (kind === "none") throw new ApiError(409, "MU catalogue invalide : " + item.itemName);
        amount = Number((kind === "percent" ? computed.value * 100 : computed.value).toFixed(6));
      }
      let revised;
      try { revised = reviseOrderLine(now, { quantity: item.quantity, markupKind: kind, markupAmount: amount }, now.availableStock); }
      catch (error) { throw new ApiError(400,error.message); }
      const raw = helpers.deriveBaseMarkup(revised.markupKind, revised.markupValue, draft.frjMember, now.discountRate);
      return { order_id: id, line_no: item.lineNo, item_name: now.itemName, storage: now.storage, aisle: now.aisle,
        quantity: revised.quantity, stock_at_submission: revised.stockAtSubmission, unit_tt_ped: now.unitTtPed,
        markup_kind: revised.markupKind, markup_value: revised.markupValue, markup_display: revised.markupDisplay,
        unit_sale_ped: revised.unitSalePed, line_tt_ped: revised.lineTtPed, line_sale_ped: revised.lineSalePed,
        price_status: confirming ? "confirmed" : revised.priceStatus,
        base_markup_kind: raw.kind, base_markup_value: raw.value, base_markup_profiled: 0,
        discount_campaign_id: now.discountCampaignId, discount_kind: now.discountKind, discount_rate: now.discountRate };
    });
  } else if (confirming) {
    // Comme la confirmation Admin : actualiser la campagne, conserver TT/quantité/MU de base,
    // même si l'article n'est plus au catalogue ou si son stock vient d'être vendu.
    if (mutable) {
      const date = businessDateInParis();
      const campaigns = await env.DB.prepare(`SELECT oi.line_no, COALESCE(s.id,p.id) AS id,
        COALESCE(s.campaign_type,p.campaign_type) AS kind, COALESCE(s.discount_rate,p.discount_rate) AS rate
        FROM purchase_order_items oi
        LEFT JOIN discount_campaigns s ON s.campaign_type='sale' AND s.enabled=1 AND ? BETWEEN s.starts_on AND s.ends_on
        LEFT JOIN discount_campaigns p ON p.campaign_type='daily_promo' AND p.enabled=1 AND p.starts_on=?
          AND p.storage=oi.storage AND p.aisle=oi.aisle
        WHERE oi.order_id=?`).bind(date,date,id).all();
      const byNo = new Map(campaigns.results.map(row=>[Number(row.line_no),row]));
      priced = priced.map(item=>{
        const campaign = byNo.get(Number(item.line_no));
        const mu = computeDiscountedMarkup({kind:item.base_markup_kind || item.markup_kind,
          value:item.base_markup_value ?? item.markup_value,
          frjMember:Number(item.base_markup_profiled)===1 ? false : draft.frjMember,
          discountRate:campaign?.rate || 0});
        const prices = priceOrderLine(item.unit_tt_ped,item.quantity,mu.kind,mu.value);
        return {...item,markup_kind:mu.kind,markup_value:mu.value,markup_display:formatMarkup(mu.kind,mu.value),
          unit_sale_ped:prices.unitSalePed,line_tt_ped:prices.lineTtPed,line_sale_ped:prices.lineSalePed,
          discount_campaign_id:campaign?.id ?? null,discount_kind:campaign?.kind ?? null,discount_rate:campaign?.rate ?? null};
      });
    }
    priced.forEach(item => { item.price_status = "confirmed"; });
  }
  const round = n => Math.round(n * 100) / 100;
  const totalTt = round(priced.reduce((n,item) => n + Number(item.line_tt_ped), 0));
  const totalSale = round(priced.reduce((n,item) => n + Number(item.line_sale_ped), 0));
  const status = adminQuote || termsChanged || draft.status === "awaiting_approval" ? "submitted" : draft.status;
  const approval = adminQuote ? 0 : termsChanged || draft.status === "awaiting_approval" ? 1 : statusChanged ? 0 : current.row.approval_required;
  const pricing = confirming ? "confirmed" : termsChanged
    ? priced.some(item => item.price_status === "to-confirm") ? "to-confirm" : "estimated" : current.row.pricing_status;
  // Le reçu et les écritures sont atomiques. Une révision concurrente ne peut pas être écrasée.
  const attempt = crypto.randomUUID();
  const guard = "EXISTS (SELECT 1 FROM purchase_order_events WHERE event_key = ? AND order_id = ? AND json_extract(details,'$.attempt') = ?)";
  const guardArgs = [operationId, id, attempt];
  const statements = [env.DB.prepare(`INSERT OR IGNORE INTO purchase_order_events
    (order_id, action, actor, event_key, comment, details)
    SELECT po.id, 'sheet-order-edited', 'gas', ?, ?, ? FROM purchase_orders po
    WHERE po.id = ? AND ${revisionSql} = ?`).bind(operationId, "Demande modifiée depuis Google Sheets.",
      JSON.stringify({ digest, attempt, termsChanged, statusChanged, from:base.status, to:adminQuote ? "admin_quote" : status, previousApprovalRequired:current.row.approval_required }), id, expected)];
  statements.push(env.DB.prepare(`UPDATE purchase_orders SET buyer_avatar=?, buyer_contact=?, buyer_comment=?,
    language=?, frj_member=?, status=?, approval_required=?, admin_quote=?, proposal_version=proposal_version+?,
    total_tt_ped=?, total_sale_ped=?, pricing_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND ${guard}`)
    .bind(draft.buyerAvatar, draft.buyerContact || null, draft.buyerComment || null, draft.language,
      draft.frjMember ? 1 : 0, status, approval, adminQuote ? 1 : 0, termsChanged ? 1 : 0, totalTt, totalSale, pricing, id, ...guardArgs));
  const columns = ["item_name","storage","aisle","quantity","stock_at_submission","unit_tt_ped","markup_kind","markup_value",
    "markup_display","unit_sale_ped","line_tt_ped","line_sale_ped","price_status","base_markup_kind","base_markup_value",
    "base_markup_profiled","discount_campaign_id","discount_kind","discount_rate"];
  const oldByNo = new Map(current.items.map(item => [Number(item.line_no), item]));
  for (const item of priced) {
    const old = oldByNo.get(Number(item.line_no));
    if (old && columns.every(key => (old[key] ?? null) === (item[key] ?? null))) continue;
    if (old) statements.push(env.DB.prepare(`UPDATE purchase_order_items SET ${columns.map(c => c+"=?").join(",")}
      WHERE order_id=? AND line_no=? AND ${guard}`).bind(...columns.map(c => item[c] ?? null), id, item.line_no, ...guardArgs));
    else statements.push(env.DB.prepare(`INSERT INTO purchase_order_items (order_id,line_no,${columns.join(",")})
      SELECT ?,?,${columns.map(() => "?").join(",")} WHERE ${guard}`)
      .bind(id,item.line_no,...columns.map(c => item[c] ?? null),...guardArgs));
  }
  for (const old of current.items) if (!priced.some(item => item.line_no === old.line_no)) {
    statements.push(env.DB.prepare(`DELETE FROM purchase_order_items WHERE order_id=? AND line_no=? AND ${guard}`)
      .bind(id,old.line_no,...guardArgs));
  }
  // Confirmer les lignes avant de verrouiller définitivement l’entête Terminée.
  statements.push(statements.splice(1,1)[0]);
  const results = await env.DB.batch(statements);
  if (!Number(results[0].meta?.changes)) return { ok:false, conflict:true,
    error:"D1 a changé pendant l'enregistrement.", snapshot:(await readSheetOrder(env,id,helpers)).snapshot };
  const discord = await helpers.synchronizeDiscordOrder(env,id);
  return { ok:true, discord, snapshot:(await readSheetOrder(env,id,helpers)).snapshot };
}
