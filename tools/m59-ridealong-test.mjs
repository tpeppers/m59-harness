// Offline control-transfer regression: no game login, broker, or live fleet is used.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { RidealongControls, ridealongRequest, verifyRidealongProxy, ridealongSession } from './m59-ridealong.mjs';
import { disconnectKeeperClient } from './m59-keeper-disconnect.mjs';
import { M59Client } from './m59-client.mjs';
let count = 0;
const test = async (label, fn) => { await fn(); console.log(`ok ${++count} ${label}`); };
const stateFile = resolve('substrate', 'fleets', 'fixture-ridealong.json');
const args = { agent: 't7', pid: 123, fleet_state: stateFile, player: 456, attach_port: 8932, gate_control: 8931 };
const want = ridealongRequest(args, stateFile);
const credentials = { account: 'fixture', character: 'Fixture Seven', host: '127.0.0.1', port: 5959 };
const proxy = () => ({ pid: 789, attach_port: 8932, gate_control: 8931,
  server: { host: 'localhost', port: 5959 }, sessions: [{ player_id: 456, in_game: true,
    gate: { holder: 'keeper:t7' }, attached: null }] });
function fixture() {
  const events = [];
  let pilot = { pid: 123, keeperWasRunning: true }, keeper = { pid: 99 }, failStop = false;
  let startOk = true, ready = true, alive = true, status = proxy();
  const controls = new RidealongControls({ stateFile,
    credentials: agent => agent === 't7' ? credentials : null,
    pilot: () => pilot, keeper: () => keeper, pidAlive: () => alive,
    proxyStatus: async () => status, logPath: agent => resolve('substrate', `keeper-${agent}.log`),
    claim: (agent, pid, options) => { events.push('claim'); pilot = { pid, ...options }; },
    unclaim: (agent, expected) => { assert.equal(pilot, expected); events.push('unclaim'); pilot = null; },
    stop: async () => { events.push('stop'); if (failStop) return false; keeper = null; return true; },
    start: async () => { events.push('start'); if (startOk) keeper = { pid: 100 }; return startOk; },
    ready: async () => { events.push('ready'); return ready; },
  });
  return { controls, events, pilot: () => pilot,
    set: patch => { if ('pilot' in patch) pilot = patch.pilot; if ('failStop' in patch) failStop = patch.failStop;
      if ('startOk' in patch) startOk = patch.startOk; if ('ready' in patch) ready = patch.ready;
      if ('alive' in patch) alive = patch.alive; if ('status' in patch) status = patch.status; } };
}

