import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseNativeContext,bindNative,settingValue,changeFor,startClientContext} from './m59-client-context.mjs';
let at=1900000000000;const dir=mkdtempSync(join(tmpdir(),'m59-context-'));
const binding='321\t127.0.0.1%3A15959\tfixture\tTest%20character\t17\t91\t92\t93';
const request=(pane='DUM',seq=0,token='',op='',strategy='',field='',value='')=>`M59CTXREQ\t1\t${at}\t${binding}\t${pane}\t${seq}\t${token}\t${op}\t${strategy}\t${field}\t${encodeURIComponent(value)}\nC\t99\tsword\t4\t${at}\nEND\n`;
const plan={pid:321,paused:true,agent:'unit-fixture',at,identity:{server:'127.0.0.1:15959',account:'fixture',character:'Test character',player_id:17},room_object:91,room_wire:{room_resource_id:92,room_security_u32:93},items:[{id:99,name:'sword',amount:1,state:'keep'}]};
let plans={fleet:'fixture-fleet',broker_pid:123,at,plans:[plan]};
const catalogue=[{id:'fixture',title:'Test behavior',description:'Test only',settings:[{id:'limit',title:'Limit',type:'integer',min:1,max:20,default:12}]}];
let dum={selected:1,fleet:'fixture-fleet',pid:456,strategy_cas:1,revision:'v1',catalogue,states:{fixture:{state:'all',settings:{limit:12}}}};
let requests=[],writes=0,failDum=false;const fetcher=async(url,opts={})=>{requests.push([url,opts.method||'GET']);
  if(failDum&&url.includes('8916'))throw new Error('fixture outage');
  if(url.endsWith('/plans'))return Response.json(plans);
  if(url.endsWith('/health'))return Response.json({ok:true,fleet:'fixture-fleet',pid:456});
  if(opts.method==='POST'){const b=JSON.parse(opts.body);assert.deepEqual(b.agents,['unit-fixture']);assert.equal(b.expected_pid,456);assert.equal(b.expected_fleet,'fixture-fleet');assert.equal(b.expected_revision,'v1');writes++;dum={...dum,revision:'v2',states:{fixture:{state:'none',settings:{limit:12}}}};return Response.json({ok:true});}
  return Response.json(dum);
};
let service;
try{
  const r=parseNativeContext(request(),at);assert.equal(bindNative(r,plans,{fleet:'fixture-fleet',brokerPid:123,now:at}).agent,'unit-fixture');
  const telemetry=parseNativeContext(request().replace('END\n',`P\t61952\t30208\t200\nN\t1\t1\tHealth\t90\t0\t100\t100\t${at}\nEND\n`),at);
  assert.equal(telemetry.position.col,61);assert.equal(telemetry.position.row,30);assert.equal(telemetry.stats[0].value,90);
  for(const mutate of [p=>p.fleet='other',p=>p.broker_pid=124,p=>p.plans[0].paused=false,p=>p.plans[0].pid=999,p=>p.plans[0].room_wire.room_security_u32=94,p=>p.at-=7000]){
    const p=structuredClone(plans);mutate(p);assert.throws(()=>bindNative(r,p,{fleet:'fixture-fleet',brokerPid:123,now:at}));}
  assert.throws(()=>parseNativeContext(request(),at+7000));assert.throws(()=>parseNativeContext(request('DUM',at-7000,'a'.repeat(48),'toggle','fixture','','false'),at));
  assert.equal(settingValue(catalogue[0].settings[0],'14'),14);for(const x of ['0','21','1.5','"12"','null'])assert.throws(()=>settingValue(catalogue[0].settings[0],x));
  assert.throws(()=>changeFor({...r,strategy:'fixture',op:'toggle',value:'false'},{data:{...dum,strategy_cas:undefined}}));
  service=await startClientContext({dir,fleet:'fixture-fleet',brokerPid:123,port:0,fetcher,now:()=>at,alive:()=>{},schedule:false});
  assert.equal(requests.length,0,'no clients must cause zero HTTP reads');
  writeFileSync(join(dir,'native','321.tsv'),request());await service.tick();
  let header=readFileSync(join(dir,'views','321.tsv'),'utf8').split('\n')[0].split('\t');assert.equal(header.length,15);let token=header[11];
  assert.equal(requests.length,3);await service.tick();assert.equal(requests.length,3,'fresh cache reused');
  writeFileSync(join(dir,'native','321.tsv'),request('DUM',at,token,'toggle','fixture','','false'));await service.tick();assert.equal(writes,1);
  await service.tick();assert.equal(writes,1,'identical command cannot replay');
  const endpoint='http://127.0.0.1:'+service.server.address().port;
  const clients=await (await fetch(endpoint+'/v1/clients')).json();assert.equal(clients.clients[0].control,'human');assert.equal(clients.clients[0].conditions[0].source,'native-look-cache');assert.ok(!JSON.stringify(clients).includes('token'));
  assert.equal((await fetch(endpoint+'/v1/clients',{method:'POST'})).status,405);assert.equal((await fetch(endpoint+'/health',{headers:{origin:'https://example.test'}})).status,403);
  at+=5100;plans.at=plan.at=at;failDum=true;writeFileSync(join(dir,'native','321.tsv'),request());await service.tick();
  const retained=readFileSync(join(dir,'views','321.tsv'),'utf8');
  assert.ok(retained.includes('S\tfixture\tTest%20behavior'),'retain cached DUM catalogue');
  assert.ok(retained.includes('Cached%20DUM'),'label retained context');
  const failedReads=requests.length;await service.tick();assert.equal(requests.length,failedReads,'back off failed DUM refreshes');
  const staleToken=retained.split('\n')[0].split('\t')[11];
  writeFileSync(join(dir,'native','321.tsv'),request('DUM',at,staleToken,'toggle','fixture','','true'));await service.tick();assert.equal(writes,1,'stale retained context cannot write');
  at+=5100;plans.at=plan.at=at;failDum=false;writeFileSync(join(dir,'native','321.tsv'),request('hidden'));const before=requests.filter(([u])=>u.includes('8916')).length;
  await service.tick();assert.equal(requests.filter(([u])=>u.includes('8916')).length,before,'hidden tab does not refresh DUM');
  at+=7000;await service.tick();assert.equal((await (await fetch(endpoint+'/v1/clients')).json()).clients.length,0);
  console.log('PASS native context: exact human binding, typed controls, CAS requirement, expiry, dedup, passive condition relay, demand/cache, loopback read API');
}finally{service?.close();rmSync(dir,{recursive:true,force:true});}
