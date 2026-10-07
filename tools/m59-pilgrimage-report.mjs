#!/usr/bin/env node
// Summarize saved world tours, including unfinished trips rather than just survivors.
// node tools/m59-pilgrimage-report.mjs RESULT.json [MORE.json] [--out REPORT.json]
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function percentile(values, fraction) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  return sorted.length ? sorted[Math.max(0,Math.ceil(fraction*sorted.length)-1)] : null;
}
function durations(rows) {
  const values=rows.map(r=>r.ms);
  return {n:values.length,median_ms:percentile(values,.5),p90_ms:percentile(values,.9),
    p95_ms:percentile(values,.95),max_ms:percentile(values,1)};
}
export function summarizeTour(result) {
  if(result.schema!=='m59-pilgrimage-result/v1'||!Array.isArray(result.results))throw Error('expected a saved pilgrimage result');
  const finish=Number(result.finished_at),began=Number(result.measurement_began_at);
  if(!Number.isFinite(finish)||!Number.isFinite(began)||finish<=began)throw Error('invalid measurement interval');
  const completed=result.results.flatMap(r=>(r.legs??[]).map(l=>({...l,agent:r.agent,character:r.character})));
  const unfinished=result.results.filter(r=>r.outcome!=='arrived'&&r.legBegan!=null&&Number.isFinite(Number(r.legBegan))).map(r=>({
    agent:r.agent,character:r.character,from:r.legFrom??r.inn,to:r.to,ended:r.ended,outcome:r.outcome,
    ms:Math.max(0,(r.outcome==='refused'&&Number.isFinite(r.began)&&Number.isFinite(r.ms)
      ?Math.min(finish,r.began+r.ms):finish)-Number(r.legBegan)),failed:r.outcome==='refused',deaths:Math.max(0,(r.deaths??0)-(r.deathsAtLegStart??0)),censored:true}));
  const fullP90=percentile(completed.map(r=>r.ms),.9);
  const pairs=[...new Set([...completed,...unfinished].map(r=>`${r.from}>${r.to}`))].sort().map(pair=>{
    const matches=r=>`${r.from}>${r.to}`===pair,c=completed.filter(matches),u=unfinished.filter(matches);
    return {pair,completed:durations(c),completed_deaths:c.reduce((n,r)=>n+(r.deaths??0),0),
      unfinished:u.length,failed_dispatches:u.filter(r=>r.failed).length,unfinished_max_age_ms:percentile(u.map(r=>r.ms),1),
      // Censoring only provides a LOWER bound on full-trip duration. It is not a completed-trip percentile.
      all_attempts_p90_lower_bound_ms:percentile([...c,...u].map(r=>r.ms),.9)};
  });
  const hours=(finish-began)/3600000,deaths=result.results.reduce((n,r)=>n+(r.deaths??0),0);
  return {direction:result.direction,seed:result.seed,actors:result.results.length,window_ms:finish-began,
    source:result.provenance?.harness??result.provenance,completed_legs:completed.length,
    completed_full_circuits:result.results.reduce((n,r)=>n+Math.floor((r.legs?.length??0)/result.ring.length),0),
    actors_with_arrivals:result.results.filter(r=>r.legs?.length).length,polled_deaths:deaths,
    actors_with_polled_deaths:result.results.filter(r=>r.deaths>0).length,
    legs_per_actor_hour:completed.length/(result.results.length*hours),
    polled_deaths_per_100_legs:completed.length?100*deaths/completed.length:null,
    completed:durations(completed),unfinished:unfinished.length,failed_dispatches:unfinished.filter(r=>r.failed).length,
    unfinished_older_than_completed_p90:fullP90==null?null:unfinished.filter(r=>r.ms>fullP90).length,
    all_attempts_p90_lower_bound_ms:percentile([...completed,...unfinished].map(r=>r.ms),.9),pairs,
    slowest_completed:completed.sort((a,b)=>b.ms-a.ms).slice(0,10),
    oldest_unfinished:unfinished.sort((a,b)=>b.ms-a.ms).slice(0,10),
    limitations:['Deaths are polled Underworld entries; reconcile postmortem event times separately.',
      'All-attempt duration percentiles are lower bounds: unfinished trips are right-censored; refused dispatches stop aging at refusal.',
      'First-leg duration includes staggered launch preparation. Different starting states, windows, seeds and monster timers confound comparisons.']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2),i=args.indexOf('--out'),out=i<0?null:args[i+1];
  if(i>=0)args.splice(i,2);
  if(!args.length||args.some(x=>x.startsWith('--')))throw Error('provide saved result paths [--out new.json]');
  const report={schema:'m59-pilgrimage-comparison/v1',runs:args.map(file=>({file:resolve(file),...summarizeTour(JSON.parse(readFileSync(file,'utf8')))}))};
  if(out)writeFileSync(resolve(out),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  for(const r of report.runs)console.log(JSON.stringify({file:r.file,direction:r.direction,legs:r.completed_legs,deaths:r.polled_deaths,
    p90_seconds:r.completed.p90_ms/1000,unfinished:r.unfinished,unfinished_above_p90:r.unfinished_older_than_completed_p90,
    legs_per_actor_hour:r.legs_per_actor_hour}));
}
