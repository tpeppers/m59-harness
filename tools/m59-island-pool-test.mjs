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
// THE KEEPER DRINKS TOO (operator, 2026-10-27: "It should also drink from the pool of vigor if in that room").
{
  const { Autopilot } = await import('./m59-autopilot.mjs');
  const { POOL_OF_VIGOR: P } = await import('./m59-island-chalice.mjs');
  function keeper({ room = 2510, vigor = 90, at = { row: 30, col: 30 }, full = 3, health = 80, held = false } = {}) {
    let seq = 0, drinks = 0; const events = [];
    const c = { get evSeq() { return seq; }, self: { ...at }, room: { num: room }, trade: null,
      vitals: () => ({ health: { value: health, max: 80 }, vigor: { value: vigor, scale_max: 200 } }),
      go: () => { if (drinks < full) { drinks++; vigor = Math.min(200, vigor + 40); events.push({ seq: ++seq, kind: 'message', text: 'You drink from the life-giving waters.' }); } },
      waitFor: async ({ since, match }) => ({ events: events.filter(e => e.seq > since && (!match || match(e))) }) };
    const notes = [];
    const k = Object.assign(Object.create(Autopilot.prototype), { running: true, inert: false, policy: {}, tally: {},
      s: { client: c, world: { room: { num: room } }, pacer: { submit: async (_k, f) => f() },
           walkTo: async (col, row) => { c.self = { row, col }; } },
      note: (w, d) => notes.push({ w, d }), progress: () => {}, facultyHeld: () => held, threat: () => ({ landing: 0 }) });
    return { k, c, notes, drinks: () => drinks };
  }
  let f = keeper();
  ok('the KEEPER: a body in 2510 below full vigor walks into the pool and drinks until the stomach is full',
     await f.k.drinkAtPoolOfVigor() === true && f.drinks() === 3 && f.c.self.row >= P.rows[0] && f.c.self.row <= P.rows[1]);
  f = keeper({ vigor: 200 });
  ok('the keeper at full vigor does nothing', await f.k.drinkAtPoolOfVigor() === false && f.drinks() === 0);
  f = keeper({ room: 2500 });
  ok('the keeper in any other room does nothing', await f.k.drinkAtPoolOfVigor() === false && f.drinks() === 0);
  f = keeper({ held: true });
  ok('the keeper does nothing while something else holds its movement', await f.k.drinkAtPoolOfVigor() === false);
  f = keeper({ health: 30 });
  ok('the keeper does nothing hurt (under half health)', await f.k.drinkAtPoolOfVigor() === false);
  f = keeper(); await f.k.drinkAtPoolOfVigor();
  ok('the keeper drinks at most once a minute', await f.k.drinkAtPoolOfVigor() === false);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
