// An operator registers one observed food pile. No manifest means no cache work.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { molluskRockThreatAt } from './m59-casters.mjs';
import { dibsFile, dibsVerdict, readDibs } from './m59-dibs.mjs';
import { fleetName } from './m59-fleetpath.mjs';
import { idsCurrent } from './m59-idgen.mjs';
import { foodValue, weighItem } from './m59-items.mjs';
import { liveMoveOrder } from './m59-move-origin.mjs';
import { OF } from './m59-parse.mjs';
import { relayRestCap } from './m59-relay-farming.mjs';
import { carryCapacity, itemIsProtected, VIGOR_MAX } from './m59-skills.mjs';
import { currentSurvivalDecision, isActiveRecoveryDecision } from './m59-survival-decision.mjs';

const ROOM = 552;
const RADIUS = 3;
const MAX_AGE_MS = 5 * 60_000;
const RETRY_GAP_MS = 10_000;
const FOODS = new Set(['loaf of bread', 'meat pie', 'wheel of cheese', 'inky-cap mushroom']);
const attempts = new WeakMap();
const fold = value => String(value ?? '').trim().toLowerCase();
const positive = value => Number.isSafeInteger(value) && value > 0;
const placed = point => positive(point?.row) && positive(point?.col);
const distance = (a, b) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
const nameOf = (c, o) => c.rsc.get(o.nameRsc) ?? '';
const heldCount = (c, name) => c.inventory.reduce((count, o) =>
  count + (fold(nameOf(c, o)) === fold(name) ? Number(o.amount) || 1 : 0), 0);

export const farmFoodCacheFile = (fleet = fleetName()) => process.env.M59_FARM_FOOD_CACHE_FILE ||
  fileURLToPath(new URL(`../substrate/farm-food-cache-${fleet || 'default'}.json`, import.meta.url));

export function readFarmFoodCache(file = farmFoodCacheFile()) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

function eligibleBody(pilot, s, c, v, now) {
  const vigor = v?.vigor?.value, health = v?.health;
  const cap = relayRestCap(v) ?? 80;
  return pilot.mode === 'farm' && pilot.policy?.assignedRoom === ROOM && !pilot.policy.neverAttack &&
    s.world?.room?.num === ROOM && s.live && c?.combatReady && c.state === 'game' &&
    Number.isFinite(vigor) && vigor >= cap &&
    health?.max > 0 && health.value === health.max && placed(c.self) && !c.self.predicted &&
    !pilot.stopping && !pilot.inert && !pilot.suspendedJourney && !pilot.recoverUntilWhole &&
    !(pilot.frozenUntil > now) && !(s.job && !s.job.done) && !liveMoveOrder(s) &&
    !s.combat?.active && !s._rite && !c.trade && !s.pacer?.holdStatus?.()?.active &&
    !c.ailments?.()?.length && !(s.damagedAt > now - 5000) &&
    !isActiveRecoveryDecision(currentSurvivalDecision(s)) &&
    !pilot.secondWindFarming?.()?.active && !pilot.facultyHeld('work') &&
    !pilot.facultyHeld('movement') && !pilot.facultyHeld('economy');
}

function boundPile(s, c, record, now) {
  const holder = record?.holder, item = record?.item, ids = c.idsAsOf?.();
  if (record?.schema !== 'm59-farm-food-cache/1' || record.room !== ROOM ||
      fold(record.server?.host) !== fold(s.credentials?.host) || !fold(s.credentials?.host) ||
      record.server?.port !== Number(s.credentials?.port) || !positive(record.server?.port) ||
      !Number.isSafeInteger(record.room_security) || !Number.isSafeInteger(c.room?.security) ||
      record.room_security !== (c.room.security >>> 0) ||
      !positive(record.observed_at) || record.observed_at > now || now - record.observed_at > MAX_AGE_MS ||
      !positive(record.expires_at) || record.expires_at <= now || record.expires_at > record.observed_at + MAX_AGE_MS ||
      !ids || !idsCurrent(ids) || ids.last_save_began_at >= record.observed_at || c.idsTrackedSince > record.observed_at ||
      !positive(holder?.id) || !fold(holder?.name) || !placed(holder) ||
      !positive(item?.id) || !placed(item) || !FOODS.has(fold(item?.name)) ||
      distance(holder, item) > RADIUS || distance(c.self, holder) > RADIUS) return null;

  const anchor = c.room.objects.get(holder.id), pile = c.room.objects.get(item.id);
  if (!(anchor?.flags & OF.PLAYER) || anchor.predicted || !placed(anchor) || distance(anchor, holder) ||
      fold(nameOf(c, anchor)) !== fold(holder.name) ||
      !(pile?.flags & OF.GETTABLE) || pile.predicted || !placed(pile) || distance(pile, item) ||
      fold(nameOf(c, pile)) !== fold(item.name) || !positive(pile.amount)) return null;
  return pile;
}

