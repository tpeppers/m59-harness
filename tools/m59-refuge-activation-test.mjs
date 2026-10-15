import assert from 'node:assert/strict';
import {roomGeometry} from './m59-ground.mjs';
import {knownRefugeCell,turnAtProvedRefuge,confirmRefugeCellArrival} from './m59-refuge-activation.mjs';
import {restUntil} from './m59-skills.mjs';
const geo=roomGeometry(2502),pose={id:1,x:2083,y:1466,row:22,col:32};
assert.deepEqual(knownRefugeCell(geo,pose),{row:22,col:32});
assert.equal(knownRefugeCell(geo,{...pose,x:3072,y:2736,row:42,col:48}),null);
assert.equal(knownRefugeCell(geo,{...pose,predicted:true}),null);
function fixture(){
 const calls=[];let awake=false,seated=false;
 const c={state:'game',room:{id:77},self:{...pose,degrees:0},evSeq:0,events:[],
  vitals:()=>({health:{value:awake?20:13,max:20},vigor:{value:200,scale_max:200}}),stats:()=>{},waitFor:async()=>{},
  rest:()=>{calls.push('rest');seated=true;},stand:()=>{calls.push('stand');seated=false;},
  face:degrees=>{calls.push('turn');c.self.degrees=degrees;awake=true;}};
 const s={client:c,need:()=>c,live:true,movementGeneration:4,world:{geometry:geo},movementWasCancelled:()=>false,
  confirmFinePosition:async()=>({...c.self,room_object_id:77,at:Date.now()}),pacer:{submit:async(_kind,f)=>f()}};
 return {s,c,calls,seated:()=>seated};
}
{
 const f=fixture(),r=await restUntil(f.s,{health:1,vigor:0,maxSeconds:5});
 assert.deepEqual(f.calls,['rest','turn','stand']);assert.equal(r.vitals.health.value,20,'the real rest loop heals after native activation');
 assert.equal(f.seated(),false);assert.deepEqual({...f.c.self,degrees:0},{...pose,degrees:0},'the activation does not change position');
}
for(const why of ['unconfirmed','predicted','room changed','identity changed','cancelled','declined','combat owns','PvP gear']){
 const f=fixture();
 if(why==='unconfirmed')f.s.confirmFinePosition=async()=>null;
 if(why==='predicted')f.c.self.predicted=true;
 if(why==='room changed')f.s.confirmFinePosition=async()=>{f.c.room.id=78;return {...pose};};
 if(why==='identity changed')f.s.confirmFinePosition=async()=>{f.c.self.id=2;return {...pose};};
 if(why==='cancelled')f.s.movementWasCancelled=()=>true;
 if(why==='combat owns')f.s.combat={active:true};
 if(why==='PvP gear')f.c.pvpGearActive=true;
 const r=await turnAtProvedRefuge(f.s,{beforeMutation:()=>why==='declined'?false:undefined});
 assert.equal(r.sent,false,why);assert(!f.calls.includes('turn'),why+' cannot wake a body');
}
{
 const f=fixture();await assert.rejects(restUntil(f.s,{health:1,vigor:0,beforeMutation:k=>{if(k==='turn')throw Error('fixture takeover');}}),/fixture takeover/);
 assert.deepEqual(f.calls,['rest','stand'],'a failed activation retains authorized rest cleanup');
}
console.log('Real rest activates only confirmed cover, preserves position/identity/cancellation and cleans up after an activation failure.');

// Native convoy 28: a refused Hollows jump was followed by a walk which stopped
// eight KOD units short, across the selected refuge's square boundary.
const refuge={point:{x:2176,y:2552},cell:{row:39,col:34}};
const edgePose={id:1,x:2176,y:2560,row:40,col:34};
assert.equal(knownRefugeCell(geo,edgePose),null);
assert(knownRefugeCell(geo,{id:1,...refuge.point,...refuge.cell}));
{
 let body={...edgePose},finishes=0,reads=0;
 const r=await confirmRefugeCellArrival(geo,refuge,{settleMs:0,read:async()=>{
  reads++;if(finishes&&reads>2)body={id:1,...refuge.point,...refuge.cell};return body;
 },finish:async point=>{assert.deepEqual(point,refuge.point);finishes++;return {arrived:true};}});
 assert(r.arrived&&r.finished);assert.equal(finishes,1,'confirmation lag does not resend a movement');
}
{
 let finishes=0;
 const r=await confirmRefugeCellArrival(geo,refuge,{settleMs:0,read:async()=>edgePose,
  finish:async()=>{finishes++;return {arrived:true};}});
 assert.equal(r.arrived,false,'an optimistic movement reply cannot prove the covered cell');assert.equal(finishes,1);
}
for(const body of [{...edgePose,predicted:true},{...edgePose,x:2150}]){
 let finishes=0;
 const r=await confirmRefugeCellArrival(geo,refuge,{settleMs:0,read:async()=>body,finish:async()=>{finishes++;}});
 assert.equal(r.arrived,false);assert.equal(finishes,0,'unconfirmed or distant poses cannot authorize the final approach');
}
{
 const r=await confirmRefugeCellArrival(geo,refuge,{settleMs:0,read:async()=>edgePose,finish:async()=>({cancelled:true})});
 assert(r.cancelled&&!r.arrived);
 await assert.rejects(confirmRefugeCellArrival(geo,refuge,{read:async()=>{throw Error('ownership changed');},finish:async()=>{}}),/ownership changed/);
}
console.log('Partial-refuge arrival finishes one checked short approach and requires observed cover, retaining cancellation and ownership refusal.');
