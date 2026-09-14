import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';
export const SURVIVAL_DECISION_DIR = process.env.M59_SURVIVAL_DECISION_DIR ||
  fileURLToPath(new URL('../substrate/survival-decisions/',import.meta.url));
const safe = v => String(v??'unknown').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80);
// One file per process and day avoids interleaving between keeper writers. Bounded
// asynchronous writes cannot hold up movement or accumulate an unlimited queue.
export function createSurvivalDecisionRecorder(agent,{dir=SURVIVAL_DECISION_DIR}={}) {
  let chain=Promise.resolve(),pending=0,errors=0,dropped=0;
  const fleet=safe(fleetName()||'default');
  const record=row=>{
    if(pending>=128){dropped++;return;}
    const day=new Date(row.at).toISOString().slice(0,10);
    const file=path.join(dir,`${fleet}-${safe(agent)}-${process.pid}-${day}.jsonl`);
    const line=JSON.stringify({...row,agent,fleet})+'\n'; pending++;
    chain=chain.then(()=>mkdir(dir,{recursive:true})).then(()=>appendFile(file,line))
      .catch(()=>{errors++;}).finally(()=>{pending--;});
  };
  record.stats=()=>({pending,errors,dropped});
  record.flush=()=>chain;
  return record;
}
