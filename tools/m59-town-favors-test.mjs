#!/usr/bin/env node
// m59-town-favors-test.mjs -- TOWN TRIPS ON DEMAND: start, drop + hold, favors, and the `townTrip`
// strategy hook. Offline: the rules in m59-town-favors.mjs, then the keeper methods over a stubbed
// Autopilot (the m59-bankrun-test.mjs shape).
//
//   node tools/m59-town-favors-test.mjs
import * as TF from './m59-town-favors.mjs';
import { Autopilot } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const tests = [];
const t = (name, fn) => tests.push({ name, fn });
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
const ok = (c, what) => { if (!c) throw new Error(what); };

// ------------------------------------------------------------------ the rules
t('normalizeFavor: a good favor, names split, defaults filled', () => {
  const f = TF.normalizeFavor({ item: 'Purple Mushroom', amount: 100, deliver_to: 'Janice, Camilla', shop_room: 373 }, { now: 1, by: 'op' });
  ok(f.ok, f.why);
  eq([f.favor.item, f.favor.amount, f.favor.to, f.favor.source, f.favor.shop_room, f.favor.room, f.favor.status, f.favor.by],
     ['purple mushroom', 100, ['Janice', 'Camilla'], 'any', 373, null, 'open', 'op'], 'fields');
});
t('normalizeFavor: refuses what would go wrong later', () => {
  for (const [raw, why] of [[{ amount: 5, deliver_to: 'A' }, /item/], [{ item: 'x', amount: 0, deliver_to: 'A' }, /amount/],
    [{ item: 'x', amount: 2000, deliver_to: 'A' }, /amount/], [{ item: 'x', amount: 5 }, /deliver_to/],
    [{ item: 'x', amount: 5, deliver_to: 'A', source: 'steal' }, /source/], [{ item: 'x', amount: 5, deliver_to: 'A', source: 'buy' }, /shop_room/],
    [{ item: 'x', amount: 5, deliver_to: 'A', deliver_room: 'castle' }, /deliver_room/]]) {
    const r = TF.normalizeFavor(raw); ok(!r.ok && why.test(r.why), `${JSON.stringify(raw)} -> ${r.why}`);
  }
});
t('normalizeTripCommand: ops, town, hold default and bounds', () => {
  eq(TF.normalizeTripCommand({ op: 'start' }), { ok: true, op: 'start', town: 'market', why: null }, 'start default');
  eq(TF.normalizeTripCommand({ op: 'drop' }).holdMs, TF.DEFAULT_HOLD_MS, 'default hold');
  eq(TF.normalizeTripCommand({ op: 'drop', hold_ms: 0 }).holdMs, 0, 'no hold');
  ok(!TF.normalizeTripCommand({ op: 'drop', hold_ms: -1 }).ok, 'negative hold');
  ok(!TF.normalizeTripCommand({ op: 'start', town: 'moon' }).ok, 'bad town');
  ok(!TF.normalizeTripCommand({ op: 'teleport' }).ok, 'bad op');
  ok(!TF.normalizeTripCommand({ op: 'drop_favor' }).ok, 'drop_favor needs an id');
});
t('sharesFor: even split, remainder first, never more than carried, less what was given', () => {
  const f = TF.normalizeFavor({ item: 'x', amount: 101, deliver_to: 'A,B' }).favor;
  eq(TF.sharesFor(f, 101), { A: 51, B: 50 }, 'even');
  eq(TF.sharesFor(f, 60), { A: 51, B: 9 }, 'short');
  f.delivered = { A: 51 };
  eq(TF.sharesFor(f, 50), { B: 50 }, 'after A');
});
t('favorDone: by what was loaded, not what was asked', () => {
  const f = TF.normalizeFavor({ item: 'x', amount: 100, deliver_to: 'A,B' }).favor;
  f.loaded = 60; f.delivered = { A: 50 }; ok(!TF.favorDone(f), 'not yet');
  f.delivered.B = 10; ok(TF.favorDone(f), 'all 60 given');
});
t('normalizeTownAnswer: start and favors checked; unknown keys reported', () => {
  const r = TF.normalizeTownAnswer({ start: { town: 'supply', why: 'low' }, favors: [{ item: 'herb', amount: 10, deliver_to: 'J' }, { item: '' }], color: 1 }, { by: 'strategy:s' });
  eq(r.start, { town: 'supply', why: 'low' }, 'start');
  eq(r.favors.map(f => [f.item, f.by]), [['herb', 'strategy:s']], 'favors');
  ok(r.problems.some(p => /unknown keys: color/.test(p)) && r.problems.some(p => /favor 1/.test(p)), JSON.stringify(r.problems));
});
t('addFavors: one open favor per key, and a cap', () => {
  const list = [];
  const mk = i => TF.normalizeFavor({ item: 'x', amount: 1, deliver_to: 'A', key: 'k', id: `f${i}` }).favor;
  eq(TF.addFavors(list, [mk(1), mk(2)]).refused.length, 1, 'same key refused');
  list[0].status = 'delivered';
  eq(TF.addFavors(list, [mk(3)]).added, ['f3'], 'a delivered key frees it');
  const many = Array.from({ length: 20 }, (_, i) => TF.normalizeFavor({ item: 'x', amount: 1, deliver_to: 'A', id: `m${i}` }).favor);
  TF.addFavors(list, many);
  eq(list.filter(f => f.status === 'open').length, TF.MAX_OPEN_FAVORS, 'capped');
});

