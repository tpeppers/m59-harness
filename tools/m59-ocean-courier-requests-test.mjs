// THE GREAT OCEAN COURIER SERVES THE FLEET'S STANDING REQUESTS (substrate/courier-requests.json). Operator 2026-11-12:
// Zoot (t17) asked for 100 mushrooms, 100 red and 100 purple while Zheng sold every red and purple mushroom the farmers
// handed him. Whole-name matching, the shortfall, the sale hold (and no change without requests), a malformed file that
// is loud and keeps the last good reading, a delivery that never overshoots, a requester outside 552 skipped, and a
// farmer's surplus above its reserve brokered when Zheng holds none. Offline; fakes only.
//   node tools/m59-ocean-courier-requests-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'm59-ocean-requests-'));
const requestsFile = join(dir, 'courier-requests.json');
process.env.M59_COURIER_REQUESTS_FILE = requestsFile;
process.env.M59_TRADE_GOODS_DIR = join(dir, 'trade-goods');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const {
  oceanCourierRequests, oceanRequestShortfall, oceanRequestsFor, oceanRequestDelivery, oceanTradeGoodsSale,
  oceanFarmerSurplus, oceanParcelSale, oceanDepartureWithhold, OCEAN_COURIER_KEEP,
} = await import('./m59-ocean-courier-cache.mjs');
const { deliverRequestedReagents, oceanRequestPicture, oceanLastRequestHold, oceanFarmerQuiet } =
  await import('./fleetscripts/ocean-courier.mjs');

const writeRequests = value => writeFileSync(requestsFile, typeof value === 'string' ? value : JSON.stringify(value));
const pack = (items, over = {}) => ({ ids_stale: false, last_save_at: null, ids_as_of: 1, items,
  carry: { load: { exact: true, bulk: 100, weight: 100 }, room_for: { weight: 2000, bulk: 2000 } }, ...over });
const row = (id, name, amount) => ({ id, name, amount });

// What the live farmers' packs look like: every mushroom of this world in one pack.
const mixed = pack([row(1, 'red mushroom', 50), row(2, 'purple mushroom', 10), row(3, 'edible mushroom', 30),
  row(4, 'mushroom', 5), row(5, 'blue mushroom', 12)]);

test('item names are whole names: mushroom is not red, purple, edible or blue mushroom', () => {
  assert.deepEqual(oceanRequestShortfall({ t17: { mushroom: 100 } }, { t17: mixed }), { mushroom: 95 });
  assert.deepEqual(oceanRequestShortfall({ t17: { 'red mushroom': 100 } }, { t17: mixed }), { 'red mushroom': 50 });
  assert.deepEqual(oceanRequestShortfall({ t17: { 'Purple Mushroom ': 100 } }, { t17: mixed }), { 'purple mushroom': 90 });
  // A sale hold for plain mushrooms leaves red ones saleable.
  const zheng = pack([row(9, 'red mushroom', 60), row(10, 'mushroom', 40)]);
  assert.deepEqual(oceanTradeGoodsSale(zheng, {}, { mushroom: 100 }), [{ name: 'red mushroom', amount: 60 }]);
});

test('the shortfall sums max(0, target - held) over requesters, and an unread pack holds none', () => {
  const requests = { t17: { mushroom: 100, 'red mushroom': 100, 'purple mushroom': 100 }, t4: { 'red mushroom': 20, mushroom: 3 } };
  const packs = { t17: mixed, t4: pack([row(7, 'red mushroom', 25)]) };
  assert.deepEqual(oceanRequestShortfall(requests, packs),
    { mushroom: 95 + 3, 'red mushroom': 50, 'purple mushroom': 90 });
  assert.deepEqual(oceanRequestShortfall(requests, { t4: packs.t4 }),
    { mushroom: 100 + 3, 'red mushroom': 100, 'purple mushroom': 100 });
  assert.deepEqual(oceanRequestShortfall({}, packs), {});
  assert.deepEqual(oceanRequestsFor(requests, ['t4', 't99']), { t4: requests.t4 });
});

