#!/usr/bin/env node
// WHO ORDERED A MOVE AND WHO CANCELLED IT — and the movement incident log those failures leave.
// Offline: no socket, no broker, no roster. Every ledger write is redirected to a scratch dir.
//
//   node tools/m59-move-origin-test.mjs
//
// The incident (prod 2026-10-04, t9 Camilla): a FleetScript buy-spell errand walked her to the
// guild hall 714 three times and reported "did not reach 714 in three attempts". Each journey had
// been CANCELLED by another issuer — once by the errand's own clear-the-way cancel, then by the
// keeper's survive-mode shelter logic ("chosen shelter approach interrupted: route uses the
// fallback walker"). Nothing named the canceller to the errand or the operator. These cases pin
// that it is now named on both sides, in the ledger row, in status, and in the step's failure.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRATCH = mkdtempSync(join(tmpdir(), 'm59-moveorigin-'));
process.env.M59_LEDGER_DIR = SCRATCH;

const M = await import('./m59-move-origin.mjs');
const I = await import('./m59-movement-incidents.mjs');
const { Session } = await import('./m59-game.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const { rtsJobReport } = await import('./m59-rts-safety.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e?.stack ?? e).toString().split('\n').slice(0, 4).join('\n       ')); }
};

const SCRIPT = { source: 'fleetscript', name: 'buy-spell', run_id: 'r1' };
const SHELTER_WHY = 'chosen shelter approach interrupted: route uses the fallback walker';

console.log('the origin itself');
await test('silence is unattributed, never empty', () => {
  const o = M.moveOrigin(null);
  assert.equal(o.source, 'unattributed'); assert.equal(o.name, 'unattributed');
  assert.ok(o.at > 0);
});
await test('a "source:name" string and an unknown source are both honest', () => {
  assert.equal(M.originLabel(M.moveOrigin('keeper:shelter')), 'keeper:shelter');
  const odd = M.moveOrigin({ source: 'gremlin', name: 'x' });
  assert.equal(odd.source, 'unattributed'); assert.equal(odd.claimed_source, 'gremlin');
});
await test('a claimant string is a fleetscript when it says so and a bot otherwise', () => {
  assert.equal(M.claimantOrigin('fleetscript:buy-spell').source, 'fleetscript');
  assert.equal(M.claimantOrigin('dum/prod two bands@pid-11220').source, 'bot');
});
await test('the label carries the run, so two runs of one script are told apart', () => {
  assert.equal(M.originLabel(M.moveOrigin(SCRIPT)), 'fleetscript:buy-spell#r1');
  assert.equal(M.sameIssuer(M.moveOrigin(SCRIPT), M.moveOrigin({ ...SCRIPT, run_id: 'r2' })), false);
});

