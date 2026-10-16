// Admit a transit before entering a constrained room, across script processes.
// Passage packets retain their separate live collision/admission checks.
import {randomUUID} from 'node:crypto';
import {dirname,basename,join} from 'node:path';
import {stateFileFor,rosterGameEndpoint} from './m59-fleetpath.mjs';
import {fileSpotClaimsEnabled,configureSpotClaimStore,spotClaimNamespace,
 reserveFileTraversal,markFileTraversal,releaseFileTraversal} from './m59-spotclaims.mjs';

function defaultStore(ctx){
 if(!fileSpotClaimsEnabled()){
  const fleetPath=stateFileFor(ctx.fleet),endpoint=rosterGameEndpoint(fleetPath);
  if(!endpoint)throw Error('traversal_admission_server_indeterminate');
  const parent=dirname(fleetPath),substrate=basename(parent)==='fleets'?dirname(parent):parent;
  configureSpotClaimStore({directory:process.env.M59_SPOT_CLAIMS_DIR||join(substrate,'.spot-claims'),
   namespace:process.env.M59_SPOT_CLAIMS_NAMESPACE||spotClaimNamespace({fleetPath,...endpoint})});
 }
 return {reserve:reserveFileTraversal,mark:markFileTraversal,release:releaseFileTraversal};
}
const fresh=(p,agent,now)=>p?.agent===agent&&p.confirmed===true&&Number.isInteger(p.room)&&
 Number.isFinite(p.at)&&Math.abs(now-p.at)<=5000;

export async function withTraversalAdmission(ctx,{room,read,run,waitQueued=null,
 deadline=Date.now()+7200000,pollMs=1000,store=null,now=Date.now,
 sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(!Number.isSafeInteger(room)||!ctx.agent||!read||!run)throw Error('traversal_admission_incomplete');
 store??=defaultStore(ctx);
 const token=randomUUID();let lease,entered=false,cleared=false,parked=false;
 const evidence={room,phase:'waiting',started_at:now()};
 (ctx.state??={}).traversalAdmission=evidence;
 const own=async()=>{
  const p=await read(ctx.agent);
  if(!fresh(p,ctx.agent,now()))throw Error('traversal_own_position_unconfirmed');
  return p;
 };
 try{
  while(!lease){
   if(now()>=deadline)throw Error('traversal_admission_queue_budget');
   const p=await own();
   if(now()>=deadline)throw Error('traversal_admission_queue_budget');
   const got=store.reserve(ctx.agent,room,token);
   if(!got)throw Error('traversal_admission_store_unavailable');
   if(got.ok){lease=got.lease;break;}
   const holder=got.lease;
   evidence.holder=holder?.agent;
   // A failed or dead driver can leave a living body inside. The claim stays
   // until this exact agent has a fresh, confirmed position outside the room.
   // A live admitted driver still owns its approach in the preceding room.
   // The store cannot release this ticket before entry, so probing its body
   // here only fills its packet queue while it needs to walk or take cover.
   // Re-read the atomic lease on the next poll; entered, stopped or dead
   // drivers retain the existing cached hint + fresh outside-position proof.
   const approaching=holder?.phase==='admitted'&&holder.driver_alive===true;
   const seen=approaching?null:holder?.agent===ctx.agent?p:await read(holder?.agent,{cached:true}).catch(()=>null);
   const proof=holder&&Number.isInteger(seen?.room)&&seen.room!==holder.room?
    (fresh(seen,holder.agent,now())?seen:await read(holder.agent).catch(()=>null)):null;
   if(holder&&fresh(proof,holder.agent,now())&&store.release(holder,proof))continue;
   if(waitQueued&&!parked){
    evidence.parking_attempts=(evidence.parking_attempts??0)+1;
    // No available cover is a scene limitation, not a failed journey or an
    // admission grant. Retry the claim before another parking attempt so a
    // waiter can leave a crowded arrival as soon as its predecessor clears.
    parked=(await waitQueued())!==false;evidence.parked=parked;
   }
   await sleep(Math.min(pollMs,Math.max(1,deadline-now())));
  }
  evidence.phase='admitted';evidence.admitted_at=now();delete evidence.holder;
  const result=await run({
   entered:async()=>{
    const p=await own();if(p.room!==room)throw Error('traversal_entry_unconfirmed');
    if(!store.mark(lease,'entered'))throw Error('traversal_admission_lost');
    entered=true;evidence.phase='entered';evidence.entered_at=now();
   },
   cleared:async()=>{
    const p=await own();
    if(!entered||p.room===room||!store.release(lease,p))throw Error('traversal_exit_unconfirmed');
    cleared=true;evidence.phase='cleared';evidence.cleared_at=now();
   },
  });
  if(!cleared)throw Error('traversal_exit_unconfirmed');
  return result;
 }finally{
  if(lease&&!cleared){
   store.mark(lease,'stopped');
   const proof=await own().catch(()=>null);
   if(proof)store.release(lease,proof);
   evidence.phase='stopped';evidence.stopped_at=now();
  }
  if(!lease){evidence.phase='not_admitted';evidence.stopped_at=now();}
 }
}
