// THE OCEAN COURIER AFTER 2026-11-11: an unknown save epoch is an epoch, the farmers' sale piles ride with Zheng and are
// sold in Marion, and the desk's dedicated axes are handed to the farmers without magic. Offline; fakes only.
//   node tools/m59-ocean-trade-goods-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Every file this suite writes goes to a temporary directory, set before the modules read their paths.
const dir = mkdtempSync(join(tmpdir(), 'm59-ocean-trade-goods-'));
process.env.M59_TRADE_GOODS_DIR = join(dir, 'trade-goods');
process.env.M59_OCEAN_GEAR_CARGO_FILE = join(dir, 'cargo.json');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const {
  OCEAN_COURIER_KEEP, oceanSaveClear, oceanSaveEpoch, oceanTradeGoodsAcceptance, oceanTradeGoodsDue, oceanTradeGoodsSale,
  readOceanGearCargo, recordOceanGearCargo, selectOceanGearCargo, OCEAN_LAP, oceanLapDue, oceanSaleValue,
  oceanMedicHerbWant, oceanMedicOutcome, oceanBuyQuantity, oceanReadJson,
} = await import('./m59-ocean-courier-cache.mjs');
const {
  oceanAxeRecipients, oceanCourierReady, oceanCourierWaiting, oceanDeskReady, oceanDeskStockAxes, oceanWardReady,
  oceanWardWaiting, sellTradeGoods, setOceanTradeGoods, depositPurseWithDesk, OCEAN_PURSE_FLOAT,
} = await import('./fleetscripts/ocean-courier.mjs');
const { noteReceived, readReceived } = await import('./m59-loot-eject.mjs');

const now = Date.now();
const zheng = (over = {}) => ({ character: 'Zheng He', in_game: true, connected: true, ids_stale: false,
  room: { num: 552 }, pid: 38080, connection_revision: 1, last_save_at: null, next_save_expected_at: null,
  you: { object_id: 7081, row: 19, col: 32 }, hp: { value: 23, max: 23 }, vigor: { value: 160 }, karma: { value: 10 },
  combat: { personal_threat: { level: 'quiet' } },
  autopilot_status: { mode: 'survive', faculties: { work: 'keeper' }, policy: { neverAttack: true, townTrips: false } }, ...over });
const statler = (over = {}) => ({ character: 'Statler', in_game: true, ids_stale: false, room: { num: 552 },
  you: { object_id: 4444, row: 43, col: 57 }, last_save_at: null, next_save_expected_at: null,
  autopilot_status: { faculties: { work: { owner: 'great-ocean:jala-singer' } } }, ...over });

test('an unobserved save epoch is an epoch; stale ids and a save due soon are not', () => {
  assert.equal(oceanSaveEpoch({ ids_stale: false, last_save_at: null }), null);
  assert.equal(oceanSaveEpoch({ ids_stale: false, last_save_at: 1234 }), 1234);
  assert.equal(oceanSaveEpoch({ ids_stale: true, last_save_at: null }), undefined);
  assert.equal(oceanSaveEpoch({ ids_stale: false, last_save_at: 'soon' }), undefined);
  assert.equal(oceanSaveClear({ ids_stale: false, last_save_at: null, next_save_expected_at: null }, 30_000, now), true);
  assert.equal(oceanSaveClear({ ids_stale: false, last_save_at: 9, next_save_expected_at: now + 10_000 }, 30_000, now), false);
  assert.equal(oceanSaveClear({ ids_stale: false, last_save_at: 9, next_save_expected_at: now + 60_000 }, 30_000, now), true);
  assert.equal(oceanSaveClear({ ids_stale: true, last_save_at: 9, next_save_expected_at: now + 60_000 }, 30_000, now), false);
});

test('the 2026-11-11 courier is ready with null save fields, and says why when it is not', () => {
  // The live replies after the 18:05Z restart: last_save_at null, next_save_expected_at null.
  assert.equal(oceanCourierReady(zheng(), 552, 140), true);
  assert.equal(oceanWardReady(statler()), true);
  assert.equal(oceanCourierWaiting(zheng({ ids_stale: true }), 552), 'Zheng ids are stale');
  assert.match(oceanCourierWaiting(zheng({ hp: { value: 20, max: 23 } }), 552), /health 20\/23/);
  assert.match(oceanCourierWaiting(zheng({ room: { num: 202 } }), 552), /in 202, not 552/);
  assert.match(oceanCourierWaiting(zheng({ pid: null }), 552), /pid/);
  assert.match(oceanWardWaiting(statler({ you: { object_id: 4444, row: 40, col: 57 } })), /ward square/);
  assert.match(oceanWardWaiting(statler({ last_save_at: 5, next_save_expected_at: Date.now() + 5000 })), /save is due/);
});

