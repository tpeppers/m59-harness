#!/usr/bin/env node
// A JALA SINGER IS ARMED WITH ITS INSTRUMENT (pass-combat.mjs jalaSinger). Offline.
//   node tools/m59-jala-singer-test.mjs
// 2026-11-14, Loial: holding his lute in the inn he was stopped by the arming ladder every pass; holding a mace he
// practised and every song was refused (jala.kod CanPayCosts needs an instrument in use).
import { jalaSinger } from './m59-jala-singer.mjs';
let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); };
const ap = (held, drill, spells = [{ name: 'mirth', school: 6 }, { name: 'light', school: 4 }]) => ({
  policy: { practiceSpells: { enabled: true, spells: drill.map(name => ({ name, target: 'self' })) } },
  s: { client: { equipment: () => ({ known: true, equipped: held.map(name => ({ name })) }), spells } },
});
ok('lute in hand, drilling mirth (Jala): a singer', jalaSinger(ap(['lute'], ['mirth'])) === true);
ok('a school given by name also counts', jalaSinger(ap(['lute'], ['mirth'], [{ name: 'mirth', school: 'Jala' }])) === true);
ok('mace in hand: not a singer (the ladder arms it as before)', jalaSinger(ap(['mace'], ['mirth'])) === false);
ok('lute in hand but no Jala song in the drill: not a singer', jalaSinger(ap(['lute'], ['light'])) === false);
ok('a Jala song in the drill it does not know: not a singer', jalaSinger(ap(['lute'], ['truth'])) === false);
ok('equipment unknown: not a singer (never guess)', jalaSinger({ policy: {}, s: { client: { equipment: () => ({ known: false }) } } }) === false);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
