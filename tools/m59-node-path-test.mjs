#!/usr/bin/env node
// Offline regression: node route corners, Peak candidate falls, wire rounding and confirmed arrivals.
import assert from 'node:assert/strict';
import {runNodeJourney} from './m59-node-journey.mjs';
import {findPath} from './m59-map.mjs';
import {sessionWalkPrototype} from './m59-session-walk.mjs';
import {MAX_STEP_HEIGHT} from './m59-roo.mjs';
import {fineRouter,checkedWalkWaypoints,proveCandidateFall} from './m59-fineroute.mjs';
import {auditNodeWalk} from './m59-node-route-audit.mjs';
import {previewOpenedDoor} from './m59-ceiling-doors.mjs';
import {readFileSync} from 'node:fs';
let count=0;
async function test(name,fn){await fn();console.log('ok '+name);count++;}
const walk=sessionWalkPrototype({FINE_STRIDE:48,FINE_STRIDE_MAX:80,MAX_STEP_HEIGHT}).walkFine;
function fixture({confirm='same',shelf=false,stuck=false}={}){
  let cancelled=false,confirmed=false;
  const c={room:{id:750},self:{x:0,y:100,row:1,col:1}};
  const geo={leafAtClient:()=>({sector:{}}),floorBaseAtClient:()=>confirmed&&confirm==='fall'?0:3200};
  const s={need:()=>c,client:c,world:{room:{num:750},geometry:shelf?geo:null},movementGeneration:1,
    movementWasCancelled:()=>cancelled,cancelledMovement:()=>({arrived:false,cancelled:true}),
    validateFineTarget:(x,y)=>({moved:true,target:{x,y}}),
    async stepFine(x,y){if(!stuck||c.self.x===0){c.self={...c.self,x:stuck?80:x,y};}return {moved:true,position:{...c.self}};},
    async confirmPosition(){confirmed=true;if(confirm==='cancel')cancelled=true;if(confirm==='room')c.room.id=1;
      if(confirm==='away')c.self.x=0;if(confirm==='timeout')return null;return {row:c.self.row,col:c.self.col};}};
  return {s,c};
}
await test('the last allowed step succeeds only after a fresh server endpoint',async()=>{
  const {s}=fixture();const r=await walk.call(s,32,100,{maxSteps:1,stride:32,arriveWithin:3});
  assert.equal(r.arrived,true);assert.equal(r.steps,1);assert.equal(r.position.x,32);
});
for(const kind of ['away','timeout','fall'])await test('predicted final arrival refuses server '+kind,async()=>{
  const {s}=fixture({confirm:kind,shelf:kind==='fall'});assert.equal((await walk.call(s,32,100,{maxSteps:1,stride:32,arriveWithin:3,holdShelf:kind==='fall'})).arrived,false);
});
await test('final confirmation preserves cancellation and room boundaries',async()=>{
  const a=fixture({confirm:'cancel'}),b=fixture({confirm:'room'});
  assert.equal((await walk.call(a.s,32,100,{maxSteps:1,stride:32,arriveWithin:3})).cancelled,true);
  assert.equal((await walk.call(b.s,32,100,{maxSteps:1,stride:32,arriveWithin:3})).left_room,true);
});
await test('checked bends cannot succeed twenty wire units short of a three-unit tolerance',async()=>{
  const {s}=fixture({stuck:true});const r=await walk.call(s,100,100,{maxSteps:8,stride:80,arriveWithin:3,exactArrival:true});
  assert.equal(r.arrived,false);
});
await test('a precise corner correction stays inside a narrow legal corridor',async()=>{
  const {s,c}=fixture();c.self.x=97;c.self.y=99;
  const valid=(x,y)=>x>=97&&x<=100&&y>=99&&y<=100;
  s.validateFineTarget=(x,y)=>({moved:valid(x,y),target:{x,y}});
  s.stepFine=async(x,y)=>{if(!valid(x,y))return {moved:false,reason:'wall'};
    c.self={...c.self,x,y};return {moved:true,position:{...c.self}};};
  const r=await walk.call(s,100,100,{maxSteps:1,stride:32,arriveWithin:3,exactArrival:true});
  assert.equal(r.arrived,true);assert.equal(c.self.x,100);assert.equal(c.self.y,100);
});
await test('compression keeps a necessary right-angle corner',()=>{
  const geo={traceFineMoveClient:(ax,ay,bx,by)=>({arrived:ax===bx||ay===by})};
  const p=[{x:0,y:0},{x:0,y:10},{x:10,y:10}];assert.deepEqual(checkedWalkWaypoints(geo,p).points,p);
});
await test('clipped dense edges fail checked mode but remain explicit for legacy rail repair',()=>{
  const geo={traceFineMoveClient:()=>({arrived:false,moved:true})},p=[{x:0,y:0},{x:1,y:1}];
  assert.equal(checkedWalkWaypoints(geo,p).ok,false);
  const old=checkedWalkWaypoints(geo,p,{allowUnprovedEdges:true});assert.equal(old.ok,true);assert.equal(old.unproved.length,1);
});
await test('checked mode refuses an untraced height-only flood',()=>assert.throws(()=>fineRouter(750,{exactWalk:true,strict:false}),/collision tracing/));
await test('Ice entry reaches the real door trigger with every fine and integer-wire chord proved',()=>{
  const R=fineRouter(750,{exactWalk:true}),plan=R.plan({row:46,col:25,x:25088,y:46592},{row:24,col:10},{maxJumps:0});
  const report=auditNodeWalk(plan,R.geo);assert.equal(report.ok,true,JSON.stringify(report.failures[0]));assert.equal(plan.jumps,0);
  assert.ok(plan.legs[0].waypoints.length>100);assert.equal(plan.legs[0].walk_proof.checked,true);
});
await test('timed-door preview leaves live geometry closed and preserves the separate mana gate',()=>{
  const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url))),
    closed=fineRouter(750,{worldMap:map,exactWalk:true}),observed=new Map([[1,{type:5,height:380}],[2,{type:5,height:380}]]),
    preview=previewOpenedDoor(map,750,1,{observed});
  assert.equal(preview.conditional,true);assert.equal(preview.state,'448,380');
  assert.equal(closed.geo.sectors[171].ceilingHeight,6080);assert.equal(preview.geometry.sectors[171].ceilingHeight,7168);
  assert.equal(preview.geometry.sectors[176].ceilingHeight,6080);
  const open=fineRouter(750,{worldMap:map,geometry:preview.geometry,exactWalk:true});
  const plan=open.plan({row:24,col:10,x:9216,y:23568},{row:25,col:20},{maxJumps:0});assert.equal(auditNodeWalk(plan,open.geo).ok,true);
  assert.equal(closed.plan({row:25,col:20},{row:24,col:10},{maxJumps:0}).ok,false);
  assert.equal(closed.plan({row:25,col:20},{row:24,col:11},{maxJumps:0}).ok,true);
  assert.equal(previewOpenedDoor(map,750,999),null);
});
await test('Vale normal entry reaches the exact spawn square and has a checked walking return',()=>{
  const R=fineRouter(532,{exactWalk:true}),out=R.plan({x:29184,y:512},{row:23,col:30},{maxJumps:0});
  assert.equal(auditNodeWalk(out,R.geo).ok,true);assert.equal(out.jumps,0);
  const back=R.plan(out.legs[0].waypoints.at(-1),{row:1,col:29},{maxJumps:0});
  assert.equal(auditNodeWalk(back,R.geo).ok,true);
});
const peak=fineRouter(515,{exactWalk:true});
await test('failed low takeoffs do not erase all Peak landing proposals from higher shelves',()=>{
  const seen=peak.closure({x:31232,y:50688}),audit={};
  const c=peak.candidateJumps(seen,peak.footing(20,17),{audit,prove:false});
  // The old landing-key cache marked every landing tried BEFORE its first failed arc.
  assert.ok(c.length>0);assert.ok(c.some(p=>peak.floorAt(p.fromFine.x,p.fromFine.y)===8896));
  assert.ok(audit.rejections.fall_span_exceeds_budget>0);
});
await test('candidate falls reject void endpoints and walls rather than accepting footprint heights',()=>{
  const noFloor=proveCandidateFall(peak.geo,{fromFine:{x:9984,y:19552},toFine:{x:10376,y:20498}});
  assert.equal(noFloor.reason,'endpoint_has_no_floor');
  const wall=proveCandidateFall(peak.geo,{fromFine:{x:9216,y:19456},toFine:{x:10240,y:19456}});
  assert.equal(wall.model_proved,false);assert.equal(wall.trace.arrived,false);
});
await test('shared physical bounds permit a checked small uphill fall but reject a larger rise',()=>{
  const a={x:27936,y:30400},b={x:28660,y:29676};
  const valid=proveCandidateFall(peak.geo,{fromFine:a,toFine:b});
  assert.equal(valid.to_floor_client-valid.from_floor_client,128);assert.equal(valid.model_proved,true);
  const high=proveCandidateFall(peak.geo,{fromFine:{x:9984,y:21760},toFine:{x:9984,y:22192}});
  assert.equal(high.reason,'fall_span_exceeds_actual_floor_budget');
});
await test('Peak upper-stair candidate plan contains a proved fall and checked walk chords',()=>{
  const p=peak.plan({x:5824,y:24000},{row:20,col:17},{allowCandidates:true,maxJumps:1,branch:24});
  assert.equal(p.ok,true,p.why);assert.equal(p.jumps,1);assert.equal(p.all_declared,false);
  assert.equal(auditNodeWalk(p,peak.geo).ok,true);
  assert.ok(p.legs.filter(l=>l.kind==='jump').every(j=>proveCandidateFall(peak.geo,j).model_proved));
});
await test('connected node arrival requires a fresh endpoint in the destination room',async()=>{
  const fixture=(finalRoom,confirm=true,cancel=false)=>{
    const s={world:{room:{num:200}},client:{self:{row:56,col:39,x:2528,y:3616}},movementGeneration:1,
      movementWasCancelled:()=>cancel,confirmPosition:async()=>confirm,
      async travel(to,{onHop}){this.world.room.num=finalRoom;await onHop({room:{num:finalRoom},hop:1});return {arrived:true};}};
    return s;
  };
  assert.equal((await runNodeJourney(fixture(532),532)).arrived,true);
  assert.equal((await runNodeJourney(fixture(531),532)).arrived,false);
  assert.equal((await runNodeJourney(fixture(532,false),532)).arrived,false);
  assert.equal((await runNodeJourney(fixture(532,true,true),532)).arrived,false);
});
await test('connected node trial preserves evidence of every ordinary travel crossing',async()=>{
  const seen=[],s={world:{room:{num:200}},client:{self:{row:56,col:39,x:2528,y:3616}},movementGeneration:1,
    movementWasCancelled:()=>false,confirmPosition:async()=>true,
    async travel(to,{onHop}){for(const [i,room] of [534,533,542,541,531,532].entries()){
      this.world.room.num=room;await onHop({room:{num:room},hop:i+1});}return {arrived:true,hops:6,total_stumbles:0};}};
  const result=await runNodeJourney(s,532,{onHop:h=>seen.push(h.position.room)});
  assert.equal(result.arrived,true);assert.equal(result.start.room,200);assert.equal(result.end.room,532);
  assert.deepEqual(seen,[534,533,542,541,531,532]);assert.equal(result.hops.length,6);
});
await test('Marion-to-Vale graph includes the coded town exit and actual forest crossings',()=>{
  const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url)));
  const out=findPath(map,200,532),back=findPath(map,532,200);
  assert.equal(out.found,true);assert.deepEqual(out.hops.map(h=>h.to),[534,533,542,541,531,532]);
  assert.equal(out.hops[0].kind,'region');assert.equal(back.found,true);
  assert.deepEqual(back.hops.map(h=>h.to),[531,541,542,533,534,200]);
});
console.log(count+' checked node path assertions passed');
