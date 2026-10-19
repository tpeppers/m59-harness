// Reusable fine-rail crowd planning. Coordinates at this boundary are named KOD points.
import {floorAt} from './m59-ground.mjs';
import {cutRail} from './m59-railcut.mjs';
import {railLeg} from './m59-noderails.mjs';
import {protocolToClient,clientToProtocol} from './m59-finepos.mjs';
import {blockingBodySnapshot,planBodyDetour} from './m59-body-detour.mjs';
import {railBoarding,quantizeRailPoint} from './m59-railfollow.mjs';
export function chooseCrowdClearanceStep(geo,objects,controlledIds,{exclude=new Set(),eligible=()=>true,avoidSquares=new Set(),clearance=28,acceptStep=()=>true}={}){
 clearance=Math.max(28,Math.min(96,Number(clearance)||28));
 const pressureRadius=Math.max(32,clearance);
 const all=[...objects.values()].filter(o=>Number.isFinite(o.x)&&Number.isFinite(o.y)),bodies=all.filter(o=>(o.flags&1)!==0);let best;
 for(const p of all){
  if(!controlledIds.has(p.id)||exclude.has(p.id)||!eligible(p))continue;
  const others=bodies.filter(o=>o.id!==p.id),clear=q=>Math.min(...others.map(o=>Math.hypot(o.x-q.x,o.y-q.y))),before=clear(p);
  if(before>=clearance)continue;
  const pressure=q=>others.reduce((sum,o)=>sum+Math.max(0,pressureRadius-Math.hypot(o.x-q.x,o.y-q.y))**2,0),priorPressure=pressure(p);
  const from=protocolToClient(p),height=floorAt(geo,from.x,from.y),obstacles=blockingBodySnapshot(objects,p.id);
  if(!Number.isFinite(height))continue;
  for(const radius of [4,8,16,32,64])for(let i=0;i<32;i++){
   const target={x:Math.round(p.x+radius*Math.cos(i*Math.PI/16)),y:Math.round(p.y+radius*Math.sin(i*Math.PI/16))},point=protocolToClient(target),floor=floorAt(geo,point.x,point.y);
   const row=Math.floor(target.y/64),col=Math.floor(target.x/64);
   if(Number.isInteger(geo.rows)&&(row<1||row>geo.rows)||Number.isInteger(geo.cols)&&(col<1||col>geo.cols)||avoidSquares.has(row+','+col)||!acceptStep(p,target)||!Number.isFinite(floor)||Math.abs(height-floor)>384)continue;
   const after=clear(target);if(after<before+1||after<16||pressure(target)>=priorPressure-1)continue;
   const trace=geo.traceFineMoveClient(from.x,from.y,point.x,point.y,{slide:false,obstacles});if(!trace?.arrived||trace.blocked)continue;
   // Spacing must not drop into a pocket whose return crosses a higher lip.
   // Occupancy will change; prove the return terrain independently of bodies.
   const back=geo.traceFineMoveClient(point.x,point.y,from.x,from.y,{slide:false});if(!back?.arrived||back.blocked)continue;
   const gain=after-before;
   if(!best||gain>best.gain)best={id:p.id,from:{x:p.x,y:p.y},target,before,after,gain,height,floor};
  }
 }
 return best;
}
// Move the front of a close convoy forward before merely spreading it sideways.
export function chooseRailAdvanceStep(geo,objects,controlledIds,legs,{exclude=new Set()}={}){
 const all=[...objects.values()].filter(o=>Number.isFinite(o.x)&&Number.isFinite(o.y)),bodies=all.filter(o=>(o.flags&1)!==0);let best;
 for(const p of all){
  if(!controlledIds.has(p.id)||exclude.has(p.id))continue;
  const others=bodies.filter(o=>o.id!==p.id),clear=q=>Math.min(...others.map(o=>Math.hypot(o.x-q.x,o.y-q.y))),before=clear(p);
  if(before>=48)continue;
  const from=protocolToClient(p),height=floorAt(geo,from.x,from.y),board=railBoarding(legs,from,{floor:height,within:512,strictFloor:true,geo});
  if(!board)continue;
  const points=legs[board.leg].waypoints,obstacles=blockingBodySnapshot(objects,p.id);
  for(let i=board.denseIndex+1;i<Math.min(points.length,board.denseIndex+49);i++){
   const target=clientToProtocol(points[i]),point=protocolToClient(target),floor=floorAt(geo,point.x,point.y),after=clear(target);
   if(!Number.isFinite(floor)||height-floor>384||Math.hypot(target.x-p.x,target.y-p.y)>96||after<Math.max(24,before+1))continue;
   const trace=geo.traceFineMoveClient(from.x,from.y,point.x,point.y,{slide:false,obstacles});if(!trace?.arrived||trace.blocked)continue;
   const rank=board.leg*100000+i;
   if(!best||rank>best.rank)best={id:p.id,from:{x:p.x,y:p.y},target,before,after,height,floor,rank,railAdvance:true};
  }
 }
 return best;
}

