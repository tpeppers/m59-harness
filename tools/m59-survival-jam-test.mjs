// Offline integration: actual watchdog pulse, handoff, pending dispatcher and
// retreat ladder. Only wire movement/attacks and geometry observations are fixtures.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const scratch=mkdtempSync(join(tmpdir(),'m59-jam-'));
process.env.M59_WATCHDOG_PINNED_MS='20000';
process.env.M59_LEDGER_DIR=scratch;process.env.M59_UPTIME_FILE=join(scratch,'uptime.jsonl');
const {Autopilot}=await import('./m59-autopilot.mjs');
const {Session}=await import('./m59-game.mjs');
const {geometryFor,coarseCombatReachFrom}=await import('./m59-safespots.mjs');
const {recordBlockerClearance}=await import('./m59-blocker-events.mjs');
const {OF}=await import('./m59-parse.mjs');
const {freshState}=await import('./m59-watchdog.mjs');
const {attachSurvivalDecisions,chooseSurvivalDecision,currentSurvivalDecision}=await import('./m59-survival-decision.mjs');

function fixture() {
  const events=[],health={value:52,max:55},self={id:1,row:35,col:32};
  const c={selfId:1,self,state:'game',room:{id:1584,objects:new Map()},inventory:[],
    vitals:()=>({health,vigor:{value:100,max:200}}),equipment:()=>({known:true,equipped:[{name:'axe'}]})};
  const geo={path:(fr,fc,tr,tc,opts)=>({found:!opts.avoid.has(tr+','+tc),steps:[{row:tr,col:tc}]}),
    walkable:()=>true};
  const s={name:null,live:true,client:c,world:{room:{num:584},geometry:geo},movementGeneration:0,
    cancelledMovementTokens:new Set(),cancelMovement:Session.prototype.cancelMovement,
    movementWasCancelled:Session.prototype.movementWasCancelled,
    retreatAlongBreadcrumbs:async()=>({moved:false,reason:'object_blocked'}),
    walkTo:async()=>({arrived:false,reason:'object_blocked'}),
    travel:async()=>({arrived:false,reason:'object_blocked'}),
    enteredVia:{room:584,from:585,door:{row:35,col:25}}};
  const k=Object.assign(Object.create(Autopilot.prototype),{s,policy:{},tally:{},passes:1,watch:freshState(),
    recordFrame:()=>{},note:()=>{},ledgerEvent:(kind,x)=>events.push({kind,...x}),progress:()=>{},who:()=>null,
    holdWorks:()=>false,currentRecoveryWall:()=>k.wall??null,checkFreeze:()=>false,
    facultyHeld:f=>k.external===f,safety:()=>({fleeAt:0.7}),threatCeiling:()=>65,
    crowded:()=>false,threatCountHere:()=>2,protectedItemNames:()=>[],carryFloors:()=>({}),
    unreachableIn:()=>new Set(),trackSinceFull:()=>{},trackGrind:()=>{},hitDamageTotal:()=>k.damage??0,
    takeSafeSpotObserved:async()=>({took:false,why:'no reachable refuge'}),
    playDead:async()=>{chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'open freeze refused'});return false;},
    fightNow:async()=>({fought:true,landed_hits:1}),threat:()=>({near:[],adjacent:[]})});
  attachSurvivalDecisions(s,{record:()=>{},epoch:'test'});
  const target={id:2,name:'spider',row:35,col:33,flags:OF.ATTACKABLE};c.room.objects.set(2,target);
  return {k,s,c,health,self,target,events};
}
function measured(f) {
  const {k,health}=f,now=Date.now();k.doing='travelling';
  k.pulsePosition(now-30_000,health);k.pulsePosition(now-29_000,health);k.pulsePosition(now,health);
  assert.ok(k.measuredWedgeInPlace(),'real pulse established a measured wedge');
}
async function handoff(f) {
  measured(f);const {k,s}=f;
  k.policy.tradeInPlaceWhenWedged=false;
  k.inert={travelling:true,to:110,at:Date.now(),guard:{safe_spot:true}};
  s.shelterPolicy={need:()=>true};
  await k.recoverFromTravelFallback();
  k.policy.tradeInPlaceWhenWedged=true;k._survivalReplan=null;k.doing=null;
  k.pulsePosition(Date.now()+1000,f.health);
  assert.equal(k.watch.wedged,null,'idle pulse clears the old travel clock');
  assert.equal(k.survivalJam().generation,s.movementGeneration);
  assert.ok(k.wedgedInPlace(),'survival episode survives that clearing');
}
test('real travel watchdog → pending recovery → idle → sustained weak fight → resume same destination',async()=>{
  const f=fixture();await handoff(f);const {k,c,s,health}=f;let swings=0;
  const journey=k.suspendedJourney;
  k.fightNow=async opts=>{assert.equal(opts.exactTargetId,2);assert.equal(opts.loot,false);
    if(++swings===6){c.room.objects.delete(2);health.value=55;return {fought:true,killed:true};}
    return {fought:true,landed_hits:1};};
  await k.continueSurvivalDecision();assert.equal(swings,6);
  assert.equal(k.suspendedJourney,journey);assert.equal(currentSurvivalDecision(s),null);
  let resumed;k.releaseRestedHold=async()=>{};k.tooTiredToTravel=()=>false;k.sanctuary=()=>false;
  k.travel=async to=>{resumed=to;return {arrived:true};};
  await k.resumeSuspendedJourney({s,c,hp:1,v:c.vitals()});assert.equal(resumed,110);
  assert.equal(k.suspendedJourney,null);
  assert.ok(f.events.some(e=>e.phase==='clearance'&&e.path_clear));
  assert.equal(k.tally.kills,undefined,'a shared disappearance is not a personal kill');
});
test('low health interrupts a productive fight and reaches a refuge',async()=>{
  const f=fixture();await handoff(f);let swings=0;
  f.k.fightNow=async()=>{swings++;f.health.value=12;return {fought:true,landed_hits:1};};
  f.k.takeSafeSpotObserved=async()=>{f.self.col=25;f.k.wall={ok:true,row:35,col:25};return {took:true,spot:f.k.wall};};
  await f.k.continueSurvivalDecision();assert.equal(swings,1);assert.equal(f.self.col,25);
  assert.ok(f.events.some(e=>e.phase==='retreat'&&e.took));
  assert.equal(f.k.survivalJam(),null);
});
test('replacement decisions preserve failed survival retreat rungs in the same pocket',async()=>{
  const f=fixture();await handoff(f);f.health.value=10;const rungs=[];
  const backup=f.k.backUpToUnstick.bind(f.k);
  f.k.backUpToUnstick=async(...args)=>{const r=await backup(...args);rungs.push(r.rung);return r;};
  for(let i=0;i<3;i++) {
    chooseSurvivalDecision(f.s,{strategy:'nearest_refuge',reason:'new refuge '+i});
    f.k._survivalReplan=null;await f.k.continueSurvivalDecisionStep();
  }
  assert.deepEqual(rungs,[1,2,3]);
  assert.ok(f.k.backUps.filter(b=>b.failed).every(b=>b.jam_id===f.k.survivalJam().id));
});
for(const change of ['displacement','room','cover','human','survival','combat','recovery','stop','death','expiry','generation','client']) {
  test('jam cannot survive '+change,async()=>{
    const f=fixture();await handoff(f);const {k,s}=f;
    if(change==='displacement')f.self.col+=3;
    if(change==='room')s.world.room.num++;
    if(change==='cover')k.wall={ok:true};
    if(change==='human')k.inert={by:'human'};
    if(['survival','combat','recovery'].includes(change))k.external=change;
    if(change==='stop')k.stopping=true;
    if(change==='death')f.health.value=0;
    if(change==='expiry')k.survivalJamEpisode.expires=Date.now()-1;
    if(change==='generation')s.cancelMovement(null,'external move');
    if(change==='client')s.client={...f.c};
    assert.equal(k.survivalJam(),null);assert.equal(k.wedgedInPlace(),null);
  });
}
test('cancellation and faculty takeover mid-swing forbid a second swing or retreat',async()=>{
  for(const change of ['generation','combat','recovery']) {
    const f=fixture();await handoff(f);let swings=0;
    f.k.fightNow=async()=>{swings++;if(change==='generation')f.s.cancelMovement(null,'external');else f.k.external=change;return {fought:true,landed_hits:1};};
    await f.k.continueSurvivalDecision();assert.equal(swings,1);
    assert.ok(f.events.some(e=>e.phase==='cancelled'));assert.equal(f.k.survivalJam(),null);
  }
});
test('repeated failed approaches can establish a jam, deliberate safe cover cannot',async()=>{
  const f=fixture(),now=Date.now();
  f.k.rememberSurvivalJam({failed:true,now:now-11000});
  assert.equal(f.k.wedgedInPlace(),null);
  f.k.rememberSurvivalJam({failed:true,now});assert.ok(f.k.wedgedInPlace());
  f.k.wall={ok:true};assert.equal(f.k.rememberSurvivalJam({failed:true}),null);
});
test('unchanged failed replans wait, damage and new body/exit information bypass the wait',async()=>{
  const f=fixture();chooseSurvivalDecision(f.s,{strategy:'nearest_refuge'});let calls=0;
  f.k.takeSafeSpotObserved=async()=>{calls++;return {took:false,why:'blocked'};};
  await f.k.continueSurvivalDecision();const n=calls;
  await f.k.continueSurvivalDecision();assert.equal(calls,n);
  f.k.damage=5;await f.k.continueSurvivalDecision();assert.ok(calls>n);const m=calls;
  f.c.room.objects.delete(2);await f.k.continueSurvivalDecision();assert.ok(calls>m);
  const p=calls;f.s.world.room.edgeExits=[{row:35,col:26,to:585}];
  await f.k.continueSurvivalDecision();assert.ok(calls>p);
});
test('exact larger target retaliates, chases to refuge and leaves a body-aware clear local path',async()=>{
  const f=fixture();await handoff(f);f.target.name='troll';let swings=0;
  f.k.planBlockerLure=()=>({spot:{row:35,col:25},filter:(col,row)=>col===25&&row===35});
  f.k.fightNow=async opts=>{assert.equal(opts.exactTargetId,2);return {fought:true,landed_hits:1,
    combat:++swings===4?["You dodge the troll's attack."]:[]};};
  f.k.takeSafeSpotObserved=async(_why,_quarry,opts)=>{
    assert.ok(opts.candidateFilter(25,35));assert.equal(opts.candidateFilter(32,35),false);
    f.self.col=25;f.target.col=26;f.k.wall={ok:true,row:35,col:25};return {took:true,spot:f.k.wall};};
  await f.k.continueSurvivalDecision();assert.equal(swings,4);
  assert.ok(f.events.some(e=>e.phase==='retaliation'&&e.target_id===2));
  assert.ok(f.events.some(e=>e.phase==='refuge_arrival'&&e.chase_observed&&e.observed));
  assert.ok(f.events.some(e=>e.phase==='clearance'&&e.path_clear));
  assert.equal(f.k.suspendedJourney.to,110);
});
test('shared-target clearance is correlated across observers without duplicate kill credit',()=>{
  const events=[],emit=(who,kind,data)=>events.push({who,kind,...data});
  const detail={server:['lab',18959],room_num:108,room_object_id:751,target_id:8000,target:'giant rat'};
  const a=recordBlockerClearance('one',detail,{directory:scratch,now:100000,emit});
  const b=recordBlockerClearance('two',detail,{directory:scratch,now:102800,emit});
  assert.equal(a.id,b.id);assert.equal(b.duplicate,true);assert.equal(events.length,1);
  assert.equal(events[0].kind,'blocker_clearance');
  assert.equal(recordBlockerClearance('later',detail,{directory:scratch,now:111000,emit}).duplicate,false);
});

