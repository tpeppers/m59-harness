// Offline: shared claims and real process death, no broker, roster or game.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {configureSpotClaimStore,reserveFileTraversal,markFileTraversal,releaseFileTraversal,
 reserveFilePassage,releaseFilePassage} from './m59-spotclaims.mjs';
import {withTraversalAdmission} from './m59-traversal-admission.mjs';
import {admittedIslandTransit} from './m59-island-route.mjs';

if(process.argv[2]==='crash-worker'){
 configureSpotClaimStore({directory:process.argv[3],namespace:'crash'});
 reserveFileTraversal('crashed',2505,'crashed-ticket');process.exit(0);
}
const dir=mkdtempSync(join(tmpdir(),'m59-traversal-')),room=2505;
let cases=0;
const reset=()=>configureSpotClaimStore({directory:dir,namespace:String(++cases)});
const proof=(agent,room)=>({agent,room,confirmed:true,at:Date.now()});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
try{
 for(const queueBudgetMs of [0,NaN]){
  let called=false;
  await assert.rejects(admittedIslandTransit({agent:'invalid-budget',state:{}},{queueBudgetMs,
   read:async()=>{called=true;},hop:async()=>{called=true;}}),/invalid_island_queue_budget/);
  assert.equal(called,false,'an invalid deadline cannot start observations or travel');
 }
 reset();
 {
  const a=reserveFileTraversal('a',room,'one').lease;
  assert.equal(reserveFilePassage('a',room,'narrow-neck').ok,true,'packet passage and whole transit are separate resources');
  assert.equal(releaseFileTraversal(a,proof('a',2000)),false,'a live admitted traveler has not entered yet');
  assert.equal(reserveFileTraversal('b',room,'two').ok,false);
  markFileTraversal(a,'entered');
  for(const p of [{...proof('a',2000),confirmed:false},proof('b',2000),proof('a',room),{...proof('a',2000),at:0}])
   assert.equal(releaseFileTraversal(a,p),false);
  assert.equal(releaseFilePassage('a'),true);
  assert.equal(reserveFileTraversal('b',room,'two').ok,false,'releasing a packet passage cannot release a map transit');
  assert.equal(releaseFileTraversal(a,proof('a',2000)),true);
  assert.equal(reserveFileTraversal('b',room,'two').ok,true);
 }
 reset();
 {
  const places=new Map([['a',2001],['b',2001]]),read=async a=>proof(a,places.get(a)),events=[];
  let beginA,finishA,parked=0;
  const started=new Promise(r=>beginA=r),finish=new Promise(r=>finishA=r);
  const a=withTraversalAdmission({agent:'a',state:{}},{room,read,run:async t=>{
   events.push('a enters');places.set('a',room);await t.entered();beginA();await finish;
   places.set('a',2504);await t.cleared();events.push('a clears');return 'a';
  }});
  await started;
  const b=withTraversalAdmission({agent:'b',state:{}},{room,read,pollMs:1,waitQueued:async()=>parked++,run:async t=>{
   events.push('b enters');places.set('b',room);await t.entered();places.set('b',2504);await t.cleared();return 'b';
  }});
  await pause(15);assert.deepEqual(events,['a enters']);assert.equal(places.get('b'),2001);assert.equal(parked,1);
  finishA();assert.deepEqual(await Promise.all([a,b]),['a','b']);assert.deepEqual(events,['a enters','a clears','b enters']);
 }
 reset();
 {
  const places=new Map([['a',2001],['b',2001]]),read=async a=>proof(a,places.get(a));
  await assert.rejects(withTraversalAdmission({agent:'a',state:{}},{room,read,run:async t=>{
   places.set('a',room);await t.entered();throw Error('refused jump');
  }}),/refused jump/);
  let enteredB=false;
  await assert.rejects(withTraversalAdmission({agent:'b',state:{}},{room,read,deadline:Date.now()+20,pollMs:1,
   run:async()=>{enteredB=true;}}),/queue_budget/);
  assert.equal(enteredB,false,'failed traveler still inside retains admission');
  places.set('a',2504);
  await withTraversalAdmission({agent:'b',state:{}},{room,read,run:async t=>{
   places.set('b',room);await t.entered();places.set('b',2504);await t.cleared();
  }});
 }
 reset();
 {
  const read=async a=>proof(a,2001);
  await assert.rejects(withTraversalAdmission({agent:'a',state:{}},{room,read,run:async()=>{throw Error('operator cancelled before entry');}}),/operator cancelled/);
  assert.equal(reserveFileTraversal('b',room,'after-cancel').ok,true,'a positively observed outside cancellation releases its ticket');
 }
 reset();
 {
  let reserved=0;
  await assert.rejects(withTraversalAdmission({agent:'a',state:{}},{room,read:async()=>proof('someone-else',2001),
   store:{reserve:()=>reserved++},run:async()=>{}}),/own_position_unconfirmed/);
  assert.equal(reserved,0);
 }
 reset();
 {
  const places=new Map([['a',2000],['b',2000]]),events=[];let enteredA,finishA,parkedB;
  const started=new Promise(r=>enteredA=r),finish=new Promise(r=>finishA=r),parked=new Promise(r=>parkedB=r);
  const read=async ctx=>({room:{num:places.get(ctx.agent)},you:{id:ctx.agent==='a'?1:2,predicted:false},hp:{value:20,max:20}});
  const caller=agent=>({agent,state:{},call:async()=>{throw Error('queued holder hint must not send status reads');}});
  const readCached=async agent=>({connected:true,in_game:true,room:{num:places.get(agent)}});
  const hop=async(ctx,to)=>{
   if(ctx.agent==='a'&&to===2504){enteredA();await finish;}
   events.push(ctx.agent+'->'+to);places.set(ctx.agent,to);
   if(ctx.agent==='b'&&to===2001)parkedB();return {ok:true,to};
  };
  const a=admittedIslandTransit(caller('a'),{from:2000,to:2504,read,readCached,hop});await started;
  const b=admittedIslandTransit(caller('b'),{from:2000,to:2504,read,readCached,hop});await parked;
  assert.equal(places.get('b'),2001);assert(!events.includes('b->2505'));
  finishA();await Promise.all([a,b]);
  assert.deepEqual(events,['a->2505','b->2001','a->2504','b->2000','b->2505','b->2504'],
   'the next returner waits in the inn until an actual cave exit, then uses ordinary hops');
 }
 reset();
 {
  const held=reserveFileTraversal('dead',room,'underworld').lease;markFileTraversal(held,'entered');
  let place=2000;
  await admittedIslandTransit({agent:'b',state:{},call:async(name,args)=>{
   assert.equal(name,'status');assert.equal(args.agent,'dead');return {connected:true,in_game:true,room:{num:1},hp:{value:0}};
  }},{from:2000,to:2504,readCached:async()=>({connected:true,in_game:true,room:{num:1},hp:{value:0}}),read:async c=>{
   if(c.agent==='dead')throw Error('traveller_died');return {room:{num:place},you:{id:2,predicted:false}};
  },hop:async(_ctx,to)=>{place=to;return {ok:true,to};}});
  assert.equal(place,2504,'an observed Underworld transition releases a dead predecessor without stopping the other travelers');
 }
 reset();
 {
  const held=reserveFileTraversal('a',room,'outward').lease;markFileTraversal(held,'entered');
  const places=new Map([['a',room],['b',2504]]),hops=[];let parked=0;
  await admittedIslandTransit({agent:'b',state:{},call:async()=>({connected:true,in_game:true,room:{num:places.get('a')}})},{from:2504,to:2000,
   readCached:async()=>({connected:true,in_game:true,room:{num:places.get('a')}}),
   read:async c=>({room:{num:places.get(c.agent)},you:{id:c.agent==='a'?1:2,predicted:false}}),
   park:async()=>{if(++parked===2)places.set('a',2504);return false;},
   hop:async(c,to)=>{assert.equal(places.get('a'),2504,'unavailable parking cannot waive the occupied-room claim');hops.push(to);places.set(c.agent,to);return {ok:true,to};}});
  assert.equal(parked,2,'the Island integration retries an unavailable parking scene before admission');assert.deepEqual(hops,[2505,2000]);
 }
 reset();
 {
  const held=reserveFileTraversal('a',room,'unparked-cancel').lease;markFileTraversal(held,'entered');
  let ownReads=0,entered=false,parking=0;
  await assert.rejects(withTraversalAdmission({agent:'b',state:{}},{room,pollMs:1,
   read:async agent=>{if(agent==='b'&&++ownReads>1)throw Error('owner cancelled');return proof(agent,agent==='a'?room:2504);},
   waitQueued:async()=>{parking++;return false;},run:async()=>{entered=true;}}),/owner cancelled/);
  assert.equal(parking,1);assert.equal(entered,false);
  assert.equal(reserveFileTraversal('c',room,'still-held').ok,false,'an unparked cancellation cannot release its predecessor');
 }
 reset();
 {
  const places=new Map([['a',2501],['b',2501]]),events=[];let enteredA,finishA,parkedB;
  const started=new Promise(r=>enteredA=r),finish=new Promise(r=>finishA=r),parked=new Promise(r=>parkedB=r);
  const read=async ctx=>({room:{num:places.get(ctx.agent)},you:{id:ctx.agent==='a'?1:2,predicted:false},hp:{value:20,max:20}});
  const caller=agent=>({agent,state:{},call:async(name,args)=>({connected:true,in_game:true,room:{num:places.get(args.agent)}})});
  const hop=async(ctx,to)=>{
   if(ctx.agent==='a'&&to===2503){enteredA();await finish;}
   events.push(ctx.agent+'->'+to);places.set(ctx.agent,to);return {ok:true,to};
  };
  const options={room:2502,from:2501,to:2503,read,hop,park:async ctx=>{events.push(ctx.agent+' parks');parkedB();}};
  const a=admittedIslandTransit(caller('a'),options);await started;
  const b=admittedIslandTransit(caller('b'),options);await parked;
  assert.equal(places.get('b'),2501,'the Hollows follower waits before its native arrival can occupy the jump approach');
  assert(!events.includes('b->2502'));
  finishA();await Promise.all([a,b]);
  assert.deepEqual(events,['a->2502','b parks','a->2503','b->2502','b->2503']);
 }
 configureSpotClaimStore({directory:dir,namespace:'crash'});
 {
  const worker=fork(fileURLToPath(import.meta.url),['crash-worker',dir],{windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('exit',code=>code===0?resolve():reject(Error('worker failed')));});
  const blocked=reserveFileTraversal('survivor',room,'new-ticket');
  assert.equal(blocked.ok,false);assert.equal(blocked.lease.driver_alive,false,'a dead process does not clear its living body');
  assert.equal(releaseFileTraversal(blocked.lease,proof('crashed',room)),false);
  assert.equal(releaseFileTraversal(blocked.lease,proof('crashed',2000)),true);
  assert.equal(reserveFileTraversal('survivor',room,'new-ticket').ok,true);
 }
 {
  const file=join(dir,'roster.json');
  writeFileSync(file,JSON.stringify({a:{credentials:{host:'127.0.0.1',port:7}}}));
  process.env.M59_STATE_FILE=file;delete process.env.M59_SPOT_CLAIMS_DIR;delete process.env.M59_SPOT_CLAIMS_NAMESPACE;
  configureSpotClaimStore({enabled:false});let place=2000;
  await withTraversalAdmission({agent:'a',fleet:'offline',state:{}},{room,read:async a=>proof(a,place),run:async t=>{
   place=room;await t.entered();place=2000;await t.cleared();
  }});
  assert(existsSync(join(dir,'.spot-claims')),'ordinary CLI defaults scope the shared store to the actual roster directory');
 }
 console.log('Traversal admission checks passed: parallel callers, reserved entry, confirmed exit, stopped body, cancellation, a crashed driver and default roster scoping.');
}finally{
 const target=resolve(dir),base=resolve(tmpdir())+sep;
 if(!target.startsWith(base))throw Error('scratch cleanup escaped temporary directory');
 rmSync(target,{recursive:true,force:true});
}
