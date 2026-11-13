// Offline: the harness side of DUM's supervisor registry contract (m59-supervisor-heartbeat.mjs).
//   node tools/m59-supervisor-heartbeat-test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeIdentity, supervisorHeartbeat, supervisorStateDir } from './m59-supervisor-heartbeat.mjs';

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); } };

const dir = mkdtempSync(join(tmpdir(), 'm59-hb-'));
const fakeGit = ({ porcelain = '' } = {}) => (cwd, args) => {
  if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return 'C:/repo';
  if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc123';
  if (args[0] === 'status') return porcelain;
  return null;
};
const env = (extra = {}) => ({ M59_SUPERVISOR_STATE_DIR: dir, ...extra });
const read = id => JSON.parse(readFileSync(join(dir, `${id}.supervisor.json`), 'utf8'));

test('the card carries every schema-1 field, atomically written', () => {
  const hb = supervisorHeartbeat({ id: 'courier', fleet: 'prod', entry: 'C:/repo/tools/x.mjs', env: env(), run: fakeGit() });
  hb.write();
  const c = read('courier');
  for (const k of ['schema', 'id', 'pid', 'started_at', 'heartbeat_at', 'fleet', 'entry', 'repo', 'commit', 'dirty', 'status'])
    assert.ok(k in c, `missing ${k}`);
  assert.equal(c.schema, 1); assert.equal(c.commit, 'abc123'); assert.equal(c.dirty, false); assert.equal(c.status, 'running');
  assert.ok(!existsSync(join(dir, 'courier.supervisor.json.next')), 'no temp file left behind');
});

test('a modified or untracked pinned path reads dirty', () => {
  assert.equal(codeIdentity('C:/repo/tools/x.mjs', [], fakeGit({ porcelain: ' M tools/x.mjs' })).dirty, true);
  assert.equal(codeIdentity('C:/repo/tools/x.mjs', [], fakeGit({ porcelain: '?? tools/x.mjs' })).dirty, true);
});

test('outside a git tree: repo/commit null, never a guess', () => {
  const id = codeIdentity('C:/nowhere/x.mjs', [], () => null);
  assert.deepEqual(id, { repo: null, commit: null, dirty: null });
});

test('DUM\'s declared id and requester win over the default', () => {
  const hb = supervisorHeartbeat({ id: 'courier', entry: 'C:/repo/x.mjs', run: fakeGit(),
    env: env({ M59_SUPERVISOR_ID: 'ocean-courier', M59_SUPERVISOR_REQUESTED_BY: 'dum/test@pid-1' }) });
  hb.write();
  const c = read('ocean-courier');
  assert.equal(c.id, 'ocean-courier'); assert.equal(c.requested_by, 'dum/test@pid-1');
});

test('the registry stop file is seen, cleared on start, and stop() leaves status stopped', () => {
  const hb = supervisorHeartbeat({ id: 'stopper', entry: 'C:/repo/x.mjs', env: env(), run: fakeGit(), everyMs: 60_000 });
  writeFileSync(hb.stopFile, '');
  hb.start();
  assert.equal(hb.stopRequested(), false, 'a start clears a stale stop request');
  writeFileSync(hb.stopFile, '');
  assert.equal(hb.stopRequested(), true);
  hb.stopping(); assert.equal(read('stopper').status, 'stopping');
  hb.stop(); assert.equal(read('stopper').status, 'stopped');
});

test('state dir defaults under the harness substrate', () => {
  assert.match(supervisorStateDir({}).replace(/\\/g, '/'), /substrate\/supervisors$/);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