// Find a reachable wire point beyond a landing. A square center can lie inside
// the collision radius of a curved wall even when its center has a floor.
// This plans terrain only; the ordinary mover still checks live bodies per packet.
export function planLandingClearance(geo,body,preferred,{minAdvance=32,maxOffset=16}={}){
 if(!geo?.collisionReady||body?.predicted||![body?.x,body?.y,preferred?.x,preferred?.y].every(Number.isFinite))return {found:false,reason:'landing_body_unconfirmed'};
 const from=protocolToClient(body),height=floorAt(geo,from.x,from.y),dx=preferred.x-body.x,dy=preferred.y-body.y,length=Math.hypot(dx,dy);
 if(!Number.isFinite(height)||length<minAdvance)return {found:false,reason:'landing_clearance_direction_unproved'};
 const candidates=[];
 for(let ox=-maxOffset;ox<=maxOffset;ox++)for(let oy=-maxOffset;oy<=maxOffset;oy++)candidates.push({x:Math.round(preferred.x)+ox,y:Math.round(preferred.y)+oy,d:ox*ox+oy*oy});
 candidates.sort((a,b)=>a.d-b.d);
 for(const p of candidates){
  if(((p.x-body.x)*dx+(p.y-body.y)*dy)/length<minAdvance)continue;
  const target=protocolToClient(p),floor=floorAt(geo,target.x,target.y);
  if(!Number.isFinite(floor)||Math.abs(floor-height)>384)continue;
  const trace=geo.traceFineMoveClient(from.x,from.y,target.x,target.y,{slide:false});
  if(trace?.arrived&&!trace.blocked)return {found:true,target:{x:p.x,y:p.y},floor,advance:((p.x-body.x)*dx+(p.y-body.y)*dy)/length};
 }
 return {found:false,reason:'no_proved_landing_clearance'};
}

// Follow the proved walking leg as far as the current body gap allows. This
// never crosses a declared jump or invents a lateral shortcut onto another shelf.
export function planRailForwardGap(geo,body,leg,{objects,selfId=body?.id,afterAim,minAdvance=8,maxAdvance=96,clearance=32}={}){
 if(!geo?.collisionReady||body?.predicted||!leg||leg.kind!=='walk')return {found:false,reason:'rail_gap_origin_unconfirmed'};
 const from=protocolToClient(body),height=floorAt(geo,from.x,from.y),points=leg.sourceWaypoints??leg.waypoints;
 const board=railBoarding([{kind:'walk',waypoints:points}],from,{floor:height,within:512,strictFloor:true});
 if(!board)return {found:false,reason:'rail_gap_off_route'};
 const after=afterAim?points.findIndex(p=>p.x===afterAim.x&&p.y===afterAim.y):-1;
 if(afterAim&&after<0)return {found:false,reason:'rail_gap_aim_unproved'};
 const obstacles=blockingBodySnapshot(objects,selfId),others=[...(objects?.values?.()??[])].filter(o=>o.id!==selfId&&(o.flags&1)&&Number.isFinite(o.x)&&Number.isFinite(o.y));let best;
 for(let index=Math.max(board.denseIndex+1,after+1);index<Math.min(points.length,board.denseIndex+97);index++){
  const aim=points[index],wire=quantizeRailPoint(aim,{floorAt:(x,y)=>floorAt(geo,x,y),edge:(a,b)=>geo.traceFineMoveClient(a.x,a.y,b.x,b.y)?.arrived===true});if(!wire.ok)continue;
  const target=wire.protocol,point=protocolToClient(target),distance=Math.hypot(target.x-body.x,target.y-body.y),floor=floorAt(geo,point.x,point.y);
  if(distance<minAdvance||distance>maxAdvance||height-floor>384||others.some(o=>Math.hypot(o.x-target.x,o.y-target.y)<clearance))continue;
  const trace=geo.traceFineMoveClient(from.x,from.y,point.x,point.y,{slide:false,obstacles});
  if(trace?.arrived&&!trace.blocked)best={found:true,target,index,advance:distance,floor,from:{x:body.x,y:body.y}};
 }
 return best??{found:false,reason:'no_proved_forward_gap'};
}

