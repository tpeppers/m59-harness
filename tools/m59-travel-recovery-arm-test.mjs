// Offline: interrupted travel keeps its arming guard while later survival gates still run.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {freshState} from './m59-watchdog.mjs';
const {Autopilot,CONTINUE}=await import(process.env.M59_TEST_AUTOPILOT ?? './m59-autopilot.mjs');
function fixture(policy={},suspended=true){
  const calls=[],k=Object.assign(Object.create(Autopilot.prototype),{policy,
    suspendedJourney:suspended?{to:39,at:Date.now()}:null,
    waitingOn:{code:'MANA_FOR_CREATE_WEAPON'},s:{client:{}},
    clearRefusal:code=>calls.push(code),doneWaiting:()=>{calls.push('done_waiting');},
    trainingStyleFor:()=>{throw Error('ordinary arming reached');}});
  return {k,calls};
}
test('a retained journey proceeds to survival/resume without a weapon-factory wait',async()=>{
  const {k,calls}=fixture();
  assert.equal(await k.passArm({s:k.s,c:k.s.client}),CONTINUE);
  assert.ok(calls.includes('done_waiting'));assert.ok(calls.includes('UNARMED_CANNOT_CAST'));
  assert.equal(k.suspendedJourney.to,39,'the guard does not dispatch or replace the destination');
});
test('an explicit arm guard still requires the normal arming stage',async()=>{
  const {k}=fixture({travelGuard:{arm:true}});
  await assert.rejects(k.passArm({s:k.s,c:k.s.client}),/ordinary arming reached/);
});
test('retiring the journey restores ordinary arming',async()=>{
  const {k}=fixture({},false);
  await assert.rejects(k.passArm({s:k.s,c:k.s.client}),/ordinary arming reached/);
});

test('a suspended per-order arm requirement overrides permissive policy',async()=>{
  const {k}=fixture({travelGuard:{arm:false}});k.suspendedJourney.guard={arm:true};
  await assert.rejects(k.passArm({s:k.s,c:k.s.client}),/ordinary arming reached/);
});
test('suspension preserves a copy of the effective journey guard',()=>{
  const {k}=fixture({},false);k.tally={deaths:0};k.inert={travelling:true,to:39,guard:{arm:true}};
  assert.equal(k.suspendJourney('test'),true);assert.equal(k.suspendedJourney.guard.arm,true);
  k.inert.guard.arm=false;assert.equal(k.suspendedJourney.guard.arm,true);
});

test('the watchdog keeps the issuer and guards before cancelling a wounded journey',()=>{
  const {k}=fixture({},false),origin={source:'fleetscript',name:'courier',run_id:'one'};
  const now=Date.now();let cancellations=0;
  Object.assign(k,{tally:{deaths:0},passes:1,watch:freshState(),claims:new Map(),doing:'travelling',
    inert:{travelling:true,to:2501,guard:{arm:false,safe_spot:true}},
    recordFrame:()=>{},checkFreeze:()=>false,fightBackCheck:()=>{},clearPathCheck:()=>{},
    facultyHeld:()=>false,note:()=>{},progress:()=>{},safety:()=>({fleeAt:0.7}),
    revive(){this.inert=null;},
    cancelForSurvival(){cancellations++;this.s.moveOrder=null;return {cancelled:true};}});
  Object.assign(k.s,{live:true,movementGeneration:1,moveOrder:{to:2501,origin,generation:1},
    client:{state:'game',vitals:()=>({health:{value:13,max:20}})}});
  k.watch.lastPulseAt=now;k.watch.wedged={since:now-60000,taking_hits:true,inert:true,at:{row:30,col:22}};
  k.watchdogTick();
  assert.equal(cancellations,1);assert.equal(k.suspendedJourney.to,2501);
  assert.deepEqual(k.suspendedJourney.origin,origin);
  assert.equal(k.suspendedJourney.guard.arm,false);assert.equal(k.suspendedJourney.guard.safe_spot,true);
  const parent=k.suspendedJourney;k.inert={travelling:true,to:2000};k.suspendJourney('nested shelter');
  assert.equal(k.suspendedJourney,parent,'recovery retains its root issuer and destination');
});
