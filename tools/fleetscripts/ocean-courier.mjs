import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { verify, walk } from '../m59-fleetscript.mjs';
import { fleetName, resolveControlUrl, stateFileFor } from '../m59-fleetpath.mjs';
import { addStashClaim, dibsFile } from '../m59-dibs.mjs';
import { farmFoodCacheFile } from '../m59-farm-food-cache-record.mjs';
import { farmGearCacheFile } from '../m59-farm-gear-cache-record.mjs';
import { PICKUP_REACH, stashClaim } from '../m59-floor-cache.mjs';
import { isActiveRecoveryDecision } from '../m59-survival-decision.mjs';
import { OF } from '../m59-parse.mjs';
import { ITEM_RARITY } from '../m59-items.mjs';
import { classifyWeapon } from '../m59-weapon-magic.mjs';
import {
  OCEAN_BREAD, OCEAN_COURIER, OCEAN_GEAR_NAMES, OCEAN_SALE_PRICE, OCEAN_SHOPS, oceanBreadPlan, oceanBuyQuantity, oceanDistance,
  oceanHasProvisionBatch, oceanItemCount, oceanItemName, oceanProvisionRecord, oceanUnitsFit,
  readOceanGearCargo, readOceanSaleAuthorization, readOceanSaleDeposits, recordOceanGearCargo, retireOceanGearCargo,
  selectOceanGearCargo, selectOceanSalePiles, writeOceanCache,
} from '../m59-ocean-courier-cache.mjs';

const { agent, name, room, holder, holderName, ward, sale, reserve } = OCEAN_COURIER;
const TOAD = 202, SMITH = 201;
const medicAgent = 'hk1';
const deskAgent = 'hk3', deskName = 'Raphael son of Mephistopheles';
const AXE = 'axe';
const courierScriptName = 'ocean-courier';
const toTown = [552, 544, 534, 200, TOAD];
const fromTown = [200, 534, 544, 552];
const corridor = [552, 544, 534, 535, 200, TOAD, SMITH];
const saleNames = Object.keys(OCEAN_SALE_PRICE);
const count = oceanItemCount;
const purse = pack => count(pack, 'shilling');
export const oceanCanVisitSmith = (pack, wanted) => OCEAN_SHOPS.Colhorr.some(supply =>
  wanted[supply.name] > 0 && purse(pack) >= reserve + supply.price && oceanUnitsFit(pack, supply.name) > 0);
const matches = (item, itemName) => oceanItemName(item.name) === oceanItemName(itemName);
const report = (event, fields = {}) => console.log(JSON.stringify({
  at: new Date().toISOString(), courier: name, event, ...fields,
}));
const require = (condition, reason) => { if (!condition) throw Error(reason); };
const epoch = s => [s.pid, s.connection_revision, s.last_save_at, s.you?.object_id ?? s.you?.id];
const unchanged = (a, b) => epoch(a).every((value, index) => value === epoch(b)[index]);
const position = (a, b) => oceanDistance(a, b) === 0;
const exactHandle = (a, b) => a.id === b.id && a.name === b.name && position(a, b);

const read = (rpc, who) => rpc('status', { agent: who, brief: true }, 12000);
const inventory = (rpc, who = agent) => rpc('inventory', { agent: who, fresh: true }, 12000);
const visibility = (rpc, who) => rpc('look', { agent: who, cached: true, projection: 'render' }, 12000);

export async function oceanWardScan(rpc, who, what) {
  const before = await visibility(rpc, who);
  const result = await rpc('floor_cache', { action: 'scan', agent: who, near: holder, what, radius: 3 }, 9000);
  const after = await visibility(rpc, who);
  const current = observation => observation?.in_game && observation.connected && observation.ids_stale === false &&
    observation.room?.num === room && Number.isSafeInteger(observation.last_save_at) &&
    Number.isSafeInteger(observation.pid) && Number.isSafeInteger(observation.you?.object_id ?? observation.you?.id) &&
    Number.isSafeInteger(observation.room_wire?.room_security_u32);
  if (!result?.ok || result.ids_stale === true || result.room !== room || !Array.isArray(result.items) ||
      !current(before) || !current(after) || !unchanged(before, after) ||
      before.room_wire.room_security_u32 !== after.room_wire.room_security_u32)
    return { ok: false, ids_stale: true, why: 'the floor scan crossed an unverified Ocean room epoch' };
  const quantity = item => Number(item.amount) || 1;
  if (result.items.some(item => !after.objects?.some(object => object.id === item.id && matches(object, item.name) &&
      position(object, item) && quantity(object) === quantity(item) &&
      (object.can?.includes('get') || (object.flags & OF.GETTABLE)))))
    return { ok: false, ids_stale: true, why: 'the exact floor object changed after the Ocean scan' };
  return { ...result, ids_stale: false, last_save_at: after.last_save_at };
}

const scan = (rpc, what) => oceanWardScan(rpc, agent, what);

export async function oceanCourierIdentity(fleet) {
  const url = resolveControlUrl().url;
  require(url, 'a production broker URL is required');
  const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(7000) });
  require(response.ok, 'broker identity unavailable');
  const health = await response.json();
  const roster = stateFileFor(fleet);
  const actual = String(health.state ?? '').replaceAll('\\', '/').toLowerCase();
  require(health.fleet === fleet && actual === roster.replaceAll('\\', '/').toLowerCase() &&
    health.game_server?.host && Number(health.game_server.port) > 0, 'broker holds a different fleet');
  return health.game_server;
}

