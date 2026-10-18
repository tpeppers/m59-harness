import{beginRailInputEvidence,railEvidenceScene}from'./m59-rail-input-evidence.mjs';
import {request as httpRequest} from 'node:http';
import {protocolToClient} from './m59-finepos.mjs';
import {landingCheck} from './m59-railfollow.mjs';
import {scanKeepers,identityOf,identityMismatch} from './m59-keeper.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// A cohort shares one concurrent read-only band scan. Never cache its completed
// result: the next discovery must see new keeper PIDs after a handoff.
export function createRailDiscovery(scan=scanKeepers){
 const pending=new Map();
 return fleet=>{
  if(pending.has(fleet))return pending.get(fleet);
  const request=Promise.resolve().then(()=>scan({fleet,timeoutMs:5000})).finally(()=>pending.delete(fleet));
  pending.set(fleet,request);return request;
 };
}
const discoverRailKeepers=createRailDiscovery();
// Native walking legs may legitimately wait longer than fetch's implicit
// five-minute response-header deadline. Core HTTP has no such hidden deadline;
// the caller's explicit AbortSignal remains the sole absolute request budget.
// This sends exactly one POST. A disconnect never licenses another action.
export function postRailAction(url,{headers={},body='',signal}={}){
 return new Promise((resolve,reject)=>{
  const request=httpRequest(url,{method:'POST',headers:{...headers,'content-length':Buffer.byteLength(body)},signal},response=>{
   const chunks=[];let bytes=0;
   response.on('data',chunk=>{bytes+=chunk.length;if(bytes>8e6){request.destroy(Error('rail action response too large'));return;}chunks.push(chunk);});
   response.once('error',reject);
   response.once('end',()=>{
    const text=Buffer.concat(chunks).toString('utf8'),headers=new Headers();
    for(const[key,value]of Object.entries(response.headers))if(value!=null)headers.set(key,Array.isArray(value)?value.join(', '):String(value));
    resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,headers,json:async()=>JSON.parse(text)});
   });
  });
  request.once('error',reject);request.end(body);
 });
}
// An ordered room read certifies only this keeper's own body, in this room.
export function confirmedRailBody(s){
 const p=s?.position_read;
 if(s?.in_game!==true||s.connected===false||!p||p.predicted||p.id!==s.you?.id||p.room_object_id!==s.room?.object_id||
   ![p.x,p.y,p.row,p.col].every(Number.isFinite)||Math.floor(p.x/64)!==p.col||Math.floor(p.y/64)!==p.row)return null;
 return {...s,you:{...s.you,...p}};
}
export function createRailObserver({fleet,agent,discover=()=>discoverRailKeepers(fleet),fetchImpl=fetch,actionFetch=fetchImpl===fetch?postRailAction:fetchImpl,wait=sleep,attempts=4,now=Date.now,readinessMs=30000,traceDirectory=process.env.M59_RAIL_TRACE_DIR}={}){
 let keeper,lastObservation;
 const remember=(state,kind)=>{if(traceDirectory)lastObservation={at:now(),kind,scene:railEvidenceScene(state)};return state;};
 const observe=async()=>{
  const deadline=now()+Math.min(30000,Math.max(1,readinessMs));
  const readOnce=async()=>{
   let last;
   for(let attempt=0;attempt<attempts&&now()<deadline;attempt++){
    try{
     if(!keeper){keeper=(await discover()).get(agent);if(!keeper)throw Error('rail keeper absent');}
     const u=new URL('http://127.0.0.1:'+keeper.port+'/state');
     for(const [key,value]of Object.entries({position:1,agent,character:keeper.character,keeper_pid:keeper.pid}))u.searchParams.set(key,String(value));
     const r=await fetchImpl(u,{signal:AbortSignal.timeout(Math.max(1,Math.min(12000,deadline-now())))}),s=await r.json();
     const conflict=identityMismatch(keeper,identityOf(r.headers,s));
     if(conflict||r.status===409)throw Object.assign(Error('rail keeper identity changed: '+(conflict??'address refused')),{terminal:true});
     if(!r.ok)throw Error('rail observation HTTP '+r.status);
     return s;
    }catch(e){if(e.terminal)throw e;last=e;}
    if(attempt+1<attempts&&now()<deadline){
     const next=(await discover()).get(agent);
     if(next&&keeper&&next.character!==keeper.character)throw Error('rail keeper character changed');
     if(next)keeper=next;await wait(Math.min(750,Math.max(1,deadline-now())));
    }
   }
   throw last??Error('rail observation timed out');
  };
  return remember(await waitForRailState(readOnce,{deadline,now,wait}),'ordered-own-body');
 };
 // One identity-fenced request owns a complete walking leg. A timeout is
 // ambiguous and is never retried here.
 observe.action=async(name,args,{timeoutMs=660000}={})=>{
  if(!keeper)await observe();
  const own=args?.origin?.source==='fleetscript'&&['walk_rail','walk_fine','walk_to','walk','step','jump'].includes(name);
  const walks=own?(globalThis.__m59OwnWalks??=new Map()):null,previous=walks?.get(agent),until=now()+timeoutMs;
  if(walks)walks.set(agent,Math.max(previous??0,until));
  let evidence;
  try{
  const wireBody=JSON.stringify({name,args,agent,character:keeper.character,keeper_pid:keeper.pid});
  evidence=beginRailInputEvidence({directory:traceDirectory,agent,keeper,name,args,wireBody,observation:lastObservation,now});
  const r=await actionFetch('http://127.0.0.1:'+keeper.port+'/action',{
   method:'POST',headers:{'content-type':'application/json'},
   body:wireBody,signal:AbortSignal.timeout(timeoutMs)});
  const reply=await r.json(),conflict=identityMismatch(keeper,identityOf(r.headers,reply));
  if(conflict||r.status===409)throw Error('rail action identity/refusal: '+(conflict??reply.error));
  if(!r.ok||reply.error)throw Error('rail action refused: '+(reply.error??r.status));
  const traceError=evidence?.finish({reply});
  return evidence?{...reply,input_evidence:{id:evidence.id,inputFile:evidence.inputFile,outcomeFile:evidence.outcomeFile,...(traceError?{write_error:traceError}:{})}}:reply;
  }catch(error){evidence?.finish({error});throw error;}
  finally{if(walks&&walks.get(agent)===Math.max(previous??0,until)){if(previous>now())walks.set(agent,previous);else walks.delete(agent);}}
 };
 observe.cached=async()=>{
  const deadline=now()+Math.min(30000,Math.max(1,readinessMs));let last;
  for(let attempt=0;attempt<attempts&&now()<deadline;attempt++){
   try{
    if(!keeper)await observe();
    const u=new URL('http://127.0.0.1:'+keeper.port+'/state');
    for(const [key,value]of Object.entries({agent,character:keeper.character,keeper_pid:keeper.pid}))u.searchParams.set(key,String(value));
    const r=await fetchImpl(u,{signal:AbortSignal.timeout(Math.max(1,Math.min(12000,deadline-now())))}),state=await r.json(),identity=identityOf(r.headers,state),conflict=identityMismatch(keeper,identity);
    if(conflict||r.status===409||!identity.agent||!identity.character||identity.pid==null)throw Object.assign(Error('rail cached keeper identity/read changed: '+(conflict??'unverified keeper')),{terminal:true});
    if(!r.ok)throw Error('rail cached observation HTTP '+r.status);return remember(state,'cached');
   }catch(e){
    if(e.terminal)throw e;last=e;
    if(attempt+1<attempts&&now()<deadline){
     const next=(await discover()).get(agent);if(next&&keeper&&next.character!==keeper.character)throw Error('rail keeper character changed');if(next)keeper=next;
     await wait(Math.min(750,Math.max(1,deadline-now())));
    }
   }
  }
  throw last??Error('rail cached observation timed out');
 };
 observe.probeMove=async(target,options={})=>{if(!keeper)await observe();return readRailMoveCheck(keeper,target,options,{fetchImpl});};
 return observe;
}

