#!/usr/bin/env node
// m59-claimwedge-test.mjs — A CLAIMED BODY THAT BOUNCES IS STILL A WEDGED BODY.
//
//   node tools/m59-claimwedge-test.mjs
//   M59_AUTOPILOT_MODULE=../../prod-deploy/tools/m59-autopilot.mjs node tools/m59-claimwedge-test.mjs
//
// Offline. Opens no socket, joins nobody, needs no broker, writes no ledger. It drives the
// REAL `pulsePosition` over a keeper stripped to the fields that method touches, with the
// REAL `pennedIn`, `inertBleeding`, `facultyOwner` and `facultyHeld` off the prototype —
// what is under test is a DECISION about a sequence of samples, and a sequence is something
// a fixture can state exactly and a live fleet cannot.
//
// ======================== WHAT THIS PINS ========================
//
// `pulsePosition` gates `pennedIn` — the only test that sees a two-square bounce — behind a
// flag that asked `this.inert`: has the KEEPER stood itself down. A commander claim on
// `movement` (a bot, a fleetscript, DUM) deliberately leaves survival with the keeper, so
// `this.inert` is null and that flag was false. The claimed body therefore got only the
// EXACT-SQUARE test, and an oscillating character reads as moving on every pair.
//
// MEASURED, prod 2026-09-17. Rowlf, level 52, room 39, killed by a battered skeleton while
// `movement` was held by `dum/prod Valley and Castle Victoria HP bands@pid-38876`:
//
//   wedges: 415          net_squares: 1 over 94.7s       wedged_at_death.for_ms: 1104
//
// Four hundred and fifteen episodes, each thrown away when the body stepped to the next
// square, so none of them ever aged to INERT_RESCUE_MS and the rescue that cancels the
// stalled driver's walk could not fire. He went 41 -> 0 bouncing between 16,8 / 17,8 / 18,8.
// Clifford and both of Animal's deaths the same night carry the same marker.
//
// THREE CLAIMS, AND THE THIRD IS THE ONE THAT KEEPS THIS HONEST:
//   1. A CLAIMED, BLEEDING, BOUNCING body opens ONE episode and KEEPS it, so its age
//      matures past INERT_RESCUE_MS and the rescue has something to act on.
//   2. A claimed body that is genuinely walking, or is not losing health, is untouched.
//   3. AN ORDINARY SELF-DRIVEN TRAVELLER IS BIT-FOR-BIT UNCHANGED. The handbrake is not
//      widened for anybody who was not already driven from outside — `pennedIn` stays a
//      strictly-inert-or-claimed instrument. This is the regression the repair must not be.

import { readFileSync } from 'node:fs';

const MODULE = process.env.M59_AUTOPILOT_MODULE || './m59-autopilot.mjs';
const { Autopilot } = await import(new URL(MODULE, import.meta.url).href);
const SOURCE = readFileSync(new URL(MODULE, import.meta.url), 'utf8');

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  — ' + extra : '')); }
};

const INERT_RESCUE_MS = Number(process.env.M59_INERT_RESCUE_MS || 4_000);

// ---------------------------------------------------------------------------
// The smallest thing that can stand in for a keeper mid-walk. Real prototype, so
// `pennedIn`, `inertBleeding` and the faculty lookups are the shipped ones.
// ---------------------------------------------------------------------------
function keeper({ doing = 'travelling', inert = null, hold = null, claim = null,
                  room = 39, col = 16, row = 8, health = 41 } = {}) {
  const k = Object.create(Autopilot.prototype);
  const self = { col, row, x: col * 64 + 32, y: row * 64 + 32 };
  k.doing = doing;
  k.inert = inert;
  k.hold = hold;
  k.tally = {};
  k.passes = 0;
  k.watch = { pulses: [], lastPulseAt: 0, wedged: null, wedges: 0 };
  k.s = { client: { self, room: { id: room } }, world: { room: { num: room } } };
  k.claims = new Map();
  if (claim) k.claims.set('movement', { owner: claim, until: Date.now() + 600_000, why: 'test' });
  k.notes = [];
  k.frames = [];
  k.note = (what, detail) => k.notes.push({ what, detail });
  k.recordFrame = why => k.frames.push(why);
  // Not under test, and both write to instruments this fixture does not carry.
  k.trackSinceFull = () => {};
  k.trackGrind = () => {};
  k.health = health;
  // Move the body, or do not, and take a sample.
  k.step = (t, { to = null, lose = 2 } = {}) => {
    if (to) { self.col = to.col; self.row = to.row; self.x = to.col * 64 + 32; self.y = to.row * 64 + 32; }
    k.health = Math.max(0, k.health - lose);
    return k.pulsePosition(t, { value: k.health, max: 52 });
  };
  return k;
}

// Rowlf's own trail: two adjacent squares, back and forth, while being eaten.
const bounce = (k, from = 1000, to = 8000, lose = 2) => {
  let flip = false;
  for (let t = from; t <= to; t += 1000) {
    flip = !flip;
    k.step(t, { to: { col: flip ? 17 : 16, row: 8 }, lose });
  }
};

const DUM = 'dum/prod Valley and Castle Victoria HP bands@pid-38876';

