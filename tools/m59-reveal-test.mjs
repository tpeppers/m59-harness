#!/usr/bin/env node
// THE IDENTIFICATION SERVICE'S RULES, offline: no socket, no roster, no broker, no fleet.
//
// Everything here pins a decision that costs orc teeth to get wrong. Teeth are 325 each at
// Paddock and there is no way to get them back, so "it cast at the wrong thing" is a bill
// rather than a log line.
import assert from 'node:assert/strict';
import { ITEM_RARITY, rarityName, isUnidentified } from './m59-items.mjs';
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

console.log(`\n${n} assertions, all offline.\n`);
