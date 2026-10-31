#!/usr/bin/env node
// A JOURNEY THAT THREW STILL LEAVES A REASON. Offline: no socket, no broker, no roster; every
// ledger and incident write goes to a scratch directory.
//
//   node tools/m59-travel-threw-test.mjs
//
// THE INCIDENT, prod 2026-10-27..31. The largest class of "stuck" in the movement-incident log was
// `kind: not_arrived` with `reason: null` -- 455 counting repeats, mostly survival_exit, caster_exit
// and hunt_relocation journeys whose bodies walked to the exit square and never changed room.
// `Autopilot.travel` wrote the ledger row and the incident in a `finally` with no `catch`: when
// `Session.travel` THREW, `outcome` was still null there, and the exception went on to callers
// that keep it only in the 200-entry in-memory journal. These cases pin that a throw now becomes
// `reason: "travel_threw: <message> @ <frame>"` on both records, and still propagates unchanged.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'm59-travelthrew-'));
process.env.M59_LEDGER_DIR = SCRATCH;

const I = await import('./m59-movement-incidents.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const { travelThrewOutcome } = await import('./m59-trip-telemetry.mjs');

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e?.stack ?? e).toString().split('\n').slice(0, 4).join('\n       ')); }
};

// The stand-in keeper m59-move-origin-test uses: Autopilot.travel lifted onto the fields it reads.
const fakeKeeper = ({ travel, ledger, name }) => {
  const s = {
    name, movementGeneration: 0, lastMovementCancel: null,
    world: { room: { num: 2142, name: 'Territory of the Noble Avars' },
             route: () => ({ found: true, hops: [{ from: 2142, to: 2143, to_name: 'south' }] }) },
    client: { self: { row: 29, col: 1, x: 96, y: 1904 }, me: { name: 'Sweetums' }, selfId: 1,
              room: { objects: new Map() }, rsc: { get: () => null },
              vitals: () => ({ health: { value: 100, max: 119 }, vigor: { value: 150 } }) },
    movementWasCancelled: () => false,
    travel,
  };
  return {
    name, policy: {}, doing: 'resting', s,
    watch: { pulses: [{ at: 1, room: 2142, row: 30, col: 2, x: 160, y: 1952, health: 100 }] },
    goTravelling: () => {}, revive: () => {}, answerWedge: async () => null,
    restBeforeSettingOut: async () => ({ rested: false }), travelHoldMode: () => 'on',
    travelGuard: Autopilot.prototype.travelGuard,
    recordFrame: () => {}, hitDamageTotal: () => 0, pvpReturnGate: () => null,
    travelInterrupted: () => false, eatBeforeTravel: async () => {},
    ledgerEvent: (kind, row) => ledger.push({ kind, ...row }), detailEvent: () => {},
    travelHold: async () => {}, recordTravelShelterStop: () => {},
  };
};

// A throw from a real-looking depth, so the stack carries a tools/ frame below the test's own.
function deepInTheWalker() { const exit = null; return exit.stand_on.row; }

