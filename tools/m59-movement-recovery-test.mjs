import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Autopilot} from './m59-autopilot.mjs';
import {Session} from './m59-game.mjs';
import {returnToSpot} from './m59-skills.mjs';
import {buildIncident,exportIncident} from './m59-movement-incidents.mjs';
import {heldMonsterPlacementPlan} from './m59-scene-staging.mjs';
import {traceMove,recentMoveAttempts} from './m59-collision-trace.mjs';

function keeper() {
 const s={name:'fixture',client:{selfId:1,self:{row:37,col:14,predicted:false},room:{objects:new Map()}},world:{room:{num:534},geometry:{walkable:()=>true}}};
 return Object.assign(Object.create(Autopilot.prototype),{s,policy:{unreachableSpotMs:1000},wallHere:()=>({ok:true,row:37,col:14})});
}
test('keep-right offsets stay in the requested square, including a shelter beside a room edge',()=>{
 const home={x:2208,y:3040},from={x:2144,y:2976,row:46,col:33};
 for(const [lane,expected] of [[{x:2152,y:3096},home],[{x:2192,y:3048},{x:2192,y:3048}]]) {
  const s={world:{geometry:{standPointWire:()=>home,traceFineMoveClient:()=>({arrived:true})}},
   bodiesInSquare:()=>[],keepRightLane:()=>lane};
  assert.deepEqual(Session.prototype.aimInto.call(s,from,47,34),expected);
 }
});
test('fresh failed rest cannot be re-adopted as logoff-safe; temporary exclusion expires',t=>{
 t.mock.timers.enable({apis:['Date'],now:10000});const k=keeper();
 assert.ok(k.currentRecoveryWall());k.noteFailedRestSpot(534,14,37);
 assert.equal(k.currentRecoveryWall(),null);
 assert.equal(k.replacementSurvivalChoice('attacked',{strategy:'rest_safe'}).strategy,'nearest_refuge');
 t.mock.timers.tick(1001);assert.ok(k.currentRecoveryWall());
});
test('a co-located attackable monster defeats recovery cover; items and other squares do not',()=>{
 const k=keeper(),objects=k.s.client.room.objects;
 objects.set(2,{id:2,flags:9,row:37,col:14});assert.equal(k.currentRecoveryWall(),null);
 objects.set(2,{id:2,flags:9,row:37,col:15});assert.ok(k.currentRecoveryWall());
 objects.set(2,{id:2,flags:1,row:37,col:14});assert.ok(k.currentRecoveryWall());
});
test('terminal refuge approach stops all fallback movers and retains reason without inventing cancellation',async()=>{
 for(const routeFirst of [true,false]) {
  const c={self:{row:10,col:10,x:672,y:672,predicted:false}},calls=[];
  const fail=async name=>{calls.push(name);return{arrived:false,reason:'collision_geometry_unavailable'};};
  const s={client:c,need:()=>c,world:{room:{num:583}},movementGeneration:0,movementWasCancelled:()=>false,
   standBeforeGo:async()=>{},walkTo:()=>fail('square'),approachFine:()=>fail('fine'),walkFine:()=>fail('last-fine')};
  const r=await returnToSpot(s,{col:12,row:10},{routeFirst});
  assert.equal(r.reason,'collision_geometry_unavailable');assert.equal(r.cancelled,undefined);assert.equal(calls.length,1);
 }
});
test('incident trail retains numeric time alongside its named square',()=>{
 traceMove({agent:'fixture',kind:'step',room:554,from:{x:1568,y:1824},sent:false,reason:'object_blocked',objectId:7});
 const r=buildIncident({agent:'fixture',kind:'wedge',trail:[{at:12345,room:554,row:28,col:24,x:1568,y:1824}],code:{}});
 assert.equal(r.trail[0].at,12345);assert.deepEqual(r.trail[0].square,{row:28,col:24});
 assert.equal(exportIncident(r,{names:[]}).failure.movement_attempts.attempts.at(-1).object_id,7);
});
test('attempt journal stays bounded, preserves fine points/body ID and isolates callers from mutation',()=>{
 const from={x:800,y:960};for(let i=0;i<100;i++)traceMove({agent:'journal-fixture',kind:'step',room:554,from,target:{row:28,col:24},sent:false,reason:'object_blocked',objectId:7});
 from.x=99;const r=recentMoveAttempts('journal-fixture');assert.equal(r.attempts.length,32);assert.ok(r.evicted>0);
 assert.equal(r.attempts[0].from.x,800);assert.equal(r.attempts[0].object_id,7);
 r.attempts[0].from.x=1;assert.equal(recentMoveAttempts('journal-fixture').attempts[0].from.x,800);
 assert.equal(typeof r.attempts[0].at,'number');
});
test('scene capture loads before lab config without caching the wrong disk trace destination',()=>{
 const script=`process.env.M59_COLLISION_TRACE_FILE='before-lab';
 await import(${JSON.stringify(new URL('./m59-scene-capture.mjs',import.meta.url).href)});
 process.env.M59_COLLISION_TRACE_FILE='isolated-lab';
 const {TRACE_FILE}=await import(${JSON.stringify(new URL('./m59-collision-trace.mjs',import.meta.url).href)});
 if(TRACE_FILE!=='isolated-lab')throw Error('scene import cached a pre-lab trace path');`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);
});
test('exact held placement restores a monster in an otherwise inaccessible square, never player placement',()=>{
 const scene={actors:[{key:'self',kind:'player'},{key:'tree',kind:'monster',at:{v:{row:37,col:14,x:928,y:2400}}}]};
 const actual={room_object:5,properties:{pbsceneheld:{value:1}},actors:[]};
 const plan=heldMonsterPlacementPlan(scene,new Map([['tree',7]]),actual);assert.equal(plan.length,1);assert.match(plan[0],/NewHold/);assert.match(plan[0],/what OBJECT 7/);
 assert.throws(()=>heldMonsterPlacementPlan(scene,new Map([['tree',7]]),{...actual,properties:{}}),/held room/);
 assert.throws(()=>heldMonsterPlacementPlan({...scene,actors:[{...scene.actors[1],at:{v:{row:37,col:14,x:400,y:2400}}}]},new Map([['tree',7]]),actual),/consistent/);
});
