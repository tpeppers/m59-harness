import{errorEvidence}from'./m59-error-evidence.mjs';
import{queuedRoomExit}from'./m59-queued-room-exit.mjs';
import {rollingGatherCutoff} from './m59-crossing-queue.mjs';
// Ordinary player movement to Brax. Administrative setup belongs in the lab driver.
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,appendFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {followRoadJourney as travelBraxRoad,roadTrafficGap} from './m59-road-journey.mjs';
import {planDeclaredTakeoff,planDeclaredLanding} from './m59-jump-takeoff.mjs';
import {nearestClearStation,planQueuedEgress} from './m59-rail-traffic.mjs';
import {sharedJournal} from './m59-shared-journal.mjs';
import {crossingGate,waitForCrossing,releaseAfterClearance} from './m59-crossing-queue.mjs';
import {roomExitSquares,loadMap} from './m59-map.mjs';
import {roomGeometry,floorAt,edgeOf} from './m59-ground.mjs';
import {railLeg,fineEdge,checkRoute,bakeOne,aimsAlong} from './m59-noderails.mjs';
import {fineRouter} from './m59-fineroute.mjs';
import {cutRail} from './m59-railcut.mjs';
import {scanKeepers,identityOf,identityMismatch} from './m59-keeper.mjs';
import {protocolToClient,clientToProtocol,squareCentreClient} from './m59-finepos.mjs';
import {braxPuzzleReadiness,braxLeverUsable,braxFailedReadyAfter,BRAX_SOLVED_RESET_MS} from './m59-brax-puzzle.mjs';
import {applyAncientFloors,liftWaitMs} from './m59-moving-platform.mjs';
import {evidenceDirFor,resolveControlUrl} from './m59-fleetpath.mjs';
import {planBodyDetour} from './m59-body-detour.mjs';
import {railBoarding,railEndReached} from './m59-railfollow.mjs';
import {createRailObserver,confirmedRailBody,refusedRailWrite,waitForRailState,waitForRailGeometry,unsentRailAnimationRefusal,resumeObservedRailWalk,readRailMoveCheck,provedRailMove,unsentRailGeometryRefusal} from './m59-rail-observer.mjs';
import {originLabel} from './m59-move-origin.mjs';
import {currentCallOrigin} from './m59-fleetscript.mjs';
import {checkedIslandWalk,recoverIslandFineWalk,activeOwnedFineRecovery,checkIslandCancellation} from './m59-island-finewalk.mjs';

import {isActiveRecoveryDecision} from './m59-survival-decision.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const BRAX_DESTINATION=827;
export const unsentBraxBodyRefusal=r=>r?.jumped===false&&r.cancelled!==true&&r.mover?.moved===false&&r.mover.left_room!==true&&r.mover.reason==='object_blocked';
export const unsentBraxJumpRefusal=r=>unsentBraxBodyRefusal(r)||(r?.jumped===false&&r.cancelled!==true&&r.mover?.moved===false&&r.mover.left_room!==true&&['fall_changed_before_send','fall_blocked_by_body','casting_hold'].includes(r.mover.reason));
// A completed native walk may have made partial progress before its final
// locally refused packet. Fresh body/geometry proof owns any subsequent route.
export const braxStoppedPlatformWalk=r=>r?.arrived===false&&r?.cancelled!==true&&(
 r.reason==='object_blocked'||r.geometry_rejections?.includes('object_blocked')||
 r.last_step?.moved===false&&r.last_step.geometry_blocked===true);
export const MAX_BRAX_GROUP=25;
export const departureSlot=index=>({x:55808+(index%2)*1024,y:14848+Math.floor(index/2)*512});
export const platformSlot=index=>{
  if(!Number.isInteger(index)||index<0||index>=25)throw Error('platform slot must be 0..24');
  return {row:[18,19,21,22,23][Math.floor(index/5)],col:[52,53,57,58,59][index%5]};
};
export function freePlatformStation(members,objects,selfId,near=null){
 const reserved=new Set(members.map(m=>m.station??m.slot));
 const bodies=objects.filter(o=>o.id!==selfId&&((o.flags&5)||o.is_player)).map(o=>
  Number.isFinite(o.x)&&Number.isFinite(o.y)?{x:o.x,y:o.y}:Number.isFinite(o.row)&&Number.isFinite(o.col)?{x:o.col*64+32,y:o.row*64+32}:null).filter(Boolean);
 const stations=Array.from({length:25},(_,id)=>{const p=platformSlot(id);return{id,x:p.col*64+32,y:p.row*64+32};});
 return nearestClearStation(stations,bodies,{reserved,near,clearance:32})?.id??null;
}
export const CORNERS=[{row:16,col:51,stand:{row:17,col:51}},{row:16,col:60,stand:{row:17,col:60}},
  {row:25,col:51,stand:{row:24,col:51}},{row:25,col:60,stand:{row:24,col:60}}];
