import{checkedExitCandidates}from'./m59-checked-exit-candidates.mjs';
import{exitConvoyBranch}from'./m59-exit-convoy.mjs';
import{adoptPassageConvoy}from'./m59-passage-admission.mjs';
import{preparedFineExitStage}from'./m59-session-walk.mjs';
// Execute one checked walking leg in the keeper, without a broker/read round trip
// at every bend. All movement still goes through the ordinary paced fine walker.
import {blockingBodySnapshot} from './m59-body-detour.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {floorAt} from './m59-ground.mjs';
import {quantizeRailPoint,passedRailAim} from './m59-railfollow.mjs';
import {planRailForwardGap,railEndQueueReady,planStraightQueueAdvance,planRailBodyDetour} from './m59-rail-traffic.mjs';
import {canJoinDeclaredTakeoff} from './m59-jump-takeoff.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const refusalDetail=r=>!r?.moved?{reason:r?.reason??null,traffic:r?.traffic??r?.validation?.traffic??null,zone:r?.zone??r?.validation?.zone??null,holder:r?.validation?.holder??r?.holder??null,admission_reason:r?.validation?.admission_reason??null,note:r?.note??r?.validation?.note??null}:null;
const bodyBlocked=r=>!r?.cancelled&&r?.arrived!==true&&(r?.reason==='object_blocked'||r?.geometry_rejections?.includes('object_blocked'));
const validCheckedLeg=leg=>leg?.kind==='walk'&&Array.isArray(leg.waypoints)&&leg.waypoints.length>0&&leg.waypoints.length<=8192&&leg.waypoints.every(p=>[p?.x,p?.y].every(Number.isFinite))&&Array.isArray(leg.sourceWaypoints??leg.waypoints)&&(leg.sourceWaypoints??leg.waypoints).length<=32768&&(leg.sourceWaypoints??leg.waypoints).every(p=>[p?.x,p?.y].every(Number.isFinite));
export async function walkCheckedRail(session,args,settings){
 if(!validCheckedLeg(args?.leg))throw Error('invalid checked walking leg');
 if(args.exit&&![args.exit.to,args.exit.row,args.exit.col].every(n=>Number.isInteger(n)&&n>0))throw Error('invalid checked exit');
 const started=(settings?.now??Date.now)(),movementGeneration=session.movementGeneration;
 const startClient=session.client,previous=session.passageConvoy,convoy=args?.convoy,last=args?.leg?.waypoints?.at(-1);
 if(convoy){
  if(typeof convoy.key!=='string'||!convoy.key||!Array.isArray(convoy.characters)||convoy.characters.length<1||convoy.characters.length>25||convoy.characters.some(n=>typeof n!=='string'||!n)||!last)throw Error('invalid checked convoy');
  session.passageConvoy={characters:[...new Set(convoy.characters)],flow:JSON.stringify([convoy.key,Number(args.room),...(args.exit?exitConvoyBranch(session.world.map,Number(args.room),args.exit):['point',last.x,last.y])])};
 }
 try{
  let result,exitReady=null,passageAdoption=null,crossingExit=args.exit;
  if(convoy&&session._passage&&Number(session.world?.room?.num)===Number(args.room)){if(!await session.confirmPosition())throw Error('rail_position_confirmation_timeout');if(session.movementWasCancelled(movementGeneration))return session.cancelledMovement({});passageAdoption=adoptPassageConvoy(session);if(passageAdoption.adopted)session.client?.observeSessionEvidence?.({kind:'action',opcode:'PASSAGE_ADOPTED',reason:JSON.stringify(passageAdoption)});}
  // A predecessor already inside the proved doorway must keep going outward,
  // never walk back through its follower to the rail's nominal anchor.
  if(args.exit&&args.leg?.kind==='walk'&&Array.isArray(args.leg.waypoints)&&args.leg.waypoints.length>0&&args.leg.waypoints.length<=8192&&args.leg.waypoints.every(p=>[p?.x,p?.y].every(Number.isFinite))&&Array.isArray(args.leg.sourceWaypoints??args.leg.waypoints)&&(args.leg.sourceWaypoints??args.leg.waypoints).length<=32768&&(args.leg.sourceWaypoints??args.leg.waypoints).every(p=>[p?.x,p?.y].every(Number.isFinite))&&Number(session.world?.room?.num)===Number(args.room)){
   const actual=await session.confirmPosition();if(!actual)throw Error('rail_position_confirmation_timeout');
   const published=checkedExitCandidates(session,args.exit.to);
   const candidates=published.filter(e=>e.stand_on?.row===args.exit.row&&e.stand_on?.col===args.exit.col);
   const branch=JSON.stringify(exitConvoyBranch(session.world.map,Number(args.room),args.exit));
   const aliases=candidates.some(e=>e.kind==='go'&&!e.locked)?published.filter(e=>e.kind==='go'&&!e.locked&&JSON.stringify(exitConvoyBranch(session.world.map,Number(args.room),{to:e.to,row:e.stand_on?.row,col:e.stand_on?.col}))===branch):[];
   exitReady=()=>{const ready=[...candidates,...aliases].find(exit=>preparedFineExitStage(session.world.geometry,session.client.self,exit));if(ready)crossingExit={to:args.exit.to,row:ready.stand_on.row,col:ready.stand_on.col};return !!ready;};
   if(exitReady()){result={arrived:true,already_at_opening:true,completed_aims:0,total_aims:args.leg.waypoints.length,steps:0};session.railProgress={room:args.room,startedAt:started,updatedAt:(settings?.now??Date.now)(),phase:'exit-ready',requested_exit:{...args.exit},resolved_exit:{...crossingExit},leg_end_client:{x:last.x,y:last.y},position:{id:session.client.selfId,x:session.client.self.x,y:session.client.self.y,row:session.client.self.row,col:session.client.self.col}};}
  }
  result??=await executeCheckedRail(session,args,{...settings,exitReady,passageAdoption});
  // Declared region exits can fire on the approach packet itself. A room
  // fence then stops the old leg; its positively observed intended landing is success.
  if(exitReady&&result.left_room===true&&session.client===startClient&&Number(session.world?.room?.num)===Number(args.exit.to)&&!session.movementWasCancelled(movementGeneration)&&session.client?.vitals?.()?.health?.value>0)return{...result,arrived:true,cancelled:false,crossing_while_approaching:true};
  if(!result.arrived||!args.exit)return{...result,passage_adoption:passageAdoption};
  const remaining=(Number(args.timeoutMs)||600000)-((settings?.now??Date.now)()-started);
  if(remaining<=0)return {...result,arrived:false,reason:'rail_wait_budget_exhausted'};
  const crossed=await crossCheckedRailExit(session,crossingExit,{timeoutMs:remaining,movementGeneration,now:settings?.now,wait:settings?.wait});
  if(session.railProgress)Object.assign(session.railProgress,{phase:crossed.left?'arrived':'stopped',resolved_exit:{...crossingExit},updatedAt:(settings?.now??Date.now)(),endedAt:(settings?.now??Date.now)()});
  return {...result,arrived:crossed.left===true,left_room:crossed.left===true,crossing:crossed,resolved_exit:crossingExit,passage_adoption:passageAdoption};
 }
 catch(error){
  if(error.message!=='rail_position_confirmation_timeout')throw error;
  const progress=session.railProgress;
  if(progress)Object.assign(progress,{phase:'stopped',reason:'position_confirmation_timeout',endedAt:(settings?.now??Date.now)(),updatedAt:(settings?.now??Date.now)()});
  return {arrived:false,reason:'position_confirmation_timeout',operationEnded:true,position:progress?.position??null,passage_adoption:progress?.passage_adoption??null};
 }
 finally{session.passageConvoy=previous;}
}
async function executeCheckedRail(session,{room,leg,exit=null,nextJump=null,queueEnd=false,stayInLane=false,queuePath=false,bodyDetour=false,timeoutMs=600000},
 {now=Date.now,wait=sleep,onProgress=()=>{},exitReady=null,passageAdoption=null}={}){
 const points=leg?.waypoints,dense=leg?.sourceWaypoints??points;
 if(leg?.kind!=='walk'||!Array.isArray(points)||!points.length||points.length>8192||!Array.isArray(dense)||dense.length>32768||
   [...points,...dense].some(p=>![p?.x,p?.y].every(Number.isFinite)))throw Error('invalid checked walking leg');
 const c=session.need(),geo=session.world?.geometry,generation=session.movementGeneration,startRoom=c.room.id;
 if(!geo?.collisionReady||Number(session.world?.room?.num)!==Number(room))return {arrived:false,reason:'rail_room_or_geometry_changed'};
 const deadline=now()+Math.max(1,Math.min(600000,Number(timeoutMs)||600000)),floor=(x,y)=>floorAt(geo,x,y);
 let completed=0,steps=0,waits=0,confirmRetries=0,skipThrough=-1;
 const progress=session.railProgress={room:Number(room),startedAt:now(),updatedAt:now(),phase:'walking',requested_exit:exit?{to:exit.to,row:exit.row,col:exit.col}:null,leg_end_client:{x:points.at(-1).x,y:points.at(-1).y},passage_adoption:passageAdoption,aim:0,total_aims:points.length,movedAt:now(),position:null};
 const position=()=>{const b=c.self;return b?{id:b.id,x:b.x,y:b.y,row:b.row,col:b.col,...(Number.isInteger(b.flags)?{flags:b.flags}:{})}:null;};
 const fence=()=>session.client!==c||c.room.id!==startRoom||session.movementWasCancelled(generation);
 const finish=r=>{Object.assign(progress,{updatedAt:now(),endedAt:now(),phase:r.arrived?'arrived':r.joined_takeoff?'takeoff-ready':r.queue_ready?'queue-ready':'stopped',reason:r.reason??null,position:position()});return {...r,completed_aims:completed,total_aims:points.length,steps,body_waits:waits,position:position()};};
 const confirm=async()=>{if(!await session.confirmPosition())throw Error('rail_position_confirmation_timeout');};
 const join=async()=>{
  if(!nextJump)return false;
  const b=c.self;if(!b)return false;
  // Only request the authoritative read when close enough to the declared lip.
  const p=protocolToClient(b),source=nextJump.from_fine;
  if(!source||Math.hypot(p.x-source.x,p.y-source.y)>2048)return false;
  await confirm();if(fence())return false;
  return canJoinDeclaredTakeoff(geo,c.self,nextJump,{objects:c.room.objects,selfId:c.selfId,stayInLane,requireActual:stayInLane});
 };
 const takeBodyDetour=async index=>{
  const detour=planRailBodyDetour(geo,c.self,leg,{objects:c.room.objects,selfId:c.selfId,fromIndex:index});
  Object.assign(progress,{phase:'detouring-body',body_detour:detour,updatedAt:now()});
  if(!detour.found)return{done:false};
  for(const target of detour.waypoints){
   const r=await session.walkFine(target.x,target.y,{maxSteps:32,stride:48,arriveWithin:0,holdShelf:true,exactArrival:true,movementGeneration:generation});steps+=Number(r.steps)||0;
   if(fence()||r.cancelled||r.left_room)return{terminal:finish({...r,arrived:false})};
   if(exitReady?.()){await confirm();if(fence())return{terminal:finish(session.cancelledMovement({}))};if(exitReady())return{terminal:finish({arrived:true,already_at_opening:true})};}
   if(!r.arrived)return{done:false};
  }
  return{done:true,index:detour.index};
 };
 for(const [index,aim]of points.entries()){
  if(index<=skipThrough)continue;
  for(;;){
   if(fence())return finish(session.cancelledMovement({}));
   if(now()>=deadline)return finish({arrived:false,reason:'rail_wait_budget_exhausted'});
   const hold=session.pacer.holdStatus?.();if(hold?.active){Object.assign(progress,{phase:'waiting-cast',updatedAt:now()});await wait(Math.min(250,Math.max(1,deadline-now())));continue;}
   // A body can enter the opening while resolving an earlier bend. Hand it
   // outward immediately instead of finishing stale approach waypoints.
   if(exitReady?.()){await confirm();if(fence())return finish(session.cancelledMovement({}));if(exitReady())return finish({arrived:true,already_at_opening:true});}
   if(await join())return finish({arrived:false,joined_takeoff:true});
   const wire=quantizeRailPoint(aim,{floorAt:floor,edge:(a,b)=>geo.traceFineMoveClient(a.x,a.y,b.x,b.y)?.arrived===true});
   if(!wire.ok)return finish({arrived:false,reason:wire.reason,waypoint:index});
   Object.assign(progress,{updatedAt:now(),phase:'walking',aim:index,target:wire.protocol,position:position()});
   const before=position();
   if(bodyDetour&&!queuePath&&!stayInLane){
    await confirm();if(fence())return finish(session.cancelledMovement({}));
    const from=protocolToClient(c.self),to=protocolToClient(wire.protocol),obstacles=blockingBodySnapshot(c.room.objects,c.selfId);
    const direct=geo.traceFineMoveClient(from.x,from.y,to.x,to.y,{slide:false,obstacles});
    if(!direct.arrived||direct.blocked){
     const detour=await takeBodyDetour(index);
     if(detour.terminal)return detour.terminal;
     if(detour.done){skipThrough=detour.index;completed+=skipThrough-index+1;progress.movedAt=now();break;}
     waits++;await wait(Math.min(150,Math.max(1,deadline-now())));continue;
    }
   }

   if(stayInLane||queuePath){
    await confirm();if(fence())return finish(session.cancelledMovement({}));
    if(queuePath){const actual=protocolToClient(c.self);
      if(passedRailAim(leg,aim,actual,{floor:floor(actual.x,actual.y),within:512,geo})){
        Object.assign(progress,{phase:'advanced-past-aim',updatedAt:now(),queue_advance:{aim:index,reason:'confirmed_connected_body_beyond_aim'}});
        completed++;break;
      }
    }
    if(Math.hypot(c.self.x-wire.protocol.x,c.self.y-wire.protocol.y)<=(queuePath?0:3)){completed++;break;}
    // The existing 1.5-square queue horizon can clear a crowded offset lip.
    // stepFine still paces by actual distance and rechecks bodies at send time.
    const gap=planStraightQueueAdvance(geo,c.self,wire.protocol,{objects:c.room.objects,selfId:c.selfId,maxRise:queuePath?384:16,maxDrop:queuePath?Infinity:16,maxAdvance:96,minAdvance:queuePath?1:4});
    if(!gap.found){
     // Preserve the people queue; a known NPC directly blocking the next prefix
     // can use the same fully checked local detour as open-ground convoy travel.
     if(queuePath){
      const npcObjects=new Map([...c.room.objects].filter(([id,o])=>id!==c.selfId&&Number.isInteger(o.flags)&&(o.flags&1)&&!(o.flags&4)));
      if(npcObjects.size){
       const b=c.self,dx=wire.protocol.x-b.x,dy=wire.protocol.y-b.y,length=Math.hypot(dx,dy),scale=length?Math.min(48,length)/length:0;
       const from=protocolToClient(b),to=protocolToClient({x:b.x+dx*scale,y:b.y+dy*scale}),terrain=geo.traceFineMoveClient(from.x,from.y,to.x,to.y,{slide:false}),occupied=geo.traceFineMoveClient(from.x,from.y,to.x,to.y,{slide:false,obstacles:blockingBodySnapshot(npcObjects,c.selfId)});
       if(terrain.arrived&&!terrain.blocked&&(!occupied.arrived||occupied.blocked)){
        Object.assign(progress,{queue_npc_detour:{ids:[...npcObjects.keys()],at:now()}});
        const detour=await takeBodyDetour(index);if(detour.terminal)return detour.terminal;
        if(detour.done){skipThrough=detour.index;completed+=skipThrough-index+1;progress.movedAt=now();break;}
       }
      }
     }
     waits++;Object.assign(progress,{queue_block:gap,phase:'waiting-body',updatedAt:now(),position:position(),body_waits:waits});await wait(Math.min(100,Math.max(1,deadline-now())));continue;
    }
    await session.standBeforeGo({shouldCancel:fence});if(fence())return finish(session.cancelledMovement({}));
    const r=await session.stepFine(gap.target.x,gap.target.y,{bodyDetour:true,movementGeneration:generation,
      targetGuard:({from,to})=>{const a=protocolToClient(from),b=protocolToClient(to),start=floor(a.x,a.y),land=floor(b.x,b.y);return Number.isFinite(start)&&Number.isFinite(land)&&Math.abs(start-gap.height)<=16&&Math.abs(land-gap.floor)<=16?null:{reason:'shelf_changed_before_send'};}});
    steps+=r.moved?1:0;Object.assign(progress,{updatedAt:now(),position:position(),reason:r.reason??null,blockedBy:r.objectId??null,last_refusal:refusalDetail(r)});onProgress({index,aim,reply:r});
    if(fence()||r.cancelled||r.left_room)return finish({...r,arrived:false});
    if(r.moved){progress.movedAt=now();continue;}
    const descending=queuePath&&r.reason==='geometry_blocked'&&Number.isFinite(r.validation?.motionZ?.max)&&Number.isFinite(r.validation?.destinationFloor)&&r.validation.motionZ.max>r.validation.destinationFloor+384;
    if(!descending&&!['object_blocked','casting_hold','collision_geometry_changed','position_confirmation_timeout'].includes(r.reason))return finish({...r,arrived:false});
    if(descending)Object.assign(progress,{phase:'waiting-descent',updatedAt:now()});
    waits++;await wait(Math.min(100,Math.max(1,deadline-now())));continue;
   }
   const r=await session.walkFine(wire.protocol.x,wire.protocol.y,{maxSteps:64,stride:48,arriveWithin:3,holdShelf:true,exactArrival:true,bodyDetour,movementGeneration:generation});
   steps+=Number(r.steps)||0;const after=position();if(before&&after&&Math.hypot(after.x-before.x,after.y-before.y)>0){progress.movedAt=now();progress.waitSince=null;}
   Object.assign(progress,{updatedAt:now(),position:after,reason:r.reason??null,blockedBy:r.objectId??null,last_refusal:refusalDetail(r)});onProgress({index,aim,reply:r});
   if(fence()||r.cancelled)return finish({...r,arrived:false,cancelled:true});
   if(r.arrived){completed++;confirmRetries=0;break;}
   if(session.pacer.holdStatus?.().active){await wait(Math.min(250,Math.max(1,deadline-now())));continue;}
   if(r.reason==='position_confirmation_timeout'&&confirmRetries++<3){await confirm();continue;}
   if(!bodyBlocked(r)&&r.reason!=='collision_geometry_changed')return finish(r);
   // A stopped walker may inspect the body map; never mix an external driver
   // with this native order, and never repeat an ambiguous transport write.
   await confirm();if(fence())return finish(session.cancelledMovement({}));
   if(queueEnd){const queued=railEndQueueReady(geo,c.self,leg,{objects:c.room.objects,selfId:c.selfId});
    if(queued.ready)return finish({arrived:false,queue_ready:true,queue_end:queued});}
   if(await join())return finish({arrived:false,joined_takeoff:true});
   if(bodyBlocked(r)){
    const gap=planRailForwardGap(geo,c.self,leg,{objects:c.room.objects,selfId:c.selfId,afterAim:aim});
    if(gap.found){
     const advanced=await session.walkFine(gap.target.x,gap.target.y,{maxSteps:64,stride:48,arriveWithin:0,holdShelf:true,exactArrival:true,movementGeneration:generation});
     steps+=Number(advanced.steps)||0;if(fence()||advanced.cancelled)return finish({...advanced,arrived:false,cancelled:true});
     const p=protocolToClient(c.self);
     if(passedRailAim(leg,aim,p,{floor:floor(p.x,p.y)})){completed++;break;}
     if(!advanced.arrived&&!bodyBlocked(advanced))return finish(advanced);
    }
   }
   waits++;Object.assign(progress,{phase:bodyBlocked(r)?'waiting-body':'waiting-animation',updatedAt:now(),waitSince:progress.waitSince??now(),body_waits:waits});await wait(Math.min(250,Math.max(1,deadline-now())));
  }
 }
 await confirm();if(fence())return finish(session.cancelledMovement({}));
 return finish({arrived:true});
}

