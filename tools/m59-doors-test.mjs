#!/usr/bin/env node
// THE DOORS YOU OPERATE — offline, and against the real kod when it is here.
//
//   node tools/m59-doors-test.mjs
//
// What this pins is the difference between a door table that is nearly right and one that is
// usable. A near-complete table is worse than none: the first version of `m59-doors.mjs` found
// five of room 714's six doors and missed MAIN_DOOR, which is the only one the hall's exit is
// behind — the table would have described the Bookmaker's Guild House perfectly and still left
// every character in it stranded.
import { readFileSync, existsSync } from 'node:fs';
import { parseConstants, otherEnd, sectorHeights, doorsFor } from './m59-doors.mjs';

let pass = 0, fail = 0, skip = 0;
const ok = (what, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (detail ? ' — ' + detail : '')); }
};
const skipped = (what, why) => { skip++; console.log('  --   ' + what + ' — ' + why); };

// ---------------------------------------------------------------- the pure parts
console.log('\nreading constants out of a class');
{
  const c = parseConstants('constants:\n\n   MAIN_DOOR  = 59\n   MAIN_DOOR_OPEN = 190\n   DOOR_DELAY = 5000\n');
  ok('a constant is read', c.get('MAIN_DOOR') === 59);
  ok('extra spaces before the = do not hide it', c.get('MAIN_DOOR_OPEN') === 190);
  // KOD IS CASE-INSENSITIVE. A table keyed on the canonical spelling is the bug that hid the
  // Temple of Qor's two entrances; the same mistake here would hide a door.
  const lower = parseConstants('   main_door = 59\n');
  ok('a lower-case constant answers to the upper-case name', lower.get('MAIN_DOOR') === 59);
}

console.log('\nfinding the other end of a door\'s swing');
{
  const c = new Map([['X_CLOSED', 100], ['Y_DOWN', 0], ['Y_UP', 115]]);
  ok('by the _CLOSED convention', otherEnd(c, 'X', 190).height === 100);
  ok('by the _DOWN convention, for a lift', otherEnd(c, 'Y', 115).height === 0);
  // THE FACT BEATS THE HABIT. guildh10 writes literal heights and names no constant at all.
  ok('by reading the sector\'s other SetSector, which needs no naming convention',
     otherEnd(new Map(), 'Z', 72, new Set([72, 0])).height === 0);
  ok('and that path is preferred over the convention',
     otherEnd(c, 'X', 190, new Set([190, 42])).height === 42);
  ok('an unknown door reports nothing rather than guessing',
     otherEnd(new Map(), 'Q', 5).height === null);
  // A guard that cannot read its input has not passed.
  const amb = otherEnd(new Map(), 'Q', 5, new Set([5, 1, 2]));
  ok('three heights is not a door this understands, and it says so',
     amb.height === null && Array.isArray(amb.ambiguous) && amb.ambiguous.length === 2);
}

console.log('\nevery height a sector is ever set to');
{
  const src = 'send(self,@setsector,#sector=D,#animation=ANIMATE_CEILING_LIFT,#height = 72,#speed=50);\n' +
              'send(self,@setsector,#sector=D,#animation=ANIMATE_CEILING_LIFT,#height = 0,#speed=50);\n';
  const h = sectorHeights(src, new Map([['D', 6]]));
  ok('both ends are collected for the sector', h.get(6)?.size === 2);
  ok('and they are the literal heights', [...h.get(6)].sort((a, b) => a - b).join(',') === '0,72');
}

// ---------------------------------------------------------------- against the real kod
const KOD = process.env.M59_KOD || 'C:/code/meridian59/kod';
const hall = KOD + '/object/active/holder/room/ghall/guildh14.kod';
const hall10 = KOD + '/object/active/holder/room/ghall/guildh10.kod';

