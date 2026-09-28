// Read append-only m59-node-attempt/1 evidence. No network and no character control.
// node tools/m59-node-attempts.mjs substrate/node-attempts/20260928/attempts.jsonl
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { STONES } from './m59-stones.mjs';
export function summarizeAttempts(rows) {
  return ['cave','badlands','ancient','peak'].map(stone=>{
    const trials=rows.filter(r=>r.format==='m59-node-attempt/1'&&r.stone===stone);
    const s=STONES[stone];
    const arrivals=trials.filter(r=>r.navigation?.status==='reached_box'&&r.end?.room===s.room&&
      Math.abs(r.end.row-s.row)<3&&Math.abs(r.end.col-s.col)<3&&r.scene_ref&&r.route_ref&&r.start&&
      typeof r.broker_sha==='string'&&r.broker_sha!=='unknown'&&r.movement_epoch&&
      [r.start.room,r.start.x_client,r.start.y_client,r.start.floor_client].every(Number.isFinite));
    // Group by the actual script/follower revision. Different fixes are not three passes.
    const groups=new Map();
    for(const r of arrivals){const key=JSON.stringify([r.checkout_sha,r.broker_sha,r.movement_epoch,r.route_ref,
      r.start.room,r.start.x_client,r.start.y_client,r.start.floor_client,r.setup?.quiet]);const g=groups.get(key)??[];g.push(r);groups.set(key,g);}
    const repeatGroups=[...groups.values()].filter(g=>new Set(g.filter(r=>r.independent_reset===true).map(r=>r.scene_ref)).size>=3);
    const repeated=repeatGroups.length>0;
    return {stone,trials:trials.length,arrivals:arrivals.length,route_verified:repeated,
      melds:trials.filter(r=>r.objective?.status==='melded').length,
      already:trials.filter(r=>r.objective?.status==='already').length,
      escape_verified:repeatGroups.some(g=>new Set(g.filter(r=>r.escape?.verified===true).map(r=>r.scene_ref)).size>=3),
      last_commit:trials.at(-1)?.checkout_sha??null,last_predicate:trials.at(-1)?.navigation?.predicate??null};
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const rows=readFileSync(process.argv[2],'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  console.log(JSON.stringify(summarizeAttempts(rows),null,2));
}