// These broker guards refuse before dispatching an action. Timeouts are ambiguous.
export const refusedRailWrite=(reply,agent)=>typeof reply?.error==='string'&&(
 reply.error==='agent "'+agent+'" is not in game — call join first'||
 reply.error.includes('keeper identity could not be verified; refusing write'));

// A returned confirmation refusal is different from a transport timeout: the
// mover has stopped, but the preceding packet may have landed. Re-observe its
// own body before asking the ordinary walker to replan from the actual pose.
export async function resumeObservedRailWalk(initial,walk,{observe,room,owner,since,onObserved=()=>{},attempts=3}){
 let reply=initial;
 for(let retry=0;reply?.reason==='position_confirmation_timeout'&&!reply.cancelled&&retry<attempts;retry++){
  const s=confirmedRailBody(await observe());
  if(!s||s.room.num!==room||!(s.hp?.value>0))throw Error('rail_confirmation_recovery_unproved');
  const cancel=s.movement?.last_cancel;
  if(cancel?.at>=since&&cancel.by?.source!=='keeper'&&cancel.by_label!==owner)throw Error('rail_confirmation_recovery_cancelled');
  onObserved({retry,body:s.you});
  reply=await walk();
 }
 return reply;
}

// A timed mover has already paid its simulated flight time. Observe the real
// landing instead of adding a fixed delay for every queued traveler.
export async function waitForConfirmedRailLanding({read,room,target,floorAt,owner,since,timeoutMs=12000,now=Date.now,wait=sleep}){
 const deadline=now()+timeoutMs;let state,landing;
 for(;;){
  state=confirmedRailBody(await read());if(!state)throw Error('rail_landing_position_unconfirmed');
  const cancel=state.movement?.last_cancel;
  if(cancel?.at>=since&&cancel.by?.source!=='keeper'&&cancel.by_label!==owner)throw Error('rail_landing_cancelled');
  if(state.room.num!==room||!(state.hp?.value>0))return {ok:false,state,reason:'landing_room_or_health_changed'};
  const p=protocolToClient(state.you);landing=landingCheck(p,target,{floor:floorAt(p.x,p.y),wantedFloor:floorAt(target.x,target.y)});
  if(landing.ok)return {ok:true,state,landing};
  if(now()>=deadline)return {ok:false,state,landing,reason:'landing_confirmation_timeout'};
  await wait(Math.min(100,Math.max(1,deadline-now())));
 }
}