await test('exact absolute roster is required even for an otherwise valid request', () => {
  assert.throws(() => ridealongRequest({ ...args, fleet_state: resolve('another-fleet.json') }, stateFile), /exact absolute/);
  assert.throws(() => ridealongRequest({ ...args, fleet_state: 'fixture-ridealong.json' }, stateFile), /exact absolute/);
  assert.throws(() => ridealongRequest({ ...args, agent: '../t7' }, stateFile), /exact fleet agent/);
  for (const key of ['pid', 'player', 'attach_port', 'gate_control'])
    assert.throws(() => ridealongRequest({ ...args, [key]: -1 }, stateFile), /positive integer/);
});
await test('proxy must prove both ports, player, keeper gate and roster server', () => {
  assert.equal(verifyRidealongProxy(want, proxy(), credentials).player_id, 456);
  for (const status of [{ ...proxy(), attach_port: 1 }, { ...proxy(), gate_control: 1 },
      { ...proxy(), server: { host: 'elsewhere', port: 5959 } },
      { ...proxy(), server: { host: 'localhost', port: 5960 } }, { ...proxy(), sessions: [] }])
    assert.throws(() => verifyRidealongProxy(want, status, credentials));
  const s = proxy(); s.sessions[0].gate.holder = 'keeper:t8';
  assert.throws(() => verifyRidealongProxy(want, s, credentials), /not held by this keeper/);
  s.sessions[0].gate.holder = 'keeper:t7'; s.sessions[0].attached = { agent: 't8' };
  assert.throws(() => verifyRidealongProxy(want, s, credentials), /another keeper/);
});
await test('release registers the full keeper before removing the human pilot claim', async () => {
  const f = fixture(), result = await f.controls.attach(args);
  assert.equal(result.ok, true); assert.equal(result.automated, true); assert.equal(result.piloted, false);
  assert.deepEqual(f.events, ['stop', 'start', 'ready', 'unclaim']);
  assert.equal(result.attached.pid, 100); assert.equal(result.attached.client_pid, 123);
  assert.match(result.attached.log_path, /keeper-t7\.log$/);
});
await test('a second release is idempotent and does not restart working automation', async () => {
  const f = fixture(); await f.controls.attach(args); f.events.length = 0;
  assert.equal((await f.controls.attach(args)).ok, true);
  assert.deepEqual(f.events, ['ready']);
});
await test('reclaim establishes pilot protection BEFORE dropping the shared keeper', async () => {
  const f = fixture(); await f.controls.attach(args); f.events.length = 0;
  const r = await f.controls.reclaim(args);
  assert.equal(r.ok, true); assert.equal(r.reclaimed, true); assert.equal(r.automated, false);
  assert.equal(r.attached, null); assert.deepEqual(f.events, ['claim', 'stop']);
  assert.equal(f.pilot().pid, 123); assert.equal(f.pilot().keeperWasRunning, true);
});
await test('reclaim still works after the native gate has expired', async () => {
  const f = fixture(); await f.controls.attach(args); const s = proxy(); s.sessions[0].gate = null; f.set({ status: s });
  assert.equal((await f.controls.reclaim(args)).ok, true);
});
await test('different client PID or player cannot reclaim a released connection', async () => {
  const f = fixture(); await f.controls.attach(args); f.events.length = 0;
  for (const change of [{ pid: 987 }, { player: 555 }, { attach_port: 9999 }])
    assert.equal((await f.controls.reclaim({ ...args, ...change })).ok, false);
  assert.deepEqual(f.events, []); assert.equal(f.controls.status('t7').automated, true);
});
await test('a stopped keeper stays stopped when the client is reclaimed later', async () => {
  const f = fixture(); f.set({ pilot: { pid: 123, keeperWasRunning: false } });
  await f.controls.attach(args); await f.controls.reclaim(args);
  assert.equal(f.pilot().keeperWasRunning, false);
});
await test('unknown agent, dead client and mismatched local pilot are refused before any stop', async () => {
  for (const patch of [{ alive: false }, { pilot: null }, { pilot: { pid: 44 } },
      { pilot: { pid: null, lease: { id: 'remote' } } }]) {
    const f = fixture(); f.set(patch);
    assert.equal((await f.controls.attach(args)).ok, false); assert.deepEqual(f.events, []);
  }
  const f = fixture(); assert.equal((await f.controls.attach({ ...args, agent: 'absent' })).ok, false);
  assert.deepEqual(f.events, []);
});
await test('failed startup preserves the existing human claim and removes the attachment', async () => {
  const f = fixture(); f.set({ startOk: false });
  const r = await f.controls.attach(args);
  assert.equal(r.ok, false); assert.equal(r.piloted, true); assert.equal(r.attached, null);
  assert.deepEqual(f.events, ['stop', 'start', 'stop']); assert.equal(f.pilot().pid, 123);
});
await test('unconfirmed attachment is stopped without ever claiming automation', async () => {
  const f = fixture(); f.set({ ready: false });
  const r = await f.controls.attach(args);
  assert.equal(r.ok, false); assert.equal(r.piloted, true); assert.equal(r.automated, false);
  assert.deepEqual(f.events, ['stop', 'start', 'ready', 'stop']);
});
await test('an old keeper refusing stop prevents an overlapping attached process', async () => {
  const f = fixture(); f.set({ failStop: true });
  assert.equal((await f.controls.attach(args)).ok, false); assert.deepEqual(f.events, ['stop']);
});
await test('failed reclaim retains pilot protection and its attachment barrier', async () => {
  const f = fixture(); await f.controls.attach(args); f.events.length = 0; f.set({ failStop: true });
  const r = await f.controls.reclaim(args);
  assert.equal(r.ok, false); assert.equal(r.piloted, true); assert.equal(r.automated, false);
  assert.ok(r.attached); assert.deepEqual(f.events, ['claim', 'stop']);
});
await test('gate-loss suspension follows the same protected reclaim order', async () => {
  const f = fixture(); await f.controls.attach(args); f.events.length = 0;
  assert.equal(await f.controls.suspend('t7', 'gate expired'), true);
  assert.deepEqual(f.events, ['claim', 'stop']); assert.equal(f.controls.status('t7').attached, null);
});
await test('native exit suspension never installs a claim on a dead PID', async () => {
  const f = fixture(); await f.controls.attach(args); f.events.length = 0; f.set({ alive: false });
  assert.equal(await f.controls.suspend('t7', 'client gone'), true);
  assert.deepEqual(f.events, ['stop']); assert.equal(f.controls.status('t7').attached, null);
});
await test('concurrent ownership transfers are rejected before touching keeper state', async () => {
  const f = fixture(); f.controls.transitions.add('t7');
  assert.equal((await f.controls.attach(args)).ok, false);
  assert.equal((await f.controls.reclaim(args)).ok, false); assert.deepEqual(f.events, []);
});
await test('keeper readiness is required; a remembered PID alone never reports automation', async () => {
  const f = fixture(); await f.controls.attach(args);
  f.controls.records.get('t7').keeper_ready = false;
  assert.equal(f.controls.status('t7').automated, false);
  assert.equal(f.controls.status('t7').keeper_ready, false);
  f.controls.records.get('t7').keeper_ready = true;
  assert.equal(f.controls.status('t7').automated, true);
});
await test('save renumber follows the stable attachment while the old numeric ID is stale', () => {
  const status = proxy();
  status.sessions[0].player_id = 999;
  status.sessions[0].attached = { agent: 't7' };
  status.sessions.push({ player_id: 456, attached: null });
  assert.equal(ridealongSession(want, status).player_id, 999);
  assert.equal(ridealongSession(want, { sessions: [] }), null);
});
await test('actual M59Client close logs off; keeper shutdown detaches with no BP_REQ_QUIT', async () => {
  const make = () => {
    const writes = [];
    const client = Object.assign(Object.create(M59Client.prototype), {
      state: 'game', attach: { agent: 't7', port: 8932, player: 456 }, keepaliveTimer: null,
      sock: { destroyed: false, write: (bytes, done) => { writes.push(Buffer.from(bytes)); done?.(); },
        destroy() { this.destroyed = true; } },
    });
    return { client, writes };
  };
  const survival = make(); survival.client.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(survival.writes[0]?.[7], 54, 'the real attached close asks the proxy to quit');
  const reclaimed = make(); disconnectKeeperClient(reclaimed.client);
  assert.deepEqual(reclaimed.writes, [], 'control-transfer shutdown emits no game packet');
  assert.equal(reclaimed.client.sock.destroyed, true);
  let ordinaryClosed = false;
  disconnectKeeperClient({ close: () => { ordinaryClosed = true; } });
  assert.equal(ordinaryClosed, true, 'ordinary keeper shutdown still closes its game connection');
});
await test('broker spawns attached keepers, excludes native auto-claim, and guards reconnects', () => {
  const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  const keeper = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  assert.match(broker, /M59_KEEPER_ATTACH: ridealong\.records\.has\(agent\)/);
  assert.match(broker, /if \(ridealong\.records\.has\(hit\.agent\)\) return/);
  assert.match(broker, /recoverRidealong\(c\.agent, c\.pid/);
  assert.match(broker, /maintainRidealongs\(\)\.then/);
  assert.match(keeper, /refused malformed attachment/);
  assert.equal((keeper.match(/ridealong: attachmentView\(\)/g) ?? []).length, 2);
  assert.match(keeper, /attached proxy player does not match the roster character/);
  assert.equal((keeper.match(/disconnectKeeperClient\(session\.client\)/g) ?? []).length, 2,
    '/stop and SIGTERM both detach attached clients without logoff');
  assert.match(broker, /put\('ridealong', ridealong\.records\)/);
  assert.match(broker, /refill\(ridealong\.records, s\.ridealong\)/);
  assert.match(broker, /ridealong\.transitions\.size === 0/);
  assert.match(broker, /M59_PLAN_BROKER_PORT: String\(argv\.includes\('--http'\)/);
});
console.log(`${count} ridealong tests passed`);
