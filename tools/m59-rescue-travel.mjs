import {load,firstAnswer} from './m59-strategies.mjs';
import {readHometown,hometownRoster} from './m59-hometowns.mjs';
import {loadBook} from './m59-transits.mjs';
import {epochFor} from './m59-epoch.mjs';
import {arrivalOptions,transitEvidence} from './m59-arrival-model.mjs';
import {inspectChalice,isChalice,performRescue} from './m59-rescue.mjs';
import {evidenceDirFor} from './m59-fleetpath.mjs';
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const norm=s=>String(s??'').toLowerCase();
let strategyCache;
export async function rescueTravelPolicy(ctx,{loaded=null}={}){
 strategyCache??=load();
 const result=await firstAnswer(loaded??await strategyCache,'rescueTravel',ctx,{onError:(...e)=>console.error('[rescueTravel]',...e)});
 return result?.answer??null;
}
// Directed crossing times for the current movement epoch, from every roster character's transit book.
export function currentEdges(){
 const epoch=epochFor();
 return transitEvidence(hometownRoster().map(r=>loadBook(r.character)),{since:epoch.dirty?Infinity:Date.parse(epoch.at)||Infinity});
}
export function affordableRescue(c,count=1){
 if((c.inventory??[]).some(i=>/token/i.test(i.name??c.rsc?.get(i.nameRsc)??'')))return null;
 const spell=(c.spells??[]).find(sp=>norm(sp.name??c.rsc.get(sp.nameRsc))==='rescue');
 const emeralds=(c.inventory??[]).filter(i=>/^emeralds?$/.test(norm(i.name??c.rsc.get(i.nameRsc)))).reduce((n,i)=>n+(i.amount||1),0);
 const karma=c.stat?.('karma')?.value,mana=c.vitals?.().mana?.value;
 return spell&&Number.isFinite(karma)&&karma>=30&&mana>=16*count&&emeralds>=count?{kind:'spell',spell_id:spell.id,uses:Math.min(2,Math.floor(mana/16),emeralds)}:null;
}
export async function rescueTravelCapabilities(s){
 const c=s.need(),out=[],spell=affordableRescue(c);
 if(spell)out.push(spell);
 const cups=(c.inventory??[]).filter(i=>isChalice(c,i));
 if(cups.length===1){const charge=await inspectChalice(s,cups[0],{fresh:true});
  const min=Math.min(...charge.possibilities.map(p=>p.remaining));
  if(charge.usable)out.push({kind:'chalice',item_id:cups[0].id,uses:/filled to the brim/i.test(charge.description)&&min>=3?2:1,charge});
 }
 return out;
}
export async function verifiedRescueContext(s,policy){
 const c=s.need();let guildHall=null;
 // Only the fresh roster packet or the exact native no-guild answer proves precedence.
 const requested=Date.now(),since=c.evSeq;
 await s.pacer.submit('read',()=>c.requestGuildInfo());
 const read=await c.waitFor({since,kinds:['guild','message'],timeoutMs:1500,match:e=>e.kind==='guild'&&e.what==='roster'||e.kind==='message'&&/You do not belong to a guild\./i.test(e.text??'')});
 const homeRoom=readHometown(s.credentials?.character)?.current?.room??null;
 if((read.events??[]).some(e=>e.kind==='message'&&/You do not belong to a guild\./i.test(e.text??'')))return {guildHall:null,homeRoom};
 if(!c.guild||!Number.isFinite(c.guild.readAt)||c.guild.readAt<requested)return null;
 if(c.guild.name){if(!policy.guildName||norm(c.guild.name)!==norm(policy.guildName))return null;guildHall=Number(policy.guildHall);if(!guildHall)return null;}
 return {guildHall,homeRoom};
}
function receiptFor(s){const dir=join(evidenceDirFor(),'rescue-travel');mkdirSync(dir,{recursive:true});return join(dir,createHash('sha256').update(JSON.stringify([s.credentials?.host,s.credentials?.port,s.credentials?.character??s.name])).digest('hex')+'.json');}
function save(file,record){const tmp=file+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(record,null,2));renameSync(tmp,file);}
// Called by Session.travel while it already owns movement. Every approach uses that
// same generation and the ordinary travel guards; no inert lease or second driver.
export async function tryRescueTravel(s,to,opts={}){
 // A map-level teleport cannot prove a requested arrival component or puzzle handoff.
 if(opts.arriveNear||opts.handOffAt||s.combat?.active)return null;
 const character=s.credentials?.character,policy=await rescueTravelPolicy({agent:s.name,character,
  spells:(s.client?.spells??[]).map(sp=>s.client.rsc.get(sp.nameRsc)),to});
 if(!policy?.enabled)return null;
 const file=receiptFor(s);let prior;try{prior=JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(prior?.pending)return {arrived:false,reason:'previous Rescue outcome needs reconciliation',rescue_receipt:file};
 const stopped=()=>s.movementWasCancelled(opts.movementGeneration,opts.controlToken)||s.combat?.active||!s.live||s.world?.room?.num===1;
 if(stopped()||Date.now()-(s.lastPlayerAttackAt??0)<600000)return null;
 const context=await verifiedRescueContext(s,policy);if(!context)return null;
 const caps=await rescueTravelCapabilities(s);if(!caps.length)return null;
 const edges=currentEdges();
 const blocked=[...(s.barredRooms??[]),...(opts.avoid??[]),...(policy.blocked??[])];
 const plans=arrivalOptions({map:s.world.map,from:s.world.room.num,to,...context,methods:caps,edges,
  maxRescues:policy.double===true?2:1,blocked,confine:policy.confine??[],fallbackMs:policy.fallbackMs??20000});
 const best=plans.find(p=>p.legs.reduce((n,l)=>n+(l.kind==='walk'?l.hops.length:1),0)<=(opts.maxHops??25));if(!best||!best.legs.some(l=>l.kind!=='walk'))return null;
 return executeRescuePlan(s,to,best,{policy,opts,file});
}
export async function executeRescuePlan(s,to,best,{policy,opts={},file,contextFor=verifiedRescueContext}){
 const character=s.credentials?.character;
 const stopped=()=>s.movementWasCancelled(opts.movementGeneration,opts.controlToken)||s.combat?.active||!s.live||s.world?.room?.num===1;
 const record={character,to,started_at:Date.now(),plan:best.legs,p90_ms:best.p90_ms,basis:best.basis,pending:false,steps:[]};save(file,record);
 let remainingHops=opts.maxHops??25;
 for(const [legIndex,leg] of best.legs.entries()){
  if(stopped())return {arrived:false,cancelled:true,rescue_receipt:file};
  if(s.world.room.num!==leg.from)return {arrived:false,reason:'route origin changed',rescue_receipt:file};
  if(leg.kind==='walk'){
   if(!leg.hops.length)continue;
   if(remainingHops<=0)return {arrived:false,reason:'journey hop budget exhausted',rescue_receipt:file};
   const result=await s.travel(leg.to,{...opts,maxHops:remainingHops,allowRescue:false});remainingHops-=result.hops??leg.hops.length;record.steps.push({leg,result});save(file,record);if(!result.arrived)return {...result,rescue_receipt:file};
  }else{
   if(remainingHops--<=0)return {arrived:false,reason:'journey hop budget exhausted',rescue_receipt:file};
   if(Date.now()-(s.lastPlayerAttackAt??0)<600000)return {arrived:false,reason:'PvP teleport lockout',rescue_receipt:file};
   const currentContext=await contextFor(s,policy);
   const {predictedRescueRoom}=await import('./m59-rescue.mjs');
   if(!currentContext||predictedRescueRoom(leg.from,currentContext)!==leg.to)return {arrived:false,reason:'Rescue destination changed',rescue_receipt:file};
   const fresh=await rescueTravelCapabilities(s),cap=fresh.find(c=>c.kind===leg.kind);
   const needed=best.legs.slice(legIndex).filter(l=>l.kind===leg.kind).length;
   if(!cap||cap.uses<needed)return {arrived:false,reason:'Rescue resources no longer cover the chain',rescue_receipt:file};
   // Persist BEFORE dispatch. A lost reply or process restart must never spend again.
   record.pending=true;save(file,record);
   const result=await performRescue(s,cap,{destination:leg.to,stopped,validate:()=>{
     const health=s.client?.vitals?.().health;
     return s.world.room.num===leg.from&&Number.isFinite(health?.value)&&health.value>0&&
       (leg.kind!=='spell'||!!affordableRescue(s.client,needed));
   }});
   record.steps.push({leg,result});record.pending=!!(result.pending||result.cancelled||(!result.arrived&&!result.refused));save(file,record);
   if(!result.arrived)return {...result,rescue_receipt:file};
   if(opts.onHop)await opts.onHop({room:s.world.room,hop:record.steps.length,remaining:0,via:'rescue'});
  }
 }
 record.complete=true;record.finished_at=Date.now();save(file,record);
 save(file.replace(/\.json$/, `-${record.started_at}.json`),record);
 return {arrived:s.world.room.num===to,room:{num:s.world.room.num,name:s.world.room.name},hops:(opts.maxHops??25)-remainingHops,rescue_receipt:file,via:'rescue-travel'};
}
export async function rescueTravelReadiness(s,to){
 const character=s.credentials?.character,policy=await rescueTravelPolicy({agent:s.name,character,spells:(s.client?.spells??[]).map(sp=>s.client.rsc.get(sp.nameRsc)),to});
 const base={at:Date.now(),enabled:!!policy?.enabled,methods:[],guildHall:null,homeRoom:readHometown(character)?.current?.room??null};
 if(!s.live)return {...base,unavailable:true,reason:'not in game'};
 if(s.world?.room?.num===1||!(s.client?.vitals?.().health?.value>0))return {...base,unavailable:true,reason:'not alive or health unknown'};
 try {if(JSON.parse(readFileSync(receiptFor(s),'utf8')).pending)return {...base,unavailable:true,reason:'previous Rescue outcome unresolved'};}catch(e){if(e.code!=='ENOENT')return {...base,unavailable:true,reason:'Rescue receipt unreadable'};}
 if(s.combat?.active)return {...base,unavailable:true,reason:'combat owns body'};
 if(!policy?.enabled)return {...base,reason:'private tactic not enabled; walking only'};
 if(Date.now()-(s.lastPlayerAttackAt??0)<600000)return {...base,reason:'PvP teleport lockout; walking only'};
 const context=await verifiedRescueContext(s,policy);
 if(!context)return {...base,reason:'guild destination not verified; walking only'};
 const caps=await rescueTravelCapabilities(s);
 return {...base,...context,methods:caps.map(c=>({kind:c.kind,uses:policy.double?c.uses:Math.min(1,c.uses)})),reason:caps.length?'resources inspected now':'no eligible carried chalice or affordable Rescue; walking only'};
}
