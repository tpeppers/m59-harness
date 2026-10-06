#!/usr/bin/env node
// EVERY TOWN TRIP SAYS WHY, AND A SELL TRIP HAS TO BE WORTH THE ROAD.   node tools/m59-triptelemetry-test.mjs
//
// Offline: binds Autopilot.prototype methods to a rig. Opens no socket.
//
// Operator, 2026-09-27: "group up all such code and put it through a 'make town trips'
// telemetry/bookkeeping method ... town trips should aim to be $10k+ if their purpose is for
// selling". Measured the same day: a hunter making a ~300-shilling sell trip every twenty minutes,
// and 7 of 27 crew "town trips" that bought and sold nothing, all indistinguishable in the ledger.
import { Autopilot, TRIP_PURPOSE, MIN_SELL_TRIP_VALUE, SELL_REGARDLESS_AT, hungerNeedsTown } from './m59-autopilot.mjs';

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

// 2026-09-28: chalice riders hand their shillings to the guild hall and read "broke" by design;
// Floyd and Animal opened six broke trips to Barloque in an hour with ~7.5k aboard.
{
  const items = [{ name: 'shilling', amount: 400 }, ...Array.from({ length: 9 }, () => ({ name: 'long sword', amount: 1 }))];
  const stub = r => Object.assign(r, { standingOrderUnstarted: () => null, overfarmHoldsTrip: () => null,
    supplyShortfall: () => ({ short: false }) });
  // 2026-10-06, operator: "we never want to sell because we're broke". The trigger is gone: even with
  // sellWhenBroke set (a stale doctrine) and a pack that clears any value floor, poverty sells nothing.
  const { r } = rig({ items, policy: { sellWhenBroke: true } });
  const cheap = stub(r).checkIfShouldSell();
  ok('a broke character whose pack is worth under the floor stays', cheap.sell === false, JSON.stringify(cheap));
  const { r: low } = rig({ items, policy: { sellWhenBroke: true, minSellTripValue: 250 } });
  const go = stub(low).checkIfShouldSell();
  ok('and STILL stays when the pack clears it: being broke is never a reason to sell',
     go.trigger !== 'broke' && go.sell === false, JSON.stringify(go));
}

// 2026-10-06, Clifford: ten `trigger: "food"` trips in a day, each ten apples off a small withdrawal,
// with a fight floor of 80 that resting reaches on its own. An empty larder is a reason to go to town
// only when the character's floor is above what resting delivers (80 of 200).
ok('a floor resting reaches needs no food trip', !hungerNeedsTown(80, 200) && !hungerNeedsTown(40, 200));
ok('a floor above the resting cap does', hungerNeedsTown(120, 200));
{
  const hungry = policy => {
    const opened = [];
    const { r } = rig({ items: [{ name: 'shilling', amount: 40 }, { name: 'long sword', amount: 2 }],
                        policy: { bankAbove: 1_000_000, hungryFloor: 100, ...policy } });
    const c = r.s.client;
    Object.assign(c, { waitFor: async () => ({}), vitals: () => ({ vigor: { value: 74, scale_max: 200 } }) });
    Object.assign(r.s, { need: () => c, pacer: { submit: async () => {} },
                         bankKnown: () => ({ balance: 7000 }),
                         world: { room: { num: 38 }, route: () => ({ found: true, hops: [1, 2, 3] }) } });
    Object.assign(r, { townTrip: null, poorSupply: null, larder: () => [],
      reagentCount: () => ({ elderberry: 0, herbs: 0 }),
      checkIfShouldSell: () => ({ sell: false, trigger: null }),
      prepareFarmDelivery: () => {}, packWantsMarket: () => false,
      shoppingPlan: () => ({}), postShoppingPlan: () => ({}),
      openTownTrip: (target, o) => { opened.push({ target, ...o }); },
      continueTownTrip: async () => true });
    return { r, opened };
  };
  const cliff = hungry({ vigorFloor: 40, fightAboveVigor: 40 });
  const went = await cliff.r.bankRun();
  ok('Clifford: no food, 7,000 banked, floor 80 -- stays and farms', went === false && !cliff.opened.length,
     JSON.stringify(cliff.opened));
  const fed = hungry({ vigorFloor: 140 });
  await fed.r.bankRun();
  ok('a floor of 140 with no food still goes to town for some',
     fed.opened.length === 1 && fed.opened[0].starving === true, JSON.stringify(fed.opened));
  const parked = hungry({ vigorFloor: 40 });
  parked.r.deferredShoppingTrip = { purpose: 'food', target: { room: 151 } };
  await parked.r.bankRun();
  ok('and a parked hunger trip is dropped rather than resumed',
     parked.r.deferredShoppingTrip === null && !parked.opened.length && !parked.r.townTrip);
}

