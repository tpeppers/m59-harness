import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OCEAN_SHOPS, oceanBuyQuantity, oceanCourierReserveFood, oceanProvisionRecord, oceanUnitsFit, selectOceanSalePiles,
} from './m59-ocean-courier-cache.mjs';
import { oceanCanVisitSmith, oceanCourierReturnSteps, oceanDeskReady, oceanDeskSpareCandidate, oceanWardScan, script } from './fleetscripts/ocean-courier.mjs';

const now = 100_000;
const epoch = 90_000;
const holder = { object_id: 90, row: 43, col: 57 };
const item = { id: 93, name: 'blue mushroom', amount: 48, row: 44, col: 56 };
const ward = { in_game: true, ids_stale: false, room: { num: 552 }, character: 'Statler',
  last_save_at: epoch, room_wire: { room_security_u32: 500 }, you: holder };
const scene = { ok: true, ids_stale: false, room: 552, last_save_at: epoch, items: [item] };
const donation = { kind: 'farm_sale_cache_deposit', room: 552, room_security: 500,
  courier: 'Zheng He', last_save_at: epoch, observed_at: 98_000, expires_at: 110_000,
  anchor: { id: 90, name: 'Statler', row: 43, col: 57 }, item };
const pack = { carry: { load: { exact: true }, room_for: { bulk: 100, weight: 100 } },
  items: [{ name: 'shilling', amount: 1000 }] };

test('only picks an exact, current Raphael spare paired with Zheng’s intake receipts', () => {
  const intake = { id: 42, generation: epoch, from: 'hk2', purchaseReceipt: 'Colhorr exact purchase', handoffReceipt: 'bilateral handoff' };
  const spare = { ...intake, room: 202, owner: 'hk3', name: 'axe', verified_at: now };
  const desk = { state: { deskSpare: [spare], deskCustody: [] }, conf: { deskSpareIntake: [intake] } };
  const raphael = { last_save_at: epoch, items: [{ id: 41, name: 'axe', rarity: 0 }, { id: 42, name: 'axe', rarity: 0 }] };
  assert.equal(oceanDeskSpareCandidate(desk, raphael), spare);
  assert.equal(oceanDeskSpareCandidate(desk, { ...raphael, last_save_at: epoch + 1 }), null);
  assert.equal(oceanDeskSpareCandidate(desk, { ...raphael, items: [{ id: 42, name: 'axe', rarity: 100 }] }), null);
  assert.equal(oceanDeskSpareCandidate({ ...desk, conf: { deskSpareIntake: [] } }, raphael), null);
  assert.equal(oceanDeskSpareCandidate({ ...desk, state: { ...desk.state, deskCustody: [{ id: 42 }] } }, raphael), null);
  assert.equal(oceanDeskSpareCandidate({ ...desk, state: { ...desk.state, deskDropRestore: { t1: true } } }, raphael), null);
});

test('only a quiet and unattended Raphael at the Toad qualifies for stationary trades', () => {
  const raphael = { character: 'Raphael son of Mephistopheles', room: { num: 202 }, connected: true, in_game: true,
    combat_ready: true, ids_stale: false, pid: 10, connection_revision: 4, you: { object_id: 5 },
    last_save_at: epoch, next_save_expected_at: Date.now() + 300_000, hp: { value: 30, max: 30 },
    combat: { active: false, personal_threat: { level: 'quiet' } },
    autopilot_status: { mode: 'survive', policy: { assignedRoom: 202, townTrips: false },
      faculties: { work: 'keeper', movement: 'keeper', economy: 'keeper' } } };
  assert.equal(oceanDeskReady(raphael), true);
  for (const busy of [{ hold: { active: true } }, { ridealong: { piloted: true } }, { human_held: true },
    { job: { busy: true } }, { room: { num: 201 } },
    { autopilot_status: { ...raphael.autopilot_status, committed: { kind: 'bot' } } },
    { autopilot_status: { ...raphael.autopilot_status, cast_rite: { active: true } } }])
    assert.equal(oceanDeskReady({ ...raphael, ...busy }), false);
  assert.deepEqual(script.controls, ['hk2', 'hk3']);
});

