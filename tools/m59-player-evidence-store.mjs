import {Worker,parentPort,workerData} from 'node:worker_threads';
import {mkdir,appendFile,readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PlayerEvidenceObserver} from './m59-player-evidence.mjs';
const sourceFiles=Object.fromEntries(['m59-player-evidence.mjs','m59-player-evidence-store.mjs'].map(f=>
  [f,createHash('sha256').update(readFileSync(new URL(f,import.meta.url))).digest('hex')]));
export const PLAYER_EVIDENCE_DIR=process.env.M59_PLAYER_EVIDENCE_DIR??fileURLToPath(new URL('../substrate/player-evidence',import.meta.url));
export const serverKey=server=>createHash('sha256').update(String(server).toLowerCase()).digest('hex').slice(0,20);
const safe=s=>String(s??'unknown').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80);
export async function appendEvidence(rows,{dir=process.env.M59_PLAYER_EVIDENCE_DIR??PLAYER_EVIDENCE_DIR,writer='operator',provenance=null}={}) {
  const groups=new Map();
  for(const row of rows) {
    if(!row.server||!row.character)throw Error('evidence requires server and character identity');
    const folder=path.join(dir,serverKey(row.server)),day=new Date(row.at).toISOString().slice(0,10),
      file=path.join(folder,safe(writer)+'-'+day+'.jsonl');
    if(!groups.has(file))groups.set(file,[]);
    groups.get(file).push({...row,schema:'m59-player-evidence/v1',provenance:row.provenance??provenance});
  }
  for(const [file,records] of groups){await mkdir(path.dirname(file),{recursive:true});
    await appendFile(file,records.map(r=>JSON.stringify(r)).join('\n')+'\n');}
}
export async function readEvidence({dir=process.env.M59_PLAYER_EVIDENCE_DIR??PLAYER_EVIDENCE_DIR,server,character=null}={}) {
  if(!server)throw Error('an explicit server host:port is required');
  const folder=path.join(dir,serverKey(server));let files;
  try{files=await readdir(folder);}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const rows=[];
  for(const file of files.filter(f=>f.endsWith('.jsonl')).sort()) {
    const text=await readFile(path.join(folder,file),'utf8'),lines=text.split('\n');
    for(let i=0;i<lines.length;i++) {
      if(!lines[i])continue;
      let row;try{row=JSON.parse(lines[i]);}catch(e){if(i===lines.length-1)continue;throw Error('corrupt player evidence: '+file);}
      if(row.schema==='m59-player-evidence/v1'&&row.server.toLowerCase()===server.toLowerCase()&&
        (!character||row.character.toLowerCase()===character.toLowerCase()))rows.push(row);
    }
  }
  return rows;
}
export function attachPlayerEvidence(s,{dir=process.env.M59_PLAYER_EVIDENCE_DIR??PLAYER_EVIDENCE_DIR,workerFactory=(url,options)=>new Worker(url,options)}={}) {
  if(s.playerEvidence)return s.playerEvidence;
  let worker=null,pending=0,closed=false;const recent=[];const stats={queued:0,dropped:0,errors:0,persisted:0};
  const emit=row=>{
    recent.push(row);if(recent.length>16)recent.shift();
    if(closed||pending>=32){stats.dropped++;return;}
    if(!worker) {
      worker=workerFactory(new URL('./m59-player-evidence-store.mjs',import.meta.url),{
        workerData:{playerEvidence:true,dir,writer:safe(s.name)+'-'+process.pid+'-'+Date.now(),
          root:fileURLToPath(new URL('../',import.meta.url))}});
      worker.unref();worker.on('message',m=>{
        pending=Math.max(0,pending-1);if(m.error){stats.errors++;stats.dropped++;stats.last_error=m.error;}else stats.persisted++;
      });
      worker.on('error',e=>{stats.errors++;stats.last_error=e.message;stats.dropped+=pending;pending=0;worker=null;});
    }
    pending++;stats.queued++;worker.postMessage({...row,provenance:s.replayRecorder?.status?.()?.provenance??
      {harness_commit:null,files:sourceFiles,meaning:'evidence module bytes at process import; commit unavailable'}});
  };
  const observer=new PlayerEvidenceObserver({emit});
  const context=()=>({server:String(s.credentials?.host??'')+':'+String(s.credentials?.port??''),
    observer:s.client?.me?.name??s.name,agent:s.name,room:s.world?.room?.num??null});
  const timer=setInterval(()=>{try{observer.flush(Date.now(),false,s.client);}catch{stats.errors++;}},250);timer.unref();
  const api={event(ev,c){if(c!==s.client||closed)return;try{observer.event(ev,c,context());}catch(e){stats.errors++;stats.last_error=e.message;}},
    recent:()=>structuredClone(recent),
    status:()=>({...stats,events:observer.stats.events,witnessed_deaths:observer.stats.witnessed_deaths,
      dropped:stats.dropped+observer.stats.dropped,errors:stats.errors+observer.stats.errors,pending,enabled:!closed}),
    async flush(){observer.flush(Date.now(),true,s.client);const start=Date.now();
      while(pending&&Date.now()-start<5000)await new Promise(r=>setTimeout(r,10));return pending===0;},
    async close(){clearInterval(timer);await api.flush();closed=true;await worker?.terminate();s.playerEvidence=null;},
    reset(){observer.flush(Date.now(),true,null);observer.players.clear();observer.health=[];observer.items=[];observer.room=null;}};
  s.playerEvidence=api;return api;
}
if(parentPort&&workerData?.playerEvidence) {
  const provenance={writer_started_at:Date.now(),node:process.version};
  let queue=Promise.resolve();
  parentPort.on('message',row=>{queue=queue.then(()=>appendEvidence([row],{...workerData,provenance}))
    .then(()=>parentPort.postMessage({ok:true}),e=>parentPort.postMessage({error:e.message}));});
}
