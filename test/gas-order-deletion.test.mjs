import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const id="11111111-1111-4111-8111-111111111111";
const other="22222222-2222-4222-8222-222222222222";
function fixture() {
  const props=new Map(), sheets=new Map(), calls=[];
  for(const name of ["COMMANDES_APP","COMMANDES_LIGNES","COMMANDES_HISTORIQUE"]) {
    const rows=[["DATA","ORDER_ID"],["target",id],["copy",other],["target again",id]];
    sheets.set(name,{rows,getLastRow:()=>rows.length,getDataRange:()=>({getValues:()=>rows.map(r=>r.slice())}),deleteRow:n=>rows.splice(n-1,1)});
  }
  let failAck=false,locked=false;
  const context=vm.createContext({
    FRJ_SYNC_CONFIG:{appSpreadsheetId:"test"},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k),setProperty:(k,v)=>props.set(k,v)})},
    SpreadsheetApp:{openById:()=>({getSheetByName:n=>sheets.get(n)}),flush:()=>{}},
    withFrjDataLock_:callback=>{assert.equal(locked,false);locked=true;try{return callback();}finally{locked=false;}},
    frjD1Request_:(path,options)=>{
      assert.equal(locked,true);calls.push(path);
      if(path.endsWith("/ack")) {if(failAck)throw Error("réseau");return {ok:true};}
      return {deletions:[{id}]};
    }
  });
  vm.runInContext(fs.readFileSync(new URL("../gas/OrderDeletion.gs",import.meta.url),"utf8"),context);
  return {context,sheets,props,calls,setFail:v=>{failAck=v}};
}
test("GAS suppression ciblée : trois feuilles, copies et en-têtes préservés, reprise après perte d'accusé",()=>{
  const f=fixture();
  f.setFail(true);
  assert.throws(()=>f.context.frjProcessPendingQuoteDeletions_(),/réseau/);
  for(const sheet of f.sheets.values())assert.deepEqual(sheet.rows,[["DATA","ORDER_ID"],["copy",other]]);
  assert.equal(f.context.frjOrderWasDeleted_(id),true);
  assert.equal(f.context.frjOrderWasDeleted_(other),false);
  f.setFail(false);
  assert.equal(f.context.frjProcessPendingQuoteDeletions_(),1);
  for(const sheet of f.sheets.values())assert.equal(sheet.rows.length,2);
});
test("GAS suppression : une feuille sans clé interrompt avant toute suppression",()=>{
  const f=fixture();
  f.sheets.get("COMMANDES_LIGNES").rows[0][1]="INCONNU";
  assert.throws(()=>f.context.frjProcessPendingQuoteDeletions_(),/ORDER_ID/);
  for(const sheet of f.sheets.values())assert.equal(sheet.rows.length,4);
  assert.equal(f.context.frjOrderWasDeleted_(id),false);
});
test("GAS : un ancien miroir du devis ou de son historique ne le recrée pas",()=>{
  const f=fixture();
  f.context.frjProcessPendingQuoteDeletions_();
  vm.runInContext(fs.readFileSync(new URL("../gas/PurchaseOrders.gs",import.meta.url),"utf8"),f.context);
  vm.runInContext(fs.readFileSync(new URL("../gas/OrderHistory.gs",import.meta.url),"utf8"),f.context);
  assert.equal(f.context.upsertPurchaseOrderMirror_({id,items:[]}),0);
  assert.equal(f.context.upsertPurchaseOrderHistoryMirror_([{orderId:id}]),0);
});
