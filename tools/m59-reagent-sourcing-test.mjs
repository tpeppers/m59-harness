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
import { reagentBuyAllowed, splitBySourcing, REAGENT_BLOCKS } from './m59-autopilot.mjs';
import { reagentSource, reagentSellTest, normaliseReagents, normalisePlan,
         REAGENT_MODES, DEFAULT_REAGENT_MODE } from './m59-guildwants.mjs';
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

console.log('\n1. THE GUILD DECIDES, AND A FLEET THAT HAS NOT OPTED IN IS UNAFFECTED');
{
  // This was a hardcoded set naming orc teeth, which made one fleet's economy a fact about the
  // source tree. Whether a guild can supply its own reagents is a fact about that guild's hall.
  ok('with no plan at all, everything is still bought', reagentSource('orc tooth', {}) === 'buy');
  ok('...which is the shipped default, stated once', DEFAULT_REAGENT_MODE === 'buy');
  ok('...and it is NOT chest, because a fleet with no hall cannot source from one',
     DEFAULT_REAGENT_MODE !== 'chest');
  const plan = { reagents: normaliseReagents({ reagents: { default: 'chest' } }) };
  ok('a guild-wide default flips everything at once', reagentSource('sapphire', { plan }) === 'chest');
  ok('...including reagents nobody wrote down', reagentSource('vial of solagh', { plan }) === 'chest');
}

console.log('\n2. FOUR LAYERS, MOST SPECIFIC FIRST, AND SILENCE MEANS THE LAYER BELOW');
{
  const plan = { reagents: normaliseReagents({ reagents: { default: 'chest', items: { herb: 'buy' } } }) };
  ok('the guild default applies', reagentSource('sapphire', { plan }) === 'chest');
  ok('a guild per-item override beats it', reagentSource('herb', { plan }) === 'buy');
  ok('a CHARACTER beats the guild', reagentSource('sapphire', { plan, policy: { reagentSource: { sapphire: 'buy' } } }) === 'buy');
  ok('...and may turn one off entirely', reagentSource('herb', { plan, policy: { reagentSource: { herb: 'off' } } }) === 'off');
  // The class switch is coarser and has to win, or "this character buys no reagents" quietly
  // acquires an exception.
  ok('buyReagents:false outranks a per-item buy',
     reagentBuyAllowed({ buyReagents: false, reagentSource: { herb: 'buy' } }, 'herb', plan) === false);

  // AN UNRECOGNISED MODE IS REPORTED, NEVER APPLIED AND NEVER DROPPED. A typo of "chests" must
  // not read as "buy" — that is how `purpose` stayed out of a schema for a year.
  const problems = [];
  const r = normaliseReagents({ reagents: { default: 'chests', items: { herb: 'maybe' } } }, problems);
  ok('a bad default is refused, not guessed', r.default === null);
  ok('a bad override is dropped from the map', r.items.size === 0);
  ok('...and BOTH are reported', problems.length === 2, problems.join(' | ').slice(0, 90));
  ok('the mode list is the three the operator named', REAGENT_MODES.join(',') === 'chest,buy,off');
}

console.log('\n2b. THE NORMALISER IS IDEMPOTENT, AND IT COST ME AN HOUR THAT IT WAS NOT');
{
  // `guildPlan()` already runs `normalisePlan`, which runs `normaliseReagents`. Calling it again
  // on the result handed back an ALREADY-NORMALISED block whose `items` is a Map, and
  // `Object.entries(new Map(...))` is `[]` — so every per-item override silently disappeared while
  // `default`, being a plain string, survived. Measured against the real prod file, which held
  // `{ elderberry: "buy", herb: "buy" }` on a `chest` default: both vanished, and the fleet's two
  // FOOD reagents resolved to `chest` against a guild chest holding fifteen castings for
  // twenty-one characters. Correct in the file, correct in the code, a starved fleet.
  const once = normaliseReagents({ reagents: { default: 'chest', items: { herb: 'buy' } } });
  const twice = normaliseReagents({ reagents: once });
  ok('normalising twice keeps the default', twice.default === 'chest');
  ok('...and keeps the overrides', twice.items.get('herb') === 'buy', `${twice.items.size} override(s)`);
  ok('...and resolves the same either way',
     reagentSource('herb', { plan: { reagents: twice } }) === 'buy');
  // normalisePlan carries the block through, which is how a caller gets one object.
  const full = normalisePlan({ chests: {}, reagents: { default: 'chest', items: { herb: 'buy' } } });
  ok('normalisePlan carries the reagents block', full.reagents.items.get('herb') === 'buy');
  ok('...and it survives being normalised again', normalisePlan(full).reagents.items.get('herb') === 'buy');
}

console.log('\n2c. `chest` IS ONE SETTING WITH TWO HALVES');
{
  // Take it from the chest instead of buying, AND put it in the chest instead of selling. Either
  // half alone leaves the round trip open in one direction — and a merchant buys at ~60% and
  // sells at ~140%, so a reagent that goes over a counter and comes back costs 2.3x its value.
  const plan = { reagents: normaliseReagents({ reagents: { default: 'chest', items: { herb: 'buy' } } }) };
  const sell = reagentSellTest({ plan });
  ok('a chest-sourced reagent is never sold', sell('sapphire') === true);
  ok('...and a bought one still is', sell('herb') === false);
  ok('the test says why, for a reader who did not set it', /60%/.test(sell.why) && /140%/.test(sell.why));
  // The direction matters more than the quantity: guildKeepTest protects what the chest is SHORT
  // of, which goes away the moment a target is met. This does not.
  ok('it does not depend on what the chest currently holds', reagentSellTest({ plan })('orc tooth') === true);
}

