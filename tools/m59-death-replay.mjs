#!/usr/bin/env node
import {readFile,writeFile,rename} from 'node:fs/promises';
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
    const d=r.decision;if(!d)continue;const p=d.chosen_refuge;
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
  const cases=interventionCases([...latest.values()],candidate);
  if(cancelled.length)cases.at(-1).checkpoint_hint=bundle.frames.find(f=>f.event?.decision?.id===cancelled[0].id&&f.event.decision.selected_at)?.id??null;
  return {frame_id:frame.id,captured_at:frame.at,policy:frame.scene.controller?.policy??null,
    activated_strategies:strategies,cases,unknowns:frame.scene.notes,
    survival_window_ms:Math.max(1000,(bundle.death.at-frame.at)+15000),
    baseline_decisions:decisionSignature(following.map(f=>f.event).filter(Boolean))};
}
function interventionCases(decisions,candidate) {
  const strategies=[...new Set(decisions.filter(d=>d.activated_at!=null).map(d=>d.strategy).filter(s=>s&&s!=='yield_to_controller'))];
  const cancelled=decisions.filter(d=>d.cancelled_at&&d.outcome!=='arrived'&&d.replacement_id).sort((a,b)=>a.cancelled_at-b.cancelled_at);
  const cases=[{id:'baseline',kind:'baseline',question:'Do deaths recur, and how closely do their behavior and timing match the recording?'}];
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
      question:'Would completing the first cancelled intervention change the outcome?'});
  }
  return cases;
}
export function trialUsability(result) {
  const reasons=[];
  if(result?.loaded?.ok!==true||result?.loaded?.landed?.ok!==true)reasons.push('restored scene did not verify');
  if(result?.player_state?.ok===false)reasons.push('known player state differs');
  if(result?.release?.ok===false)reasons.push('scene release failed');
  if(result?.error)reasons.push('execution error: '+result.error);
  if(!['died','recovered','survived_window'].includes(result?.outcome))reasons.push('outcome is not a completed observation');
  if(!Number.isFinite(result?.elapsed_ms)||result.elapsed_ms<0)reasons.push('observation duration is unknown');
  return {usable:reasons.length===0,reasons};
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
  const trial=trialUsability(result);reasons.push(...trial.reasons);
  if(result?.outcome!=='died')reasons.push('original death did not recur');
  if(JSON.stringify(decisionSignature(result?.decisions??[]))!==JSON.stringify(expected))reasons.push('survival decision sequence diverged');
  const elapsed=bundle.death.at-frame.at,tolerance=Math.max(5000,elapsed*0.25);
  if(!Number.isFinite(result?.elapsed_ms)||Math.abs(result.elapsed_ms-elapsed)>tolerance)reasons.push('death timing diverged');
  const originalRoom=bundle.death?.detail?.where?.room;
  if(originalRoom!=null&&result.death_room!==originalRoom)reasons.push('death room diverged');
  // `valid` retains the original helper's meaning: a close recording match.
  // It is deliberately NOT the default experiment eligibility gate anymore.
  return {valid:reasons.length===0,reasons,trial,death_observed:trial.usable&&result?.outcome==='died',
    scope:'recording similarity only; timing/route/decision differences do not invalidate an otherwise usable death experiment; root cause and hidden state remain unconfirmed'};
}

