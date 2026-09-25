// Offline regressions for the September 24–25 poison/rest and shelter deaths.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { healUp, restUntil, isHealingFlaskDescription } from './m59-skills.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import { Session } from './m59-game.mjs';
import { geometryFor } from './m59-safespots.mjs';
import { observeRefugeProgress, REFUGE_PROGRESS_MS } from './m59-recovery-refuge.mjs';
import { attachSurvivalDecisions, chooseSurvivalDecision, currentSurvivalDecision, finishSurvivalDecision } from './m59-survival-decision.mjs';

const healing='This flask, formed from clear glass and topped by a cork, contains a thick blue fluid.  It looks cool and refreshing.';
const arsenic='The pungent liquid in this bottle contains floating bits of strange matter.';
const hit='The skeleton stabs you with its attack.';
async function advance(t,promise) {
  let done=false,result,error;
  promise.then(r=>{done=true;result=r;},e=>{done=true;error=e;});
  for(let i=0;i<40&&!done;i++){await immediate();t.mock.timers.tick(3000);}
  await immediate();assert.ok(done,'operation must settle');if(error)throw error;return result;
}
function restFixture(samples,{poison=true}={}) {
  let index=-1,stands=0;
  const c={evSeq:0,events:[],self:{row:10,col:3},room:{objects:new Map()},
    vitals:()=>({health:{value:samples[Math.max(index,0)].hp,max:68},vigor:{value:126,scale_max:200}}),
    ailments:()=>poison?[{name:'poison'}]:[],
    stats(){index=Math.min(index+1,samples.length-1);const text=samples[index].text;
      if(text)this.events.push({seq:++this.evSeq,at:Date.now(),kind:samples[index].kind??'message',text});},
    waitFor:async()=>({events:[]}),rest(){},stand(){stands++;}};
  const s={client:c,need:()=>c,pacer:{submit:async(_lane,fn)=>fn()},world:{room:{num:38}},movementGeneration:0};
  return {s,c,stands:()=>stands};
}
for(const hp of [44,60]) test('poison plus a skeleton hit interrupts rest at HP '+hp,async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const f=restFixture([{hp:58},{hp,text:hit}]);
  const r=await advance(t,restUntil(f.s,{health:1,vigor:0,maxSeconds:8}));
  assert.match(r.interrupted,/attacked/);assert.equal(r.poison_drain,undefined);assert.equal(f.stands(),1);
});
test('poison alone, stale attacks and player speech do not manufacture an incoming hit',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const f=restFixture([{hp:58},{hp:57,text:hit,kind:'chat'},{hp:68}]);
  f.c.events.push({seq:++f.c.evSeq,kind:'message',at:Date.now()-100,text:hit});
  const r=await advance(t,restUntil(f.s,{health:1,vigor:0,maxSeconds:12}));
  assert.equal(r.interrupted,null);assert.equal(r.poison_drain,1);assert.equal(r.reached_target,true);
});
test('damage with no ailment still interrupts and explicit abortOnDamage=false is respected',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const f=restFixture([{hp:58},{hp:44}],{poison:false});
  assert.match((await advance(t,restUntil(f.s,{health:1,vigor:0,maxSeconds:8}))).interrupted,/damage/);
  const g=restFixture([{hp:58},{hp:44,text:hit},{hp:68}]);
  assert.equal((await advance(t,restUntil(g.s,{health:1,vigor:0,maxSeconds:8,abortOnDamage:false}))).interrupted,null);
});
test('poisoned safe-wall recovery reconsiders logoff using the new low health',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const {s,c}=restFixture([{hp:58},{hp:26,text:hit}]);
  const wall={ok:true,row:10,col:3};
  const k=Object.assign(Object.create(Autopilot.prototype),{s,policy:{},tally:{},
    currentRecoveryWall:()=>wall,checkFreeze:()=>false,facultyHeld:()=>false,
    rememberSurvivalJam:()=>null,note:()=>{},playerThreatPresent:()=>false,safety:()=>({fleeAt:0.68})});
  s.loggedInAt=Date.now()-78000;s.damagedAt=Date.now();
  chooseSurvivalDecision(s,{strategy:'rest_safe',status:'recovering',chosen_refuge:wall});
  await advance(t,k.continueSurvivalDecisionStep());
  assert.equal(currentSurvivalDecision(s).strategy,'logoff_safe');
  assert.equal(c.vitals().health.value,26);
  assert.equal(k.logoffDeclined('attacked during recovery',true),null,'earlier above-threshold refusal cannot persist');
});