test('real failed refuge executor establishes a jam without any watchdog timer evidence',async()=>{
  const f=fixture(),realNow=Date.now;let now=realNow(),swings=0;
  Date.now=()=>now;
  try {
    f.k.watch=null;chooseSurvivalDecision(f.s,{strategy:'nearest_refuge'});
    await f.k.takeRecoverySpot('first blocked approach');
    assert.equal(f.k.wedgedInPlace(),null);
    now+=11000;
    f.k.fightNow=async()=>{if(++swings===4){f.c.room.objects.delete(2);return {fought:true,killed:true};}return {fought:true,landed_hits:1};};
    await f.k.continueSurvivalDecision();
    assert.equal(swings,4);assert.equal(f.k.survivalJam().failures>=2,true);
  } finally {Date.now=realNow;}
});
test('a brief faculty handoff cannot return a stale jam to the old owner',async()=>{
  const f=fixture();await handoff(f);
  f.k.claimFaculties({faculties:['movement'],by:'human'});
  f.k.releaseFaculties({faculties:['movement'],by:'human'});
  assert.equal(f.k.wedgedInPlace(),null);
});
test('faculty takeover during breadcrumbs stops higher retreat rungs',async()=>{
  const f=fixture();await handoff(f);f.health.value=10;
  await f.k.backUpToUnstick('first failure',{owner:'survival'});
  f.s.retreatAlongBreadcrumbs=async()=>{f.k.claimFaculties({faculties:['movement'],by:'human'});return {moved:false};};
  f.s.walkTo=()=>assert.fail('new owner must not inherit another retreat');
  const r=await f.k.backUpToUnstick('second failure',{owner:'survival'});
  assert.equal(r.cancelled,true);assert.equal(f.k.survivalJam(),null);
});
test('a late chase is recorded only for the exact target arriving beside the refuge',async()=>{
  const f=fixture();await handoff(f);f.target.name='troll';
  f.k.planBlockerLure=()=>({spot:{row:35,col:25},filter:()=>true});
  f.k.fightNow=async()=>({fought:true,landed_hits:1,combat:["You dodge the troll's attack."]});
  f.k.takeSafeSpotObserved=async()=>{f.self.col=25;f.k.wall={ok:true,row:35,col:25};return {took:true,spot:f.k.wall};};
  await f.k.continueSurvivalDecision();assert.equal(f.events.some(e=>e.phase==='chase'),false);
  f.target.col=39;f.k.observeBlockerLure();assert.equal(f.events.some(e=>e.phase==='chase'),false,'moving away is not chase');
  f.target.col=26;f.k.observeBlockerLure();
  assert.equal(f.events.filter(e=>e.phase==='chase').length,1);
  f.k.observeBlockerLure();assert.equal(f.events.filter(e=>e.phase==='chase').length,1);
});
test('newly occupied route prevents a false clearance',async()=>{
  const f=fixture();await handoff(f);
  f.c.room.objects.delete(2);f.c.room.objects.set(3,{...f.target,id:3});
  assert.equal(f.k.finishClearedBlocker({row:35,col:33},{target_id:2}),false);
  assert.equal(f.events.at(-1).path_clear,false);
});