// ---------------------------------------------------------------------------
console.log('\n1. a claimed, bleeding, bouncing body holds ONE episode and it matures');
{
  const k = keeper({ claim: DUM });
  bounce(k);
  ok('the bounce is caught at all', !!k.watch.wedged,
     `wedges=${k.watch.wedges} wedged=${JSON.stringify(k.watch.wedged)}`);
  ok('as ONE episode, not one per step', k.watch.wedges === 1, `wedges=${k.watch.wedges}`);
  ok('the episode names the driver that had stopped',
     k.watch.wedged?.inert === `movement held by ${DUM}`, String(k.watch.wedged?.inert));
  ok('it knows it is being hit', k.watch.wedged?.taking_hits === true);
  ok(`and it ages past INERT_RESCUE_MS (${INERT_RESCUE_MS}ms), which is what the rescue reads`,
     k.watch.wedged?.for_ms >= INERT_RESCUE_MS, `for_ms=${k.watch.wedged?.for_ms}`);
  ok('it records how much the episode has cost', k.watch.wedged?.health_lost > 0,
     `health_lost=${k.watch.wedged?.health_lost}`);
  ok('it raises one `!` note a person can grep for',
     k.notes.filter(n => n.what.startsWith('! NOT MOVING')).length === 1);
}

// ---------------------------------------------------------------------------
console.log('\n2. the claim alone is not enough — the body must be stuck AND bleeding');
{
  const walking = keeper({ claim: DUM });
  for (let t = 1000, c = 16; t <= 8000; t += 1000, c++) walking.step(t, { to: { col: c, row: 8 } });
  ok('a claimed body that is genuinely walking is never flagged',
     walking.watch.wedges === 0 && !walking.watch.wedged, `wedges=${walking.watch.wedges}`);

  const healthy = keeper({ claim: DUM });
  bounce(healthy, 1000, 8000, 0);
  ok('a claimed body that bounces but loses NO health is not flagged by this clause',
     healthy.watch.wedges === 0 && !healthy.watch.wedged, `wedges=${healthy.watch.wedges}`);

  const parked = keeper({ claim: DUM, doing: 'recovering' });
  bounce(parked);
  ok('a claimed body that is not going anywhere is still excused',
     parked.watch.wedges === 0 && !parked.watch.wedged, `wedges=${parked.watch.wedges}`);

  const wall = keeper({ claim: DUM, hold: { col: 16, row: 8 } });
  bounce(wall);
  ok('a held safe wall is standing still on purpose and is never flagged',
     wall.watch.wedges === 0 && !wall.watch.wedged, `wedges=${wall.watch.wedges}`);
}

// ---------------------------------------------------------------------------
console.log('\n3. THE REGRESSION GATE — nobody who was not already driven from outside changes');
{
  // This is the whole safety argument for the repair. `pennedIn` is a handbrake, and
  // widening a handbrake for the ordinary self-driven traveller is a different decision
  // that nothing here has measured. A plain traveller must read exactly as it always did.
  const plain = keeper();
  bounce(plain);
  ok('an unclaimed, un-inert traveller that bounces is NOT wedged by the bounce',
     plain.watch.wedges === 0 && !plain.watch.wedged, `wedges=${plain.watch.wedges}`);

  // ...and the exact-square alarm it DOES have still works, unchanged.
  const still = keeper();
  for (let t = 1000; t <= 4000; t += 1000) still.step(t);
  ok('...while a plain traveller standing perfectly still is flagged exactly as before',
     still.watch.wedges === 1 && !!still.watch.wedged, `wedges=${still.watch.wedges}`);

  // The legacy inert path — the case the clause was originally written for — is untouched.
  const errand = keeper({ inert: { why: 'errand' } });
  bounce(errand);
  ok('an INERT bleeding bouncing body is caught exactly as it was before',
     errand.watch.wedges === 1 && errand.watch.wedged?.for_ms >= INERT_RESCUE_MS,
     `wedges=${errand.watch.wedges} for_ms=${errand.watch.wedged?.for_ms}`);

  const errandHealthy = keeper({ inert: { why: 'errand' } });
  bounce(errandHealthy, 1000, 8000, 0);
  ok('...and an inert body losing no health is still excused, as before',
     errandHealthy.watch.wedges === 0, `wedges=${errandHealthy.watch.wedges}`);
}

// ---------------------------------------------------------------------------
console.log('\n4. a live fight cannot reach this clause — the two guards are 200 lines apart');
{
  // `facultyOwner` answers `combat:<id>` for an unprotected faculty while a fight is live,
  // which reads as a claim here. The only thing that stops an ordinary stationary fight
  // opening wedges is that `watchdogTick` returns before it ever calls `pulsePosition`.
  // Nothing local says so, so it is pinned here: if somebody moves the pulse above that
  // return, this test is the thing that notices.
  const tick = SOURCE.slice(SOURCE.indexOf('\n  watchdogTick() {'));
  const combatReturn = tick.indexOf('combat?.active');
  const pulseCall = tick.indexOf('this.pulsePosition(');
  ok('watchdogTick still returns on a live fight BEFORE it pulses the position',
     combatReturn > 0 && pulseCall > 0 && combatReturn < pulseCall,
     `combat@${combatReturn} pulse@${pulseCall}`);

  const k = keeper({ claim: DUM });
  k.s.combat = { active: { id: 'fight-1' } };
  ok('...and while that fight is live the faculty does read as held, which is why it matters',
     k.facultyHeld('movement') === true && k.facultyOwner('movement') === 'combat:fight-1');
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