test('collects one receipt-bound exact stack and ignores ordinary identical floor loot', () => {
  const floor = { ...scene, items: [...scene.items, { ...item, id: 101 }] };
  assert.deepEqual(selectOceanSalePiles([donation, donation], floor, ward, now), [item]);
  assert.deepEqual(selectOceanSalePiles([], floor, ward, now), []);
  assert.deepEqual(selectOceanSalePiles([donation], { ...scene, items: [{ ...item, amount: 47 }] }, ward, now), []);
});

test('collects an exact same-save merge only when every prior unit has a receipt', () => {
  const base = { ...donation, observed_at: 91_000, expires_at: 95_000 };
  const combined = { ...item, amount: 74 };
  const merge = { ...donation, item: combined, previous_amount: 48, deposited_amount: 26 };
  const floor = { ...scene, items: [combined] };
  assert.deepEqual(selectOceanSalePiles([merge, base], floor, ward, now), [combined]);
  assert.deepEqual(selectOceanSalePiles([merge], floor, ward, now), []);
  assert.deepEqual(selectOceanSalePiles([base, { ...merge, previous_amount: 47, deposited_amount: 27 }],
    floor, ward, now), []);
  const reconciled = { ...merge, kind: 'farm_sale_cache_reconciled', reconciliation: {
    kind: 'native-drop-merge', agent: 't2', floor_before_at: 92_000, pack_after_at: 93_000, floor_after_at: 94_000,
  } };
  assert.deepEqual(selectOceanSalePiles([base, reconciled], floor, ward, now), [combined]);
  assert.deepEqual(selectOceanSalePiles([base, { ...reconciled, reconciliation: { ...reconciled.reconciliation,
    floor_after_at: 89_000 } }], floor, ward, now), []);
});

test('rejects expired, wrong-ward, old-generation and unapproved parcels', () => {
  const bad = [
    { ...donation, expires_at: now },
    { ...donation, last_save_at: epoch - 100 },
    { ...donation, room_security: 501 },
    { ...donation, anchor: { ...donation.anchor, id: 9 } },
    { ...donation, item: { ...item, name: 'sapphire' } },
    { ...donation, item: { ...item, row: 43 } },
  ];
  assert.deepEqual(selectOceanSalePiles(bad, scene, ward, now), []);
  assert.deepEqual(selectOceanSalePiles([donation], { ...scene, ids_stale: true }, ward, now), []);
});

test('provision purchase respects price ceilings, capacity and walking purse', () => {
  const bread = OCEAN_SHOPS.Tova[0];
  const listing = { id: 1, name: 'loaf of bread', cost: 120 };
  assert.equal(oceanBuyQuantity(pack, listing, bread, 24), 5);
  assert.equal(oceanBuyQuantity(pack, { ...listing, cost: 121 }, bread, 24), 0);
  assert.equal(oceanBuyQuantity({ ...pack, items: [{ name: 'shilling', amount: 519 }] }, listing, bread, 24), 0);
  assert.equal(oceanUnitsFit({ carry: { load: { exact: false }, room_for: { bulk: 100, weight: 100 } } },
    'red mushroom'), 0);
});

test('skips the smith when the prior counter left only the walking purse', () => {
  const packWith = amount => ({
    carry: { load: { exact: true }, room_for: { bulk: 200, weight: 200 } },
    items: [{ name: 'shilling', amount }],
  });
  const wanted = { axe: 1, 'leather armor': 1 };
  assert.equal(oceanCanVisitSmith(packWith(400), wanted), false);
  assert.equal(oceanCanVisitSmith(packWith(1040), wanted), true);
  assert.equal(oceanCanVisitSmith(packWith(1040), { axe: 1 }), false);
});

test('prepares a quiet under-vigor courier with his own unprotected reserve food', () => {
  const loaf = { id: 8, name: 'loaf of bread', amount: 2 };
  const mushroom = { id: 9, name: 'edible mushroom', amount: 10 };
  const status = { vigor: { value: 129 }, ids_stale: false, items: [mushroom, loaf] };
  assert.equal(oceanCourierReserveFood(status), loaf);
  assert.equal(oceanCourierReserveFood({ ...status, vigor: { value: 140 } }), null);
  assert.equal(oceanCourierReserveFood({ ...status, vigor: { value: 70 } }), null);
  assert.equal(oceanCourierReserveFood({ ...status, ids_stale: true }), null);
  assert.equal(oceanCourierReserveFood({ ...status,
    autopilot_status: { policy: { protectedItems: ['Loaf of Bread'] } } }), null);
});

