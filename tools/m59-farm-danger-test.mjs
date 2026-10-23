import assert from 'node:assert/strict';
import {Autopilot,STAGE_OVERRAN} from './m59-autopilot.mjs';
import {bodyAuthority,withBodyStage,withRecoveryCommand} from './m59-body-command.mjs';
let release,packets=0,cancels=0;const health={value:74,max:74};
const s={client:{room:{id:827},selfId:1,vitals:()=>({health})},cancelMovement:()=>{cancels++;return{cancelled:true};}};
const ap={s,tally:{},note(){},safety:()=>({fleeAt:.7}),passFarm:async()=>{await new Promise(r=>release=r);bodyAuthority(s).guard();packets++;return true;}};
const pending=Autopilot.prototype.runStageBounded.call(ap,'passFarm',{});
setTimeout(()=>{health.value=46;},20);
assert.equal(await pending,STAGE_OVERRAN);assert.equal(cancels,1);assert.equal(ap.tally.survival_stage_interrupts,1);
assert(ap.stageInFlight.has('passFarm'),'unsettled old invocation stays fenced, no duplicate work');
release();await new Promise(r=>setTimeout(r,0));assert.equal(packets,0,'late old attack cannot follow recovery');assert(!ap.stageInFlight.has('passFarm'));
// A healthy slow operation retains its authority; recovery itself is never
// cancelled by this farm-only monitor. Explicit road orders retain their policy.
health.value=74;ap.passFarm=async()=>{bodyAuthority(s).guard();return 17;};assert.equal(await Autopilot.prototype.runStageBounded.call(ap,'passFarm',{}),17);
ap.passFleeAndRest=async()=>31;health.value=3;assert.equal(await Autopilot.prototype.runStageBounded.call(ap,'passFleeAndRest',{}),31);assert.equal(cancels,1);
console.log('PASS actual farm rung yields below flee line within100ms; late queued authority fenced; recovery/healthy work preserved');

health.value=74;let finishHelp;
ap.passCooperative=async()=>{await new Promise(r=>finishHelp=r);bodyAuthority(s).guard();packets++;return true;};
const helping=Autopilot.prototype.runStageBounded.call(ap,'passCooperative',{});
setTimeout(()=>{health.value=46;},20);
assert.equal(await helping,STAGE_OVERRAN);assert.equal(cancels,2);
assert(ap.stageInFlight.has('passCooperative'));
finishHelp();await new Promise(r=>setTimeout(r,0));assert.equal(packets,0);assert(!ap.stageInFlight.has('passCooperative'));
console.log('PASS cooperative distraction yields on the same100ms danger clock and cannot reclaim the body after survival takes over');

const deadToken={cancelled:true};
assert.throws(()=>withBodyStage(s,'passFarm',()=>withRecoveryCommand(s,()=>bodyAuthority(s).guard()),deadToken),/preempted by survival/);
assert.throws(()=>withBodyStage(s,'passFarm',()=>withBodyStage(s,'nested-helper',()=>bodyAuthority(s).guard()),deadToken),/preempted by survival/);
console.log('PASS nested helpers and urgent recovery priority cannot renew a cancelled ordinary stage');

const receipts=[],accounting={tally:{kills:2},killTimes:[],ledgerEvent:(kind,detail)=>receipts.push({kind,...detail})};
Autopilot.prototype.recordInterruptedFarmOutcome.call(accounting,{target:'daemon skeleton',killed:true,rounds:3},{room:{num:827},holding:true,preempted:'STAGE_PREEMPTED'});
assert.equal(accounting.tally.kills,3);assert.equal(receipts.filter(e=>e.kind==='killed').length,1);assert(receipts[0].from_safe_spot);
Autopilot.prototype.recordInterruptedFarmOutcome.call(accounting,{target:'narthyl worm',killed:false},{room:{num:827},preempted:'STAGE_PREEMPTED'});assert.equal(accounting.tally.kills,3);
console.log('PASS late completed fight receipts retain credited kills without restarting body work or inventing an uncertain kill');

// Actual pull/Session/collision return after server save, not a copied selector.
const {bastionHarness}=await import('./fixtures/bastion-fallback-client.mjs'),h=await bastionHarness();
const f=h.fixture({from:{room:827,x:2336,y:1312}},{wireNames:true,maxPackets:40,maxMs:8000});
let save=0,swings=0;const originalWalk=f.s.walkTo.bind(f.s);
f.c.idsAsOf=()=>({last_save_at:save});f.c.room.objects.set(9,{id:9,nameRsc:9,flags:1,col:36,row:18,x:2336,y:1184});f.c.rsc.set(9,'daemon skeleton');f.c.attack=()=>swings++;
f.s.walkTo=async(...args)=>{const reply=await originalWalk(...args);save++;return reply;};
const puller={s:f.s,hold:{room:827,col:36,row:20},mode:'farm',policy:{},crowded:()=>false,safety:()=>({fleeAt:.7}),farmBuffAsk:async()=>null,note(){},releaseHold(){this.hold=null;},terminalMovement:()=>null};
const {withBodyCommand}=await import('./m59-body-command.mjs');
const pullResult=await withBodyCommand(f.s,()=>Autopilot.prototype.pull.call(puller,{id:9}));
assert.equal(pullResult.pulled,false);assert.equal(swings,0);assert.equal(f.c.self.row,20);assert.equal(f.c.self.col,36);assert(f.packets.length>=2);
console.log('PASS actual changed-generation pull sends no stale attack and normally returns to its original refuge square');

// The farm rung may itself be returning to cover when a hit arrives. Preserve
// that actual scoped refuge proof, but release it as soon as a step is blocked.
const {withProvenRefugeLeg,rememberRefugePosition}=await import('./m59-refuge-leg.mjs');
const hp2={value:20,max:20},origin={source:'keeper',name:'shelter'};
const s2={client:{state:'game',room:{id:77},selfId:1,self:{id:1,x:640,y:640},vitals:()=>({health:hp2})},live:true,movementGeneration:4,moveOrder:{origin,generation:4},movementWasCancelled:()=>false,cancelMovement:()=>{throw Error('a progressing refuge was cancelled');}};
await withProvenRefugeLeg(s2,[{x:960,y:640}],{row:10,col:15},{movementGeneration:4},async leg=>{
 rememberRefugePosition(s2,{id:1,x:640,y:640,room_object_id:77,at:leg.started_at});
 Object.assign(s2.client.self,{x:704});rememberRefugePosition(s2,{id:1,x:704,y:640,room_object_id:77,at:leg.started_at});
 const k={s:s2,tally:{},note(){},safety:()=>({fleeAt:.7}),mortalDanger:()=>({rate:-3}),passFarm:async()=>{await new Promise(r=>setTimeout(r,230));return 19;}};
 setTimeout(()=>hp2.value=10,20);assert.equal(await Autopilot.prototype.runStageBounded.call(k,'passFarm',{}),19);assert(!k.tally.survival_stage_interrupts);
 leg.blocked=true;let cancelled=0;s2.cancelMovement=()=>{cancelled++;};k.passFarm=async()=>new Promise(()=>{});
 assert.equal(await Autopilot.prototype.runStageBounded.call(k,'passFarm',{}),STAGE_OVERRAN);assert.equal(cancelled,1);
});
console.log('PASS mid-farm confirmed progress to cover survives incoming damage; blocked refuge immediately releases emergency preemption');