console.log('\na journey cancelled by another issuer records BOTH sides (Session.cancelMovement)');
await test('the cancel names the canceller AND the order it pre-empted, and status shows it', async () => {
  const s = new Session('t9');
  s.world = { room: { num: 48 } };
  let cancelled;
  await M.withMoveOrder(s, { to: 714, origin: SCRIPT }, async () => {
    // One layer down, the same order seen again: inherited, not re-issued.
    await M.withMoveOrder(s, { to: 714 }, async () => {
      assert.equal(M.liveMoveOrder(s).origin.name, 'buy-spell');
      const r = s.cancelMovement(null, SHELTER_WHY, { origin: M.keeperOrigin('shelter') });
      assert.equal(r.cancelled, true);
      assert.equal(r.cancelled_by, 'keeper:shelter');
      assert.equal(r.preempted.ordered_by, 'fleetscript:buy-spell#r1');
      cancelled = s.cancelledMovement();
    });
  });
  assert.equal(cancelled.cancelled_by, SHELTER_WHY, 'the why is kept where readers already read it');
  assert.equal(cancelled.cancelled_by_origin.source, 'keeper');
  assert.equal(cancelled.cancelled_by_origin.name, 'shelter');
  const report = M.movementReport(s);
  assert.equal(report.order, null, 'the cancelled order is no longer steering');
  assert.equal(report.last_preempted.by_label, 'keeper:shelter');
  assert.equal(report.last_preempted.preempted.to, 714);
  assert.match(report.last_preempted.summary,
    /^walk to 714 ordered by fleetscript:buy-spell#r1 cancelled by keeper:shelter \(chosen shelter approach interrupted.*\) at \d\d:\d\d:\d\dZ$/);
});
await test('a script cancelling its OWN earlier walk is not a preemption', async () => {
  const s = new Session('t9');
  await M.withMoveOrder(s, { to: 714, origin: SCRIPT }, async () => {
    s.cancelMovement(null, "clearing the way for the errand's own walk to 714", { origin: SCRIPT });
  });
  assert.equal(s.lastMovementCancel.self_cancel, true);
  assert.equal(s.lastPreempted ?? null, null);
});
await test('a cancel with no origin is recorded as unattributed, not as the keeper', () => {
  const s = new Session('t9');
  s.cancelMovement(null, 'somebody');
  assert.equal(s.lastMovementCancel.by.source, 'unattributed');
});
await test('the job report says who ordered the move in flight, and who cancelled it', () => {
  const job = { kind: 'travel', label: 'walk to 714', startedAt: Date.now() - 5000, done: false,
                origin: M.moveOrigin(SCRIPT) };
  assert.equal(rtsJobReport(job).ordered_by, 'fleetscript:buy-spell#r1');
  job.cancelled = true;
  job.cancelledBy = M.recordMovementCancel({ movementGeneration: 0 }, { why: SHELTER_WHY,
    origin: M.keeperOrigin('shelter'), job });
  Object.assign(job, { done: true, finishedAt: Date.now() });
  const done = rtsJobReport(job);
  assert.equal(done.cancelled, true);
  assert.equal(done.cancelled_by.by, 'keeper:shelter');
  assert.match(done.cancelled_by.summary, /ordered by fleetscript:buy-spell#r1 cancelled by keeper:shelter/);
});
await test('a busy refusal names whose walk holds the body', () => {
  const s = new Session('t9');
  s.job = { kind: 'travel', label: 'walk to room 48', done: false, origin: M.keeperOrigin('town_trip') };
  assert.throws(() => s.startJob('travel', 'walk to 714', async () => {}),
                /is busy: walk to room 48 \(ordered by keeper:town_trip\)/);
});

console.log('\nthe journey ledger row and the incident (Autopilot.travel)');
const fakeKeeper = ({ travel, ledger, lastCancel = null, name = 't9' }) => {
  const s = {
    name, movementGeneration: 0,
    world: { room: { num: 48, name: 'Inside the Inn' },
             route: () => ({ found: true, hops: [{ from: 48, to: 49, stand_on: { row: 1, col: 21 } },
                                                   { from: 49, to: 714, to_name: 'the hall' }] }) },
    client: { self: { row: 10, col: 12, x: 12 * 64 + 32, y: 10 * 64 + 32 },
              me: { name: 'Camilla' }, selfId: 1,
              room: { objects: new Map([[2, { id: 2, flags: 8, nameRsc: 9, name: 'troll' }]]) },  // flags 8 = OF.ATTACKABLE
              rsc: { get: () => 'troll' },
              vitals: () => ({ health: { value: 30, max: 60 }, vigor: { value: 120 } }) },
    lastMovementCancel: lastCancel,
    movementWasCancelled: () => false,
    cancelMovement(token, why, opts = {}) {
      this.lastMovementCancel = M.recordMovementCancel(this, { why, origin: opts.origin });
      this.movementGeneration++;
      return { cancelled: true };
    },
    travel,
  };
  return {
    name, policy: {}, doing: 'travelling', s,
    watch: { pulses: [{ at: 1, room: 48, row: 10, col: 11, x: 736, y: 672, health: 40 },
                      { at: 2, room: 48, row: 10, col: 12, x: 800, y: 672, health: 30 }] },
    goTravelling: () => {}, revive: () => {}, answerWedge: async () => null,
    restBeforeSettingOut: async () => ({ rested: false }), travelHoldMode: () => 'on',
    recordFrame: () => {}, hitDamageTotal: () => 0, pvpReturnGate: () => null,
    travelInterrupted: () => false, eatBeforeTravel: async () => {},
    ledgerEvent: (kind, row) => ledger.push({ kind, ...row }), detailEvent: () => {},
    travelHold: async () => {}, recordTravelShelterStop: () => {},
  };
};
await test('a pre-empted journey row carries its own origin and the canceller\'s', async () => {
  const ledger = [];
  const k = fakeKeeper({ ledger, travel: async function () {
    this.cancelMovement(null, SHELTER_WHY, { origin: M.keeperOrigin('shelter') });
    return this.cancelledMovement?.() ?? { arrived: false, cancelled: true,
      reason: 'movement cancelled by a newer command', refusals: [] };
  } });
  await Autopilot.prototype.travel.call(k, 714, { origin: SCRIPT });
  const row = ledger.find(r => r.kind === 'travel_journey');
  assert.ok(row, 'a travel_journey row was written');
  assert.equal(row.ordered_by, 'fleetscript:buy-spell#r1');
  assert.equal(row.origin.source, 'fleetscript');
  assert.equal(row.cancelled_by, SHELTER_WHY);
  assert.equal(row.cancelled_by_label, 'keeper:shelter');
  assert.equal(row.cancelled_by_origin.name, 'shelter');
});
await test('a cancel from BEFORE the journey is not blamed for it', async () => {
  const ledger = [];
  const stale = { why: "clearing the way for the errand's own walk to 714", at: Date.now() - 60_000,
                  by: M.moveOrigin(SCRIPT), by_label: 'fleetscript:buy-spell#r1' };
  const k = fakeKeeper({ ledger, lastCancel: stale, travel: async () => ({ arrived: true, hops: 2 }) });
  await Autopilot.prototype.travel.call(k, 714, { origin: SCRIPT });
  const row = ledger.find(r => r.kind === 'travel_journey');
  assert.equal(row.cancelled_by, null);
  assert.equal(row.cancelled_by_origin, undefined);
});
await test('a journey with no origin from inside the keeper is keeper:unattributed, never empty', async () => {
  const ledger = [];
  const k = fakeKeeper({ ledger, travel: async () => ({ arrived: true, hops: 2 }) });
  await Autopilot.prototype.travel.call(k, 714, {});
  const row = ledger.find(r => r.kind === 'travel_journey');
  assert.equal(row.ordered_by, 'keeper:unattributed');
});
await test('the failed journey leaves ONE movement incident, with position, target, route and canceller', async () => {
  const ledger = [];
  // Its own agent: the same failure as the case above would be DEDUPED into it, by design.
  const k = fakeKeeper({ ledger, name: 't9b', travel: async function () {
    this.cancelMovement(null, SHELTER_WHY, { origin: M.keeperOrigin('shelter') });
    return { arrived: false, cancelled: true, reason: 'movement cancelled by a newer command',
             refusals: [{ stand_on: { row: 1, col: 21 }, stage: 'crossing', why: 'boundary refused' }] };
  } });
  await Autopilot.prototype.travel.call(k, 714, { origin: SCRIPT });
  const all = I.readIncidents({ dir: SCRATCH, agent: 't9b' });
  assert.equal(all.length, 1, 'exactly one incident for one failed journey');
  const rec = all[0];
  assert.equal(rec.kind, 'preempted');
  assert.ok(rec, 'an incident was written');
  assert.equal(rec.format, I.FORMAT);
  assert.equal(rec.room.num, 48);
  assert.deepEqual(rec.start.square, { row: 10, col: 12 });
  assert.deepEqual(rec.start.fine, { x: 800, y: 672, units: 'kod' });
  assert.equal(rec.target.room, 714);
  assert.deepEqual(rec.target.square, { row: 1, col: 21 }, 'the stage square it was failing to reach');
  assert.deepEqual(rec.route.planned, [48, 49, 714]);
  assert.equal(rec.cancelled_by.by_label, 'keeper:shelter');
  assert.equal(rec.ordered_by.label, 'fleetscript:buy-spell#r1');
  assert.equal(rec.refusals[0].at, 'r1c21');
  assert.equal(rec.threats.count, 1);
  assert.equal(rec.trail.length, 2);
  assert.ok(rec.id.startsWith('mi-'));
  assert.ok('harness_sha' in rec.code && 'movement_epoch' in rec.code);
});

console.log('\nthe incident log: dedupe and export');
await test('a retry loop is ONE incident with a count, not one per tick', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm59-inc-'));
  let t = 1_000_000;
  const log = I.createIncidentLog({ dir, fleet: 'testfleet', clock: () => t, dedupeMs: 60_000 });
  const fail = { agent: 't9', kind: 'exits_exhausted', reason: 'route_progressing_exits_exhausted',
                 from: 48, room: { num: 48 }, target: { room: 714, row: 1, col: 21 } };
  const a = log.record(fail); t += 9_000;
  const b = log.record(fail); t += 9_000;
  const c = log.record(fail);
  assert.equal(a.written, 'incident'); assert.equal(b.written, 'repeat'); assert.equal(c.id, a.id);
  t += 120_000;
  const d = log.record(fail);
  assert.equal(d.written, 'incident', 'after the window the same failure is a new incident');
  assert.notEqual(d.id, a.id);
  const rows = I.readIncidents({ dir, now: t, sinceMs: 3600_000 });
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.id === a.id).repeats, 2);
  rmSync(dir, { recursive: true, force: true });
});
await test('export is a redacted, self-contained fixture a script can aim with', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm59-inc-'));
  const log = I.createIncidentLog({ dir, fleet: 'testfleet' });
  const { id } = log.record({ agent: 't9', character: 'Camilla', kind: 'fleetscript_walk_failed',
    reason: 'walk to 714 cancelled by keeper:shelter; Camilla did not reach 714', from: 48,
    room: { num: 48, name: 'Inside the Inn' }, start: { room: 48, row: 10, col: 12, x: 800, y: 672 },
    target: { room: 714, row: 1, col: 21 },
    cancel: { by: M.keeperOrigin('shelter'), why: SHELTER_WHY, at: Date.now() } });
  const [rec] = I.readIncidents({ dir, id });
  const fx = I.exportIncident(rec, { names: ['Camilla', 't9'] });
  assert.equal(fx.format, I.FIXTURE_FORMAT);
  assert.equal(fx.subject.name, 'player A');
  assert.ok(!JSON.stringify(fx).includes('Camilla'), 'no character name rides out');
  assert.equal(fx.room.name, 'Inside the Inn', 'room names are never rewritten');
  assert.deepEqual(fx.replay.walk, { to: 714 });
  assert.deepEqual(fx.replay.start_square, { row: 10, col: 12 });
  assert.equal(fx.failure.cancelled_by.by_label, 'keeper:shelter');
  assert.match(fx.units_note, /64 units per square/);
  const kept = I.exportIncident(rec, { keepNames: true });
  assert.equal(kept.subject.name, 'Camilla');
  rmSync(dir, { recursive: true, force: true });
});
await test('classification: preempted, cancelled, exits_exhausted, wedge, refused', () => {
  const pre = { by: M.keeperOrigin('shelter'), preempted: { to: 714 }, self_cancel: false };
  assert.equal(I.classifyJourneyFailure({ cancelled: true }, pre), 'preempted');
  assert.equal(I.classifyJourneyFailure({ cancelled: true }, { ...pre, self_cancel: true }), 'cancelled');
  assert.equal(I.classifyJourneyFailure({ reason: 'route_progressing_exits_exhausted' }), 'exits_exhausted');
  assert.equal(I.classifyJourneyFailure({ wedged: true, reason: 'x' }), 'wedge');
  assert.equal(I.classifyJourneyFailure({ refused: true, why: 'outside the confinement' }), 'refused');
});