test('a quiet desk with an unknown epoch qualifies; a save due within 45 s does not', () => {
  const raphael = (over = {}) => ({ character: 'Raphael son of Mephistopheles', in_game: true, connected: true,
    combat_ready: true, ids_stale: false, room: { num: 202 }, pid: 50, connection_revision: 2, last_save_at: null,
    next_save_expected_at: null, you: { object_id: 7082 }, hp: { value: 30, max: 30 },
    combat: { personal_threat: { level: 'quiet' } },
    autopilot_status: { mode: 'survive', policy: { assignedRoom: 202, townTrips: false },
      faculties: { work: 'keeper', movement: 'keeper', economy: 'keeper' } }, ...over });
  assert.equal(oceanDeskReady(raphael()), true);
  assert.equal(oceanDeskReady(raphael({ last_save_at: 7, next_save_expected_at: Date.now() + 20_000 })), false);
});

test('gear cargo in an unknown epoch is bound to the keeper process and connection that saw it', () => {
  const server = { host: 'prod.example', port: 5959 };
  const at202 = zheng({ room: { num: 202 } });
  const cargo = { id: 12995, name: 'axe', source: 'Raphael', receipt: { id: 12995, name: 'axe', from: 'hk3', to: 'hk2',
    generation: null, started: now - 2000, confirmed: now - 1000, from_body: 7082, to_body: 7081 } };
  recordOceanGearCargo('prod', server, at202, cargo);
  const record = readOceanGearCargo('prod');
  assert.equal(record.last_save_at, null);
  assert.equal(record.keeper_pid, 38080);
  const pack = { ids_stale: false, last_save_at: null, ids_as_of: now, items: [{ id: 12995, name: 'axe', rarity: 0 }] };
  assert.deepEqual(selectOceanGearCargo(record, server, zheng(), pack), [cargo]);
  // A reconnect, a new keeper process, or an observed save each void the handle.
  assert.deepEqual(selectOceanGearCargo(record, server, zheng({ connection_revision: 2 }), pack), []);
  assert.deepEqual(selectOceanGearCargo(record, server, zheng({ pid: 1 }), pack), []);
  assert.deepEqual(selectOceanGearCargo(record, server, zheng({ last_save_at: now }), { ...pack, last_save_at: now }), []);
});

test('the farm loot Zheng carries is sold above his working stock, ledger or not; never gear, money or keepsakes', () => {
  const pack = { items: [
    { name: 'emerald', amount: 125 }, { name: 'red mushroom', amount: 80 }, { name: 'elderberry', amount: 70 },
    { name: 'shilling', amount: 900 }, { name: 'axe', amount: 0 }, { name: 'diamond', amount: 3 }, { name: 'herb', amount: 20 },
    { name: 'wand of healing', amount: 0 }, { name: 'Jewel of Froz', amount: 0 }, { name: 'entroot berry', amount: 9 },
  ] };
  const byName = rows => Object.fromEntries(rows.map(row => [row.name, row.amount]));
  const sale = byName(oceanTradeGoodsSale(pack, { emerald: 125, 'red mushroom': 60, elderberry: 50, shilling: 300, axe: 1,
    diamond: 10, herb: 40, sapphire: 4, 'entroot berry': 4 }));
  // red mushroom: all 80 go, not the 60 the ledger knows; entroot only as far as the ledger says farmers gave it.
  assert.deepEqual(sale, { emerald: 125, 'red mushroom': 80, elderberry: 70 - OCEAN_COURIER_KEEP.elderberry, diamond: 3,
    'entroot berry': 4 });
  // 2026-11-12, the live backlog: an empty ledger still sells the farm's loot, never the wand, the jewel or the entroot.
  assert.deepEqual(byName(oceanTradeGoodsSale(pack, {})), { emerald: 125, 'red mushroom': 80,
    elderberry: 70 - OCEAN_COURIER_KEEP.elderberry, diamond: 3 });
});

