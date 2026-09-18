#!/usr/bin/env node
// A REAGENT HAS A SOURCE, NOT JUST A PRICE — offline, no broker, no server, no keeper.
//
//   node tools/m59-reagent-sourcing-test.mjs
//
// THE FAILURE, measured on prod 2026-09-18. Robin's shopping plan came to 39,124 shillings
// against a purse of 618:
//
//     sapphire   x180 @ 120 = 21,600     orc tooth  x150 @ 80 = 12,000
//     mushroom   x160 @  20 =  3,200     elderberry  x58 @ 28 =  1,624
//
// The guild chests, cached the same afternoon, held 202 orc teeth, 503 sapphires and 460
// mushrooms. Ten of twenty-one characters sat in `poor_farming.active`; eleven carried
// `purchase_funding.status: "unaffordable - returning to farming"`, a status that RETRIES rather
// than stopping. Lew made 26 journeys in 90 minutes, every one to a shop, and reached his station
// ONCE. That is this repository's own trap running live: a trip that cannot fix the thing that
// opened it will run for ever, and every lap reports success.
//
// The capability to take them was never missing. `withdrawFromStockpile` walks to the hall, steps
// out of the foyer, says the password, reads the chests and takes what is needed — under a comment
// that says THE CHESTS FIRST. Its want list was hardcoded to `elderberry` and `herb`.
//
// Operator, 2026-09-18: "Make it a special (default off) buy-orc-teeth option, where if it's off
// and not available in vault or chest it doesn't get added to the loadout... and when people take
// on tasks, we can make 'farm orc teeth' a task, because that can restock the chest."
import { reagentBuyAllowed, splitBySourcing, REAGENT_SOURCING, REAGENT_BLOCKS } from './m59-autopilot.mjs';
import { loadSpawns, farmSourcesFor } from './m59-spawns.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const spawns = loadSpawns(process.env.M59_SPAWN_FILE || join(REPO, 'substrate', 'm59-spawns.json'));

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

console.log('\n1. ORC TEETH ARE NOT BOUGHT, AND THAT IS THE DEFAULT');
{
  ok('a character with no opinion does not buy them', reagentBuyAllowed({}, 'orc tooth') === false);
  ok('...and still buys everything else', reagentBuyAllowed({}, 'sapphire') === true);
  ok('...including the two the fleet runs on', reagentBuyAllowed({}, 'elderberry') === true
     && reagentBuyAllowed({}, 'herb') === true);
  ok('the set says WHY, not just no', !!REAGENT_SOURCING['orc tooth'].why,
     REAGENT_SOURCING['orc tooth'].why);
}

console.log('\n2. THREE LAYERS, MOST SPECIFIC FIRST, AND SILENCE MEANS THE OLD BEHAVIOUR');
{
  ok('a character may opt back IN', reagentBuyAllowed({ buyReagent: { 'orc tooth': true } }, 'orc tooth') === true);
  ok('a character may opt something else OUT', reagentBuyAllowed({ buyReagent: { sapphire: false } }, 'sapphire') === false);
  // The class switch is the coarser rule and has to win, or "this character buys no reagents"
  // quietly acquires an exception.
  ok('buyReagents:false outranks a per-item yes',
     reagentBuyAllowed({ buyReagents: false, buyReagent: { 'orc tooth': true } }, 'orc tooth') === false);
  ok('...and outranks the default yes', reagentBuyAllowed({ buyReagents: false }, 'herb') === false);
  // An unrecognised item is not a refusal. Nothing here knows every reagent in the game, and
  // guessing no would silently stop a purchase nobody asked to stop.
  ok('an item nobody has an opinion about is buyable', reagentBuyAllowed({}, 'vial of solagh') === true);
  ok('casing does not decide it', reagentBuyAllowed({}, 'Orc Tooth') === false);
}