console.log('travelThrewOutcome');
await test('names the error and its first in-repository frame, relative to tools/', () => {
  let err; try { deepInTheWalker(); } catch (e) { err = e; }
  const o = travelThrewOutcome(err);
  assert.equal(o.arrived, false);
  assert.equal(o.threw, true);
  assert.match(o.reason, /^travel_threw: TypeError: Cannot read properties of null/);
  assert.match(o.reason, / @ deepInTheWalker m59-travel-threw-test\.mjs:\d+$/);
  assert.ok(!/[A-Za-z]:[\\/]|file:/.test(o.reason), `no absolute path: ${o.reason}`);
  assert.ok(o.frames.length >= 1 && o.frames.length <= 4);
});
await test('a synthetic stack: skips node internals and node_modules, keeps the innermost repo frame', () => {
  const e = new Error('boom');
  e.stack = ['Error: boom',
    '    at Array.map (<anonymous>)',
    '    at /x/node_modules/lib/index.js:3:1',
    '    at Session.leaveVia (file:///C:/code/m59-lab/prod-deploy/tools/m59-session-walk.mjs:6123:15)',
    '    at async Session.leaveViaAny (C:\\code\\repo\\tools\\m59-session-walk.mjs:8599:17)',
    '    at file:///C:/code/repo/tools/autopilot/travel.mjs:1242:23',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)'].join('\n');
  const o = travelThrewOutcome(e);
  assert.equal(o.reason, 'travel_threw: boom @ Session.leaveVia m59-session-walk.mjs:6123');
  assert.deepEqual(o.frames, ['Session.leaveVia m59-session-walk.mjs:6123',
    'async Session.leaveViaAny m59-session-walk.mjs:8599', 'autopilot/travel.mjs:1242']);
});
await test('a non-Error throw and a stackless error still give a reason', () => {
  assert.equal(travelThrewOutcome('a string').reason, 'travel_threw: a string');
  assert.equal(travelThrewOutcome(undefined).reason, 'travel_threw: unknown error');
  const e = new RangeError('x'.repeat(500)); e.stack = '';
  const o = travelThrewOutcome(e);
  assert.ok(o.reason.startsWith('travel_threw: RangeError: xxx') && o.reason.length < 240, o.reason);
  assert.deepEqual(o.frames, []);
});

console.log('\nAutopilot.travel when Session.travel throws');
await test('the exception still reaches the caller, unchanged', async () => {
  const ledger = [], boom = new TypeError('Cannot read properties of undefined (reading \'row\')');
  const k = fakeKeeper({ ledger, name: 'tt1', travel: async () => { throw boom; } });
  await assert.rejects(Autopilot.prototype.travel.call(k, 2143, {}), err => err === boom);
});
await test('the zone_change row names the error instead of reason: null', async () => {
  const ledger = [];
  const k = fakeKeeper({ ledger, name: 'tt2', travel: async () => deepInTheWalker() });
  await Autopilot.prototype.travel.call(k, 2143, {}).catch(() => {});
  const row = ledger.find(r => r.kind === 'zone_change' || r.kind === 'travel_journey');
  assert.ok(row, 'a journey row was written');
  assert.equal(row.arrived, false);
  assert.match(row.reason ?? '', /^travel_threw: TypeError: .* @ deepInTheWalker m59-travel-threw-test\.mjs:\d+$/);
  assert.ok(Array.isArray(row.threw_at) && row.threw_at[0].startsWith('deepInTheWalker '), JSON.stringify(row.threw_at));
});
await test('the movement incident carries the same reason, and is not classed as anything but not_arrived', async () => {
  const ledger = [];
  const k = fakeKeeper({ ledger, name: 'tt3', travel: async () => deepInTheWalker() });
  await Autopilot.prototype.travel.call(k, 2143, { origin: { source: 'keeper', name: 'survival_exit' } }).catch(() => {});
  const all = I.readIncidents({ dir: SCRATCH, agent: 'tt3' });
  assert.equal(all.length, 1, 'one incident for one failed journey');
  assert.equal(all[0].kind, 'not_arrived');
  assert.match(all[0].reason ?? '', /^travel_threw: TypeError: /);
  assert.equal(all[0].target.room, 2143);
});
await test('a journey that RETURNS is untouched: no threw_at, its own reason', async () => {
  const ledger = [];
  const k = fakeKeeper({ ledger, name: 'tt4', travel: async () => ({ arrived: false, reason: 'gave up after 1 hops', stumbles: 0 }) });
  const out = await Autopilot.prototype.travel.call(k, 2143, {});
  assert.equal(out.reason, 'gave up after 1 hops');
  const row = ledger.find(r => r.kind === 'zone_change' || r.kind === 'travel_journey');
  assert.equal(row.reason, 'gave up after 1 hops');
  assert.equal('threw_at' in row, false);
  assert.equal(row.stumbles, 0);
});

if (process.env.KEEP_SCRATCH) console.log('scratch', SCRATCH); else rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