test('the sale withholds only up to the shortfall, on top of his working stock', () => {
  const zheng = pack([row(1, 'red mushroom', 234), row(2, 'purple mushroom', 59), row(3, 'elderberry', 100)]);
  const sale = hold => Object.fromEntries(oceanTradeGoodsSale(zheng, {}, hold).map(r => [r.name, r.amount]));
  assert.deepEqual(sale({ 'red mushroom': 100, 'purple mushroom': 90 }), { 'red mushroom': 134, elderberry: 100 - OCEAN_COURIER_KEEP.elderberry });
  assert.deepEqual(sale({ 'red mushroom': 300 }), { 'purple mushroom': 59, elderberry: 60 });
  assert.deepEqual(sale({ elderberry: 25 }), { 'red mushroom': 234, 'purple mushroom': 59, elderberry: 35 });
  // Ward parcels of a held item sell only out of what the hold leaves, and the trade goods after them.
  const withParcels = pack([row(1, 'red mushroom', 130)]);
  const parcels = oceanParcelSale(withParcels, new Map([['red mushroom', 30], ['blue mushroom', 8]]), { 'red mushroom': 120 });
  assert.deepEqual([...parcels], [['red mushroom', 10], ['blue mushroom', 8]]);
  assert.deepEqual(oceanTradeGoodsSale(withParcels, {}, oceanDepartureWithhold({ 'red mushroom': 120 }, parcels)), []);
});

test('no requests: the sale is exactly what it was before', () => {
  const packs = [mixed, pack([row(1, 'red mushroom', 234), row(2, 'elderberry', 61), row(3, 'bunch of grapes', 1)]),
    pack([row(1, 'herb', 300), row(2, 'long sword', 1), row(3, 'shilling', 900)])];
  const received = { 'long sword': 1, herb: 40 };
  for (const p of packs) {
    assert.deepEqual(oceanTradeGoodsSale(p, received, {}), oceanTradeGoodsSale(p, received));
    assert.deepEqual(oceanTradeGoodsSale(p, {}, undefined), oceanTradeGoodsSale(p));
  }
  const parcels = new Map([['red mushroom', 30]]);
  assert.deepEqual([...oceanParcelSale(packs[1], parcels, {})], [...parcels]);
  assert.deepEqual(oceanDepartureWithhold({}, parcels), {});
});

test('the requests file: missing is empty, a BOM still reads, a broken file is loud, a bad entry is named', () => {
  rmSync(requestsFile, { force: true });
  assert.deepEqual(oceanCourierRequests('prod').requests, {});
  assert.equal(oceanCourierRequests('prod').error, null);
  writeRequests('﻿' + JSON.stringify({ t17: { Mushroom: 100, 'red mushroom': '100', 'purple mushroom': 0 } }));
  assert.deepEqual(oceanCourierRequests('prod'), { requests: { t17: { mushroom: 100, 'red mushroom': 100 } }, error: null,
    problems: [], file: requestsFile });
  writeRequests('{ "t17": { "mushroom": 100 ');
  const broken = oceanCourierRequests('prod');
  assert.match(broken.error, /will not parse/);
  assert.deepEqual(broken.requests, {});
  writeRequests('[1, 2]');
  assert.match(oceanCourierRequests('prod').error, /not an object/);
  writeRequests({ t17: { mushroom: 'lots', herb: -3, 'red mushroom': 10 }, t4: 7 });
  const partial = oceanCourierRequests('prod');
  assert.equal(partial.error, null);
  assert.deepEqual(partial.requests, { t17: { 'red mushroom': 10 } });
  assert.equal(partial.problems.length, 3);
});

