// Public server death announcements witnessed by another connected fleet socket.
import{appendFileSync,mkdirSync,readFileSync}from'node:fs';import{join}from'node:path';import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';import{parseDeathBroadcast}from'./m59-death-attribution.mjs';
const directory=fileURLToPath(new URL('../substrate/death-notices/',import.meta.url));
const fold=s=>String(s??'').trim().toLowerCase();
const file=(identity,day,dir)=>join(dir,createHash('sha256').update(JSON.stringify([fold(identity.host),Number(identity.port)])).digest('hex')+'-'+day+'.jsonl');
export function recordDeathNotice(identity,event,{observer,sessionId=null,isFleetmate=()=>false,directory:dir=directory}={}){
 if(event?.kind!=='message'||!Number.isFinite(event.at)||!identity?.host||!Number(identity.port))return false;
 const death=parseDeathBroadcast(event.text);if(!death||fold(death.who)!==fold(observer)&&!isFleetmate(death.who))return false;
 try{mkdirSync(dir,{recursive:true});appendFileSync(file(identity,new Date(event.at).toISOString().slice(0,10),dir),JSON.stringify({...death,at:event.at,observer,sessionId})+'\n');return true;}catch{return false;}
}
export function findDeathNotice(identity,character,{at=Date.now(),since=at-30000,until=at+5000,directory:dir=directory}={}){
 if(!identity?.host||!Number(identity.port)||!Number.isFinite(since)||until<since||until-since>900000)return null;
 const days=new Set([new Date(since).toISOString().slice(0,10),new Date(until).toISOString().slice(0,10)]),rows=[];
 for(const day of days){try{for(const line of readFileSync(file(identity,day,dir),'utf8').split('\n')){try{const e=JSON.parse(line);if(fold(e.who)===fold(character)&&e.at>=since&&e.at<=until)rows.push(e);}catch{}}}catch{}}
 rows.sort((a,b)=>a.at-b.at);const groups=[];for(const row of rows){let g=groups.find(g=>g.text===row.text&&Math.abs(g.at-row.at)<1000);if(!g){g={...row,witnesses:[]};groups.push(g);}g.witnesses.push({observer:row.observer,sessionId:row.sessionId,at:row.at});}
 if(groups.length!==1)return null;
 return{...groups[0],source:'fleet_socket_server_announcement',dt:at-groups[0].at};
}
