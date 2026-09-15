import assert from 'node:assert/strict';
import http from 'node:http';
import {Metrics,measuredFetch,measureHttp,route} from './m59-perf.mjs';
let now=0;const m=new Metrics({now:()=>now,intervalMs:0,processStats:false});
const finish=m.begin('test');now=20;finish('ok');finish('error');
m.add('secret?token=never',42);let row=m.flush();
assert.equal(row.metrics['test.elapsed_ms'].sum,20);assert.equal(row.inflight,0);
assert.equal(row.metrics['test.ok'].n,1);assert(!JSON.stringify(row).includes('never'));
row=m.flush();assert.equal(row.metrics['test.ok'].n,0);assert.equal(row.metrics['test.ok'].total_n,1);
assert.equal(route('/health?password=SECRET'),'health');assert.equal(route('/account/SECRET'),'other');
const live=new Metrics({intervalMs:0,processStats:false});
let requests=0;
const server=http.createServer((req,res)=>{requests++;measureHttp(req,res,live);
  if(req.url==='/timeout'){setTimeout(()=>res.end('{}'),100).unref();return;}
  if(req.url==='/bad'){res.end('not-json');return;}
  if(req.url==='/error'){res.writeHead(503);res.end('{}');return;}
  const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{
    const body=JSON.stringify({ok:true,unicode:'é🐸',echo:Buffer.concat(chunks).toString()});
    res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(body)});
    res.end(body);
  });
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port;
const f=measuredFetch(fetch,live);
try{
  const a=await f(url+'/health?token=SECRET',{method:'POST',body:'abc',headers:{authorization:'Bearer SECRET'}});
  assert.equal((await a.json()).echo,'abc');
  const b=await f(url+'/health');assert.match(await b.text(),/unicode/);
  await assert.rejects(async()=>{await (await f(url+'/bad')).json();});
  assert.equal((await f(url+'/error')).status,503);
  await assert.rejects(()=>f(url+'/timeout',{signal:AbortSignal.timeout(10)}));
  const out=live.flush();assert.equal(requests,5);assert.equal(out.inflight,1); // server timeout still running
  assert.equal(out.metrics['broker.health.ok'].n,2);
  assert.equal(out.metrics['broker.health.tx_body_bytes'].sum,3);
  assert.equal(out.metrics['client.health.rx_consumed_body_bytes'].sum,3);
  assert.equal(out.metrics['broker.other.body_error'].n,1);
  assert.equal(out.metrics['broker.other.timeout'].n,1);
  assert(!JSON.stringify(out).includes('SECRET'));assert(!JSON.stringify(out).includes('unicode'));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));live.close();m.close();}
console.log('PASS performance metrics: payload privacy, exact body bytes, single completion, HTTP errors, timeouts, malformed JSON, interval totals');
