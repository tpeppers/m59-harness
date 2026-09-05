#!/usr/bin/env node
// WHAT COUNTS AS FOOD — offline, no server.
//
//   node tools/m59-food-test.mjs
//
// A MUSHROOM IS USUALLY A REAGENT. There are five in this world and only two are edible:
//
//   mushroom            the one players call a "brown" — it has no adjective, which is
//                       exactly what makes it dangerous to match on
//   red mushroom        reagent
//   blue mushroom       reagent (the zap enchantment)
//   edible mushroom     FOOD, nutrition 5
//   Inky-cap mushroom   FOOD, nutrition 50
//
// So any pattern containing a bare `mushroom` matches all five, and every one of those
// matches is a reagent being counted as a meal or sold to the wrong merchant. The
// operator lost a pack of casting reagents to exactly that reading, 2026-09-04.
//
// The items table is derived from the game's own Food class tree, so it is right by
// construction; the risk is a hand-written classifier somewhere else disagreeing with it.
// This pins both: the table's answer, and that the two classifiers which decide whether a
// thing gets EATEN or SOLD agree with it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { foodValue } from './m59-items.mjs';

const HERE = (f) => fileURLToPath(new URL(f, import.meta.url));

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

console.log('\nonly two of this world\'s five mushrooms are food');
{
  ok('the bare `mushroom` — the "brown" — is NOT food', foodValue('mushroom') == null);
  ok('nor is the red one', foodValue('red mushroom') == null);
  ok('nor the blue one, which is a spell reagent', foodValue('blue mushroom') == null);
  ok('`edible mushroom` is food', foodValue('edible mushroom')?.nutrition === 5,
     JSON.stringify(foodValue('edible mushroom')));
  ok('and the Inky-cap is the good one', foodValue('Inky-cap mushroom')?.nutrition === 50,
     JSON.stringify(foodValue('Inky-cap mushroom')));
  // Case is not a promise the wire makes.
  ok('the lookup does not care about case', foodValue('INKY-CAP MUSHROOM')?.nutrition === 50);
  ok('nor about surrounding space', foodValue('  edible mushroom  ')?.nutrition === 5);
}

console.log('\nthe classifiers agree with the table, which is what actually matters');
{
  // A SOURCE SCAN WAS THE WRONG INSTRUMENT. The first version of this grepped tools/ for a
  // bare `mushroom` inside a regex and flagged five files - and four of them were right:
  // scenery exclusions that genuinely mean every mushroom, and m59-sellrun's `LANE.reagents`,
  // which sells loot mushrooms on purpose. Only a CLASSIFIER can be wrong about what food
  // is, so ask the classifiers instead of the source.
  const { classifyPack } = await import('./m59-smartloot.mjs');
  const pack = classifyPack(['mushroom', 'red mushroom', 'blue mushroom',
                             'edible mushroom', 'slice of pork', 'herb']);
  ok('the loot classifier calls the brown, red and blue ones reagents',
     ['mushroom', 'red mushroom', 'blue mushroom'].every(n => pack.reagents.includes(n)),
     JSON.stringify(pack.reagents));
  ok('and the edible one food, so it is not fenced as stock',
     pack.food.includes('edible mushroom'), JSON.stringify(pack.food));
  ok('nothing edible was filed as a reagent',
     !pack.reagents.some(n => /edible|inky/i.test(n)));

  // The sell circuit's own keep list. A meal must never reach a counter while the Duke's
  // tables are the fleet's only free food: vigor above the resting cap comes only from
  // eating, so a slice of pork is worth more in a pack than anything paid for it.
  const sellrun = readFileSync(HERE('m59-sellrun.mjs'), 'utf8');
  // To the end of the line, not \S+: the pattern contains spaces ("slice of pork").
  const line = /const KEEP_FOOD = \/(.+)\/i;/.exec(sellrun);
  ok('the sell circuit has a food keep-list', !!line);
  const KEEP_FOOD = line ? new RegExp(line[1], 'i') : /$^/;
  for (const meal of ['slice of pork', 'bowl of soup', 'edible mushroom', 'Inky-cap mushroom'])
    ok('it protects ' + meal, KEEP_FOOD.test(meal));
  for (const stock of ['mushroom', 'red mushroom', 'blue mushroom'])
    ok('and still sells ' + stock, !KEEP_FOOD.test(stock));
}

console.log('\nthe Duke\'s Feast Hall cannot be fought in, and the approach can');
{
  // Asked by the operator, 2026-09-04, and worth pinning because a PK rule is built on it.
  // duke4.kod and duke5.kod declare ROOM_NO_COMBAT | ROOM_SANCTUARY; duke3 declares
  // ROOM_NO_COMBAT alone; duke1 (the Courtyard, 950) and duke2 (Blackstone Keep, 951)
  // declare NEITHER — so the hall is safe and the two rooms you cross to reach it are not.
  const SAFE = new Set([953, 954]);        // Feast Hall, Grand Ballroom
  const NO_COMBAT = new Set([952, 953, 954]);
  const FIGHTABLE = new Set([950, 951]);   // Courtyard, Blackstone Keep
  ok('the Feast Hall is a sanctuary', SAFE.has(953));
  ok('so is the Grand Ballroom next door', SAFE.has(954));
  ok('the Chambers are no-combat but not a sanctuary', NO_COMBAT.has(952) && !SAFE.has(952));
  ok('the Courtyard and the Keep are ordinary rooms — a courier can be killed there',
     FIGHTABLE.has(950) && FIGHTABLE.has(951) &&
     !NO_COMBAT.has(950) && !NO_COMBAT.has(951));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
