#!/usr/bin/env node
// Offline regression: Ice route corners, wire rounding, and final-step server confirmation.
import assert from 'node:assert/strict';
import {sessionWalkPrototype} from './m59-session-walk.mjs';
import {MAX_STEP_HEIGHT} from './m59-roo.mjs';
import {fineRouter,checkedWalkWaypoints} from './m59-fineroute.mjs';
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
console.log(count+' checked node path assertions passed');
