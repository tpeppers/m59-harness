// Offline regression for the September 20–22 death audit. No sockets or roster.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.M59_LEDGER_DIR = mkdtempSync(join(tmpdir(), 'm59-survival-escalation-'));
const { Autopilot } = await import(process.env.M59_TEST_AUTOPILOT
  || './m59-autopilot.mjs');

function fixture() {
  const k = Object.create(Autopilot.prototype), calls = [];
  const self = { row: 8, col: 23 };
  k.s = {
    movementGeneration: 7,
    movementWasCancelled: g => g !== k.s.movementGeneration,
    client: { self, vitals: () => ({ health: { value: 6, max: 49 } }) },
    world: { room: { num: 39 } },
    enteredVia: { room: 39, from: 38, door: { row: 2, col: 19 } },
    retreatAlongBreadcrumbs: async opts => {
      calls.push(['crumbs', opts]); return { moved: false, reason: 'breadcrumb_trail_broken' };
    },
    walkTo: async (col, row, opts) => {
      calls.push(['entry', opts]); return { arrived: false, reason: 'object_blocked' };
    },
    travel: async (room, opts) => {
      calls.push(['previous', opts]); return { arrived: false, reason: 'object_blocked' };
    },
  };
  k.holdWorks = () => false;
  k.threat = () => ({ near: [], adjacent: [] });
  k.safety = () => ({ fleeAt: 0.7 });
  k.who = () => null;
  k.policy = {};
  k.tally = {};
  k.note = k.progress = () => {};
  k.wedgedInPlace = () => ({ why: 'blocked', for_ms: 10000 });
  return { k, calls, self };
}
const escape = k => k.backUpToUnstick('regression', { owner: 'survival' });
const seedThirdRung = k => { k.backUps = [1, 2].map(() => ({ room: 39, at: Date.now() })); };

test('failed survival retreats reach the entry and previous-room fallbacks', async () => {
  const { k, calls } = fixture();
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await escape(k));
  assert.deepEqual(results.map(r => r.rung), [1, 2, 3, 3]);
  assert.deepEqual(results.map(r => r.tried.map(t => t.rung)), [[1], [1, 2], [1, 2, 3], [1, 2, 3]]);
  assert.equal(k.backUps.length, 2, 'failed history is capped at the escalation limit');
  assert.ok(results.every(r => !r.freed));
  assert.ok(calls.every(([, opts]) => opts.movementGeneration === 7));
  const previous = calls.find(([name]) => name === 'previous')[1];
  assert.equal(previous.maxHops, 2);
  assert.equal(previous.maxStumbles, 2);
});

test('a working fallback returns control without walking out of the room', async () => {
  const { k, calls, self } = fixture();
  seedThirdRung(k);
  k.s.walkTo = async (col, row) => { calls.push(['entry']); self.col = col; self.row = row; return { arrived: true }; };
  const out = await escape(k);
  assert.equal(out.rung, 3);
  assert.equal(out.freed, true);
  assert.equal(calls.filter(([name]) => name === 'previous').length, 0);
  assert.equal(k.backUps.filter(b => b.failed).length, 0);
});

test('a successful breadcrumb retreat never falls through to an exit', async () => {
  const { k, calls, self } = fixture();
  seedThirdRung(k);
  k.s.retreatAlongBreadcrumbs = async () => { self.col -= 3; return { steps: 3 }; };
  calls.length = 0;
  assert.equal((await escape(k)).freed, true);
  assert.deepEqual(calls, []);
});

test('failed survival history cannot escalate ordinary movement', async () => {
  const { k } = fixture();
  await escape(k); await escape(k);
  assert.equal(k.stuckRung(k.wedgePlace()), 1);
  assert.equal(k.stuckRung(k.wedgePlace(), { owner: 'survival' }), 3);
  k.s.client.vitals = () => ({ health: { value: 49, max: 49 } });
  assert.equal((await k.backUpToUnstick('healthy movement')).rung, 1);
});

test('leaving the pocket or expiring the history resets failed escalation', async () => {
  const { k, self } = fixture();
  await escape(k); self.col += 20;
  assert.equal((await escape(k)).rung, 1);
  k.backUps.forEach(b => b.at -= 11 * 60_000);
  assert.equal((await escape(k)).rung, 1);
  k.s.world.room.num = 38;
  assert.equal((await escape(k)).rung, 1);
});

test('cancellation after breadcrumbs cannot resume with a fresh generation', async () => {
  const { k, calls } = fixture();
  seedThirdRung(k); calls.length = 0;
  k.s.retreatAlongBreadcrumbs = async () => { k.s.movementGeneration++; return { cancelled: true }; };
  const history = JSON.stringify(k.backUps);
  const out = await escape(k);
  assert.equal(out.cancelled, true);
  assert.deepEqual(calls, []);
  assert.equal(JSON.stringify(k.backUps), history);
});

test('cancellation after entry cannot start a previous-room journey', async () => {
  const { k, calls } = fixture();
  seedThirdRung(k); calls.length = 0;
  k.s.walkTo = async () => { k.s.movementGeneration++; return { cancelled: true }; };
  assert.equal((await escape(k)).cancelled, true);
  assert.equal(calls.filter(([name]) => name === 'previous').length, 0);
});

test('a new safe-wall hold stops the remaining fallbacks', async () => {
  const { k, calls } = fixture();
  seedThirdRung(k); calls.length = 0;
  k.s.retreatAlongBreadcrumbs = async () => { k.hold = { room: 39 }; return {}; };
  await escape(k);
  assert.deepEqual(calls, []);
});

test('missing entry memory never invents a return destination', async () => {
  const { k, calls } = fixture(); k.s.enteredVia = null;
  for (let i = 0; i < 4; i++) await escape(k);
  assert.ok(calls.every(([name]) => name === 'crumbs'));
});

test('survival cancellation handles the pass without a trade or an escape tally', async () => {
  const { k } = fixture();
  k.backUpToUnstick = async () => ({ cancelled: true, freed: false });
  assert.equal(await k.escapeIfWedgedAndHurt({ near: [{}], v: k.s.client.vitals() }), true);
  assert.equal(k.tally.wedge_escapes, undefined);
});

test('ordinary movement remains refused while hurt', async () => {
  const { k, calls } = fixture();
  assert.equal((await k.backUpToUnstick('ordinary')).attempted, false);
  assert.deepEqual(calls, []);
});

for (const reason of ['disabled', 'healthy', 'wall', 'no-nearby', 'not-wedged']) {
  test(`escape eligibility stays unchanged: ${reason}`, async () => {
    const { k, calls } = fixture(); let near = [{}], v = k.s.client.vitals();
    if (reason === 'disabled') k.policy.backUpWhenWedged = false;
    if (reason === 'healthy') v = { health: { value: 49, max: 49 } };
    if (reason === 'wall') k.holdWorks = () => true;
    if (reason === 'no-nearby') near = [];
    if (reason === 'not-wedged') k.wedgedInPlace = () => null;
    assert.equal(await k.escapeIfWedgedAndHurt({ near, v }), false);
    assert.deepEqual(calls, []);
  });
}


test('terminal geometry failures neither retry another mover nor advance history', async () => {
  const { k, calls } = fixture(); seedThirdRung(k);
  k.s.retreatAlongBreadcrumbs = async () => ({ reason: 'collision_geometry_unavailable' });
  const before = JSON.stringify(k.backUps);
  const out = await escape(k);
  assert.equal(out.terminal_reason, 'collision_geometry_unavailable');
  assert.deepEqual(calls, []);
  assert.equal(JSON.stringify(k.backUps), before);
});
