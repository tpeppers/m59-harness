// Offline guard for PREFER MUNDANE (policy.preferMundaneWeapon, c._preferMundane, weaponRanking's inverted tie-break,
// Autopilot.syncMagicSet / applyMagicPreference). Opens no socket.
//
//   node tools/m59-prefer-mundane-test.mjs
//
// Operator, 2026-10-12, of the Ukgoth troll crew: "they should keep two weapons (one Kraanan dedicated for trolls, one
// undedicated for spiders/orcs/etc.)". prefer_magic_weapon already makes the dedicated one win inside the family in
// the troll rooms; this is the other half. Pinned: the mundane twin wins only when asked and only inside the family;
// prefer magic is untouched; silence is the old ranking.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { weaponRanking } from './m59-skills.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const names = ['hammer', 'hammer', 'axe'];
const client = (magic, preferMundane = false) => ({
  inventory: names.map((nm, i) => ({ id: i + 1, nameRsc: 1000 + i, flags: 0 })),
  rsc: { get: r => names[r - 1000] ?? '' }, using: new Set(), _magicWeaponIds: magic, _preferMundane: preferMundane,
});
const order = (magic, preferMundane, priority = ['hammer']) =>
  weaponRanking(client(magic, preferMundane), { priority }).map(r => r.o.id).join();

await ok('prefer magic (unchanged): the dedicated hammer (2) first', () => assert.ok(order(new Set([2]), false).startsWith('2,1')));
await ok('prefer mundane: the undedicated hammer (1) first', () => assert.ok(order(new Set([2]), true).startsWith('1,2')));
await ok('...and never across the family: a magic axe does not jump the hammers either way', () => {
  assert.ok(order(new Set([3]), true).startsWith('1,2'));
  assert.ok(order(new Set([3]), true).endsWith('3'));
});
await ok('silence: no magic set, the old order', () => assert.ok(order(null, true).startsWith('1,2')));

await ok('the keeper: the setting, the magic set kept while preferring mundane, and the swap', () => {
  const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('preferMundaneWeapon: false,'));
  assert.ok(src.includes("const mundane = !on && this.policy?.preferMundaneWeapon === true;"));
  assert.ok(src.includes('c._preferMundane = mundane;'));
  assert.ok(src.includes("this.note('MUNDANE SWAP'"));
  const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  assert.ok(broker.includes('p.policy.preferMundaneWeapon = a.prefer_mundane_weapon === true;'));
});

console.log(`\n${n} passed`);