console.log('\n3. BOTH HALVES COME BACK — a vanished line is one nobody can question');
{
  const plan = [
    { item: 'elderberry', amount: 58 }, { item: 'herb', amount: 50 },
    { item: 'sapphire', amount: 180 }, { item: 'mushroom', amount: 160 },
    { item: 'orc tooth', amount: 150 },
  ];
  const { buy, stockpile } = splitBySourcing(plan, {});
  ok('the teeth leave the merchant list', !buy.some(r => r.item === 'orc tooth'));
  ok('...and are named as coming from stock', stockpile.length === 1 && stockpile[0].item === 'orc tooth');
  ok('...with the amount, not just the name', stockpile[0].amount === 150);
  ok('everything else still goes to a merchant', buy.length === 4);
  const price = { elderberry: 28, herb: 14, sapphire: 120, mushroom: 20, 'orc tooth': 80 };
  const total = plan.reduce((a, r) => a + r.amount * price[r.item], 0);
  const after = buy.reduce((a, r) => a + r.amount * price[r.item], 0);
  ok('the bill falls by exactly the teeth', total - after === 12000, `${total} -> ${after}`);
  // Honesty about scope: this does not make Robin solvent. The sapphire line is a separate
  // argument and the test says so rather than implying a fix it did not make.
  ok('...and is STILL unaffordable on 618, which is the next problem', after > 618, `${after} left`);
}

console.log('\n4. THE MALFORMED CASES DO NOT INVENT WORK');
{
  ok('an empty list', splitBySourcing([], {}).buy.length === 0);
  ok('a missing list', splitBySourcing(undefined, {}).buy.length === 0);
  ok('a non-array', splitBySourcing(null, {}).buy.length === 0 && splitBySourcing('x', {}).buy.length === 0);
  const messy = splitBySourcing([null, { amount: 5 }, { item: '' }, { item: 'herb', amount: 1 }], {});
  ok('rows with no item are dropped, not passed on as blanks', messy.buy.length === 1);
  ok('...and the good row survives', messy.buy[0].item === 'herb');
  ok('a missing policy is the default policy', splitBySourcing([{ item: 'orc tooth', amount: 1 }]).stockpile.length === 1);
}

console.log('\n5. A SHORTAGE HAS TO SAY WHERE THE THING COMES FROM');
{
  if (!spawns) { ok('the spawn index is readable', false); }
  else {
    const t = farmSourcesFor(spawns, 'orc tooth');
    ok('orc teeth are farmable', t.farmable === true);
    const best = t.sources[0];
    ok('...by the orc, at the top of the list', best.creature === 'orc', `${best.creature} ${best.per_roll_percent}%`);
    ok('...sorted by drop rate, best first',
       t.sources.every((x, i) => i === 0 || (x.per_roll_percent ?? 0) <= (t.sources[i - 1].per_roll_percent ?? 0)));
    // The whole point of a destination: room 27 is where the cave cohort already stands, so
    // "farm orc teeth" is a task with nowhere new to go.
    ok('...in rooms the fleet already farms', best.rooms.includes(27), JSON.stringify(best.rooms.slice(0, 6)));
    ok('...and it cites the kod rather than asserting', /\.kod:/.test(best.cite ?? ''), best.cite);

    // The answer that would have saved me an hour: I concluded the holy-weapon desk was blocked
    // because no merchant sells a fairy wing. Nobody does — and they are farmable.
    const w = farmSourcesFor(spawns, 'fairy wing');
    ok('fairy wings are farmable too, which "no merchant sells them" hid', w.farmable === true,
       w.sources[0] && `${w.sources[0].creature} L${w.sources[0].level} ${w.sources[0].per_roll_percent}%`);

    const none = farmSourcesFor(spawns, 'a thing that does not exist');
    ok('an item nothing drops is not farmable', none.farmable === false);
    ok('...and says so rather than returning an empty list silently', !!none.why, none.why);
  }
}

console.log('\n6. A SHORTAGE NAMES WHAT GOES QUIET');
{
  ok('orc teeth block super strength', /super strength/.test(REAGENT_BLOCKS['orc tooth'] ?? ''));
  ok('...and cite the kod', /\.kod:/.test(REAGENT_BLOCKS['orc tooth'] ?? ''), REAGENT_BLOCKS['orc tooth']);
  ok('sapphires block bless', /bless/.test(REAGENT_BLOCKS['sapphire'] ?? ''));
  ok('fairy wings block holy weapon', /holy weapon/.test(REAGENT_BLOCKS['fairy wing'] ?? ''));
  ok('an item with no consequence recorded answers undefined, not a guess',
     REAGENT_BLOCKS['herb'] === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
