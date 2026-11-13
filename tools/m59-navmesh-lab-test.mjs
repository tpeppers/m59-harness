#!/usr/bin/env node
// Pure pre-login refusal/shape tests. No adapter, server, config or credentials read.
import assert from 'node:assert/strict';
import {selectTypedNavMeshLabPlan,validateNativeNavMeshLabInputs} from './m59-navmesh-lab.mjs';
let count=0;const test=(name,fn)=>{fn();console.log('ok '+name);count++;};
const p=(x,y=512)=>({x,y});
const raw=()=>({format:'m59-typed-candidate-plan/1',room:515,from:p(512),goal:{kind:'point',...p(896)},legs:[
 {kind:'walk',from:p(512),to:p(640),waypoints:[p(512),p(640)]},
 {kind:'jump',declared:false,from:p(640),to:p(896),fromFine:p(640),toFine:p(896)}]});
const fixture=()=>({config:{fleet_file:'private-roster.json',agent:'test',native_snapshot:'private-snapshot'},
 roster:{test:{credentials:{host:'127.0.0.1',port:17959}}},
 scene:{schema:'m59-scene/v1',room:{num:515},actors:[{kind:'player',mine:true,name:'Test',at:{v:{row:1,col:1,x:96,y:96},how:'estimated'}}]},
 plan:selectTypedNavMeshLabPlan(raw()),candidateJumps:1});
test('typed candidate input is accepted only with the explicit bounded candidate flag',()=>{
 const f=fixture();assert.equal(validateNativeNavMeshLabInputs(f).candidateFalls,1);
 assert.throws(()=>validateNativeNavMeshLabInputs({...f,candidateJumps:0}),/explicit_candidate_jumps/);
});
test('production and other lab endpoints are refused before any adapter can be created',()=>{
 for(const [host,port]of [['127.0.0.1',15959],['127.0.0.1',5959],['example.test',17959]]){
  const f=fixture();f.roster.test.credentials={host,port};assert.throws(()=>validateNativeNavMeshLabInputs(f),/loopback_17959/);}
});
test('maintenance mismatch and missing native snapshot are refused',()=>{
 const f=fixture();f.config.admin_port=19998;assert.throws(()=>validateNativeNavMeshLabInputs(f),/17998/);
 delete f.config.admin_port;delete f.config.native_snapshot;assert.throws(()=>validateNativeNavMeshLabInputs(f),/native_snapshot_required/);
});
test('a single-leg selection changes the authored start and cannot claim a complete route',()=>{
 const plan=selectTypedNavMeshLabPlan(raw(),{onlyLeg:1});assert.deepEqual(plan.from,p(640));assert.equal(plan.legs.length,1);assert.equal(plan.returnRoute,null);
 assert.match(plan.scope,/single authored leg/);const f=fixture();f.plan=plan;assert.throws(()=>validateNativeNavMeshLabInputs(f),/fine_start/);
 f.scene.actors[0].at.v.x=104;assert.equal(validateNativeNavMeshLabInputs(f).candidateFalls,1);
});
test('untyped flattened routes and nonmovement actions cannot masquerade as typed plans',()=>{
 assert.throws(()=>selectTypedNavMeshLabPlan({waypoints:[p(512),p(896)]}),/unsupported_typed/);
 const bad=raw();bad.legs[1].kind='activate';assert.throws(()=>selectTypedNavMeshLabPlan(bad),/invalid_or_disconnected/);
});
test('disconnected legs and unproved walk endpoints are refused',()=>{
 const bad=raw();bad.legs[1].from=p(656);assert.throws(()=>selectTypedNavMeshLabPlan(bad),/disconnected/);
 const other=raw();other.legs[0].waypoints.pop();assert.throws(()=>selectTypedNavMeshLabPlan(other),/walk_proof/);
});
test('off-wire points and inconsistent named goal semantics are refused',()=>{
 const bad=raw();bad.from.x=513;assert.throws(()=>selectTypedNavMeshLabPlan(bad),/invalid_typed/);
 const other=raw();other.goal={kind:'square',row:2,col:2};assert.throws(()=>selectTypedNavMeshLabPlan(other),/goal_does_not_match/);
});
test('a flattened fall endpoint cannot be silently retargeted',()=>{
 const bad=raw();bad.legs[1].toFine=p(912);assert.throws(()=>selectTypedNavMeshLabPlan(bad),/fall_endpoints/);
});
test('scene room, coarse/fine identity and initial actor binding must match the plan',()=>{
 const f=fixture();f.scene.room.num=39;assert.throws(()=>validateNativeNavMeshLabInputs(f),/room_mismatch/);
 f.scene.room.num=515;f.scene.actors[0].at.v.col=2;assert.throws(()=>validateNativeNavMeshLabInputs(f),/fine_start/);
 f.scene.actors[0].at.v.col=1;f.scene.actors[0].name='REPLACE_WITH_OWNED_LAB_CHARACTER';assert.throws(()=>validateNativeNavMeshLabInputs(f),/private_character_binding/);
});
test('captured attacks, other players, monsters and PvP configuration are refused',()=>{
 for(const change of [f=>f.scene.actors.push({kind:'monster'}),f=>f.scene.actors.push({kind:'player',mine:false}),
  f=>f.scene.controller={start_actions:[{kind:'attack'}]},f=>f.config.pvp={enabled:true}]){
  const f=fixture();change(f);assert.throws(()=>validateNativeNavMeshLabInputs(f),/refuses|without_other_bodies/);}
});
test('the pure guard revalidates typed shape even when called outside the CLI',()=>{
 const f=fixture();f.plan.legs[1].kind='attack';assert.throws(()=>validateNativeNavMeshLabInputs(f),/invalid_or_disconnected/);
});
test('return plan stays separate and must connect to the actual outward endpoint',()=>{
 const r=raw();r.returnPlan={legs:[{kind:'walk',from:p(896),to:p(512),waypoints:[p(896),p(512)]}]};
 const plan=selectTypedNavMeshLabPlan(r);assert.equal(plan.returnRoute.legs.length,1);assert.deepEqual(plan.returnRoute.goal,{kind:'point',...p(512)});
 r.returnPlan.legs[0].from=p(912);assert.throws(()=>selectTypedNavMeshLabPlan(r),/disconnected/);
});
console.log(count+' pure native-navmesh lab guards passed; no login or server operation');