export function summarizeReplayRuns(runs,cases) {
  const counts=rows=>({deaths:rows.filter(r=>r.outcome==='died').length,
    recovered:rows.filter(r=>r.outcome==='recovered').length,
    survived_window:rows.filter(r=>r.outcome==='survived_window').length});
  return cases.map(c=>{
    const rows=runs.filter(r=>r.case===c.id),usable=rows.filter(r=>trialUsability(r).usable),
      applied=usable.filter(r=>r.case==='baseline'||r.intervention_applied===true);
    return {case:c.id,runs:rows.length,valid:applied.length,...counts(applied),
      observed:{usable:usable.length,...counts(usable)},unknown:rows.length-usable.length,
      unapplied:usable.length-applied.length,
      excluded:rows.filter(r=>!applied.includes(r)).map(r=>({trial:r.trial,reasons:trialUsability(r).usable?
        ['intervention activation/suppression was not confirmed']:trialUsability(r).reasons}))};
  });
}
export function assessBaselineRuns(rows,{criterion='reproducible-death',minDeaths=2,requested=rows.length}={}) {
  const usable=rows.filter(r=>trialUsability(r).usable),deaths=usable.filter(r=>r.outcome==='died'),
    matches=rows.filter(r=>r.recording_match?.valid),complete=rows.length===requested;
  const repeatable=deaths.length>=2;
  const qualified=complete&&(criterion==='recorded-behavior'?matches.length===requested:deaths.length>=minDeaths);
  return {valid:qualified,status:qualified?(criterion==='recorded-behavior'?'recorded_behavior_reproduced':
      repeatable?'reproducible_death':'single_death_observed'):'insufficient_baseline_evidence',
    criterion,comparisons_allowed:qualified,
    failure_reproduction:{requested,completed:rows.length,usable:usable.length,deaths:deaths.length,
      nonfatal:usable.length-deaths.length,invalid:rows.length-usable.length,required_deaths:minDeaths,repeatable},
    recording_fidelity:{matching_runs:matches.length,checked_runs:rows.length,
      all_matched:complete&&matches.length===requested,
      deviations:rows.filter(r=>!r.recording_match?.valid).map(r=>({trial:r.trial,reasons:r.recording_match?.reasons??['not assessed']}))},
    root_cause:'unconfirmed; recurrence alone does not establish that failures share a mechanism',
    scope:criterion==='recorded-behavior'?'close reproduction of the recording; hidden state remains unverified':
      'intervention experiments on this reconstructed scenario; similarity to the original death is assessed separately'};
}