test('a delivery never overshoots the target, the giver keep or what fits', () => {
  assert.equal(oceanRequestDelivery({ target: 100, receiverHolds: 90, giverHolds: 200, fits: 500 }), 10);
  assert.equal(oceanRequestDelivery({ target: 100, receiverHolds: 120, giverHolds: 200, fits: 500 }), 0);
  assert.equal(oceanRequestDelivery({ target: 100, receiverHolds: 0, giverHolds: 50, giverKeep: 40, fits: 500 }), 10);
  assert.equal(oceanRequestDelivery({ target: 100, receiverHolds: 0, giverHolds: 200, fits: 7 }), 7);
  assert.equal(oceanRequestDelivery({ target: 100, receiverHolds: 0, giverHolds: 200, fits: Infinity }), 100);
  assert.equal(oceanRequestDelivery({ target: 100, receiverHolds: 0, giverHolds: NaN, fits: 50 }), 0);
  for (let i = 0; i < 500; i++) {
    const t = Math.floor(Math.random() * 200), r = Math.floor(Math.random() * 200), g = Math.floor(Math.random() * 300);
    const k = Math.floor(Math.random() * 50), f = Math.floor(Math.random() * 300);
    const n = oceanRequestDelivery({ target: t, receiverHolds: r, giverHolds: g, giverKeep: k, fits: f });
    assert.ok(n >= 0 && r + n <= Math.max(r, t) && g - n >= Math.min(g, k) && n <= f, JSON.stringify({ t, r, g, k, f, n }));
  }
  // A farmer gives only above its strategy reserve and its own request; an item with no known reserve, never.
  const farmer = pack([row(1, 'mushroom', 70), row(2, 'red mushroom', 30), row(3, 'purple mushroom', 40)]);
  assert.equal(oceanFarmerSurplus(farmer, 'mushroom'), 22);
  assert.equal(oceanFarmerSurplus(farmer, 'mushroom', 60), 10);
  assert.equal(oceanFarmerSurplus(farmer, 'red mushroom'), 6);
  assert.equal(oceanFarmerSurplus(farmer, 'purple mushroom'), 0);
});

// ---- the delivery, against a fake broker ----
const body = (character, over = {}) => ({ character, in_game: true, connected: true, ids_stale: false, room: { num: 552 },
  pid: 100, connection_revision: 1, last_save_at: null, next_save_expected_at: null, you: { object_id: 7, row: 1, col: 1 },
  hp: { value: 50, max: 50 }, vigor: { value: 160 }, karma: { value: 10 }, combat: { personal_threat: { level: 'quiet' } },
  autopilot_status: { mode: 'survive', faculties: { work: 'keeper', movement: 'keeper', economy: 'keeper' },
    policy: { neverAttack: true, townTrips: false } }, ...over });

function world({ packs, rooms = {}, bodies = {}, refuse = false }) {
  const calls = [];
  const rows = Object.keys(packs).map(agent => ({ agent, room_num: rooms[agent] ?? 552, activity: 'farming' }));
  const rpc = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'fleet') return { fleet: rows };
    if (tool === 'inventory') return structuredClone(packs[args.agent]);
    if (tool === 'status') return { ...(bodies[args.agent] ?? body(args.agent, { room: { num: rooms[args.agent] ?? 552 } })),
      items: packs[args.agent].items };
    if (tool === 'supply') {
      if (refuse) return { supplied: false, reason: 'the receiver cannot hold it' };
      const [what] = args.what;
      const from = packs[args.from].items.find(r => r.id === what.id);
      from.amount -= what.amount;
      const into = packs[args.to].items.find(r => r.name === what.name);
      if (into) into.amount += what.amount;
      else packs[args.to].items.push({ id: 900 + calls.length, name: what.name, amount: what.amount });
      return { supplied: true, amounts: [{ name: what.name, asked: what.amount, giver_lost: what.amount, received: what.amount }] };
    }
    assert.fail(`unexpected ${tool}`);
  };
  return { rpc, calls };
}
async function captured(task) {
  const lines = [], log = console.log;
  console.log = line => { try { lines.push(JSON.parse(line)); } catch { lines.push(line); } };
  try { return { result: await task(), lines }; } finally { console.log = log; }
}
const zhengBody = () => body('Zheng He', { hp: { value: 23, max: 23 } });

