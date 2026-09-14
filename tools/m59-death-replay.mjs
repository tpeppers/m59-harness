#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function readReplay(file) {
  const envelope=JSON.parse(await readFile(file,'utf8'));
  if(envelope.sha256!==digest(envelope.payload))throw Error('replay checksum mismatch');
  if(envelope.payload?.schema!=='m59-death-replay/v1')throw Error('unsupported replay schema');
  return envelope.payload;
}
export function replayFrame(bundle,id=null) {
  const f=id?bundle.frames.find(f=>f.id===id):bundle.frames.find(f=>f.scene?.actors?.find(a=>a.mine)?.vitals?.hp?.v?.value>0);
  if(!f)throw Error('no living replay checkpoint found');
  return f;
}
export function decisionSignature(rows) {
  // Compare actual selection/path changes, not just the name of a strategy.
  const result=[];let previous=null;
  for(const r of rows) {
    if(!['chosen','updated'].includes(r?.event))continue;
    const d=r.decision,p=d.chosen_refuge;
    const row={event:r.event,strategy:d.strategy,reason_code:d.reason_code,source:d.source??'keeper',
      refuge:p?{room:p.room??null,row:p.row,col:p.col,x:p.x??null,y:p.y??null}:null,
      path:d.path??null,path_length:d.path_length??null};
    const key=JSON.stringify(row);
    if(key!==previous||r.event==='chosen')result.push(row);previous=key;
  }
  return result;
}
export function firstPassChecklist(bundle,{frameId=null,candidate='nearest_refuge'}={}) {
  const frame=replayFrame(bundle,frameId),following=bundle.frames.slice(bundle.frames.indexOf(frame)+1);
  const latest=new Map();
  for(const f of following)if(f.event?.decision)latest.set(f.event.decision.id,f.event.decision);
  for(const d of bundle.death?.detail?.survival_decisions?.history??[])
    if(d.chosen_at>=frame.at)latest.set(d.id,d);
  const active=frame.scene.controller?.decision;if(active)latest.set(active.id,latest.get(active.id)??active);
  const activated=[...latest.values()].filter(d=>d.activated_at!=null);
  const strategies=[...new Set(activated.map(d=>d.strategy).filter(s=>s!=='yield_to_controller'))];
  const cancelled=[...latest.values()].filter(d=>d.cancelled_at&&d.outcome!=='arrived'&&d.replacement_id)
    .sort((a,b)=>a.cancelled_at-b.cancelled_at);
  const cases=[{id:'baseline',kind:'baseline',question:'Does the recorded death recur with the captured code and decisions?'}];
  if(!strategies.length)cases.push({id:`enable-${candidate}`,kind:'enable',strategy:candidate,
    question:'Would starting one intervention at this checkpoint change the outcome?',
    note:'No activation was recorded; this does not establish that every intervention was disabled.'});
  for(const strategy of strategies)cases.push({id:`disable-${strategy}`,kind:'disable',strategies:[strategy],
    question:`Would suppressing ${strategy} change the outcome?`});
  if(strategies.length>1)cases.push({id:'disable-activated',kind:'disable',strategies,
    question:'Would suppressing all activated strategies change the outcome?'});
  if(cancelled.length) {
    const d=cancelled[0];
    cases.push({id:'continue-first-cancelled',kind:'continue',decision:d,
      question:'Would completing the first cancelled intervention change the outcome?',
      checkpoint_hint:bundle.frames.find(f=>f.event?.decision?.id===d.id&&f.event.decision.selected_at)?.id??null});
  }
  return {frame_id:frame.id,captured_at:frame.at,policy:frame.scene.controller?.policy??null,
    activated_strategies:strategies,cases,unknowns:frame.scene.notes,
    survival_window_ms:Math.max(1000,(bundle.death.at-frame.at)+15000),
    baseline_decisions:decisionSignature(following.map(f=>f.event).filter(Boolean))};
}
export function baselineVerdict({bundle,frame,result,expected,attestation}) {
  const reasons=[],source=bundle.provenance?.harness;
  if(!source?.commit||attestation?.harness?.commit!==source.commit)reasons.push('harness commit mismatch or unknown');
  if(!source?.source_sha256||attestation?.harness?.source_sha256!==source.source_sha256)reasons.push('loaded source manifest mismatch or unknown');
  if(!frame.scene.capture?.complete_visible_positions)reasons.push('incomplete or predicted starting positions');
  if(frame.scene.capture?.complete_controller===false)reasons.push('truncated controller state');
  if((bundle.capture?.dropped??0)>0||(bundle.capture?.errors??0)>0)reasons.push('capture dropped frames or reported errors');
  if(bundle.provenance?.server?.image_id&&result?.server_attestation?.image_id!==bundle.provenance.server.image_id)
    reasons.push('attested server image differs');
  if(result?.loaded?.ok!==true||result?.loaded?.landed?.ok!==true)reasons.push('restored scene did not verify');
  if(result?.player_state?.ok===false)reasons.push('known player state differs');
  if(result?.outcome!=='died')reasons.push('original death did not recur');
  if(JSON.stringify(decisionSignature(result?.decisions??[]))!==JSON.stringify(expected))reasons.push('survival decision sequence diverged');
  const elapsed=bundle.death.at-frame.at,tolerance=Math.max(5000,elapsed*0.25);
  if(!Number.isFinite(result?.elapsed_ms)||Math.abs(result.elapsed_ms-elapsed)>tolerance)reasons.push('death timing diverged');
  const originalRoom=bundle.death?.detail?.where?.room;
  if(originalRoom!=null&&result.death_room!==originalRoom)reasons.push('death room diverged');
  return {valid:reasons.length===0,reasons,
    scope:'baseline behavior reproduced from client-observed state; hidden server state remains unverified'};
}

