import assert from 'node:assert/strict';
import {World} from './m59-world.mjs';
import {loadMap} from './m59-map.mjs';
import {orderExits,Session} from './m59-game.mjs';
const original=loadMap(),bar=original.rooms[2008];
function exits({num=2008,x=1551,y=833,budget={maxMs:5000,maxNodes:100000},locks=true,fine=true}={}){
 const room={...bar,num,goExits:locks?bar.goExits:bar.goExits.filter(e=>!e.locked)};
 const map={...original,rooms:{[num]:room}};
 const self={row:Math.floor(y/64),col:Math.floor(x/64),...(fine?{x,y}:{})};
 const world=new World({roomNameRsc:room.nameRsc,roomRsc:room.roomRsc,self,room:{objects:new Map()}},map,{fineConnectivityBudget:budget});
 return world.exits();
}
for(const origin of [{x:1551,y:833},{x:1120,y:1280},{num:77770,x:1551,y:833}]){
 const all=exits(origin),toTown=all.filter(e=>e.to===2000);
 assert.equal(all.length,bar.goExits.length,'model evidence retains every declared portal');
 for(const e of toTown.filter(e=>e.stand_on.col===31)){
  assert.equal(e.verified,false);assert.equal(e.fine_disconnected,true);
 }
 const chosen=orderExits(toTown)[0];
 assert.equal(chosen.stand_on.col,30,'the real crossing executor ranks the connected sibling first');
 assert.equal(chosen.verified,true);
  assert.equal(chosen.prefer_fine_approach,true);
 assert(all.some(e=>e.to===2001&&e.verified===true),'open alternate town route remains available');
}
for(const options of [{budget:{maxNodes:1,maxMs:1}},{fine:false},{locks:false}]){
 const candidates=exits(options).filter(e=>e.to===2000&&e.stand_on.col===31);
 assert(candidates.every(e=>e.verified===true&&!e.fine_disconnected&&!e.prefer_fine_approach),'unknown fine connectivity retains coarse doorway fallback');
}
const oldRail=process.env.M59_RAIL;process.env.M59_RAIL='0';
try{for(const mode of ['room-change','cancel','fine-refused','ordinary']){
 const calls=[],c={room:{id:1},self:{row:13,col:24,x:1551,y:833}};
 let cancelled=false;
 const s=Object.assign(Object.create(Session.prototype),{client:c,world:{room:{num:2008}},movementGeneration:1,
  need:()=>c,movementWasCancelled:()=>cancelled,cancelledMovement:()=>({cancelled:true,left:false}),
  standBeforeGo:async()=>{},refreshRoomIdentity:async()=>({confirmed:true}),
  approachFine:async(col,row,o)=>{calls.push('fine');assert.equal(col,30);assert.equal(row,12);assert.equal(o.movementGeneration,1);
   if(mode==='cancel')cancelled=true;
   if(mode==='room-change'){c.room.id=2;s.world.room={num:2000};return {arrived:true,left_room:true};}
   return {arrived:false,reason:'fine approach refused'};},
  walkTo:async()=>{calls.push('coarse');cancelled=true;return {arrived:false,cancelled:true,reason:'cancelled'};}
 });
 const r=await s.leaveVia({kind:'go',to:2000,stand_on:{row:12,col:30},prefer_fine_approach:mode!=='ordinary'});
 assert.deepEqual(calls,mode==='ordinary'?['coarse']:mode==='fine-refused'?['fine','coarse']:['fine']);
 if(mode==='room-change')assert.equal(r.left,true);else assert.equal(r.cancelled,true);
}}finally{if(oldRail===undefined)delete process.env.M59_RAIL;else process.env.M59_RAIL=oldRail;}
console.log('Go-exit connectivity: connected sibling wins; declared portals, unknown geometry and unrelated rooms retain their fallback.');
