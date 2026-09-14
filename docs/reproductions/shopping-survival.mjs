// Read-only offline comparison. Run from any directory; opens no game socket.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const evidence = mkdtempSync(join(tmpdir(), 'm59-shopping-audit-'));
process.env.M59_EVIDENCE_DIR = evidence;
process.env.M59_UPTIME_FILE = join(evidence, 'uptime.jsonl');
const { Autopilot } = await import('../../tools/m59-autopilot.mjs');
const { OF } = await import('../../tools/m59-parse.mjs');
// Reuse the existing offline fake client; exercise production methods, not copied guards.
const fixture = readFileSync(new URL('../../tools/m59-survival-handoff-test.mjs', import.meta.url), 'utf8');
const make = new Function('Autopilot', fixture.slice(fixture.indexOf('function keeper()'),
  fixture.indexOf('const ctx =')) + '\nreturn keeper;')(Autopilot);
const cases = [
  { name: 'low health, nearby monster, no wedge', hp: 20, monster: true },
  { name: 'five seconds estimated life, no adjacent object', hp: 40, ttl: 5000 },
  { name: 'low health, nearby stranger, no wedge', hp: 20, player: true },
  { name: 'hurt but above flee line, no imminent collapse', hp: 40, monster: true },
  { name: 'unarmed at full health, default arm guard off', hp: 50, unarmed: true },
  { name: 'unarmed at full health, arm guard explicitly on', hp: 50, unarmed: true, arm: true },
  { name: 'low health and a five-second damaging wedge', hp: 20, monster: true, wedge: true },
];
const rows = [];
for (const scenario of cases) {
  for (const origin of ['internal shopping', 'travel with a free pass loop']) {
    const k = make();
    k.timeToDeath = () => scenario.ttl ?? null;
    k.damageRate = () => scenario.ttl ? k.health / (scenario.ttl / 1000) : null;
    k.armed = () => !scenario.unarmed;
    k.policy.travelGuard = { arm: !!scenario.arm };
    k.policy.fightBackAfterMs = 10000;
    k.s.client.rsc = { get: () => 'audit stranger' };
    // These watchdog edicts are real too: their inert gate suppresses both origins.
    k.fightBackCheck = Autopilot.prototype.fightBackCheck;
    k.clearPathCheck = Autopilot.prototype.clearPathCheck;
    k.inReachOfUs = () => [...k.s.client.room.objects.values()];
    let guards = 0;
    const guard = k.passTravelling;
    k.passTravelling = async function(ctx) { guards++; return guard.call(this, ctx); };
    let enter, settle;
    const entered = new Promise(r => { enter = r; });
    k.s.travel = async () => { enter(); return new Promise(r => { settle = r; }); };
    k.townTrip = { target: { room: 714, hops: 4 }, nextService: -1, startedAt: Date.now() };
    k.shoppingPlan = () => ({ required_purse: 0 });
    k.postShoppingPlan = () => {};
    k.leaveHold = async () => ({});
    k.money = { trips: 0, trips_failed: 0, why_not: [] };
    const pending = origin === 'internal shopping'
      ? k.passErrand({ s: k.s, c: k.s.client, room: k.s.world.room })
      : k.travel(714);
    await entered;
    k.health = scenario.hp;
    if (scenario.monster || scenario.player) k.s.client.room.objects.set(10, {
      id: 10, row: 20, col: 20, nameRsc: 10,
      flags: OF.ATTACKABLE | (scenario.player ? OF.PLAYER : 0) });
    k.doing = 'travelling';
    k.watch.attack = { since: Date.now() - 20000, lastHitAt: Date.now(), hits: 3, lost: 10 };
    k.watch.pinnedSince = Date.now() - 20000;
    if (scenario.wedge) k.watch.wedged = {
      since: Date.now() - 5000, taking_hits: true, at: { room: 584, row: 20, col: 20 } };
    k.watchdogTick();
    if (origin !== 'internal shopping' && k.inert) await k.passUnderworld({
      s: k.s, c: k.s.client, room: k.s.world.room,
      v: k.s.client.vitals(), hp: k.health / 50 });
    rows.push({ scenario: scenario.name, origin, guard_calls: guards,
      cancelled: k.s.movementGeneration !== 0, freeze: !!k.frozenUntil,
      suspended_to: k.suspendedJourney?.to ?? null, fight_due: !!k.fightBackDue });
    settle({ arrived: false, cancelled: true, reason: 'offline fixture ended' });
    await pending;
  }
}
assert.equal(rows[0].guard_calls, 0);
assert.equal(rows[0].cancelled, false);
assert.equal(rows[1].guard_calls, 1);
assert.equal(rows[1].cancelled, true);
assert.equal(rows[2].cancelled, false);
assert.equal(rows[3].cancelled, true);
assert.ok(rows.slice(-2).every(r => r.cancelled && r.suspended_to === 714));
assert.ok(rows.every(r => !r.fight_due));
console.log(JSON.stringify(rows, null, 2));