// The adapter owns server IO; all variants use its SAME shared scene loader/reset.
// Failed baselines stop the experiment. No counterfactual is reported as evidence.
export async function runFirstPass(bundle,{adapter,frameId=null,candidate='nearest_refuge',baselineRuns=3,trials=3,onResult=()=>{}}={}) {
  if(!Number.isInteger(baselineRuns)||baselineRuns<1||!Number.isInteger(trials)||trials<1)throw Error('positive trial counts required');
  const frame=replayFrame(bundle,frameId),checklist=firstPassChecklist(bundle,{frameId:frame.id,candidate});
  const report={schema:'m59-death-replay-report/v1',bundle_id:bundle.id,frame_id:frame.id,
    started_at:new Date().toISOString(),provenance:bundle.provenance,checklist,runs:[],
    validation:{valid:false,status:'pending'},strategies:[],
    interpretation:'Each variant starts from a freshly restored scene. Survival at the observation horizon is censored, not proof of a saved life.'};
  const attestation=await adapter.attest();report.replay_provenance=attestation;
  // Refuse code mismatches before any scene mutation, not after a misleading run.
  const source=bundle.provenance?.harness;
  if(!source?.commit||attestation?.harness?.commit!==source.commit||
      !source.source_sha256||attestation?.harness?.source_sha256!==source.source_sha256) {
    report.validation={valid:false,status:'code_mismatch',reasons:['run from the captured commit and source manifest']};
    await adapter.close?.();report.finished_at=new Date().toISOString();return report;
  }
  try {
    for(let i=0;i<baselineRuns;i++) {
      const result=await adapter.run({scene:frame.scene,variant:checklist.cases[0],
        horizonMs:checklist.survival_window_ms,reference:bundle,frame});
      const verdict=baselineVerdict({bundle,frame,result,expected:checklist.baseline_decisions,attestation});
      const row={case:'baseline',trial:i+1,...result,validation:verdict};report.runs.push(row);await onResult(row);
      if(!verdict.valid){report.validation={...verdict,status:'baseline_not_reproduced'};return report;}
    }
    report.validation={valid:true,status:'baseline_reproduced',runs:baselineRuns,
      hidden_state:'not certified; retain state gaps and baseline variance in interpretation'};
    for(const variant of checklist.cases.slice(1))for(let i=0;i<trials;i++) {
      const result=await adapter.run({scene:frame.scene,variant,horizonMs:checklist.survival_window_ms,reference:bundle,frame});
      const row={case:variant.id,trial:i+1,...result};report.runs.push(row);await onResult(row);
    }
    for(const variant of checklist.cases) {
      const runs=report.runs.filter(r=>r.case===variant.id),valid=runs.filter(r=>r.loaded?.ok===true&&r.loaded?.landed?.ok===true&&
        r.player_state?.ok!==false&&!r.error&&r.intervention_applied!==false&&['died','recovered','survived_window'].includes(r.outcome));
      report.strategies.push({case:variant.id,runs:runs.length,valid:valid.length,
        deaths:valid.filter(r=>r.outcome==='died').length,
        recovered:valid.filter(r=>r.outcome==='recovered').length,
        survived_window:valid.filter(r=>r.outcome==='survived_window').length,
        unknown:runs.length-valid.length});
    }
  }catch(e) {report.error=e.message;report.validation={valid:false,status:'experiment_error',reasons:[e.message]};report.strategies=[];
  }finally {try{await adapter.close?.();}catch(e){report.cleanup_error=e.message;report.validation.valid=false;report.strategies=[];}
    report.finished_at=new Date().toISOString();}
  return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [action,file,...args]=process.argv.slice(2),arg=(n,d=null)=>{const i=args.indexOf(n);return i>=0?args[i+1]:d;};
  try {
    const bundle=await readReplay(file),frameId=arg('--frame');
    if(action==='checklist')console.log(JSON.stringify(firstPassChecklist(bundle,{frameId}),null,2));
    else if(action==='run') {
      const {createShadowReplayAdapter}=await import('./m59-shadow-replay.mjs');
      const adapter=await createShadowReplayAdapter({bundle,configFile:arg('--config')});
      const report=await runFirstPass(bundle,{adapter,frameId,baselineRuns:Number(arg('--baselines','3')),
        trials:Number(arg('--trials','3')),onResult:r=>console.log(JSON.stringify({case:r.case,trial:r.trial,outcome:r.outcome,validation:r.validation}))});
      const out=arg('--out',file+'.report.json');await writeFile(out,JSON.stringify(report,null,2));
      console.log(`wrote ${out}; ${report.validation.status}`);if(!report.validation.valid)process.exitCode=2;
    }else throw Error('usage: m59-death-replay.mjs checklist|run BUNDLE [--frame ID] [--config CONFIG] [--out FILE]');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
