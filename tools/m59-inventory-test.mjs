#!/usr/bin/env node
// Offline tests for m59-inventory.mjs — the classifier and the drop plan. No socket, no roster.
import { classify, dropCandidates, KEEP, HALL_STASH_KEEP } from './m59-inventory.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };

ok(classify('elderberry') === 'reagent', 'elderberry is a REAGENT, not food (a dedicator dropped 18 as "food", 2026-09-25)');
ok(classify('herbs') === 'reagent' && classify('Inky-cap mushroom') === 'reagent', 'herbs and every mushroom are reagents');
ok(classify('blue dragon scale') === 'reagent', 'a blue dragon scale is a reagent, not junk');
ok(classify('loaf of bread') === 'food' && classify('slice of pork') === 'food', 'bread and pork are food (the game Food class tree)');
ok(classify('Chalice of the Rain') === 'cup', 'the chalice is the cup');
ok(classify('shilling') === 'money', 'money');
ok(classify('long sword') === 'weapon' && classify('hammer') === 'weapon', 'weapons');
ok(classify('chain armor') === 'armour' && classify("knight's shield") === 'armour', 'armour and shields');
ok(classify('ring of lethargy') === 'magic', 'jewellery is kept as magic');
ok(classify('ore chunk') === 'junk', 'ore is junk');

const pack = [
  { id: 1, name: 'elderberry', amount: 40 }, { id: 2, name: 'loaf of bread', amount: 59 },
  { id: 3, name: 'ore chunk', amount: 3 }, { id: 4, name: 'long sword', amount: 1 },
  { id: 5, name: 'Chalice of the Rain', amount: 1 }, { id: 6, name: 'shilling', amount: 500 },
  { id: 7, name: 'slice of pork', amount: 8 }, { id: 8, name: 'leather armor', amount: 1 },
  { id: 9, name: 'strange trinket', amount: 1 },
];
const plan = dropCandidates(pack, ['leather armor'], { profile: KEEP.raid, keepFood: 10 });
const names = plan.map(p => p.item.name);
ok(!names.includes('elderberry'), 'makeRoom never drops a reagent');
ok(!names.includes('Chalice of the Rain') && !names.includes('shilling') && !names.includes('long sword'), 'never the cup, money or a weapon');
ok(!names.includes('leather armor'), 'never anything worn');
ok(names.indexOf('ore chunk') >= 0 && names.indexOf('ore chunk') < names.indexOf('loaf of bread'), 'junk goes before food');
ok(plan.find(p => p.item.name === 'loaf of bread')?.amount === 49, 'food keeps 10 of each kind and drops only the excess');
ok(!names.includes('slice of pork'), 'a food stack at or under the keep is left alone');
ok(names.includes('strange trinket'), 'unknown loot is junk');
ok(dropCandidates(pack, [], { profile: KEEP.all }).every(p => classify(p.item.name) === 'junk'), 'KEEP.all drops junk only');

ok(HALL_STASH_KEEP.includes('chalice') && HALL_STASH_KEEP.includes('sword'), 'the hall stash keeps the cup and weapons');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
