import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {Autopilot} from './m59-autopilot.mjs';
import {Session} from './m59-game.mjs';
import {returnToSpot} from './m59-skills.mjs';
import {buildIncident,exportIncident} from './m59-movement-incidents.mjs';
import {heldMonsterPlacementPlan} from './m59-scene-staging.mjs';
import {traceMove,recentMoveAttempts} from './m59-collision-trace.mjs';
import {TERMINAL_MOVEMENT_REASONS} from './m59-movement.mjs';
import {geometryFor} from './m59-safespots.mjs';

function fineApproachFixture({waypoints=5}={}) {
 const c={self:{row:10,col:10,x:672,y:672},room:{id:10}},calls=[];
 const s=Object.assign(Object.create(Session.prototype),{client:c,movementGeneration:0,
  need:()=>c,movementWasCancelled:g=>g!==s.movementGeneration,
  world:{room:{num:597},geometry:{collisionReady:true,finePathProtocol:()=>({found:true,
   waypoints:Array.from({length:waypoints},(_,i)=>({x:680+i*8,y:680}))})}},
  stepFine:async(x,y)=>{calls.push({kind:'waypoint',x,y});return {moved:true};},
  walkFine:async(_x,_y,options)=>{calls.push({kind:'fallback',...options});return {arrived:false,steps:options.maxSteps,reason:'ran out of steps'};}});
 return {s,c,calls};
}

test('fine waypoint and sliding fallback attempts share the caller budget and report all attempts',async()=>{
 for(const [waypoints,maxSteps,expected] of [[5,2,5],[1,4,4],[0,3,3],[5,0,0]]) {
  const {s,calls}=fineApproachFixture({waypoints});
  const r=await s.approachFine(12,12,{maxSteps});
  assert.equal(r.steps,expected);assert.equal(r.arrived,false);
  assert.equal(calls.filter(x=>x.kind==='waypoint').length,maxSteps===0?0:waypoints);
  const fallback=calls.find(x=>x.kind==='fallback');
  assert.equal(fallback?.maxSteps??0,Math.max(0,expected-waypoints));
 }
});

test('successful fine routes use exactly their existing waypoints and no fallback',async()=>{
 const {s,c,calls}=fineApproachFixture({waypoints:2});
 s.stepFine=async(x,y)=>{calls.push({kind:'waypoint',x,y});
  if(calls.length===2)c.self={row:12,col:12,x:800,y:800};return {moved:true};};
 const r=await s.approachFine(12,12,{maxSteps:2});
 assert.equal(r.arrived,true);assert.equal(r.steps,2);assert.equal(calls.length,2);
});

test('a long real-geometry detour keeps its full planned route despite a short default budget',async()=>{
 const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url)));
 const room=map.rooms[597],geo=geometryFor(room),target={row:4,col:23};
 const from={row:7,col:25,...geo.standPointWire(7,25)},goal=geo.standPointWire(target.row,target.col);
 const path=geo.finePathProtocol(from.x,from.y,goal.x,goal.y,{step:8,margin:256,maxNodes:4000});
 assert.ok(path.found&&path.waypoints.length>24,'fixture exercises a planned detour beyond the caller default');
 const c={selfId:1,self:{...from},room:{id:597,security:geo.security,flags:0,overrideDepths:[0,0,0,0],objects:new Map()}};
 c.room.objects.set(1,c.self);const calls=[];
 const s=Object.assign(Object.create(Session.prototype),{client:c,world:{room,geometry:geo},
  movementGeneration:0,movementWasCancelled:()=>false,need:()=>c,moveSpeed:()=>18,
  stepFine:async(x,y)=>{
   const r=s.validateFineTarget(x,y,{slide:true});calls.push({x,y});
   if(r.moved&&r.target){c.self={...r.target,row:Math.floor(r.target.y/64),col:Math.floor(r.target.x/64)};c.room.objects.set(1,c.self);}
   return {...r,left_room:false};
  },walkFine:async()=>assert.fail('a healthy planned route needs no fan fallback')});
 const r=await s.approachFine(target.col,target.row,{maxSteps:24});
 assert.equal(r.arrived,true);assert.ok(r.steps>24);assert.equal(r.steps,calls.length);
 assert.deepEqual(calls,path.waypoints.slice(0,calls.length).map(({x,y})=>({x,y})));
});

test('every terminal waypoint failure propagates its receipt before any more movement',async()=>{
 for(const reason of TERMINAL_MOVEMENT_REASONS) {
  const {s,calls}=fineApproachFixture();
  s.stepFine=async()=>{calls.push('refused');return {moved:false,reason,note:'original detail',animation:{tag:3}};};
  const r=await s.approachFine(12,12,{maxSteps:5});
  assert.equal(r.reason,reason);assert.equal(r.note,'original detail');assert.equal(r.animation.tag,3);
  assert.equal(r.steps,1);assert.equal(r.cancelled,undefined);assert.deepEqual(calls,['refused']);
 }
});

test('terminal exceptions and fallback refusals retain their reason and total attempts',async()=>{
 const f=fineApproachFixture();f.s.stepFine=async()=>{throw Error('room_geometry_mismatch');};
 assert.equal((await f.s.approachFine(12,12)).reason,'room_geometry_mismatch');assert.equal(f.calls.length,0);
 const g=fineApproachFixture({waypoints:1});
 g.s.walkFine=async()=>({steps:2,reason:'position_confirmation_timeout',note:'no confirmed start'});
 const r=await g.s.approachFine(12,12,{maxSteps:4});
 assert.equal(r.steps,3);assert.equal(r.reason,'position_confirmation_timeout');assert.equal(r.note,'no confirmed start');
});

test('takeover during the last waypoint or fallback cannot certify a stale arrival',async()=>{
 for(const phase of ['waypoint','fallback']) {
  const {s,c,calls}=fineApproachFixture({waypoints:phase==='waypoint'?1:0});
  const takeOver=async()=>{calls.push(phase);c.self={row:12,col:12,x:800,y:800};s.movementGeneration++;return {moved:true,arrived:true,steps:1};};
  if(phase==='waypoint')s.stepFine=takeOver;else s.walkFine=takeOver;
  const r=await s.approachFine(12,12,{maxSteps:2});
  assert.equal(r.arrived,false);assert.equal(r.cancelled,true);assert.equal(r.steps,1);assert.deepEqual(calls,[phase]);
 }
});

test('square and fine shelter strategies both receive the requested attempt budget',async()=>{
 for(const routeFirst of [true,false]) {
  const {s,c,calls}=fineApproachFixture({waypoints:5});c.self.predicted=false;
  s.standBeforeGo=async()=>{};
  s.walkTo=async(_col,_row,opts)=>{calls.push({kind:'square',maxSteps:opts.maxSteps});return {arrived:false,reason:'geometry_blocked'};};
  s.approachFine=async(col,row,opts)=>{calls.push({kind:'fine-budget',maxSteps:opts.maxSteps});return Session.prototype.approachFine.call(s,col,row,opts);};
  const r=await returnToSpot(s,{row:12,col:12},{maxSteps:2,routeFirst});
  assert.equal(r.arrived,false);assert.equal(calls.find(x=>x.kind==='square').maxSteps,2);
  assert.equal(calls.find(x=>x.kind==='fine-budget').maxSteps,2);
  assert.equal(calls.filter(x=>x.kind==='waypoint').length,5);assert.equal(calls.some(x=>x.kind==='fallback'),false);
 }
});

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
