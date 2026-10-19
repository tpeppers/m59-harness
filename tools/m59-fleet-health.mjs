// Read only fleet observations; the game protocol does not expose another player's HP.
import{mkdirSync,readFileSync,writeFileSync,renameSync}from'node:fs';import{join}from'node:path';import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';
const defaultDir=fileURLToPath(new URL('../substrate/fleet-health/',import.meta.url));
const fold=s=>String(s??'').trim().toLowerCase();
const key=({host,port,character})=>createHash('sha256').update(JSON.stringify([fold(host),Number(port),fold(character)])).digest('hex');
export function publishFleetHealth(s,{directory=process.env.M59_FLEET_HEALTH_DIR??defaultDir,now=Date.now()}={}){
 const c=s.client,credentials=s.credentials;
 if(!c?.combatReady||c.state!=='game'||!credentials?.host||!c.me?.name||!c.self||!s.world?.room?.num)return false;
 const identity={host:credentials.host,port:Number(credentials.port),character:c.me.name};
 const health=c.vitals()?.health;if(!(health?.max>0)||!Number.isFinite(health.value))return false;
 const version=JSON.stringify([identity,c.selfId,s.world.room.num,health.value,health.max]);
 if(version===s._healthPublishedVersion&&now-(s._healthPublishedAt??0)<500)return false;
 const report={at:now,pid:process.pid,character:c.me.name,endpoint:{host:fold(credentials.host),port:Number(credentials.port)},body_id:c.selfId,room:s.world.room.num,health:{value:health.value,max:health.max}};
 try{mkdirSync(directory,{recursive:true});const file=join(directory,key(identity)+'.json'),tmp=file+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(report));renameSync(tmp,file);s._healthPublishedAt=now;s._healthPublishedVersion=version;return true;}catch{return false;}
}
export function readFleetHealth(identity,{directory=process.env.M59_FLEET_HEALTH_DIR??defaultDir,now=Date.now(),maxAgeMs=5000,room,bodyId}={}){
 try{const r=JSON.parse(readFileSync(join(directory,key(identity)+'.json'),'utf8'));
  if(r.endpoint?.host!==fold(identity.host)||r.endpoint?.port!==Number(identity.port)||fold(r.character)!==fold(identity.character)||r.room!==room||r.body_id!==bodyId||!Number.isFinite(r.at)||r.at>now||now-r.at>maxAgeMs||!(r.health?.value>0)||!(r.health.max>=r.health.value))return null;
  return r;
 }catch{return null;}
}
