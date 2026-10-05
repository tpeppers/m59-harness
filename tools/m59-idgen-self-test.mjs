// Offline guard: the stale-id gate never refuses the character's OWN object id.
//
// 2026-10-05: Pepe's and Statler's remove-curse loops cast on themselves by object id. That id is
// handed out with no name (`look.you.object_id`), so after the first server save the by-name
// re-resolution could never vouch for it, and every self-cast in the fleet was refused -- ~1,400 a
// character, read by the loop as "nothing said". (m59-idgen-test.mjs dies at its own line 149 at
// HEAD, a fixed timestamp aged past the registry's 12 h limit, so these live here.)
//
//   node tools/m59-idgen-self-test.mjs
import assert from 'node:assert/strict';
import { SaveClock, IdRegistry, judgeArgs, reresolveRefs } from './m59-idgen.mjs';

const now = Date.now();
const clock = new SaveClock();
clock.observe({ began: now - 60_000, ended: now - 59_000 }, 't2');
const reg = new IdRegistry();
reg.note('t2', 4461, { name: null, at: now - 3_600_000 });      // self, nameless, before the save
reg.note('t2', 8568, { name: null, at: now - 3_600_000 });      // something else, nameless, before the save

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${name}`); };

const refs = judgeArgs({ target: 4461 }, { agent: 't2', registry: reg, clock, now, keys: ['target'] });
ok('the nameless self id is still judged stale by the registry', () => assert.equal(refs.length, 1));
ok('but it equals the session\'s own id now, so it is kept', () => {
  const rr = reresolveRefs(refs, { candidates: [], clock, selfId: 4461 });
  assert.equal(rr.ok, true); assert.equal(rr.subs[0].how, 'self'); assert.equal(rr.subs[0].to, 4461);
});
ok('any OTHER nameless stale id is still refused', () => {
  const other = judgeArgs({ target: 8568 }, { agent: 't2', registry: reg, clock, now, keys: ['target'] });
  assert.equal(reresolveRefs(other, { candidates: [], clock, selfId: 4461 }).ok, false);
});
ok('without a self id, the old refusal stands', () => {
  assert.equal(reresolveRefs(refs, { candidates: [], clock }).ok, false);
});

console.log(`\n${n} passed`);
