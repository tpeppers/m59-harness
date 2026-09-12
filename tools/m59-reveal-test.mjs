#!/usr/bin/env node
// THE IDENTIFICATION SERVICE'S RULES, offline: no socket, no roster, no broker, no fleet.
//
// Everything here pins a decision that costs orc teeth to get wrong. Teeth are 325 each at
// Paddock and there is no way to get them back, so "it cast at the wrong thing" is a bill
// rather than a log line.
import assert from 'node:assert/strict';
import { ITEM_RARITY, rarityName, isUnidentified, isCursed } from './m59-items.mjs';
import { REVEAL, IDENTIFY, teethIn, revealable, budget } from './m59-reveal.mjs';

let n = 0;
const ok = (what, fn) => { fn(); n++; console.log('  ok  ' + what); };

console.log('\nrarity grades — the filter the whole tool rests on');

ok('100 is unidentified, and that is the only grade reveal can act on', () => {
  assert.equal(ITEM_RARITY.UNIDENTIFIED, 100);
  assert.equal(rarityName(100), 'unidentified');
  assert.equal(isUnidentified({ rarity: 100 }), true);
});

// GetRarity tests IsIdentified BEFORE IsCursed (item.kod:723-736), so anything still reading
// 200 has already been revealed. Casting at it burns 3 teeth to discover nothing, for ever,
// on every cursed weapon in the fleet.
ok('cursed (200) is NOT work — it is already identified', () => {
  assert.equal(isUnidentified({ rarity: 200 }), false);
  assert.equal(rarityName(200), 'cursed');
});

// An item with no attributes at all skips IsIdentified's loop and returns TRUE, so plain gear
// reads 0. If this ever read as work the fleet would cast at every slice of pork it owns.
ok('normal (0) is not work', () => {
  assert.equal(isUnidentified({ rarity: 0 }), false);
  assert.equal(rarityName(0), 'normal');
});

// A missing grade is the case that matters most: before this change BOTH serializers dropped
// the field, so every item everywhere read `undefined`. Guessing "unidentified" there would
// have spent the fleet's entire tooth supply on its own pork in one pass.
ok('an ABSENT grade is not work — unknown must never read as yes', () => {
  assert.equal(isUnidentified({}), false);
  assert.equal(isUnidentified({ rarity: null }), false);
  assert.equal(isUnidentified(undefined), false);
  assert.equal(rarityName(undefined), null);
});

console.log('\nwhat counts as work');

ok('revealable takes grade 100 and nothing else', () => {
  const got = revealable([
    { id: 1, name: 'long sword', rarity: 0 },
    { id: 2, name: 'gnarled staff', rarity: 100 },
    { id: 3, name: 'cursed mace', rarity: 200 },
    { id: 4, name: 'herald shield', rarity: 4 },
    { id: 5, name: 'wand', rarity: 100 },
  ]).map(i => i.id);
  assert.deepEqual(got, [2, 5]);
});

// A NumberItem stack is money, arrows, food or reagents. None carries an attribute and the
// server has no per-stack identification, so a stack reading 100 is a bug somewhere else and
// must not be paid for here.
ok('a stack is never work, whatever it is graded', () => {
  assert.deepEqual(revealable([{ id: 9, name: 'arrows', rarity: 100, amount: 40 }]), []);
  assert.equal(revealable([{ id: 9, name: 'wand', rarity: 100, amount: 1 }]).length, 1);
});

ok('an empty or absent pack is no work and does not throw', () => {
  assert.deepEqual(revealable([]), []);
  assert.deepEqual(revealable(undefined), []);
});

console.log('\ncounting orc teeth');

ok('teeth count by amount, singular and plural, and ignore everything else', () => {
  assert.equal(teethIn([{ name: 'orc teeth', amount: 6 }]), 6);
  assert.equal(teethIn([{ name: 'orc tooth', amount: 1 }]), 1);
  // A bare object with no amount is one thing, not zero.
  assert.equal(teethIn([{ name: 'orc tooth' }]), 1);
  assert.equal(teethIn([{ name: 'slice of pork', amount: 208 }]), 0);
  assert.equal(teethIn([]), 0);
});

