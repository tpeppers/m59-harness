import assert from 'node:assert/strict';
import {attachReplayDecisionRecording,createShadowReplayAdapter} from './m59-shadow-replay.mjs';
import {chooseSurvivalDecision,restoreSurvivalDecisionForReplay,updateSurvivalDecision} from './m59-survival-decision.mjs';
const source={harness:{commit:'a'.repeat(40),source_sha256:'1'.repeat(64),dirty:false}};
const execution={harness:{commit:'b'.repeat(40),source_sha256:'2'.repeat(64),dirty:true}};
const original=structuredClone(source),events=[];
const s={movementGeneration:0,credentials:{host:'127.0.0.1',port:17959},client:{host:'127.0.0.1',port:17959,self:{row:10,col:20},vitals:()=>({health:{value:25,max:50}})},world:{room:{num:598}}};
const k={replacementSurvivalChoice:(why)=>({strategy:'nearest_refuge',reason:why})};
attachReplayDecisionRecording(s,k,{execution,source,record:e=>events.push(e)});
const first=chooseSurvivalDecision(s,{strategy:'route_refuge',reason:'new replay choice'});
assert.equal(first.epoch,execution.harness.commit);
assert.deepEqual(events.at(-1).replay_execution,execution.harness);
assert.equal(events.at(-1).source_scene_commit,source.harness.commit);
const saved={...first,id:'historical',epoch:source.harness.commit};
restoreSurvivalDecisionForReplay(s,saved);
updateSurvivalDecision(s,'historical',{status:'approaching'});
assert.equal(events.at(-1).decision.epoch,source.harness.commit,'resumed history keeps its origin');
assert.equal(events.at(-1).replay_execution.commit,execution.harness.commit,'the action still names its executing code');
const next=chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'replacement in replay'});
assert.equal(next.epoch,execution.harness.commit);
assert.deepEqual(source,original,'capture provenance was not relabelled');
const unknown=[];
attachReplayDecisionRecording(s,k,{execution:null,source,record:e=>unknown.push(e)});
chooseSurvivalDecision(s,{strategy:'route_refuge',reason:'execution unavailable'});
assert.equal(unknown.at(-1).decision.epoch,null,'unknown execution cannot borrow the historical commit');
assert.equal(unknown.at(-1).replay_execution.commit,null);
assert.equal(unknown.at(-1).source_scene_commit,source.harness.commit);
console.log('Replay provenance: new choices, resumed history, replacements, dirty code and unknown execution remain distinct');


// A second copy has a separate WeakMap, as historical engine imports do.
const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),url=await import('node:url');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m59-replay-engine-test-'));
try {
 const text=(await fs.readFile(new URL('./m59-survival-decision.mjs',import.meta.url),'utf8')).replace("'./m59-parse.mjs'",JSON.stringify(new URL('./m59-parse.mjs',import.meta.url).href));
 const file=path.join(dir,'historical-decision.mjs');await fs.writeFile(file,text);const historical=await import(url.pathToFileURL(file));
 const engineSession={...s},historicalEvents=[];
 attachReplayDecisionRecording(engineSession,k,{execution,source,record:e=>historicalEvents.push(e),attachDecisions:historical.attachSurvivalDecisions});
 const d=historical.chooseSurvivalDecision(engineSession,{strategy:'route_refuge'});
 assert.equal(d.epoch,execution.harness.commit);assert.equal(historicalEvents.length,1);
 chooseSurvivalDecision(engineSession,{strategy:'nearest_refuge'});assert.equal(historicalEvents.length,1,'current decision state must not replace or emit the historical engine state');
 assert.equal(historical.currentSurvivalDecision(engineSession).id,d.id);
 await assert.rejects(()=>createShadowReplayAdapter({configFile:'unused',engineRoot:dir}),/fresh trial worker/);
 await assert.rejects(()=>createShadowReplayAdapter({configFile:'unused',engineRoot:dir,isolate:false}),/Cannot find module/,'missing historical engine must not fall back to current modules');
}finally{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert(path.basename(dir).startsWith('m59-replay-engine-test-'));await fs.rm(dir,{recursive:true,force:true});}
console.log('Replay engine: historical decision recording shares one WeakMap; current state cannot replace it; missing sources refuse');
