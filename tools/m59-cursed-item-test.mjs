#!/usr/bin/env node
// Offline contract for cursed-weapon detection. Opens no socket and joins nobody.
//
// The bug this pins: WeapAttCursed renders the "cursed %s" name prefix only once the
// attribute has been IDENTIFIED (wacursed.kod:36), and every loot attribute starts
// unidentified. So a cursed weapon straight off the floor is called "mystic sword", and a
// detector that reads the NAME hands the character the one item that can never come off --
// ItemReqUnuse returns FALSE unconditionally (wacursed.kod:97-102). That is what happened
// to Floyd on 2026-09-08: our own equip_best wielded it.
//
// The server does say so, twice: once in the description, and once in the refusal it sends
// on every failed unuse, drop, give and vault. These tests are about believing the refusal.

import {
  CURSE_SAID, cursedFromSaid, markCursedItem, noteCursedFromMessage, isCursedItem,
  isCursed, weaponRanking,
} from './m59-skills.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => {
  if (cond) { passed++; console.log('  ok  ', what); }
  else { failed++; console.log('  FAIL', what); }
};

// A client stub shaped like the real one where these functions touch it.
const clientWith = (items) => ({
  inventory: items.map((it, i) => ({ id: it.id ?? i + 1, nameRsc: 1000 + i, flags: 0 })),
  rsc: { get: (r) => items[r - 1000]?.name ?? '' },
  using: new Set(),
});

console.log('\nthe name alone does not find an unidentified curse');
{
  ok('an identified curse is caught by name', isCursed('cursed mystic sword'));
  ok('an UNidentified curse is invisible to the name test', !isCursed('mystic sword'));
}

console.log('\nthe refusal message is parsed');
{
  const said = 'The mystic sword seems to cling to your hand!';
  ok('the refusal matches CURSE_SAID', CURSE_SAID.test(said));
  ok('the item name is recovered from it', cursedFromSaid(said) === 'mystic sword');
  ok('a lower-case article is handled', cursedFromSaid('a rusty axe seems to cling to your hand!')
     === 'rusty axe');
  ok('an unrelated line yields null, not a false positive',
     cursedFromSaid('You hit the fungus beast.') === null);
  ok('empty input is null', cursedFromSaid('') === null && cursedFromSaid(null) === null);
}

console.log('\na learned curse sticks to the session');
{
  const c = clientWith([{ name: 'mystic sword' }]);
  ok('unknown at first', !isCursedItem(c, c.inventory[0], 'mystic sword'));
  ok('the message is recorded',
     noteCursedFromMessage(c, 'The mystic sword seems to cling to your hand!', 1));
  ok('now known by id', isCursedItem(c, c.inventory[0], 'mystic sword'));
  ok('and known by name, so a second copy is refused too',
     isCursedItem(c, { id: 99, nameRsc: 1000 }, 'mystic sword'));
  ok('an unrelated weapon stays clean', !isCursedItem(c, { id: 98 }, 'short sword'));
  ok('a non-curse message records nothing',
     noteCursedFromMessage(c, 'You feel better.', 5) === false);
}

console.log('\nweaponRanking will not offer a weapon the server refused to release');
{
  const c = clientWith([{ name: 'mystic sword' }, { name: 'short sword' }]);
  const before = weaponRanking(c).map(x => x.name);
  ok('both weapons rank while nothing is known', before.length === 2);
  markCursedItem(c, { id: 1, name: 'mystic sword' });
  const after = weaponRanking(c).map(x => x.name);
  ok('the cursed one drops out', !after.includes('mystic sword'));
  ok('the clean one survives', after.includes('short sword'));
}

console.log('\nan explicitly named cursed weapon is still refused without any message');
{
  const c = clientWith([{ name: 'cursed long sword' }, { name: 'short sword' }]);
  const names = weaponRanking(c).map(x => x.name);
  ok('the name prefix alone is enough', !names.includes('cursed long sword'));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
