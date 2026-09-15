// Offline, real movement cancellation and keeper recovery entry points.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Session} from './m59-game.mjs';
import {Autopilot} from './m59-autopilot.mjs';
import {CombatMode} from './m59-combat-mode.mjs';
import {OF} from './m59-parse.mjs';
import {bindPacketScope} from './m59-packet-scope.mjs';
import {bodyAuthority} from './m59-body-command.mjs';
import {returnToSpot} from './m59-skills.mjs';
import {geometryFor} from './m59-safespots.mjs';
import {attachSurvivalDecisions,chooseSurvivalDecision,currentSurvivalDecision,
  cancelSurvivalDecision,updateSurvivalDecision,finishSurvivalDecision,survivalDecisionSnapshot} from './m59-survival-decision.mjs';
import {summarizeSurvivalDecisions,postmortemSurvivalDecisions,loadSurvivalDecisionRows} from './m59-survival-decisions.mjs';
import {createSurvivalDecisionRecorder} from './m59-survival-decision-log.mjs';
const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url),'utf8'));
let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name);}
function fixture({row=8,col=16}={}) {
  const events=[],calls=[],health={value:30,max:50};
  const c={state:'game',selfId:1,self:{id:1,row,col,degrees:0},room:{objects:new Map()},
    vitals:()=>({health,vigor:{value:80}}),face:()=>calls.push('turn'),stats(){},rest(){},stand(){},waitFor:async()=>({})};
  const s=Object.assign(Object.create(Session.prototype),{name:null,client:c,movementGeneration:0,
    cancelledMovementTokens:new Set(),world:{room:map.rooms[39],geometry:geometryFor(map.rooms[39]),map},
    need:()=>c,pacer:{submit:async(_lane,fn)=>fn()}});
  const k=Object.assign(Object.create(Autopilot.prototype),{s,policy:{},passes:1,tally:{},claims:new Map(),
    journal:[],book:{save(){},get:()=>null,discredited:()=>false},safety:()=>({fleeAt:0.7}),
    tellPilot:async()=>{},note(){},noProgress(){},
    reconnect:async()=>{calls.push('reconnect');return {ok:true};}});
  attachSurvivalDecisions(s,{record:r=>events.push(r),onCancel:(why,d)=>k.replacementSurvivalChoice(why,d),epoch:'test'});
  return {s,k,c,health,events,calls};
}
await test('replacement is atomic, linked, dated and detached in postmortems',()=>{
  const {s,events}=fixture();const a=chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'hurt'});
  updateSurvivalDecision(s,a.id,{chosen_refuge:{row:7,col:16,room:39},path:[{row:7,col:16}],path_length:1});
  const b=cancelSurvivalDecision(s,'watchdog detected a blocked approach');
  assert.notEqual(b.id,a.id);assert.equal(a.replacement_id,b.id);assert.equal(b.previous_decision_id,a.id);
  assert.equal(a.cancel_reason,'watchdog detected a blocked approach');
  assert.equal(events.at(-2).event,'replaced');assert.equal(events.at(-1).event,'chosen');
  const pm={at:Date.now(),survival_decisions:survivalDecisionSnapshot(s)};
  const before=JSON.stringify(pm);assert.equal(finishSurvivalDecision(s,a.id,'recovered'),false);
  finishSurvivalDecision(s,b.id,'died');assert.equal(JSON.stringify(pm),before);
  const report=postmortemSurvivalDecisions(pm);assert.equal(report.decisions[0].path_length,1);
  assert.ok(report.decisions[0].chosen_ms_before_death>=0);
});
for(const first of ['fine','square']) await test(`cancelled ${first} approach cannot start another mover`,async()=>{
  const {s,calls}=fixture();if(first==='square')s.client.self.col=2;
  chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'hurt'});
  const cancel=async()=>{calls.push(first);s.cancelMovement(null,'test interruption');return {arrived:false,cancelled:true};};
  s.approachFine=first==='fine'?cancel:async()=>assert.fail('fine fallback after cancel');
  s.walkTo=first==='square'?cancel:async()=>assert.fail('square fallback after cancel');
  s.walkFine=async()=>assert.fail('fine positioning after cancel');
  const r=await returnToSpot(s,{row:8,col:18,x:1184,y:544});
  assert.equal(r.cancelled,true);assert.deepEqual(calls,[first]);
  assert.equal(survivalDecisionSnapshot(s).history[0].outcome,'cancelled');
});
await test('a changed generation outranks a stale successful arrival',async()=>{
  const {s}=fixture();s.approachFine=async()=>{s.movementGeneration++;return {arrived:true};};
  s.walkTo=async()=>assert.fail('stale success continued');
  assert.equal((await returnToSpot(s,{row:8,col:18})).cancelled,true);
});
await test('ordinary blockage can still use the alternate mover',async()=>{
  const {s,c,calls}=fixture();s.approachFine=async()=>({arrived:false,reason:'blocked'});
  s.walkTo=async(col,row)=>{calls.push('square');c.self={...c.self,col,row};return {arrived:true};};
  assert.equal((await returnToSpot(s,{row:8,col:18})).arrived,true);assert.deepEqual(calls,['square']);
});
await test('safe-wall recovery logs off, reconnects, turns and keeps the square',async()=>{
  const {k,s,c,calls}=fixture({row:7,col:16});
  k.takeSafeSpot=async()=>assert.fail('safe bot must not walk to another refuge');
  const r=await k.takeRecoverySpot('hurt at cover');
  assert.equal(r.took,true);assert.deepEqual(calls,['reconnect','turn']);
  assert.deepEqual({row:c.self.row,col:c.self.col},{row:7,col:16});
  assert.equal(currentSurvivalDecision(s).strategy,'logoff_safe');
  assert.equal(currentSurvivalDecision(s).status,'recovering');
  await k.takeRecoverySpot('still recovering');
  assert.deepEqual(calls,['reconnect','turn'],'do not repeatedly clear the health timer');
  assert.equal(currentSurvivalDecision(s).strategy,'rest_safe');
  assert.match(currentSurvivalDecision(s).mitigation,/health timer/);
});
await test('an automatic blocked approach selects a route replacement; explicit stop yields',async()=>{
  const {s,k}=fixture();k.inert={travelling:true,to:598};
  chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'hurt'});
  s.cancelMovement(null,'approach blocked');assert.equal(currentSurvivalDecision(s).strategy,'route_refuge');
  k.takeRecoverySpot=async(why,options)=>{assert.equal(options.route,true);return {took:true};};
  await k.continueSurvivalDecision();
  k.cancelJourney('operator cancelled');assert.equal(currentSurvivalDecision(s).strategy,'yield_to_controller');
  assert.equal(await k.continueSurvivalDecision(),false);
});
await test('a replacement failure retains a new explicit decision',async()=>{
  const {s,k}=fixture();k.takeSafeSpotObserved=async()=>{throw Error('broken route');};
  const r=await k.takeSafeSpot('hurt',null,{recovery:true});
  assert.equal(r.took,false);assert.equal(currentSurvivalDecision(s).strategy,'nearest_refuge');
  const old=survivalDecisionSnapshot(s).history.at(-1);
  assert.equal(old.outcome,'blocked');assert.equal(old.replacement_id,currentSurvivalDecision(s).id);
});
await test('blocked recovery target is excluded and the replacement reaches another wall',async()=>{
  const {s,k,c,calls}=fixture();const attempted=[];
  s.approachFine=s.walkTo=async(col,row)=>{
    attempted.push({col,row});
    if(row===7&&col===16)return {arrived:false,reason:'blocked by a moving body'};
    c.self={...c.self,col,row};return {arrived:true};
  };
  assert.equal((await k.takeRecoverySpot('hurt')).took,false);
  assert.equal(currentSurvivalDecision(s).strategy,'nearest_refuge');
  await k.continueSurvivalDecision();
  assert.ok(attempted.some(p=>p.row!==7||p.col!==16));
  assert.notDeepEqual({row:k.hold.row,col:k.hold.col},{row:7,col:16});
  assert.equal(currentSurvivalDecision(s).strategy,'logoff_safe');
  assert.deepEqual(calls,['reconnect','turn']);
});
await test('fresh damage overrides the already-healing exception at a safe wall',async()=>{
  const {k,s,calls}=fixture({row:7,col:16});
  await k.takeRecoverySpot('hurt');s.damagedAt=k.turnedAt+1;
  await k.takeRecoverySpot('new damage at the wall');
  assert.deepEqual(calls,['reconnect','turn','reconnect','turn']);
});
await test('failed turn stays explicit and must be retried before resting',async()=>{
  const {k,s,c,calls}=fixture({row:7,col:16});
  c.face=()=>{throw Error('turn rejected');};await k.takeRecoverySpot('hurt');
  assert.equal(currentSurvivalDecision(s).phase,'turn_required');
  c.rest=()=>assert.fail('rested with the healing timer still unarmed');
  c.face=()=>calls.push('turn');await k.continueSurvivalDecision();
  assert.equal(currentSurvivalDecision(s).phase,'reconnected_turn_and_heal');
});
await test('a predicted position is not proof of current shelter',()=>{
  const {k,c}=fixture({row:7,col:16});c.self.predicted=true;
  assert.equal(k.currentRecoveryWall(),null);
});
await test('a director movement lease cannot cancel recovery or split its episode',async()=>{
  const {k,s,c,health,events}=fixture({row:7,col:16});
  k.claimFaculties({faculties:['work','movement','economy'],by:'production farming director'});
  await k.takeRecoverySpot('hurt under a director lease');
  const d=currentSurvivalDecision(s);
  // Use the real rest executor, completing its first cached-stat refresh.
  c.stats=()=>{health.value=50;};
  assert.equal(await k.continueSurvivalDecision(),true);
  assert.equal(currentSurvivalDecision(s).id,d.id);
  assert.equal(await k.continueSurvivalDecision(),false);
  assert.equal(currentSurvivalDecision(s),null);
  const report=summarizeSurvivalDecisions(events);
  assert.equal(report.episodes,1);assert.equal(report.resolved_episodes,1);
  assert.equal(report.strategies[0].recovered_episodes,1);
  assert.ok(!events.some(e=>e.decision.strategy==='yield_to_controller'));
});
await test('pending survival keeps its protected faculty; explicit handoffs still yield',async()=>{
  const {k,s}=fixture();
  k.claimFaculties({faculties:['movement'],by:'production farming director'});
  const d=chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'approach interrupted'});
  let calls=0;k.takeRecoverySpot=async()=>{calls++;return {took:true};};
  assert.equal(await k.continueSurvivalDecision(),true);assert.equal(calls,1);
  assert.equal(currentSurvivalDecision(s).id,d.id);
  k.claimFaculties({faculties:['survival'],by:'explicit survival controller',mayYield:['survival']});
  assert.equal(await k.continueSurvivalDecision(),false);
  assert.equal(currentSurvivalDecision(s).strategy,'yield_to_controller');
  k.releaseFaculties();
  chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'new recovery'});
  k.busy={until:Date.now()+10000};
  assert.equal(await k.continueSurvivalDecision(),false);
  assert.equal(currentSurvivalDecision(s).strategy,'yield_to_controller');
});
await test('decision history and recorded paths remain bounded',()=>{
  const {s}=fixture();let d;
  for(let i=0;i<70;i++)d=chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'retry'});
  updateSurvivalDecision(s,d.id,{path:Array.from({length:300},()=>({row:7,col:16})),path_length:300});
  const snapshot=survivalDecisionSnapshot(s);
  assert.equal(snapshot.history.length,64);assert.equal(snapshot.history_dropped,5);
  assert.equal(snapshot.current.path.length,256);assert.equal(snapshot.current.path_truncated,true);
});
await test('reports include successful chains and unknown attempts without inventing saved lives',async()=>{
  const {s,events}=fixture();const a=chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'hurt'});
  updateSurvivalDecision(s,a.id,{activated_at:Date.now(),arrived_at:Date.now(),path_length:1});
  const b=chooseSurvivalDecision(s,{strategy:'logoff_safe',reason:'at cover'},{outcome:'arrived'});
  finishSurvivalDecision(s,b.id,'recovered');chooseSurvivalDecision(s,{strategy:'route_refuge',reason:'next episode'});
  const result=summarizeSurvivalDecisions(events);
  assert.equal(result.strategies.find(x=>x.strategy==='nearest_refuge').recovered_episodes,1);
  assert.equal(result.strategies.find(x=>x.strategy==='route_refuge').unknown_episodes,1);
  const dir=mkdtempSync(path.join(tmpdir(),'survival-decision-log-'));
  const record=createSurvivalDecisionRecorder('offline',{dir});events.forEach(record);await record.flush();
  writeFileSync(path.join(dir,'incomplete.jsonl'),'{incomplete');
  const loaded=loadSurvivalDecisionRows(dir);assert.equal(loaded.rows.length,events.length);assert.equal(loaded.malformed,1);
  assert.equal(record.stats().errors,0);
});
await test('a blocked refuge reaches its replacement within one survival dispatch',async()=>{
  const {s,k,c,calls}=fixture();const attempted=[];
  s.approachFine=s.walkTo=async(col,row)=>{
    attempted.push({col,row});
    if(row===7&&col===16)return {arrived:false,reason:'occupied'};
    c.self={...c.self,col,row};return {arrived:true};
  };
  chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'hurt'});
  await k.continueSurvivalDecision();
  assert.ok(attempted.some(p=>p.row!==7||p.col!==16));
  assert.equal(currentSurvivalDecision(s).status,'recovering');
  assert.deepEqual(calls,['reconnect','turn']);
});
await test('a late-stage refused logoff starts its refuge before pass returns',async()=>{
  const {s,k,calls}=fixture();k.playDeadObserved=async()=>false;
  k.passOnce=async()=>{await k.playDead('under attack');};
  k.takeRecoverySpot=async()=>{
    const d=currentSurvivalDecision(s);assert.equal(d.retry_at,undefined);
    calls.push('replacement started');updateSurvivalDecision(s,d.id,{status:'recovering'});
  };
  await k.pass();assert.deepEqual(calls,['replacement started']);
});
await test('same-pass travel cancellation does not cancel a fresh survival approach',async()=>{
  const {s,k,c,calls}=fixture();k.survivalInterruptedPass=k.passes;
  s.cancelMovement(null,'old journey cancelled');
  s.approachFine=s.walkTo=async(col,row)=>{c.self={...c.self,col,row};return {arrived:true};};
  chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'replace cancelled journey'});
  await k.continueSurvivalDecision();
  assert.deepEqual(calls,['reconnect','turn']);assert.equal(currentSurvivalDecision(s).status,'recovering');
  assert.equal(k.travelInterrupted(),true,'the old travel stack stays cancelled');
});
await test('losing a recovery wall starts a replacement without another heartbeat',async()=>{
  const {s,k,calls}=fixture();
  chooseSurvivalDecision(s,{strategy:'rest_safe',status:'recovering',reason:'resting'});
  k.takeRecoverySpot=async()=>{
    calls.push('replacement started');
    updateSurvivalDecision(s,currentSurvivalDecision(s).id,{status:'recovering'});
  };
  await k.continueSurvivalDecision();assert.deepEqual(calls,['replacement started']);
});
await test('explicit survival ownership handoff stops an immediate replacement chain',async()=>{
  const {s,k,calls}=fixture();
  chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'hurt'});
  k.takeRecoverySpot=async()=>{
    calls.push('first');k.busy={until:Date.now()+10000};
    chooseSurvivalDecision(s,{strategy:'route_refuge',reason:'try another wall'});
  };
  assert.equal(await k.continueSurvivalDecision(),false);
  assert.deepEqual(calls,['first']);assert.equal(currentSurvivalDecision(s).strategy,'yield_to_controller');
});
await test('repeating failed alternatives preserves intent without a busy loop',async()=>{
  const {s,k}=fixture();let attempts=0;
  chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'hurt'});
  k.takeRecoverySpot=async()=>{
    assert.ok(++attempts<10,'failed alternatives spun forever');
    chooseSurvivalDecision(s,{strategy:'logoff_open',reason:'no refuge'});
  };
  k.playDeadObserved=async()=>false;
  await k.continueSurvivalDecision();
  assert.equal(attempts,1);assert.equal(currentSurvivalDecision(s).strategy,'nearest_refuge');
});
await test('newly excluded refuges count as new information for immediate alternatives',async()=>{
  const {s,k}=fixture();let attempts=0;
  chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'hurt'});
  k.playDeadObserved=async()=>false;
  k.takeRecoverySpot=async()=>{
    attempts++;
    if(attempts===3){updateSurvivalDecision(s,currentSurvivalDecision(s).id,{status:'recovering'});return;}
    assert.ok(attempts<4);k.noteUnreachableSpot(39,16+attempts,7);
    chooseSurvivalDecision(s,{strategy:'logoff_open',reason:'refuge blocked'});
  };
  await k.continueSurvivalDecision();assert.equal(attempts,3);
  assert.equal(currentSurvivalDecision(s).status,'recovering');
});
await test('PvP monster cover uses the real recovery selector and arrival without starting healing',async()=>{
  const {s,k,c,calls}=fixture();c.room.id=3900;
  c.rsc=new Map([[2,'Assailant'],[3,'troll']]);
  c.room.objects.set(2,{id:2,nameRsc:2,row:8,col:17,flags:OF.PLAYER|OF.ATTACKABLE});
  c.room.objects.set(3,{id:3,nameRsc:3,row:8,col:18,flags:OF.ATTACKABLE});
  c.attack=()=>calls.push('player attack');
  s.combat=new CombatMode(s,{keeper:()=>k,schedule:()=>1,unschedule(){}});
  s.pacer.submit=async(kind,fn)=>{
    const authority=bodyAuthority(s),send=bindPacketScope(kind,authority.bind(fn));
    await Promise.resolve();authority.guard();return send();
  };
  s.approachFine=s.walkTo=async(col,row)=>{
    await s.pacer.submit('move',()=>{calls.push('shelter move');c.self={...c.self,col,row};});
    return {arrived:true};
  };
  s.combat.event({kind:'message',text:'Assailant hits you.'});
  c.room.objects.delete(2);s.combat.event({kind:'vanished',id:2});
  s.combat.event({kind:'message',text:'The troll hits you.'});
  await s.combat.tick();
  assert.ok(calls.includes('shelter move'));
  assert.ok(k.currentRecoveryWall()?.ok,'the shared selector reached an actual geometric safe wall');
  assert.ok(!calls.includes('reconnect'));assert.ok(!calls.includes('turn'));
  const d=currentSurvivalDecision(s);
  assert.equal(d.strategy,'pvp_return_fire');assert.equal(d.phase,'monster_cover');
  assert.equal(d.status,'active');assert.ok(d.path_length>0);
  assert.equal(s.combat.pvpStatus().shelter.chosen_refuge.row,c.self.row);
  s.combat.issue({action:'stop'});
});
console.log(`${passed} survival decision scenarios passed`);
