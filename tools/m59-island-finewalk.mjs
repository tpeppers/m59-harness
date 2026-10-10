// #movement: follow the operator's Hollows route with body-seeded, checked fine rails.
import {cutRail,furthestTraceable,chordWalkable} from './m59-railcut.mjs';
import {protocolToClient,clientToProtocol,finePosition,keeperPortFor} from './m59-finepos.mjs';
import {lookupKeeperBand} from './runtime/keeper-bands.mjs';
import {applyDoorState} from './m59-routes.mjs';
import {roomGeometry,floorAt} from './m59-ground.mjs';
import {safeSpots,hasAnyFooting} from './m59-safespots.mjs';
import {foodValue} from './m59-items.mjs';
import {originLabel} from './m59-move-origin.mjs';
import {currentCallOrigin} from './m59-fleetscript.mjs';

export function checkIslandCancellation(ctx,status){
  const cancel=status?.movement?.last_cancel,start=ctx.state?.islandCancelFence;
  if(start!=null&&cancel?.at>=start&&cancel.by?.source!=='keeper'&&
     cancel.by_label!==originLabel(ctx.origin??currentCallOrigin()))throw Error('island_walk_cancelled_by_operator');
}

const finePorts=new Map();
export async function readIslandFinePosition(ctx,look){
  const key=ctx.fleet+':'+ctx.agent;
  let observed,snapshot;
  const fetchState=async(port,path)=>{
    const r=await fetch('http://127.0.0.1:'+port+path,{signal:AbortSignal.timeout(9000)});
    const state=await r.json();
    if(state.agent!==ctx.agent)throw Error('island_keeper_identity_mismatch');
    snapshot=state;
    observed=state.doors?.observed;
    return state;
  };
  let port=finePorts.get(key),position;
  if(port)position=await finePosition(ctx.agent,{port,fetchState}).catch(()=>null);
  if(!position?.ok){
    if(!ctx.fleet)throw Error('island_fine_position_requires_fleet');
    const band=lookupKeeperBand(ctx.fleet,{registryPath:process.env.M59_KEEPER_BAND_REGISTRY||undefined});
    if(!band)throw Error('island_keeper_band_unavailable');
    port=await keeperPortFor(ctx.agent,{bands:[[band.base,band.end]]});
    if(!port)throw Error('island_keeper_unavailable');
    position=await finePosition(ctx.agent,{port,fetchState});finePorts.set(key,port);
  }
  const body=look??{room:snapshot.room,you:snapshot.you,hp:snapshot.hp,vigor:snapshot.vigor};
  return {...bindIslandFinePosition(body,position),sector_heights:observed,movement:snapshot.movement};
}
export function bindIslandFinePosition(look,position){
  if(!position?.ok||position.fresh!==true||position.room!==look.room?.num)throw Error('island_fine_position_unconfirmed');
  if(!Number.isFinite(position.protocol?.x)||!Number.isFinite(position.protocol?.y))throw Error('island_fine_position_unreadable');
  return {...look,you:{...look.you,...position.square,...position.protocol}};
}

// Rest alone caps vigor at 80. Eat carried, source-classified food while on
// the observed recovery wall; fresh handles avoid save-renumbered inventory.
export async function eatIslandAtWall(ctx,onSample=()=>{},{target=160,maxBites=12,settleMs=2500}={}){
  let initial;
  const read=async()=>{
    const l=await ctx.call('look',{agent:ctx.agent});onSample(l);
    if(ctx.state?.islandCancelFence!=null)checkIslandCancellation(ctx,await ctx.call('status',{agent:ctx.agent,brief:true}));
    if(!Number.isFinite(l.hp?.value)||!Number.isFinite(l.hp?.max)||l.hp.max<=0)throw Error('traveller_health_unreadable');
    if(l.hp.value<=0||l.room?.num===1)throw Error('traveller_died');
    if(initial&&l.hp.max<initial.hp.max)throw Error('traveller_lost_max_health');
    if(initial&&l.room?.num!==initial.room.num)throw Error('meal_unexpected_room');
    initial??=l;return l;
  };
  let l=await read(),bites=0;const blocked=new Set();
  while(Number.isFinite(l.vigor?.value)&&l.vigor.value<target&&bites<maxBites){
    const pack=await ctx.call('inventory',{agent:ctx.agent});
    const meal=(pack.items??[]).filter(i=>i.id>0&&!blocked.has(i.name)&&(foodValue(i.name)?.nutrition??0)>0)
      .sort((a,b)=>{
        const x=foodValue(a.name),y=foodValue(b.name);
        return y.nutrition/Math.max(1,y.filling)-x.nutrition/Math.max(1,x.filling)||y.nutrition-x.nutrition;
      })[0];
    if(!meal)break;
    const before=l.vigor.value;
    await ctx.call('act',{agent:ctx.agent,verb:'eat',target:meal.id});bites++;
    await new Promise(r=>setTimeout(r,settleMs));l=await read();
    if(!(l.vigor?.value>before))blocked.add(meal.name);
  }
  return {bites,vigor:l.vigor?.value};
}

