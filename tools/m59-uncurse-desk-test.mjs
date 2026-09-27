#!/usr/bin/env node
// WHO GETS A REMOVE CURSE, AND WHAT A RELEASE SAYS, OFFLINE.   node tools/m59-uncurse-desk-test.mjs
import { suspects, castVerdict } from './m59-uncurse-desk.mjs';
import { unCursedFromSaid, UNCURSE_SAID } from './m59-skills.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => { if (cond) { passed++; console.log(`  ok   ${what}`); }
                                         else { failed++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };

const rows = [
  { agent: 'hk1', character: 'Caster', room_num: 2 },
  { agent: 'a', character: 'Holder', room_num: 2, wielding: 'short sword' },
  { agent: 'b', character: 'Clean', room_num: 2, wielding: 'hammer' },
  { agent: 'c', character: 'Away', room_num: 599, wielding: 'short sword' },
  { agent: 'd', character: 'Worn', room_num: 2, wielding: 'axe', worn: ['leather armor'] },
  { agent: 'e', character: 'Carried', room_num: 2, wielding: 'axe' },
];
const packs = new Map([
  ['a', [{ name: 'short sword', rarity: 100 }, { name: 'short sword', rarity: 0 }]],   // today's case
  ['b', [{ name: 'hammer', rarity: 0 }]],
  ['c', [{ name: 'short sword', rarity: 100 }]],
  ['d', [{ name: 'leather armor', rarity: 200 }]],
  ['e', [{ name: 'mace', rarity: 100 }]],                                                // only carried
]);
const got = suspects(rows, packs, { caster: 'hk1', room: 2 }).map(s => s.agent);
ok('a wielded unidentified weapon is a suspect, even beside a clean twin', got.includes('a'), JSON.stringify(got));
ok('a worn cursed armour piece is a suspect', got.includes('d'));
ok('a clean character is not', !got.includes('b'));
ok('someone in another room is not', !got.includes('c'));
ok('an unidentified item only CARRIED is not (a curse costs nothing until it is used)', !got.includes('e'));
ok('never the caster', !got.includes('hk1'));
const cooled = suspects(rows, packs, { caster: 'hk1', room: 2, now: 1000, last: new Map([['a', 500]]), cooldownMs: 1_800_000 });
ok('a character cast on within the cooldown is skipped', !cooled.some(s => s.agent === 'a'));

ok('the release line names the item', unCursedFromSaid('Your short sword loses its ominous luster.') === 'short sword');
ok('other lines name nothing', unCursedFromSaid('Your short sword seems a little more... ordinary.') === null);
ok('the cast\'s own line is recognised', UNCURSE_SAID.test("Shal'ille tears the cursed item from your body."));

// 2026-09-27: the first live hour read "no mana spent" as "nothing cursed" while the desk was simply
// out of emeralds, and a resting caster read the same way.
const NO_REAGENT = ["You don't have the reagents to cast remove curse!"];
ok('no emerald is not "clean", and is retried',
   castVerdict(NO_REAGENT).verdict === 'no_reagents' && castVerdict(NO_REAGENT).retry === true);
ok('a resting caster is retried', castVerdict(['You find yourself unable to cast a spell.']).retry === true);
ok('"detects no accursed items" is clean',
   castVerdict(["Shal'ille detects no accursed items to strip away."]).verdict === 'clean');
ok('a spent cast is a lift', castVerdict(['You cast remove curse on Piggy.'], 65, 61).verdict === 'lifted');
ok('silence is unknown, never clean', castVerdict([], 65, 65).verdict === 'unknown');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
