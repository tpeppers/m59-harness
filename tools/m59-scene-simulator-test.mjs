// Offline: fake native admin/containers and fake adapters, never a live fleet.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {captureServerSave,SAVE_PARTS} from './runtime/server-save-set.mjs';
import {inspectSceneContainer,matchesReloadCache,verifyInstalledSave,resetNativeScene} from './m59-scene-reset.mjs';
import {fastReplayReads,waitForReplayRead} from './m59-lab-readiness.mjs';
import {readLive} from './m59-abilities.mjs';
import {simulateScene,summarizeLoopTimes} from './m59-scene-simulator.mjs';
import {simulateScene as fleetScriptSimulator} from './m59-fleetscript.mjs';
let passed=0;const test=async(name,fn)=>{await fn();console.log('PASS '+name);passed++;};
const env={M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:'17998'};
const info={Id:'container',Image:'image',State:{Running:true,StartedAt:'start'},Config:{Labels:{
  'org.openai.m59.scene-lab':'true','org.openai.m59.scene-reload.ack':'v1'}},
  NetworkSettings:{Ports:{'5959/tcp':[{HostIp:'127.0.0.1',HostPort:'17959'}],
    '9998/tcp':[{HostIp:'127.0.0.1',HostPort:'17998'}]}}};
const dir=mkdtempSync(path.join(tmpdir(),'m59-reset-test-'));
for(const part of SAVE_PARTS)writeFileSync(path.join(dir,part+'.123'),part+' fixture');
writeFileSync(path.join(dir,'lastsave.txt'),'LASTSAVE 123\n');
const snapshot=path.join(dir,'copy'),manifest=captureServerSave(dir,snapshot);
const cache={schema:'m59-scene-reset-cache/v1',container_id:info.Id,image_id:info.Image,
  started_at:info.State.StartedAt,stamp:manifest.stamp,files:manifest.files};
const sums=SAVE_PARTS.map(p=>manifest.files[p+'.123']+'  /m59/savegame/'+p+'.123').join('\n');
const saveCache=c=>writeFileSync(path.join(snapshot,'.reload-cache.json'),JSON.stringify(c));

