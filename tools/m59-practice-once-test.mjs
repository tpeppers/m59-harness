#!/usr/bin/env node
// OFFLINE. The practice picker (choosePractice in m59-practice-once.mjs) that a service desk or a
// drill calls between other work — no broker, no socket. Each case is a way one practice cast could
// be wasted or never happen.
import { choosePractice, SHALILLE_DRILL } from './m59-practice-once.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
// NONE IS NO ROW. In a real pack `amount: 0` is a single NON-STACKING item (a scroll, a suit of
// armour), which is why count() reads it as one — so "out of fairy wings" is an absent row.
const pack = (e, w) => [...(e ? [{ name: 'elderberry', amount: e }] : []), ...(w ? [{ name: 'fairy wing', amount: w }] : [])];
const abil = { 'holy symbol': 44, 'detect evil': 40 };

let c = choosePractice({ table: SHALILLE_DRILL, abilities: abil, pack: pack(90, 20), mana: 27 });
ok(c.pick?.spell === 'detect evil', `the LOWEST ability is practised first (got ${c.pick?.spell})`);
c = choosePractice({ table: SHALILLE_DRILL, abilities: abil, pack: pack(90, 0), mana: 27 });
ok(c.pick?.spell === 'holy symbol', 'a spell without its reagent is skipped, not attempted');
c = choosePractice({ table: SHALILLE_DRILL, abilities: abil, pack: pack(2, 0), mana: 27 });
ok(!c.pick && c.restock, `out of reagents says so and asks for a restock (${c.why})`);
c = choosePractice({ table: SHALILLE_DRILL, abilities: abil, pack: pack(90, 20), mana: 9 });
ok(c.pick?.spell === 'holy symbol', 'with mana for only the cheaper spell, that one is cast rather than waiting');
c = choosePractice({ table: SHALILLE_DRILL, abilities: abil, pack: pack(90, 20), mana: 5 });
ok(!c.pick && c.manaShort === 3, `short of mana says by how much (${c.why})`);
c = choosePractice({ table: SHALILLE_DRILL, abilities: { 'holy symbol': 30 }, pack: pack(90, 20), mana: 27 });
ok(c.pick?.spell === 'holy symbol', 'a spell the character does not know is never chosen');
c = choosePractice({ table: SHALILLE_DRILL, abilities: {}, pack: pack(90, 20), mana: 27 });
ok(!c.pick && /knows none/.test(c.why), 'knowing none of them is a refusal with the reason');
c = choosePractice({ table: SHALILLE_DRILL, abilities: abil, pack: pack(90, 20), mana: null });
ok(!c.pick, 'unread mana is not treated as enough');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
