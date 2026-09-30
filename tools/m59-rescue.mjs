// Inventory-dependent Rescue travel and renewable chalice maintenance.
// Player protocol only. Native charges/destinations are never read via admin here.
import {readFileSync} from 'node:fs';
import {findPath,AVOID_IN_TRANSIT,NEVER_ENTER} from './m59-map.mjs';
import {OF} from './m59-parse.mjs';
const terrain=JSON.parse(readFileSync(new URL('../substrate/m59-rescue-terrain.json',import.meta.url)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const state=new WeakMap();
const norm=x=>String(x??'').trim().toLowerCase();
export const isChalice=(c,item)=>norm(item?.name??c?.rsc?.get(item?.nameRsc))==='chalice of the rain';
const items=s=>s.client?.inventory??[];
function live(s){
  let v=state.get(s);
  if(!v||v.client!==s.client){v={client:s.client,charges:new Map(),pending:null,busy:false};state.set(s,v);}
  return v;
}
export function chargePossibilities(description){
  let band=null;
  if(/filled to the brim/i.test(description))band=4;
  else if(/mostly full/i.test(description))band=3;
  else if(/few sips/i.test(description))band=2;
  else if(/almost empty/i.test(description))band=1;
  else if(/completely empty/i.test(description))band=0;
  if(band===null)return [];
  const out=[];
  for(let capacity=3;capacity<=5;capacity++)for(let remaining=1;remaining<=capacity;remaining++){
    const pct=Math.floor(100*remaining/capacity),b=pct>90?4:pct>65?3:pct>30?2:pct>0?1:0;
    if(b===band)out.push({capacity,remaining});
  }
  return out;
}
export const expendable=possibilities=>possibilities.length>0&&possibilities.every(x=>x.remaining>=2);
export function rescueRegion(num){
  if(!Number.isInteger(num)||num<=0)return null;
  if(num>=1000&&num<1010)return 1000;
  if(num>=1010&&num<=1018)return 1010;
  if(num>=2000&&num<=2499)return 2000;
  if(num>=2500&&num<=2599)return 2500;
  if(num>=825&&num<=833)return 825;
  return 1;
}
export function predictedRescueRoom(from,{guildHall=null,homeRoom=null}={}){
  if(from===1||from===43)return null;
  if(guildHall&&guildHall!==from&&rescueRegion(guildHall)===rescueRegion(from))return guildHall;
  if(rescueRegion(from)===2000||from===2510)return 2001;
  if(rescueRegion(from)===2500)return 2510;
  return homeRoom;
}
export async function inspectChalice(s,item,{fresh=false}={}){
  const v=live(s),old=v.charges.get(item.id);
  if(!fresh&&old&&Date.now()-old.at<5000)return old;
  const c=s.need(),since=c.evSeq;
  await s.pacer.submit('look',()=>c.look(item.id));
  const read=await c.waitFor({since,kinds:['look'],timeoutMs:2000});
  const description=read.events.find(e=>e.id===item.id)?.description??'';
  let possibilities=chargePossibilities(description);
  // The description cannot establish a higher count after our own accepted use.
  if(old?.spent&&possibilities.length){
    const narrowed=possibilities.filter(p=>old.possibilities.some(o=>o.capacity===p.capacity&&o.remaining===p.remaining));
    if(narrowed.length)possibilities=narrowed;
  }
  const result={item_id:item.id,description,possibilities,usable:expendable(possibilities),spent:!!old?.spent,at:Date.now()};
  v.charges.set(item.id,result);return result;
}
export async function rescueCapability(s){
  const v=live(s),c=s.need();
  if(v.pending)return {available:false,reason:'rescue pending or its outcome is uncertain',pending:v.pending};
  if(s.combat?.active)return {available:false,reason:'combat owns this body'};
  for(const item of items(s).filter(i=>isChalice(c,i))){
    const charge=await inspectChalice(s,item);
    if(charge.usable){
      if(s.chaliceErrand?.item_id===item.id)s.chaliceErrand=null;
      return {available:true,kind:'chalice',item_id:item.id,charge,delay_max_ms:25000};
    }
    s.chaliceErrand={kind:'recharge_chalice',state:'pending',item_id:item.id,
      reason:'one charge or an uncertain reserve',at:s.chaliceErrand?.at??Date.now()};
  }
  const spell=(c.spells??[]).find(sp=>norm(c.rsc.get(sp.nameRsc))==='rescue');
  const emeralds=items(s).filter(i=>/^emeralds?$/.test(norm(i.name??c.rsc.get(i.nameRsc))))
    .reduce((n,i)=>n+(i.amount||1),0);
  if(spell&&emeralds>=1&&(c.vitals?.().mana?.value??0)>=16
      &&(c.stat?.('karma')?.value??30)>=30)
    return {available:true,kind:'spell',spell_id:spell.id,emeralds,delay_max_ms:25000};
  return {available:false,reason:'no expendable chalice or affordable learned Rescue'};
}
export function chooseRescueRoute({from,to,landing,walking,tail,capability,blocked=[],confine=[]}){
  if(!capability?.available||!landing||landing===from||blocked.includes(landing)||NEVER_ENTER.has(landing))return null;
  if(confine.length&&!confine.includes(landing))return null;
  if(to!==landing&&!tail?.found)return null;
  const walkMs=walking?.found?(walking.hops?.length??0)*20000:Infinity;
  const estimate=capability.delay_max_ms+(to===landing?0:tail.hops.length*20000);
  if(estimate>=walkMs)return null;
  return {kind:'rescue',from,to:landing,destination:to,estimated_ms:estimate,
    estimate_basis:'25-second Rescue bound plus 20 seconds per remaining room; heuristic',
    capability,remaining_hops:to===landing?[]:tail.hops};
}
export async function performRescue(s,capability,{destination=null,stopped=()=>false,timeoutMs=35000,onEvent=()=>{}}={}){
  const v=live(s),c=s.need(),origin=s.world?.room?.num;
  if(v.busy||v.pending)return {arrived:false,refused:true,reason:'rescue already pending'};
  if(stopped())return {arrived:false,cancelled:true};
  v.busy=true;
  try{
    if(capability.kind==='chalice'){
      const item=items(s).find(i=>i.id===capability.item_id&&isChalice(c,i));
      if(!item)return {arrived:false,refused:true,reason:'chalice no longer held'};
      const charge=await inspectChalice(s,item,{fresh:true});
      if(!charge.usable)return {arrived:false,refused:true,reason:'preserving final charge or uncertain reserve'};
    }else if(capability.kind!=='spell')return {arrived:false,refused:true,reason:'unknown rescue method'};
    const since=c.evSeq;
    const guard=()=>{if(stopped()||s.client!==c||s.combat?.active)throw Error('rescue preempted');};
    await s.pacer.submit('rest',()=>{guard();c.stand();});
    v.pending={from:origin,destination,started_at:Date.now(),kind:capability.kind,status:'awaiting-confirmation'};
    await s.pacer.submit(capability.kind==='chalice'?'use':'cast',()=>{
      guard();
      if(capability.kind==='chalice'){
        const old=v.charges.get(capability.item_id);
        v.charges.set(capability.item_id,{...old,spent:true,at:0,
          possibilities:old.possibilities.map(p=>({...p,remaining:p.remaining-1}))});
        c.use(capability.item_id);
        if(!expendable(v.charges.get(capability.item_id).possibilities))
          s.chaliceErrand={kind:'recharge_chalice',state:'pending',item_id:capability.item_id,
            reason:'reserve reached after use',at:Date.now()};
      }else c.cast(capability.spell_id,[]);
    });
    onEvent('rescue_sent',{method:capability.kind,origin,destination});
    const until=Date.now()+timeoutMs;
    while(Date.now()<until){
      if(stopped()||s.client!==c||!s.live||s.world?.room?.num===1)
        return {arrived:false,cancelled:true,reason:'rescue interrupted; do not spend another charge'};
      const events=(c.events??[]).filter(e=>e.seq>since&&e.kind==='message');
      const text=events.map(e=>e.text).join('\n');
      if(/feel a holy force rescue you/i.test(text)){
        const room=s.world?.room?.num;
        if(room===origin){await sleep(100);continue;}
        v.pending=null;
        return {arrived:destination==null||room===destination,landed_in:room,via:'rescue',
          elapsed_ms:Date.now()-until+timeoutMs,method:capability.kind};
      }
      if(/Only those who have walked|cannot rescue|already being rescued|unsuccessful in casting|not enough.*mana|do not have.*reagent|cannot cast|can't cast/i.test(text)){
        // Already-pending replies do not prove that the old timer is gone.
        if(!/already being rescued/i.test(text))v.pending=null;
        return {arrived:false,refused:true,...(/already being rescued/i.test(text)?{pending:true}:{}),reason:text.slice(-500)};
      }
      await sleep(100);
    }
    v.pending.status='uncertain';return {arrived:false,pending:true,reason:'Rescue did not confirm; no automatic recast'};
  }finally{v.busy=false;}
}
export function rechargeRoom(num){return terrain.rooms[num]??null;}
export function rechargeDetour(map,from,to,{maxExtraHops=2,blocked=[],confine=[],avoid=[]}={}){
  const options={avoid:new Set([...AVOID_IN_TRANSIT,...avoid])};
  const direct=findPath(map,from,to,options);if(!direct.found)return null;
  const banned=new Set(blocked);
  let best=null;
  for(const key of Object.keys(terrain.rooms)){
    const num=Number(key);if(banned.has(num)||NEVER_ENTER.has(num)||(confine.length&&!confine.includes(num)))continue;
    const a=findPath(map,from,num,options),b=findPath(map,num,to,options);
    if(!a.found||!b.found)continue;
    if(confine.length&&[...a.hops,...b.hops].some(h=>!confine.includes(Number(h.to))))continue;
    const extra=a.hops.length+b.hops.length-direct.hops.length;
    if(extra>maxExtraHops)continue;
    if(!best||extra<best.extra_hops||(extra===best.extra_hops&&a.hops.length<best.distance))
      best={room:num,extra_hops:extra,distance:a.hops.length};
  }
  return best;
}
export async function rechargeChalice(s,{stopped=()=>false}={}){
  const v=live(s),c=s.need(),room=s.world?.room?.num,item=items(s).find(i=>isChalice(c,i));
  if(!item||!rechargeRoom(room)||v.pending||v.busy)return {ok:false,reason:'no available refill operation'};
  const charge=await inspectChalice(s,item,{fresh:true});
  if(charge.usable)return {ok:true,needed:false};
  const me=c.self;
  if(!Number.isFinite(me?.row)||!Number.isFinite(me?.col))
    return {ok:false,reason:'refill deferred until the player position is known'};
  const crowded=[...(c.room?.objects?.values()??[])].some(o=>o.id!==c.selfId&&(o.flags&(OF.PLAYER|OF.ATTACKABLE))
    &&Math.max(Math.abs(o.row-me.row),Math.abs(o.col-me.col))<=6);
  if(crowded||s.combat?.active||stopped())return {ok:false,reason:'refill deferred while threatened or crowded'};
  v.busy=true;let dropped=false;
  const guard=()=>{if(stopped()||s.combat?.active||s.client!==c||s.world?.room?.num!==room)throw Error('refill preempted');};
  try{
    const since=c.evSeq;
    await s.pacer.submit('drop',()=>{guard();c.drop(item.id);dropped=true;});
    await c.waitFor({since,kinds:['inventory-remove','message','create'],timeoutMs:600});
    // Always attempt retrieval after a drop, even when the external order is cancelled.
    if(s.client!==c||s.world?.room?.num!==room)return {ok:false,dropped:true,reason:'room/client changed before pickup'};
    await s.pacer.submit('get',()=>c.get(item.id));
    await sleep(150);
    await s.pacer.submit('read',()=>c.requestInventory());
    await c.waitFor({kinds:['inventory'],timeoutMs:700});
    const held=items(s).find(i=>i.id===item.id&&isChalice(c,i));
    if(!held){
      s.chaliceErrand={kind:'recharge_chalice',state:'pickup_unconfirmed',item_id:item.id,room,at:Date.now()};
      return {ok:false,dropped:true,reason:'pickup not confirmed; recover this item before moving',item_id:item.id};
    }
    dropped=false;
    v.charges.delete(item.id);
    const after=await inspectChalice(s,held,{fresh:true});
    const ok=/filled to the brim/i.test(after.description)&&after.usable;
    if(ok)s.chaliceErrand=null;
    return {ok,item_id:item.id,room,description:after.description};
  }finally{
    if(dropped){
      s.chaliceErrand={kind:'recharge_chalice',state:'pickup_unconfirmed',item_id:item.id,room,at:Date.now()};
      if(s.client===c&&s.world?.room?.num===room)await s.pacer.submit('get',()=>c.get(item.id)).catch(()=>{});
    }
    v.busy=false;
  }
}
export async function travelRescueOption(s,to,{stopped=()=>false,allowRescue=true,allowRecharge=true,onEvent=()=>{}}={}){
  if(!allowRescue&&!allowRecharge)return null;
  const c=s.need(),context=s.rescueContext??{},from=s.world?.room?.num;
  if(s.chaliceErrand?.state==='pickup_unconfirmed'){
    if(items(s).some(i=>i.id===s.chaliceErrand.item_id))s.chaliceErrand={...s.chaliceErrand,state:'pending'};
    else return {kind:'blocked',reason:'chalice pickup is unconfirmed; movement held for recovery',errand:s.chaliceErrand};
  }
  const chalice=items(s).some(i=>isChalice(c,i));
  if(!chalice&&!(context.enabled&&(c.spells??[]).some(sp=>norm(c.rsc.get(sp.nameRsc))==='rescue')))return null;
  let cap=await rescueCapability(s);
  if(s.chaliceErrand&&allowRecharge&&context.recharge!==false){
    if(rechargeRoom(from)){
      const r=await rechargeChalice(s,{stopped});onEvent('chalice_recharge',r);
      if(r.dropped)return {kind:'blocked',reason:r.reason,errand:s.chaliceErrand};
      if(r.ok)cap=await rescueCapability(s);
    }else{
      const detour=rechargeDetour(s.world.map,from,to,{blocked:context.blocked??[],
        confine:context.confine??[],avoid:[...(s.barredRooms??[])]});
      s.chaliceErrand={...s.chaliceErrand,destination:detour?.room??null};
      if(detour&&detour.room!==from)return {kind:'recharge',...detour};
    }
  }
  if(!allowRescue||context.enabled===false||!cap.available)return null;
  // A configured hall is an operator assertion, cross-checked against live guild
  // membership. Arrival still verifies the actual server-selected destination.
  let guildHall=null;
  if(context.guildHall&&context.guildName){
    if(!c.guild||Date.now()-(c.guild.readAt??0)>60000){
      const since=c.evSeq;await s.pacer.submit('read',()=>c.requestGuildInfo());
      await c.waitFor({since,kinds:['guild'],timeoutMs:1000});
    }
    if(norm(c.guild?.name)===norm(context.guildName))guildHall=Number(context.guildHall);
  }
  const landing=predictedRescueRoom(from,{guildHall,homeRoom:context.homeRoom});
  if(!landing)return null;
  const walking=s.world.route(to),tail=landing===to?null:findPath(s.world.map,landing,to,
    {avoid:new Set([...AVOID_IN_TRANSIT,...(s.barredRooms??[])])});
  if(context.confine?.length&&tail?.hops?.some(h=>!context.confine.includes(Number(h.to))))return null;
  return chooseRescueRoute({from,to,landing,walking,tail,capability:cap,
    blocked:[...(context.blocked??[]),...(s.barredRooms??[])],confine:context.confine??[]});
}
