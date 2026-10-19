import {join} from 'node:path';
import {evidenceDirFor} from './m59-fleetpath.mjs';
import {sharedJournal} from './m59-shared-journal.mjs';
// The historical directory name is retained so old/new callers share live claims.
// Serialize the fine alignment, flight and landing clearance across CLI children.
export function crossingGate(key,{directory=join(evidenceDirFor(),'brax-crossings'),alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}}}={}){
 const journal=sharedJournal(key,{directory}),same=(a,b)=>a?.pid===b?.pid&&a?.token===b?.token;
 const validate=owner=>{if(!Number.isSafeInteger(owner?.pid)||owner.pid<=0||!owner.token)throw Error('invalid crossing owner');};
 return {
  async acquire(owner){validate(owner);let acquired=false;await journal.change(held=>{
   if(held){validate(held);if(same(held,owner)){acquired=true;return;}if(alive(held.pid))return;}
   acquired=true;return owner;
  });return acquired;},
  async foreign(owner){validate(owner);const held=await journal.change(()=>{});if(!held)return false;validate(held);return !same(held,owner)&&alive(held.pid);},
  async release(owner){validate(owner);let released=false;await journal.change(held=>{if(same(held,owner)){released=true;return null;}});return released;},
 };
}


// Acquire atomically after every wake-up. Merely observing an empty gate lets
// all waiting followers enter the approach together when its owner leaves.
export async function waitForCrossing(gate,owner,{check=async()=>{},ready=async()=>true,deadline,now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 for(;;){
  await check();
  if(now()>=deadline)throw Error('rail_crossing_queue_budget');
  if(await ready()&&await gate.acquire(owner))return;
  await wait(500);
 }
}

// Let a follower use the crossing once its predecessor has physically cleared
// the landing, while the predecessor continues the rest of its parking walk.
export async function releaseAfterClearance(gate,owner,moving,{read,clear,onClear=()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms))}){
 let done=false;
 const pending=Promise.resolve(moving).then(value=>({value}),error=>({error})).finally(()=>{done=true;});
 let observationError;
 while(!done){
  await wait(500);if(done)break;
  let state;try{state=await read();}catch(error){observationError=error;break;}
  if(clear(state)){if(await gate.release(owner))onClear(state);break;}
 }
 const result=await pending;
 if(result.error)throw result.error;if(observationError)throw observationError;
 return result.value;
}

// Debounce a live assembly without allowing a stream of stragglers to hold it
// forever. A closed window cannot be reopened by a late caller.
export function rollingGatherCutoff({cutoff,hardCutoff,idleMs},now){
 if(![cutoff,hardCutoff,idleMs,now].every(Number.isFinite)||idleMs<0||hardCutoff<cutoff)throw Error('invalid gathering window');
 return now>cutoff?cutoff:Math.max(cutoff,Math.min(hardCutoff,now+idleMs));
}

// Shared by native passage admission and scripted crossings. A convoy may have
// multiple bodies in a long corridor, but only one unconfirmed entrance packet.
// Unknown flows remain exclusive; a timeout never proves physical clearance.
export function crossingAdmissionConflict(held,request){
 if(held.agent===request.agent)return false;
 return !(request.flow&&held.flow===request.flow)||!!(request.entry&&held.entry&&request.entry!==held.entry)||held.entryPending===true;
}
