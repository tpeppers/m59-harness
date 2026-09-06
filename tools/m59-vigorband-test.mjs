#!/usr/bin/env node
// THE VIGOR BAND: A FLOOR TO START A FIGHT, A CEILING TO EAT TO, AND THEY ARE NOT THE SAME.
//
//   node tools/m59-vigorband-test.mjs      # offline, opens no socket, touches no roster
//
// The operator's word for this is "turbo": the ceiling stays at 200 whatever the floor is,
// so "0.8 turbo" is a band of 160..200 and "0.4 turbo" is 80..200. The keeper has always
// worked that way — `applyFightAboveVigor` sets the floor and leaves the ceiling alone, and
// the comment beside it argues why at length: health returns as ((200-vigor)^2/6 + 1000) ms
// a point, 1.0 hp/s at 200 against 0.29 at 80, so a character pinned AT its floor throws
// away the regeneration it just paid food for.
//
// WHAT WAS MISSING WAS THE ABILITY TO SAY IT. The ceiling could only be inherited from the
// selected strategy plan, so on prod every one of 21 rows reported `vigorCeiling: undefined`
// while every character was in fact eating to 200 — a band nobody had declared and nothing
// reported. And ten of those characters were at floor 200 against that same ceiling, which
// is the degenerate case: they must be at exactly full to swing, and drop out of the fight
// on the first tick of vigor burn.

import { applyFightAboveVigor, reachableFightFloor } from './m59-autopilot.mjs';
import { readFileSync } from 'node:fs';

const BROKER = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  — ' + extra : '')); }
};

console.log('\nthe floor does not touch the ceiling — that IS turbo');
{
  const p = {};
  applyFightAboveVigor(p, 160);
  ok('0.8 turbo sets the floor to 160', p.vigorFloor === 160 && p.fightAboveVigor === 160);
  ok('...and leaves the ceiling alone, so the band stays open to 200',
     p.vigorCeiling === undefined, JSON.stringify(p));
  const q = { vigorCeiling: 200 };
  applyFightAboveVigor(q, 80);
  ok('0.4 turbo is 80..200 and the ceiling survives it',
     q.vigorFloor === 80 && q.vigorCeiling === 200);
  // The range is checked, because a floor above the bar is a deadlock and a negative one is
  // a typo that would read as "always fight".
  for (const bad of [-1, 201, NaN, 'lots']) {
    let threw = false;
    try { applyFightAboveVigor({}, bad); } catch { threw = true; }
    ok(`refuses a floor of ${JSON.stringify(bad)}`, threw);
  }
}

console.log('\nthe ceiling is declarable now, and refuses the one value that deadlocks');
{
  ok('the tool takes vigor_ceiling', /vigor_ceiling: \{ type: 'number', minimum: 0, maximum: 200/.test(BROKER));
  ok('and applies it to the policy the eat loop reads', BROKER.includes('p.policy.vigorCeiling = ceiling;'));
  // A CEILING BELOW THE FLOOR IS NOT A TIGHT BAND, IT IS A CHARACTER THAT MUST EAT DOWNWARDS.
  // There is no such action, so it would idle for ever while every call reported success —
  // which is the failure this repository keeps paying for.
  ok('it refuses a ceiling below the floor',
     BROKER.includes('is below the fighting floor'));
  ok('...and says why rather than clamping silently',
     BROKER.includes('a character cannot eat downwards'));
  // ORDER MATTERS: the floor is applied first, so a caller sending both gets the band it
  // asked for rather than whichever argument the object happened to enumerate last.
  const floorAt = BROKER.indexOf('applyFightAboveVigor(p.policy, a.fight_above_vigor)');
  const ceilAt = BROKER.indexOf('if (a.vigor_ceiling !== undefined)');
  ok('the floor is applied before the ceiling is checked against it',
     floorAt > 0 && ceilAt > floorAt, `floor@${floorAt} ceiling@${ceilAt}`);
}

console.log('\nthe board can be asked what band a character is on');
{
  ok('vigor_floor is reported', BROKER.includes('vigor_floor: st?.policy?.vigorFloor'));
  ok('vigor_ceiling is reported', BROKER.includes('vigor_ceiling: st?.policy?.vigorCeiling'));
  // `vigor_target` has meant `fightAboveVigor` since it existed and readers are built on it.
  // The name is wrong — it is the floor, not a target — and the NUMBER stays put anyway,
  // because renaming a field readers depend on to fix a word is the more expensive mistake.
  ok('and vigor_target keeps meaning exactly what it always did',
     BROKER.includes('vigor_target: st?.policy?.fightAboveVigor || null'));
}

console.log('\nand the safety net is still under all of it');
{
  // reachableFightFloor is the KEEPER's one-second guard: a floor above what resting plus
  // the pack can deliver is a number no action can satisfy. Turbo raises the policy floor;
  // it must never let the policy outrun what the character can actually eat to.
  ok('a 160 floor with an empty larder falls back to the resting cap',
     reachableFightFloor(160, 200, 0) === 80);
  ok('...and rises with what is actually in the pack',
     reachableFightFloor(160, 200, 50) === 130);
  ok('a floor already low enough is never raised',
     reachableFightFloor(60, 200, 500) === 60);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
