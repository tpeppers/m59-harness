// Two completed Rescue landings, followed by a compulsory guarded jungle refill.
// This module uses ordinary broker tools only; there are no lab or DM imports.
import {readFileSync,mkdirSync,writeFileSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {itemClassIndex,KODDB} from './m59-itemclass.mjs';
import {ordinaryHop,pause,location} from './m59-island-route.mjs';
import {processStartedAt,START_TIME_TOLERANCE_MS} from './runtime/process-identity.mjs';
export const FULL_CUP=/filled to the brim with pure water/i;
export function cupIsFull(description){return FULL_CUP.test(String(description??''));}
const norm=s=>String(s??'').trim().toLowerCase();
const LIMITS={weapon:2,armor:1,helmet:1,gauntlet:1,shield:1};
export function guardCategory(chain,alcohol=false){
  const c=new Set(chain.map(norm)),has=n=>c.has(norm(n));
  if(has('NeruditeOreChunk')||alcohol)return 'forbidden';
  if(has('Weapon')&&!has('BlackDagger'))return 'weapon';
  if(has('Gauntlet'))return 'gauntlet';
  if(has('Shield')&&!has('Torch'))return 'shield';
  if(has('Armor')&&!has('Robe')&&!has('LightRobe'))return 'armor';
  if(has('Helmet')&&!has('Circlet')&&!has('IvyCirclet'))return 'helmet';
  return null;
}
export function jungleStashPlan(items,{equipped=[],classify}={}){
  const worn=new Set(equipped.map(x=>norm(x.name??x))),counts={},drop=[],keep=[];
  const wornIds=new Set(equipped.filter(x=>x.id>0).map(x=>x.id));
  const isWorn=i=>wornIds.size?wornIds.has(i.id):worn.has(norm(i.name));
  // Retain worn protection before spare equipment.
  const rows=[...items].sort((a,b)=>Number(isWorn(b))-Number(isWorn(a)));
  for(const item of rows){
    const category=classify(item);
    if(category==='forbidden'||category==='unknown'||category&&((counts[category]??0)>=LIMITS[category]))drop.push({...item,category,was_equipped:isWorn(item)});
    else {keep.push(item);if(category)counts[category]=(counts[category]??0)+1;}
  }
  return {drop,keep,counts};
}
let INDEX,DB;
export function jungleItemClassifier(){
  INDEX??=itemClassIndex();DB??=JSON.parse(readFileSync(KODDB,'utf8')).classes;
  const alcohol=chain=>{
    for(const name of chain){const m=DB[norm(name)]?.messages?.find(m=>norm(m.name)==='isalcohol');if(m)return /return\s+TRUE/i.test(m.body);}
    return false;
  };
  return item=>{
    const candidates=INDEX.byName.get(norm(item.name))??[];
    if(!candidates.length)return 'unknown';
    const categories=candidates.map(c=>{const chain=DB[norm(c.class)]?.chain??[];return guardCategory(chain,alcohol(chain));});
    return categories.every(c=>c===categories[0])?categories[0]:'unknown';
  };
}
const signature=o=>JSON.stringify([norm(o.name),o.amount??0,o.rarity??o.appearance?.rarity??0,o.translation??o.appearance?.translation??0,o.icon_rsc??o.appearance?.icon_rsc??0]);
const identity=o=>JSON.stringify([norm(o.name),o.rarity??o.appearance?.rarity??0,o.translation??o.appearance?.translation??0,o.icon_rsc??o.appearance?.icon_rsc??0]);
export const inventoryUnits=(items,item)=>items.filter(i=>identity(i)===identity(item)).reduce((n,i)=>n+(i.amount>0?i.amount:1),0);
async function pack(ctx){const p=await ctx.call('inventory',{agent:ctx.agent});if(!Array.isArray(p.items))throw Error('inventory_unavailable');return p.items;}
async function freshPackItem(ctx,item){
  const items=await pack(ctx),matches=items.filter(i=>signature(i)===signature(item));
  let current=matches.find(i=>i.id===item.id);
  if(!current&&matches.length===1)current=matches[0];
  if(!current&&matches.length>1){
    // Equivalent objects inside this character's own pack are interchangeable;
    // preserve worn protection while selecting a spare after save renumbering.
    const eq=await ctx.call('equipment',{agent:ctx.agent});if(!eq.known)throw Error('equipment_unknown');
    const worn=new Set((eq.equipped??[]).map(i=>i.id));
    current=matches.find(i=>item.was_equipped&&!item.unused?worn.has(i.id):!worn.has(i.id));
  }
  if(!current)throw Error('item_changed_before_drop_'+item.name);
  item.id=current.id;return current;
}
async function singleCup(ctx){
  const cups=(await pack(ctx)).filter(i=>/chalice of the rain/i.test(i.name));
  if(cups.length!==1||!(cups[0].id>0))throw Error('requires_exactly_one_chalice');
  return cups[0];
}
async function fullCup(ctx){
  const cup=await singleCup(ctx),l=await ctx.call('look_at',{agent:ctx.agent,target:cup.id});
  if(l.id!==cup.id||!cupIsFull(l.description))throw Error('chalice_must_be_full');
  return cup;
}
async function hop(ctx,to,record){
  const l=await ordinaryHop(ctx,to,{budgetMs:180000});record.travel.push(l);
  if(!l.ok)throw Error('crossing_failed_'+to);
}
// Rescue requires staying still through its delay. Start from a safe wall so
// ordinary keeper shelter/play-dead survival does not interrupt a paid sip.
export async function prepareIslandSip(ctx,record,save){
  const initial=await ctx.call('look',{agent:ctx.agent});
  if(!Number.isFinite(initial.hp?.value)||!Number.isFinite(initial.hp?.max)||initial.hp.max<=0||
     initial.hp.value<=0||initial.room?.num===1)throw Error('sip_shelter_health_unconfirmed');
  if(initial.hp.max<(ctx.fragileBelow??20)||initial.hp.value/initial.hp.max<(ctx.minHealth??1))
    throw Error('sip_shelter_requires_departure_health');
  const agent=ctx.agent,spots=await ctx.call('safe_spots',{agent,limit:4096});
  const candidates=(spots.spots??[]).filter(s=>s.can_reach_you===0&&!s.rim&&s.distance<=10)
    .sort((a,b)=>a.distance-b.distance);
  for(const wall of candidates.slice(0,3)){
    if(spots.standing_at?.row!==wall.row||spots.standing_at?.col!==wall.col)
      await ctx.call('walk_to',{agent,row:wall.row,col:wall.col,max_steps:40,arrive_within:3},60000);
    const l=await ctx.call('look',{agent});
    if(!Number.isFinite(l.hp?.value)||!Number.isFinite(l.hp?.max)||l.hp.value<=0||l.room?.num===1)
      throw Error('sip_shelter_health_unconfirmed');
    if(l.hp.max<initial.hp.max)throw Error('traveller_lost_max_health');
    if(l.room?.num!==spots.room?.num)throw Error('sip_shelter_unexpected_room');
    if(l.you?.row===wall.row&&l.you?.col===wall.col){
      record.departure_shelter=location(l);save();await ctx.call('rest',{agent,stand:true});return;
    }
  }
  throw Error('chalice_requires_reachable_safe_wall');
}
async function sipTo(ctx,to,record,save){
  await ctx.call('rest',{agent:ctx.agent,stand:true});
  const cup=await singleCup(ctx),before=location(await ctx.call('look',{agent:ctx.agent}));
  if(!Number.isFinite(before.hp?.value)||!Number.isFinite(before.hp?.max)||before.hp.max<=0)throw Error('traveller_health_unreadable');
  if(before.room===1||before.hp.value<=0)throw Error('traveller_died');
  if(before.hp.max<(ctx.fragileBelow??20))throw Error('traveller_below_max_health_floor');
  const sip={from:before,to,started_at:new Date().toISOString(),cup_name:cup.name};record.sips.push(sip);save();
  sip.reply=await ctx.call('act',{agent:ctx.agent,verb:'use',target:cup.id});save();
  if((sip.reply.messages??[]).some(m=>/walked the path of peace/i.test(m)))throw Error('pvp_teleport_lockout');
  const until=Date.now()+45000;
  for(;;){
    const l=location(await ctx.call('look',{agent:ctx.agent}));
    if(!Number.isFinite(l.hp?.value)||!Number.isFinite(l.hp?.max)||l.hp.max<=0)throw Error('traveller_health_unreadable');
    if(l.room===1||l.hp?.value<=0)throw Error('traveller_died');
    if(l.hp.max<before.hp.max)throw Error('traveller_lost_max_health');
    if(l.room===to){sip.landed=l;save();return;}
    if(l.room!==before.room)throw Error('unexpected_rescue_landing_'+l.room);
    if(Date.now()>until)throw Error('rescue_landing_not_observed');
    await pause(750);
  }
}
async function awaitPack(ctx,test,label){
  const until=Date.now()+12000;
  for(;;){const items=await pack(ctx);if(test(items))return items;if(Date.now()>until)throw Error(label);await pause(400);}
}
async function dropItem(ctx,item){
  const current=await freshPackItem(ctx,item),before=inventoryUnits(await pack(ctx),item),units=item.amount>0?item.amount:1;
  await ctx.call('act',{agent:ctx.agent,verb:'drop',target:current.id,...(item.amount>0?{amount:item.amount}:{})});
  await awaitPack(ctx,p=>inventoryUnits(p,item)<=before-units,'drop_not_confirmed_'+item.name);
  item.dropped_at=Date.now();
}
async function retrieve(ctx,item,group=[]){
  const seen=await ctx.call('look',{agent:ctx.agent});
  const floor=(seen.objects??[]).filter(o=>signature(o)===signature(item)&&o.can?.includes('get'));
  // Save renumbering is handled by fresh floor identity, and ambiguity is a refusal.
  let exact=floor.filter(o=>Math.abs(o.row-item.floor.row)<=1&&Math.abs(o.col-item.floor.col)<=1);
  // Multiple identical spares can share a square. Use the original handle only
  // before a save; afterwards an ambiguous name/location must be reviewed.
  if(!(seen.last_save_at>item.dropped_at)&&item.dropped_at){
    const same=exact.filter(o=>o.id===item.id);if(same.length===1)exact=same;
  }
  // The server renumbers every item on save. A verified, initially empty stash
  // can contain several equivalent spares; reclaim that exact remaining group.
  const owned=group.filter(i=>i.dropped&&!i.recovered&&signature(i)===signature(item));
  if(exact.length>1&&owned.length===exact.length)exact=[exact[0]];
  if(exact.length!==1)throw Error('stash_missing_or_ambiguous_'+item.name);
  const before=inventoryUnits(await pack(ctx),item),units=exact[0].amount>0?exact[0].amount:1;
  await ctx.call('act',{agent:ctx.agent,verb:'get',target:exact[0].id});
  await awaitPack(ctx,p=>inventoryUnits(p,item)>=before+units,'pickup_not_confirmed_'+item.name);
}
async function restoreEquipment(ctx,item,save){
  if(!item.was_equipped||item.reequipped)return;
  const eq=await ctx.call('equipment',{agent:ctx.agent});
  if(!eq.known)throw Error('equipment_unknown');
  const worn=new Set((eq.equipped??[]).map(i=>i.id));
  const matches=(await pack(ctx)).filter(i=>signature(i)===signature(item));
  // Equivalent recovered spares in our own pack are interchangeable.
  const current=matches.find(i=>!worn.has(i.id))??matches.find(i=>worn.has(i.id));
  if(!current)throw Error('restored_equipment_missing');
  if(!worn.has(current.id))await ctx.call('act',{agent:ctx.agent,verb:'use',target:current.id});
  const after=await ctx.call('equipment',{agent:ctx.agent});
  if(!after.known||!(after.equipped??[]).some(i=>i.id===current.id))throw Error('restored_equipment_not_confirmed');
  item.reequipped=true;save();
}
const activeStashTokens=new Set();
export async function withStashLease(ctx,record,fn){
  if(!record.receipt)throw Error('refill_requires_durable_receipt');
  const file=resolve(dirname(record.receipt),'refill.lock'),token=randomUUID(),deadline=Date.now()+900000;
  const alive=prior=>{try{process.kill(prior.pid,0);}catch(e){if(e.code==='ESRCH')return false;}
    const started=processStartedAt(prior.pid);return !started||!prior.started_at||Math.abs(started-prior.started_at)<=START_TIME_TOLERANCE_MS;};
  const remove=nonce=>{try{const current=JSON.parse(readFileSync(file,'utf8'));if(current.token===nonce)unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}};
  for(;;){
    try{const fd=openSync(file,'wx');try{writeFileSync(fd,JSON.stringify({token,pid:process.pid,started_at:Date.now()-process.uptime()*1000,agent:ctx.agent,receipt:record.receipt}));}finally{closeSync(fd);}activeStashTokens.add(token);break;}
    catch(e){
      if(e.code!=='EEXIST')throw e;
      let prior;try{prior=JSON.parse(readFileSync(file,'utf8'));}catch(err){if(err.code==='ENOENT'||err instanceof SyntaxError){if(Date.now()>deadline)throw Error('refill_lock_unreadable');await pause(100);continue;}throw err;}
      const receipt=existsSync(prior.receipt)?JSON.parse(readFileSync(prior.receipt,'utf8')):null;
      const live=alive(prior),ownFinished=prior.pid===process.pid&&!activeStashTokens.has(prior.token);
      if(receipt?.complete||prior.agent===ctx.agent&&(!live||ownFinished)){remove(prior.token);continue;}
      if(!live||ownFinished)throw Error('refill_waits_for_unrecovered_stash_'+prior.agent);
      if(Date.now()>deadline)throw Error('refill_queue_budget');
      await pause(1000);
    }
  }
  try{return await fn();}finally{
    activeStashTokens.delete(token);
    // Retain ownership of abandoned cargo; a later traveler cannot claim it.
    if(record.refill?.complete||!record.stash?.items.some(i=>i.dropped&&!i.recovered))remove(token);
  }
}
export function islandRideRecovery(record,room){
  if(!record.sips?.length&&!record.stash)return 'not_started';
  if(record.sips?.length===1&&room===2510)return 'second_sip';
  if(record.sips?.length===2&&[2000,2001,2013,2115].includes(room))return 'refill';
  return 'unobserved';
}
export async function refillIslandCup(ctx,options={}){
  return withStashLease(ctx,options.record,()=>refillOwned(ctx,options));
}
async function refillOwned(ctx,{record,save,keepItems=true}={}){
  if(record.stash)return recoverIslandRefill(ctx,{record,save});
  await hop(ctx,2000,record);await hop(ctx,2013,record);
  const position=await ctx.call('walk_to',{agent:ctx.agent,row:4,col:40,max_steps:100,arrive_within:4},180000);
  const at=location(await ctx.call('look',{agent:ctx.agent}));
  if(at.room!==2013||Math.abs(at.row-4)+Math.abs(at.col-40)>1)throw Error('stash_position_not_reached');
  const inv=await pack(ctx),eq=await ctx.call('equipment',{agent:ctx.agent});
  if(!eq.known)throw Error('equipment_unknown');
  const plan=jungleStashPlan(inv,{equipped:eq.equipped??[],classify:jungleItemClassifier()});
  const floor=(await ctx.call('look',{agent:ctx.agent})).objects??[];
  if(floor.some(o=>plan.drop.some(i=>identity(i)===identity(o))&&Math.abs(o.row-at.row)<=1&&Math.abs(o.col-at.col)<=1))throw Error('stash_area_already_contains_matching_items');
  record.stash={room:2013,position:at,exclusive:true,items:plan.drop.map(i=>({...i,floor:{row:at.row,col:at.col},dropped:false,recovered:false})),keepItems};save();
  for(const item of record.stash.items){
    if(item.was_equipped){await freshPackItem(ctx,item);await ctx.call('act',{agent:ctx.agent,verb:'unuse',target:item.id});item.unused=true;save();}
    await dropItem(ctx,item);item.dropped=true;save();
  }
  if(jungleStashPlan(await pack(ctx),{classify:jungleItemClassifier()}).drop.length)throw Error('contraband_remains');
  await hop(ctx,2115,record);
  const cup=await singleCup(ctx);record.refill={room:2115,before:cup,position:location(await ctx.call('look',{agent:ctx.agent}))};save();
  await dropItem(ctx,cup);
  record.refill.cupDropped=true;save();
  await retrieve(ctx,{...cup,floor:record.refill.position});
  record.refill.cupRecovered=true;save();
  await fullCup(ctx);record.refill.full=true;save();
  await hop(ctx,2013,record);
  await ctx.call('walk_to',{agent:ctx.agent,row:at.row,col:at.col,max_steps:30,arrive_within:4},60000);
  if(keepItems)for(const item of record.stash.items){
    await retrieve(ctx,item,record.stash.items);item.recovered=true;save();
    await restoreEquipment(ctx,item,save);
  }
  await hop(ctx,2000,record);
  record.refill.complete=true;save();
}
// A retry follows the durable cargo record; it never abandons a previous stash or
// starts a fresh sip while the outcome of the previous sip is unknown.
export async function recoverIslandRefill(ctx,{record,save}){
  const room=(await ctx.call('look',{agent:ctx.agent})).room?.num;
  if(![2000,2001,2013,2115].includes(room))throw Error('refill_recovery_requires_island');
  if(room===2001)await hop(ctx,2000,record);
  if(room===2000||room===2001)await hop(ctx,2013,record);
  if(room!==2115){
    const at=record.stash.position;
    await ctx.call('walk_to',{agent:ctx.agent,row:at.row,col:at.col,max_steps:100,arrive_within:4},180000);
    for(const item of record.stash.items.filter(i=>!i.dropped)){
      const present=(await pack(ctx)).some(i=>signature(i)===signature(item));
      if(present){await freshPackItem(ctx,item);if(item.was_equipped&&!item.unused){await ctx.call('act',{agent:ctx.agent,verb:'unuse',target:item.id});item.unused=true;save();}await dropItem(ctx,item);}
      else {
        const floor=(await ctx.call('look',{agent:ctx.agent})).objects??[];
        if(!floor.some(i=>signature(i)===signature(item)))throw Error('unconfirmed_stash_drop_'+item.name);
      }
      item.dropped=true;save();
    }
    if(!record.refill?.full){
      if(jungleStashPlan(await pack(ctx),{classify:jungleItemClassifier()}).drop.length)throw Error('contraband_remains');
      await hop(ctx,2115,record);
    }
  }
  if(!record.refill?.full){
    const cups=(await pack(ctx)).filter(i=>/chalice of the rain/i.test(i.name));
    if(!cups.length&&record.refill?.before)await retrieve(ctx,{...record.refill.before,floor:record.refill.position});
    const cup=await singleCup(ctx);
    if(!record.refill)record.refill={room:2115,before:cup,position:location(await ctx.call('look',{agent:ctx.agent}))};
    save();await dropItem(ctx,cup);record.refill.cupDropped=true;save();
    await retrieve(ctx,{...cup,floor:record.refill.position});record.refill.cupRecovered=true;save();
    await fullCup(ctx);record.refill.full=true;save();
  }
  await hop(ctx,2013,record);
  const at=record.stash.position;
  await ctx.call('walk_to',{agent:ctx.agent,row:at.row,col:at.col,max_steps:100,arrive_within:4},180000);
  if(record.stash.keepItems)for(const item of record.stash.items.filter(i=>i.dropped&&(!i.recovered||i.was_equipped&&!i.reequipped))){
    if(!item.recovered){await retrieve(ctx,item,record.stash.items);item.recovered=true;save();}
    await restoreEquipment(ctx,item,save);
  }
  await hop(ctx,2000,record);record.refill.complete=true;save();
}
export async function rideIslandCup(ctx,{evidenceDir='substrate/island-chalice',keepItems=true}={}){
  const {agent,call,state}=ctx;
  await call('autopilot',{agent,action:'town_trip',op:'drop',hold_ms:0});
  const file=resolve(evidenceDir,agent+'-pending.json');mkdirSync(dirname(file),{recursive:true});
  if(existsSync(file)){
    const previous=JSON.parse(readFileSync(file,'utf8'));
    if(!previous.complete){
      previous.receipt=file;
      const save=()=>writeFileSync(file,JSON.stringify(previous,null,2));
      const room=(await call('look',{agent})).room?.num;
      const recovery=islandRideRecovery(previous,room);
      if(recovery==='second_sip'){
        previous.sips[0].landed??=location(await call('look',{agent}));save();
        await sipTo(ctx,2001,previous,save);
      }
      // Island arrival proves both completed teleports without consuming more water.
      if(recovery==='refill'||recovery==='second_sip'){
        previous.sips[1].landed??=location(await call('look',{agent}));
        await refillIslandCup(ctx,{record:previous,save,keepItems});
        previous.end=location(await call('look',{agent}));previous.complete=true;delete previous.failure;save();
        return {ok:true,evidence:file,recovered:true};
      }
      if(recovery==='not_started')
        writeFileSync(file.replace('-pending','-unstarted-'+Date.now()),JSON.stringify(previous,null,2));
      else throw Error('unfinished_island_ride_requires_observed_landing: '+file);
    }
  }
  // Confirm a full cup BEFORE walking or sipping.
  await fullCup(ctx);
  const room=(await call('look',{agent})).room?.num;
  if(room!==27&&!(room>=2500&&room<=2509))throw Error('island_ride_requires_orc_cave_region');
  const record={format:'m59-island-chalice/1',at:new Date().toISOString(),agent,receipt:file,start:location(await call('look',{agent})),sips:[],travel:[],complete:false};
  const save=()=>writeFileSync(file,JSON.stringify(record,null,2));state.islandChalice=record;save();
  try{
    if(room===27)await hop(ctx,2500,record);
    await prepareIslandSip(ctx,record,save);
    await sipTo(ctx,2510,record,save);
    // A second sip starts only after the first Rescue has landed.
    await sipTo(ctx,2001,record,save);
    await refillIslandCup(ctx,{record,save,keepItems});
    record.end=location(await call('look',{agent}));record.complete=true;save();
    writeFileSync(file.replace('-pending','-'+Date.now()),JSON.stringify(record,null,2));
    return {ok:true,evidence:file};
  }catch(e){record.failure=e.message;save();throw e;}
}
