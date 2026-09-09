import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {atomicJson,saleBlocked} from './m59-inventory-intent.mjs';
import {startService,parseClientPack,encode} from './m59-inventory-intent-service.mjs';
import {sendIntent,attestViewer} from './m59-inventory-intent-send.mjs';
const dir=mkdtempSync(join(tmpdir(),'m59-intent-service-test-'));
const identity={server:'fixture.invalid:5959',account:'fixture',character:'Fixture',player_id:17};
let pilot=[],badBroker=false,unexpected=0,service;
const broker=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.method==='GET'&&req.url==='/health')return res.end(JSON.stringify({ok:true,pid:77,root:dir,
    fleet:badBroker?'wrong':'test',sessions:['t1'],session_object_ids:{t1:17},session_characters:{t1:'Fixture'}}));
  let text='';req.on('data',b=>text+=b);req.on('end',()=>{
    const body=JSON.parse(text);
    if(body.params?.name!=='pilot'||body.params?.arguments?.action!=='status'){unexpected++;res.statusCode=403;return res.end('{}');}
    res.end(JSON.stringify({result:{content:[{type:'text',text:JSON.stringify({piloted:pilot})}]}}));
  });
});
await new Promise(done=>broker.listen(0,'127.0.0.1',done));
try {
  const now=Date.now();
  atomicJson(join(dir,'observed','bot-'+process.pid+'.json'),{schema:'m59-inventory-plan/1',at:now,pid:process.pid,
    agent:'t1',identity,room:10,room_wire:{room_resource_id:22,room_security_u32:33},items:[
      {id:31,name:'herb',amount:7,equipped:false,recommended:true,role:'food',reason:'surplus'},
      {id:32,name:'long sword',amount:1,equipped:true,recommended:false,role:'weapon',reason:'equipped'}]});
  service=await startService({fleet:'test',dir,port:0,broker:'http://127.0.0.1:'+broker.address().port,brokerRoot:dir,
    roster:[{agent:'t1',host:'fixture.invalid',port:5959,account:'fixture',character:'Fixture'}]});
  const base='http://127.0.0.1:'+service.server.address().port;
  const plans=()=>fetch(base+'/plans').then(r=>r.json());
  assert.equal((await plans()).plans[0].items[0].state,'sell');
  const change={fleet:'test',broker_pid:77,agent:'t1',character:'Fixture',player_id:17,item_id:31,item_name:'herb',
    revision:0,state:'keep',source:'operator',clicked_at:Date.now()};
  assert.equal((await fetch(base+'/intent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(change)})).status,403);
  assert.equal((await fetch(base+'/plans',{headers:{Origin:'http://example.invalid'}})).status,403);
  assert.equal((await sendIntent(change,{dir,viewer:false})).state,'keep');
  assert.equal((await plans()).plans[0].items[0].state,'keep');
  assert.match(saleBlocked({credentials:{host:'fixture.invalid',port:5959,account:'fixture'},client:{me:{id:17,name:'Fixture'}}},
    {id:31,name:'herb'},{dir}),/veto/);
  await assert.rejects(sendIntent(change,{dir,viewer:false}),/refused/);
  await assert.rejects(sendIntent({...change,revision:1,item_name:'wrong'},{dir,viewer:false}),/refused/);
  const ai=await sendIntent({...change,revision:1,state:'sell',source:'ai'},{dir,viewer:false});
  assert.equal(ai.state,'keep');assert.equal(ai.revision,1);
  const blocked=await sendIntent({...change,revision:1,item_id:32,item_name:'long sword',state:'sell'},{dir,viewer:false});
  assert.equal(blocked.blocked,true);
  const pack=['M59PACK',1,Date.now(),process.pid,encode(identity.server),identity.account,identity.character,17,20,22,33].join('\t')+
    '\nI\t31\therb\t8\t0\t123\t0\nI\t32\tlong%20sword\t1\t1\t124\t0\nEND\n';
  assert.equal(parseClientPack(pack).items[0].amount,8);
  assert.throws(()=>parseClientPack(pack,Date.now()+7000));
  assert.throws(()=>parseClientPack(pack.replace('\nEND\n','\nI\t31\therb\t8\t0\t123\t0\nEND\n')));
  pilot=[{agent:'t1',character:'Fixture',object_id:17,pid:process.pid,alive:true}];
  await service.tick(); // Real login gap: keeper is stopped before native data arrives.
  assert.equal((await plans()).plans.length,0);
  mkdirSync(join(dir,'clients'),{recursive:true});writeFileSync(join(dir,'clients',process.pid+'.tsv'),pack);
  await service.tick();
  const possessed=(await plans()).plans[0];
  assert.equal(possessed.paused,true);assert.equal(possessed.items[0].amount,8);
  assert.equal(possessed.items[0].role,'food');assert.equal(possessed.items[0].state,'keep');
  assert.match(readFileSync(join(dir,'views',process.pid+'.tsv'),'utf8'),/I\t31\therb\tkeep/);
  const view=readFileSync(join(dir,'viewer.tsv'),'utf8');assert.match(view,/I\tt1\t31\therb\t8\t0\tfood\t\tkeep\toperator/);
  await sendIntent({...change,revision:2,state:'sell',clicked_at:Date.now()},{dir,viewer:false});
  assert.match(readFileSync(join(dir,'views',process.pid+'.tsv'),'utf8'),/I\t31\therb\tsell/);
  assert.match(saleBlocked({credentials:{host:'fixture.invalid',port:5959,account:'fixture'},client:{me:{id:17,name:'Fixture'}}},
    {id:31,name:'herb'},{dir}),/possessed/);
  // Attest a dummy local viewer package; never load or execute it.
  const install=join(dir,'mod');mkdirSync(join(install,'Data'),{recursive:true});
  writeFileSync(join(install,'Data','RedAlert.dll'),'fixture');
  const sessionPath=join(dir,'session.json'),session={schema:'m59-cnc-view-session/v1',mode:'live_cached_read',
    authority:{writes_enabled:false,launch_policy:'observe-only'},identity:{expected:{fleet:'test',broker_pid:77}},
    package:{install_root:install,redalert_dll_sha256:createHash('sha256').update('fixture').digest('hex')}};
  atomicJson(sessionPath,session);attestViewer({...change,session:sessionPath},{sessionPath});
  assert.throws(()=>attestViewer({...change,broker_pid:99,session:sessionPath},{sessionPath}),/broker/);
  writeFileSync(join(install,'Data','RedAlert.dll'),'changed');
  assert.throws(()=>attestViewer({...change,session:sessionPath},{sessionPath}),/build/);
  badBroker=true;await service.tick();assert.equal((await plans()).plans.length,0);

// A STRUGGLING BROKER MUST BE ASKED LESS OFTEN, NOT AT THE SAME RATE.
//
// This polled flat at 1s for ever. Every tick costs the broker a full /health — 21 sessions
// enumerated — plus a pilot RPC, and both are ABORTED at 2.5s/3.5s, which does not cancel
// the work: the broker computes the answer and finds nobody there. m59-cnc's own launcher
// warns a rejoin sweep "can stall the broker for most of a minute", so the old behaviour
// spent that minute asking sixty more times, hardest exactly when it could least afford it.
{
  const first=service.pollMs();
  assert.ok(first>1000,`one failure must widen the interval, got ${first}`);
  await service.tick();
  const second=service.pollMs();
  assert.ok(second>first,`consecutive failures must keep widening, got ${second} after ${first}`);
  assert.ok(second<=30000*1.15,`and stay capped, got ${second}`);
  // AND IT MUST CLOSE AGAIN. A backoff with no way back is a service that quietly stops
  // being useful after one bad minute and never recovers.
  badBroker=false;await service.tick();
  assert.equal(service.pollMs(),1000,'a good tick returns to the base interval at once');
  // PUT THE FIXTURE BACK. The cases after this one need a service that is NOT current, and
  // a recovery check that quietly heals it would make them assert nothing.
  badBroker=true;await service.tick();
}
  await assert.rejects(sendIntent({...change,revision:3},{dir,viewer:false}),/not current/);
  assert.equal(unexpected,0);
  console.log('inventory service tests passed: authenticated clicks, AI/veto, CAS, native handoff, paused sales, viewer attestation, stale identity');
} finally {
  service?.close();broker.closeAllConnections();await new Promise(done=>broker.close(done));rmSync(dir,{recursive:true,force:true});
}
