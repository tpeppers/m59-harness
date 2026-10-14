// #movement: refine a declared ledge takeoff using stock gravity and collision.
// All coordinates at this API are named KOD/protocol points; declarations use CLIENT units.
import {protocolToClient,clientToProtocol} from './m59-finepos.mjs';
import {blockingBodySnapshot} from './m59-body-detour.mjs';

export function declaredJumpMoveOptions(declaration,vigor){
  if(!declaration?.from||!declaration?.to)return {ok:false,reason:'jump_undeclared'};
  if(declaration?.requires?.running===true&&!(Number.isFinite(vigor)&&vigor>=12))
    return {ok:false,reason:Number.isFinite(vigor)?'jump_needs_run':'jump_vigor_unreadable'};
  const p=declaration?.to_fine;
  return {ok:true,options:{fall:true,timedFall:true,...(p?{aimX:p.x/16+64,aimY:p.y/16+64}:{})}};
}

export function planDeclaredTakeoff(geo,body,declaration,{objects,selfId,roomFlags=0,overrideDepths=null,maxMs=500}={}){
  if(!geo?.collisionReady||!declaration?.from_fine||!declaration?.to_fine||![body?.x,body?.y].every(Number.isFinite))
    return {found:false,reason:'declared_fine_takeoff_unavailable'};
  const started=performance.now(),from=protocolToClient(body),landing=declaration.to_fine,
    options={slide:false,obstacles:blockingBodySnapshot(objects,selfId),roomFlags,overrideDepths},floor=geo.floorBaseAtClient(from.x,from.y);
  const shelf=geo.floorBaseAtClient(declaration.from_fine.x,declaration.from_fine.y);
  if(!Number.isFinite(floor)||!Number.isFinite(shelf)||Math.abs(floor-shelf)>64)return {found:false,reason:'declared_takeoff_wrong_shelf'};
  const candidates=[clientToProtocol(declaration.from_fine)];
  for(let row=declaration.from.row-1;row<=declaration.from.row+1;row++)for(let col=declaration.from.col-1;col<=declaration.from.col+1;col++)
    for(let y=row*64;y<(row+1)*64;y+=8)for(let x=col*64;x<(col+1)*64;x+=8)candidates.push({x,y});
  candidates.sort((a,b)=>Math.hypot(a.x-body.x,a.y-body.y)-Math.hypot(b.x-body.x,b.y-body.y));
  for(const takeoff of candidates){
    if(performance.now()-started>=maxMs)return {found:false,reason:'takeoff_search_budget'};
    const p=protocolToClient(takeoff),height=geo.floorBaseAtClient(p.x,p.y);
    if(!Number.isFinite(height)||Math.abs(height-floor)>64)continue;
    const walk=geo.traceFineMoveClient(from.x,from.y,p.x,p.y,options);
    if(!walk.arrived||walk.blocked)continue;
    const flight=geo.traceFineMoveClient(p.x,p.y,landing.x,landing.y,{...options,fall:true,timedFall:true});
    if(flight.arrived)return {found:true,takeoff,landing:clientToProtocol(landing),flight_ms:flight.fall_motion.elapsed_ms,ms:Math.round(performance.now()-started)};
  }
  return {found:false,reason:'no_proved_nearby_takeoff'};
}
