#!/usr/bin/env node
// A TOWN STOP THAT CANNOT SEE A SWORD.
//
//   node tools/m59-nonstackable-sale-test.mjs
//
// Offline: no broker, no socket, no roster, no fleet. `planTownStop` is pure arithmetic over
// its arguments, so this runs the real function on real pack rows.
//
// ======================== THE CLAIM THIS SUITE EXISTS TO PIN ========================
//
// The server reports a stack count in `amount`, and for anything that does NOT stack it
// reports 0. The planner read `it.amount ?? it.count ?? 1` — and `??` falls through only on
// null and undefined, so zero survived as a real count of NOTHING. Every `>= min_stack` test
// below it then excluded the item, silently: it never appeared in a sell list at all, so the
// stop reported success having left the entire pile behind.
//
// MEASURED ON PROD 2026-09-19, reading live keeper packs. Every non-stackable item in the
// fleet was invisible to the town stop:
//
//     122 long swords across eleven characters — Pepe 22, Statler 21, Janice 16,
//     Bunsen 15, Robin 15, Kermit 12 — plus 47 flasks, 10 hammers, 9 axes,
//     shields and armour.
//
// Kermit's own pack, read off his keeper: `long sword amount:0` twelve times over, while
// `red mushroom amount:30` sold on the same trip. An operator got on a character after a
// town stop and found it still carrying twenty long swords.
//
// TWO DEFECTS, AND THE SECOND ONLY SHOWS ONCE THE FIRST IS FIXED. The sweep de-duplicates by
// NAME so each kind is offered once — right for a stack, where one row is the whole holding,
// and wrong for anything that does not stack, where twelve swords are TWELVE ROWS. Reading
// the matched row alone would have offered one of Kermit's twelve and called the stop a
// success for the other eleven.
//
// The sibling path in m59-skills.mjs (`inventorySalePlan`) has always used `o.amount || 1`,
// which is correct. Two code paths, one field, and only one of them could see a sword.
import { normalise } from './m59-loadout.mjs';
import { planTownStop, unitsOf } from './m59-townstop.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};
const norm1 = (l) => normalise(l).loadout;
const sellOf = (p, item) => p.sell.find(s => s.item.toLowerCase() === item.toLowerCase());

// KERMIT'S ACTUAL ROWS, shape copied from his keeper's /state rather than invented: a
// non-stackable object carries `amount: 0`, and holding twelve means twelve rows.
const row = (name, amount, id) => ({ id, name, amount, tag: 0, flags: 16, rarity: 0 });
const KERMIT = [
  ...Array.from({ length: 12 }, (_, i) => row('long sword', 0, 8900 + i)),
  ...Array.from({ length: 3 }, (_, i) => row('flask', 0, 8800 + i)),
  row('hammer', 0, 8700),
  row('axe', 0, 8701),
  row('herb', 10, 8600),
  row('elderberry', 10, 8601),
  row('loaf of bread', 17, 8602),
  row('red mushroom', 30, 8603),
  row('blue mushroom', 16, 8604),
  row('purple mushroom', 22, 8605),
];

const LOADOUT = norm1({
  format: 'm59-loadout/1', character: 'Kermit',
  gear: { weapon: ['hammer', 'axe'], slots: { body: ['leather armor'] } },
  carry: [
    { item: 'elderberry', min: 20, max: 40, kind: 'reagent' },
    { item: 'herb', min: 20, max: 40, kind: 'reagent' },
  ],
});

console.log('\nunitsOf: A ZERO AMOUNT IS ONE OBJECT, NOT NONE');
{
  ok('a non-stackable row counts as one', unitsOf({ name: 'long sword', amount: 0 }) === 1);
  ok('a real stack counts as itself', unitsOf({ name: 'red mushroom', amount: 30 }) === 30);
  ok('a missing amount counts as one', unitsOf({ name: 'thing' }) === 1);
  ok('a `count` field is honoured when `amount` is absent', unitsOf({ count: 4 }) === 4);
  // Defensive: the wire is not ours and a garbage reading must not erase a real object.
  ok('a negative amount is still one object', unitsOf({ amount: -3 }) === 1);
  ok('a non-numeric amount is still one object', unitsOf({ amount: 'lots' }) === 1);
  ok('null is one object, not zero', unitsOf(null) === 1);
}

console.log('\nTHE MEASURED CASE: KERMIT\'S TWELVE SWORDS MUST BE OFFERED');
{
  const p = planTownStop(LOADOUT, { items: KERMIT, equipped: ['hammer'] });
  ok('a plan came back', !!p);
  const sw = sellOf(p, 'long sword');
  ok('long swords are in the sell list at all', !!sw,
     'sell list: ' + p.sell.map(s => s.item).join(', '));
  // THE SECOND DEFECT. One row read alone gives 1; the holding is 12.
  ok('and ALL TWELVE are offered, not one', sw && sw.amount === 12, String(sw?.amount));
  const fl = sellOf(p, 'flask');
  ok('flasks too — 47 of them fleet-wide', !!fl && fl.amount === 3, String(fl?.amount));
}

console.log('\nAND IT DID NOT BREAK WHAT ALREADY WORKED');
{
  const p = planTownStop(LOADOUT, { items: KERMIT, equipped: ['hammer'] });
  for (const [name, n] of [['red mushroom', 30], ['blue mushroom', 16], ['purple mushroom', 22]]) {
    const e = sellOf(p, name);
    ok(`${name} still sells its real stack (${n})`, !!e && e.amount === n, String(e?.amount));
  }
  // The reagents are under their floor and must survive, which is the invariant the sibling
  // suite pins — restated here because this change touches the same counting.
  ok('herbs are NOT sold — under the carry floor', !sellOf(p, 'herb'));
  ok('elderberry is NOT sold — under the carry floor', !sellOf(p, 'elderberry'));
  // Gear named by the loadout is kept whether or not it stacks. The hammer is the character's
  // weapon; before the fix it was protected by accident, because nothing could see it.
  ok('the hammer it fights with is kept', !sellOf(p, 'hammer'));
  ok('and the axe it is told to carry is kept', !sellOf(p, 'axe'));
}

console.log('\nTHE EQUIPPED ITEM IS NEVER FENCED, STACKABLE OR NOT');
{
  const worn = [...KERMIT, row('mystic sword', 0, 8999)];
  const p = planTownStop(LOADOUT, { items: worn, equipped: ['mystic sword'] });
  ok('a worn non-stackable is not offered', !sellOf(p, 'mystic sword'),
     'this is the one that would cost a weapon rather than a walk');
}

console.log('\nTHE INVARIANT, STATED AS ITSELF');
{
  // Nothing the character is carrying, that the loadout has no opinion about and is not
  // wearing, may be left out of the plan. That is the whole job of a pack-clearing stop.
  const p = planTownStop(LOADOUT, { items: KERMIT, equipped: ['hammer'] });
  const named = new Set(p.sell.map(s => s.item.toLowerCase()));
  const spokenFor = new Set(['herb', 'elderberry', 'hammer', 'axe']);
  const missed = [...new Set(KERMIT.map(i => i.name.toLowerCase()))]
    .filter(n => !spokenFor.has(n) && !named.has(n));
  ok('every unspoken-for kind in the pack is offered', missed.length === 0,
     missed.join(', ') || '(none)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
