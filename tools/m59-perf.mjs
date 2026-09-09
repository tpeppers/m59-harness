// Payload-free, bounded integration telemetry. Explicitly enabled by preload.
import {appendFile, mkdir, rename, stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';

export const bounds = [1,5,16,50,100,250,1000,5000];
export function perf(key,value=1){globalThis[Symbol.for('m59.perf')]?.add(key,value);}
export class Metrics {
  constructor({source='integration', path=null, intervalMs=10000, maxBytes=8*1024*1024,
               now=()=>performance.now(), sink=null, processStats=true}={}) {
    this.source=source;this.path=path;this.maxBytes=maxBytes;this.now=now;this.sink=sink;
    this.values=new Map();this.last=now();this.queue=[];this.queuedBytes=0;this.writing=false;
    this.dropped=0;this.writeErrors=0;this.inflight=0;this.peak=0;this.closed=false;
    this.cpu=process.cpuUsage();this.processStats=processStats;
    if(processStats){this.delay=monitorEventLoopDelay({resolution:20});this.delay.enable();}
    if(intervalMs>0){this.timer=setInterval(()=>this.flush(),intervalMs);this.timer.unref();}
  }
  add(key,value=1) {
    if(!/^[a-z0-9._]{1,100}$/.test(key)||!Number.isFinite(value)||value<0)return;
    if(!this.values.has(key)){if(this.values.size>=256)return;
      this.values.set(key,{n:0,sum:0,max:0,total_n:0,total_sum:0,buckets:Array(9).fill(0)});}
    const m=this.values.get(key);m.n++;m.total_n++;m.sum+=value;m.total_sum+=value;m.max=Math.max(m.max,value);
    let i=0;while(i<bounds.length&&value>bounds[i])i++;m.buckets[i]++;
  }
  begin(key) {
    const start=this.now();this.add(key+'.started');this.inflight++;this.peak=Math.max(this.peak,this.inflight);
    let done=false;return outcome=>{if(done)return;done=true;this.inflight--;
      this.add(key+'.elapsed_ms',this.now()-start);this.add(key+'.'+outcome);};
  }
  flush() {
    const now=this.now(), elapsed=Math.max(0,now-this.last);this.last=now;
    if(this.processStats){const cpu=process.cpuUsage();this.add('process.cpu_ms',
      (cpu.user+cpu.system-this.cpu.user-this.cpu.system)/1000);this.cpu=cpu;
      this.add('process.rss_bytes',process.memoryUsage().rss);
      this.add('process.event_loop_p95_ms',this.delay.percentile(95)/1e6);this.delay.reset();}
    const metrics=Object.fromEntries([...this.values].map(([k,v])=>[k,{...v,buckets:[...v.buckets]}]));
    const row={schema:'m59-perf/v1',source:this.source,pid:process.pid,at:new Date().toISOString(),
      mono_ms:now,window_ms:elapsed,inflight:this.inflight,peak_inflight:this.peak,
      dropped_log_windows:this.dropped,log_write_errors:this.writeErrors,metrics};
    for(const m of this.values.values()){m.n=0;m.sum=0;m.max=0;m.buckets.fill(0);}
    this.peak=this.inflight;
    if(this.sink){try{this.sink(row);}catch{this.writeErrors++;}}
    if(this.path){const line=JSON.stringify(row)+'\n',bytes=Buffer.byteLength(line);
      if(this.queuedBytes+bytes>256*1024)this.dropped++;
      else{this.queue.push(line);this.queuedBytes+=bytes;void this.drain();}}
    return row;
  }
  async drain() {
    if(this.writing)return;this.writing=true;
    try {await mkdir(dirname(this.path),{recursive:true});
      while(this.queue.length){const batch=this.queue.splice(0).join('');this.queuedBytes=0;
        const size=await stat(this.path).then(s=>s.size,()=>0);
        if(size+Buffer.byteLength(batch)>this.maxBytes)
          await rename(this.path,this.path+'.1').catch(e=>{if(e.code!=='ENOENT')throw e;});
        await appendFile(this.path,batch);}
    } catch {this.writeErrors++;this.dropped+=this.queue.length;this.queue=[];this.queuedBytes=0;}
    finally{this.writing=false;}
  }
  close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);this.delay?.disable();this.flush();}
}

