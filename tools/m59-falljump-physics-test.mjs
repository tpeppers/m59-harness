#!/usr/bin/env node
// DOES THE FALL RULE EVER REFUSE A HOP THE CLIENT WOULD ALLOW?
//
//   node tools/m59-falljump-physics-test.mjs
//
// Offline. No map, no bake, no socket — this is arithmetic with citations, so it says the same
// thing on a fresh clone as on the machine that runs the fleet.
//
// WHAT IT PINS. A jump candidate this arithmetic refuses is a gap nobody ever learns is
// crossable, and that failure is SILENT — the tool simply offers one fewer route and the room
// reads as severed. Room 27's mana node was called unreachable by four separate measurements
// and BASELINE.md concluded no declaration could ever fix it; the only thing wrong was the cap.
import { fallenBy, airTime, reachFor, maxSpan, maxSpanDiscrete, heightAfter,
         FALL_V0, GRAVITY, RUN_SPEED, WALK_SPEED, MAX_STEP_HEIGHT, CLIENT_FINENESS as F }
  from './m59-falljump-physics.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

console.log('\nthe four constants, against their sites in the client');
{
  ok('FALL_VELOCITY_0 is FINENESS*2/3 = 682.67 (move.h:17)', near(FALL_V0, 682.67, 0.01));
  ok('GRAVITY_ACCELERATION is 5*FINENESS = 5120 (moveobj.h:15)', GRAVITY === 5120);
  ok('a run is 5 squares a second (move.c:184,49)', RUN_SPEED === 5 * F && RUN_SPEED === 5120);
  ok('a walk is half that (move.c:187)', WALK_SPEED === 2560);
  ok('the step limit is 384 client units', MAX_STEP_HEIGHT === 384);
}

console.log('\nA BODY LEAVING A LEDGE IS ALREADY FALLING — there is no jump button');
{
  ok('it is moving downward immediately', fallenBy(0.001) > 0,
     'FALL_VELOCITY_0 is negative in the client: you do not rise at all');
  ok('after a tenth of a second it has fallen 94 units', near(fallenBy(0.1), 94, 1));
  ok('and the fall accelerates', fallenBy(0.4) - fallenBy(0.3) > fallenBy(0.2) - fallenBy(0.1));
  ok('airTime inverts fallenBy', near(fallenBy(airTime(2048)), 2048, 0.01));
  ok('a rise has no air time', airTime(-500) === 0);
  ok('and a level line has none either', airTime(0) === 0);
}

console.log('\nthe reach table, from the source arithmetic');
{
  // Horizontal distance covered before falling a given amount, at a run.
  const table = [[384, 1415], [1024, 2627], [2048, 3947], [3072, 4967], [6144, 7279]];
  for (const [drop, span] of table)
    ok(`a ${drop}-unit drop carries ${span} client units`, near(reachFor(drop), span, 3),
       `got ${Math.round(reachFor(drop))}`);
  ok('a walk carries exactly half as far', near(reachFor(2048, WALK_SPEED), reachFor(2048) / 2, 0.01));
}

console.log('\nTHE LANDING RULE IS ONE EXPRESSION, and the level reach is 1.38 squares');
{
  ok('at dead level a run carries 1.38 squares, not 1.5',
     near(maxSpan(0) / F, 1.38, 0.01), `got ${(maxSpan(0) / F).toFixed(3)}`);
  ok('which is 1415 client units, and the old cap allowed 1536', near(maxSpan(0), 1415, 2));
  ok('a landing ABOVE the take-off is legal at short range',
     maxSpan(-145) > F, 'at one square you may land +145 above where you left');
  ok('and impossible past the step limit', maxSpan(-MAX_STEP_HEIGHT) === 0,
     'you cannot arrive higher than one step, however short the hop');
  ok('a bigger drop always reaches further', maxSpan(2048) > maxSpan(1024));
  ok('maxSpan is reachFor(drop + step)', maxSpan(1000) === reachFor(1000 + MAX_STEP_HEIGHT));
}

