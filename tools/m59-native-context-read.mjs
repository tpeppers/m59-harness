// Demand-driven broker reader. No background timer and no game connection.
import {perf} from './m59-perf.mjs';
const fresh=(at,now)=>Number.isFinite(at)&&at<=now+1000&&now-at<=6000;
export function nativeContextReader({url=process.env.M59_CLIENT_CONTEXT_URL,fetcher=fetch,now=Date.now}={}) {
  let cache=null,at=0,pending=null,retry=0;
  if(url){const u=new URL(url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password)throw Error('native context must be loopback');url=u.origin;}
  return async ({fleet,brokerPid,agents=[],pilot})=>{
    const empty=reason=>({schema:'m59-native-context/1',fleet,broker_pid:brokerPid,clients:[],unavailable:reason});
    if(!url)return empty('native context endpoint not configured');
    if(!cache||now()-at>1000){
      if(now()<retry)return empty('native context temporarily unavailable');
      if(!pending)pending=(async()=>{
        const start=performance.now();try{
          const res=await fetcher(url+'/v1/clients',{signal:AbortSignal.timeout(1500)});
          if(!res.ok)throw Error('context unavailable');const reader=res.body.getReader();let size=0,chunks=[];
          for(;;){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>8*1024*1024){await reader.cancel();throw Error('context too large');}chunks.push(x.value);}
          perf('broker.native_context.rx_body_bytes',size);const data=JSON.parse(Buffer.concat(chunks).toString());
          if(data.schema!=='m59-native-context/1'||!Array.isArray(data.clients)||data.clients.length>40)throw Error('invalid native context');
          cache=data;at=now();retry=0;
        }catch{cache=null;retry=now()+5000;perf('broker.native_context.unavailable');}
        finally{pending=null;perf('broker.native_context.elapsed_ms',performance.now()-start);}
      })();
      await pending;
    }
    if(!cache||cache.fleet!==fleet||cache.broker_pid!==brokerPid||!fresh(cache.at,now()))return empty('context identity changed or stale');
    // Re-attest every read, INCLUDING cache hits: a released claim cannot linger.
    const clients=cache.clients.filter(c=>{
      const p=pilot(c.agent);return p&&p.pid===c.pid&&p.objectId===c.player_id&&p.character===c.character&&c.control==='human'&&fresh(c.at,now())&&(!agents.length||agents.includes(c.agent));
    });
    return structuredClone({...cache,clients});
  };
}
