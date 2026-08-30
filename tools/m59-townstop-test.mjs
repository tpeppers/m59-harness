#!/usr/bin/env node
// DOES A TOWN STOP EVER SELL SOMETHING IT IS ABOUT TO BUY?
//
//   node tools/m59-townstop-test.mjs
//
// Offline, and BEHAVIOURAL rather than source-matching: `planTownStop` is pure arithmetic
// over its arguments, so this runs the real function on real loadouts instead of grepping
// for the shape of one. Source assertions are for code that needs a live server; this does
// not, and a test that can execute the thing should.
//
// WHY THIS FILE EXISTS. Two answers to "may this be sold" were already in the tree and did
// not agree: the loadout's per-character `carry[].min`/`max`, and `m59-sellrun.mjs`'s own
// `keep_always.reagent_floor` plus a hardcoded ['herb','elderberry']. The hardcoded pair is
// the expensive half — it protects the two reagents somebody thought of, so a character told
// to carry a third had it fenced at the first stop and bought back at the last, paying the
// merchant spread twice for no change in the pack.
//
// The invariant below is the whole point, and it should fail the day somebody makes the sell
// list outrank a floor.
import { normalise } from './m59-loadout.mjs';
// normalise() answers {loadout, problems}. Every assertion here is about the loadout.
const norm1 = (raw) => normalise(raw).loadout;
import { planTownStop, neverSellsWhatItBuys, DEFAULTS } from './m59-townstop.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`); }
};

const pack = (o) => Object.entries(o).map(([name, amount]) => ({ name, amount }));
const sellOf = (p, item) => p.sell.find(s => s.item.toLowerCase() === item.toLowerCase());
const buyOf = (p, item) => p.buy.find(b => b.item.toLowerCase() === item.toLowerCase());

// A character told to carry two reagents and to fight with a mace, holding a pile of loot.
const LOADOUT = norm1({
  format: 'm59-loadout/1', character: 'Tester',
  gear: { weapon: ['mace', 'hammer'], slots: { body: ['leather armor'] } },
  carry: [
    { item: 'elderberry', min: 20, max: 40, kind: 'reagent' },
    { item: 'herb', min: 20, max: 40, kind: 'reagent' },
    { item: 'inky cap', min: 2, max: 6, kind: 'potion' },
  ],
  sell: ['long sword'],
  keep: ['guild token'],
});

console.log('the invariant: never sell what this same stop would buy');
{
  // Short of herbs, swimming in elderberry — the exact shape that used to sell the herbs.
  const p = planTownStop(LOADOUT, {
    items: pack({ herb: 3, elderberry: 111, mushroom: 240, sapphire: 38, shilling: 400 }),
    equipped: ['mace'],
  });
  ok('a plan came back', !!p);
  ok('herbs are being bought', !!buyOf(p, 'herb') && buyOf(p, 'herb').short === 17);
  ok('and herbs are NOT in the sell list', !sellOf(p, 'herb'));
  const inv = neverSellsWhatItBuys(p);
  ok('the invariant holds', inv.ok, `both: ${inv.both.join(', ')}`);
}

console.log('\nbut everything else still goes');
{
  const p = planTownStop(LOADOUT, {
    items: pack({ herb: 3, elderberry: 111, mushroom: 240, sapphire: 38, shilling: 400 }),
    equipped: ['mace'],
  });
  ok('loot the loadout has never heard of is sold', !!sellOf(p, 'mushroom') && !!sellOf(p, 'sapphire'));
  ok('and all of it, since nothing asked for any', sellOf(p, 'mushroom').amount === 240);
  ok('money is never offered', !sellOf(p, 'shilling'));
  ok('what is WORN is never offered', !sellOf(p, 'mace'));
  ok('the reason is recorded, not just the verdict',
     /loadout has no opinion/.test(sellOf(p, 'sapphire').why));
}

console.log('\na reagent over its ceiling is kept, and the ceiling says so out loud');
{
  const p = planTownStop(LOADOUT, {
    items: pack({ elderberry: 111, herb: 60 }), equipped: [],
  });
  // never_sell_kinds includes 'reagent' by default, so `max: 40` does not apply to these.
  ok('elderberry is not sold despite being 71 over its ceiling', !sellOf(p, 'elderberry'));
  const w = p.withheld.find(x => x.item === 'elderberry');
  ok('and the withholding is REPORTED rather than silent', !!w && w.over === 71,
     JSON.stringify(p.withheld));
  ok('the report names the setting that did it', !!w && /never_sell_kinds/.test(w.why));
  // A number that stops applying and says nothing is the failure this repo keeps paying for.
  ok('a non-reagent over its ceiling IS still sold',
     !!sellOf(planTownStop(LOADOUT, { items: pack({ 'inky cap': 20 }) }), 'inky cap'));
}

