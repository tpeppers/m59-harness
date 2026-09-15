#!/usr/bin/env node
// Offline: checksum-verified captures and injected adapters; no game connection.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {digest,baselineVerdict} from './m59-death-replay.mjs';
import {planPostMortemSimulation,simulatePostMortem,annotatePvpTrial} from './m59-postmortem-sim.mjs';
import {spawnSync} from 'node:child_process';
import {simulatePostMortem as fleetSim} from './m59-fleetscript.mjs';
import {isPvpAttackRefusal} from './m59-replay-players.mjs';
assert.equal(isPvpAttackRefusal('Only those in guilds may attack each other here.'),true);
assert.match(annotatePvpTrial({pvp:{actors:[],activity:{attack_refusals:3}}}).pvp_validation.interpretation,/guild/);
const dir=await mkdtemp(path.join(tmpdir(),'postmortem-pvp-'));
const scene=hp=>({name:'fixture',room:{num:544},actors:[
  {key:'self',mine:true,kind:'player',name:'Victim',vitals:{hp:{v:{value:hp,max:48},how:'observed'}}},
  {key:'attacker',kind:'player',name:'Morpheus',at:{v:{row:67,col:11,x:707,y:4326}}}
],controller:{policy:{fleeBelow:.4}}});
const payload={schema:'m59-death-replay/v1',id:'test',death:{at:10000},frames:[
  {id:'earlier',at:1000,scene:scene(48)},{id:'latest',at:9000,scene:scene(5)},
  {id:'dead',at:10000,scene:scene(0)}]};
const file=path.join(dir,'death.json'),bundleFile=path.join(dir,'bundle.json');
const record={character:'Victim',at:10000,replay:{file:'bundle.json'},text:[
  {at:10000,text:'### Victim has been murdered in cold blood.'},
  {at:10000,text:'You are dead, poor soul. Go now, and take revenge on Morpheus!'}]};
const save=async(p=payload)=>writeFile(bundleFile,JSON.stringify({payload:p,sha256:digest(p)}));
try {
  await save();await writeFile(file,JSON.stringify(record));
  assert.equal(fleetSim,simulatePostMortem);
  const annotated=annotatePvpTrial({outcome:'died',pvp:{actors:[{actor:'attacker',behavior:'melee',
    captured_name:'Morpheus',shadow_name:'ReplayABC',combat:{target:'Victim'}}]},
    victim_hp_trace:[{at:9000,hp:5,room:544},{at:10000,hp:0,room:544}],
    victim_messages:[{at:10000,text:'### Victim has been murdered in cold blood.'},
      {at:10000,text:'You are dead, poor soul. Go now, and take revenge on ReplayABC!'}]});
  assert.equal(annotated.simulated_death.captured_player,'Morpheus');
  assert.equal(annotated.simulated_death.attribution.observed,true);
  assert.equal(annotated.victim_observed_hp_loss,5);
  const plan=await planPostMortemSimulation({file});
  assert.equal(plan.frame_id,'latest');assert.deepEqual(plan.options.attackers,['Morpheus']);
  assert.equal(plan.pvp.actors[0].behavior,'melee');
  assert.equal((await planPostMortemSimulation({file,frameId:'earlier'})).scene.actors[0].vitals.hp.v.value,48);
  await assert.rejects(planPostMortemSimulation({file,frameId:'dead'}),/living checkpoint/);
  await assert.rejects(planPostMortemSimulation({file,attackers:['Absent']}),/checkpoint/);
  await assert.rejects(planPostMortemSimulation({file:bundleFile}),/specify attackers/);
  assert.equal((await planPostMortemSimulation({file:bundleFile,attackers:['attacker']})).frame_id,'latest');
  await writeFile(file,JSON.stringify({character:'Victim'}));
  await assert.rejects(planPostMortemSimulation({file}),/no replay bundle/);
  await writeFile(file,JSON.stringify(record));
  await writeFile(bundleFile,JSON.stringify({payload,sha256:'corrupt'}));
  await assert.rejects(planPostMortemSimulation({file}),/checksum/);await save();
  const simulationFile=path.join(dir,'simulation.json');
  await writeFile(simulationFile,JSON.stringify({postMortem:'death.json',configFile:'absent-config.json'}));
  const cli=spawnSync(process.execPath,['tools/m59-scene-simulator.mjs',simulationFile],{encoding:'utf8',timeout:10000});
  assert.equal(cli.status,1);assert.match(cli.stderr,/absent-config/);
  assert.doesNotMatch(cli.stderr,/unsettled top-level await/,'postmortem import must not deadlock the simulator CLI');
  const calls=[];let closed=false;
  const loadout={schema:'m59-player-loadout/v1',complete:true,items:[],skills:[43099],spells:[]};
  const result=await simulatePostMortem({file,trials:2,approximatePlayer:true,reload:{noMonsters:true},
    loadouts:{Morpheus:loadout},requireLoadouts:true,sequences:{Morpheus:[{do:'attack',swings:2}]},
    adapterFactory:async()=>({run:async req=>{
      calls.push(structuredClone(req));const attack=req.pvp.attackers.length>0;
      req.scene.actors.length=0;
      return {outcome:attack?'died':'survived_window',loaded:{ok:true,landed:{ok:true}},
        pvp:{modeled:true,activity:{attacks:attack?2:0,casts:attack?1:0,cast_failures:attack?1:0},cleanup:{complete:true}}};
    },close:async()=>{closed=true;}})});
  assert.equal(closed,true);assert.equal(result.completed,true);
  assert.deepEqual(calls.map(c=>c.pvp.attackers.length),[1,0,1,0]);
  assert.ok(calls.every(c=>c.scene.actors.length===2&&c.pvp.allow_approximate_player&&c.variant.reload.noMonsters));
  for(const c of calls){assert.deepEqual(c.pvp.loadouts,{Morpheus:loadout});assert.equal(c.pvp.require_loadouts,true);
    assert.deepEqual(c.pvp.sequences,{Morpheus:[{do:'attack',swings:2}]});}
  assert.equal(result.comparison[0].deaths,2);assert.equal(result.comparison[1].survived_window,2);
  assert.equal(result.comparison[0].trials_with_casts,2);assert.equal(result.comparison[1].trials_with_casts,0);
  assert.equal(result.comparison[0].trials_with_cast_failures,2);
  assert.equal(result.validation.baseline_reproduction_verified,false);
  const strict=baselineVerdict({bundle:payload,frame:payload.frames[1],result:result.runs[0],expected:[]});
  assert.equal(strict.valid,false);assert.ok(strict.reasons.some(r=>r.includes('modeled')));
  let count=0;
  await assert.rejects(simulatePostMortem({file,trials:2,adapterFactory:async()=>({run:async()=>{
    if(count++)throw Error('failed next load');return result.runs[0];
  },close:async()=>{}})}),e=>{
    assert.equal(e.report.runs.length,1);assert.equal(e.report.postmortem.frame_id,'latest');
    assert.equal(e.report.comparison[1].cleanup_verified,false);return true;
  });
} finally {await rm(dir,{recursive:true,force:true});}
console.log('Postmortem selection, checksum, paired controls, shared API, fidelity and partial-report tests passed');