export function oceanWardReady(s) {
  return s?.in_game && s.you && s.ids_stale === false && s.room?.num === room && s.character === holderName &&
    position(s.you, ward) && s.autopilot_status?.faculties?.work?.owner === 'great-ocean:jala-singer' &&
    s.next_save_expected_at - Date.now() > 30_000;
}

export function oceanCourierReady(s, expected, minVigor = 0) {
  const p = s?.autopilot_status;
  const threat = s?.combat?.personal_threat;
  return s?.character === name && s.in_game && s.connected && s.ids_stale === false &&
    s.room?.num === expected && epoch(s).every(Number.isSafeInteger) &&
    s.hp?.max > 0 && s.hp.value === s.hp.max && s.vigor?.value >= minVigor && s.karma?.value > 0 &&
    p?.mode === 'survive' && p.policy?.neverAttack === true && p.policy?.townTrips === false &&
    !s.ridealong?.piloted && !s.hold?.active && !s.cooperative_wait && !s.combat?.active &&
    !s.movement?.order && !p.recovery_travel && !p.suspended_journey &&
    !p.recovering_from_death && !isActiveRecoveryDecision(p.survival_decisions?.current) &&
    threat?.level === 'quiet' && (!threat.last_personal_at || Date.now() - threat.last_personal_at >= 15000);
}

async function waitForBody(rpc, expected, minVigor = 0) {
  const deadline = Date.now() + 155_000;
  do {
    const s = await read(rpc, agent);
    if (oceanCourierReady(s, expected, minVigor)) return s;
    await sleep(2600);
  } while (Date.now() < deadline);
  throw Error(`Zheng did not settle safely in ${expected}`);
}

export function oceanCourierReturnSteps(s, { fleet, server } = {}) {
  const origin = s?.room?.num;
  if (!corridor.includes(origin) || !oceanCourierReady(s, origin, 95) ||
      s.autopilot_status.faculties?.work !== 'keeper' ||
      s.autopilot_status.policy.confineRooms?.join(',') !== corridor.join(',')) return null;
  const resumeFrom = origin === 535 ? 534 : origin;
  const remaining = fromTown.includes(resumeFrom) ? fromTown.slice(fromTown.indexOf(resumeFrom) + 1) : fromTown;
  const steps = [];
  for (const to of remaining) {
    steps.push(walk(to, { minHealth: 1, why: 'resume the verified courier return corridor' }),
      verify(async ({ call: rpc }) => { await waitForBody(rpc, to); return true; }, `verify recovered courier in room ${to}`));
  }
  steps.push(verify(async ({ call: rpc }) => {
    const home = await waitForBody(rpc, room);
    await setCorridor(rpc, [room]);
    report('interrupted lap returned');
    if (fleet && server && selectOceanGearCargo(readOceanGearCargo(fleet), server, home, home).length)
      await stageSupplies(rpc, { server, purchased: {} }, fleet, { carriedOnly: true });
    return true;
  }, 'restore Ocean confinement after an interrupted lap'));
  return steps;
}

async function setCorridor(rpc, rooms) {
  const result = await rpc('autopilot', { agent, action: 'start', confine_rooms: rooms,
    why: 'Verified Ocean courier corridor' }, 12000);
  require(result.keeper_push?.confirmed === true, 'courier confinement did not reach keeper');
}

export async function moveToWard(rpc, { pickup = false } = {}) {
  const s = await waitForBody(rpc, room);
  const inReach = body => pickup ? oceanDistance(body.you, sale) <= PICKUP_REACH
    : oceanDistance(body.you, ward) <= 3;
  if (inReach(s)) return s;
  // Three squares of fine tolerance still leaves a margin inside the native
  // seven-square Manhattan pickup range. The live tile is checked below.
  const motion = await rpc('walk_to', { agent, ...sale, fine: true, exact_arrival: true,
    arrive_within: pickup ? 3 * 64 : 12 }, 80000);
  if (motion.arrived !== true) {
    if (motion.reason === 'object_blocked' && motion.cancelled !== true) {
      const after = await read(rpc, agent);
      if (oceanCourierReady(after, room) && unchanged(s, after) && inReach(after)) return after;
    }
    throw Error(motion.reason ?? 'courier could not reach the ward');
  }
  const until = Date.now() + 10000;
  do {
    const after = await read(rpc, agent);
    if (oceanCourierReady(after, room) && unchanged(s, after) && inReach(after)) return after;
    await sleep(500);
  } while (Date.now() < until);
  throw Error('courier did not settle on the delivery square');
}

async function merchant(rpc, seller, expected) {
  const s = await visibility(rpc, agent);
  const rows = s.objects?.filter(item => matches(item, seller) && !item.is_player &&
    !(item.flags & OF.PLAYER) && (item.can?.includes('buy') || (item.flags & OF.BUYABLE)));
  require(s.room?.num === expected && rows?.length === 1 && Number.isSafeInteger(rows[0].id),
    `exact ${seller} counter not visible`);
  return rows[0].id;
}

