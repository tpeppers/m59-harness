import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dibsFile, itemKey, liveClaims, normalizeBook } from './m59-dibs.mjs';
import { ledgerDirForRoster, stateFileFor } from './m59-fleetpath.mjs';
import { ITEM_RARITY, weighItem } from './m59-items.mjs';
import { estimateItemSellValue } from './m59-item-value.mjs';

export const OCEAN_COURIER = Object.freeze({
  room: 552, agent: 'hk2', name: 'Zheng He', holder: 't3', holderName: 'Statler',
  ward: { row: 43, col: 57 }, sale: { row: 44, col: 56 }, reserve: 400,
});
export const OCEAN_SALE_PRICE = Object.freeze({ 'blue mushroom': 25, 'red mushroom': 20 });
export const OCEAN_BREAD = Object.freeze({ name: 'loaf of bread', target: 20, reserve: 4 });
export const OCEAN_SHOPS = Object.freeze({
  Morrigan: [{ name: 'herb', limit: 180, price: 20, batch: 24 }, { name: 'elderberry', limit: 32, price: 40, batch: 8 }],
  Tova: [{ name: OCEAN_BREAD.name, limit: 24, price: 120, batch: 4 }],
  Colhorr: [{ name: 'axe', limit: 1, price: 960, batch: 1 }, { name: 'leather armor', limit: 1, price: 640, batch: 1 }],
});
const MAX_TAIL = 2 * 1024 * 1024;
const WARD_RADIUS = 3;
const SALE_CLAIM_TTL = 12 * 60_000;
const SALE_PICKUP_LIMIT = 15 * 60_000;
const SALE_PIN_FRESH = 90_000;
const SALE_PICKUP_BUDGET = 10_000;
const SALE_SCOPE = 'ocean-sale-cache';
const SALE_CLAIM_OWNER = 'ocean-courier';
const SALE_WARD_SCHEMA = 'm59-farm-sale-cache-ward/1';
const GEAR_CARGO_SCHEMA = 'm59-ocean-gear-cargo/1';
export const OCEAN_GEAR_NAMES = Object.freeze(['axe', 'leather armor']);
const positive = value => Number.isSafeInteger(value) && value > 0;
export const oceanItemName = name => String(name ?? '').trim().toLowerCase();
export const oceanDistance = (a, b) => Math.abs(a?.row - b?.row) + Math.abs(a?.col - b?.col);
export function oceanItemCount(pack, name) {
  const wanted = oceanItemName(name);
  return (pack.items ?? []).reduce((count, row) =>
    oceanItemName(row.name) === wanted ? count + (positive(row.amount) ? row.amount : 1) : count, 0);
}

// THE SAVE EPOCH, KNOWN OR NOT. A positive `last_save_at` is the last server save the broker observed; `null` with
// `ids_stale === false` is an epoch too: no save observed since this broker and keeper connected. 2026-11-11: the
// broker and keepers restarted at 18:05Z and prod had not saved since 2026-11-10T08:59Z, so every reply carried
// last_save_at=null and next_save_expected_at=null -- and every courier gate read "not a positive integer" as "not
// ready". Zheng ran no lap and no ward pin was written, silently, while the farmers' packs filled to 100%.
//
// THE RENUMBER SAFETY IS KEPT, NOT WAIVED. An object id dies at a server save. A save observed mid-operation turns
// `null` into a number, so the strict before/after equality every act already performs still refuses it; an unknown
// epoch is additionally bound to the keeper process and connection (`pid`, `connection_revision`), because a keeper
// that reconnected may have crossed a save it never saw; and every hand-over re-reads the exact item by name (and
// LOOK for a weapon) immediately before it acts. `undefined` means the reply cannot say (stale ids): never ready.
export function oceanSaveEpoch(s) {
  if (s?.ids_stale !== false) return undefined;
  if (positive(s.last_save_at)) return s.last_save_at;
  return s.last_save_at == null ? null : undefined;
}
export const oceanEpochKnown = s => oceanSaveEpoch(s) !== undefined;
/** No save is predicted inside `margin`. Without an observed cadence nothing can be predicted; the per-act equality guards it. */
export function oceanSaveClear(s, margin, now = Date.now()) {
  if (!oceanEpochKnown(s)) return false;
  if (positive(s.next_save_expected_at)) return s.next_save_expected_at - now > margin;
  return s.next_save_expected_at == null;
}

