// Standing Brax task setup. No work at import or steps() time.
import fs from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {asAgents} from './m59-fleetlib.mjs';
import {call,currentCallOrigin} from './m59-fleetscript.mjs';
import {fleetName} from './m59-fleetpath.mjs';
import {createRailObserver} from './m59-rail-observer.mjs';
import {observeCourierJourney} from './m59-courier-journey.mjs';
import {blank,loadoutPath,normalise,spellbook} from './m59-loadout.mjs';
import {buyCourierGoods} from './m59-courier-purchases.mjs';
import {braxProvisionReserve} from './m59-brax-supply.mjs';
import {islandReadOwner,checkIslandCancellation} from './m59-island-observation.mjs';
import {reserveBraxService,startBraxService,releaseBraxReservation,braxServiceStatus,localBraxBroker} from './m59-brax-service.mjs';
export {localBraxBroker} from './m59-brax-service.mjs';
const groups=new Map(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const count=(items,name)=>items.filter(i=>String(i.name).toLowerCase()===name||name==='herb'&&String(i.name).toLowerCase()==='herbs').reduce((n,i)=>n+(i.amount>0?i.amount:1),0);
export function braxFarmPlan(p){
 const couriers=asAgents(p.couriers),selected=asAgents(p.agents),farmers=selected.filter(a=>!couriers.includes(a)),runner=String(p.runner??'');
 if(new Set(selected).size!==selected.length||couriers.length!==2||new Set(couriers).size!==2||farmers.length<1||farmers.length>25||!farmers.includes(runner))
  throw Error('Brax needs 1..25 distinct farmers, exactly2 different mainland couriers, and runner=<one farmer>');
 if([...selected,...couriers].some(a=>!a||a==='all'||!/^[a-zA-Z0-9_-]+$/.test(a)))throw Error('Brax roles require explicit automated agent IDs; no all/wildcard');
 return{farmers,couriers,runner,agents:[...farmers,...couriers]};
}
export function requireAutomatedBraxActors(rows,agents){
 if(!Array.isArray(rows))throw Error('fleet visibility is unavailable; cannot distinguish human-piloted actors');
 for(const agent of agents){const row=rows.find(r=>r.agent===agent);if(!row||!Object.hasOwn(row,'piloted')||row.piloted)throw Error('Brax actor missing, unknown or human-piloted: '+agent);}
}
export function qorCaster(abilities){
 return (abilities?.spells??[]).some(s=>Number(s.ability??s.proficiency??0)>0&&String(s.school??spellbook().get(String(s.name).toLowerCase())?.school??'').toLowerCase()==='qor');
}
export function braxTaskOrders(role,{qor=false,protectedItems=null}={}){
 if(!['farmer','courier'].includes(role))throw Error('unknown Brax role');
 const farmer=role==='farmer';
 return{farm_strategy:null,buddy:null,practice_spells:null,room_enchant:null,guard_zone:null,
  assigned_room:farmer?827:null,confine_rooms:farmer?[578,826,827]:[350,371,373,374,568,578],
  movement_region:{version:1,id:farmer?'brax-farmer':'brax-mainland-courier',rooms:farmer?[578,826,827]:[350,371,373,374,568,578],
   anchors:{578:farmer?{x:2352,y:2208}:{x:2256,y:2208}}},
  ...(farmer?{hunt:['daemon skeleton','narthyl worm']}:{}),hunt_priority:farmer?(qor?['narthyl worm','daemon skeleton']:['daemon skeleton','narthyl worm']):null,
  training_style:'short_sword',training_weapon:'hammer',training_weapon_only:true,
  roam:false,town_trips:false,buy_food:false,buy_weapons:false,buy_reagents:false,farm_delivery:null,
  ...(Array.isArray(protectedItems)?{protect_items:protectedItems.filter(n=>!String('loaf of bread').includes(String(n).toLowerCase()))}:{} )};
}
const POLICY_KEYS={farm_strategy:'farmStrategy',buddy:'buddy',practice_spells:'practiceSpells',room_enchant:'roomEnchant',guard_zone:'guardZone',assigned_room:'assignedRoom',confine_rooms:'confineRooms',
 movement_region:'movementRegion',hunt:'hunt',hunt_priority:'huntPriority',training_style:'trainingStyle',training_weapon:'trainingWeapon',training_weapon_only:'trainingWeaponOnly',
 roam:'roam',town_trips:'townTrips',buy_food:'buyFood',buy_weapons:'buyWeapons',buy_reagents:'buyReagents',farm_delivery:'farmDelivery',protect_items:'protectedItems'};
export function braxPolicyMismatches(actual,orders){return Object.entries(orders).filter(([arg,value])=>POLICY_KEYS[arg]&&!isDeepStrictEqual(actual?.[POLICY_KEYS[arg]]??null,value)).map(([arg])=>arg);}
// Keep every source section and unknown note. Do not normalize the source as an editor.
export function braxTaskLoadout(raw,{character,agent,role,abilities,arrived=false}){
 const out=structuredClone(raw??blank(character,agent));
 if(out.character&&out.character.toLowerCase()!==character.toLowerCase())throw Error('loadout belongs to another character');
 out.character=character;out.agent=agent;out.policy={...out.policy,assigned_room:arrived&&role==='farmer'?827:null,buy_reagents:false};
 out.gear={...out.gear,weapon:['hammer']};out.carry??=[];
 for(const name of ['hammer','loaf of bread','herb','elderberry']){
  const min=braxProvisionReserve({abilities},name);if(!min)continue;
  let row=out.carry.find(r=>String(r.item??'').toLowerCase()===name);
  if(!row){row={item:name,min};out.carry.push(row);}else row.min=Math.max(Number(row.min)||0,min);
  if(Number.isFinite(row.max)&&row.max<row.min)row.max=row.min;
 }
 out.updated=new Date().toISOString();return out;
}
async function checkedCall(name,args,ms){const r=await call(name,args,ms);if(r?.error||r?.refused||r?.started===false&&!r?.keeper_backed)throw Error(name+': '+(r.error??r.why??r.reason??'refused'));return r;}
async function push(agent,args){const r=await checkedCall('autopilot',{agent,action:'start',mode:'idle',...args});if(r.keeper_push?.confirmed!==true)throw Error('native policy push unconfirmed '+agent);return r;}
function save(path,value){fs.mkdirSync(dirname(path),{recursive:true});const tmp=path+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,path);}
async function travel(ctx,read,to){
 const before=await read();if(before.room.num===to)return;
 const started=Date.now(),walks=(globalThis.__m59OwnWalks??=new Map()),prior=walks.get(ctx.agent);walks.set(ctx.agent,started+600000);
 try{const r=await ctx.call('travel',{agent:ctx.agent,to,run_errands:false,max_hops:30,origin:currentCallOrigin()},600000);
  if(r?.error)throw Error('preparation travel: '+r.error);
  await observeCourierJourney({agent:ctx.agent,to,before,result:r,read:()=>read(),deadline:started+600000});
 }finally{if(prior==null)walks.delete(ctx.agent);else walks.set(ctx.agent,prior);}
}
async function stockActor(ctx,actor,read,runDir){
 await read();const file=loadoutPath(actor.character),current=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
 if(!isDeepStrictEqual(current,actor.sourceLoadout))throw Error('source loadout changed after preflight '+actor.agent);
 const loadout=braxTaskLoadout(current,{...actor,arrived:false});save(file,loadout);
 const {protect_items}=braxTaskOrders(actor.role,{protectedItems:actor.sourcePolicy.protectedItems});
 await push(ctx.agent,{farm_strategy:null,assigned_room:null,confine_rooms:[],movement_region:null,buddy:null,practice_spells:null,room_enchant:null,roam:false,town_trips:false,
  buy_food:false,buy_weapons:false,buy_reagents:false,farm_delivery:null,training_style:'short_sword',training_weapon:'hammer',training_weapon_only:true,
  ...(protect_items!==undefined?{protect_items}:{})});
 const path=join(runDir,'purchases');
 for(const [name,room,seller]of [['loaf of bread',371,'Pietro'],['hammer',374,'Quintor'],['herb',373,"Zhieu B'hob"],['elderberry',373,"Zhieu B'hob"]]){
  const min=braxProvisionReserve(actor,name);if(!min)continue;
  const p=await checkedCall('inventory',{agent:ctx.agent,fresh:true});if(!Array.isArray(p.items)||p.ids_stale)throw Error('inventory unconfirmed');
  const need=Math.max(0,min-count(p.items,name));if(!need)continue;
  // A farmer already upstairs may only use ordinary Brax supplies, never go back
  // to Jasper or repeat the lift for a missing kit. Resume requires its carried kit.
  if([826,827].includes((await read()).room.num))throw Error('upstairs farmer lacks '+name+'; supply it before resuming initialization');
  await travel(ctx,read,room);
  const bought=await buyCourierGoods({agent:ctx.agent,state:{},call:checkedCall},{seller,item:name,aliases:name==='herb'?['herbs']:[],amount:need,evidenceDir:path});
  if(bought.status!=='confirmed'||bought.quantity<need)throw Error('ordinary '+name+' purchase not fully confirmed; inspect '+bought.status);
 }
 await equipBraxHammer(ctx,read);actor.prepared=true;
}
async function equipBraxHammer(ctx,read){
 const pack=await checkedCall('inventory',{agent:ctx.agent,fresh:true}),hammer=pack.items?.find(i=>i.name?.toLowerCase()==='hammer');
 if(!hammer||pack.ids_stale)throw Error('carried hammer not confirmed');
 const before=await read();if(!before.equipment_items?.some(i=>i.name?.toLowerCase()==='hammer'))await checkedCall('act',{agent:ctx.agent,verb:'use',target:hammer.id});
 const after=await read();if(!after.equipment_items?.some(i=>i.name?.toLowerCase()==='hammer'))throw Error('actual equipped hammer not confirmed');
}
export async function prepareBraxInitialization(ctx,plan){
 ctx.state.islandCancelFence??=Date.now();
 const origin=currentCallOrigin(),key=ctx.fleet+':'+origin.run_id;
 let g=groups.get(key);if(!g){g={contexts:new Map(),started:Date.now()};groups.set(key,g);}g.contexts.set(ctx.agent,ctx);
 if(!g.promise)g.promise=(async()=>{
  while(g.contexts.size<plan.agents.length){if(Date.now()-g.started>30000)throw Error('Brax initialization could not acquire every selected actor');await sleep(100);}
  const identity=await localBraxBroker(ctx.fleet);g.identity=identity;
  requireAutomatedBraxActors((await checkedCall('fleet',{refresh:true})).fleet,plan.agents);
  const readers=new Map(plan.agents.map(agent=>[agent,createRailObserver({fleet:ctx.fleet,agent})]));
  // Every participant is checked before any policy, file or game command changes.
  const actors=await Promise.all(plan.agents.map(async agent=>{
   const s=await readers.get(agent)();if(s.in_game!==true||s.connected!==true||!(s.hp?.value>0)||s.room.num===1||!s.autopilot_status?.policy||s.autopilot_status?.mode==='tick')throw Error('Brax actor is not a living native farming keeper: '+agent);
   const role=plan.couriers.includes(agent)?'courier':'farmer';if(role==='courier'&&[579,826,827].includes(s.room.num))throw Error('mainland courier is upstairs: '+agent);
   const abilities=await checkedCall('abilities',{agent,kind:'spells'});if(!Array.isArray(abilities.spells))throw Error('spell list unconfirmed '+agent);
   const remote=await checkedCall('loadout',{agent}),path=loadoutPath(s.character),sourceLoadout=fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):null;
   if(!isDeepStrictEqual(sourceLoadout?normalise(sourceLoadout).loadout:null,remote.loadout))throw Error('local/source keeper loadout differs '+agent);
   return{agent,role,character:s.character,abilities,qor:qorCaster(abilities),sourcePolicy:s.autopilot_status?.policy,sourceLoadout,
    initial:{pid:s.pid,maxHealth:s.hp.max,deathAt:s.autopilot_status?.last_death?.at??0}};
  }));
  const reservation=reserveBraxService({...identity,...plan,actors});g.reservation=reservation;g.actors=actors;
  // Immutable backups never contain account credentials. Preserve all source
  // policy and raw loadout fields, including false, zero and operator notes.
  save(join(reservation.runDir,'before.json'),{createdAt:Date.now(),actors});
  const prepared=await Promise.allSettled(actors.map(a=>{
   const c=g.contexts.get(a.agent),read=async()=>{const s=await readers.get(a.agent)();checkIslandCancellation(c,s);
    if(!islandReadOwner(c,s)||s.pid!==a.initial.pid||s.character!==a.character||s.room.num===1||!(s.hp.value>0)||s.hp.max<a.initial.maxHealth||
      (s.autopilot_status?.last_death?.at??0)>a.initial.deathAt)throw Error('Brax preparation body or controller changed '+a.agent);return s;};
   return stockActor(c,a,read,reservation.runDir);
  }));
  const errors=prepared.flatMap((r,i)=>r.status==='rejected'?[{agent:actors[i].agent,error:r.reason.message}]:[]);
  save(join(reservation.runDir,'preparation.json'),{actors:actors.map(({sourcePolicy,sourceLoadout,...a})=>a),errors});
  if(errors.length)throw Error('Brax preparation failed: '+errors.map(e=>e.agent+': '+e.error).join('; '));
  for(const c of g.contexts.values())c.state.braxInit={runDir:reservation.runDir,actor:actors.find(a=>a.agent===c.agent)};
  return {ok:true,initialization:reservation.runDir};
 })();
 try{return await g.promise;}catch(e){if(g.reservation)releaseBraxReservation(g.reservation,{reason:e.message});throw e;}
}
export async function assignBraxFarm(ctx,plan){
 const actor=ctx.state.braxInit?.actor;if(!actor)throw Error('Brax preparation receipt missing');
 const read=createRailObserver({fleet:ctx.fleet,agent:ctx.agent}),s=await read(),wanted=actor.role==='farmer'?827:350;
 checkIslandCancellation(ctx,s);if(!islandReadOwner(ctx,s)||s.room.num!==wanted||!(s.hp?.value>0))throw Error('Brax arrival/ownership not confirmed');
 const file=loadoutPath(actor.character),current=JSON.parse(fs.readFileSync(file,'utf8'));
 save(file,braxTaskLoadout(current,{...actor,arrived:true}));
 const orders=braxTaskOrders(actor.role,{qor:actor.qor,protectedItems:actor.sourcePolicy.protectedItems});await push(ctx.agent,orders);
 await equipBraxHammer(ctx,read);
 const actual=await read();
 const differences=braxPolicyMismatches(actual.autopilot_status?.policy,orders);
 const floors=actual.autopilot_status?.loadout_retention?.carry_floors??{};
 for(const name of ['hammer','loaf of bread','herb','elderberry'])if((floors[name]??0)<braxProvisionReserve(actor,name))differences.push('carry minimum '+name);
 if(differences.length)throw Error('Brax standing policy not observed: '+differences.join(', '));
 save(join(ctx.state.braxInit.runDir,'ready-'+ctx.agent+'.json'),{agent:ctx.agent,role:actor.role,character:actor.character,room:actual.room.num,at:Date.now(),orders});
 return{ok:true,role:actor.role,room:actual.room.num,hammer:true,initialization:ctx.state.braxInit.runDir};
}
export async function completeBraxInitialization(reservation,plan,result,{start=startBraxService,rpc=checkedCall}={}){
 if(!plan.agents.every(a=>result.results?.[a]?.ok===true)){releaseBraxReservation(reservation,{reason:'partial initialization; no service launched'});return{ok:false,why:'Partial Brax initialization: inspect per-agent results; couriers not started',initialization:reservation.runDir};}
 try{
  // Called only after the outer run releases every lease. Require each native
  // receipt before handing the finite initializer to the detached controller.
  for(const agent of plan.farmers){const r=await rpc('autopilot',{agent,action:'start',mode:'farm'});if(r.keeper_push?.confirmed!==true)throw Error('farm mode not confirmed '+agent);}
  const service=await start(reservation);return{ok:true,initialization:reservation.runDir,farmers:plan.farmers,couriers:plan.couriers,runner:plan.runner,service};
 }catch(e){
  // A known pre-launch failure can release its unused reservation. Once spawn
  // has been submitted, release refuses: an unknown child must not be replayed.
  releaseBraxReservation(reservation,{reason:e.message});throw e;
 }
}
export async function finishBraxInitialization({params,result}, deps={}){
 const plan=braxFarmPlan(params),fleet=fleetName(),runDir=Object.values(result.results??{}).flatMap(r=>Object.values(r.state??{})).find(r=>r?.initialization)?.initialization,
 g=[...groups.values()].reverse().find(x=>(!runDir||x.reservation?.runDir===runDir)&&x.reservation?.fleet===fleet&&x.reservation?.pid===process.pid&&
  isDeepStrictEqual(x.reservation.farmers,plan.farmers)&&isDeepStrictEqual(x.reservation.couriers,plan.couriers));
 if(!g?.reservation)return{ok:false,why:'Brax preparation did not create a service reservation',results:result.results};
 return completeBraxInitialization(g.reservation,plan,result,deps);
}
export async function resolveBraxFarmAgents(p){const plan=braxFarmPlan(p),fleet=fleetName();await localBraxBroker(fleet);requireAutomatedBraxActors((await checkedCall('fleet',{refresh:true})).fleet,plan.agents);const service=braxServiceStatus(fleet);if(service.reserved||service.status?.phase==='needs-attention')throw Error('Brax service reserved/running or needs reconciliation; inspect its status before another order');return{agents:plan.agents};}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=key=>{const i=args.indexOf('--'+key);return i<0?'':args[i+1];};
 try{if(args[0]!=='plan')throw Error('Use: node tools/m59-brax-farm.mjs plan --agents a,b --couriers c,d --runner a');
  const plan=braxFarmPlan({agents:value('agents'),couriers:value('couriers'),runner:value('runner')});
  console.log(JSON.stringify({...plan,farmerOrders:braxTaskOrders('farmer'),qorPriority:braxTaskOrders('farmer',{qor:true}).hunt_priority,
   courierOrders:braxTaskOrders('courier'),provisioning:'ordinary purchases for each carried hammer/food/heal reagent minimum; source survival settings retained',
   execution:'Fleet REPL: brax-farm agents='+plan.farmers.join(',')+' couriers='+plan.couriers.join(',')+' runner='+plan.runner},null,2));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
