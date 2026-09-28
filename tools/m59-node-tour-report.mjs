#!/usr/bin/env node
// Summarize full circuits separately from partial replays and individual arrivals.
import {readFileSync} from 'node:fs';
import {TOUR_NODES,tourComplete,insideNode} from './m59-node-tour.mjs';
const file=process.argv[2];if(!file)throw Error('Usage: node tools/m59-node-tour-report.mjs <tours.jsonl>');
const rows=readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const full=rows.filter(r=>r.from_step===0&&r.complete===true&&tourComplete(r));
const groups=new Map();
for(const r of full){
  const key=JSON.stringify([r.checkout_sha,r.broker_sha,r.movement_epoch,r.recipe_sha256,r.rail_sha256,
    r.start.room,r.start.x_client,r.start.y_client,r.start.floor_client,r.setup?.quiet]);
  const g=groups.get(key)??[];g.push(r);groups.set(key,g);
}
const repeated=[...groups.values()].filter(g=>new Set(g.filter(r=>r.setup?.independent_reset&&r.scene_ref).map(r=>r.scene_ref)).size>=3);
console.log(JSON.stringify({attempts:rows.length,full_starts:rows.filter(r=>r.from_step===0).length,complete_circuits:full.length,
  repeatable_circuit:repeated.length>0,repeat_groups:repeated.map(g=>g.map(r=>r.id)),
  nodes:TOUR_NODES.map(stone=>({stone,arrivals:rows.filter(r=>r.nodes?.some(n=>n.stone===stone&&insideNode(n.position,stone))).length,
    first_melds:rows.flatMap(r=>r.nodes??[]).filter(n=>n.stone===stone&&n.status==='melded').length})),
  runs:rows.map(r=>({id:r.id,from_step:r.from_step,complete:r.complete,selected_complete:r.selected_complete,
    skipped:r.selection?.skipped,selected:r.selection?.selected,nodes:r.nodes?.map(n=>n.stone),
    last_leg:r.legs?.at(-1)?.label,predicate:r.failure?.split('\n')[0]??null,receipt:r.id+'.json'}))},null,2));
