import assert from 'node:assert/strict';
import {Autopilot} from './m59-autopilot.mjs';
import {restoreReplayJourney,replayJourneyDestination,resumeReplayJourney} from './m59-replay-journey.mjs';
const fixture=()=>Object.assign(Object.create(Autopilot.prototype),{
  policy:{},claims:new Map(),book:{save(){}},note(){},
  roomOutranksUs:()=>true,sanctuary:()=>false,
  s:{name:null,world:{room:{num:598}},client:{vitals:()=>({health:{value:30,max:49}})}},
});
const saved={travelling:true,to:39,why:'supply run',at:Date.now()-30000,maxMs:900000,
  attempts:3,guard:{safe_spot:true,flee:false,rest:false}};
const old=fixture();old.inert=structuredClone(saved);old.goTravelling(saved.why,{to:saved.to});
assert.equal(old.s.shelterPolicy,undefined,'raw flag restoration reproduces the missing callbacks');
const k=fixture(),before=structuredClone(saved);
const restored=restoreReplayJourney(k,{inert:saved});
assert.equal(restored.shelter_callbacks,true);
assert.equal(k.s.shelterPolicy.need(),true,'the real shelter trigger sees current damage after restoration');
assert.equal(k.inert.at,saved.at);assert.equal(k.inert.maxMs,saved.maxMs);
assert.equal(k.inert.attempts,3);assert.equal(k.inert.guard.flee,false);assert.equal(k.inert.guard.rest,false);
assert.deepEqual(saved,before,'restoration cannot mutate the captured source');
const off=fixture();off.s.shelterPolicy={need:()=>true};
restoreReplayJourney(off,{inert:{...saved,guard:{safe_spot:false}}});
assert.equal(off.s.shelterPolicy,null,'explicit disabled shelters remain disabled without stale callbacks');
const held=fixture();const hold={why:'external errand',at:saved.at,maxMs:30000};
assert.equal(restoreReplayJourney(held,{inert:hold,suspendedJourney:{to:39}}).kind,'external_hold');
assert.deepEqual(held.inert,hold);assert.equal(held.s.shelterPolicy,undefined);
assert.equal(replayJourneyDestination({inert:hold,suspended_journey:{to:39}}),null);
assert.equal(replayJourneyDestination({inert:saved}),39);
assert.equal(replayJourneyDestination({suspended_journey:{to:39}}),39);
assert.equal(replayJourneyDestination({inert:{travelling:true,to:null}}),null);
let travelled=null,revived=false;
k.travel=async to=>{travelled=to;return {arrived:true,hop_wall_stops:1};};
k.s.travel=()=>assert.fail('replay bypassed keeper travel hooks');
k.revive=()=>{revived=true;k.inert=null;};
assert.deepEqual(await resumeReplayJourney(k,39),{arrived:true,hop_wall_stops:1});
assert.equal(travelled,39);assert.equal(revived,true);
const interrupted=fixture();restoreReplayJourney(interrupted,{inert:saved});
const replacement={why:'recovery',travelling:false};
interrupted.travel=async()=>{interrupted.inert=replacement;return {paused:true};};
interrupted.revive=()=>assert.fail('replay erased a replacement controller');
await resumeReplayJourney(interrupted,39);
assert.equal(interrupted.inert,replacement);
const retry=fixture();restoreReplayJourney(retry,{inert:saved});
retry.travel=async()=>({arrived:false,reason:'exit approach blocked'});
retry.revive=()=>{retry.inert=null;};
await resumeReplayJourney(retry,39);
assert.equal(retry.suspendedJourney.to,39);assert.equal(retry.suspendedJourney.attempts,4);
assert.equal(retry.suspendedJourney.trigger,'exit approach blocked');
const cancelled=fixture();restoreReplayJourney(cancelled,{inert:saved});
cancelled.travel=async()=>{cancelled.inert.cancelled=true;return {cancelled:true};};
cancelled.revive=()=>{cancelled.inert=null;};
await resumeReplayJourney(cancelled,39);assert.equal(cancelled.suspendedJourney,null);
console.log('Replay journey: reproduced missing callbacks; real shelter trigger, guards, deadlines, ownership and keeper travel hooks passed');