test('a safe wall cannot trigger the pending retreat ladder from stale travel evidence',async()=>{
  const f=fixture();measured(f);f.health.value=10;f.k.wall={ok:true};
  chooseSurvivalDecision(f.s,{strategy:'nearest_refuge'});
  f.k.backUpToUnstick=()=>assert.fail('safe cover must not start a jam retreat');
  f.k.fightNow=()=>assert.fail('safe cover must not provoke a blocker');
  await f.k.continueSurvivalDecisionStep();
  assert.equal(f.k.survivalJam(),null);
});

test('separate keeper processes cannot both emit the canonical shared clearance',async()=>{
  const moduleURL=new URL('./m59-blocker-events.mjs',import.meta.url).href;
  const code=`import {recordBlockerClearance} from ${JSON.stringify(moduleURL)};
    const r=recordBlockerClearance('fixture',{server:['test',1],room_num:108,target_id:9876,target:'rat'},
      {directory:${JSON.stringify(scratch)},now:200000,emit:()=>{}});console.log(JSON.stringify(r));`;
  const results=await Promise.all([1,2].map(()=>promisify(execFile)(process.execPath,['--input-type=module','-e',code],{windowsHide:true})));
  const receipts=results.map(r=>JSON.parse(r.stdout.trim()));
  assert.equal(receipts.filter(r=>r.duplicate===false).length,1);
  assert.ok(receipts.every(r=>r.duplicate!==null||r.unavailable==='EEXIST'));
});