// WHAT ZHENG SELLS THAT THE FARMERS HANDED HIM. Operator 2026-11-11: "farmers hand their sellable loot to Zheng He,
// Zheng sells in Marion, money accumulates instead of items occupying packs". The farmers' keepers offer their own
// farm-town sale plan (lootEject in great-ocean-marion.mjs); Zheng's keeper takes it as trade goods and counts it by
// name (m59-loot-eject.mjs noteReceived). Never below the courier's own working stock of what he buys for the ward;
// gear, money and the cup are never sold.
//
// AND HIS OWN SURPLUS OF THE FARM'S LOOT, LEDGER OR NOT (2026-11-12). Zheng stood at 84% with red mushrooms (~234),
// scales, feathers, gems and 61 elderberries that predate the received ledger, so a sale of "only what was received"
// sold a bunch of grapes per lap -- and his 30%-free acceptance refused every farmer. OCEAN_COURIER_SELLS is the
// courier's own sale list: everything of those names above his working stock goes, whoever handed it over. Anything
// else is sold only up to what the ledger says farmers gave him (his own kit, the cup, wands and vault keepsakes stay).
export const OCEAN_COURIER_KEEP = Object.freeze({ elderberry: 40, herb: 180,
  [OCEAN_BREAD.name]: OCEAN_BREAD.target + OCEAN_BREAD.reserve });
export const OCEAN_COURIER_SELLS = Object.freeze(['red mushroom', 'blue mushroom', 'emerald', 'diamond', 'ruby', 'sapphire',
  'blue dragon scale', 'dark angel feather', 'bunch of grapes', 'elderberry', 'edible mushroom']);
const NEVER_SOLD = new Set(['shilling', 'axe', 'leather armor', 'chalice of the rain', 'small round shield', 'hammer']);
export const OCEAN_TRADE_GOODS_DUE = Object.freeze({ bulk: 500, fullness: 0.55 });

export function oceanTradeGoodsSale(pack, received = {}) {
  const owed = new Map(Object.entries(received ?? {}).map(([raw, n]) => [oceanItemName(raw), Number(n)]));
  const names = new Set([...owed.keys(), ...OCEAN_COURIER_SELLS]);
  const out = [];
  for (const name of names) {
    if (!name || NEVER_SOLD.has(name)) continue;
    const surplus = oceanItemCount(pack, name) - (OCEAN_COURIER_KEEP[name] ?? 0);
    const amount = OCEAN_COURIER_SELLS.includes(name) ? surplus : Math.min(owed.get(name) ?? 0, surplus);
    if (positive(amount)) out.push({ name, amount });
  }
  return out;
}

// WHAT A SALE IS WORTH AT MORRIGAN. The item book's estimate at a normal merchant, times what Morrigan actually paid
// against it on 2026-11-11 (feathers 75 of 105, blue mushroom 25 of 35, scale 50 of 70, ruby 100 of 140, diamond 50 of
// 70, emerald 15 of 21, elderberry 10 of 14: 0.7). A planning number only; every sale is still quoted first.
export const OCEAN_MORRIGAN_RATIO = 0.7;
export function oceanSaleValue(sale, estimate = name => estimateItemSellValue(name, { quantity: 1 })?.sell_value ?? 0) {
  return Math.round(sale.reduce((t, row) => t + (Number(estimate(row.name)) || 0) * OCEAN_MORRIGAN_RATIO * row.amount, 0));
}

