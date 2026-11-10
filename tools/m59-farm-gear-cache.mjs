import { mollusksBlockedAt } from './m59-casters.mjs';
import { dibsFile, dibsVerdict, itemKey, readDibs } from './m59-dibs.mjs';
import { boundFarmGearPiles, FARM_GEAR_CACHE_RADIUS as RADIUS, FARM_GEAR_CACHE_ROOM as ROOM,
  readFarmGearCache } from './m59-farm-gear-cache-record.mjs';
import { weighItem } from './m59-items.mjs';
import { liveMoveOrder } from './m59-move-origin.mjs';
import { OF } from './m59-parse.mjs';
import { armourKind, brokenSet, carryCapacity, isArmed, isBannedWeapon, isCursedItem,
  parseConditionLevel } from './m59-skills.mjs';
import { stationaryTradeActive } from './m59-stationary-trade.mjs';
import { currentSurvivalDecision, isActiveRecoveryDecision } from './m59-survival-decision.mjs';

const RETRY_GAP_MS = 15_000;
const FAILED_LOOK_RETRY_MS = 60_000;
const attempts = new WeakMap();
const fold = value => String(value ?? '').trim().toLowerCase();
const distance = (a, b) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col);

function eligible(pilot, s, c, now) {
  const hp = c?.vitals()?.health;
  return pilot.mode === 'farm' && pilot.policy?.assignedRoom === ROOM && !pilot.policy.neverAttack &&
    s.world?.room?.num === ROOM && s.live && c?.combatReady && c.state === 'game' && c.room?.objects &&
    hp?.max > 0 && hp.value === hp.max && c.self && !c.self.predicted &&
    !pilot.stopping && !pilot.inert && !pilot.suspendedJourney && !pilot.recoverUntilWhole &&
    !(pilot.frozenUntil > now) && !(s.job && !s.job.done) && !liveMoveOrder(s) &&
    !s.keeperRecoveryTravel && !s.combat?.active && !s._rite && !c.trade && !stationaryTradeActive(s) &&
    !s.pacer?.holdStatus?.()?.active &&
    !c.ailments?.()?.length && !(s.damagedAt > now - 5000) &&
    !isActiveRecoveryDecision(currentSurvivalDecision(s)) &&
    !pilot.facultyHeld('work') && !pilot.facultyHeld('movement') && !pilot.facultyHeld('economy');
}

function needsGear(pilot, c, name) {
  const eq = c.equipment?.();
  if (!eq?.known || !Array.isArray(c.inventory)) return false;
  const nameOf = o => fold(o.name ?? c.rsc.get(o.nameRsc));
  const broken = brokenSet(c);
  if ([...c.inventory, ...eq.equipped].some(o => nameOf(o) === name && !broken.has(o.id))) return false;
  if (name === 'axe' && isBannedWeapon(name, pilot.bannedWeaponsNow?.())) return false;
  // Existing sound body armour stays on. This cache supplies missing gear, not a refit.
  if (name === 'leather armor' && eq.equipped.some(o => armourKind(nameOf(o))?.slot === 'armour' && !broken.has(o.id)))
    return false;
  const free = carryCapacity(c).room_for;
  const unit = weighItem(name);
  return !!(free && unit && free.weight >= unit.weight && free.bulk >= unit.bulk);
}

function wardQuiet(pilot, s, c) {
  if (pilot.playerThreatPresent() || pilot.inReachOfUs().length) return false;
  const { casters, complete } = pilot.casterScene();
  const geo = s.world.geometry;
  return complete && geo?.collisionReady && geo.security === c.room.security &&
    geo.grid?.length === geo.rows * geo.cols && geo.monsterGrid?.length === geo.rows * geo.cols &&
    (casters.length === 0 || mollusksBlockedAt(geo, c.self, casters));
}

function cacheDibsAllow(book, record, item, character, now) {
  // Bypass only the holder's own scoped cache stash, never an unrelated reservation.
  const holder = record.holder;
  const claims = (book?.claims ?? []).filter(claim => {
    const near = claim.near;
    return !(claim.source === 'floor-cache' && claim.room === ROOM && claim.item === itemKey(item.name) &&
      claim.for.length === 1 && claim.for[0] === fold(holder.name) && near?.row === holder.row &&
      near.col === holder.col && near.radius <= RADIUS && distance(near, item) <= near.radius);
  });
  return dibsVerdict({ book: { claims }, room: ROOM, item: item.name, at: item, character, now }).allowed;
}

