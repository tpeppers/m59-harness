// Shared FleetScript/FleetScratch/CLI iteration loop. No production broker calls.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createShadowReplayAdapter} from './m59-shadow-replay.mjs';
export function summarizeLoopTimes(rows) {
  const summary=values=>{
    const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
    const middle=Math.floor(sorted.length/2);
    return sorted.length?{n:sorted.length,min_ms:sorted[0],median_ms:sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2,
      max_ms:sorted.at(-1)}:null;
  };
  return {restore_to_start:summary(rows.map(r=>r.timings?.restore_to_start_ms)),
    complete_overhead:summary(rows.map(r=>r.timing_wall_ms-(r.timings?.simulation_ms??0)))};
}
export async function simulateScene({scene,configFile,cases=[{id:'baseline'}],trials=1,
    horizonMs=10000,onTrial=()=>{},adapterFactory=createShadowReplayAdapter}={}) {
  if(!Number.isInteger(trials)||trials<1||trials>1000)throw Error('trials must be 1..1000');
  if(!Number.isInteger(horizonMs)||horizonMs<0||horizonMs>3600000)throw Error('horizonMs must be 0..3600000');
  if(!Array.isArray(cases)||!cases.length||cases.length>100)throw Error('one to 100 simulation cases required');
  if(cases.some(c=>!c||typeof c.id!=='string'||!c.id)||new Set(cases.map(c=>c.id)).size!==cases.length)
    throw Error('simulation cases require distinct nonempty ids');
  const source=typeof scene==='string'?JSON.parse(await readFile(scene,'utf8')):structuredClone(scene);
  if(!source?.actors?.length||!Number.isInteger(source.room?.num))throw Error('a captured scene is required');
  const adapter=await adapterFactory({configFile}),runs=[];
  const report={schema:'m59-scene-simulation/v1',started_at:new Date().toISOString(),completed:false,
    scene:source.name,cases,trials,horizon_ms:horizonMs,runs,
    validation:{status:'exploratory',baseline_reproduction_verified:false},
    interpretation:'All observations are exploratory. Reproducible deaths are useful even when they differ from a recording. Use the death-replay comparison workflow to measure recurrence, recording similarity and intervention outcomes separately.'};
  try {
    report.provenance=await adapter.attest?.()??null;
    for(let trial=1;trial<=trials;trial++)for(const entry of cases) {
      const input=structuredClone(source);input.controller??={};
      input.controller.policy={...input.controller.policy,...entry.policy};
      const result=await adapter.run({scene:input,frame:{at:source.capture?.at??Date.now()},
        variant:{kind:'baseline',...entry.variant,reload:entry.reload??{}},horizonMs,pvp:entry.pvp??null});
      const row={case:entry.id,trial,...result};
      if(horizonMs===0&&['survived_window','recovered'].includes(row.outcome))row.outcome='setup_only';
      runs.push(row);await onTrial(row);
      if(!row.loaded?.ok||!row.loaded?.landed?.ok||row.player_state?.ok===false||row.error||
        !['died','survived_window','recovered','setup_only'].includes(row.outcome))
        throw Error('simulation stopped after a failed setup or execution: '+entry.id);
    }
    report.completed=true;
  }catch(error){report.error=error.message;error.report=report;throw error;
  }finally {
    try{await adapter.close();}catch(error){report.completed=false;report.error??=error.message;error.report=report;throw error;}
    finally{report.finished_at=new Date().toISOString();report.timing=summarizeLoopTimes(runs);}
  }
  return report;
}
export async function runSimulationFile(file,{onTrial=()=>{}}={}) {
  const config=JSON.parse(await readFile(file,'utf8')),base=path.dirname(path.resolve(file));
  if((typeof config.scene!=='string'&&typeof config.postMortem!=='string')||typeof config.configFile!=='string')throw Error('simulation file needs scene or postMortem, and configFile paths');
  let report;
  try {
    if(config.postMortem) {
      const {simulatePostMortem}=await import('./m59-postmortem-sim.mjs');
      report=await simulatePostMortem({...config,file:path.resolve(base,config.postMortem),
        configFile:path.resolve(base,config.configFile),onTrial});
    }else report=await simulateScene({...config,scene:path.resolve(base,config.scene),
      configFile:path.resolve(base,config.configFile),onTrial});
    return report;
  }catch(error){report=error.report;throw error;
  }finally{if(config.out&&report)await writeFile(path.resolve(base,config.out),JSON.stringify(report,null,2));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  // Finish module evaluation before loading the optional postmortem driver,
  // which shares simulateScene. Top-level await here would deadlock that import.
  (async()=>{
  try {
    const report=await runSimulationFile(process.argv[2],{onTrial:r=>console.log(JSON.stringify({
      case:r.case,trial:r.trial,outcome:r.outcome,restore_ms:r.timings?.restore_to_start_ms,
      wall_ms:r.timing_wall_ms,method:r.native_restore?.method}))});
    console.log(JSON.stringify({timing:report.timing,validation:report.validation}));
  }catch(e){console.error(e.message);process.exitCode=1;}
  })();
}
