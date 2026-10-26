#!/usr/bin/env node
import { readToolSource } from './autopilot/source.mjs';
// CAN AN OPERATOR ACTUALLY SET THE VIGOR FLOOR?
//
//   node tools/m59-vigorfloor-test.mjs
//
// Offline. Reads source and the local policy file; opens no socket, starts no broker.
//
// WHY THIS FILE EXISTS. `fight_above_vigor` is documented, schema'd, accepted by the
// broker, stored in the roster, and reported back by `autopilot status` — and for every
// value below 100 it did nothing at all. `fightFloor()` is
//
//     Math.max(MIN_FIGHT_VIGOR, p.vigorFloor ?? plan.vigorFloor ?? p.fightAboveVigor ?? 0)
//
// so a clamp silently raised it. The policy read back exactly what was set and the
// character behaved as though it had not been. That is the failure mode this repository
// keeps naming — a setting that reads as applied and changes nothing — and it had gone so
// far that substrate/policy.local.json carried a key called `why_the_floor_is_100`
// explaining that 80 was not settable, rather than the clamp being moved.
//
// Measured on prod 2026-08-28, before the change: eighteen of twenty characters reporting
// `cannot fight` against a floor of 100, ten consecutive half-hourly reports with zero
// toughers, and fleet max health falling 1,006 -> 930 as they died without ever engaging.
// The escape hatch only fires on an EMPTY larder, so a character holding one mushroom
// against a floor of 100 was deadlocked with food in its pack.
//
// THE LAW: 80 is REST_VIGOR_CAP x 200, exactly what resting alone delivers, so it is the
// highest floor a character can always reach unaided and the last one that cannot
// deadlock. A floor above it is a bet on the food chain and must remain expressible; a
// floor at or below it must be honoured rather than quietly raised.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_FIGHT_VIGOR as LOCAL_MIN } from './m59-localpolicy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const pilot = readToolSource(join(HERE, 'm59-autopilot.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

const keeperMin = (() => {
  const m = /const MIN_FIGHT_VIGOR = (\d+);/.exec(pilot);
  return m ? Number(m[1]) : null;
})();
const restCap = (() => {
  const m = /const REST_VIGOR_CAP = ([\d.]+);/.exec(pilot);
  return m ? Number(m[1]) : null;
})();

console.log('the clamp is at what resting can actually reach');
{
  ok('MIN_FIGHT_VIGOR is readable from the keeper', keeperMin != null, 'not found');
  ok('REST_VIGOR_CAP is readable', restCap != null, 'not found');
  // 0.4 of a 200 bar is 80. If the clamp sits above what resting delivers, then a fleet
  // whose larder is thin can never start a fight, which is the deadlock this pins.
  ok('and the clamp is no higher than resting alone delivers',
     keeperMin != null && restCap != null && keeperMin <= restCap * 200,
     `clamp ${keeperMin} vs resting ceiling ${restCap != null ? restCap * 200 : '?'}`);
  ok('specifically, it is 80', keeperMin === 80, `${keeperMin}`);
}

console.log('\nthe starvation hatch still sits below it');
{
  const starved = (() => {
    const m = /const STARVED_FIGHT_VIGOR = (\d+);/.exec(pilot);
    return m ? Number(m[1]) : null;
  })();
  // The hatch is the answer to an EMPTY larder. It has to stay strictly under the clamp,
  // or it stops being a relief valve and becomes the floor.
  ok('STARVED_FIGHT_VIGOR is still lower than the clamp',
     starved != null && keeperMin != null && starved < keeperMin,
     `starved ${starved} vs clamp ${keeperMin}`);
}

console.log('\nand the tool that WARNS about the clamp agrees with it');
{
  // A second copy of a number that moved. m59-localpolicy.mjs warned that a local 80
  // "will not lower it" — advice that was true before the clamp moved and is now exactly
  // backwards, which is worse than no warning: it talks an operator out of a setting that
  // works.
  ok('m59-localpolicy.mjs carries the same value', LOCAL_MIN === keeperMin,
     `localpolicy ${LOCAL_MIN} vs keeper ${keeperMin}`);
}

console.log('\nthe standing orders on disk are settable, not silently raised');
{
  const f = join(HERE, '..', 'substrate', 'policy.local.json');
  if (!existsSync(f)) {
    console.log('  (no local policy on this checkout — nothing to check)');
  } else {
    let j = null;
    try { j = JSON.parse(readToolSource(f, 'utf8')); } catch { j = null; }
    ok('the local policy parses', !!j, 'a file that will not parse is not an empty file');
    const floors = Object.entries(j?.blocks || {})
      .map(([name, b]) => [name, b?.fight_above_vigor])
      .filter(([, v]) => typeof v === 'number');
    ok('and it states a vigor floor', floors.length > 0);
    // The point of the whole change: every floor written here must survive the clamp.
    for (const [name, v] of floors)
      ok(`${name}'s floor of ${v} is honoured rather than raised`,
         keeperMin != null && v >= keeperMin,
         `${v} would be clamped up to ${keeperMin}`);
    // And the file should no longer be explaining why it cannot say what it means.
    ok('the file no longer documents 80 as unsettable',
       !Object.keys(j || {}).includes('why_the_floor_is_100'));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
