#!/usr/bin/env node
// A PACK FULL OF WHAT IT KEEPS OPENS NO SELL TRIP.   node tools/m59-keepfull-test.mjs
//
// Offline: binds Autopilot.prototype methods to a rig. Opens no socket.
//
// 2026-09-28: the courier sat at 97% of capacity in 10 stacks, every one of them kept (gems,
// reagents, bread for the crew). checkIfShouldSell measured the WHOLE pack, so the load trigger
// fired, the courier walked to Barloque to sell what it could never sell, and died on the road
// seven times in ninety minutes, dropping the guild's gems each time. "A trip that cannot fix the
// thing that opened it will run for ever" (CLAUDE.md). A trip now opens only when what the counter
// would sell brings the pack back under the trigger, or frees a real share of it.
import { Autopilot } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => { if (cond) { passed++; console.log(`  ok   ${what}`); }
                                         else { failed++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };

// Ten stacks of 'diamond' against a max_carry of 5: the STACKS trigger is due.
const rig = ({ relief, policy = {}, stacks = 10 } = {}) => {
  const notes = [];
  const r = Object.create(Autopilot.prototype);
  Object.assign(r, {
    policy: { strategy: 'fieldrest', maxCarry: 5, minSellTripValue: 0, ...policy },
    s: { client: { inventory: Array.from({ length: stacks }, (_, i) => ({ id: i + 1, nameRsc: 'diamond', amount: 1 })),
                   rsc: { get: x => x }, stat: () => 0 },
         world: { room: { num: 2 } } },
    note: (what, data) => notes.push({ what, ...data }),
    bansDestination: () => false,
    standingOrderUnstarted: () => null,
    overfarmHoldsTrip: () => null,
    supplyShortfall: () => null,
  });
  if (relief !== undefined) r.saleRelief = () => relief;
  return { r, notes };
};
const relief = (stacksAfter, after = 0.1) => ({ after, stacksAfter,
  fixesLoad: (at, now = 1) => after < at || now - after >= 0.25,
  fixesStacks: (max, now = Infinity) => stacksAfter < max || now - stacksAfter >= 5,
  summary: { stacks: stacksAfter } });

{
  const { r, notes } = rig({ relief: relief(10) });
  const d = r.checkIfShouldSell();
  ok('a pack full of kept stock opens no sell trip', d.sell === false, JSON.stringify(d));
  ok('and says why, once', notes.filter(n => n.what === 'sell trip held: the pack is full of what it keeps').length === 1,
     JSON.stringify(notes));
  r.checkIfShouldSell();
  ok('the note is throttled', notes.filter(n => /full of what it keeps/.test(n.what)).length === 1);
}
{
  const { r } = rig({ relief: relief(3) });
  const d = r.checkIfShouldSell();
  ok('a pack the counter can bring under the ceiling still goes', d.sell === true && d.trigger === 'stacks', JSON.stringify(d));
}
{
  const { r } = rig({ relief: relief(5), stacks: 10 });
  const d = r.checkIfShouldSell();
  ok('freeing five stacks is worth the road even above the ceiling', d.sell === true, JSON.stringify(d));
}
{
  const { r } = rig({ relief: null });
  const d = r.checkIfShouldSell();
  ok('when the sale plan cannot say, it goes as it always did', d.sell === true && d.trigger === 'stacks', JSON.stringify(d));
}
{
  const r = Object.create(Autopilot.prototype);
  r.s = { client: { inventory: [], rsc: { get: x => x }, stat: () => 0 } };
  ok('unknown equipment is "cannot say", never "nothing to sell"',
     r.saleRelief({ known: true, load: { weight: 100, bulk: 100 }, weight_max: 1700, bulk_max: 1700 }) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
