import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";

const headers=["ORDER_ID","REFERENCE","AVATAR_ACHETEUR","CONTACT","COMMENTAIRE","LANGUE","MEMBRE_FRJ","STATUT",
  "TOTAL_TT_PED","TOTAL_VENTE_PED","PRIX_STATUT","DATE_CLIENT","DATE_RECEPTION","SYNC_PAYLOAD_JSON","SYNCED_D1_AT",
  "SYNC_ERROR","DISCORD_MESSAGE_ID","DISCORD_ERROR","APPROVAL_REQUIRED","PROPOSAL_VERSION","EDITION_JSON","EDITION_ERREUR","D1_CONFLIT_JSON","ACTION_EDITION"];
const snapshot={id:"11111111-1111-4111-8111-111111111111",publicReference:"FRJ-20260912-111111",
  buyerAvatar:"Public",buyerContact:"",buyerComment:"",language:"FR",frjMember:false,status:"submitted",
  editRevision:4,totalTtPed:10,totalSalePed:12,pricingStatus:"estimated",proposalVersion:0,
  items:[{lineNo:1,itemName:"Article",storage:"ARMORS",aisle:"PARTS",quantity:1,
    markupKind:"percent",markupValue:1.2,unitTtPed:10,lineTtPed:10,lineSalePed:12}]};
test("GAS : le miroir conserve pourcentages, zéros et texte sans exécuter de formule",()=>{
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL("../gas/PurchaseOrders.gs",import.meta.url),"utf8"),context);
  let formatted=false, written;
  const sheet={getMaxRows:()=>100,getRange:(row,col,rows,cols)=>({
    setNumberFormat(format){assert.equal(col,3);assert.equal(cols,4);assert.equal(format,"@");formatted=true;},
    setValues(values){assert.ok(formatted);written=values[0];}
  })};
  const input=["id","ref","00123","=1+1","101%","FR"];
  context.purchaseWriteOrderRow_(sheet,2,input);
  assert.equal(written[2],"00123");assert.equal(written[3],"'=1+1");assert.equal(written[4],"101%");
  assert.equal(input[3],"=1+1");
});
function fixture() {
  let calls=0;
  const context=vm.createContext({Utilities:{getUuid:randomUUID},
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>key==="FRJ_ADMIN_QUOTES_VERSION"?"1":"20260912-2"})},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}});
  vm.runInContext(fs.readFileSync(new URL("../gas/OrderEditing.gs",import.meta.url),"utf8"),context);
  const indexes=context.frjOrderIndexes_(headers), row=Array(headers.length).fill("");
  Object.assign(row,{[indexes.ORDER_ID]:snapshot.id,[indexes.REFERENCE]:snapshot.publicReference,
    [indexes.AVATAR_ACHETEUR]:"Public",[indexes.LANGUE]:"FR",[indexes.MEMBRE_FRJ]:"FALSE",
    [indexes.STATUT]:"submitted",[indexes.SYNCED_D1_AT]:"2026-09-12",
    [indexes.SYNC_PAYLOAD_JSON]:JSON.stringify({order:snapshot,items:snapshot.items}),
    [indexes.TOTAL_TT_PED]:10,[indexes.TOTAL_VENTE_PED]:12,[indexes.PRIX_STATUT]:"estimated",
    [indexes.PROPOSAL_VERSION]:0,[indexes.APPROVAL_REQUIRED]:"FALSE"});
  const state={values:[headers,row],indexes,lines:context.frjOrderLineRows_(snapshot),
    sheet:{getRange:(at,col)=>({
      setValue(value){state.values[at-1][col-1]=value;calls++;},
      clearContent(){state.values[at-1][col-1]="";calls++;}
    })}};
  context.frjOrderSheetState_=()=>state;
  return {context,state,row,indexes,calls:()=>calls};
}
test("GAS : historique rattaché à sa demande et replay de réparation unique",()=>{
  const properties=new Map(), seen=[];
  const withFrjDataLock_=callback=>callback();
  const context=vm.createContext({
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k),setProperty:(k,v)=>properties.set(k,v)})},
    frjD1Request_:path=>{seen.push(path);return {cursor:10,hasMore:false,orders:[{id:snapshot.id,historyEvents:[{eventKey:"d1-10"}]}]};},
    withFrjDataLock_,upsertPurchaseOrderMirror_:()=>{},upsertPurchaseOrderHistoryMirror_:events=>assert.equal(events[0].orderId,snapshot.id)
  });
  vm.runInContext(fs.readFileSync(new URL("../gas/SyncOrders.gs",import.meta.url),"utf8"),context);
  properties.set("FRJ_D1_ORDERS_EVENT_CURSOR","500");
  context.frjPullPurchaseOrdersFromD1_();context.frjPullPurchaseOrdersFromD1_();
  assert.deepEqual(seen,["/sync/orders?afterEventId=0","/sync/orders?afterEventId=10"]);
});

test("GAS : l'accusé d'un commentaire conserve le lien de l'événement",()=>{
  let saved;
  const context=vm.createContext({upsertPurchaseOrderHistoryMirror_:(events,force)=>{saved=events;assert.equal(force,true);}});
  vm.runInContext(fs.readFileSync(new URL("../gas/OrderHistory.gs",import.meta.url),"utf8"),context);
  context.upsertPurchaseOrderHistoryMirror_=(events,force)=>{saved=events;assert.equal(force,true);};
  const pending={sheet:{getRange:()=>({getValue:()=>"Commentaire corrigé"})},indexes:{COMMENTAIRE:5},
    entries:[{rowNumber:2,event:{eventKey:"event-1",orderId:snapshot.id,comment:"Commentaire corrigé"}}]};
  assert.equal(context.purchaseMarkHistorySyncResult_(pending,[{eventKey:"event-1",ok:true,event:{eventKey:"event-1",comment:"Commentaire corrigé"}}]),1);
  assert.equal(saved[0].orderId,snapshot.id);
});