console.log('\na protected KIND does not need a floor to be protected');
{
  // THE REGRESSION THIS PINS. `never_sell_kinds` was briefly gated on `floor > 0`, which on
  // the prod fleet protected nothing at all: every reagent floor there is 0, zeroed on
  // 2026-08-27 because unsatisfiable floors re-opened a town trip for ever. A setting that
  // silently does nothing on the only fleet that runs it is worse than no setting.
  const L = norm1({
    format: 'm59-loadout/1', character: 'Tester',
    carry: [{ item: 'elderberry', min: 0, max: 200, kind: 'reagent' }],
  });
  const p = planTownStop(L, { items: pack({ elderberry: 82 }) });
  ok('a floor-zero reagent is still protected', p.keep_fragments.includes('elderberry'));
  ok('and is not sold', !sellOf(p, 'elderberry'));
  const over = planTownStop(L, { items: pack({ elderberry: 250 }) });
  ok('even above its ceiling', !sellOf(over, 'elderberry'));
  ok('and the ceiling that stopped applying is reported',
     over.withheld.some(w => w.item === 'elderberry' && w.over === 50));
}

console.log('\nthe sell list never beats a floor');
{
  const L = norm1({
    format: 'm59-loadout/1', character: 'Tester',
    carry: [{ item: 'long sword', min: 1, max: 2, kind: 'weapon' }],
    sell: ['long sword'],
  });
  const p = planTownStop(L, { items: pack({ 'long sword': 0 }) });
  ok('an item under its floor is bought', !!buyOf(p, 'long sword'));
  ok('and not sold, even though it is on the sell list', !sellOf(p, 'long sword'));
  ok('and the contradiction is reported as a conflict',
     p.conflicts.some(c => /sell list AND under its floor/.test(c.why)));
}

console.log('\nkeep_fragments is the plan in sell_all vocabulary');
{
  const p = planTownStop(LOADOUT, { items: pack({ elderberry: 50, mushroom: 9 }), equipped: [] });
  // `sell_all` refuses to offer anything whose name CONTAINS one of these, lowercased.
  ok('every protected name is present', ['elderberry', 'herb', 'mace', 'hammer',
      'leather armor', 'guild token'].every(n => p.keep_fragments.includes(n)));
  ok('they are lowercased', p.keep_fragments.every(f => f === f.toLowerCase()));
  ok('and deduplicated', p.keep_fragments.length === new Set(p.keep_fragments).size);
  ok('loot is NOT in it', !p.keep_fragments.includes('mushroom'));
}

console.log('\nsilence means the behaviour that was already there');
{
  // AN ABSENT LOADOUT IS NOT AN EMPTY ONE. Read as "sell nothing" it makes the trip
  // pointless; read as "sell everything" it fences the fleet's reagents. Neither is safe to
  // guess, so the answer is null and the caller has to decide.
  ok('a null loadout returns null, not a plan', planTownStop(null, { items: pack({ mushroom: 5 }) }) === null);
  const empty = norm1({ format: 'm59-loadout/1', character: 'Tester' });
  const p = planTownStop(empty, { items: pack({ mushroom: 5 }) });
  ok('an empty loadout still sells loot', !!sellOf(p, 'mushroom'));
  ok('and protects nothing it was not told to', p.keep_fragments.length === 0);
}

console.log('\nthe courier case: shed loot, carry every reagent home');
{
  // What the Valley move needs: sell the mushrooms and gems, keep all 111 elderberry.
  const p = planTownStop(LOADOUT, {
    items: pack({ elderberry: 111, herb: 14, mushroom: 240, emerald: 24, shilling: 380 }),
    equipped: ['hammer'],
    settings: { never_sell_kinds: ['reagent'] },
  });
  ok('both reagents survive', !sellOf(p, 'elderberry') && !sellOf(p, 'herb'));
  ok('the loot does not', !!sellOf(p, 'mushroom') && !!sellOf(p, 'emerald'));
  ok('and the wielded hammer is untouched', !sellOf(p, 'hammer'));
  ok('the invariant still holds', neverSellsWhatItBuys(p).ok);
}

console.log('\nthe defaults are stated, not implied');
{
  ok('reagents are the default protected kind', DEFAULTS.never_sell_kinds.includes('reagent'));
  ok('and selling the unknown is on by default', DEFAULTS.sell_unknown === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