const paths=new Map([
  ['/','rpc'],['/health','health'],['/rts/v1/read','aggregate'],['/plans','plans'],
  ['/v1/snapshot.v8.tsv','snapshot_v8'],['/v1/snapshot.v8','snapshot_v8_json'],
  ['/v1/snapshot.tsv','snapshot_v7'],['/v1/snapshot','snapshot_v7_json'],
  ['/v1/scene.v3.tsv','scene_v3'],['/v1/scene.v3','scene_v3_json'],
  ['/v1/scene.tsv','scene_v2'],['/v1/scene','scene_v2_json'],
  ['/v1/atlas.v1.tsv','atlas'],['/v1/events','events'],['/intent','intent'],
]);
export function route(input){try{return paths.get(new URL(input,'http://127.0.0.1').pathname)||'other';}catch{return 'other';}}
const bytes=(v,encoding)=>typeof v==='string'?Buffer.byteLength(v,encoding):v?.byteLength||0;

export function measuredFetch(original,metrics){
  return async function(input,options){
    const key='broker.'+route(input?.url||input),start=metrics.now(),done=metrics.begin(key);
    // Body only, excluding headers/TCP overhead. Never retain the contents.
    metrics.add(key+'.tx_body_bytes',bytes(options?.body));
    try{
      const response=await original.call(this,input,options);
      metrics.add(key+'.headers_ms',metrics.now()-start);
      metrics.add(key+'.http_'+response.status);
      const length=Number(response.headers?.get?.('content-length'));
      if(Number.isFinite(length)&&length>0)metrics.add(key+'.advertised_body_bytes',length);
      const json=response.json.bind(response),text=response.text?.bind(response);
      if(text)response.text=async()=>{try{const body=await text();
        metrics.add(key+'.rx_body_bytes',Buffer.byteLength(body));done(response.ok?'ok':'http_error');return body;
      }catch(e){done(e?.name==='TimeoutError'||e?.name==='AbortError'?'timeout':'body_error');throw e;}};
      response.json=async()=>{
        try {
          const parseStart=metrics.now();let value;
          if(text){const body=await text();metrics.add(key+'.rx_body_bytes',Buffer.byteLength(body));
            const p=metrics.now();value=JSON.parse(body);metrics.add(key+'.json_parse_ms',metrics.now()-p);}
          else{value=await json();metrics.add(key+'.unmeasured_body');}
          metrics.add(key+'.body_and_parse_ms',metrics.now()-parseStart);
          done(response.ok?'ok':'http_error');return value;
        }catch(e){done(e?.name==='TimeoutError'||e?.name==='AbortError'?'timeout':'body_error');throw e;}
      };
      // Non-success replies are often intentionally not consumed by existing callers.
      if(!response.ok)done('http_error');
      return response;
    }catch(e){done(e?.name==='TimeoutError'||e?.name==='AbortError'?'timeout':'network_error');throw e;}
  };
}

export function measureHttp(req,res,metrics){
  const key='client.'+route(req.url),start=metrics.now(),done=metrics.begin(key);
  let header=false,ended=false;
  // Do not add a data listener: it would change request stream flow/consumption.
  const emit=req.emit;
  req.emit=function(event,...args){if(event==='data')metrics.add(key+'.rx_consumed_body_bytes',bytes(args[0]));return emit.call(this,event,...args);};
  const write=res.write,end=res.end,head=res.writeHead;
  res.writeHead=function(...args){if(!header){header=true;metrics.add(key+'.headers_ms',metrics.now()-start);}return head.apply(this,args);};
  res.write=function(chunk,encoding,...args){metrics.add(key+'.tx_body_bytes',bytes(chunk,typeof encoding==='string'?encoding:undefined));return write.call(this,chunk,encoding,...args);};
  res.end=function(chunk,encoding,...args){if(!ended){ended=true;metrics.add(key+'.tx_body_bytes',bytes(chunk,typeof encoding==='string'?encoding:undefined));}return end.call(this,chunk,encoding,...args);};
  res.once('finish',()=>{metrics.add(key+'.http_'+res.statusCode);done(res.statusCode<400?'ok':'http_error');});
  res.once('close',()=>done('disconnected'));
}
