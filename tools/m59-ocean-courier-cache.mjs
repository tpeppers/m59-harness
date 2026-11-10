import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ledgerDirForRoster, stateFileFor } from './m59-fleetpath.mjs';
import { weighItem } from './m59-items.mjs';

export const OCEAN_COURIER = Object.freeze({
  room: 552, agent: 'hk2', name: 'Zheng He', holder: 't3', holderName: 'Statler',
  ward: { row: 43, col: 57 }, sale: { row: 44, col: 56 }, reserve: 400,
});
export const OCEAN_SALE_PRICE = Object.freeze({ 'blue mushroom': 25, 'red mushroom': 20 });
export const OCEAN_SHOPS = Object.freeze({
  Morrigan: [{ name: 'herb', limit: 180, price: 20 }, { name: 'elderberry', limit: 32, price: 40 }],
  Tova: [{ name: 'loaf of bread', limit: 24, price: 120 }],
  Colhorr: [{ name: 'axe', limit: 1, price: 960 }, { name: 'leather armor', limit: 1, price: 640 }],
});
const MAX_TAIL = 2 * 1024 * 1024;
const WARD_RADIUS = 3;
const positive = value => Number.isSafeInteger(value) && value > 0;
export const oceanItemName = name => String(name ?? '').trim().toLowerCase();
export const oceanDistance = (a, b) => Math.abs(a?.row - b?.row) + Math.abs(a?.col - b?.col);
export const oceanItemCount = (pack, name) => (pack.items ?? []).reduce((count, row) =>
  oceanItemName(row.name) === name ? count + (positive(row.amount) ? row.amount : 1) : count, 0);

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
  return [now - 86_400_000, now].flatMap(time =>
    tailRows(join(dir, 'fleet-' + new Date(time).toISOString().slice(0, 10) + '.jsonl')));
}

export function selectOceanSalePiles(rows, scene, ward, now = Date.now()) {
  const anchor = ward.you;
  const holderId = anchor?.object_id ?? anchor?.id;
  const security = ward.room_wire?.room_security_u32;
  if (!ward.in_game || ward.room?.num !== OCEAN_COURIER.room || ward.ids_stale !== false ||
      !scene.ok || scene.ids_stale !== false || !Array.isArray(scene.items) ||
      scene.room !== OCEAN_COURIER.room || scene.last_save_at !== ward.last_save_at ||
      ward.character !== OCEAN_COURIER.holderName || !positive(holderId) || !positive(security) ||
      oceanDistance(anchor, OCEAN_COURIER.ward) !== 0) return [];
  const exact = new Map();
  for (const row of rows) {
    const { item, anchor: receiptHolder } = row;
    if (row.kind !== 'farm_sale_cache_deposit' || row.room !== OCEAN_COURIER.room ||
        row.courier !== OCEAN_COURIER.name || row.room_security !== security ||
        row.last_save_at !== ward.last_save_at || row.observed_at <= row.last_save_at ||
        !(row.observed_at <= now && row.expires_at > now) ||
        receiptHolder?.id !== holderId || receiptHolder.name !== ward.character ||
        oceanDistance(receiptHolder, anchor) !== 0 ||
        !positive(item?.id) || !positive(item?.amount) || !Object.hasOwn(OCEAN_SALE_PRICE, item.name) ||
        oceanDistance(item, OCEAN_COURIER.sale) !== 0) continue;
    if (scene.items.some(pile => pile.id === item.id && pile.name === item.name &&
        pile.amount === item.amount && oceanDistance(pile, item) === 0)) exact.set(item.id, item);
  }
  return [...exact.values()];
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
  return Math.max(0, Math.min(wanted, supply.limit, oceanUnitsFit(pack, supply.name),
    Math.floor((oceanItemCount(pack, 'shilling') - OCEAN_COURIER.reserve) / price)));
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
