// #movement: follow the operator's Hollows route with body-seeded, checked fine rails.
import {cutRail,furthestTraceable,chordWalkable,threatEdgeCost} from './m59-railcut.mjs';
import {protocolToClient,clientToProtocol,finePosition,keeperPortFor} from './m59-finepos.mjs';
import {lookupKeeperBand} from './runtime/keeper-bands.mjs';
import {applyDoorState} from './m59-routes.mjs';
import {roomGeometry,floorAt} from './m59-ground.mjs';
import {safeSpots,hasAnyFooting} from './m59-safespots.mjs';
import {foodValue} from './m59-items.mjs';
import {originLabel,keeperMovementPreemption} from './m59-move-origin.mjs';
import {currentCallOrigin} from './m59-fleetscript.mjs';
import {fallJumpsIn} from './m59-falljump.mjs';
import {planDeclaredTakeoff} from './m59-jump-takeoff.mjs';
import {cutFineRailAsync} from './m59-fine-rail.mjs';
import {checkIslandCancellation,observeIslandTraveller} from './m59-island-observation.mjs';
import {loadMap,roomExitSquares} from './m59-map.mjs';
import {blockingBodySnapshot} from './m59-body-detour.mjs';
import {knownRefugeCell} from './m59-refuge-activation.mjs';
export {checkIslandCancellation} from './m59-island-observation.mjs';

