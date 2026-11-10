import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeBook } from './m59-dibs.mjs';
import {
  OCEAN_SHOPS, oceanBreadPlan, oceanBuyQuantity, oceanCourierReserveFood, oceanHasProvisionBatch,
  oceanProvisionRecord, oceanUnitsFit, readOceanGearCargo, readOceanSaleAuthorization, recordOceanGearCargo,
  renewOceanSaleClaims, selectOceanGearCargo, selectOceanSalePiles,
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

const minute = 60_000;
const originalClaims = renewOceanSaleClaims({ claims: [] }, donation.observed_at - 30_000);
const liveWardPin = time => ({ schema: 'm59-farm-sale-cache-ward/1', room: 552, room_security: 500,
  last_save_at: epoch, observed_at: time - 2000, expires_at: time + 2 * minute, anchor: donation.anchor });
const saleAuthorization = (raw, time, pin = liveWardPin(time)) => ({ book: normalizeBook(raw), pin });
const selectUnexpired = (rows, floor, singer) =>
  selectOceanSalePiles(rows, floor, singer, now, saleAuthorization(originalClaims, now, null));

function courierTestFiles(t, names) {
  const dir = mkdtempSync(join(tmpdir(), 'm59-ocean-courier-'));
  const files = Object.fromEntries(names.map(name => [name, join(dir, `${name}.json`)]));
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, file] of Object.entries(files)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
      rmSync(file, { force: true });
    }
    rmdirSync(dir);
  });
  Object.assign(process.env, files);
  return files;
}

test('a fully receipted sale stack survives an interrupted lap while exact Dibs are renewed', () => {
  const eightMinutesLater = donation.observed_at + 8 * minute;
  const renewed = renewOceanSaleClaims(originalClaims, eightMinutesLater);
  assert.ok(renewed.claims.every((claim, index) => claim.at === originalClaims.claims[index].at &&
    Date.parse(claim.until) > Date.parse(originalClaims.claims[index].until)));
  const pickup = time => selectOceanSalePiles([donation], scene, ward, time, saleAuthorization(renewed, time));
  assert.deepEqual(pickup(eightMinutesLater), [item]);
  assert.deepEqual(pickup(donation.observed_at + 13 * minute), [item]);
  assert.deepEqual(pickup(donation.observed_at + 15 * minute), []);
});

test('claim lapses and competing covering claims end sale-pickup continuity', () => {
  const afterGap = Date.parse(originalClaims.claims[0].until) + 1;
  const restarted = renewOceanSaleClaims(originalClaims, afterGap);
  assert.equal(Date.parse(restarted.claims[0].at), afterGap);
  assert.deepEqual(selectOceanSalePiles([donation], scene, ward, afterGap, saleAuthorization(restarted, afterGap)), []);

  const time = donation.observed_at + 8 * minute;
  const conflict = { room: 552, item: item.name, for: ['Another farmer'] };
  const contended = { claims: [...originalClaims.claims, conflict] };
  assert.deepEqual(selectOceanSalePiles([donation], scene, ward, time, saleAuthorization(contended, time)), []);
  const renewed = renewOceanSaleClaims(contended, time);
  assert.ok(renewed.claims.includes(conflict));
  const cleared = { claims: renewed.claims.filter(claim => claim !== conflict) };
  assert.deepEqual(selectOceanSalePiles([donation], scene, ward, time + 1, saleAuthorization(cleared, time + 1)), []);
  assert.deepEqual(selectOceanSalePiles([donation], scene, ward, now, saleAuthorization(contended, now)), []);
});

test('sale grace rejects a stale ward, save change, or altered exact stack before pickup', () => {
  const time = donation.observed_at + 8 * minute;
  const livePin = liveWardPin(time);
  const select = (candidate = scene, pin = livePin, singer = ward) =>
    selectOceanSalePiles([donation], candidate, singer, time, saleAuthorization(originalClaims, time, pin));
  assert.deepEqual(select(), [item]);
  for (const pin of [null, { ...livePin, observed_at: time - 91_000 }, { ...livePin, expires_at: time + 1 },
    { ...livePin, last_save_at: epoch + 1 }, { ...livePin, room_security: 501 },
    { ...livePin, anchor: { ...livePin.anchor, id: 100 } }]) assert.deepEqual(select(scene, pin), []);
  assert.deepEqual(select({ ...scene, ids_stale: true }), []);
  assert.deepEqual(select({ ...scene, last_save_at: epoch + 1 }), []);
  assert.deepEqual(select({ ...scene, items: [] }), []);
  assert.deepEqual(select({ ...scene, items: [{ ...item, amount: 49 }] }), []);
  assert.deepEqual(select({ ...scene, items: [{ ...item, row: 43 }] }), []);
  assert.deepEqual(select(scene, livePin, { ...ward, you: { ...holder, col: 56 } }), []);
});

