import assert from 'node:assert/strict';
import {test} from 'node:test';
import {keeperRecoveryRescueReady} from './m59-move-origin.mjs';
import {Autopilot} from './m59-autopilot.mjs';
import {roomGeometry} from './m59-ground.mjs';
import {chooseSurvivalDecision} from './m59-survival-decision.mjs';
import * as wd from './m59-watchdog.mjs';
const now=Date.now();
const s={movementGeneration:4,moveOrder:{generation:4,origin:{source:'keeper',name:'shelter'},at:now-1500}};
assert(!keeperRecoveryRescueReady(s,now-10000,now,4000),'the old body stall cannot age a new recovery');
assert(keeperRecoveryRescueReady(s,now-10000,now+3000,4000),'a genuinely stalled recovery remains bounded');
s.moveOrder.origin.source='fleetscript';assert(keeperRecoveryRescueReady(s,now-10000,now,4000),'fresh external replans do not mask a stalled driver');
s.moveOrder.origin.source='keeper';s.moveOrder.generation=3;assert(keeperRecoveryRescueReady(s,now-10000,now,4000),'a cancelled generation cannot retain the recovery window');
function host(age){
 let cancelled=0;const at=Date.now();
 const h=Object.assign(Object.create(Autopilot.prototype),{doing:null,inert:{why:'external errand'},hold:null,passes:1,tally:{},policy:{},
  s:{live:true,movementGeneration:4,client:{state:'game',room:{id:2500},self:{row:29,col:21},vitals:()=>({health:{value:6,max:20}})},
    moveOrder:{generation:4,origin:{source:'keeper',name:'shelter'},at:at-age},cancelMovement:()=>{cancelled++;return {}; }},
  watch:{...wd.freshState(),lastPulseAt:at,lastHealth:6,wedged:{since:at-10000,inert:true,taking_hits:true,at:{room:2500,row:29,col:21}}},
  safety:()=>({fleeAt:.7}),lastFrameAt:at,recordFrame(){this.lastFrameAt=Date.now();},note:()=>{},progress:()=>{},
  checkFreeze:()=>false,fightBackCheck:()=>{},clearPathCheck:()=>{},pulsePosition:()=>{},
  facultyHeld:()=>true,facultyOwner:()=> 'fleetscript:courier',suspendJourney:()=>{},revive:()=>{},
  cancelForSurvival:()=>{cancelled++;return {};}});
 return {h,count:()=>cancelled};
}
for(const tick of [wd.tick,h=>Autopilot.prototype.watchdogTick.call(h)]){
 const fresh=host(1500);tick(fresh.h);assert.equal(fresh.count(),0,'the real watchdog must not cancel a new keeper approach');
 const stalled=host(6000);tick(stalled.h);assert.equal(stalled.count(),1,'the real watchdog still rescues an overdue keeper move');
}
for(const age of [1500,6000]){
 const sample=host(age);sample.h.inert.travelling=true;
 Autopilot.prototype.watchdogTick.call(sample.h);
 assert.equal(sample.count(),age===1500?0:1,'the journey watchdog uses the same recovery window');
}
console.log('Both real watchdogs distinguish the new recovery driver from the old physical stall, without exempting an overdue or external driver.');

function recordedApproach(){
 const f=host(6000),h=f.h,s=h.s,c=s.client;
 c.self={id:1,row:52,col:15,x:1000,y:3344};c.selfId=1;c.room={id:2502,objects:new Map()};
 s.world={room:{num:2502},geometry:roomGeometry(2502)};
 h.inert={why:'external journey',travelling:true};h.facultyHeld=key=>key==='movement';
 h.noteUnreachableSpot=()=>{};h.rememberSurvivalJam=()=>{};
 const target={row:51,col:16,fine:{x:1024,y:3320}};
 chooseSurvivalDecision(s,{strategy:'nearest_refuge',status:'approaching',chosen_refuge:{room:2502,row:51,col:16}});
 const stop=h.watchRecoveryApproach(target);
 const wedge=()=>{h.watch.lastPulseAt=Date.now();h.lastFrameAt=Date.now();h.watch.wedged={since:Date.now()-10000,
  inert:true,taking_hits:true,at:{room:2502,row:52,col:15}};};
 return {...f,s,c,stop,wedge};
}
for(const [name,tick] of [['pulse',wd.tick],['keeper',h=>Autopilot.prototype.watchdogTick.call(h)]]){
 test(name+' watchdog retains recent confirmed fine recovery progress, then rescues stale progress',t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:100000});
  const f=recordedApproach();
  t.mock.timers.tick(1500);Object.assign(f.c.self,{x:1008,y:3336});t.mock.timers.tick(500);
  t.mock.timers.tick(2500);f.wedge();tick(f.h);
  assert.equal(f.count(),0,'the recorded final sub-square advance is not the old stalled script');
  t.mock.timers.tick(2000);f.wedge();tick(f.h);
  assert.equal(f.count(),1,'confirmed progress is bounded rather than a permanent exemption');
  f.stop();assert.equal(f.s.keeperRecoveryApproach,undefined);
 });
}
test('predicted movement and revisiting an old best point cannot renew the recovery lease',t=>{
 t.mock.timers.enable({apis:['Date','setInterval'],now:100000});
 const f=recordedApproach();
 t.mock.timers.tick(1500);Object.assign(f.c.self,{x:1008,y:3336,predicted:true});t.mock.timers.tick(3000);
 assert(keeperRecoveryRescueReady(f.s,90000,Date.now(),4000));
 delete f.c.self.predicted;t.mock.timers.tick(500);const bestAt=f.s.keeperRecoveryApproach.progress.progressedAt;
 Object.assign(f.c.self,{x:1000,y:3344});t.mock.timers.tick(1000);
 Object.assign(f.c.self,{x:1008,y:3336});t.mock.timers.tick(3500);
 assert.equal(f.s.keeperRecoveryApproach.progress.progressedAt,bestAt);
 assert(keeperRecoveryRescueReady(f.s,90000,Date.now(),4000));f.stop();
});
for(const change of ['generation','client','room','life','decision','human','external order','closed'])
 test('a recovery progress lease cannot survive '+change,t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:100000});
  const f=recordedApproach();t.mock.timers.tick(1500);Object.assign(f.c.self,{x:1008,y:3336});t.mock.timers.tick(500);
  if(change==='generation')f.s.movementGeneration++;
  if(change==='client')f.s.client={...f.c};
  if(change==='room')f.s.world.room.num=2503;
  if(change==='life')f.s.lifeBoundary=1;
  if(change==='decision')chooseSurvivalDecision(f.s,{strategy:'rest_safe'});
  if(change==='human')f.h.inert={by:'human'};
  if(change==='external order')f.s.moveOrder.origin.source='fleetscript';
  if(change==='closed')f.stop();
  assert(keeperRecoveryRescueReady(f.s,90000,Date.now(),4000),change+' cannot hide an old body stall');f.stop();
 });
