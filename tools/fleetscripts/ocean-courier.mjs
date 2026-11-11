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
import { noteGone, readReceived } from '../m59-loot-eject.mjs';
import {
  OCEAN_BREAD, OCEAN_COURIER, OCEAN_GEAR_NAMES, OCEAN_SALE_PRICE, OCEAN_SHOPS, oceanBreadPlan, oceanBuyQuantity, oceanDistance,
  oceanEpochKnown, oceanHasProvisionBatch, oceanItemCount, oceanItemName, oceanProvisionRecord, oceanSaveClear,
  oceanTradeGoodsAcceptance,
  oceanTradeGoodsDue, oceanTradeGoodsSale, oceanUnitsFit,
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
// TRANSIT ROOMS ARE CROSSED, NOT SETTLED IN (operator 2026-11-11: "Zheng should be able to survive a few hits from
// Fungus Beasts ... just have Zheng keep running the laps and it's not a problem if they die 1-2x"). The first lap of
// deploy-2026-11-11-1 aborted in the Valley of Ileria because a fungus beast and a groundworm larva camped beside him
// kept the threat reading off 'quiet' for the whole 155 s settle, and the return checkback then refused to walk him home
// for the same reason: stranded on a safe spot for 35 minutes. In these rooms arrival is enough; every room where he
// trades or waits (552, 200, the Toad, the smith) still requires the full quiet, full-health reading.
export const OCEAN_TRANSIT_ROOMS = Object.freeze([544, 534, 535]);
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
// One keeper process, one connection, one body, and a save epoch that is either a number or knowingly unobserved
// (oceanSaveEpoch). `unchanged` still compares all four strictly, so a save landing mid-act refuses the act.
const liveEpoch = s => [s.pid, s.connection_revision, s.you?.object_id ?? s.you?.id].every(Number.isSafeInteger) &&
  oceanEpochKnown(s);
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
    observation.room?.num === room && oceanEpochKnown(observation) &&
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

// The first unmet condition, or null when the body is ready. The runner logs it, because a gate that only ever
// answers false is how the courier sat out 34 hours of null save epochs without a single line (2026-11-11).
const firstUnmet = checks => checks.find(([ok]) => !ok)?.[1] ?? null;

export function oceanWardWaiting(s) {
  return firstUnmet([
    [s?.in_game && s.you, 'Statler is not in game'],
    [s?.ids_stale === false, 'Statler ids are stale (a save is in progress or was just crossed)'],
    [s?.room?.num === room && s.character === holderName && position(s.you, ward), 'Statler is not on the ward square'],
    [s?.autopilot_status?.faculties?.work?.owner === 'great-ocean:jala-singer', 'Statler is not posted by the singer'],
    [oceanSaveClear(s, 30_000), `a server save is due within 30 s (next ${s?.next_save_expected_at})`],
  ]);
}
export const oceanWardReady = s => oceanWardWaiting(s) === null;

export function oceanCourierWaiting(s, expected, minVigor = 0) {
  const p = s?.autopilot_status;
  const threat = s?.combat?.personal_threat;
  return firstUnmet([
    [s?.character === name && s.in_game && s.connected, 'Zheng is not connected in game'],
    [s?.ids_stale === false, 'Zheng ids are stale'],
    [s?.room?.num === expected, `Zheng is in ${s?.room?.num}, not ${expected}`],
    [liveEpoch(s), 'no keeper pid, connection or body id to bind the save epoch to'],
    [s?.hp?.max > 0 && s.hp.value === s.hp.max, `health ${s?.hp?.value}/${s?.hp?.max} is not full`],
    [s?.vigor?.value >= minVigor, `vigor ${s?.vigor?.value} under ${minVigor}`],
    [s?.karma?.value > 0, 'karma is not positive'],
    [p?.mode === 'survive' && p.policy?.neverAttack === true && p.policy?.townTrips === false,
      'not in the courier posture (survive, never attack, no town trips)'],
    [!s?.ridealong?.piloted && !s?.hold?.active && !s?.cooperative_wait, 'piloted, held or waiting cooperatively'],
    [!s?.combat?.active && !s?.movement?.order, 'in combat or under a movement order'],
    [!p?.recovery_travel && !p?.suspended_journey && !p?.recovering_from_death &&
      !isActiveRecoveryDecision(p?.survival_decisions?.current), 'recovering'],
    [threat?.level === 'quiet' && (!threat.last_personal_at || Date.now() - threat.last_personal_at >= 15000),
      'not quiet for 15 s'],
  ]);
}
export const oceanCourierReady = (s, expected, minVigor = 0) => oceanCourierWaiting(s, expected, minVigor) === null;

// ARRIVED IN A TRANSIT ROOM: the identity, epoch and posture half of oceanCourierWaiting, without health or quiet.
export function oceanCourierArrivedWaiting(s, expected) {
  const p = s?.autopilot_status;
  return firstUnmet([
    [s?.character === name && s.in_game && s.connected, 'Zheng is not connected in game'],
    [s?.ids_stale === false, 'Zheng ids are stale'],
    [s?.room?.num === expected, `Zheng is in ${s?.room?.num}, not ${expected}`],
    [liveEpoch(s), 'no keeper pid, connection or body id to bind the save epoch to'],
    [s?.hp?.value > 0, 'Zheng is dead'],
    [p?.mode === 'survive' && p.policy?.neverAttack === true && p.policy?.townTrips === false,
      'not in the courier posture (survive, never attack, no town trips)'],
    [!s?.ridealong?.piloted && !p?.recovering_from_death, 'piloted or recovering from death'],
  ]);
}
export const oceanCourierSettled = (s, expected, minVigor = 0) => OCEAN_TRANSIT_ROOMS.includes(expected)
  ? oceanCourierArrivedWaiting(s, expected) === null
  : oceanCourierReady(s, expected, minVigor);

async function waitForBody(rpc, expected, minVigor = 0) {
  const deadline = Date.now() + 155_000;
  do {
    const s = await read(rpc, agent);
    if (oceanCourierSettled(s, expected, minVigor)) return s;
    await sleep(2600);
  } while (Date.now() < deadline);
  throw Error(`Zheng did not settle safely in ${expected}`);
}

export function oceanCourierReturnSteps(s, { fleet, server } = {}) {
  const origin = s?.room?.num;
  // A live fight is the keeper's (survival owns the body); a merely unquiet transit room is not a reason to stay.
  if (!corridor.includes(origin) || s?.combat?.active || !oceanCourierSettled(s, origin, 95) ||
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
    if (fleet && server && selectOceanGearCargo(readOceanGearCargo(fleet), server, home, home).some(item => item.source === 'Raphael'))
      await deliverDedicatedAxes(rpc, fleet, server).catch(error => report('axe delivery deferred', { reason: error.message }));
    if (fleet && server && selectOceanGearCargo(readOceanGearCargo(fleet), server, home, home).length)
      await stageSupplies(rpc, { server, purchased: {} }, fleet, { carriedOnly: true });
    return true;
  }, 'restore Ocean confinement after an interrupted lap'));
  return steps;
}