test('a lap departs only when it is worth the road, and waits in the Ocean otherwise', () => {
  assert.equal(oceanLapDue({}).go, false);
  assert.match(oceanLapDue({ saleValue: 120 }).why, /waiting in the Ocean/);
  assert.equal(oceanLapDue({ parcels: 1 }).go, true);
  assert.equal(oceanLapDue({ saleValue: OCEAN_LAP.saleValue }).go, true);
  // Full of something worth selling goes; full of his own kit does not (03:41Z: 'pack 80% full', 50 shillings).
  assert.equal(oceanLapDue({ fullness: 0.6, saleValue: OCEAN_LAP.minValue }).go, true);
  assert.equal(oceanLapDue({ fullness: 0.8, saleValue: 50 }).go, false);
  assert.equal(oceanLapDue({ axeWork: true }).go, true);
  assert.equal(oceanLapDue({ breadShort: true }).go, true);
  // The longest wait goes with something to do, never empty-handed.
  assert.equal(oceanLapDue({ sinceLastMs: OCEAN_LAP.maxWaitMs, saleValue: 50 }).go, false);
  assert.equal(oceanLapDue({ sinceLastMs: OCEAN_LAP.maxWaitMs, saleValue: 300 }).go, true);
  assert.equal(oceanLapDue({ sinceLastMs: OCEAN_LAP.maxWaitMs - 1, saleValue: 300 }).go, false);
  assert.equal(oceanLapDue({ sinceLastMs: OCEAN_LAP.maxWaitMs, provision: true }).go, true);
  // Morrigan pays 0.7 of the book's estimate.
  assert.equal(oceanSaleValue([{ name: 'dark angel feather', amount: 4 }], () => 105), 294);
  assert.ok(oceanSaleValue([{ name: 'red mushroom', amount: 234 }]) >= OCEAN_LAP.saleValue);
});

test('medic herbs: never more than he can take, nothing after a capacity refusal, capped by the last delivery', () => {
  assert.equal(oceanMedicHerbWant({ healerHerbs: 100 }), 0);
  assert.equal(oceanMedicHerbWant({ healerHerbs: 0, carried: 0, fits: 400 }), 180);
  assert.equal(oceanMedicHerbWant({ healerHerbs: 0, carried: 25, fits: 60 }), 40);
  assert.equal(oceanMedicHerbWant({ healerHerbs: 0, fits: 400, last: { refused: 'capacity' } }), 0);
  assert.equal(oceanMedicHerbWant({ healerHerbs: 0, fits: 400, last: { delivered: 84 } }), 84);
  assert.equal(oceanMedicHerbWant({ healerHerbs: 0, fits: 400, last: { refused: 'other' } }), 180);
  assert.equal(oceanMedicOutcome({ amount: 88, verified: false,
    reason: 'the receiver cannot hold it — the server refused the offer on weight or bulk' }).refused, 'capacity');
  assert.equal(oceanMedicOutcome({ amount: 85, verified: false, reason: 'the offer never reached them' }).refused, 'other');
  assert.deepEqual({ ...oceanMedicOutcome({ amount: 84, verified: true, now: 5 }) }, { delivered: 84, refused: null, at: 5 });
});

test('purchases hold back for a higher priority, and desk files may carry a byte-order mark', () => {
  const pack = { carry: { load: { exact: true }, room_for: { bulk: 2000, weight: 2000 } }, items: [{ name: 'shilling', amount: 2000 }] };
  const herb = { id: 1, name: 'herb', cost: 20 };
  const supply = { name: 'herb', limit: 180, price: 20 };
  assert.equal(oceanBuyQuantity(pack, herb, supply, 180), 80);           // (2000 - 400 reserve) / 20
  assert.equal(oceanBuyQuantity(pack, herb, supply, 180, 960), 32);      // the Colhorr axe held back
  const file = join(dir, 'bom.json');
  writeFileSync(file, '﻿{"exclude":["hk1","hk2"]}');
  assert.deepEqual(oceanReadJson(file), { exclude: ['hk1', 'hk2'] });
  const source = readFileSync(new URL('./fleetscripts/ocean-courier.mjs', import.meta.url), 'utf8');
  assert.match(source, /function readDeskState[\s\S]{0,700}oceanReadJson\(files\.state\)[\s\S]{0,80}oceanReadJson\(files\.conf\)/);
});

test('a received pile is worth a lap at 500 bulk or a pack 55% full', () => {
  const light = { carry: { load: { bulk: 400 }, room_for: { bulk: 2300 } } };
  assert.equal(oceanTradeGoodsDue(light, [{ name: 'emerald', amount: 100 }]), false);
  assert.equal(oceanTradeGoodsDue(light, [{ name: 'red mushroom', amount: 100 }]), true);
  assert.equal(oceanTradeGoodsDue({ carry: { load: { bulk: 1600 }, room_for: { bulk: 1100 } } },
    [{ name: 'emerald', amount: 10 }]), true);
  assert.equal(oceanTradeGoodsDue({ carry: { load: { bulk: 2000 }, room_for: { bulk: 700 } } }, []), false);
});

