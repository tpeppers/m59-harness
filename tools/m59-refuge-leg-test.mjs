import assert from 'node:assert/strict';
import {rememberRefugePosition,withProvenRefugeLeg,continuingProvenRefugeLeg} from './m59-refuge-leg.mjs';
import {Autopilot,CONTINUE,HANDLED,PASS_STAGES} from './m59-autopilot.mjs';
import {sessionWalkPrototype} from './m59-session-walk.mjs';
const origin={source:'fleetscript',name:'refuge-leg',run_id:'fixture'};
function session(){
 const c={state:'game',room:{id:77},self:{x:640,y:640,row:10,col:10},vitals:()=>({health:{value:13,max:20}})};
 return {client:c,live:true,movementGeneration:4,moveOrder:{origin,generation:4},movementWasCancelled:()=>false};
}
const points=[{x:960,y:640},{x:1280,y:640}],goal={row:10,col:20};
function progress(s,leg){
 rememberRefugePosition(s,{x:640,y:640,room_object_id:77,at:leg.started_at});
 rememberRefugePosition(s,{x:704,y:640,room_object_id:77,at:leg.started_at});
}
const options={movementGeneration:4,controlToken:{id:1}};
const s=session();
await withProvenRefugeLeg(s,points,goal,options,async leg=>{
 assert(!continuingProvenRefugeLeg(s),'a planned route alone cannot defer survival');
 progress(s,leg);assert(continuingProvenRefugeLeg(s,{now:leg.started_at+2}));
 const pose=s.refugePosition;
 rememberRefugePosition(s,{x:704,y:640,room_object_id:77,at:leg.started_at+3000});
 assert(!continuingProvenRefugeLeg(s,{now:leg.started_at+3000}),'fresh reads of a stalled body are not progress');
 s.refugePosition=pose;
 for(const [why,change,restore] of [
  ['blocked',()=>leg.blocked=true,()=>leg.blocked=false],
  ['cancelled',()=>s.movementWasCancelled=()=>true,()=>s.movementWasCancelled=()=>false],
  ['foreign owner',()=>s.moveOrder={origin:{source:'operator',name:'new'},generation:4},()=>s.moveOrder={origin,generation:4}],
  ['new generation',()=>s.movementGeneration=5,()=>s.movementGeneration=4],
  ['new room',()=>s.client.room.id=78,()=>s.client.room.id=77],
  ['new client',()=>s.client={...s.client},()=>s.client=leg.client],
  ['disconnected',()=>s.client.state='closed',()=>s.client.state='game'],
  ['dead',()=>s.client.vitals=()=>({health:{value:0,max:20}}),()=>s.client.vitals=()=>({health:{value:13,max:20}})],
 ]){change();assert(!continuingProvenRefugeLeg(s,{now:leg.started_at+2}),why);restore();}
 assert(!continuingProvenRefugeLeg(s,{now:leg.started_at+3000}),'stale observations expire');
 assert(!continuingProvenRefugeLeg(s,{now:leg.started_at+2,maxRemainingSquares:1}),'long remaining route cannot defer recovery');
 leg.next_index=points.length;assert(!continuingProvenRefugeLeg(s,{now:leg.started_at+2}),'arrival releases recovery');leg.next_index=0;
 // Actual ladder and recovery stage, rather than a second implementation of their policy.
 const ran=[],cancel=[],k=Object.assign(Object.create(Autopilot.prototype),{s,policy:{},tally:{},passes:1,stageInFlight:new Set(),
  mortalDanger:()=>({frac:.65,fleeAt:.65,rate:-3}),note:()=>{},traceThisPass:()=>{},travelInterrupted:()=>false,
  runStageBounded:async stage=>{ran.push(stage);return stage==='passFleeAndRest'?k.passFleeAndRest({s}):CONTINUE;}});
 s.job={done:false,kind:'travel'};s.cancelMovement=()=>cancel.push(true);
 let buffs=0;k.farmBuffPass=async()=>{buffs++;return true;};
 assert.equal(await k.runPassLadder({}),'passFleeAndRest');assert.equal(ran[0],PASS_STAGES[0]);
 assert.equal(cancel.length,0,'a proved moving leg is not cancelled');assert.equal(buffs,0,'recovery does not cast over that leg');
 leg.blocked=true;ran.length=0;
 assert.equal(await k.runPassLadder({}),'passFleeAndRest');assert.equal(ran[0],'passFleeAndRest');
 assert.equal(cancel.length,1,'a refused step immediately restores emergency preemption');assert.equal(buffs,1);
});
assert.equal(s.provenRefugeLeg,null);
await assert.rejects(withProvenRefugeLeg(s,points,goal,options,async()=>{throw Error('fixture failure');}),/fixture failure/);
assert.equal(s.provenRefugeLeg,null,'a thrown move releases its scoped proof');
// Actual waypoint executor advances the proof cursor only on an arrived step.
for(const blocked of [false,true]){
 const s=session();s.need=()=>s.client;s.cancelledMovement=()=>({cancelled:true});
 s.confirmPosition=async()=>({});let steps=0;
 s.stepFine=async(x,y)=>{assert.equal(s.provenRefugeLeg.next_index,steps++);
  if(blocked)return {moved:false,reason:'object_blocked'};
  Object.assign(s.client.self,{x,y,row:Math.floor(y/64),col:Math.floor(x/64)});return {moved:true};};
 await withProvenRefugeLeg(s,points,goal,options,async leg=>{
  const r=await sessionWalkPrototype({}).walkDepartureLegs.call(s,points,goal,{...options,shelterFallback:false});
  assert.equal(r.arrived,!blocked);assert.equal(leg.blocked,blocked);assert.equal(leg.next_index,blocked?0:2);
 });assert.equal(s.provenRefugeLeg,null);
}
console.log('Confirmed short refuge progress retains the real survival ladder; blocked, stale, foreign and cancelled legs release it.');