// Zheng's trade-goods acceptance, pushed only on a change and confirmed by the keeper (oceanTradeGoodsAcceptance).
export async function setOceanTradeGoods(rpc, on) {
  const carrier = await read(rpc, agent);
  const next = oceanTradeGoodsAcceptance(carrier?.autopilot_status?.policy?.acceptDonations, on);
  if (!next) return true;
  const result = await rpc('autopilot', { agent, action: 'start', accept_donations: next,
    why: on ? 'Ocean courier takes farmer sale piles between laps' : 'Ocean courier lap: no trade goods until it returns' }, 12000);
  const confirmed = result?.keeper_push?.confirmed === true;
  report('trade goods acceptance', { on, confirmed });
  return confirmed;
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

// THE FARMERS' TRADE GOODS (oceanTradeGoodsSale): each stack quoted first, sold only at that quote, and judged by the
// pack and the purse. A counter that quotes nothing does not deal in it (Morrigan buys provisions and gems, Colhorr
// weapons and armour): the row stays in plan.trade for the next counter, and whatever no counter takes rides home.
export async function sellTradeGoods(rpc, keeper, plan, seller, expected) {
  if (!plan.trade?.length) return;
  const body = await waitForBody(rpc, expected, 95);
  const merchantId = await merchant(rpc, seller, expected);
  const left = [];
  for (const row of plan.trade) {
    let owed = row.amount;
    while (owed > 0) {
      const before = await inventory(rpc);
      const stack = before.items.filter(item => matches(item, row.name))
        .sort((a, b) => (Number(b.amount) || 1) - (Number(a.amount) || 1))[0];
      if (!stack || before.ids_stale !== false) break;
      const stackable = Number(stack.amount) > 0;
      const amount = stackable ? Math.min(owed, stack.amount) : 1;
      const args = { merchant: merchantId, item: stackable ? { id: stack.id, amount } : { id: stack.id } };
      const quote = await keeper('sell_one', { ...args, confirm: false }, 20000);
      const price = Number(quote?.offered_price);
      if (quote?.sold !== false || !Number.isSafeInteger(price) || price <= 0) break;
      const [sameBody, samePack] = await Promise.all([read(rpc, agent), inventory(rpc)]);
      require(oceanCourierReady(sameBody, expected) && unchanged(body, sameBody) &&
        before.last_save_at === samePack.last_save_at && purse(before) === purse(samePack) &&
        samePack.items.some(item => item.id === stack.id && matches(item, row.name) && item.amount === stack.amount),
      `pack changed during ${row.name} quote`);
      const sale = await keeper('sell_one', { ...args, confirm: true, expected_price: price }, 20000);
      require(sale?.sold === true, sale?.note ?? `keeper refused ${row.name} sale`);
      const after = await inventory(rpc);
      require(after.last_save_at === before.last_save_at && count(before, row.name) - count(after, row.name) === amount &&
        purse(after) - purse(before) === price, `ambiguous ${row.name} sale; inspect pack before any repeat`);
      noteGone(agent, [{ name: row.name, amount }]);   // the keeper counts by session name, the agent
      owed -= amount;
      report('trade goods sold', { seller, item: row.name, amount, shillings: price });
    }
    if (owed > 0) left.push({ name: row.name, amount: owed });
  }
  plan.trade = left;
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
    s.room?.num === TOAD && liveEpoch(s) && s.hp?.max > 0 && s.hp.value === s.hp.max &&
    p?.mode === 'survive' && p.policy?.assignedRoom === TOAD && p.policy.townTrips === false &&
    ['work', 'movement', 'economy'].every(faculty => p.faculties?.[faculty] === 'keeper') &&
    !s.human_held && !s.ridealong?.piloted && !s.ridealong?.human_held && !s.hold?.active && !s.cooperative_wait &&
    !s.job?.busy && !p.committed && !s.combat?.active && !s.movement?.order && !p.movement?.order && !p.cast_rite?.active &&
    !p.cooperative_logoff?.phase && !p.recovery_travel && !p.suspended_journey && !p.recovering_from_death &&
    !isActiveRecoveryDecision(p.survival_decisions?.current) && threat?.level === 'quiet' &&
    (!threat.last_personal_at || Date.now() - threat.last_personal_at >= 15000) && oceanSaveClear(s, 45_000);
}

export async function oceanReadyDeskSpare(rpc, fleet, generation) {
  const desk = readDeskState(fleet);
  if (!desk || !quietDesk(desk) || !Array.isArray(desk.state.deskSpare) ||
      !desk.state.deskSpare.some(receipt => intakeMatches(receipt, generation))) return null;
  const raphael = await read(rpc, deskAgent).catch(() => null);
  return oceanDeskReady(raphael) && raphael.last_save_at === generation
    ? oceanDeskSpareCandidate(desk, raphael) : null;
}

// DESK STOCK. Axes Raphael holds unworn that his keeper's weapon book reads as dedicated. The intake receipts that
// used to be the only way out are keyed to a save epoch, so every save stranded the desk's work: 2026-11-11 he held an
// enchanted axe and four mundane ones with no current receipt for any of them. A candidate only: moveDeskAxe LOOKs
// the exact id immediately before the trade and refuses anything that is not a sound, unconjured Kraanan dedication.
export function oceanDeskStockAxes(raphael) {
  const book = raphael?.autopilot_status?.weapon_magic?.weapons ?? [];
  const reading = id => book.find(w => w.id === id && w.name === AXE);
  return (raphael?.items ?? []).filter(item => knownAxe(item) && reading(item.id)?.wielded !== true &&
    reading(item.id)?.class === 'enchanted' && reading(item.id)?.bypasses_nonmagic === true && !reading(item.id)?.broken)
    .map(item => item.id);
}

// WHO GETS A DEDICATED AXE. kod: a mollusk takes +10% from a magic weapon and -30% from a bludgeon (mollusk.kod:99-101),
// and a frogman RESISTS every non-magic weapon by 65 (frogman.kod:67), so in 552 the dedicated axe is worth most to the
// hammer and mace wielders, then to every other farmer without a magic weapon. Only automated farmers standing in the
// Ocean, alive, not piloted, never the singer; a dedicated axe is never handed to someone who already has magic.
const BLUDGEON = /^(hammer|mace)$/i;
export function oceanAxeRecipients(rows, { exclude = [holder] } = {}) {
  return (rows ?? []).filter(r => /^t\d+$/.test(r?.agent ?? '') && !exclude.includes(r.agent) &&
    Number(r.room_num) === room && !r.piloted && !r.human_held && r.activity !== 'NOT IN GAME' &&
    r.weapon_magic && r.weapon_magic.wielded?.bypasses_nonmagic !== true && !(r.weapon_magic.magic_spares > 0))
    .sort((a, b) => Number(BLUDGEON.test(b.wielding ?? '')) - Number(BLUDGEON.test(a.wielding ?? '')));
}

function pendingIntake(desk, raphael) {
  return desk.conf.deskSpareIntake?.some(entry => intakeMatches(entry, raphael.last_save_at) &&
    raphael.items?.some(item => item.id === entry.id && knownAxe(item)));
}

async function moveDeskAxe(rpc, fleet, id, generation, collecting, { stock = false } = {}) {
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
      !oceanSaveClear(courier, 45_000) ||
      !(collecting ? stock || oceanDeskSpareCandidate(desk, raphael)?.id === id : !pendingIntake(desk, raphael)) ||
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

// Collect up to OCEAN_AXES_PER_LAP dedicated axes for the farmers who lack magic (plan.axeNeed, read at the ward):
// a receipt-bound spare first, then the desk's own stock. The Colhorr spare path (plan.wanted.axe) is unchanged.
export const OCEAN_AXES_PER_LAP = 3;
async function collectDeskSpare(rpc, fleet, plan) {
  const want = Math.min(OCEAN_AXES_PER_LAP, Math.max(plan.axeNeed ?? 0, plan.wanted[AXE] ? 1 : 0));
  for (let collected = 0; collected < want; collected++) {
    const desk = readDeskState(fleet);
    if (!desk || !quietDesk(desk)) return;
    const raphael = await read(rpc, deskAgent).catch(() => null);
    if (!oceanDeskReady(raphael)) return;
    const spare = oceanDeskSpareCandidate(desk, raphael);
    const candidates = spare ? [{ id: spare.id, generation: spare.generation, stock: false }]
      : oceanDeskStockAxes(raphael).slice(0, 4).map(id => ({ id, generation: raphael.last_save_at, stock: true }));
    let movement = null, chosen = null;
    for (const candidate of candidates) {
      movement = await moveDeskAxe(rpc, fleet, candidate.id, candidate.generation, true, { stock: candidate.stock });
      if (movement) { chosen = candidate; break; }
    }
    if (!movement) return;
    const { carrier, receipt } = movement;
    recordOceanGearCargo(fleet, plan.server, carrier, { id: chosen.id, name: AXE, source: 'Raphael', receipt });
    plan.purchased[AXE] = (plan.purchased[AXE] ?? 0) + 1;
    plan.wanted[AXE] = 0;
    plan.axeNeed = Math.max(0, (plan.axeNeed ?? 0) - 1);
    report('dedicated axe collected', { ...receipt, stock: chosen.stock });
  }
}

// HAND THE DEDICATED AXES STRAIGHT TO THE FARMERS, in the Ocean, by stationary trade. Operator 2026-11-11: desk axes
// "SHIPPED OUT by Zheng He on his return leg ... delivered to farmers lacking a dedicated weapon, rather than farmers
// walking to the Toad". Never on the floor: a dedication costs elderberries, an orc tooth and a 30 s trance, and a
// floor pile in a shared room is anybody's. Each axe is LOOKed again first; the receiver must be quiet and whole; the
// result is read back from both packs. An axe nobody can take this time stays in Zheng's pack for the next return.
async function deliverDedicatedAxes(rpc, fleet, server) {
  const body = await waitForBody(rpc, room);
  const pack = await inventory(rpc);
  const axes = selectOceanGearCargo(readOceanGearCargo(fleet), server, body, pack).filter(item => item.source === 'Raphael');
  if (!axes.length) return;
  const recipients = oceanAxeRecipients((await rpc('fleet', {}, 30000).catch(() => null))?.fleet);
  for (const axe of axes) {
    let delivered = false;
    while (!delivered && recipients.length) {
      const to = recipients.shift();
      const look = await rpc('look_at', { agent, target: axe.id }, 10000).catch(() => null);
      const reading = Number(look?.id) === axe.id && typeof look.description === 'string'
        ? classifyWeapon({ name: AXE, look: look.description }) : null;
      if (!soundAxe(reading) || reading.class !== 'enchanted') { report('carried axe no longer reads dedicated', { id: axe.id }); break; }
      const [giver, takerPack, taker, carrier] = await Promise.all([
        inventory(rpc), inventory(rpc, to.agent), read(rpc, to.agent), read(rpc, agent)]);
      const p = taker?.autopilot_status, threat = taker?.combat?.personal_threat;
      const takerQuiet = taker?.in_game && taker.connected && taker.ids_stale === false && taker.room?.num === room &&
        taker.hp?.max > 0 && taker.hp.value >= 0.9 * taker.hp.max && !taker.combat?.active && !taker.movement?.order &&
        !taker.ridealong?.piloted && !taker.human_held && ['work', 'movement', 'economy'].every(f => p?.faculties?.[f] === 'keeper') &&
        threat?.level === 'quiet' && oceanUnitsFit(takerPack, AXE) >= 1 && takerPack.ids_stale === false &&
        p?.weapon_magic?.wielded?.bypasses_nonmagic !== true && !(p?.weapon_magic?.magic_spares > 0);
      if (!takerQuiet || !oceanCourierReady(carrier, room) || !unchanged(body, carrier) || giver.ids_stale !== false ||
          giver.last_save_at !== body.last_save_at || !giver.items.some(item => item.id === axe.id && knownAxe(item))) continue;
      const bread = giver.items.filter(item => matches(item, OCEAN_BREAD.name)).sort((a, b) => b.amount - a.amount)[0];
      const loaves = bread && count(giver, OCEAN_BREAD.name) - OCEAN_BREAD.reserve >= 2 ? 2 : 0;
      const receipt = await rpc('supply', { from: agent, to: to.agent, stationary: true, who_travels: 'neither',
        no_dropoff: true, ids_as_of: giver.ids_as_of,
        what: [{ id: axe.id, name: AXE, amount: 1 }, ...(loaves ? [{ id: bread.id, name: OCEAN_BREAD.name, amount: loaves }] : [])] },
      35000).catch(error => ({ error: error.message }));
      const [giverAfter, takerAfter] = await Promise.all([inventory(rpc), inventory(rpc, to.agent)]);
      const stillHeld = giverAfter.items?.some(item => item.id === axe.id);
      const gained = count(takerAfter, AXE) - count(takerPack, AXE);
      if (stillHeld && gained === 0 && receipt?.supplied !== true) continue;
      require(receipt?.supplied === true && !stillHeld && gained === 1 && giverAfter.last_save_at === giver.last_save_at &&
        takerAfter.last_save_at === takerPack.last_save_at,
      `ambiguous dedicated axe delivery #${axe.id} to ${to.agent}; inspect both packs before repeating`);
      retireOceanGearCargo(fleet, server, body, [axe.id]);
      delivered = true;
      report('dedicated axe delivered', { id: axe.id, to: to.agent, character: to.character, loaves });
    }
  }
}

// ZHENG'S PURSE GOES TO RAPHAEL (operator 2026-11-11: "when he is in the Limping Toad on a lap ... hand his purse above
// a working float (keep ~2000 shillings for axe/bread purchases) to Raphael by stationary trade/supply, verified by both
// purses read back. Raphael accumulates; no hall deposit for now"). Marion has no bank, and the courier is a 23-health
// body on the road. Only with both bodies quiet in the Toad in one save epoch, and judged by both purses: an exact
// transfer or nothing moved; anything else stops the lap for inspection.
export const OCEAN_PURSE_FLOAT = 2000;
export async function depositPurseWithDesk(rpc) {
  const [courier, raphael, giver, taker] = await Promise.all([
    read(rpc, agent), read(rpc, deskAgent).catch(() => null), inventory(rpc), inventory(rpc, deskAgent).catch(() => null)]);
  const amount = purse(giver) - OCEAN_PURSE_FLOAT;
  if (amount < 100) return null;
  const coins = giver.items.filter(item => matches(item, 'shilling'));
  if (!oceanCourierReady(courier, TOAD) || !oceanDeskReady(raphael) || coins.length !== 1 ||
      [giver, taker].some(pack => pack?.ids_stale !== false || !Array.isArray(pack.items)) ||
      giver.last_save_at !== courier.last_save_at || taker.last_save_at !== raphael.last_save_at ||
      courier.last_save_at !== raphael.last_save_at) {
    report('purse hand-over deferred', { amount, why: 'Zheng and Raphael are not both quiet in the Toad in one save epoch' });
    return null;
  }
  const receipt = await rpc('supply', { from: agent, to: deskAgent, stationary: true, who_travels: 'neither',
    no_dropoff: true, ids_as_of: giver.ids_as_of, what: [{ id: coins[0].id, name: 'shilling', amount }] }, 35000)
    .catch(error => ({ error: error.message }));
  const [giverAfter, takerAfter] = await Promise.all([inventory(rpc), inventory(rpc, deskAgent)]);
  const lost = purse(giver) - purse(giverAfter), gained = purse(takerAfter) - purse(taker);
  const sameEpoch = giverAfter.last_save_at === giver.last_save_at && takerAfter.last_save_at === taker.last_save_at;
  if (sameEpoch && lost === 0 && gained === 0 && receipt?.supplied !== true) {
    report('purse hand-over refused', { amount, reason: receipt?.reason ?? receipt?.error ?? null });
    return null;
  }
  require(sameEpoch && receipt?.supplied === true && lost === amount && gained === amount,
    `ambiguous purse hand-over to Raphael (asked ${amount}, Zheng lost ${lost}, Raphael gained ${gained}); inspect both purses`);
  report('purse handed to Raphael', { amount, zheng: purse(giverAfter), raphael: purse(takerAfter) });
  return amount;
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
    // A dedicated axe is handed to a farmer (deliverDedicatedAxes), never left on the ward floor.
    if (item.source === 'Raphael') continue;
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
      if (heldGear().some(item => item.source === 'Raphael')) {
        await deliverDedicatedAxes(rpc, fleet, plan.server).catch(error => report('axe delivery deferred', { reason: error.message }));
        pack = await inventory(rpc);
        require(pack.ids_stale === false && pack.last_save_at === body.last_save_at, 'courier pack changed epoch during delivery');
      }
      if (oceanBreadPlan(floorCount(bread), count(pack, bread)).stage > 0 || heldGear().some(item => item.source !== 'Raphael')) {
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
      // DEDICATED AXES FOR WHOEVER LACKS MAGIC: the desk's stock goes out on this lap; with too little stock, one
      // more Colhorr axe is bought for Raphael to dedicate (handoffNewAxe; the supervisor casts on desk stock).
      const [raphael, rows] = await Promise.all([read(rpc, deskAgent).catch(() => null),
        rpc('fleet', {}, 30000).then(r => r?.fleet ?? []).catch(() => [])]);
      const carriedAxes = heldGear().filter(item => item.source === 'Raphael').length;
      plan.axeNeed = Math.max(0, oceanAxeRecipients(rows).length - carriedAxes);
      const deskReady = oceanDeskStockAxes(raphael).length;
      const deskBlanks = (raphael?.autopilot_status?.weapon_magic?.weapons ?? []).filter(w => w.name === AXE &&
        w.class === 'mundane' && w.wielded !== true && !w.broken).length;
      if (plan.axeNeed > deskReady + deskBlanks) plan.wanted[AXE] = 1;
      // THE FARMERS' SALE PILES, handed over as trade goods while Zheng waited in the Ocean.
      plan.trade = oceanTradeGoodsSale(pack, readReceived(agent));
      await collectSale(rpc, fleet, plan);
      const spare = plan.wanted[AXE] > 0 && await oceanReadyDeskSpare(rpc, fleet, pack.last_save_at);
      plan.go = plan.sales.size > 0 || !!spare || (plan.axeNeed > 0 && deskReady > 0) ||
        oceanTradeGoodsDue(pack, plan.trade) || oceanHasProvisionBatch(pack, plan.wanted);
      if (plan.go) {
        // DEPARTING: no more trade goods until he is home (the runner switches them back on), then sell what arrived.
        require(await setOceanTradeGoods(rpc, false), 'trade goods acceptance did not switch off before departure');
        await sleep(5000);             // a trade already in its window finishes before the pack is read again
        const settled = await inventory(rpc);
        require(settled.ids_stale === false && settled.last_save_at === body.last_save_at,
          'courier pack changed save epoch before departure');
        plan.trade = oceanTradeGoodsSale(settled, readReceived(agent));
        await setCorridor(rpc, corridor);
      }
      report('lap plan', { departing: plan.go, wanted: plan.wanted, sales: Object.fromEntries(plan.sales),
        trade: plan.trade, axe_need: plan.axeNeed, desk_dedicated: deskReady, desk_blanks: deskBlanks });
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
      await sellTradeGoods(rpc, keeper, plan, 'Morrigan', TOAD);
      await buySupplies(rpc, plan, 'Morrigan', TOAD, fleet);
      await buySupplies(rpc, plan, 'Tova', TOAD, fleet);
      await collectDeskSpare(rpc, fleet, plan);
      await depositPurseWithDesk(rpc);           // sale proceeds above the float stay with Raphael
      const stock = await inventory(rpc);
      plan.gear = stock.ids_stale === false && (oceanCanVisitSmith(stock, plan.wanted) || plan.trade.length > 0);
    }), 'sell the ward parcels and stock herbs, elderberries, and food'));
    const gearStop = () => plan.gear && !plan.problem;
    const nearSmith = () => plan.go ? 200 : room;
    const smithLeg = (to, gate) => walk(() => gate() ? to : nearSmith(),
      { candidates: [...new Set([to, 200, room])], minHealth: 1, why: 'one verified leg of the Ocean courier corridor' });
    steps.push(leg(200), settled(200), smithLeg(SMITH, gearStop), settled(SMITH, gearStop));
    steps.push(verify(async ({ call: rpc, keeper }) => {
      if (!gearStop()) return true;
      plan.atSmith = true;
      return bounded('smith commerce', async () => {
        await sellTradeGoods(rpc, keeper, plan, 'Colhorr', SMITH);
        await buySupplies(rpc, plan, 'Colhorr', SMITH, fleet);
      });
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
      await bounded('axe delivery', () => deliverDedicatedAxes(rpc, fleet, plan.server));
      await stageSupplies(rpc, plan, fleet);
      report('returned', { purchased: plan.purchased, problem: plan.problem });
      return plan.problem ? { ok: false, why: plan.problem } : true;
    }, 'restore Ocean confinement and register exact delivered cache items'));
    return steps;
  },
};