console.log('\n3. BOTH HALVES COME BACK — a vanished line is one nobody can question');
{
  const plan = [
    { item: 'elderberry', amount: 58 }, { item: 'herb', amount: 50 },
    { item: 'sapphire', amount: 180 }, { item: 'mushroom', amount: 160 },
    { item: 'orc tooth', amount: 150 },
  ];
  const guild = { reagents: normaliseReagents({ reagents: { default: 'chest',
                                                 items: { elderberry: 'buy', herb: 'buy', mushroom: 'buy' } } }) };
  const { buy, stockpile } = splitBySourcing(plan, { policy: {}, plan: guild });
  ok('the teeth leave the merchant list', !buy.some(r => r.item === 'orc tooth'));
  ok('the sapphires leave it too', !buy.some(r => r.item === 'sapphire'));
  ok('...and both are named as coming from stock', stockpile.length === 2);
  ok('...with the amounts, not just the names',
     stockpile.find(r => r.item === 'orc tooth').amount === 150 &&
     stockpile.find(r => r.item === 'sapphire').amount === 180);
  ok('the three the fleet must still buy survive', buy.length === 3,
     buy.map(r => r.item).join(', '));
  const price = { elderberry: 28, herb: 14, sapphire: 120, mushroom: 20, 'orc tooth': 80 };
  const total = plan.reduce((a, r) => a + r.amount * price[r.item], 0);
  const after = buy.reduce((a, r) => a + r.amount * price[r.item], 0);
  ok('the bill falls by the teeth AND the sapphires', total - after === 12000 + 21600,
     `${total} -> ${after}`);
  // The number that decides whether this was worth doing: 618 in the purse.
  ok('...and what is left is AFFORDABLE, which the teeth alone were not', after < 618 + 5000,
     `${after} left against a purse of 618`);
}

console.log('\n4. THE MALFORMED CASES DO NOT INVENT WORK');
{
  ok('an empty list', splitBySourcing([], {}).buy.length === 0);
  ok('a missing list', splitBySourcing(undefined, {}).buy.length === 0);
  ok('a non-array', splitBySourcing(null, {}).buy.length === 0 && splitBySourcing('x', {}).buy.length === 0);
  const messy = splitBySourcing([null, { amount: 5 }, { item: '' }, { item: 'herb', amount: 1 }], {});
  ok('rows with no item are dropped, not passed on as blanks', messy.buy.length === 1);
  ok('...and the good row survives', messy.buy[0].item === 'herb');
  ok('no options at all is the historical behaviour', splitBySourcing([{ item: 'orc tooth', amount: 1 }]).buy.length === 1);
  // `off` is a third group, not a silent drop.
  const offPlan = { reagents: normaliseReagents({ reagents: { items: { 'orc tooth': 'off' } } }) };
  const three = splitBySourcing([{ item: 'orc tooth', amount: 1 }, { item: 'herb', amount: 1 }], { plan: offPlan });
  ok('an off reagent is neither bought nor drawn', three.off.length === 1 && three.buy.length === 1);
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

console.log('\n6. THE BEST SOURCE IS NOT THE BIGGEST NUMBER');
{
  if (!spawns) { ok('the spawn index is readable', false); }
  else {
    // Sorting by drop rate alone answers "farm a sapphire off a level-105 lupogg", which is worse
    // than answering nothing because somebody might try it. The ceiling is the character's own.
    const none = farmSourcesFor(spawns, 'sapphire');
    ok('with no ceiling, the pick is the highest RATE', none.best.creature === 'lupogg', `L${none.best.level}`);
    const capped = farmSourcesFor(spawns, 'sapphire', { maxLevel: 59 });
    ok('a 59 ceiling picks something a 59-health character can fight', capped.best.level <= 59,
       `${capped.best.creature} L${capped.best.level} ${capped.best.per_roll_percent}%`);
    ok('...and the full rate-ordered list is still returned unchanged', capped.sources.length === none.sources.length);
    const teeth = farmSourcesFor(spawns, 'orc tooth', { maxLevel: 59 });
    ok('orc teeth still come off the orc, in room 27', teeth.best.creature === 'orc' && teeth.best.rooms.includes(27));

    // A CEILING THAT EXCLUDES EVERYTHING MUST SAY SO, not quietly relax itself — that is how the
    // lupogg gets recommended anyway.
    const wing = farmSourcesFor(spawns, 'fairy wing', { maxLevel: 59 });
    ok('an unreachable reagent has no best', wing.best === null);
    ok('...and it is still marked farmable, which is a different fact', wing.farmable === true);
    ok('...and it names the softest one and its level', /fey elhai/.test(wing.best_why ?? '') && /60/.test(wing.best_why ?? ''),
       wing.best_why);
  }
}

console.log('\n7. A SHORTAGE NAMES WHAT GOES QUIET');
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
