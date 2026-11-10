// Ocean sale cargo belongs to Zheng only on the explicitly reserved ward tile.
// A matching floor receipt identifies the exact stack for the courier's pickup.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { molluskRockThreatAt } from './m59-casters.mjs';
import { walkPlan } from './m59-chase.mjs';
import { dibsFile, itemKey, liveClaims, readDibs } from './m59-dibs.mjs';
import { fleetName } from './m59-fleetpath.mjs';
import { idsCurrent } from './m59-idgen.mjs';
import { claimGift, releaseGift } from './m59-interest-store.mjs';
import { saleBlocked } from './m59-inventory-intent.mjs';
import { ITEM_RARITY, weighItem } from './m59-items.mjs';
import { annotateRow } from './m59-make-space.mjs';
import { liveMoveOrder } from './m59-move-origin.mjs';
import { dropSpec, OF } from './m59-parse.mjs';
import { reagentKey } from './m59-reagent-reserve.mjs';
import { carryCapacity, interest } from './m59-skills.mjs';
import { currentSurvivalDecision, isActiveRecoveryDecision } from './m59-survival-decision.mjs';

export const FARM_SALE_CACHE_ROOM = 552;
export const FARM_SALE_CACHE_ANCHOR = Object.freeze({ name: 'Statler', row: 43, col: 57 });
export const FARM_SALE_CACHE_DROP = Object.freeze({ row: 44, col: 56 });
export const FARM_SALE_CACHE_COURIER = 'Zheng He';
export const FARM_SALE_CACHE_EVENT = 'farm_sale_cache_deposit';
export const FARM_SALE_CACHE_ITEMS = Object.freeze(['blue mushroom', 'red mushroom']);
export const FARM_SALE_CACHE_WARD_SCHEMA = 'm59-farm-sale-cache-ward/1';
export const farmSaleCacheWardFile = (fleet = fleetName()) => process.env.M59_FARM_SALE_CACHE_WARD_FILE ||
  fileURLToPath(new URL(`../substrate/farm-sale-cache-ward-${fleet || 'default'}.json`, import.meta.url));
const floors = { 'blue mushroom': 24, 'red mushroom': 96 };
const scope = 'ocean-sale-cache';
const maxPiles = 5;
const maxSteps = 18;
const retryMs = 30_000;
const cacheLifeMs = 5 * 60_000;
const attempts = new WeakMap();
const same = (a, b) => !!a && !!b && a.row === b.row && a.col === b.col;
const placed = p => Number.isSafeInteger(p?.row) && Number.isSafeInteger(p?.col) && !p.predicted;
const within = (a, b, reach) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col) <= reach;
const nameOf = (c, o) => String(c.rsc.get(o.nameRsc) ?? '').trim().toLowerCase();
const amountOf = (c, name) => c.inventory.reduce((n, o) => n + (nameOf(c, o) === name ? o.amount || 1 : 0), 0);

export function readFarmSaleCacheWard(file = farmSaleCacheWardFile()) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

// The observer pins the broker's shared epoch. Native receive timestamps for
// one save vary by process, and a keeper that joined afterwards may have none.
function currentWardPin(c, pin, now) {
  const ids = c.idsAsOf?.();
  return pin?.schema === FARM_SALE_CACHE_WARD_SCHEMA && pin.room === FARM_SALE_CACHE_ROOM &&
    Number.isSafeInteger(c.room?.security) && pin.room_security === (c.room.security >>> 0) &&
    Number.isSafeInteger(pin.last_save_at) && pin.last_save_at > 0 &&
    Number.isSafeInteger(pin.observed_at) && pin.last_save_at <= pin.observed_at && pin.observed_at <= now &&
    Number.isSafeInteger(pin.expires_at) && pin.expires_at > now &&
    Number.isSafeInteger(pin.anchor?.id) && pin.anchor.id > 0 && pin.anchor.name === FARM_SALE_CACHE_ANCHOR.name &&
    same(pin.anchor, FARM_SALE_CACHE_ANCHOR) && idsCurrent(ids) && ids.inventory_at >= pin.last_save_at &&
    !(ids.last_save_began_at > pin.observed_at) && !(ids.last_save_at > pin.observed_at) &&
    !(ids.last_save_at > pin.last_save_at + 5000);
}

