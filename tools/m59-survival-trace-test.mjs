// Offline. Real keeper/helper/session entry points; no socket, roster or live orders.
import assert from 'node:assert/strict';
import { Autopilot } from './m59-autopilot.mjs';
import { Session } from './m59-game.mjs';
import { returnToSpot } from './m59-skills.mjs';
import { OF } from './m59-parse.mjs';
import { attachSurvivalTrace, traceSurvival, traceSurvivalOperation, tracePassContext,
  survivalTraceSnapshot, survivalTraceSummary, SURVIVAL_TRACE_LIMITS as limits } from './m59-survival-trace.mjs';

function fixture() {
  const health = { value: 43, max: 50 };
  const c = { state: 'game', selfId: 1, self: { id: 1, row: 8, col: 16, x: 1024, y: 512 },
    vitals: () => ({ health, vigor: { value: 90 } }), room: { objects: new Map() },
    stats() { assert.fail('telemetry must not request stats'); },
    roomContents() { assert.fail('telemetry must not request room contents'); } };
  const s = Object.assign(Object.create(Session.prototype), { name: null, client: c,
    lastHealth: 50, movementGeneration: 0, cancelledMovementTokens: new Set(),
    world: { room: { num: 39, name: 'Upstairs Castle Victoria' } },
    need: () => c, hitBook: () => null, standBeforeGo: async () => {} });
  const k = Object.assign(Object.create(Autopilot.prototype), { s, journal: [], passes: 9,
    passStage: 'passFleeAndRest', passStageAt: Date.now() - 20000,
    passStartedAt: Date.now() - 22000, policy: { fleeBelow: 0.45, blindWalkWatchdog: false },
    mode: 'farm', safety: () => ({ fleeAt: 0.68 }), recentText: () => [],
    claims: new Map([['movement', { owner: 'DUM', until: Date.now() + 60000 }]]) });
  attachSurvivalTrace(s, k);
  return { s, k, c, health };
}
let tests = 0;
async function test(name, run) { await run(); tests++; console.log('PASS ' + name); }

await test('frozen/no-movement spam cannot erase refuge evidence or issue reads', () => {
  const { s, k } = fixture();
  k.note('taking the next wall on the route and mending there', { to: { row: 51, col: 22 } });
  traceSurvival(s, 'refuge_selected', { selected: { kind: 'exit', row: 65, col: 19 } });
  for (let i = 0; i < 1000; i++) { k.note('frozen', { left_s: 90 }); k.note('! NOT MOVING'); }
  const record = k.postMortem();
  assert.equal(record.decisions.length, 14);
  assert.deepEqual(record.survival_trace.events[0].detail.detail.to, { row: 51, col: 22 });
  assert.equal(record.survival_trace.events[1].detail.selected.kind, 'exit');
  assert.equal(record.survival_trace.events.length, 2);
  assert.equal(record.survival_trace.current.policies.flee_at, 0.68);
  assert.equal(record.survival_trace.current.movement_claim.owner, 'DUM');
  assert.equal(record.survival_trace.current.busy, null, 'standing claim is not an active busy job');
});

await test('a cancelled fine approach stops; death preserves its cancellation evidence', async () => {
  const { s, k, c, health } = fixture();
  tracePassContext(s, { room: s.world.room, hp: 0.94, v: { health: { value: 47, max: 50 } } });
  c.room.objects.set(10, { id: 10, name: 'battered skeleton', flags: OF.ATTACKABLE, row: 8, col: 17 });
  const calls = [];
  s.approachFine = async () => {
    calls.push('fine'); s.cancelMovement('never-record-this-token', 'clear path watchdog');
    return { arrived: false, cancelled: true, reason: 'movement interrupted' };
  };
  s.walkTo = async () => assert.fail('cancelled survival approach restarted as a square walk');
  const result = await returnToSpot(s, { row: 8, col: 18 });
  health.value = 32;
  s.noteHealth({ value: 32, max: 50 });
  s.world.room = { num: 1, name: 'The Underworld' };
  c.room.objects.clear();
  const record = k.postMortem(), before = JSON.stringify(record);
  const trace = record.survival_trace;
  assert.deepEqual(calls, ['fine']);
  assert.equal(result.cancelled,true);
  assert.deepEqual(trace.active_operations, []);
  const cancel = trace.events.find(e => e.kind === 'movement_cancelled');
  assert.equal(cancel.detail.previous_generation, 0);
  assert.equal(cancel.detail.next_generation, 1);
  assert.equal(cancel.detail.token_present, true);
  assert.equal(trace.damage[0].context.room, 39, 'pushed hit retained before room cache changed');
  assert.equal(trace.damage[0].context.nearby.bodies[0].name, 'battered skeleton');
  assert.equal(trace.damage[0].context.pass_observation.health.value, 47);
  assert.equal(trace.damage[0].context.health.value, 32);
  assert.equal(trace.current.room, 1);
  assert.ok(!before.includes('never-record-this-token'));
  assert.equal(survivalTraceSummary(s).active, 0);
  assert.equal(JSON.stringify(record), before, 'late completion cannot change the death record');
});