// Only a returned, explicitly unsent flight refusal permits re-planning. A
// transport timeout or an observed flight never licenses a second jump packet.
export const unsentRailJumpRefusal=reply=>reply?.jumped===false&&reply.cancelled!==true&&reply.mover?.moved===false&&reply.mover.left_room!==true&&
 ['object_blocked','fall_blocked_by_body','fall_changed_before_send','casting_hold'].includes(reply.mover.reason);

// A keeper can briefly reconnect during its own survival action. Readiness is
// proved afresh; waiting neither sends movement nor extends the caller's deadline.
export async function waitForRailState(read,{fine=true,deadline,check=()=>{},onWait=()=>{},now=Date.now,wait=sleep}={}){
 const end=Math.min(deadline??Infinity,now()+30000);let attempts=0;
 while(now()<end){
  const state=await read();check(state);
  const ready=fine?confirmedRailBody(state):state?.in_game===true&&state.connected!==false&&Number.isInteger(state.room?.num)&&state.hp?.max>0?state:null;
  if(ready)return ready;
  onWait({attempt:attempts++,connected:state?.connected,in_game:state?.in_game});
  await wait(Math.min(500,Math.max(1,end-now())));
 }
 throw Error('rail state readiness timed out');
}

export const unsentRailAnimationRefusal=r=>r?.jumped===false&&r?.cancelled!==true&&r?.mover?.moved===false&&r.mover.left_room!==true&&r.mover.reason==='collision_geometry_changed';
// The animation guard remains authoritative. Wait on its published readiness
// before re-proving a takeoff; an ambiguous flight is never repeated.
export async function waitForRailGeometry(read,{room,deadline,owner,since,now=Date.now,wait=sleep}={}){
 for(;;){
  const s=confirmedRailBody(await read()),cancel=s?.movement?.last_cancel;
  if(!s||s.room.num!==room||!(s.hp?.value>0))throw Error('rail_animation_body_changed');
  if(cancel?.at>=since&&cancel.by?.source!=='keeper'&&cancel.by_label!==owner)throw Error('rail_animation_cancelled');
  if(now()>=deadline)throw Error('rail_animation_wait_exhausted');
  if(!(s.doors?.settling_until>now()))return s;
  await wait(Math.min(250,s.doors.settling_until-now(),Math.max(1,deadline-now())));
 }
}


// Cached native geometry question only: this endpoint never sends a move.
export async function readRailMoveCheck(keeper,{x,y},{slide=false,fall=false,timedFall=false}={}, {fetchImpl=fetch}={}){
 const u=new URL('http://127.0.0.1:'+keeper.port+'/movecheck');
 for(const [key,value]of Object.entries({x,y,slide:slide?1:0,fall:fall?1:0,timed_fall:timedFall?1:0,agent:keeper.agent,character:keeper.character,keeper_pid:keeper.pid}))u.searchParams.set(key,String(value));
 const r=await fetchImpl(u,{signal:AbortSignal.timeout(12000)}),data=await r.json(),identity=identityOf(r.headers,data),conflict=identityMismatch(keeper,identity);
 if(!r.ok||conflict||data.error||!identity.agent||!identity.character||identity.pid==null)throw Error('rail movecheck refused: '+(conflict??data.error??'keeper identity unverified'));
 return data;
}
export const provedRailMove=(probe,target)=>probe?.validation?.available===true&&probe.validation.moved===true&&probe.validation.arrived===true&&probe.validation.blocked!==true&&probe.validation.target?.x===target.x&&probe.validation.target?.y===target.y;
export const unsentRailGeometryRefusal=r=>r?.jumped===false&&r.cancelled!==true&&r.mover?.moved===false&&r.mover.left_room!==true&&r.mover.reason==='geometry_blocked'&&r.mover.validation?.available===true&&r.mover.validation.moved===false;
