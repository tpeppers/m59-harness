// #movement: refine a declared ledge takeoff using stock gravity and collision.
// All coordinates at this API are named KOD/protocol points; declarations use CLIENT units.
import {protocolToClient,clientToProtocol} from './m59-finepos.mjs';
import {blockingBodySnapshot,planBodyDetour} from './m59-body-detour.mjs';
import {MIN_NOMOVEON} from './m59-roo.mjs';

// A settled landing just short of its exact aim may finish on foot. Proximity
// alone cannot connect two shelves: retain body collision and a floor fence.
export function planDeclaredLanding(geo,body,declaration,{objects,selfId,roomFlags=0,overrideDepths=null,maxMs=100,within=32,maxWalk=64}={}){
 if(!geo?.collisionReady||body?.predicted||!declaration?.to_fine||![body?.x,body?.y].every(Number.isFinite))
  return {found:false,reason:'confirmed_declared_landing_unavailable'};
 const point=clientToProtocol(declaration.to_fine),p=protocolToClient(body);
 if(Math.hypot(body.x-point.x,body.y-point.y)>within)return {found:false,reason:'not_near_declared_landing'};
 const targetFloor=geo.floorBaseAtClient(declaration.to_fine.x,declaration.to_fine.y),height=geo.floorBaseAtClient(p.x,p.y);
 if(!Number.isFinite(targetFloor)||!Number.isFinite(height)||Math.abs(height-targetFloor)>384)
  return {found:false,reason:'not_on_declared_landing_shelf'};
 const minimumFloor=targetFloor-384,plan=planBodyDetour(geo,body,point,{refine:true,objects,selfId,roomFlags,overrideDepths,
  minimumFloor,marginSquares:2,maxRangeSquares:8,maxNodes:6000,maxMs});
 if(!plan.found)return {found:false,reason:plan.reason??'landing_ground_approach_unproved'};
 let previous=body,distance=0;
 for(const q of plan.waypoints){distance+=Math.hypot(q.x-previous.x,q.y-previous.y);previous=q;}
 return distance<=maxWalk?{found:true,point,minimumFloor,waypoints:plan.waypoints}:
  {found:false,reason:'landing_ground_approach_too_long'};
}

export function declaredJumpMoveOptions(declaration,vigor){
  if(!declaration?.from||!declaration?.to)return {ok:false,reason:'jump_undeclared'};
  if(declaration?.requires?.running===true&&!(Number.isFinite(vigor)&&vigor>=12))
    return {ok:false,reason:Number.isFinite(vigor)?'jump_needs_run':'jump_vigor_unreadable'};
  const p=declaration?.to_fine;
  return {ok:true,options:{fall:true,timedFall:true,...(p?{aimX:p.x/16+64,aimY:p.y/16+64}:{})}};
}

