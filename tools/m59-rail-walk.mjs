// Execute one checked walking leg in the keeper, without a broker/read round trip
// at every bend. All movement still goes through the ordinary paced fine walker.
import {spreadEdges} from './m59-world.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {floorAt} from './m59-ground.mjs';
import {quantizeRailPoint,passedRailAim} from './m59-railfollow.mjs';
import {planRailForwardGap,railEndQueueReady,planStraightQueueAdvance} from './m59-rail-traffic.mjs';
import {canJoinDeclaredTakeoff} from './m59-jump-takeoff.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const bodyBlocked=r=>!r?.cancelled&&r?.arrived!==true&&(r?.reason==='object_blocked'||r?.geometry_rejections?.includes('object_blocked'));
export async function walkCheckedRail(session,args,settings){
 const started=(settings?.now??Date.now)(),movementGeneration=session.movementGeneration;
 const previous=session.passageConvoy,convoy=args?.queuePath&&args.convoy,last=args?.leg?.waypoints?.at(-1);
 if(convoy){
  if(typeof convoy.key!=='string'||!convoy.key||!Array.isArray(convoy.characters)||convoy.characters.length<1||convoy.characters.length>25||convoy.characters.some(n=>typeof n!=='string'||!n)||!last)throw Error('invalid checked convoy');
  session.passageConvoy={characters:[...new Set(convoy.characters)],flow:JSON.stringify([convoy.key,args.room,last.x,last.y])};
 }
 try{
  const result=await executeCheckedRail(session,args,settings);
  if(!result.arrived||!args.exit)return result;
  const remaining=(Number(args.timeoutMs)||600000)-((settings?.now??Date.now)()-started);
  if(remaining<=0)return {...result,arrived:false,reason:'rail_wait_budget_exhausted'};
  const crossed=await crossCheckedRailExit(session,args.exit,{timeoutMs:remaining,movementGeneration,now:settings?.now,wait:settings?.wait});
  return {...result,arrived:crossed.left===true,left_room:crossed.left===true,crossing:crossed};
 }
 finally{session.passageConvoy=previous;}
}
async function executeCheckedRail(session,{room,leg,nextJump=null,queueEnd=false,stayInLane=false,queuePath=false,timeoutMs=600000},
 {now=Date.now,wait=sleep,onProgress=()=>{}}={}){
 const points=leg?.waypoints,dense=leg?.sourceWaypoints??points;
 if(leg?.kind!=='walk'||!Array.isArray(points)||!points.length||points.length>8192||!Array.isArray(dense)||dense.length>32768||
   [...points,...dense].some(p=>![p?.x,p?.y].every(Number.isFinite)))throw Error('invalid checked walking leg');
 const c=session.need(),geo=session.world?.geometry,generation=session.movementGeneration,startRoom=c.room.id;
 if(!geo?.collisionReady||Number(session.world?.room?.num)!==Number(room))return {arrived:false,reason:'rail_room_or_geometry_changed'};
 const deadline=now()+Math.max(1,Math.min(600000,Number(timeoutMs)||600000)),floor=(x,y)=>floorAt(geo,x,y);
 let completed=0,steps=0,waits=0,confirmRetries=0;
 const progress=session.railProgress={room:Number(room),startedAt:now(),updatedAt:now(),phase:'walking',aim:0,total_aims:points.length,movedAt:now(),position:null};
 const position=()=>{const b=c.self;return b?{id:b.id,x:b.x,y:b.y,row:b.row,col:b.col}:null;};
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
 for(const [index,aim]of points.entries()){
  for(;;){
   if(fence())return finish(session.cancelledMovement({}));
   if(now()>=deadline)return finish({arrived:false,reason:'rail_wait_budget_exhausted'});
   const hold=session.pacer.holdStatus?.();if(hold?.active){Object.assign(progress,{phase:'waiting-cast',updatedAt:now()});await wait(Math.min(250,Math.max(1,deadline-now())));continue;}
   if(await join())return finish({arrived:false,joined_takeoff:true});
   const wire=quantizeRailPoint(aim,{floorAt:floor,edge:(a,b)=>geo.traceFineMoveClient(a.x,a.y,b.x,b.y)?.arrived===true});
   if(!wire.ok)return finish({arrived:false,reason:wire.reason,waypoint:index});
   Object.assign(progress,{updatedAt:now(),phase:'walking',aim:index,target:wire.protocol,position:position()});
   const before=position();
   if(stayInLane||queuePath){
    await confirm();if(fence())return finish(session.cancelledMovement({}));
    if(Math.hypot(c.self.x-wire.protocol.x,c.self.y-wire.protocol.y)<=(queuePath?0:3)){completed++;break;}
    const gap=planStraightQueueAdvance(geo,c.self,wire.protocol,{objects:c.room.objects,selfId:c.selfId,maxRise:queuePath?384:16,maxDrop:queuePath?Infinity:16,minAdvance:queuePath?1:4});
    if(!gap.found){waits++;Object.assign(progress,{queue_block:gap,phase:'waiting-body',updatedAt:now(),position:position(),body_waits:waits});await wait(Math.min(100,Math.max(1,deadline-now())));continue;}
    await session.standBeforeGo({shouldCancel:fence});if(fence())return finish(session.cancelledMovement({}));
    const r=await session.stepFine(gap.target.x,gap.target.y,{bodyDetour:true,movementGeneration:generation,
      targetGuard:({from,to})=>{const a=protocolToClient(from),b=protocolToClient(to),start=floor(a.x,a.y),land=floor(b.x,b.y);return Number.isFinite(start)&&Number.isFinite(land)&&Math.abs(start-gap.height)<=16&&Math.abs(land-gap.floor)<=16?null:{reason:'shelf_changed_before_send'};}});
    steps+=r.moved?1:0;Object.assign(progress,{updatedAt:now(),position:position(),reason:r.reason??null,blockedBy:r.objectId??null});onProgress({index,aim,reply:r});
    if(fence()||r.cancelled||r.left_room)return finish({...r,arrived:false});
    if(r.moved){progress.movedAt=now();continue;}
    const descending=queuePath&&r.reason==='geometry_blocked'&&Number.isFinite(r.validation?.motionZ?.max)&&Number.isFinite(r.validation?.destinationFloor)&&r.validation.motionZ.max>r.validation.destinationFloor+384;
    if(!descending&&!['object_blocked','casting_hold','collision_geometry_changed','position_confirmation_timeout'].includes(r.reason))return finish({...r,arrived:false});
    if(descending)Object.assign(progress,{phase:'waiting-descent',updatedAt:now()});
    waits++;await wait(Math.min(100,Math.max(1,deadline-now())));continue;
   }
   const r=await session.walkFine(wire.protocol.x,wire.protocol.y,{maxSteps:64,stride:48,arriveWithin:3,holdShelf:true,exactArrival:true,movementGeneration:generation});
   steps+=Number(r.steps)||0;const after=position();if(before&&after&&Math.hypot(after.x-before.x,after.y-before.y)>0){progress.movedAt=now();progress.waitSince=null;}
   Object.assign(progress,{updatedAt:now(),position:after,reason:r.reason??null,blockedBy:r.objectId??null});onProgress({index,aim,reply:r});
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
 for(;;){
  if(session.movementWasCancelled(generation))return {left:false,reason:'movement_cancelled'};
  if(session.world.room.num!==source)return {left:session.world.room.num===to,reason:'room_changed'};
  const candidates=spreadEdges(session.world.exits().filter(e=>e.to===to)).filter(e=>e.stand_on?.row===row&&e.stand_on?.col===col);
  if(!candidates.length)return {left:false,reason:'checked_exit_not_published'};
  const result=await session.leaveViaAny(candidates,{exact:true,movementGeneration:generation});
  if(result.left)return result;
  const traffic=result.tried?.length>0&&result.tried.every(e=>e.stage==='walk'&&e.crossing_packet_sent!==true&&e.why==='object_blocked');
  if(!traffic||now()>=deadline)return result;
  await session.confirmPosition();await wait(Math.min(250,Math.max(1,deadline-now())));
 }
}