await test('container attestation rejects wrong label, public port and stopped server',()=>{
  assert.equal(inspectSceneContainer(()=>JSON.stringify([info])).Id,info.Id);
  for(const edit of [i=>i.State.Running=false,i=>i.Config.Labels={},
    i=>i.NetworkSettings.Ports['5959/tcp'][0].HostIp='0.0.0.0']) {
    const bad=structuredClone(info);edit(bad);
    assert.throws(()=>inspectSceneContainer(()=>JSON.stringify([bad])),/attest/);
  }
});
await test('warm bootstrap identity expires with image, container, start, stamp or file changes',()=>{
  assert.equal(matchesReloadCache(cache,info,manifest),true);
  for(const field of ['image_id','container_id','started_at','stamp','files'])
    assert.equal(matchesReloadCache({...cache,[field]:'changed'},info,manifest),false);
});
await test('installed checkpoint verification requires all four original byte hashes',()=>{
  assert.equal(verifyInstalledSave(sums,manifest),true);
  assert.equal(verifyInstalledSave(sums.replace(manifest.files['accounts.123'],'0'.repeat(64)),manifest),false);
  assert.equal(verifyInstalledSave(sums.split('\n').slice(1).join('\n'),manifest),false);
});
await test('warm reset verifies files and requires a positive native completion acknowledgement',async()=>{
  saveCache(cache);const calls=[];
  const exec=(_bin,args)=>{calls.push(args);return sums;};
  const dmFn=async cmds=>{calls.push(cmds);return 'Loading game...done.';};
  const result=await resetNativeScene({snapshot,env,info,exec,dmFn});
  assert.equal(result.method,'world-reload');assert.equal(calls.length,2);
  assert.equal(calls[0][2],'sha256sum');assert.deepEqual(calls[1],['reload game 123']);
  for(const reply of ['','Loading game...','Cannot reload: players in game','Loading game... system dead'])
    await assert.rejects(resetNativeScene({snapshot,env,info,exec,dmFn:async()=>reply}),/did not confirm/);
});
await test('unexpected installed data refuses mutation instead of silently overwriting it',async()=>{
  saveCache(cache);let called=false;
  await assert.rejects(resetNativeScene({snapshot,env,info,exec:()=>'',dmFn:async()=>{called=true;}}),/checksum/);
  assert.equal(called,false);
});
await test('cold bootstrap restores accounts once and caches only the newly started container',async()=>{
  saveCache({...cache,started_at:'previous'});const calls=[];
  const fresh={...info,State:{...info.State,StartedAt:'new-start'}};
  const exec=(bin,args)=>{calls.push([bin,...args]);return args[0]==='inspect'?JSON.stringify([fresh]):'';};
  const dmFn=async cmds=>{calls.push(cmds);return cmds[0]==='show status'?'System Status':'terminated';};
  const result=await resetNativeScene({snapshot,env,info,exec,dmFn});
  assert.equal(result.method,'container-restart');assert.equal(result.account_state,'restored');
  assert.ok(calls.some(c=>c[0]==='terminate save'));
  assert.ok(calls.some(c=>c.includes('restore')&&c.includes(snapshot)));
  assert.equal(JSON.parse(readFileSync(path.join(snapshot,'.reload-cache.json'))).started_at,'new-start');
});
await test('restart is explicit; old images cannot use acknowledged reload; production is refused',async()=>{
  saveCache(cache);const calls=[];
  const exec=(_bin,args)=>{calls.push(args);return args[0]==='inspect'?JSON.stringify([info]):'';};
  await resetNativeScene({snapshot,mode:'restart',env,info,exec,dmFn:async()=>'System Status'});
  assert.ok(calls.some(c=>c[0]==='start'));assert.ok(!calls.some(c=>c[2]==='sha256sum'));
  const old=structuredClone(info);delete old.Config.Labels['org.openai.m59.scene-reload.ack'];
  await assert.rejects(resetNativeScene({snapshot,mode:'reload',env,info:old}),/acknowledged/);
  await assert.rejects(resetNativeScene({snapshot,env:{...env,M59_ADMIN_PORT:'9998'}}),/17998/);
});
await test('response-driven reads require explicit opt-in and the isolated game endpoint',async()=>{
  assert.equal(fastReplayReads({}),false);
  assert.throws(()=>fastReplayReads({replayFastReads:true,client:{host:'production',port:5959}}),/isolated/);
  assert.throws(()=>fastReplayReads({replayFastReads:true,client:{host:'127.0.0.1',port:15959}}),/isolated/);
  await assert.rejects(waitForReplayRead(()=>false,{timeoutMs:10}),/timed out/);
});
await test('stale list/group data and unrelated replies do not complete an ability read',async()=>{
  const packets=[],events=[{seq:1,kind:'spells'},{seq:2,kind:'skills'}];
  const c={host:'127.0.0.1',port:17959,evSeq:2,events,abilitiesAt:{skills:1,spells:1},
    requestSpells(){packets.push('spells');},requestSkills(){packets.push('skills');},
    stats(group){packets.push(group);},abilitiesKnown(){return {skills:[],spells:[],read_at:this.abilitiesAt};}};
  const s={client:c,need:()=>c,replayFastReads:true,pacer:{submit:async(kind,fn)=>{assert.equal(kind,'read');fn();}}};
  let finished=false;const pending=readLive(s).then(r=>{finished=true;return r;});
  await new Promise(r=>setTimeout(r,20));assert.deepEqual(packets,['spells','skills']);
  events.push({seq:3,kind:'damage'});await new Promise(r=>setTimeout(r,20));assert.equal(finished,false);
  events.push({seq:4,kind:'skills'},{seq:5,kind:'spells'});
  await new Promise(r=>setTimeout(r,20));assert.deepEqual(packets,['spells','skills',3,4]);assert.equal(finished,false);
  c.abilitiesAt.skills=Date.now();await new Promise(r=>setTimeout(r,20));assert.equal(finished,false);
  c.abilitiesAt.spells=Date.now();const result=await pending;
  assert.equal(result.requests,4);assert.deepEqual(result.skills,[]);assert.deepEqual(result.spells,[]);
});
await test('ordinary ability reads retain their fixed-wait fallback without replay fields',async()=>{
  const packets=[],c={requestSkills:()=>packets.push('skills'),stats:n=>packets.push(n),
    abilitiesKnown:()=>({skills:[],spells:[],read_at:{}})};
  const result=await readLive({need:()=>c,pacer:{submit:async(_kind,fn)=>fn()}},{kinds:'skills',settleMs:0});
  assert.deepEqual(packets,['skills',4]);assert.equal(result.spells,null);
});
const scene={name:'fixture',room:{num:39},actors:[{key:'self',kind:'player'}],controller:{policy:{fleeBelow:.4}}};
const good=()=>({outcome:'survived_window',loaded:{ok:true,landed:{ok:true}},player_state:{ok:true},
  timing_wall_ms:1300,timings:{restore_to_start_ms:200,simulation_ms:1000}});
