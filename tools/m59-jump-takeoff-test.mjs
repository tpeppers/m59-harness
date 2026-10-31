import assert from 'node:assert/strict';
import {roomGeometry} from './m59-ground.mjs';
import {fallJumpsIn} from './m59-falljump.mjs';
import {planDeclaredTakeoff,declaredJumpMoveOptions,canJoinDeclaredTakeoff} from './m59-jump-takeoff.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {traceFallMotion} from './m59-falltrace.mjs';
const geo=roomGeometry(2502),declaration=fallJumpsIn(2502).find(j=>j.to.row===40&&j.to.col===29),body={x:2200,y:2648};
const from=protocolToClient(body),landing=declaration.to_fine;
// 2026-10-31 (docs/falljump-audit-2026-10-31.md): the declaration now names the far LIP of the pit,
// r40c29, not a point a walk away across the plateau. From the old approach point on the 8000
// shelf the run goes up the 8000-8465 ramp and leaves its top edge, so it is itself a timed flight.
assert.equal(traceFallMotion(geo,from.x,from.y,landing.x,landing.y).arrived,true,'the approach shelf is a run-up takeoff for the lip landing');
const p=planDeclaredTakeoff(geo,body,declaration);
assert(p.found,JSON.stringify(p));
assert(Math.abs(Math.floor(p.takeoff.y/64)-declaration.from.row)<=1);
assert(Math.abs(Math.floor(p.takeoff.x/64)-declaration.from.col)<=1);
const takeoff=protocolToClient(p.takeoff);
assert.equal(geo.traceFineMoveClient(from.x,from.y,takeoff.x,takeoff.y,{slide:false}).arrived,true);
for(const dt of [8,16,33,50]){
 const flight=traceFallMotion(geo,takeoff.x,takeoff.y,landing.x,landing.y,{dt,recordFrames:true});
 assert.equal(flight.arrived,true);assert.equal(flight.destinationFloor,8000);
 assert(flight.fall_motion.frames.every(f=>f.floor-f.z<=384));
}
assert.equal(declaredJumpMoveOptions(null,200).ok,false);
for(const vigor of [undefined,null,NaN,0,11])assert.equal(declaredJumpMoveOptions(declaration,vigor).ok,false);
assert.deepEqual(declaredJumpMoveOptions(declaration,12).options,{fall:true,timedFall:true,aimX:1884,aimY:2572});
assert.equal(planDeclaredTakeoff(geo,{x:1891,y:2589},declaration).reason,'declared_takeoff_wrong_shelf');
assert.equal(planDeclaredTakeoff(geo,body,declaration,{maxMs:0}).reason,'takeoff_search_budget');
const blocked=planDeclaredTakeoff(geo,body,declaration,{objects:new Map([[9,{id:9,flags:9,x:1884,y:2572}]])});
assert.equal(blocked.found,false,'an occupied landing cannot be planned as clear');
console.log('Declared takeoffs refine on the same ledge, retain running guards, and pass stock gravity at four frame intervals.');

const ancient=roomGeometry(579),first=fallJumpsIn(579).find(j=>j.from.row===40&&j.from.col===33&&j.to.col===32),readyBody={x:2152,y:2640};
const ready=planDeclaredTakeoff(ancient,readyBody,first);
assert(ready.found);assert.deepEqual(ready.takeoff,readyBody,'a valid actual takeoff needs no unreachable micro-alignment');
const crowded=planDeclaredTakeoff(ancient,readyBody,first,{objects:new Map([[9,{id:9,flags:9,x:2083,y:2569}]])});
assert.equal(crowded.found,false);assert(planDeclaredTakeoff(ancient,readyBody,first).found,'traffic refusal is distinct from absent terrain');

assert(canJoinDeclaredTakeoff(ancient,{x:2146,y:2614},first),'front rider beyond the last walking aim can join its proved takeoff');
assert(!canJoinDeclaredTakeoff(ancient,{x:2075,y:2585},first),'a missed landing in the gully cannot skip the climb');
assert(!canJoinDeclaredTakeoff(ancient,{x:4700,y:2400},first),'the local crossing proof is not an across-room shortcut');