// WHEN A LAP IS WORTH THE ROAD (2026-11-12). Every 8 minutes Zheng left with sales {} and a bunch of grapes, so farmers
// had about a minute between laps to hand him anything, and a refused farmer backs off for five. He now waits in the
// Ocean taking trade goods until there is a reason: ward parcels, sale value or a full pack, dedicated axes waiting at
// the desk for farmers who lack magic, bread running low (and affordable), or the longest wait with anything to do.
export const OCEAN_LAP = Object.freeze({ saleValue: 1500, fullness: 0.55, breadLow: 8, maxWaitMs: 20 * 60_000, minValue: 200 });
export function oceanLapDue({ parcels = 0, saleValue = 0, fullness = 0, axeWork = false, breadShort = false,
  provision = false, sinceLastMs = 0 } = {}) {
  if (parcels > 0) return { go: true, why: 'ward sale parcels to carry' };
  if (saleValue >= OCEAN_LAP.saleValue) return { go: true, why: `about ${saleValue} shillings to sell` };
  // FULL OF WHAT? His own kit (armour, shield, hammer, axe, the Chalice) alone reads ~80% (2026-11-12 03:41Z: a lap left
  // 'pack 80% full' with 50 shillings to sell). Fullness counts only when it is worth something at Morrigan.
  if (fullness >= OCEAN_LAP.fullness && saleValue >= OCEAN_LAP.minValue) return { go: true, why: `pack ${Math.round(fullness * 100)}% full` };
  if (axeWork) return { go: true, why: 'dedicated desk axes for farmers without magic' };
  if (breadShort) return { go: true, why: 'the ward is short of bread' };
  if (sinceLastMs >= OCEAN_LAP.maxWaitMs && (saleValue >= OCEAN_LAP.minValue || provision))
    return { go: true, why: `waited ${Math.round(sinceLastMs / 60_000)} min with work to do` };
  return { go: false, why: `waiting in the Ocean for trade goods (about ${saleValue} shillings so far)` };
}

// THE MEDIC'S HERBS, AT MOST WHAT HE CAN TAKE (2026-11-12: 94 and 21 bought on two laps for Loial while every hand-over
// read "the receiver cannot hold it", and bread then went unbought). The want is capped by the healer's free capacity
// less what Zheng already carries for him, and by the last hand-over's outcome: a capacity refusal buys nothing until a
// delivery succeeds; a verified delivery caps the next purchase at that amount.
export function oceanMedicHerbWant({ healerHerbs = 0, carried = 0, fits = 0, last = null } = {}) {
  const onHand = healerHerbs + Math.max(0, carried - 5);
  if (onHand >= 90) return 0;
  let want = Math.min(180 - onHand, Math.max(0, fits - Math.max(0, carried - 5)));
  if (last?.refused === 'capacity') return 0;
  if (positive(last?.delivered)) want = Math.min(want, last.delivered);
  return Math.max(0, want);
}

/** A JSON file that may carry a UTF-8 byte-order mark (PowerShell's Out-File/Set-Content -Encoding utf8 writes one). */
export function oceanReadJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// The last medic hand-over's outcome, written by the runner and read by the next lap plan (oceanMedicHerbWant).
export const oceanMedicHerbsFile = fleet => process.env.M59_OCEAN_MEDIC_HERBS_FILE ||
  join(dirname(dirname(stateFileFor(fleet))), 'scratch', `ocean-medic-herbs-${fleet}.json`);
export function readOceanMedicHerbs(fleet) {
  try { return oceanReadJson(oceanMedicHerbsFile(fleet)); } catch { return null; }
}
const CAPACITY_REFUSAL = /cannot hold|receiver_full|can't carry|weight or bulk/i;
/** -> { delivered, refused, at } for a verified amount, or the kind of refusal ('capacity' or 'other'). */
export function oceanMedicOutcome({ amount, verified, reason, now = Date.now() }) {
  if (verified) return { delivered: amount, refused: null, at: now };
  return { delivered: 0, refused: CAPACITY_REFUSAL.test(String(reason ?? '')) ? 'capacity' : 'other', at: now };
}

