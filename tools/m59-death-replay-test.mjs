import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {EventEmitter} from 'node:events';
import {OF} from './m59-parse.mjs';
import {captureCachedScene} from './m59-scene-capture.mjs';
import {loadPlan,executeLoad,executeRelease,observed,sceneProvenance} from './m59-scene.mjs';
import {relocateFineCmd} from './m59-dm.mjs';
import {compareScenePlacement} from './m59-scene-admin.mjs';
import {firstPassChecklist,baselineVerdict,runFirstPass,readReplay,digest} from './m59-death-replay.mjs';
import {attachReplayRecorder} from './m59-replay-recorder.mjs';
import {chooseSurvivalDecision,currentSurvivalDecision} from './m59-survival-decision.mjs';
import {installReplayVariant} from './m59-replay-variants.mjs';
import {assertShadowReplayConfig,rebaseReplayTimes} from './m59-shadow-replay.mjs';
import {sceneWithOptions} from './m59-scene-options.mjs';
import {captureServerSave,verifyServerSave,SAVE_PARTS} from './runtime/server-save-set.mjs';
import {nativeMonsterPlan,enrichHeldScene,compareNativeMonster} from './m59-scene-native-state.mjs';
let passed=0;const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
function fixture(count=3) {
  const c={state:'game',host:'127.0.0.1',port:15959,selfId:1,me:{name:'Subject'},
    self:{id:1,row:30,col:61,x:3911,y:1955,angle:2048},evSeq:12,
    room:{id:91,objects:new Map()},rsc:{get:n=>'resource '+n},statsById:new Map(),
    vitals:()=>({health:{value:12,max:50},mana:{value:8,max:30},vigor:{value:60,max:200}}),
    inventory:[{id:7,name:'mace',amount:1,rarity:0}],equipment:()=>({equipped:[{id:7,name:'mace'}]}),
    abilities:new Map([[1,{kind:'skill',name:'mace',ability:90}]]),abilitiesAt:{skills:1,spells:1}};
  for(let i=0;i<count;i++)c.room.objects.set(i+2,{id:i+2,name:'skeleton',flags:OF.ATTACKABLE,
    row:29,col:60,x:3861,y:1891,angle:128});
  const s={name:'offline',live:true,client:c,credentials:{host:'127.0.0.1',port:15959},
    world:{room:{num:39,name:'room'}},movementGeneration:0,cancelMovement(){this.movementGeneration++;return {cancelled:true};}};
  const k={s,mode:'farm',policy:{fleeBelow:.4,secret:'do not copy'},
    currentRecoveryWall:()=>true,playDead:async()=>true,takeRecoverySpot:async()=>({took:true}),
    takeSafeSpot:async()=>({took:true}),continueSurvivalDecision:async()=>true,checkFreeze:()=>true,goTravelling(){}};
  return {s,c,k};
}
const code={harness:{commit:'a'.repeat(40),source_sha256:'b'.repeat(64),dirty:false}};
function bundleFixture() {
  const {s,k}=fixture();const scene=captureCachedScene(s,k,{provenance:code,at:10000});
  return {schema:'m59-death-replay/v1',id:'fixture',provenance:code,frames:[{id:'start',at:10000,scene}],
    death:{at:20000,detail:{where:{room:39}}},capture:{dropped:0,errors:0}};
}
const baselineResult=()=>({outcome:'died',elapsed_ms:10000,death_room:39,decisions:[],loaded:{ok:true,landed:{ok:true}}});

