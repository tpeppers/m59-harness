#!/usr/bin/env node
// OFFLINE. The practice picker (choosePractice in m59-practice-once.mjs) that a service desk or a
// drill calls between other work — no broker, no socket. Each case is a way one practice cast could
// be wasted or never happen.
import { choosePractice, practiceOnce, maxTranceMs, SHALILLE_DRILL } from './m59-practice-once.mjs';

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

// NEVER RETURN MID-TRANCE. The reagent is paid BEFORE the trance (user.kod:4822 then :4825), so a
// fake whose cast reply comes back at once, reagent already gone, is exactly the case that used to
// return while the spell was still charging.
const TABLE = [{ spell: 'holy symbol', reagent: /^elderberry$/i, per: 3, mana: 8, self: false, castMs: 1500, school: "Shal'ille" }];
function fake(castReply) {
  let berries = 90; const calls = [];
  const call = async (tool) => {
    calls.push({ tool, at: Date.now() });
    if (tool === 'inventory') return { items: [{ name: 'elderberry', amount: berries }] };
    if (tool === 'status') return { mana: { value: 30 }, vigor: { value: 190 } };
    if (tool === 'abilities') return { spells: [{ name: 'holy symbol', ability: 40 }] };
    if (tool === 'cast') { const r = castReply(); if (r.paid) berries -= 3; return r; }
    return {};
  };
  return { call, calls };
}
{
  const f = fake(() => ({ paid: true, sent: true, said: ['You focus your whole will on casting holy symbol.'] }));
  const t0 = Date.now();
  const r = await practiceOnce({ call: f.call, agent: 't3', table: TABLE });
  const took = Date.now() - t0;
  ok(took >= maxTranceMs(1500) - 50, `a charging cast is waited out to its longest trance (${took}ms >= ${maxTranceMs(1500)}ms)`);
  ok(r.outcome === 'success', `and only then judged by the reagent (${r.outcome})`);
  const castAt = f.calls.find(c => c.tool === 'cast').at;
  ok(f.calls.filter(c => c.at > castAt && c.tool !== 'inventory').length === 0, 'nothing but a pack read is sent during the trance');
}
{
  const f = fake(() => ({ sent: true, said: ['You were unsuccessful in casting holy symbol.'] }));
  const t0 = Date.now();
  const r = await practiceOnce({ call: f.call, agent: 't3', table: TABLE });
  ok(r.outcome === 'fizzle' && Date.now() - t0 < 300, 'a failed chance roll has no trance and returns at once');
}
{
  const f = fake(() => ({ paid: true, sent: true, said: ['You focus your whole will on casting holy symbol.',
    'Your concentration is broken and the holy symbol spell fizzles.'] }));
  const r = await practiceOnce({ call: f.call, agent: 't3', table: TABLE });
  ok(r.outcome === 'broken', `a broken trance is reported as broken, not success (${r.outcome})`);
}
ok(SHALILLE_DRILL.every(t => t.castMs > 0), 'every drill spell carries its kod cast time');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
