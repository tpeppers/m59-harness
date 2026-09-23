// Keepers are separate processes. A shared disappearance is one clearance, not
// a kill credited to every attacker. Preserve each observer's blocker_event too.
import {mkdirSync,readFileSync,writeFileSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fleetName,ledgerDirFor} from './m59-fleetpath.mjs';
import {recordEvent} from './m59-ledger.mjs';
export function recordBlockerClearance(character,detail,{directory=ledgerDirFor(fleetName()),now=Date.now(),emit=recordEvent}={}) {
  if(/[\\/]m59-[a-z-]+-test\.mjs$/.test(process.argv[1]??'') && !process.env.M59_LEDGER_DIR)
    return {id:null,duplicate:null,unavailable:'test ledger directory required'};
  const dir=join(directory,'blocker-clearances');
  const key=createHash('sha256').update(JSON.stringify([detail.server,detail.room_num,detail.room_object_id,
    detail.target_id,detail.target])).digest('hex');
  const file=join(dir,key+'.json'),lock=file+'.lock';
  let locked=false;
  try {
    mkdirSync(dir,{recursive:true});mkdirSync(lock);locked=true;
    let old;try{old=JSON.parse(readFileSync(file,'utf8'));}catch{}
    // Short correlation interval covers concurrent attackers' delayed reads.
    // Object IDs are not permanent creature identities, so never suppress forever.
    if(old && now-old.at>=0 && now-old.at<10_000)return {id:old.id,duplicate:true};
    const id=randomUUID();writeFileSync(file,JSON.stringify({id,at:now}));
    emit(character,'blocker_clearance',{...detail,clearance_id:id,
      evidence:'target disappeared; killing blow and cause not attributed'});
    return {id,duplicate:false};
  } catch(e) {
    // Never block survival on another process or failed telemetry storage.
    return {id:null,duplicate:null,unavailable:e.code??e.message};
  } finally {if(locked)try{rmdirSync(lock);}catch{}}
}
