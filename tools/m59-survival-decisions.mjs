#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SURVIVAL_DECISION_DIR } from './m59-survival-decision-log.mjs';

export function summarizeSurvivalDecisions(rows) {
  const latest=new Map();
  for(const r of rows) if(r?.decision?.id) latest.set(r.decision.id,r);
  const episodes=new Map();
  for(const {decision:d} of latest.values()) {
    const key=d.episode_id??d.id;
    if(d.outcome==='recovered'||d.outcome==='died') episodes.set(key,d.outcome);
  }
  const groups=new Map();
  for(const {decision:d} of latest.values()) {
    const key=`${d.epoch??'unknown'}:${d.strategy}`;
    let g=groups.get(key);
    if(!g) groups.set(key,g={epoch:d.epoch??null,strategy:d.strategy,decisions:0,activated:0,
      arrived:0,replaced:0,outcomes:{},episodes:new Set(),recovered_episodes:new Set(),
      died_episodes:new Set(),duration_ms:[],path_lengths:[],starting_hp:[],reasons:{},damage_taken:0});
    g.decisions++;if(d.activated_at)g.activated++;if(d.arrived_at)g.arrived++;
    if(d.replacement_id)g.replaced++;
    const outcome=d.outcome??'unfinished';g.outcomes[outcome]=(g.outcomes[outcome]??0)+1;
    const ep=d.episode_id??d.id;g.episodes.add(ep);
    if(episodes.get(ep)==='recovered')g.recovered_episodes.add(ep);
    if(episodes.get(ep)==='died')g.died_episodes.add(ep);
    if(d.ended_at!=null)g.duration_ms.push(Math.max(0,d.ended_at-d.chosen_at));
    if(Number.isFinite(d.path_length))g.path_lengths.push(d.path_length);
    if(d.hp?.max>0)g.starting_hp.push(d.hp.value/d.hp.max);
    g.reasons[d.reason_code??'unknown']=(g.reasons[d.reason_code??'unknown']??0)+1;
    g.damage_taken+=d.damage_taken??0;
  }
  const mean=a=>a.length?a.reduce((a,b)=>a+b,0)/a.length:null;
  return {version:1,decisions:latest.size,
    episodes:new Set([...latest.values()].map(r=>r.decision.episode_id??r.decision.id)).size,
    resolved_episodes:episodes.size,
    caveat:'Observational associations, not lives saved. Strategies face different threats and HP. A replacement chain can include several strategies; its outcomes are not independent. Unfinished records are unknown, not deaths. Compare within the same code epoch.',
    strategies:[...groups.values()].map(g=>({...g,episodes:g.episodes.size,
      recovered_episodes:g.recovered_episodes.size,died_episodes:g.died_episodes.size,
      unknown_episodes:g.episodes.size-g.recovered_episodes.size-g.died_episodes.size,
      mean_duration_ms:mean(g.duration_ms),mean_path_length:mean(g.path_lengths),
      mean_starting_hp_fraction:mean(g.starting_hp),
      duration_ms:undefined,path_lengths:undefined,starting_hp:undefined})).sort((a,b)=>b.decisions-a.decisions)};
}

export function loadSurvivalDecisionRows(dir,{since=0}={}) {
  const rows=[];let malformed=0,files=0;
  if(!fs.existsSync(dir))return {rows,malformed,files};
  for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.jsonl')).sort()) {
    files++;
    for(const line of fs.readFileSync(path.join(dir,name),'utf8').split('\n')) {
      if(!line.trim())continue;
      try {const r=JSON.parse(line);if(r.at>=since)rows.push(r);}catch{malformed++;}
    }
  }
  rows.sort((a,b)=>a.at-b.at);
  return {rows,malformed,files};
}
export function postmortemSurvivalDecisions(pm) {
  const snapshot=pm.survival_decisions??pm.survival_trace?.survival_decisions;
  if(!snapshot)return {available:false,why:'this record predates explicit survival decisions'};
  const rows=[...(snapshot.history??[]),...(snapshot.current?[snapshot.current]:[])];
  const at=pm.at??snapshot.captured_at;
  return {available:true,history_dropped:snapshot.history_dropped??0,
    decisions:rows.slice(-12).map(d=>({id:d.id,strategy:d.strategy,reason:d.reason,
      chosen_at:d.chosen_at,chosen_ms_before_death:at-d.chosen_at,
      cancelled_at:d.cancelled_at??null,cancelled_ms_before_death:d.cancelled_at?at-d.cancelled_at:null,
      cancel_reason:d.cancel_reason??null,replacement_id:d.replacement_id,
      previous_decision_id:d.previous_decision_id,chosen_refuge:d.chosen_refuge,
      path_length:d.path_length,path_source:d.path_source,status:d.status,outcome:d.outcome,
      mitigation:d.mitigation,hp:d.hp,damage_taken:d.damage_taken}))};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2),arg=(key,fallback)=>{const i=args.indexOf(key);return i>=0?args[i+1]:fallback;};
  const window=arg('--since','24h'),m=/^(\d+(?:\.\d+)?)(h|d)$/.exec(window);
  if(!m)throw Error('--since must be a duration such as 24h or 7d');
  const dir=path.resolve(arg('--dir',SURVIVAL_DECISION_DIR));
  const input=loadSurvivalDecisionRows(dir,{since:Date.now()-Number(m[1])*(m[2]==='d'?86400000:3600000)});
  const report={...summarizeSurvivalDecisions(input.rows),dir,files:input.files,malformed:input.malformed};
  if(args.includes('--json'))console.log(JSON.stringify(report,null,2));
  else {
    console.log(`Survival decisions: ${report.decisions}; ${report.files} log files; ${report.malformed} unreadable rows`);
    console.table(report.strategies.map(g=>({epoch:g.epoch?.slice(0,12)??'unknown',strategy:g.strategy,
      decisions:g.decisions,activated:g.activated,arrived:g.arrived,replaced:g.replaced,
      recovered_episodes:g.recovered_episodes,died_episodes:g.died_episodes,unknown_episodes:g.unknown_episodes,
      mean_seconds:g.mean_duration_ms==null?null:Math.round(g.mean_duration_ms/1000)})));
    console.log(report.caveat);
  }
}
