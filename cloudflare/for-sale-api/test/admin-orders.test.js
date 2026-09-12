import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handlePublicOrderGet, handlePublicOrderAcceptance, handlePublicOrderCancellation, handleAdminDelete, handleAdminGet, handleAdminPost, handleSyncGet, handleSyncPost, refreshMutableOrderDiscounts } from "../src/application.js";
import { editableSheetDraft } from "../src/order-sheet-sync.js";
import { normalizeAdminOrderDraft, normalizeAdminOrderLine } from "../src/orders.js";

class D1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new D1Statement(this.database, this.sql, values);
  }

  first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  execute() {
    return /^\s*(SELECT|WITH)\b/i.test(this.sql) ? this.all() : this.run();
  }
}

function makeD1(database) {
  return {
    prepare(sql) {
      return new D1Statement(database, sql);
    },
    batch(statements) {
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function applyMigration(database, name) {
  database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
}

function setupDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE avatars (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, legacy_sheet_name TEXT NOT NULL);
    CREATE TABLE catalog_items (
      name TEXT PRIMARY KEY COLLATE NOCASE,
      unit_price_ped REAL,
      image TEXT,
      wiki_url TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE catalog_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_name TEXT NOT NULL COLLATE NOCASE REFERENCES catalog_items(name),
      storage TEXT NOT NULL,
      aisle TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE (item_name, storage, aisle)
    );
    CREATE TABLE inventory_current (
      avatar_id TEXT NOT NULL REFERENCES avatars(id),
      row_key TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      source_id TEXT,
      item_name TEXT NOT NULL COLLATE NOCASE,
      quantity REAL NOT NULL,
      value_ped REAL,
      container TEXT,
      container_ref_id TEXT,
      PRIMARY KEY (avatar_id, row_key)
    ) WITHOUT ROWID;
    CREATE TABLE container_config (
      avatar_id TEXT NOT NULL REFERENCES avatars(id),
      container_key TEXT NOT NULL,
      container TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (avatar_id, container_key)
    ) WITHOUT ROWID;
    CREATE VIEW saleable_inventory AS
      SELECT ii.* FROM inventory_current ii
      JOIN container_config cc
        ON cc.avatar_id = ii.avatar_id
       AND cc.container_key = lower(trim(coalesce(ii.container, '')))
        AND cc.enabled = 1;
    CREATE TABLE market_current (
      item_name TEXT PRIMARY KEY COLLATE NOCASE,
      weighted_kind TEXT,
      weighted_value REAL,
      observed_at TEXT
    );
    CREATE TABLE discount_campaigns (
      id TEXT PRIMARY KEY,
      campaign_type TEXT NOT NULL,
      starts_on TEXT NOT NULL,
      ends_on TEXT NOT NULL,
      storage TEXT,
      aisle TEXT,
      discount_rate REAL NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      origin TEXT NOT NULL DEFAULT 'manual',
      eligible_pair_count INTEGER,
      candidate_pair_count INTEGER,
      generation_seed TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  applyMigration(database, "0007_purchase_requests.sql");
  applyMigration(database, "0008_order_discord_notifications.sql");
  applyMigration(database, "0009_order_proposals.sql");
  applyMigration(database, "0016_purchase_order_history.sql");
  applyMigration(database, "0018_purchase_order_tracking_tokens.sql");
  applyMigration(database, "0021_purchase_order_discounts.sql");
  applyMigration(database, "0023_mutable_order_discounts.sql");
  applyMigration(database, "0024_admin_quotes.sql");
  applyMigration(database, "0025_completed_order_lock.sql");
  database.exec(`
    INSERT INTO avatars VALUES ('enzo', 'Enzo', 'Inventaire Enzo');
    INSERT INTO catalog_items (name, unit_price_ped) VALUES ('Item A', 10), ('Item B', 5), ('Sans stock', 2);
    INSERT INTO catalog_listings (item_name, storage, aisle) VALUES
      ('Item A', 'ARMORS', 'PARTS'),
      ('Item B', 'MATERIALS', 'MINERALS'),
      ('Sans stock', 'MATERIALS', 'MINERALS');
    INSERT INTO container_config (avatar_id, container_key, container, enabled)
      VALUES ('enzo', 'carried', 'Carried', 1);
    INSERT INTO inventory_current (avatar_id, row_key, line_no, item_name, quantity, container) VALUES
      ('enzo', 'a', 1, 'Item A', 5, 'Carried'),
      ('enzo', 'b', 2, 'Item B', 3, 'Carried'),
      ('enzo', 'c', 3, 'Sans stock', 0, 'Carried');
    INSERT INTO market_current (item_name, weighted_kind, weighted_value, observed_at) VALUES
      ('Item A', 'percent', 1.2, CURRENT_TIMESTAMP),
      ('Item B', 'ped', 2.5, CURRENT_TIMESTAMP);
  `);
  return database;
}

const lineA = { itemName: "Item A", storage: "ARMORS", aisle: "PARTS", quantity: 2, markupKind: "percent", markupAmount: 110 };
const lineB = { itemName: "Item B", storage: "MATERIALS", aisle: "MINERALS", quantity: 1, markupKind: "ped", markupAmount: 1.25 };

async function sheetFixture() {
  const db = setupDatabase(), env = { DB: makeD1(db), CART_ENABLED: "true" };
  const url = new URL("https://api.example/admin/orders");
  const created = await (await handleAdminPost(new Request(url,{method:"POST",
    body:JSON.stringify({buyerAvatar:"Public",frjMember:false,items:[lineA,lineB]})}),url,env)).json();
  const id = created.order.id;
  const get = async () => (await (await handleSyncGet(new URL("https://api.example/sync/order-edit?id="+id),env)).json()).snapshot;
  const initial = await get();
  const operation = () => ({ orderId:id,operationId:"sheet-"+crypto.randomUUID(),
    baseRevision:initial.editRevision,draft:editableSheetDraft(initial) });
  const send = async payload => {
    const endpoint = new URL("https://api.example/sync/order-edit");
    return (await handleSyncPost(new Request(endpoint,{method:"POST",body:JSON.stringify(payload)}),endpoint,env)).json();
  };
  const items = () => db.prepare("SELECT * FROM purchase_order_items WHERE order_id=? ORDER BY line_no").all(id);
  const writes = () => Number(db.prepare("SELECT total_changes() AS n").get().n);
  return {db,env,id,initial,get,operation,send,items,writes};
}


test("Devis Admin : avatar facultatif uniquement avec profil explicite", () => {
  for (const [frjMember, avatar] of [[false,"Public"],[true,"Membre Soc"]]) {
    const draft = { adminQuote:true,frjMember,items:[lineA] };
    assert.equal(normalizeAdminOrderDraft(draft).buyerAvatar,avatar);
    assert.equal(normalizeAdminOrderDraft({...draft,buyerAvatar:"Mon Avatar"}).buyerAvatar,"Mon Avatar");
    assert.throws(()=>normalizeAdminOrderDraft({...draft,frjMember:undefined}),/profil/i);
    assert.throws(()=>normalizeAdminOrderDraft({...draft,adminQuote:false}),/avatar/i);
    assert.throws(()=>normalizeAdminOrderDraft({...draft,duplicateSourceId:crypto.randomUUID()}),/avatar/i);
  }
});

test("Statuts avancés : conversion Devis Admin refusée par API, Sheets et SQL", async () => {
  for (const status of ["preparing","ready","completed"]) {
    const f = await sheetFixture();
    const url = new URL("https://api.example/admin/orders/"+f.id+"/status");
    const post = next => handleAdminPost(new Request(url,{method:"POST",body:JSON.stringify({status:next})}),url,f.env);
    await post(status);
    assert.equal((await f.get()).status,status);
    assert.ok(f.items().every(item=>item.price_status==="confirmed"));
    await assert.rejects(()=>post("admin_quote"),e=>e.status===409);
    const snapshot=await f.get(), op=f.operation();
    op.baseRevision=snapshot.editRevision;
    op.draft=editableSheetDraft(snapshot);
    op.draft.status="admin_quote";
    await assert.rejects(()=>f.send(op),e=>e.status===409);
    assert.throws(()=>f.db.prepare("UPDATE purchase_orders SET admin_quote=1,status='submitted',approval_required=0 WHERE id=?").run(f.id),/conversion|verrouille/i);
    assert.equal((await f.get()).status,status);
  }
});

test("Terminée : clôture Sheets, idempotence et verrouillage définitif sans bloquer les accusés techniques", async () => {
  const f=await sheetFixture(), close=f.operation();
  close.draft.status="completed";
  assert.equal((await f.send(close)).ok,true);
  assert.equal((await f.send(close)).duplicate,true);
  const snapshot=await f.get();
  assert.equal(snapshot.status,"completed");
  assert.ok(f.items().every(item=>item.price_status==="confirmed"));
  const unchanged={...f.operation(),baseRevision:snapshot.editRevision,draft:editableSheetDraft(snapshot)};
  assert.equal((await f.send(unchanged)).noChange,true);
  for (const field of ["buyerAvatar","buyerContact","buyerComment"]) {
    await assert.rejects(()=>f.send({...unchanged,operationId:"sheet-"+crypto.randomUUID(),draft:{...unchanged.draft,[field]:"Modification"}}),e=>e.status===409);
  }
  const url=new URL("https://api.example/admin/orders/"+f.id+"/status");
  for (const status of ["submitted","viewed","preparing","ready","cancelled","expired","admin_quote"]) {
    await assert.rejects(()=>handleAdminPost(new Request(url,{method:"POST",body:JSON.stringify({status})}),url,f.env),e=>e.status===409);
  }
  for (const sql of [
    "UPDATE purchase_orders SET buyer_avatar='Autre' WHERE id=?",
    "DELETE FROM purchase_orders WHERE id=?",
    "UPDATE purchase_order_items SET quantity=99 WHERE order_id=?",
    "DELETE FROM purchase_order_items WHERE order_id=?",
    "UPDATE purchase_order_events SET comment='Autre' WHERE order_id=?",
    "DELETE FROM purchase_order_events WHERE order_id=?"
  ]) assert.throws(()=>f.db.prepare(sql).run(f.id),/Terminee/);
  assert.doesNotThrow(()=>f.db.prepare("UPDATE purchase_orders SET discord_message_id='technical-receipt' WHERE id=?").run(f.id));
  assert.deepEqual(editableSheetDraft(await f.get()),editableSheetDraft(snapshot));
});

test("Devis Admin : conversion explicite, privé, hors progression et modèle éditable",async()=>{
  const f=await sheetFixture();
  f.db.prepare("UPDATE purchase_orders SET source_backend='d1' WHERE id=?").run(f.id);
  const post=async(path,body)=>{const url=new URL("https://api.example"+path);return (await handleAdminPost(new Request(url,{method:"POST",body:JSON.stringify(body)}),url,f.env)).json();};
  const items=f.items();
  const result=await post("/admin/orders/"+f.id+"/status",{status:"admin_quote"});
  assert.equal(result.status,"admin_quote");
  assert.deepEqual(f.items(),items);
  assert.equal((await f.get()).status,"admin_quote");
  const quote=f.db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(f.id);
  assert.equal(quote.approval_required,0);
  assert.equal(quote.source_backend,"d1");
  for(const status of ["submitted","preparing","completed","cancelled","expired"]) {
    await assert.rejects(()=>post("/admin/orders/"+f.id+"/status",{status}),e=>e.status===409);
  }
  const token="a".repeat(72), hash=createHash("sha256").update(token).digest("hex");
  f.db.prepare("UPDATE purchase_orders SET access_token_hash=? WHERE id=?").run(hash,f.id);
  const alias="b".repeat(72);
  f.db.prepare("INSERT INTO purchase_order_tracking_tokens(token_hash,order_id) VALUES (?,?)").run(createHash("sha256").update(alias).digest("hex"),f.id);
  for(const identifier of [quote.public_reference,token,alias]) {
    const base="https://api.example/orders/status/"+identifier;
    await assert.rejects(()=>handlePublicOrderGet(new URL(base),f.env),e=>e.status===404);
    await assert.rejects(()=>handlePublicOrderCancellation(new URL(base+"/cancel"),f.env),e=>e.status===404);
    await assert.rejects(()=>handlePublicOrderAcceptance(new Request(base+"/accept",{method:"POST",body:JSON.stringify({proposalVersion:1})}),new URL(base+"/accept"),f.env),e=>e.status===404);
  }
  await assert.rejects(()=>post("/admin/orders/"+f.id+"/tracking-link",{}),e=>e.status===404);
  await post("/admin/orders/"+f.id+"/proposal",{items:[{lineNo:1,quantity:1,markupKind:"percent",markupAmount:115}]});
  await post("/admin/orders/"+f.id+"/items/1",{quantity:2,markupKind:"percent",markupAmount:116});
  await handleAdminDelete(new URL("https://api.example/admin/orders/"+f.id+"/items/2"),f.env);
  await post("/admin/orders/"+f.id+"/items",lineB);
  assert.equal((await f.get()).status,"admin_quote");
  assert.equal((await f.get()).approvalRequired,false);
  const before=f.items(); await refreshMutableOrderDiscounts(f.env);
  assert.deepEqual(f.items(),before);
  const report=await (await handleAdminGet(new URL("https://api.example/admin/orders"),f.env)).json();
  assert.equal(report.orders[0].status,"admin_quote");
  const preview=await (await handleAdminGet(new URL("https://api.example/admin/orders/"+f.id+"/duplicate-preview"),f.env)).json();
  assert.equal(preview.source.status,"admin_quote");
  assert.throws(()=>f.db.prepare("UPDATE purchase_orders SET status='ready' WHERE id=?").run(f.id),/Devis Admin/);
});

test("Devis Admin : Sheets convertit, conserve le modèle et le miroir le restitue",async()=>{
  const f=await sheetFixture(), edit=f.operation();
  edit.draft.status="admin_quote";
  const converted=await f.send(edit);
  assert.equal(converted.snapshot.status,"admin_quote");
  assert.equal((await f.send(edit)).duplicate,true);
  const next={...f.operation(),baseRevision:converted.snapshot.editRevision,draft:editableSheetDraft(converted.snapshot)};
  next.draft.buyerAvatar="Avatar quelconque"; next.draft.items[0].quantity=1;
  const updated=await f.send(next);
  assert.equal(updated.snapshot.status,"admin_quote"); assert.equal(updated.snapshot.approvalRequired,false);
  const normal={...f.operation(),baseRevision:updated.snapshot.editRevision,draft:editableSheetDraft(updated.snapshot)};
  normal.draft.status="submitted";
  await assert.rejects(()=>f.send(normal),e=>e.status===409);
  const mirror=await (await handleSyncGet(new URL("https://api.example/sync/orders?afterEventId=0"),f.env)).json();
  assert.equal(mirror.orders.find(o=>o.id===f.id).status,"admin_quote");
});

test("Sheets : entête seule, aucune écriture de ligne ; reprises et absence de changement sans écriture",async () => {
  const f=await sheetFixture(), before=f.items(), noop=f.operation(), zero=f.writes();
  assert.equal((await f.send(noop)).noChange,true);
  assert.equal(f.writes(),zero);
  const edit=f.operation(); edit.draft.buyerAvatar="Avatar corrigé"; edit.draft.buyerContact="contact"; edit.draft.language="EN";
  const result=await f.send(edit);
  assert.equal(result.ok,true); assert.equal(result.snapshot.buyerAvatar,"Avatar corrigé");
  assert.equal(f.writes()-zero,2); // entête + reçu historique ; aucun webhook configuré dans la fixture
  assert.deepEqual(f.items(),before);
  assert.equal(result.snapshot.proposalVersion,f.initial.proposalVersion);
  const settled=f.writes();
  assert.equal((await f.send(edit)).duplicate,true);
  assert.equal(f.writes(),settled);
  edit.draft.buyerAvatar="Autre";
  await assert.rejects(()=>f.send(edit),e=>e.status===409);
});

test("Sheets : version concurrente conservée, même si la date à la seconde est identique",async () => {
  const f=await sheetFixture(), edit=f.operation();
  edit.draft.buyerAvatar="Ancien";
  f.db.prepare("INSERT INTO purchase_order_events(order_id,action) VALUES (?, 'status-changed')").run(f.id);
  const before=f.writes(), result=await f.send(edit);
  assert.equal(result.conflict,true); assert.equal(f.writes(),before);
  assert.equal(result.snapshot.buyerAvatar,"Public");
});

test("Sheets : concurrence entre lecture et transaction n'écrit aucune valeur locale",async () => {
  const f=await sheetFixture(), edit=f.operation(); edit.draft.buyerAvatar="Concurrent";
  const original=f.env.DB.batch;
  let injected=false;
  f.env.DB.batch=statements=>{
    if (!injected && statements[0].sql.includes("INSERT OR IGNORE")) {
      injected=true;
      f.db.prepare("INSERT INTO purchase_order_events(order_id,action) VALUES (?, 'status-changed')").run(f.id);
    }
    return original(statements);
  };
  const before=f.writes(), result=await f.send(edit);
  assert.equal(result.conflict,true);
  assert.equal(f.writes()-before,1); // seulement l'événement concurrent simulé
  assert.equal(result.snapshot.buyerAvatar,"Public");
});

test("Sheets : deux transactions portant le même reçu ne réappliquent pas la proposition",async () => {
  const f=await sheetFixture(), edit=f.operation(); edit.draft.items[0].quantity=3;
  const original=f.env.DB.batch;
  let injected=false;
  f.env.DB.batch=statements=>{
    if (!injected && statements[0].sql.includes("INSERT OR IGNORE")) {
      injected=true;
      const details=JSON.parse(statements[0].values[2]); details.attempt="concurrent-attempt";
      f.db.prepare("INSERT INTO purchase_order_events(order_id,action,event_key,details) VALUES (?, 'sheet-order-edited',?,?)")
        .run(f.id,edit.operationId,JSON.stringify(details));
    }
    return original(statements);
  };
  const before=f.writes(), result=await f.send(edit);
  assert.equal(result.conflict,true);
  assert.equal(f.writes()-before,1);
  assert.equal(result.snapshot.items[0].quantity,2);
});

test("Sheets : une seule ligne modifiée, totaux recalculés et nouvelle validation client",async () => {
  const f=await sheetFixture(), before=f.items(), edit=f.operation(), zero=f.writes();
  edit.draft.items[0].quantity=3;
  const result=await f.send(edit);
  assert.equal(result.ok,true); assert.equal(f.writes()-zero,3);
  assert.deepEqual(f.items()[1],before[1]);
  assert.equal(result.snapshot.totalTtPed,35); assert.equal(result.snapshot.totalSalePed,39.25);
  assert.equal(result.snapshot.status,"awaiting_approval");
  assert.equal(result.snapshot.proposalVersion,f.initial.proposalVersion+1);
});

test("Sheets : profils et MU auto suivent les marges, sans cumuler la réduction FRJ",async () => {
  const f=await sheetFixture(), edit=f.operation();
  edit.draft.frjMember=true;
  const member=await f.send(edit);
  assert.equal(member.snapshot.items[0].markupValue,1.05);
  assert.equal(member.snapshot.items[1].markupValue,0.625);
  const back={...f.operation(),baseRevision:member.snapshot.editRevision,draft:editableSheetDraft(member.snapshot)};
  back.draft.frjMember=false; back.draft.items[0].markupKind="auto"; back.draft.items[0].markupAmount=null;
  const publicOrder=await f.send(back);
  assert.equal(publicOrder.snapshot.items[0].markupValue,1.2);
  assert.equal(publicOrder.snapshot.items[1].markupValue,1.25);
});

test("Sheets : articles retirés, quantités invalides et confirmation séparée",async () => {
  const f=await sheetFixture(), invalid=f.operation(), before=f.writes();
  invalid.draft.items[0].quantity=99;
  await assert.rejects(()=>f.send(invalid),e=>e.status===400);
  assert.equal(f.writes(),before);
  invalid.draft.items[0].quantity=3; invalid.draft.status="ready";
  await assert.rejects(()=>f.send(invalid),e=>e.status===400);
  const remove=f.operation(); remove.draft.items.pop();
  const result=await f.send(remove); assert.equal(result.snapshot.items.length,1);
  assert.equal(result.snapshot.totalSalePed,22);
  const confirm={...f.operation(),baseRevision:result.snapshot.editRevision,draft:editableSheetDraft(result.snapshot)};
  f.db.exec("UPDATE inventory_current SET quantity=0; UPDATE catalog_items SET unit_price_ped=999");
  confirm.draft.status="preparing";
  const confirmed=await f.send(confirm);
  assert.equal(confirmed.snapshot.pricingStatus,"confirmed");
  assert.equal(confirmed.snapshot.items[0].unitTtPed,10);
  const frozen={...f.operation(),baseRevision:confirmed.snapshot.editRevision,draft:editableSheetDraft(confirmed.snapshot)};
  frozen.draft.items[0].quantity=1;
  await assert.rejects(()=>f.send(frozen),e=>e.status===409);
  frozen.draft=editableSheetDraft(confirmed.snapshot); frozen.draft.buyerAvatar="Correction tardive";
  assert.equal((await f.send(frozen)).snapshot.buyerAvatar,"Correction tardive");
});

test("T-018 copie indépendante, contact et contrôle du catalogue sans écriture du modèle", async () => {
  const database = setupDatabase();
  const env = { DB: makeD1(database), CART_ENABLED: "true" };
  const url = new URL("https://api.example/admin/orders");
  const create = async payload => (await handleAdminPost(new Request(url, {
    method: "POST", body: JSON.stringify(payload)
  }), url, env)).json();
  const model = await create({ buyerAvatar: "Autre avatar", adminQuote: true, frjMember: true, items: [lineA] });
  const before = database.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(model.order.id);
  const oldItems = database.prepare("SELECT * FROM purchase_order_items WHERE order_id = ?").all(model.order.id);
  const previewUrl = new URL(`https://api.example/admin/orders/${model.order.id}/duplicate-preview`);
  const preview = await (await handleAdminGet(previewUrl, env)).json();
  assert.equal(preview.source.id, model.order.id);
  assert.equal(preview.source.accessTokenHash, undefined);
  assert.deepEqual(database.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(model.order.id), before);
  const snapshot = preview.catalog.items.find(item => item.itemName === lineA.itemName);
  assert.equal(model.order.status,"admin_quote");
  assert.equal(model.trackingPath,undefined);
  assert.equal(model.accessToken,undefined);
  const payload = { buyerAvatar: "Client", buyerContact: " Discord : client ", frjMember: false, adminQuote:true,
    duplicateSourceId: model.order.id, items: [{ ...lineA, markupAmount: 120, catalogSnapshot: snapshot }] };
  const result = await create(payload);
  assert.notEqual(result.order.id, model.order.id);
  assert.notEqual(result.order.publicReference, model.order.publicReference);
  assert.equal(result.order.status, "awaiting_approval");
  assert.equal(result.order.proposalVersion, 1);
  assert.equal(database.prepare("SELECT buyer_contact FROM purchase_orders WHERE id = ?").get(result.order.id).buyer_contact, "Discord : client");
  assert.deepEqual(database.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(model.order.id), before);
  assert.deepEqual(database.prepare("SELECT * FROM purchase_order_items WHERE order_id = ?").all(model.order.id), oldItems);
  for (const field of ["unitTtPed", "markupValue", "discountRate", "discountCampaignId"]) {
    const stale = structuredClone(payload);
    stale.items[0].catalogSnapshot[field] = "outdated";
    await assert.rejects(() => create(stale), error => error.status === 409);
  }
  await assert.rejects(() => create({ ...payload, items: [{ ...payload.items[0], quantity: 99 }] }),
    error => error.status === 409);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM purchase_orders").get().n, 2);
  await assert.rejects(() => create({ ...payload, duplicateSourceId: result.order.id }),
    error => error.status === 400);
  await assert.rejects(() => handleAdminGet(new URL(`https://api.example/admin/orders/${result.order.id}/duplicate-preview`), env),
    error => error.status === 400);
});

test("d.12 valide les saisies directes et limite la MU à deux décimales", () => {
  assert.equal(normalizeAdminOrderDraft({ buyerAvatar: " Enzo ", frjMember: true, items: [lineA] }).buyerAvatar, "Enzo");
  assert.throws(() => normalizeAdminOrderLine({ ...lineA, markupAmount: 1.234 }), /2 décimales/);
  assert.throws(() => normalizeAdminOrderLine({ ...lineA, markupKind: "none" }), /Type de MU/);
  assert.throws(() => normalizeAdminOrderDraft({ buyerAvatar: "Enzo", items: [lineA, lineA] }), /une seule fois/);
});

test("d.12 expose seulement les listings possédant un stock vendable", async () => {
  const database = setupDatabase();
  const response = await handleAdminGet(new URL("https://api.example/admin/orders/catalog"), { DB: makeD1(database) });
  const result = await response.json();
  assert.deepEqual(result.items.map((item) => item.itemName), ["Item A", "Item B"]);
  assert.equal(result.items[0].availableStock, 5);
  assert.deepEqual(
    result.items.map(({ markupKind, markupValue }) => ({ markupKind, markupValue })),
    [
      { markupKind: "percent", markupValue: 1.2 },
      { markupKind: "ped", markupValue: 2.5 }
    ]
  );
});

test("T-006 expose la remise active et la demande directe conserve sa MU remisée", async () => {
  const database = setupDatabase();
  database.exec(`
    INSERT INTO discount_campaigns (
      id, campaign_type, starts_on, ends_on, storage, aisle, discount_rate, enabled
    ) VALUES (
      'promo-active', 'daily_promo', date('now'), date('now'), 'ARMORS', 'PARTS', 0.10, 1
    )
  `);
  const env = { DB: makeD1(database), CART_ENABLED: "true" };
  const catalog = await (await handleAdminGet(new URL("https://api.example/admin/orders/catalog"), env)).json();
  const item = catalog.items.find((entry) => entry.itemName === "Item A");
  assert.equal(item.discountKind, "daily_promo");
  assert.equal(item.discountCampaignId, "promo-active");
  assert.equal(item.discountRate, 0.1);

  const url = new URL("https://api.example/admin/orders");
  const created = await (await handleAdminPost(new Request(url, {
    method: "POST",
    body: JSON.stringify({
      buyerAvatar: "Promo Buyer",
      frjMember: false,
      items: [{ ...lineA, markupAmount: 118 }]
    })
  }), url, env)).json();
  assert.equal(created.order.items[0].markupValue, 1.18);
  assert.equal(created.order.items[0].baseMarkupValue, 1.2);
  assert.equal(created.order.items[0].discountRate, 0.1);
});

test("T-007 actualise les remises des demandes modifiables puis les fige à préparer", async () => {
  const database = setupDatabase();
  const env = { DB: makeD1(database), CART_ENABLED: "true" };
  const url = new URL("https://api.example/admin/orders");
  const created = await (await handleAdminPost(new Request(url, {
    method: "POST",
    body: JSON.stringify({ buyerAvatar: "Mutable Buyer", frjMember: false, items: [{ ...lineA, markupAmount: 120 }] })
  }), url, env)).json();
  database.exec(`
    INSERT INTO discount_campaigns (
      id, campaign_type, starts_on, ends_on, storage, aisle, discount_rate, enabled
    ) VALUES (
      'promo-refresh', 'daily_promo', date('now'), date('now'), 'ARMORS', 'PARTS', 0.25, 1
    )
  `);
  assert.deepEqual(await refreshMutableOrderDiscounts(env), [created.order.id]);
  let line = database.prepare(`SELECT markup_value, discount_kind, discount_rate FROM purchase_order_items`).get();
  assert.equal(line.markup_value, 1.15);
  assert.equal(line.discount_kind, "daily_promo");
  assert.equal(line.discount_rate, 0.25);
  assert.equal(database.prepare(`SELECT proposal_version FROM purchase_orders`).get().proposal_version, 2);

  database.prepare(`UPDATE purchase_orders SET status = 'preparing', approval_required = 0 WHERE id = ?`).run(created.order.id);
  database.exec(`UPDATE discount_campaigns SET discount_rate = 0.5 WHERE id = 'promo-refresh'`);
  assert.deepEqual(await refreshMutableOrderDiscounts(env), []);
  line = database.prepare(`SELECT markup_value, discount_rate FROM purchase_order_items`).get();
  assert.equal(line.markup_value, 1.15);
  assert.equal(line.discount_rate, 0.25);
});

test("d.12 crée atomiquement une demande directe à valider et son lien par référence", async () => {
  const database = setupDatabase();
  const env = { DB: makeD1(database), CART_ENABLED: "true" };
  const url = new URL("https://api.example/admin/orders");
  const response = await handleAdminPost(new Request(url, {
    method: "POST",
    body: JSON.stringify({ buyerAvatar: "Direct Buyer", frjMember: true, items: [lineA, lineB] })
  }), url, env);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.match(result.order.publicReference, /^FRJ-\d{8}-[A-F0-9]{6}$/);
  assert.equal(result.order.status, "awaiting_approval");
  assert.equal(result.order.proposalVersion, 1);
  assert.equal(result.order.totalSalePed, 28.25);
  assert.match(result.accessToken, /^[a-f0-9-]{70,80}$/i);
  assert.equal(result.trackingPath, `suivi-commande.html?ref=${result.order.publicReference}`);

  const stored = database.prepare(`SELECT * FROM purchase_orders`).get();
  assert.equal(stored.source_backend, "d1-admin");
  assert.equal(stored.status, "submitted");
  assert.equal(stored.approval_required, 1);
  assert.equal(stored.proposal_version, 1);
  assert.equal(stored.access_token_hash, createHash("sha256").update(result.accessToken).digest("hex"));
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM purchase_order_items`).get().count, 2);
  const history = database.prepare(`SELECT action, actor FROM purchase_order_events WHERE action = 'admin-created'`).get();
  assert.equal(history.action, "admin-created");
  assert.equal(history.actor, "admin");
});

test("d.12 ajoute une ligne, recalcule la proposition et refuse les doublons", async () => {
  const database = setupDatabase();
  const env = { DB: makeD1(database), CART_ENABLED: "true" };
  const createUrl = new URL("https://api.example/admin/orders");
  const created = await (await handleAdminPost(new Request(createUrl, {
    method: "POST",
    body: JSON.stringify({ buyerAvatar: "Direct Buyer", frjMember: false, items: [lineA] })
  }), createUrl, env)).json();
  const addUrl = new URL(`https://api.example/admin/orders/${created.order.id}/items`);
  const response = await handleAdminPost(new Request(addUrl, {
    method: "POST",
    body: JSON.stringify(lineB)
  }), addUrl, env);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.proposalVersion, 2);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM purchase_order_items`).get().count, 2);
  const stored = database.prepare(`SELECT total_sale_ped, approval_required, proposal_version FROM purchase_orders`).get();
  assert.equal(stored.total_sale_ped, 28.25);
  assert.equal(stored.approval_required, 1);
  assert.equal(stored.proposal_version, 2);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM purchase_order_events WHERE action = 'proposal-line-added'`).get().count, 1);

  await assert.rejects(
    () => handleAdminPost(new Request(addUrl, { method: "POST", body: JSON.stringify(lineB) }), addUrl, env),
    (error) => error.status === 409 && /déjà présent/.test(error.message)
  );
});

