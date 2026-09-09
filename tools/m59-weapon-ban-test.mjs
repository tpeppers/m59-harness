#!/usr/bin/env node
// Offline contract for banned weapons. Opens no socket and joins nobody.
//
// A priority list is a PREFERENCE and its last entry is still an entry: with nothing better
// in the pack, equip_best walks to the bottom of the list and wields whatever is there. On
// this fleet that was `mace`, and the same character was found holding one three times in
// one evening while the operator watched it be reported rather than fixed.
//
// It is not cosmetic. Mace fighting is Weaponcraft LEVEL 1 and the level-3 unlock counts
// only the top three LEVEL-2 abilities, so a mace trains a number no threshold reads while
// displacing bare hands, which train brawling -- level 2, and uncapped on this quarry.
// Swinging it is strictly worse than swinging nothing.

import { weaponRanking, isBannedWeapon, markCursedItem } from './m59-skills.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => {
  if (cond) { passed++; console.log('  ok  ', what); }
  else { failed++; console.log('  FAIL', what); }
};

const clientWith = (items) => ({
  inventory: items.map((n, i) => ({ id: i + 1, nameRsc: 1000 + i, flags: 0 })),
  rsc: { get: (r) => items[r - 1000] ?? '' },
  using: new Set(),
});

console.log('\nthe predicate itself');
{
  ok('no list bans nothing', !isBannedWeapon('mace', null) && !isBannedWeapon('mace', []));
  ok('an exact name is banned', isBannedWeapon('mace', ['mace']));
  ok('substring, so a variant is caught too', isBannedWeapon('rusty mace', ['mace']));
  ok('case does not matter', isBannedWeapon('MACE', ['Mace']));
  ok('an unrelated weapon is untouched', !isBannedWeapon('short sword', ['mace']));
  ok('an empty name is not banned', !isBannedWeapon('', ['mace']));
}

console.log('\nranking drops a banned weapon even when it is all there is');
{
  const c = clientWith(['mace']);
  ok('ranked without a ban', weaponRanking(c).length === 1);
  ok('and gone with one', weaponRanking(c, { banned: ['mace'] }).length === 0);
}

console.log('\nthe ban outranks the priority list, which is the whole point');
{
  const c = clientWith(['mace', 'short sword']);
  const ranked = weaponRanking(c, { priority: ['mace', 'short sword'], banned: ['mace'] });
  ok('the banned weapon is not first', ranked[0]?.name !== 'mace');
  ok('it is not anywhere', !ranked.some(x => x.name === 'mace'));
  ok('the legal weapon survives', ranked.some(x => x.name === 'short sword'));
}

console.log('\nbanning is about CHOOSING, not about carrying');
{
  // Nothing here stops a banned weapon being carried, looted or sold -- taking it to a
  // merchant is exactly what should happen to it, and merchantEquipmentPlan is deliberately
  // not given the ban list.
  const c = clientWith(['mace']);
  ok('the pack still holds it', c.inventory.length === 1);
}

console.log('\na curse still wins, because a curse cannot be unwielded');
{
  // WeapAttCursed refuses every unuse unconditionally (wacursed.kod:97-102), so a cursed
  // weapon already in the hand stays there whatever a ban says. The ban is on the CHOICE;
  // this checks the two filters are independent rather than one masking the other.
  const c = clientWith(['scimitar', 'short sword']);
  markCursedItem(c, { id: 1, name: 'scimitar' });
  const ranked = weaponRanking(c, { banned: ['mace'] });
  ok('a cursed weapon is refused by the curse filter, not the ban',
     !ranked.some(x => x.name === 'scimitar'));
  ok('and the clean one is still offered', ranked.some(x => x.name === 'short sword'));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
