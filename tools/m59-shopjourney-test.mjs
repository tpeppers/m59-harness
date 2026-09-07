#!/usr/bin/env node
// A SHOPPING TRIP IS TRAVEL-SHOP-TRAVEL-SHOP, SO EVERY LEG IS A JOURNEY.
//
//   node tools/m59-shopjourney-test.mjs      # offline, opens no socket, touches no roster
//
// WHAT THIS PINS.
//
// `shelterPolicy` is what makes the shelter planner in `walkTo` live rather than dead code:
// it is read while the route is being planned, and `sheltersAlong` works out which
// route-adjacent walls a hurt walker may duck into on the way. It is set in exactly ONE
// place — `goTravelling` — and that had exactly one caller: `travelJob`, the EXTERNAL
// journey path used by the travel tool.
//
// So the keeper's own travel — which is what a supply run is built from,
// `restockInTown` -> `Autopilot.travel` -> `Session.travel` — crossed the same roads with
// no shelters planned and no `travel_guard`. Those roads are 599 Ukgoth and 598 The Cragged
// Mountains, which is where most of this fleet's road deaths happen. The comment beside the
// assignment asserted the opposite in as many words: "an errand, a fight or a shopping trip
// has no route ahead to divert along". A supply run is eleven hops out and eleven back.
//
// Reported by a peer agent, 2026-09-06, and confirmed by reading the one setter and its one
// caller before changing anything.

import { Autopilot } from './m59-autopilot.mjs';
import { readFileSync } from 'node:fs';

const AP = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  — ' + extra : '')); }
};

// A keeper stripped to what `goTravelling` and the posture bookkeeping touch.
function keeper({ inert = null, guard = null } = {}) {
  const ap = Object.create(Autopilot.prototype);
  ap.policy = {};
  ap.inert = inert;
  ap.s = { shelterPolicy: null, client: {} };
  // goTravelling flushes the safe-spot book on the way out; the fake needs both halves.
  ap.book = { get: () => null, save: () => {} };
  ap.note = () => {};
  ap.travelGuard = () => guard ?? { safe_spot: true, flee: true, fight_back: true,
                                    arm: true, rest: true };
  ap.suspendedJourney = null;
  return ap;
}

console.log('\ngoTravelling is what hands the mover its shelters');
{
  const ap = keeper();
  ok('nothing is set before a journey', ap.s.shelterPolicy === null);
  ap.goTravelling('travelling to 110', { to: 110 });
  ok('and a journey installs it', !!ap.s.shelterPolicy,
     JSON.stringify(ap.s.shelterPolicy));
  ok('...carrying the book the walls are read from', !!ap.s.shelterPolicy?.book);
  ok('...and a detour ceiling', ap.s.shelterPolicy?.maxDetour !== undefined);
}

console.log('\nthe guard decides whether shelters are offered at all');
{
  // `travel_guard.safe_spot` is switchable live per character. A trip that has turned
  // sheltering off must not get it back through this path.
  const ap = keeper({ guard: { safe_spot: false, flee: true, fight_back: true,
                               arm: true, rest: true } });
  ap.goTravelling('travelling to 110', { to: 110 });
  ok('safe_spot off means no shelter policy', !ap.s.shelterPolicy);
}

console.log('\nthe keeper\'s OWN travel installs the posture, which is the whole fix');
{
  // Source-level: the wiring is inside `Autopilot.travel`, which is a 250-line method whose
  // real body needs a live session. What is pinned is that the install, the re-assertion and
  // the ownership-checked handback are all present and in the right order — the failure this
  // guards is somebody removing one of the three.
  const at = AP.indexOf('  async travel(room, opts)');
  const body = AP.slice(at, AP.indexOf('\n  async ', at + 10));
  ok('it installs the travelling posture',
     /this\.goTravelling\(`travelling to \$\{room\}`, \{ to: room \}\)/.test(body));
  ok('...only when nothing already holds the keeper', /if \(!this\.inert\) \{/.test(body));
  ok('...remembering whether the hold is OURS', /ourTravelHold = this\.inert/.test(body));
  ok('...re-asserting it, because an inert keeper wakes on a deadline',
     /setInterval\(/.test(body) && /2000\)/.test(body));
  ok('...and handing it back only if it is still ours',
     /if \(ourTravelHold && this\.inert === ourTravelHold\)/.test(body));
  ok('...clearing the timer whatever happens', /if \(holdTimer\) clearInterval\(holdTimer\)/.test(body));
  // ORDER: the handback must be in the `finally`, or a journey that throws leaves the keeper
  // silenced until INERT_MAX_MS lapses.
  ok('the handback is in the finally, not after the happy path',
     body.indexOf('} finally {') < body.indexOf('this.inert === ourTravelHold'));
}

console.log('\nnesting under the external journey path is a no-op, not a double hold');
{
  // `travelJob` installs the posture and then calls this method. Taking it twice, or
  // reviving somebody else's hold, is how a character ends up driven by two things at once.
  const ap = keeper({ inert: { travelling: true, why: 'travelJob has it' } });
  const before = ap.inert;
  ap.goTravelling('travelling to 110', { to: 110 });
  ok('an existing journey hold is left exactly as it was', ap.inert === before);
  // AND AN ERRAND OUTRANKS A JOURNEY. An errand asked for silence and got it; a journey
  // does not get to quietly upgrade itself into one.
  const e = keeper({ inert: { why: 'an errand has it' } });
  const eBefore = e.inert;
  e.goTravelling('travelling to 110', { to: 110 });
  ok('an errand hold is not upgraded either', e.inert === eBefore);
  ok('...and no shelter policy is installed under an errand', e.s.shelterPolicy === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