test("T-010 supprime une ligne modifiable et recalcule la proposition", async () => {
  const database = setupDatabase();
  const env = { DB: makeD1(database), CART_ENABLED: "true" };
  const createUrl = new URL("https://api.example/admin/orders");
  const created = await (await handleAdminPost(new Request(createUrl, {
    method: "POST",
    body: JSON.stringify({ buyerAvatar: "Direct Buyer", frjMember: false, items: [lineA, lineB] })
  }), createUrl, env)).json();
  const deleteUrl = new URL(`https://api.example/admin/orders/${created.order.id}/items/2`);
  const response = await handleAdminDelete(deleteUrl, env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.proposalVersion, 2);
  assert.equal(result.removedLineNo, 2);

  const stored = database.prepare(`
    SELECT total_tt_ped, total_sale_ped, approval_required, proposal_version
    FROM purchase_orders
  `).get();
  assert.equal(stored.total_tt_ped, 20);
  assert.equal(stored.total_sale_ped, 22);
  assert.equal(stored.approval_required, 1);
  assert.equal(stored.proposal_version, 2);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM purchase_order_items`).get().count, 1);
  const history = database.prepare(`
    SELECT details FROM purchase_order_events WHERE action = 'proposal-line-removed'
  `).get();
  assert.deepEqual(JSON.parse(history.details), {
    lineNo: 2,
    itemName: "Item B",
    proposalVersion: 2
  });
  assert.equal(database.prepare(`
    SELECT comment FROM purchase_order_events WHERE action = 'proposal-line-removed'
  `).get().comment, "Article « Item B » supprimé par l’administrateur.");

  const lastDeleteUrl = new URL(`https://api.example/admin/orders/${created.order.id}/items/1`);
  await assert.rejects(
    () => handleAdminDelete(lastDeleteUrl, env),
    (error) => error.status === 409 && /dernière ligne/.test(error.message)
  );
  database.prepare(`
    UPDATE purchase_orders SET status = 'preparing', approval_required = 0 WHERE id = ?
  `).run(created.order.id);
  await assert.rejects(
    () => handleAdminDelete(lastDeleteUrl, env),
    (error) => error.status === 409 && /À valider, Transmises ou Vues/.test(error.message)
  );
});