// Zheng takes a farmer's sale pile while it leaves 15% of his pack free for the provisions he brings back. The
// acceptance is his existing accept_donations (the reagent and wand list he already takes) plus trade_goods, or the
// same without it. Null when the keeper already holds what is asked, so the runner pushes only a change. Shillings
// come off his shed-for-space list: he now carries the farmers' sale proceeds (live 2026-11-11 the list named them).
// 15% (2026-11-12): at 30% one courier could not keep up with 20 farmers -- packs averaged 93% with 12 full and the kill
// rate fell from 24 to 17 a minute while they kept offering and being refused. 15% of 2,700 is ~405 bulk: a lap's bread,
// the medic's herbs and an axe still fit.
export const OCEAN_TRADE_GOODS = Object.freeze({ keep_free: 0.15 });
const shedList = base => Array.isArray(base?.drop_for_space)
  ? base.drop_for_space.filter(name => oceanItemName(name) !== 'shilling') : null;
export function oceanTradeGoodsAcceptance(current, on) {
  const has = !!current?.trade_goods && current.enabled !== false;
  const same = has && Number(current.trade_goods.keep_free) === OCEAN_TRADE_GOODS.keep_free && !current.trade_goods.from &&
    (shedList(current) ?? []).length === (current.drop_for_space?.length ?? 0);
  if (on ? same : !has) return null;
  const base = current && typeof current === 'object' && current.enabled !== false ? current : {};
  return { enabled: true,
    ...(Array.isArray(base.reagents) && base.reagents.length ? { reagents: base.reagents } : {}),
    ...(shedList(base) ? { drop_for_space: shedList(base) } : {}),
    min_bulk_free: Number.isFinite(base.min_bulk_free) ? base.min_bulk_free : 40,
    ...(on ? { trade_goods: { ...OCEAN_TRADE_GOODS } } : {}) };
}

/** Is the received pile worth a lap by itself? */
export function oceanTradeGoodsDue(pack, sale) {
  const load = sale.reduce((t, row) => t + (weighItem(row.name)?.bulk ?? 0) * row.amount, 0);
  const have = pack?.carry?.load?.bulk, free = pack?.carry?.room_for?.bulk;
  const fullness = Number.isFinite(have) && Number.isFinite(free) && have + free > 0 ? have / (have + free) : 0;
  return sale.length > 0 && (load >= OCEAN_TRADE_GOODS_DUE.bulk || fullness >= OCEAN_TRADE_GOODS_DUE.fullness);
}

export function oceanBreadPlan(floor, carried) {
  const missing = Math.max(0, OCEAN_BREAD.target - floor);
  return { stage: Math.min(missing, Math.max(0, carried - OCEAN_BREAD.reserve)),
    wanted: missing + Math.max(0, OCEAN_BREAD.reserve - carried) };
}

export function oceanCourierReserveFood(status) {
  const vigor = status?.vigor?.value;
  if (!Number.isFinite(vigor) || vigor < 80 || vigor >= 140 || status.ids_stale !== false) return null;
  const protectedItems = new Set((status.autopilot_status?.policy?.protectedItems ?? []).map(oceanItemName));
  const stock = (status.items ?? []).filter(item => positive(item.id) && positive(item.amount) &&
    !protectedItems.has(oceanItemName(item.name)));
  return stock.find(item => ['loaf of bread', 'meat pie'].includes(oceanItemName(item.name))) ??
    stock.find(item => oceanItemName(item.name) === 'inky-cap mushroom') ?? null;
}

