// Offline guard for tools/runtime/pending-successors.mjs: a keeper staged on the new code for a
// character a person is playing waits, inert, and takes over as a handoff only once they let go.
//
//   node tools/runtime/pending-successors-test.mjs
//
// The incident: 2026-11-02, `restart-keepers --fleet prod` skipped Gonzo (t18) without a line while
// the operator played him; when they let go the SAME old keeper resumed him on the old code. Every
// case below drives the real module against fake hands that record what they were asked to do, so
// "never acts while a person holds the body" is a statement about the calls actually made. Opens no
// socket, spawns nothing, touches no roster.
import assert from 'node:assert/strict';
import {
  PendingSuccessors, pilotedRestartPlan, pendingVerdict, pendingMaxWaitMs,
  DEFAULT_PENDING_MAX_WAIT_MS, PENDING_ENV, PENDING_MAX_WAIT_ENV,
} from './pending-successors.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };

// Everything that would reach a process, a port or the server. `held` is the person at the controls.
function fakeWorld({ held = true, alive = true, old = { pid: 100, port: 9511, identity: { agent: 't18', pid: 100 },
                     live: { connected: false, in_game: false, cooperative_wait: false } },
                     dormancy = null, fence = true, ready = true, onFence = null, now = 1_000_000 } = {}) {
  const w = { held, alive, old, dormancy, fence, ready, calls: [], marks: [], records: [], clock: now };
  const call = (name, ...a) => { w.calls.push(name); return a; };
  w.fx = {
    occupied: () => w.held,
    successorAlive: () => w.alive,
    oldKeeper: async () => { call('oldKeeper'); return w.old; },
    dormancy: () => w.dormancy,
    clearDormancy: () => { call('clearDormancy'); w.dormancy = null; },
    fenceOld: async () => { call('fenceOld'); onFence?.(w); return w.fence; },
    unfenceOld: async () => { call('unfenceOld'); return true; },
    wake: async () => { call('wake'); return { ok: true }; },
    sleep: async () => { call('sleep'); return true; },
    waitReady: async (rec, { dormant }) => { call(dormant ? 'waitReadyDormant' : 'waitReady'); return w.ready; },
    swap: async () => { call('swap'); },
    stopOld: async () => { call('stopOld'); return true; },
    stopSuccessor: async () => { call('stopSuccessor'); },
    mark: (agent, on) => { w.marks.push(on); },
    record: (agent, what, detail) => { w.records.push({ what, ...detail }); },
  };
  w.book = new PendingSuccessors({ fx: w.fx, now: () => w.clock });
  w.stage = (extra = {}) => w.book.stage('t18', { pid: 200, port: 9530, startedAt: w.clock,
    deadline: w.clock + 60 * 60_000, old_pid: 100, ...extra });
  return w;
}
// The calls that reach a process or the server. Asking `oldKeeper` is a read, and is allowed.
const ACTS = ['clearDormancy', 'fenceOld', 'unfenceOld', 'wake', 'sleep', 'swap', 'stopOld', 'stopSuccessor'];
const acted = w => w.calls.filter(c => ACTS.includes(c));

// ------------------------------------------------------------------ what a restart does with one

await ok('plan: a character nobody holds is handed off exactly as before', () => {
  for (const connected of [true, false, null])
    assert.equal(pilotedRestartPlan({ occupied: false, dormant: false, connected }).action, 'handoff');
});

await ok('plan: a piloted character whose keeper is out of the world is replaced dormant now (2026-10-07)', () => {
  assert.equal(pilotedRestartPlan({ occupied: true, connected: false }).action, 'dormant_swap');
  assert.equal(pilotedRestartPlan({ occupied: true, connected: false, defer: false }).action, 'dormant_swap');
});

await ok('plan: where a swap would bump the person, a successor is DEFERRED, not skipped', () => {
  const through = pilotedRestartPlan({ occupied: true, connected: true });
  assert.equal(through.action, 'defer');
  assert.match(through.why, /proxied client/);
  assert.match(through.why, /successor waits for them to log off/);
  assert.equal(pilotedRestartPlan({ occupied: true, connected: null }).action, 'defer', 'an old keeper that will not say');
});