test('one-square oscillations retain the measured episode and escalate through all rungs',async()=>{
  const f=fixture();await handoff(f);f.health.value=10;const {k,s,self}=f;
  const episode=k.survivalJam().id,results=[];let flip=false,exits=0;
  s.retreatAlongBreadcrumbs=async()=>{self.col=(flip=!flip)?33:32;return {steps:1};};
  s.travel=async()=>{exits++;return {arrived:false};};
  for(let n=0;n<3;n++)results.push(await k.backUpToUnstick('shuffle',{owner:'survival'}));
  assert.deepEqual(results.map(r=>r.rung),[1,2,3]);
  assert.ok(results.every(r=>r.displaced&&!r.freed));assert.equal(exits,1);
  assert.equal(k.survivalJam().id,episode);
  assert.ok(k.backUps.every(b=>b.failed&&b.jam_id===episode));
});

for(const phase of ['breadcrumbs','entry','previous'])for(const respawn of [false,true]) {
  test('death during '+phase+(respawn?' followed by immediate respawn':'' )+' never counts as escape',async()=>{
    const f=fixture();await handoff(f);const {k,s,health,self}=f;health.value=10;
    await k.backUpToUnstick('prime one',{owner:'survival'});
    await k.backUpToUnstick('prime two',{owner:'survival'});
    const before=JSON.stringify(k.backUps),calls=[];
    const move=async(name,opts)=>{
      calls.push(name);
      if(name!==phase)return {arrived:false};
      s.lastHealth=null;health.value=0;
      Session.prototype.noteHealth.call(s,{value:0,max:55});
      s.world.room.num=1;
      if(respawn){health.value=55;Session.prototype.noteHealth.call(s,{value:55,max:55});
        s.world.room.num=585;self.col=20;}
      assert.equal(s.movementWasCancelled(opts.movementGeneration,opts.controlToken),true,
        'the paced mover must see the lease cancellation, even after respawn');
      assert.equal(s.movementWasCancelled(s.movementGeneration),false,'new recovery owner is not cancelled');
      return {arrived:true,steps:2};
    };
    s.retreatAlongBreadcrumbs=o=>move('breadcrumbs',o);
    s.walkTo=(_c,_r,o)=>move('entry',o);s.travel=(_room,o)=>move('previous',o);
    const out=await k.backUpToUnstick('fatal retreat',{owner:'survival'});
    assert.equal(out.freed,false);assert.equal(out.cancelled,true);
    assert.equal(out.interruption,'death during retreat');
    assert.ok(out.tried.every(r=>!r.worked));assert.equal(calls.at(-1),phase);
    assert.equal(JSON.stringify(k.backUps),before,'stale retreat cannot change failure history');
    assert.equal(s.movementCancellationChecks.size,0,'lease released after completion');
    assert.equal(k.survivalJam(),null);
  });
}