function flaskFixture(descriptions) {
  let hp=10,looked=null;const applied=[],looks=[];
  const c={selfId:1,evSeq:0,inventory:descriptions.map((_,i)=>({id:i+10,nameRsc:1})),spells:[],rsc:{get:()=> 'flask'},
    vitals:()=>({health:{value:hp,max:30}}),requestInventory(){},look(id){looked=id;looks.push(id);},
    waitFor:async opts=>opts.kinds.includes('look')?{events:[{id:looked,seq:++c.evSeq,description:descriptions[looked-10]}]}:{events:[]},
    apply(id){applied.push(id);hp+=10;c.inventory=c.inventory.filter(o=>o.id!==id);}};
  const s={client:c,need:()=>c,pacer:{submit:async(_lane,fn)=>fn()}};
  return {s,c,applied,looks};
}
test('same-name arsenic and unknown flasks are skipped; verified medicine is consumed',async()=>{
  const f=flaskFixture([arsenic,null,healing]);const r=await healUp(f.s,{maxItems:1});
  assert.deepEqual(f.applied,[12]);assert.equal(r.skipped.length,2);assert.equal(r.healed,true);
  assert.equal(isHealingFlaskDescription('flask'),false);
  assert.equal(isHealingFlaskDescription(healing+' This is poisoned.'),false);
});
test('stale, wrong-object and failed LOOK replies cannot authorize drinking',async()=>{
  for(const mode of ['stale','wrong','timeout','throw']) {
    const f=flaskFixture([healing]);f.c.evSeq=5;
    f.c.waitFor=async opts=>{
      if(!opts.kinds.includes('look'))return {events:[]};
      assert.equal(opts.since,5);assert.equal(opts.match({id:99}),false);
      if(mode==='throw')throw Error('no reply');
      return {events:mode==='timeout'?[]:[{id:mode==='wrong'?99:10,seq:mode==='stale'?4:6,description:healing}]};
    };
    await healUp(f.s);assert.deepEqual(f.applied,[],mode);
  }
});
test('an unconsumed flask is not applied repeatedly and object IDs are re-inspected on the next call',async()=>{
  const f=flaskFixture([healing]);f.c.apply=id=>f.applied.push(id);
  await healUp(f.s);assert.deepEqual(f.applied,[10]);
  f.c.waitFor=async opts=>({events:opts.kinds.includes('look')?[{id:10,seq:++f.c.evSeq,description:arsenic}]:[]});
  await healUp(f.s);assert.deepEqual(f.applied,[10]);assert.deepEqual(f.looks,[10,10]);
});
test('losing the client during inspection or queued use cannot drink or cast on the old client',async()=>{
  for(const lane of ['look','act']) {
    const f=flaskFixture([healing]);f.c.spells=[{id:50,nameRsc:2}];
    f.c.rsc.get=n=>n===2?'heal':'flask';f.c.cast=()=>assert.fail('stale heal cast');
    f.s.pacer.submit=async(kind,fn)=>{if(kind===lane)f.s.client={};return fn();};
    const r=await healUp(f.s);assert.equal(r.cancelled,true);assert.deepEqual(f.applied,[]);
  }
});

