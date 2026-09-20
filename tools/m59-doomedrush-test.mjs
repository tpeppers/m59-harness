#!/usr/bin/env node
// THE DOOMED CHARACTER THAT STOOD STILL: run to the nearest wall, THEN freeze.
//
//   node tools/m59-doomedrush-test.mjs
//
// Offline. No socket, no roster, no temp files — the throttle is exercised directly and the
// call site is linted out of the source, which is the same shape as m59-rts-authority-test.
//
// ======================== WHAT THIS PINS, AND WHY IT EXISTS ========================
//
// THE HOLE. `playDead` refuses outright in the open against monsters — 2026-09-18, "it will not
// save you from monsters" — and its refusal note promises that "the ladder falls through to
// something that MOVES". That was true for a TRAVELLING character, whose travel guard has
// shelter rungs. It was true of nothing for a character standing in a farm room: the doomed rung
// in `passFleeAndRest` noted and fell through, the rest gate below refuses to rest in the open,
// and `continueSurvivalDecision` — which the refusal's own comment says "drains this replacement
// in the current pass" — is never called anywhere in `passFleeAndRest`.
//
// Measured on prod across the 36 deaths of 2026-09-19/20: 36/36 `was.moving: false`, 35/36 at or
// below a quarter of health, 36/36 `fled_in_time` under 0.25 against a ~0.68 threshold, and 19/36
// `doing: "stalled"` — not travelling, so never covered by the travel guard's emergency, which
// was the only place `doomedInOpenBelow` had teeth.
//
// Operator, 2026-09-20: "the fix imho is to move to the nearest safe spot and then play dead."
//
// So the two properties below are the whole repair and both are easy to lose in a later edit:
//
//   1. THE RUSH COMES FIRST AND THE FREEZE STILL HAPPENS. A `return` between them would strand
//      the character at a wall it never used — the freeze, the turn and the heal are the other
//      half of the sequence, and the wall alone heals nothing. The vigor rung further down this
//      same method carries that correction in its own words after it deadlocked characters.
//
//   2. THE RUSH IS BOUNDED PER ROOM. The doomed rung fires every pass while health is low and
//      the rush is a WALK, not a test; unbounded, a room with no reachable wall becomes a
//      treadmill that re-walks and re-fails while the freeze below it never gets asked.
import { readFileSync } from 'node:fs';
import { Autopilot } from './m59-autopilot.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  ' + extra : ''}`); }
};

const SRC = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');

console.log('');
console.log('the throttle: one wall-rush per room per window');
{
  // The helpers are pure state on the instance, so they can be exercised without a world.
  const a = Object.create(Autopilot.prototype);
  a.policy = {};

  ok('a room that has never been rushed is not throttled', a.spotRushedAt(39) === false);
  a.noteSpotRush(39);
  ok('and is throttled immediately after a rush', a.spotRushedAt(39) === true);
  // KEYED ON THE ROOM. Walking into a new room is a new emergency and always gets an attempt.
  ok('a different room is never throttled by another room\'s rush', a.spotRushedAt(599) === false);

  // The window is short on purpose: a room whose occupancy changed may offer a wall it could
  // not twenty seconds ago.
  a.spotRush = { room: 39, at: Date.now() - 21_000 };
  ok('the throttle lapses once the window is past', a.spotRushedAt(39) === false);
  a.policy = { doomedSpotRetryMs: 60_000 };
  a.spotRush = { room: 39, at: Date.now() - 21_000 };
  ok('and the window is a policy knob', a.spotRushedAt(39) === true);

  // A null room must not collide with a real one — an unreadable room is its own bucket, not
  // room 0 and not "every room".
  a.policy = {};
  a.noteSpotRush(null);
  ok('an unreadable room throttles only itself', a.spotRushedAt(null) === true && a.spotRushedAt(39) === false);
}

console.log('');
console.log('the call site: rush BEFORE the freeze, and do not return between them');
{
  // Slice out the doomed branch of passFleeAndRest.
  const start = SRC.indexOf('if (doomed && this.policy.panicLogoff !== false) {');
  ok('the doomed branch is present', start > 0);
  const end = SRC.indexOf('// AND THE SAME ANSWER, EARLIER', start);
  ok('and its extent could be found', end > start);
  const branch = SRC.slice(start, end);

  const rushAt = branch.indexOf('takeSafeSpot');
  const freezeAt = branch.indexOf('this.playDead(');
  ok('the branch rushes for a wall', rushAt > 0);
  ok('and still freezes', freezeAt > 0);
  // THE ORDERING IS THE REPAIR. Freezing first is the behaviour that was killing characters.
  ok('and the rush comes FIRST — the freeze is refused in the open', rushAt < freezeAt,
     `rush@${rushAt} freeze@${freezeAt}`);

  // NO RETURN BETWEEN THEM. This is the strand hazard, and it is the one a later edit will
  // reintroduce because returning after a successful move looks obviously right.
  const between = branch.slice(rushAt, freezeAt);
  ok('nothing returns between the rush and the freeze',
     !/\breturn\b/.test(between), between.match(/\breturn\b.*/)?.[0] ?? '');

  // It must ask for the NEAREST wall — the operator said nearest, and a far wall is the town
  // run that was overturned on 2026-09-10 wearing a different hat.
  ok('the rush asks for the nearest wall', /nearestOnly:\s*true/.test(branch));
  // And it must be throttled, or the emergency becomes a treadmill.
  ok('the rush is throttled per room', /spotRushedAt/.test(branch) && /noteSpotRush/.test(branch));
  // A throw inside the rush must not skip the freeze.
  ok('a failing rush cannot take the freeze down with it', /\.catch\(/.test(branch.slice(rushAt, freezeAt)));
  // It is gated on not already having a wall — rushing from a wall we already hold is a loop.
  ok('it only rushes when there is no wall here already', /currentRecoveryWall\(\)/.test(branch));
}

console.log('');
console.log('the threshold is the one the operator named');
{
  const start = SRC.indexOf('const doomedAt = Math.round(');
  const decl = SRC.slice(start, start + 320);
  ok('doomedInOpenBelow still governs the open case', /doomedInOpenBelow/.test(decl));
  ok('and doomedInSpotBelow the sheltered one', /doomedInSpotBelow/.test(decl));
  ok('both still default to 0.3', (decl.match(/\?\?\s*0\.3/g) ?? []).length === 2);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
