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
import { fallenBy, airTime, reachFor, maxSpan, maxSpanDiscrete, spanBracket,
         jumpConfidence, heightAfter,
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


console.log('\nTHE FALL HAPPENS FIRST, and assuming otherwise flatters every candidate');
{
  // statgame.c:388-389 — AnimationTimerProc (the fall) then HandleKeys (the move). The first
  // version of the module had this backwards and it moved jump 3 from "too close to call" to
  // "clears comfortably" — the one candidate it was ever asked about.
  const b = spanBracket(384, { dt: 16 });
  ok('a bracket is two numbers, not one', b.lo < b.hi);
  ok('and one frame of horizontal wide', b.hi - b.lo === 81,
     `dt=16 advances 27*3 = 81 units a frame (move.c:266,268)`);
  ok('maxSpanDiscrete is the LOWER edge — the last position known legal',
     maxSpanDiscrete(384, { dt: 16 }) === b.lo);
  ok('a bigger drop brackets further out', spanBracket(2048).lo > spanBracket(384).lo);
  ok('nothing to reach with no height to give', spanBracket(-MAX_STEP_HEIGHT).hi === 0);
}

console.log('\nROOM 27 JUMP 3 IS UNDECIDABLE FROM ARITHMETIC, AND THAT IS THE FINDING');
{
  const c = jumpConfidence(384, 2202);
  ok('it does not clear at every frame rate', !c.clears);
  ok('and it does not fail at every frame rate', !c.fails);
  ok('SO IT NEEDS A BODY', c.needsBody,
     '2202 lands inside the bracket at 8, 16, 33, 66 and 100ms — the client’s own ' +
     'quantisation is wider than the margin, so no amount of further arithmetic settles it');
  ok('and the verdict says so in words', /cannot decide/.test(c.verdict));

  // The two things that ARE decided, and they are what the fix rests on.
  ok('the OLD cap missed it by 666 units, which is 0.65 squares and not a rounding question',
     2202 - 1024 * 1.5 === 666);
  ok('a hop well inside every bracket clears outright', jumpConfidence(384, 1900).clears);
  ok('and one well outside every bracket is refused outright',
     jumpConfidence(384, 4000).fails);
}

console.log('\nthe closed form has NO clean relation to the bracket — the old claim is withdrawn');
{
  // An earlier version asserted "conservative lower bound up to a drop of ~3517". That was
  // measured with the ordering backwards. With it right, the closed form sits below the
  // bracket at some drops, inside it at others, and above it for long falls.
  const rel = drop => {
    const b = spanBracket(drop, { dt: 8 }), c = maxSpan(drop);
    return c < b.lo ? 'below' : c > b.hi ? 'above' : 'inside';
  };
  ok('below the bracket at a 1024 drop', rel(1024) === 'below');
  ok('INSIDE it at a 384 drop', rel(384) === 'inside');
  ok('and ABOVE it for a long fall', rel(10240) === 'above',
     'so there is no drop below which maxSpan is guaranteed conservative');
  ok('which is why maxSpan stays the planner gate and the bracket is only a tie-break',
     maxSpan(384) > spanBracket(384, { dt: 8 }).lo - 1024 &&
     maxSpan(384) < spanBracket(384, { dt: 8 }).hi + 1024,
     'it is a stable frame-rate-free number in the right neighbourhood, which is what a ' +
     'proposer wants');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