test('trade-goods acceptance keeps Zheng\'s existing take list and pushes only a change', () => {
  const live = { enabled: true, reagents: ['wand', 'entroot berry'], drop_for_space: ['loaf of bread'], min_bulk_free: 40 };
  const on = oceanTradeGoodsAcceptance(live, true);
  assert.deepEqual(on, { ...live, trade_goods: { keep_free: 0.15 } });
  assert.equal(oceanTradeGoodsAcceptance({ ...on, trade_goods: { enabled: true, keep_free: 0.15, from: null } }, true), null);
  assert.deepEqual(oceanTradeGoodsAcceptance(on, false), live);
  assert.equal(oceanTradeGoodsAcceptance(live, false), null);
  assert.deepEqual(oceanTradeGoodsAcceptance(null, true), { enabled: true, min_bulk_free: 40, trade_goods: { keep_free: 0.15 } });
  // The live list on 2026-11-11 named shillings among the things he sheds for space; a purse of sale proceeds is not.
  const shedsMoney = { ...live, drop_for_space: ['shilling', 'loaf of bread'] };
  assert.deepEqual(oceanTradeGoodsAcceptance(shedsMoney, true).drop_for_space, ['loaf of bread']);
  assert.notEqual(oceanTradeGoodsAcceptance({ ...shedsMoney, trade_goods: { keep_free: 0.15 } }, true), null);
});

test('desk stock: only unworn axes the weapon book reads as dedicated', () => {
  const raphael = { items: [
    { id: 11439, name: 'mace', rarity: 0 }, { id: 12658, name: 'axe', rarity: 0 }, { id: 12995, name: 'axe', rarity: 0 },
    { id: 13001, name: 'axe', rarity: 0 }, { id: 13002, name: 'axe', rarity: 100 },
  ], autopilot_status: { weapon_magic: { weapons: [
    { id: 11439, name: 'mace', class: 'mundane', wielded: true },
    { id: 12658, name: 'axe', class: 'mundane', bypasses_nonmagic: false },
    { id: 12995, name: 'axe', class: 'enchanted', bypasses_nonmagic: true },
    { id: 13001, name: 'axe', class: 'enchanted', bypasses_nonmagic: true, wielded: true },
    { id: 13002, name: 'axe', class: 'enchanted', bypasses_nonmagic: true },
  ] } } };
  // 13001 is in his hand; 13002 is unidentified (rarity 100), so it is never handed over on a name.
  assert.deepEqual(oceanDeskStockAxes(raphael), [12995]);
  assert.deepEqual(oceanDeskStockAxes(null), []);
});

test('dedicated axes go to automated Ocean farmers without magic, bludgeon wielders first', () => {
  const plain = { wielded: { bypasses_nonmagic: false }, magic_spares: 0 };
  const rows = [
    { agent: 't20', room_num: 552, wielding: 'scimitar', weapon_magic: plain },
    { agent: 't1', room_num: 552, wielding: 'hammer', weapon_magic: plain },
    { agent: 't4', room_num: 552, wielding: 'axe', weapon_magic: { wielded: { bypasses_nonmagic: true } } },
    { agent: 't19', room_num: 552, wielding: 'long sword', weapon_magic: { ...plain, magic_spares: 1 } },
    { agent: 't3', room_num: 552, wielding: null, weapon_magic: plain },
    { agent: 't6', room_num: 552, activity: 'NOT IN GAME', weapon_magic: plain },
    { agent: 't9', room_num: 552, piloted: true, wielding: 'mace', weapon_magic: plain },
    { agent: 't7', room_num: 534, wielding: 'axe', weapon_magic: plain },
    { agent: 'hk2', room_num: 552, wielding: 'hammer', weapon_magic: plain },
    { agent: 't8', room_num: 552, wielding: 'mace', weapon_magic: null },
  ];
  assert.deepEqual(oceanAxeRecipients(rows).map(r => r.agent), ['t1', 't20']);
});