console.log('\nroom 714, The Bookmaker\'s Guild House');
if (!existsSync(hall)) skipped('714 from the kod', 'no Meridian 59 source at ' + KOD);
else {
  const doors = doorsFor(readFileSync(hall, 'utf8'));
  const by = new Map(doors.map(d => [d.sector, d]));
  ok('all six doors are found', doors.length === 6, String(doors.length));

  // THE ONE THAT MATTERS. Its SetSector is not in the trigger branch — the branch reads
  // `if ReqLegalEntry { send(self,@OpenEntranceDoor) }` — so finding it proves the extractor
  // follows one level of indirection. Without it the table has every door but the exit.
  const main = by.get(59);
  ok('MAIN_DOOR (59) is among them, through OpenEntranceDoor', !!main && main.opened_via);
  ok('and it is the ceiling door that swings 100 -> 190',
     main?.kind === 'ceiling' && main?.closed === 100 && main?.open === 190);
  ok('it shuts itself after 5 seconds, timed from the PRESS', main?.delay_ms === 5000);
  ok('and it refuses anyone ReqLegalEntry refuses', main?.gate === 'ReqLegalEntry');

  // `when` is WHERE YOU STAND (user.kod sends piRow/piCol), not where you are heading. This is
  // the square Zoot and Statler were standing on, not pressing, on 2026-09-19.
  const eq = (d, axis) => d.when.filter(c => c.axis === axis && c.op === '==')
    .flatMap(c => Array.isArray(c.values) ? c.values : [c.value]);
  ok('you work it from r4c28 — the square the stranded characters were standing on',
     eq(main, 'row').join() === '4' && eq(main, 'col').join() === '28');

  // Same-axis equalities are ALTERNATIVES: `(row=18 and col=10) or (row=19 and col=10)`.
  const hallDoor = by.get(55);
  ok('HALL_DOOR (55) is worked from either of two rows, as an OR and not an impossibility',
     eq(hallDoor, 'row').sort().join() === '18,19' && eq(hallDoor, 'col').join() === '10');

  const inner = by.get(53);
  ok('INNER_DOOR (53) keeps its range as a range',
     inner.when.some(c => c.axis === 'row' && c.op === '>=' && c.value === 11) &&
     inner.when.some(c => c.axis === 'row' && c.op === '<=' && c.value === 13));

  ok('the two lifts are members-only, and say so',
     by.get(83)?.gate === 'IsMember' && by.get(84)?.gate === 'IsMember');
  ok('and they are floors, not ceilings',
     by.get(83)?.kind === 'floor' && by.get(84)?.kind === 'floor');
  ok('every door of this hall carries both heights, so a state can be baked for each',
     doors.every(d => d.open != null && d.closed != null));
}

console.log('\na hall that writes literal heights instead of constants');
if (!existsSync(hall10)) skipped('710 from the kod', 'no Meridian 59 source at ' + KOD);
else {
  const doors = doorsFor(readFileSync(hall10, 'utf8'));
  const north = doors.find(d => d.sector_name === 'NORTH_DOOR');
  ok('NORTH_DOOR is found at all', !!north);
  // guildh10 names no NORTH_DOOR_OPEN or _CLOSED; both heights are literals in the calls.
  ok('and both its heights are read from the calls themselves',
     north?.open === 72 && north?.closed === 0,
     JSON.stringify({ open: north?.open, closed: north?.closed }));
}

// ---------------------------------------------------------------- against the hand-written one
console.log('\nthe derived table agrees with the hand-written one it replaces');
if (!existsSync(hall)) skipped('agreement with m59-guild-passage', 'no kod');
else {
  const { doors: handWritten } = await import('./m59-guild-passage.mjs');
  const derived = new Map(doorsFor(readFileSync(hall, 'utf8')).map(d => [d.sector, d]));
  // `guildPassage` models the doors BETWEEN its five sections. It omits the counter door and
  // the two lifts (not on a section boundary) and adds sector 3, the secret door — which is
  // opened by saying a password, not by a `go`, so `SomethingTryGo` cannot know about it.
  for (const h of handWritten.filter(d => !d.secret))
    ok(`sector ${h.sector} is in both tables`, derived.has(h.sector));
  ok('the secret door is NOT derived, because it is not opened by a go',
     !derived.has(3) && handWritten.some(d => d.sector === 3 && d.secret));
  ok('and the derived table adds the three guildPassage does not model',
     [58, 83, 84].every(s => derived.has(s)));
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