// A prepared fine route may name the exact published exit branch. Keep that
// selection through native crossing; only positively unsent body refusals retry.
export async function crossCheckedRailExit(session,{to,row,col},{timeoutMs=60000,movementGeneration=session.movementGeneration,now=Date.now,wait=sleep}={}){
 if(![to,row,col].every(n=>Number.isInteger(n)&&n>0))throw Error('invalid checked exit');
 const generation=movementGeneration,source=session.world.room.num,deadline=now()+Math.min(180000,timeoutMs);
 const initialClient=session.client;
 for(;;){
  if(session.movementWasCancelled(generation))return {left:false,reason:'movement_cancelled'};
  if(session.world.room.num!==source)return {left:session.world.room.num===to,reason:'room_changed'};
  if(initialClient&&session.client!==initialClient)return{left:false,reason:'checked_exit_client_changed'};
  if(now()>=deadline)return{left:false,reason:'checked_exit_wait_budget_exhausted'};
  if(session.pacer?.holdStatus?.().active){
    if(session.railProgress)Object.assign(session.railProgress,{phase:'waiting-cast',updatedAt:now()});
    await wait(Math.min(250,Math.max(1,deadline-now())));continue;
  }
  const candidates=checkedExitCandidates(session,to).filter(e=>e.stand_on?.row===row&&e.stand_on?.col===col);
  if(!candidates.length)return {left:false,reason:'checked_exit_not_published'};
  if(session.railProgress)Object.assign(session.railProgress,{phase:'crossing-exit',updatedAt:now()});
  const result=await session.leaveViaAny(candidates,{exact:true,movementGeneration:generation});
  if(result.left)return result;
  const traffic=result.tried?.length>0&&result.tried.every(e=>e.why==='object_blocked'&&
    (e.stage==='walk'&&e.crossing_packet_sent!==true||e.stage==='edge'&&e.crossing_packet_sent===false));
  const unsentCast=result.tried?.length>0&&result.tried.every(e=>e.why==='casting_hold'&&e.crossing_packet_sent===false);
  if(unsentCast&&now()<deadline){await wait(Math.min(250,Math.max(1,deadline-now())));continue;}
  if(!traffic||now()>=deadline)return result;
  if(session.railProgress)Object.assign(session.railProgress,{phase:'waiting-exit-body',updatedAt:now(),exit_wait:{unsent:true,candidates:result.tried,nearby_bodies:[...(session.client?.room?.objects?.values?.()??[])].filter(o=>o.id!==session.client?.selfId&&(o.flags&1)&&Math.hypot(o.x-session.client.self.x,o.y-session.client.self.y)<96).map(o=>({id:o.id,name:typeof o.name==='string'?o.name:session.client?.rsc?.get?.(o.nameRsc),x:o.x,y:o.y}))}});
  await session.confirmPosition();await wait(Math.min(250,Math.max(1,deadline-now())));
 }
}
