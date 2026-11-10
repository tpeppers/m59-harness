import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';
import { idsCurrent } from './m59-idgen.mjs';
import { OF } from './m59-parse.mjs';

export const FARM_GEAR_CACHE_ROOM = 552;
export const FARM_GEAR_CACHE_RADIUS = 3;
const MAX_AGE_MS = 15 * 60_000;
const MAX_ITEMS = 16;
const fold = value => String(value ?? '').trim().toLowerCase();
const positive = value => Number.isSafeInteger(value) && value > 0;
const positioned = p => positive(p?.row) && positive(p?.col);
const distance = (a, b) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col);

export const isFarmGearCacheItem = name => ['axe', 'leather armor'].includes(fold(name));
export const farmGearCacheFile = (fleet = fleetName()) => process.env.M59_FARM_GEAR_CACHE_FILE ||
  fileURLToPath(new URL(`../substrate/farm-gear-cache-${fleet || 'default'}.json`, import.meta.url));

export function readFarmGearCache(file = farmGearCacheFile()) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

export function boundFarmGearPiles(s, c, record, now = Date.now(), { forWithdrawal = false } = {}) {
  const holder = record?.holder;
  const ids = c?.idsAsOf?.();
  if (record?.schema !== 'm59-farm-gear-cache/1' || record.room !== FARM_GEAR_CACHE_ROOM ||
      s.world?.room?.num !== record.room || !c?.room?.objects ||
      !fold(s.credentials?.host) || fold(record.server?.host) !== fold(s.credentials.host) ||
      !positive(record.server?.port) || record.server.port !== Number(s.credentials.port) ||
      !Number.isSafeInteger(c.room.security) || record.room_security !== (c.room.security >>> 0) ||
      !positive(record.observed_at) || record.observed_at > now ||
      !positive(record.expires_at) || record.expires_at <= now || record.expires_at > record.observed_at + MAX_AGE_MS ||
      !Object.hasOwn(record, 'last_save_at') ||
      (record.last_save_at !== null && (!positive(record.last_save_at) || record.last_save_at >= record.observed_at)) ||
      ids?.saving || ids?.last_save_began_at >= record.observed_at ||
      !positive(holder?.id) || fold(holder?.name) !== 'statler' || !positioned(holder) ||
      !Array.isArray(record.items) || record.items.length > MAX_ITEMS ||
      new Set(record.items.map(item => item?.id)).size !== record.items.length) return [];

  if (forWithdrawal) {
    const anchor = c.room.objects.get(holder.id);
    // The broker's canonical save mark is writer provenance. Each keeper receives
    // its own save packets, and a keeper started after that save has no local mark.
    if (!idsCurrent(ids) || (record.last_save_at != null && ids.inventory_at < record.last_save_at) ||
        c.idsTrackedSince > record.observed_at || !positioned(c.self) || c.self.predicted ||
        distance(c.self, holder) > FARM_GEAR_CACHE_RADIUS || !(anchor?.flags & OF.PLAYER) ||
        anchor.predicted || !positioned(anchor) || distance(anchor, holder) ||
        fold(c.rsc.get(anchor.nameRsc)) !== 'statler') return [];
  }
  return record.items.flatMap(item => {
    if (!positive(item?.id) || !positioned(item) || !isFarmGearCacheItem(item.name) ||
        distance(holder, item) > FARM_GEAR_CACHE_RADIUS) return [];
    const o = c.room.objects.get(item.id);
    if (!(o?.flags & OF.GETTABLE) || o.predicted || !positioned(o) || distance(o, item) ||
        (o.amount != null && o.amount > 1) || fold(c.rsc.get(o.nameRsc)) !== fold(item.name) ||
        (forWithdrawal && distance(c.self, item) > FARM_GEAR_CACHE_RADIUS)) return [];
    return [{ id: item.id, name: fold(item.name), row: item.row, col: item.col }];
  });
}