// A terminal queue is a safe place near the checked endpoint, not an arrival
// at that exact point. Callers opt in only after an explicit body refusal.
export function railEndQueueReady(geo,body,leg,{objects,selfId=body?.id,maxDistance=96}={}){
 if(!geo?.collisionReady||body?.predicted||leg?.kind!=='walk'||![body?.x,body?.y].every(Number.isFinite))return {ready:false};
 const end=(leg.sourceWaypoints??leg.waypoints)?.at(-1);if(!end)return {ready:false};
 const goal=clientToProtocol(end),from=protocolToClient(body),height=floorAt(geo,from.x,from.y),floor=floorAt(geo,end.x,end.y);
 if(!Number.isFinite(height)||!Number.isFinite(floor)||Math.abs(height-floor)>16||Math.hypot(body.x-goal.x,body.y-goal.y)>Math.min(128,maxDistance))return {ready:false};
 const bodies=blockingBodySnapshot(objects,selfId);if(!bodies.some(o=>Math.hypot(o.x-end.x,o.y-end.y)<=maxDistance*16))return {ready:false};
 const direct=geo.traceFineMoveClient(from.x,from.y,end.x,end.y,{slide:false});
 const connection=direct.arrived&&!direct.blocked?{found:true}:planBodyDetour(geo,body,goal,{refine:true,objects:new Map(),selfId,minimumFloor:Math.min(height,floor)-384,maxRangeSquares:8,marginSquares:2,maxNodes:6000,maxMs:150});
 return connection.found?{ready:true,position:body,goal,floor:height}:{ready:false};
}

// Release each clear traveler independently. Bodies that have already departed
// are still obstacles, but are never selected for staging a second time.
export function crowdDepartureReady(objects,controlledIds,{clearance=28}={}){
 const all=[...objects.values()].filter(o=>Number.isFinite(o.x)&&Number.isFinite(o.y));
 return all.filter(p=>controlledIds.has(p.id)&&all.every(o=>o.id===p.id||!(o.flags&1)||Math.hypot(o.x-p.x,o.y-p.y)>=clearance)).map(p=>p.id);
}


// Named KOD station points; the caller supplies the bodies that block this
// surface. Keep destination reservations and body clearance independent of rank.
export function nearestClearStation(stations,bodies,{reserved=new Set(),near=null,clearance=32}={}){
 const distance=p=>near&&Number.isFinite(near.x)&&Number.isFinite(near.y)?Math.hypot(p.x-near.x,p.y-near.y):0;
 return stations.filter(p=>!reserved.has(p.id)&&bodies.every(o=>Math.hypot(o.x-p.x,o.y-p.y)>=clearance)).sort((a,b)=>distance(a)-distance(b))[0]??null;
}


