// A routing retry may outlive each short failed job. Keep its body evidence
// across those jobs; an idle waiter or a geometry refusal is not a traffic jam.
import {journeyTrafficWait} from './m59-trip-telemetry.mjs';
const valid=p=>Number.isInteger(p?.room)&&Number.isFinite(p.col)&&Number.isFinite(p.row);
const same=(a,b)=>valid(a)&&valid(b)&&a.room===b.room&&Math.abs(a.col-b.col)<=1&&Math.abs(a.row-b.row)<=1;
const gap=30000;
export function noteTrafficJam(previous,{outcome,place,to,owner,now=Date.now()}){
 const proof=journeyTrafficWait(outcome);
 if(!valid(place)||!owner||!proof||proof.room!==place.room||proof.to!==Number(to)||outcome.cancelled||/cancel|interrupt|preempt/i.test(outcome.reason??''))return null;
 const continuing=previous&&previous.owner===owner&&previous.to===Number(to)&&same(previous.place,place)&&now>=previous.at&&now-previous.at<=gap;
 return {owner,to:Number(to),place:continuing?previous.place:{...place},since:continuing?previous.since:now,at:now,attempts:continuing?previous.attempts+1:1};
}
export function trafficBlinkAdvice(jam,{place,to,owner,now=Date.now()}){
 if(!jam||!owner||jam.owner!==owner||jam.to!==Number(to)||!same(jam.place,place)||now<jam.at||now-jam.at>gap||jam.attempts<2||now-jam.since<10000)return null;
 return {...place,to:Number(to),wedged_for_ms:now-jam.since,repeats:jam.attempts};
}
// A sent cast is not a finished trance. The normal pacer knows the actual
// charge, including server updates; legacy sessions get the conservative wait.
export async function waitForBlinkCast(pacer,{now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),cancelled=()=>false,budgetMs=30000,sentAt=now()}={}){
 const deadline=now()+budgetMs;
 if(cancelled())return {quiet:false,cancelled:true};
 if(!pacer?.holdStatus?.()?.active){await wait(Math.max(0,15000-(now()-sentAt)));return {quiet:!cancelled(),cancelled:cancelled()};}
 while(pacer.holdStatus()?.active){
  if(cancelled())return {quiet:false,cancelled:true};
  if(now()>=deadline)return {quiet:false,why:'blink trance budget'};
  await wait(Math.min(250,deadline-now()));
 }
 return {quiet:!cancelled(),cancelled:cancelled()};
}
