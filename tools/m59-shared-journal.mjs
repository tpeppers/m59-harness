import {readFileSync,writeFileSync,mkdirSync,renameSync,openSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {evidenceDirFor} from './m59-fleetpath.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// All checkouts use the same endpoint-keyed journal beside the shared evidence store.
// The short mutex is atomic (wx); no socket work occurs while it is held.
export async function replaceSharedJournal(temporary,file,{rename=renameSync,now=Date.now,wait=sleep,budgetMs=2000}={}){
  const deadline=now()+budgetMs;
  for(;;){try{rename(temporary,file);return;}catch(error){
    if(!['EPERM','EACCES','EBUSY'].includes(error.code)||now()>=deadline)throw error;
    await wait(50);
  }}
}
export function sharedJournal(server,{directory=join(evidenceDirFor(),'shared-journals'),openMutex=openSync}={}){
  mkdirSync(directory,{recursive:true});
  const file=join(directory,createHash('sha256').update(server).digest('hex').slice(0,24)+'.json');
  return {file,async change(fn){
    const lock=file+'.mutex',until=Date.now()+10000;
    for(;;){let fd;
      try{fd=openMutex(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid}));}
      catch(e){
        // Windows can report a just-unlinked mutex as temporarily delete-pending.
        // Retry without deleting or interpreting an inaccessible owner's lock.
        if(e.code==='EPERM'||e.code==='EACCES'){
          if(Date.now()>until)throw Error('Shared journal mutex stayed inaccessible');
          await sleep(50);continue;
        }
        if(e.code!=='EEXIST')throw e;
        let held;
        try{held=JSON.parse(readFileSync(lock,'utf8'));}
        catch(readError){if(Date.now()>until)throw Error('Unreadable Shared journal mutex');await sleep(50);continue;}
        if(!Number.isSafeInteger(held.pid)||held.pid<=0)throw Error('Invalid Shared journal mutex owner');
        try{process.kill(held.pid,0);}catch(dead){if(dead.code==='ESRCH'){unlinkSync(lock);continue;}throw dead;}
        if(Date.now()>until)throw Error('Shared journal is busy');await sleep(50);continue;}
      try{const value=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
        const next=fn(value);if(next!==undefined){const tmp=file+'.'+randomUUID();writeFileSync(tmp,JSON.stringify(next));await replaceSharedJournal(tmp,file);}return next??value;
      }finally{closeSync(fd);unlinkSync(lock);}
    }
  }};
}