// 2026-10-06, Statler: a sell trip opened at 98% load, the operator logged in and took his mushrooms,
// logged out, and the keeper -- alive all along -- resumed the walk to Barloque. A trip resumed on a
// NEW CONNECTION is re-judged against a fresh pack; one the operator asked for is never re-judged.
{
  const resumed = ({ purpose = 'sell', trigger = 'load', sell = { sell: false, trigger: null, why: 'pack 40%' },
                     inventory = true, policy = {} } = {}) => {
    const { r, events } = rig({ items: [{ name: 'shilling', amount: 100 }], policy });
    const oldClient = r.s.client, newClient = { ...oldClient, evSeq: 1,
      requestInventory() {}, waitFor: async () => ({ events: inventory ? [{ kind: 'inventory' }] : [] }),
      vitals: () => ({ vigor: { value: 70, scale_max: 200 } }) };
    if (!inventory) newClient.inventory = undefined;
    const cancelled = [];
    Object.assign(r.s, { client: newClient, pacer: { submit: async (k, fn) => fn() },
                         cancelMovement: (...a) => { cancelled.push(a[1]); return { cancelled: true }; } });
    Object.assign(r, { checkIfShouldSell: () => sell, travelInterrupted: () => false, suspendedJourney: null, inert: null,
      larder: () => [], reagentCount: () => ({ elderberry: 0, herbs: 0 }), hereRoom: () => 38,
      townTrip: { target: { room: 113 }, nextService: -1, startedAt: 1, trigger, purpose, client: oldClient } });
    return { r, events, cancelled, newClient };
  };
  const statler = resumed();
  const went = await statler.r.continueTownTrip();
  ok('Statler: a sell trip whose pack was emptied while a person held him is dropped on the new connection',
     went === false && statler.r.townTrip === null && statler.cancelled.length === 1, JSON.stringify(statler.r.townTrip));
  const dropped = statler.events.find(e => e.kind === 'town_trip_dropped');
  ok('and the ledger says it was reassessed, with no hold on the next trip',
     dropped?.by === 'reassessed' && dropped.hold_ms === 0 && /no longer calls for a market/.test(dropped.why), JSON.stringify(dropped));
  ok('without setting a town-trip hold', !statler.r.townTripHold);

  const full = resumed({ sell: { sell: true, trigger: 'load', why: 'pack is 98% of capacity' } });
  ok('a pack that still calls for a market keeps its trip, judged on the new connection',
     await full.r.reassessTownTrip(full.r.townTrip) === 'kept' && full.r.townTrip?.client === full.newClient);
  const asked = resumed({ purpose: 'operator', trigger: 'operator' });
  ok('a trip the operator asked for is never re-judged', await asked.r.reassessTownTrip(asked.r.townTrip) === 'kept');
  const hungry = resumed({ purpose: 'food', trigger: 'food', policy: { vigorFloor: 40 } });
  ok('a food trip whose floor resting reaches is dropped too', await hungry.r.reassessTownTrip(hungry.r.townTrip) === 'dropped');
  const blind = resumed({ inventory: false });
  ok('no fresh pack, no verdict: an unread pack never drops a trip',
     await blind.r.reassessTownTrip(blind.r.townTrip) === 'unknown' && blind.r.townTrip !== null);
  const same = resumed();
  same.r.townTrip.client = same.r.s.client;
  let judged = 0; same.r.reassessTownTrip = async () => { judged++; return 'kept'; };
  same.r.continueTownTrip = Autopilot.prototype.continueTownTrip;
  await same.r.continueTownTrip().catch(() => {});
  ok('the same connection is not re-judged on every pass', judged === 0);
}

// 2026-10-06, Raphael: "not do any town trips, selling, etc., we want him to be locked in room 2".
// policy.townTrips === false closes every door of its own; an operator's request still opens.
{
  const posted = ({ policy = {}, sell = { sell: true, trigger: 'load', why: 'pack is 99% of capacity' } } = {}) => {
    const opened = [];
    const { r, events } = rig({ items: [{ name: 'shilling', amount: 5000 }], policy: { bankAbove: 500, ...policy } });
    const c = r.s.client;
    Object.assign(c, { waitFor: async () => ({}), vitals: () => ({ vigor: { value: 74, scale_max: 200 } }) });
    Object.assign(r.s, { need: () => c, pacer: { submit: async () => {} }, bankKnown: () => ({ balance: 0 }),
                         cancelMovement: () => ({ cancelled: true }),
                         world: { room: { num: 2 }, route: () => ({ found: true, hops: [1, 2] }) } });
    Object.assign(r, { townTrip: null, poorSupply: null, larder: () => [{}], reagentCount: () => ({ elderberry: 0, herbs: 0 }),
      checkIfShouldSell: () => sell, prepareFarmDelivery: () => {}, packWantsMarket: () => false,
      farmCleanupBeforeSale: async () => {}, shoppingPlan: () => ({}), postShoppingPlan: () => ({}), hereRoom: () => 2,
      travelInterrupted: () => false, suspendedJourney: null, inert: null,
      openTownTrip: (target, o) => { opened.push({ target, ...o }); }, continueTownTrip: async () => true });
    return { r, opened, events };
  };
  const raphael = posted({ policy: { townTrips: false } });
  ok('townTrips false: a full pack and a purse over bankAbove open no trip',
     await raphael.r.bankRun() === false && !raphael.opened.length, JSON.stringify(raphael.opened));
  const control = posted();
  await control.r.bankRun();
  ok('and the same character without it does go', control.opened.length === 1);
  const asked = posted({ policy: { townTrips: false } });
  let requested = 0;
  asked.r.operatorTripRequest = { town: 'market', by: 'operator', at: 1 };
  asked.r.openRequestedTownTrip = async () => { requested++; return true; };
  await asked.r.bankRun();
  ok('an operator\'s request still opens one', requested === 1);
  const under = posted({ policy: { townTrips: false } });
  under.r.townTrip = { target: { room: 113 }, nextService: -1, startedAt: 1, trigger: 'load', purpose: 'sell', client: under.r.s.client };
  under.r.continueTownTrip = Autopilot.prototype.continueTownTrip;
  const went = await under.r.continueTownTrip();
  const row = under.events.find(e => e.kind === 'town_trip_dropped');
  ok('a trip of its own already under way is dropped with no hold',
     went === false && under.r.townTrip === null && row?.by === 'policy' && row.hold_ms === 0, JSON.stringify(row));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
