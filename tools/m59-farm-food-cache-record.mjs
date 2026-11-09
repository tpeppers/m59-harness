// The verified registration is shared by the whole-stack and counted pickup paths.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';
import { idsCurrent } from './m59-idgen.mjs';
import { OF } from './m59-parse.mjs';

export const FARM_FOOD_CACHE_ROOM = 552;
export const FARM_FOOD_CACHE_RADIUS = 3;
const MAX_AGE_MS = 5 * 60_000;
const FOODS = new Set(['loaf of bread', 'meat pie', 'wheel of cheese', 'inky-cap mushroom']);
const fold = value => String(value ?? '').trim().toLowerCase();
const positive = value => Number.isSafeInteger(value) && value > 0;
const placed = point => positive(point?.row) && positive(point?.col);
const distance = (a, b) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
const nameOf = (c, o) => fold(c.rsc.get(o.nameRsc));

export const isFarmFoodCacheItem = name => FOODS.has(fold(name));
export const farmFoodCacheFile = (fleet = fleetName()) => process.env.M59_FARM_FOOD_CACHE_FILE ||
  fileURLToPath(new URL(`../substrate/farm-food-cache-${fleet || 'default'}.json`, import.meta.url));

export function readFarmFoodCache(file = farmFoodCacheFile()) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

export function boundFarmFoodPile(s, c, record, now = Date.now(), { forWithdrawal = false } = {}) {
  const holder = record?.holder, item = record?.item;
  if (record?.schema !== 'm59-farm-food-cache/1' || record.room !== FARM_FOOD_CACHE_ROOM ||
      s.world?.room?.num !== record.room ||
      fold(record.server?.host) !== fold(s.credentials?.host) || !fold(s.credentials?.host) ||
      record.server?.port !== Number(s.credentials?.port) || !positive(record.server?.port) ||
      !Number.isSafeInteger(record.room_security) || !Number.isSafeInteger(c.room?.security) ||
      record.room_security !== (c.room.security >>> 0) ||
      !positive(record.observed_at) || record.observed_at > now || now - record.observed_at > MAX_AGE_MS ||
      !positive(record.expires_at) || record.expires_at <= now || record.expires_at > record.observed_at + MAX_AGE_MS ||
      !positive(holder?.id) || !fold(holder?.name) || !placed(holder) ||
      !positive(item?.id) || !placed(item) || !isFarmFoodCacheItem(item?.name) ||
      distance(holder, item) > FARM_FOOD_CACHE_RADIUS) return null;

  const ids = c.idsAsOf?.();
  if (ids?.last_save_began_at >= record.observed_at) return null;
  const pile = c.room.objects.get(item.id);
  if (!(pile?.flags & OF.GETTABLE) || pile.predicted || !placed(pile) || distance(pile, item) ||
      nameOf(c, pile) !== fold(item.name) || !positive(pile.amount)) return null;
  if (!forWithdrawal) return pile;

  // Leaving an exact stack alone needs no proof about our pack, body, or distance.
  // Sending a counted get requires current handles and a still-present ward holder.
  if (!idsCurrent(ids) || c.idsTrackedSince > record.observed_at ||
      !placed(c.self) || distance(c.self, holder) > FARM_FOOD_CACHE_RADIUS) return null;
  const anchor = c.room.objects.get(holder.id);
  return (anchor?.flags & OF.PLAYER) && !anchor.predicted && placed(anchor) && !distance(anchor, holder) &&
    nameOf(c, anchor) === fold(holder.name) ? pile : null;
}
