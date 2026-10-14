import assert from 'node:assert/strict';
import {roomGeometry} from './m59-ground.mjs';
import {knownRefugeCell,turnAtProvedRefuge} from './m59-refuge-activation.mjs';
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
