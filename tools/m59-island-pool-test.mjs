// Offline: the pool-of-vigor side trip (m59-island-route topUpAtPool). Operator, 2026-10-26: "make sure trips through the
// caves both ways top up at the pool of vigor". 2510 hangs off 2504, so the walk tops up when it stands in 2504.
import { topUpAtPool, POOL_ROOM, POOL_SIDE_ROOM, MAIN_CAVES } from './m59-island-route.mjs';
let passed = 0, failed = 0;
const ok = (what, cond) => { if (cond) { passed++; console.log('  ok   ' + what); } else { failed++; console.log('  FAIL ' + what); } };
const ctxAt = (room, vigor) => ({ agent: 'tX', state: {}, call: async (tool) => {
  if (tool === 'look') return { room: { num: room }, vigor: { value: vigor }, you: { row: 1, col: 1 } };
  throw Error('unexpected call ' + tool);
} });
ok('the pool is 2510, entered from 2504', POOL_ROOM === 2510 && POOL_SIDE_ROOM === 2504);
ok('2504 is on the walking route both ways', MAIN_CAVES.includes(POOL_SIDE_ROOM) && !MAIN_CAVES.includes(POOL_ROOM));
{ const rec = {}; const t = await topUpAtPool(ctxAt(2503, 50), rec, () => {});
  ok('not standing in 2504: nothing moves', /not_at_2504/.test(t.skipped) && rec.pool_trips.length === 1); }
{ const rec = {}; const t = await topUpAtPool(ctxAt(2504, 200), rec, () => {});
  ok('already at the target: no side trip', /already_200/.test(t.skipped)); }
{ const rec = {}; const t = await topUpAtPool(ctxAt(2504, 210), rec, () => {}, { target: 200 });
  ok('above the target: no side trip', /already_210/.test(t.skipped)); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
