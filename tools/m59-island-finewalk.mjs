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
import {cutFineRailAsync} from './m59-fine-rail.mjs';
import {checkIslandCancellation,observeIslandTraveller,withIslandObservationDeadline} from './m59-island-observation.mjs';
import {loadMap,roomExitSquares} from './m59-map.mjs';
import {blockingBodySnapshot,floorConstraintAllows} from './m59-body-detour.mjs';
import {knownRefugeCell,confirmRefugeCellArrival} from './m59-refuge-activation.mjs';
import {followDeclaredCrossing,followDeclaredApproach} from './m59-declared-crossing.mjs';
import {planDeclaredLanding} from './m59-jump-takeoff.mjs';
import {copyFineGeometry,applyFineSectorObservations} from './m59-observed-geometry.mjs';
import {planRefugeStage,planNearbyFineRefuge} from './m59-fine-refuge-reach.mjs';
import {isActiveRecoveryDecision} from './m59-survival-decision.mjs';
export {checkIslandCancellation} from './m59-island-observation.mjs';

const finePorts=new Map();
// Occupancy is independent of survival. An observer must be able to prove a
// predecessor's actual exit even while that body is dead or recovering in the
// Underworld. This read grants no travel/recovery authority to that character.
export async function readIslandOccupancy(ctx){
  const {position,snapshot}=await readFineOnce(ctx),p=snapshot?.position_read;
  if(!position?.ok||position.fresh!==true||position.room!==snapshot.room?.num||
     snapshot.in_game!==true||snapshot.connected===false||
     !Number.isSafeInteger(snapshot.pid)||snapshot.pid<=0||position.pid!==snapshot.pid||
     typeof snapshot.character!=='string'||!snapshot.character||
     !Number.isSafeInteger(p?.id)||p.id<=0||p.id!==snapshot.you?.id||p.predicted||
     p.room_object_id!==snapshot.room?.object_id||
     ![p.x,p.y,p.row,p.col].every(Number.isFinite)||
     Math.floor(p.x/64)!==p.col||Math.floor(p.y/64)!==p.row)
    throw Error('island_occupancy_unconfirmed');
  const live=await(await fetch('http://127.0.0.1:'+position.port+'/live',
    {signal:AbortSignal.timeout(3000)})).json();
  if(live.agent!==ctx.agent||live.pid!==snapshot.pid||live.character!==snapshot.character)
    throw Error('island_occupancy_keeper_changed');
  return {agent:ctx.agent,room:position.room,confirmed:true,at:p.at,
    body_id:p.id,keeper_pid:snapshot.pid};
}
export async function readIslandFinePosition(ctx,look){
  return observeIslandTraveller(ctx,()=>readFineOnce(ctx,look),{
    valid:v=>v.position?.ok&&v.position.fresh===true&&v.position.room===v.body.room?.num&&
      Number.isFinite(v.body.hp?.value)&&Number.isFinite(v.body.hp?.max)&&v.body.hp.max>0,
    bodyOf:v=>v.body,statusOf:v=>v.snapshot,error:'island_fine_position_unconfirmed'
  }).then(({body,position,snapshot,observed})=>({...bindIslandFinePosition(body,position),objects:snapshot.objects,sector_heights:observed,
    sector_movements:snapshot.doors?.movements,door_settling_until:snapshot.doors?.settling_until,
    movement:snapshot.movement,autopilot_status:snapshot.autopilot_status}));
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
    const l=await observeIslandTraveller(ctx,()=>ctx.call('look',{agent:ctx.agent}));onSample(l);
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
  const owned=origin?.source==='fleetscript'&&lease?.owner===origin.source+':'+origin.name&&lease.expires_in_ms>0&&
    isActiveRecoveryDecision(d);
  if(!owned)return false;
  // A completed rest can precede the keeper's next decision pulse. Its normal
  // fine tool already accepts a healthy body; do not wait for that completed
  // `recovering` label to disappear.
  const health=status?.hp,vigor=status?.vigor?.value;
  if(d.status==='recovering'&&Number.isFinite(health?.max)&&health.max>0&&
      Number.isFinite(health.value)&&health.value>=health.max&&Number.isFinite(vigor)&&vigor>=80)return false;
  return true;
}
export function ownsFineRecovery(ctx,status,{since=null,active=false,established=false}={}){
  return keeperMovementPreemption(status,originLabel(ctx.origin??currentCallOrigin()),{since})||
    ((active||established)&&activeOwnedFineRecovery(ctx,status));
}
export async function recoverIslandFineWalk(ctx,{deadline,read,since=null,active=false,initial=null,pollMs=1000,onSample=()=>{},allowRecoveryRoomChanges=false}={}){
  const fail=(reason,status=null,l=null)=>{
    (ctx.state??={}).islandRecoveryFailure={at:Date.now(),reason,since,deadline,
      actor:l&&{id:l.you?.id,room:l.room?.num,room_object_id:l.room?.object_id,x:l.you?.x,y:l.you?.y},hp:l?.hp,vigor:l?.vigor,
      lease:status?.autopilot_status?.faculties?.movement,decision:status?.autopilot_status?.survival_decisions?.current&&{
        id:status.autopilot_status.survival_decisions.current.id,status:status.autopilot_status.survival_decisions.current.status,strategy:status.autopilot_status.survival_decisions.current.strategy}};
    return false;
  };
  delete (ctx.state??={}).islandRecoveryFailure;
  const actor=l=>({id:l.you?.id,room:l.room?.num,roomId:l.room?.object_id,x:l.you?.x,y:l.you?.y});
  const covered=l=>knownRefugeCell(roomGeometry(l.room?.num),l.you);
  let actorFence=initial&&activeOwnedFineRecovery(ctx,initial)?actor(initial):null;
  let refugeFence=initial&&activeOwnedFineRecovery(ctx,initial)&&covered(initial)?actor(initial):null;
  for(;;){
    if(Date.now()>=deadline)return fail('deadline');
    const broker=await ctx.call('status',{agent:ctx.agent,brief:true});
    checkIslandCancellation(ctx,broker);
    const {l}=await read();checkIslandCancellation(ctx,l);
    const brokerLease=broker.autopilot_status?.faculties?.movement,origin=ctx.origin??currentCallOrigin();
    if(brokerLease?.owner&&brokerLease.expires_in_ms>0&&brokerLease.owner!==origin.source+':'+origin.name)return fail('foreign_broker_lease',broker,l);
    // Use one current native snapshot for body, recovery and lease. Mixing its
    // current body with the broker's older recovery label can falsely end a live wait.
    const s=l.autopilot_status?.faculties?l:broker;
    // Once positively observed, follow this controller's live recovery lease
    // across keeper refuge/logoff replacements. Their own preemptions can
    // replace last_preempted without ending the traveler's recovery.
    const owned=ownsFineRecovery(ctx,s,{since,active,established:Number.isInteger(actorFence?.id)&&actorFence.id>0});
    if(!owned&&!actorFence&&!refugeFence)return fail('recovery_not_owned',s,l);
    const wall=s.autopilot_status?.safe_spot;
    const observedActor=actor(l);
    if(l.room?.num===1||!(l.hp?.value>0))return fail('traveller_died',s,l);
    if(actorFence&&(observedActor.id!==actorFence.id||observedActor.room!==actorFence.room||observedActor.roomId!==actorFence.roomId)){
      // A room-exit objective may follow its own keeper's ordinary refuge trip
      // across a boundary. A fixed-room rail still refuses that change. Never
      // infer ownership from an old cancellation or carry a refuge into a new room.
      if(!allowRecoveryRoomChanges||observedActor.id!==actorFence.id||!activeOwnedFineRecovery(ctx,s))return fail('actor_changed',s,l);
      refugeFence=null;
    }
    if(owned)actorFence=actor(l);
    // last_preempted is historical evidence, not a live recovery lock. A
    // completed full-health detour must not wait forever outside a refuge.
    const currentLease=s.autopilot_status?.faculties?.movement;
    if(actorFence&&origin?.source==='fleetscript'&&currentLease?.owner===origin.source+':'+origin.name&&currentLease.expires_in_ms>0&&
       !activeOwnedFineRecovery(ctx,s)&&!s.autopilot_status?.recovery_travel&&!s.movement?.order&&!s.job?.busy&&
       l.you?.id===actorFence.id&&l.room?.num===actorFence.room&&l.room?.object_id===actorFence.roomId&&
       Number.isFinite(l.hp?.max)&&l.hp.max>0&&l.hp.value>=l.hp.max)return true;
    if(!owned){
      const origin=ctx.origin??currentCallOrigin(),lease=s.autopilot_status?.faculties?.movement,order=s.movement?.order,p=actor(l);
      if(origin?.source!=='fleetscript'||lease?.owner!==origin.source+':'+origin.name||!(lease.expires_in_ms>0)||
        (order&&order.origin?.source!=='keeper'&&order.ordered_by!==originLabel(origin))||
        !Number.isInteger(p.id)||p.id<=0||p.id!==actorFence?.id||p.room!==actorFence.room||p.roomId!==actorFence.roomId)return fail('controller_or_lease_changed',s,l);
      // A completed keeper escape may have arrived at another fine pose. A
      // positively read healthy body can resume its goal without more resting.
      if(Number.isFinite(l.hp?.max)&&l.hp.max>0&&l.hp.value>=l.hp.max)return true;
      if(!refugeFence||Math.hypot(p.x-refugeFence.x,p.y-refugeFence.y)>1||!covered(l))return fail('completed_outside_refuge',s,l);
    }
    const decision=s.autopilot_status?.survival_decisions?.current;
    const chosen=decision?.chosen_refuge,order=s.movement?.order;
    const approaching=owned&&isActiveRecoveryDecision(decision)&&
      ['pending','approaching'].includes(decision.status)&&
      (chosen&&(chosen.row!==l.you.row||chosen.col!==l.you.col||chosen.room!=null&&chosen.room!==l.room.num)||
       order?.origin?.source==='keeper'&&order.kind==='shelter');
    // A covered cell can lie on the way to the keeper's chosen refuge. Let
    // that active approach finish before a rest command can interrupt it.
    if(!approaching&&((wall?.works&&wall.at?.row===l.you.row&&wall.at?.col===l.you.col)||knownRefugeCell(roomGeometry(l.room?.num),l.you))){
      if(covered(l))refugeFence=actor(l);
      const rested=await ctx.call('rest_up',{agent:ctx.agent,to:1,max_seconds:30},45000);
      if(rested?.interrupted){
        const nextBroker=await ctx.call('status',{agent:ctx.agent,brief:true});checkIslandCancellation(ctx,nextBroker);
        const nextBody=(await read()).l;checkIslandCancellation(ctx,nextBody);
        const nextBrokerLease=nextBroker.autopilot_status?.faculties?.movement;
        if(nextBrokerLease?.owner&&nextBrokerLease.expires_in_ms>0&&nextBrokerLease.owner!==origin.source+':'+origin.name)return fail('foreign_broker_lease',nextBroker,nextBody);
        const next=nextBody.autopilot_status?.faculties?nextBody:nextBroker;
        const nextLease=next.autopilot_status?.faculties?.movement,nextActor=actor(nextBody),nextOrder=next.movement?.order;
        const same=nextActor.id===actorFence?.id&&nextActor.room===actorFence.room&&nextActor.roomId===actorFence.roomId;
        const kept=nextLease?.owner===origin.source+':'+origin.name&&nextLease.expires_in_ms>0&&(!nextOrder||nextOrder.origin?.source==='keeper'||nextOrder.ordered_by===originLabel(origin));
        if(Date.now()>=deadline)return fail('interrupted_deadline',next,nextBody);
        if(!activeOwnedFineRecovery(ctx,next)){
          if(same&&kept&&nextBody.hp?.max>0&&nextBody.hp.value>=nextBody.hp.max&&nextBody.vigor?.value>=80)return true;
          return fail('interrupted_without_owned_recovery',next,nextBody);
        }
        await new Promise(r=>setTimeout(r,Math.min(pollMs,Math.max(1,deadline-Date.now()))));continue;
      }
      await read();await eatIslandAtWall(ctx,onSample);const recovered=await read();
      if(recovered.l.hp.value<recovered.l.hp.max){if(Date.now()>=deadline)return fail('deadline');continue;}
      await ctx.call('rest',{agent:ctx.agent,stand:true});return true;
    }
    if(Date.now()>=deadline)return fail('deadline');
    if(s.movement?.order&&s.movement.order.origin?.source!=='keeper'&&s.movement.order.ordered_by!==originLabel(ctx.origin??currentCallOrigin()))return fail('foreign_movement',s,l);
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
export const islandFineStepBudget=(body,aim,{stride=48}={})=>Math.max(8,Math.ceil(Math.hypot(aim.x-body.x,aim.y-body.y)/(16*stride))+2);
export function cutIslandRail(body,goal,options){
  return cutRail(body,goal,options);
}
export const islandTrafficRefusal=reply=>reply?.reason==='object_blocked'||reply?.geometry_rejections?.includes('object_blocked')===true;
export async function confirmIslandFineArrival(read,aim,{attempts=3,settleMs=250,tolerance=128}={}){
  let observation,error;
  for(let i=0;i<attempts;i++){
    await new Promise(r=>setTimeout(r,settleMs));
    observation=await read();error=Math.hypot(observation.body.x-aim.x,observation.body.y-aim.y);
    if(error<=tolerance)break;
  }
  return {...observation,error};
}
export async function checkedIslandWalk(ctx,target,options={}){
  return withIslandObservationDeadline(ctx,Date.now()+(options.budgetMs??180000),()=>checkedIslandWalkWithinBudget(ctx,target,options));
}
async function checkedIslandWalkWithinBudget(ctx,target,{room,budgetMs=180000,onSample=()=>{},allowEdgeTo=null,validatePosition=null,minimumFloor=null,guideNext=null,stopWhen=null}={}){
  const {agent,call}=ctx,geo=copyFineGeometry(roomGeometry(room)),started=Date.now();
  let goal=protocolToClient(target);
  const chordBudget=4096,bodyScopeSquares=2*chordBudget/1024+2;
  const exits=roomExitSquares(loadMap().rooms[room],{rows:geo?.rows,cols:geo?.cols,to:allowEdgeTo,includeInland:true});
  let avoidance=new Set(exits);
  if(!geo?.collisionReady)throw Error('fine_route_geometry_unavailable');
  let liveBodies=[];
  const floorMinimum=()=>typeof minimumFloor==='function'?minimumFloor():minimumFloor;
  const edge=(a,b)=>{if(avoidance.has(Math.floor(b.y/1024)+1+','+(Math.floor(b.x/1024)+1)))return false;
    if(!floorConstraintAllows(geo,clientToProtocol(b),floorMinimum()))return false;
    const t=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,obstacles:liveBodies});return t?.arrived===true&&t.blocked!==true;};
  let squares=new Set(),refugeMask=null,refugeRevision=null;
  const read=async()=>{
    const l=await readIslandFinePosition(ctx);onSample(l);
    checkIslandCancellation(ctx,l);
    if(l.room?.num!==room)throw Error('fine_route_unexpected_room');
    applyFineSectorObservations(loadMap(),room,geo,l.sector_movements);
    if(room===27){
      if(![1,2,3,4,5].every(id=>l.sector_heights?.[id]===24))throw Error('island_cave_requires_observed_dispel');
      const applied=applyDoorState({rooms:{27:{num:27}}},27,l.sector_heights,{geometryOf:()=>geo});
      if(applied.unbaked||applied.state!=='sector1@24+sector2@24+sector3@24+sector4@24+sector5@24')throw Error('island_cave_open_mask_unavailable');
    }
    if(refugeMask!==geo._stepMask||refugeRevision!==geo.revision||!squares.size){
      squares=new Set(safeSpots(geo,{limit:Infinity}).filter(s=>!s.rim&&hasAnyFooting(geo,s.row,s.col)).map(s=>s.row+','+s.col));
      refugeMask=geo._stepMask;refugeRevision=geo.revision;
    }
    if(!Number.isFinite(l.hp?.value)||!Number.isFinite(l.hp?.max)||l.hp.max<=0)throw Error('traveller_health_unreadable');
    if(l.hp.value<=0)throw Error('traveller_died');
    const body=protocolToClient(l.you);if(!Number.isFinite(body.x)||!Number.isFinite(body.y))throw Error('fine_route_position_unreadable');
    validatePosition?.(l);
    liveBodies=blockingBodySnapshot(new Map((l.objects??[]).map(o=>[o.id,o])),l.you.id);
    avoidance=roomExitSquares(loadMap().rooms[room],{rows:geo.rows,cols:geo.cols,to:allowEdgeTo,includeInland:true,
      from:{row:l.you.row,col:l.you.col,confirmed:true}});
    avoidance.delete(l.you.row+','+l.you.col); // permit leaving an actual arrival cell
    return {l,body};
  };
  const partialRefuges=new Set();
  let {l,body}=await read(),cut=null,index=0,recuts=0,commands=0,trafficWaits=0,cutWaits=0,shelteredStops=0,recoveries=0,recoverySince=started,confirmationRetries=0,stride=128,lastRiskCut=0;
  let expectedFloor=floorAt(geo,goal.x,goal.y);
  while(Date.now()-started<budgetMs){
    if(activeOwnedFineRecovery(ctx,l)){
      // Repeated damage may require another legitimate shelter cycle. The
      // original leg deadline bounds this work; every cycle still proves the
      // same live body, recovery owner and cancellation fence before resuming.
      if(!await recoverIslandFineWalk(ctx,{deadline:started+budgetMs,read,onSample,active:true,initial:l})){
        ctx.state.islandRecoveryFailure??={room,reason:'controller_incomplete',position:l.you,hp:l.hp,vigor:l.vigor};
        throw Error('fine_route_recovery_incomplete');
      }
      recoveries++;recoverySince=Date.now();({l,body}=await read());cut=null;continue;
    }
    if(Number.isFinite(l.door_settling_until)&&l.door_settling_until>Date.now()){
      cut=null;await new Promise(r=>setTimeout(r,Math.min(100,l.door_settling_until-Date.now())));
      ({l,body}=await read());continue;
    }
    const connection=stopWhen?.(l);
    if(connection)return {ok:true,targetReached:false,connected:connection,commands,recuts,shelteredStops,end:l.you};
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
        avoidSquares:avoidance,minimumFloor:floorMinimum(),
        allowBodyPrefix:true,prefixSquares:chordBudget/1024,requirePrefixRefuge:true,excludedPrefixStops:partialRefuges,guideNext});
      ({l,body}=await read());
      if(l.hp.value<l.hp.max&&activeOwnedFineRecovery(ctx,l)){cut=null;continue;}
      if(Math.hypot(seed.x-body.x,seed.y-body.y)>16){cut=null;continue;}
      if(cut.guide_advance){
        target=cut.guide_advance.to;goal=protocolToClient(target);expectedFloor=floorAt(geo,goal.x,goal.y);guideNext=null;
        ((ctx.state??={}).islandGuideAdvances??=[]).push({at:Date.now(),room,...cut.guide_advance});
      }
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
      ctx.state.islandFineFailure={room,target,body,reason:'fine_route_chord_not_proved',
        aim,direct,fromIndex:index,cut:{ok:cut.ok,bridgeOk:cut.bridgeOk,partial:cut.partial,
          refuge:cut.refuge,first:cut.waypoints?.[0],last:cut.waypoints?.at(-1),
          next:cut.waypoints?.slice(index,index+4)},
        objects:(l.objects??[]).map(o=>({id:o.id,x:o.x,y:o.y,row:o.row,col:o.col,flags:o.flags})),
        avoided_squares:[...avoidance],excluded_prefix_refuges:[...partialRefuges]};
      throw Error('fine_route_chord_not_proved');
    }
    if(signature!==cut.threatSignature&&Date.now()-lastRiskCut>=2500&&cost(body,aim)>Math.hypot(aim.x-body.x,aim.y-body.y)*1.25){cut=null;continue;}
    const wire=clientToProtocol(aim),quantized=protocolToClient(wire);
    if(!chordWalkable(body,quantized,{edge,lattice:128}).ok)throw Error('fine_route_wire_chord_not_proved');
    const refugeArrival=cut.partial&&cut.refuge&&aim.i===cut.waypoints.length-1;
    const tolerance=refugeArrival?16:128;
    const atRefuge=()=>!refugeArrival||l.you.row===cut.refuge.row&&l.you.col===cut.refuge.col;
    const before=body,commandAt=Date.now(),request={agent,...wire,fine:true,stride,max_steps:islandFineStepBudget(body,aim,{stride}),arrive_within:refugeArrival?0:3,exact_arrival:true,hold_shelf:true,
      avoid_squares:[...avoidance].map(k=>{const [row,col]=k.split(',').map(Number);return {row,col};})};
    const beforeObservation={room:l.room,you:l.you,hp:l.hp,objects:l.objects,sector_movements:l.sector_movements,sector_heights:l.sector_heights,hold:l.hold};
    const reply=await call('walk_to',request,30000);
    commands++;({l,body}=await read());
    let error=Math.hypot(body.x-aim.x,body.y-aim.y);
    if(reply.arrived===true&&(error>tolerance||!atRefuge())){
      // A save or correction can overtake the predicted walk reply. Never accept
      // that prediction as arrival; reread, then retry an unchanged body twice.
      ({l,body,error}=await confirmIslandFineArrival(read,aim,{tolerance}));
      if((error>tolerance||!atRefuge())&&Math.hypot(body.x-before.x,body.y-before.y)<64&&confirmationRetries++<2){
        await new Promise(r=>setTimeout(r,750));continue;
      }
    }
    if(error>tolerance||!atRefuge()||reply.arrived!==true){
      if(await recoverIslandFineWalk(ctx,{deadline:started+budgetMs,since:recoverySince,read,onSample,active:true,initial:l})){
        recoveries++;recoverySince=Date.now();({l,body}=await read());cut=null;continue;
      }
      if(islandTrafficRefusal(reply)&&trafficWaits++<120){await new Promise(r=>setTimeout(r,1000));if(Math.hypot(body.x-before.x,body.y-before.y)>=64)cut=null;continue;}
      if(reply.shelf_refusals>0&&stride>8){stride=Math.max(8,Math.floor(stride/2));cut=null;continue;}
      if(Math.hypot(body.x-before.x,body.y-before.y)<64||++recuts>4){
        ctx.state.islandFineFailure={room,target,wire,before,body,request,before_observation:beforeObservation,reply,commandAt,recoverySince,status:await call('status',{agent,brief:true})};
        throw Error('fine_route_ended_short_'+(reply.reason??'position'));
      }
      cut=null;
    }else {confirmationRetries=0;cutWaits=0;index=aim.i;if(aim.sheltered)shelteredStops++;
      if(cut.partial&&index===cut.waypoints.length-1){if(cut.refuge)partialRefuges.add(cut.refuge.row+','+cut.refuge.col);cut=null;}}
  }
  ctx.state??={};ctx.state.islandFineFailure={room,target,body,reason:'fine_route_budget',
    commands,recuts,trafficWaits,cutWaits,recoveries,index,excluded_prefix_refuges:[...partialRefuges],
    cut:cut&&{ok:cut.ok,bridgeOk:cut.bridgeOk,why:cut.why,partial:cut.partial,refuge:cut.refuge,
      waiting_refuge:cut.waiting_refuge,traffic_blocked:cut.traffic_blocked,
      first:cut.waypoints?.[0],next:cut.waypoints?.slice(index,index+4),last:cut.waypoints?.at(-1)}};
  throw Error('fine_route_budget');
}
export async function walkHollowsOut(ctx,options={}){
  const {agent,call}=ctx;
  const deadline=Date.now()+(options.budgetMs??180000);
  const remaining=()=>({...options,room:2502,budgetMs:Math.max(1,deadline-Date.now())});
  // Wait at a real wall behind the approach. Followers must not occupy the
  // takeoff corridor while the admitted traveler refines and clears its jump.
  const staging=planRefugeStage(roomGeometry(2502),{x:2201,y:2650},{row:42,col:36});
  if(!staging.found)throw Error('hollows_staging_'+staging.reason);
  const read=async()=>{const l=await readIslandFinePosition(ctx);options.onSample?.(l);checkIslandCancellation(ctx,l);return l;};
  const walk=(point,guard={})=>checkedIslandWalk(ctx,point,{...remaining(),...guard});
  const declaration=fallJumpsIn(2502).find(j=>j.to?.row===40&&j.to?.col===29);
  // This lower pocket has no proved ordinary path to any room exit or the
  // western climb. Unlike Konima it has no established walking gutter. Never
  // aim uphill or invent a teleport; the route must prevent that descent.
  const gutter=async observed=>{
   ctx.state??={};ctx.state.islandTakeoffFailure={room:2502,reason:'lower_escape_unproved',observed:observed.you};
   throw Error('hollows_lower_escape_unproved');
  };
  const initial=await read(),landed=planDeclaredLanding(roomGeometry(2502),initial.you,declaration,
   {objects:new Map((initial.objects??[]).map(o=>[o.id,o])),selfId:initial.you.id});
  const staged=landed.found?{gutter:false}:await followDeclaredApproach(declaration,{geo:roomGeometry(2502),read,walk,
   target:staging.point,gutter,requireShelf:true});
  // The shared controller owns refinement through landing clearance, including
  // body waits and a verified keeper recovery during a takeoff or jump call.
  if(!staged.gutter)await followDeclaredCrossing(ctx,declaration,{geo:roomGeometry(2502),read,walk,
   stage:staging.point,gutter,clear:HOLLOWS_OUT_POINTS[0],
   refineTakeoff:true,approachPoint:{x:2201,y:2650},budgetMs:Math.max(1,deadline-Date.now()),
   walkTakeoff:async(target,{validatePosition}={})=>{
    let before=await read();validatePosition?.(before);
    if(!Number.isFinite(before.vigor?.value)||before.vigor.value<12)throw Error('hollows_crossing_requires_running_vigor');
    const distance=Math.hypot(before.you.x-target.x,before.you.y-target.y);
    const approach=await call('walk_to',{agent,...target,fine:true,stride:16,max_steps:Math.ceil(distance/16)+2,arrive_within:0,exact_arrival:true,hold_shelf:true},30000);
    before=await read();validatePosition?.(before);
    if(approach.arrived&&Math.hypot(before.you.x-target.x,before.you.y-target.y)>0.1){
     const confirmed=await confirmIslandFineArrival(async()=>{
      const l=await read();validatePosition?.(l);return {l,body:protocolToClient(l.you)};
     },protocolToClient(target),{attempts:4,settleMs:150,tolerance:1.6});
     before=confirmed.l;
    }
    if(!approach.arrived||Math.hypot(before.you.x-target.x,before.you.y-target.y)>0.1){
      ctx.state.islandTakeoffFailure={room:2502,takeoff:target,observed:before.you,
        approach:{arrived:approach.arrived,reason:approach.reason,steps:approach.steps,
          last_step:approach.last_step,geometry_rejections:approach.geometry_rejections}};
      console.log('ISLAND TAKEOFF REFUSED '+JSON.stringify({agent,...ctx.state.islandTakeoffFailure}));
      throw Object.assign(Error('hollows_refined_takeoff_not_observed_'+(approach.reason??'position')),
       islandTrafficRefusal(approach)?{code:'declared_crossing_traffic_blocked'}:{});
    }
   },
   recover:({since,initial})=>recoverIslandFineWalk(ctx,{deadline,since,initial,active:true,onSample:options.onSample,
    read:async()=>({l:await read()})}),
   waitAtCover:async()=>{
    const l=await read(),refuge=planNearbyFineRefuge(roomGeometry(2502),l.you,
     new Map((l.objects??[]).map(o=>[o.id,o])),l.you.id);
    if(!refuge.found)throw Error('declared_crossing_refuge_unavailable');
    const held=await followDeclaredApproach(declaration,{geo:roomGeometry(2502),read,walk,
     target:refuge.point,gutter,requireShelf:true});
    if(!held.gutter)await confirmIslandQueueRefuge(ctx,roomGeometry(2502),refuge,read,'declared_crossing_refuge_not_observed');
   },
   observeLanding:async landing=>(await confirmIslandFineArrival(async()=>{
    const l=await read();return {l,body:protocolToClient(l.you)};
   },protocolToClient(landing),{attempts:8,settleMs:100})).l,
  });
  const points=HOLLOWS_OUT_POINTS.slice(1);
  for(const [i,point] of points.entries()){
    await checkedIslandWalk(ctx,point,{...remaining(),guideNext:points[i+1]??null,...(point===HOLLOWS_OUT_POINTS.at(-1)?{allowEdgeTo:2503}:{})});
    console.log('HOLLOWS POINT '+JSON.stringify({agent,target:point}));
  }
}
async function waitForDeclaredTurn(ctx,geo,read,walk,{allowUnparked=false}={}){
  const l=await read();
  // Queue parking has the same exit exclusions as its executing walker. A
  // neighbouring arrival cell is not cover if reaching it would leave the map.
  const excludedRefuges=roomExitSquares(loadMap().rooms[l.room.num],{rows:geo.rows,cols:geo.cols,includeInland:true});
  if(knownRefugeCell(geo,l.you)&&!excludedRefuges.has(l.you.row+','+l.you.col))return true;
  const avoidSquares=new Set(excludedRefuges);
  avoidSquares.delete(l.you.row+','+l.you.col);
  const refuge=planNearbyFineRefuge(geo,l.you,new Map(l.objects.map(o=>[o.id,o])),l.you.id,{avoidSquares,excludedRefuges});
  if(!refuge.found){if(allowUnparked)return false;throw Error('declared_crossing_queue_refuge_unavailable');}
  await walk(refuge.point);
  await confirmIslandQueueRefuge(ctx,geo,refuge,read,'declared_crossing_queue_refuge_unconfirmed');
  return true;
}
async function confirmIslandQueueRefuge(ctx,geo,refuge,read,error){
 const result=await confirmRefugeCellArrival(geo,refuge,{read:async()=>(await read()).you,
  finish:point=>ctx.call('walk_to',{agent:ctx.agent,...point,fine:true,stride:8,max_steps:10,
   arrive_within:0,exact_arrival:true,hold_shelf:true})});
 if(result.cancelled)throw Error('declared_crossing_queue_cancelled');
 if(!result.arrived)throw Error(error);
}
export async function waitAtIslandTrafficRefuge(ctx,options={}){
 const initial=await readIslandFinePosition(ctx),room=initial.room.num,geo=roomGeometry(room);
 const read=async()=>{const l=await readIslandFinePosition(ctx);checkIslandCancellation(ctx,l);return l;};
 return waitForDeclaredTurn(ctx,geo,read,(point,guard={})=>checkedIslandWalk(ctx,point,{...options,...guard,room}),{allowUnparked:true});
}
export async function approachIslandDoor(ctx,options={}){
  const initial=await readIslandFinePosition(ctx);
  if(initial.you.row>10){
    const geo=roomGeometry(2505),walk=(target,guard={})=>checkedIslandWalk(ctx,target,{room:2505,...options,...guard});
    const read=async()=>{const l=await readIslandFinePosition(ctx);checkIslandCancellation(ctx,l);options.onSample?.(l);return l;};
    const jumps=fallJumpsIn(2505),first=jumps.find(j=>j.from.row===27&&j.from.col===60),second=jumps.find(j=>j.from.row===46&&j.from.col===80);
    // Staging is part of admission: a waiting follower must not occupy the
    // refuge the active traveler may need after damage or a refused jump.
    const waitQueued=()=>waitForDeclaredTurn(ctx,geo,read,walk);
    const queueBudgetMs=options.queueBudgetMs??7200000;
    const initialPoint=protocolToClient(initial.you),height=geo.floorBaseAtClient(initialPoint.x,initialPoint.y);
    let crossed={crossed:initial.you.col>=65&&initial.you.col<84&&initial.you.row<47};
    if(initial.you.col<48||initial.you.col<=60&&height>=14800){
      crossed=await followDeclaredCrossing(ctx,first,{geo,read,walk,gutter:{x:3808,y:2144},stage:{x:3072,y:1768},clear:{x:4800,y:1512},budgetMs:options.budgetMs,queueBudgetMs,waitQueued, gutterOnRefusal:true,
        prepare:()=>followDeclaredApproach(first,{geo,read,walk,target:{x:3072,y:1768},gutter:{x:3808,y:2144}})});
    }else if(initial.you.col<65&&height<14500&&initial.you.row<35)await walk({x:3808,y:2144});
    if(crossed.crossed){
      await followDeclaredCrossing(ctx,second,{geo,read,walk,gutter:{x:5440,y:3096},stage:{x:5144,y:2688},clear:{x:5440,y:3096},budgetMs:options.budgetMs,queueBudgetMs,waitQueued, gutterOnRefusal:true,
        prepare:()=>followDeclaredApproach(second,{geo,read,walk,target:{x:5144,y:2688},gutter:{x:5440,y:3096}})});
    }
  }
  // Fine point inside the real go-trigger, in KOD/protocol units.
  await checkedIslandWalk(ctx,{x:4029,y:385},{room:2505,...options});
  await ctx.call('rest',{agent:ctx.agent,stand:true});
  await ctx.call('act',{agent:ctx.agent,verb:'go'});
}
export async function approachKonimaMainland(ctx,options={}){
  const geo=roomGeometry(2505),walk=(target,guard={})=>checkedIslandWalk(ctx,target,{room:2505,...options,...guard});
  const read=async()=>{const l=await readIslandFinePosition(ctx);checkIslandCancellation(ctx,l);options.onSample?.(l);return l;};
  let before=await read();
  if(before.you.row<10){
    await walk({x:3936,y:416});
    const opened=await ctx.call('operate_door',{agent:ctx.agent,targets:[{row:27,col:65}]},30000);
    if(!opened.opened)throw Error('konima_return_door_'+opened.reason);
    // Clear the animated sector inside its opening window before the long walk.
    await walk({x:4456,y:416});
  }
  before=await read();const point=protocolToClient(before.you),height=geo.floorBaseAtClient(point.x,point.y);
  if(before.you.col<48||before.you.col<=61&&before.you.row<25){
    // Already on the mainland side of the return drop: retain its westbound goal.
  }else if(before.you.col<65&&before.you.row>=25&&before.you.row<=35&&height<14500)await walk({x:3808,y:2144});
  else{
    const declaration=fallJumpsIn(2505).find(j=>j.from.row===27&&j.from.col===64&&j.to.row===23);
    await followDeclaredCrossing(ctx,declaration,{geo,read,walk,gutter:{x:3808,y:2144},stage:{x:4840,y:1472},clear:{x:3312,y:1272},budgetMs:options.budgetMs,
      queueBudgetMs:options.queueBudgetMs??7200000,waitQueued:()=>waitForDeclaredTurn(ctx,geo,read,walk),gutterOnRefusal:true,
      prepare:()=>followDeclaredApproach(declaration,{geo,read,walk,target:{x:4840,y:1472},gutter:{x:3808,y:2144}})});
  }
  await checkedIslandWalk(ctx,{x:160,y:4640},{room:2505,allowEdgeTo:2504,...options});
}
export async function approachMainlandCaveExit(ctx,options={}){
  // Its west boundary is r11c1. Observe the complete Dispel state before using
  // its baked mask, then approach with the same checked fine movement as Hollows.
  return checkedIslandWalk(ctx,{x:96,y:736},{room:27,allowEdgeTo:2500,...options});
}