function authorizedClaim(book, name, now) {
  const covering = liveClaims(book, now).filter(claim => claim.room === FARM_SALE_CACHE_ROOM &&
    claim.item === itemKey(name) && (!claim.near || within(claim.near, FARM_SALE_CACHE_DROP, claim.near.radius)));
  const courier = FARM_SALE_CACHE_COURIER.toLowerCase();
  return covering.every(claim => claim.for.length === 1 && claim.for[0] === courier) &&
    covering.find(claim => claim.source === scope && same(claim.near, FARM_SALE_CACHE_DROP) &&
      claim.near.radius === 0 && Number.isFinite(claim.until) && claim.until > now + retryMs);
}

function eligibleBody(pilot, s, c, now, ownApproach = false) {
  const v = c?.vitals?.();
  return pilot.mode === 'farm' && pilot.policy?.townTrips === false &&
    pilot.policy.assignedRoom === FARM_SALE_CACHE_ROOM && !pilot.policy.neverAttack &&
    s.world?.room?.num === FARM_SALE_CACHE_ROOM && s.live && c?.combatReady && c.state === 'game' &&
    v?.health?.max > 0 && v.health.value === v.health.max && v.vigor?.value >= 140 && placed(c.self) &&
    !pilot.stopping && !pilot.inert && !pilot.suspendedJourney && !pilot.recoverUntilWhole &&
    !(pilot.frozenUntil > now) && !(s.job && !s.job.done) && (ownApproach || !liveMoveOrder(s)) &&
    !s.combat?.active && !s._rite && !c.trade && !s.pacer?.holdStatus?.()?.active &&
    !c.ailments?.()?.length && !(s.damagedAt > now - 5000) &&
    !isActiveRecoveryDecision(currentSurvivalDecision(s)) && !pilot.secondWindFarming?.()?.active &&
    !pilot.facultyHeld('work') && !pilot.facultyHeld('movement') && !pilot.facultyHeld('economy');
}

function ward(pilot, s, c) {
  const anchor = [...c.room.objects.values()].find(o => (o.flags & OF.PLAYER) && placed(o) &&
    same(o, FARM_SALE_CACHE_ANCHOR) && nameOf(c, o) === FARM_SALE_CACHE_ANCHOR.name.toLowerCase());
  const geo = s.world.geometry, scene = pilot.casterScene();
  if (!anchor || !Number.isSafeInteger(anchor.id) || !scene.complete || !geo?.collisionReady ||
      geo.security !== c.room.security || geo.grid?.length !== geo.rows * geo.cols ||
      geo.monsterGrid?.length !== geo.rows * geo.cols || pilot.playerThreatPresent()) return null;
  return { anchor, geo, casters: scene.casters };
}

