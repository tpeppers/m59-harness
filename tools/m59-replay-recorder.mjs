import {Worker} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {captureCachedScene} from './m59-scene-capture.mjs';

export const REPLAY_DIR=process.env.M59_REPLAY_DIR??fileURLToPath(new URL('../substrate/replays/',import.meta.url));
export function attachReplayRecorder(s,k,{enabled=s.replayCaptureEnabled===true,dir=REPLAY_DIR,
    sampleMs=1000,workerFactory=(url,options)=>new Worker(url,options)}={}) {
  if(!enabled)return null;
  if(s.replayRecorder){s.replayRecorder.setKeeper(k);return s.replayRecorder;}
  const prefix=`${String(s.name??'agent').replace(/[^a-zA-Z0-9_-]/g,'_')}-${process.pid}-${Date.now()}`;
  const stats={pending:0,dropped:0,errors:0,frames:0,capture_ms_max:0,capture_ms_total:0,
    persisted_deaths:0,persisted_writes:0,ready:false,last_death:null};
  const savedDeaths=new Set();
  let keeper=k,sequence=0,lastDeath=null,closed=false;
  let worker;
  try {worker=workerFactory(new URL('./m59-replay-worker.mjs',import.meta.url),{
    workerData:{dir,prefix,root:fileURLToPath(new URL('../',import.meta.url)),
      server:s.replayServerAttestation??null,maxFrames:120,maxBytes:16*1024*1024}});
  }catch(e){s.replayCaptureError=e.message;return null;}
  worker.unref();
  worker.on('message',m=>{
    if(m.type==='ack')stats.pending=Math.max(0,stats.pending-1);
    if(m.type==='ready'){stats.ready=true;stats.provenance=m.provenance;}
    if(m.type==='saved'){
      stats.persisted_writes++;savedDeaths.add(m.file);
      stats.persisted_deaths=savedDeaths.size;stats.last_death=m.file;
    }
    if(m.type==='error'){stats.errors++;stats.last_error=m.error;}
  });
  worker.on('error',e=>{stats.errors++;stats.last_error=e.message;});
  const post=(message,critical=false)=>{
    if(closed||stats.pending>=(critical?12:4)){stats.dropped++;return false;}
    try {stats.pending++;worker.postMessage(message);return true;}
    catch(e){stats.pending--;stats.errors++;stats.last_error=e.message;return false;}
  };
  const capture=(reason='sample',event=null,{scene:preparedScene=null}={})=>{
    // Reserve capacity for crisis events even when periodic samples are queued.
    if(!s.live||stats.pending>=(reason==='sample'?4:12)){if(s.live)stats.dropped++;return null;}
    if(reason==='sample'&&lastDeath&&Date.now()-lastDeath.at>5000&&s.world?.room?.num!==1&&s.client?.vitals?.()?.health?.value>0)lastDeath=null;
    const start=performance.now();
    try {
      const id=`${prefix}-${++sequence}`;
      const scene=preparedScene?structuredClone(preparedScene):captureCachedScene(s,keeper,{name:id});
      const frame={id,at:Date.now(),reason,scene,event,capture_status:{dropped:stats.dropped,errors:stats.errors}};
      if(!post({type:'frame',frame},reason!=='sample'))return null;
      stats.frames++;return id;
    }catch(e){stats.errors++;stats.last_error=e.message;return null;}
    finally {const ms=performance.now()-start;stats.capture_ms_total+=ms;stats.capture_ms_max=Math.max(stats.capture_ms_max,ms);}
  };
  const timer=setInterval(()=>capture(),Math.max(100,sampleMs));timer.unref();
  const recorder={capture,setKeeper:value=>{keeper=value;},
    decision:row=>capture(`decision_${row.event}`,row),
    death:(detail={})=>{
      const now=Date.now();
      if(!lastDeath||detail.fatal_at&&detail.fatal_at-lastDeath.at>5000)
        lastDeath={id:`${prefix}-death-${now}`,at:detail.fatal_at??now};
      capture('death',null);
      const queued=post({type:'death',death:{...lastDeath,detail},capture_status:{...stats,provenance:undefined}},true);
      return {id:lastDeath.id,file:path.join(dir,`${lastDeath.id}.json`),status:queued?'queued':'dropped',
        captured_at:now,kind:'client-observed-scene',requires_baseline_reproduction:true};
    },
    status:()=>({...stats,provenance:stats.provenance?{harness:stats.provenance.harness}:null,
      average_capture_ms:stats.frames?stats.capture_ms_total/stats.frames:0}),
    flush:async(timeoutMs=5000)=>{
      const start=Date.now();while(stats.pending&&Date.now()-start<timeoutMs)await new Promise(r=>setTimeout(r,20));
      return stats.pending===0;
    },
    close:async()=>{clearInterval(timer);await recorder.flush();closed=true;await worker.terminate();},
  };
  s.replayRecorder=recorder;return recorder;
}
