import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Session} from './m59-game.mjs';
import {Autopilot,PASS_STAGES} from './m59-autopilot.mjs';
import {OF} from './m59-parse.mjs';
import {withPacketScope,bindPacketScope} from './m59-packet-scope.mjs';
import {currentSurvivalDecision} from './m59-survival-decision.mjs';
import * as party from './m59-party.mjs';
import {load,firstAnswer} from './m59-strategies.mjs';
import {cooperativeStore,configureCooperativeLogoff,publishCooperativePresence,requestCooperativeLogoff,markCooperativeOffline,
  cooperativeBeforeLogin,cooperativeAfterLogin,cooperativeAssist,cooperativeHelperReady,
  prepareCooperativeRefuge,cooperativeReturnRefuge} from './m59-cooperative-logoff.mjs';
import {cooperativeReconnectRefusal} from './m59-cooperative-logoff.mjs';
const dir=mkdtempSync(join(tmpdir(),'m59-cooperative-logoff-'));
party.setRosterSource(()=>new Set(['Victim','Helper','Second']));
const policy={enabled:true,helper_health:.95,danger_quiet_ms:3000,cooldown_ms:60000,attempt_ms:6000};
function fixture(label='case'){
 const directory=join(dir,label),cred=character=>({host:'fixture.invalid',port:15959,character,account:'offline-test',password:'unused'});
 const monster={id:40,nameRsc:'daemon skeleton',flags:OF.ATTACKABLE,row:10,col:10};
 const bodies=[{id:1,nameRsc:'Victim',flags:OF.PLAYER},{id:2,nameRsc:'Helper',flags:OF.PLAYER},monster];
 const actor=(name,id,character)=>{
  const s=Object.create(Session.prototype),c={state:'game',combatReady:true,me:{name:character},selfId:id,self:{id,row:10,col:10},
   room:{id:8270,objects:new Map(bodies.map(o=>[o.id,{...o}]))},rsc:{get:x=>x},idsAsOf:()=>({last_save_at:7}),vitals:()=>({health:{value:100,max:100},vigor:{value:180}}),sock:{destroy(){c.state='offline';}}};
  Object.assign(s,{name,client:c,credentials:cred(character),fleetStateFile:join(directory,'fleet.json'),cooperativeLogoffDirectory:directory,world:{room:{num:827}},movementGeneration:1,
   cancelMovement:()=>({cancelled:true}),movementWasCancelled:g=>g!==s.movementGeneration});
  s._askStrategies=async()=>({strategy:'fixture-private',answer:policy});
  const pilot={s,mode:'farm',tally:{},stageInFlight:new Map(),inReachOfUs:()=>[...c.room.objects.values()].filter(o=>!(o.flags&OF.PLAYER)),
   currentRecoveryWall:()=>false,safety:()=>({fleeAt:.9}),checkFreeze:()=>false,facultyHeld:()=>false,fightFloor:()=>80,threat:()=>({landing:0}),note(){},
   fightNow:async opts=>({target_id:opts.exactTargetId,landed_hits:1})};
  return {s,c,pilot};
 };
 const a=actor('victim',1,'Victim'),b=actor('helper',2,'Helper');
 const setup=async()=>{await configureCooperativeLogoff(b.pilot,'helper');const offered=await configureCooperativeLogoff(a.pilot,'request');return requestCooperativeLogoff(a.pilot,offered);};
 const offline=r=>{a.c.sock.destroy();a.s.client=null;markCooperativeOffline(a.s);const store=cooperativeStore(a.s),record=store.read('request','victim');record.offline_at=Date.now()-1000;store.write('request','victim',record);return record;};
 return {a,b,setup,offline,store:()=>cooperativeStore(a.s)};
}
try{
 {
  const directory=join(dir,'private-hook');mkdirSync(directory);
  writeFileSync(join(directory,'cooperative.mjs'),"export default {name:'fixture-cooperation',kind:'cooperative',enabled:true,cooperativeLogoff:()=>({enabled:true})};");
  const loaded=await load({dir:directory,log:()=>{}});assert.equal(loaded.problems.length,0);
  assert.equal((await firstAnswer(loaded,'cooperativeLogoff',{phase:'helper'})).answer.enabled,true);
  console.log('PASS the ordinary private strategy loader discovers the Cooperative kind and hook; no public tactic is enabled');
 }
 {
  const f=fixture('owned-admission-lock'),store=f.store(),path=join(store.dir,'room-827.lock');
  store.lock(827,()=>{
    const owner=JSON.parse(readFileSync(path,'utf8'));assert.equal(owner.pid,process.pid);assert(owner.process_started_at>0&&owner.token);
    writeFileSync(path,JSON.stringify({...owner,token:'replacement-owner'}));
  });
  assert.equal(JSON.parse(readFileSync(path,'utf8')).token,'replacement-owner','release cannot delete another owner\'s replacement lock');
  assert.equal(store.lock(827,()=>assert.fail('a held lock was bypassed')),null);
  console.log('PASS admission locks preserve PID/start/token evidence and never unlink a replacement or bypass a held owner');
 }
 {
  const f=fixture('admission');const r=await f.setup();assert(r&&r.helpers.includes('helper'));
  const offered=await configureCooperativeLogoff(f.b.pilot,'request');assert.equal(requestCooperativeLogoff(f.b.pilot,offered),null,'last helper stays online');
  const stranger=fixture('isolated');stranger.b.s.credentials.port=15960;await configureCooperativeLogoff(stranger.b.pilot,'helper');
  assert.equal(requestCooperativeLogoff(stranger.a.pilot,await configureCooperativeLogoff(stranger.a.pilot,'request')),null,'another server cannot qualify as a helper');
  console.log('PASS exact roster/server/room admission reserves the last online helper');
 }
 {
  const f=fixture('defer');await f.setup();f.offline();let calls=0;
  f.b.pilot.fightNow=async opts=>(calls++,{target_id:opts.exactTargetId,landed_hits:0});
  f.b.s.combat={active:{}};assert.equal(await cooperativeAssist(f.b.pilot),false);f.b.s.combat=null;
  f.b.s.damagedAt=Date.now();assert.equal(await cooperativeAssist(f.b.pilot),false);f.b.s.damagedAt=0;
  f.b.pilot.stageInFlight.set('passFarm',Promise.resolve());assert.equal(await cooperativeAssist(f.b.pilot),false);f.b.pilot.stageInFlight.clear();
  assert.equal(calls,0);assert.equal(await cooperativeAssist(f.b.pilot),true);assert.equal(calls,1);
  assert.deepEqual(f.store().read('request','victim').receipts,{},'a miss cannot release login');
  let polls=0;await assert.rejects(cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{wait:async()=>{if(++polls===2)throw Error('still offline');}}),/still offline/);
  assert.equal(polls,2);assert(f.a.s.cooperativeLogoffWaiting);
  console.log('PASS helpers defer during combat/danger/unfinished work; a submitted attack or miss never releases reconnect');
 }
 {
  const f=fixture('confirmed');await f.setup();f.offline();let options;
  f.b.pilot.fightNow=async o=>(options=o,{target_id:o.exactTargetId,landed_hits:1});
  assert(await cooperativeAssist(f.b.pilot));assert.equal(options.rounds,1);assert.equal(options.loot,false);assert.equal(options.exactTargetId,40);
  await cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{wait:async()=>assert.fail('a real hit should release immediately')});
  assert.equal(f.store().read('request','victim').state,'returning','login failure/restart must still revalidate the hit');
  const restarted={name:'victim',fleetStateFile:f.a.s.fleetStateFile,cooperativeLogoffDirectory:f.a.s.cooperativeLogoffDirectory};
  await cooperativeBeforeLogin(restarted,f.a.s.credentials,{wait:async()=>assert.fail('durable receipt should survive a keeper restart')});
  f.b.c.vitals=()=>({health:{value:0,max:100}});f.b.s._cooperativePublishedAt=0;publishCooperativePresence(f.b.pilot);
  await assert.rejects(cooperativeBeforeLogin(restarted,f.a.s.credentials,{wait:async()=>{throw Error('helper died');}}),/helper died/);
  f.b.c.vitals=()=>({health:{value:100,max:100}});f.b.s._cooperativePublishedAt=0;publishCooperativePresence(f.b.pilot);
  await cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{wait:async()=>assert.fail('fresh living helper should qualify again')});
  cooperativeAfterLogin(f.a.s);assert.equal(f.store().read('request','victim').state,'resumed');
  console.log('PASS confirmed exact-target hits release login, survive restart, and are rechecked if the helper dies before login');
 }
 {
  const f=fixture('scope');await f.setup();f.offline();let queued;
  f.b.pilot.fightNow=async()=>{queued=bindPacketScope('attack',()=>assert.fail('stale packet ran'));f.b.s.movementGeneration++;queued();};
  await cooperativeAssist(f.b.pilot);assert.deepEqual(f.store().read('request','victim').receipts,{});
  assert.throws(queued,/preempted/);
  f.b.s.cooperativeLoginAllowed=()=>false;f.a.s.cooperativeLoginAllowed=()=>false;
  await assert.rejects(cooperativeBeforeLogin(f.a.s,f.a.s.credentials),/ownership/);
  console.log('PASS actual paced scope revokes stale distraction packets and operator stop cancels the pending login');
 }
 {
  const f=fixture('multiple-threats');
  for(const actor of [f.a,f.b])actor.c.room.objects.set(41,{id:41,nameRsc:'narthyl worm',flags:OF.ATTACKABLE,row:10,col:11});
  await f.setup();f.offline();await cooperativeAssist(f.b.pilot);
  await assert.rejects(cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{wait:async()=>{throw Error('second attacker not distracted');}}),/second attacker/);
  const r=f.store().read('request','victim');r.last_attempt_at=0;f.store().write('request','victim',r);
  await cooperativeAssist(f.b.pilot);await cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{wait:async()=>assert.fail('both attackers have proved hits')});
  assert.equal(Object.keys(f.store().read('request','victim').receipts).length,2);
  console.log('PASS every captured nearby monster needs its own confirmed hit; one distraction cannot release a multi-attacker victim');
 }
 {
  const f=fixture('resume-during-fight-cleanup');await f.setup();f.offline();let killCredit=0;
  f.b.pilot.recordCooperativeKill=()=>killCredit++;
  f.b.pilot.fightNow=async options=>{
    let packets=0;
    bindPacketScope('move',()=>packets++)();
    bindPacketScope('attack',()=>packets++)();
    assert.equal(packets,2,'the helper may perform its own approach and one hit, while foreign movement remains refused');
    await options.onLandedHit({target_id:40,landed_hits:1});
    await cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{wait:async()=>assert.fail('landed hit should release before cleanup')});
    cooperativeAfterLogin(f.a.s);
    bindPacketScope('read',()=>{})();
    assert.throws(bindPacketScope('attack',()=>assert.fail('second attack after release')),/claim expired/);
    return{target_id:40,target:'daemon skeleton',landed_hits:1,killed:true};
  };
  await cooperativeAssist(f.b.pilot);assert.equal(killCredit,1);
  console.log('PASS an observed hit releases the victim before helper cleanup; final reads and kill credit survive, another attack is fenced');
 }
 {
  const s=Object.create(Session.prototype),c={state:'game',evSeq:0,selfId:1,self:{id:1,row:10,col:10},
    room:{id:8270,objects:new Map([[1,{id:1}],[40,{id:40,row:10,col:11}]])},vitals:()=>({health:{value:100,max:100}})};
  let receipt=false,stats=false;
  Object.assign(s,{client:c,faceToward:async()=>{},pacer:{submit:async(kind,fn)=>fn()}});
  c.attack=()=>{s.observeAttackMessage({kind:'said',seq:++c.evSeq,text:'You hit the daemon skeleton.'},c);assert.equal(receipt,false);
    s.observeAttackMessage({kind:'message',seq:++c.evSeq,text:'You hit the daemon skeleton.'},c);assert.equal(receipt,true);};
  c.stats=()=>{stats=true;assert(receipt,'the streamed receipt must precede even attackRounds internal stats');};
  c.waitFor=async()=>({events:[]});
  await s.attackRounds(40,1,{onMessages:messages=>{assert.deepEqual(messages,['You hit the daemon skeleton.']);receipt=true;}});
  assert(stats);assert.equal(s.attackMessageObservers.size,0,'completed native exchange removes its callback');
  c.attack=()=>{throw Error('socket failed');};
  await assert.rejects(s.attackRounds(40,1,{onMessages:()=>{}}),/socket failed/);
  assert.equal(s.attackMessageObservers.size,0,'failed native exchange removes its callback too');
  console.log('PASS actual native attack exchange streams server prose before its internal health wait, excludes chat and cleans up after failure');
 }
 {
  const f=fixture('native-play-dead');await configureCooperativeLogoff(f.b.pilot,'helper');
  const p=f.a.pilot;
  Object.assign(p,{operatorSurvivalStandDown:()=>false,suspendJourney(){},adoptRecoveryWall:()=>false,playerThreatPresent:()=>false,
   fleetLogoff:Autopilot.prototype.fleetLogoff,reconnect:Autopilot.prototype.reconnect,
   resumeCooperativeReturn:Autopilot.prototype.resumeCooperativeReturn});
  let recoveryCalls=0;
  p.takeRecoverySpot=async(why,opts)=>{assert.equal(f.a.s.client.combatReady,true);assert.equal(currentSurvivalDecision(f.a.s).id,opts.decisionId);recoveryCalls++;return{took:true};};
  f.a.s.joinOnce=async credentials=>{f.a.s.credentials=credentials;f.a.s.client={...f.a.c,state:'game'};return{joined:true};};
  const run=Autopilot.prototype.playDead.call(p,'captured off-wall danger');
  await new Promise(r=>setTimeout(r,900));assert.equal(f.a.s.client,null);
  assert(await cooperativeAssist(f.b.pilot));assert.equal(await run,true);
  assert.equal(p.tally.logoffs,1);assert.equal(p.frozenUntil,null);assert.equal(currentSurvivalDecision(f.a.s).reason_code,'cooperative_return');
  assert.equal(recoveryCalls,1,'the original playDead call must already have routed to cover without another pass');
  await p.resumeCooperativeReturn();assert.equal(recoveryCalls,1,'boot and reconnect callbacks cannot repeat the escape');
  assert.equal(f.store().read('request','victim').state,'resumed');
  console.log('PASS actual off-wall playDead routes immediately after gated login, before another pass, and never repeats its return');
 }
 {
  const f=fixture('prepared-origin');
  Object.assign(f.a.c.self,{x:672,y:672});f.a.c.room.objects.set(1,{...f.a.c.self,nameRsc:'Victim',flags:OF.PLAYER});
  f.b.c.room.objects.set(1,{...f.a.c.self,nameRsc:'Victim',flags:OF.PLAYER});
  f.b.s.world.geometry={rows:30,cols:30};
  const r=await f.setup();let plannedFrom;
  f.b.pilot.searchSafeSpot=function(geo,from){
    plannedFrom=from;assert.equal(this.s.name,'victim');assert.equal(this.s.client.selfId,1);
    assert.equal(this.s.client.room.objects.get(2).id,2,'the helper remains a blocking peer for the victim');
    return{row:9,col:10,steps_away:1,fine:{x:672,y:608}};
  };
  f.offline();assert(await cooperativeAssist(f.b.pilot));assert.equal(plannedFrom.x,672);
  await cooperativeBeforeLogin(f.a.s,f.a.s.credentials);f.a.s.client=f.a.c;f.a.c.state='game';
  assert.equal(cooperativeReturnRefuge(f.a.s).row,9);
  f.a.c.self.x+=4;assert.equal(cooperativeReturnRefuge(f.a.s),null,'actual shifted landing invalidates the peer hint');f.a.c.self.x-=4;
  f.a.c.self.predicted=true;assert.equal(cooperativeReturnRefuge(f.a.s),null);delete f.a.c.self.predicted;
  f.a.c.idsAsOf=()=>({last_save_at:8});assert.equal(cooperativeReturnRefuge(f.a.s),null);f.a.c.idsAsOf=()=>({last_save_at:7});
  assert.equal(cooperativeReturnRefuge(f.a.s,{now:Date.now()+31000}),null,'old hints cannot become movement authority');
  f.b.c.room.objects.get(1).nameRsc='Recycled body';assert.equal(prepareCooperativeRefuge(f.b.pilot,r),null);
  console.log('PASS offline peer preparation uses the victim ghost, never the helper body; changed landing/save/identity and stale hints refuse');
 }
 {
  const f=fixture('boot-return'),p=f.a.pilot;
  f.a.s.cooperativeLogoffReturn={request_id:'restarted-waiter',room:827};
  Object.assign(p,{operatorSurvivalStandDown:()=>false,takeRecoverySpot:async()=>({took:true})});
  p.resumeCooperativeReturn=Autopilot.prototype.resumeCooperativeReturn;
  assert(await p.resumeCooperativeReturn());assert.equal(currentSurvivalDecision(f.a.s).reason_code,'cooperative_return');
  const other=fixture('boot-owned'),q=other.a.pilot;other.a.s.cooperativeLogoffReturn={request_id:'held'};
  Object.assign(q,{operatorSurvivalStandDown:()=>false,facultyHeld:()=>true,takeRecoverySpot:()=>assert.fail('foreign owner must not move')});
  assert.equal(await Autopilot.prototype.resumeCooperativeReturn.call(q),false);
  const source=readFileSync(new URL('./m59-keeper-process.mjs',import.meta.url),'utf8');
  assert(source.indexOf('await autopilot.resumeCooperativeReturn?.()')<source.indexOf('autopilot.start();'));
  console.log('PASS restarted waiters establish refuge recovery before farming starts, while operator faculty ownership still refuses');
 }
 {
  const pilot={s:{},tally:{},killTimes:[],ledgerEvent:(kind,row)=>pilot.rows.push({kind,...row}),rows:[],currentRecoveryWall:()=>false,farmStrategyHook(){}};
  Autopilot.prototype.recordCooperativeKill.call(pilot,{killed:true,target:'daemon skeleton',rounds:1},{id:'rescue-credit',room:827});
  assert.equal(pilot.tally.kills,1);assert.equal(pilot.rows[0].cooperative_distraction,true);
  console.log('PASS a one-hit distraction kill retains normal credited-kill telemetry');
 }
 {
  const f=fixture('native-control-rejoin');await f.setup();f.offline();let sideEffects=0,reply;
  const source=readFileSync(new URL('./m59-keeper-process.mjs',import.meta.url),'utf8');
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  for(const path of ['/join','/rejoin']){
    const start=source.indexOf("    if (req.method === 'POST' && path === '"+path+"')");
    const end=source.indexOf('\n    if (',start+10);assert(start>0&&end>start);
    const run=new AsyncFunction('req','path','readBody','requireAddressedWrite','refuseWhileDormant','cooperativeReconnectRefusal','session','credHost','credPort','json','changeJoinIntent','autopilot','join',source.slice(start,end));
    await run({method:'POST'},path,async()=> '{}',()=>true,()=>false,cooperativeReconnectRefusal,f.a.s,'fixture.invalid',15959,
      (body,status)=>reply={body,status},()=>sideEffects++,{stop:()=>sideEffects++},async()=>sideEffects++);
    assert.equal(reply.status,423);assert.equal(reply.body.reason_code,'cooperative_wait');
  }
  assert.equal(sideEffects,0,'native broker requests must not stop the keeper, close its continuation or start another login');
  console.log('PASS actual native /join and /rejoin handlers refuse before every stop/change/login side effect during a cooperative wait');
 }
 {
  let ticked=0;
  const pilot={s:{combat:{active:{pvp:true},tick:async()=>ticked++}},fleetLogoff:()=>assert.fail('PvP must not enter a monster-distraction logoff')};
  assert.equal(await Autopilot.prototype.playDead.call(pilot,'player combat'),true);assert.equal(ticked,1);
  console.log('PASS active PvP retains combat ownership instead of handing its body to the cooperative tactic');
 }
 {
  const f=fixture('native-rejoin');await f.setup();let connected=0;
  f.a.s.joinOnce=async credentials=>{connected++;f.a.s.credentials=credentials;return{joined:true};};
  const pending=f.a.s.rejoin('cooperative test');await new Promise(r=>setTimeout(r,900));assert.equal(connected,0,'native reconnect must not log in on its old 800ms timer');
  assert.equal(cooperativeReconnectRefusal(f.a.s).reason_code,'cooperative_wait','a competing rejoin must refuse before it stops or replaces this continuation');
  assert.equal(f.store().read('request','victim').state,'offline');
  assert(await cooperativeAssist(f.b.pilot));await pending;assert.equal(connected,1);assert.equal(f.store().read('request','victim').state,'resumed');
  console.log('PASS actual Session.rejoin destroys the old socket, waits for distraction, and completes exactly one gated login');
 }
 assert(PASS_STAGES.indexOf('passCooperative')>PASS_STAGES.indexOf('passFleeAndRest'));
 assert(PASS_STAGES.indexOf('passCooperative')<PASS_STAGES.indexOf('passFarm'));
 console.log('PASS cooperative work runs after survival and before discretionary farming');
}finally{party.setRosterSource(null);rmSync(dir,{recursive:true,force:true});}
