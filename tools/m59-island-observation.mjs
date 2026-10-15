import {originLabel} from './m59-move-origin.mjs';
import {currentCallOrigin} from './m59-fleetscript.mjs';

export function checkIslandCancellation(ctx,status){
  const cancel=status?.movement?.last_cancel,start=ctx.state?.islandCancelFence;
  if(start!=null&&cancel?.at>=start&&cancel.by?.source!=='keeper'&&
     cancel.by_label!==originLabel(ctx.origin??currentCallOrigin()))throw Error('island_walk_cancelled_by_operator');
}
export function islandReadOwner(ctx,status,{orderedBy,to}={}){
  const origin=ctx.origin??currentCallOrigin(),label=orderedBy??originLabel(origin);
  const faculty=status?.autopilot_status?.faculties?.movement;
  if(faculty?.owner&&faculty.expires_in_ms>0&&
      faculty.owner!==origin?.source+':'+origin?.name)return false;
  // The runner's renewable movement lease remains held during a survival
  // reconnect. A dead or foreign lease never licenses continuation.
  if(origin?.source==='fleetscript'&&faculty?.owner===origin.source+':'+origin.name&&faculty.expires_in_ms>0)return true;
  const pre=status?.movement?.last_preempted,hold=status?.autopilot_status?.suspended_journey;
  return !!label&&(pre?.by?.source==='keeper'&&pre.preempted?.ordered_by===label&&
    (to==null||Number(pre.preempted.to)===to)||hold?.ordered_by===label&&(to==null||Number(hold.to)===to));
}
export async function observeIslandTraveller(ctx,read,{valid=l=>Number.isFinite(l.hp?.value)&&Number.isFinite(l.hp?.max)&&l.hp.max>0&&Number.isFinite(l.room?.num),
  bodyOf=l=>l,statusOf=null,error='traveller_health_unreadable',deadline=Date.now()+15000,pollMs=250,orderedBy,to,
  retryReadError=e=>e.name==='AbortError'||/fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|island_keeper_unavailable/i.test(e.message),
  sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  let recovering=false;
  const fail=(reason,body,status)=>{
    const faculty=status?.autopilot_status?.faculties?.movement,order=status?.movement?.order;
    (ctx.state??={}).islandObservationFailure={at:Date.now(),reason,room:body?.room?.num,
      hp:body?.hp&&{value:body.hp.value,max:body.hp.max},connected:status?.connected,in_game:status?.in_game,
      broker_error:status?.broker_error&&String(status.broker_error).slice(0,160),
      lease:faculty&&{owner:faculty.owner,expires_in_ms:faculty.expires_in_ms},
      order:order&&{kind:order.kind,to:order.to,ordered_by:order.ordered_by},
      owner_proved:islandReadOwner(ctx,status,{orderedBy,to}),recovering};
    throw Error(reason);
  };
  for(;;){
    let value;try{value=await read();}catch(e){if(!retryReadError(e))throw e;}
    const body=value===undefined?null:bodyOf(value);
    if(body?.room?.num===1||body?.hp?.value===0)throw Error('traveller_died');
    let status=value===undefined?null:statusOf?.(value);if(status)checkIslandCancellation(ctx,status);
    if(recovering){
      status??=await ctx.call('status',{agent:ctx.agent,brief:true});checkIslandCancellation(ctx,status);
      if(!islandReadOwner(ctx,status,{orderedBy,to}))fail(error,body,status);
      if(Date.now()>=deadline)fail(error+'_recovery_budget',body,status);
    }
    if(value!==undefined&&valid(value))return value;
    status??=await ctx.call('status',{agent:ctx.agent,brief:true});checkIslandCancellation(ctx,status);
    if(!islandReadOwner(ctx,status,{orderedBy,to}))fail(error,body,status);
    if(Date.now()>=deadline)fail(error+'_recovery_budget',body,status);
    recovering=true;
    await sleep(Math.min(pollMs,Math.max(1,deadline-Date.now())));
  }
}