// Captured convoy: the timed tracer slides round a nearby follower and reports
// arrived, while Session.step correctly refuses its occupied straight lane.
{
 const actor={x:2160,y:2648},objects=new Map([[9,{id:9,flags:5,x:2145,y:2654}]]);
 const blocked=planDeclaredTakeoff(ancient,actor,first,{objects,selfId:1});assert.equal(blocked.found,false,'an occupied straight lane waits instead of trusting a sliding trace');
 const front=planDeclaredTakeoff(ancient,{x:2145,y:2654},first,{objects:new Map([[10,{id:10,flags:5,...actor}]]),selfId:9});assert(front.found,'the body physically ahead can clear first');
 const plan=planDeclaredTakeoff(ancient,actor,first,{objects:new Map(),selfId:1});assert(plan.found,'the waiting body becomes eligible when the front clears');
 const {bastionHarness}=await import('./fixtures/bastion-fallback-client.mjs'),h=await bastionHarness(),{withBodyCommand}=await h.imp('m59-body-command.mjs');
 const lead=h.fixture({from:{room:579,x:2145,y:2654},bodies:[{id:10,flags:5,...actor,nameRsc:10}]},{bodies:true,maxMs:15000,maxPackets:40});
 const departed=await withBodyCommand(lead.s,async()=>{const w=await lead.s.walkFine(front.takeoff.x,front.takeoff.y,{stride:8,maxSteps:32,arriveWithin:0,exactArrival:true,holdShelf:true});assert(w.arrived,JSON.stringify(w));return lead.s.step(32,40,{fall:true,timedFall:true,aimX:2083,aimY:2569});},'front-native-crossing');
 assert(departed.moved,JSON.stringify(departed));
 const f=h.fixture({from:{room:579,...actor},bodies:[]},{bodies:true,maxMs:15000,maxPackets:40});
 const result=await withBodyCommand(f.s,async()=>{const w=await f.s.walkFine(plan.takeoff.x,plan.takeoff.y,{stride:8,maxSteps:32,arriveWithin:0,exactArrival:true,holdShelf:true});assert(w.arrived,JSON.stringify(w));return await f.s.step(32,40,{fall:true,timedFall:true,aimX:2083,aimY:2569});},'proved-native-takeoff-lane');
 assert(result.moved,JSON.stringify(result));assert.deepEqual({x:f.c.self.x,y:f.c.self.y},{x:2083,y:2569});
}

{
 const plan=planDeclaredTakeoff(ancient,{x:2215,y:2698},first);assert(plan.found,JSON.stringify(plan));
 assert(Math.abs(Math.floor(plan.takeoff.y/64)-first.from.row)<=1);assert(Math.abs(Math.floor(plan.takeoff.x/64)-first.from.col)<=1);
 assert.notDeepEqual(plan.takeoff,{x:2215,y:2698},'a physically valid but undeclared source must first walk into the public jump neighborhood');
}

{
 const {readFileSync}=await import('node:fs');const f=JSON.parse(readFileSync(new URL('./fixtures/cliff-convoy-choke.json',import.meta.url))),objects=new Map(f.actors.map(o=>[o.id,o]));
 const head=f.actors[0],ready=planDeclaredTakeoff(ancient,head,first,{objects,selfId:head.id});
 assert(ready.found,JSON.stringify(ready));assert(canJoinDeclaredTakeoff(ancient,head,first,{objects,selfId:head.id}),'the physically ahead body joins its usable crossing instead of waiting for a rear approach owner');
 const from=protocolToClient(head),to=protocolToClient(ready.takeoff),{blockingBodySnapshot}=await import('./m59-body-detour.mjs');
 assert(ancient.traceFineMoveClient(from.x,from.y,to.x,to.y,{slide:false,obstacles:blockingBodySnapshot(objects,head.id)}).arrived);
}