export async function collectSale(rpc, fleet, plan) {
  const [singer, floor] = await Promise.all([read(rpc, holder), oceanWardScan(rpc, medicAgent, saleNames)]);
  require(oceanWardReady(singer), 'the cache holder moved or is nearing a save');
  if (!floor.ok || !floor.items.length) return;
  const receipts = readOceanSaleDeposits(fleet);
  const approved = (scene, ward) => selectOceanSalePiles(receipts, scene, ward, Date.now(), readOceanSaleAuthorization(fleet));
  const piles = approved(floor, singer);
  if (!piles.length) return;
  const snapshot = await moveToWard(rpc, { pickup: true });
  for (const item of piles) {
    const [body, before, scene, currentSinger] = await Promise.all([
      read(rpc, agent), inventory(rpc), scan(rpc, item.name), read(rpc, holder),
    ]);
    require(oceanCourierReady(body, room) && unchanged(snapshot, body) && position(body.you, snapshot.you) &&
      oceanDistance(body.you, item) <= PICKUP_REACH,
      'courier state changed while staging sale');
    if (!oceanWardReady(currentSinger) || before.ids_stale !== false || before.last_save_at !== snapshot.last_save_at ||
        scene.last_save_at !== snapshot.last_save_at || oceanUnitsFit(before, item.name) < item.amount ||
        !approved(scene, currentSinger).some(pile => exactHandle(pile, item) && pile.amount === item.amount)) continue;
    await rpc('act', { agent, verb: 'get', target: item.id }, 10000);
    const after = await inventory(rpc);
    const amount = count(after, item.name) - count(before, item.name);
    require(after.last_save_at === before.last_save_at && amount === item.amount,
      `unconfirmed exact pickup of ${item.name} #${item.id}; inspect before selling`);
    plan.sales.set(item.name, (plan.sales.get(item.name) ?? 0) + amount);
    report('sale parcel collected', { item });
  }
}

async function sellParcels(rpc, keeper, plan) {
  const body = await waitForBody(rpc, TOAD, 95);
  const seller = await merchant(rpc, 'Morrigan', TOAD);
  for (const [itemName, amount] of plan.sales) {
    const before = await inventory(rpc);
    const stack = before.items.find(item => matches(item, itemName) && item.amount >= amount);
    require(stack, `sale parcel of ${itemName} missing from Zheng's pack`);
    const args = { merchant: seller, item: { id: stack.id, amount } };
    const quote = await keeper('sell_one', { ...args, confirm: false }, 20000);
    const price = OCEAN_SALE_PRICE[itemName] * amount;
    require(quote?.sold === false && Number(quote.offered_price) === price, `unexpected ${itemName} quote`);
    const [sameBody, samePack] = await Promise.all([read(rpc, agent), inventory(rpc)]);
    require(oceanCourierReady(sameBody, TOAD) && unchanged(body, sameBody) &&
      before.last_save_at === samePack.last_save_at && purse(before) === purse(samePack) &&
      samePack.items.some(item => item.id === stack.id && matches(item, itemName) && item.amount === stack.amount),
    `pack changed during ${itemName} quote`);
    const sale = await keeper('sell_one', { ...args, confirm: true, expected_price: price }, 20000);
    require(sale?.sold === true, sale?.note ?? `keeper refused ${itemName} sale`);
    const after = await inventory(rpc);
    require(after.last_save_at === before.last_save_at && count(before, itemName) - count(after, itemName) === amount &&
      purse(after) - purse(before) === price, `ambiguous ${itemName} sale; inspect pack before any repeat`);
    report('sale receipt', { item: itemName, amount, shillings: price });
  }
}

async function buySupplies(rpc, plan, seller, expected, fleet) {
  const wanted = OCEAN_SHOPS[seller].filter(supply => plan.wanted[supply.name] > 0);
  if (!wanted.length) return;
  await waitForBody(rpc, expected, 95);
  const merchantId = await merchant(rpc, seller, expected);
  for (const supply of wanted) {
    const menu = await rpc('shop', { agent, seller: merchantId }, 20000);
    const listing = menu.items?.find(item => matches(item, supply.name));
    const before = await inventory(rpc);
    const amount = oceanBuyQuantity(before, listing, supply, plan.wanted[supply.name]);
    if (!amount) { report('purchase deferred', { item: supply.name }); continue; }
    const body = await read(rpc, agent);
    require(oceanCourierReady(body, expected) && body.last_save_at === before.last_save_at,
      `courier changed before buying ${supply.name}`);
    await rpc('shop', { agent, seller: merchantId, buy_ids: [{ id: listing.id, amount }] }, 45000);
    const after = await inventory(rpc);
    const cost = Number(listing.cost ?? listing.price) * amount;
    require(after.ids_stale === false && before.ids_stale === false && after.last_save_at === before.last_save_at && purse(before) - purse(after) === cost &&
      count(after, supply.name) - count(before, supply.name) === amount && purse(after) >= reserve,
    `ambiguous ${supply.name} purchase; inspect pack before any repeat`);
    plan.purchased[supply.name] = amount;
    const ids = after.items.filter(item => matches(item, supply.name) &&
      !before.items.some(prior => prior.id === item.id)).map(item => item.id);
    const purchase = { seller, merchant: merchantId, room: expected, item: supply.name, amount,
      shillings: cost, generation: after.last_save_at, ids, at: Date.now() };
    plan.purchaseReceipts[supply.name] = purchase;
    report('purchase receipt', purchase);
    if (OCEAN_GEAR_NAMES.includes(supply.name)) {
      recordOceanGearCargo(fleet, plan.server, body, { id: ids[0], name: supply.name, source: seller, receipt: purchase });
    }
  }
}