await test('FleetScript shares the simulator; paired cases each receive pristine input',async()=>{
  assert.equal(fleetScriptSimulator,simulateScene);const calls=[];let closed=false;
  const result=await simulateScene({scene,cases:[{id:'base'},{id:'strong',policy:{fleeBelow:.7},reload:{fullHp:true}}],
    trials:2,horizonMs:0,adapterFactory:async()=>({attest:async()=>({commit:'fixture'}),
      run:async req=>{calls.push(structuredClone(req));req.scene.actors.length=0;return good();},
      close:async()=>{closed=true;}})});
  assert.equal(closed,true);assert.equal(result.completed,true);assert.equal(result.provenance.commit,'fixture');
  assert.deepEqual(result.runs.map(r=>[r.case,r.trial]),[['base',1],['strong',1],['base',2],['strong',2]]);
  assert.deepEqual(calls.map(c=>c.scene.controller.policy.fleeBelow),[.4,.7,.4,.7]);
  assert.ok(calls.every(c=>c.scene.actors.length===1));assert.equal(scene.actors.length,1);
  assert.ok(result.runs.every(r=>r.outcome==='setup_only'));assert.equal(result.validation.baseline_reproduction_verified,false);
});
await test('invalid releases, player mismatches and thrown executions stop the loop with partial evidence',async()=>{
  for(const failure of [{...good(),outcome:'invalid_release'},{...good(),player_state:{ok:false}},Error('connection lost')]) {
    let calls=0,closed=false;
    await assert.rejects(simulateScene({scene,trials:3,adapterFactory:async()=>({run:async()=>{
      calls++;if(failure instanceof Error)throw failure;return failure;},close:async()=>{closed=true;}})}),error=>{
        assert.equal(error.report.completed,false);assert.ok(error.report.finished_at);return true;});
    assert.equal(calls,1);assert.equal(closed,true);
  }
});
await test('invalid loop requests never acquire an adapter and timing medians handle even samples',async()=>{
  for(const config of [{trials:0},{horizonMs:-1},{cases:[]},{cases:[null]},{cases:[{id:'x'},{id:'x'}]}])
    await assert.rejects(simulateScene({scene,...config,adapterFactory:()=>assert.fail('acquired')}));
  assert.equal(summarizeLoopTimes([{timings:{restore_to_start_ms:10}},{timings:{restore_to_start_ms:20}}]).restore_to_start.median_ms,15);
});
console.log(passed+' scene simulation tests passed');
