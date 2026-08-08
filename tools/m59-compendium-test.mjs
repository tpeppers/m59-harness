#!/usr/bin/env node
// TURNING A LIVE CHARACTER INTO A REFERENCE CHARACTER. Offline, no server, no browser:
//
//   node tools/m59-compendium-test.mjs
//
// The bestiary computes every row against a "build" — six attributes, five combat
// skills, a weapon class and one armour class per slot. A live character has all of
// that, but not in that shape, and every step of the translation can go wrong quietly:
//
//   * a skill name that does not exist reads as "not learned", which is a legitimate
//     answer, so a wrong name is invisible. Seven of the eight weapon proficiencies
//     were wrong for exactly this reason.
//   * gear is matched by DISPLAY NAME between two vocabularies that were written years
//     apart, and an unmatched item would otherwise silently become an empty slot.
//   * a skill the character never learned is 0, and 0 is a number the whole table is
//     then computed from. That has to be reported, not just used.
//
// So this checks the translation against the compendium's real vocabulary, and pins
// the proficiency names against the server's own resource strings.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFromCharacter, COOKIE, importUrl } from './m59-compendium.mjs';
import { proficiencyFor, WEAPON_PROFICIENCY } from './m59-skills.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? `  ${extra}` : ''}`); }
};
const eq = (what, got, want) =>
  ok(what, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const DATA = JSON.parse(readFileSync(
  fileURLToPath(new URL('../compendium/creatures.json', import.meta.url)), 'utf8'));

// A character as the three broker tools report one.
const character = ({ name = 'Kermit', equipped = [], skills = [], health = 29 } = {}) => ({
  status: {
    character: name, agent: 't1',
    vitals: { health: { value: health, max: health } },
    attributes: {
      might: { value: 35 }, intellect: { value: 30 }, stamina: { value: 50 },
      agility: { value: 35 }, mysticism: { value: 30 }, aim: { value: 20 },
    },
  },
  equipment: { known: true, equipped: equipped.map((n, i) => ({ id: i + 1, name: n })) },
  abilities: { skills: skills.map(([n, a]) => ({ name: n, ability: a })), spells: [] },
  data: DATA,
});

// ------------------------------------------------- the names the server actually uses

console.log('\nthe proficiency names are the server\'s, not invented');
{
  // Verbatim from each skill's own resource string in kod. Seven of these eight used
  // to be made up, and because the only consumer is a by-name lookup, every one of
  // them returned "this character has no such skill" for ever.
  eq('a mace trains mace fighting', proficiencyFor('mace'), 'mace fighting');
  eq('a long sword trains fencing', proficiencyFor('long sword'), 'fencing');
  eq('an axe trains axe wielding', proficiencyFor('battle axe'), 'axe wielding');
  eq('a scimitar trains scimitar wielding', proficiencyFor('scimitar'), 'scimitar wielding');
  eq('a hammer trains hammer wielding', proficiencyFor('war hammer'), 'hammer wielding');
  eq('a short sword has its own', proficiencyFor('short sword'), 'short sword fighting');
  eq('a bow trains archery', proficiencyFor('crossbow'), 'archery');
  // The one that has to keep working: every sword routes to SKID 451 whatever it is
  // called, and the short sword must not fall through to it.
  eq('a nerudite sword is still fencing', proficiencyFor('nerudite sword'), 'fencing');
  ok('and nothing still says "proficiency"',
     !WEAPON_PROFICIENCY.some(([, n]) => /proficiency/i.test(n)),
     JSON.stringify(WEAPON_PROFICIENCY.map(x => x[1])));
}

// ------------------------------------------------------------------ the translation

console.log('\na character with a weapon and armour');
{
  const b = buildFromCharacter(character({
    equipped: ['mace', 'chain armor', 'helm'],
    skills: [['mace fighting', 20], ['slash', 14], ['parry', 31], ['dodge', 9]],
  }));
  eq('the weapon becomes its compendium class', b.weapon, 'Mace');
  eq('armour lands in the right slots', b.gear, { body: 'ChainArmor', head: 'SimpleHelm' });
  eq('the proficiency is the one for what is held', b.skills.proficiency, 20);
  eq('the stroke is the one it would swing', b.skills.stroke, 14);
  eq('defences come across', [b.skills.parry, b.skills.dodge], [31, 9]);
  eq('attributes come across', b.stats.might, 35);
  eq('and max health is the level', b.maxHealth, 29);
  eq('block was never learned, so it is zero AND reported',
     [b.skills.block, b.from.missing_skills], [0, ['block']]);
}

console.log('\nthe stroke depends on what is in the hand');
{
  const melee = buildFromCharacter(character({
    equipped: ['long sword'], skills: [['slash', 10], ['thrust', 40], ['fire', 99]] }));
  eq('a melee weapon takes the better of slash and thrust', melee.from.stroke, 'thrust');
  eq('and its number', melee.skills.stroke, 40);
  ok('not the archery stroke, however good it is', melee.skills.stroke !== 99);

  const bow = buildFromCharacter(character({
    equipped: ['crossbow'], skills: [['slash', 10], ['fire', 55]] }));
  eq('a bow takes fire', [bow.from.stroke, bow.skills.stroke], ['fire', 55]);

  const fist = buildFromCharacter(character({
    equipped: [], skills: [['Unarmed Combat', 7], ['brawling', 12], ['slash', 90]] }));
  eq('an empty hand takes Unarmed Combat', fist.from.stroke, 'Unarmed Combat');
  eq('and brawling stands in for the proficiency', fist.skills.proficiency, 12);
  // calc.mjs reaches for these when there is no weapon; without them an unarmed
  // character is modelled as a swordsman who happens to be holding nothing.
  eq('both unarmed numbers are carried', [fist.skills.punch, fist.skills.brawling], [7, 12]);
  eq('and no weapon class is claimed', fist.weapon, '');
}

// The two vocabularies overlap, and the overlap is a trap: `Helm` is the CLASS of
// "magic spirit helmet", while the item called "helm" has the class `SimpleHelm`.
// Matching either in one pass picks whichever comes first in the file, and computes
// the table against a defence bonus the character does not have.
console.log('\nwhen a display name collides with somebody else\'s class name');
{
  const plain = buildFromCharacter(character({ equipped: ['helm'] }));
  eq('a plain helm is the item CALLED helm', plain.gear.head, 'SimpleHelm');
  const magic = buildFromCharacter(character({ equipped: ['magic spirit helmet'] }));
  eq('and the magic one is still reachable by its own name', magic.gear.head, 'Helm');
  // The class remains usable for anything that deliberately passes one.
  const byClass = buildFromCharacter(character({ equipped: ['ChainArmor'] }));
  eq('a class name still matches', byClass.gear.body, 'ChainArmor');
}

console.log('\ngear the compendium has no entry for');
{
  const b = buildFromCharacter(character({
    equipped: ['mace', 'a thing that does not exist'], skills: [['mace fighting', 20]] }));
  eq('the weapon still resolves', b.weapon, 'Mace');
  // Silently dropping it would leave a table computed as if the character were not
  // wearing the thing it is wearing, and nothing on the page would say so.
  eq('and the unmatched item is named', b.from.unmatched_gear, ['a thing that does not exist']);
}

console.log('\ntwo things in one slot');
{
  // kod allows it via CanBeWornInSameSlotWith; the bestiary has one select per slot.
  const b = buildFromCharacter(character({ equipped: ['chain armor', 'plate armor'] }));
  eq('the first wins', b.gear.body, 'ChainArmor');
  ok('and both are still listed as worn', b.from.worn.length === 2, JSON.stringify(b.from.worn));
}

console.log('\na character we know nothing about');
{
  const b = buildFromCharacter(character({ equipped: [], skills: [] }));
  // Every skill zero is a legitimate build and the page will happily compute from it,
  // so the report is the only thing standing between that and a table of fiction.
  ok('every combat skill is reported missing',
     ['stroke (Unarmed Combat)', 'brawling', 'parry', 'block', 'dodge']
       .every(k => b.from.missing_skills.includes(k)), JSON.stringify(b.from.missing_skills));
  ok('the build is still valid enough to compute', b.skills.stroke === 0 && b.stats.might === 35);
}

console.log('\nwhat the page is told about where this came from');
{
  const b = buildFromCharacter(character({
    equipped: ['mace'], skills: [['mace fighting', 20], ['slash', 14]] }));
  eq('the character is named', b.from.character, 'Kermit');
  eq('and so is the proficiency it used', b.from.proficiency, 'mace fighting');
  ok('the build is marked live so the page can say so', b.live === true);
  eq('and it is a detailed build — simple mode cannot express imported gear', b.mode, 'detailed');
}

console.log('\nthe import URL');
{
  const u = importUrl('t1', '/creatures/', 8099);
  ok('is loopback', u.startsWith('http://127.0.0.1:8099/'), u);
  ok('carries the agent', /agent=t1/.test(u));
  ok('and the destination, encoded', /to=%2Fcreatures%2F/.test(u), u);
  eq('the cookie has a stable name', COOKIE, 'm59char');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