test("Sheets GAS : aucune écriture ni requête D1 sans changement",()=>{
  const f=fixture();
  assert.equal(f.context.frjSyncEditableOrders_(),0);
  assert.equal(f.calls(),0);
});
test("Sheets GAS : capture d'un nom et reprise réseau avec le même identifiant",()=>{
  const f=fixture(), sent=[];
  f.row[f.indexes.AVATAR_ACHETEUR]="Nom corrigé";
  f.context.frjD1Request_=(_path,options)=>{sent.push(JSON.parse(options.payload));throw new Error("réseau");};
  f.context.frjSyncEditableOrders_(); f.context.frjSyncEditableOrders_();
  assert.equal(sent.length,2);
  assert.equal(sent[0].operationId,sent[1].operationId);
  assert.equal(sent[0].draft.buyerAvatar,"Nom corrigé");
  assert.equal(sent[0].draft.items[0].markupAmount,120);
  assert.equal(sent[0].baseRevision,4);
  assert.equal(JSON.parse(f.row[f.indexes.SYNC_PAYLOAD_JSON]).order.buyerAvatar,"Public");
});
test("Sheets GAS : le miroir conserve la saisie locale et signale la concurrence",()=>{
  const f=fixture();
  f.row[f.indexes.CONTACT]="Nouveau contact";
  f.context.frjScanOrderEdits_(f.state);
  assert.equal(f.context.frjPreserveLocalOrderEdit_(f.row,f.indexes,{...snapshot,editRevision:5},f.state.sheet,2),true);
  assert.equal(f.row[f.indexes.CONTACT],"Nouveau contact");
  assert.match(f.row[f.indexes.EDITION_ERREUR],/conservées/);
  assert.equal(f.context.frjScanOrderEdits_(f.state).length,0);
});
test("Sheets GAS : un secours fraîchement transmis ne devient pas une suppression des lignes",()=>{
  const f=fixture();
  f.row[f.indexes.SYNC_PAYLOAD_JSON]=JSON.stringify({order:{...snapshot,editRevision:undefined,sourceBackend:"gas-fallback"},items:snapshot.items});
  f.state.lines=[];
  assert.equal(f.context.frjScanOrderEdits_(f.state).length,0);
  assert.equal(f.context.frjPreserveLocalOrderEdit_(f.row,f.indexes,snapshot,f.state.sheet,2),false);
});
test("Sheets GAS : saisie pendant l'envoi conservée, jamais écrasée par l'accusé",()=>{
  const f=fixture();
  f.row[f.indexes.CONTACT]="Premier";
  f.context.frjD1Request_=()=>{f.row[f.indexes.CONTACT]="Deuxième";return {ok:true,snapshot};};
  f.context.upsertPurchaseOrderMirror_=()=>assert.fail("La nouvelle saisie serait perdue");
  assert.equal(f.context.frjSyncEditableOrders_(),0);
  assert.equal(f.row[f.indexes.CONTACT],"Deuxième");
});
test("Sheets GAS : retrait explicite, décimales françaises et totaux techniques restaurés",()=>{
  const f=fixture();
  f.state.lines[0][7]="121,25"; f.row[f.indexes.TOTAL_VENTE_PED]=999;
  let pending=f.context.frjScanOrderEdits_(f.state);
  assert.equal(pending[0].payload.draft.items[0].markupAmount,121.25);
  assert.equal(f.row[f.indexes.TOTAL_VENTE_PED],12);
  f.state.lines[0][8]=true;
  pending=f.context.frjScanOrderEdits_(f.state);
  assert.equal(pending[0].payload.draft.items.length,0); // le serveur refuse une demande vide
});
test("Sheets GAS autonome : actions de résolution sans getUi ni spreadsheet actif",()=>{
  const f=fixture();
  f.row[f.indexes.MEMBRE_FRJ]="invalide";
  f.row[f.indexes.ACTION_EDITION]="RECHARGER D1 (ABANDON LOCAL)";
  f.context.frjD1Request_=()=>({snapshot});
  let forced=0;
  f.context.upsertPurchaseOrderMirror_=(value,force)=>{assert.equal(value.id,snapshot.id);assert.equal(force,true);forced++;};
  f.context.frjProcessOrderActions_();
  assert.equal(forced,1); assert.equal(f.row[f.indexes.ACTION_EDITION],"");
  f.row[f.indexes.MEMBRE_FRJ]="FALSE"; f.row[f.indexes.CONTACT]="Local";
  f.row[f.indexes.ACTION_EDITION]="REAPPLIQUER SHEETS SUR D1";
  f.context.frjD1Request_=()=>({snapshot:{...snapshot,editRevision:8}});
  f.context.frjProcessOrderActions_();
  const operation=JSON.parse(f.row[f.indexes.EDITION_JSON]);
  assert.equal(operation.baseRevision,8);assert.equal(operation.draft.buyerContact,"Local");
  assert.doesNotMatch(fs.readFileSync(new URL("../gas/OrderEditing.gs",import.meta.url),"utf8"),/getUi\(|getActiveSpreadsheet\(/);
});