function tailRows(file) {
  let fd;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - MAX_TAIL);
    const buffer = Buffer.alloc(size - start);
    fd = openSync(file, 'r');
    const length = readSync(fd, buffer, 0, buffer.length, start);
    const rows = buffer.subarray(0, length).toString('utf8').split('\n');
    if (start) rows.shift();
    // The ledger can be appending while we read. Only use complete lines.
    rows.pop();
    return rows.flatMap(row => {
      try { return [JSON.parse(row)]; }
      catch { return []; }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readOceanSaleDeposits(fleet, now = Date.now()) {
  const dir = ledgerDirForRoster(stateFileFor(fleet));
  const receipts = [now - 86_400_000, now].flatMap(time =>
    tailRows(join(dir, 'fleet-' + new Date(time).toISOString().slice(0, 10) + '.jsonl')));
  return receipts.concat(tailRows(join(dir, 'ocean-courier-reconciliations.jsonl')));
}

function isSaleReceipt(row) {
  if (row?.kind === 'farm_sale_cache_deposit') return true;
  const proof = row?.reconciliation;
  return row?.kind === 'farm_sale_cache_reconciled' && proof?.kind === 'native-drop-merge' &&
    /^t\d+$/.test(proof.agent ?? '') && positive(proof.floor_before_at) && positive(proof.pack_after_at) &&
    positive(proof.floor_after_at) && row.last_save_at <= proof.floor_before_at &&
    proof.floor_before_at < proof.pack_after_at && proof.pack_after_at < proof.floor_after_at &&
    proof.floor_after_at <= row.observed_at && row.previous_amount > 0;
}

export const oceanSaleWardPath = fleet => process.env.M59_FARM_SALE_CACHE_WARD_FILE ||
  join(dirname(dirname(stateFileFor(fleet))), `farm-sale-cache-ward-${fleet || 'default'}.json`);

function normalizedSaleBook(raw) {
  const problems = [];
  const book = normalizeBook(raw, problems);
  if (!Array.isArray(raw?.claims) || problems.length) throw Error('unreadable floor reservations');
  return book;
}

const onlyZheng = claim => Array.isArray(claim.for) && claim.for.length === 1 &&
  oceanItemName(claim.for[0]) === oceanItemName(OCEAN_COURIER.name);
const ownSaleClaim = claim => claim?.source === SALE_SCOPE && claim.by === SALE_CLAIM_OWNER &&
  Number(claim.room) === OCEAN_COURIER.room && onlyZheng(claim) && claim.near?.radius != null && Number(claim.near.radius) === 0 &&
  oceanDistance(claim.near, OCEAN_COURIER.sale) === 0 && Object.hasOwn(OCEAN_SALE_PRICE, itemKey(claim.item));

function currentSaleClaim(book, name, now) {
  const covering = liveClaims(book, now).filter(claim => claim.room === OCEAN_COURIER.room &&
    claim.item === itemKey(name) && (!claim.near || oceanDistance(claim.near, OCEAN_COURIER.sale) <= claim.near.radius));
  if (!covering.every(onlyZheng)) return null;
  const exact = covering.filter(claim => ownSaleClaim(claim) && positive(claim.until));
  return exact.length === 1 ? exact[0] : null;
}

// Renew the lease without erasing when exclusive coverage began. A lapse or a
// competing claim clears continuity, even if the same tile is claimed again.
export function renewOceanSaleClaims(raw, now = Date.now()) {
  const book = normalizedSaleBook(raw);
  const prior = Object.keys(OCEAN_SALE_PRICE).map(item => [item, currentSaleClaim(book, item, now)]);
  const validStart = claim => positive(Date.parse(claim?.at)) && Date.parse(claim.at) <= now;
  if (prior.every(([, claim]) => validStart(claim) && claim.until > now + SALE_CLAIM_TTL / 2)) return null;
  const claims = prior.map(([item, claim]) => ({
    source: SALE_SCOPE, room: OCEAN_COURIER.room, item, for: [OCEAN_COURIER.name],
    near: { ...OCEAN_COURIER.sale, radius: 0 }, at: validStart(claim) ? claim.at : new Date(now).toISOString(),
    until: new Date(now + SALE_CLAIM_TTL).toISOString(), by: SALE_CLAIM_OWNER,
    why: 'Exact registered keeper sale parcels for the Marion courier',
  }));
  return { ...raw, claims: [...raw.claims.filter(claim => !ownSaleClaim(claim)), ...claims] };
}

export function readOceanSaleAuthorization(fleet) {
  let book;
  try { book = normalizedSaleBook(JSON.parse(readFileSync(dibsFile(fleet), 'utf8'))); }
  catch { return null; }
  let pin = null;
  try { pin = JSON.parse(readFileSync(oceanSaleWardPath(fleet), 'utf8')); }
  catch { /* A fresh receipt needs the claim; grace additionally needs the ward pin. */ }
  return { book, pin };
}

function salePickupAuthorized(row, ward, now, authorization) {
  const claim = currentSaleClaim(authorization?.book, row.item.name, now);
  if (!claim || claim.until <= now + SALE_PICKUP_BUDGET) return false;
  if (row.expires_at > now) return true;
  const { pin } = authorization;
  const claimStarted = Date.parse(claim.at);
  return now < row.observed_at + SALE_PICKUP_LIMIT && positive(claimStarted) && claimStarted <= row.observed_at &&
    pin?.schema === SALE_WARD_SCHEMA && pin.room === row.room && pin.room_security === row.room_security &&
    pin.last_save_at === row.last_save_at && positive(pin.observed_at) && positive(pin.expires_at) &&
    pin.observed_at > pin.last_save_at && pin.observed_at <= now && now - pin.observed_at <= SALE_PIN_FRESH &&
    pin.expires_at > now + SALE_PICKUP_BUDGET && pin.anchor?.id === (ward.you?.object_id ?? ward.you?.id) &&
    pin.anchor.name === ward.character && oceanDistance(pin.anchor, ward.you) === 0;
}

export function selectOceanSalePiles(rows, scene, ward, now = Date.now(), authorization) {
  const anchor = ward.you;
  const holderId = anchor?.object_id ?? anchor?.id;
  const security = ward.room_wire?.room_security_u32;
  if (!ward.in_game || ward.room?.num !== OCEAN_COURIER.room || ward.ids_stale !== false ||
      !scene.ok || scene.ids_stale !== false || !Array.isArray(scene.items) ||
      scene.room !== OCEAN_COURIER.room || scene.last_save_at !== ward.last_save_at ||
      ward.character !== OCEAN_COURIER.holderName || !positive(holderId) || !positive(security) ||
      oceanDistance(anchor, OCEAN_COURIER.ward) !== 0) return [];
  const receipts = new Map();
  for (const row of rows.filter(isSaleReceipt).sort((a, b) => a.observed_at - b.observed_at)) {
    const { item, anchor: receiptHolder } = row;
    if (row.room !== OCEAN_COURIER.room ||
        row.courier !== OCEAN_COURIER.name || row.room_security !== security ||
        row.last_save_at !== ward.last_save_at || row.observed_at <= row.last_save_at ||
        !positive(row.observed_at) || !positive(row.expires_at) ||
        !(row.observed_at <= now && row.expires_at > row.observed_at) ||
        receiptHolder?.id !== holderId || receiptHolder.name !== ward.character ||
        oceanDistance(receiptHolder, anchor) !== 0 ||
        !positive(item?.id) || !positive(item?.amount) || !Object.hasOwn(OCEAN_SALE_PRICE, item.name) ||
        oceanDistance(item, OCEAN_COURIER.sale) !== 0) continue;
    const previous = row.previous_amount ?? 0;
    const deposited = row.deposited_amount ?? item.amount;
    if (!Number.isSafeInteger(previous) || previous < 0 || !positive(deposited) ||
        previous + deposited !== item.amount) continue;
    const last = receipts.get(item.id);
    // An expired base can still explain part of the live stack. A new
    // deposit renews only the contiguous, fully accounted-for amount.
    if (previous > 0 ? !last || last.item.name !== item.name || last.item.amount !== previous ||
        row.observed_at < last.observed_at : last) continue;
    receipts.set(item.id, row);
  }
  return [...receipts.values()].filter(row => salePickupAuthorized(row, ward, now, authorization) &&
    scene.items.some(pile => pile.id === row.item.id && pile.name === row.item.name &&
      pile.amount === row.item.amount && oceanDistance(pile, row.item) === 0)).map(row => row.item);
}

export function oceanUnitsFit(pack, name) {
  const unit = weighItem(name);
  const free = pack.carry?.room_for;
  if (!unit || !free || pack.carry.load?.exact !== true ||
      !Number.isFinite(free.weight) || !Number.isFinite(free.bulk)) return 0;
  return Math.max(0, Math.floor(Math.min(free.weight / Math.max(1, unit.weight),
    free.bulk / Math.max(1, unit.bulk))));
}

// `holdBack`: shillings kept for a higher-priority purchase later in the lap (bread > the desk's axe > herbs).
export function oceanBuyQuantity(pack, offer, supply, wanted, holdBack = 0) {
  const price = Number(offer?.cost ?? offer?.price);
  if (!positive(offer?.id) || oceanItemName(offer.name) !== supply.name || !positive(price) ||
      price > supply.price || !positive(wanted)) return 0;
  return oceanQuantityAtPrice(pack, supply, wanted, price, holdBack);
}

function oceanQuantityAtPrice(pack, supply, wanted, price, holdBack = 0) {
  return Math.max(0, Math.min(wanted, supply.limit, oceanUnitsFit(pack, supply.name),
    Math.floor((oceanItemCount(pack, 'shilling') - OCEAN_COURIER.reserve - Math.max(0, holdBack)) / price)));
}

export function oceanHasProvisionBatch(pack, wanted) {
  return Object.values(OCEAN_SHOPS).flat().some(supply => positive(wanted[supply.name]) &&
    oceanQuantityAtPrice(pack, supply, wanted[supply.name], supply.price) >= supply.batch);
}

export const oceanGearCargoFile = fleet => process.env.M59_OCEAN_GEAR_CARGO_FILE ||
  join(dirname(dirname(stateFileFor(fleet))), 'scratch', `ocean-gear-cargo-${fleet}.json`);

export function readOceanGearCargo(fleet) {
  try { return JSON.parse(readFileSync(oceanGearCargoFile(fleet), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

const bodyId = body => body?.you?.object_id ?? body?.you?.id;
// An unknown save epoch binds a record to the exact keeper process and connection that observed it.
const sessionOf = body => oceanSaveEpoch(body) === null
  ? { keeper_pid: body.pid, connection_revision: body.connection_revision } : {};
const sameSession = (record, body) => oceanSaveEpoch(body) !== null ||
  (positive(body.pid) && Number.isSafeInteger(body.connection_revision) &&
    record.keeper_pid === body.pid && record.connection_revision === body.connection_revision);
const gearCargoCurrent = (record, server, body) => record?.schema === GEAR_CARGO_SCHEMA &&
  body?.character === OCEAN_COURIER.name && body.ids_stale === false && positive(bodyId(body)) &&
  oceanEpochKnown(body) && record.last_save_at === oceanSaveEpoch(body) && sameSession(record, body) &&
  record.body_id === bodyId(body) &&
  record.agent === OCEAN_COURIER.agent && typeof server?.host === 'string' && server.host && positive(Number(server.port)) &&
  record.server?.host === server.host && record.server.port === Number(server.port) && Array.isArray(record.items);

function provenGearCargo(item, save, carrier) {
  const receipt = item?.receipt;
  const after = at => positive(at) && (save === null || at > save);
  if (!positive(item?.id) || !OCEAN_GEAR_NAMES.includes(item.name) || receipt?.generation !== save) return false;
  if (item.source === 'Colhorr') return receipt.seller === 'Colhorr' && receipt.room === 201 &&
    receipt.item === item.name && receipt.amount === 1 && receipt.ids?.length === 1 && receipt.ids[0] === item.id &&
    positive(receipt.shillings) && after(receipt.at);
  return item.source === 'Raphael' && item.name === 'axe' && receipt.from === 'hk3' &&
    receipt.to === OCEAN_COURIER.agent && receipt.name === item.name && receipt.id === item.id &&
    positive(receipt.from_body) && receipt.to_body === carrier && after(receipt.started) &&
    positive(receipt.confirmed) && receipt.confirmed >= receipt.started;
}

export function recordOceanGearCargo(fleet, server, body, item) {
  const record = { schema: GEAR_CARGO_SCHEMA, agent: OCEAN_COURIER.agent, body_id: bodyId(body),
    server: { host: server?.host, port: Number(server?.port) }, last_save_at: oceanSaveEpoch(body),
    ...sessionOf(body), items: [] };
  if (!gearCargoCurrent(record, server, body) || !provenGearCargo(item, record.last_save_at, record.body_id))
    throw Error('gear cargo needs an exact receipt in Zheng’s current save epoch');
  const prior = readOceanGearCargo(fleet);
  if (gearCargoCurrent(prior, server, body)) record.items = prior.items.filter(entry =>
    provenGearCargo(entry, record.last_save_at, record.body_id) && entry.id !== item.id);
  record.items.push(item);
  writeOceanCache(oceanGearCargoFile(fleet), record);
}

export function retireOceanGearCargo(fleet, server, body, ids) {
  if (!ids.length) return;
  const record = readOceanGearCargo(fleet);
  if (!gearCargoCurrent(record, server, body)) return;
  const items = record.items.filter(item => !ids.includes(item?.id));
  if (items.length !== record.items.length) writeOceanCache(oceanGearCargoFile(fleet), { ...record, items });
}

export function selectOceanGearCargo(record, server, body, pack) {
  if (!gearCargoCurrent(record, server, body) || pack?.ids_stale !== false || pack.last_save_at !== body.last_save_at ||
      !positive(pack.ids_as_of) || (positive(body.last_save_at) && pack.ids_as_of < body.last_save_at) ||
      !Array.isArray(pack.items)) return [];
  return record.items.filter(item => provenGearCargo(item, record.last_save_at, record.body_id) && pack.items.some(row =>
    row.id === item.id && oceanItemName(row.name) === item.name && Number.isInteger(row.rarity) &&
    row.rarity >= ITEM_RARITY.NORMAL && row.rarity < ITEM_RARITY.UNIDENTIFIED && [null, undefined, 0, 1].includes(row.amount)))
    .sort((a, b) => Number(b.source === 'Raphael') - Number(a.source === 'Raphael'));
}

export function oceanProvisionRecord({ host, ward, items, kind, now = Date.now() }) {
  const { room, holderName } = OCEAN_COURIER;
  const holder = { id: ward.you.object_id ?? ward.you.id, name: holderName, row: ward.you.row, col: ward.you.col };
  const room_security = ward.room_wire?.room_security_u32;
  if (!ward.in_game || ward.ids_stale !== false || ward.character !== holderName || ward.room?.num !== room ||
      oceanDistance(holder, OCEAN_COURIER.ward) !== 0 || !positive(holder.id) ||
      !positive(room_security) || !host?.host || !positive(Number(host.port)) ||
      !items.length || items.some(item => !positive(item.id) || !(oceanDistance(item, holder) <= WARD_RADIUS)))
    throw Error('ward or delivery is not current and within the cache');
  const base = { server: { host: host.host, port: Number(host.port) }, room, room_security,
    observed_at: now, holder };
  const handle = ({ id, name, row, col }) => ({ id, name, row, col });
  if (kind === 'food' && items.length === 1 && items[0].name === 'loaf of bread')
    return { ...base, schema: 'm59-farm-food-cache/1', expires_at: now + 300_000, item: handle(items[0]) };
  if (kind === 'gear' && items.length <= 16 && items.every(item => ['axe', 'leather armor'].includes(item.name)))
    return { ...base, schema: 'm59-farm-gear-cache/1', expires_at: now + 900_000,
      last_save_at: ward.last_save_at, items: items.map(handle) };
  throw Error('delivery does not match the exact cache category');
}

export function writeOceanCache(file, record) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  renameSync(temporary, file);
}