function deskFiles(fleet) {
  const dir = join(dirname(dirname(stateFileFor(fleet))), 'scratch');
  return { state: join(dir, 'great-ocean-state.json'), conf: join(dir, 'great-ocean.json') };
}

function readDeskState(fleet) {
  try {
    const files = deskFiles(fleet);
    const state = JSON.parse(readFileSync(files.state, 'utf8'));
    const conf = JSON.parse(readFileSync(files.conf, 'utf8'));
    if (!Array.isArray(state.deskCustody) || !conf || typeof conf !== 'object' || Array.isArray(conf) ||
        (conf.deskSpareIntake !== undefined && !Array.isArray(conf.deskSpareIntake))) return null;
    return { files, state, conf };
  } catch { return null; }
}

const quietDesk = ({ state }) => !state.deskCustody.length && !Object.keys(state.deskArmRestore ?? {}).length &&
  !Object.keys(state.deskDropRestore ?? {}).length;
const knownAxe = item => item?.name === AXE && Number.isSafeInteger(item.id) && item.id > 0 &&
  Number.isInteger(item.rarity) && item.rarity >= ITEM_RARITY.NORMAL && item.rarity < ITEM_RARITY.UNIDENTIFIED;
const soundAxe = reading => reading?.made === false && !reading.broken &&
  ['flawless', 'excellent', 'good'].includes(reading.condition);
const intakeMatches = (entry, generation) => entry?.generation === generation && entry.from === agent &&
  Number.isSafeInteger(entry.id) && entry.id > 0 && typeof entry.purchaseReceipt === 'string' &&
  !!entry.purchaseReceipt.trim() && typeof entry.handoffReceipt === 'string' && !!entry.handoffReceipt.trim();

export function oceanDeskSpareCandidate(desk, raphael) {
  if (!desk || !quietDesk(desk) || !Array.isArray(desk.state.deskSpare)) return null;
  return desk.state.deskSpare.find(receipt => intakeMatches(receipt, raphael.last_save_at) &&
    receipt.owner === deskAgent && receipt.room === TOAD && receipt.name === AXE &&
    Number.isFinite(receipt.verified_at) && receipt.verified_at >= receipt.generation &&
    desk.conf.deskSpareIntake?.some(intake => intakeMatches(intake, receipt.generation) && intake.id === receipt.id &&
      intake.purchaseReceipt === receipt.purchaseReceipt && intake.handoffReceipt === receipt.handoffReceipt) &&
    raphael.items?.some(item => item.id === receipt.id && knownAxe(item))) ?? null;
}

export function oceanDeskReady(s) {
  const p = s?.autopilot_status, threat = s?.combat?.personal_threat;
  return s?.character === deskName && s.in_game && s.connected && s.combat_ready && s.ids_stale === false &&
    s.room?.num === TOAD && epoch(s).every(Number.isSafeInteger) && s.hp?.max > 0 && s.hp.value === s.hp.max &&
    p?.mode === 'survive' && p.policy?.assignedRoom === TOAD && p.policy.townTrips === false &&
    ['work', 'movement', 'economy'].every(faculty => p.faculties?.[faculty] === 'keeper') &&
    !s.human_held && !s.ridealong?.piloted && !s.ridealong?.human_held && !s.hold?.active && !s.cooperative_wait &&
    !s.job?.busy && !p.committed && !s.combat?.active && !s.movement?.order && !p.movement?.order && !p.cast_rite?.active &&
    !p.cooperative_logoff?.phase && !p.recovery_travel && !p.suspended_journey && !p.recovering_from_death &&
    !isActiveRecoveryDecision(p.survival_decisions?.current) && threat?.level === 'quiet' &&
    (!threat.last_personal_at || Date.now() - threat.last_personal_at >= 15000) && s.next_save_expected_at - Date.now() > 45_000;
}

export async function oceanReadyDeskSpare(rpc, fleet, generation) {
  const desk = readDeskState(fleet);
  if (!desk || !quietDesk(desk) || !Array.isArray(desk.state.deskSpare) ||
      !desk.state.deskSpare.some(receipt => intakeMatches(receipt, generation))) return null;
  const raphael = await read(rpc, deskAgent).catch(() => null);
  return oceanDeskReady(raphael) && raphael.last_save_at === generation
    ? oceanDeskSpareCandidate(desk, raphael) : null;
}

function pendingIntake(desk, raphael) {
  return desk.conf.deskSpareIntake?.some(entry => intakeMatches(entry, raphael.last_save_at) &&
    raphael.items?.some(item => item.id === entry.id && knownAxe(item)));
}

