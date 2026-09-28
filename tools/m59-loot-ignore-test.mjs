#!/usr/bin/env node
// Offline: the fleet loot-ignore rule (m59-game lootIgnored). Operator, 2026-09-28: stop picking up
// the loot that does not pay its weight — gold round shields, small round shields, leather armor, maces.
//
//   node tools/m59-loot-ignore-test.mjs
import { lootIgnored } from './m59-game.mjs';

let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) { pass++; console.log(`  ok   ${what}`); } else { fail++; console.log(`  FAIL ${what}`); } };
const RULES = [{ name: 'gold round shield', unless_unworn: 'shield' }, { name: 'small round shield', unless_unworn: 'shield' },
               { name: 'leather armor', unless_unworn: 'armor' }, { name: 'mace' }];

ok('a gold round shield is left by a character already carrying a shield', lootIgnored('gold round shield', RULES, ['knight\'s shield', 'hammer']));
ok('but taken by one wearing no shield', !lootIgnored('Gold Round Shield', RULES, ['hammer']));
ok('leather armor is left by an armoured character', lootIgnored('leather armor', RULES, ['scale armor']));
ok('and taken by an unarmoured one', !lootIgnored('leather armor', RULES, ['short sword']));
ok('a mace is always left', lootIgnored('mace', RULES, []));
ok('exact names only: "mushroom" rules do not touch purple mushroom', !lootIgnored('purple mushroom', [{ name: 'mushroom' }], []));
ok('long swords are not on the list', !lootIgnored('long sword', RULES, []));
ok('no rules, nothing ignored', !lootIgnored('mace', [], []));
ok('a bare string rule works too', lootIgnored('mace', ['mace'], []));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
