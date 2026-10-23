#!/usr/bin/env node
// Fleet-scoped, ordinary ledge supply worker. Never starts on import or restart.
import fs from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fleetName,stateFileFor,resolveControlUrl} from './m59-fleetpath.mjs';
const HERE=fileURLToPath(import.meta.url),ROOT=resolve(dirname(HERE),'..');
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&resolve(a).toLowerCase()===resolve(b).toLowerCase();
export async function localBraxBroker(fleet,{fetchImpl=fetch,root=ROOT,stateFile=stateFileFor(fleet),url=resolveControlUrl().url}={}){
 if(!url)throw Error('name M59_CONTROL_URL');const u=new URL(url);
 if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('Brax initializer must run locally on the broker host');
 const response=await fetchImpl(new URL('/health',u),{signal:AbortSignal.timeout(15000)}),health=await response.json();
 if(!response.ok||health.fleet!==(fleet||'default')||!samePath(health.state,stateFile)||!samePath(health.root,root))
  throw Error('Brax broker fleet, roster or deployed checkout does not match this initializer');
 return{fleet,stateFile:resolve(stateFile),url:u.href,root:resolve(root)};
}
function save(p,v){fs.mkdirSync(dirname(p),{recursive:true});const tmp=p+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v,null,2));fs.renameSync(tmp,p);}
export function braxServicePaths(fleet,{directory=join(ROOT,'substrate','brax-farm'),stateFile=stateFileFor(fleet)}={}){
 const key=createHash('sha256').update(resolve(stateFile).toLowerCase()).digest('hex').slice(0,20),dir=join(directory,key);
 return{dir,lock:join(dir,'controller.lock'),status:join(dir,'status.json'),stop:join(dir,'stop.json')};
}
export function braxServiceStatus(fleet,options={}){const paths=braxServicePaths(fleet,options),lock=read(paths.lock);return{reserved:!!lock,lock,status:read(paths.status),paths};}
export function reserveBraxService(config,options={}){
 const paths=braxServicePaths(config.fleet,{stateFile:config.stateFile,...options});fs.mkdirSync(paths.dir,{recursive:true});
 if(read(paths.status)?.phase==='needs-attention')throw Error('Previous Brax initialization/service needs reconciliation; inspect '+paths.status+' and archive that status only after its accepted operations are resolved');
 let fd;try{fd=fs.openSync(paths.lock,'wx');}catch(e){if(e.code==='EEXIST')throw Error('Brax controller already reserved; inspect status, never delete a live/unknown lock');throw e;}
 const token=randomUUID(),runDir=join(paths.dir,Date.now()+'-'+token),rec={...config,format:'m59-brax-service/1',paths,token,runDir,pid:process.pid,
  startedAt:Math.round(Date.now()-process.uptime()*1000),createdAt:Date.now(),phase:'initializing'};
 try{fs.writeFileSync(fd,JSON.stringify({token,pid:process.pid,startedAt:rec.startedAt,runDir,phase:'initializing'}));}
 finally{fs.closeSync(fd);}
 save(join(runDir,'manifest.json'),rec);save(paths.status,{token,phase:'initializing',pid:process.pid,runDir});return rec;
}
export function releaseBraxReservation(rec,{reason='initialization ended'}={}){
 const lock=read(rec.paths.lock);if(lock?.token!==rec.token||lock.pid!==process.pid||lock.phase!=='initializing')return false;
 save(rec.paths.status,{token:rec.token,pid:process.pid,phase:'needs-attention',reason,runDir:rec.runDir,endedAt:Date.now()});fs.unlinkSync(rec.paths.lock);return true;
}
export async function startBraxService(rec,{spawnImpl=spawn,wait=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=15000}={}){
 const lock=read(rec.paths.lock);if(lock?.token!==rec.token||lock.pid!==process.pid||lock.phase!=='initializing')throw Error('Brax startup reservation changed');
 // Persist before spawn: an uncertain launch never licenses a second child.
 save(rec.paths.lock,{...lock,phase:'starting',spawnSubmittedAt:Date.now()});
 const manifest=join(rec.runDir,'manifest.json'),fd=fs.openSync(join(rec.runDir,'controller.log'),'a');let child;
 try{
  child=spawnImpl(process.execPath,[HERE,'--worker',manifest],{cwd:rec.root,detached:true,windowsHide:true,stdio:['ignore',fd,fd],
   env:{...process.env,M59_FLEET:rec.fleet??'',M59_STATE_FILE:rec.stateFile,M59_CONTROL_URL:rec.url}});
  await new Promise((ok,fail)=>{child.once('error',fail);child.once('spawn',ok);});child.unref();
 }finally{fs.closeSync(fd);}
 const end=Date.now()+timeoutMs;
 while(Date.now()<end){const s=read(rec.paths.status),owner=read(rec.paths.lock);if(s?.token===rec.token&&s.pid===child.pid){if(s.phase==='running'&&owner?.token===rec.token&&owner.pid===child.pid)return s;if(s.phase==='needs-attention')throw Error(s.error??'Brax worker startup failed');}await wait(200);}
 // Child may be executing. Keep the reservation; NEVER spawn it again on timeout.
 throw Error('Brax worker startup outcome unknown; inspect status/log before another order');
}
export function stopBraxService(fleet,options={}){
 const current=braxServiceStatus(fleet,options);if(!current.lock)return{ok:true,stopped:true,status:current.status};
 save(current.paths.stop,{token:current.lock.token,requestedAt:Date.now()});return{ok:true,requested:true,pid:current.lock.pid,note:'No new cycles; accepted trades and return legs finish normally.'};
}
// A farmer may stand in 827, where walk-to-brax and the runner's ledge leg end,
// or in the farm room its standing assignment walks it to (828 since 2026-10-23).
export const braxFarmRoomOf=rec=>rec?.farmRoom??827;
export const braxFarmerHome=(rec,room)=>room===827||room===braxFarmRoomOf(rec);
export function braxArcherTaskArgs(rec,actor,reserve){
 const farmRoom=braxFarmRoomOf(rec),hammers=rec.actors.filter(a=>a.role==='farmer'&&!a.archery).map(a=>a.agent).join(',');
 return{agents:[actor.agent],room:farmRoom,allowed_rooms:[578,826,827,...(farmRoom===827?[]:[farmRoom])].join(','),mode:actor.archery.mode??'snipe',
  farmers:hammers,supply_from:hammers,bow:actor.archery.bow,
  supply_to:actor.archery.arrows,supply_stock:JSON.stringify(Object.fromEntries(['loaf of bread','herb','elderberry'].map(n=>[n,reserve(actor,n,{carryFloors:Object.fromEntries((actor.sourceLoadout?.carry??[]).filter(r=>r?.item).map(r=>[r.item,r.min]))})]))),
  hours:actor.archery.hours,minHealth:.9,fragileBelow:1,stop_file:rec.paths.stop,stop_token:rec.token};
}
export async function runBraxSupplyWorker(rec,{rpc,readActor,runLeg,recover,cacheDelivery,runTask,serviceFactory,verifyActors=async()=>{},verify=async()=>{}}){
 const state={token:rec.token,pid:process.pid,startedAt:Math.round(Date.now()-process.uptime()*1000),phase:'starting',runDir:rec.runDir,cycles:{},deliveries:0,actorPhases:{}};
 const persist=()=>save(rec.paths.status,{...state,updatedAt:Date.now()});
 const event=e=>{fs.appendFileSync(join(rec.runDir,'events.jsonl'),JSON.stringify({at:Date.now(),...e})+'\n');if(e.kind==='farmer-delivery-confirmed')state.deliveries++;
  if(e.kind==='cycle-complete')state.cycles[e.agent]=e.cycles;
  if(e.kind==='service-failure')(state.failures??=[]).push({agent:e.agent,error:e.error,at:Date.now()});persist();};
 const lock=read(rec.paths.lock);if(lock?.token!==rec.token||lock.phase!=='starting'||lock.pid!==rec.pid)throw Error('Brax worker cannot adopt changed startup reservation');
 save(rec.paths.lock,{...lock,pid:process.pid,startedAt:state.startedAt,phase:'running'});persist();
 let service,stopTimer,tasks=[];
 try{
  await verify();
  const allowed=new Map(rec.actors.map(a=>[a.agent,a]));
  const checkedRead=async agent=>{if(!allowed.has(agent))throw Error('actor outside Brax assignment');const s=await readActor(agent);
   const actor=allowed.get(agent),region=actor.role==='farmer'?'brax-farmer':'brax-mainland-courier';
   if(s.character!==actor.character||s.autopilot_status?.policy?.movementRegion?.id!==region)throw Error('Brax actor identity or assignment changed '+agent);return s;};
  for(const actor of rec.actors){const s=await checkedRead(actor.agent),farmer=actor.role==='farmer';
   if(!(farmer?braxFarmerHome(rec,s.room?.num):s.room?.num===350)||!(s.hp?.value>0)||s.in_game!==true||s.connected!==true||
    !s.equipment_items?.some(i=>i.name?.toLowerCase()===(actor.archery?.bow??'hammer').toLowerCase())||s.autopilot_status?.faculties?.work!=='keeper'||
    s.autopilot_status?.policy?.movementRegion?.id!==(farmer?'brax-farmer':'brax-mainland-courier'))throw Error('Brax worker qualification no longer valid '+actor.agent);
  }
  if(rec.actors.some(a=>a.archery)&&!runTask)throw Error('archer task launcher unavailable');
  const call=async(name,args,ms)=>{
   if(!['inventory','autopilot','travel','supply','shop','sell_all','equipment','abilities','delivery_notice'].includes(name))throw Error('non-logistics command refused');
   for(const key of name==='supply'?['from','to']:['agent'])if(args[key]&&!allowed.has(args[key]))throw Error('outside Brax assignment');
   if(['autopilot','travel','supply','shop','sell_all','delivery_notice'].includes(name)){
    const agents=(name==='supply'?[args.from,args.to]:[args.agent]).filter(Boolean);await verifyActors(agents);
    for(const agent of agents)await checkedRead(agent);
   }
   const r=await rpc(name,args,ms);if(r?.error)throw Error(name+': '+r.error);return r;
  };
  service=serviceFactory({actors:rec.actors.map(a=>({...a,shadow_account:a.agent,shadow_name:a.character})),runner:rec.runner,couriers:rec.couriers,
   call,read:checkedRead,
   runLeg:async(agent,...args)=>{await verifyActors([agent]);await checkedRead(agent);return runLeg(agent,...args);},
   recover:recover&& (async(agent,...args)=>{await verifyActors([agent]);await checkedRead(agent);return recover(agent,...args);}),
   cacheDelivery:cacheDelivery&& (async args=>{await verifyActors([args.agent]);await checkedRead(args.agent);return cacheDelivery(args);}),
   emit:event,phase:async(agent,phase)=>{state.actorPhases[agent]={phase,at:Date.now()};persist();},
   evidenceDir:join(rec.runDir,'purchases'),farmRunner:true,farmRoom:braxFarmRoomOf(rec)});
  const stop=()=>{if(read(rec.paths.stop)?.token===rec.token){state.phase='stopping';service.stop();persist();}};
  stopTimer=setInterval(stop,1000);stop();state.phase=service.stopped?'stopping':'running';persist();
  state.tasks={};tasks=(service.stopped?[]:rec.actors.filter(a=>a.archery)).map(async actor=>{state.tasks[actor.agent]={phase:'running',startedAt:Date.now()};persist();
   try{await verifyActors([actor.agent]);const result=await runTask(actor);state.tasks[actor.agent]={phase:result.ok?'completed':'needs-attention',result,endedAt:Date.now()};}
   catch(e){state.tasks[actor.agent]={phase:'needs-attention',error:e.message,endedAt:Date.now()};}persist();});
  const results=await service.run();if(tasks.length)save(rec.paths.stop,{token:rec.token,requestedAt:Date.now(),reason:'courier service ended'});await Promise.all(tasks);
  state.cycles=service.cycles;state.results=results.map(r=>r.status==='rejected'?{status:r.status,error:r.reason?.message}:r);
  state.phase=results.some(r=>r.status==='rejected')||Object.values(state.tasks).some(t=>t.phase==='needs-attention')?'needs-attention':'stopped';
 }catch(e){state.phase='needs-attention';state.error=e.message;service?.stop();}
 finally{clearInterval(stopTimer);
  // Even an unexpected service failure must stop and settle managed tasks
  // before releasing the fleet controller reservation.
  if(tasks.length){save(rec.paths.stop,{token:rec.token,requestedAt:Date.now(),reason:'controller ending'});await Promise.allSettled(tasks);}
  state.endedAt=Date.now();persist();if(read(rec.paths.lock)?.token===rec.token&&read(rec.paths.lock)?.pid===process.pid)fs.unlinkSync(rec.paths.lock);}
 return state;
}
async function worker(manifest){
 const rec=read(resolve(manifest)),within=rec&&relative(rec.paths.dir,resolve(manifest));if(rec?.format!=='m59-brax-service/1'||!within||within.startsWith('..')||isAbsolute(within))throw Error('invalid Brax worker manifest');
 if(resolve(rec.root)!==ROOT||resolve(rec.stateFile)!==resolve(stateFileFor(rec.fleet)))throw Error('worker checkout/roster mismatch');
 const [{call,fleetScript,withCallOrigin},{runNamed,loadFleetScripts},{script:leg},{script:rest},{BraxSupplyService,braxProvisionReserve},{publicBraxDeliveryCache},{createRailObserver}]=await Promise.all([
  import('./m59-fleetscript.mjs'),import('./m59-fleetlib.mjs'),import('./fleetscripts/brax-ledge-leg.mjs'),import('./fleetscripts/brax-service-rest.mjs'),
  import('./m59-brax-supply.mjs'),import('./m59-delivery-cache.mjs'),import('./m59-rail-observer.mjs')]);
 const readers=new Map(rec.agents.map(agent=>[agent,createRailObserver({fleet:rec.fleet,agent})])),scripts=new Map([leg,rest].map(s=>[s.name,{...s,source:'public'}]));
 if(rec.actors.some(a=>a.archery)){const loaded=(await loadFleetScripts()).scripts.get('archerplus');if(loaded?.integration?.version!==1||!loaded.integration.cooperativeStop||!loaded.integration.stationarySupply||!loaded.integration.allowedRooms)throw Error('updated private archerplus is not installed');scripts.set('archerplus',loaded);}
 const run=async(name,args)=>{const r=await runNamed(name,args,{scripts,fleetScript});if(!r.results?.[args.agents[0]]?.ok)throw Error('Brax service leg failed '+JSON.stringify(r));return r;};
 return withCallOrigin({source:'bot',name:'brax-supply',run_id:rec.token},()=>runBraxSupplyWorker(rec,{rpc:call,readActor:a=>readers.get(a)(),runLeg:(agent,role,direction)=>run(leg.name,{agents:[agent],role,direction,minHealth:.9,fragileBelow:1,farm_room:braxFarmRoomOf(rec)}),
  recover:(agent,{health})=>run(rest.name,{agents:[agent],health}),cacheDelivery:publicBraxDeliveryCache,
  runTask:actor=>runNamed('archerplus',braxArcherTaskArgs(rec,actor,braxProvisionReserve),{scripts,fleetScript}),
  serviceFactory:opts=>new BraxSupplyService(opts),verify:()=>localBraxBroker(rec.fleet),
  verifyActors:async agents=>{const rows=(await call('fleet',{refresh:true})).fleet;
   for(const agent of agents){const row=rows?.find(r=>r.agent===agent);if(!row||!Object.hasOwn(row,'piloted')||row.piloted)throw Error('Brax actor missing, unknown or human-piloted: '+agent);}
  }}));
}
if(process.argv[1]&&resolve(process.argv[1])===HERE){
 const op=process.argv[2],fleet=fleetName();
 try{if(op==='--worker')await worker(process.argv[3]);else if(op==='status')console.log(JSON.stringify(braxServiceStatus(fleet),null,2));
  else if(op==='stop')console.log(JSON.stringify(stopBraxService(fleet),null,2));else throw Error('Use: node tools/m59-brax-service.mjs status|stop --fleet <name>. Start with the brax-farm FleetScript.');}
 catch(e){console.error(e.message);process.exitCode=1;}
}