async function moveDeskAxe(rpc, fleet, id, generation, collecting) {
  const from = collecting ? deskAgent : agent, to = collecting ? agent : deskAgent;
  const [giver, receiver, worn] = await Promise.all([
    inventory(rpc, from), inventory(rpc, to), rpc('equipment', { agent: from, refresh: false }, 10000),
  ]);
  if ([giver, receiver].some(pack => pack?.ids_stale !== false || pack.last_save_at !== generation ||
      !Number.isSafeInteger(pack.ids_as_of) || pack.ids_as_of < generation || !Array.isArray(pack.items)) ||
      !giver.items.some(item => item.id === id && knownAxe(item)) || receiver.items.some(item => item.id === id) ||
      worn?.known !== true || !Array.isArray(worn.equipped) || worn.equipped.some(item => item.id === id) ||
      oceanUnitsFit(receiver, AXE) < 1) return null;
  const look = await rpc('look_at', { agent: from, target: id }, 10000);
  const reading = Number(look?.id) === id && typeof look.description === 'string'
    ? classifyWeapon({ name: AXE, look: look.description }) : null;
  if (!soundAxe(reading) || reading.class !== (collecting ? 'enchanted' : 'mundane')) return null;
  const [courier, raphael] = await Promise.all([read(rpc, agent), read(rpc, deskAgent)]);
  const desk = readDeskState(fleet);
  const courierCommitment = courier?.autopilot_status?.committed;
  const ownLap = courierCommitment?.kind === 'bot' && courierCommitment.held_by?.by === `fleetscript:${courierScriptName}`;
  if (!desk || !quietDesk(desk) || !oceanCourierReady(courier, TOAD, 95) || !oceanDeskReady(raphael) ||
      courier.human_held || courier.ridealong?.human_held || courier.job?.busy ||
      courier.autopilot_status?.cast_rite?.active || (courierCommitment && !ownLap) ||
      courier.last_save_at !== generation || raphael.last_save_at !== generation ||
      courier.next_save_expected_at - Date.now() <= 45_000 ||
      !(collecting ? oceanDeskSpareCandidate(desk, raphael)?.id === id : !pendingIntake(desk, raphael)) ||
      !(collecting ? raphael : courier).items?.some(item => item.id === id && knownAxe(item))) return null;
  const started = Date.now();
  const receipt = await rpc('supply', { from, to, stationary: true, who_travels: 'neither', no_dropoff: true,
    ids_as_of: giver.ids_as_of, what: [{ id, name: AXE, amount: 1 }] }, 35000).catch(error => ({ error: error.message }));
  const [giverAfter, receiverAfter, courierAfter, raphaelAfter] = await Promise.all([
    inventory(rpc, from), inventory(rpc, to), read(rpc, agent), read(rpc, deskAgent),
  ]);
  const same = [giverAfter, receiverAfter].every(pack => pack.ids_stale === false && pack.last_save_at === generation) &&
    [courierAfter, raphaelAfter].every(s => s.room?.num === TOAD && s.in_game && s.connected && s.ids_stale === false) &&
    unchanged(courier, courierAfter) && position(courier.you, courierAfter.you) &&
    unchanged(raphael, raphaelAfter) && position(raphael.you, raphaelAfter.you);
  const stillHeld = giverAfter.items?.some(item => item.id === id && knownAxe(item));
  const gained = receiverAfter.items?.some(item => item.id === id && knownAxe(item));
  if (same && stillHeld && !gained && receipt?.supplied !== true) return null;
  require(same && receipt?.supplied === true && !receipt.ids_reresolved?.length && !stillHeld && gained &&
    receipt.amounts?.some(line => matches(line, AXE) && line.asked === 1 && line.giver_lost === 1 && line.received === 1),
  `ambiguous exact desk transfer #${id}; inspect both packs before repeating`);
  return { carrier: courierAfter, receipt: { id, name: AXE, from, to, generation, started, confirmed: Date.now(),
    from_body: (collecting ? raphael : courier).you.object_id ?? (collecting ? raphael : courier).you.id,
    to_body: (collecting ? courier : raphael).you.object_id ?? (collecting ? courier : raphael).you.id } };
}

async function collectDeskSpare(rpc, fleet, plan) {
  const desk = readDeskState(fleet);
  if (!desk || !quietDesk(desk) || !plan.wanted[AXE]) return;
  const raphael = await read(rpc, deskAgent).catch(() => null);
  if (!oceanDeskReady(raphael)) return;
  const spare = oceanDeskSpareCandidate(desk, raphael);
  if (!spare) return;
  const movement = await moveDeskAxe(rpc, fleet, spare.id, spare.generation, true);
  if (!movement) return;
  const { carrier, receipt } = movement;
  recordOceanGearCargo(fleet, plan.server, carrier, { id: spare.id, name: AXE, source: 'Raphael', receipt });
  plan.purchased[AXE] = 1;
  plan.wanted[AXE] = 0;
  report('dedicated axe collected', receipt);
}