test('a live departure from the original pocket stops fallbacks and preserves the journey',async()=>{
  const f=fixture();await handoff(f);f.health.value=10;const journey=f.k.suspendedJourney;
  f.s.retreatAlongBreadcrumbs=async()=>{f.self.col=29;return {steps:3};};
  f.s.walkTo=()=>assert.fail('already escaped');f.s.travel=()=>assert.fail('already escaped');
  const out=await f.k.backUpToUnstick('real escape',{owner:'survival'});
  assert.equal(out.freed,true);assert.equal(out.cancelled,false);assert.equal(f.k.suspendedJourney,journey);
});

test('a client replacement cancels the paced retreat lease without cancelling the replacement',async()=>{
  const f=fixture();await handoff(f);
  f.s.retreatAlongBreadcrumbs=async opts=>{
    f.s.client={...f.c};f.self.col=20;
    assert.equal(f.s.movementWasCancelled(opts.movementGeneration,opts.controlToken),true);
    return {steps:12};
  };
  const out=await f.k.backUpToUnstick('reconnect',{owner:'survival'});
  assert.equal(out.cancelled,true);assert.equal(out.freed,false);assert.equal(out.interruption,'client replaced');
});

test('a namesake arriving during a larger fight stops provocation and keeps refuge safety',async()=>{
  const f=fixture();await handoff(f);f.target.name='troll';let swings=0,retreats=0;
  f.k.planBlockerLure=()=>({spot:{row:35,col:25},filter:()=>true});
  f.k.fightNow=async()=>{swings++;f.c.room.objects.set(3,{...f.target,id:3,col:34});
    return {fought:true,landed_hits:1,combat:[]};};
  f.k.takeSafeSpotObserved=async()=>{retreats++;return {took:false};};
  await f.k.continueSurvivalDecision();assert.equal(swings,1);assert.ok(retreats>=1);
  assert.ok(f.events.some(e=>e.phase==='refusal'&&e.reason==='retaliation identity became ambiguous'));
  assert.equal(f.events.some(e=>e.phase==='retaliation'),false);
});