export async function tryFarmGearCache(pilot, {
  read = readFarmGearCache, readClaims = () => readDibs(dibsFile()), now = Date.now,
} = {}) {
  const s = pilot.s, c = s.client;
  if (typeof c?.get !== 'function' || typeof c.look !== 'function' || !eligible(pilot, s, c, now()) ||
      (attempts.get(c)?.at ?? -Infinity) > now() - RETRY_GAP_MS ||
      ![...c.room.objects.values()].some(o => (o.flags & OF.PLAYER) && fold(c.rsc.get(o.nameRsc)) === 'statler' &&
        distance(c.self, o) <= RADIUS)) return false;
  const record = read();
  const prior = attempts.get(c);
  const failures = prior && prior.observedAt === record?.observed_at ? prior.failures : new Map();
  const character = [c.me?.name, s.name];
  const usableGround = item => {
    const o = c.room.objects.get(item.id);
    return o?.rarity === 0 && !isCursedItem(c, o, item.name);
  };
  const candidates = boundFarmGearPiles(s, c, record, now(), { forWithdrawal: true })
    .filter(o => !(failures.get(o.id) > now()) && usableGround(o) && needsGear(pilot, c, o.name));
  if (!candidates.length) return false;
  const claims = readClaims();
  const offered = candidates.filter(o => cacheDibsAllow(claims, record, o, character, now()));
  const item = (!isArmed(c) && offered.find(o => o.name === 'axe')) || offered[0];
  if (!item) return false;
  const { id, name } = item;
  const { id: roomId, security } = c.room, body = c.selfId, generation = c.idGenerations;
  const valid = () => {
    const current = now();
    if (s.client !== c || c.idGenerations !== generation || c.room?.id !== roomId || c.room.security !== security ||
        c.selfId !== body || !eligible(pilot, s, c, current) || !needsGear(pilot, c, name) || !wardQuiet(pilot, s, c))
      return false;
    const latest = read();
    const bound = boundFarmGearPiles(s, c, latest, current, { forWithdrawal: true })
      .some(o => o.id === id && o.name === name && o.row === item.row && o.col === item.col);
    return bound && latest.observed_at === record.observed_at && usableGround(item) &&
      cacheDibsAllow(readClaims(), latest, item, character, current);
  };
  let looked = false;
  const lookSince = c.evSeq;
  await s.pacer.submit('look', () => {
    if (!valid()) return;
    attempts.set(c, { at: now(), observedAt: record.observed_at, failures });
    looked = true;
    c.look(id);
  }).catch(() => {});
  if (!looked) return false;
  const reply = await c.waitFor({ since: lookSince, kinds: ['look'], timeoutMs: 1200,
    match: e => e.id === id }).catch(() => null);
  const desc = reply?.events?.find(e => e.kind === 'look' && e.id === id)?.description;
  if (!(parseConditionLevel(desc) >= 3)) {
    failures.set(id, now() + FAILED_LOOK_RETRY_MS);
    return false;
  }

  let sent = false;
  const beforeGet = c.evSeq;
  await s.pacer.submit('get', () => {
    if (!valid() || c.inventory.some(o => o.id === id)) return;
    sent = true;
    c.get(id);
  }).catch(() => {});
  if (!sent) return false;
  await c.waitFor({ since: beforeGet, kinds: ['got', 'inventory'], timeoutMs: 1400 }).catch(() => {});
  if (s.client !== c || c.idGenerations !== generation || c.room?.id !== roomId || c.selfId !== body ||
      !c.inventory.some(o => o.id === id && fold(c.rsc.get(o.nameRsc)) === name)) return false;
  if (name === 'axe') pilot.noteWeaponArrived?.([id]);
  else pilot.dressedAt = 0;
  pilot.ledgerEvent('farm_gear_cache_withdrawal', { room: ROOM, item: name, id });
  return true;
}