async function handoffNewAxe(rpc, fleet, plan) {
  const purchase = plan.purchaseReceipts[AXE], id = purchase?.ids[0];
  const movement = await moveDeskAxe(rpc, fleet, id, purchase.generation, false);
  if (!movement) return;
  const { carrier, receipt: handoff } = movement;
  plan.purchased[AXE] = 0;
  const desk = readDeskState(fleet);
  require(desk, `exact axe #${id} reached Raphael but intake config needs reconciliation`);
  const intake = { id, generation: purchase.generation, from: agent,
    purchaseReceipt: JSON.stringify(purchase), handoffReceipt: JSON.stringify(handoff) };
  const prior = desk.conf.deskSpareIntake ?? [];
  require(!prior.some(entry => entry.id === id && entry.generation === purchase.generation),
    `exact axe #${id} reached Raphael but the intake already exists`);
  writeOceanCache(desk.files.conf, { ...desk.conf, deskSpareIntake: [...prior, intake] });
  retireOceanGearCargo(fleet, plan.server, carrier, [id]);
  report('desk intake receipt', { purchase, handoff });
}

async function gearToStage(rpc, candidates) {
  if (!candidates.length) return [];
  const equipped = await rpc('equipment', { agent, refresh: false }, 10000).catch(() => null);
  if (equipped?.known !== true || !Array.isArray(equipped.equipped)) return [];
  const unworn = candidates.filter(item => !equipped.equipped.some(worn => worn.id === item.id));
  const cargo = [];
  for (const item of unworn) {
    if (cargo.some(ready => ready.name === item.name)) continue;
    if (item.source === 'Raphael') {
      const look = await rpc('look_at', { agent, target: item.id }, 10000).catch(() => null);
      const reading = Number(look?.id) === item.id && typeof look.description === 'string'
        ? classifyWeapon({ name: AXE, look: look.description }) : null;
      if (!soundAxe(reading) || reading.class !== 'enchanted') continue;
    }
    cargo.push({ name: item.name, id: item.id, amount: 1, gear: true });
  }
  return cargo;
}