// ------------------------------------------------------------------ the keeper
function keeper({ room = 100, inventory = [], names = {}, strategy = null, players = [] } = {}) {
  const k = Object.create(Autopilot.prototype);
  const c = { inventory, rsc: { get: id => names[id] }, evSeq: 0,
    requestInventory() {}, async waitFor() { return { events: [] }; } };
  const calls = { cancel: [], ledger: [], opened: [], continued: 0, asked: [] };
  Object.assign(k, {
    s: { name: 't20', client: c, need: () => c, pacer: { submit: async (_k, fn) => fn?.() },
         world: { room: { num: room }, route: to => ({ found: true, hops: [room, to] }) },
         cancelMovement: (...a) => { calls.cancel.push(a); return { cancelled: true }; },
         _askStrategies: async (hook, ctx) => { calls.asked.push([hook, ctx]); return strategy ? strategy(ctx) : null; } },
    policy: { bankAbove: 500, assignedRoom: 38, walkingMoney: 400 },
    note: () => {}, ledgerEvent: (kind, d) => calls.ledger.push([kind, d]),
    who: () => 'Lew', purseNow: () => 28, bansDestination: () => false, packWantsMarket: () => false,
    playerHere: n => players.includes(n) ? { id: n } : null,
    shoppingPlan: () => ({ lines: [] }), postShoppingPlan: () => {},
    openTownTrip(target, opts) { calls.opened.push({ target, opts }); this.townTrip = { target, purpose: 'operator', nextService: -1 }; return this.townTrip; },
    continueTownTrip: async () => { calls.continued++; return true; },
    checkIfShouldSell: () => { throw new Error('the threshold path must not run'); },
  });
  return { k, c, calls };
}

