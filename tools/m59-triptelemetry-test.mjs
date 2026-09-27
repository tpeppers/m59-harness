#!/usr/bin/env node
// EVERY TOWN TRIP SAYS WHY, AND A SELL TRIP HAS TO BE WORTH THE ROAD.   node tools/m59-triptelemetry-test.mjs
//
// Offline: binds Autopilot.prototype methods to a rig. Opens no socket.
//
// Operator, 2026-09-27: "group up all such code and put it through a 'make town trips'
// telemetry/bookkeeping method ... town trips should aim to be $10k+ if their purpose is for
// selling". Measured the same day: a hunter making a ~300-shilling sell trip every twenty minutes,
// and 7 of 27 crew "town trips" that bought and sold nothing, all indistinguishable in the ledger.
import { Autopilot, TRIP_PURPOSE, MIN_SELL_TRIP_VALUE, SELL_REGARDLESS_AT } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => { if (cond) { passed++; console.log(`  ok   ${what}`); }
                                         else { failed++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };

const rig = ({ items = [], policy = {} } = {}) => {
  const events = [], notes = [];
  const r = Object.create(Autopilot.prototype);
  Object.assign(r, {
    policy: { strategy: 'fieldrest', ...policy },
    s: { client: { inventory: items.map((it, i) => ({ id: i + 1, nameRsc: it.name, amount: it.amount ?? 1 })),
                   rsc: { get: x => x } },
         world: { room: { num: 599 } } },
    ledgerEvent: (kind, data) => events.push({ kind, ...data }),
    note: (what, data) => notes.push({ what, ...data }),
    bansDestination: () => false,
  });
  return { r, events, notes };
};

{
  const { r, events } = rig({ items: [{ name: 'shilling', amount: 900 }, { name: 'long sword', amount: 1 }] });
  const trip = r.openTownTrip({ room: 104, name: 'Joguer' },
    { sellCall: { trigger: 'supply', why: 'out of elderberry', missing: ['elderberry'] }, supplyTrip: true });
  const e = events.find(x => x.kind === 'town_trip_opened');
  ok('opening a trip records town_trip_opened', !!e, JSON.stringify(events));
  ok('with its trigger and purpose', e?.trigger === 'supply' && e?.purpose === 'restock' && trip.purpose === 'restock');
  ok('and pairs with completion by trip_started_at', e?.trip_started_at === trip.startedAt);
  ok('shillings are not counted as sale value', r.packSaleValue().value === r.itemValue('long sword', 1));
}

ok('every trigger checkIfShouldSell can return has a purpose',
   ['load', 'stacks', 'unweighable', 'broke', 'supply', 'standing_order', 'policy'].every(t => TRIP_PURPOSE[t]));
ok('the operator\'s number is the default', MIN_SELL_TRIP_VALUE === 10_000);

{
  const { r } = rig({ policy: { minSellTripValue: 250 } });
  ok('a character may carry its own threshold', r.minSellTripValue() === 250);
  const { r: d } = rig();
  ok('and silence is the default', d.minSellTripValue() === MIN_SELL_TRIP_VALUE);
}
ok('a truly full pack goes whatever it is worth', SELL_REGARDLESS_AT > 0.9 && SELL_REGARDLESS_AT < 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
