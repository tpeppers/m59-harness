// One controlled provision drop, with durable no-replay evidence and ground confirmation.
import{mkdirSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,unlinkSync}from'node:fs';import{join}from'node:path';import{fileURLToPath}from'node:url';import{randomUUID,createHash}from'node:crypto';
import{liveMoveOrder}from'./m59-move-origin.mjs';
import{exactDrop,executeExactDrop}from'./m59-inventory-drop.mjs';import{isActiveRecoveryDecision}from'./m59-survival-decision.mjs';import{islandReadOwner,checkIslandCancellation}from'./m59-island-observation.mjs';
const defaultDirectory=fileURLToPath(new URL('../substrate/delivery-cache-intents/',import.meta.url));
const provision=name=>/^(hammer|herbs?|elderberry|loaf of bread)$/.test(name),count=i=>i.amount>0?i.amount:1;
const total=(items,name)=>items.filter(i=>i.name===name).reduce((n,i)=>n+count(i),0);
// Rechecked at the native paced packet, on the socket's actual client.
export async function executeDeliveryCacheDrop(session,ap,args,{execute=executeExactDrop,now=Date.now}={}){
 const first=session.client;
 const authority=()=>{
  const c=session.client,st=ap?.status?.(),owner=args.origin?.source==='fleetscript'?'fleetscript:'+args.origin.name:null;
  if(!owner||c!==first||!session.live||c?.state!=='game'||session.world?.room?.num!==827||args.room!==827||!st||['work','economy','movement'].some(k=>st.faculties?.[k]?.owner!==owner||!(st.faculties[k].expires_in_ms>0))||session.job&&!session.job.done||liveMoveOrder(session)||session.keeperRecoveryTravel||st.cast_rite?.active||isActiveRecoveryDecision(st.survival_decisions?.current)||!(c.vitals?.()?.health?.value/c.vitals?.()?.health?.max>=.9)||c.self?.row!==args.row||c.self?.col!==args.col)throw Error('delivery drop body or authority changed');
  if(c.idsAsOf?.()?.last_save_at!==args.last_save_at)throw Error('delivery drop save generation changed');
  return c;
 };
 const beforeDrop=c=>{const st=ap.status();
  const item=c.inventory?.find(i=>i.id===args.item),name=item&&c.rsc.get(item.nameRsc),eq=c.equipment?.();
  const protectedNames=[...(st.policy?.protectedItems??[]),...(st.policy?.vaultItems??[])].map(x=>String(x).toLowerCase());
  const floor=Number(Object.entries(st.loadout_retention?.carry_floors??{}).find(([key])=>key.toLowerCase().replace(/^herbs$/,'herb')===String(name).toLowerCase().replace(/^herbs$/,'herb'))?.[1]??0),minimum=Math.max(floor,name==='hammer'?1:name==='loaf of bread'?6:0);
  if(!provision(name)||!eq?.known||eq.equipped.some(i=>i.id===args.item)||protectedNames.some(n=>n&&name.toLowerCase().includes(n))||!Number.isSafeInteger(args.retain)||args.retain<minimum||c.inventory.filter(i=>c.rsc.get(i.nameRsc)===name).reduce((n,i)=>n+count(i),0)-args.amount<args.retain)throw Error('delivery drop would consume personal kit');
  exactDrop(c,args,{now:now()});
 };
 try{beforeDrop(authority());}catch(e){return{requested:false,reason:e.message,submission:{attempted:false}};}return execute(session,args,{authority,now,beforeDrop});
}
export async function cacheDeliveryCargo(ctx,{items=[],recipients=[],read,drop,notify,directory=defaultDirectory,now=Date.now}={}){
 if(items.length>16||recipients.length>25||typeof read!=='function'||typeof drop!=='function'||typeof notify!=='function')throw Error('bounded delivery-cache dependencies required');
 const initial=await read(),caches=[];const guard=s=>{checkIslandCancellation(ctx,s);if(s.delivery_cache!==1||!islandReadOwner(ctx,s)||s.pid!==initial.pid||s.character!==initial.character||s.in_game!==true||s.connected!==true||s.room?.num!==827||!(s.hp?.value/s.hp?.max>=.9)||s.job?.busy||s.movement?.order||s.autopilot_status?.cast_rite?.active||isActiveRecoveryDecision(s.autopilot_status?.survival_decisions?.current))throw Error('delivery cache body not ready');};
 try{guard(initial);}catch(e){return{ok:true,deferred:true,reason:e.message,caches};}
 mkdirSync(directory,{recursive:true});
 const lock=join(directory,createHash('sha256').update(JSON.stringify([ctx.fleet,ctx.agent])).digest('hex')+'.lock');let fd;try{fd=openSync(lock,'wx');}catch(e){if(e.code==='EEXIST')return{ok:true,deferred:true,reason:'another delivery-cache intent owns this actor',caches};throw e;}
 try{writeFileSync(fd,JSON.stringify({pid:process.pid,agent:ctx.agent,at:now()}));
 for(const wanted of items){
  let s=await read();try{guard(s);}catch(e){return{ok:true,deferred:true,reason:e.message,caches};}
  if(!provision(wanted.name))continue;
  const stem=createHash('sha256').update(JSON.stringify([ctx.fleet,ctx.agent,wanted.name])).digest('hex'),file=join(directory,stem+'.json');let prior;try{prior=JSON.parse(readFileSync(file,'utf8'));}catch{}
  if(prior?.status==='pending'||prior?.status==='uncertain')return{ok:true,uncertain:true,reason:'unreconciled prior drop intent',caches};
  const p=await ctx.call('inventory',{agent:ctx.agent,fresh:true}),item=p.items?.find(i=>i.id===wanted.id&&i.name===wanted.name);if(!item)continue;
  if(!Number.isSafeInteger(wanted.amount)||wanted.amount<=0||!Number.isSafeInteger(wanted.retain)||wanted.retain<0||total(p.items,item.name)-wanted.amount<wanted.retain)throw Error('delivery cache exceeds confirmed surplus');
  const id=randomUUID(),args={item:item.id,expected_item_name:item.name,expected_amount:count(item),amount:wanted.amount,retain:wanted.retain,room:827,row:s.you.row,col:s.you.col,player_id:s.you.id,last_save_at:s.ids_as_of&&Object.hasOwn(s.ids_as_of,'last_save_at')?s.ids_as_of.last_save_at:(s.last_save_at??null),deadline_at:now()+6000,control_token:id,origin:ctx.origin};
  const beforeGround=new Map((s.objects??[]).filter(o=>o.name===item.name&&(o.flags&16)&&o.row===s.you.row&&o.col===s.you.col).map(o=>[o.id,count(o)]));
  const intent={id,status:'pending',agent:ctx.agent,item:item.name,quantity:wanted.amount,at:now(),args};const save=()=>{const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(intent));renameSync(tmp,file);};save();
  let reply;try{reply=await drop(args);}catch(e){intent.status='uncertain';intent.error=e.message;save();return{ok:true,uncertain:true,caches,reason:'drop transport or packet outcome unconfirmed'};}
  if(reply?.requested===false){intent.status='unsubmitted';save();continue;}
  await ctx.call('look',{agent:ctx.agent});s=await read();const after=await ctx.call('inventory',{agent:ctx.agent,fresh:true});
  let valid=true;try{guard(s);}catch{valid=false;}
  const ground=(s.objects??[]).find(o=>o.name===item.name&&(o.flags&16)&&o.row===args.row&&o.col===args.col&&count(o)-(beforeGround.get(o.id)??0)>=wanted.amount);
  if(reply?.requested!==true||reply.confirmed!==true||!valid||!ground||total(p.items,item.name)-total(after.items??[],item.name)!==wanted.amount){intent.status='uncertain';save();return{ok:true,uncertain:true,caches,reason:'drop needs giver and new ground quantity proof'};}
  const cache={id,item:item.name,quantity:wanted.amount,ground_id:ground.id,room:827,row:args.row,col:args.col};intent.status='confirmed';intent.cache=cache;save();const notices=[];
  for(const target of recipients){const key=/^herbs?$/.test(item.name)?'herb':item.name;if(!(target.items?.[key]>0))continue;try{notices.push(await notify({...cache,action:'publish',agent:target.agent,from:ctx.agent}));}catch(e){notices.push({stored:false,error:e.message});}}
  caches.push({...cache,notices,pickupRequired:false});
 }
 return{ok:true,caches};
 }finally{closeSync(fd);unlinkSync(lock);}
}

// Explicit opt-in for the authorized Brax service; owns only the runner for a bounded drop-off.
export async function publicBraxDeliveryCache(p){
 const[{runNamed},{fleetScript},{script}]=await Promise.all([import('./m59-fleetlib.mjs'),import('./m59-fleetscript.mjs'),import('./fleetscripts/brax-cache-delivery.mjs')]);
 const result=await runNamed(script.name,{agents:[p.agent],items:p.items,recipients:p.recipients},{scripts:new Map([[script.name,{...script,source:'public',file:'tools/fleetscripts/brax-cache-delivery.mjs'}]]),fleetScript});
 const native=result.results?.[p.agent]?.state?.deliveryCache;if(native)return native;if(!result.ok) return{ok:true,deferred:true,reason:'public cache body was unavailable'};throw Error('public cache result absent');
}