test('trade goods are sold at the quote, judged by pack and purse, and a refusing counter keeps the row', async () => {
  noteReceived('hk2', [{ name: 'emerald', amount: 30 }, { name: 'hammer', amount: 1 }]);
  let pack = { ids_stale: false, last_save_at: null, items: [{ id: 1, name: 'shilling', amount: 500 },
    { id: 2, name: 'emerald', amount: 30 }, { id: 3, name: 'hammer', amount: 0 }] };
  const body = zheng({ room: { num: 202 } });
  const calls = [];
  const rpc = async (tool, args) => {
    if (tool === 'status') return body;
    if (tool === 'inventory') return pack;
    if (tool === 'look') return { room: { num: 202 }, objects: [{ id: 99, name: 'Morrigan', can: ['buy'] }] };
    assert.fail(`unexpected ${tool}`);
  };
  const keeper = async (op, args) => {
    calls.push([op, args]);
    if (args.item.id === 3) return { sold: false, offered_price: null };          // an innkeeper does not buy a hammer
    if (!args.confirm) return { sold: false, offered_price: 21 * args.item.amount };
    assert.equal(args.expected_price, 21 * args.item.amount);
    pack = { ...pack, items: [{ id: 1, name: 'shilling', amount: 500 + args.expected_price }, { id: 3, name: 'hammer', amount: 0 }] };
    return { sold: true };
  };
  const plan = { trade: [{ name: 'emerald', amount: 30 }, { name: 'hammer', amount: 1 }] };
  await sellTradeGoods(rpc, keeper, plan, 'Morrigan', 202);
  assert.deepEqual(plan.trade, [{ name: 'hammer', amount: 1 }]);
  assert.deepEqual(calls.filter(([, a]) => a.confirm).map(([, a]) => a.item), [{ id: 2, amount: 30 }]);
  assert.deepEqual(readReceived('hk2'), { hammer: 1 });

  // A purse that does not move by the quoted price is an ambiguous sale and stops the lap.
  pack = { ids_stale: false, last_save_at: null, items: [{ id: 1, name: 'shilling', amount: 500 }, { id: 4, name: 'ruby', amount: 5 }] };
  const short = async (op, args) => {
    if (!args.confirm) return { sold: false, offered_price: 100 };
    pack = { ...pack, items: [{ id: 1, name: 'shilling', amount: 550 }] };
    return { sold: true };
  };
  await assert.rejects(sellTradeGoods(rpc, short, { trade: [{ name: 'ruby', amount: 5 }] }, 'Morrigan', 202), /ambiguous ruby sale/);
});

test('the acceptance switch pushes only a change and reports whether the keeper confirmed it', async () => {
  let policy = { enabled: true, reagents: ['wand'], min_bulk_free: 40 };
  const pushes = [];
  const rpc = async (tool, args) => {
    if (tool === 'status') return zheng({ autopilot_status: { policy: { acceptDonations: policy } } });
    assert.equal(tool, 'autopilot');
    pushes.push(args.accept_donations);
    policy = args.accept_donations;
    return { keeper_push: { confirmed: true } };
  };
  assert.equal(await setOceanTradeGoods(rpc, true), true);
  assert.equal(await setOceanTradeGoods(rpc, true), true);
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].trade_goods, { keep_free: 0.15 });
  assert.equal(await setOceanTradeGoods(rpc, false), true);
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].trade_goods, undefined);
  assert.deepEqual(pushes[1].reagents, ['wand']);
});

test('Zheng hands his purse above the 2000 float to Raphael in the Toad, judged by both purses', async () => {
  const toad = zheng({ room: { num: 202 } });
  const raphael = { character: 'Raphael son of Mephistopheles', in_game: true, connected: true, combat_ready: true,
    ids_stale: false, room: { num: 202 }, pid: 50, connection_revision: 2, last_save_at: null, next_save_expected_at: null,
    you: { object_id: 7082 }, hp: { value: 30, max: 30 }, combat: { personal_threat: { level: 'quiet' } },
    autopilot_status: { mode: 'survive', policy: { assignedRoom: 202, townTrips: false },
      faculties: { work: 'keeper', movement: 'keeper', economy: 'keeper' } } };
  const fake = ({ zhengPurse, deliver }) => {
    const purses = { hk2: zhengPurse, hk3: 6683 };
    const supplies = [];
    const rpc = async (tool, args) => {
      if (tool === 'status') return args.agent === 'hk3' ? raphael : toad;
      if (tool === 'inventory') return { ids_stale: false, last_save_at: null, ids_as_of: now,
        items: [{ id: args.agent === 'hk3' ? 11210 : 10786, name: 'shilling', amount: purses[args.agent] }] };
      assert.equal(tool, 'supply');
      supplies.push(args);
      const moved = deliver(args.what[0].amount);
      purses.hk2 -= moved.lost; purses.hk3 += moved.gained;
      return { supplied: moved.gained > 0 };
    };
    return { rpc, supplies, purses };
  };
  const exact = fake({ zhengPurse: 9500, deliver: n => ({ lost: n, gained: n }) });
  assert.equal(await depositPurseWithDesk(exact.rpc), 9500 - OCEAN_PURSE_FLOAT);
  assert.deepEqual(exact.supplies[0], { from: 'hk2', to: 'hk3', stationary: true, who_travels: 'neither', no_dropoff: true,
    ids_as_of: now, what: [{ id: 10786, name: 'shilling', amount: 7500 }] });
  assert.deepEqual(exact.purses, { hk2: 2000, hk3: 14183 });

  const float = fake({ zhengPurse: 2050, deliver: () => assert.fail('no hand-over under the float') });
  assert.equal(await depositPurseWithDesk(float.rpc), null);

  const refused = fake({ zhengPurse: 5000, deliver: () => ({ lost: 0, gained: 0 }) });
  assert.equal(await depositPurseWithDesk(refused.rpc), null);

  const partial = fake({ zhengPurse: 5000, deliver: n => ({ lost: n, gained: n - 100 }) });
  await assert.rejects(depositPurseWithDesk(partial.rpc), /ambiguous purse hand-over/);
});