console.log('\nTHE BRANCHED CAP THAT SHIPPED, pinned as the thing it was');
{
  // m59-jumpfinder.mjs and m59-fineroute.mjs both carried this, identically, until 2026-09-10.
  const shipped = (span, drop) => drop <= MAX_STEP_HEIGHT
    ? !(span > F * 1.5)
    : !(span > reachFor(drop) + F / 2);
  const truth = (span, drop) => !(span > maxSpan(drop));

  ok('at dead level the old cap was PERMISSIVE by 0.12 squares',
     shipped(1500, 0) && !truth(1500, 0),
     'F * 1.5 is 1536; the client stops at 1415, so a 1500-unit level hop was offered and is not real');
  ok('at a 384 drop it was RESTRICTIVE by 0.65 squares',
     !shipped(2000, 384) && truth(2000, 384),
     'a 2000-unit hop off a one-step ledge is legal and was refused');
  ok('and that is the half that hides routes', !shipped(2202, 384) && truth(2202, 384));

  // The exact jump that closed room 27: 25,44 -> 23,44, span 2202, drop 384.
  // Its margin under the CLOSED FORM is 1.57 units, which is thin enough to be worth
  // distrusting — so it is checked against the client's own integration below rather than
  // claimed from this number.
  ok('room 27 jump 3 is legal under the closed form, but only just',
     truth(2202, 384) && maxSpan(384) - 2202 < 5 && maxSpan(384) - 2202 > 0,
     `margin ${(maxSpan(384) - 2202).toFixed(2)}`);
  ok('and the old cap missed it by 666', !shipped(2202, 384) && (2202 - F * 1.5) === 666);

  ok('the two agree on a long fall, which is why nobody noticed',
     shipped(3100, 1024) === truth(3100, 1024));
}

console.log('\nheightAfter is the carried z a step predicate throws away');
{
  ok('at the take-off the body is at the take-off floor', heightAfter(5000, 0) === 5000);
  ok('one square out it has fallen 239 units', near(heightAfter(5000, F), 5000 - 239, 1));
  ok('and it keeps falling', heightAfter(5000, 3 * F) < heightAfter(5000, 2 * F));
}


console.log('\nthe CLIENT integrates forward Euler in integers, and that is not the closed form');
{
  // moveobj.c advances z with the velocity from the START of each frame, so an accelerating
  // fall is UNDER-counted: the body falls slower than the closed form and travels further.
  ok('the client reaches further than the closed form at a 384 drop',
     maxSpanDiscrete(384, { dt: 16 }) > maxSpan(384));
  ok('and at dead level too', maxSpanDiscrete(0, { dt: 16 }) > maxSpan(0));

  ok('ROOM 27 JUMP 3 CLEARS THE CLIENT\'S OWN ARITHMETIC BY OVER 30 UNITS, NOT 1.6',
     [8, 16, 33, 100].every(dt => maxSpanDiscrete(384, { dt }) - 2202 > 30),
     'the 1.57-unit margin is an artifact of the closed form, which is the conservative one');
  ok('and so do the other two room 27 drops',
     maxSpanDiscrete(1280, { dt: 8 }) > 3501 && maxSpanDiscrete(1536, { dt: 8 }) > 3804);

  // gravityAdjust exists to make the ARC frame-rate invariant; what moves with frame rate is
  // the Euler error, and it moves in the permissive direction at every rate.
  const across = [5, 8, 16, 33, 66, 100, 200].map(dt => maxSpanDiscrete(384, { dt }));
  ok('every frame rate from 5 to 200ms is more permissive than the closed form',
     across.every(v => v > maxSpan(384)),
     'so maxSpan never offers a short-drop jump the client would refuse');
  ok('and the spread across frame rates is small — under 200 units',
     Math.max(...across) - Math.min(...across) < 200);
}

console.log('\nwhere the closed form STOPS being conservative, so a long declaration is checked');
{
  ok('at a 3072 drop it is still conservative', maxSpanDiscrete(3072, { dt: 8 }) > maxSpan(3072));
  ok('BUT past ~3517 it over-reaches', maxSpanDiscrete(4096, { dt: 8 }) < maxSpan(4096),
     'a very long declared fall wants maxSpanDiscrete, not maxSpan');
  ok('and the over-reach stays under half a percent',
     (maxSpan(10240) - maxSpanDiscrete(10240, { dt: 8 })) / maxSpan(10240) < 0.005);
  ok('a zero-or-negative limit reaches nothing', maxSpanDiscrete(-MAX_STEP_HEIGHT) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
