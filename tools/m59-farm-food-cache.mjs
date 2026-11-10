// An operator registers one observed food pile. No manifest means no cache work.
import { molluskRockThreatAt } from './m59-casters.mjs';
import { dibsFile, dibsVerdict, itemKey, readDibs } from './m59-dibs.mjs';
import { boundFarmFoodPile, FARM_FOOD_CACHE_RADIUS as RADIUS, FARM_FOOD_CACHE_ROOM as ROOM,
  readFarmFoodCache } from './m59-farm-food-cache-record.mjs';
import { foodValue, weighItem } from './m59-items.mjs';
import { liveMoveOrder } from './m59-move-origin.mjs';
import { relayRestCap } from './m59-relay-farming.mjs';
import { carryCapacity, itemIsProtected, VIGOR_MAX } from './m59-skills.mjs';
import { currentSurvivalDecision, isActiveRecoveryDecision } from './m59-survival-decision.mjs';

const RETRY_GAP_MS = 10_000;
const attempts = new WeakMap();
const fold = value => String(value ?? '').trim().toLowerCase();
const positive = value => Number.isSafeInteger(value) && value > 0;
const placed = point => positive(point?.row) && positive(point?.col);
const distance = (a, b) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
const nameOf = (c, o) => c.rsc.get(o.nameRsc) ?? '';
const heldCount = (c, name) => c.inventory.reduce((count, o) =>
  count + (fold(nameOf(c, o)) === fold(name) ? Number(o.amount) || 1 : 0), 0);

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

function cachePortionAllowed(book, record, pile, character, now) {
  const { holder, item } = record;
  // The scoped stash keeps ordinary loot sweeps from taking the stack. It does
  // not exclude counted withdrawals from this exact, independently bound pile.
  const claims = (book?.claims ?? []).filter(claim => {
    const near = claim.near;
    return !(claim.source === 'floor-cache' && claim.room === record.room && claim.item === itemKey(item.name) &&
      claim.for.length === 1 && claim.for[0] === fold(holder.name) && near?.row === holder.row &&
      near.col === holder.col && near.radius <= RADIUS && distance(near, pile) <= near.radius);
  });
  return dibsVerdict({ book: { claims }, room: record.room, item: item.name, at: pile, character, now }).allowed;
}

export async function tryFarmFoodCache(pilot, {
  read = readFarmFoodCache, readClaims = () => readDibs(dibsFile()), now = Date.now,
} = {}) {
  const s = pilot.s, c = s.client;
  if (typeof c?.getFromContainer !== 'function' ||
      !eligibleBody(pilot, s, c, c.vitals(), now()) || (attempts.get(c) ?? -Infinity) > now() - RETRY_GAP_MS) return false;
  const record = read();
  if (!boundFarmFoodPile(s, c, record, now(), { forWithdrawal: true }) ||
      !canUsePortion(pilot, c, c.vitals(), record.item.name)) return false;
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
    const pile = boundFarmFoodPile(s, c, latest, current, { forWithdrawal: true });
    if (!pile || pile.id !== id || latest.item.name !== name || latest.observed_at !== record.observed_at ||
        latest.room_security !== record.room_security) return;
    const { casters, complete } = pilot.casterScene();
    const geo = s.world.geometry;
    if (!complete || !geo?.collisionReady || geo.security !== c.room.security ||
        geo.grid?.length !== geo.rows * geo.cols || geo.monsterGrid?.length !== geo.rows * geo.cols ||
        molluskRockThreatAt(geo, c.self, casters)) return;
    if (!cachePortionAllowed(readClaims(), latest, pile, [c.me?.name, s.name], current)) return;
    attempts.set(c, current);
    sent = true;
    // Opcode 239 passes the number to UserGet. Opcode 113 omits it and can take the entire floor stack.
    return c.getFromContainer({ id, amount: 1 });
  }).catch(() => {});
  if (!sent) return false;
  await c.waitFor({ since: seq, kinds: ['got', 'inventory'], timeoutMs: 1600,
    match: () => heldCount(c, name) === before + 1 }).catch(() => {});
  if (s.client !== c || c.idGenerations !== generation || c.room?.id !== roomObject || c.selfId !== body ||
      heldCount(c, name) !== before + 1) return false;
  pilot.ledgerEvent('farm_food_cache_withdrawal', { room: ROOM, item: name, amount: 1 });
  return true;
}