function quietAt(c, scene, point) {
  if (!placed(point) || !scene.geo.inBounds(point.row, point.col) || molluskRockThreatAt(scene.geo, point, scene.casters)) return false;
  return ![...c.room.objects.values()].some(o => (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
    (!placed(o) || Math.hypot(o.row - point.row, o.col - point.col) <= 3));
}

function wardPiles(c) {
  return [...c.room.objects.values()].filter(o => (o.flags & OF.GETTABLE) && placed(o) &&
    within(o, FARM_SALE_CACHE_ANCHOR, 3));
}

function reservedForFleet(records, name) {
  let demand = 0;
  for (const row of records.values()) for (const [wanted, amount] of row.needs ?? [])
    if (reagentKey(wanted) === name && Number.isFinite(amount) && amount > 0) demand += amount;
  return demand;
}

function chooseParcel(pilot, c, book, now, state) {
  const plan = pilot.ownSalePlan();
  if (!plan || plan.error) return null;
  const demands = interest.records();
  const heldBack = pilot.heldBackIds?.() ?? new Set();
  for (const name of FARM_SALE_CACHE_ITEMS) {
    if (!authorizedClaim(book, name, now)) continue;
    const keep = floors[name] + reservedForFleet(demands, name);
    for (const row of plan.items ?? []) {
      if (itemKey(row.name) !== name || state.blocked.has(row.id)) continue;
      const item = c.inventory.find(o => o.id === row.id && o.rarity === ITEM_RARITY.NORMAL && nameOf(c, o) === name);
      const allowed = annotateRow(row, { heldBack });
      const amount = Math.min(60, allowed.sale_amount, item?.amount ?? 0, amountOf(c, name) - keep);
      if (allowed.droppable && Number.isSafeInteger(amount) && amount > 0 &&
          amount * weighItem(name).bulk >= 80) return { id: item.id, name, amount, keep };
    }
  }
  return null;
}

async function readRoom(s, c) {
  const since = c.evSeq;
  await s.pacer.submit('read', () => c.roomContents());
  const r = await c.waitFor({ since, kinds: ['room-contents'], timeoutMs: 1700 });
  return r.events?.some(event => event.kind === 'room-contents');
}

export async function tryFarmSaleCache(pilot, {
  readClaims = () => readDibs(dibsFile()), readWard = readFarmSaleCacheWard,
  now = Date.now, acquire = claimGift, release = releaseGift,
} = {}) {
  const s = pilot.s, c = s.client;
  if (!eligibleBody(pilot, s, c, now())) return false;
  const book = readClaims();
  if (!FARM_SALE_CACHE_ITEMS.some(name => authorizedClaim(book, name, now()))) return false;
  const pin = readWard();
  if (!currentWardPin(c, pin, now())) return false;
  const generation = c.idGenerations, self = c.selfId, roomObject = c.room.id;
  const sameBody = () => s.client === c && c.idGenerations === generation && c.room?.id === roomObject && c.selfId === self &&
    currentWardPin(c, pin, now());
  let state = attempts.get(c);
  if (!state || state.generation !== generation) {
    state = { generation, at: -Infinity, blocked: new Set() };
    attempts.set(c, state);
  }
  if (now() - state.at < retryMs) return false;
  const atDrop = same(c.self, FARM_SALE_CACHE_DROP);
  if (!atDrop) {
    if (Math.hypot(c.self.row - FARM_SALE_CACHE_DROP.row, c.self.col - FARM_SALE_CACHE_DROP.col) > maxSteps) return false;
    const cap = carryCapacity(c);
    if (!cap.room_for || (cap.room_for.bulk >= 240 && cap.room_for.weight >= 190)) return false;
  }
  const scene = ward(pilot, s, c);
  if (!scene || scene.anchor.id !== pin.anchor.id || !quietAt(c, scene, c.self) ||
      !quietAt(c, scene, FARM_SALE_CACHE_DROP) || wardPiles(c).length >= maxPiles) return false;
  const planned = chooseParcel(pilot, c, book, now(), state);
  if (!planned) return false;

  if (!atDrop) {
    const path = walkPlan(scene.geo, c.self, FARM_SALE_CACHE_DROP, { maxNodes: 400 });
    if (!path.found || path.goal_exempt || !path.steps?.length || path.steps.length > maxSteps ||
        path.steps.some(step => !quietAt(c, scene, step))) return false;
    const allowed = new Set(path.steps.map(step => `${step.row},${step.col}`));
    const movementGeneration = s.movementGeneration;
    state.at = now();
    await s.walkTo(FARM_SALE_CACHE_DROP.col, FARM_SALE_CACHE_DROP.row, {
      maxSteps, hardCap: maxSteps, doors: false, movementGeneration,
      beforeMutation: (_kind, step) => {
        const current = sameBody() && eligibleBody(pilot, s, c, now(), true) && ward(pilot, s, c);
        return !!current && current.anchor.id === scene.anchor.id &&
          allowed.has(`${step?.row},${step?.col}`) && quietAt(c, current, c.self) && quietAt(c, current, step);
      },
    }).catch(() => null);
    if (!same(c.self, FARM_SALE_CACHE_DROP)) return true;
  }

  const giver = `${s.name ?? c.me?.name}@${process.pid}`;
  const lock = [giver, scope, 'deposit'];
  if (!acquire(...lock, { ttlMs: 15_000, now: now() })) return false;
  let sent = false;
  try {
    if (!sameBody() || !await readRoom(s, c)) return false;
    let proof = null;
    const seq = c.evSeq;
    await s.pacer.submit('drop', () => {
      const current = sameBody() && eligibleBody(pilot, s, c, now()) && ward(pilot, s, c);
      const latest = readWard();
      if (!current || !currentWardPin(c, latest, now()) || latest.last_save_at !== pin.last_save_at ||
          latest.observed_at !== pin.observed_at || latest.anchor.id !== pin.anchor.id ||
          current.anchor.id !== pin.anchor.id || !same(c.self, FARM_SALE_CACHE_DROP) ||
          !quietAt(c, current, c.self) || wardPiles(c).length >= maxPiles) return;
      const claims = readClaims();
      const claim = authorizedClaim(claims, planned.name, now());
      const parcel = claim && chooseParcel(pilot, c, claims, now(), state);
      const item = c.inventory.find(o => o.id === planned.id);
      if (!parcel || parcel.id !== planned.id || parcel.amount !== planned.amount || !item ||
          saleBlocked(s, { id: planned.id, name: planned.name })) return;
      const at = now();
      proof = { before: amountOf(c, parcel.name), absent: new Set(c.room.objects.keys()),
        expires_at: Math.min(at + cacheLifeMs, claim.until, latest.expires_at), parcel };
      state.at = at;
      sent = true;
      return c.drop([dropSpec(item, parcel.amount)]);
    }).catch(() => {});
    if (!sent) return false;
    await c.waitFor({ since: seq, kinds: ['appeared', 'message'], timeoutMs: 1400 }).catch(() => null);
    const inventorySeq = c.evSeq;
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    const reply = await c.waitFor({ since: inventorySeq, kinds: ['inventory'], timeoutMs: 2000 }).catch(() => null);
    const { parcel, before, absent, expires_at } = proof;
    const current = sameBody() && ward(pilot, s, c);
    const appeared = new Set(c.eventsSince(seq).filter(event => event.kind === 'appeared').map(event => event.id));
    const added = current ? wardPiles(c).filter(o => !absent.has(o.id) && appeared.has(o.id) && same(o, FARM_SALE_CACHE_DROP) &&
      nameOf(c, o) === parcel.name && o.amount === parcel.amount) : [];
    if (!reply?.events?.some(event => event.kind === 'inventory') || !current || current.anchor.id !== scene.anchor.id ||
        added.length !== 1 || amountOf(c, parcel.name) !== before - parcel.amount) {
      state.blocked.add(parcel.id);
      pilot.ledgerEvent('farm_sale_cache_unverified', { room: FARM_SALE_CACHE_ROOM, item: parcel.name, amount: parcel.amount });
      return true;
    }
    const observed_at = now();
    pilot.ledgerEvent(FARM_SALE_CACHE_EVENT, {
      room: FARM_SALE_CACHE_ROOM, room_security: pin.room_security, last_save_at: pin.last_save_at,
      anchor: { id: current.anchor.id, ...FARM_SALE_CACHE_ANCHOR }, courier: FARM_SALE_CACHE_COURIER,
      item: { id: added[0].id, name: parcel.name, amount: parcel.amount, ...FARM_SALE_CACHE_DROP }, observed_at, expires_at,
    });
    return true;
  } finally {
    release(...lock);
  }
}
