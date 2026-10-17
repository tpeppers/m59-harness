import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bastionHarness} from './fixtures/bastion-fallback-client.mjs';
import {walkCheckedRail} from './m59-rail-walk.mjs';
import {clientToProtocol} from './m59-finepos.mjs';
import {ensureBraxApproach} from './m59-brax.mjs';
import {applyAncientFloors} from './m59-moving-platform.mjs';
const h=await bastionHarness(),{withBodyCommand}=await h.imp('m59-body-command.mjs');
const route=JSON.parse(readFileSync(ensureBraxApproach())).stones[0].routes[0];
const source=route.legs[0],leg={...source,sourceWaypoints:source.waypoints,waypoints:source.aims};
const f=h.fixture({from:{room:579,...clientToProtocol(leg.waypoints[0])}},{maxPackets:4096,maxMs:60000});
const next=route.legs[1],nextJump={room:579,from:next.from,to:next.to,from_fine:next.declared_from??next.fromFine,to_fine:next.declared_to??next.toFine};
const r=await withBodyCommand(f.s,()=>walkCheckedRail(f.s,{room:579,leg,nextJump}),'offline-native-rail');
assert(r.arrived||r.joined_takeoff,JSON.stringify(r));assert(f.packets.length>0);assert(f.packets.length<450,'normal strides avoid the old eight-unit packet crawl');
console.log('native Ancient first leg:',r.completed_aims,'aims,',f.packets.length,'ordinary packets, joins declared takeoff:',!!r.joined_takeoff);
const cancelled=h.fixture({from:{room:579,...clientToProtocol(leg.waypoints[0])}});let once=false;
const stopped=await withBodyCommand(cancelled.s,()=>walkCheckedRail(cancelled.s,{room:579,leg},{onProgress:()=>{if(!once){once=true;cancelled.s.movementGeneration++;}}}),'offline-native-cancel');
assert(stopped.cancelled);assert.equal(stopped.completed_aims,0);
const wrong=h.fixture({from:{room:579,...clientToProtocol(leg.waypoints[0])}});
assert.equal((await withBodyCommand(wrong.s,()=>walkCheckedRail(wrong.s,{room:826,leg}),'offline-native-room')).reason,'rail_room_or_geometry_changed');assert.equal(wrong.packets.length,0);
console.log('native rail generation cancellation and room fences passed');

for(const [index,source]of route.legs.entries()){
 if(index===0||source.kind!=='walk')continue;
 const leg={...source,sourceWaypoints:source.waypoints,waypoints:source.aims};
 const f=h.fixture({from:{room:579,...clientToProtocol(leg.waypoints[0])}},{maxPackets:4096,maxMs:60000});
 const r=await withBodyCommand(f.s,()=>walkCheckedRail(f.s,{room:579,leg}),'offline-native-rest-of-climb');
 assert(r.arrived,JSON.stringify({index,...r}));console.log('native Ancient walking leg',index,':',f.packets.length,'packets');
}

{
 const sample=JSON.parse(readFileSync(new URL('./fixtures/brax-south-queue.json',import.meta.url))),body=sample.actors[0];
 const make=()=>{
  const f=h.fixture({from:{room:579,...body},bodies:sample.actors.slice(1)},{bodies:true,maxPackets:100});
  applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(sample.floors).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>f.s.world.geometry});return f;
 };
 const leg={kind:'walk',waypoints:[sample.goal]},queued=make();
 const q=await withBodyCommand(queued.s,()=>walkCheckedRail(queued.s,{room:579,leg,queueEnd:true}),'offline-native-terminal-queue');
 assert(q.queue_ready&&!q.arrived,'a physical terminal crowd is queue-ready, never false exact arrival');
 const waiting=make();let wakes=0;
 const done=await withBodyCommand(waiting.s,()=>walkCheckedRail(waiting.s,{room:579,leg},{wait:async()=>{wakes++;for(const b of sample.actors.slice(1))waiting.c.room.objects.delete(b.id);}}),'offline-native-body-gap');
 assert(done.arrived);assert(wakes>0);assert(done.body_waits>0);assert.equal(waiting.s.railProgress.phase,'arrived');
 console.log('native captured South queue: waits locally behind a body and proceeds when its gap opens');
}

{
 const {Autopilot,scriptedWalkDefersArming}=await h.imp('m59-autopilot.mjs');
 const pilot={mode:'idle',policy:{},suspendedJourney:null,travelGuard:()=>({arm:false}),facultyOwner:()=> 'fleetscript:convoy',clearRefusal(){},waitingOn:null};
 assert(scriptedWalkDefersArming(pilot));
 for(const change of [{mode:'farm'},{facultyOwner:()=> 'keeper'},{travelGuard:()=>({arm:true})},{facultyOwner:key=>key==='movement'?'fleetscript:convoy':'keeper'}])assert(!scriptedWalkDefersArming({...pilot,...change}));
 await Autopilot.prototype.passArm.call(pilot,{s:{},c:{},room:{num:579}});
 console.log('scripted fine travel shares the normal arm=false doctrine; farming and explicit arm=true retain rearming');
}