test('real Flatlands geometry and real lure selector support exact retaliation, refuge and chase',async()=>{
  const f=fixture();await handoff(f);const {k,s,self,target,events}=f;target.name='troll';
  const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url),'utf8'));
  s.world.geometry=geometryFor(map.rooms['584']);assert.ok(s.world.geometry);
  const origin={row:self.row,col:self.col},blocked={row:target.row,col:target.col};
  const plan=k.planBlockerLure(target,origin);assert.ok(plan,'real planner must find an eligible refuge');
  assert.ok(plan.filter(plan.spot.col,plan.spot.row));
  const landing=coarseCombatReachFrom(s.world.geometry,target)(plan.spot.col,plan.spot.row).attack_position;
  assert.ok(landing);let swings=0;
  k.fightNow=async opts=>{assert.equal(opts.exactTargetId,target.id);return {fought:true,landed_hits:1,
    combat:++swings===3?["You dodge the troll's attack."]:[]};};
  k.takeSafeSpotObserved=async(_reason,_quarry,opts)=>{
    assert.ok(opts.candidateFilter(plan.spot.col,plan.spot.row));
    Object.assign(self,plan.spot);Object.assign(target,landing);k.wall={ok:true,...plan.spot};
    return {took:true,spot:k.wall};
  };
  await k.continueSurvivalDecision();assert.equal(swings,3);
  assert.ok(events.some(e=>e.phase==='retaliation'&&e.target_id===target.id));
  assert.ok(events.some(e=>e.phase==='refuge_arrival'&&e.chase_observed));
  assert.ok(events.some(e=>e.phase==='clearance'&&e.path_clear));
  assert.equal(k.blockerPathClear(blocked),true);assert.equal(k.suspendedJourney.to,110);
});

for(const type of ['health','identity','both'])test('lure refusal distinguishes '+type,async()=>{
  const f=fixture();await handoff(f);f.target.name='troll';
  if(type!=='identity')f.health.value=10;
  if(type!=='health')f.c.room.objects.set(3,{...f.target,id:3,col:34});
  f.k.fightNow=()=>assert.fail('unsafe provocation');
  await f.k.tradeInPlaceIfWedged({near:[f.target],v:f.c.vitals()});
  const refusal=f.events.find(e=>e.phase==='refusal');assert.ok(refusal);
  assert.equal(refusal.low_health,type!=='identity');
  assert.equal(refusal.ambiguous_retaliation,type!=='health');
});


test('opposite edges of the same pocket cannot discard the failed-retreat history',async()=>{
  const f=fixture();await handoff(f);f.health.value=10;
  let flip=false;f.s.retreatAlongBreadcrumbs=async()=>{f.self.col=(flip=!flip)?34:30;return {steps:4};};
  const r=[];for(let i=0;i<4;i++)r.push(await f.k.backUpToUnstick('same episode',{owner:'survival'}));
  assert.deepEqual(r.map(x=>x.rung),[1,2,3,3]);assert.ok(r.every(x=>!x.freed));
});

test('new safe cover during a rail attempt prevents all remaining fallback movement',async()=>{
  const f=fixture();await handoff(f);f.health.value=10;
  f.k.onwardExit=()=>({row:35,col:25});
  f.s.retreatToRail=async()=>{f.k.wall={ok:true};return {rejoined:false};};
  f.s.retreatAlongBreadcrumbs=()=>assert.fail('safe cover must end movement');
  const out=await f.k.backUpToUnstick('covered',{owner:'survival',to:110});
  assert.equal(out.freed,true);assert.equal(out.displaced,false);
});


test('real breadcrumb executor observes death after an awaited step and sends no second move',async()=>{
  const f=fixture();await handoff(f);const {k,s,c,self,health}=f;
  Object.assign(self,{x:32,y:35});s.need=()=>c;
  s.breadcrumbs=[{roomId:c.room.id,from:{x:30,y:35},to:{x:31,y:35}},
    {roomId:c.room.id,from:{x:31,y:35},to:{x:32,y:35}}];
  let sent=0;s.queueValidatedMove=async()=>{
    sent++;s.lastHealth=null;health.value=0;Session.prototype.noteHealth.call(s,{value:0,max:55});
    health.value=55;s.world.room.num=585;
    return {sent:true,target:{x:31,y:35}};
  };
  c.predictSelf=()=>assert.fail('stale retreat must not predict a post-respawn position');
  s.retreatAlongBreadcrumbs=Session.prototype.retreatAlongBreadcrumbs;
  const out=await k.backUpToUnstick('paced fatal step',{owner:'survival'});
  assert.equal(sent,1);assert.equal(out.cancelled,true);assert.equal(out.freed,false);
  assert.equal(s.movementCancellationChecks.size,0);
});