test('reads the current ward and Dibs files and rechecks after an exact claim is revoked', t => {
  const files = courierTestFiles(t, ['M59_DIBS_FILE', 'M59_FARM_SALE_CACHE_WARD_FILE']);
  const time = donation.observed_at + 8 * minute;
  const readAndSelect = () => selectOceanSalePiles([donation], scene, ward, time, readOceanSaleAuthorization('prod'));
  writeFileSync(files.M59_DIBS_FILE, JSON.stringify(originalClaims));
  writeFileSync(files.M59_FARM_SALE_CACHE_WARD_FILE, JSON.stringify(liveWardPin(time)));
  assert.deepEqual(readAndSelect(), [item]);
  writeFileSync(files.M59_DIBS_FILE, JSON.stringify({ claims: [{ room: 552, item: item.name, for: ['Other'] }] }));
  assert.deepEqual(readAndSelect(), []);
  writeFileSync(files.M59_DIBS_FILE, '{');
  assert.equal(readOceanSaleAuthorization('prod'), null);
  assert.deepEqual(selectOceanSalePiles([donation], scene, ward, now), []);
});

test('an interrupted 534 return stages only the exact receipted dedicated axe and retires its cargo', async t => {
  const files = courierTestFiles(t, ['M59_OCEAN_GEAR_CARGO_FILE', 'M59_FARM_GEAR_CACHE_FILE', 'M59_DIBS_FILE']);
  const server = { host: 'prod.example', port: 5900 };
  const axe = { id: 18782, name: 'axe', amount: 0, rarity: 0 };
  const other = { ...axe, id: 400 };
  const floorAxe = { ...axe, id: 19001, row: 44, col: 56, can: ['get'] };
  const home = { character: 'Zheng He', in_game: true, connected: true, ids_stale: false, room: { num: 552 },
    pid: 10, connection_revision: 1, last_save_at: epoch, ids_as_of: now, you: { object_id: 25, row: 44, col: 56 },
    hp: { value: 23, max: 23 }, vigor: { value: 120 }, karma: { value: 15 }, room_wire: ward.room_wire,
    combat: { personal_threat: { level: 'quiet' } }, autopilot_status: { mode: 'survive', faculties: { work: 'keeper' },
      policy: { neverAttack: true, townTrips: false, confineRooms: [552, 544, 534, 535, 200, 202, 201] } } };
  const cargo = { id: axe.id, name: axe.name, source: 'Raphael', receipt: { id: axe.id, name: axe.name,
    from: 'hk3', to: 'hk2', generation: epoch, started: now - 1000, confirmed: now, from_body: 31, to_body: 25 } };
  recordOceanGearCargo('prod', server, { ...home, room: { num: 202 } }, cargo);
  const stored = readOceanGearCargo('prod');
  const before = { ...home, items: [other, axe] };
  assert.deepEqual(selectOceanGearCargo(stored, server, home, before), [cargo]);
  assert.deepEqual(selectOceanGearCargo(stored, server, home, { ...before, items: [other] }), []);
  assert.deepEqual(selectOceanGearCargo(stored, server, home, { ...before, ids_stale: true }), []);
  assert.deepEqual(selectOceanGearCargo(stored, server, home, { ...before, last_save_at: epoch + 1 }), []);
  assert.deepEqual(selectOceanGearCargo(stored, server, { ...home, you: { object_id: 26 } }, before), []);
  assert.deepEqual(selectOceanGearCargo(stored, { ...server, port: 5901 }, home, before), []);
  assert.throws(() => recordOceanGearCargo('prod', server, home, { ...cargo, receipt: { ...cargo.receipt, id: other.id } }));

  let dropped = false;
  const mutations = [];
  const carried = () => ({ ...home, items: dropped ? [other] : [other, axe] });
  const rpc = async (tool, args) => {
    if (tool === 'status') return args.agent === 'hk2' ? carried()
      : { ...ward, next_save_expected_at: Date.now() + 60_000,
        autopilot_status: { faculties: { work: { owner: 'great-ocean:jala-singer' } } } };
    if (tool === 'inventory') return carried();
    if (tool === 'look') return { ...home, objects: dropped ? [floorAxe] : [] };
    if (tool === 'floor_cache') return { ok: true, room: 552, near: { row: 43, col: 57 }, items: dropped ? [floorAxe] : [] };
    if (tool === 'equipment') return { known: true, equipped: [{ id: other.id }] };
    if (tool === 'look_at') {
      assert.equal(args.target, axe.id);
      return { id: axe.id, description: "This weapon is in flawless condition. This weapon has been dedicated to Kraanan's glory." };
    }
    mutations.push([tool, args]);
    if (tool === 'autopilot') return { keeper_push: { confirmed: true } };
    if (tool === 'act' && args.verb === 'drop' && args.target === axe.id) { dropped = true; return { ok: true }; }
    assert.fail(`unexpected call ${tool}`);
  };
  const steps = oceanCourierReturnSteps({ ...before, room: { num: 534 } }, { fleet: 'prod', server });
  await steps.at(-1).fn({ call: rpc });
  assert.deepEqual(mutations.filter(([tool]) => tool === 'act'), [['act', { agent: 'hk2', verb: 'drop', target: axe.id }]]);
  assert.deepEqual(readOceanGearCargo('prod').items, []);
  assert.deepEqual(JSON.parse(readFileSync(files.M59_FARM_GEAR_CACHE_FILE, 'utf8')).items,
    [{ id: floorAxe.id, name: axe.name, row: 44, col: 56 }]);
  await steps.at(-1).fn({ call: rpc });
  assert.equal(mutations.filter(([tool]) => tool === 'act').length, 1);

  const leather = { id: 515, name: 'leather armor', amount: 0, rarity: 0 };
  const purchase = { id: leather.id, name: leather.name, source: 'Colhorr', receipt: { seller: 'Colhorr',
    room: 201, item: leather.name, amount: 1, shillings: 640, generation: epoch, ids: [leather.id], at: now } };
  recordOceanGearCargo('prod', server, { ...home, room: { num: 201 } }, purchase);
  const newPack = { ...before, items: [other, leather] };
  assert.deepEqual(selectOceanGearCargo(readOceanGearCargo('prod'), server, home, newPack), [purchase]);
  assert.deepEqual(selectOceanGearCargo(readOceanGearCargo('prod'), server, home,
    { ...newPack, items: [{ ...leather, id: 516 }] }), []);
});