function canUsePortion(pilot, c, v, name) {
  const { value: vigor } = v.vigor;
  const ceiling = pilot.policy.vigorCeiling ?? VIGOR_MAX;
  const stomach = pilot.stomach;
  const fitsMeal = food => food && vigor + food.nutrition <= ceiling && stomach?.roomFor(food.filling);
  if (!fitsMeal(foodValue(name)) || itemIsProtected(name, pilot.notOursToEat?.()) || heldCount(c, name) > 0 ||
      pilot.larder(c).some(row => !row.held &&
        (!pilot.policy.relayBeforeRest || fold(row.name) !== 'edible mushroom') && fitsMeal(row.food))) return false;
  const free = carryCapacity(c).room_for;
  const unit = weighItem(name);
  return !!(free && unit && free.weight >= unit.weight && free.bulk >= unit.bulk);
}

export async function tryFarmFoodCache(pilot, { read = readFarmFoodCache, now = Date.now } = {}) {
  const s = pilot.s, c = s.client;
  if (typeof c?.getFromContainer !== 'function' ||
      !eligibleBody(pilot, s, c, c.vitals(), now()) || (attempts.get(c) ?? -Infinity) > now() - RETRY_GAP_MS) return false;
  const record = read();
  if (!boundPile(s, c, record, now()) || !canUsePortion(pilot, c, c.vitals(), record.item.name)) return false;
  const { id, name } = record.item;
  const generation = c.idGenerations, roomObject = c.room.id, body = c.selfId;
  const before = heldCount(c, name);
  const seq = c.evSeq;
  let sent = false;
  await s.pacer.submit('get', () => {
    const v = c.vitals(), current = now();
    if (s.client !== c || c.idGenerations !== generation || c.room.id !== roomObject || c.selfId !== body ||
        !eligibleBody(pilot, s, c, v, current) || !canUsePortion(pilot, c, v, name) ||
        heldCount(c, name) !== before || pilot.playerThreatPresent() || pilot.inReachOfUs().length) return;
    const latest = read();
    const pile = boundPile(s, c, latest, current);
    if (!pile || pile.id !== id || latest.item.name !== name || latest.observed_at !== record.observed_at ||
        latest.room_security !== record.room_security) return;
    const { casters, complete } = pilot.casterScene();
    const geo = s.world.geometry;
    if (!complete || !geo?.collisionReady || geo.security !== c.room.security ||
        geo.grid?.length !== geo.rows * geo.cols || geo.monsterGrid?.length !== geo.rows * geo.cols ||
        molluskRockThreatAt(geo, c.self, casters)) return;
    if (!dibsVerdict({ book: readDibs(dibsFile()), room: ROOM, item: name, at: pile,
      character: [c.me?.name, s.name], now: current }).allowed) return;
    attempts.set(c, current);
    sent = true;
    // Opcode 239 passes the number to UserGet. Opcode 113 omits it and can take the entire floor stack.
    return c.getFromContainer({ id, amount: 1 });
  }).catch(() => {});
  if (!sent) return false;
  await c.waitFor({ since: seq, kinds: ['got', 'message'], timeoutMs: 1400 }).catch(() => {});
  if (s.client !== c || c.idGenerations !== generation || c.room?.id !== roomObject || c.selfId !== body ||
      heldCount(c, name) !== before + 1) return false;
  pilot.ledgerEvent('farm_food_cache_withdrawal', { room: ROOM, item: name, amount: 1 });
  return true;
}
