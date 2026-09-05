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
  // ASK THE MODULE, NOT THE FILE. This used to read the source and pull the pattern out
  // with a regex — and this very test's own heading says a source scan is the wrong
  // instrument. It broke the moment KEEP_FOOD stopped being a regex literal and started
  // asking the Food class tree, which is exactly the change it should have been indifferent
  // to. A test that pins the SHAPE of an implementation fails on improvements.
  const { KEEP_FOOD } = await import('./m59-sellrun.mjs');
  ok('the sell circuit has a food keep-list', typeof KEEP_FOOD?.test === 'function');
  for (const meal of ['slice of pork', 'bowl of soup', 'edible mushroom', 'Inky-cap mushroom'])
    ok('it protects ' + meal, KEEP_FOOD.test(meal));
  for (const stock of ['mushroom', 'red mushroom', 'blue mushroom'])
    ok('and still sells ' + stock, !KEEP_FOOD.test(stock));
}

console.log('\nthe fleet page counts what there is to eat, and only that');
{
  // THE ECONOMY PAGE'S FOOD TOTAL reads each row's own `pack_items`, so it costs no packet
  // and is exactly as fresh as the rest of the page. What it must never do is decide for
  // itself what food is: it asks the table above, which is built from the game's Food class
  // tree, because a hand-written list on a page would be the fifth place this fleet could
  // disagree with itself about a mushroom.
  const { foodHeld } = await import('./m59-economy.mjs');
  const held = foodHeld([
    { character: 'A', pack_items: [{ name: 'slice of pork', amount: 40 },
                                   { name: 'red mushroom', amount: 9 },
                                   { name: 'shilling', amount: 100 }] },
    { character: 'B', pack_items: [{ name: 'bowl of soup', amount: 12 },
                                   { name: 'Inky-cap mushroom', amount: 2 },
                                   { name: 'slice of pork', amount: 3 }] },
    { character: 'C', pack_items: null },
  ]);
  ok('it totals every meal across the fleet', held.total === 57, String(held.total));
  ok('the same kind in two packs is one slice',
     held.kinds[0].name === 'slice of pork' && held.kinds[0].value === 43,
     JSON.stringify(held.kinds[0]));
  ok('and it knows how many are carrying it', held.kinds[0].holders === 2);
  ok('reagents are not food, however mushroom-shaped',
     !held.kinds.some(k => /red mushroom/.test(k.name)),
     JSON.stringify(held.kinds.map(k => k.name)));
  ok('money is not food either', !held.kinds.some(k => /shilling/.test(k.name)));
  ok('the Inky-cap is counted, at its real nutrition',
     held.kinds.some(k => k.name === 'inky-cap mushroom' && k.nutrition === 50));
  // AN UNREAD PACK IS NOT AN EMPTY ONE. Reporting the fleet as starving because nobody
  // looked is the mistake this page exists to prevent, so it is counted separately and
  // said out loud on the card.
  ok('an unread pack is counted as unread, not as zero', held.unread === 1);
  ok('and does not count as fed', held.fed === 2 && held.characters === 3);
  // Nutrition is what matters for vigor, and it is a sum of what COULD be eaten rather than
  // vigor in hand: the stomach admits 100 at a sitting.
  ok('nutrition is the weighted sum', held.nutrition === 43 * 9 + 12 * 9 + 2 * 50,
     String(held.nutrition));
  // THE OPERATOR'S OWN HAUL IS NOT THE FLEET'S WORK. While the feast errand was broken the
  // operator walked characters into the hall by hand, and the page must not report that as
  // progress. The obvious discriminator does not work: `platter of raw spider eyes` IS one
  // of the hall's seven dispensers, so hand-placed and bot-fetched food is the same item
  // from the same platter and only the person who did it knows which.
  const split = foodHeld(
    [{ character: 'A', pack_items: [{ name: 'spider eye', amount: 362 },
                                    { name: 'slice of pork', amount: 12 }] }],
    { baseline: { 'spider eye': 362 } });
  ok('what was hand-placed is not counted as earned',
     split.kinds.find(k => k.name === 'spider eye').earned === 0);
  ok('and what was not is', split.kinds.find(k => k.name === 'slice of pork').earned === 12);
  ok('the total still reports everything held', split.total === 374, String(split.total));
  ok('the two halves are reported side by side, never netted',
     split.baseline === 362 && split.earned === 12);
  // A baseline bigger than what is carried means some has been eaten, which is ordinary.
  const eaten = foodHeld([{ character: 'A', pack_items: [{ name: 'spider eye', amount: 40 }] }],
                         { baseline: { 'spider eye': 362 } });
  ok('eating into the baseline does not make earned negative', eaten.earned === 0);
  ok('and the baseline reported is what is actually there', eaten.baseline === 40);
  // A NUMBER GOES STALE THE MOMENT THE OPERATOR PICKS UP ONE MORE, and it did — within ten
  // minutes of a baseline of 362 being written the count was 632, so the page reported 270
  // "earned" that no bot had touched, which is the exact thing the baseline exists to stop.
  // "all" is for a haul still in progress; a number is for one that has finished.
  const still = foodHeld(
    [{ character: 'A', pack_items: [{ name: 'spider eye', amount: 632 },
                                    { name: 'slice of pork', amount: 7 }] }],
    { baseline: { 'spider eye': 'all' } });
  ok('"all" absorbs the whole kind however much it grows',
     still.kinds.find(k => k.name === 'spider eye').earned === 0);
  ok('and still reports what is actually held',
     still.kinds.find(k => k.name === 'spider eye').value === 632);
  ok('while a kind nobody claimed is entirely earned', still.earned === 7);
  ok('an empty fleet is zero, not a crash', foodHeld([]).total === 0);
  ok('and so is no fleet at all', foodHeld(null).total === 0);
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
