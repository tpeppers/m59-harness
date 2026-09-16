// Offline reserve, trade-quantity and interrupted-market regression tests.
import assert from 'node:assert/strict';
import { normalise, saleAllowance } from './m59-loadout.mjs';
import { inventorySalePlan, sellAll } from './m59-skills.mjs';
import { FLEET_KEEP, MARKET_KEEP } from './m59-items.mjs';
import { Autopilot, MARKET_STOPS, townDestinations } from './m59-autopilot.mjs';
import { Session } from './m59-game.mjs';

const loadout=normalise({character:'Fixture',carry:[{item:'herb',min:12,max:40},
  {item:'elderberry',min:12,max:40},{item:'sapphire',min:24,max:100}]}).loadout;
assert.ok(loadout);
const c={inventory:[{id:1,nameRsc:1,amount:41},{id:2,nameRsc:2,amount:224}],
  rsc:new Map([[1,'herbs'],[2,'elderberry']]),using:new Set(),statsById:new Map(),
  requestInventory(){},waitFor:async()=>({events:[{kind:'inventory'}]})};
const s={name:'fixture',need:()=>c,client:c,pacer:{submit:async(_,fn)=>fn()}};
const plan=()=>inventorySalePlan(s,{loadout,keep:FLEET_KEEP}).items;
assert.deepEqual(plan().map(i=>[i.queued,i.sale_amount]),[[true,1],[true,184]]);
assert.equal(saleAllowance(loadout,'herbs',[{name:'herbs',amount:40}]).amount,0);
assert.equal(saleAllowance(loadout,'sapphire',[{name:'sapphire',amount:120}]).amount,20);
assert.equal(saleAllowance(loadout,'red mushroom',[{name:'red mushroom',amount:100}]).amount,Infinity);
const keep={...loadout,keep:['herb']};
assert.equal(inventorySalePlan(s,{loadout:keep,keep:FLEET_KEEP}).items[0].queued,false);
assert.equal(inventorySalePlan(s,{loadout,keep:FLEET_KEEP,protect:['elderberry']}).items[1].queued,false);
// Duplicate stack objects share one reserve, not a separate reserve per object.
c.inventory=[{id:1,nameRsc:1,amount:30},{id:3,nameRsc:1,amount:30}];
assert.deepEqual(plan().map(i=>[i.queued,i.sale_amount]),[[true,20],[false,0]]);
const offers=[];
s.sellOne=async(_merchant,item,confirm)=>{offers.push({amount:item.amount,confirm});
  if(confirm)c.inventory.find(i=>i.id===item.id).amount-=item.amount;
  return {sold:confirm,offered_price:item.amount*7};};
const result=await sellAll(s,{merchant:{id:99,name:'Joguer'},loadout,keep:MARKET_KEEP});
assert.equal(result.total_received,140);
assert.equal(c.inventory.reduce((n,i)=>n+i.amount,0),40);
// One unit from a stack must retain the counted-object protocol tag.
c.inventory=[{id:1,nameRsc:1,amount:41}];c.evSeq=0;c.eventsSince=()=>[];
c.trade={theirs:[{amount:7}]};let wire;
c.offer=(_id,items)=>{wire=items;};c.cancelOffer=()=>{};
c.waitFor=async()=>({events:[{kind:'countered'}]});
await Session.prototype.sellOne.call(s,99,{id:1,amount:1},false);
assert.deepEqual(wire,[{id:1,amount:1}]);

const k=Object.assign(Object.create(Autopilot.prototype),{s:{world:{room:{num:113}}},
  policy:{},travelInterrupted:()=>false,actions:[],
  travel:async function(room){this.actions.push(['travel',room]);this.s.world.room.num=room;return {arrived:true};},
  sellInTown:async function(options){this.actions.push(['sell',this.s.world.room.num,options.maxStack??null]);
    return {sold:[{name:'loot',price:10}],total_received:10};}});
const trip={marketStops:MARKET_STOPS};
const travel=k.travel;let interrupted=true;
k.travel=async function(room){if(interrupted){interrupted=false;return {arrived:false};}return travel.call(this,room);};
assert.equal((await k.sellMarketCircuit(trip)).pending,true);
assert.equal(trip.marketIndex,1);
const sale=await k.sellMarketCircuit(trip);
assert.equal(sale.total_received,30);
assert.deepEqual(k.actions.filter(a=>a[0]==='sell'),[['sell',113,null],['sell',109,25],['sell',104,null]]);
assert.equal(townDestinations({packFull:true,richEnoughToBank:true})[0].room,113);
assert.ok(!MARKET_STOPS.some(s=>s.room===110));
const owner=Object.assign(Object.create(Autopilot.prototype),{
  policy:{},townTrip:{startedAt:1234},inertStatus:()=>null,parkStatus:()=>null,
  heldStatus:()=>null,busyStatus:()=>null,
});
assert.equal(owner.commitment().kind,'errand');
assert.equal(owner.commitment().since,1234);
assert.notEqual(owner.commitment().takeable,true);
owner.townTrip=null;owner.deferredShoppingTrip={startedAt:1234};
assert.equal(owner.commitment(),null,'deferred unaffordable shopping releases the farmer');
console.log('reagent income regression tests passed');
