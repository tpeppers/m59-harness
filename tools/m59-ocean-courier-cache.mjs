import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dibsFile, itemKey, liveClaims, normalizeBook } from './m59-dibs.mjs';
import { ledgerDirForRoster, stateFileFor } from './m59-fleetpath.mjs';
import { weighItem } from './m59-items.mjs';

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
const positive = value => Number.isSafeInteger(value) && value > 0;
export const oceanItemName = name => String(name ?? '').trim().toLowerCase();
export const oceanDistance = (a, b) => Math.abs(a?.row - b?.row) + Math.abs(a?.col - b?.col);
export const oceanItemCount = (pack, name) => (pack.items ?? []).reduce((count, row) =>
  oceanItemName(row.name) === name ? count + (positive(row.amount) ? row.amount : 1) : count, 0);

export function oceanBreadPlan(floor, carried) {
  const missing = Math.max(0, OCEAN_BREAD.target - floor);
  return { stage: Math.min(missing, Math.max(0, carried - OCEAN_BREAD.reserve)),
    wanted: missing + Math.max(0, OCEAN_BREAD.reserve - carried) };
}

export function oceanCourierReserveFood(status) {
  const vigor = status?.vigor?.value;
  if (!Number.isFinite(vigor) || vigor < 80 || vigor >= 140 || status.ids_stale !== false) return null;
  const protectedItems = new Set((status.autopilot_status?.policy?.protectedItems ?? []).map(oceanItemName));
  return status.items?.find(item => positive(item.id) && positive(item.amount) &&
    ['loaf of bread', 'meat pie'].includes(item.name) && !protectedItems.has(item.name)) ?? null;
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

export function oceanBuyQuantity(pack, offer, supply, wanted) {
  const price = Number(offer?.cost ?? offer?.price);
  if (!positive(offer?.id) || oceanItemName(offer.name) !== supply.name || !positive(price) ||
      price > supply.price || !positive(wanted)) return 0;
  return oceanQuantityAtPrice(pack, supply, wanted, price);
}

function oceanQuantityAtPrice(pack, supply, wanted, price) {
  return Math.max(0, Math.min(wanted, supply.limit, oceanUnitsFit(pack, supply.name),
    Math.floor((oceanItemCount(pack, 'shilling') - OCEAN_COURIER.reserve) / price)));
}

export function oceanHasProvisionBatch(pack, wanted) {
  return Object.values(OCEAN_SHOPS).flat().some(supply => positive(wanted[supply.name]) &&
    oceanQuantityAtPrice(pack, supply, wanted[supply.name], supply.price) >= supply.batch);
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
