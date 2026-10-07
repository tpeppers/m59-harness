#!/usr/bin/env node
// Underworld source-backed puzzle, trigger avoidance and node recognition regressions.
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {solveBraziers,BRAZIER_FLIPS,UNDERWORLD_BRAZIERS,UNDERWORLD_TELEPORTERS,
  flameState,readBrazierMask,crossesTrigger,underworldRegionPlan,runUnderworldNode,underworldPositionSnapshot} from './m59-underworld-node.mjs';
import {fineRouter} from './m59-fineroute.mjs';
import {meldVerdict} from './m59-nodecheck.mjs';
import {STONES,objectiveFor,KOD_ROOT} from './m59-stones.mjs';
let checks=0;
function test(name,fn){fn();checks++;console.log('ok '+name);}
test('all flame states solve using only unlit switches, at most seven activations',()=>{
 for(let mask=0;mask<32;mask++){
  let state=mask;const steps=solveBraziers(mask);assert.ok(steps.length<=7);
  for(const i of steps){assert.equal(state&(1<<(i-1)),0);state^=BRAZIER_FLIPS[i-1];}
  assert.equal(state,31);
 }
 assert.deepEqual(solveBraziers(31),[]);assert.throws(()=>solveBraziers(32));
});
test('timer-aware solutions finish at the southern brazier without an earlier solve',()=>{
 for(let m=0;m<31;m++){
  const steps=solveBraziers(m,{last:4});assert.ok(steps.length<=9);assert.equal(steps.at(-1),4);
  let at=m;for(const [j,index] of steps.entries()){
   assert.equal(at&(1<<(index-1)),0);at^=BRAZIER_FLIPS[index-1];
   assert.equal(at===31,j===steps.length-1);
  }
 }
 assert.deepEqual(solveBraziers(27,{last:4}),[3,5,2,5,4]);
});
test('toggle mapping agrees with the room source rather than an arbitrary Lights Out puzzle',()=>{
 const file=join(KOD_ROOT,'object/active/holder/room/monsroom/uworld.kod');
 if(!existsSync(file)){console.log('source cross-check skipped: set M59_ROOT');return;}
 const kod=readFileSync(file,'utf8');
 const body=kod.split('BrazierLit(')[1].split('CreateStandardExits(')[0];
 for(let i=1;i<=5;i++){
  const section=body.split('if what = poBrazier'+i+' ')[1].split('lit = FALSE;')[0];
  const mask=[...section.matchAll(/#what=(\d)/gi)].reduce((m,v)=>m|(1<<(Number(v[1])-1)),0);
  assert.equal(mask,BRAZIER_FLIPS[i-1]);
 }
});
test('lit and cold wire animations distinguish state while missing evidence stays unknown',()=>{
 assert.equal(flameState({animate:{animation:1,group:1}}),false);
 assert.equal(flameState({animate:{animation:2,groupLow:2,groupHigh:6}}),true);
 assert.equal(flameState({animate:{animation:1,group:2}}),null);
 assert.equal(flameState({}),null);
 const objs=UNDERWORLD_BRAZIERS.map(b=>({...b,id:b.index,name:'brazier',animate:{animation:1,group:1}}));
 assert.equal(readBrazierMask(objs).mask,0);
 assert.throws(()=>readBrazierMask([...objs,objs[0]]),/ambiguous/);
});
test('a long chord cannot cross a teleporter just because its endpoint is elsewhere',()=>{
 const t={row:16,col:16};assert.equal(crossesTrigger({x:14000,y:15800},{x:18000,y:15800},t),true);
 assert.equal(crossesTrigger({x:14000,y:15000},{x:18000,y:15000},t),false);
});
test('the central portal has its own meld message and is excluded from generic stone errands',()=>{
 assert.equal(meldVerdict('Yet, when you regain your equilibrium, you feel the course of magic flow through your veins.').verdict,'melded');
 assert.equal(meldVerdict('You have already bonded with the corpsenode.').verdict,'already');
 assert.equal(meldVerdict('Entering the portal you wander about the netherworld, but find yourself drawn out...').verdict,'unrelated');
 assert.equal(objectiveFor(STONES.corpse),null);assert.equal(STONES.corpse.puzzle,'underworld-braziers');
});
const R=fineRouter(1,{exactWalk:true});
for(const b of UNDERWORLD_BRAZIERS)test('normal entrance has checked activation-range approach to brazier '+b.index,()=>{
 const route=underworldRegionPlan(R.geo,null,{x:18944,y:23040},b,3);
 assert.equal(route.audit.ok,true,JSON.stringify(route.plan));assert.equal(route.plan.jumps,0);
 const points=route.plan.legs[0].waypoints;
 for(let i=1;i<points.length;i++)assert.ok(![...UNDERWORLD_TELEPORTERS,{row:16,col:16}].some(t=>crossesTrigger(points[i-1],points[i],t)));
 const p=points.at(-1),row=Math.floor(p.y/1024)+1,col=Math.floor(p.x/1024)+1;
 assert.ok(Math.abs(row-b.row)<=3&&Math.abs(col-b.col)<=3);
});
test('southern final activation has a short checked route onto the actual portal square',()=>{
 const route=underworldRegionPlan(R.geo,null,{x:11328,y:28208},{row:16,col:16},0,{allowCentral:true});
 assert.equal(route.audit.ok,true);assert.ok(route.plan.legs[0].waypoints.length<45);
 const end=route.plan.legs[0].waypoints.at(-1);
 assert.equal(end.row,16);assert.equal(end.col,16);
});
test('final switch approach rejects the low valley in favor of a short connected return',()=>{
 const at={x:5088,y:22032},b={row:31,col:15};
 const ordinary=underworldRegionPlan(R.geo,null,at,b,3),ordinaryEnd=ordinary.plan.legs[0].waypoints.at(-1);
 assert.equal(R.floorAt(ordinaryEnd.x,ordinaryEnd.y),1844);
 const timed=underworldRegionPlan(R.geo,null,at,b,3,{returnTo:{row:16,col:16}});
 assert.equal(timed.audit.ok,true);assert.equal(timed.return_route.audit.ok,true);
 assert.ok(timed.return_route.plan.legs[0].waypoints.length<=45);
 const end=timed.plan.legs[0].waypoints.at(-1);assert.ok(R.floorAt(end.x,end.y)>1844);
});
test('exact point plans keep the measured endpoint and refuse an unobserved closure point',()=>{
 const from={x:18944,y:23040},seen=R.closure(from),to=[...seen.values()].find(p=>p.x!==from.x);
 const plan=R.planWalkToPoint(from,to);assert.equal(plan.ok,true);
 assert.equal(plan.legs[0].waypoints.at(-1).x,to.x);assert.equal(plan.legs[0].waypoints.at(-1).y,to.y);
 assert.equal(R.planWalkToPoint(from,{x:to.x+0.1,y:to.y}).ok,false);
});
await assert.rejects(runUnderworldNode({world:{room:{num:52}}}),/existing_room_1/);checks++;
const exitSession={world:{room:{num:1}},client:{self:{row:1,col:1,x:64,y:64},room:{objects:new Map()}},
 async confirmPosition(){this.world.room.num=52;return {row:1,col:1};}};
assert.equal((await underworldPositionSnapshot(exitSession,{allowExit:true})).room,52);
await assert.rejects(underworldPositionSnapshot(exitSession),/left_before_completion/);checks++;

console.log(checks+' Underworld assertions passed');