const finePorts=new Map();
export async function readIslandFinePosition(ctx,look){
  return observeIslandTraveller(ctx,()=>readFineOnce(ctx,look),{
    valid:v=>v.position?.ok&&v.position.fresh===true&&v.position.room===v.body.room?.num&&
      Number.isFinite(v.body.hp?.value)&&Number.isFinite(v.body.hp?.max)&&v.body.hp.max>0,
    bodyOf:v=>v.body,statusOf:v=>v.snapshot,error:'island_fine_position_unconfirmed'
  }).then(({body,position,snapshot,observed})=>({...bindIslandFinePosition(body,position),objects:snapshot.objects,sector_heights:observed,movement:snapshot.movement,autopilot_status:snapshot.autopilot_status}));
}
async function readFineOnce(ctx,look){
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
  return {body,position,snapshot,observed};
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

export function activeOwnedFineRecovery(ctx,status){
  const origin=ctx.origin??currentCallOrigin(),a=status?.autopilot_status,lease=a?.faculties?.movement,d=a?.survival_decisions?.current;
  const order=status?.movement?.order;
  if(order&&order.origin?.source!=='keeper'&&order.ordered_by!==originLabel(origin))return false;
  return origin?.source==='fleetscript'&&lease?.owner===origin.source+':'+origin.name&&lease.expires_in_ms>0&&
    d?.source==='keeper'&&d.strategy!=='yield_to_controller'&&d.ended_at==null&&['pending','approaching','arrived','holding','recovering'].includes(d.status);
}
export async function recoverIslandFineWalk(ctx,{deadline,read,since=null,active=false,initial=null,pollMs=1000,onSample=()=>{}}={}){
  const actor=l=>({id:l.you?.id,room:l.room?.num,roomId:l.room?.object_id,x:l.you?.x,y:l.you?.y});
  const covered=l=>knownRefugeCell(roomGeometry(l.room?.num),l.you);
  let refugeFence=initial&&activeOwnedFineRecovery(ctx,initial)&&covered(initial)?actor(initial):null;
  for(;;){
    const s=await ctx.call('status',{agent:ctx.agent,brief:true});
    checkIslandCancellation(ctx,s);
    const owned=keeperMovementPreemption(s,originLabel(ctx.origin??currentCallOrigin()),{since})||(active&&activeOwnedFineRecovery(ctx,s));
    if(!owned&&!refugeFence)return false;
    const {l}=await read(),wall=s.autopilot_status?.safe_spot;
    if(!owned){
      const origin=ctx.origin??currentCallOrigin(),lease=s.autopilot_status?.faculties?.movement,order=s.movement?.order,p=actor(l);
      if(origin?.source!=='fleetscript'||lease?.owner!==origin.source+':'+origin.name||!(lease.expires_in_ms>0)||
        (order&&order.origin?.source!=='keeper'&&order.ordered_by!==originLabel(origin))||
        !Number.isInteger(p.id)||p.id!==refugeFence.id||p.room!==refugeFence.room||p.roomId!==refugeFence.roomId||
        Math.hypot(p.x-refugeFence.x,p.y-refugeFence.y)>1||!covered(l))return false;
    }
    if((wall?.works&&wall.at?.row===l.you.row&&wall.at?.col===l.you.col)||knownRefugeCell(roomGeometry(l.room?.num),l.you)){
      if(covered(l))refugeFence=actor(l);
      const rested=await ctx.call('rest_up',{agent:ctx.agent,to:1,max_seconds:30},45000);
      if(rested?.interrupted)return false;
      await read();await eatIslandAtWall(ctx,onSample);const recovered=await read();
      if(recovered.l.hp.value<recovered.l.hp.max){if(Date.now()>=deadline)return false;continue;}
      await ctx.call('rest',{agent:ctx.agent,stand:true});return true;
    }
    if(Date.now()>=deadline)return false;
    if(s.movement?.order&&s.movement.order.origin?.source!=='keeper'&&s.movement.order.ordered_by!==originLabel(ctx.origin??currentCallOrigin()))return false;
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
export function shelteredIslandAim(waypoints,body,{fromIndex=0,aim,squares,edge,cost=null}={}){
  if(!aim||!squares?.size)return aim;
  const prices=new Map();let accumulated=0,previous=body;
  for(let i=fromIndex+1;i<=aim.i;i++){
    if(cost)accumulated+=cost(previous,waypoints[i]);
    prices.set(i,accumulated);previous=waypoints[i];
  }
  for(let i=aim.i;i>fromIndex;i--){
    const p=waypoints[i];if(!p)continue;
    const row=Math.floor(p.y/1024)+1,col=Math.floor(p.x/1024)+1;
    if(squares.has(row+','+col)&&Math.hypot(p.x-body.x,p.y-body.y)>=128&&chordWalkable(body,p,{edge,lattice:128}).ok
      &&(!cost||cost(body,p)<=prices.get(i)+0.01))
      return {...p,i,sheltered:true};
  }
  return aim;
}
export const islandFineStepBudget=(body,aim)=>Math.ceil(Math.hypot(aim.x-body.x,aim.y-body.y)/(16*48))+2;
export function cutIslandRail(body,goal,options){
  return cutRail(body,goal,options);
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
export async function checkedIslandWalk(ctx,target,{room,budgetMs=180000,onSample=()=>{},allowEdgeTo=null}={}){
  const {agent,call}=ctx,geo=roomGeometry(room),goal=protocolToClient(target),started=Date.now();
  const chordBudget=4096,bodyScopeSquares=2*chordBudget/1024+2;
  const exits=roomExitSquares(loadMap().rooms[room],{rows:geo?.rows,cols:geo?.cols,to:allowEdgeTo,includeInland:true});
  let avoidance=new Set(exits);
  if(!geo?.collisionReady)throw Error('fine_route_geometry_unavailable');
  let liveBodies=[];
  const edge=(a,b)=>{if(avoidance.has(Math.floor(b.y/1024)+1+','+(Math.floor(b.x/1024)+1)))return false;
    const t=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,obstacles:liveBodies});return t?.arrived===true&&t.blocked!==true;};
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
    liveBodies=blockingBodySnapshot(new Map((l.objects??[]).map(o=>[o.id,o])),l.you.id);
    avoidance=new Set(exits);avoidance.delete(l.you.row+','+l.you.col); // permit leaving an arrival cell
    return {l,body};
  };
  const partialRefuges=new Set();
  let {l,body}=await read(),cut=null,index=0,recuts=0,commands=0,trafficWaits=0,cutWaits=0,shelteredStops=0,recoveries=0,recoverySince=started,confirmationRetries=0,stride=128,lastRiskCut=0;
  const expectedFloor=floorAt(geo,goal.x,goal.y);
  while(Date.now()-started<budgetMs){
    if(l.hp.value<l.hp.max&&activeOwnedFineRecovery(ctx,l)){
      if(recoveries>=3||!await recoverIslandFineWalk(ctx,{deadline:started+budgetMs,read,onSample,active:true,initial:l}))throw Error('fine_route_recovery_incomplete');
      recoveries++;recoverySince=Date.now();({l,body}=await read());cut=null;continue;
    }
    const distance=Math.hypot(body.x-goal.x,body.y-goal.y),actualFloor=floorAt(geo,body.x,body.y);
    if(distance<=128&&Number.isFinite(actualFloor)&&Number.isFinite(expectedFloor)&&Math.abs(actualFloor-expectedFloor)<=384)
      return {ok:true,commands,recuts,shelteredStops,end:l.you};
    const threats=(l.objects??[]).filter(o=>(o.flags&8)&&!(o.flags&4)&&Number.isFinite(o.x)&&Number.isFinite(o.y));
    const signature=threats.map(o=>o.id+':'+o.row+','+o.col).sort().join('|');
    const cost=threatEdgeCost(threats.map(protocolToClient),{radius:8*1024,weight:12,spacing:128});
    // Only the next four-square chord executes. Recut before it can leave the
    // occupancy snapshot, with two squares of clearance; distant queued bodies remain risks,
    // without sealing a route we will re-observe on approach.
    if(cut&&Math.hypot(body.x-cut.bodyOrigin.x,body.y-cut.bodyOrigin.y)>chordBudget){cut=null;continue;}
    if(!cut){
      const seed=body;
      cut=await cutFineRailAsync(geo,l.you,target,{threats,threatRadius:8,threatWeight:12,maxMs:4000,
        objects:new Map((l.objects??[]).map(o=>[o.id,o])),selfId:l.you.id,bodyRangeSquares:bodyScopeSquares,
        avoidSquares:avoidance,
        allowBodyPrefix:true,prefixSquares:chordBudget/1024,requirePrefixRefuge:true,excludedPrefixStops:partialRefuges});
      ({l,body}=await read());
      if(l.hp.value<l.hp.max&&activeOwnedFineRecovery(ctx,l)){cut=null;continue;}
      if(Math.hypot(seed.x-body.x,seed.y-body.y)>16){cut=null;continue;}
      if(!cut.ok||!cut.bridgeOk){
        if(cut.traffic_blocked&&cut.waiting_refuge?.row===l.you.row&&cut.waiting_refuge?.col===l.you.col){
          // A temporary live-body cut at cover spends the existing journey
          // budget, not twelve retries. Every loop re-reads position, damage,
          // ownership and bodies; no packet leaves without a new full proof.
          cut=null;await new Promise(r=>setTimeout(r,1000));continue;
        }
        if(cut.body_obstacles>0&&cutWaits++<12){cut=null;await new Promise(r=>setTimeout(r,500));continue;}
        ctx.state.islandFineFailure={room,target,body,cut:{ok:cut.ok,bridgeOk:cut.bridgeOk,why:cut.why,seed:cut.seed,visited:cut.visited,
          body_obstacles:cut.body_obstacles,traffic_blocked:cut.traffic_blocked,waiting_refuge:cut.waiting_refuge},
          objects:(l.objects??[]).map(o=>({id:o.id,x:o.x,y:o.y,row:o.row,col:o.col,flags:o.flags,name:o.name})),
          avoided_squares:[...avoidance],excluded_prefix_refuges:[...partialRefuges],
          floor:floorAt(geo,body.x,body.y),seedFloor:cut.seed?floorAt(geo,cut.seed.x,cut.seed.y):null};
        throw Error('fine_route_cut_failed');
      }index=0;cut.bodyOrigin={...body};cut.threatSignature=signature;lastRiskCut=Date.now();
    }
    const direct=furthestTraceable(cut.waypoints,body,{edge,fromIndex:index,maxAhead:48,budget:chordBudget,lattice:128,cost});
    const aim=shelteredIslandAim(cut.waypoints,body,{fromIndex:index,aim:direct,squares,edge,cost});
    if(!aim||aim.tooClose||!chordWalkable(body,aim,{edge,lattice:128}).ok){
      if((cut.partial||liveBodies.length>0)&&cutWaits++<12){cut=null;await new Promise(r=>setTimeout(r,500));continue;}
      throw Error('fine_route_chord_not_proved');
    }
    if(signature!==cut.threatSignature&&Date.now()-lastRiskCut>=2500&&cost(body,aim)>Math.hypot(aim.x-body.x,aim.y-body.y)*1.25){cut=null;continue;}
    const wire=clientToProtocol(aim),quantized=protocolToClient(wire);
    if(!chordWalkable(body,quantized,{edge,lattice:128}).ok)throw Error('fine_route_wire_chord_not_proved');
    const before=body,commandAt=Date.now(),reply=await call('walk_to',{agent,...wire,fine:true,stride,max_steps:Math.ceil(Math.hypot(body.x-aim.x,body.y-aim.y)/(16*stride))+2,arrive_within:3,exact_arrival:true,hold_shelf:true,
      avoid_squares:[...avoidance].map(k=>{const [row,col]=k.split(',').map(Number);return {row,col};})},30000);
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
      if(recoveries<3&&await recoverIslandFineWalk(ctx,{deadline:started+budgetMs,since:recoverySince,read,onSample,active:true,initial:l})){
        recoveries++;recoverySince=Date.now();({l,body}=await read());cut=null;continue;
      }
      if(islandTrafficRefusal(reply)&&trafficWaits++<120){await new Promise(r=>setTimeout(r,1000));if(Math.hypot(body.x-before.x,body.y-before.y)>=64)cut=null;continue;}
      if(reply.shelf_refusals>0&&stride>8){stride=Math.max(8,Math.floor(stride/2));cut=null;continue;}
      if(Math.hypot(body.x-before.x,body.y-before.y)<64||++recuts>4){
        ctx.state.islandFineFailure={room,target,wire,before,body,reply,commandAt,recoverySince,status:await call('status',{agent,brief:true})};
        throw Error('fine_route_ended_short_'+(reply.reason??'position'));
      }
      cut=null;
    }else {confirmationRetries=0;cutWaits=0;index=aim.i;if(aim.sheltered)shelteredStops++;
      if(cut.partial&&index===cut.waypoints.length-1){if(cut.refuge)partialRefuges.add(cut.refuge.row+','+cut.refuge.col);cut=null;}}
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
  let before=await readIslandFinePosition(ctx);
  if(!Number.isFinite(before.vigor?.value)||before.vigor.value<12)throw Error('hollows_crossing_requires_running_vigor');
  const declaration=fallJumpsIn(2502).find(j=>j.to?.row===44&&j.to?.col===27);
  const refined=planDeclaredTakeoff(roomGeometry(2502),before.you,declaration);
  if(!refined.found)throw Error('hollows_takeoff_'+refined.reason);
  if(before.you.x!==refined.takeoff.x||before.you.y!==refined.takeoff.y){
    const distance=Math.hypot(before.you.x-refined.takeoff.x,before.you.y-refined.takeoff.y);
    const approach=await call('walk_to',{agent,...refined.takeoff,fine:true,stride:16,max_steps:Math.ceil(distance/16)+2,arrive_within:0,exact_arrival:true,hold_shelf:true},30000);
    before=await readIslandFinePosition(ctx);options.onSample?.(before);
    if(!approach.arrived||Math.hypot(before.you.x-refined.takeoff.x,before.you.y-refined.takeoff.y)>0.1)throw Error('hollows_refined_takeoff_not_observed');
  }
  const jump=await call('jump',{agent,to_row:44,to_col:27});
  const observed=await confirmIslandFineArrival(async()=>{
    const l=await readIslandFinePosition(ctx);options.onSample?.(l);checkIslandCancellation(ctx,l);
    return {l,body:protocolToClient(l.you)};
  },protocolToClient({x:1750,y:2824}),{attempts:8,settleMs:100});
  const landed=observed.l;
  if(landed.room?.num!==2502||Math.hypot(landed.you.x-1750,landed.you.y-2824)>10)throw Error('hollows_crossing_not_observed_'+(jump.reason??'landing'));
  await checkedIslandWalk(ctx,HOLLOWS_OUT_POINTS[0],remaining());
  },async()=>{
    const waiting=await readIslandFinePosition(ctx);options.onSample?.(waiting);
    checkIslandCancellation(ctx,waiting);
    if(Date.now()>=deadline)throw Error('hollows_crossing_queue_budget');
    if(waiting.room?.num!==2502||waiting.hp?.value<=0)throw Error('hollows_crossing_queue_body_changed');
  });
  for(const point of HOLLOWS_OUT_POINTS.slice(1)){
    await checkedIslandWalk(ctx,point,{...remaining(),...(point===HOLLOWS_OUT_POINTS.at(-1)?{allowEdgeTo:2503}:{})});
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
  return checkedIslandWalk(ctx,{x:96,y:736},{room:27,allowEdgeTo:2500,...options});
}