function approachFixture() {
  const c={state:'game',selfId:1,self:{row:7,col:20},room:{objects:new Map()},
    vitals:()=>({health:{value:32,max:58}})};
  const geo={path:(fr,fc,tr,tc)=>({found:true,steps:Array(Math.abs(fr-tr)+Math.abs(fc-tc)).fill({})})};
  const s=Object.assign(Object.create(Session.prototype),{name:null,client:c,world:{room:{num:38},geometry:geo},movementGeneration:0});
  const k=Object.assign(Object.create(Autopilot.prototype),{s,policy:{},tally:{},
    currentRecoveryWall:()=>null,holdWorks:()=>false,facultyHeld:()=>false,
    measuredWedgeInPlace:()=>null,note:()=>{},ledgerEvent:()=>{}});
  attachSurvivalDecisions(s,{onCancel:(why,d)=>k.replacementSurvivalChoice(why,d)});
  chooseSurvivalDecision(s,{strategy:'nearest_refuge',status:'approaching',chosen_refuge:{row:7,col:23}});
  return {s,c,k,geo,target:{row:7,col:23}};
}
test('a confirmed shorter route renews progress; an oscillation and predictions do not',()=>{
  const {geo,target}=approachFixture();
  const p=observeRefugeProgress(null,geo,{row:7,col:20},target,0);
  observeRefugeProgress(p,geo,{row:8,col:20},target,3000);
  observeRefugeProgress(p,geo,{row:7,col:20},target,4000);
  assert.equal(p.progressedAt,0);
  observeRefugeProgress(p,geo,{row:7,col:22,predicted:true},target,5000);assert.equal(p.progressedAt,0);
  observeRefugeProgress(p,geo,{row:7,col:21},target,6000);assert.equal(p.progressedAt,6000);
});
test('watchdog cancellations cannot renew a stalled refuge; the next selection excludes it',t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:100000});
  const {k,s,target}=approachFixture();let stop=k.watchRecoveryApproach(target);
  t.mock.timers.tick(4000);k.cancelForSurvival(null,'watchdog rescuing a stalled driver');stop();
  assert.equal(s.movementGeneration,1);
  stop=k.watchRecoveryApproach(target);t.mock.timers.tick(REFUGE_PROGRESS_MS-4000);
  assert.equal(s.movementGeneration,2);assert.ok(k.unreachableIn(38).has('23,7'));
  assert.notEqual(currentSurvivalDecision(s).status,'approaching');stop();
});
test('real approach progress prevents cancellation; returning to old squares does not',t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:100000});
  const {k,s,c,target}=approachFixture();const stop=k.watchRecoveryApproach(target);
  t.mock.timers.tick(5000);c.self.col=21;t.mock.timers.tick(500);
  t.mock.timers.tick(5000);assert.equal(s.movementGeneration,0);
  c.self.col=20;t.mock.timers.tick(3000);assert.equal(s.movementGeneration,1);stop();
});
test('a new recovery episode and a completed arrival do not inherit an expired approach clock',t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:100000});
  const {k,s,c,target}=approachFixture();let stop=k.watchRecoveryApproach(target);
  t.mock.timers.tick(6000);c.self={...target};stop();
  assert.equal(k.refugeApproachProgress.targets.size,0);
  c.self={row:7,col:20};stop=k.watchRecoveryApproach(target);
  t.mock.timers.tick(6000);assert.equal(s.movementGeneration,0);stop();
  finishSurvivalDecision(s,currentSurvivalDecision(s).id,'recovered');
  chooseSurvivalDecision(s,{strategy:'nearest_refuge',status:'approaching'});
  stop=k.watchRecoveryApproach(target);t.mock.timers.tick(4000);
  assert.equal(s.movementGeneration,0);stop();
});
for(const change of ['human','pvp','generation','decision','client','room','life','arrived'])
  test('an old approach watcher cannot cancel after '+change,t=>{
    t.mock.timers.enable({apis:['Date','setInterval'],now:100000});
    const {k,s,c,target}=approachFixture();const stop=k.watchRecoveryApproach(target);
    if(change==='human')k.inert={by:'human'};
    if(change==='pvp')s.combat={active:{pvp:true}};
    if(change==='generation')s.movementGeneration++;
    if(change==='decision')chooseSurvivalDecision(s,{strategy:'rest_safe'});
    if(change==='client')s.client={...c};
    if(change==='room')s.world.room.num=39;
    if(change==='life')s.lifeBoundary=1;
    if(change==='arrived')c.self={...target};
    const before=s.movementGeneration;t.mock.timers.tick(10000);
    assert.equal(s.movementGeneration,before);assert.equal(k.unreachableIn(38),null);stop();
  });

test('a real recovery selector routes first, cancels a stuck await and then selects another wall',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:100000});
  const {s,c,k}=approachFixture();
  const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url)));
  const geo=geometryFor(map.rooms[39]);
  s.world={room:map.rooms[39],map,geometry:geo,reach:(col,row)=>{
    const p=geo.path(c.self.row,c.self.col,row,col,{clearance:0});
    return {reachable:p.found,steps:p.steps?.length};
  }};
  c.self={id:1,row:8,col:16};
  Object.assign(k,{claims:new Map(),passes:1,journal:[],mode:'farm',
    safety:()=>({fleeAt:0.68}),book:{get:()=>null,discredited:()=>false},
    playDead:async()=>true});
  s.need=()=>c;s.standBeforeGo=async()=>{};
  s.approachFine=async()=>assert.fail('cancelled route cannot fall through to the fine fan');
  const attempts=[];let blocked=true;
  s.walkTo=async(col,row,opts)=>{
    assert.ok(opts.avoidSquares instanceof Set);attempts.push({row,col});
    if(!blocked){Object.assign(c.self,{row,col});return {arrived:true};}
    const generation=s.movementGeneration;
    while(s.movementGeneration===generation)await new Promise(resolve=>setTimeout(resolve,1000));
    return {arrived:false,cancelled:true};
  };
  const first=await advance(t,k.takeRecoverySpot('stuck near a wall'));
  assert.equal(first.cancelled,true);assert.equal(attempts.length,1);
  assert.ok(k.unreachableIn(39).has(`${attempts[0].col},${attempts[0].row}`));
  blocked=false;
  const next=await k.takeRecoverySpot('replacement');
  assert.equal(next.took,true);assert.equal(attempts.length,2);
  assert.notDeepEqual(attempts[0],attempts[1]);
});