console.log('\nevery move path supplies an origin (source sweep)');
// THE GUARD AGAINST THE NEXT ANONYMOUS CALLER. Every `.travel(` and `cancelMovement(` call in the
// keeper's movement code names its issuer. A new one that does not is the gap this whole change
// closes, reopened — so it fails here, by file and line, rather than as `unattributed` on prod.
const SWEPT = ['m59-autopilot.mjs', 'm59-combat-mode.mjs', 'm59-watchdog.mjs', 'm59-keeper-goap.mjs',
               'm59-bt-farm.mjs', 'm59-bt-retreat.mjs', 'm59-reagent-coop-runtime.mjs', 'm59-atomics.mjs',
               'm59-keeper-process.mjs', 'm59-broker.mjs'];
// A call is attributed when its own statement (up to the closing of its argument list, a few
// lines) mentions `origin`, or passes the caller's `opts`/`options`/`...opts` straight through.
const statementAt = (lines, i) => lines.slice(i, i + 4).join(' ');
await test('no .travel( or cancelMovement( call in the keeper or broker is unattributed', () => {
  const missing = [];
  for (const f of SWEPT) {
    const lines = readFileSync(join(HERE, f), 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '');
      if (/^\s*\*/.test(l) || !/(\.travel\(|cancelMovement\??\.?\()/.test(code)) return;
      if (/typeof\s+\S*cancelMovement|cancelMovement\(token,why,\{|async cancelMovement\(|cancelMovement\(controlToken, why = /.test(code)) return;
      if (/\b(async\s+)?travel\(\s*(room|toRoomNum|to|dest)\b[^)]*\)\s*\{/.test(code)) return; // definitions
      if (/ctx\.travel\(agent, to\)/.test(code)) return;   // atomics' ctx.travel, whose body names its origin
      const stmt = statementAt(lines, i);
      if (/origin/.test(stmt) || /\.\.\.(opts|options|sessionOpts)\b/.test(stmt)) return;
      missing.push(`${f}:${i + 1}: ${l.trim().slice(0, 110)}`);
    });
  }
  assert.deepEqual(missing, [], 'unattributed move calls:\n  ' + missing.join('\n  '));
});
await test('the prototype wrappers are installed on Session and Autopilot travel', () => {
  assert.equal(typeof Session.prototype.travel.__moveOrder, 'function');
  assert.equal(typeof Autopilot.prototype.travel.__moveOrder, 'function');
});

if (process.env.KEEP_SCRATCH) console.log('scratch', SCRATCH); else rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
