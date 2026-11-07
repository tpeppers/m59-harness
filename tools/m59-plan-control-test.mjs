// Offline: actual MANAGE control provider, log tail and negotiated file protocol.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlProvider } from './plans/control.mjs';
import { createKeeperLogTail } from './m59-plan-logs.mjs';
import { parsePlanRequest, renderPlanView, enc } from './m59-plan-desk.mjs';
let passed = 0;
const test = async (name, f) => { await f(); passed++; console.log(`  ok ${name}`); };
const dir = mkdtempSync(join(tmpdir(), 'm59-plan-control-'));
const now = Date.now();
const request = (version, capability = '') => `M59PLANREQ\t${version}\t${now}\t42\t127.0.0.1%3A5962\tt1\tTester\t99\t1\n${capability}END\n`;
await test('new clients negotiate log capability; old requests remain readable', () => {
  assert.equal(parsePlanRequest(request(2, 'C\tlogs\t1\n'), now).capabilities.logs, true);
  assert.equal(parsePlanRequest(request(1), now).capabilities.logs, undefined);
  assert.equal(parsePlanRequest(request(1, 'C\tlogs\t1\n'), now), null);
  assert.equal(parsePlanRequest(request(2, 'C\tunknown\t1\n'), now), null);
});
await test('log rows are escaped and never sent to protocol one clients', () => {
  const logs = [{ seq: 123, text: 'line\twith\nbreaks' }];
  assert.equal(renderPlanView({ pid: 42, ack: 0, logs }).includes('\nL\t'), false);
  assert.ok(renderPlanView({ pid: 42, ack: 0, logs, version: 2 }).includes(`\nL\t123\t${enc(logs[0].text)}\n`));
});
const file = join(dir, 'keeper-t1.log');
writeFileSync(file, 'historic\n');
const tail = createKeeperLogTail();
await test('log mode starts off and enabling starts at EOF', () => {
  assert.deepEqual(tail.read(file), []);
  tail.setEnabled(true, file); assert.deepEqual(tail.read(file), []);
  appendFileSync(file, 'new line\n'); assert.equal(tail.read(file)[0].text, 'new line');
  assert.deepEqual(tail.read(file), []);
});
await test('partial UTF-8 and partial lines survive separate writes', () => {
  const value = Buffer.from('log café\n');
  appendFileSync(file, value.subarray(0, 8)); assert.deepEqual(tail.read(file), []);
  appendFileSync(file, value.subarray(8)); assert.equal(tail.read(file)[0].text, 'log café');
});
await test('log rotation and truncation keep the stream live', () => {
  writeFileSync(file, 'cut\n'); assert.equal(tail.read(file)[0].text, 'cut');
  renameSync(file, join(dir, 'old.log')); writeFileSync(file, 'rotated\n');
  assert.equal(tail.read(file)[0].text, 'rotated');
});
await test('per-client log cursors do not consume each other and disable discards old output', () => {
  const other = createKeeperLogTail(); other.setEnabled(true, file);
  appendFileSync(file, 'both\n'); assert.equal(tail.read(file)[0].text, 'both'); assert.equal(other.read(file)[0].text, 'both');
  tail.setEnabled(false, file); appendFileSync(file, 'off\n'); assert.deepEqual(tail.read(file), []);
  tail.setEnabled(true, file); assert.deepEqual(tail.read(file), []);
});
await test('missing logs and oversized bursts are bounded', () => {
  const missing = join(dir, 'later.log'), t = createKeeperLogTail(); t.setEnabled(true, missing);
  assert.deepEqual(t.read(missing), []); writeFileSync(missing, 'created later\n');
  assert.equal(t.read(missing)[0].text, 'created later');
  appendFileSync(file, 'x'.repeat(180000) + '\n\x1b[31mred\x1b[0m\n');
  const rows = tail.read(file); assert.ok(rows.length <= 64); assert.ok(rows.some(r => /skipped/.test(r.text)));
  assert.ok(rows.every(r => r.text.length <= 2000 && !r.text.includes('\x1b')));
  assert.ok(rows.every((r, i) => i === 0 || r.seq > rows[i - 1].seq));
});
function fixture() {
  const calls = [], ctx = { fleet: 'test', stateFile: join(dir, 'roster.json'), substrate: dir, now,
    client: { agent: 't1', pid: 42, player_id: 99, capabilities: { logs: true } }, desk: { messages: [] } };
  let found = { advert: { gate_control: 1001, attach: 1002 }, session: { player_id: 99, gate: null, gate_refusal: null } };
  let status = { automated: false, attached: null, piloted: true }, fail = null, lostReply = false;
  const p = createControlProvider({ find: async () => found,
    proxy: async (port, path, body) => {
      calls.push({ kind: 'proxy', path, body });
      if (path.startsWith('/ungate')) found.session.gate = null;
      else found.session.gate = { holder: body.holder };
      return { ok: true };
    },
    callBroker: async args => {
      calls.push({ kind: 'broker', ...args });
      if (fail && args.action !== 'control_status') return { ok: false, error: fail };
      if (args.action === 'attach') status = { automated: true, piloted: false,
        attached: { pid: 100, client_pid: 42, player: 99, attach_port: 1002, gate_control: 1001 } };
      if (args.action === 'attach' && lostReply) throw Error('reply lost after transfer');
      if (args.action === 'reclaim') status = { automated: false, piloted: true, attached: null };
      return { ok: true, ...status };
    },
  });
  return { p, ctx, calls, get found() { return found; }, set found(v) { found = v; }, set fail(v) { fail = v; }, set status(v) { status = v; }, set lostReply(v) { lostReply = v; } };
}
await test('release gates native input before broker attach and confirms exact identity', async () => {
  const f = fixture(); assert.equal((await f.p.run('control.keeper', {}, f.ctx)).ok, true);
  assert.deepEqual(f.calls.slice(0, 2).map(c => c.kind === 'proxy' ? c.path : c.action), ['/gate?player=99', 'attach']);
  assert.equal(f.calls[1].fleet_state, f.ctx.stateFile); assert.equal(f.calls[1].pid, 42);
  await f.p.entries(f.ctx); assert.equal(f.ctx.keeperRegistered, true); assert.equal(f.ctx.control, 'keeper');
});
await test('failed attach rolls the gate back and reports failure', async () => {
  const f = fixture(); f.fail = 'old broker';
  assert.equal((await f.p.run('control.keeper', {}, f.ctx)).ok, false);
  assert.equal(f.found.session.gate, null); assert.equal(f.calls.at(-1).path, '/ungate?player=99');
});
await test('a lost attach response is reconciled without undoing a completed transfer', async () => {
  const f = fixture(); f.lostReply = true;
  assert.equal((await f.p.run('control.keeper', {}, f.ctx)).ok, true);
  assert.ok(f.found.session.gate); assert.equal(f.calls.some(c => c.path?.startsWith('/ungate')), false);
});
await test('reclaim stops the broker keeper and protects the pilot before opening input', async () => {
  const f = fixture(); await f.p.run('control.keeper', {}, f.ctx); f.calls.length = 0;
  assert.equal((await f.p.run('control.take', {}, f.ctx)).ok, true);
  assert.deepEqual(f.calls.map(c => c.kind === 'proxy' ? c.path : c.action), ['reclaim', '/ungate?player=99']);
  assert.equal(f.ctx.control, 'none');
});
await test('a failed reclaim keeps native input gated, and other holders cannot be stolen', async () => {
  const f = fixture(); await f.p.run('control.keeper', {}, f.ctx); f.fail = 'busy stopping';
  assert.equal((await f.p.run('control.take', {}, f.ctx)).ok, false); assert.ok(f.found.session.gate);
  f.found.session.gate.holder = 'somebody else';
  assert.equal((await f.p.run('control.take', {}, f.ctx)).ok, false);
});
await test('a gate alone does not enable watched-character FleetScripts', async () => {
  const f = fixture(); f.found.session.gate = { holder: 'keeper:t1' };
  await f.p.entries(f.ctx); assert.equal(f.ctx.keeperRegistered, false);
  f.status = { automated: true, attached: { client_pid: 666, player: 99, attach_port: 1002, gate_control: 1001 } };
  f.ctx.now++; await f.p.entries(f.ctx); assert.equal(f.ctx.keeperRegistered, false);
});
await test('live managed keepers renew the gate on the desk clock', async () => {
  const f = fixture(); await f.p.run('control.keeper', {}, f.ctx); f.calls.length = 0;
  await f.p.tick(f.ctx); assert.equal(f.calls.filter(c => c.kind === 'proxy').length, 0);
  f.ctx.now += 30001; await f.p.tick(f.ctx);
  assert.equal(f.calls.filter(c => c.kind === 'proxy').length, 1);
});
await test('missing keepers give controls back after the bounded grace', async () => {
  const f = fixture(); f.found.session.gate = { holder: 'keeper:t1' };
  await f.p.tick(f.ctx); assert.ok(f.found.session.gate);
  f.ctx.now += 20001; await f.p.tick(f.ctx); assert.equal(f.found.session.gate, null);
  assert.equal(f.ctx.desk.messages.length, 1);
});
await test('log toggle streams keeper output without mutating the disk log or sending game packets', async () => {
  const f = fixture(); writeFileSync(file, 'earlier\n');
  await f.p.run('control.logs', { enabled: 'true' }, f.ctx);
  appendFileSync(file, 'keeper moving\n'); await f.p.tick(f.ctx);
  assert.equal(f.ctx.desk.logs[0].text, 'keeper moving'); assert.equal(f.calls.length, 0);
  assert.equal(readFileSync(file, 'utf8'), 'earlier\nkeeper moving\n');
  await f.p.run('control.logs', { enabled: 'false' }, f.ctx); assert.deepEqual(f.ctx.desk.logs, []);
  f.ctx.client.capabilities = {}; assert.equal((await f.p.entries(f.ctx)).find(e => e.id === 'control.logs').disabled, true);
});
console.log(`\n${passed} passed`);
