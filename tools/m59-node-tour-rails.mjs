// Rebuild the downstream circuit rails when the shared #movement epoch changes.
import {readFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {epochId} from './m59-epoch.mjs';
import {CIRCUIT_REVISION,circuitPlan} from './m59-node-circuit.mjs';
import {findRoute,checkRoute,fineEdge} from './m59-noderails.mjs';
import {roomGeometry} from './m59-ground.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export function railsNeedRefresh(baked,epoch){
  return !epoch||baked?.tour?.format!=='m59-node-circuit-rails/1'||
    baked.tour.catalog_revision!==CIRCUIT_REVISION||baked.tour.movement_epoch!==epoch;
}
export async function ensureTourRails({railFile='substrate/node-tour-rails.json',selected}={}){
  const steps=circuitPlan(selected).filter(s=>s.kind==='rail');
  if(!steps.length)return {needed:false};
  const file=resolve(root,railFile),epoch=epochId();let baked;
  try{baked=JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const refreshed=railsNeedRefresh(baked,epoch);
  if(refreshed){
    console.log('Refreshing node circuit rails from the current #movement code');
    await promisify(execFile)(process.execPath,['tools/m59-node-tour-bake.mjs','--out',file],
      {cwd:root,timeout:600000,maxBuffer:8000000,windowsHide:true});
    baked=JSON.parse(readFileSync(file,'utf8'));
  }
  for(const step of steps){
    const route=findRoute(baked,{node:step.node,direction:step.direction??'to_node',exit:step.exit??null});
    const room=baked.stones.find(s=>s.node===step.node)?.room;
    if(!route?.rail_complete||route.all_declared!==true)throw Error('missing_checked_circuit_rail_'+step.node);
    const check=checkRoute(route,{edge:fineEdge(roomGeometry(room))});
    if(!check.ok||check.skipped)throw Error('stale_circuit_rail_'+step.node);
  }
  return {needed:true,refreshed,file,movement_epoch:epoch};
}
