import { ApiError } from "./http.js";
import { deleteDiscordOrderMessage } from "./discord.js";

export async function finishQuoteDiscordDeletion(env, id) {
  const row = await env.DB.prepare("SELECT discord_message_id FROM purchase_order_deletions WHERE order_id=?").bind(id).first();
  if (!row?.discord_message_id) return true;
  try {
    await deleteDiscordOrderMessage({webhookUrl:env.DISCORD_ORDER_WEBHOOK_URL,messageId:row.discord_message_id});
    await env.DB.prepare("UPDATE purchase_order_deletions SET discord_message_id=NULL WHERE order_id=? AND discord_message_id=?")
      .bind(id,row.discord_message_id).run();
    return true;
  } catch {
    // Le message reste dans l'outbox, jamais perdu après l'effacement du modèle.
    return false;
  }
}

export async function deleteAdminQuote(env, id, confirmation) {
  const order = await env.DB.prepare("SELECT id,public_reference,admin_quote,status FROM purchase_orders WHERE id=?").bind(id).first();
  if (!order) {
    const deleted = await env.DB.prepare("SELECT order_id FROM purchase_order_deletions WHERE order_id=?").bind(id).first();
    if (!deleted) throw new ApiError(404,"Devis introuvable");
    return {ok:true,deleted:true,alreadyDeleted:true,syncPending:true};
  }
  if (Number(order.admin_quote)!==1 || order.status!=="submitted") throw new ApiError(409,"Seuls les Devis Admin peuvent être supprimés définitivement.");
  if (confirmation!==order.public_reference) throw new ApiError(400,"Confirmation de la référence du devis requise.");
  // INSERT conditionnel et cascade dans une transaction : les copies sont indépendantes.
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO purchase_order_deletions(order_id,discord_message_id)
      SELECT id,discord_message_id FROM purchase_orders WHERE id=? AND admin_quote=1 AND status='submitted'`).bind(id),
    env.DB.prepare(`DELETE FROM purchase_orders WHERE id=? AND admin_quote=1 AND status='submitted'
      AND EXISTS(SELECT 1 FROM purchase_order_deletions WHERE order_id=?)`).bind(id,id)
  ]);
  if (!Number(results[1].meta?.changes)) throw new ApiError(409,"Le devis a changé ; rechargez la liste.");
  const discordDone = await finishQuoteDiscordDeletion(env,id);
  return {ok:true,deleted:true,syncPending:true,discordDone};
}

export async function pendingQuoteDeletions(env) {
  const rows = await env.DB.prepare(`SELECT order_id FROM purchase_order_deletions
    WHERE gas_done=0 OR discord_message_id IS NOT NULL ORDER BY deleted_at,order_id LIMIT 20`).all();
  return {deletions:rows.results.map(row=>({id:row.order_id}))};
}

export async function acknowledgeQuoteDeletion(env, id) {
  if (!/^[a-f0-9-]{36}$/i.test(String(id))) throw new ApiError(400,"Identifiant invalide");
  const result=await env.DB.prepare("UPDATE purchase_order_deletions SET gas_done=1 WHERE order_id=?").bind(id).run();
  if (!Number(result.meta?.changes)) throw new ApiError(404,"Suppression introuvable");
  return {ok:true,discordDone:await finishQuoteDiscordDeletion(env,id)};
}