t('drop: ends the trip AND the set-aside one, cancels the walk, holds new trips', async () => {
  const { k, calls } = keeper();
  k.townTrip = { target: { room: 101 }, purpose: 'sell', startedAt: 1 };
  k.deferredShoppingTrip = { target: { room: 104 } };
  const r = k.townTripCommand({ op: 'drop', why: 'Lew is broke', hold_ms: 60_000 });
  ok(r.ok && k.townTrip === null && k.deferredShoppingTrip === null, 'both trips gone');
  ok(r.dropped.active?.to === 101 && r.dropped.deferred === true, JSON.stringify(r.dropped));
  ok(k.townTripHeld(), 'held'); ok(calls.cancel.length === 1 && r.walk_cancelled, 'walk cancelled');
  eq(calls.ledger.map(x => x[0]), ['town_trip_dropped'], 'ledger');
  eq(await k.bankRun(), false, 'bankRun opens nothing while held (and never reaches the thresholds)');
  eq(calls.asked.length, 0, 'not even a strategy is asked while held');
});
t('drop with hold_ms 0 ends the trip without a hold', () => {
  const { k } = keeper();
  k.townTrip = { target: { room: 101 } };
  k.townTripCommand({ op: 'drop', hold_ms: 0 });
  ok(!k.townTrip && !k.townTripHeld(), 'no hold');
});
t('start: queued, then opened by bankRun past the thresholds, aimed at the town asked for', async () => {
  const { k, calls } = keeper();
  k.townTripHold = { until: Date.now() + 1e6 };
  const r = k.townTripCommand({ op: 'start', town: 'supply', why: 'operator says go' });
  ok(r.queued && !k.townTripHeld(), 'queued and the hold lifted');
  await k.bankRun();
  eq(calls.opened.length, 1, 'opened once');
  eq(calls.opened[0].opts.sellCall.trigger, 'operator', 'trigger');
  ok(calls.opened[0].opts.supplyTrip === true, 'a supply trip');
  ok(calls.continued === 1, 'driven by continueTownTrip');
  eq(k.townTripCommand({ op: 'start' }).started, false, 'a second start while on a trip changes nothing');
});
t('allow lifts a hold without starting anything', () => {
  const { k } = keeper();
  k.townTripHold = { until: Date.now() + 1e6 };
  k.townTripCommand({ op: 'allow' });
  ok(!k.townTripHeld() && !k.operatorTripRequest, 'lifted, nothing queued');
});
t('favor: added, listed, dropped; a bad favor says why', () => {
  const { k } = keeper();
  const r = k.townTripCommand({ op: 'favor', item: 'purple mushroom', amount: 100, deliver_to: 'Janice,Camilla', source: 'hall' });
  ok(r.ok && r.status.favors.length === 1, JSON.stringify(r));
  const id = r.added[0];
  ok(!k.townTripCommand({ op: 'favor', item: 'x' }).ok, 'bad favor refused');
  k.townTripCommand({ op: 'drop_favor', favor_id: id });
  eq(k.townFavorList[0].status, 'dropped', 'dropped');
});
t('strategy: may start a trip and add favors -- but never through a hold', async () => {
  const strategy = () => ({ strategy: 'restock-casters', answer: { start: { town: 'supply', why: 'Janice low' },
    favors: [{ item: 'purple mushroom', amount: 100, deliver_to: 'Janice,Camilla', key: 'purple' }] } });
  const a = keeper({ strategy });
  await a.k.bankRun();
  eq(a.calls.opened[0]?.opts.sellCall.trigger, 'strategy', 'a strategy-started trip');
  eq(a.k.townFavorList.length, 1, 'favor added once (the opening ask dedupes by key)');
  ok(a.calls.asked.some(([h, ctx]) => h === 'townTrip' && ctx.opening), 'asked again as the trip opened');
  const b = keeper({ strategy });
  b.k.townTripHold = { until: Date.now() + 1e6 };
  await b.k.bankRun();
  eq(b.calls.opened.length, 0, 'held: no strategy trip');
});
t('gather: hall first, the shop only for the remainder; status loaded', async () => {
  const { k, c } = keeper({ inventory: [], names: { 1: 'purple mushroom' } });
  k.townTripCommand({ op: 'favor', item: 'purple mushroom', amount: 100, deliver_to: 'Janice,Camilla', shop_room: 373 });
  k.withdrawFromStockpile = async need => { c.inventory.push({ id: 9, nameRsc: 1, amount: 18 }); return { took: [{ item: need[0].item, amount: 18 }] }; };
  k.buyFavorCargo = async (f, need) => { eq(need, 82, 'buys only the remainder'); c.inventory[0].amount += 40; return 40; };
  await k.gatherTownFavors();
  const f = k.townFavorList[0];
  eq([f.status, f.loaded], ['loaded', 58], 'loaded');
  ok(f.notes.some(n => /short by 42/.test(n)), JSON.stringify(f.notes));
});
t('deliver: split between recipients in the room; an absent one is retried, not skipped', async () => {
  const { k, c } = keeper({ room: 38, inventory: [{ id: 9, nameRsc: 1, amount: 58 }], names: { 1: 'purple mushroom' }, players: ['Janice'] });
  k.townTripCommand({ op: 'favor', item: 'purple mushroom', amount: 100, deliver_to: 'Janice,Camilla' });
  const f = k.townFavorList[0]; f.status = 'loaded'; f.loaded = 58;
  // A stack given away to nothing LEAVES the pack, as on the wire -- it does not sit at amount 0.
  k.chaliceGive = async (name, items) => { c.inventory[0].amount -= items[0].amount;
    if (c.inventory[0].amount <= 0) c.inventory.splice(0, 1); return { gave: true }; };
  ok(await k.deliverTownFavors(), 'did something');
  eq(f.delivered, { Janice: 50 }, 'Janice had her half (of 100)');
  eq(f.status, 'loaded', 'Camilla still owed: kept open');
  ok(f.notes.some(n => /Camilla is not in room 38/.test(n)), JSON.stringify(f.notes));
  f.nextTryAt = 0; k.playerHere = n => ({ id: n });
  await k.deliverTownFavors();
  eq([f.delivered, f.status], [{ Janice: 50, Camilla: 8 }, 'delivered'], 'Camilla had what was left, and it closed');
});
t('deliver: waits while a trip is still in flight', async () => {
  const { k } = keeper();
  k.townTripCommand({ op: 'favor', item: 'x', amount: 1, deliver_to: 'A' });
  k.townFavorList[0].status = 'loaded';
  k.townTrip = { target: { room: 101 } };
  eq(await k.deliverTownFavors(), false, 'not while travelling');
});

for (const { name, fn } of tests) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
}
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