{
 const f=h.fixture({from:{room:579,...clientToProtocol(leg.waypoints[0])}});let holds=2,wakes=0;
 f.s.pacer.holdStatus=()=>({active:holds>0});
 const r=await withBodyCommand(f.s,()=>walkCheckedRail(f.s,{room:579,leg:{...leg,waypoints:leg.waypoints.slice(0,3)}},{wait:async()=>{assert.equal(f.packets.length,0);holds--;wakes++;}}),'offline-native-trance-wait');
 assert(r.arrived);assert.equal(wakes,2);console.log('native rail waits an evidenced casting hold before submitting movement');
}

{
 const {crossCheckedRailExit}=await import('./m59-rail-walk.mjs');let calls=0,confirms=0,clock=0;
 const mock={movementGeneration:7,movementWasCancelled:g=>g!==7,world:{room:{num:579},exits:()=>[17,62].map(col=>({kind:'edge',to:578,direction:'north',stand_on:{row:1,col}}))},
  confirmPosition:async()=>{confirms++;return true;},leaveViaAny:async(candidates,options)=>{calls++;assert(options.exact);assert.equal(candidates.length,1);assert.equal(candidates[0].stand_on.col,62);return calls===1?{left:false,tried:[{stage:'walk',crossing_packet_sent:false,why:'object_blocked'}]}:{left:true};}};
 assert((await crossCheckedRailExit(mock,{to:578,row:1,col:62},{timeoutMs:1000,now:()=>clock,wait:async ms=>{clock+=ms;}})).left);assert.equal(calls,2);assert.equal(confirms,1);
 calls=0;assert.equal((await crossCheckedRailExit(mock,{to:578,row:1,col:62},{movementGeneration:6})).reason,'movement_cancelled');assert.equal(calls,0);
 assert.equal((await crossCheckedRailExit(mock,{to:578,row:99,col:62})).reason,'checked_exit_not_published');assert.equal(calls,0);
 mock.leaveViaAny=async()=>{calls++;return {left:false,tried:[{stage:'cross',crossing_packet_sent:true,why:'object_blocked'}]};};
 assert(!(await crossCheckedRailExit(mock,{to:578,row:1,col:62})).left);assert.equal(calls,1,'an already-sent or ambiguous crossing is not repeated');
 console.log('native exact exit: published branch, actual cancellation generation, bounded unsent-body retry and no repeated ambiguous crossing');
}

{
 const {Autopilot,scriptedWalkDefersVigorRest}=await h.imp('m59-autopilot.mjs'),{chooseSurvivalDecision,currentSurvivalDecision}=await h.imp('m59-survival-decision.mjs');
 const captured=JSON.parse(readFileSync(new URL('./fixtures/brax-corner-vigor-rest.json',import.meta.url))),v={health:captured.hp,vigor:captured.vigor};
 const s={client:{self:captured.you,selfId:captured.you.id,room:{objects:new Map()},vitals:()=>v,ailments:()=>[]},world:{room:captured.room},movementGeneration:5};
 const pilot={s,mode:'idle',policy:{},stopping:false,facultyOwner:()=> 'fleetscript:walk-to-brax (public)',facultyHeld:()=>false,travelGuard:()=>({rest:false}),operatorSurvivalStandDown:()=>false};
 assert(scriptedWalkDefersVigorRest(pilot,v));
 for(const change of [{mode:'farm'},{stopping:true},{recoverUntilWhole:true},{suspendedJourney:{to:827}},{facultyOwner:()=> 'keeper'},{facultyOwner:k=>k==='movement'?'fleetscript:walk-to-brax (public)':'keeper'},{facultyHeld:()=>true},{travelGuard:()=>({rest:true})}])assert(!scriptedWalkDefersVigorRest({...pilot,...change},v));
 assert(!scriptedWalkDefersVigorRest(pilot,{...v,health:{value:19,max:20}}));assert(!scriptedWalkDefersVigorRest(pilot,{...v,vigor:{value:39}}));
 assert(!scriptedWalkDefersVigorRest({...pilot,s:{...s,client:{...s.client,ailments:()=>['poison']}}},v));
 const pending=chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:captured.decision.original_reason,status:'pending'});
 assert.equal(await Autopilot.prototype.continueSurvivalDecisionStep.call(pilot),false);
 assert.equal(currentSurvivalDecision(s),null);assert.equal(pending.outcome,'recovered');
 console.log('captured full-health78-vigor lever worker: existing scripted road doctrine completes nonurgent recovery; wounds, exhaustion, ailments, post-death recovery and foreign/protected ownership retain recovery');
}