test('a confirm the keeper refuses with nothing moved skips that item and the counter carries on', async () => {
  let pack = { ids_stale: false, last_save_at: null, items: [{ id: 1, name: 'shilling', amount: 500 },
    { id: 5, name: 'blue mushroom', amount: 40 }, { id: 6, name: 'diamond', amount: 4 }] };
  const body = zheng({ room: { num: 202 } });
  const rpc = async tool => {
    if (tool === 'status') return body;
    if (tool === 'inventory') return pack;
    if (tool === 'look') return { room: { num: 202 }, objects: [{ id: 99, name: 'Morrigan', can: ['buy'] }] };
    assert.fail(`unexpected ${tool}`);
  };
  const keeper = async (op, args) => {
    if (!args.confirm) return { sold: false, offered_price: 25 * args.item.amount };
    if (args.item.id === 5) return { sold: false, note: 'sale did not remove the offered quantity' };   // nothing moved
    pack = { ...pack, items: [{ id: 1, name: 'shilling', amount: 500 + args.expected_price }, { id: 5, name: 'blue mushroom', amount: 40 }] };
    return { sold: true };
  };
  const plan = { trade: [{ name: 'blue mushroom', amount: 40 }, { name: 'diamond', amount: 4 }] };
  await sellTradeGoods(rpc, keeper, plan, 'Morrigan', 202);
  assert.deepEqual(plan.trade, [{ name: 'blue mushroom', amount: 40 }]);          // rides home; the diamonds still sold
  assert.equal(pack.items.find(i => i.name === 'shilling').amount, 600);
});
test('a refusal whose pack shows the exact sale is a sale (the 09:36Z ruby), and the counter carries on', async () => {
  let pack = { ids_stale: false, last_save_at: null, items: [{ id: 1, name: 'shilling', amount: 500 },
    { id: 7, name: 'ruby', amount: 15 }, { id: 6, name: 'diamond', amount: 4 }] };
  const body = zheng({ room: { num: 202 } });
  const rpc = async tool => {
    if (tool === 'status') return body;
    if (tool === 'inventory') return pack;
    if (tool === 'look') return { room: { num: 202 }, objects: [{ id: 99, name: 'Morrigan', can: ['buy'] }] };
    assert.fail(`unexpected ${tool}`);
  };
  const keeper = async (op, args) => {
    if (!args.confirm) return { sold: false, offered_price: 100 * args.item.amount };
    const coins = pack.items.find(i => i.name === 'shilling').amount + args.expected_price;
    pack = { ...pack, items: [{ id: 1, name: 'shilling', amount: coins }, ...pack.items.filter(i => i.name !== 'shilling' && i.id !== args.item.id)] };
    return args.item.id === 7 ? { sold: false, note: 'sale did not remove the offered quantity' } : { sold: true };
  };
  const plan = { trade: [{ name: 'ruby', amount: 15 }, { name: 'diamond', amount: 4 }] };
  await sellTradeGoods(rpc, keeper, plan, 'Morrigan', 202);
  assert.deepEqual(plan.trade, []);                                                // both sold, nothing rides home
  assert.equal(pack.items.find(i => i.name === 'shilling').amount, 500 + 1500 + 400);
});