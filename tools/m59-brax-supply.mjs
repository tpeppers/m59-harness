// Rolling Brax supply service. Dependencies own fleet identity, ordinary RPC and public legs.
// Couriers work independently; only the upper-runner handoff is serialized.
import {randomUUID} from 'node:crypto';
import {foodValue,weighItem} from './m59-items.mjs';
import {buyCourierGoods} from './m59-courier-purchases.mjs';
const count=(items,name)=>items.filter(i=>i.name?.toLowerCase()===name).reduce((n,i)=>n+(i.amount>0?i.amount:1),0);
export function braxNeeds(actor,items,{food=6,herbs=20,elderberries=10}={}){
 const knows=re=>(actor.abilities?.spells??[]).some(s=>s.ability>0&&re.test(s.name));
 const haveFood=items.reduce((n,i)=>n+(foodValue(i.name)?.nutrition??0)/20*(i.amount>0?i.amount:1),0);
 return{hammer:count(items,'hammer')?0:1,'loaf of bread':Math.max(0,Math.ceil(food-haveFood)),herb:knows(/minor heal|major heal|hospice|create food/i)?Math.max(0,(knows(/minor heal|major heal|hospice/i)?herbs:6)-count(items,'herb')-count(items,'herbs')):0,elderberry:knows(/create food/i)?Math.max(0,elderberries-count(items,'elderberry')):0};
}
export function braxCourierTarget(name,demand,cap){const reserve=name==='hammer'?1:name==='herb'||name==='elderberry'?5:name==='loaf of bread'?4:0;return Math.min(cap,Math.max(0,demand??0)+reserve);}
export function braxSaleCargo(name){return /sapphire|emerald|diamond|ruby|armor|armour|shield|sword|scimitar|mace|axe|gauntlet|helm/i.test(name)&&!/hammer|wand|quest|signet|shield of|soldier.s shield|guild|princess|duke|rebel militia/i.test(name);}
export class BraxSupplyService{
 constructor({actors,runner,couriers,call,read,runLeg,emit=()=>{},phase=()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms)),evidenceDir='substrate/courier-purchases',farmRunner=true}){
  if(!actors.some(c=>c.shadow_account===runner&&c.role==='farmer')||couriers.length!==2||new Set(couriers).size!==2)throw Error('Brax service needs one selected farmer runner and2 distinct couriers');
  Object.assign(this,{actors,runner,couriers,call,read,runLeg,emit,phase,wait,evidenceDir});this.farmRunner=farmRunner;this.farmers=actors.filter(c=>c.role==='farmer');this.stopped=false;this.upperGate=Promise.resolve();this.cycles={};this.pending=new Set();this.shopGates=new Map();this.lastLaneCourier=null;this.capacityBlocks=new Map();this.notReadyUntil=new Map();
 }
 async runnerMode(mode){const r=await this.call('autopilot',{agent:this.runner,action:'start',mode});if(r.error||r.keeper_push?.confirmed!==true)throw Error('runner mode not confirmed');}
 async atMerchant(name,fn){const previous=this.shopGates.get(name)??Promise.resolve(),task=previous.catch(()=>{}).then(fn);this.shopGates.set(name,task.then(()=>{},()=>{}));return task;}
 async event(kind,detail={}){await this.emit({at:Date.now(),kind,...detail});}
 async pack(agent){for(let attempt=0;attempt<4;attempt++){const p=await this.call('inventory',{agent,fresh:true});if(Array.isArray(p?.items)&&p.ids_stale!==true)return p;if(attempt<3)await this.wait(500);}throw Error('inventory unconfirmed '+agent);}
 async localFarmers(room){const out=[];for(const c of this.farmers){const s=await this.read(c.shadow_account);if(s.hp?.value>0&&s.room?.num===room)out.push({actor:c,state:s});}return out;}
 async needs(){const rows=[];for(const c of this.farmers){const s=await this.read(c.shadow_account);if(![578,826,827].includes(s.room?.num)||!(s.hp?.value>0))continue;const p=await this.pack(c.shadow_account);rows.push({agent:c.shadow_account,needs:braxNeeds(c,p.items)});}return rows;}
 async transfer(from,to,item,amount){
  if(!(amount>0))return null;if((this.notReadyUntil.get(from)??0)>Date.now()||(this.notReadyUntil.get(to)??0)>Date.now()){await this.event('trade-deferred',{from,to,item:item.name,reason:'recent native stationary readiness refusal'});return{quantity:0,deferred:true};}const id=randomUUID(),p=await this.pack(from),i=p.items.find(x=>x.id===item.id&&x.name===item.name);if(!i)throw Error('cargo changed before submission');
  const key=to+':'+i.name,signature=items=>JSON.stringify(items.map(x=>[x.name,x.amount>0?x.amount:1]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  if(this.capacityBlocks.has(key)){const current=signature((await this.pack(to)).items);if(current===this.capacityBlocks.get(key)){await this.event('trade-deferred',{id,from,to,item:i.name,reason:'server-refused capacity; receiver inventory unchanged'});return{quantity:0,deferred:true};}this.capacityBlocks.delete(key);}
  const receiver=await this.read(to),cap=receiver.carry,unit=weighItem(i.name);
  if(!unit||!cap?.known||cap.load?.exact!==true||!cap.room_for){await this.event('trade-deferred',{id,from,to,item:i.name,reason:'capacity unknown'});return{quantity:0,deferred:true};}
  const margin=i.name==='hammer'?0:16;
  amount=Math.max(0,Math.min(amount,unit.weight>0?Math.floor(Math.max(0,cap.room_for.weight-margin)/unit.weight):amount,unit.bulk>0?Math.floor(Math.max(0,cap.room_for.bulk-margin)/unit.bulk):amount));
  if(!amount){await this.event('trade-deferred',{id,from,to,item:i.name,reason:'receiver capacity'});return{quantity:0,deferred:true};}
  await this.event('trade-intent',{id,from,to,item:i.name,amount});
  const r=await this.call('supply',{from,to,what:[{id:i.id,amount}],ids_as_of:p.ids_as_of,who_travels:'neither',stationary:true},90000);
  await this.event('trade-result',{id,from,to,item:i.name,amount,result:r});
  if(typeof r.reason==='string'&&r.reason.startsWith('stationary body not ready:')){this.notReadyUntil.set(from,Date.now()+10000);this.notReadyUntil.set(to,Date.now()+10000);await this.event('trade-deferred',{id,from,to,item:i.name,reason:r.reason});return{quantity:0,deferred:true};}
  if(r.reason_code==='receiver_full'&&!r.partial&&!(r.amounts?.length)&&r.not_received?.length&&r.not_received.every(x=>x.received===0&&x.giver_lost===0)){this.capacityBlocks.set(key,signature((await this.pack(to)).items));await this.event('capacity-prediction-refuted',{id,from,to,item:i.name,amount,predictedCarry:cap,result:r});return{quantity:0,deferred:true};}
  if(!r.supplied||r.amounts?.some(m=>m.giver_lost<m.asked))throw Object.assign(Error('cargo transfer not verified: '+(r.reason??r.error??'unknown')),{receipt:r});return{...r,quantity:amount};
 }
 async deliverLocal(){
  const upper=await this.read(this.runner),locals=await this.localFarmers(upper.room.num);locals.sort((a,b)=>{const healer=x=>(x.actor.abilities?.spells??[]).some(s=>/minor heal|major heal|hospice/i.test(s.name));return Number(healer(b))-Number(healer(a))||a.state.hp.max-b.state.hp.max;});
  for(const {actor,state}of locals){const a=actor.shadow_account;if(a===this.runner||state.hp.value/state.hp.max<.9)continue;
   const need=braxNeeds(actor,(await this.pack(a)).items);
   for(const [name,want]of Object.entries(need)){if(want<=0)continue;const p=await this.pack(this.runner),wear=new Set(((await this.read(this.runner)).equipment_items??[]).map(i=>i.id)),items=p.items.filter(i=>i.name===name||name==='herb'&&i.name==='herbs');const reserve=name==='hammer'?1:name==='herb'?20:name==='elderberry'?10:2;
    let left=Math.min(want,Math.max(0,items.reduce((n,i)=>n+(i.amount>0?i.amount:1),0)-reserve));
    for(const item of items){if(wear.has(item.id))continue;const n=Math.min(left,item.amount>0?item.amount:1);if(n>0){const sent=await this.transfer(this.runner,a,item,n);left-=sent?.quantity??0;}if(!left)break;}
   }
  }
 }
 async collectLocal(){
  const here=await this.read(this.runner);if(Math.min(here.carry?.room_for?.weight??0,here.carry?.room_for?.bulk??0)<200)return;const locals=(await this.localFarmers(here.room.num)).filter(x=>x.actor.shadow_account!==this.runner&&x.state.hp.value/x.state.hp.max>=.9);
  let donors=0;for(const {actor,state}of locals){if(donors>=3)break;const a=actor.shadow_account,p=await this.pack(a),worn=new Set((state.equipment_items??[]).map(i=>i.id));
   const protectedNames=state.autopilot_status?.policy?.protectedItems??[];
   const candidates=p.items.filter(i=>!worn.has(i.id)&&!protectedNames.some(n=>String(i.name).toLowerCase().includes(String(n).toLowerCase()))&&braxSaleCargo(i.name)).slice(0,2);
   for(const i of candidates){await this.transfer(a,this.runner,i,Math.min(i.amount>0?i.amount:1,10));donors++;}
   const cash=p.items.find(i=>/^shillings?$/.test(i.name));if(cash?.amount>1500&&count((await this.pack(this.runner)).items,'shilling')<10000){await this.transfer(a,this.runner,cash,Math.min(5000,cash.amount-1000));donors++;}
  }
 }
 async townTravel(agent,to){
  let s=await this.read(agent);if(s.room.num===to)return;const before=s,startedAt=Date.now(),deadline=startedAt+600000;await this.phase(agent,'Jasper travel');
  const r=await this.call('travel',{agent,to,max_hops:6,run_errands:false,avoid:[579,826,827,828,829,830,831,832,833]},600000),returnedAt=Date.now();
  // The native keeper may retain and resume this exact objective after recovery.
  // Observe that owned journey; never send a second travel order on a timeout.
  for(;;){s=await this.read(agent);await this.event('town-travel-observed',{agent,to,result:r,room:s.room.num,job:s.job,suspended:s.autopilot_status?.suspended_journey});
   const renamedHandle=s.you?.id!==before.you?.id,stableCharacter=typeof before.character==='string'&&before.character.length>0&&s.character===before.character,newDeath=(s.autopilot_status?.last_death?.at??0)>(before.autopilot_status?.last_death?.at??0);
   if(renamedHandle&&!stableCharacter||s.pid!==before.pid||newDeath||!(s.hp?.value>0)||s.room.num===1||Number.isFinite(before.hp?.max)&&s.hp.max<before.hp.max)throw Error('courier body changed during town travel');
   if(s.room.num===to)break;
   const a=s.autopilot_status??{},held=a.suspended_journey,move=s.movement?.order;
   const ownHeld=held?.to===to&&held.ordered_by===r.ordered_by,ownMove=move?.to===to&&move.ordered_by===r.ordered_by;
   if(Date.now()>=deadline||!r.ordered_by||!ownHeld&&!ownMove&&Date.now()-returnedAt>=3000)throw Error('courier journey ended before Jasper counter '+to);
   await this.wait(1000);
  }
  await this.event('town-travel',{agent,to,result:r,arrivedAt:Date.now(),startedAt});
 }
 async sell(agent,room,merchant){await this.townTravel(agent,room);const before=await this.pack(agent);const r=await this.atMerchant(merchant,()=>this.call('sell_all',{agent,merchant,keep:['hammer','herb','elderberry','bread','mushroom','meat pie','stew','cheese','wand','quest','signet'],max_weapons:1,max_offers:12},180000));const after=await this.pack(agent);await this.event('sale',{agent,merchant,beforeCash:count(before.items,'shilling'),afterCash:count(after.items,'shilling'),result:r});return r;}
 async procure(agent){
  await this.phase(agent,'Jasper procurement');const rows=await this.needs(),need={};for(const r of rows)for(const[k,n]of Object.entries(r.needs))need[k]=(need[k]??0)+n;
  await this.sell(agent,374,'Quintor');
  // Reagents/gems go to an explicitly trusted real reagent buyer, never the bank.
  await this.sell(agent,373,"Zhieu B'hob");
  const ctx={agent,state:{},call:this.call};
  for(const [name,room,seller,cap]of [['hammer',374,'Quintor',8],['herb',373,"Zhieu B'hob",80],['elderberry',373,"Zhieu B'hob",50],['loaf of bread',371,'Pietro',48]]){
   const p=await this.pack(agent),amount=Math.max(0,braxCourierTarget(name,need[name],cap)-count(p.items,name));if(!amount)continue;await this.townTravel(agent,room);
   // Nonstackable merchant stock is one object per purchase. Each next purchase
   // is new intent only after the preceding cash+inventory delta is reconciled.
   for(let attempt=0;attempt<cap;attempt++){
    const current=count((await this.pack(agent)).items,name),remaining=braxCourierTarget(name,need[name],cap)-current;if(remaining<=0)break;
    const receipt=await this.atMerchant(seller,()=>buyCourierGoods(ctx,{seller,item:name,aliases:name==='herb'?['herbs']:[],amount:remaining,evidenceDir:this.evidenceDir}));await this.event('purchase',{agent,item:name,receipt});
    if(receipt.status==='unreconciled')throw Error('ambiguous purchase; manual inventory reconciliation required');if(receipt.status!=='confirmed'||!(receipt.quantity>0))break;
   }
  }
  await this.townTravel(agent,350);
 }
 async exchange(agent){
  await this.runnerMode('idle');await this.phase(this.runner,'collecting');const s=await this.read(this.runner);if(s.room.num===827)await this.collectLocal();
  await this.phase(this.runner,'outbound');await this.runLeg(this.runner,'farmer','out');await this.collectLocal();await this.phase(this.runner,'exchange');await this.phase(agent,'exchange');
  // Export first to make room on the upper runner. Retain own food, medicine and hammer.
  const upperCap=(await this.read(this.runner)).carry?.room_for,lowerCap=(await this.read(agent)).carry?.room_for;const free=p=>Math.min(p?.weight??0,p?.bulk??0);
  for(const from of free(lowerCap)<free(upperCap)?[agent,this.runner]:[this.runner,agent]){
   const to=from===this.runner?agent:this.runner,p=await this.pack(from),state=await this.read(from),worn=new Set((state.equipment_items??[]).map(i=>i.id));
   const chosen=from===agent?p.items.filter(i=>/^(hammer|herbs?|elderberry|loaf of bread)$/.test(i.name)):p.items.filter(i=>!worn.has(i.id)&&(braxSaleCargo(i.name)||/^shillings?$/.test(i.name)));
   const budgets=new Map(),protectedNames=state.autopilot_status?.policy?.protectedItems??[];
   for(const item of chosen){if(worn.has(item.id)||from===this.runner&&protectedNames.some(n=>String(item.name).toLowerCase().includes(String(n).toLowerCase())))continue;const reserve=from===agent?(item.name==='hammer'?1:/herbs?/.test(item.name)?5:item.name==='elderberry'?5:item.name==='loaf of bread'?4:0):/^shillings?$/.test(item.name)?500:0;if(!budgets.has(item.name))budgets.set(item.name,Math.max(0,count(p.items,item.name)-reserve));const n=Math.min(item.amount>0?item.amount:1,budgets.get(item.name),/^shillings?$/.test(item.name)?5000:100);if(n){const sent=await this.transfer(from,to,item,n);budgets.set(item.name,budgets.get(item.name)-(sent?.quantity??0));}}
  }
  // Other farmers may still be in upper578 during preparation.
  await this.phase(this.runner,'local distribution');await this.deliverLocal();
  const lowerBack=this.runLeg(agent,'courier','back');this.pending.add(lowerBack);lowerBack.finally(()=>this.pending.delete(lowerBack)).catch(()=>{});
  await this.phase(this.runner,'returning');await this.runLeg(this.runner,'farmer','back');await this.phase(this.runner,'local distribution');await this.deliverLocal();await this.phase(this.runner,'farming');if(this.farmRunner)await this.runnerMode('farm');
  // Release the lane gate once upper is home and lower has cleared its stand.
  const start=Date.now();for(;;){const s=await this.read(agent);if(s.room.num!==578||Math.hypot(s.you.x-2256,s.you.y-2208)>64)break;if(Date.now()-start>60000)throw Error('lower courier did not clear exchange lane');await this.wait(1000);}return {lowerBack};
 }
 async admitLane(agent){
  const previous=this.lastLaneCourier;if(previous&&previous!==agent){const s=await this.read(previous);
   if(!Number.isInteger(s.room?.num)||s.room.num===578&&(!Number.isFinite(s.you?.x)||!Number.isFinite(s.you?.y)||Math.hypot(s.you.x-2256,s.you.y-2208)<=64))throw Error('previous courier still occupies or cannot prove clearance of ledge lane: '+previous);
  }this.lastLaneCourier=agent;
 }
 async worker(agent,{until=Infinity,maxCycles=Infinity}={}){
  for(let n=0;n<maxCycles&&!this.stopped&&Date.now()<until;n++){
   try{let s=await this.read(agent);if(s.room.num===578){await this.phase(agent,'returning');await this.runLeg(agent,'courier','back');}
    await this.procure(agent);await this.phase(agent,'waiting for ledge lane');
    const exchange=this.upperGate.catch(()=>{}).then(async()=>{await this.admitLane(agent);await this.phase(agent,'outbound');await this.runLeg(agent,'courier','out');return this.exchange(agent);});this.upperGate=exchange.then(()=>{},()=>{});const done=await exchange;await done.lowerBack;this.cycles[agent]=(this.cycles[agent]??0)+1;await this.event('cycle-complete',{agent,cycles:this.cycles[agent]});
   }catch(e){await this.phase(agent,'needs attention');await this.event('service-failure',{agent,error:e.message});throw e;}
  }
 }
 async run(options={}){const result=await Promise.allSettled(this.couriers.map(a=>this.worker(a,options)));await Promise.allSettled([...this.pending]);return result;}
 stop(){this.stopped=true;}
}
