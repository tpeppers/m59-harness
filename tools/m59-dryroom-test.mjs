#!/usr/bin/env node
// A CHARACTER HUNTING SOMETHING THE ROOM DOES NOT MAKE — offline, no socket, no keeper.
//
//   node tools/m59-dryroom-test.mjs
//
// The state this pins was the commonest one in the fleet and the only one with no name.
// Measured on prod 2026-09-18 across sixty consecutive one-minute samples, spanning three
// configuration changes: **four to seven characters of twenty-three were hunting in a room that
// generates none of their quarry at EVERY sample**, and not one of the three changes moved that
// number. Mean characters per state, by window:
//
//     sell_at_load   fight  hunt  DRY-ROOM  hold  travel   kills/min
//     0.80            2.2    2.3     4.1     6.5    5.1       2.97
//     0.95            2.3    2.8     6.7     6.5    2.3       2.40
//     0.88            1.1    2.8     5.4     6.8    4.5       1.15
//
// Raising the town-trip trigger did exactly what it was meant to — travel 5.1 -> 2.3 — and the
// characters that stopped travelling went into DRY-ROOM rather than into fighting. `hunt` barely
// moved and `hold` did not move at all. The threshold only decided which unproductive state they
// sat in, which is what three missed predictions in a row were trying to say.
//
// It was invisible because `yieldCheck` audits the QUARRY against the character's own level and
// never asks whether the room contains it. So the board rendered `hunting: skeleton` for a
// character standing in a guild hall — the healthy string, identical to a character standing in
// a room with nine skeletons in it.
//
// This runs against the committed spawn index, on purpose: what is being pinned is that the check
// still answers correctly for the rooms this fleet is actually in.
import { loadSpawns, huntRoomYield } from './m59-spawns.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const spawns = loadSpawns(process.env.M59_SPAWN_FILE || join(REPO, 'substrate', 'm59-spawns.json'));

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

if (!spawns) {
  console.log('  NO   the spawn index is readable');
  process.exit(1);
}

console.log('\n1. THE SIX CHARACTERS THAT WERE STRANDED, AND THE ROOM EACH WAS STANDING IN');
{
  // Read live off the fleet at 13:40, every one of them assigned to 27, 38 or 39, and none of
  // them on a shopping trip. This is the case list, not an illustration.
  const stranded = [
    ['Zoot', 714, 'skeleton', 'the Bookmakers guild hall'],
    ['Scooter', 2, ['zombie', 'battered skeleton'], 'a town room'],
    ['Sweetums', 104, 'skeleton', 'one NPC and nothing else'],
    ['Piggy', 104, ['orc', 'spider'], 'the same room, a different order'],
    ['Statler', 578, 'skeleton', 'the Cragged Mountains: black spiders and trolls'],
    ['Rizzo', 376, ['zombie', 'battered skeleton'], 'the Sewers'],
  ];
  for (const [who, room, hunt, what] of stranded) {
    const r = huntRoomYield(spawns, room, hunt, { standingHere: true });
    ok(`${who} in ${room} (${what}) reads DRY`, r?.dry === true, r?.why?.slice(0, 64));
  }
}

console.log('\n2. AND THE STATIONS THEY WERE SUPPOSED TO BE IN DO NOT');
{
  // The other half of the claim, and the half that makes it usable: a check that fired on the
  // farm rooms too would be noise, and would be switched off inside a week.
  const home = [
    [38, 'skeleton'], [39, ['zombie', 'battered skeleton']], [27, ['orc', 'spider']],
    [39, 'zombie'], [39, 'battered skeleton'], [27, 'spider'], [27, 'orc'],
  ];
  for (const [room, hunt] of home) {
    const r = huntRoomYield(spawns, room, hunt, { standingHere: true });
    ok(`room ${room} hunting ${Array.isArray(hunt) ? hunt.join('/') : hunt} is NOT dry`,
       r?.dry === false, (r?.matched ?? []).join(', '));
  }
  // A two-generator room satisfies an order naming EITHER, because the list is a set of
  // acceptable answers rather than a preference order — see huntNames.
  const half = huntRoomYield(spawns, 39, ['battered skeleton', 'ogre'], { standingHere: true });
  ok('one match out of two is enough', half?.dry === false, (half?.matched ?? []).join(', '));
}

console.log('\n3. AN UNINDEXED ROOM IS ONLY AN ANSWER WHEN SOMEBODY IS STANDING IN IT');
{
  // The index holds 183 rooms and NONE has an empty generator list, so an absent room either
  // makes nothing or is not a room. Guessing would flag every character shopping in a town.
  const away = huntRoomYield(spawns, 714, 'skeleton');
  ok('asked ABOUT room 714 from elsewhere: null, not a guess', away?.dry === null);
  ok('...and it says which question it could not answer',
     /not a room|nobody is standing/.test(away?.why ?? ''), away?.why?.slice(0, 70));
  ok('...and records that the room is unindexed', away?.indexed === false);

  const here = huntRoomYield(spawns, 714, 'skeleton', { standingHere: true });
  ok('standing IN 714: dry, because the body proves the room exists', here?.dry === true);
  ok('...and it says so rather than citing missing data',
     /makes nothing/.test(here?.why ?? ''), here?.why?.slice(0, 70));
  ok('...with an empty generator list, not a null one', Array.isArray(here?.generates) && here.generates.length === 0);

  // A room number that is not a room reads the same way from outside, which is the honest answer.
  ok('a nonsense room asked about is null', huntRoomYield(spawns, 999999, 'skeleton')?.dry === null);
}

console.log('\n4. NO ORDER, NOTHING TO BE DRY ABOUT');
{
  ok('a null hunt list answers null', huntRoomYield(spawns, 38, null) === null);
  ok('an empty hunt list answers null', huntRoomYield(spawns, 38, []) === null);
  ok('a list of empty strings answers null', huntRoomYield(spawns, 38, ['', '  ']) === null);
  // A room with generators and an unmatched order is dry, and must name what IS there — the
  // remedy is always "hunt this instead" or "go there instead", and both need the room's list.
  const r = huntRoomYield(spawns, 578, 'skeleton', { standingHere: true });
  ok('a dry indexed room names what it DOES generate',
     (r?.generates ?? []).length > 0 && r.why.includes(r.generates[0]), (r?.generates ?? []).join(', '));
  ok('...and names the quarry it cannot supply', /skeleton/.test(r?.why ?? ''));
  ok('...and is marked indexed, unlike an absent room', r?.indexed === true);
}

console.log('\n5. THE FIELD NAMES A CALLER ACTS ON');
{
  const r = huntRoomYield(spawns, 104, ['orc', 'spider'], { standingHere: true });
  ok('carries the room it judged', r?.room === 104);
  ok('carries the order it judged', JSON.stringify(r?.hunting) === JSON.stringify(['orc', 'spider']));
  ok('carries an empty match list rather than omitting it', Array.isArray(r?.matched) && r.matched.length === 0);
  // The savelog bug's shape: a breakdown read off the wrong field is empty while the totals are
  // right, and nothing anywhere says so. `generates` must be the creature NAMES.
  ok('generates holds names, not objects', (r?.generates ?? []).every(x => typeof x === 'string'),
     (r?.generates ?? []).join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