export async function recoverIslandFineWalk(ctx,{deadline,read,pollMs=1000,onSample=()=>{}}={}){
  for(;;){
    const s=await ctx.call('status',{agent:ctx.agent,brief:true}),pre=s.movement?.last_preempted;
    if(pre?.by?.source!=='keeper'||pre.preempted?.ordered_by!==originLabel(ctx.origin??currentCallOrigin()))return false;
    const {l}=await read(),wall=s.autopilot_status?.safe_spot;
    if(wall?.works&&wall.at?.row===l.you.row&&wall.at?.col===l.you.col){
      await ctx.call('rest_up',{agent:ctx.agent,to:1,max_seconds:30},45000);
      await read();await eatIslandAtWall(ctx,onSample);await read();
      await ctx.call('rest',{agent:ctx.agent,stand:true});return true;
    }
    if(Date.now()>=deadline)return false;
    if(s.movement?.order&&s.movement.order.origin?.source!=='keeper')return false;
    await new Promise(r=>setTimeout(r,pollMs));
  }
}
// KOD/protocol fine points from the successful final stretch of the human walk.
export const HOLLOWS_OUT_POINTS=[
  {x:1344,y:3076}, // approach to the little western cavern, r48c21
  {x:935,y:3351},  // foot of the western climb, r52c14
  {x:880,y:2591},  // top of the climb, r40c13
  {x:2410,y:1062}, // upper passage, r16c37
  {x:3991,y:1160}, // after the eastward drop, r18c62
  {x:4968,y:649},  // northern east exit approach, r10c77
];
let hollowsCrossing=Promise.resolve();
async function crossingTurn(fn,whileWaiting){
  const previous=hollowsCrossing;let release;
  hollowsCrossing=new Promise(r=>{release=r;});
  try{
    let ready=false;previous.then(()=>{ready=true;});
    while(!ready){await whileWaiting();await new Promise(r=>setTimeout(r,1000));}
    return await fn();
  }finally{
    // A cancelled waiter must not let its successor overlap the current jumper.
    previous.then(release);
  }
}
export function shelteredIslandAim(waypoints,body,{fromIndex=0,aim,squares,edge}={}){
  if(!aim||!squares?.size)return aim;
  for(let i=aim.i;i>fromIndex;i--){
    const p=waypoints[i];if(!p)continue;
    const row=Math.floor(p.y/1024)+1,col=Math.floor(p.x/1024)+1;
    if(squares.has(row+','+col)&&Math.hypot(p.x-body.x,p.y-body.y)>=128&&chordWalkable(body,p,{edge,lattice:128}).ok)
      return {...p,i,sheltered:true};
  }
  return aim;
}
export const islandFineStepBudget=(body,aim)=>Math.ceil(Math.hypot(aim.x-body.x,aim.y-body.y)/(16*48))+2;
export function cutIslandRail(body,goal,options){
  const first=cutRail(body,goal,options);
  if(first.bridgeOk)return first;
  // The closest rounded grid point can lie across a wall. Try nearby seeds only
  // after proving the entire bridge from the observed body to each candidate.
  const lattice=options.lattice??128,candidates=[];
  for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++){
    const seed={x:first.seed.x+dx*lattice,y:first.seed.y+dy*lattice};
    const distance=Math.hypot(seed.x-body.x,seed.y-body.y);
    if(distance===0||seed.x<0||seed.y<0||seed.x>=options.bounds.w||seed.y>=options.bounds.h)continue;
    if(chordWalkable(body,seed,{edge:options.edge,lattice}).ok)candidates.push({seed,distance});
  }
  for(const {seed} of candidates.sort((a,b)=>a.distance-b.distance).slice(0,8)){
    const cut=cutRail(seed,goal,options);
    if(cut.ok&&cut.bridgeOk)return {...cut,bridgeOk:true,waypoints:[{...body,f:options.floorAt?.(body.x,body.y)},...cut.waypoints],alternateSeed:true};
  }
  return first;
}
export const islandTrafficRefusal=reply=>reply?.reason==='object_blocked'||reply?.geometry_rejections?.includes('object_blocked')===true;
export async function confirmIslandFineArrival(read,aim,{attempts=3,settleMs=250}={}){
  let observation,error;
  for(let i=0;i<attempts;i++){
    await new Promise(r=>setTimeout(r,settleMs));
    observation=await read();error=Math.hypot(observation.body.x-aim.x,observation.body.y-aim.y);
    if(error<=128)break;
  }
  return {...observation,error};
}
export async function checkedIslandWalk(ctx,target,{room,budgetMs=180000,onSample=()=>{}}={}){
  const {agent,call}=ctx,geo=roomGeometry(room),goal=protocolToClient(target),started=Date.now();
  if(!geo?.collisionReady)throw Error('fine_route_geometry_unavailable');
  const edge=(a,b)=>geo.traceFineMoveClient(a.x,a.y,b.x,b.y)?.arrived===true;
  const squares=new Set(safeSpots(geo,{limit:Infinity}).filter(s=>!s.rim&&hasAnyFooting(geo,s.row,s.col)).map(s=>s.row+','+s.col));
  const read=async()=>{
    const l=await readIslandFinePosition(ctx);onSample(l);
    checkIslandCancellation(ctx,l);
    if(l.room?.num!==room)throw Error('fine_route_unexpected_room');
    if(room===27){
      if(![1,2,3,4,5].every(id=>l.sector_heights?.[id]===24))throw Error('island_cave_requires_observed_dispel');
      const applied=applyDoorState({rooms:{27:{num:27}}},27,l.sector_heights,{geometryOf:()=>geo});
      if(applied.unbaked||applied.state!=='sector1@24+sector2@24+sector3@24+sector4@24+sector5@24')throw Error('island_cave_open_mask_unavailable');
    }
    if(!Number.isFinite(l.hp?.value)||!Number.isFinite(l.hp?.max)||l.hp.max<=0)throw Error('traveller_health_unreadable');
    if(l.hp.value<=0)throw Error('traveller_died');
    const body=protocolToClient(l.you);if(!Number.isFinite(body.x)||!Number.isFinite(body.y))throw Error('fine_route_position_unreadable');
    return {l,body};
  };
  let {l,body}=await read(),cut=null,index=0,recuts=0,commands=0,trafficWaits=0,shelteredStops=0,recoveries=0,confirmationRetries=0,stride=48;
  const expectedFloor=floorAt(geo,goal.x,goal.y);
  while(Date.now()-started<budgetMs){
    const distance=Math.hypot(body.x-goal.x,body.y-goal.y),actualFloor=floorAt(geo,body.x,body.y);
    if(distance<=128&&Number.isFinite(actualFloor)&&Number.isFinite(expectedFloor)&&Math.abs(actualFloor-expectedFloor)<=384)
      return {ok:true,commands,recuts,shelteredStops,end:l.you};
    if(!cut){
      cut=cutIslandRail(body,goal,{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y),lattice:128});
      if(!cut.ok||!cut.bridgeOk){
        ctx.state.islandFineFailure={room,target,body,cut:{ok:cut.ok,bridgeOk:cut.bridgeOk,why:cut.why,seed:cut.seed,visited:cut.visited},
          floor:floorAt(geo,body.x,body.y),seedFloor:floorAt(geo,cut.seed.x,cut.seed.y)};
        throw Error('fine_route_cut_failed');
      }index=0;
    }
    const direct=furthestTraceable(cut.waypoints,body,{edge,fromIndex:index,maxAhead:24,budget:2048,lattice:128});
    const aim=shelteredIslandAim(cut.waypoints,body,{fromIndex:index,aim:direct,squares,edge});
    if(!aim||aim.tooClose||!chordWalkable(body,aim,{edge,lattice:128}).ok)throw Error('fine_route_chord_not_proved');
    const wire=clientToProtocol(aim),quantized=protocolToClient(wire);
    if(!chordWalkable(body,quantized,{edge,lattice:128}).ok)throw Error('fine_route_wire_chord_not_proved');
    const before=body,reply=await call('walk_to',{agent,...wire,fine:true,stride,max_steps:Math.ceil(Math.hypot(body.x-aim.x,body.y-aim.y)/(16*stride))+2,arrive_within:3,exact_arrival:true,hold_shelf:true},30000);
    commands++;({l,body}=await read());
    let error=Math.hypot(body.x-aim.x,body.y-aim.y);
    if(reply.arrived===true&&error>128){
      // A save or correction can overtake the predicted walk reply. Never accept
      // that prediction as arrival; reread, then retry an unchanged body twice.
      ({l,body,error}=await confirmIslandFineArrival(read,aim));
      if(error>128&&Math.hypot(body.x-before.x,body.y-before.y)<64&&confirmationRetries++<2){
        await new Promise(r=>setTimeout(r,750));continue;
      }
    }
    if(error>128||reply.arrived!==true){
      if(/cancelled/.test(reply.reason??'')&&recoveries<3&&await recoverIslandFineWalk(ctx,{deadline:started+budgetMs,read,onSample})){
        recoveries++;({l,body}=await read());cut=null;continue;
      }
      if(islandTrafficRefusal(reply)&&trafficWaits++<120){await new Promise(r=>setTimeout(r,1000));if(Math.hypot(body.x-before.x,body.y-before.y)>=64)cut=null;continue;}
      if(reply.shelf_refusals>0&&stride>8){stride=stride===48?16:8;cut=null;continue;}
      if(Math.hypot(body.x-before.x,body.y-before.y)<64||++recuts>4){
        ctx.state.islandFineFailure={room,target,wire,before,body,reply,status:await call('status',{agent,brief:true})};
        throw Error('fine_route_ended_short_'+(reply.reason??'position'));
      }
      cut=null;
    }else {confirmationRetries=0;index=aim.i;if(aim.sheltered)shelteredStops++;}
  }
  throw Error('fine_route_budget');
}
export async function walkHollowsOut(ctx,options={}){
  const {agent,call}=ctx;
  const deadline=Date.now()+(options.budgetMs??180000);
  const remaining=()=>({...options,room:2502,budgetMs:Math.max(1,deadline-Date.now())});
  await checkedIslandWalk(ctx,{x:2201,y:2650},remaining());
  await crossingTurn(async()=>{
  // A declared landing occupied by another follower is not permission to jump
  // elsewhere. Let the preceding traveler clear the landing along the same rail.
  await checkedIslandWalk(ctx,{x:2201,y:2650},remaining());
  const before=await readIslandFinePosition(ctx);
  if(!Number.isFinite(before.vigor?.value)||before.vigor.value<12)throw Error('hollows_crossing_requires_running_vigor');
  const jump=await call('jump',{agent,to_row:44,to_col:27});
  await new Promise(r=>setTimeout(r,5500));
  const landed=await readIslandFinePosition(ctx);options.onSample?.(landed);
  if(landed.room?.num!==2502||Math.hypot(landed.you.x-1750,landed.you.y-2824)>10)throw Error('hollows_crossing_not_observed_'+(jump.reason??'landing'));
  await checkedIslandWalk(ctx,HOLLOWS_OUT_POINTS[0],remaining());
  },async()=>{
    const waiting=await readIslandFinePosition(ctx);options.onSample?.(waiting);
    checkIslandCancellation(ctx,waiting);
    if(Date.now()>=deadline)throw Error('hollows_crossing_queue_budget');
    if(waiting.room?.num!==2502||waiting.hp?.value<=0)throw Error('hollows_crossing_queue_body_changed');
  });
  for(const point of HOLLOWS_OUT_POINTS.slice(1)){
    await checkedIslandWalk(ctx,point,remaining());
    console.log('HOLLOWS POINT '+JSON.stringify({agent,target:point}));
  }
}
export async function approachIslandDoor(ctx,options={}){
  // Fine point inside the real go-trigger, in KOD/protocol units.
  await checkedIslandWalk(ctx,{x:4029,y:385},{room:2505,...options});
  await ctx.call('rest',{agent:ctx.agent,stand:true});
  await ctx.call('act',{agent:ctx.agent,verb:'go'});
}
export async function approachMainlandCaveExit(ctx,options={}){
  // Its west boundary is r11c1. Observe the complete Dispel state before using
  // its baked mask, then approach with the same checked fine movement as Hollows.
  return checkedIslandWalk(ctx,{x:96,y:736},{room:27,...options});
}
