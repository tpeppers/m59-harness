// Bounded combat evidence spanning sockets and keeper handoffs. No credentials or chat.
import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {classifyCombatLine} from './m59-combatlog.mjs';
import{spellFeedback}from'./m59-healing-feedback.mjs';
import {parseDeathBroadcast,parsePersonalDeathMessage} from './m59-death-attribution.mjs';
const directory=fileURLToPath(new URL('../substrate/session-evidence/',import.meta.url));
export const sessionEvidenceKind=event=>['message','room-entered','connection','login','action','equipment','enchantment','inventory','spells'].includes(event?.kind)||event?.kind==='stat'&&['health','mana','vigor'].includes(event.name);
const copy=value=>JSON.parse(JSON.stringify(value));
export class SessionEvidence {
 constructor({host,port,character,agent,directory:dir=directory,now=Date.now,limit=160,keep=4}={}){
  this.identity={host:String(host??'').toLowerCase(),port:Number(port),character:String(character??'').trim().toLowerCase()};
  if(!this.identity.host||!this.identity.port||!this.identity.character)throw Error('session evidence requires endpoint and character');
  this.agent=agent;this.now=now;this.limit=limit;this.keep=keep;this.clients=new WeakMap();
  this.prefix=createHash('sha256').update(JSON.stringify(this.identity)).digest('hex')+'-';this.dir=dir;
  this.records=[];this.failure=null;
  this.refresh();
 }
 refresh(){
  try{for(const file of readdirSync(this.dir).filter(f=>f.startsWith(this.prefix)&&f.endsWith('.json')).sort().slice(-this.keep)){const saved=JSON.parse(readFileSync(join(this.dir,file),'utf8'));if(JSON.stringify(saved.identity)!==JSON.stringify(this.identity))continue;const record=saved.session;if(record?.id===this.active?.id)continue;const i=this.records.findIndex(r=>r.id===record.id);record.events=record.events.slice(-this.limit);if(i<0)this.records.push(record);else this.records[i]=record;}this.records.sort((a,b)=>a.startedAt-b.startedAt);this.records=this.records.slice(-this.keep);}catch{}
 }
 begin(client,{why='login',previous=null}={}){
  if(this.active&&!this.active.endedAt){this.active.endedAt=this.now();this.active.endReason='client replaced without a close observation';this.active.endObserved=false;this.save();}
  const previousSession=this.records.at(-1)?.id??null;
  const record={id:randomUUID(),previousSession,agent:this.agent??null,pid:process.pid,startedAt:this.now(),why,previous,events:[],endedAt:null};
  record.file=this.prefix+String(record.startedAt).padStart(16,'0')+'-'+record.id+'.json';
  this.records.push(record);this.records=this.records.slice(-this.keep);this.active=record;this.clients.set(client,record);this.save();return record.id;
 }
 observe(client,event,body={}){
  const record=this.clients.get(client);if(!record||record.endedAt)return false;
  const kind=event.kind;
  if(kind==='message'){
   const text=String(event.text??'');const death=parseDeathBroadcast(text);
   if(!classifyCombatLine(text)&&!spellFeedback(text)&&!parsePersonalDeathMessage(text)&&!(death&&death.who.toLowerCase()===this.identity.character)&&!/^(?:Your (?:health|mana|vigor)|You (?:cast|feel|cannot cast|can't cast|are unable to cast)|The spell|Not enough|You must wait|Your spell)/i.test(text))return false;
  }else if(!['room-entered','connection','login','action','equipment','enchantment','inventory','spells'].includes(kind)&&!(kind==='stat'&&['health','mana','vigor'].includes(event.name)))return false;
  if(kind==='stat'){const signature=JSON.stringify([event.value,event.max,body.room]);record.lastStat??={};if(record.lastStat[event.name]===signature)return false;record.lastStat[event.name]=signature;}
  // Whitelist fields; callers cannot accidentally persist credentials or arbitrary payloads.
  const entry={at:Number.isFinite(event.at)?event.at:this.now(),kind,room:body.room??null,position:body.position??null,posture_command:['stand','rest'].includes(body.posture_command?.verb)?{verb:body.posture_command.verb,at:Number.isFinite(body.posture_command.at)?body.posture_command.at:null,room_object_id:Number.isSafeInteger(body.posture_command.room_object_id)?body.posture_command.room_object_id:null}:null,vitals:body.vitals??null,ailments:Array.isArray(body.ailments)?body.ailments.filter(n=>typeof n==='string').slice(0,16).map(n=>n.slice(0,80)):null,...(body.healing_resources?{healing_resources:body.healing_resources}:{})};
  for(const key of ['name','value','max','phase','reason','opcode','text'])if(event[key]!=null)entry[key]=typeof event[key]==='string'?event[key].slice(0,600):event[key];
  if(kind==='action'&&event.opcode==='HEAL_RESULT'){
   let result;try{result=JSON.parse(event.reason);}catch{}
   if(result&&typeof result==='object'){
    const healing={};for(const key of['trigger','cast','spell','targetId','self','mana_spent','paid','health_gain','server_outcome','server_message','confirmed','stood_before_cast','poison_cleared','poison_weakened'])if(['boolean','number','string'].includes(typeof result[key]))healing[key]=typeof result[key]==='string'?result[key].slice(0,300):result[key];
    if(['stand','rest'].includes(result.posture_at_send?.verb))healing.posture_at_send={verb:result.posture_at_send.verb,at:Number.isFinite(result.posture_at_send.at)?result.posture_at_send.at:null,room_object_id:Number.isSafeInteger(result.posture_at_send.room_object_id)?result.posture_at_send.room_object_id:null};
    for(const key of['target_health_before','target_health_after']){const h=result[key];if(h&&Number.isFinite(h.value)&&Number.isFinite(h.max)&&h.value>=0&&h.max>=h.value&&h.max>0)healing[key]={value:h.value,max:h.max};}
    for(const key of['target_report_before_at','target_report_after_at'])if(Number.isFinite(result[key]))healing[key]=result[key];
    entry.healing=healing;entry.reason=JSON.stringify(healing).slice(0,600);record.lastHealing=copy(entry);
   }
  }
  // Keep reconnect/death anchors outside the rolling action window. A busy
  // fight must not erase the first login HP or the fatal transition itself.
  if(kind==='login'&&event.phase==='ready'&&!record.loginReady)record.loginReady=copy(entry);
  if(kind==='stat'&&event.name==='health'){record.firstHealth??=copy(entry);record.lastHealth=copy(entry);}
  const ownDeath=kind==='message'&&(parsePersonalDeathMessage(event.text)||parseDeathBroadcast(event.text)?.who.toLowerCase()===this.identity.character);
  if(kind==='stat'&&event.name==='health'&&event.value<=0||ownDeath){record.fatalEvidence??=[];record.fatalEvidence.push(copy(entry));record.fatalEvidence=record.fatalEvidence.slice(-8);}
  record.events.push(entry);if(record.events.length>this.limit){const dropped=record.events.length-this.limit;record.events.splice(0,dropped);record.eventsDropped=(record.eventsDropped??0)+dropped;}
  if(kind==='stat'&&event.name==='health'&&event.value<=0)this.save();else this.arm();return true;
 }
 end(client,reason,body={}){
  const record=this.clients.get(client);if(!record||record.endedAt)return false;
  this.observe(client,{kind:'connection',phase:'closed',reason},body);
  record.endedAt=this.now();record.endReason=String(reason);record.endObserved=true;this.save();return true;
 }
 arm(){if(this.timer)return;this.timer=setTimeout(()=>{this.timer=null;this.save();},1000);this.timer.unref?.();}
 save(){
  if(this.timer){clearTimeout(this.timer);this.timer=null;}
  try{mkdirSync(this.dir,{recursive:true});const file=join(this.dir,this.active.file),temp=file+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify({schema:'m59-session-evidence/v1',identity:this.identity,updatedAt:this.now(),session:this.active}));renameSync(temp,file);this.failure=null;}catch(e){this.failure=e.message;}
 }
 snapshot(){this.save();this.refresh();return copy({schema:'m59-session-evidence/v1',identity:this.identity,capturedAt:this.now(),write_error:this.failure,sessions:this.records,note:'Each socket has its own health baseline. Offline gaps and unobserved replacement boundaries are explicit; no damage or killer is inferred across them.'});}
 messages({since=-Infinity,until=Infinity}={}){return this.records.flatMap(s=>{const seen=new Set();return [...s.events,...(s.fatalEvidence??[])].filter(e=>{const key=JSON.stringify([e.at,e.kind,e.text]);if(e.kind!=='message'||e.at<since||e.at>until||seen.has(key))return false;seen.add(key);return true;}).map(e=>({...e,session_id:s.id}));});}
}
