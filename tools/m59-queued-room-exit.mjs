import{planQueuedRoomExit}from'./m59-queued-exit-plan.mjs';
export{planQueuedRoomExit}from'./m59-queued-exit-plan.mjs';
import{Worker}from'node:worker_threads';
import{coalesceCheckedRailLeg}from'./m59-rail-coalesce.mjs';
import{protocolToClient,clientToProtocol,squareCentreClient}from'./m59-finepos.mjs';
import{preparedFineExitStage}from'./m59-session-walk.mjs';
import{planBodyDetour,blockingBodySnapshot}from'./m59-body-detour.mjs';
// Ordinary convoy egress retains a published fine doorway and its clear-prefix queue.
import {loadMap,edgeCandidatesOf,roomExitSquares} from './m59-map.mjs';
import {setImmediate as yieldPlanning} from 'node:timers/promises';
import {planQueuedEgress} from './m59-rail-traffic.mjs';
import {roomGeometry} from './m59-ground.mjs';
import {createRailObserver} from './m59-rail-observer.mjs';
import {currentCallOrigin} from './m59-fleetscript.mjs';
import {originLabel} from './m59-move-origin.mjs';
import {recoverIslandFineWalk,ownsFineRecovery,activeOwnedFineRecovery} from './m59-island-finewalk.mjs';
import {checkIslandCancellation,islandReadOwner} from './m59-island-observation.mjs';
// A cohort's unreachable terrain searches must not block HTTP, cancellation,
// survival callbacks or telemetry. Reuse two bounded worker isolates; idle
// workers do not keep a controller alive. Workers never send game commands.
const exitPlanningPool=[],exitPlanningQueue=[];let exitPlanningSequence=0;
function pumpExitPlanning(){
 while(exitPlanningQueue.length){
  let slot=exitPlanningPool.find(s=>!s.dead&&!s.job);
  if(!slot){if(exitPlanningPool.filter(s=>!s.dead).length>=2)return;
   const worker=new Worker(new URL('./m59-queued-exit-plan-worker.mjs',import.meta.url),{execArgv:[],resourceLimits:{maxOldGenerationSizeMb:256},workerData:{kind:'m59-queued-exit-planner/1'}});
   slot={worker,job:null,dead:false};exitPlanningPool.push(slot);
   const failed=error=>{if(slot.dead)return;slot.dead=true;if(slot.job)slot.job.finish({found:false,reason:'exit_planner_worker_error',error:String(error?.message??error).slice(0,400)});slot.job=null;pumpExitPlanning();};
   worker.on('message',message=>{const job=slot.job;if(!job||job.id!==message.id)return;slot.job=null;job.finish(message.result);worker.unref();pumpExitPlanning();});
   worker.on('error',failed);worker.on('exit',code=>failed(Error('exit planner worker exited '+code)));worker.unref();
  }
  const job=exitPlanningQueue.shift();if(job.done)continue;slot.job=job;slot.worker.ref();
  try{slot.worker.postMessage({id:job.id,...job.input});}catch(error){slot.job=null;job.finish({found:false,reason:'exit_planner_input_error',error:error.message});slot.worker.unref();}
 }
}
export async function planQueuedRoomExitAsync(state,to,{map=loadMap(),geometry=roomGeometry(state.room?.num),branch=null,timeoutMs=60000}={}){
 if(!geometry?.collisionReady)return{found:false,reason:'exit_body_unconfirmed'};
 const input={state:{room:state.room,you:state.you,objects:state.objects??[]},to,room:map.rooms[state.room?.num],branch,
  geometry:geometry.toJSON({includeSurfaces:false,graphEntrySquares:[],edgeDirections:[]}),stepMask:geometry._stepMask??null};
 return new Promise(resolve=>{const job={id:++exitPlanningSequence,input,done:false,finish(result){if(job.done)return;job.done=true;clearTimeout(timer);resolve(result);}};
  const timer=setTimeout(()=>{const i=exitPlanningQueue.indexOf(job);if(i>=0)exitPlanningQueue.splice(i,1);job.finish({found:false,reason:'exit_planner_deadline'});},Math.max(1,timeoutMs));
  exitPlanningQueue.push(job);pumpExitPlanning();
 });
}
// A keeper provisioning/recovery trip owns packets even when no survival
// decision is active and the traveler is at full health. Wait without issuing
// movement or rest; the next iteration replans from the actual returned room.
async function waitQueuedRecoveryTrip(ctx,initial,{observe,deadline,pollMs}){
 const actor=initial.you?.id;
 let state=initial;
 while(state.autopilot_status?.recovery_travel){
  checkIslandCancellation(ctx,state);
  if(!islandReadOwner(ctx,state)||state.you?.id!==actor)throw Error('queued_exit_recovery_owner_changed');
  if(!(state.hp?.value>0)||state.room.num===1)throw Error('queued_exit_traveller_died');
  if(Date.now()>=deadline)throw Error('queued_exit_recovery_trip_deadline');
  await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,Math.max(1,deadline-Date.now()))));
  state=await observe();
 }
 checkIslandCancellation(ctx,state);
 if(!islandReadOwner(ctx,state)||state.you?.id!==actor)throw Error('queued_exit_recovery_owner_changed');
 if(!(state.hp?.value>0)||state.room.num===1)throw Error('queued_exit_traveller_died');
}
export async function queuedRoomExit(ctx,to,{timeoutMs=180000,branch=null,queuePath=false,recoveryPollMs=1000,characters=ctx.state.braxConvoyCharacters,observe=createRailObserver({fleet:ctx.fleet,agent:ctx.agent})}={}){
 const startedAt=Date.now(),deadline=startedAt+timeoutMs,continuations=[];
 for(let attempt=0;attempt<32&&Date.now()<deadline;attempt++){
  const state=await observe();checkIslandCancellation(ctx,state);
  if(state.room.num===to)return {arrived:true,alreadyAcross:true};
  if(!islandReadOwner(ctx,state))throw Error('queued_exit_owner_changed');
  if(!(state.hp?.value>0)||state.room.num===1)throw Error('queued_exit_traveller_died');
  if(state.autopilot_status?.recovery_travel){await waitQueuedRecoveryTrip(ctx,state,{observe,deadline,pollMs:recoveryPollMs});continue;}
  if(activeOwnedFineRecovery(ctx,state)){const recovered=await recoverIslandFineWalk(ctx,{deadline,read:async()=>({l:await observe()}),since:startedAt,initial:state,active:true,allowRecoveryRoomChanges:true});if(!recovered)throw Error('queued_exit_recovery_incomplete');continue;}
  await yieldPlanning();
  const plan=await planQueuedRoomExitAsync(state,to,{branch,timeoutMs:Math.max(1,Math.min(60000,deadline-Date.now()))});
  await yieldPlanning();if(!plan.found)throw Object.assign(Error(plan.reason),{plan});
  const fresh=await observe();checkIslandCancellation(ctx,fresh);
  if(!islandReadOwner(ctx,fresh))throw Error('queued_exit_owner_changed');
  if(!(fresh.hp?.value>0)||fresh.room.num===1)throw Error('queued_exit_traveller_died');
  if(fresh.room.num===to)return{arrived:true,alreadyAcross:true};
  if(fresh.room.num!==state.room.num||fresh.you?.id!==state.you?.id||Math.hypot(fresh.you.x-state.you.x,fresh.you.y-state.you.y)>1||
     JSON.stringify(fresh.doors?.observed??{})!==JSON.stringify(state.doors?.observed??{})||fresh.autopilot_status?.recovery_travel||activeOwnedFineRecovery(ctx,fresh))continue;
  const origin=ctx.origin??currentCallOrigin();let reply,error;
  try{reply=await observe.action('walk_rail',{room:plan.room,leg:plan.leg,queuePath,bodyDetour:!queuePath,exit:plan.exit,convoy:{key:originLabel(origin),characters:characters??[state.character]},timeoutMs:deadline-Date.now(),origin},{timeoutMs:deadline-Date.now()+15000});}
  catch(e){const endedLogin=e.message===`rail action refused: agent "${ctx.agent}" is not in game — call join first`;if(e.message!=='rail action refused: rail_position_confirmation_timeout'&&!endedLogin)throw e;error=e;}
  if(reply?.operationEnded&&reply.reason==='position_confirmation_timeout')error=Error(reply.reason);
  const actual=await observe();checkIslandCancellation(ctx,actual);
  const adoption=reply?.passage_adoption??actual.movement?.rail?.passage_adoption;if(adoption?.adopted)continuations.push({at:Date.now(),attempt,kind:'passage-adopted',...adoption});
  if(actual.room.num===to&&actual.hp?.value>0)return {...reply,arrived:true,continuations};
  if(reply?.reason==='keeper_recovery_trip_active'&&typeof reply.trip_id==='string'&&islandReadOwner(ctx,actual)){
   await waitQueuedRecoveryTrip(ctx,actual,{observe,deadline,pollMs:recoveryPollMs});
   continuations.push({at:Date.now(),attempt,kind:'keeper-trip-complete',trip_id:reply.trip_id});continue;
  }
  if(ownsFineRecovery(ctx,actual,{since:startedAt,active:true})){
   const recovered=await recoverIslandFineWalk(ctx,{deadline,read:async()=>({l:await observe()}),since:startedAt,initial:actual,active:true,allowRecoveryRoomChanges:true});
   if(recovered){continuations.push({at:Date.now(),attempt,kind:'owned-recovery-complete',room:actual.room.num,position:actual.you});continue;}
  }else if(error&&islandReadOwner(ctx,actual)&&!actual.job?.busy&&!actual.movement?.order){continuations.push({at:Date.now(),attempt,kind:'known-ended-position-replan',error:error.message,position:actual.you});continue;}
  const evidence={at:Date.now(),reply,error:error?.message,actual:{room:actual.room,hp:actual.hp,you:actual.you},recovery:ctx.state.islandRecoveryFailure};
  ctx.state.queuedExitFailure=evidence;console.log(JSON.stringify({kind:'queued-exit-stopped',agent:ctx.agent,...evidence}));
  throw Object.assign(Error('queued_exit_stopped'),evidence);
 }
 throw Error('queued_exit_budget_exhausted');
}
