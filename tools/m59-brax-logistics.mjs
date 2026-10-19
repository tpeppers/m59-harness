// Public, ordinary movement on each side of the Cragged ledge. No admin access.
import {roomGeometry,floorAt,edgeOf} from './m59-ground.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {cutRail} from './m59-railcut.mjs';
import {createRailObserver} from './m59-rail-observer.mjs';
import {queuedRoomExit} from './m59-queued-room-exit.mjs';
import {regionContains,regionSegmentAllowed} from './m59-movement-region.mjs';
import {coalesceCheckedRailLeg} from './m59-rail-coalesce.mjs';
import {clientToProtocol} from './m59-finepos.mjs';
import {currentCallOrigin} from './m59-fleetscript.mjs';
import {activeOwnedFineRecovery,ownsFineRecovery,recoverIslandFineWalk} from './m59-island-finewalk.mjs';
import {checkIslandCancellation,islandReadOwner} from './m59-island-observation.mjs';
export const BRAX_LEDGE={room:578,farmer:{x:2352,y:2208},courier:{x:2256,y:2208},cavern:{x:3168,y:1760},road:{x:224,y:2336}};
export function planLedgeRail(from,to,{role,geo=roomGeometry(578),coalesce=true}={}){
 const anchor=BRAX_LEDGE[role];if(!anchor||!regionContains(geo,anchor,from)||!regionContains(geo,anchor,to))throw Error('ledge endpoints outside role component');
 const edge=edgeOf(geo),both=(a,b)=>edge(a,b)&&edge(b,a),goal=protocolToClient(to);
 const plan=cutRail(protocolToClient(from),goal,{edge:both,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y),lattice:256});
 if(!plan.ok||!plan.bridgeOk)throw Error('no reversible ledge rail: '+plan.why);
 const last=plan.waypoints.at(-1);if(Math.hypot(last.x-goal.x,last.y-goal.y)>1){if(!both(last,goal))throw Error('ledge exact arrival bridge refused');plan.waypoints.push({...goal,f:floorAt(geo,goal.x,goal.y)});}
 const dense={kind:'walk',waypoints:plan.waypoints,sourceWaypoints:plan.waypoints};if(!coalesce)return dense;const short=coalesceCheckedRailLeg(geo,dense,{avoidSquares:new Set()});
 // Keep dense subsegments wherever a shortened chord cannot prove reversibility.
 const points=[short.waypoints[0]];let sourceIndex=0;
 for(let i=1;i<short.waypoints.length;i++){const target=short.waypoints[i],to=dense.waypoints.indexOf(target);if(to<sourceIndex)return dense;
  if(regionSegmentAllowed(geo,anchor,clientToProtocol(points.at(-1)),clientToProtocol(target)))points.push(target);
  else points.push(...dense.waypoints.slice(sourceIndex+1,to+1));sourceIndex=to;
 }
 return{...short,waypoints:points};
}
export async function runBraxLedgeLeg(ctx,{role,direction,observe=createRailObserver({fleet:ctx.fleet,agent:ctx.agent}),timeoutMs=480000}={}){
 ctx={...ctx,origin:ctx.origin??currentCallOrigin()};
 if(!['farmer','courier'].includes(role)||!['out','back'].includes(direction))throw Error('invalid Brax service leg');
 const end=Date.now()+timeoutMs,events=[],event=e=>{events.push({at:Date.now(),...e});ctx.log?.(ctx.agent,JSON.stringify(e));};
 const read=async()=>{if(Date.now()>end)throw Error('Brax service leg deadline');const s=await observe();if(!(s.hp?.value>0)||s.room.num===1)throw Error('service actor died');return s;};
 const cross=async to=>{const r=await queuedRoomExit(ctx,to,{observe,characters:[(await read()).character],timeoutMs:Math.min(180000,end-Date.now())});event({kind:'service-exit',to,reply:r});if(!r.arrived)throw Error('service exit failed');};
 const road=async to=>{const before=await read();if(before.room.num===to)return;const r=await ctx.call('travel',{agent:ctx.agent,to,max_hops:8,run_errands:false,avoid:[579,826,827,828,829,830,831,832,833]},Math.max(1,end-Date.now()));event({kind:'courier-road',to,reply:r});if((await read()).room.num!==to)throw Error('courier road did not reach '+to);};
 const fine=async to=>{
  const startedAt=Date.now();let denseFallback=false;for(let attempt=0;attempt<8&&Date.now()<end;attempt++){
   const s=await read();checkIslandCancellation(ctx,s);if(!islandReadOwner(ctx,s))throw Error('service rail owner changed');if(s.room.num!==578)throw Error('ledge rail requires578');
   if(activeOwnedFineRecovery(ctx,s)){if(!await recoverIslandFineWalk(ctx,{deadline:end,read:async()=>({l:await observe()}),since:startedAt,initial:s,active:true}))throw Error('service rail recovery incomplete');continue;}
   const leg=planLedgeRail(s.you,to,{role,coalesce:!denseFallback});let reply,error;
   try{reply=await observe.action('walk_rail',{room:578,leg,bodyDetour:!denseFallback,timeoutMs:Math.min(180000,end-Date.now()),origin:ctx.origin});}
   catch(e){if(e.message!=='rail action refused: rail_position_confirmation_timeout'&&e.message!=='rail action refused: movement_region: segment leaves returnable component'&&e.message!==`rail action refused: agent "${ctx.agent}" is not in game — call join first`)throw e;error=e;}
   event({kind:'service-rail',to,reply,error:error?.message});const actual=await read();checkIslandCancellation(ctx,actual);if(!islandReadOwner(ctx,actual))throw Error('service rail owner changed');
   if(actual.room.num===578&&Math.hypot(actual.you.x-to.x,actual.you.y-to.y)<=12&&regionContains(roomGeometry(578),BRAX_LEDGE[role],actual.you))return;
   if(error?.message==='rail action refused: movement_region: segment leaves returnable component'){if(!denseFallback&&actual.room.num===578&&regionContains(roomGeometry(578),BRAX_LEDGE[role],actual.you)&&!actual.job?.busy&&!actual.movement?.order){denseFallback=true;event({kind:'service-region-guard-dense-fallback',attempt,position:actual.you});continue;}throw Error('service boundary guard refused dense continuation');}
   if(ownsFineRecovery(ctx,actual,{since:startedAt,active:true})){if(await recoverIslandFineWalk(ctx,{deadline:end,read:async()=>({l:await observe()}),since:startedAt,initial:actual,active:true})){event({kind:'service-owned-recovery-complete',attempt});continue;}}
   if((error||reply?.operationEnded&&reply.reason==='position_confirmation_timeout')&&actual.room.num===578&&!actual.job?.busy&&!actual.movement?.order){event({kind:'service-known-ended-replan',attempt});continue;}
   throw Object.assign(Error('service stand not reached on correct component'),{reply,error:error?.message,actual:{room:actual.room,num:actual.room.num,hp:actual.hp,you:actual.you}});
  }throw Error('service rail deadline or bounded continuation budget');
 };
 let s=await read();
 if(role==='farmer'){
  if(direction==='out'){if(s.room.num===827)await cross(826);s=await read();if(s.room.num===826)await cross(578);await fine(BRAX_LEDGE.farmer);}
  else{if(s.room.num===578){await fine(BRAX_LEDGE.cavern);await cross(826);}if((await read()).room.num===826)await cross(827);if((await read()).room.num!==827)throw Error('upper runner did not return827');}
 }else{
  if(direction==='out'){if(![350,568,578].includes(s.room.num))await road(350);if((await read()).room.num===350)await road(568);if((await read()).room.num===568)await road(578);await fine(BRAX_LEDGE.courier);}
  else{if(s.room.num===578){await fine(BRAX_LEDGE.road);await road(568);}if((await read()).room.num===568)await road(350);if((await read()).room.num!==350)throw Error('lower courier did not return Jasper');}
 }
 const final=await read();return{ok:true,role,direction,room:final.room.num,position:final.you,hp:final.hp,events};
}