export function planDeclaredTakeoff(geo,body,declaration,{objects,selfId,roomFlags=0,overrideDepths=null,maxMs=500,stayInLane=false,actualOnly=false}={}){
  if(!geo?.collisionReady||!declaration?.from_fine||!declaration?.to_fine||![body?.x,body?.y].every(Number.isFinite))
    return {found:false,reason:'declared_fine_takeoff_unavailable'};
  if(stayInLane&&Math.floor(body.x/64)!==declaration.from.col)return{found:false,reason:'declared_lane_mismatch'};
  const started=performance.now(),from=protocolToClient(body),landing=declaration.to_fine,
    options={slide:false,obstacles:blockingBodySnapshot(objects,selfId),roomFlags,overrideDepths},floor=geo.floorBaseAtClient(from.x,from.y);
  const shelf=geo.floorBaseAtClient(declaration.from_fine.x,declaration.from_fine.y);
  if(!Number.isFinite(floor)||!Number.isFinite(shelf)||Math.abs(floor-shelf)>64)return {found:false,reason:'declared_takeoff_wrong_shelf'};
  let laneNpcAlignment=null;
  // Once a queued traveler has a terrain-proved flight from its actual lip,
  // another body is a wait, not a reason to cross the neighboring queue.
  if((stayInLane||actualOnly)&&Math.abs(Math.floor(body.y/64)-declaration.from.row)<=1&&Math.abs(Math.floor(body.x/64)-declaration.from.col)<=1){
    const terrain=geo.traceFineMoveClient(from.x,from.y,landing.x,landing.y,{...options,obstacles:[],fall:true,timedFall:true});
    if(terrain.arrived){
      const dx=landing.x-from.x,dy=landing.y-from.y,length2=dx*dx+dy*dy;
      const blockers=options.obstacles.filter(o=>{const t=length2?Math.max(0,Math.min(1,((o.x-from.x)*dx+(o.y-from.y)*dy)/length2)):0;return Math.hypot(o.x-from.x-t*dx,o.y-from.y-t*dy)<MIN_NOMOVEON;});
      const occupied=blockers.length>0;
      const flight=occupied?null:geo.traceFineMoveClient(from.x,from.y,landing.x,landing.y,{...options,fall:true,timedFall:true});
      if(flight?.arrived)return{found:true,takeoff:{x:body.x,y:body.y},landing:clientToProtocol(landing),flight_ms:flight.fall_motion.elapsed_ms,ms:Math.round(performance.now()-started)};
      const knownNpc=blockers.length>0&&blockers.every(o=>Number.isInteger(objects?.get(o.id)?.flags)&&!(objects.get(o.id).flags&4));
      if(actualOnly||!stayInLane||!knownNpc)return{found:false,reason:'declared_lane_occupied',blockers:blockers.map(o=>({id:o.id,...clientToProtocol(o),flags:objects?.get(o.id)?.flags??null}))};
      laneNpcAlignment=blockers.map(o=>o.id);
    }
  }
  if(actualOnly)return {found:false,reason:'actual_takeoff_unproved'};
  const candidates=[{x:body.x,y:body.y},clientToProtocol(declaration.from_fine)];
  for(let row=declaration.from.row-1;row<=declaration.from.row+1;row++)for(let col=declaration.from.col-1;col<=declaration.from.col+1;col++)
    for(let y=row*64;y<(row+1)*64;y+=8)for(let x=col*64;x<(col+1)*64;x+=8)candidates.push({x,y});
  candidates.sort((a,b)=>Math.hypot(a.x-body.x,a.y-body.y)-Math.hypot(b.x-body.x,b.y-body.y));
  for(const takeoff of candidates){
    if(stayInLane){
      const dx=landing.x-from.x,dy=landing.y-from.y;
      if(Math.floor(takeoff.x/64)!==declaration.from.col||Math.floor(body.x/64)!==declaration.from.col||
         Math.hypot(takeoff.x-body.x,takeoff.y-body.y)>16||
         (takeoff.x-body.x)*dx+(takeoff.y-body.y)*dy<0)continue;
    }
    // The public jump verb permits only the declared source's one-square
    // neighborhood, even when a farther same-shelf flight is physically valid.
    if(Math.abs(Math.floor(takeoff.y/64)-declaration.from.row)>1||Math.abs(Math.floor(takeoff.x/64)-declaration.from.col)>1)continue;
    if(performance.now()-started>=maxMs)return {found:false,reason:'takeoff_search_budget'};
    const p=protocolToClient(takeoff),height=geo.floorBaseAtClient(p.x,p.y);
    if(!Number.isFinite(height)||Math.abs(height-floor)>64)continue;
    const walk=geo.traceFineMoveClient(from.x,from.y,p.x,p.y,options);
    if(!walk.arrived||walk.blocked)continue;
    // Session.step waits/refuses a flight whose straight lane is occupied.
    // The physics tracer may slide round that body and still report arrived;
    // that does not prove the unchanged lane the native jump guard will use.
    const dx=landing.x-p.x,dy=landing.y-p.y,length2=dx*dx+dy*dy;
    if(options.obstacles.some(o=>{const t=length2?Math.max(0,Math.min(1,((o.x-p.x)*dx+(o.y-p.y)*dy)/length2)):0;return Math.hypot(o.x-p.x-t*dx,o.y-p.y-t*dy)<MIN_NOMOVEON;}))continue;
    const flight=geo.traceFineMoveClient(p.x,p.y,landing.x,landing.y,{...options,fall:true,timedFall:true});
    if(flight.arrived)return {found:true,takeoff,...(laneNpcAlignment?{alignment:{same_lane:true,npc_blockers:laneNpcAlignment}}:{}),landing:clientToProtocol(landing),flight_ms:flight.fall_motion.elapsed_ms,ms:Math.round(performance.now()-started)};
  }
  return {found:false,reason:'no_proved_nearby_takeoff'};
}

// Join the next declared crossing from a nearby actual ledge, without walking
// backward to the last serialized approach aim. The complete ground+flight proof remains.
export function canJoinDeclaredTakeoff(geo,body,declaration,{within=2048,objects,selfId,stayInLane=false,requireActual=false}={}){
 if(!declaration?.from_fine||![body?.x,body?.y].every(Number.isFinite))return false;
 const p=protocolToClient(body);
 if(Math.hypot(p.x-declaration.from_fine.x,p.y-declaration.from_fine.y)>within)return false;
 const plan=planDeclaredTakeoff(geo,body,declaration,{objects,selfId,stayInLane,actualOnly:requireActual});
 return plan.found&&(!requireActual||plan.takeoff.x===body.x&&plan.takeoff.y===body.y);
}


// The native jump owns posture too. Unlike the general rest tool, this does not
// refresh stats or wait for a stat reply before every rider's flight.
export async function prepareDeclaredJump(session,{now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=30000}={}){
 const c=session.need(),room=c.room.id,body=c.selfId??c.self?.id,generation=session.movementGeneration,deadline=now()+timeoutMs;
 const cancelled=()=>session.client!==c||c.room.id!==room||(c.selfId??c.self?.id)!==body||session.movementWasCancelled(generation);
 while(session.pacer.holdStatus?.().active){if(cancelled())return{ok:false,cancelled:true,reason:'movement_cancelled'};if(now()>=deadline)return{ok:false,reason:'jump_cast_hold_timeout'};await wait(Math.min(100,Math.max(1,deadline-now())));}
 if(cancelled())return{ok:false,cancelled:true,reason:'movement_cancelled'};
 if(c.lastPostureCommand?.verb!=='stand'||c.lastPostureCommand.room_object_id!==room)await session.standBeforeGo({shouldCancel:cancelled});
 return cancelled()?{ok:false,cancelled:true,reason:'movement_cancelled'}:{ok:true};
}
