import{currentSurvivalDecision,isActiveRecoveryDecision}from'./m59-survival-decision.mjs';
import{journeyTrafficWait}from'./m59-trip-telemetry.mjs';
import{originLabel}from'./m59-move-origin.mjs';
// A body-only road refusal ends its driver. An unchanged healthy traveler may
// resume its own rest=false journey with the normal road reserve; waiting for
// the rest cap when policy deliberately does not rest is a deadlock.
function resumeKind(pilot,j,v,{travelFloor=40,ordinaryFloor=20}={}){
 const s=pilot.s,owner=pilot.facultyOwner?.('movement'),origin=j?.origin,job=s?.job;
 const traffic=job?.kind==='travel'&&!job.cancelRequestedAt&&!job.result?.cancelled&&!job.result?.recovery?.cancelled?journeyTrafficWait(job.result):null;
 if(pilot.stopping||pilot.mode!=='idle'||pilot.inert?.travelling||s?.moveOrder||s?.keeperRecoveryTravel||isActiveRecoveryDecision(currentSurvivalDecision(s))||pilot.hold||pilot.recoverUntilWhole||
   origin?.source!=='fleetscript'||typeof owner!=='string'||owner!==origin.source+':'+origin.name||pilot.facultyOwner?.('work')!==owner||
   pilot.travelGuard?.().rest!==false||typeof pilot.facultyHeld!=='function'||['survival','recovery','combat'].some(k=>pilot.facultyHeld(k))||s?.combat?.active||
   (s?.client?.ailments?.()??[]).length||!job?.done||job.cancelled||job.cancelRequestedAt||job.result?.cancelled||job.result?.recovery?.cancelled||job.error||job.origin?.run_id!==origin.run_id||
   originLabel(job.origin)!==originLabel(origin))return false;
 const hp=v?.health,raw=v?.vigor?.value,floor=Math.max(pilot.policy?.travelVigorFloor??travelFloor,pilot.policy?.ordinaryVigorFloor??ordinaryFloor);
 if(!(Number.isFinite(hp?.max)&&hp.max>0&&Number.isFinite(hp.value)&&hp.value>=hp.max&&Number.isFinite(raw)&&raw>=floor))return false;
 if(traffic&&traffic.room===s.world?.room?.num&&Number(traffic.to)===Number(j.to)&&j.trigger==='route_progressing_exits_exhausted')return 'traffic';
 const r=job.result,d=r?.deviation??s.lastMovementDeviation;
 if(r?.arrived===false&&r.reason==='movement_deviation'&&!r.cancelled&&!r.recovery?.cancelled&&Number(job.to)===Number(j.to)&&
    j.trigger==='the travel job ended short of the destination'&&d?.confirmed&&d.room===s.world?.room?.num&&
    d.confirmation?.asked_at>=job.startedAt&&d.confirmation?.finished_at<=job.finishedAt)return 'deviation';
 return false;
}

// A deviation is a positively ended job, but its cached pose cannot authorize a
// continuation. The native caller first confirms the current body under the
// same client, room and movement generation, then rechecks every ownership gate.
export function scriptedDeviationResumeCandidate(pilot,j,v,options){return resumeKind(pilot,j,v,options)==='deviation';}
export function scriptedTrafficResumeReady(pilot,j,v,options={}){
 const kind=resumeKind(pilot,j,v,options);if(kind==='traffic')return true;
 const body=options.confirmedBody,c=pilot.s?.client;
 return kind==='deviation'&&!!body&&body===c?.self&&!body.predicted&&Number.isFinite(body.x)&&Number.isFinite(body.y);
}
