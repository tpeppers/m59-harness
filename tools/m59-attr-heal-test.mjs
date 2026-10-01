// Offline guard for tools/m59-attr-heal.mjs: a keeper re-asks for stat group 2 only when its
// attribute block is genuinely incomplete, never on a healthy one. Opens no socket.
//
//   node tools/m59-attr-heal-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attributesIncomplete } from './m59-attr-heal.mjs';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${name}`); };
const block = (over = {}) => {
  const m = new Map();
  const vals = { might: 30, intellect: 45, stamina: 40, agility: 35, mysticism: 50, aim: 25, karma: -40, ...over };
  for (const [k, v] of Object.entries(vals)) if (v !== undefined) m.set(k, { value: v, observed_at: 1000 });
  return m;
};

ok('a healthy block asks nothing -- including karma 0, which is a real value', () => {
  assert.equal(attributesIncomplete(block()), null);
  assert.equal(attributesIncomplete(block({ karma: 0 })), null);
});
ok('karma missing: re-ask', () => assert.match(attributesIncomplete(block({ karma: undefined })).why, /karma missing/));
ok('intellect 0 is an absence, not a value: re-ask', () => assert.match(attributesIncomplete(block({ intellect: 0 })).why, /intellect 0/));
ok('an empty block (t9, 2026-10-01): re-ask, and the snapshot says what was there', () => {
  const r = attributesIncomplete(new Map());
  assert.match(r.why, /karma missing.*intellect missing/);
  assert.equal(r.snapshot.karma, null);
});
ok('the snapshot carries observed_at, so the log can tell "never arrived" from "overwritten"', () => {
  assert.deepEqual(attributesIncomplete(block({ intellect: 0 })).snapshot.intellect, { value: 0, observed_at: 1000 });
});
ok('no client yet: nothing to judge', () => assert.equal(attributesIncomplete(null), null));
ok('the keeper heals only in game, never during a handoff, once a minute, and logs once per drop', () => {
  const src = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  assert.ok(/if \(!inGame \|\| !session\.live \|\| handoffActive\(\)\) return;\s*const bad = attributesIncomplete/.test(src));
  assert.ok(src.includes('if (!bad) { attrHealReported = false; return; }'));
  assert.ok(src.includes('}, ATTR_HEAL_EVERY_MS);'));
});

console.log(`\n${n} passed`);
