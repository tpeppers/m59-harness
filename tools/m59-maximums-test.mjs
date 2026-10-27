#!/usr/bin/env node
// Offline: the fleet-wide maximums board (m59-maximums-page.mjs) against a fleet handed in,
// and the two kod facts it stands on, read back out of substrate/m59-spells.json.
import assert from 'node:assert/strict';
import { maximumsReport, renderMaximums, spellKey, PRISM_CASTERS } from './m59-maximums-page.mjs';
import { loadSpells } from './m59-spells.mjs';

let n = 0;
const ok = (what, cond, detail) => { assert.ok(cond, `${what}${detail ? ` — ${detail}` : ''}`); n++; };

// ---- the catalogue carries what the page needs (m59-spells.mjs build)
const kod = loadSpells().spells;
const bottled = kod.filter(s => s.potion).map(s => s.name);
ok('distill can bottle rescue (rescue.kod GetPotionClass)', bottled.includes('rescue'));
ok('...and a personal enchantment (deflect)', bottled.includes('deflect'));
ok('...inherited through a parent class is still read (resist fire)', bottled.includes('resist fire'));
ok('...but not a spell whose answer is the base $ (fireball)', !bottled.includes('fireball'));
const multi = kod.filter(s => s.multicast).map(s => s.name).sort();
ok('the six multicast spells are the ones under multicst/', JSON.stringify(multi) ===
   JSON.stringify(['blood inheritance', 'bond', 'hunt', 'shadow rift', 'shatterlock', 'summon cow']), multi.join(','));

// ---- a fleet of five, handed in
const catalogue = [
  { name: 'distill', school: 'Jala', level: 3, kind: 'spell' },
  { name: 'rescue', school: 'Shal’ille', level: 2, kind: 'spell' },
  { name: 'deflect', school: 'Faren', level: 3, kind: 'spell' },
  { name: "kara'hol's curse", school: 'Qor', level: 3, kind: 'spell' },
  { name: 'hunt', school: 'Kraanan', level: 5, kind: 'spell' },
  { name: 'bond', school: 'Shal’ille', level: 6, kind: 'spell' },
  { name: 'fireball', school: 'Faren', level: 4, kind: 'spell' },
  { name: 'heal', school: 'Shal’ille', level: 1, kind: 'spell' },
];
const kodRows = [
  { name: 'rescue', potion: 'RescuePotion', multicast: false },
  { name: 'deflect', potion: 'DeflectPotion', multicast: false },
  { name: 'karahols curse', potion: 'KaraholsCursePotion', multicast: false },
  { name: 'hunt', potion: null, multicast: true },
  { name: 'bond', potion: null, multicast: true },
];
const known = { A: ['distill', 'rescue', 'hunt'], B: ['deflect', 'hunt', "Kara'hol's curse"],
                C: ['hunt', 'bond'], D: [], E: ['distill'] };
const plans = {
  D: { schools: { 'Shal’ille': 6 } },              // plans rescue and bond
  E: { abilities: [{ name: 'deflect', kind: 'spell' }], schools: { Faren: 3 } },
};
const r = maximumsReport({
  characters: Object.keys(known).map(character => ({ character })),
  catalogue, kod: kodRows, knownOf: c => known[c], planOf: c => plans[c] ?? null,
});
const row = (list, name) => r[list].find(x => x.name === name);

ok('a known spell is a full box, naming who', row('spells', 'rescue').status === 'yes' &&
   row('spells', 'rescue').known.join() === 'A');
ok('a school plan reaches every level up to it', row('spells', 'bond').planned.includes('D'));
ok('a spell only planned is half a box', row('spells', 'heal').status === 'planned' &&
   row('spells', 'heal').planned.join() === 'D');
ok('nobody: an empty box', row('spells', 'fireball').status === 'no' && !row('spells', 'fireball').known.length);
ok("the wire's apostrophes match the SID's spelling", row('spells', "kara'hol's curse").known.includes('B'),
   spellKey("Kara'hol's curse"));

ok('potion: one body with distill AND the spell', row('potions', 'rescue').status === 'yes' &&
   row('potions', 'rescue').brewers[0].character === 'A');
ok('potion: distill known + spell planned is half', row('potions', 'deflect').status === 'planned' &&
   row('potions', 'deflect').brewers.map(b => b.character).join() === 'E');
ok('potion: the spell without distill is not a brewer, but is named as the near miss',
   row('potions', "kara'hol's curse").status === 'no' && row('potions', "kara'hol's curse").spell_only.some(o => o.character === 'B'));
ok('potion: distill in one body and the spell in another does not tick it',
   !row('potions', "kara'hol's curse").brewers.length);

ok(`prism: ${PRISM_CASTERS} who know it is a full box`, row('prism', 'hunt').status === 'yes' &&
   row('prism', 'hunt').known.length === 3);
ok('prism: one knower plus one plan is short of three', row('prism', 'bond').status === 'no' &&
   row('prism', 'bond').known.length === 1 && row('prism', 'bond').planned.join() === 'D');

const r2 = maximumsReport({ characters: [{ character: 'C' }, { character: 'D' }, { character: 'F' }],
  catalogue, kod: kodRows, knownOf: c => known[c] ?? [],
  planOf: c => (c === 'F' ? { schools: { 'Shal’ille': 6 } } : plans[c] ?? null) });
ok('prism: knowers plus plans reaching three is half a box', r2.prism.find(x => x.name === 'bond').status === 'planned');

const html = renderMaximums({ report: r });
ok('the page carries its tab', html.includes('href="/maximums" class="on"'));
ok('...links the party page', /\/party\/index\.html/.test(html));
ok('...and draws all three sections', ['1. Combined', '2. Distillable', '3. Prism'].every(t => html.includes(t)));
ok('...with a planned name marked as a plan', html.includes('who p'));

console.log(`m59-maximums-test: ${n} passed`);
