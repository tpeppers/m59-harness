import assert from 'node:assert/strict';
import {keeperRecoveryRescueReady} from './m59-move-origin.mjs';
import {Autopilot} from './m59-autopilot.mjs';
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