test('a requester in 552 gets what Zheng holds, up to its target; one elsewhere is named and skipped', async () => {
  writeRequests({ t17: { mushroom: 100, 'red mushroom': 100, 'purple mushroom': 100 }, t4: { 'red mushroom': 50 } });
  const packs = {
    hk2: pack([row(1, 'red mushroom', 234), row(2, 'purple mushroom', 59), row(3, 'shilling', 900)]),
    t17: pack([row(11, 'red mushroom', 90), row(12, 'purple mushroom', 5)]),
    t4: pack([]),
  };
  const { rpc, calls } = world({ packs, rooms: { t4: 202 }, bodies: { hk2: zhengBody() } });
  const { result, lines } = await captured(() => deliverRequestedReagents(rpc, 'prod'));
  const delivered = lines.filter(l => l.event === 'courier request delivered');
  assert.deepEqual(delivered.map(l => [l.agent, l.item, l.amount, l.before, l.after]),
    [['t17', 'red mushroom', 10, 90, 100], ['t17', 'purple mushroom', 59, 5, 64]]);
  assert.equal(packs.t17.items.find(r => r.name === 'red mushroom').amount, 100);       // never past the target
  assert.equal(packs.hk2.items.find(r => r.name === 'red mushroom').amount, 224);
  assert.ok(lines.some(l => l.event === 'courier request waiting' && l.agent === 't4' && /t4 not in 552/.test(l.why)));
  assert.ok(!calls.some(c => c.tool === 'supply' && c.args.to === 't4'));
  assert.ok(!calls.some(c => ['walk', 'walk_to', 'travel'].includes(c.tool)));
  assert.ok(calls.filter(c => c.tool === 'supply').every(c => c.args.stationary === true && c.args.who_travels === 'neither' &&
    c.args.no_dropoff === true));
  // Still short: 100 plain mushrooms (no farmer here has any) and 36 purple -- held back from his sale.
  assert.deepEqual(result.hold, { mushroom: 100, 'purple mushroom': 36 });
  assert.deepEqual(oceanLastRequestHold(), result.hold);
});

test('a requester that already holds its target is handed nothing, and a refusal moves nothing quietly', async () => {
  writeRequests({ t17: { 'red mushroom': 100 } });
  const packs = { hk2: pack([row(1, 'red mushroom', 50)]), t17: pack([row(11, 'red mushroom', 140)]) };
  const full = world({ packs, bodies: { hk2: zhengBody() } });
  await captured(() => deliverRequestedReagents(full.rpc, 'prod'));
  assert.ok(!full.calls.some(c => c.tool === 'supply'));
  const short = { hk2: pack([row(1, 'red mushroom', 50)]), t17: pack([row(11, 'red mushroom', 60)]) };
  const refused = world({ packs: short, bodies: { hk2: zhengBody() }, refuse: true });
  const { lines } = await captured(() => deliverRequestedReagents(refused.rpc, 'prod'));
  assert.ok(lines.some(l => l.event === 'courier request refused' && l.amount === 40));
  assert.equal(short.t17.items[0].amount, 60);
});

test('a requester that is not quiet is waited for, not handed anything', async () => {
  writeRequests({ t17: { 'red mushroom': 100 } });
  const packs = { hk2: pack([row(1, 'red mushroom', 50)]), t17: pack([]) };
  const fighting = body('Zoot', { combat: { active: true, personal_threat: { level: 'engaged' } } });
  assert.equal(oceanFarmerQuiet(fighting, packs.t17), false);
  assert.equal(oceanFarmerQuiet(body('Zoot'), packs.t17), true);
  const { rpc, calls } = world({ packs, bodies: { hk2: zhengBody(), t17: fighting } });
  const { lines } = await captured(() => deliverRequestedReagents(rpc, 'prod'));
  assert.ok(lines.some(l => l.event === 'courier request waiting' && l.agent === 't17'));
  assert.ok(!calls.some(c => c.tool === 'supply'));
});

test('when Zheng holds none, a farmer in 552 gives only its surplus above its reserve', async () => {
  writeRequests({ t17: { mushroom: 100 }, t9: { mushroom: 60 } });
  const packs = {
    hk2: pack([row(1, 'shilling', 900)]),
    t17: pack([row(11, 'mushroom', 20)]),
    t5: pack([row(21, 'mushroom', 70)]),        // reserve 48: 22 spare
    t9: pack([row(31, 'mushroom', 75)]),        // its own request 60 beats the reserve: 15 spare
    t3: pack([row(41, 'mushroom', 200)]),       // the singer: never a giver
  };
  const { rpc, calls } = world({ packs, bodies: { hk2: zhengBody() } });
  const { result } = await captured(() => deliverRequestedReagents(rpc, 'prod'));
  assert.equal(packs.t5.items[0].amount, 48);
  assert.equal(packs.t9.items[0].amount, 60);
  assert.equal(packs.t3.items[0].amount, 200);
  assert.equal(packs.t17.items[0].amount, 20 + 22 + 15);
  assert.ok(!calls.some(c => c.tool === 'supply' && c.args.from === 't3'));
  assert.deepEqual(result.hold, { mushroom: 100 - 57 });
});

