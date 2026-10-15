// Offline overlap regression: a script's paced walk must end before shelter moves.
import assert from 'node:assert/strict';
import {Session} from './m59-game.mjs';
import {Autopilot} from './m59-autopilot.mjs';
import {withMoveOrder,movementReport} from './m59-move-origin.mjs';
import {attachSurvivalDecisions,chooseSurvivalDecision,currentSurvivalDecision} from './m59-survival-decision.mjs';

function fixture(){
 const s=Object.assign(Object.create(Session.prototype),{name:null,movementGeneration:7,
  cancelledMovementTokens:new Set(),world:{room:{num:2502}},
  client:{state:'game',vitals:()=>({health:{value:12,max:20}})}});
 attachSurvivalDecisions(s);
 const d=chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'hurt'});
 const calls=[],k=Object.assign(Object.create(Autopilot.prototype),{s,
  adoptRecoveryWall:()=>false,clearSurvivalJam:()=>{},playDead:async()=>{},
  takeSafeSpot:async()=>{calls.push({generation:s.movementGeneration,oldCancelled:s.movementWasCancelled(7)});return {took:true};}});
 return {s,k,d,calls};
}

for(const source of ['fleetscript','operator']){
 const {s,k,d,calls}=fixture();
 await withMoveOrder(s,{kind:'walk',origin:{source,name:'overlap',run_id:'one'},to:'x2568,y2768'},async()=>{
  assert.equal(s.movementWasCancelled(7),false);
  const r=await k.takeRecoverySpot('hurt during a paced chord',{decisionId:d.id});
  assert.equal(r.took,true);assert.equal(calls.length,1);
  assert.equal(calls[0].oldCancelled,source==='fleetscript');
  assert.equal(calls[0].generation,source==='fleetscript'?8:7);
  assert.equal(currentSurvivalDecision(s).id,d.id,'the selected recovery survives its handoff');
  if(source==='fleetscript'){
   const pre=movementReport(s).last_preempted;
   assert.equal(pre.by_label,'keeper:shelter');
   assert.equal(pre.preempted.ordered_by,'fleetscript:overlap#one');
   assert.equal(s.movementWasCancelled(7),true,'queued script packets cannot resume after the refuge move');
  }
 });
}
{
 const {s,k,d,calls}=fixture();
 s.cancelMovement=()=>({cancelled:false,reason:'new authority owns the body'});
 await withMoveOrder(s,{kind:'walk',origin:{source:'fleetscript',name:'old'},to:'old'},async()=>{
  const r=await k.takeRecoverySpot('handoff refused',{decisionId:d.id});
  assert.equal(r.cancelled,true);assert.equal(calls.length,0);
 });
}
{
 const {s,k,d,calls}=fixture();
 await withMoveOrder(s,{kind:'shelter',origin:{source:'keeper',name:'shelter'},to:'r44c43'},async()=>{
  await k.takeRecoverySpot('continue the existing shelter',{decisionId:d.id});
  assert.equal(calls[0].generation,7,'an existing keeper approach does not cancel itself');
 });
}
console.log('Recovery preemption checks passed: old paced generation, decision continuity, operator scope and refused handoff.');
