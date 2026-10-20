// Rolling Brax supply service. Dependencies own fleet identity, ordinary RPC and public legs.
// Couriers work independently; only the upper-runner handoff is serialized.
import {isActiveRecoveryDecision} from './m59-survival-decision.mjs';
import {observeCourierJourney} from './m59-courier-journey.mjs';
import {randomUUID} from 'node:crypto';
import {foodValue,weighItem,itemNameKey} from './m59-items.mjs';
import {buyCourierGoods} from './m59-courier-purchases.mjs';
const inventorySignature=items=>JSON.stringify(items.map(x=>[x.name,x.amount>0?x.amount:1]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
const count=(items,name)=>items.filter(i=>i.name?.toLowerCase()===name).reduce((n,i)=>n+(i.amount>0?i.amount:1),0);
export function braxNeeds(actor,items,{food=6,herbs=20,elderberries=10,protectedNames=[]}={}){
 const knows=re=>(actor.abilities?.spells??[]).some(s=>s.ability>0&&re.test(s.name));
 const protectedFood=new Set(protectedNames.map(itemNameKey));
 const haveFood=items.filter(i=>!protectedFood.has(itemNameKey(i.name))).reduce((n,i)=>n+(foodValue(i.name)?.nutrition??0)/20*(i.amount>0?i.amount:1),0);
 return{hammer:count(items,'hammer')?0:1,'loaf of bread':Math.max(0,Math.ceil(food-haveFood)),herb:knows(/minor heal|major heal|hospice|create food/i)?Math.max(0,(knows(/minor heal|major heal|hospice/i)?herbs:6)-count(items,'herb')-count(items,'herbs')):0,elderberry:knows(/create food/i)?Math.max(0,elderberries-count(items,'elderberry')):0};
}
export function braxProvisionReserve(actor,name,{carryFloors={}}={}){
 const spells=actor?.abilities?.spells??[],knows=re=>spells.some(s=>s.ability>0&&re.test(s.name));
 const base=name==='hammer'?1:name==='loaf of bread'?6:name==='herb'?(knows(/minor heal|major heal|hospice/i)?20:knows(/create food/i)?6:0):name==='elderberry'&&knows(/create food/i)?10:0;
 const floor=Number(Object.entries(carryFloors).find(([key])=>key.toLowerCase()===name)?.[1]??0);
 return Math.max(base,Number.isFinite(floor)?floor:0);
}
export function braxCourierTarget(name,demand,cap,reserve=name==='hammer'?1:name==='herb'||name==='elderberry'?5:name==='loaf of bread'?4:0){return Math.min(cap,Math.max(0,demand??0)+reserve);}
export function braxSaleCargo(name){return /sapphire|emerald|diamond|ruby|armor|armour|shield|sword|scimitar|mace|axe|gauntlet|helm/i.test(name)&&!/hammer|wand|quest|signet|shield of|soldier.s shield|guild|princess|duke|rebel militia/i.test(name);}
export class BraxSupplyService{
 constructor({actors,runner,couriers,call,read,runLeg,recover=null,cacheDelivery=null,emit=()=>{},phase=()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms)),evidenceDir='substrate/courier-purchases',farmRunner=true}){
  if(!actors.some(c=>c.shadow_account===runner&&c.role==='farmer')||couriers.length!==2||new Set(couriers).size!==2)throw Error('Brax service needs one selected farmer runner and2 distinct couriers');
  Object.assign(this,{actors,runner,couriers,call,read,runLeg,recover,cacheDelivery,emit,phase,wait,evidenceDir});this.farmRunner=farmRunner;this.farmers=actors.filter(c=>c.role==='farmer');this.stopped=false;this.upperGate=Promise.resolve();this.cycles={};this.pending=new Set();this.shopGates=new Map();this.lastLaneCourier=null;this.capacityBlocks=new Map();this.notReadyUntil=new Map();this.lastNeeds=new Map();
 }
 async reserve(agent,name,state=null){const s=state??await this.read(agent);return braxProvisionReserve(this.actors.find(c=>c.shadow_account===agent),name,{carryFloors:s.autopilot_status?.loadout_retention?.carry_floors??{}});}
 async runnerMode(mode){const r=await this.call('autopilot',{agent:this.runner,action:'start',mode});if(r.error||r.keeper_push?.confirmed!==true)throw Error('runner mode not confirmed');}
 async atMerchant(name,fn){const previous=this.shopGates.get(name)??Promise.resolve(),task=previous.catch(()=>{}).then(fn);this.shopGates.set(name,task.then(()=>{},()=>{}));return task;}
 async event(kind,detail={}){await this.emit({at:Date.now(),kind,...detail});}
 async pack(agent){for(let attempt=0;attempt<4;attempt++){const p=await this.call('inventory',{agent,fresh:true});if(Array.isArray(p?.items)&&p.ids_stale!==true)return p;if(attempt<3)await this.wait(500);}throw Error('inventory unconfirmed '+agent);}
 async localFarmers(room){const out=[];for(const c of this.farmers){const s=await this.read(c.shadow_account);if(s.hp?.value>0&&s.room?.num===room&&s.in_game!==false&&s.connected!==false)out.push({actor:c,state:s});}return out;}
 async needs(){const rows=[];for(const c of this.farmers){const agent=c.shadow_account,s=await this.read(agent);if(![578,826,827].includes(s.room?.num)||!(s.hp?.value>0))continue;if(s.in_game===false||s.connected===false){if(this.lastNeeds.has(agent))rows.push({agent,needs:this.lastNeeds.get(agent),deferred:true});continue;}const p=await this.pack(agent),needs=braxNeeds(c,p.items,{protectedNames:[...(s.autopilot_status?.policy?.protectedItems??[]),...(s.autopilot_status?.policy?.vaultItems??[])]});this.lastNeeds.set(agent,needs);rows.push({agent,needs});}return rows;}
 async transfer(from,to,item,amount,plannedAsOf=null){
  if(!(amount>0))return null;if((this.notReadyUntil.get(from)??0)>Date.now()||(this.notReadyUntil.get(to)??0)>Date.now()){await this.event('trade-deferred',{from,to,item:item.name,reason:'recent native stationary readiness refusal'});return{quantity:0,deferred:true};}const id=randomUUID(),p=await this.pack(from),i=p.items.find(x=>x.id===item.id&&x.name===item.name);
  const plannedAt=typeof plannedAsOf==='number'?plannedAsOf:plannedAsOf?.inventory_at,lastSave=p.ids_as_of?.last_save_at??p.last_save_at;
  const savedSincePlan=Number.isFinite(plannedAt)&&Number.isFinite(lastSave)&&lastSave>plannedAt;
  // This is a proved pre-submission refusal, not a failed/unknown accepted
  // transfer. Preserve the cargo and let the next ordinary cycle select afresh.
  if(!i||savedSincePlan){await this.event('trade-deferred',{id,from,to,item:item.name,asked_id:item.id,reason:savedSincePlan?'planned cargo predates server save':'planned cargo no longer carried',submission:{attempted:false},planned_ids_as_of:plannedAsOf,current_ids_as_of:p.ids_as_of});return{quantity:0,deferred:true,unsubmitted:true};}
  const key=to+':'+i.name,signature=inventorySignature;
  if(this.capacityBlocks.has(key)){const current=signature((await this.pack(to)).items);if(current===this.capacityBlocks.get(key)){await this.event('trade-deferred',{id,from,to,item:i.name,reason:'server-refused capacity; receiver inventory unchanged'});return{quantity:0,deferred:true};}this.capacityBlocks.delete(key);}
  const receiver=await this.read(to),cap=receiver.carry,unit=weighItem(i.name);
  if(!unit||!cap?.known||cap.load?.exact!==true||!cap.room_for){await this.event('trade-deferred',{id,from,to,item:i.name,reason:'capacity unknown'});return{quantity:0,deferred:true};}
  const margin=16;
  amount=Math.max(0,Math.min(amount,unit.weight>0?Math.floor(Math.max(0,cap.room_for.weight-margin)/unit.weight):amount,unit.bulk>0?Math.floor(Math.max(0,cap.room_for.bulk-margin)/unit.bulk):amount));
  if(!amount){await this.event('trade-deferred',{id,from,to,item:i.name,reason:'receiver capacity'});return{quantity:0,deferred:true};}
  await this.event('trade-intent',{id,from,to,item:i.name,amount});
  const giver=await this.read(from),sameFarm=giver.room?.num===827&&receiver.room?.num===827;
  // Internal distribution follows the farmer to its safe trading range. The
  // runner moves on both collection and delivery; the patient keeps its post.
  const local=sameFarm&&(from===this.runner||to===this.runner);
  const r=await this.call('supply',{from,to,what:[{id:i.id,amount}],ids_as_of:p.ids_as_of,
    who_travels:local?(from===this.runner?'from':'to'):'neither',stationary:!local},local?180000:90000);
  await this.event('trade-result',{id,from,to,item:i.name,amount,result:r});
  // requireStationaryTrade rejects BP.REQ_OFFER before native send. The
  // legacy keeper exposes only its exact message, not the typed error code.
  // This specific guard refusal is unsubmitted; generic transport errors and
  // any partial/ambiguous accepted gift still fail below and are never replayed.
  if(r.supplied===false&&r.reason_code==='recipient_not_visible'&&r.submission?.attempted===false&&r.submission?.stage==='recipient_visibility'){await this.event('delivery-recipient-deferred',{id,from,to,item:i.name,reason:r.reason,submission:r.submission});return{quantity:0,deferred:true,unsubmitted:true};}
  const nativePreSend=r.reason==='native offer submission refused'&&r.submission?.error==='stationary exchange expired or preempted by survival';
  if(typeof r.reason==='string'&&r.reason.startsWith('stationary body not ready:')||nativePreSend){this.notReadyUntil.set(from,Date.now()+10000);this.notReadyUntil.set(to,Date.now()+10000);await this.event('trade-deferred',{id,from,to,item:i.name,reason:r.reason,submission:{attempted:false},nativePreSend});return{quantity:0,deferred:true,unsubmitted:true};}
  if(r.reason_code==='receiver_full'&&!r.partial&&!(r.amounts?.length)&&r.not_received?.length&&r.not_received.every(x=>x.received===0&&x.giver_lost===0)){this.capacityBlocks.set(key,signature((await this.pack(to)).items));await this.event('capacity-prediction-refuted',{id,from,to,item:i.name,amount,predictedCarry:cap,result:r});return{quantity:0,deferred:true};}
  if(!r.supplied||r.amounts?.some(m=>m.giver_lost<m.asked||Number.isFinite(m.received)&&m.received<m.asked))throw Object.assign(Error('cargo transfer not verified: '+(r.reason??r.error??'unknown')),{receipt:r});if(local&&from===this.runner)await this.event('farmer-delivery-confirmed',{id,from,to,item:i.name,quantity:amount,receipt:r});return{...r,quantity:amount};
 }
 // Ordinary loot export can free the recipient's physical room before provisioning.
 async makeDeliveryRoom(actor,name){
  const agent=actor.shadow_account,state=await this.read(agent),unit=weighItem(name);let free=state.carry?.room_for;
  if(!unit||!free||!state.carry?.known||state.carry.load?.exact!==true)return;
  const margin=16,key=agent+':'+name;let p;
  if(this.capacityBlocks.has(key))p=await this.pack(agent);
  const refuted=p&&this.capacityBlocks.get(key)===inventorySignature(p.items);
  // A confirmed server refusal outranks an apparently adequate table estimate.
  // Export a whole additional unit before permitting a materially new intent.
  const wanted={weight:Math.max(unit.weight+margin,refuted?free.weight+Math.max(16,unit.weight):0),bulk:Math.max(unit.bulk+margin,refuted?free.bulk+Math.max(16,unit.bulk):0)};
  if(free.weight>=wanted.weight&&free.bulk>=wanted.bulk)return;
  p??=await this.pack(agent);const worn=new Set((state.equipment_items??[]).map(i=>i.id));
  const protectedNames=[...(state.autopilot_status?.policy?.protectedItems??[]),...(state.autopilot_status?.policy?.vaultItems??[])];
  const floors=state.autopilot_status?.loadout_retention?.carry_floors??{};
  for(const item of p.items){
   if(worn.has(item.id)||!braxSaleCargo(item.name)||protectedNames.some(n=>String(item.name).toLowerCase().includes(String(n).toLowerCase())))continue;
   const floor=Number(Object.entries(floors).find(([n])=>n.toLowerCase()===item.name.toLowerCase())?.[1]??0),surplus=count(p.items,item.name)-floor;
   const stock=weighItem(item.name);if(!stock||surplus<=0)continue;
   const required=Math.max(stock.weight>0?Math.ceil(Math.max(0,wanted.weight-free.weight)/stock.weight):0,stock.bulk>0?Math.ceil(Math.max(0,wanted.bulk-free.bulk)/stock.bulk):0);
   const n=Math.min(item.amount>0?item.amount:1,surplus,Math.max(1,required));
   const receipt=await this.transfer(agent,this.runner,item,n,p.ids_as_of);await this.event('recipient-room-export',{agent,item:item.name,quantity:receipt?.quantity??0,for:name});
   if(receipt?.quantity>0){free=(await this.read(agent)).carry?.room_for;if(!free||free.weight>=wanted.weight&&free.bulk>=wanted.bulk)return;} // Continue with different surplus until a whole provision fits.
  }
 }
 async deliverLocal(){
  if(this.stopped)return;const upper=await this.read(this.runner),locals=await this.localFarmers(upper.room.num);locals.sort((a,b)=>{const healer=x=>(x.actor.abilities?.spells??[]).some(s=>/minor heal|major heal|hospice/i.test(s.name));return Number(healer(b))-Number(healer(a))||a.state.hp.max-b.state.hp.max;});
  for(const {actor,state}of locals){if(this.stopped)return;const a=actor.shadow_account;if(a===this.runner||state.hp.value/state.hp.max<.9)continue;
   const need=braxNeeds(actor,(await this.pack(a)).items,{protectedNames:[...(state.autopilot_status?.policy?.protectedItems??[]),...(state.autopilot_status?.policy?.vaultItems??[])]});
   for(const [name,want]of Object.entries(need)){if(want<=0)continue;await this.makeDeliveryRoom(actor,name);const p=await this.pack(this.runner),wear=new Set(((await this.read(this.runner)).equipment_items??[]).map(i=>i.id)),items=p.items.filter(i=>i.name===name||name==='herb'&&i.name==='herbs');const reserve=await this.reserve(this.runner,name);
    let left=Math.min(want,Math.max(0,items.reduce((n,i)=>n+(i.amount>0?i.amount:1),0)-reserve));
    for(const item of items){if(wear.has(item.id))continue;const n=Math.min(left,item.amount>0?item.amount:1);if(n>0){const sent=await this.transfer(this.runner,a,item,n,p.ids_as_of);left-=sent?.quantity??0;}if(!left)break;}
   }
  }
  await this.cacheLocalRemainder();
 }
 async cacheLocalRemainder(){
  if(this.stopped||!this.cacheDelivery)return;const state=await this.read(this.runner);if(state.room?.num!==827||state.in_game===false||state.connected===false)return;
  const demand=await this.needs(),recipients=demand.filter(r=>r.agent!==this.runner&&Object.values(r.needs).some(n=>n>0));if(!recipients.length)return;
  const p=await this.pack(this.runner),worn=new Set((state.equipment_items??[]).map(i=>i.id)),protectedNames=[...(state.autopilot_status?.policy?.protectedItems??[]),...(state.autopilot_status?.policy?.vaultItems??[])].map(itemNameKey),budgets=new Map(),items=[];
  for(const i of p.items){const name=/^herbs?$/.test(i.name)?'herb':i.name;if(!/^(hammer|herb|elderberry|loaf of bread)$/.test(name)||worn.has(i.id)||protectedNames.some(n=>n&&itemNameKey(i.name).includes(n)))continue;
   const wanted=recipients.reduce((n,r)=>n+(r.needs[name]??0),0);if(!wanted)continue;
   const retain=await this.reserve(this.runner,name,state);if(!budgets.has(name))budgets.set(name,Math.max(0,p.items.filter(x=>(/^herbs?$/.test(x.name)?'herb':x.name)===name).reduce((n,x)=>n+(x.amount>0?x.amount:1),0)-retain));const amount=Math.min(i.amount>0?i.amount:1,budgets.get(name),wanted);if(amount>0){items.push({id:i.id,name:i.name,amount,retain});budgets.set(name,budgets.get(name)-amount);}
  }
  if(!items.length)return;const result=await this.cacheDelivery({agent:this.runner,items,recipients:recipients.map(r=>({agent:r.agent,items:r.needs}))});await this.event('delivery-cache-result',{agent:this.runner,result});
  if(result?.uncertain)await this.event('delivery-cache-reconciliation-required',{agent:this.runner,reason:result.reason});
 }
 async collectLocal({cargo=true}={}){
  if(this.stopped)return;const here=await this.read(this.runner);const locals=(await this.localFarmers(here.room.num)).filter(x=>x.actor.shadow_account!==this.runner&&x.state.hp.value/x.state.hp.max>=.9).sort((a,b)=>(b.actor.purse??0)-(a.actor.purse??0));
  let donors=0;for(const {actor,state}of locals){if(donors>=3)break;const a=actor.shadow_account,p=await this.pack(a),worn=new Set((state.equipment_items??[]).map(i=>i.id));
   const protectedNames=[...(state.autopilot_status?.policy?.protectedItems??[]),...(state.autopilot_status?.policy?.vaultItems??[])];
   const cash=p.items.find(i=>/^shillings?$/.test(i.name));if(cash?.amount>1500&&count((await this.pack(this.runner)).items,'shilling')<10000){await this.transfer(a,this.runner,cash,Math.min(5000,cash.amount-1000),p.ids_as_of);donors++;}
   const candidates=cargo?p.items.filter(i=>!worn.has(i.id)&&!protectedNames.some(n=>String(i.name).toLowerCase().includes(String(n).toLowerCase()))&&braxSaleCargo(i.name)).slice(0,2):[];
   for(const i of candidates){await this.transfer(a,this.runner,i,Math.min(i.amount>0?i.amount:1,10),p.ids_as_of);donors++;}
  }
 }
 async townTravel(agent,to){
  let s=await this.read(agent);if(s.room.num===to)return;const before=s,startedAt=Date.now(),deadline=startedAt+600000;await this.phase(agent,'Jasper travel');
  const r=await this.call('travel',{agent,to,max_hops:6,run_errands:false,avoid:[579,826,827,828,829,830,831,832,833]},600000),returnedAt=Date.now();
  await observeCourierJourney({agent,to,before,result:r,read:this.read,deadline,wait:this.wait,emit:e=>this.event(e.kind,e)});
  await this.event('town-travel',{agent,to,result:r,arrivedAt:Date.now(),startedAt});
 }
 async sell(agent,room,merchant){await this.townTravel(agent,room);const before=await this.pack(agent);const r=await this.atMerchant(merchant,()=>this.call('sell_all',{agent,merchant,keep:['hammer','herb','elderberry','bread','mushroom','meat pie','stew','cheese','wand','quest','signet'],max_weapons:1,max_offers:12,skip_names:['hammer','herb','herbs','elderberry','elderberries','loaf of bread','loaves of bread']},180000));const after=await this.pack(agent);await this.event('sale',{agent,merchant,beforeCash:count(before.items,'shilling'),afterCash:count(after.items,'shilling'),result:r});return r;}
 async procure(agent){
  await this.phase(agent,'Jasper procurement');const rows=await this.needs(),need={};for(const r of rows)for(const[k,n]of Object.entries(r.needs))need[k]=(need[k]??0)+n;
  await this.sell(agent,374,'Quintor');
  // Reagents/gems go to an explicitly trusted real reagent buyer, never the bank.
  await this.sell(agent,373,"Zhieu B'hob");
  const ctx={agent,state:{},call:this.call};
  const goods=[['loaf of bread',371,'Pietro',48],['hammer',374,'Quintor',8],['herb',373,"Zhieu B'hob",80],['elderberry',373,"Zhieu B'hob",50]];
  // Buy the courier's own travel kit before bulk cargo can consume its pack.
  // Pool medicine is compact; extra hammers follow it, then remaining meals.
  const own=await Promise.all(goods.map(async g=>[...g,await this.reserve(agent,g[0])]));
  const orders=[...own.map(g=>({...Object.fromEntries(['name','room','seller','cap','reserve'].map((k,i)=>[k,g[i]])),own:true})),
    ...[own[2],own[3],own[1],own[0]].map(g=>({...Object.fromEntries(['name','room','seller','cap','reserve'].map((k,i)=>[k,g[i]])),own:false}))];
  for(const {name,room,seller,cap,reserve,own}of orders){
   const target=own?reserve:braxCourierTarget(name,need[name],cap,reserve);
   for(let attempt=0;attempt<cap;attempt++){
    const p=await this.pack(agent),remaining=target-count(p.items,name);if(remaining<=0)break;
    const state=await this.read(agent),unit=weighItem(name),free=state.carry?.room_for,margin=own?16:256;
    // Native full-pack evidence refuted a one-unit last-gap estimate. Keep a
    // real own-kit margin and256units for return loot during pool procurement.
    // Full couriers cannot export the runner's loot to make room for supplies.
    const fits=unit&&free&&state.carry?.known&&state.carry?.load?.exact===true?Math.max(0,Math.min(remaining,
      unit.weight>0?Math.floor(Math.max(0,free.weight-margin)/unit.weight):remaining,
      unit.bulk>0?Math.floor(Math.max(0,free.bulk-margin)/unit.bulk):remaining)):0;
    if(!fits){await this.event('procurement-capacity-deferred',{agent,item:name,requested:remaining,room_for:free??null,ownKit:own});break;}
    await this.townTravel(agent,room);
    const receipt=await this.atMerchant(seller,()=>buyCourierGoods(ctx,{seller,item:name,aliases:name==='herb'?['herbs']:[],amount:fits,evidenceDir:this.evidenceDir}));await this.event('purchase',{agent,item:name,receipt});
    if(['unreconciled','blocked'].includes(receipt.status)){await this.event('purchase-needs-reconciliation',{agent,item:name,receipt,note:'No repeat of this item purchase; other confirmed cargo may still be delivered.'});break;}
    if(receipt.status!=='confirmed'||!(receipt.quantity>0))break;
   }
  }
  await this.townTravel(agent,350);
 }
 async waitExchangeReady(agent,{timeoutMs=180000,now=Date.now}={}){
  const end=now()+timeoutMs,baselines=new Map(),approaches=new Map(),recoveries=new Map(),lastStates=new Map();
  for(;;){
   if(this.stopped)throw Error('service stopped before exchange readiness');let ready=true;
   for(const [a,role]of [[this.runner,'farmer'],[agent,'courier']]){
    const s=await this.read(a),old=baselines.get(a);
    if(old&&(s.pid!==old.pid||s.character!==old.character||(s.autopilot_status?.last_death?.at??0)>old.death||Number.isFinite(s.hp?.max)&&s.hp.max<old.max))throw Error('exchange body changed '+a);
    if(s.room?.num===1||Number.isFinite(s.hp?.value)&&s.hp.value<=0)throw Error('exchange body died '+a);
    if(!old&&Number.isInteger(s.pid)&&s.character&&Number.isFinite(s.hp?.max))baselines.set(a,{pid:s.pid,character:s.character,max:s.hp.max,death:s.autopilot_status?.last_death?.at??0});
    const summary={agent:a,role,hp:s.hp,room:s.room?.num,position:s.you,connected:s.connected,in_game:s.in_game,job:s.job?.busy??null,movement:s.movement?.order??null,work:s.autopilot_status?.faculties?.work,cast:s.autopilot_status?.cast_rite?.active??false,recovery:s.autopilot_status?.survival_decisions?.current??null};
    const stateKey=JSON.stringify([summary.hp,summary.room,summary.position?.x,summary.position?.y,summary.connected,summary.in_game,summary.job,summary.movement?.ordered_by,summary.work,summary.cast,summary.recovery?.id,summary.recovery?.status]);
    if(lastStates.get(a)!==stateKey){lastStates.set(a,stateKey);await this.event('exchange-readiness-observation',summary);}
    const protectedStage=(s.autopilot_status?.ladder?.in_flight??[]).some(r=>['passFightBack','passFleeAndRest','passUnderworld'].includes(r.stage));
    const canRequestRecovery=s.in_game===true&&s.connected===true&&s.hp?.max>0&&s.hp.value/s.hp.max<.9&&!s.job?.busy&&!s.movement?.order&&!s.combat?.active&&!s.autopilot_status?.cast_rite?.active&&s.autopilot_status?.faculties?.work==='keeper'&&!s.autopilot_status?.recovery_travel&&!isActiveRecoveryDecision(s.autopilot_status?.survival_decisions?.current)&&!protectedStage;
    if(canRequestRecovery&&this.recover){
     if(this.stopped||now()>=end)throw Error('exchange readiness ended before recovery');if((recoveries.get(a)??0)>=2)throw Error('exchange health recovery budget exhausted '+a);recoveries.set(a,(recoveries.get(a)??0)+1);ready=false;
     await this.phase(a,'waiting for safe exchange');await this.event('exchange-explicit-health-goal',{agent:a,role,hp:s.hp,health:1,why:'stationary trade admission exceeds the idle rest trigger'});await this.recover(a,{role,health:1});continue;
    }
    const quiet=s.in_game===true&&s.connected===true&&s.hp?.max>0&&s.hp.value/s.hp.max>=.9&&!s.job?.busy&&!s.movement?.order&&!s.combat?.active&&!s.autopilot_status?.cast_rite?.active&&s.autopilot_status?.faculties?.work==='keeper'&&(this.notReadyUntil.get(a)??0)<=now();
    if(!quiet){ready=false;continue;}
    const stand=role==='farmer'?{x:2352,y:2208}:{x:2256,y:2208};
    if(s.room.num!==578||!Number.isFinite(s.you?.x)||!Number.isFinite(s.you?.y)||Math.hypot(s.you.x-stand.x,s.you.y-stand.y)>12){
     if(this.stopped||now()>=end)throw Error('exchange readiness ended before reapproach');if((approaches.get(a)??0)>=2)throw Error('exchange reapproach budget exhausted '+a);approaches.set(a,(approaches.get(a)??0)+1);ready=false;
     await this.event('exchange-known-ended-reapproach',{agent:a,role,room:s.room.num,hp:s.hp});await this.runLeg(a,role,'out');
    }
   }
   if(ready){await this.event('exchange-native-ready',{agents:[this.runner,agent]});return;}
   if(now()>=end)throw Error('native exchange readiness timed out');
   await this.phase(agent,'waiting for safe exchange');await this.phase(this.runner,'waiting for safe exchange');await this.wait(Math.min(1000,Math.max(1,end-now())));
  }
 }
 async exchange(agent,{lowerOut,startLowerOut}={}){
  await this.runnerMode('idle');await this.phase(this.runner,'collecting');const s=await this.read(this.runner);if(s.room.num===827){await this.deliverLocal();const awaiting=(await this.needs()).some(r=>Object.values(r.needs).some(n=>n>0));if(awaiting)await this.event('loot-collection-deferred-for-provisions',{agent:this.runner});await this.collectLocal({cargo:!awaiting});}
  if(this.stopped){if(lowerOut)await Promise.allSettled([lowerOut]);throw Error('service stopped before new exchange approaches');}
  await this.phase(this.runner,'outbound');if(!lowerOut&&startLowerOut)lowerOut=startLowerOut();const approaches=await Promise.allSettled([this.runLeg(this.runner,'farmer','out'),lowerOut??Promise.resolve()]);const failed=approaches.find(r=>r.status==='rejected');if(failed)throw failed.reason;await this.waitExchangeReady(agent);await this.collectLocal();await this.phase(this.runner,'exchange');await this.phase(agent,'exchange');
  // Free the tighter pack first, then load again after verified exports make room.
  // Each bounded pass takes fresh inventory; an ambiguous transfer still throws.
  const upperCap=(await this.read(this.runner)).carry?.room_for,lowerCap=(await this.read(agent)).carry?.room_for;const free=p=>Math.min(p?.weight??0,p?.bulk??0);
  const demand={};for(const row of await this.needs())for(const [name,n]of Object.entries(row.needs))demand[name]=(demand[name]??0)+n;
  const provisionName=name=>/^herbs?$/.test(name)?'herb':name;
  const stock=(items,name)=>items.filter(i=>provisionName(i.name)===name).reduce((n,i)=>n+(i.amount>0?i.amount:1),0);
  const handoff=async from=>{
   const to=from===this.runner?agent:this.runner,p=await this.pack(from),state=await this.read(from),worn=new Set((state.equipment_items??[]).map(i=>i.id));
   const rank=name=>name==='hammer'&&demand.hammer>0?-1:/^herbs?$/.test(name)?0:name==='loaf of bread'?1:name==='elderberry'?2:3;
   const chosen=from===agent?p.items.filter(i=>/^(hammer|herbs?|elderberry|loaf of bread)$/.test(i.name)).sort((a,b)=>rank(a.name)-rank(b.name)):p.items.filter(i=>!worn.has(i.id)&&(braxSaleCargo(i.name)||/^shillings?$/.test(i.name)));
   const budgets=new Map(),protectedNames=[...(state.autopilot_status?.policy?.protectedItems??[]),...(state.autopilot_status?.policy?.vaultItems??[])];
   for(const item of chosen){if(this.stopped)break;if(worn.has(item.id)||from===this.runner&&protectedNames.some(n=>String(item.name).toLowerCase().includes(String(n).toLowerCase())))continue;const reserve=from===agent?await this.reserve(agent,/^herbs?$/.test(item.name)?'herb':item.name,state):/^shillings?$/.test(item.name)?500:0;if(!budgets.has(item.name)){
     let available=Math.max(0,count(p.items,item.name)-reserve);
     if(from===agent){const name=provisionName(item.name),upper=await this.pack(this.runner),reserveUpper=await this.reserve(this.runner,name);available=Math.min(available,Math.max(0,(demand[name]??0)+reserveUpper+(name==='hammer'?1:0)-stock(upper.items,name)));}
     budgets.set(item.name,available);
    }const n=Math.min(item.amount>0?item.amount:1,budgets.get(item.name),/^shillings?$/.test(item.name)?5000:100);if(n){const sent=await this.transfer(from,to,item,n,p.ids_as_of);budgets.set(item.name,budgets.get(item.name)-(sent?.quantity??0));}}
  };
  for(const from of free(lowerCap)<free(upperCap)?[agent,this.runner]:[this.runner,agent])await handoff(from);
  await handoff(agent);
  if(!this.stopped&&[agent,this.runner].some(a=>(this.notReadyUntil.get(a)??0)>Date.now())){await this.waitExchangeReady(agent);await handoff(this.runner);await handoff(agent);}
  // Other farmers may still be in upper578 during preparation.
  await this.phase(this.runner,'local distribution');await this.deliverLocal();
  await this.phase(agent,'returning');const lowerBack=this.runLeg(agent,'courier','back');this.pending.add(lowerBack);lowerBack.finally(()=>this.pending.delete(lowerBack)).catch(()=>{});
  await this.phase(this.runner,'returning');await this.runLeg(this.runner,'farmer','back');await this.phase(this.runner,'local distribution');await this.deliverLocal();await this.phase(this.runner,'farming');if(this.farmRunner&&!this.stopped)await this.runnerMode('farm');
  // Release the lane gate once upper is home and lower has cleared its stand.
  const start=Date.now();for(;;){const s=await this.read(agent);if(s.room.num!==578||Math.hypot(s.you.x-2256,s.you.y-2208)>64)break;if(Date.now()-start>60000)throw Error('lower courier did not clear exchange lane');await this.wait(1000);}return {lowerBack};
 }
 async admitLane(agent){
  const previous=this.lastLaneCourier;if(previous&&previous!==agent){const s=await this.read(previous);
   if(!Number.isInteger(s.room?.num)||s.room.num===578&&(!Number.isFinite(s.you?.x)||!Number.isFinite(s.you?.y)||Math.hypot(s.you.x-2256,s.you.y-2208)<=64))throw Error('previous courier still occupies or cannot prove clearance of ledge lane: '+previous);
  }this.lastLaneCourier=agent;
 }
 async returnEndedService(agent,role){
  const s=await this.read(agent);
  if(s.in_game!==true||s.connected!==true||!(s.hp?.value>0)||s.job?.busy||s.movement?.order||s.autopilot_status?.faculties?.work!=='keeper'){
   await this.event('service-return-deferred',{agent,role,reason:'native body or released control not proved'});return false;
  }
  const home=role==='farmer'?827:350;
  if(s.room?.num!==home){
   if(!(role==='farmer'?[578,826]:[578,568]).includes(s.room?.num))return false;
   await this.phase(agent,'returning after ended service');await this.runLeg(agent,role,'back');
  }
  const after=await this.read(agent);
  if(after.room?.num!==home||!(after.hp?.value>0))return false;
  await this.event('service-return-confirmed',{agent,role,room:home});return true;
 }
 async failedUpper(agent,error){
  await this.phase(this.runner,'service stalled');
  try{if(await this.returnEndedService(this.runner,'farmer')){
   if(this.farmRunner&&!this.stopped)await this.runnerMode('farm');
   await this.phase(this.runner,'farming');await this.event('runner-farm-restored-after-ended-service-failure',{agent:this.runner,courier:agent,serviceError:error.message});
  }}catch(e){await this.event('runner-service-stalled',{agent:this.runner,courier:agent,error:e.message});}
 }
 async worker(agent,{until=Infinity,maxCycles=Infinity}={}){
  for(let n=0;n<maxCycles&&!this.stopped&&Date.now()<until;n++){
   try{let s=await this.read(agent);if(s.room.num===578){await this.phase(agent,'returning');await this.runLeg(agent,'courier','back');}
    await this.procure(agent);await this.phase(agent,'waiting for ledge lane');
    const exchange=this.upperGate.catch(()=>{}).then(async()=>{if(this.stopped||Date.now()>=until)return{skipped:true};let lowerOut;try{await this.admitLane(agent);await this.phase(agent,'waiting for upper preparation');const startLowerOut=()=>{if(!lowerOut){lowerOut=(async()=>{await this.phase(agent,'outbound');if(this.stopped)throw Error('service stopped before lower approach');return this.runLeg(agent,'courier','out');})();lowerOut.catch(()=>{});this.pending.add(lowerOut);}return lowerOut;};const done=await this.exchange(agent,{startLowerOut});if(!lowerOut)throw Error('exchange did not start the owned lower approach');await lowerOut;return done;}catch(error){if(lowerOut)await Promise.allSettled([lowerOut]);await this.failedUpper(agent,error);throw error;}finally{if(lowerOut)this.pending.delete(lowerOut);}});this.upperGate=exchange.then(()=>{},()=>{});const done=await exchange;if(done.skipped)break;await done.lowerBack;this.cycles[agent]=(this.cycles[agent]??0)+1;await this.event('cycle-complete',{agent,cycles:this.cycles[agent]});
   }catch(e){await this.phase(agent,'needs attention');await this.event('service-failure',{agent,error:e.message,receipt:e.receipt??null});
    // A failed receipt is never replayed. Released ordinary legs may still go
    // home with their remaining cargo; ambiguous/live jobs receive no new order.
    try{await this.returnEndedService(agent,'courier');}catch(back){await this.event('service-return-failed',{agent,error:back.message});}
    throw e;}

  }
 }
 async run(options={}){const result=await Promise.allSettled(this.couriers.map(a=>this.worker(a,options)));await Promise.allSettled([...this.pending]);return result;}
 stop(){this.stopped=true;}
}