export const cornerWork=(index,count)=>{
  const assignments=count===1?[[0,1,2,3]]:count===2?[[0,2],[1,3]]:count===3?[[0,1],[2],[3]]:count===4?[[0],[1],[2],[3]]:[[],[0],[1],[2],[3]];
  return (assignments[index]??[]).map(i=>CORNERS[i]);
};
// Operators may walk to unchanged platform stand cells while boarding. Activation
// still waits for the center/corner state proof in pull().
export function braxWorkStand(index,expectedCount,station=index){
 if(index===0)return{row:22,col:55};
 return cornerWork(index,expectedCount)[0]?.stand??platformSlot(station);
}
export function platformAims(from,to){
  const inside=p=>p.x>=50*1024&&p.x<=61*1024&&p.y>=14*1024&&p.y<=26*1024;
  if(!inside(from)||!inside(to))return [to];
  const box={x:{min:54784,max:57344},y:{min:18432,max:21504}};
  let lo=0,hi=1;
  for(const axis of ['x','y']){
    const d=to[axis]-from[axis],range=box[axis];
    if(!d){if(from[axis]<range.min||from[axis]>range.max)return [to];continue;}
    const a=(range.min-from[axis])/d,b=(range.max-from[axis])/d;
    lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));
    if(lo>hi)return [to];
  }
  const inColumn=from.x>=box.x.min&&from.x<=box.x.max;
  const aisle=to.y<box.y.min?16896:24064;
  const aims=[];
  if(inColumn&&((from.y<box.y.min&&aisle===24064)||(from.y>box.y.max&&aisle===16896))){
    const side=to.x<(box.x.min+box.x.max)/2?52736:58880;aims.push({x:side,y:from.y},{x:side,y:aisle});
  }
  else aims.push({x:from.x,y:aisle});
  aims.push({x:to.x,y:aisle},to);return aims;
}
// An unrelated message (including a periodic server save) is not a lever verdict.
export async function awaitLeverConfirmation(reply,{since,waitEvent,observedRaised,now=Date.now,timeoutMs=10000}){
  const switched=value=>/You switch the lever\./.test(JSON.stringify(value));
  if(switched(reply))return true;
  const deadline=now()+timeoutMs;let cursor=since;
  while(now()<deadline){
    if(await observedRaised())return true;
    const event=await waitEvent({since:cursor,kinds:['message'],timeout_ms:Math.min(1000,deadline-now())});
    if(switched(event))return true;
    if(event.no_event_stream)return false;
    cursor=Math.max(cursor,event.cursor??cursor);
  }
  return await observedRaised();
}
export const keeperSurvivalInterruption=reply=>reply?.cancelled===true&&reply.cancelled_by_origin?.source==='keeper'||reply?.cancelled!==true&&reply?.reason==='keeper_recovery_active'&&typeof reply.decision_id==='string'||reply?.cancelled!==true&&reply?.reason==='keeper_recovery_trip_active'&&typeof reply.trip_id==='string';
export function keeperRecoveryTripSince(s,since){
 const cancel=s.movement?.last_cancel;
 return !!s.autopilot_status?.recovery_travel||cancel?.at>=since&&cancel.by?.source==='keeper'&&cancel.by?.name==='recovery_detour';
}
export function ownedBraxRoadRecovery(s,origin,since){
 const lease=s.autopilot_status?.faculties?.movement;
 if(origin?.source!=='fleetscript'||lease?.owner!==origin.source+':'+origin.name||!(lease.expires_in_ms>0)||!(s.hp?.value>0))return false;
 return [s.movement?.last_preempted,...(s.movement?.preemptions??[])].some(p=>p?.at>=since&&p.by?.source==='keeper'&&p.preempted?.ordered_by===originLabel(origin));
}
// Only a returned, stopped walking operation can resume from a newly read body.
// An unknown child/HTTP outcome never enters this path.
export function braxEndedCliffContinuation(ctx,reply,current,{since=0}={}){
 const s=confirmedRailBody(current),rail=s?.movement?.rail,origin=ctx.origin??currentCallOrigin(),owner=originLabel(origin),lease=s?.autopilot_status?.faculties?.movement;
 if(reply?.reason!=='position_confirmation_timeout'||!s||s.room.num!==579||!(s.hp?.value>0)||reply.position?.id!==s.you.id||rail?.room!==579||rail.phase!=='stopped'||!(rail.startedAt>=since&&rail.endedAt>=rail.startedAt)||origin?.source!=='fleetscript'||lease?.owner!==origin.source+':'+origin.name||!(lease.expires_in_ms>0))return null;
 const cancelled=reply.cancelled_by_origin,cancel=s.movement.last_cancel;
 if(cancelled&&originLabel(cancelled)!==owner&&cancelled.source!=='keeper'||cancel?.at>=since&&cancel.by?.source!=='keeper'&&cancel.by_label!==owner)return null;
 if(activeOwnedFineRecovery(ctx,s))return 'owned-recovery';
 if(!braxActiveRecovery(s)&&!s.autopilot_status?.recovery_travel&&!s.autopilot_status?.recovering_from_death&&!s.job?.busy&&!s.movement?.order&&s.hp.max>0&&s.hp.value/s.hp.max>=Math.max(.9,ctx.minHealth??.9)&&s.vigor?.value>=40)return 'observed-ready';
 return null;
}

export const braxActiveRecovery=s=>{const d=s.autopilot_status?.survival_decisions?.current;return !!d&&(typeof d!=='object'||isActiveRecoveryDecision(d));};
export const readyAfterSurvival=(s,minHealth=0.9)=>Number(s.hp?.value)>0&&Number(s.hp?.max)>0&&s.hp.value/s.hp.max>=minHealth&&!braxActiveRecovery(s);
export const braxArrival=s=>Number(s.room?.num)===827&&Number(s.hp?.value)>0;
// A confirmed body on the connected lift is a completed first fall even if
// ordinary landing clearance has moved it off the single serialized aim.
export function braxLandingProof(geo,s,to,expectedFloor){
 if(s?.room?.num!==579||s.you?.predicted||![s.you?.x,s.you?.y].every(Number.isFinite))return null;
 const p=protocolToClient(s.you),floor=floorAt(geo,p.x,p.y);
 if(!Number.isFinite(floor)||Math.abs(floor-expectedFloor)>1)return null;
 if(to.row===25&&(p.x<51200||p.x>62464||p.y<14336||p.y>26624))return null;
 const proof=planDeclaredLanding(geo,s.you,{to_fine:{x:to.x,y:to.y}},to.row===25?{within:512,maxWalk:1024,maxMs:150}:{within:32,maxWalk:64,maxMs:100});
 return proof.found?{position:{...p,row:s.you.row,col:s.you.col},floor_client:floor,connected:true}:null;
}


export {replaceSharedJournal as replaceBraxJournal} from './m59-shared-journal.mjs';
export const groupJournal=(server,options={})=>sharedJournal(server,{directory:join(evidenceDirFor(),'brax-groups'),...options});

