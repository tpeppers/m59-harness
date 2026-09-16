// Private, append-only experiment bundles. No production calls or credentials.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const sha256=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
export function summarize(report) {
  const run=report.runs?.[0],t=run?.team_experiment??report.team_experiment??{},events=t.events??[];
  const arrivals=kind=>events.filter(e=>e.kind===kind).map(({actor,ms})=>({actor,ms}));
  const foyer=arrivals('hall_foyer_arrival'),inner=arrivals('inner_hall_arrival'),deaths=arrivals('casualty');
  return {completed:report.completed===true,validation:report.validation??null,
    outcome:t.winner??'invalid',reason:t.reason??report.error??null,resolved_ms:t.resolved_ms??null,
    first_foyer_ms:foyer[0]?.ms??null,first_inner_ms:inner[0]?.ms??null,
    foyer_arrivals:foyer,inner_arrivals:inner,deaths,
    floyd:{died:deaths.some(x=>x.actor==='t16'),final:t.final?.actors?.find(x=>x.key==='t16')??null},
    hall:t.hall_final??null,errors:t.errors??[],cleanup:run?.pvp?.cleanup??null};
}
function runtimeDirs(value,out=new Set()) {
  if(value&&typeof value==='object')for(const [key,v]of Object.entries(value)){
    if(key==='runtime_dir'&&typeof v==='string')out.add(v);
    else if(v&&typeof v==='object')runtimeDirs(v,out);
  }
  return out;
}
export function finalize(dir,{exitCode=null}={}) {
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
  const reportFile=path.join(dir,'report.json');
  const report=fs.existsSync(reportFile)?JSON.parse(fs.readFileSync(reportFile)):{error:'process ended without report'};
  const t=report.runs?.[0]?.team_experiment??report.team_experiment??{};
  for(const [file,rows]of [['events.jsonl',t.events??[]],['check-ins.jsonl',(t.events??[]).filter(e=>e.kind==='progress')]])
    fs.writeFileSync(path.join(dir,file),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  json(path.join(dir,'summary.json'),summarize(report));
  // Copy only the lab runtime's evidence. Never copy the fleet/config/password files.
  const evidence=['decisions','hits','intel','player-evidence','postmortems','pvp','recordings','shelters','tactics','trails','transits','keeper-uptime','replays'];
  manifest.runtime_evidence=[];
  for(const source of runtimeDirs(report)){
    if(!fs.existsSync(source))continue;
    const target=path.join(dir,'runtime',String(manifest.runtime_evidence.length));
    for(const name of evidence)if(fs.existsSync(path.join(source,name))){
      fs.mkdirSync(target,{recursive:true});fs.cpSync(path.join(source,name),path.join(target,name),{recursive:true});
    }
    manifest.runtime_evidence.push({source,relative:path.relative(dir,target)});
  }
  const hashes={};
  function walk(folder){for(const d of fs.readdirSync(folder,{withFileTypes:true})){
    const file=path.join(folder,d.name);
    if(d.isDirectory())walk(file);
    else if(d.name!=='manifest.json')hashes[path.relative(dir,file).replaceAll('\\','/')]=sha256(file);
  }}
  walk(dir);manifest.files=hashes;manifest.finished_at=new Date().toISOString();manifest.exit_code=exitCode;
  manifest.metrics=summarize(report);manifest.state='finished';
  json(path.join(dir,'manifest.json'),manifest);
  fs.writeFileSync(path.join(dir,'REPORT.md'),[
    '# Guild defense round '+manifest.round,'',
    '**Hypothesis:** '+manifest.hypothesis,'',
    '**Code:** '+manifest.code.commit+(manifest.code.dirty?' (dirty at capture)':''),'',
    '**Provenance:** '+manifest.provenance,'',
    '## Results','', '```json',JSON.stringify(manifest.metrics,null,2),'```','',
    'Full native report: [report.json](report.json). Check-ins: [check-ins.jsonl](check-ins.jsonl).',
    'See manifest.json for input/source hashes and copied runtime evidence.',
    'One exploratory run; ambient combat and scheduling vary. Full-health prepared equipment is a scenario assumption.',
    'Controllers share one process; production uses separate keeper processes.',''].join('\n'));
  manifest.files['REPORT.md']=sha256(path.join(dir,'REPORT.md'));json(path.join(dir,'manifest.json'),manifest);
  return manifest;
}
async function main(){
  const [mode,id,hypothesis,...rest]=process.argv.slice(2);
  if(!['run','import'].includes(mode)||!/^\d{3}-[a-z0-9-]+$/.test(id??'')||!hypothesis)
    throw Error('Usage: node tools/m59-guild-defense-round.mjs run|import 001-name "hypothesis" [old-report]');
  const root=path.resolve('substrate/guild-defense'),dir=path.join(root,'rounds',id);
  fs.mkdirSync(path.dirname(dir),{recursive:true});fs.mkdirSync(dir); // Deliberately refuses overwrite.
  const dirty=!!git('status','--porcelain','--untracked-files=normal');
  if(mode==='run'&&dirty)throw Error('Commit this round before running it; tracked source must be clean');
  json(path.join(dir,'manifest.json'),{schema:'m59-guild-defense-round/v1',round:id,hypothesis,
    state:'started',started_at:new Date().toISOString(),
    provenance:mode==='import'?'Retrospective archive: execution provenance is inside the original report; this commit identifies the archive tooling.':'Executed from the recorded clean commit',
    code:{commit:git('rev-parse','HEAD'),dirty},parent_round:process.env.SIM_PARENT_ROUND??null});
  fs.mkdirSync(path.join(dir,'inputs'));
  fs.copyFileSync(path.join(root,'defenders.json'),path.join(dir,'inputs','defenders.json'));
  fs.copyFileSync('tools/m59-guild-defense-sim.mjs',path.join(dir,'driver.mjs'));
  if(mode==='import'){
    fs.copyFileSync(rest[0],path.join(dir,'report.json'));
    const baselineDriver=path.join(root,'castle-response.mjs');
    if(fs.existsSync(baselineDriver))fs.copyFileSync(baselineDriver,path.join(dir,'original-driver.mjs'));
    const m=finalize(dir);console.log(JSON.stringify({dir,metrics:m.metrics}));return;
  }
  const log=fs.openSync(path.join(dir,'console.log'),'wx');
  const checkins=fs.openSync(path.join(dir,'live-events.jsonl'),'wx');
  const child=spawn(process.execPath,['tools/m59-guild-defense-sim.mjs',path.join(dir,'report.json')],{
    env:{...process.env,SIM_ROUND_DIR:dir,SIM_DEFENDERS:path.join(dir,'inputs','defenders.json')},
    stdio:['ignore','pipe','pipe'],windowsHide:true});
  let pending='';
  child.stdout.on('data',b=>{fs.writeSync(log,b);process.stdout.write(b);pending+=b.toString();
    const rows=pending.split('\n');pending=rows.pop();for(const row of rows)if(row.startsWith('{'))fs.writeSync(checkins,row+'\n');});
  child.stderr.on('data',b=>{fs.writeSync(log,b);process.stderr.write(b);});
  const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  fs.closeSync(log);fs.closeSync(checkins);
  const m=finalize(dir,{exitCode});console.log(JSON.stringify({dir,metrics:m.metrics}));
  process.exitCode=exitCode??1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.stack);process.exitCode=1;});
