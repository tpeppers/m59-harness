// Ordinary declared jumps with a positive landing and a proved missed-jump
// escape. Callers supply their guarded reader/walker, so this works for any map.
import {clientToProtocol,protocolToClient} from './m59-finepos.mjs';
import {planDeclaredTakeoff} from './m59-jump-takeoff.mjs';
const queues=new Map();
const reachGutter=(gutter,walk,observed)=>typeof gutter==='function'?gutter(observed):walk(gutter);
// A long staging walk may begin below the takeoff shelf. Arm its floor fence
// only after reaching that shelf, then hand any later lower pose to the gutter.
export async function followDeclaredApproach(declaration,{geo,read,walk,target,gutter,requireShelf=false}={}){
 if(!declaration?.from_fine||!geo||!read||!walk||!target||!gutter)throw Error('declared_approach_incomplete');
 const q=declaration.from_fine,minimum=geo.floorBaseAtClient(q.x,q.y)-384;
 if(!Number.isFinite(minimum))throw Error('declared_approach_floor_unreadable');
 let armed=requireShelf;
 const height=observed=>{const p=protocolToClient(observed.you);return geo.floorBaseAtClient(p.x,p.y);};
 const validatePosition=observed=>{
  if(observed.room?.num!==declaration.room)throw Error('declared_crossing_room_changed');
  const floor=height(observed);if(!Number.isFinite(floor))throw Error('declared_approach_floor_unreadable');
  if(floor>=minimum)armed=true;
  else if(armed)throw Object.assign(Error('declared_crossing_approach_dropped'),{code:'declared_crossing_approach_dropped'});
 };
 try{
  validatePosition(await read());await walk(target,{validatePosition});validatePosition(await read());
  return {gutter:false};
 }catch(error){
  if(error?.code!=='declared_crossing_approach_dropped')throw error;
  const observed=await read();
  if(observed.room?.num!==declaration.room||!(height(observed)<minimum))throw error;
  await reachGutter(gutter,walk,observed);return {crossed:false,gutter:true,why:'approach_dropped'};
 }
}
export async function followDeclaredCrossing(ctx,declaration,{geo,read,walk,gutter,clear,stage,budgetMs=180000,
 refineTakeoff=false,approachPoint=null,walkTakeoff=walk,recover=null,observeLanding=null,waitAtCover=null}={}){
 if(!declaration?.from_fine||!declaration?.to_fine||!geo||!read||!walk||!gutter)throw Error('declared_crossing_incomplete');
 const began=Date.now(),takeoff=clientToProtocol(declaration.from_fine),landing=clientToProtocol(declaration.to_fine);
 const floor=p=>{const q=protocolToClient(p);return geo.floorBaseAtClient(q.x,q.y);};
 const fromFloor=floor(takeoff),toFloor=floor(landing);
 if(!Number.isFinite(fromFloor)||!Number.isFinite(toFloor))throw Error('declared_crossing_floor_unavailable');
 const key=ctx.fleet+':'+declaration.room+':'+declaration.from.row+','+declaration.from.col;
 const prior=queues.get(key)??Promise.resolve();let release;
 const tail=new Promise(r=>{release=r;});queues.set(key,tail);
 const restage=async()=>{if(waitAtCover)await waitAtCover();else if(stage)await walk(stage);};
 const planFrom=observed=>{
  const started=performance.now(),planned=planDeclaredTakeoff(geo,observed.you,declaration,
   {objects:new Map((observed.objects??[]).map(o=>[o.id,o])),selfId:observed.you.id,maxMs:350});
  const remaining=500-(performance.now()-started),terrain=planned.found?{found:true}:remaining>0?
   planDeclaredTakeoff(geo,observed.you,declaration,{maxMs:remaining}):{found:false,reason:'takeoff_search_budget'};
  return {planned,terrain};
 };
 try{
  let ready=false;prior.then(()=>{ready=true;});
  while(!ready){await read();if(Date.now()-began>budgetMs)throw Error('declared_crossing_queue_budget');await new Promise(r=>setTimeout(r,500));}
  let lastRefusal='landing not observed',attempts=0;
  while(attempts<3){
   if(Date.now()-began>=budgetMs)throw Error('declared_crossing_budget');
   let before=await read();
   if(before.room?.num!==declaration.room)throw Error('declared_crossing_room_changed');
   // A lower floor is the escape case, even before the first attempt. The same
   // square number on another shelf must never authorize a jump retry.
   if(floor(before.you)<fromFloor-384){await reachGutter(gutter,walk,before);return {crossed:false,gutter:true,why:'below_takeoff'};}
   const since=Date.now();
   if(before.hp?.value<before.hp?.max){
    if(recover&&await recover({since,initial:before}))continue;
    if(!stage&&!waitAtCover)throw Error('declared_crossing_needs_recovery');
    await restage();await new Promise(r=>setTimeout(r,500));continue;
   }
   let target=takeoff;
   if(refineTakeoff){
    const {planned,terrain}=planFrom(before);
    if(!planned.found){
     // A recovery can finish within inches of a usable takeoff. Keep its
     // direct proof; the older approach is only needed when geometry alone
     // cannot reach a takeoff from this actual pose.
     if(!terrain.found&&approachPoint&&Math.hypot(before.you.x-approachPoint.x,before.you.y-approachPoint.y)>8){
      const prepared=await followDeclaredApproach(declaration,{geo,read,walk,target:approachPoint,gutter,requireShelf:true});
      if(prepared.gutter)return prepared;
      continue;
     }
     ctx.state??={};ctx.state.declaredCrossingFailure={phase:'takeoff_plan',room:declaration.room,
      observed:before.you,reason:planned.reason,terrain_proved:terrain.found===true,
      traffic_blocked:terrain.found===true&&planned.reason==='no_proved_nearby_takeoff'};
     if(!terrain.found||(!stage&&!waitAtCover))throw Error('declared_takeoff_'+planned.reason);
     // A body refusal spends the journey budget at cover. It does not consume
     // flight attempts, license another landing, or leave the corridor occupied.
     await restage();await new Promise(r=>setTimeout(r,500));continue;
    }
    target=planned.takeoff;
   }else if(approachPoint){
    const prepared=await followDeclaredApproach(declaration,{geo,read,walk,target:approachPoint,gutter,requireShelf:true});
    if(prepared.gutter)return prepared;
   }
   let approach;
   try{approach=await followDeclaredApproach(declaration,{geo,read,
    walk:(point,guard)=>point===target?walkTakeoff(point,guard):walk(point,guard),target,gutter,requireShelf:true});}
   catch(error){
    if(recover&&await recover({since,initial:await read()}))continue;
    if(error?.code==='declared_crossing_traffic_blocked'&&(stage||waitAtCover)){await restage();await new Promise(r=>setTimeout(r,500));continue;}
    throw error;
   }
   if(approach.gutter)return approach;
   before=await read();
   if(floor(before.you)<fromFloor-384){await reachGutter(gutter,walk,before);return {crossed:false,gutter:true,why:'approach_dropped'};}
   if(Math.hypot(before.you.x-target.x,before.you.y-target.y)>8||Math.abs(floor(before.you)-fromFloor)>64)throw Error('declared_crossing_takeoff_unconfirmed');
   if(before.hp?.value<before.hp?.max){
    if(recover&&await recover({since,initial:before}))continue;
    if(!stage&&!waitAtCover)throw Error('declared_crossing_needs_recovery');await restage();continue;
   }
   let reply;
   attempts++;
   try{reply=await ctx.call('jump',{agent:ctx.agent,to_row:declaration.to.row,to_col:declaration.to.col});}
   catch(error){
    if(recover&&await recover({since,initial:await read()}))continue;
    throw error;
   }
   lastRefusal=reply.reason??reply.error??'landing not observed';
   const after=await (observeLanding?observeLanding(landing):read()),height=floor(after.you);
   if(after.room?.num!==declaration.room)throw Error('declared_crossing_room_changed');
   if(!Number.isFinite(height))throw Error('declared_crossing_landing_floor_unreadable');
   if(Math.hypot(after.you.x-landing.x,after.you.y-landing.y)<=8&&Math.abs(height-toFloor)<=64){
    if(clear)await walk(clear);return {crossed:true,reply};
   }
   if(Number.isFinite(height)&&height<fromFloor-384){await reachGutter(gutter,walk,after);return {crossed:false,gutter:true,reply};}
   ctx.state??={};ctx.state.declaredCrossingFailure={phase:'landing',room:declaration.room,
    observed:after.you,reply};
   if(recover&&await recover({since,initial:after}))continue;
   if(Math.abs(height-fromFloor)>64||Math.hypot(after.you.x-target.x,after.you.y-target.y)>64)throw Error('declared_crossing_unclassified_landing');
   await restage();await new Promise(r=>setTimeout(r,500));
  }
  throw Error('declared_crossing_attempts_exhausted: '+lastRefusal);
 }finally{prior.then(release);if(queues.get(key)===tail)tail.then(()=>{if(queues.get(key)===tail)queues.delete(key);});}
}