export function makeBraxApproach(source){
  if(!source?.ok||!source?.rail_complete)throw Error('missing checked Ancient approach');
  const geo=roomGeometry(579),edge=fineEdge(geo),opts={edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)};
  const r=structuredClone(source);r.legs=r.legs.slice(0,3);
  const points=r.legs[2].waypoints,target={x:37632,y:38272};
  const index=points.reduce((best,p,i)=>Math.hypot(p.x-target.x,p.y-target.y)<Math.hypot(points[best].x-target.x,points[best].y-target.y)?i:best,0);
  r.legs[2].waypoints=points.slice(0,index+1);
  r.legs[2].aims=aimsAlong(r.legs[2].waypoints,{edge});
  for(const goal of [{x:37376,y:39424},{x:55808,y:32000}]){
    const from=r.legs.at(-1).waypoints.at(-1),cut=cutRail(from,goal,{...opts,edge:edgeOf(geo)});
    if(!cut.ok||!cut.bridgeOk)throw Error('Brax shelf cut refused');
    r.legs.push(railLeg({waypoints:cut.waypoints},{...opts,edge:edgeOf(geo)}));
  }
  r.exit='brax-south';r.exit_label='brax-south';r.to='r32c55';r.jumps=1;
  r.waypoints=r.legs.reduce((n,l)=>n+(l.waypoints?.length??0),0);
  r.rail_complete=r.legs.filter(l=>l.kind==='walk').every(l=>!l.unvalidated);
  if(!r.rail_complete||!checkRoute(r,{edge}).ok)throw Error('Brax approach rail check refused: '+JSON.stringify({legs:r.legs.map(l=>l.unvalidated),check:checkRoute(r,{edge})}));
  return r;
}
export function ensureBraxApproach({sourceFile=join(root,'substrate/node-tour-rails.json'),out=join(root,'substrate/brax-rails.json')}={}){
  let source;
  if(existsSync(sourceFile))source=JSON.parse(readFileSync(sourceFile)).stones?.find(s=>s.node==='ancient')?.routes?.find(r=>r.direction==='to_node'&&r.exit==='edge:589:r38c74');
  if(!source){
    const router=fineRouter(579),geo=router.geo;
    source=bakeOne(router,{row:38,col:74},{row:52,col:30},{maxJumps:3,edge:fineEdge(geo),bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
  }
  const route=makeBraxApproach(source);
  mkdirSync(dirname(out),{recursive:true});
  const temporary=out+'.'+randomUUID();writeFileSync(temporary,JSON.stringify({stones:[{node:'brax',room:579,routes:[route]}]}));renameSync(temporary,out);return out;
}

export function braxSouthQueueReached(geo,s){
 return s.room?.num===579&&s.hp?.value>0&&s.you&&!s.you.predicted&&railEndReached(geo,{...protocolToClient(s.you),predicted:s.you.predicted},{x:55808,y:32000},{within:1536});
}

export function braxBoardingLaneKey(server,col){
 if(typeof server?.host!=='string'||!server.host||!Number.isInteger(server.port)||server.port<=0||![55,56].includes(col))throw Error('invalid Brax boarding lane');
 return [server.host,server.port,579,'platform-landing',col].join(':');
}
export function chooseBraxBoarding(geo,body,objects,{columns=[55,56]}={}){
 if(!Array.isArray(columns)||!columns.length||columns.some(c=>![55,56].includes(c)))throw Error('invalid Brax boarding columns');
 const lanes=[...new Set(columns)].sort((a,b)=>Math.abs(body.x-(a*64+32))-Math.abs(body.x-(b*64+32)));
 for(const col of lanes){const x=(col-1)*1024+512,declaration={room:579,from:{row:32,col},to:{row:25,col},from_fine:{x,y:32000},to_fine:{x,y:25088}};
  const plan=planDeclaredTakeoff(geo,body,declaration,{objects,selfId:body.id});if(plan.found)return {col,x,plan};}
 return null;
}

// A complete requested cohort need not sit out the remaining assembly window.
// Independent callers without a known cohort retain the bounded gathering window.
export function braxBoardingComplete(group,now){
 return group.members.length>0&&group.members.every(m=>m.aboard)&&
  (now>=group.cutoff||group.members.length===25||Array.isArray(group.expectedAgents)&&group.expectedAgents.length>0&&
   group.expectedAgents.every(agent=>group.members.some(m=>m.agent===agent)));
}

// Late travelers in a failed request must not silently start another puzzle
// while the rest of that same request has already stopped. A new request still
// goes through the complete observed reset/readiness proof.
export function braxAdmissionGroup(g,observed,{now,requestKey,expectedAgents=null,gatherMs=60000,id=randomUUID}={}){
 if(g?.raisedAt!=null&&g.phase==='leaving'&&g.members?.length&&g.members.every(m=>m.gone||m.failure))g.phase='departed';
 if(g?.failure&&g.requestKey===requestKey)throw Error(g.failure);
 if(!g||g.phase==='waiting-reset'||g.phase==='departed'||g.failure){
  const ready=braxPuzzleReadiness(g,observed,now);
  if(!g)g={id:id(),phase:'waiting-reset',requestKey,members:[]};
  g.baselineSince=ready.baselineSince;g.readyAfter=ready.readyAfter;
  if(!ready.ready){g.phase='waiting-reset';return g;}
  return {id:id(),phase:'boarding',requestKey,cutoff:now+gatherMs,gatherMs,hardGatherAt:now+Math.max(gatherMs,Math.min(180000,3*gatherMs)),readyAfter:ready.readyAfter,expectedAgents,members:[],
    readiness:{verifiedAt:now,readyAfter:ready.readyAfter,source:ready.source}};
 }
 return g;
}

// Once the lift is positively raised, an individual unloading/onward failure
// cannot invalidate the solved puzzle for healthy riders or later arrivals.
export function braxRecordMemberExit(group,ticket){
 const member=group.members?.find(m=>m.ticket===ticket);if(!member)throw Error('unknown Brax rider exit');
 member.gone=true;if(group.members.every(m=>m.gone||m.failure))group.phase='departed';return group;
}

export function braxRecordMemberFailure(group,ticket,reason,now){
 const member=group.members?.find(m=>m.ticket===ticket);
 if(member)member.failure={at:now,reason};
 group.readyAfter=braxFailedReadyAfter(group,now);
 if(member?.gone||Number.isFinite(group.raisedAt)){
  if(group.members?.length&&group.members.every(m=>m.gone||m.failure))group.phase='departed';
  return group;
 }
 group.failure=reason;return group;
}

export async function runBrax(ctx,{expectedAgents=null,gatherMs=60000,timeoutMs=1800000,approachFile=join(root,'substrate/brax-rails.json'),resumeRaisedAt=null,resumeNorthLedge=false}={}){
  const {agent,fleet,call,state}=ctx,start=Date.now(),end=start+timeoutMs;
  state.islandCancelFence??=start;
  const control=resolveControlUrl();if(!control.url)throw Error(control.why);
  const controlURL=new URL(control.url),native=createRailObserver({fleet,agent});
  const out=join(root,'substrate/brax-attempts');mkdirSync(out,{recursive:true});
  const id=agent+'-'+Date.now(),receipt=join(out,id+'.jsonl');state.brax={id,receipt,success:false};
  const log=(event,data={})=>{appendFileSync(receipt,JSON.stringify({at:new Date().toISOString(),agent,event,...data})+'\n');console.log('BRAX '+agent+' '+event);};
  let keeper,ticket,journal,batchId;
  const read=async({fine=true}={})=>{
    if(Date.now()>end)throw Error('Brax route time budget exhausted');
    for(let attempt=0;!keeper&&attempt<3;attempt++){
      keeper=(await scanKeepers({fleet,timeoutMs:5000})).get(agent);
      if(!keeper)await sleep(500);
    }
    if(!keeper)throw Error('Brax requires a verified keeper');
    const readOnce=async()=>{for(let attempt=0;attempt<3;attempt++){
      const url=new URL(`http://127.0.0.1:${keeper.port}/state`);
      for(const [key,value]of Object.entries({...(fine?{position:1}:{}),agent,character:keeper.character,keeper_pid:keeper.pid}))url.searchParams.set(key,String(value));
      let response,s;
      try{response=await fetch(url,{signal:AbortSignal.timeout(Math.max(1,Math.min(30000,end-Date.now())))});s=await response.json();}
      catch(error){
        log('keeper-read-failure',{attempt,error:errorEvidence(error)});
        if(attempt===2||Date.now()>end)throw error;
        log('keeper-read-retry',{attempt,reason:error.message});
        const next=(await scanKeepers({fleet,timeoutMs:5000})).get(agent);
        if(next&&next.character!==keeper.character)throw Error('Brax keeper character changed');
        if(next)keeper=next;
        await sleep(500);continue;
      }
      if(!response.ok||identityMismatch(keeper,identityOf(response.headers,s)))throw Error('Brax keeper identity changed');
      return s;
    }};
    return waitForRailState(readOnce,{fine,deadline:end,check:s=>{
      if(s.hp?.value<=0||s.room?.num===1)throw Error('Brax character died');
      checkIslandCancellation(ctx,s);
    },onWait:detail=>log('position-read-unconfirmed',detail)});
  };
  const command=async(name,args={})=>{
    for(let attempt=0;attempt<3;attempt++){
      const reply=await call(name,{agent,...args});log('command',{name,args,reply});
      if(!refusedRailWrite(reply,agent)||attempt===2)return reply;
      await read();await sleep(1000);
    }
  };
  const until=async(test,why,budget=180000)=>{const deadline=Math.min(end,Date.now()+budget);for(;;){const result=await test();if(result)return result;if(Date.now()>deadline)throw Error(why);await sleep(500);}};
  const position=s=>({...protocolToClient(s.you),row:s.you.row,col:s.you.col});
  const rawWalkPoint=async(point,room=579)=>{
    const aim=point.x==null?squareCentreClient(point.row,point.col):point;
    let reply;
    const deadline=Math.min(end,Date.now()+180000),pointSince=Date.now();
    do{
      const walk=async()=>{
        if(Date.now()>deadline)throw Error('Brax point walk exhausted its original deadline');
        return command('walk_to',{...clientToProtocol(aim),fine:true,max_steps:180,stride:48,arrive_within:4,exact_arrival:true,hold_shelf:true});
      };
      reply=await resumeObservedRailWalk(await walk(),walk,{observe:read,room,owner:originLabel(ctx.origin??currentCallOrigin()),since:start,
        onObserved:detail=>log('point-confirmation-recovered',detail)});
      if(keeperSurvivalInterruption(reply)){
        log('point-survival-interruption',{reply});const initial=await read();
        const recovered=await recoverIslandFineWalk(ctx,{deadline,since:pointSince,active:true,initial,
          read:async()=>{const l=await read();if(l.room.num!==room)throw Error('Brax point recovery changed rooms');return {l,body:position(l)};}});
        if(!recovered)throw Object.assign(Error('Brax point recovery did not finish'),{reply,survival:true});
        log('point-survival-recovered',{position:(await read()).you});continue;
      }
      if(reply.reason!=='collision_geometry_changed')break;
      if(Date.now()>deadline)throw Error('Brax room animation did not settle');
      await sleep(1000);
    }while(true);
    const s=await read(),p=position(s);
    if(s.room.num!==room||Math.hypot(p.x-aim.x,p.y-aim.y)>128)throw Object.assign(Error('Brax fine walk stopped before its target'),{reply,observation:{room:s.room,you:s.you,doors:s.doors,objects:s.objects}});
  };
  const walkPoint=async(point,room=579)=>{
    const aim=point.x==null?squareCentreClient(point.row,point.col):point;
    const current=await read(),from=position(current);
    const flatTop=current.doors.observed?.[2]===800&&current.doors.observed?.[3]===800;
    for(const target of room===579&&!flatTop?platformAims(from,aim):[aim]){
      try{await rawWalkPoint(target,room);}
      catch(error){
        if(room!==579||!braxStoppedPlatformWalk(error.reply))throw error;
        let complete=false;
        const deadline=Math.min(end,Date.now()+90000);
        while(!complete&&Date.now()<deadline){
          const s=await read(),geo=roomGeometry(room);
          applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(s.doors.observed).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>geo});
          // A routing pivot is a guide, not a destination. A parked rider may
          // occupy it permanently; prove a whole route to the actual endpoint.
          const from=protocolToClient(s.you),floor=Math.min(floorAt(geo,from.x,from.y),floorAt(geo,aim.x,aim.y));
          const plan=planBodyDetour(geo,s.you,clientToProtocol(aim),{
            objects:new Map(s.objects.map(o=>[o.id,o])),selfId:s.you.id,minimumFloor:floor-16,maxRangeSquares:24,marginSquares:4,maxNodes:12000,maxMs:1000});
          log('body-detour',{found:plan.found,reason:plan.reason,nodes:plan.nodes,pivot:target,goal:aim});
          if(!plan.found){await sleep(Math.min(500,Math.max(1,deadline-Date.now())));continue;}
          try{for(const point of plan.waypoints)await rawWalkPoint(protocolToClient(point),room);complete=true;}
          catch(next){if(!braxStoppedPlatformWalk(next.reply))throw next;error=next;await sleep(Math.min(500,Math.max(1,deadline-Date.now())));}
        }
        if(!complete)throw error;
        return; // The detour reached the real endpoint, not the blocked guide.
      }
    }
  };
  const follow=async(file,label)=>{
    const invokedAt=Date.now();
    const args=['tools/m59-fineclimb.mjs','--fleet',fleet,'--port',controlURL.port,'--agent',agent,'--rail','brax','--rail-file',file,'--origin-json',JSON.stringify(ctx.origin??currentCallOrigin()),'--convoy-json',JSON.stringify({key:originLabel(ctx.origin??currentCallOrigin()),characters:state.braxConvoyCharacters??[keeper.character]}),'--no-hop','--native-rail','--coalesce-rail','--serialize-jumps','--wait-bodies','--keeper-position','--precise-waypoints','--steps','32','--stride','8',...(label==='cliffs'?['--queue-end']:[]),'--receipt',join(out,id+'-'+label+'-commands.jsonl')];
    const commandsFile=join(out,id+'-'+label+'-commands.jsonl');
    const result=await new Promise(done=>execFile(process.execPath,args,{cwd:root,timeout:Math.max(1,end-Date.now()),maxBuffer:8e6,windowsHide:true},(error,stdout,stderr)=>done({error,stdout,stderr})));
    writeFileSync(join(out,id+'-'+label+'.txt'),result.stdout+'\n'+result.stderr);
    if(result.error){
      const rows=existsSync(commandsFile)?readFileSync(commandsFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>Date.parse(row.at)>=invokedAt):[];
      const last=rows.findLast(row=>row.kind==='keeper-recovery')?.reply??rows.filter(row=>['native-walk','walk','alignment','jump'].includes(row.kind)).at(-1)?.reply;
      const outcome=rows.findLast(row=>row.kind==='outcome');let survival=keeperSurvivalInterruption(last),continuation=null;const failure={kind:'child_exit',code:result.error.code??null,signal:result.error.signal??null,error:result.error.message,stderr:result.stderr.slice(-3000)};
      try{
        const current=await read(),order=current.movement?.order,owner=originLabel(ctx.origin??currentCallOrigin());
        if(label==='cliffs'&&outcome?.came_off?.kind==='native-walk')continuation=braxEndedCliffContinuation(ctx,outcome.came_off.reply,current,{since:invokedAt});
        survival ||= continuation==='owned-recovery';
        failure.native={pid:current.pid,room:current.room,you:current.you,position_read:current.position_read,hp:current.hp,mana:current.mana,vigor:current.vigor,faculties:current.autopilot_status?.faculties,recovery:current.autopilot_status?.survival_decisions?.current,preemptions:current.movement?.preemptions,order,rail:current.movement?.rail,continuation};
        if(!survival&&!continuation&&!current.autopilot_status?.recovery_travel&&order?.ordered_by===owner){await command('cancel_movement');failure.ownedOperationCancelled=true;}
      }catch(error){failure.observationError=error.message;}
      log('rail-child-failure',failure);
      throw Object.assign(Error('Brax '+label+' rail follower stopped'),{survival,interruption:survival?last:null,endedConfirmation:!!continuation,confirmationEnded:continuation==='observed-ready',outcome:outcome??failure});
    }
  };
  const cut=async(to,label)=>{
    const s=await read(),geo=roomGeometry(s.room.num);
    if(s.room.num===579)applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(s.doors.observed).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>geo});
    const from=position(s),edge=edgeOf(geo);
    const proof=cutRail(from,to,{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
    if(!proof.ok||!proof.bridgeOk)throw Error('Brax '+label+' exact route not proved');
    const leg=railLeg({waypoints:proof.waypoints},{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
    const route={ok:true,rail_complete:!leg.unvalidated,direction:'to_node',exit:label,exit_label:label,from:`r${s.you.row}c${s.you.col}`,to:`r${Math.floor(to.y/1024)+1}c${Math.floor(to.x/1024)+1}`,legs:[leg],jumps:0,all_declared:true,waypoints:leg.waypoints.length};
    if(!route.rail_complete||!checkRoute(route,{edge}).ok)throw Error('Brax '+label+' cut check refused');
    const file=join(out,id+'-'+label+'.json');writeFileSync(file,JSON.stringify({stones:[{node:'brax',room:s.room.num,routes:[route]}]}));await follow(file,label);
  };
  const jump=async(to,expectedFloor,{queueOnBlocked=false}={})=>{
    const deadline=Math.min(end,Date.now()+90000);
    const declaration={room:579,from:{row:to.row===25?32:15,col:to.col},to:{row:to.row,col:to.col},
      from_fine:{x:to.x,y:to.row===25?32000:14848},to_fine:{x:to.x,y:to.y}};
    for(;;){
      const current=await waitForRailGeometry(async()=>{const s=await native();checkIslandCancellation(ctx,s);if(s.pid!==keeper.pid)throw Error('Brax jump keeper changed');return s;},{room:579,deadline,owner:originLabel(ctx.origin??currentCallOrigin()),since:start}),geo=roomGeometry(579);
      if(current.room.num!==579)throw Error('Brax jump room changed');
      if(braxActiveRecovery(current)){
        log('jump-recovery-wait',{to,hp:current.hp,vigor:current.vigor,decision:current.autopilot_status?.survival_decisions?.current});
        if(!activeOwnedFineRecovery(ctx,current)||!await recoverIslandFineWalk(ctx,{deadline,since:start,active:true,initial:current,read:async()=>({l:await read()})}))throw Object.assign(Error('Brax jump recovery did not complete within the original deadline'),{observation:current});
        continue;
      }
      applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(current.doors.observed).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>geo});
      const plan=planDeclaredTakeoff(geo,current.you,declaration,{objects:new Map(current.objects.map(o=>[o.id,o])),selfId:current.you.id,stayInLane:to.row===8});
      if(!plan.found){
        if(!planDeclaredTakeoff(geo,current.you,declaration).found)throw Object.assign(Error('Brax actual takeoff cannot prove the declared flight'),{observation:{room:current.room,you:current.you,doors:current.doors,objects:current.objects,plan,declaration}});
        if(queueOnBlocked)return false;
        if(Date.now()>=deadline)throw Error('Brax jump body wait exhausted');
        log('jump-body-wait',{to,position:position(current),keeper_pid:current.pid,room_object_id:current.room.object_id,declaration,plan,hp:current.hp,mana:current.mana,vigor:current.vigor,recovery:current.autopilot_status?.survival_decisions?.current,observed:current.doors.observed,objects:current.objects.filter(o=>(o.flags&1)&&Number.isFinite(o.x)&&Number.isFinite(o.y)).map(({id,x,y,row,col,flags,name})=>({id,x,y,row,col,flags,name}))});await sleep(1000);continue;
      }
      if(Math.hypot(plan.takeoff.x-current.you.x,plan.takeoff.y-current.you.y)>0){
        const alignment=await command('walk_to',{...plan.takeoff,fine:true,max_steps:8,stride:8,arrive_within:0,exact_arrival:true,hold_shelf:true});
        if(queueOnBlocked&&alignment.arrived!==true&&(alignment.reason==='object_blocked'||alignment.geometry_rejections?.includes('object_blocked')))return false;
        if(Date.now()>=deadline)throw Error('Brax takeoff alignment timed out');
        continue; // re-prove the actual body after its ordinary alignment walk
      }
      const target=clientToProtocol(declaration.to_fine),probe=await readRailMoveCheck(keeper,target,{slide:true,fall:true,timedFall:true});
      if(!provedRailMove(probe,target)){
        log('native-flight-wait',{to,probe});
        if(queueOnBlocked)return false;
        if(Date.now()>=deadline)throw Error('Brax native flight readiness timed out');
        await sleep(500);continue;
      }
      const args={to_row:to.row,to_col:to.col,origin:ctx.origin??currentCallOrigin()},reply=await native.action('jump',args,{timeoutMs:Math.max(1,deadline-Date.now())});log('command',{name:'jump',args,reply});
      if(unsentRailGeometryRefusal(reply)){
        log('native-flight-unsent',{to,reply});
        if(queueOnBlocked)return false;
        if(Date.now()>=deadline)throw Error('Brax native flight readiness timed out');
        await sleep(500);continue;
      }
      if(unsentRailAnimationRefusal(reply)){log('jump-animation-wait',{to,animation:reply.mover.animation});continue;}
      if(!unsentBraxJumpRefusal(reply)){
        if(reply.jumped===false)throw Object.assign(Error('Brax jump refused: '+(reply.reason??reply.error??'unknown')),{reply});
        break;
      }
      const waiting=await read();
      if(waiting.room.num!==579)throw Object.assign(Error('Brax jump room changed after an unsent refusal'),{reply,observation:waiting});
      if(queueOnBlocked)return false;
      if(Date.now()>=deadline)throw Error('Brax jump body wait exhausted');
      log(reply.mover?.reason==='casting_hold'?'jump-cast-wait':'jump-body-wait',{to,position:position(waiting),hp:waiting.hp,mana:waiting.mana,vigor:waiting.vigor,recovery:waiting.autopilot_status?.survival_decisions?.current,reply});await sleep(1000);
    }
    // The existing mover may choose a body-clearing lane within this square.
    // Accept that legal adjustment, then independently require the expected shelf below.
    let observed,lastPose;
    const landed=await until(async()=>{
      const s=await read(),geo=roomGeometry(579);
      applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(s.doors.observed).map(([id,height])=>[+id,{height,type:4}])),null,{geometryOf:()=>geo});
      const proof=braxLandingProof(geo,s,to,expectedFloor),key=s.room.num+':'+s.you.x+','+s.you.y;
      observed={room:s.room,you:s.you,expected:to,expectedFloor,actualFloor:floorAt(geo,position(s).x,position(s).y),proof};
      if(key!==lastPose){lastPose=key;log('landing-observation',observed);}
      return proof?s:null;
    },'Brax fall landing not observed',12000).catch(error=>{error.observation=observed;throw error;});
    const s=await read(),p=position(s),geo=roomGeometry(579);
    applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(s.doors.observed).map(([k,height])=>[Number(k),{height,type:4}])),null,{geometryOf:()=>geo});
    const actualFloor=floorAt(geo,p.x,p.y);
    if(!Number.isFinite(actualFloor)||Math.abs(actualFloor-expectedFloor)>1)throw Error('Brax landed on wrong shelf');
    log('landing',{position:p,floor_client:expectedFloor});return landed;
  };
  const update=fn=>journal.change(g=>{if(g?.id!==batchId)throw Error('Brax batch was replaced');fn(g);return g;});
  const phase=async(wanted)=>until(async()=>{let g=await update(g=>{});if(g.failure)throw Error(g.failure);return wanted.includes(g.phase)?g:null;},'Brax group phase timed out',240000);
  const pull=async(lever)=>{
    await walkPoint(lever.stand);const l=await call('look',{agent});
    const found=l.objects.filter(o=>/lever/i.test(o.name)&&o.row===lever.row&&o.col===lever.col);
    if(found.length!==1)throw Error('Brax lever not uniquely visible');
    const before=await read(),puzzle=await update(g=>{});
    if(!braxLeverUsable(puzzle,lever,before.doors.observed))throw Error('Brax lever not known usable in the current puzzle phase');
    log('lever-ready',{row:lever.row,col:lever.col,phase:puzzle.phase,readiness:puzzle.readiness,observed:before.doors.observed});
    const since=before.ev_seq;
    await update(g=>{g.lastTouchAttemptAt=Date.now();});
    const reply=await command('act',{verb:'activate',target:found[0].id});
    const confirmed=await awaitLeverConfirmation(reply,{since,
      waitEvent:args=>command('wait_for_event',args),observedRaised:async()=>(await read()).doors.observed?.[3]===800});
    if(!confirmed)throw Error('Brax lever switch was not confirmed');
    log('lever',{row:lever.row,col:lever.col,id:found[0].id});
    if((await read()).doors.observed?.[3]===800){const raised=await update(g=>{g.raisedAt??=Date.now();});log('lift-raised',{batch:batchId,raisedAt:raised.raisedAt});}
  };
  const cross=async(row,col,to)=>{
    const owner=originLabel(ctx.origin??currentCallOrigin());
    await travelBraxRoad({read:()=>read({fine:false}),confirmArrival:read,command,owner,to,maxHops:1,deadline:Math.min(end,Date.now()+180000),
      onWait:detail=>log('crossing-wait',{to,...detail}),trafficReady:async(_s,traffic)=>{const actual=await read();return roadTrafficGap(roomGeometry(actual.room.num),actual,traffic);}});
    await command('cancel_movement');log('entered',{room:to});
  };
  const northEgress=async()=>{
    const reply=await queuedRoomExit(ctx,578,{observe:native,branch:{row:1,col:62},queuePath:true,characters:state.braxConvoyCharacters??[keeper.character],timeoutMs:Math.min(180000,end-Date.now())});
    log('north-egress',{reply});if(!reply.arrived)throw Object.assign(Error('Brax north egress stopped'),{reply});
    log('north-clear',{atExit:true});
  };
  const northFall=async(col,{approached=false}={})=>{
    const p=position(await read());
    // At full height the center spire and platform share one floor.
    const x=(col-1)*1024+512;if(!approached)await walkPoint({x,y:14848});
    await jump({row:8,col,x,y:7680},8160);
    await northEgress();
  };
  const onward=async(room,to,label,row,col,next)=>{
    if(room===578||room===826){const actual=await read();if(actual.room.num===next)return;if(actual.room.num!==room)throw Error('Brax '+label+' unexpected recovery room');const reply=await queuedRoomExit(ctx,next,{observe:native,characters:state.braxConvoyCharacters,timeoutMs:Math.min(600000,end-Date.now())});log('queued-onward',{label,room,to:next,reply});return;}
    for(let attempt=0;attempt<3;attempt++){
      const s=await read();if(s.room.num===next)return;
      if(s.room.num!==room)throw Error('Brax '+label+' unexpected recovery room');
      try{
        await checkedIslandWalk(ctx,clientToProtocol(to),{room,allowEdgeTo:next,budgetMs:Math.min(600000,end-Date.now()),onSample:l=>{if(l.room?.num!==room)throw Error('Brax onward room changed');}});
        await cross(row,col,next);return;
      }
      catch(error){
        if(!error.survival||attempt===2)throw error;
        log('survival-interruption',{label,attempt,reply:error.interruption});
        let stableSince=0,lastHP=0;
        await until(async()=>{
          const s=await read();
          if(s.room.num!==room)throw Error('Brax survival changed rooms');
          if(!readyAfterSurvival(s,Math.max(0.9,ctx.minHealth??0.9))||s.hp.value<lastHP)stableSince=0;
          else stableSince ||= Date.now();
          lastHP=s.hp.value;
          return stableSince&&Date.now()-stableSince>=8000?s:null;
        },'Brax keeper recovery timed out',180000);
        log('survival-recovered',{label,attempt,position:position(await read())});
      }
    }
  };
  const finish=async()=>{
    if((await read()).room.num===833){
      const owner=originLabel(ctx.origin??currentCallOrigin());
      await travelBraxRoad({read:()=>read({fine:false}),confirmArrival:read,command,owner,to:827,maxHops:3,deadline:Math.min(end,Date.now()+180000),trafficReady:async(_s,traffic)=>{const current=await read();return roadTrafficGap(roomGeometry(current.room.num),current,traffic);}});
    }
    if((await read()).room.num===579)await onward(579,{x:62976,y:512},'north-exit',0,62,578);
    if((await read()).room.num===578)await onward(578,{x:50176,y:27136},'cragged-east',27,51,826);
    if((await read()).room.num===826)await onward(826,{x:44544,y:18944},'caverns-east',19,45,827);
    const s=await read();state.brax.success=braxArrival(s);log('objective',{success:state.brax.success,room:s.room,you:s.you,hp:s.hp});
    if(!state.brax.success)throw Error('Ancient Graveyard of Brax not reached');
    // Arrival completes the travel order. A null post prevents a former room
    // enchantment worker from interpreting Brax as a new stationary casting post.
    await command('autopilot',{action:'set',mode:'idle',assigned_room:null,roam:false,town_trips:false,farm_strategy:null,training_weapon_only:false});return true;
  };
  try{
    let s=await read();log('start',{room:s.room,you:s.you,hp:s.hp});
    await command('autopilot',{action:'set',mode:'idle',assigned_room:null,roam:false,town_trips:false,farm_strategy:null,training_weapon_only:false});
    if(braxArrival(s)){log('already-at-objective');return await finish();}
    if(s.room.num===833){log('resume-goad');return await finish();}
    if(s.room.num===826){log('resume-caverns');return await finish();}
    if(s.room.num===578){
      const geo=roomGeometry(578),edge=edgeOf(geo),proof=cutRail(position(s),{x:50176,y:27136},{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
      if(proof.ok&&proof.bridgeOk){log('resume-cragged-eastern-component');return await finish();}
    }
    if(resumeNorthLedge){
      const p=position(s);
      if(s.room.num!==579||s.you.row!==7||![55,56].includes(s.you.col)||floorAt(roomGeometry(579),p.x,p.y)!==8160)throw Error('Brax continuation requires the actual north shelf');
      log('north-shelf-continuation',{position:p});await northEgress();return await finish();
    }
    // Explicit measured continuation: no placement and no inferred lift timing.
    if(resumeRaisedAt!=null){
      if(!Number.isFinite(resumeRaisedAt)||Date.now()>resumeRaisedAt+100000||s.room.num!==579||s.doors.observed?.[3]!==800)throw Error('Brax lift continuation is not current');
      log('continuation',{raised_at:resumeRaisedAt});await sleep(Math.max(0,resumeRaisedAt+liftWaitMs()-Date.now()));
      await northFall(55);return await finish();
    }
    let aboardAlready=false;
    if(s.room.num===579){
      const g=roomGeometry(579),p=position(s);
      applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(s.doors.observed).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>g});
      const height=floorAt(g,p.x,p.y),platform=s.doors.observed?.[3];
      if(p.y<=9216&&p.x>=51200&&Number.isFinite(height)){
        const north=cutRail(p,{x:62976,y:512},{edge:edgeOf(g),bounds:{w:g.cols*1024,h:g.rows*1024},floorAt:(x,y)=>floorAt(g,x,y)});
        if(north.ok&&north.bridgeOk){log('resume-north-shelf',{position:p,height});await northEgress();return await finish();}
      }
      aboardAlready=p.x>=51200&&p.x<=62464&&p.y>=14336&&p.y<=26624&&[250,800].includes(platform)&&height===platform*16;
      if(aboardAlready)log('resume-platform',{position:p,height});
    }
    if(!aboardAlready){
    if(s.room.num!==579||s.you.col<=2){
      const owner=originLabel(ctx.origin??currentCallOrigin());
      for(const[from,to]of[[39,38],[38,2],[2,599]]){const city=await read();if(city.room.num===from){const reply=await queuedRoomExit(ctx,to,{observe:native,queuePath:from===38,characters:state.braxConvoyCharacters,timeoutMs:Math.min(600000,end-Date.now())});log('queued-city-exit',{from,to,reply});}}
      await travelBraxRoad({read:()=>read({fine:false}),command,owner,onWait:data=>log('road-wait',data),trafficReady:async(_state,traffic)=>{const current=await read();return roadTrafficGap(roomGeometry(current.room.num),current,traffic);},to:589,deadline:Math.min(end,Date.now()+600000)});
      const entry=await queuedRoomExit(ctx,579,{observe:native,characters:state.braxConvoyCharacters,timeoutMs:Math.min(600000,end-Date.now())});log('queued-entry',{from:589,to:579,reply:entry});
    }
    await command('cancel_movement');await command('rest',{stand:true});
    await command('autopilot',{action:'set',mode:'idle',assigned_room:null,roam:false,town_trips:false,farm_strategy:null,training_weapon_only:false});
    // Ordinary travel lands beside the eastern exit, not at the recorded rail head.
    // Survival may also have moved us to cover. Prove a walk from the actual body.
    const approach=JSON.parse(readFileSync(approachFile,'utf8')).stones.find(stone=>stone.node==='brax')?.routes[0];
    const head=approach?.legs[0]?.waypoints[0];if(!head)throw Error('Brax approach rail has no head');
    let endedCliffContinuations=0;
    for(;;){
      s=await read();const here=position(s),geo=roomGeometry(579),legStart=Date.now();
      applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(s.doors.observed).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>geo});
      const floor=floorAt(geo,here.x,here.y);
      if(braxSouthQueueReached(geo,s)){log('south-queue-continuation',{position:s.you,floor,observed:s.doors.observed});break;}
      const alreadyOnRail=!!railBoarding(approach.legs,here,{floor,within:1024,strictFloor:true,geo});
      try{
        if(!alreadyOnRail)await checkedIslandWalk(ctx,clientToProtocol(head),{room:579,allowEdgeTo:589,budgetMs:Math.min(600000,end-Date.now()),
          stopWhen:current=>{const at=protocolToClient(current.you),floor=floorAt(geo,at.x,at.y);return railBoarding(approach.legs,at,{floor,within:1024,strictFloor:true,geo});}});
        await follow(approachFile,'cliffs');break;
      }catch(error){
        if(error.endedConfirmation&&++endedCliffContinuations>3)throw Error('Brax cliff confirmation continuation budget exhausted');
        if(error.confirmationEnded){log('cliff-confirmation-recovered',{attempt:endedCliffContinuations,position:(await read()).you});continue;}
        let initial=await read({fine:false});
        const recoveryTrip=keeperRecoveryTripSince(initial,legStart)||error.interruption?.reason==='keeper_recovery_trip_active'||initial.room.num!==579&&ownedBraxRoadRecovery(initial,ctx.origin??currentCallOrigin(),start);
        if(!error.survival&&!recoveryTrip)throw error;
        log('cliff-survival-interruption',{reply:error.interruption,entryRecoveryTrip:recoveryTrip});
        if(recoveryTrip){
          while(initial.autopilot_status?.recovery_travel){if(Date.now()>=end)throw Error('Brax recovery trip exhausted route deadline');await sleep(500);initial=await read({fine:false});}
          initial=await read();
          log('cliff-recovery-trip-complete',{room:initial.room.num,position:initial.you});
          return await runBrax(ctx,{expectedAgents,gatherMs,timeoutMs:Math.max(1,end-Date.now()),approachFile});
        }
        initial=await read();
        if(initial.room.num!==579||!await recoverIslandFineWalk(ctx,{deadline:end,since:legStart,active:true,initial,
          read:async()=>{const l=await read();if(l.room.num!==579)throw Error('Brax cliff recovery changed rooms');return {l,body:position(l)};}}))throw Error('Brax cliff recovery incomplete');
        log('cliff-survival-recovered',{position:position(await read())});
      }
    }
    s=await read();const south=position(s),geo=roomGeometry(579);
    applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(s.doors.observed).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>geo});
    const southFloor=floorAt(geo,south.x,south.y),endFloor=floorAt(geo,55808,32000);
    if(s.room.num!==579||!Number.isFinite(southFloor)||!Number.isFinite(endFloor)||Math.hypot(south.x-55808,south.y-32000)>1536||Math.abs(southFloor-endFloor)>16)throw Error('Brax south queue not reached');
    log('south-queue-ready',{position:s.you});
    }
    const server=(await(await fetch(new URL('health',controlURL))).json()).game_server;
    journal=groupJournal(`${server.host}:${server.port}`);
    ticket=agent+'-'+randomUUID();
    await until(async()=>{
      s=await read({fine:false});if(s.doors.observed?.[3]!==250)return false;
      s=await read();
      let accepted=false;
      const g=await journal.change(g=>{
        const now=Date.now();
        g=braxAdmissionGroup(g,s.doors.observed,{now,requestKey:originLabel(ctx.origin??currentCallOrigin()),expectedAgents,gatherMs});
        if(g.phase!=='boarding'||now>g.cutoff||g.members.length>=25)return g;
        const station=freePlatformStation(g.members,s.objects,s.you.id,s.you);if(station==null)return g;
        const m={ticket,agent,character:keeper.character,pid:process.pid,slot:g.members.length,station,aboard:false,corners:false,gone:false};
        g.members.push(m);if(g.hardGatherAt!=null)g.cutoff=rollingGatherCutoff({cutoff:g.cutoff,hardCutoff:g.hardGatherAt,idleMs:g.gatherMs},now);accepted=true;return g;
      });
      if(accepted){batchId=g.id;return true;}return false;
    },'Brax lift unavailable for a new group',600000);
    let g=await update(g=>{}),me=g.members.find(m=>m.ticket===ticket);
    log('admitted',{batch:batchId,slot:me.slot,readiness:g.readiness});
    // One boarding trajectory at a time keeps the common landing clear.
    const lane=me.slot%2,col=55+lane,x=55808+lane*1024;
    // Keep alignment/flight exclusive: a legal takeoff may be diagonal.
    // Only the already confirmed landing/parking stage may overlap the next fall.
    const boardingGate=crossingGate([server.host,server.port,579,'platform-boarding'].join(':')),
      landingGate=crossingGate(braxBoardingLaneKey(server,col)),boardingOwner={pid:process.pid,token:ticket,agent};
    const boardingDeadline=Math.min(end,Date.now()+360000);
    let boarded=false,boardingState;
    const checkBoarding=async()=>{
      const current=await update(g=>{});if(current.failure)throw Error(current.failure);
      boardingState=await read({fine:false});if(boardingState.room.num!==579)throw Error('Brax boarding room changed');const geo=roomGeometry(579);
      applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(boardingState.doors.observed).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>geo});
    };
    const readyToBoard=()=>aboardAlready||boardingState.in_game===true&&boardingState.connected!==false&&boardingState.you&&!boardingState.you.predicted&&!!chooseBraxBoarding(roomGeometry(579),boardingState.you,new Map(boardingState.objects.map(o=>[o.id,o])),{columns:[col]});
    while(!boarded){
      await waitForCrossing(landingGate,boardingOwner,{deadline:boardingDeadline,check:checkBoarding,ready:readyToBoard});
      try{
        await waitForCrossing(boardingGate,boardingOwner,{deadline:boardingDeadline,check:checkBoarding,ready:readyToBoard});
        try{
          if(!aboardAlready){const current=await read(),chosen=chooseBraxBoarding(roomGeometry(579),current.you,new Map(current.objects.map(o=>[o.id,o])),{columns:[col]});if(!chosen)continue;
            if(await jump({row:25,col:chosen.col,x:chosen.x,y:25088},4000,{queueOnBlocked:true})===false)continue;}
          const landing=(await read()).you;
          // jump() returned only after an actual connected landing on floor4000.
          // The next column may start while this character walks into the grid.
          await boardingGate.release(boardingOwner);
          await releaseAfterClearance(landingGate,boardingOwner,walkPoint(braxWorkStand(me.slot,g.expectedAgents?.length??g.members.length,me.station??me.slot)),{
            read,clear:s=>{
              const p=protocolToClient(s.you),floor=floorAt(roomGeometry(579),p.x,p.y);
              return s.room.num===579&&Math.hypot(s.you.x-landing.x,s.you.y-landing.y)>=32&&Number.isFinite(floor)&&Math.abs(floor-4000)<=16;
            },onClear:s=>log('boarding-clear',{actual:s.you,landing})});
          await update(g=>{g.members.find(m=>m.ticket===ticket).aboard=true;});log('aboard',{batch:batchId,slot:me.slot});boarded=true;
        }finally{await boardingGate.release(boardingOwner);}
      }finally{await landingGate.release(boardingOwner);if(!boarded)await sleep(500);}
    }
    g=await until(async()=>{const g=await update(g=>{if(g.phase==='boarding'&&braxBoardingComplete(g,Date.now()))g.phase='center';});if(g.failure)throw Error(g.failure);return g.phase!=='boarding'?g:null;},'Brax group did not assemble',420000);
    if(me.slot===0){
      await pull({row:21,col:55,stand:{row:22,col:55}});
      await until(async()=>(await read()).doors.observed?.[2]===800,'Brax center lever effect missing',8000);
      await update(g=>{g.phase='corners';g.centerAt=Date.now();});
    }
    g=await phase(['corners']);
    for(const lever of cornerWork(me.slot,g.members.length))await pull(lever);
    // Stay on the corner's safe platform floor while it rises. Returning to a
    // station crosses other lever workers and cannot delay their completion.
    await update(g=>{g.members.find(m=>m.ticket===ticket).corners=true;});
    g=await until(async()=>{let g=await update(g=>{});if(g.failure)throw Error(g.failure);return g.members.every(m=>m.corners)?g:null;},'Brax corner work incomplete',120000);
    if(me.slot===0){
      await until(async()=>(await read()).doors.observed?.[3]===800,'Brax puzzle did not raise lift',10000);
      g=await update(g=>{g.phase='rising';g.raisedAt??=Date.now();g.readyAfter=g.raisedAt+BRAX_SOLVED_RESET_MS;});
      log('lift-raised',{batch:batchId,raisedAt:g.raisedAt,targetHeight:800});
    }
    g=await phase(['rising','leaving','departed']);
    // Full 550/15 seconds plus margin, then validate the packet and floor.
    await sleep(Math.max(0,g.raisedAt+liftWaitMs()-Date.now()));
    s=await read();if(s.room.num!==579||s.doors.observed?.[3]!==800||s.doors.observed?.[4]!==510)throw Error('Brax lift height did not validate');
    log('lift-validated',{batch:batchId,raisedAt:g.raisedAt,observed:s.doors.observed});
    await update(g=>{if(g.phase==='rising')g.phase='leaving';});
    // Assemble two half-square-spaced queues before waiting for the preceding fall.
    // Successive riders then advance half a square, rather than walking from a distant station.
    await walkPoint(departureSlot(me.slot));log('departure-queue',{slot:me.slot});
    // The native mover owns the whole lane. It reads its current body and the
    // moving leader on every gap, avoiding repeated stale cached aim requests.
    // Collision proof determines when each traveler can leave, independently
    // of a predecessor's parent process reaching its journal update.
    const current=await read(),a={...protocolToClient(current.you),f:12800},b={x,y:14848,f:12800};
    const departure=await native.action('walk_rail',{room:579,leg:{kind:'walk',waypoints:[b],sourceWaypoints:[a,b]},
      nextJump:{room:579,from:{row:15,col},to:{row:8,col},from_fine:{x,y:14848},to_fine:{x,y:7680}},
      stayInLane:true,timeoutMs:80000,origin:ctx.origin??currentCallOrigin()},{timeoutMs:90000});
    log('departure-lane',{slot:me.slot,reply:departure});
    if(!departure.arrived&&!departure.joined_takeoff)throw Object.assign(Error('Brax native departure lane did not clear'),{reply:departure});
    await northFall(col,{approached:true});
    // Walk off the landing before the next member uses the same trajectory.
    await update(g=>braxRecordMemberExit(g,ticket));
    return await finish();
  }catch(e){log('failure',{reason:e.message,error:errorEvidence(e),interruption:e.interruption??null,railOutcome:e.outcome??null,fine:state.islandFineFailure??null,recovery:state.islandRecoveryFailure??null,observation:e.observation??state.islandObservationFailure??null,reply:e.reply??null});state.brax.failure=e.message;
    if(journal&&batchId)await update(g=>{
      braxRecordMemberFailure(g,ticket,e.message,Date.now());
    }).catch(()=>{});
    return {ok:false,why:e.message};
  }
}

export {crossingGate as braxCrossingGate} from './m59-crossing-queue.mjs';

export {followRoadJourney as travelBraxRoad} from './m59-road-journey.mjs';