await test('independent awaits have separate parents and preserve result/error identity', async () => {
  const { s } = fixture();
  let finish;
  const result = { arrived: true };
  const a = traceSurvivalOperation(s, 'a', {}, () => new Promise(r => { finish = r; }));
  const b = await traceSurvivalOperation(s, 'b', {}, () => result);
  assert.equal(b, result);
  const beginnings = survivalTraceSnapshot(s).events.filter(e => e.kind === 'operation_begin');
  assert.deepEqual(beginnings.map(e => e.detail.parent_id), [null, null]);
  finish(result); assert.equal(await a, result);
  const error = new Error('original error');
  await assert.rejects(traceSurvivalOperation(s, 'error', {}, () => { throw error; }), e => e === error);
  assert.equal(survivalTraceSummary(s).active, 0);
  // Broken cache must not suppress an action or change its result.
  s.client.vitals = () => { throw new Error('unavailable cache'); };
  assert.equal(await traceSurvivalOperation(s, 'cache failure', {}, () => result), result);
});

await test('bounded retention and distinct damage lane report omissions', () => {
  const { s } = fixture();
  traceSurvival(s, 'health_loss', { value: 20 }, { lane: 'damage' });
  for (let i = 0; i < limits.events + 7; i++) traceSurvival(s, 'event', { i });
  let trace = survivalTraceSnapshot(s);
  assert.equal(trace.events.length, limits.events); assert.equal(trace.dropped.events, 7);
  assert.equal(trace.damage.length, 1);
  for (let i = 0; i < 10; i++) traceSurvival(s, 'disabled', {}, { throttle_ms: 10000 });
  assert.equal(survivalTraceSummary(s).suppressed, 9);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + limits.age_ms + 10;
    trace = survivalTraceSnapshot(s);
    assert.equal(trace.events.length, 0); assert.equal(trace.damage.length, 0);
    assert.equal(trace.dropped.damage, 1);
  } finally { Date.now = realNow; }
});

await test('room snapshots are bounded, nearest first, explicit about incomplete scans', () => {
  const { s, c } = fixture();
  for (let i = 0; i < 2100; i++) c.room.objects.set(i + 100, { id: i + 100,
    flags: OF.ATTACKABLE, name: 'monster', row: 3000 - i, col: 16 });
  const nearby = survivalTraceSnapshot(s).current.nearby;
  assert.equal(nearby.objects_total, 2100);
  assert.equal(nearby.objects_scanned, limits.objects_scanned);
  assert.equal(nearby.bodies.length, limits.nearby);
  assert.equal(nearby.omitted_matching, limits.objects_scanned - limits.nearby);
  assert.equal(nearby.scan_truncated, true);
  assert.ok(nearby.bodies[0].row < nearby.bodies.at(-1).row);
});

await test('real refuge selector records its chosen exit and failed crossing', async () => {
  const { s, k } = fixture();
  k.policy.maxBotsPerSafeSpot = null;
  s.world.geometry = { rows: 80, cols: 80 };
  s.world.route = () => ({ found: true, hops: [{ to: 599 }] });
  k.onwardExit = () => null;
  k.searchSafeSpot = (_geo, _me, _room, options) => {
    options.stats.considered = 42;
    return { kind: 'exit', row: 65, col: 19, steps_away: 26 };
  };
  s.travel = async () => ({ arrived: false, why: 'body blocked' });
  assert.equal((await k.takeSafeSpot('recovery', null, { destination: 599 })).took, false);
  const trace = survivalTraceSnapshot(s);
  const selected = trace.events.find(e => e.kind === 'refuge_selected');
  assert.equal(selected.detail.selected.row, 65);
  assert.equal(selected.detail.search_counts.considered, 42);
  const cross = trace.events.find(e => e.kind === 'operation_end' && e.detail.kind === 'refuge_exit');
  assert.equal(cross.detail.result.why, 'body blocked');
  assert.equal(trace.active_operations.length, 0);
});
console.log(`${tests} survival trace scenarios passed`);