test('a broken requests file is loud, and the last reading that parsed still holds', async () => {
  writeRequests({ t17: { 'red mushroom': 100 } });
  const packs = { hk2: pack([row(1, 'red mushroom', 10)]), t17: pack([]) };
  const { rpc } = world({ packs, bodies: { hk2: zhengBody() } });
  await captured(() => oceanRequestPicture(rpc, 'prod'));
  writeRequests('{ not json');
  const { result, lines } = await captured(() => oceanRequestPicture(rpc, 'prod'));
  const loud = lines.find(l => l.event === 'courier requests unreadable');
  assert.ok(loud && /will not parse/.test(loud.error) && loud.using === 'the last reading that parsed');
  assert.deepEqual(result.hold, { 'red mushroom': 100 });
  rmSync(requestsFile, { force: true });
  const { result: none } = await captured(() => oceanRequestPicture(rpc, 'prod'));
  assert.deepEqual(none.hold, {});
  assert.deepEqual(oceanLastRequestHold(), {});
});

// PLAIN MUSHROOMS BOUGHT FOR THE REQUESTS (operator 2026-11-13). The Ocean farm never puts a farmer above its 48 reserve,
// so brokering alone never filled Zoot's 100. A real shortfall now buys them from Frisconar in Tos, by way of Cor Noth,
// bounded by the per-lap cap, the pack and the purse; no shortfall means no detour; nothing bought is ever sold.
const {
  oceanRequestBuyPlan, oceanRequestTripAllowed, oceanLapDue, OCEAN_REQUEST_SHOPS, OCEAN_REQUEST_ROUTE,
  OCEAN_REQUEST_TRIP_MIN, OCEAN_REQUEST_RETRY_MS, OCEAN_COURIER,
} = await import('./m59-ocean-courier-cache.mjs');
const { oceanDetourTarget, oceanCourierReturnSteps } = await import('./fleetscripts/ocean-courier.mjs');
const coins = n => row(99, 'shilling', n);
const mushroomPrice = OCEAN_REQUEST_SHOPS.Frisconar.supplies[0].price;

test('a plain-mushroom shortfall plans a purchase from Frisconar in Tos, by way of Cor Noth', () => {
  const plan = oceanRequestBuyPlan({ mushroom: 95 }, pack([coins(5000)]));
  assert.deepEqual(plan, { seller: 'Frisconar', room: 53, town: 'Tos', wanted: { mushroom: 95 }, cost: 95 * mushroomPrice });
  assert.equal(OCEAN_REQUEST_ROUTE.at(-1), 53);
  assert.ok(OCEAN_REQUEST_ROUTE.includes(150), 'the road goes through Cor Noth');
  assert.ok(!OCEAN_REQUEST_ROUTE.includes(584), 'and not through the Flatlands');
  // What he already carries for the requesters counts against the shortfall.
  assert.deepEqual(oceanRequestBuyPlan({ mushroom: 95 }, pack([coins(5000), row(4, 'mushroom', 40)])).wanted, { mushroom: 55 });
  // The per-lap cap.
  assert.equal(oceanRequestBuyPlan({ mushroom: 400 }, pack([coins(20000)])).wanted.mushroom, 150);
  // The lap is due for it, and says why.
  const due = oceanLapDue({ requestBuy: plan });
  assert.ok(due.go && /95 mushroom .*Frisconar in Tos/.test(due.why));
});

