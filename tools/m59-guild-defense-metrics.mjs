// Descriptive arrival/departure statistics. Missing arrivals are never dropped
// from the fleet denominator or imputed as the capture time.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function median(values){
  const a=values.filter(Number.isFinite).sort((a,b)=>a-b),n=a.length;
  return n?(a[Math.floor((n-1)/2)]+a[Math.floor(n/2)])/2:null;
}
export function travelMetrics(report){
  const t=report.runs?.[0]?.team_experiment??report.team_experiment??{},e=t.events??[];
  const valid=report.completed===true&&report.validation?.status!=='invalid'&&!(t.errors?.length);
  const carriers=new Set(e.filter(x=>x.kind==='rescue_waiting').map(x=>x.actor));
  const ordered=e.filter(x=>x.kind==='response_order'&&!carriers.has(x.actor));
  const keys=new Set(ordered.map(x=>x.actor));
  // Early archived rounds did not yet emit method='road'.
  const arrivals=e.filter(x=>x.kind==='hall_foyer_arrival'&&x.method!=='rescue'&&!carriers.has(x.actor));
  const trace=t.trace??[],first=trace[0];
  const departures=ordered.map(o=>{
    const start=first?.actors.find(a=>a.key===o.actor),exit=trace.find(s=>s.actors.some(a=>a.key===o.actor&&a.room!==39&&a.room!==1&&a.room!=null));
    const movement=start&&trace.find(s=>s.actors.some(a=>a.key===o.actor&&Number.isFinite(a.row)&&Number.isFinite(a.col)&&(a.row!==start.row||a.col!==start.col||a.room!==start.room)));
    return {actor:o.actor,order_ms:o.ms,first_movement_observed_ms:movement?.ms??null,first_castle_exit_observed_ms:exit?.ms??null};
  });
  const n=keys.size,missing=n-arrivals.length,orderedArrival=arrivals.map(a=>a.ms).sort((a,b)=>a-b);
  const fleetMedian=n&&orderedArrival.length>Math.floor(n/2)?(orderedArrival[Math.floor((n-1)/2)]+orderedArrival[Math.floor(n/2)])/2:null;
  return {valid,road_responders:n,road_arrived:arrivals.length,road_not_arrived:missing,
    observation_end_ms:t.resolved_ms??t.stopping_snapshot?.ms??trace.at(-1)?.ms,
    fleet_p50_ms:fleetMedian,
    fleet_p50_status:fleetMedian!=null?'observed':'median not fully observed; even cohorts require both middle observations',
    half_cohort_arrived_ms:n&&arrivals.length>=Math.ceil(n/2)?orderedArrival[Math.ceil(n/2)-1]:null,
    successful_only_p50_ms:median(arrivals.map(a=>a.ms)),arrivals,departures,
    dispatch_first_ms:ordered.length?Math.min(...ordered.map(o=>o.ms)):null,
    dispatch_last_ms:ordered.length?Math.max(...ordered.map(o=>o.ms)):null,
    first_castle_exit_ms:departures.some(d=>d.first_castle_exit_observed_ms!=null)?Math.min(...departures.map(d=>d.first_castle_exit_observed_ms??Infinity)):null,
    successful_castle_exit_p50_ms:median(departures.map(d=>d.first_castle_exit_observed_ms)),
    note:'Arrival clock starts at raid activation, includes dispatch and travel. Departures are sampled; precise events supersede them. Successful-only medians exclude failures and are not fleet ETAs.'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=path.resolve(process.argv[2]??'substrate/guild-defense/rounds');
  const rounds=fs.readdirSync(root).filter(d=>fs.existsSync(path.join(root,d,'report.json'))).map(round=>({round,...travelMetrics(JSON.parse(fs.readFileSync(path.join(root,round,'report.json'))))}));
  console.log(JSON.stringify({rounds,heterogeneous_successful_only_p50_ms:median(rounds.filter(r=>r.valid).flatMap(r=>r.arrivals.map(a=>a.ms)))},null,2));
}
