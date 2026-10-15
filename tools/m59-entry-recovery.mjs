// Ordinary retreat/re-entry for a body-blocked arrival. No relocation or combat.
import {blocksMovement,OF} from './m59-parse.mjs';

export function reversibleEntry(map,entry){
 const edge=(from,to)=>(map?.rooms?.[from]?.edgeExits??[]).some(e=>Number(e.to)===Number(to)&&!e.condition);
 return !!entry&&edge(entry.room,entry.from)&&edge(entry.from,entry.room);
}
export function entryTrafficCandidate(entry,body,status,to,{canReturn=false,orderedBy=null}={}){
 if(!canReturn||!entry||entry.room!==body?.room?.num||entry.from===to||!Number.isInteger(entry.from))return false;
 const me=body.you,hp=body.hp,p=entry.position;
 if(me?.predicted||![me?.x,me?.y,p?.x,p?.y].every(Number.isFinite)||
  Math.hypot(me.x-p.x,me.y-p.y)>128||!hp?.max||hp.value!==hp.max||hp.max!==entry.maxHp)return false;
 if((status.failed??status.job?.failed)!=='safe_legs_required'||status.busy||status.movement?.order)return false;
 if(orderedBy&&status.job?.ordered_by&&status.job.ordered_by!==orderedBy)return false;
 return (body.objects??[]).some(o=>o.id!==me.id&&[o.x,o.y].every(Number.isFinite)&&
  (blocksMovement(o.flags??0)||(o.flags&(OF.ATTACKABLE|OF.PLAYER)))&&Math.hypot(o.x-me.x,o.y-me.y)<=128);
}

// The caller retains ownership, supplies normal one-room travel and checks its
// cancellation on each read. All detours and waits share the original deadline.
export async function retreatAndRetryEntry({entry,to,deadline,hop,read,check=async()=>{},sleep,
 now=Date.now,waitMs=30000,pollMs=1000,maxAttempts=2}={}){
 const attempts=[];
 for(let n=0;n<maxAttempts;n++){
  await check();if(now()+waitMs>=deadline)return {ok:false,reason:'entry_recovery_budget',attempts};
  const attempt={};attempts.push(attempt);
  attempt.back=await hop(entry.from,deadline-now());
  if(!attempt.back.ok)return {ok:false,reason:'entry_retreat_failed',attempts,end:attempt.back.end};
  const until=Math.min(deadline,now()+waitMs);
  while(now()<until){await check();await read();await sleep(Math.min(pollMs,until-now()));}
  await check();if(now()>=deadline)return {ok:false,reason:'entry_recovery_budget',attempts};
  attempt.reenter=await hop(entry.room,deadline-now());
  if(!attempt.reenter.ok)return {ok:false,reason:'entry_reentry_failed',attempts,end:attempt.reenter.end};
  await check();
  if(now()>=deadline)return {ok:false,reason:'entry_recovery_budget',attempts,end:attempt.reenter.end};
  attempt.retry=await hop(to,deadline-now());
  if(attempt.retry.ok)return {...attempt.retry,attempts};
  if(attempt.retry.reason!=='entry_traffic_blocked')return {...attempt.retry,attempts};
 }
 return {ok:false,reason:'entry_recovery_exhausted',attempts,end:attempts.at(-1)?.retry?.end};
}
