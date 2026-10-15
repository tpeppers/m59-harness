// Ordinary declared jumps with a positive landing and a proved missed-jump
// escape. Callers supply their guarded reader/walker, so this works for any map.
import {clientToProtocol,protocolToClient} from './m59-finepos.mjs';
const queues=new Map();
export async function followDeclaredCrossing(ctx,declaration,{geo,read,walk,gutter,clear,stage,budgetMs=180000}={}){
 if(!declaration?.from_fine||!declaration?.to_fine||!geo||!read||!walk||!gutter)throw Error('declared_crossing_incomplete');
 const key=ctx.fleet+':'+declaration.room+':'+declaration.from.row+','+declaration.from.col;
 const prior=queues.get(key)??Promise.resolve();let release;
 const tail=new Promise(r=>{release=r;});queues.set(key,tail);
 const began=Date.now(),takeoff=clientToProtocol(declaration.from_fine),landing=clientToProtocol(declaration.to_fine);
 const floor=p=>{const q=protocolToClient(p);return geo.floorBaseAtClient(q.x,q.y);};
 const fromFloor=floor(takeoff),toFloor=floor(landing);
 try{
  let ready=false;prior.then(()=>{ready=true;});
  while(!ready){await read();if(Date.now()-began>budgetMs)throw Error('declared_crossing_queue_budget');await new Promise(r=>setTimeout(r,500));}
  let lastRefusal='landing not observed';
  for(let attempt=0;attempt<3;attempt++){
   let before=await read();
   if(before.room?.num!==declaration.room)throw Error('declared_crossing_room_changed');
   // A lower floor is the escape case, even before the first attempt. The same
   // square number on another shelf must never authorize a jump retry.
   if(floor(before.you)<fromFloor-384){await walk(gutter);return {crossed:false,gutter:true,why:'below_takeoff'};}
   const validatePosition=observed=>{
    if(observed.room?.num===declaration.room&&floor(observed.you)<fromFloor-384)
     throw Object.assign(Error('declared_crossing_approach_dropped'),{code:'declared_crossing_approach_dropped'});
   };
   try{await walk(takeoff,{validatePosition});}
   catch(error){
    if(error.code!=='declared_crossing_approach_dropped')throw error;
    const observed=await read();
    if(observed.room?.num!==declaration.room||!(floor(observed.you)<fromFloor-384))throw error;
    await walk(gutter);return {crossed:false,gutter:true,why:'approach_dropped'};
   }
   before=await read();
   if(floor(before.you)<fromFloor-384){await walk(gutter);return {crossed:false,gutter:true,why:'approach_dropped'};}
   if(Math.hypot(before.you.x-takeoff.x,before.you.y-takeoff.y)>8||Math.abs(floor(before.you)-fromFloor)>64)throw Error('declared_crossing_takeoff_unconfirmed');
   if(before.hp?.value<before.hp?.max){if(!stage)throw Error('declared_crossing_needs_recovery');await walk(stage);continue;}
   const reply=await ctx.call('jump',{agent:ctx.agent,to_row:declaration.to.row,to_col:declaration.to.col});
   lastRefusal=reply.reason??'landing not observed';
   const after=await read(),height=floor(after.you);
   if(after.room?.num!==declaration.room)throw Error('declared_crossing_room_changed');
   if(Math.hypot(after.you.x-landing.x,after.you.y-landing.y)<=8&&Math.abs(height-toFloor)<=64){
    if(clear)await walk(clear);return {crossed:true,reply};
   }
   if(Number.isFinite(height)&&height<fromFloor-384){await walk(gutter);return {crossed:false,gutter:true,reply};}
   if(Math.abs(height-fromFloor)>64||Math.hypot(after.you.x-takeoff.x,after.you.y-takeoff.y)>64)throw Error('declared_crossing_unclassified_landing');
   if(stage)await walk(stage);await new Promise(r=>setTimeout(r,500));
  }
  throw Error('declared_crossing_attempts_exhausted: '+lastRefusal);
 }finally{prior.then(release);if(queues.get(key)===tail)tail.then(()=>{if(queues.get(key)===tail)queues.delete(key);});}
}