await ok('plan: defer off restores the old refusal, word for word in substance', () => {
  const r = pilotedRestartPlan({ occupied: true, connected: true, defer: false });
  assert.equal(r.action, 'refuse');
  assert.match(r.why, /being played by a person through this keeper's own connection/);
  assert.equal(pilotedRestartPlan({ occupied: true, connected: null, defer: false }).action, 'refuse');
});

await ok('plan: --skip-piloted leaves every occupied character alone, whatever its keeper says', () => {
  for (const connected of [true, false, null])
    assert.equal(pilotedRestartPlan({ occupied: true, connected, skip: true }).action, 'skip');
  assert.equal(pilotedRestartPlan({ occupied: false, connected: true, skip: true }).action, 'handoff', 'skip is about pilots only');
});

await ok('plan: a dormancy hold with nobody at the controls is never deferred (there is nobody to wait for)', () => {
  assert.equal(pilotedRestartPlan({ dormant: true, connected: false }).action, 'dormant_swap');
  assert.equal(pilotedRestartPlan({ dormant: true, connected: true }).action, 'refuse');
  assert.equal(pilotedRestartPlan({ dormant: true, connected: null }).action, 'refuse');
});

await ok('max wait: 12 h by default; the caller, then the environment; garbage is reported, not applied', () => {
  assert.equal(DEFAULT_PENDING_MAX_WAIT_MS, 12 * 3600_000);
  assert.deepEqual(pendingMaxWaitMs({ env: {} }), { ms: DEFAULT_PENDING_MAX_WAIT_MS, source: 'default', warnings: [] });
  assert.equal(pendingMaxWaitMs({ minutes: 90, env: { [PENDING_MAX_WAIT_ENV]: '30' } }).ms, 90 * 60_000);
  assert.equal(pendingMaxWaitMs({ env: { [PENDING_MAX_WAIT_ENV]: '30' } }).source, PENDING_MAX_WAIT_ENV);
  const bad = pendingMaxWaitMs({ minutes: -5, env: { [PENDING_MAX_WAIT_ENV]: 'soon' } });
  assert.equal(bad.ms, DEFAULT_PENDING_MAX_WAIT_MS);
  assert.equal(bad.warnings.length, 2, 'each unusable value is named');
  assert.equal(PENDING_ENV, 'M59_KEEPER_PENDING_SUCCESSOR');
});

await ok('verdict: wait while held, give up past the deadline, activate when free, never twice at once', () => {
  const rec = { startedAt: 0, deadline: 1000 };
  assert.equal(pendingVerdict(rec, { now: 500, occupied: true }).action, 'wait');
  const late = pendingVerdict(rec, { now: 1000, occupied: true });
  assert.equal(late.action, 'teardown');
  assert.match(late.why, /max wait/);
  assert.equal(pendingVerdict(rec, { now: 5000, occupied: false }).action, 'activate', 'a person gone after the deadline still hands over');
  assert.equal(pendingVerdict(rec, { now: 5, occupied: true, successorAlive: false }).action, 'teardown');
  assert.equal(pendingVerdict({ ...rec, activating: true }, { occupied: false }).action, 'busy');
});

// ------------------------------------------------------------------ the take-over, against fake hands

await ok('NEVER WHILE HELD: a hundred ticks with a person at the controls send nothing to anybody', async () => {
  const w = fakeWorld({ held: true });
  w.stage();
  for (let i = 0; i < 100; i++) { w.clock += 5000; await w.book.tick(); }
  assert.deepEqual(acted(w), [], 'no fence, wake, sleep, swap or stop');
  assert.ok(w.book.has('t18'), 'still waiting');
  assert.deepEqual(w.records.map(r => r.what), ['staged']);
  const listed = w.book.list(w.clock)[0];
  assert.equal(listed.agent, 't18');
  assert.equal(listed.occupied, true);
  assert.equal(listed.waiting_ms, 100 * 5000);
  assert.ok(!('child' in listed), 'the list carries no process handle');
});

await ok('the person lets go: fence the old keeper, wake the successor, see it in the world, swap, stop the old one', async () => {
  const w = fakeWorld({ held: true });
  w.stage();
  await w.book.tick();
  w.held = false;
  const [r] = await w.book.tick();
  assert.equal(r.ok, true);
  assert.equal(r.pid, 200);
  assert.equal(r.old_pid, 100);
  assert.deepEqual(w.calls.filter(c => c !== 'oldKeeper'), ['fenceOld', 'wake', 'waitReady', 'swap', 'stopOld'],
                   'the handoff order: nothing logs in before the fence, nothing swaps before the world says so');
  assert.ok(!w.book.has('t18'), 'no longer pending');
  assert.deepEqual(w.marks, [true, false], 'the sweep is stepped over for the whole take-over, and released');
  assert.deepEqual(w.records.map(r => r.what), ['staged', 'activated']);
});

await ok('played THROUGH the keeper (connected): the same order, and the old keeper is dropped by the login', async () => {
  const w = fakeWorld({ held: false, old: { pid: 100, port: 9511, identity: {}, live: { connected: true, in_game: true } } });
  w.stage();
  const r = await w.book.activate('t18');
  assert.equal(r.ok, true);
  assert.ok(w.calls.indexOf('fenceOld') < w.calls.indexOf('wake'));
});

await ok('a person who comes back between the fence and the login keeps the body; the fence is withdrawn', async () => {
  const w = fakeWorld({ held: false, onFence: world => { world.held = true; } });
  w.stage();
  const r = await w.book.activate('t18');
  assert.equal(r.ok, false);
  assert.equal(r.waiting, true);
  assert.deepEqual(acted(w), ['fenceOld', 'unfenceOld'], 'no wake: the successor never logs in over them');
  assert.ok(w.book.has('t18'), 'and it goes on waiting');
  assert.equal(w.book.get('t18').activating, false);
});

await ok('a successor that does not reach the world is stopped and forgotten; the old keeper carries on', async () => {
  const w = fakeWorld({ held: false, ready: false });
  w.stage();
  const r = await w.book.activate('t18');
  assert.equal(r.ok, false);
  assert.equal(r.torn_down, true);
  assert.deepEqual(acted(w), ['fenceOld', 'wake', 'stopSuccessor', 'unfenceOld'], 'no swap and no stop of the old keeper');
  assert.ok(!w.book.has('t18'), 'ONE attempt: the sweep, not a retry loop, brings the old keeper back');
  assert.match(w.records.at(-1).why, /old keeper carries on/);
});

await ok('an old keeper that is alive and will not take the fence is never logged in over', async () => {
  const w = fakeWorld({ held: false, fence: false });
  w.stage();
  const r = await w.book.activate('t18');
  assert.equal(r.torn_down, true);
  assert.ok(!w.calls.includes('wake'));
  assert.ok(!w.calls.includes('swap'));
});

await ok('no old keeper at all: the successor logs in and nothing is stopped but nothing needs to be', async () => {
  const w = fakeWorld({ held: false, old: null });
  w.stage();
  const r = await w.book.activate('t18');
  assert.equal(r.ok, true);
  assert.deepEqual(acted(w), ['wake', 'swap']);
});

await ok('an old keeper in a cooperative logoff wait is waited for, not raced', async () => {
  const w = fakeWorld({ held: false, old: { pid: 100, port: 1, identity: {}, live: { connected: false, cooperative_wait: true } } });
  w.stage();
  const r = await w.book.activate('t18');
  assert.equal(r.waiting, true);
  assert.deepEqual(acted(w), []);
});

await ok('A RECORD THAT SAYS OUT STAYS OUT: an operator hold makes the take-over a dormant one, with no login', async () => {
  const w = fakeWorld({ held: false, dormancy: { record: { reason: 'operator', wake: 'manual' }, stayOut: true } });
  w.stage();
  const r = await w.book.activate('t18');
  assert.equal(r.ok, true);
  assert.equal(r.dormant, true);
  assert.deepEqual(acted(w), ['sleep', 'swap', 'stopOld'], 'no fence is needed and nothing logs in');
  assert.ok(w.calls.includes('waitReadyDormant'));
});

await ok('a hold that ends with the person (pilot_released) is cleared before the login, never after', async () => {
  const w = fakeWorld({ held: false, dormancy: { record: { reason: 'pilot', wake: 'pilot_released' }, stayOut: false } });
  w.stage();
  await w.book.activate('t18');
  assert.ok(w.calls.indexOf('clearDormancy') < w.calls.indexOf('wake'));
  assert.ok(w.calls.indexOf('fenceOld') < w.calls.indexOf('clearDormancy'));
});

await ok('MAX WAIT: a person who never logs off keeps their session; the successor is stopped with the reason', async () => {
  const w = fakeWorld({ held: true });
  w.stage({ deadline: w.clock + 30 * 60_000 });
  w.clock += 29 * 60_000;
  await w.book.tick();
  assert.ok(w.book.has('t18'));
  w.clock += 60_000;
  const [r] = await w.book.tick();
  assert.equal(r.torn_down, true);
  assert.deepEqual(acted(w), ['stopSuccessor'], 'nothing reaches the old keeper or the server');
  assert.ok(!w.book.has('t18'));
  assert.match(w.records.at(-1).why, /max wait/);
  assert.equal(w.records.at(-1).what, 'torn_down');
});

await ok('a successor that died on its own is forgotten, and named', async () => {
  const w = fakeWorld({ held: true });
  w.stage();
  w.alive = false;
  const [r] = await w.book.tick();
  assert.equal(r.torn_down, true);
  assert.match(r.why, /no longer running/);
});

await ok('a take-over in flight cannot be torn down or started twice', async () => {
  let release;
  const w = fakeWorld({ held: false });
  w.fx.waitReady = () => new Promise(res => { release = res; });
  w.stage();
  const first = w.book.activate('t18');
  await new Promise(r => setImmediate(r));
  assert.equal(w.book.activating('t18'), true);
  assert.equal((await w.book.activate('t18')).why, 'already taking over');
  assert.equal((await w.book.teardown('t18', 'x')).ok, false);
  assert.deepEqual(await w.book.tick(), [], 'busy, not re-decided');
  release(true);
  assert.equal((await first).ok, true);
});

await ok('one successor per character; a second stage must tear the first down (a newer deploy replaces it)', async () => {
  const w = fakeWorld();
  w.stage();
  assert.throws(() => w.stage(), /already registered/);
  await w.book.teardown('t18', 'superseded by a newer restart-keepers');
  w.stage({ pid: 201 });
  assert.equal(w.book.get('t18').pid, 201);
  assert.deepEqual(w.book.ports(), [9530]);
});

await ok('a live broker handover carries the book by pid and port, with no process handle', async () => {
  const w = fakeWorld();
  w.stage({ child: { pid: 200 } });
  const rows = w.book.exportSnapshot();
  assert.deepEqual(Object.keys(rows[0]).sort(), ['agent', 'by', 'deadline', 'old_pid', 'pid', 'port', 'reason', 'startedAt']);
  const next = fakeWorld();
  assert.equal(next.book.importSnapshot(structuredClone(rows)), 1);
  assert.equal(next.book.get('t18').child, null);
  assert.equal(next.book.get('t18').adopted, true);
  assert.equal(next.book.importSnapshot(rows), 0, 'an entry it already holds is not overwritten');
  assert.equal(next.book.importSnapshot([{ agent: 'x' }]), 0, 'a row without a pid is refused');
});

await ok('teardownAll (broker shutdown) stops every successor and nothing else', async () => {
  const w = fakeWorld();
  w.stage();
  w.book.stage('t20', { pid: 300, port: 9531, startedAt: w.clock, deadline: w.clock + 1 });
  const r = await w.book.teardownAll('broker shutdown');
  assert.equal(r.length, 2);
  assert.deepEqual(acted(w), ['stopSuccessor', 'stopSuccessor']);
  assert.equal(w.book.size, 0);
});

console.log(`\nm59 pending-successors-test: ${n} passed`);