await test('capture retains every visible body and exact asymmetric fine positions without IO',()=>{
  const {s,c,k}=fixture(40);c.playersOnline=new Map([[40,{}]]);
  c.stats=()=>assert.fail('capture polled the server');
  const sc=captureCachedScene(s,k,{provenance:code});
  assert.equal(sc.actors.length,41);assert.equal(sc.actors[0].at.v.x,3911);
  assert.equal(sc.actors.find(a=>a.object_at_capture===40).kind,'player');
  assert.equal(sc.actors[1].vitals.hp.how,'unknown');assert.equal(sc.controller.policy.secret,undefined);
  c.self.x=3912;assert.equal(sc.actors[0].at.v.x,3911,'snapshot must not retain mutable position references');
});
await test('truncation and predicted locations are explicit integrity failures',()=>{
  const {s,c,k}=fixture(8);c.self.predicted=true;
  const sc=captureCachedScene(s,k,{limits:{actors:4,inventory:10,abilities:10}});
  assert.equal(sc.capture.complete_visible_positions,false);
  assert.ok(sc.capture.gaps.includes('room objects truncated'));
  assert.ok(sc.capture.gaps.some(g=>g.includes('predicted')));
});
await test('shared loader keeps current HP distinct from maximum and uses monster properties',()=>{
  const {s,k}=fixture(1),sc=captureCachedScene(s,k,{provenance:code});
  sc.actors[1].vitals.hp=observed({value:3,max:80});
  const cmds=loadPlan(sc).map(r=>r.cmd).join('\n');
  assert.match(cmds,/piBase_Max_Health INT 50/);assert.match(cmds,/piHealth INT 12/);
  assert.match(cmds,/piMax_Mana INT 30/);assert.match(cmds,/piMana INT 8/);
  assert.match(cmds,/piMax_hit_points INT 80/);assert.match(cmds,/piHit_points INT 3/);
  assert.match(cmds,/fine_row INT 35 fine_col INT 7/);assert.match(cmds,/max_distance INT 0/);
  assert.equal(loadPlan(sc).filter(x=>x.cmd.includes('ClearBasicTimers')).length,1);
});
await test('fine coordinates cannot silently change containing square',()=>{
  assert.throws(()=>relocateFineCmd(1,2,{row:61,col:30,x:3911,y:1955}),/must agree/);
});
await test('duplicate names require separate current bindings before mutation',async()=>{
  const {s,k}=fixture(2),sc=captureCachedScene(s,k,{provenance:code});let calls=0;
  const result=await executeLoad(sc,{dmFn:async()=>{calls++;return '';}});
  assert.equal(result.ok,false);assert.equal(result.sent,0);assert.equal(calls,0);
});
await test('failed placement verification makes the shared load fail',async()=>{
  const {s,k}=fixture(0),sc=captureCachedScene(s,k,{provenance:code});
  const result=await executeLoad(sc,{resolveActor:()=>123,
    dmFn:async cmds=>cmds.map(c=>c+'\n: OBJECT 9').join('\n'),verify:async()=>({ok:false,mismatches:['fine offset']})});
  assert.equal(result.ok,false);assert.match(result.why,/verification/);
});
await test('placement checks distinguish fine offsets, health and unexpected extra actors',()=>{
  const {s,k}=fixture(0),sc=captureCachedScene(s,k,{provenance:code});
  const r=compareScenePlacement(sc,new Map([['self',1]]),{room_object:2,actors:[
    {id:1,room_object:2,row:30,col:61,x:3912,y:1955,hp:{value:12,max:50}}, {id:8,class:'Extra'}]});
  assert.equal(r.ok,false);assert.ok(r.mismatches.some(m=>m.field==='x'));
  assert.ok(r.mismatches.some(m=>m.why==='extra room actors'));
});
await test('strict recording similarity checks timing/code/decisions separately from usable deaths',()=>{
  const b=bundleFixture(),f=b.frames[0],r=baselineResult();
  assert.equal(baselineVerdict({bundle:b,frame:f,result:r,expected:[],attestation:code}).valid,true);
  for(const change of [r=>r.elapsed_ms=90000,r=>r.loaded.landed.ok=false,
    r=>r.player_state={ok:false},r=>r.death_room=99]) {
    const result=baselineResult();change(result);
    assert.equal(baselineVerdict({bundle:b,frame:f,result,expected:[],attestation:code}).valid,false);
  }
  r.outcome='survived_window';assert.equal(baselineVerdict({bundle:b,frame:f,result:r,expected:[],attestation:code}).valid,false);
  r.outcome='died';b.capture.dropped=1;
  assert.equal(baselineVerdict({bundle:b,frame:f,result:r,expected:[],attestation:code}).valid,false);
  b.capture.dropped=0;r.decisions=[{event:'chosen',decision:{strategy:'logoff_safe'}}];
  assert.equal(baselineVerdict({bundle:b,frame:f,result:r,expected:[],attestation:code}).valid,false);
});
await test('all nonfatal baselines are retained and summarized without inventing a death',async()=>{
  const b=bundleFixture();let runs=0,closed=false;
  const report=await runFirstPass(b,{adapter:{attest:async()=>code,
    run:async()=>{runs++;return {...baselineResult(),outcome:'survived_window'};},close:async()=>{closed=true;}}});
  assert.equal(runs,3);assert.equal(closed,true);assert.equal(report.validation.status,'insufficient_baseline_evidence');
  assert.equal(report.runs.length,3);assert.equal(report.strategies[0].survived_window,3);
});
await test('strict recorded-behavior mode still rejects code mismatch before a scene is loaded',async()=>{
  const report=await runFirstPass(bundleFixture(),{criterion:'recorded-behavior',adapter:{attest:async()=>({}),run:async()=>assert.fail('mutated mismatched code')}});
  assert.equal(report.validation.status,'code_mismatch');
});
await test('checklist tests activated strategies separately, jointly and the first cancellation',()=>{
  const b=bundleFixture();
  const a={id:'a',strategy:'nearest_refuge',reason_code:'hurt',chosen_at:11000,activated_at:11100,
    cancelled_at:12000,replacement_id:'b',outcome:'cancelled'};
  const d={id:'b',strategy:'logoff_open',chosen_at:12000,activated_at:12100};
  b.frames.push({id:'one',at:11000,event:{event:'chosen',decision:a}},
    {id:'two',at:12000,event:{event:'chosen',decision:d}});
  const plan=firstPassChecklist(b);
  assert.deepEqual(plan.cases.map(c=>c.kind),['baseline','disable','disable','disable','continue']);
  assert.equal(plan.cases.at(-1).decision.id,'a');
});
await test('successful baseline repeats precede paired intervention trials',async()=>{
  const variants=[];const report=await runFirstPass(bundleFixture(),{baselineRuns:2,trials:2,
    adapter:{attest:async()=>code,run:async({variant})=>{variants.push(variant.kind);return {...baselineResult(),intervention_applied:true,outcome:variant.kind==='baseline'?'died':'survived_window'};}}});
  assert.deepEqual(variants,['baseline','baseline','enable','enable']);assert.equal(report.validation.valid,true);
  assert.equal(report.strategies[1].survived_window,2);
});
await test('different death timing, room and code remain eligible with fidelity differences recorded',async()=>{
  const b=bundleFixture();b.capture.dropped=1;let baseline=0;
  const report=await runFirstPass(b,{trials:1,adapter:{attest:async()=>({harness:{commit:'new',source_sha256:'new'}}),
    run:async({variant})=>({...baselineResult(),elapsed_ms:4000,death_room:49,intervention_applied:true,
      outcome:variant.kind==='baseline'?(++baseline===1?'survived_window':'died'):'recovered'})}});
  assert.equal(baseline,3);assert.equal(report.validation.status,'reproducible_death');
  assert.equal(report.validation.failure_reproduction.deaths,2);
  assert.equal(report.validation.failure_reproduction.nonfatal,1);
  assert.equal(report.validation.recording_fidelity.all_matched,false);
  assert.ok(report.validation.recording_fidelity.deviations[1].reasons.includes('death timing diverged'));
  assert.equal(report.strategies[1].recovered,1);assert.equal(report.runs.length,4);
});
await test('strict timing divergence keeps all baseline evidence and withholds strict comparisons',async()=>{
  const report=await runFirstPass(bundleFixture(),{criterion:'recorded-behavior',adapter:{attest:async()=>code,
    run:async()=>({...baselineResult(),elapsed_ms:4000})}});
  assert.equal(report.runs.length,3);assert.equal(report.validation.valid,false);
  assert.equal(report.validation.failure_reproduction.repeatable,true);assert.equal(report.strategies[0].deaths,3);
});
await test('one observed death is retained but does not satisfy the default recurrence threshold',async()=>{
  let runs=0;const report=await runFirstPass(bundleFixture(),{adapter:{attest:async()=>code,
    run:async()=>({...baselineResult(),outcome:++runs===1?'died':'survived_window'})}});
  assert.equal(runs,3);assert.equal(report.validation.valid,false);assert.equal(report.strategies[0].deaths,1);
  assert.equal(report.strategies[0].survived_window,2);
});
await test('invalid loads and execution failures cannot satisfy the recurrence threshold',async()=>{
  let runs=0;const report=await runFirstPass(bundleFixture(),{adapter:{attest:async()=>code,run:async()=>{
    runs++;if(runs===2)throw Error('failed connection');
    return runs===1?{...baselineResult(),loaded:{ok:false}}:baselineResult();}}});
  assert.equal(runs,3);assert.equal(report.runs.length,3);assert.equal(report.validation.valid,false);
  assert.equal(report.validation.failure_reproduction.invalid,2);assert.equal(report.strategies[0].deaths,1);
});
await test('variants target protections seen in reproduced failures even when the recording differs',async()=>{
  const cases=[],b=bundleFixture();const d={id:'new',strategy:'logoff_open',reason_code:'wedged',activated_at:11000};
  const report=await runFirstPass(b,{trials:1,adapter:{attest:async()=>code,run:async({variant})=>{
    cases.push(variant);return {...baselineResult(),decisions:[{event:'chosen',decision:d}],intervention_applied:true};}}});
  assert.deepEqual(cases.map(c=>c.kind),['baseline','baseline','baseline','disable']);
  assert.deepEqual(cases.at(-1).strategies,['logoff_open']);
  assert.equal(report.checklist.cases[1].kind,'enable');assert.equal(report.validation.recording_fidelity.all_matched,false);
});
await test('a later variant error and cleanup failure never erase earlier outcomes',async()=>{
  let variants=0;const saved=[];
  const report=await runFirstPass(bundleFixture(),{trials:2,onResult:(_row,r)=>saved.push(structuredClone(r)),
    adapter:{attest:async()=>code,close:async()=>{throw Error('cleanup failed');},run:async({variant})=>{
      if(variant.kind==='baseline')return baselineResult();
      if(++variants===2)throw Error('trial failed');
      return {...baselineResult(),outcome:'survived_window',intervention_applied:false};}}});
  assert.equal(report.runs.length,5);assert.equal(saved.length,5);assert.equal(report.completed,false);
  assert.equal(report.strategies[0].deaths,3);assert.equal(report.strategies[1].observed.survived_window,1);
  assert.equal(report.strategies[1].survived_window,0);assert.equal(report.strategies[1].unapplied,1);
  assert.equal(report.strategies[1].unknown,1);assert.equal(report.cleanup_error,'cleanup failed');
});
await test('each baseline and variant receives an independent pristine scene copy',async()=>{
  const b=bundleFixture(),count=b.frames[0].scene.actors.length,seen=[];
  await runFirstPass(b,{trials:1,adapter:{attest:async()=>code,run:async({scene})=>{
    seen.push(scene.actors.length);scene.actors.length=0;return {...baselineResult(),intervention_applied:true};}}});
  assert.deepEqual(seen,[count,count,count,count]);assert.equal(b.frames[0].scene.actors.length,count);
});
await test('lab variants cannot be enabled on production',()=>{
  const {k,s}=fixture();s.credentials={host:'production.example',port:5959};
  assert.throws(()=>installReplayVariant(k,{kind:'disable',strategies:['logoff_safe']}),/shadow game server/);
  assert.throws(()=>assertShadowReplayConfig({fleet_file:'prod.json',agent:'t1'}, {credentials:s.credentials}),/refuses/);
});
await test('disabling a selected strategy suppresses its actual executor, then restores it',async()=>{
  const {k}=fixture();const control=installReplayVariant(k,{kind:'disable',strategies:['logoff_safe']});
  assert.equal(await k.playDead('test'),false);control.restore();assert.equal(await k.playDead('test'),true);
});
await test('follow-through suppresses automatic cancellation while preserving explicit stop',()=>{
  const {k,s}=fixture();const d=chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason_code:'hurt'});
  const control=installReplayVariant(k,{kind:'continue',decision:d});
  assert.equal(s.cancelMovement(null,'automatic watchdog').cancelled,false);assert.equal(s.movementGeneration,0);
  chooseSurvivalDecision(s,{strategy:'logoff_open'},{because:'automatic replacement'});
  assert.equal(currentSurvivalDecision(s).id,d.id);
  assert.equal(s.cancelMovement(null,'operator stop',{replacement:{strategy:'yield_to_controller'}}).cancelled,true);
  control.restore();
});
await test('follow-through prevents a competing executor as well as a ledger replacement',async()=>{
  const {k,s}=fixture();k.currentRecoveryWall=()=>false;
  const d=chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason_code:'hurt',status:'approaching'});
  const control=installReplayVariant(k,{kind:'continue',decision:d});
  assert.equal(await k.playDead('automatic'),false);
  assert.equal((await k.takeRecoverySpot('reroute')).took,false);
  control.restore();assert.equal(await k.playDead('normal'),true);
});
await test('rest suppression covers armed rest and its freeze executor only in the lab',async()=>{
  const {k,s}=fixture();k.hold={reclaimed:true,takenAt:1};k.turnedAt=2;
  const control=installReplayVariant(k,{kind:'disable',strategies:['rest_safe']});
  assert.equal(await k.playDead('already armed'),false);
  chooseSurvivalDecision(s,{strategy:'rest_safe'});k.frozenUntil=Date.now()+1000;
  assert.equal(k.checkFreeze(),false);assert.equal(k.frozenUntil,null);control.restore();
});
await test('critical frames retain a reserved bounded queue during worker startup',async()=>{
  const {k,s}=fixture(),fake=new EventEmitter(),messages=[];
  fake.unref=()=>{};fake.postMessage=m=>messages.push(m);fake.terminate=async()=>{};
  const recorder=attachReplayRecorder(s,k,{enabled:true,workerFactory:()=>fake,sampleMs:60000});
  for(let i=0;i<4;i++)assert.ok(recorder.capture());
  assert.ok(recorder.capture('damage'));
  assert.equal(recorder.death({reason:'fatal'}).status,'queued');
  assert.equal(recorder.status().dropped,0);
  fake.emit('message',{type:'saved',file:'same'});fake.emit('message',{type:'saved',file:'same'});
  assert.equal(recorder.status().persisted_deaths,1);assert.equal(recorder.status().persisted_writes,2);
  for(const m of messages)fake.emit('message',{type:'ack'});
  await recorder.close();
});
await test('reload options preserve the source and explicitly remove orphaned opening actions',()=>{
  const {k,s}=fixture(),sc=captureCachedScene(s,k);
  sc.controller.start_actions=[{kind:'attack',actor_key:sc.actors[1].key}];
  const changed=sceneWithOptions(sc,{fullHp:true,vigor:200,noMonsters:true});
  assert.equal(changed.actors.length,1);assert.equal(changed.actors[0].vitals.hp.v.value,50);
  assert.equal(changed.actors[0].vitals.vigor.v.value,200);
  assert.deepEqual(changed.controller.start_actions,[]);
  assert.equal(changed.reload.faithful,false);assert.equal(sc.actors[0].vitals.hp.v.value,12);
  assert.throws(()=>sceneWithOptions(sc,{vigor:201}),/0 to 200/);
});
await test('native checkpoint verification rejects altered or missing world parts',async()=>{
  const source=await mkdtemp(path.join(tmpdir(),'m59-save-source-'));
  const destination=await mkdtemp(path.join(tmpdir(),'m59-save-copy-'));
  await writeFile(path.join(source,'lastsave.txt'),'LASTSAVE 1234\n');
  for(const name of SAVE_PARTS)await writeFile(path.join(source,name+'.1234'),name);
  const m=captureServerSave(source,destination);assert.equal(m.stamp,'1234');
  assert.equal(Object.keys(verifyServerSave(destination).files).length,5);
  await writeFile(path.join(destination,'dynarscs.1234'),'corrupt');
  assert.throws(()=>verifyServerSave(destination),/checksum/);
});
await test('temporal restoration preserves relative deadlines and leaves durations alone',()=>{
  const at=1789400000000,got=rebaseReplayTimes({at,until:at+5000,held:{takenAt:at-1000},maxMs:60000},10000);
  assert.deepEqual(got,{at:at+10000,until:at+15000,held:{takenAt:at+9000},maxMs:60000});
});
await test('native monster targets rebind by scene key and timer state is verified',()=>{
  const {s,k}=fixture(1),sc=captureCachedScene(s,k),bindings=new Map([['self',801],['body-2',802]]);
  const actual={properties:{pbsceneheld:{value:1}},actors:[{id:802,class:'GiantRat',hp:{value:7,max:30},
    properties:{pbsceneheld:{value:1},potarget:{type:'OBJECT',value:801},
      pistate:{type:'INT',value:2},piscenebehaviorms:{type:'INT',value:400}}}]};
  const enriched=enrichHeldScene(sc,bindings,actual),actor=enriched.actors[1];
  assert.equal(actor.server_state.v.target,'self');
  const cmds=nativeMonsterPlan(actor,99,new Map([['self',98]]));
  assert.match(cmds[0],/what OBJECT 98/);assert.ok(cmds.some(c=>c.includes('piSceneBehaviorMs INT 400')));
  assert.deepEqual(compareNativeMonster(actor,actual.actors[0],bindings),[]);
  actual.actors[0].properties.potarget.value=999;
  assert.ok(compareNativeMonster(actor,actual.actors[0],bindings).length);
  actor.server_state.v.fields.password=1;
  assert.throws(()=>nativeMonsterPlan(actor,99,bindings),/unsupported native monster property/);
});
await test('background writer persists checksum-protected full replay bundles and corruption is detected',async()=>{
  const {k,s}=fixture();const dir=await mkdtemp(path.join(tmpdir(),'m59-replay-'));
  const recorder=attachReplayRecorder(s,k,{enabled:true,dir,sampleMs:60000});
  recorder.capture('test');const pending=recorder.death({reason:'test death'});
  assert.equal(await recorder.flush(20000),true);
  const b=await readReplay(pending.file);assert.equal(b.frames[0].scene.actors.length,4);
  assert.equal(b.validation.status,'unvalidated');assert.equal(b.provenance.harness.commit.length,40);
  const bad=JSON.parse(await readFile(pending.file,'utf8'));bad.payload.death.at++;
  await writeFile(pending.file,JSON.stringify(bad));await assert.rejects(()=>readReplay(pending.file),/checksum/);
  await recorder.close();
});
await test('capture cost is measured independently of worker serialization and disk writes',()=>{
  const {k,s}=fixture(200);const times=[];
  for(let i=0;i<100;i++){const t=performance.now();captureCachedScene(s,k,{provenance:code});times.push(performance.now()-t);}
  times.sort((a,b)=>a-b);console.log(JSON.stringify({actors:201,p50_ms:times[50],p95_ms:times[95],max_ms:times[99]}));
  assert.ok(times[95]<50,'capture consumed a material part of the one-second survival tick');
});
console.log(`${passed} death replay scenarios passed`);
