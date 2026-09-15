#!/usr/bin/env node
// Reusable postmortem -> scene -> paired PvP/idle simulation. No production RPC.
import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readReplay} from './m59-death-replay.mjs';
import {attributeDeath} from './m59-death-attribution.mjs';
import {replayPlayerPlan} from './m59-replay-players.mjs';
import {simulateScene} from './m59-scene-simulator.mjs';

export async function planPostMortemSimulation({file,frameId=null,attackers=null,profile,
  approximatePlayer=false}={}) {
  if(!file)throw Error('an explicit postmortem or replay bundle file is required');
  file=path.resolve(file);
  const record=JSON.parse(await readFile(file,'utf8'));
  const isBundle=record.payload?.schema==='m59-death-replay/v1';
  const bundleFile=isBundle?file:record.replay?.file
    ?path.resolve(path.dirname(file),record.replay.file):null;
  if(!bundleFile)throw Error('postmortem has no replay bundle; missing scene state cannot be reconstructed from prose');
  const bundle=await readReplay(bundleFile);
  const attribution=isBundle?null:attributeDeath(record);
  if(attackers==null) {
    if(attribution?.observed&&attribution.was_killed_by_player===true&&
      attribution.killed_by_player_is_a_guess!==true)attackers=[attribution.killer];
    else throw Error('specify attackers by exact captured player name; no confirmed player killer can be selected automatically');
  }
  if(!Array.isArray(attackers)||!attackers.length)throw Error('select at least one captured attacker');
  const options={enabled:true,attackers,...(profile?{profile}:{}),allow_approximate_player:approximatePlayer};
  const living=f=>f.scene?.actors?.find(a=>a.mine)?.vitals?.hp?.v?.value>0;
  const candidate=frameId?bundle.frames.find(f=>f.id===frameId):[...bundle.frames].reverse().find(f=>{
    if(f.at>=bundle.death.at)return false;
    if(!living(f))return false;
    try{replayPlayerPlan(f.scene,options);return true;}catch{return false;}
  });
  if(!candidate||!living(candidate))throw Error('no living checkpoint contains the selected attackers; choose a different frame or recording');
  const plan=replayPlayerPlan(candidate.scene,options);
  return {schema:'m59-postmortem-simulation-plan/v1',source:file,bundle_file:bundleFile,
    bundle_id:bundle.id,frame_id:candidate.id,captured_at:candidate.at,
    original_death:attribution,scene:structuredClone(candidate.scene),pvp:plan,options,
    limitations:['Other-player inputs and unknown attributes are modeled, not a replay of the human.',
      'The idle-player control keeps their bodies and all recorded monsters in the same scene.',
      'Survival to the time limit is censored; it does not establish that the historical victim would have survived.']};
}
export function annotatePvpTrial(row) {
  if(!row.pvp)return row;
  const actors=row.pvp.actors??[];
  const target=actors.find(a=>a.behavior==='melee')?.combat?.target;
  if(row.outcome==='died') {
    const deathAt=row.victim_hp_trace?.find(h=>h.hp===0)?.at;
    const attribution=attributeDeath({character:target,at:deathAt,text:row.victim_messages,
      threats:{players_present:actors.map(a=>a.shadow_name)}});
    const standin=attribution.observed?actors.find(a=>
      a.shadow_name.toLowerCase()===attribution.killer?.toLowerCase()):null;
    row.simulated_death={attribution,captured_player:standin?.captured_name??null,
      actor_key:standin?.actor??null};
  }
  let previous=null,loss=0;
  for(const h of row.victim_hp_trace??[]) {
    if(h.room===1)break;
    if(Number.isFinite(h.hp)&&Number.isFinite(previous))loss+=Math.max(0,previous-h.hp);
    previous=h.hp;
  }
  row.victim_observed_hp_loss=loss;
  return row;
}
export async function simulatePostMortem({file,configFile,frameId=null,attackers=null,profile,
  approximatePlayer=false,trials=3,horizonMs=15000,reload={},onTrial=()=>{},adapterFactory}={}) {
  const plan=await planPostMortemSimulation({file,frameId,attackers,profile,approximatePlayer});
  let report;
  try {
    report=await simulateScene({scene:plan.scene,configFile,trials,horizonMs,
      onTrial:row=>onTrial(annotatePvpTrial(row)),adapterFactory,
      cases:[{id:'modeled-pvp',pvp:plan.options,reload},{id:'players-idle',pvp:{...plan.options,attackers:[]},reload}]});
    return report;
  }catch(e){report=e.report;throw e;}
  finally {
    if(report) {
      const {scene,...metadata}=plan;report.postmortem=metadata;
      report.comparison=report.cases.map(c=>{
        const rows=report.runs.filter(r=>r.case===c.id);
        return {case:c.id,runs:rows.length,deaths:rows.filter(r=>r.outcome==='died').length,
          survived_window:rows.filter(r=>r.outcome==='survived_window').length,
          recovered:rows.filter(r=>r.outcome==='recovered').length,
          trials_with_attacks:rows.filter(r=>(r.pvp?.activity?.attacks??0)>0).length,
          trials_with_attack_refusals:rows.filter(r=>(r.pvp?.activity?.attack_refusals??0)>0).length,
          trials_with_hp_loss:rows.filter(r=>r.victim_observed_hp_loss>0).length,
          confirmed_standin_kills:rows.filter(r=>r.simulated_death?.captured_player!=null).length,
          cleanup_verified:rows.length>0&&rows.every(r=>r.pvp?.cleanup?.complete===true)};
      });
    }
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [action,file,...args]=process.argv.slice(2),arg=(name,def=null)=>{
    const i=args.indexOf(name);return i<0?def:args[i+1];
  };
  let report;
  const out=arg('--out',file?file+'.pvp-'+Date.now()+'.json':null);
  try {
    if(!['plan','run'].includes(action))throw Error('usage: m59-postmortem-sim.mjs plan|run POSTMORTEM_OR_BUNDLE --config PRIVATE_CONFIG [--attacker NAME] [--frame ID] [--approximate-player] [--no-monsters] [--lab-scenery] [--trials N] [--horizon-ms N] [--out REPORT]');
    const options={file,frameId:arg('--frame'),attackers:args.flatMap((a,i)=>a==='--attacker'?[args[i+1]]:[])};
    if(!options.attackers.length)options.attackers=null;
    options.approximatePlayer=args.includes('--approximate-player');
    if(action==='plan') {
      const {scene,...plan}=await planPostMortemSimulation(options);console.log(JSON.stringify(plan,null,2));
    }else {
      report=await simulatePostMortem({...options,configFile:arg('--config'),trials:Number(arg('--trials',3)),
        reload:{noMonsters:args.includes('--no-monsters'),labScenery:args.includes('--lab-scenery')},
        horizonMs:Number(arg('--horizon-ms',15000)),onTrial:r=>console.log(JSON.stringify({
          case:r.case,trial:r.trial,outcome:r.outcome,attacks:r.pvp?.activity?.attacks,
          cleanup:r.pvp?.cleanup?.complete,restore_ms:r.timings?.restore_to_start_ms}))});
      console.log(JSON.stringify({comparison:report.comparison,timing:report.timing}));
    }
  }catch(e){report=e.report;console.error(e.message);process.exitCode=1;}
  finally{if(report&&out){await writeFile(out+'.tmp',JSON.stringify(report,null,2));await rename(out+'.tmp',out);console.log('wrote '+out);}}
}
