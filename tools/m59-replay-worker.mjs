import {parentPort,workerData} from 'node:worker_threads';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';

export function runtimeProvenance(root) {
  const git=args=>{try{return execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:10000,
    stdio:['ignore','pipe','ignore']}).trim();}catch{return null;}};
  const files={},listed=git(['ls-files','-co','--exclude-standard','-z','tools','server-patches',
    'substrate/m59-map.json','substrate/m59-routes.json','substrate/m59-tracks.json','substrate/m59-falljumps.json']);
  for(const file of [...new Set((listed??'').split('\0').filter(Boolean))].sort()) {
    try{files[file]=createHash('sha256').update(readFileSync(path.join(root,file))).digest('hex');}catch{files[file]=null;}
  }
  const changes=git(['status','--porcelain','--untracked-files=all','--','tools','server-patches']);
  return {captured_at:new Date().toISOString(),harness:{commit:git(['rev-parse','HEAD']),
    source_sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    dirty:changes==null?null:changes.length>0,files,node:process.version,
    meaning:'files at recorder startup; source manifest is independent of mutable deployment HEAD'},
    server:{commit:process.env.M59_SERVER_COMMIT??null,attestation:process.env.M59_SERVER_COMMIT?'operator environment':'not exposed by the game protocol'},
    director:{commit:process.env.M59_DUMBOT_COMMIT??null},
    rng_state:null,timers:null};
}

if(parentPort&&workerData) {
  const {dir,maxFrames,maxBytes}=workerData;
  const provenance=runtimeProvenance(workerData.root);
  if(workerData.server)provenance.server={...workerData.server,attestation:'verified isolated container image and loopback ports'};
  const frames=[];let bytes=0,evicted=0,lastBundle=null;
  await mkdir(dir,{recursive:true});
  parentPort.postMessage({type:'ready',provenance:{harness:{...provenance.harness,files:undefined}}});
  let queue=Promise.resolve();
  parentPort.on('message',m=>{
    queue=queue.then(async()=>{
      if(m.type==='frame') {
        m.frame.scene.provenance={harness:{...provenance.harness,files:undefined},
          server:provenance.server,director:provenance.director};
        const encoded=JSON.stringify(m.frame),size=Buffer.byteLength(encoded);
        frames.push({frame:m.frame,size});bytes+=size;
        while(frames.length>maxFrames||bytes>maxBytes){bytes-=frames.shift().size;evicted++;}
      }else if(m.type==='death') {
        const payload=lastBundle?.id===m.death.id ? {...lastBundle,
          death:{...lastBundle.death,detail:{...m.death.detail,...lastBundle.death.detail,
            survival_decisions:m.death.detail.survival_decisions??lastBundle.death.detail.survival_decisions}}} :
          {schema:'m59-death-replay/v1',id:m.death.id,provenance,
          death:m.death,frames:frames.map(f=>f.frame),capture:{...m.capture_status,
            lifetime_dropped:m.capture_status.dropped,lifetime_errors:m.capture_status.errors,
            dropped:Math.max(0,m.capture_status.dropped-(frames[0]?.frame.capture_status?.dropped??0)),
            errors:Math.max(0,m.capture_status.errors-(frames[0]?.frame.capture_status?.errors??0)),
            ring_evicted:evicted,bytes,first_at:frames[0]?.frame.at??null,last_at:frames.at(-1)?.frame.at??null},
          validation:{status:'unvalidated',baseline_required:true,
            limitation:'client-observed scenes omit hidden server state; a replayed death is necessary, not proof of a bit-exact checkpoint'}};
        lastBundle=payload;
        const json=JSON.stringify(payload),sha256=createHash('sha256').update(json).digest('hex');
        const file=path.join(dir,`${m.death.id}.json`),temp=file+'.tmp';
        await writeFile(temp,JSON.stringify({sha256,payload}));await rename(temp,file);
        parentPort.postMessage({type:'saved',file,sha256});
      }
    }).catch(e=>parentPort.postMessage({type:'error',error:e.message}))
      .finally(()=>parentPort.postMessage({type:'ack'}));
  });
}
