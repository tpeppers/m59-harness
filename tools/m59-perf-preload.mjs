// Run only the desired integration process with node --import <this file>.
// No listeners, broker sessions, orders, sampling requests, or payload logging.
import http from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
import {resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Metrics,measuredFetch,measureHttp} from './m59-perf.mjs';
if(process.env.M59_PERF_LOG==='1'){
  const script=basename(process.argv[1]||'');
  const source=script.includes('rts-gateway')?'gateway':script.includes('inventory-intent')?'quartermaster':'integration';
  const dir=process.env.M59_PERF_DIR||fileURLToPath(new URL('../substrate/perf/',import.meta.url));
  const metrics=new Metrics({source,path:resolve(dir,`${source}-${process.pid}.jsonl`)});
  globalThis[Symbol.for('m59.perf')]=metrics;
  globalThis.fetch=measuredFetch(globalThis.fetch,metrics);
  const emit=http.Server.prototype.emit;
  http.Server.prototype.emit=function(event,...args){
    if(event==='request')measureHttp(args[0],args[1],metrics);
    return emit.call(this,event,...args);
  };
  syncBuiltinESMExports();
  process.once('beforeExit',()=>metrics.close());
}