test('interrupted bread delivery uses the carried surplus before buying and preserves four loaves', () => {
  const floor = 8, carried = 10;
  const { stage } = oceanBreadPlan(floor, carried);
  assert.equal(stage, 6);
  assert.deepEqual(oceanBreadPlan(floor + stage, carried - stage), { stage: 0, wanted: 6 });
  assert.deepEqual(oceanBreadPlan(18, 10), { stage: 2, wanted: 2 });
  assert.deepEqual(oceanBreadPlan(20, 1), { stage: 0, wanted: 3 });
  assert.deepEqual(oceanBreadPlan(10, 2), { stage: 0, wanted: 12 });
});

test('a purchase-only lap needs a useful affordable batch after the walking reserve', () => {
  const stocked = amount => ({ carry: { load: { exact: true }, room_for: { weight: 2_000, bulk: 2_000 } },
    items: [{ name: 'shilling', amount }] });
  assert.equal(oceanHasProvisionBatch(stocked(430), { herb: 95 }), false);
  assert.equal(oceanHasProvisionBatch(stocked(879), { herb: 95 }), false);
  assert.equal(oceanHasProvisionBatch(stocked(880), { herb: 95 }), true);
  assert.equal(oceanHasProvisionBatch(stocked(880), { herb: 23 }), false);
  assert.equal(oceanHasProvisionBatch(stocked(880), { 'loaf of bread': 4 }), true);
  assert.equal(oceanHasProvisionBatch(stocked(720), { elderberry: 8 }), true);
  assert.equal(oceanHasProvisionBatch(stocked(1_360), { axe: 1 }), true);
  assert.equal(oceanHasProvisionBatch({ ...stocked(1_360), carry: pack.carry }, { 'leather armor': 1 }), false);
});

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
  assert.deepEqual(selectUnexpired([donation, donation], floor, ward), [item]);
  assert.deepEqual(selectUnexpired([], floor, ward), []);
  assert.deepEqual(selectUnexpired([donation], { ...scene, items: [{ ...item, amount: 47 }] }, ward), []);
});

test('collects an exact same-save merge only when every prior unit has a receipt', () => {
  const base = { ...donation, observed_at: 91_000, expires_at: 95_000 };
  const combined = { ...item, amount: 74 };
  const merge = { ...donation, item: combined, previous_amount: 48, deposited_amount: 26 };
  const floor = { ...scene, items: [combined] };
  assert.deepEqual(selectUnexpired([merge, base], floor, ward), [combined]);
  assert.deepEqual(selectUnexpired([merge], floor, ward), []);
  assert.deepEqual(selectUnexpired([base, { ...merge, previous_amount: 47, deposited_amount: 27 }], floor, ward), []);
  const reconciled = { ...merge, kind: 'farm_sale_cache_reconciled', reconciliation: {
    kind: 'native-drop-merge', agent: 't2', floor_before_at: 92_000, pack_after_at: 93_000, floor_after_at: 94_000,
  } };
  assert.deepEqual(selectUnexpired([base, reconciled], floor, ward), [combined]);
  assert.deepEqual(selectUnexpired([base, { ...reconciled, reconciliation: { ...reconciled.reconciliation,
    floor_after_at: 89_000 } }], floor, ward), []);
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
  assert.deepEqual(selectUnexpired(bad, scene, ward), []);
  assert.deepEqual(selectUnexpired([donation], { ...scene, ids_stale: true }, ward), []);
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
