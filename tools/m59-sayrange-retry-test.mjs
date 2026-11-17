// Offline: sayToNpc says a quest request again when the reply is not the one asked for (silence, or another quest's line),
// up to `retries` more times, and stops as soon as the expected line arrives. Operator 2026-11-17.
import { sayToNpc } from './m59-sayrange.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => { if (cond) { pass++; console.log(`  ok   ${what}`); } else { fail++; console.log(`  FAIL ${what} ${extra}`); } };
const look = async () => ({ you: { row: 10, col: 10 }, objects: [{ name: 'Bahal zax\'Ot', row: 10, col: 11 }] });
const scripted = answers => { let n = 0; return { calls: () => n, speak: async () => ({ spoken_ok: true, replies: (answers[n++] ?? []).map(text => ({ text })) }) }; };
const EXPECT = /seraphym|bring me/i;

{
  const s = scripted([[], ['Bahal zax\'Ot tells you, "Bring me a polished seraphym."']]);
  const r = await sayToNpc({ text: 'kohuzotz', to: 'Bahal', expect: EXPECT, retries: 2 }, { look, walkTo: async () => ({}), speak: s.speak });
  ok('silence is followed by the same words, and the second answer is the quest', s.calls() === 2 && r.matched === true && r.attempts === 2, JSON.stringify(r));
}
{
  const s = scripted([['Bahal zax\'Ot tells you, "I\'m practicing my jeweling if you can bring my any unpolished gems."'],
    ['Bahal zax\'Ot tells you, "Bring me a polished seraphym."']]);
  const r = await sayToNpc({ text: 'kohuzotz', to: 'Bahal', expect: /seraphym/i, retries: 2 }, { look, walkTo: async () => ({}), speak: s.speak });
  ok('another quest\'s line is asked past', s.calls() === 2 && r.matched === true, JSON.stringify(r));
  ok('every reply heard is returned', r.replies.length === 2);
}
{
  const s = scripted([[], [], [], []]);
  const r = await sayToNpc({ text: 'kohuzotz', to: 'Bahal', expect: EXPECT, retries: 2 }, { look, walkTo: async () => ({}), speak: s.speak });
  ok('retries are bounded: 1 + 2 says, then an honest no-match', s.calls() === 3 && r.matched === false && r.attempts === 3, JSON.stringify(r));
}
{
  const s = scripted([['Bahal zax\'Ot tells you, "Bring me a polished seraphym."']]);
  const r = await sayToNpc({ text: 'kohuzotz', to: 'Bahal', expect: EXPECT, retries: 2 }, { look, walkTo: async () => ({}), speak: s.speak });
  ok('a first answer that matches is never repeated', s.calls() === 1 && r.matched === true);
}
{
  const s = scripted([[]]);
  const r = await sayToNpc({ text: 'hello', to: 'Bahal' }, { look, walkTo: async () => ({}), speak: s.speak });
  ok('silence is the old behaviour: no expect, one say', s.calls() === 1 && r.matched === undefined && r.outcome === 'no_reply');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