console.log('\nthe two spells are priced differently and it is not a detail');

ok('reveal is 3 teeth and permanent; identify is 1 and transient', () => {
  assert.equal(REVEAL.teeth, 3);
  assert.equal(REVEAL.mana, 30);
  assert.equal(IDENTIFY.teeth, 1);
  assert.equal(IDENTIFY.mana, 10);
});

console.log('\nbudget — what a pass can actually pay for');

ok('teeth are the hard limit and the shortfall is named in teeth', () => {
  const b = budget(10, 9, 200, REVEAL);
  assert.equal(b.wanted, 10);
  assert.equal(b.affordable, 3);            // 9 teeth / 3 per reveal
  assert.equal(b.teeth_needed, 30);
  assert.equal(b.teeth_short, 21);
  assert.match(b.paced_by, /orc teeth/);
});

// Mana regenerates and teeth do not. Reporting a mana shortage as a shortage would send an
// operator to a merchant to solve a problem that solves itself in a few minutes.
ok('mana paces a run, it does not block it', () => {
  const b = budget(4, 99, 30, REVEAL);
  assert.equal(b.affordable, 4);            // teeth are fine
  assert.equal(b.by_mana_now, 1);
  assert.match(b.paced_by, /regenerates/);
});

ok('with teeth and mana to spare nothing is named as the pacer', () => {
  const b = budget(2, 99, 200, REVEAL);
  assert.equal(b.affordable, 2);
  assert.equal(b.paced_by, null);
});

ok('identify stretches the same teeth three times as far', () => {
  assert.equal(budget(9, 9, 500, REVEAL).affordable, 3);
  assert.equal(budget(9, 9, 500, IDENTIFY).affordable, 9);
});

ok('no teeth means no work, and it says which shortage it is', () => {
  const b = budget(5, 0, 200, REVEAL);
  assert.equal(b.affordable, 0);
  assert.match(b.paced_by, /orc teeth/);
});


console.log('\ncursed is the same grade, and the hand is where it matters');

// NULL IS NOT ZERO, AND ZERO IS `normal`.
//
// `Number(null)` is 0, so a null grade fell through to the NORMAL case and every item whose
// rarity nobody had read came back labelled `normal`. Found on a live character the day the
// grade first shipped: Rizzo's wielded mace reported `rarity_name: "normal"` alongside a note
// saying nothing equipped was cursed, while his own keeper had been refusing to train for
// eighty consecutive passes because "mace is cursed and cannot be removed". The field added to
// answer "is this cursed" was answering "no" from an absence.
ok('a null grade has no name — it is not `normal`', () => {
  assert.equal(rarityName(null), null);
  assert.equal(rarityName(undefined), null);
  assert.equal(rarityName(''), null);
  assert.equal(rarityName(0), 'normal', 'and ZERO still is, because zero is a real grade');
});

// The two predicates were already safe here, but by luck rather than design — `Number(null)`
// is 0 and 0 is neither 100 nor 200 — so pin it rather than leave it to be re-derived.
ok('and the predicates answer false for a grade nobody has read, which is the safe direction',
   () => {
  assert.equal(isCursed({ rarity: null }), false);
  assert.equal(isUnidentified({ rarity: null }), false);
  assert.equal(isCursed({}), false);
});

// `grades_known` SAYS THE LIST ARRIVED, NOT THAT EVERY ROW IN IT IS GRADED, and the note in
// m59-broker.mjs was written as though those were the same thing. Pinned as the expression,
// because the broker cannot be imported — importing it takes the fleet lock.
ok('an ungraded row is reported as ungraded rather than folded into "none is cursed"', () => {
  const equipped = [{ name: 'mace', rarity: null }, { name: 'leather armor', rarity: 0 }];
  const ungraded = equipped.filter(e => e.rarity === null || e.rarity === undefined)
                           .map(e => e.name);
  assert.deepEqual(ungraded, ['mace']);
  const cursed = equipped.filter(e => isCursed(e)).map(e => e.name);
  assert.equal(cursed.length, 0, 'nothing READS as cursed');
  // …and that is exactly the case where the old note asserted it was clean.
  assert.ok(ungraded.length > 0, 'so the claim has to be withheld');
});

