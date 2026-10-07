import test from "node:test";

test("T-027 un miroir historique arrondi seul ne devient pas une édition automatique",()=>{
 vm.runInContext(read("../gas/OrderEditing.gs"),gas);
 const baseline={items:[{markupAmount:115.123456789}]}, legacy={items:[{markupAmount:115.123457}]};
 assert.equal(gas.frjOrderUnchangedPrecision_(legacy,baseline,{createdAt:"2026-09-20T12:00:00Z"}),true);
 assert.equal(gas.frjOrderUnchangedPrecision_({...legacy,buyerAvatar:"Changed"},baseline,{createdAt:"2026-09-20T12:00:00Z"}),false);
 assert.equal(gas.frjOrderUnchangedPrecision_(legacy,baseline,{createdAt:"2026-10-08T12:00:00Z"}),false);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {pedMath} from "../cloudflare/for-sale-api/src/ped-math.js";
import {priceOrderLine,priceOrderLines,reviseOrderLine,normalizeAdminOrderLine,formatMarkup} from "../cloudflare/for-sale-api/src/orders.js";
import {editableSheetDraft} from "../cloudflare/for-sale-api/src/order-sheet-sync.js";
const gas=vm.createContext({});
const uiContext=vm.createContext({window:{}});
const read=p=>fs.readFileSync(new URL(p,import.meta.url),"utf8").replace(/\r\n/g,"\n");
vm.runInContext(read("../gas/PurchaseOrders.gs"),gas);
vm.runInContext(read("../js/common/order-ui.js"),uiContext);
const ui=uiContext.window.FRJ_ORDER_UI;
test("T-027 même noyau décimal dans navigateur, GAS et D1",()=>{
 const core=read("../cloudflare/for-sale-api/src/ped-math.js").split("\nexport const")[0].trim();
 assert.ok(read("../gas/PurchaseOrders.gs").startsWith(core));
 assert.ok(read("../js/common/order-ui.js").startsWith(core));
});
test("T-027 prix unitaires variables, zéros inutiles, FR/EN et notation scientifique",()=>{
 for(const [v,expected] of [[0.024,"0.024"],[2,"2.00"],[1.2,"1.20"],["0.024000","0.024"],[1e-25,"0."+ "0".repeat(24)+"1"],[1e21,"1000000000000000000000.00"]]){
  assert.equal(ui.formatUnitPed(v,"EN"),expected);
  assert.equal(ui.formatUnitPed(v,"FR"),expected.replace(".",","));
 }
 assert.equal(ui.formatPed(0.024,"FR"),"0,02");
 assert.equal(ui.formatPed(1.005,"EN"),"1.01");
});
test("T-027 2100 câbles à 0.024 PED, reprise et MU très précis",()=>{
 for(const math of [pedMath,gas.FRJ_PED_MATH,ui.math]){
  const price=math.price(0.024,2100,"none",null);
  assert.equal(price.lineTtPed,50.4);assert.equal(price.lineSalePed,50.4);
  assert.equal(math.price(0.024,2100,"percent",1.23456789).lineSalePed,62.222221656);
  assert.equal(math.price(0.024,2100,"ped",0.000000123).unitSalePed,0.024000123);
 }
 const row={itemName:"Robot Low Loss Link Cable",storage:"MATERIALS",aisle:"ROBOT",stock:2100,unitTtPed:0.024,markupKind:"none",markupValue:null};
 const request={...row,quantity:2100,observedUnitTtPed:0.024,observedMarkupKind:"none",observedMarkupValue:null,observedDiscountKind:null,observedDiscountCampaignId:null,observedDiscountRate:null};
 const result=priceOrderLines([request],[row]);
 assert.equal(result.lines[0].unitTtPed,0.024);
 assert.equal(result.totalTtPed,50.4);
 const restored=JSON.parse(JSON.stringify(result.lines[0]));
 assert.equal(reviseOrderLine(restored,{quantity:2100,markupKind:"none"},2100).lineSalePed,50.4);
});
test("T-027 addition sans arrondi de chaque ligne et profils/promotion identiques",()=>{
 assert.equal(pedMath.round(pedMath.sum([priceOrderLine(0.024,1,"none",null).lineTtPed,priceOrderLine(0.024,1,"none",null).lineTtPed])),0.05);
 for(const member of [false,true])for(const kind of ["ped","percent"]){
  const v=kind==="ped"?0.000123456789:1.15123456789;
  const expected=pedMath.markup(kind,v,member,0.05);
  assert.deepEqual(JSON.parse(JSON.stringify(gas.FRJ_PED_MATH.markup(kind,v,member,0.05))),expected);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.math.markup(kind,v,member,0.05))),expected);
 }
 assert.equal(pedMath.add(0.1,0.2),0.3);
 assert.equal(pedMath.multiply(1.005,100),100.5);
 assert.throws(()=>pedMath.price(Infinity,1,"none",null),/non fini/);
});
test("T-027 saisie et synchronisation ne plafonnent plus les décimales du MU",()=>{
 const line={itemName:"Cable",storage:"MATERIALS",aisle:"ROBOT",quantity:1,markupKind:"ped",markupAmount:0.000000123};
 assert.equal(normalizeAdminOrderLine(line).markupAmount,0.000000123);
 assert.equal(editableSheetDraft({items:[{...line,markupValue:0.000000123}]}).items[0].markupAmount,0.000000123);
 assert.equal(formatMarkup("ped",0.000000123),"0,000000123 PED");
 assert.equal(formatMarkup("percent",1.15123456789),"115,123456789 %");
});