// A queue follower may approach the next person's current buffered position
// while that person advances. It cannot pass that predecessor or invent a detour.
export function planLineQueueAdvance(geo,body,head,{predecessor,objects,selfId=body?.id,clearance=32,maxAdvance=96,minAdvance=8}={}){
 if(!geo?.collisionReady||body?.predicted||!predecessor||![body?.x,body?.y,head?.x,head?.y,predecessor.x,predecessor.y].every(Number.isFinite))return{found:false};
 const dx=head.x-body.x,dy=head.y-body.y,length=Math.hypot(dx,dy);if(length<minAdvance)return{found:false};
 const ux=dx/length,uy=dy/length,px=predecessor.x-body.x,py=predecessor.y-body.y;
 if(Math.abs(px*uy-py*ux)>clearance)return{found:false};
 const limit=Math.min(length,maxAdvance,px*ux+py*uy-clearance);if(limit<minAdvance)return{found:false};
 const from=protocolToClient(body),height=floorAt(geo,from.x,from.y),obstacles=blockingBodySnapshot(objects,selfId);
 for(let advance=limit;advance>=minAdvance;advance-=4){
  const target={x:Math.round(body.x+ux*advance),y:Math.round(body.y+uy*advance)},to=protocolToClient(target),floor=floorAt(geo,to.x,to.y);
  if(!Number.isFinite(height)||!Number.isFinite(floor)||Math.abs(height-floor)>16)continue;
  const proof=geo.traceFineMoveClient(from.x,from.y,to.x,to.y,{slide:false,obstacles});
  if(proof.arrived&&!proof.blocked)return{found:true,target,advance:Math.hypot(target.x-body.x,target.y-body.y),floor};
 }
 return{found:false};
}

// A straight queue takes only its currently clear prefix. The caller rechecks
// from the actual native body after each paced packet; no lateral fan is used.
export function planStraightQueueAdvance(geo,body,head,{objects,selfId=body?.id,maxAdvance=48,minAdvance=4,clearance=32,maxRise=16,maxDrop=16}={}){
 if(!geo?.collisionReady||body?.predicted||![body?.x,body?.y,head?.x,head?.y].every(Number.isFinite))return {found:false,reason:'queue_origin_unconfirmed'};
 const dx=head.x-body.x,dy=head.y-body.y,length=Math.hypot(dx,dy);if(length<minAdvance)return {found:false};
 const from=protocolToClient(body),height=floorAt(geo,from.x,from.y),obstacles=blockingBodySnapshot(objects,selfId);
 for(let advance=Math.min(length,maxAdvance);advance>=minAdvance;advance-=4){
  const target={x:Math.round(body.x+dx/length*advance),y:Math.round(body.y+dy/length*advance)},to=protocolToClient(target),floor=floorAt(geo,to.x,to.y);
  if(!Number.isFinite(height)||!Number.isFinite(floor)||floor-height>maxRise||height-floor>maxDrop||obstacles.some(o=>Math.hypot(o.x-to.x,o.y-to.y)<clearance*16))continue;
  const proof=geo.traceFineMoveClient(from.x,from.y,to.x,to.y,{slide:false,obstacles});
  if(proof.arrived&&!proof.blocked)return {found:true,target,height,floor,advance:Math.hypot(target.x-body.x,target.y-body.y)};
 }
 return {found:false};
}

// Keep a landing connected to its onward corridor in one native order. A short
// clearance endpoint must not become a parked destination in front of followers.
// This is a terrain proof; the native mover rechecks actual bodies at every packet.
export function planQueuedEgress(geo,body,target,{avoidSquares=new Set(),maxMs=2000}={}){
 if(!geo?.collisionReady||body?.predicted||![body?.x,body?.y,target?.x,target?.y].every(Number.isFinite))return {found:false,reason:'egress_origin_unconfirmed'};
 const from=protocolToClient(body),goal=protocolToClient(target),floor=(x,y)=>floorAt(geo,x,y),bounds={w:geo.cols*1024,h:geo.rows*1024};
 const edge=(a,b)=>{if(avoidSquares.has(Math.floor(b.y/1024)+1+','+(Math.floor(b.x/1024)+1)))return false;const t=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false});return t?.arrived===true&&t.blocked!==true;};
 // Goal-directed distance pricing reuses the existing A* flood. A breadth-first
 // flood can spend the entire bounded budget exploring unrelated shelves.
 const cost=(a,b)=>Math.hypot(b.x-a.x,b.y-a.y);
 const phaseBudget=Math.max(1,maxMs/2);
 let lattice=64,cut=cutRail(from,goal,{edge,bounds,floorAt:floor,lattice,cost,maxMs:phaseBudget,deadline:performance.now()+phaseBudget});
 // A valid nearest bridge can still seed the wrong side of a narrow lip.
 // Retry one finer phase before declaring the actual endpoint disconnected.
 if(!cut.ok||!cut.bridgeOk){lattice=32;cut=cutRail(from,goal,{edge,bounds,floorAt:floor,lattice,cost,maxMs:phaseBudget,deadline:performance.now()+phaseBudget});}
 if(!cut.ok||!cut.bridgeOk)return {found:false,reason:'egress_ground_route_unproved',cut:{why:cut.why,visited:cut.visited}};
 const leg=railLeg({waypoints:cut.waypoints},{edge,bounds,floorAt:floor,lattice});
 if(leg.unvalidated)return {found:false,reason:'egress_leg_unproved'};
 return {found:true,leg:{...leg,sourceWaypoints:leg.waypoints,waypoints:leg.aims}};
}