test('provision records admit only exact kinds, room and holder', () => {
  const host = { host: 'example.test', port: 5959 };
  const bread = { ...item, name: 'loaf of bread' };
  const gear = { ...item, name: 'axe' };
  const foodRecord = oceanProvisionRecord({ host, ward, items: [bread], kind: 'food', now });
  assert.equal(foodRecord.schema, 'm59-farm-food-cache/1');
  assert.equal(foodRecord.expires_at, 400_000);
  assert.equal(foodRecord.item.id, item.id);
  const gearRecord = oceanProvisionRecord({ host, ward, items: [gear], kind: 'gear', now });
  assert.equal(gearRecord.last_save_at, epoch);
  assert.equal(gearRecord.items[0].id, item.id);
  assert.throws(() => oceanProvisionRecord({ host, ward, items: [bread], kind: 'gear', now }));
  assert.throws(() => oceanProvisionRecord({ host, ward, items: [{ ...bread, col: 40 }], kind: 'food', now }));
});

test('interrupted courier only returns on its own authorized corridor and quiet body', () => {
  const s = { character: 'Zheng He', in_game: true, connected: true, ids_stale: false, room: { num: 534 },
    pid: 10, connection_revision: 1, last_save_at: epoch, you: holder, hp: { value: 23, max: 23 },
    vigor: { value: 120 }, karma: { value: 10 }, combat: { personal_threat: { level: 'quiet' } },
    autopilot_status: { mode: 'survive', faculties: { work: 'keeper' },
      policy: { neverAttack: true, townTrips: false, confineRooms: [552, 544, 534, 535, 200, 202, 201] } } };
  const steps = oceanCourierReturnSteps(s);
  assert.deepEqual(steps.filter(step => step.do === 'walk').map(step => step.to), [544, 552]);
  assert.equal(oceanCourierReturnSteps({ ...s, combat: { active: true } }), null);
  assert.deepEqual(oceanCourierReturnSteps({ ...s, room: { num: 535 } })
    .filter(step => step.do === 'walk').map(step => step.to), [544, 552]);
  assert.equal(oceanCourierReturnSteps({ ...s, room: { num: 533 } }), null);
  assert.equal(oceanCourierReturnSteps({ ...s, you: { ...holder, object_id: null } }), null);
});

test('every conditional courier leg declares its possible rooms for FleetScript preflight', async () => {
  const prior = process.env.M59_FLEET;
  process.env.M59_FLEET = 'prod';
  try {
    const steps = await script.steps({ agent: 'hk2' });
    const legs = steps.filter(step => step.do === 'walk' && typeof step.to === 'function');
    assert.ok(legs.length > 0);
    for (const leg of legs) {
      assert.ok(leg.candidates.length > 0);
      assert.ok(leg.candidates.includes(leg.to({})));
      assert.ok(leg.candidates.every(room => [201, 202, 200, 534, 544, 552].includes(room)));
    }
  } finally {
    if (prior === undefined) delete process.env.M59_FLEET;
    else process.env.M59_FLEET = prior;
  }
});

test('stamps the broker floor scan only inside one proved room and save epoch', async () => {
  const live = { ...ward, connected: true, pid: 10, connection_revision: 1,
    objects: [{ ...item, can: ['get'] }] };
  const raw = { ok: true, room: 552, near: { row: 43, col: 57 }, items: [item] };
  const stable = async tool => tool === 'look' ? live : raw;
  const current = await oceanWardScan(stable, 'hk2', ['blue mushroom']);
  assert.deepEqual(current, { ...raw, ids_stale: false, last_save_at: epoch });
  const changed = async tool => tool === 'look' ? { ...live, objects: [{ ...item, amount: 47, can: ['get'] }] } : raw;
  assert.equal((await oceanWardScan(changed, 'hk2', ['blue mushroom'])).ok, false);
  let views = 0;
  const saves = async tool => tool === 'look'
    ? { ...live, last_save_at: epoch + (views++ ? 10 : 0) } : raw;
  const crossed = await oceanWardScan(saves, 'hk2', ['blue mushroom']);
  assert.equal(crossed.ok, false);
  assert.equal(crossed.ids_stale, true);
});
