import { readToolSource } from './autopilot/source.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,readdirSync,renameSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Session} from './m59-game.mjs';
import {Autopilot,PASS_STAGES} from './m59-autopilot.mjs';
import {OF} from './m59-parse.mjs';
import {withPacketScope,bindPacketScope} from './m59-packet-scope.mjs';
import {chooseSurvivalDecision,currentSurvivalDecision} from './m59-survival-decision.mjs';
import {noteLogoff} from './m59-healing-session.mjs';
import * as party from './m59-party.mjs';
import {load,firstAnswer} from './m59-strategies.mjs';
import {cooperativeStore,configureCooperativeLogoff,publishCooperativePresence,requestCooperativeLogoff,markCooperativeOffline,
  cooperativeBeforeLogin,cooperativeAfterLogin,cooperativeAssist,cooperativeHelperReady,
  prepareCooperativeRefuge,cooperativeReturnRefuge} from './m59-cooperative-logoff.mjs';
import {cooperativeReconnectRefusal,cooperativeWaitActive,replaceFileSync,stuckCooperativeLogoff,abortPreparingCooperativeLogoff,
  PREPARING_MAX_MS,OFFLINE_OVERRUN_MS} from './m59-cooperative-logoff.mjs';
// Healing sessions (one logoff each) go to a temp dir, never the checkout's substrate/.healing.
process.env.M59_HEALING_DIR=(await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(),'m59-coop-healing-'));
const dir=mkdtempSync(join(tmpdir(),'m59-cooperative-logoff-'));
party.setRosterSource(()=>new Set(['Victim','Helper','Second']));
const policy={enabled:true,helper_health:.95,danger_quiet_ms:3000,cooldown_ms:60000,attempt_ms:6000};
// Every cooperative_logoff_recovered row lands here instead of a fleet ledger.
const ledger=[];const capture=(who,kind,row)=>ledger.push({who,kind,...row});
const rowsFor=(agent,action)=>ledger.filter(r=>r.agent===agent&&r.kind==='cooperative_logoff_recovered'&&(!action||r.action===action));
function fixture(label='case'){
 const directory=join(dir,label),cred=character=>({host:'fixture.invalid',port:15959,character,account:'offline-test',password:'unused'});
 const monster={id:40,nameRsc:'daemon skeleton',flags:OF.ATTACKABLE,row:10,col:10};
 const bodies=[{id:1,nameRsc:'Victim',flags:OF.PLAYER},{id:2,nameRsc:'Helper',flags:OF.PLAYER},monster];
 const actor=(name,id,character)=>{
  const s=Object.create(Session.prototype),c={state:'game',combatReady:true,me:{name:character},selfId:id,self:{id,row:10,col:10},
   room:{id:8270,objects:new Map(bodies.map(o=>[o.id,{...o}]))},rsc:{get:x=>x},idsAsOf:()=>({last_save_at:7}),vitals:()=>({health:{value:100,max:100},vigor:{value:180}}),sock:{destroy(){c.state='offline';}}};
  Object.assign(s,{name,client:c,credentials:cred(character),fleetStateFile:join(directory,'fleet.json'),cooperativeLogoffDirectory:directory,world:{room:{num:827}},movementGeneration:1,
   cancelMovement:()=>({cancelled:true}),movementWasCancelled:g=>g!==s.movementGeneration});
  s._askStrategies=async()=>({strategy:'fixture-private',answer:policy});s.cooperativeRecordEvent=capture;
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
    const owner=JSON.parse(readToolSource(path,'utf8'));assert.equal(owner.pid,process.pid);assert(owner.process_started_at>0&&owner.token);
    writeFileSync(path,JSON.stringify({...owner,token:'replacement-owner'}));
  });
  assert.equal(JSON.parse(readToolSource(path,'utf8')).token,'replacement-owner','release cannot delete another owner\'s replacement lock');
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
  const f = fixture('ocean-rock-threat');
  const { loadMap, CHECKED_MAP_FILE } = await import('./m59-map.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const room = loadMap(CHECKED_MAP_FILE).rooms[552];
  const geometry = sharedRoomGeometry(room);
  for (const actor of [f.a, f.b]) {
   Object.assign(actor.s.world, { room, geometry });
   Object.assign(actor.c.room, { id: 1416, security: geometry.security });
   actor.c.room.objects.delete(40);
  }
  // Fozzie's exact replay pose at the refused 06:02:06.204 logoff.
  Object.assign(f.a.c.self, { row: 49, col: 44, x: 2848, y: 3168 });
  const mollusk = { id: 11790, nameRsc: 'mollusk creature', flags: OF.ATTACKABLE,
   row: 55, col: 41, x: 2653, y: 3567 };
  const frogman = { id: 11890, nameRsc: 'frogman', flags: OF.ATTACKABLE,
   row: 57, col: 41, x: 2668, y: 3682 };
  const distant = { ...mollusk, id: 11850, row: 56, col: 33, x: 2135, y: 3627 };
  const player = { ...mollusk, id: 3, flags: OF.PLAYER | OF.ATTACKABLE };
  for (const actor of [f.a, f.b])
   for (const object of [mollusk, frogman, distant, player]) actor.c.room.objects.set(object.id, object);
  f.a.pilot.inReachOfUs = Autopilot.prototype.inReachOfUs;
  f.a.pilot.policy = { molluskCoverRecovery: true };
  const offer = async (phase = 'request') => configureCooperativeLogoff(f.a.pilot, phase);
  assert.deepEqual(f.a.pilot.inReachOfUs(), []);
  assert.deepEqual((await offer()).ctx.monsters, [{ id: mollusk.id, name: mollusk.nameRsc }]);
  assert.deepEqual((await offer('helper')).ctx.monsters, []);
  const melee = { ...frogman, id: 41, row: 49, col: 46, x: 2976, y: 3168 };
  f.a.c.room.objects.set(melee.id, melee);
  assert.deepEqual((await offer()).ctx.monsters, [{ id: melee.id, name: melee.nameRsc }]);
  f.a.c.room.objects.delete(melee.id);
  mollusk.predicted = true;
  assert.deepEqual((await offer()).ctx.monsters, []);
  delete mollusk.predicted;
  f.a.c.self.predicted = true;
  assert.deepEqual((await offer()).ctx.monsters, []);
  delete f.a.c.self.predicted;
  f.a.c.room.security++;
  assert.deepEqual((await offer()).ctx.monsters, []);
  f.a.c.room.security = geometry.security;
  f.a.pilot.policy.molluskCoverRecovery = false;
  assert.deepEqual((await offer()).ctx.monsters, []);
  f.a.pilot.policy.molluskCoverRecovery = true;
  for (const mode of ['idle', 'survive']) {
   f.a.pilot.mode = mode;
   assert.deepEqual((await offer()).ctx.monsters, [{ id: mollusk.id, name: mollusk.nameRsc }]);
  }
  f.a.pilot.mode = 'train';
  assert.deepEqual((await offer()).ctx.monsters, []);
  f.a.pilot.mode = 'farm';
  await configureCooperativeLogoff(f.b.pilot, 'helper');
  const request = requestCooperativeLogoff(f.a.pilot, await offer());
  assert.deepEqual(request?.targets.map(t => t.id), [mollusk.id]);
  assert.deepEqual(request?.helpers, ['helper']);
  Object.assign(f.a.c.self, { row: 45, col: 55, x: 3552, y: 2912 });
  Object.assign(mollusk, { row: 45, col: 65, x: 4192, y: 2912 });
  assert.deepEqual((await offer()).ctx.monsters, []);
  console.log('PASS an opted-in Ocean requester can capture the observed rock thrower, with identity, range and LOS guards');
 }
 {
  const { loadMap, CHECKED_MAP_FILE } = await import('./m59-map.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const room = loadMap(CHECKED_MAP_FILE).rooms[552], geometry = sharedRoomGeometry(room);
  const setup = async label => {
   const f = fixture(label), {s,c,pilot} = f.a;
   s.name = label;
   for (const actor of [f.a, f.b]) {
    Object.assign(actor.s.world, { room, geometry });
    Object.assign(actor.c.room, { id: 1416, security: geometry.security });
    actor.c.room.objects.delete(40);
   }
   Object.assign(c.self, { row: 49, col: 44, x: 2848, y: 3168 });
   const rock = { id: 11790, nameRsc: 'mollusk creature', flags: OF.ATTACKABLE, row: 55, col: 41, x: 2653, y: 3567 };
   const melee = { ...rock, id: 41, row: 49, col: 46, x: 2976, y: 3168 };
   for (const actor of [f.a,f.b]) {
    actor.c.room.objects.set(rock.id,rock);
    actor.c.room.objects.set(melee.id,melee);
   }
   let hp=45, exits=0, rejoins=0;
   c.vitals=()=>({health:{value:hp,max:100},vigor:{value:180}});
   c.ailments=()=>[];
   s.lastFleetDamage={at:Date.now(),client:c,bodyId:c.selfId,roomId:c.room.id};
   Object.assign(pilot,{policy:{molluskCoverRecovery:true},safety:()=>({fleeAt:.5}),
    oceanRangedRecoveryEnabled:Autopilot.prototype.oceanRangedRecoveryEnabled,
    tryOceanCooperativeEscape:Autopilot.prototype.tryOceanCooperativeEscape,
    fleetLogoff:Autopilot.prototype.fleetLogoff,inReachOfUs:Autopilot.prototype.inReachOfUs,
    operatorSurvivalStandDown:()=>false,farmBuffPass:async()=>false,
    escapeIfWedgedAndHurt:async()=>false,tradeInPlaceIfWedged:async()=>false,defensiveAnswer:async()=>false,
    leaveForCasters:async()=>{exits++;return true;},suspendJourney(){},
    reconnect:async()=>{rejoins++;return {ok:true};},resumeCooperativeReturn:async()=>{},
   });
   return { ...f, rock, melee, setHP: value=>{hp=value;}, counts:()=>({exits,rejoins}),
    pass:()=>Autopilot.prototype.passFleeAndRest.call(pilot,{s,c,room,v:c.vitals(),hp:hp/100}) };
  };
  const mixed=await setup('early-ocean-mixed');
  const { pilot: mixedPilot, c: mixedClient, s: mixedSession } = mixed.a;
  mixedPilot.inReachOfUs=()=>[mixed.melee,mixed.melee];
  const distant={...mixed.rock,id:11850,row:56,col:33,x:2135,y:3627};
  mixedClient.room.objects.set(distant.id,distant);
  const ask=mixedSession._askStrategies;
  let mixedContext;
  mixedSession._askStrategies=(hook,ctx)=>{mixedContext=ctx;return ask(hook,ctx);};
  await configureCooperativeLogoff(mixed.b.pilot,'helper');
  await mixed.pass();
  assert.deepEqual(mixed.counts(),{exits:0,rejoins:1});
  const mixedIds=[mixed.melee.id,mixed.rock.id];
  assert.deepEqual(mixedContext.monsters.map(t=>t.id),mixedIds);
  assert.deepEqual(mixed.store().read('request',mixed.a.s.name).targets.map(t=>t.id),mixedIds);
  const ranged=await setup('early-ocean-ranged');
  ranged.a.c.room.objects.delete(ranged.melee.id);
  await configureCooperativeLogoff(ranged.b.pilot,'helper');
  await ranged.pass();
  assert.deepEqual(ranged.counts(),{exits:0,rejoins:1});
  assert.deepEqual(ranged.store().read('request',ranged.a.s.name).targets.map(t=>t.id),[ranged.rock.id]);
  for (const [label,change] of [
   ['no-helper',()=>{}],
   ['still-above-flee',f=>f.setHP(60)],
   ['stale-damage',f=>{f.a.s.lastFleetDamage.at-=6000;}],
   ['other-visit',f=>{f.a.s.lastFleetDamage.roomId++;}],
   ['proved-wall',f=>{f.a.pilot.currentRecoveryWall=()=>true;}],
   ['budget-spent',f=>noteLogoff(f.a.s.name)],
   ['only-melee',f=>f.a.c.room.objects.delete(f.rock.id)],
   ['over-target-cap',f=>{
    for(let id=100;id<115;id++)f.a.c.room.objects.set(id,{...f.rock,id});
   }],
   ['async-pose-changed',f=>{f.a.s._askStrategies=async()=>{f.a.c.self.predicted=true;return {strategy:'fixture-private',answer:policy};};}],
  ]) {
   const f=await setup('early-ocean-'+label);
   if(label!=='no-helper')await configureCooperativeLogoff(f.b.pilot,'helper');
   change(f);
   await f.pass();
   assert.deepEqual(f.counts(),{exits:1,rejoins:0},label);
   assert.equal(f.store().read('request',f.a.s.name),null,label);
   assert.equal(currentSurvivalDecision(f.a.s),null,label);
  }
  console.log('PASS Ocean mixed/ranged escape runs before the caster exit only with live proof, budget and admitted fleet help');

  // Waldorf's final confirmed pose after the first refuge's no-progress cancellation.
  const stalled = async (label, helper = true) => {
   const f = await setup(label), {s,c,pilot} = f.a;
   Object.assign(c.self,{row:47,col:47,x:3040,y:3040});
   c.vitals=()=>({health:{value:17,max:121},vigor:{value:188}});
   for (const actor of [f.a,f.b]) {
    actor.c.room.objects.delete(f.rock.id);
    actor.c.room.objects.delete(f.melee.id);
    for (const [id,row,col,x,y] of [[13099,46,47,3043,2963],[13085,47,48,3114,3051],[13094,44,55,3546,2836]])
     actor.c.room.objects.set(id,{...f.rock,id,row,col,x,y});
   }
   let paths=0;
   Object.assign(pilot,{
    rememberSurvivalJam:()=>{},blinkPastSurvivalJam:async()=>false,lureSparedBlocker:async()=>false,armedForSure:()=>true,
    takeRecoverySpot:async(why,opts)=>{paths++;assert.equal(opts.decisionId,retry.id);},
   });
   const retry=chooseSurvivalDecision(s,{strategy:'route_refuge',reason:'shelter approach made no confirmed route progress',
    reason_code:'approach_interrupted',source:'travel',replan_count:1});
   if(helper)await configureCooperativeLogoff(f.b.pilot,'helper');
   return {...f,retry,paths:()=>paths,step:()=>Autopilot.prototype.continueSurvivalDecisionStep.call(pilot)};
  };
  const rescued = await stalled('waldorf-pending-retry');
  assert.equal(await rescued.step(),true);
  assert.equal(rescued.paths(),0,'no second 44-step refuge before an admitted rescue');
  assert.equal(rescued.counts().rejoins,1);
  assert.deepEqual(rescued.store().read('request',rescued.a.s.name).targets.map(t=>t.id),[13099,13085,13094]);

  for(const [label,helper,configure,expectedPaths] of [
   ['no-helper',false,()=>{},1],
   ['already-spent',true,f=>noteLogoff(f.a.s.name),1],
   ['safe-wall',true,f=>{f.a.pilot.currentRecoveryWall=()=>true;f.a.pilot.playDead=async()=>true;},0],
   ['no-attack',true,f=>{f.a.pilot.policy.neverAttack=true;},1],
   ['new-generation',true,f=>{f.a.s._askStrategies=async()=>{f.a.s.movementGeneration++;return {strategy:'fixture-private',answer:policy};};},0],
   ['survival-handoff',true,f=>{f.a.s._askStrategies=async()=>{f.a.pilot.facultyHeld=key=>key==='survival';return {strategy:'fixture-private',answer:policy};};},0],
   ['advancing-refuge',true,f=>{
    const {s,c}=f.a,now=Date.now(),generation=s.movementGeneration;
    s.moveOrder={generation,origin:{source:'keeper',name:'shelter'}};
    s.provenRefugeLeg={client:c,self_id:c.selfId,room_object_id:c.room.id,generation,owner:'keeper:shelter',
     started_at:now-250,from:{x:2976,y:3040},waypoints:[{x:3168,y:3040}],next_index:0};
    s.refugePosition={client:c,id:c.selfId,room_object_id:c.room.id,generation,at:now,changed_at:now,
     x:3040,y:3040,previous:{x:2976,y:3040,at:now-200}};
   },1],
  ]) {
   const f=await stalled('waldorf-'+label,helper);
   configure(f);
   assert.equal(await f.step(),true,label);
   assert.equal(f.counts().rejoins,0,label);
   assert.equal(f.paths(),expectedPaths,label);
   assert.equal(currentSurvivalDecision(f.a.s),f.retry,label);
   assert.equal(f.retry.replan_count,1,label);
   assert.equal(f.store().read('request',f.a.s.name),null,label);
  }
  console.log('PASS the stalled Ocean recovery replay admits a mixed rescue before another refuge and preserves a refused retry');
 }
 {
  const f=fixture('ocean-passive-support');
  for(const actor of [f.a,f.b]){
   actor.s.world.room.num=552;
   actor.pilot.policy={molluskCoverRecovery:true};
  }
  f.a.pilot.mode='idle';
  for(const mode of ['idle','survive']){
   f.b.pilot.mode=mode;
   assert.equal(await f.setup(),null,'a passive witness cannot be the sole distraction helper');
   assert.equal(f.store().read('presence','helper').enabled,false);
   assert.equal(cooperativeHelperReady(f.b.pilot,policy),false);
   assert.equal(cooperativeHelperReady(f.b.pilot,policy,{during:true}),false);
  }
  f.b.pilot.mode='farm';
  assert.deepEqual((await f.setup())?.helpers,['helper'],'the idle supporter can still ask an active farmer for rescue');
  f.offline();
  f.b.pilot.mode='idle';
  f.b.pilot.fightNow=()=>assert.fail('the former helper now holds a passive post');
  assert.equal(await cooperativeAssist(f.b.pilot),false);
  assert.equal(f.store().read('presence','helper').enabled,false,'a change in admission eligibility is published immediately');
  f.b.c.room.objects.delete(40);
  const observedAt=Date.now()+1000;
  for(let t=observedAt;t<=observedAt+15000;t+=1000)publishCooperativePresence(f.b.pilot,{now:t});
  assert.equal(f.store().read('request','victim').receipts[40]?.kind,'gone');
  await cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{now:()=>observedAt+15100,
   wait:async()=>assert.fail('a verified passive observation should release login')});
  assert.equal(f.store().read('request','victim').state,'returning');
  console.log('PASS opted-in Ocean support can request rescue and report gone targets without offering distraction attacks');
 }
 {
  const f=fixture('defer');await f.setup();f.offline();let calls=0;
  f.b.pilot.fightNow=async opts=>(calls++,{target_id:opts.exactTargetId,landed_hits:0});
  f.b.s.combat={active:{}};assert.equal(await cooperativeAssist(f.b.pilot),false);f.b.s.combat=null;
  f.b.s.damagedAt=Date.now();assert.equal(await cooperativeAssist(f.b.pilot),false);f.b.s.damagedAt=0;
  f.b.pilot.stageInFlight.set('passFarm',Promise.resolve());assert.equal(await cooperativeAssist(f.b.pilot),false);f.b.pilot.stageInFlight.clear();
  assert.equal(calls,0);assert.equal(await cooperativeAssist(f.b.pilot),true);assert.equal(calls,1);
  assert.deepEqual(f.store().read('request','victim').receipts,{},'a miss cannot release login');
  let polls=0,seen=null;await assert.rejects(cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{wait:async()=>{seen=f.a.s.cooperativeLogoffWaiting;if(++polls===2)throw Error('still offline');}}),/still offline/);
  assert.equal(polls,2);assert(seen?.request_id,'the waiter publishes its wait while it runs');
  assert.equal(f.a.s.cooperativeLogoffWaiting,null,'a waiter that exited by throwing no longer claims to be waiting');
  console.log('PASS helpers defer during combat/danger/unfinished work; a submitted attack or miss never releases reconnect');
 }
 {
  const f=fixture('confirmed');let options;
  for(const actor of [f.a,f.b])actor.s.world.room.num=552;
  f.b.pilot.policy={molluskCoverRecovery:true};
  await f.setup();f.offline();
  f.b.pilot.fightNow=async o=>(options=o,{target_id:o.exactTargetId,landed_hits:1});
  assert(await cooperativeAssist(f.b.pilot));assert.equal(options.rounds,1);assert.equal(options.loot,false);assert.equal(options.exactTargetId,40);
  f.b.pilot.mode='idle';publishCooperativePresence(f.b.pilot);
  assert.equal(f.store().read('presence','helper').enabled,false);
  await cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{wait:async()=>assert.fail('a real hit should release immediately')});
  assert.equal(f.store().read('request','victim').state,'returning','login failure/restart must still revalidate the hit');
  const restarted={name:'victim',fleetStateFile:f.a.s.fleetStateFile,cooperativeLogoffDirectory:f.a.s.cooperativeLogoffDirectory,cooperativeRecordEvent:capture};
  await cooperativeBeforeLogin(restarted,f.a.s.credentials,{wait:async()=>assert.fail('durable receipt should survive a keeper restart')});
  f.b.c.vitals=()=>({health:{value:0,max:100}});f.b.s._cooperativePublishedAt=0;publishCooperativePresence(f.b.pilot);
  await assert.rejects(cooperativeBeforeLogin(restarted,f.a.s.credentials,{wait:async()=>{throw Error('helper died');}}),/helper died/);
  f.b.c.vitals=()=>({health:{value:100,max:100}});f.b.s._cooperativePublishedAt=0;publishCooperativePresence(f.b.pilot);
  await cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{wait:async()=>assert.fail('fresh living helper should qualify again')});
  cooperativeAfterLogin(f.a.s);assert.equal(f.store().read('request','victim').state,'resumed');
  console.log('PASS confirmed exact-target hits release login after a helper becomes passive, survive restart, and recheck helper health');
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
  Object.assign(p,{operatorSurvivalStandDown:()=>false,oceanRangedRecoveryEnabled:()=>false,
   suspendJourney(){},adoptRecoveryWall:()=>false,playerThreatPresent:()=>false,
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
  const source=readToolSource(new URL('./m59-keeper-process.mjs',import.meta.url),'utf8');
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
  f.a.s.joining=new Promise(()=>{});   // the gated login that owns this wait, in flight
  const source=readToolSource(new URL('./m59-keeper-process.mjs',import.meta.url),'utf8');
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
  f.a.s.joining=null;
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
 // GONE: a target killed by somebody else (or otherwise vanished) is resolved by a fresh,
 // repeated observation from a helper in the request's room -- never by a single read.
 const watch=(f,from,to,step=1000)=>{f.b.s._cooperativePublishedAt=0;for(let t=from;t<=to;t+=step)publishCooperativePresence(f.b.pilot,{now:t});};
 const gate=(f,at,why='still waiting')=>cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{now:()=>at,wait:async()=>{throw Error(why);}});
 {
  const f=fixture('gone-satisfies');await f.setup();const r=f.offline(),T=r.offline_at+1000;
  f.b.c.room.objects.delete(40);f.b.s.combat={active:{}};
  watch(f,T,T+14000);assert.equal(f.store().read('request','victim').receipts[40],undefined,'14s of absence is not GONE_MS');
  watch(f,T+15000,T+15000);
  const g=f.store().read('request','victim').receipts[40];
  assert.equal(g.kind,'gone');assert.equal(g.helper,'helper');assert.equal(g.helper_body,2);assert.equal(g.target_id,40);
  assert.equal(g.name,'daemon skeleton');assert.equal(g.seen_absent_since,T);assert.equal(g.at,T+15000);assert.equal(g.request_id,r.id);
  await gate(f,T+15100);assert.equal(f.store().read('request','victim').state,'returning');
  assert.equal(f.a.s.cooperativeLogoffReturn.released,undefined,'a resolved wait is not a deadline release');
  console.log('PASS a target absent from a same-room helper\'s own object list for GONE_MS (helper busy in combat) writes a gone receipt that releases login');
 }
 {
  const f=fixture('gone-single-read');await f.setup();const r=f.offline(),T=r.offline_at+1000;
  f.b.c.room.objects.delete(40);
  watch(f,T,T);watch(f,T+16000,T+16000);
  assert.equal(f.store().read('request','victim').receipts[40],undefined,'two reads 16s apart are not continuous absence');
  watch(f,T+20000,T+34000,3500);
  assert.equal(f.store().read('request','victim').receipts[40],undefined,'observations further apart than GONE_GAP_MS restart the clock');
  const lost=fixture('gone-unreadable');await lost.setup();const lr=lost.offline(),L=lr.offline_at+1000;
  lost.b.c.room.objects.delete(40);lost.b.c.room.objects.delete(2);watch(lost,L,L+16000);
  lost.b.c.room.objects.set(2,{id:2,nameRsc:'Helper',flags:OF.PLAYER});lost.b.c.idsAsOf=()=>({last_save_at:7,saving:true});watch(lost,L+17000,L+33000);
  lost.b.c.idsAsOf=()=>({last_save_at:8});watch(lost,L+34000,L+50000);
  assert.equal(lost.store().read('request','victim').receipts[40],undefined,'an unreadable room (no own body, a save, another epoch) is never absence');
  await assert.rejects(gate(f,T+34100),/still waiting/);
  console.log('PASS one read, a gapped series, or a room the helper could not read never counts as gone');
 }
 {
  const f=fixture('gone-stale');await f.setup();const r=f.offline(),T=r.offline_at+1000;
  f.b.c.room.objects.delete(40);watch(f,T,T+15000);
  assert.equal(f.store().read('request','victim').receipts[40].kind,'gone');
  watch(f,T+46000,T+46000);
  assert.equal(f.store().read('request','victim').receipts[40].at,T+15000,'a gap restarts the clock rather than refreshing');
  await assert.rejects(gate(f,T+46100),/still waiting/);
  const other=fixture('gone-other-room');await other.setup();const o=other.offline(),U=o.offline_at+1000;
  other.b.c.room.objects.delete(40);other.b.s.world.room.num=828;watch(other,U,U+16000);
  assert.equal(other.store().read('request','victim').receipts[40],undefined,'a helper in another room cannot write one');
  other.b.s.world.room.num=827;watch(other,U+20000,U+35000);assert.equal(other.store().read('request','victim').receipts[40].kind,'gone');
  other.b.s.world.room.num=828;other.b.s._cooperativePublishedAt=0;publishCooperativePresence(other.b.pilot,{now:U+35500});
  await assert.rejects(gate(other,U+35600),/still waiting/,'nor satisfy one once it stands elsewhere');
  other.b.s.world.room.num=827;other.b.s._cooperativePublishedAt=0;publishCooperativePresence(other.b.pilot,{now:U+36000});
  const own=other.store();own.write('request','helper',{id:'helper-own',agent:'helper',state:'offline',room:827});
  await assert.rejects(gate(other,U+36100),/still waiting/,'a helper with its own pending request cannot vouch');
  own.write('request','helper',{id:'helper-own',agent:'helper',state:'resumed',room:827});
  await gate(other,U+36100);assert.equal(other.store().read('request','victim').state,'returning');
  console.log('PASS a stale gone receipt, or one from a helper elsewhere or itself waiting offline, does not satisfy the gate');
 }
 {
  const f=fixture('gone-reappears');await f.setup();const r=f.offline(),T=r.offline_at+1000;
  f.b.c.room.objects.delete(40);watch(f,T,T+15000);
  assert.equal(f.store().read('request','victim').receipts[40].kind,'gone');
  f.b.c.room.objects.set(40,{id:40,nameRsc:'daemon skeleton',flags:OF.ATTACKABLE,row:10,col:10});watch(f,T+15500,T+15500);
  assert.equal(f.store().read('request','victim').receipts[40],undefined,'the same id seen again invalidates its gone receipt');
  await assert.rejects(gate(f,T+15600),/still waiting/);
  console.log('PASS a target seen again deletes its gone receipt and the victim keeps waiting');
 }
 {
  const f=fixture('gone-mixed');
  for(const actor of [f.a,f.b])actor.c.room.objects.set(41,{id:41,nameRsc:'narthyl worm',flags:OF.ATTACKABLE,row:10,col:11});
  await f.setup();const r=f.offline(),T=r.offline_at+1000;
  assert.deepEqual(r.targets.map(t=>t.id),[40,41]);
  f.b.c.room.objects.delete(40);
  let hit;f.b.pilot.fightNow=async o=>(hit=o.exactTargetId,{target_id:o.exactTargetId,landed_hits:1});
  assert(await cooperativeAssist(f.b.pilot,{now:()=>T}));assert.equal(hit,41,'a missing first target does not block a live second target');
  const receipts=f.store().read('request','victim').receipts;assert.equal(receipts[40],undefined);assert.equal(receipts[41].landed_hits,1);
  await assert.rejects(gate(f,T+100),/still waiting/,'the missing first target still requires its own proof');
  watch(f,T,T+15000);
  assert.equal(f.store().read('request','victim').receipts[40].kind,'gone');
  await gate(f,T+15100);assert.equal(f.store().read('request','victim').state,'returning');
  console.log('PASS a missing first target does not block distraction of a live target, and both still need proof');
 }
 {
  const norm=(await import('./m59-cooperative-logoff.mjs')).normalizeCooperativeLogoff;
  assert.equal(norm({enabled:true}).max_offline_ms,null);assert.equal(norm({enabled:true,max_offline_ms:null}).max_offline_ms,null);
  assert.equal(norm({enabled:true,max_offline_ms:5000}).max_offline_ms,60000);assert.equal(norm({enabled:true,max_offline_ms:1e9}).max_offline_ms,1800000);
  assert.equal(norm({enabled:true,max_offline_ms:0}).max_offline_ms,null);assert.equal(norm({enabled:true,max_offline_ms:Infinity}).max_offline_ms,null);
  const f=fixture('deadline');f.a.s._askStrategies=async()=>({strategy:'fixture-private',answer:{...policy,max_offline_ms:120000}});
  const made=await f.setup();assert.equal(made.max_offline_ms,120000,'the deadline travels with the request');
  const r=f.offline();
  let waiting=null;
  await assert.rejects(cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{now:()=>r.offline_at+119999,wait:async()=>{waiting=f.a.s.cooperativeLogoffWaiting;throw Error('still waiting');}}),/still waiting/,'not before the deadline');
  assert.equal(f.store().read('request','victim').state,'offline');assert.equal(waiting.deadline_at,r.offline_at+120000);
  const restarted={name:'victim',fleetStateFile:f.a.s.fleetStateFile,cooperativeLogoffDirectory:f.a.s.cooperativeLogoffDirectory,cooperativeRecordEvent:capture};
  await cooperativeBeforeLogin(restarted,f.a.s.credentials,{now:()=>r.offline_at+120000,wait:async()=>assert.fail('deadline reached on a restarted keeper')});
  const done=f.store().read('request','victim');
  assert.equal(done.state,'aborted');assert.equal(done.reason,'deadline');assert.equal(done.released,'deadline');
  assert.equal(restarted.cooperativeLogoffReturn.released,'deadline');
  await cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{wait:async()=>assert.fail('an aborted request no longer gates')});
  const none=fixture('no-deadline');const nr=await none.setup();assert.equal(nr.max_offline_ms,null);const n=none.offline();
  await assert.rejects(gate(none,n.offline_at+10*3600000),/still waiting/,'without the option nothing ever times out');
  assert.equal(none.store().read('request','victim').state,'offline');
  console.log('PASS opt-in max_offline_ms releases a restarted waiter at its deadline and not before; without it nothing times out');
 }
 // STUCK LOGOFFS, prod 2026-11-01. A cooperative logoff nobody is finishing ends by its own bound,
 // the keeper's flag stops claiming a wait nobody is doing, and every recovery is a ledger row.
 const eperm=()=>Object.assign(Error('EPERM: operation not permitted, rename'),{code:'EPERM'});
 const restartedOf=(f,extra={})=>({name:'victim',fleetStateFile:f.a.s.fleetStateFile,cooperativeLogoffDirectory:f.a.s.cooperativeLogoffDirectory,
   credentials:f.a.s.credentials,cooperativeRecordEvent:capture,...extra});
 {
  const box=join(dir,'rename-retry');mkdirSync(box);const target=join(box,'r.json');writeFileSync(target,'{"old":1}');
  let tries=0;writeFileSync(target+'.tmp','{"new":1}');
  replaceFileSync(target+'.tmp',target,{rename:(a,b)=>{if(++tries<3)throw eperm();renameSync(a,b);}});
  assert.equal(tries,3);assert.equal(JSON.parse(readFileSync(target,'utf8')).new,1,'a busy target is replaced once its reader lets go');
  writeFileSync(target+'.tmp2','{"lost":1}');
  assert.throws(()=>replaceFileSync(target+'.tmp2',target,{rename:()=>{throw eperm();},attempts:3}),/EPERM/);
  assert.equal(existsSync(target+'.tmp2'),false,'a write that never lands leaves no orphaned tmp behind');
  assert.throws(()=>replaceFileSync(target+'.tmp3',target,{rename:()=>{throw Object.assign(Error('ENOSPC'),{code:'ENOSPC'});}}),/ENOSPC/,'only sharing errors are retried');
  // The store's own writes go through it: a session-level rename stub stands in for a reader holding the file.
  const f=fixture('busy-store');await f.setup();let busy=2;
  f.a.s.cooperativeRename=(a,b)=>{if(busy-->0)throw eperm();renameSync(a,b);};
  markCooperativeOffline(f.a.s);f.a.s.cooperativeRename=null;
  assert.equal(f.store().read('request','victim').state,'offline','markCooperativeOffline lands through two EPERMs');
  assert.equal(readdirSync(f.store().dir).filter(n=>n.endsWith('.tmp')).length,0,'and leaves no tmp');
  console.log('PASS Windows rename over a busy file is retried, a failed write leaves no tmp, and only sharing errors are retried');
 }
 {
  // SHAPE A, in process (Robin): markCooperativeOffline's write fails after the socket is gone.
  const f=fixture('preparing-unrecorded');const r=await f.setup();assert.equal(r.state,'preparing');
  f.a.c.sock.destroy();f.a.s.client=null;
  f.a.s.cooperativeRename=()=>{throw eperm();};
  markCooperativeOffline(f.a.s);   // must not throw: the join after it is the only way back in
  f.a.s.cooperativeRename=null;
  assert.equal(f.store().read('request','victim').state,'preparing','the departure write failed, as on prod');
  assert.equal(f.a.s.cooperativeDeparture.request_id,r.id,'but this session remembers that it left for this request');
  await assert.rejects(gate(f,Date.now()+1000),/still waiting/,'and then waits for distraction rather than throwing');
  const now=f.store().read('request','victim');
  assert.equal(now.state,'offline');assert.equal(now.offline_at,f.a.s.cooperativeDeparture.at);assert.equal(now.offline_confirmed_by,'login gate');
  assert.equal(rowsFor('victim','confirmed_offline').length,1);assert.equal(rowsFor('victim','confirmed_offline')[0].who,'Victim','the row is keyed on the character');
  now.offline_at-=1000;f.store().write('request','victim',now);   // past the helper's 800ms settle
  assert(await cooperativeAssist(f.b.pilot));await cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{wait:async()=>assert.fail('a hit releases the confirmed record')});
  assert.equal(f.store().read('request','victim').state,'returning');
  console.log('PASS a preparing record whose departure write failed is confirmed offline by this session\'s own gate and then released by distraction as usual');
 }
 {
  // SHAPE A, no owner (restart, or the gate that would have confirmed it is gone).
  const f=fixture('preparing-stuck');const r=await f.setup();
  const young=restartedOf(f);
  await assert.rejects(cooperativeBeforeLogin(young,f.a.s.credentials,{now:()=>r.created_at+10000,wait:async()=>{assert.equal(young.cooperativeLogoffWaiting.phase,'preparing');throw Error('still waiting');}}),/still waiting/);
  assert.equal(f.store().read('request','victim').state,'preparing','a young preparing record may still be confirmed by its own keeper');
  assert.equal(young.cooperativeLogoffWaiting,null);
  const old=restartedOf(f);
  await cooperativeBeforeLogin(old,f.a.s.credentials,{now:()=>r.created_at+PREPARING_MAX_MS,wait:async()=>assert.fail('a preparing record past its bound must not hold the login')});
  const done=f.store().read('request','victim');
  assert.equal(done.state,'aborted');assert.equal(done.reason,'preparing_timeout');assert.equal(done.recovered_by,'login gate');
  assert.equal(old.cooperativeLogoffReturn.released,'preparing_timeout','the body comes back undistracted and goes straight for cover');
  const row=rowsFor('victim','abandoned').at(-1);assert.equal(row.reason_code,'preparing_timeout');assert.equal(row.state_was,'preparing');assert.equal(row.record_written,true);
  console.log('PASS a preparing record nobody confirmed is abandoned at PREPARING_MAX_MS by the login gate, with a ledger row, and not before');
 }
 {
  // SHAPE A, the path that actually held Robin for 4.5 hours: the broker's sweep posting /rejoin.
  const f=fixture('preparing-refusal');const r=await f.setup();f.a.c.sock.destroy();f.a.s.client=null;
  const rec=f.store().read('request','victim');rec.created_at=Date.now()-4.5*3600000;f.store().write('request','victim',rec);
  f.a.s.joining=new Promise(()=>{});
  assert.equal(cooperativeReconnectRefusal(f.a.s).reason_code,'cooperative_wait','a running continuation still owns it');
  f.a.s.joining=null;
  assert.equal(cooperativeReconnectRefusal(f.a.s),null,'no continuation and past its bound: the join goes through');
  assert.equal(f.store().read('request','victim').state,'aborted');assert.equal(f.store().read('request','victim').reason,'preparing_timeout');
  assert.equal(rowsFor('victim','abandoned').at(-1).by,'keeper join handler');
  console.log('PASS the keeper /join and /rejoin refusal no longer holds a stuck preparing record: it abandons it, says so, and lets the sweep in');
 }
 {
  // SHAPE B (Scooter): the deadline release cannot be written. The waiter must not die of it, must
  // not leave cooperative_wait set if it does die, and must go anyway past the margin.
  const f=fixture('deadline-unwritable');f.a.s._askStrategies=async()=>({strategy:'fixture-private',answer:{...policy,max_offline_ms:240000}});
  await f.setup();const r=f.offline();
  f.a.s.cooperativeRename=()=>{throw eperm();};
  f.a.s.joining=new Promise(()=>{});let during=null;
  await assert.rejects(cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{now:()=>r.offline_at+240000,wait:async()=>{during=cooperativeWaitActive(f.a.s);throw Error('still waiting');}}),/still waiting/,
    'a failed release write is retried, not thrown');
  assert.equal(during,true,'while the waiter runs, the keeper reports the wait');
  assert.equal(cooperativeWaitActive(f.a.s),false,'once it is gone, it does not (Scooter: an hour stepped over by the sweep)');
  f.a.s.joining=null;
  assert.equal(f.store().read('request','victim').state,'offline');
  await cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{now:()=>r.offline_at+240000+OFFLINE_OVERRUN_MS,wait:async()=>assert.fail('past max_offline_ms + margin the login goes even unrecorded')});
  assert.equal(f.a.s.cooperativeLogoffReturn.released,'offline_overrun');
  const row=rowsFor('victim','released_unrecorded').at(-1);assert.equal(row.reason_code,'offline_overrun');assert.equal(row.record_written,false);
  f.a.s.cooperativeRename=null;
  console.log('PASS a deadline release that cannot be written keeps the waiter alive, clears the wait flag when it ends, and logs in past the margin anyway');
 }
 {
  // SHAPE B with no waiter left at all: the join handler ends it once it is past max_offline_ms + margin.
  const f=fixture('offline-refusal');f.a.s._askStrategies=async()=>({strategy:'fixture-private',answer:{...policy,max_offline_ms:240000}});
  await f.setup();f.offline();
  const rec=f.store().read('request','victim');
  assert.equal(stuckCooperativeLogoff(rec,rec.offline_at+240000+OFFLINE_OVERRUN_MS-1),null,'not inside the margin');
  assert.equal(cooperativeReconnectRefusal(f.a.s,f.a.s.credentials,{now:rec.offline_at+60000}),null,'inside its bound with no waiter: the join re-enters the gate');
  assert.equal(f.store().read('request','victim').state,'offline','re-gating does not resolve the record');
  assert.equal(rowsFor('victim','regated').at(-1).reason_code,'no_continuation');
  assert.equal(cooperativeReconnectRefusal(f.a.s,f.a.s.credentials,{now:rec.offline_at+240000+OFFLINE_OVERRUN_MS}),null);
  assert.equal(f.store().read('request','victim').state,'aborted');assert.equal(f.store().read('request','victim').reason,'offline_overrun');
  console.log('PASS with no waiter, the join handler re-gates an offline record inside its bound and abandons one past max_offline_ms + margin');
 }
 {
  // THE HAND-ABORTED FILE (what operators did tonight): state aborted, `aborted_reason`, no aborted_at,
  // and a dead waiter's flag still on the session.
  const f=fixture('hand-aborted');await f.setup();f.offline();
  f.a.s.cooperativeLogoffWaiting={request_id:'dead-waiter',room:827,at:Date.now()-3600000};
  const rec=f.store().read('request','victim');rec.state='aborted';rec.aborted_reason='operator-session: stuck offline >5 min';f.store().write('request','victim',rec);
  assert.equal(cooperativeWaitActive(f.a.s),false,'a flag with no login in flight is not a wait the broker should step over');
  assert.equal(cooperativeReconnectRefusal(f.a.s),null);
  await cooperativeBeforeLogin(f.a.s,f.a.s.credentials,{wait:async()=>assert.fail('an aborted file does not gate')});
  cooperativeAfterLogin(f.a.s);
  assert.equal(f.a.s.cooperativeLogoffWaiting,null,'after-login clears the flag even with no return to complete');
  assert.equal(f.store().read('request','victim').state,'aborted','and does not touch the operator\'s record');
  console.log('PASS a hand-aborted request lets the next login straight in and clears the stale wait flag that used to block the sweep');
 }
 {
  // NOT FIGHTING A DELIBERATE ABSENCE: dormancy, a handoff, a leave or a stopping keeper.
  const f=fixture('stuck-but-dormant');const r=await f.setup();const quiet=restartedOf(f,{cooperativeLoginAllowed:()=>false});
  await assert.rejects(cooperativeBeforeLogin(quiet,f.a.s.credentials,{now:()=>r.created_at+PREPARING_MAX_MS*10,wait:async()=>assert.fail('no wait')}),/ownership/);
  assert.equal(f.store().read('request','victim').state,'preparing','an owner that does not want the login decides nothing');
  assert.equal(rowsFor('victim').filter(x=>x.request_id===r.id).length,0);
  console.log('PASS a stuck record is never resolved into a login the keeper does not want (dormant, handing off, left, stopping)');
 }
 {
  // A cooperative reconnect that FAILED with the socket gone aborts its preparing record too.
  const f=fixture('reconnect-failed-out');await configureCooperativeLogoff(f.b.pilot,'helper');
  const p=f.a.pilot;
  Object.assign(p,{fleetLogoff:Autopilot.prototype.fleetLogoff,
    reconnect:async()=>{f.a.c.sock.destroy();f.a.s.client=null;return{ok:false,why:'rename EPERM'};}});
  assert.equal(await p.fleetLogoff('captured off-wall danger'),true,'out of the world: the ladder does not carry on as if live');
  const rec=f.store().read('request','victim');assert.equal(rec.state,'aborted');assert(rec.aborted_at>0);
  assert.equal(rowsFor('victim','abandoned').at(-1).reason_code,'reconnect_failed');
  assert.equal(abortPreparingCooperativeLogoff(f.a.s,rec.id,'again'),false,'only a preparing record is aborted');
  console.log('PASS a failed cooperative reconnect aborts its preparing record even when the session is already out');
 }
 assert(PASS_STAGES.indexOf('passCooperative')>PASS_STAGES.indexOf('passFleeAndRest'));
 assert(PASS_STAGES.indexOf('passCooperative')<PASS_STAGES.indexOf('passFarm'));
 console.log('PASS cooperative work runs after survival and before discretionary farming');
}finally{party.setRosterSource(null);rmSync(dir,{recursive:true,force:true});}