test('no shortfall worth the road: no purchase plan, no detour leg, the lap unchanged', () => {
  assert.equal(oceanRequestBuyPlan({}, pack([coins(5000)])), null);
  assert.equal(oceanRequestBuyPlan({ mushroom: OCEAN_REQUEST_TRIP_MIN - 1 }, pack([coins(5000)])), null);
  assert.equal(oceanRequestBuyPlan({ mushroom: 95 }, pack([coins(5000), row(4, 'mushroom', 80)])), null);
  // Never anything nobody requested, and never a requested item no table sells.
  assert.equal(oceanRequestBuyPlan({ 'red mushroom': 100, 'purple mushroom': 100 }, pack([coins(5000)])), null);
  assert.deepEqual(Object.keys(oceanRequestBuyPlan({ mushroom: 50, 'red mushroom': 100 }, pack([coins(5000)])).wanted), ['mushroom']);
  assert.equal(oceanLapDue({ requestBuy: null }).go, false);
  // Every detour leg stays put unless the trip was decided: at home before departure, at 544 on a lap without one.
  for (const to of OCEAN_REQUEST_ROUTE) {
    assert.equal(oceanDetourTarget(to, {}), 552);
    assert.equal(oceanDetourTarget(to, { go: true }), 544);
    assert.equal(oceanDetourTarget(to, { go: true, requestTrip: { seller: 'Frisconar' } }), to);
  }
  // A trip that bought nothing does not make the next lap go for it for an hour.
  assert.equal(oceanRequestTripAllowed(null), true);
  assert.equal(oceanRequestTripAllowed({ at: 0, bought: 30 }, 1), true);
  assert.equal(oceanRequestTripAllowed({ at: 0, bought: 0 }, OCEAN_REQUEST_RETRY_MS - 1), false);
  assert.equal(oceanRequestTripAllowed({ at: 0, bought: 0 }, OCEAN_REQUEST_RETRY_MS), true);
});

test('the purchase is bounded by the purse above his reserve, and by what the pack can hold', () => {
  const reserve = OCEAN_COURIER.reserve;
  assert.equal(oceanRequestBuyPlan({ mushroom: 100 }, pack([coins(reserve + 30 * mushroomPrice)])).wanted.mushroom, 30);
  assert.equal(oceanRequestBuyPlan({ mushroom: 100 }, pack([coins(reserve + 10 * mushroomPrice)])), null);
  // This lap's sales count toward the purse when the plan is made in the Ocean.
  assert.equal(oceanRequestBuyPlan({ mushroom: 100 }, pack([coins(reserve)]), { extra: 40 * mushroomPrice }).wanted.mushroom, 40);
  // Bulk 5 each: room for 25.
  const tight = pack([coins(5000)], { carry: { load: { exact: true, bulk: 100, weight: 100 }, room_for: { weight: 2000, bulk: 125 } } });
  assert.equal(oceanRequestBuyPlan({ mushroom: 100 }, tight).wanted.mushroom, 25);
  // A pack that cannot say how full it is buys nothing.
  assert.equal(oceanRequestBuyPlan({ mushroom: 100 }, pack([coins(5000)], { carry: { load: { exact: false } } })), null);
});

test('bought mushrooms are never sold, even once nobody is short of them', () => {
  const zheng = pack([row(1, 'mushroom', 120), row(2, 'red mushroom', 30)]);
  const sale = (received, hold) => Object.fromEntries(oceanTradeGoodsSale(zheng, received, hold).map(r => [r.name, r.amount]));
  assert.deepEqual(sale({}, {}), { 'red mushroom': 30 });
  assert.deepEqual(sale({ mushroom: 120 }, {}), { 'red mushroom': 30 });
});

test('a lap interrupted on the detour walks back through Cor Noth to 544 and home', () => {
  const corridor = [552, 544, 534, 535, 200, 202, 201];
  const s = num => ({ character: 'Zheng He', in_game: true, connected: true, ids_stale: false, room: { num },
    pid: 10, connection_revision: 1, last_save_at: 1000, you: { object_id: 7, row: 5, col: 5 }, hp: { value: 23, max: 23 },
    vigor: { value: 120 }, karma: { value: 10 }, combat: { personal_threat: { level: 'quiet' } },
    autopilot_status: { mode: 'survive', faculties: { work: 'keeper' },
      policy: { neverAttack: true, townTrips: false, confineRooms: [...corridor, ...OCEAN_REQUEST_ROUTE] } } });
  const walks = steps => steps.filter(step => step.do === 'walk').map(step => step.to);
  assert.deepEqual(walks(oceanCourierReturnSteps(s(53))), [50, 586, 587, 576, 575, 150, 574, 564, 554, 544, 552]);
  assert.deepEqual(walks(oceanCourierReturnSteps(s(150))), [574, 564, 554, 544, 552]);
  // Back on the corridor with the detour's confinement still set: the ordinary return.
  assert.deepEqual(walks(oceanCourierReturnSteps(s(544))), [552]);
  // On the route without the detour's confinement, nothing walks.
  const plain = s(150);
  plain.autopilot_status.policy.confineRooms = corridor;
  assert.equal(oceanCourierReturnSteps(plain), null);
});