// Open-ground convoy callers may go around a stationary body and rejoin a
// later proved bend. Shelf queues opt out and retain their exact line.
export function planRailBodyDetour(geo,body,leg,{objects,selfId=body?.id,fromIndex=0,maxMs=100}={}){
 if(!geo?.collisionReady||body?.predicted||!leg?.waypoints?.length)return{found:false,reason:'detour_origin_unconfirmed'};
 const started=performance.now(),others=blockingBodySnapshot(objects,selfId),from=protocolToClient(body),height=floorAt(geo,from.x,from.y);
 for(let index=fromIndex;index<Math.min(leg.waypoints.length,fromIndex+16);index++){
  const p=leg.waypoints[index],goal=clientToProtocol(p),distance=Math.hypot(goal.x-body.x,goal.y-body.y),floor=floorAt(geo,p.x,p.y);
  if(distance<4||distance>8*64||!Number.isFinite(floor)||!Number.isFinite(height)||others.some(o=>Math.hypot(o.x-p.x,o.y-p.y)<28*16))continue;
  const remaining=maxMs-(performance.now()-started);if(remaining<=0)break;
  const route=planBodyDetour(geo,body,goal,{objects,selfId,refine:true,minimumFloor:Math.min(height,floor)-384,maxRangeSquares:8,maxGoalRangeSquares:8,marginSquares:3,maxNodes:6000,maxMs:remaining});
  if(route.found)return{...route,index,target:goal};
 }
 return{found:false,reason:'no_proved_forward_body_detour'};
}

// All inputs here are protocol fine points. Identity is supplied by the caller;
// proximity alone never turns a stranger or a monster into a convoy member.
export function lineQueuePredecessor(body,head,{objects,selfId=body?.id,isConvoy=()=>false,nameOf=o=>o.name,clearance=32,horizon=128}={}){
 if(![body?.x,body?.y,head?.x,head?.y].every(Number.isFinite))return null;
 const dx=head.x-body.x,dy=head.y-body.y,length=Math.hypot(dx,dy);if(!length)return null;
 let best;
 for(const o of objects?.values?.()??[]){
  if(o.id===selfId||!(o.flags&1)||!(o.flags&4)||![o.x,o.y].every(Number.isFinite)||!isConvoy(nameOf(o)))continue;
  const along=((o.x-body.x)*dx+(o.y-body.y)*dy)/length,across=Math.abs((o.x-body.x)*dy-(o.y-body.y)*dx)/length;
  if(along<=0||along>Math.min(length+clearance,horizon)||across>=clearance)continue;
  if(!best||along<best.along)best={...o,along,across};
 }
 return best??null;
}
// Recheck the actual paced endpoint: a collision slide cannot leave the line
// whose clear prefix was selected. The mover still checks terrain and all bodies.
export function queueLineGuard(from,head,to,{tolerance=1}={}){
 if(![from?.x,from?.y,head?.x,head?.y,to?.x,to?.y].every(Number.isFinite))return {reason:'queue_line_unconfirmed'};
 const dx=head.x-from.x,dy=head.y-from.y,length=Math.hypot(dx,dy);if(!length)return {reason:'queue_line_finished'};
 const along=((to.x-from.x)*dx+(to.y-from.y)*dy)/length,across=Math.abs((to.x-from.x)*dy-(to.y-from.y)*dx)/length;
 return along<0||along>length+1||across>tolerance?{reason:'queue_lane_changed_before_send',traffic:'convoy_queue'}:null;
}