// The adapter owns server IO; all variants use its SAME shared scene loader/reset.
// Preserve every observation. Capture fidelity and useful failure reproduction
// are independent questions; technical setup/execution failures are not deaths.
export async function runFirstPass(bundle,{adapter,frameId=null,candidate='nearest_refuge',baselineRuns=3,trials=3,
    criterion='reproducible-death',minDeaths=2,horizonMs=null,failureHypothesis=null,onResult=()=>{}}={}) {
  if(!Number.isInteger(baselineRuns)||baselineRuns<1||baselineRuns>1000||!Number.isInteger(trials)||trials<1||trials>1000)throw Error('trial counts must be 1..1000');
  if(!['reproducible-death','recorded-behavior'].includes(criterion))throw Error('criterion must be reproducible-death or recorded-behavior');
  if(!Number.isInteger(minDeaths)||minDeaths<1||(criterion==='reproducible-death'&&minDeaths>baselineRuns))throw Error('minDeaths must fit the requested baseline runs');
  if(horizonMs!=null&&(!Number.isInteger(horizonMs)||horizonMs<1||horizonMs>3600000))throw Error('horizonMs must be 1..3600000');
  const frame=replayFrame(bundle,frameId),checklist=firstPassChecklist(bundle,{frameId:frame.id,candidate});
  const report={schema:'m59-death-replay-report/v2',bundle_id:bundle.id,frame_id:frame.id,
    started_at:new Date().toISOString(),provenance:bundle.provenance,checklist,runs:[],
    criterion,min_deaths:minDeaths,horizon_ms:horizonMs??checklist.survival_window_ms,
    failure_hypothesis:failureHypothesis==null?null:{text:String(failureHypothesis),status:'unconfirmed'},
    validation:{valid:false,status:'pending'},strategies:[],experiment_cases:[checklist.cases[0]],completed:false,
    interpretation:'Every raw run is retained. A repeatable death can support scenario-level intervention testing despite recording differences. Similar root cause requires trace evidence. Survival at the horizon is censored, not proof of a saved life.'};
  const run=async variant=>{
    try{return await adapter.run({scene:structuredClone(frame.scene),variant:structuredClone(variant),
      horizonMs:report.horizon_ms,reference:bundle,frame});}
    catch(error){return {outcome:'error',error:error.message};}
  };
  try {
    const attestation=await adapter.attest();report.replay_provenance=attestation;
    const source=bundle.provenance?.harness;
    if(criterion==='recorded-behavior'&&(!source?.commit||attestation?.harness?.commit!==source.commit||
        !source.source_sha256||attestation?.harness?.source_sha256!==source.source_sha256)) {
      report.validation={valid:false,status:'code_mismatch',criterion,comparisons_allowed:false,
        reasons:['recorded-behavior requires the captured commit and source manifest; reproducible-death permits an attested alternative']};
      return report;
    }
    for(let i=0;i<baselineRuns;i++) {
      const result=await run(checklist.cases[0]);
      const verdict=baselineVerdict({bundle,frame,result,expected:checklist.baseline_decisions,attestation});
      const row={case:'baseline',trial:i+1,...result,trial_assessment:verdict.trial,recording_match:verdict};
      report.runs.push(row);report.validation=assessBaselineRuns(report.runs,{criterion,minDeaths,requested:baselineRuns});
      report.strategies=summarizeReplayRuns(report.runs,report.experiment_cases);await onResult(row,report);
    }
    if(!report.validation.comparisons_allowed){report.completed=true;return report;}
    // The reproduced failure may activate different protections. Test what the
    // usable baselines actually did, retaining the original checklist for context.
    const observed=[];
    for(const row of report.runs.filter(r=>r.trial_assessment.usable)) {
      const latest=new Map();
      for(const event of row.decisions??[])if(event.decision)latest.set(event.decision.id,event.decision);
      const active=frame.scene.controller?.decision;if(active&&!latest.has(active.id))latest.set(active.id,active);
      observed.push(...latest.values());
    }
    report.experiment_cases=interventionCases(observed,candidate);
    report.experiment_case_source='protections observed in usable baseline trials, including an active checkpoint decision';
    for(let i=0;i<trials;i++)for(const variant of report.experiment_cases.slice(1)) {
      const result=await run(variant),row={case:variant.id,trial:i+1,...result,trial_assessment:trialUsability(result)};
      report.runs.push(row);report.strategies=summarizeReplayRuns(report.runs,report.experiment_cases);await onResult(row,report);
    }
    report.completed=true;
  }catch(e) {report.error=e.message;report.validation={...report.validation,valid:false,status:'experiment_error',comparisons_allowed:false,reasons:[e.message]};
  }finally {try{await adapter.close?.();}catch(e){report.cleanup_error=e.message;report.validation.valid=false;report.completed=false;}
    report.strategies=summarizeReplayRuns(report.runs,report.experiment_cases);
    report.execution={observations:report.runs.length,usable:report.runs.filter(r=>trialUsability(r).usable).length,
      invalid:report.runs.filter(r=>!trialUsability(r).usable).length};
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
      const out=arg('--out',file+'.'+Date.now()+'.report.json');
      const persist=async report=>{await writeFile(out+'.tmp',JSON.stringify(report,null,2));await rename(out+'.tmp',out);};
      const report=await runFirstPass(bundle,{adapter,frameId,baselineRuns:Number(arg('--baselines','3')),
        trials:Number(arg('--trials','3')),criterion:arg('--criterion','reproducible-death'),minDeaths:Number(arg('--min-deaths','2')),
        horizonMs:arg('--horizon-ms')==null?null:Number(arg('--horizon-ms')),failureHypothesis:arg('--hypothesis'),
        onResult:async(r,report)=>{await persist(report);console.log(JSON.stringify({case:r.case,trial:r.trial,outcome:r.outcome,
          usable:r.trial_assessment.usable,intervention_applied:r.intervention_applied,
          recording_matched:r.recording_match?.valid,validation:report.validation.status}));}});
      await persist(report);
      console.log(`wrote ${out}; ${report.validation.status}`);
      if(!report.validation.valid||!report.completed||report.execution.invalid||report.cleanup_error)process.exitCode=2;
    }else throw Error('usage: m59-death-replay.mjs checklist|run BUNDLE [--frame ID] [--config CONFIG] [--criterion reproducible-death|recorded-behavior] [--baselines N] [--min-deaths N] [--trials N] [--horizon-ms N] [--hypothesis TEXT] [--out FILE]');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