// All seven bodies from the live ownership deadlock can clear through real
// Session walking, flight and post-landing movement, in physical readiness order.
{
 const {readFileSync}=await import('node:fs'),{bastionHarness}=await import('./fixtures/bastion-fallback-client.mjs');
 const f=JSON.parse(readFileSync(new URL('./fixtures/cliff-convoy-choke.json',import.meta.url))),left=new Map(f.actors.map(o=>[o.id,o])),h=await bastionHarness(),{withBodyCommand}=await h.imp('m59-body-command.mjs');
 let completed=0;
 while(left.size){
  let ready;for(const actor of left.values()){const plan=planDeclaredTakeoff(ancient,actor,first,{objects:left,selfId:actor.id});if(plan.found){ready={actor,plan};break;}}
  assert(ready,'a physically ready head must exist for the captured convoy');const {actor,plan}=ready;
  const native=h.fixture({from:{room:579,x:actor.x,y:actor.y},bodies:[...left.values()].filter(o=>o.id!==actor.id).map((o,i)=>({...o,id:10+i,nameRsc:10+i}))},{bodies:true,maxMs:15000,maxPackets:120});
  await withBodyCommand(native.s,async()=>{
   const approach=await native.s.walkFine(plan.takeoff.x,plan.takeoff.y,{stride:8,maxSteps:32,arriveWithin:0,exactArrival:true,holdShelf:true});assert(approach.arrived,JSON.stringify(approach));
   const flight=await native.s.step(32,40,{fall:true,timedFall:true,aimX:2083,aimY:2569});assert(flight.moved,JSON.stringify(flight));
   const clear=await native.s.walkFine(f.clearance.x,f.clearance.y,{stride:8,maxSteps:48,arriveWithin:0,exactArrival:true,holdShelf:true});assert(clear.arrived,JSON.stringify(clear));
   assert(Math.hypot(native.c.self.x-2083,native.c.self.y-2569)>=32,'landing must actually clear before admitting the next body');
  },'captured-convoy');
  left.delete(actor.id);completed++;
 }
 assert.equal(completed,7);
}

// Test native posture through the real Session guard, including a cast hold
// and a takeover while the stand is queued.
{
 const {prepareDeclaredJump}=await import('./m59-jump-takeoff.mjs');
 const {bastionHarness}=await import('./fixtures/bastion-fallback-client.mjs');
 const h=await bastionHarness(),{withBodyCommand}=await h.imp('m59-body-command.mjs');
 const f=h.fixture({from:{room:579,x:3552,y:992}});let stands=0;
 f.c.stand=()=>{stands++;f.c.lastPostureCommand={verb:'stand',room_object_id:f.c.room.id};};
 const prepare=options=>withBodyCommand(f.s,()=>prepareDeclaredJump(f.s,options),'native-jump-posture');
 assert((await prepare()).ok);assert.equal(stands,1);
 assert((await prepare()).ok);assert.equal(stands,1,'already standing skips per-rider stat/stand work');
 f.c.lastPostureCommand={verb:'rest',room_object_id:f.c.room.id};
 let clock=0;f.s.pacer.holdStatus=()=>({active:clock<250});
 assert((await prepare({now:()=>clock,wait:async ms=>{assert.equal(stands,1);clock+=ms;}})).ok);
 assert.equal(stands,2,'stand occurs after the cast hold ends');
 f.c.lastPostureCommand={verb:'rest',room_object_id:f.c.room.id};
 const submit=f.s.pacer.submit.bind(f.s.pacer);f.s.pacer.submit=async(kind,run,...args)=>{if(kind==='rest')f.s.movementGeneration++;return submit(kind,run,...args);};
 f.s.pacer.holdStatus=()=>({active:false});
 assert((await prepare()).cancelled);assert.equal(stands,2,'queued takeover sends no stale stand');assert.equal(f.packets.length,0);
 const {readFileSync}=await import('node:fs');const source=readFileSync(new URL('./m59-keeper-process.mjs',import.meta.url),'utf8');
 assert(source.indexOf('const posture=await prepareDeclaredJump(session)')<source.indexOf('const r = await session.step(toCol, toRow, move.options)'),'native jump actually owns the posture guard');
 console.log('native jump posture: existing stand reused; cast hold and queued cancellation preserved without stat refreshes');
}
