import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {atomicJson} from './m59-inventory-intent.mjs';
import {startService} from './m59-inventory-intent-service.mjs';
import {sendIntent} from './m59-inventory-intent-send.mjs';
const dir=mkdtempSync(join(tmpdir(),'m59-drop-service-test-'));
const identity={server:'fixture.invalid:5959',account:'fixture',character:'Fixture',player_id:17};
let service,capability=true,confirmed=true;const calls=[];
const broker=createServer((req,res)=>{
  const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if(req.url==='/health')return json({ok:true,pid:77,root:dir,fleet:'test',sessions:['t1'],session_object_ids:{t1:17},session_characters:{t1:'Fixture'},inventory_drop:capability?1:0});
  let body='';req.on('data',b=>body+=b);req.on('end',()=>{
    const {name,arguments:a}=JSON.parse(body).params;let value;
    if(name==='pilot')value={piloted:[]};else if(name==='fleet')value={fleet:[]};
    else {calls.push([name,a]);if(name==='commander_lease')value=a.action==='acquire'?{lease_token:'fixture-lease'}:{};
      else if(name==='inventory_drop')value={requested:true,confirmed};else throw Error('Unexpected mock RPC '+name);}
    json({result:{content:[{type:'text',text:JSON.stringify(value)}]}});
  });
});
await new Promise(done=>broker.listen(0,'127.0.0.1',done));
try {
  atomicJson(join(dir,'observed','bot-'+process.pid+'.json'),{schema:'m59-inventory-plan/1',at:Date.now(),pid:process.pid,
    agent:'t1',identity,room:39,room_wire:{room_resource_id:22,room_security_u32:33},items:[{id:31,name:'herb',amount:17,equipped:false,recommended:false}]});
  service=await startService({fleet:'test',dir,port:0,broker:'http://127.0.0.1:'+broker.address().port,brokerRoot:dir,
    roster:[{agent:'t1',host:'fixture.invalid',port:5959,account:'fixture',character:'Fixture'}]});
  const base='http://127.0.0.1:'+service.server.address().port;
  const body={fleet:'test',broker_pid:77,agent:'t1',character:'Fixture',player_id:17,item_id:31,item_name:'herb',revision:0,
    state:'drop',location:'pack',source:'operator',amount:4,expected_amount:17,clicked_at:Date.now()};
  const headers={'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/drop',{method:'POST',headers,body:JSON.stringify(body)})).status,403);assert.equal(calls.length,0);
  const {token}=JSON.parse(readFileSync(join(dir,'service.json'),'utf8'));
  assert.equal((await fetch(base+'/drop',{method:'POST',headers:{...headers,'x-m59-intent-token':token,Origin:'https://fixture.invalid'},body:JSON.stringify(body)})).status,403);
  await assert.rejects(sendIntent({...body,amount:18},{dir,viewer:false}));assert.equal(calls.length,0);
  const result=await sendIntent(body,{dir,viewer:false});assert.equal(result.dropped,true);
  assert.deepEqual(calls.map(c=>c[0]),['commander_lease','inventory_drop','commander_lease']);
  assert.equal(calls[1][1].amount,4);assert.equal(calls[1][1].item,31);
  await assert.rejects(sendIntent(body,{dir,viewer:false}));assert.equal(calls.length,3);
  // No metadata intention is changed by a drop.
  const plans=await fetch(base+'/plans').then(r=>r.json());assert.equal(plans.plans[0].revision,0);
  confirmed=false;await new Promise(r=>setTimeout(r,2));
  assert.equal((await sendIntent({...body,clicked_at:Date.now()},{dir,viewer:false})).dropped,false);
  assert.equal(calls.filter(c=>c[0]==='inventory_drop').length,2);
  capability=false;await service.tick();calls.length=0;
  await assert.rejects(sendIntent({...body,clicked_at:Date.now()},{dir,viewer:false}),e=>e.code==='DROP_UNAVAILABLE');assert.equal(calls.length,0);
  console.log('Drop service tests passed: authenticated POST, origin refusal, validation before lease, one-shot confirmation, passive result, no metadata changes, old backend refusal.');
}finally {service?.close();broker.closeAllConnections();await new Promise(done=>broker.close(done));rmSync(dir,{recursive:true,force:true});}
