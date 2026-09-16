#!/usr/bin/env node
// WHAT THIS PINS: the wire name -> kod class mapping that cloning a character depends on.
//
//   node tools/m59-itemclass-test.mjs
//
// Offline: reads `compendium/data/koddb.json` and opens no socket. Two halves — a fixture,
// so the RULES are pinned whatever the game source says today, and a handful of assertions
// against the real koddb, because a resolver that is right about a fixture and wrong about
// this world's item names is the failure mode that matters.
import { itemClassIndex, resolveItemClass, giveItemCmds, KODDB } from './m59-itemclass.mjs';
import { existsSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) { passed++; console.log(`  ok   ${what}`); }
                             else { failed++; console.log(`  FAIL ${what}`); } };

// ------------------------------------------------------------------ the rules, on a fixture
const db = { classes: {
  object:     { name: 'Object', parent: '' },
  item:       { name: 'Item', parent: 'Object' },
  passiveitem:{ name: 'PassiveItem', parent: 'Item' },
  numberitem: { name: 'NumberItem', parent: 'PassiveItem' },
  weapon:     { name: 'Weapon', parent: 'PassiveItem' },
  monster:    { name: 'Monster', parent: 'Object' },
  // a stack whose singular and plural differ — the shape that has bitten this repo twice
  herbs:      { name: 'Herbs', parent: 'NumberItem', file: 'herbs.kod', resources: {
                  Herbs_name_rsc: { kind: 'string', value: 'herb' },
                  Herbs_name_plural_rsc: { kind: 'string', value: 'herbs' },
                  Herbs_desc_rsc: { kind: 'string', value: 'a sprig' } } },
  hammer:     { name: 'Hammer', parent: 'Weapon', resources: {
                  hammer_name_rsc: { kind: 'string', value: 'hammer' } } },
  // two classes wearing one name
  flask:      { name: 'Flask', parent: 'PassiveItem', resources: {
                  flask_name_rsc: { kind: 'string', value: 'flask' } } },
  arsenic:    { name: 'Arsenic', parent: 'PassiveItem', resources: {
                  arsenic_name_rsc: { kind: 'string', value: 'flask' } } },
  // a Monster is not carryable and must never be offered as an item
  orc:        { name: 'Orc', parent: 'Monster', resources: {
                  orc_name_rsc: { kind: 'string', value: 'orc' } } },
} };
const ix = itemClassIndex({ db });

console.log('\nthe rules');
ok(resolveItemClass('hammer', ix).class === 'Hammer', 'a plain item resolves to its class');
ok(resolveItemClass('HAMMER', ix).class === 'Hammer', 'the lookup is case-insensitive — the wire is not careful');
ok(resolveItemClass('  hammer ', ix).class === 'Hammer', 'and surrounding space does not defeat it');
ok(resolveItemClass('herb', ix).class === 'Herbs', 'the SINGULAR name resolves');
ok(resolveItemClass('herbs', ix).class === 'Herbs', 'and so does the plural — both are on the wire');
ok(resolveItemClass('herb', ix).stack === true, 'a NumberItem is marked as a stack');
ok(resolveItemClass('hammer', ix).stack === false, 'and a weapon is not');
ok(resolveItemClass('a sprig', ix).ok === false, 'a DESCRIPTION is not a name and does not resolve');
ok(resolveItemClass('orc', ix).ok === false, 'a Monster is never offered as an item class');
ok(resolveItemClass('nothing like this', ix).ok === false, 'an unknown name refuses');
ok(resolveItemClass('', ix).ok === false, 'so does an empty one');

console.log('\nambiguity is reported, never guessed');
const amb = resolveItemClass('flask', ix);
ok(amb.ok === false, 'a name naming two classes does not resolve');
ok((amb.candidates ?? []).sort().join(',') === 'Arsenic,Flask', 'and it names both candidates');
ok(ix.ambiguous.some(a => a.name === 'flask'), 'the index lists it as ambiguous up front');

console.log('\nthe commands');
const give = giveItemCmds({ holderId: 4346, name: 'herb', count: 60, index: ix });
ok(give.create === 'create object Herbs', 'create names the class');
ok(give.setCount(99) === 'set object 99 piNumber INT 60', 'a stack sets piNumber to the whole pile');
ok(give.repeat === 1, 'and is created ONCE — sixty Herbs objects would bury a 14-slot pack');
ok(give.give(99) === 'send object 4346 NewHold what OBJECT 99', 'the hand-over addresses the holder');
const two = giveItemCmds({ holderId: 1, name: 'hammer', count: 2, index: ix });
ok(two.setCount === null && two.repeat === 2, 'a non-stack has no count and is created once per item');
const one = giveItemCmds({ holderId: 1, name: 'hammer', count: 0, index: ix });
ok(one.repeat === 1, 'amount 0 on the wire means ONE, not none — the countIn rule');
ok(giveItemCmds({ holderId: 1, name: 'flask', index: ix }).ok === false,
   'and an ambiguous name yields no commands at all');

// ------------------------------------------------------ against this world's actual kod
if (!existsSync(KODDB)) {
  console.log('\n(skipping the live koddb checks — no compendium/data/koddb.json here)');
} else {
  console.log('\nthe real koddb');
  const real = itemClassIndex();
  ok(real.items > 200, `the item tree is populated (${real.items} classes descend from Item)`);
  // THE NON-GUESSABLE ONES. Every one of these has been hand-written wrongly somewhere.
  const expect = { 'herb': 'Herbs', 'elderberry': 'ElderBerry', 'orc teeth': 'OrcTooth',
                   'spider eye': 'Spideye', 'long sword': 'LongSword', 'mushroom': 'Mushroom' };
  for (const [name, cls] of Object.entries(expect)) {
    const r = resolveItemClass(name, real);
    ok(r.ok && r.class === cls, `"${name}" -> ${cls}${r.ok && r.class !== cls ? ` (got ${r.class})` : ''}`);
  }
  ok(resolveItemClass('elderberry', real).stack === true, 'a reagent is a stack, so one object carries the pile');
  // Ambiguity is real here and must stay refused: creating Arsenic where prod carried a
  // Flask is a poisoning, not a rounding error.
  ok(resolveItemClass('flask', real).ok === false, '"flask" is genuinely ambiguous in this kod and refuses');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
