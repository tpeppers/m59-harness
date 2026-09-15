import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {configureReplayEnvironment,replayEnvironmentReceipt} from './m59-shadow-replay.mjs';

const root=mkdtempSync(join(tmpdir(),'m59-replay-env-'));
try {
  const selection={fleet:'replay-test',stateFile:join(root,'replay-test.json')};
  const keys=['M59_SAFESPOT_FILE','M59_BAD_EXITS','M59_PREYSIDE_FILE','M59_TRACK_STRIKES'];
  const inputs=Object.fromEntries(keys.map(key=>[key,join(root,`${key}.json`)]));
  for(const file of Object.values(inputs))writeFileSync(file,'{"baseline":true}');
  const envA={...inputs},envB={...inputs};
  const a=configureReplayEnvironment(selection,envA);
  writeFileSync(a.safespots,'{"old_trial":true}');
  const b=configureReplayEnvironment(selection,envB);
  assert.equal(a.scope,b.scope,'fixture actually reuses the same process ID');
  assert.notEqual(a.runtimeDir,b.runtimeDir);
  assert.equal(readFileSync(a.safespots,'utf8'),'{"old_trial":true}');
  assert.equal(readFileSync(b.safespots,'utf8'),'{"baseline":true}');
  for(const [runtime,env] of [[a,envA],[b,envB]])for(const key of ['M59_SURVIVAL_DECISION_DIR','M59_REPLAY_DIR']) {
    const child=relative(runtime.runtimeDir,env[key]);
    assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child),`${key} stays inside its fresh worker`);
  }
  const first=replayEnvironmentReceipt(b,1,1);
  assert.equal(first.fresh_scope,true);
  assert.equal(first.runtime_dir,b.runtimeDir);
  assert.equal(first.reused_in_process,false);
  assert.equal(first.seed_inputs_at,'environment_initialization');
  assert.ok(first.seed_inputs.every(s=>s.status==='copied'&&s.initial_sha256?.length===64));
  first.seed_inputs[0].initial_sha256='changed';
  assert.notEqual(b.seedInputs[0].initial_sha256,'changed','returned reports cannot mutate the startup manifest');
  assert.equal(replayEnvironmentReceipt(b,2,2).reused_in_process,true);
  assert.equal(replayEnvironmentReceipt(b,1,2).reused_in_process,true,
    'capture/reset before the first trial also makes process reuse explicit');
} finally {
  rmSync(root,{recursive:true,force:true});
}
console.log('Replay environment: fresh same-PID scopes, preserved evidence, baseline hashes and process reuse PASS');