async function stageSupplies(rpc, plan, fleet, { carriedOnly = false } = {}) {
  const bread = OCEAN_BREAD.name;
  const names = [...OCEAN_GEAR_NAMES, bread, 'elderberry'];
  if (!carriedOnly && !names.some(item => plan.purchased[item])) return;
  const cargoRecord = readOceanGearCargo(fleet);
  const body = await moveToWard(rpc);
  const delivery = body.you;
  const [singer, current, carried] = await Promise.all([read(rpc, holder), scan(rpc, names), inventory(rpc)]);
  require(oceanWardReady(singer) && current.ok && current.ids_stale === false && carried.ids_stale === false &&
    [singer, current, carried].every(snapshot => snapshot.last_save_at === body.last_save_at),
  'cache did not have one current save epoch before delivery');
  const food = current.items.filter(item => item.name === bread);
  const breadSurplus = oceanBreadPlan(count({ items: food }, bread), count(carried, bread)).stage;
  const breadToStage = carriedOnly ? breadSurplus : Math.min(breadSurplus, plan.purchased[bread] ?? 0);
  const cargo = await gearToStage(rpc, selectOceanGearCargo(cargoRecord, plan.server, body, carried));
  const carriedBread = carried.items.filter(item => matches(item, bread));
  let pack = carried, recovered = 0;
  if (breadToStage && food.length === 1 && carriedBread.length === 1 &&
      oceanUnitsFit(pack, bread) >= food[0].amount) {
    const file = farmFoodCacheFile(fleet);
    let registered;
    try { registered = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (registered?.schema === 'm59-farm-food-cache/1' && registered.item && registered.room === room &&
        registered.server?.host === plan.server.host && registered.server.port === Number(plan.server.port) &&
        registered.room_security === singer.room_wire?.room_security_u32 &&
        registered.observed_at > singer.last_save_at && registered.holder?.id === (singer.you.object_id ?? singer.you.id) &&
        exactHandle(registered.item, food[0])) {
      await rpc('act', { agent, verb: 'get', target: food[0].id }, 10000);
      pack = await inventory(rpc);
      recovered = count(pack, bread) - count(carried, bread);
      require(pack.ids_stale === false && pack.last_save_at === carried.last_save_at && recovered === food[0].amount,
        'ambiguous food top-up pickup; inspect the pack and pile');
    }
  }
  const provisions = [bread, 'elderberry'].filter(item => item === bread ? breadToStage && (!food.length || recovered)
    : !carriedOnly && plan.purchased[item])
    .map(item => {
      const items = pack.items.filter(row => matches(row, item));
      const stock = item === bread ? items.sort((a, b) => b.amount - a.amount)[0] : items[0];
      const amount = item === bread ? Math.min(stock?.amount ?? 0, count(pack, item) - OCEAN_BREAD.reserve, breadToStage + recovered)
        : Math.min(count(pack, item), plan.purchased[item]);
      return { name: item, id: stock?.id, amount, gear: false };
    }).filter(item => item.id && item.amount > 0);
  const payload = [...cargo, ...provisions];
  require(!recovered || payload.some(item => item.name === bread && item.amount >= recovered),
    'exact recovered food pile could not be staged as one stack');
  if (!payload.length) return { singer, stock: current, pack };
  for (const item of payload) {
    const latest = await read(rpc, agent);
    require(oceanCourierReady(latest, room) && unchanged(body, latest) && position(latest.you, delivery) &&
      latest.items?.some(row => row.id === item.id && matches(row, item.name) &&
        (item.name !== bread || row.amount >= item.amount && count(latest, bread) - item.amount >= OCEAN_BREAD.reserve)),
    'courier moved or exact ward cargo changed before drop');
    addStashClaim(dibsFile(fleet), stashClaim({ room, item: item.name, holder: holderName, near: ward,
      radius: 3, why: 'Provision procured by Zheng He for the Ocean fleet' }));
    await rpc('act', { agent, verb: 'drop', target: item.id, ...(item.gear ? {} : { amount: item.amount }) }, 10000);
  }
  const [after, refreshed, anchor] = await Promise.all([inventory(rpc), scan(rpc, names), read(rpc, holder)]);
  require(oceanWardReady(anchor) && refreshed.ok && refreshed.ids_stale === false && after.ids_stale === false &&
    [anchor, refreshed, after].every(snapshot => snapshot.last_save_at === body.last_save_at),
  'ambiguous ward drop epoch; inspect pack and floor before any repeat');
  const newPiles = refreshed.items.filter(item => position(item, delivery) && !current.items.some(old => old.id === item.id));
  const verifiedGear = cargo.flatMap(dropped => {
    const appeared = newPiles.filter(item => matches(item, dropped.name));
    return appeared.length === 1 && !after.items.some(item => item.id === dropped.id) &&
      count(pack, dropped.name) - count(after, dropped.name) === 1 ? [{ carried: dropped.id, floor: appeared[0] }] : [];
  });
  if (verifiedGear.length) {
    const file = farmGearCacheFile(fleet);
    let prior;
    try { prior = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const stillHere = prior?.last_save_at === anchor.last_save_at && prior.expires_at > Date.now()
      ? refreshed.items.filter(item => prior.items?.some(old => exactHandle(item, old))) : [];
    const gear = [...stillHere, ...verifiedGear.map(item => item.floor)];
    writeOceanCache(file, oceanProvisionRecord({ host: plan.server, ward: anchor, items: gear, kind: 'gear' }));
    retireOceanGearCargo(fleet, plan.server, body, verifiedGear.map(item => item.carried));
  }
  require(verifiedGear.length === cargo.length && provisions.every(item => count(pack, item.name) - count(after, item.name) === item.amount),
    'ambiguous ward drop; inspect pack and floor before any repeat');
  const foodDrop = provisions.find(item => item.name === bread);
  if (foodDrop) {
    const newFood = refreshed.items.filter(item => item.name === bread);
    require(newFood.length === 1 && position(newFood[0], delivery) && newFood[0].amount === foodDrop.amount,
      'exact staged food pile could not be confirmed');
    writeOceanCache(farmFoodCacheFile(fleet), oceanProvisionRecord({ host: plan.server, ward: anchor, items: newFood, kind: 'food' }));
  }
  report('ward delivery', { placed: newPiles, requested: payload });
  return { singer: anchor, stock: refreshed, pack: after };
}

function verifiedGearStock(floor, singer, fleet) {
  let record;
  try { record = JSON.parse(readFileSync(farmGearCacheFile(fleet), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (record?.schema !== 'm59-farm-gear-cache/1' || record.last_save_at !== singer.last_save_at ||
      record.expires_at <= Date.now() || record.room_security !== singer.room_wire?.room_security_u32 ||
      record.holder?.id !== (singer.you.object_id ?? singer.you.id)) return [];
  return floor.items.filter(item => record.items?.some(pile => exactHandle(item, pile)));
}

export const script = {
  name: courierScriptName,
  describe: 'Zheng He alone takes verified surplus from Statler’s Ocean ward to Marion and returns with provisions.',
  unsafe: { waives: ['fragileBody'], reason: 'The assigned positive-karma courier walks only the verified Marion corridor.' },
  controls: [agent, deskAgent],
  params: { agents: { type: 'agents', required: true } },
  async steps(params) {
    const fleet = fleetName();
    require(params.agent === agent && fleet === 'prod', 'the Ocean courier is Zheng He on prod');
    const plan = { wanted: {}, sales: new Map(), purchased: {}, purchaseReceipts: {}, problem: null };
    const bounded = async (label, task) => {
      if (plan.problem) return true;
      try { await task(); }
      catch (error) { plan.problem = error.message; report(label + ' stopped', { reason: plan.problem }); }
      return true;
    };
    const steps = [verify(async ({ call: rpc }) => {
      plan.server = await oceanCourierIdentity(fleet);
      let [body, healer, singer, stock, pack] = await Promise.all([
        read(rpc, agent), read(rpc, medicAgent), read(rpc, holder),
        scan(rpc, ['axe', 'leather armor', 'loaf of bread', 'elderberry']), inventory(rpc),
      ]);
      require(oceanCourierReady(body, room, 140) && oceanWardReady(singer) && healer.in_game && stock.ok &&
        stock.ids_stale === false && pack.ids_stale === false &&
        [stock, singer, pack].every(snapshot => snapshot.last_save_at === body.last_save_at) &&
        body.autopilot_status.policy.confineRooms?.join(',') === String(room), 'courier, healer, or ward is unavailable');
      const floorCount = item => count({ items: stock.items }, item);
      const bread = OCEAN_BREAD.name;
      const heldGear = () => selectOceanGearCargo(readOceanGearCargo(fleet), plan.server, body, pack);
      if (oceanBreadPlan(floorCount(bread), count(pack, bread)).stage > 0 || heldGear().length) {
        ({ singer, stock, pack } = await stageSupplies(rpc, plan, fleet, { carriedOnly: true }));
      }
      const gearStock = verifiedGearStock(stock, singer, fleet);
      const stockedGear = [...gearStock, ...heldGear()];
      const herbsOnHand = count(healer, 'herb') + Math.max(0, count(pack, 'herb') - 5);
      plan.wanted = {
        herb: herbsOnHand < 90 ? 180 - herbsOnHand : 0,
        elderberry: Math.max(0, 32 - count(singer, 'elderberry') - floorCount('elderberry') - count(pack, 'elderberry')),
        [bread]: oceanBreadPlan(floorCount(bread), count(pack, bread)).wanted,
        axe: stockedGear.some(item => item.name === 'axe') ? 0 : 1,
        'leather armor': stockedGear.some(item => item.name === 'leather armor') ? 0 : 1,
      };
      await collectSale(rpc, fleet, plan);
      const spare = plan.wanted[AXE] > 0 && await oceanReadyDeskSpare(rpc, fleet, pack.last_save_at);
      plan.go = plan.sales.size > 0 || !!spare || oceanHasProvisionBatch(pack, plan.wanted);
      if (plan.go) await setCorridor(rpc, corridor);
      report('lap plan', { departing: plan.go, wanted: plan.wanted, sales: Object.fromEntries(plan.sales) });
      return true;
    }, 'verify Zheng and collect only ledger-bound surplus at the ward')];
    const leg = (to, gate = () => plan.go, stay = room) =>
      walk(() => gate() ? to : stay, { candidates: [...new Set([to, stay])], minHealth: 1,
        why: 'one verified leg of the Ocean courier corridor' });
    const settled = (to, gate = () => plan.go) => verify(async ({ call: rpc }) => {
      if (gate()) await waitForBody(rpc, to);
      return true;
    }, `verify the quiet courier in room ${to}`);
    for (const to of toTown.slice(1)) steps.push(leg(to), settled(to));
    steps.push(verify(async ({ call: rpc, keeper }) => !plan.go || bounded('Toad commerce', async () => {
      await sellParcels(rpc, keeper, plan);
      await buySupplies(rpc, plan, 'Morrigan', TOAD, fleet);
      await buySupplies(rpc, plan, 'Tova', TOAD, fleet);
      await collectDeskSpare(rpc, fleet, plan);
      const stock = await inventory(rpc);
      plan.gear = stock.ids_stale === false && oceanCanVisitSmith(stock, plan.wanted);
    }), 'sell the ward parcels and stock herbs, elderberries, and food'));
    const gearStop = () => plan.gear && !plan.problem;
    const nearSmith = () => plan.go ? 200 : room;
    const smithLeg = (to, gate) => walk(() => gate() ? to : nearSmith(),
      { candidates: [...new Set([to, 200, room])], minHealth: 1, why: 'one verified leg of the Ocean courier corridor' });
    steps.push(leg(200), settled(200), smithLeg(SMITH, gearStop), settled(SMITH, gearStop));
    steps.push(verify(async ({ call: rpc }) => {
      if (!gearStop()) return true;
      plan.atSmith = true;
      return bounded('smith commerce', () => buySupplies(rpc, plan, 'Colhorr', SMITH, fleet));
    }, 'stock sound replacement leather and axes'));
    const wentToSmith = () => plan.atSmith === true;
    steps.push(smithLeg(200, wentToSmith), settled(200, wentToSmith));
    steps.push(verify(async ({ call: rpc }) => {
      const purchase = plan.purchaseReceipts[AXE];
      if (plan.problem || purchase?.seller !== 'Colhorr' || purchase.room !== SMITH || purchase.amount !== 1 ||
          purchase.ids.length !== 1 || !Number.isSafeInteger(purchase.ids[0])) return true;
      const raphael = await read(rpc, deskAgent).catch(() => null), desk = readDeskState(fleet);
      plan.returnToDesk = !!desk && quietDesk(desk) && oceanDeskReady(raphael) &&
        raphael.last_save_at === purchase.generation && !pendingIntake(desk, raphael);
      return true;
    }, 'check whether Raphael can accept the exact new Colhorr axe'));
    const returnToDesk = () => plan.returnToDesk === true;
    steps.push(smithLeg(TOAD, returnToDesk), settled(TOAD, returnToDesk));
    steps.push(verify(async ({ call: rpc }) => !returnToDesk() || bounded('desk intake',
      () => handoffNewAxe(rpc, fleet, plan)), 'hand one verified unworn new axe to Raphael without moving him'));
    steps.push(smithLeg(200, returnToDesk), settled(200, returnToDesk));
    for (const to of fromTown.slice(1)) steps.push(leg(to), settled(to));
    steps.push(verify(async ({ call: rpc }) => {
      if (!plan.go) return true;
      await setCorridor(rpc, [room]);
      await stageSupplies(rpc, plan, fleet);
      report('returned', { purchased: plan.purchased, problem: plan.problem });
      return plan.problem ? { ok: false, why: plan.problem } : true;
    }, 'restore Ocean confinement and register exact delivered cache items'));
    return steps;
  },
};