ok('200 is cursed, by the server\'s own word rather than an inference', () => {
  assert.equal(ITEM_RARITY.CURSED, 200);
  assert.equal(rarityName(200), 'cursed');
  assert.equal(isCursed({ rarity: 200 }), true);
});

// The two grades are mutually exclusive and the reveal filter must not widen to take the
// second. GetRarity tests IsIdentified before IsCursed, so a 200 has already been revealed —
// counting it as work would burn three teeth per cursed weapon in the fleet, for ever.
ok('and a cursed item is NOT revealable, which is what keeps teeth off it', () => {
  assert.equal(isUnidentified({ rarity: 200 }), false);
  assert.equal(isCursed({ rarity: 100 }), false);
  assert.equal(revealable([{ name: 'mace', rarity: 200 }]).length, 0);
});

// ABSENT IS NOT NEGATIVE. A keeper too old to send the field, and a keeper reporting a clean
// weapon, both produce `rarity: null` — and reading those the same way is the whole reason
// three checks in a row reported Rizzo's cursed mace as clean.
ok('a missing grade is not a clean one', () => {
  assert.equal(isCursed({ rarity: null }), false);
  assert.equal(isCursed({}), false);
  assert.equal(isUnidentified({ rarity: null }), false);
});

// THE REBUILD THE BROKER DOES, PINNED HERE BECAUSE THE BROKER CANNOT BE IMPORTED — importing
// it takes the fleet lock. This is the exact expression from m59-broker.mjs's KeeperProxy:
// a keeper that sends `equipment_items` carries grades, one that sends only `equipment` does
// not, and `grades_known` is what stops the second reading as "nothing is cursed".
console.log('\nthe keeper-backed rebuild keeps both shapes apart');
{
  const rebuild = (s) => ({
    known: Array.isArray(s.equipment_items) || Array.isArray(s.equipment),
    equipped: Array.isArray(s.equipment_items)
      ? s.equipment_items.map((o, i) => ({ id: o.id ?? -1 - i, name: o.name,
          nameRsc: o.nameRsc ?? o.name, flags: o.flags ?? null, rarity: o.rarity ?? null }))
      : (s.equipment ?? []).map((name, i) => ({ id: -1 - i, name, nameRsc: name,
          flags: null, rarity: null })),
    grades_known: Array.isArray(s.equipment_items),
  });

  ok('a keeper that sends the structured list carries the grade through', () => {
    const eq = rebuild({ equipment: ['mace'],
                         equipment_items: [{ name: 'mace', id: 9001, rarity: 200 }] });
    assert.equal(eq.grades_known, true);
    assert.equal(eq.equipped[0].rarity, 200);
    assert.equal(isCursed(eq.equipped[0]), true);
    assert.equal(eq.equipped[0].id, 9001);
  });

  ok('an OLDER keeper still answers, with the names and no grades — this fleet restarts ' +
     'keepers every minute, so both shapes are live at once', () => {
    const eq = rebuild({ equipment: ['mace'] });
    assert.equal(eq.known, true);
    assert.equal(eq.equipped[0].name, 'mace');
    assert.equal(eq.equipped[0].rarity, null);
    assert.equal(eq.grades_known, false);
  });

  ok('NO SNAPSHOT AT ALL is still not "nothing equipped"', () => {
    const eq = rebuild({});
    assert.equal(eq.known, false);
    assert.equal(eq.equipped.length, 0);
    assert.equal(eq.grades_known, false);
  });
}

console.log(`\n${n} assertions, all offline.\n`);
