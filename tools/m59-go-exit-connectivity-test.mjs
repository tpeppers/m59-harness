import assert from 'node:assert/strict';
import {World} from './m59-world.mjs';
import {loadMap} from './m59-map.mjs';
import {orderExits} from './m59-game.mjs';
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
 assert(all.some(e=>e.to===2001&&e.verified===true),'open alternate town route remains available');
}
for(const options of [{budget:{maxNodes:1,maxMs:1}},{fine:false},{locks:false}]){
 const candidates=exits(options).filter(e=>e.to===2000&&e.stand_on.col===31);
 assert(candidates.every(e=>e.verified===true&&!e.fine_disconnected),'unknown fine connectivity retains coarse doorway fallback');
}
console.log('Go-exit connectivity: connected sibling wins; declared portals, unknown geometry and unrelated rooms retain their fallback.');
