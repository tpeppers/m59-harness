// Offline guard for m59-towntrip-ledger.mjs and its wiring into the keeper's town trips.
//
//   node tools/m59-towntrip-ledger-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packCounts, newTripTrade, addTradeFact, packDelta, tripLedgerFields, tripTouches } from './m59-towntrip-ledger.mjs';
import { pairTrips, filterTrips, totalsByItem, moneyTotals } from './m59-towntrips.mjs';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${name}`); };

ok('a pack counts by name, and an unstackable at amount 0 is ONE', () => {
  assert.deepEqual(packCounts([{ name: 'Purple Mushroom', amount: 12 }, { name: 'purple mushroom', amount: 3 },
                               { name: 'long sword', amount: 0 }, { name: 'long sword', amount: 0 }]),
                   { 'purple mushroom': 15, 'long sword': 2 });
});
ok('trade facts fold in by item, in every shape the trade paths send', () => {
  const t = newTripTrade();
  addTradeFact(t, { earned: 300, sold: [{ name: 'red mushroom', amount: 100, price: 300 }] });
  addTradeFact(t, { earned: 30, sold: [{ name: 'Red Mushroom', amount: 10, price: 30 }] });
  addTradeFact(t, { spent: 512, bought: [{ what: 'mushroom', cost: 512, amount: 433 }] });
  addTradeFact(t, { deposited: [{ name: 'inky-cap mushroom', amount: 5 }] });
  addTradeFact(t, { guild_deposited: [{ name: 'entroot berry', amount: 40 }, { name: 'shilling', amount: 900 }] });
  addTradeFact(t, { withdrawn: [{ name: 'emerald', amount: 60 }] });
  addTradeFact(t, { banked: 4000 }); addTradeFact(t, { bank_withdrawn: 1200 });
  assert.deepEqual(t.sold['red mushroom'], { amount: 110, shillings: 330 });
  assert.equal(t.bought.mushroom.amount, 433); assert.equal(t.spent, 512); assert.equal(t.earned, 330);
  assert.equal(t.vaulted['inky-cap mushroom'].amount, 5, 'the Barloque vault is its own book');
  assert.equal(t.guild_deposited['entroot berry'].amount, 40); assert.equal(t.guild_deposited.shilling.amount, 900);
  assert.equal(t.withdrawn.emerald.amount, 60);
  assert.equal(t.banked, 4000); assert.equal(t.bank_withdrawn, 1200);
  assert.equal(t.facts, 8);
});
ok('the delta is out minus in, nonzero only', () => {
  assert.deepEqual(packDelta({ a: 5, b: 2, c: 1 }, { a: 5, b: 0, d: 4 }), { d: 4, b: -2, c: -1 });
});
ok('an unread half is null, never an empty object', () => {
  const f = tripLedgerFields({ packIn: null, packOut: { a: 1 }, trade: null });
  assert.equal(f.pack_in, null); assert.equal(f.pack_delta, null); assert.equal(f.trade, null);
  assert.deepEqual(f.pack_out, { a: 1 });
});
ok('a trip can be filtered by the item it moved, sold or not', () => {
  const t = newTripTrade(); addTradeFact(t, { sold: [{ name: 'purple mushroom', amount: 4, price: 8 }] });
  const row = tripLedgerFields({ packIn: { 'purple mushroom': 4 }, packOut: {}, trade: t });
  assert.ok(tripTouches(row, 'purple'));
  assert.ok(tripTouches(tripLedgerFields({ packIn: { herb: 2 }, packOut: {} }), 'herb'), 'the delta alone counts');
  assert.ok(!tripTouches(row, 'emerald'));
});
ok('the keeper wires it: pack in at open, every trade fact, pack out at close', () => {
  const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  assert.match(src, /packIn, trade: newTripTrade\(\)/);
  assert.match(src, /pack_in: packIn,/);
  assert.match(src, /addTradeFact\(this\.townTrip\.trade, fact\)/);
  assert.match(src, /\.\.\.tripLedgerFields\(\{ packIn: trip\.packIn/);
  assert.match(src, /this\.tradeFact\(\{ withdrawn: drawn \}\)/, 'hall draws report');
  assert.ok(src.includes("tradeFact({ guild_deposited: [{ name: nameOf(o)"), 'the hall stash reports');
  assert.ok(src.includes("tradeFact({ guild_deposited: [{ name: give.item, amount: moved }] })"), 'guild-wants contributions report');
  assert.ok(src.includes("tradeFact({ bank_withdrawn: drewFromBank })"), 'bank withdrawals report');
  assert.ok(src.includes("tradeFact({ earned: sold.total_received, sold: sold.sold })"), 'the room-making sale reports');
  const coop = readFileSync(new URL('./m59-reagent-coop-runtime.mjs', import.meta.url), 'utf8');
  assert.ok(coop.includes("k.tradeFact?.({ [direction === 'deposit' ? 'guild_deposited' : 'withdrawn']"), 'co-op transfers report');
});
ok('trips pair by agent and start, filter by item, and total by book', () => {
  const t = newTripTrade();
  addTradeFact(t, { sold: [{ name: 'red mushroom', amount: 100, price: 300 }], earned: 300 });
  addTradeFact(t, { guild_deposited: [{ name: 'purple mushroom', amount: 12 }] }); addTradeFact(t, { banked: 4000 });
  const ev = [
    { kind: 'town_trip_opened', agent: 't5', trip_started_at: 1, purpose: 'sell', to_name: 'Joguer' },
    { kind: 'town_trip_opened', agent: 't6', trip_started_at: 1, purpose: 'food' },
    { kind: 'town_trip_completed', agent: 't5', trip_started_at: 1, completed_at: 9, net_shillings: 300,
      ...tripLedgerFields({ packIn: { 'red mushroom': 100 }, packOut: {}, trade: t }) },
    { kind: 'town_trip_completed', agent: 't6', trip_started_at: 1, completed_at: 8 },
  ];
  const trips = pairTrips(ev);
  assert.equal(trips.length, 2); assert.equal(trips[0].to_name, 'Joguer');
  assert.equal(trips[0].itemised, true); assert.equal(trips[1].itemised, false, 'an old trip says so');
  assert.equal(filterTrips(trips, { item: 'purple' }).length, 1, 'a guild deposit is a match');
  assert.equal(filterTrips(trips, { sold: true }).length, 1);
  const tot = totalsByItem(trips);
  assert.equal(tot['red mushroom'].sold_sh, 300); assert.equal(tot['purple mushroom'].guild_deposited, 12);
  assert.equal(moneyTotals(trips).banked, 4000);
});

console.log(`\n${n} passed`);
