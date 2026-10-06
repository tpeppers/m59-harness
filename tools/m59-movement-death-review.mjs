#!/usr/bin/env node
// Historical journey deaths, paired builds, and explicit inconclusive outcomes.
// Uses the ordinary shadow scene loader; never dispatches to a production broker.
import {readFile,writeFile,rename,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';import {fork} from 'node:child_process';
import {readReplay} from './m59-death-replay.mjs';
import {causeOf,locate} from './m59-postmortems.mjs';
import {deathTimeFromName} from './m59-death-tally.mjs';

export const MOVEMENT_PATCH_FILES=Object.freeze(['tools/m59-finepath.mjs','tools/m59-session-walk.mjs','tools/m59-world.mjs']);
const hash=b=>createHash('sha256').update(b).digest('hex');
export const travelObjective=c=>c?.inert?.travelling?c.inert.to:c?.suspended_journey?.to??null;
export function selectTravelCheckpoint(bundle,{frameId=null,deathRoom=null}={}) {
 const living=bundle.frames.filter(f=>f.at<bundle.death.at&&f.scene?.actors?.find(a=>a.mine)?.vitals?.hp?.v?.value>0);
 const eligible=living.filter(f=>{const a=f.scene.actors.find(a=>a.mine),p=a.at?.v,to=travelObjective(f.scene.controller);
  return Number.isInteger(Number(to))&&Number(to)>0&&p&&[p.row,p.col,p.x,p.y].every(Number.isFinite)
   &&Math.floor(p.x/64)===p.col&&Math.floor(p.y/64)===p.row;});
 if(frameId)return eligible.find(f=>f.id===frameId)??null;
 const local=eligible.filter(f=>f.scene.room.num===deathRoom),rows=(local.length?local:eligible).sort((a,b)=>a.at-b.at);
 // Prefer the actual blockage over an earlier visit/recovery in the same room.
 const active=f=>{const c=f.scene.controller,d=c.decision;return c.inert?.travelling&&(!d||['ended','yielded'].includes(d.status));};
 const pose=f=>f.scene.actors.find(a=>a.mine).at.v;
 const nearby=f=>f.scene.actors.some(a=>a.kind==='monster'&&a.at?.v&&Math.hypot(a.at.v.x-pose(f).x,a.at.v.y-pose(f).y)<=3*64);
 let start=null,last=null,stall=null,episode=null,episodeLast=null;
 for(const f of rows){
  if(!active(f)){start=null;last=null;episodeLast=null;continue;}
  // Predictions cannot prove a stall, but they do not restart the journey.
  // Otherwise its final confirmed pose can win with one hit of HP remaining.
  const sameEpisode=episodeLast&&f.at-episodeLast.at<=5000
    &&travelObjective(f.scene.controller)===travelObjective(episodeLast.scene.controller)
    &&f.scene.room.num===episodeLast.scene.room.num;
  if(!sameEpisode)episode=null;
  if(!pose(f).predicted&&!episode)episode=f;
  episodeLast=f;
  if(pose(f).predicted){start=null;last=null;continue;}
  const continuous=last&&f.at-last.at<=5000&&travelObjective(f.scene.controller)===travelObjective(last.scene.controller)&&f.scene.room.num===last.scene.room.num;
  if(!continuous||Math.hypot(pose(f).x-pose(start).x,pose(f).y-pose(start).y)>8)start=f;
  if(f.at-start.at>=2000&&nearby(f)&&bundle.death.at-start.at>=5000)stall=start;
  last=f;
 }
 if(stall&&!pose(stall).predicted)return stall;
 if(episode&&!pose(episode).predicted)return episode;
 return rows.find(f=>f.scene.controller?.inert?.travelling&&!f.scene.actors.find(a=>a.mine).at.v.predicted&&bundle.death.at-f.at>=10000)
  ??rows.find(f=>!f.scene.actors.find(a=>a.mine).at.v.predicted)??rows[0]??null;
}
export async function scanTravelDeaths({postmortemDir,rosterFile=null,since=Date.now()-14*86400000,until=Date.now()}={}) {
 if(!postmortemDir||!Number.isFinite(since)||!Number.isFinite(until)||since>=until)throw Error('explicit directory and ordered finite time window required');
 const roster=rosterFile?JSON.parse(await readFile(rosterFile,'utf8')):null;
 const names=roster?new Set(Object.values(roster).map(e=>e.credentials?.character??e.character)):null;
 const rows=[],errors=[];
 for(const file of (await readdir(postmortemDir)).filter(f=>f.endsWith('.json'))){
  const named=deathTimeFromName(file);if(Number.isFinite(named)&&(named<since||named>until))continue;
  const source=path.resolve(postmortemDir,file);let pm,bytes;
  try{bytes=await readFile(source);pm=JSON.parse(bytes);}catch(e){errors.push({file,error:e.message});continue;}
  if(pm.at<since||pm.at>until||names&&!names.has(pm.character))continue;
  const cause=causeOf(pm),where=locate(pm),row={file,source,source_sha256:hash(bytes),at:pm.at,character:pm.character,agent:pm.agent,cause,where};
  if(cause.cause_observed&&cause.was_killed_by_player===false){
   try{
    if(!pm.replay?.file)throw Error('no recorded replay scene');
    const bundleFile=path.resolve(path.dirname(source),pm.replay.file),bundle=await readReplay(bundleFile),frame=selectTravelCheckpoint(bundle,{deathRoom:where.trusted?where.num:null});
    row.replay={file:bundleFile,bundle_id:bundle.id,code:bundle.provenance?.harness,frames:bundle.frames.length,checksum_verified:true};
    if(frame){const a=frame.scene.actors.find(a=>a.mine);row.checkpoint={id:frame.id,at:frame.at,room:frame.scene.room.num,position:a.at.v,hp:a.vitals.hp.v,
     destination:travelObjective(frame.scene.controller),active_travel:!!frame.scene.controller?.inert?.travelling,
     monsters:frame.scene.actors.filter(a=>a.kind==='monster').length,other_players:frame.scene.actors.filter(a=>a.kind==='player'&&!a.mine).length};}
   }catch(e){row.replay_error=e.message;}
  }
  rows.push(row);
 }
 return {schema:'m59-travel-death-catalog/v1',window:{since,until},roster_file:rosterFile,rows,errors,
  counts:{all:rows.length,observed_nonplayer:rows.filter(r=>r.cause.cause_observed&&r.cause.was_killed_by_player===false).length,travel_candidates:rows.filter(r=>r.checkpoint).length}};
}
export function sourceAssessment(captured,actual,{patched=false,allowedFiles=MOVEMENT_PATCH_FILES}={}) {
 const want=captured?.files,got=actual?.files,reasons=[];
 if(!want||!Object.keys(want).length||!got)return {ok:false,reasons:['source file manifests unavailable'],changed:[]};
 const missing=Object.keys(want).filter(f=>!want[f]||!got[f]).concat(Object.keys(got).filter(f=>!(f in want)&&!got[f]));
 const extra=Object.keys(got).filter(f=>!(f in want));
 const changed=Object.keys(want).filter(f=>want[f]&&got[f]&&want[f]!==got[f]);
 if(missing.length)reasons.push('unknown/missing captured source files: '+missing.join(', '));
 const unapprovedExtra=extra.filter(f=>!patched||!allowedFiles.includes(f));
 if(unapprovedExtra.length)reasons.push('uncaptured source files: '+unapprovedExtra.join(', '));
 if(patched)changed.push(...extra.filter(f=>allowedFiles.includes(f)));
 if(actual.commit!==captured.commit)reasons.push('executing commit differs from captured commit');
 if(patched){if(!changed.length)reasons.push('movement patch did not change executing code');if(changed.some(f=>!allowedFiles.includes(f)))reasons.push('unrelated source changes');}
 else if(changed.length)reasons.push('original source differs from capture');
 return {ok:reasons.length===0,reasons,changed,missing,extra,captured_commit:captured.commit,captured_source_sha256:captured.source_sha256,executing_source_sha256:actual.source_sha256};
}
export function reviewTrialUsability(row) {
 const reasons=[];
 if(row.error||row.cleanup_error)reasons.push(row.error??row.cleanup_error);
 if(row.loaded?.ok!==true||row.loaded?.landed?.ok!==true||row.release?.ok!==true)reasons.push('scene placement or release did not verify');
 if(row.player_state?.ok!==true)reasons.push('player-state check failed');
 if(row.source_assessment?.ok!==true)reasons.push(...(row.source_assessment?.reasons??['source not verified']));
 if(!['died','survived_window','recovered'].includes(row.outcome))reasons.push('no completed observation');
 if(!Number.isFinite(row.elapsed_ms))reasons.push('observation duration unavailable');
 if(row.trace?.goal!==row.destination)reasons.push('travel objective not verified');
 return {usable:!reasons.length,reasons};
}
export function classifyMovementComparison(runs,{minimumBaselineDeaths=2,baselineRuns=3,patchedRuns=3}={}) {
 const original=runs.filter(r=>r.arm==='original'),fixed=runs.filter(r=>r.arm==='patched');
 const usable=r=>r.assessment?.usable===true;
 const baseline=original.filter(usable),patched=fixed.filter(usable),deaths=baseline.filter(r=>r.outcome==='died'&&(r.original_death_room==null||r.death_room===r.original_death_room)&&(!r.observed_killer||!r.original_killer||r.observed_killer.toLowerCase()===r.original_killer.toLowerCase()));
 const counts={original_runs:original.length,original_usable:baseline.length,original_deaths:deaths.length,patched_runs:fixed.length,patched_usable:patched.length,
  patched_deaths:patched.filter(r=>r.outcome==='died').length,patched_survivors:patched.filter(r=>r.outcome!=='died').length,
  patched_arrivals:patched.filter(r=>r.trace?.arrived_alive).length};
 if(original.length<baselineRuns||baseline.length<baselineRuns)return {classification:'inconclusive',reason:'original baseline is incomplete or invalid',counts};
 if(deaths.length<minimumBaselineDeaths)return {classification:'baseline_not_reproduced',reason:'original code did not reproduce enough deaths; this is not evidence that the fix could not help',counts};
 if(fixed.length<patchedRuns||patched.length<patchedRuns)return {classification:'inconclusive',reason:'baseline death reproduced; patched trials are incomplete or invalid',counts};
 const drivers=new Set([...baseline,...patched].map(r=>r.driver_provenance?.harness?.source_sha256).filter(Boolean));
 if(drivers.size>1)return {classification:'inconclusive',reason:'common test driver changed between paired trials; rerun with one driver build',counts};
 if(patched.some(r=>r.outcome!=='died'||r.trace?.arrived_alive))return {classification:'plausible',reason:'original deaths recur; at least one patched run survived the same horizon or reached the recorded goal alive',counts,
  caveat:'survival to the horizon is censored; an arrival followed by death is travel improvement, not demonstrated life saving'};
 const sameRoom=patched.every(r=>deaths.some(b=>b.death_room===r.death_room));
 return {classification:sameRoom&&patched.length>=3?'highly_improbable_at_checkpoint':'no_benefit_observed',reason:'all usable patched trials died without arrival; applies only to this reconstructed checkpoint',counts,
  caveat:'small unseeded samples do not rule out another checkpoint or server reality'};
}
export function summarizeMovementDeathReview(report,totalPlanned=report.cases.length) {
 const completed=report.cases.filter(c=>c.completed),count=label=>completed.filter(c=>c.verdict?.classification===label).length;
 const plausible=count('plausible'),improbable=count('highly_improbable_at_checkpoint'),noBenefit=count('no_benefit_observed'),paired=plausible+improbable+noBenefit;
 return {planned:totalPlanned,completed:completed.length,pending:totalPlanned-completed.length,paired_tested:paired,plausibly_fixed:plausible,
  plausibly_fixed_percent:paired?Math.round(1000*plausible/paired)/10:null,highly_improbable_at_checkpoint:improbable,no_benefit_observed:noBenefit,
  baseline_not_reproduced:count('baseline_not_reproduced'),inconclusive:count('inconclusive')};
}
async function persist(file,value){if(value.schema==='m59-movement-death-review/v1')value.summary=summarizeMovementDeathReview(value,value.planned_cases);await mkdir(path.dirname(file),{recursive:true});await writeFile(file+'.tmp',JSON.stringify(value,null,2));await rename(file+'.tmp',file);}
export function invokeReviewTrial(request,{timeoutMs=(request.horizonMs??0)+120000}={}) {
 return new Promise((resolve,reject)=>{
  const child=fork(fileURLToPath(new URL('./m59-movement-review-trial.mjs',import.meta.url)),[],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true,execArgv:[]});
  let result,error,tail='';child.stdout.on('data',d=>{tail=(tail+d).slice(-4000);});child.stderr.on('data',d=>{tail=(tail+d).slice(-4000);});
  const timer=setTimeout(()=>{error='bounded trial process timeout; native lab requires an ownership check before continuation';child.kill();},timeoutMs);
  child.on('message',m=>{if(m.result)result=m.result;if(m.error)error=m.error;});child.on('error',e=>error=e.message);
  child.on('exit',code=>{clearTimeout(timer);if(error||code!==0||!result)reject(Error(error??`worker exited ${code}: ${tail}`));else resolve(result);});child.send(request);
 });
}
export async function runMovementDeathReview(plan,{out,runTrial=invokeReviewTrial,onTrial=()=>{},resume=false}={}) {
 if(!out||!plan?.config_file||!Array.isArray(plan.cases))throw Error('plan needs config_file, explicit cases and output file');
 const config=JSON.parse(await readFile(plan.config_file,'utf8'));if(!config.native_snapshot)throw Error('paired builds require a native snapshot reset before every trial');
 const n=plan.baseline_runs??3,m=plan.patched_runs??3,min=plan.minimum_baseline_deaths??2;
 if(![n,m,min].every(x=>Number.isInteger(x)&&x>0&&x<=100)||min>n)throw Error('invalid trial counts');
 let report={schema:'m59-movement-death-review/v1',plan_hash:hash(JSON.stringify(plan)),started_at:new Date().toISOString(),scope:plan.scope??'paired original code versus isolated movement patch',planned_cases:plan.cases.length,cases:[],completed:false};
 if(resume){report=JSON.parse(await readFile(out,'utf8'));if(report.plan_hash!==hash(JSON.stringify(plan)))throw Error('resume plan differs; retain the original report and start another');}
 for(const item of plan.cases){
  if(existsSync(path.join(path.dirname(out),'STOP_REVIEW'))){report.stop_reason='STOP_REVIEW requested between cases';await persist(out,report);return report;}
  let entry=report.cases.find(c=>c.id===item.id);if(entry?.completed)continue;
  if(!entry){entry={...item,runs:[],completed:false};report.cases.push(entry);}
  if(item.skip_reason){entry.verdict={classification:'inconclusive',reason:item.skip_reason};entry.completed=true;await persist(out,report);continue;}
  const bundle=await readReplay(item.bundle_file),frame=selectTravelCheckpoint(bundle,{frameId:item.frame_id});
  if(!frame)throw Error('selected checkpoint no longer has the recorded living journey');
  const destination=Number(travelObjective(frame.scene.controller));
  const horizonMs=item.horizon_ms??Math.max(30000,bundle.death.at-frame.at+30000);
  if(!Number.isFinite(horizonMs)||horizonMs<=0)throw Error('trial horizon must be a positive finite duration');
  for(const arm of ['original','patched']){
   if(arm==='patched'&&entry.runs.filter(r=>r.arm==='original'&&r.assessment?.usable&&r.outcome==='died'&&(r.original_death_room==null||r.death_room===r.original_death_room)&&(!r.observed_killer||!r.original_killer||r.observed_killer.toLowerCase()===r.original_killer.toLowerCase())).length<min)break;
   const count=arm==='original'?n:m;
   for(let trial=1;trial<=count;trial++){
    if(entry.runs.some(r=>r.arm===arm&&r.trial===trial))continue;
    if(existsSync(path.join(path.dirname(out),'STOP_REVIEW'))){report.stop_reason='STOP_REVIEW requested between trials';await persist(out,report);return report;}
    let result;
    try{result=await runTrial({root:item[arm+'_root'],configFile:plan.config_file,bundleFile:item.bundle_file,frameId:frame.id,destination,horizonMs,
      patched:arm==='patched',allowedFiles:item.allowed_files??MOVEMENT_PATCH_FILES,reload:plan.reload??{},traceFile:path.join(path.dirname(out),'traces',item.id+'-'+arm+'-'+trial+'.jsonl')});}
    catch(e){result={outcome:'error',error:e.message};}
    const row={arm,trial,destination,original_death_room:item.room??frame.scene.room.num,original_killer:item.killer,horizon_ms:horizonMs,...result};row.assessment=reviewTrialUsability(row);entry.runs.push(row);
    entry.verdict=classifyMovementComparison(entry.runs,{baselineRuns:n,patchedRuns:m,minimumBaselineDeaths:min});await persist(out,report);await onTrial(row,entry,report);
    if(row.cleanup_error||row.error&&/ownership check|already owned|already holding|cleanup|Cannot find module|ERR_MODULE_NOT_FOUND|initial ability read/i.test(row.error))throw Error('lab setup/ownership/cleanup must be resolved before another trial: '+row.error);
   }
  }
  entry.verdict=classifyMovementComparison(entry.runs,{baselineRuns:n,patchedRuns:m,minimumBaselineDeaths:min});entry.completed=true;await persist(out,report);
 }
 report.completed=true;report.finished_at=new Date().toISOString();await persist(out,report);return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [action,file,...args]=process.argv.slice(2),arg=(k,d=null)=>{const i=args.indexOf(k);return i<0?d:args[i+1];};
 try{
  if(action==='scan'){const report=await scanTravelDeaths({postmortemDir:path.resolve(file),rosterFile:arg('--roster'),since:Date.parse(arg('--since')),until:arg('--until')?Date.parse(arg('--until')):Date.now()});
   await persist(arg('--out'),report);console.log(JSON.stringify(report.counts));}
  else if(action==='run'){const plan=JSON.parse(await readFile(file,'utf8'));const report=await runMovementDeathReview(plan,{out:path.resolve(arg('--out')),resume:args.includes('--resume'),onTrial:(r,c,report)=>console.log(JSON.stringify({case:c.id,arm:r.arm,trial:r.trial,outcome:r.outcome,usable:r.assessment.usable,arrival:r.trace?.arrived_alive,verdict:c.verdict.classification,error:r.error,summary:report.summary}))});
   console.log(JSON.stringify({completed:report.completed,cases:report.cases.length,summary:report.summary}));}
  else throw Error('usage: m59-movement-death-review.mjs scan POSTMORTEM_DIR --since ISO [--until ISO] [--roster FILE] --out CATALOG | run PLAN --out REPORT [--resume]');
 }catch(e){console.error(e.message);process.exitCode=1;}
}
