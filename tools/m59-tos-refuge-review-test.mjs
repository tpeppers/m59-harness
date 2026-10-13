import assert from 'node:assert/strict';
import fs from 'node:fs';
import {geometryFor} from './m59-safespots.mjs';
import {planBodyDetour} from './m59-body-detour.mjs';
import {returnToSpot} from './m59-skills.mjs';
import {recoveryDepartureFloor} from './m59-fleetscript.mjs';
import {healthLossEvidence,record,emptyBook} from './m59-hits.mjs';
import {M59Client} from './m59-client.mjs';
let count=0; const test=async(name,fn)=>{await fn();count++;console.log('PASS '+name);};
const map=JSON.parse(fs.readFileSync(new URL('../substrate/m59-map.json',import.meta.url)));
await test('recorded Tos refuge can be reached without its obstructed centre',()=>{
 const geo=geometryFor(map.rooms[596]),from={x:103,y:192,row:3,col:1},goal=geo.standPointWire(2,1),objects=new Map([[21934,{id:21934,x:82,y:229,flags:9}]]);
 assert.equal(planBodyDetour(geo,from,goal,{objects,selfId:1,maxMs:100}).found,false);
 const p=planBodyDetour(geo,from,goal,{objects,selfId:1,goalSquare:{row:2,col:1},maxMs:100});
 assert.equal(p.found,true);assert.ok(p.nodes<32);const end=p.waypoints.at(-1);assert.equal(Math.floor(end.x/64),1);assert.equal(Math.floor(end.y/64),2);
});
await test('revoked predicted arrival invokes fine fallback and confirms it',async()=>{
 const c={self:{row:3,col:1,x:103,y:192}},calls=[];
 const s={client:c,world:{room:{num:596}},movementGeneration:0,need:()=>c,standBeforeGo:async()=>{},
  walkTo:async()=>{calls.push('coarse');c.self={row:2,col:1,x:96,y:160,predicted:true};return{arrived:true};},
  confirmPosition:async()=>{if(c.self.predicted)c.self={row:3,col:1,x:110,y:199,predicted:false};return{...c.self};},
  approachFine:async()=>{calls.push('fine');c.self={row:2,col:1,x:95,y:184,predicted:false};return{arrived:true};}};
 const r=await returnToSpot(s,{row:2,col:1},{routeFirst:true});assert.equal(r.arrived,true);assert.deepEqual(calls,['coarse','fine']);
});
await test('confirmed shelter recovery takes precedence over a75-percent floor',()=>{
 const status={hp:{value:15,max:20},room:{num:587},you:{row:33,col:56},safe_spot:{works:true},survival_decisions:{current:{status:'recovering',chosen_refuge:{room:587,row:33,col:56}}}};
 assert.equal(recoveryDepartureFloor(status,.75),1);
 assert.equal(recoveryDepartureFloor({...status,you:{...status.you,predicted:true}},.75),.75);
 assert.equal(recoveryDepartureFloor({...status,safe_spot:false},.75),.75);
 assert.equal(recoveryDepartureFloor(null,.75),.75);
});
await test('protective poison resistance is not an active sickness',()=>{
 const c=Object.create(M59Client.prototype);c.enchantmentsById=new Map([[1,{id:1,name:'poison'}],[2,{id:2,name:'resist poison'}],[3,{id:3,name:'cure disease'}]]);
 assert.deepEqual(c.ailments().map(e=>e.name),['poison']);
 let invalidated=false;c.enchantmentObservations={invalidate:()=>{invalidated=true;}};
 c.onGameMessage(228,Buffer.alloc(0));assert.equal(invalidated,true);assert.equal(c.enchantmentsById.size,0);
});
await test('loss evidence preserves uncertainty and concurrent attacks',()=>{
 const c={ailments:()=>[{id:1,name:'poison',at:900}],events:[],enchantmentStatus:()=>({as_of:1000,truncated:false})};
 const e=healthLossEvidence(c,1000);assert.equal(e.interpretation,'ailment present; damage cause unproved');
 c.events=[{kind:'message',at:999,text:'The troll wounds you with its attack.'}];const a=healthLossEvidence(c,1000);assert.equal(a.interpretation,'incoming attack observed');assert.equal(a.ailments.length,1);
 const b=emptyBook('offline');record(b,{at:1000,room:587,row:33,col:56,lost:2,evidence:e});record(b,{at:1001,room:587,row:33,col:56,lost:4,evidence:a});assert.equal(b.segments[0].evidence.length,2);c.events.length=0;assert.equal(b.segments[0].evidence[1].value.attacks.length,1);
 for(let i=0;i<20;i++)record(b,{at:1002+i,room:587,row:33,col:56,lost:1,evidence:{marker:i}});
 assert.equal(b.segments[0].evidence.length,16);assert.equal(b.segments[0].evidence_truncated,true);
 assert.deepEqual(b.segments[0].evidence[0].value,e);assert.equal(b.segments[0].evidence.at(-1).value.marker,19);
});
console.log(count+' Tos refuge/recovery cases passed');
