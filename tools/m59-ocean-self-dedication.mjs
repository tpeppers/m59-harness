import { idsCurrent } from './m59-idgen.mjs';
import { liveMoveOrder } from './m59-move-origin.mjs';
import { sendRecoverySpell } from './m59-recovery-cast.mjs';
import { brokenSet, isArmed, isBannedWeapon, isCursedItem, isOwnSummon } from './m59-skills.mjs';
import { stationaryTradeActive } from './m59-stationary-trade.mjs';
import { currentSurvivalDecision, isActiveRecoveryDecision } from './m59-survival-decision.mjs';
import { classifyWeapon } from './m59-weapon-magic.mjs';

const ROOM = 552;
const SPELL = 'enchant weapon';
const MANA = 17;
const RETRY_MS = 60_000;
const PROOF_MS = 50_000;
const SEND_WINDOW_MS = 6000;
const good = new Set(['flawless', 'excellent', 'good']);
const usable = new Set([...good, 'notched']);
const states = new WeakMap();
const nameOf = (c, o) => String(c.rsc.get(o?.nameRsc) ?? o?.name ?? '').trim().toLowerCase();

function safeToDedicate(pilot, s, c, now) {
  const health = c?.vitals()?.health;
  return pilot.mode === 'farm' && pilot.policy?.assignedRoom === ROOM && !pilot.policy.neverAttack &&
    pilot.policy.molluskCoverRecovery === true && s.world?.room?.num === ROOM &&
    s.live && c?.state === 'game' && c.combatReady && c.self && !c.self.predicted &&
    health?.max > 0 && health.value === health.max && !(s.damagedAt > now - 5000) &&
    !pilot.stopping && !pilot.inert && !pilot.suspendedJourney && !pilot.recoverUntilWhole &&
    !(pilot.frozenUntil > now) && !(s.job && !s.job.done) && !liveMoveOrder(s) &&
    !s.keeperRecoveryTravel && !s.combat?.active && !s._rite && !c.trade && !stationaryTradeActive(s) &&
    !c.ailments?.()?.length && !isActiveRecoveryDecision(currentSurvivalDecision(s)) &&
    !pilot.playerThreatPresent() && !pilot.facultyHeld('work') && !pilot.facultyHeld('movement') &&
    !pilot.facultyHeld('economy') && !!pilot.currentRecoveryWall();
}

function canPay(c) {
  const vitals = c.vitals();
  if (!(vitals?.mana?.value >= MANA && vitals?.vigor?.value >= 140)) return false;
  let berries = 0, teeth = 0;
  for (const item of c.inventory ?? []) {
    const name = nameOf(c, item);
    if (name === 'elderberry') berries += Number(item.amount) || 1;
    if (name === 'orc tooth') teeth += Number(item.amount) || 1;
  }
  return berries >= 3 && teeth >= 1;
}

async function lookExact(s, c, id, valid) {
  const since = c.evSeq;
  let sent = false;
  await s.pacer.submit('look', () => {
    if (!valid()) return;
    sent = true;
    c.look(id);
  }).catch(() => {});
  if (!sent) return null;
  const reply = await c.waitFor({ since, kinds: ['look'], timeoutMs: 1400,
    match: e => e.id === id }).catch(() => null);
  return reply?.events?.find(e => e.kind === 'look' && e.id === id)?.description ?? null;
}

export async function tryOceanSelfDedication(pilot, { now = Date.now, send = sendRecoverySpell } = {}) {
  const s = pilot.s, c = s.client;
  if (!c) return false;
  let state = states.get(c);
  const hold = s.pacer?.holdStatus?.();
  if (state?.pending) {
    const { id, name, began, stillOwned } = state.pending;
    const finish = (confirmed, reason) => {
      state.pending = null;
      pilot.ledgerEvent('ocean_self_dedication', { room: ROOM, id, item: name, confirmed, reason });
    };
    if (!stillOwned() || now() - began > PROOF_MS) {
      if (hold?.active && hold.auto && hold.spell === SPELL)
        s.pacer.breakTrance?.('Ocean self-dedication lost its verified weapon');
      finish(false, 'weapon handle, body or observation window changed');
      return false;
    }
    if (hold?.active) {
      // This hold is local to our cast. A fresh hazard always yields to survival.
      if (hold.auto && hold.spell === SPELL && !safeToDedicate(pilot, s, c, now()))
        s.pacer.breakTrance?.('Ocean self-dedication lost cover or ownership');
      return false;
    }
    if (!safeToDedicate(pilot, s, c, now())) return false;
    const desc = await lookExact(s, c, id, stillOwned);
    if (!desc || !stillOwned()) return false;
    const reading = pilot.weaponMagicBook().record(id, name, desc);
    pilot.saveWeaponMagic?.();
    const confirmed = reading.class === 'enchanted' && reading.made === false && usable.has(reading.condition);
    finish(confirmed, confirmed ? 'exact LOOK confirmed a durable Kraanan dedication' : 'exact LOOK shows no usable dedication');
    return false;
  }

  if (s.world?.room?.num !== ROOM || pilot.mode !== 'farm' || (state?.nextAt ?? -Infinity) > now() || hold?.active ||
      !Array.isArray(c.inventory) || !c.equipment?.()?.known || !isArmed(c) || !idsCurrent(c.idsAsOf?.()) || !canPay(c))
    return false;
  const spell = c.spells?.find(sp => nameOf(c, sp) === SPELL && (sp.numTargets ?? sp.targets) === 1);
  if (!spell || !safeToDedicate(pilot, s, c, now())) return false;
  const book = pilot.weaponMagicBook();
  const pack = pilot.packWeapons(c);
  book.reconcile(pack);
  const broken = brokenSet(c);
  if (pack.some(o => {
    const known = book.readings.get(o.id);
    return !broken.has(o.id) && known?.class === 'enchanted' && !known.made && usable.has(known.condition);
  })) return false;
  const target = c.inventory.find(o => {
    if (nameOf(c, o) !== 'axe' || o.rarity !== 0 || broken.has(o.id) ||
        isCursedItem(c, o, 'axe') || isOwnSummon(c, o) || isBannedWeapon('axe', pilot.bannedWeaponsNow?.())) return false;
    const known = book.readings.get(o.id);
    return !known || known.class === 'unknown' ||
      (known.class === 'mundane' && !known.made && (!known.condition || good.has(known.condition)));
  });
  if (!target) return false;
  state = { nextAt: now() + RETRY_MS, pending: null };
  states.set(c, state);
  const body = c.selfId, roomId = c.room.id, generation = c.idGenerations, movement = s.movementGeneration;
  const { id } = target, name = 'axe';
  const sendBy = now() + SEND_WINDOW_MS;
  const stillOwned = () => s.client === c && c.selfId === body && c.room?.id === roomId &&
    c.idGenerations === generation && idsCurrent(c.idsAsOf?.()) &&
    c.inventory?.some(o => o.id === id && nameOf(c, o) === name && o.rarity === 0 && !isCursedItem(c, o, name));
  const valid = () => now() < sendBy && !s.pacer?.holdStatus?.()?.active &&
    stillOwned() && !s.movementWasCancelled?.(movement) &&
    safeToDedicate(pilot, s, c, now()) && canPay(c) &&
    c.spells?.some(sp => sp.id === spell.id && nameOf(c, sp) === SPELL);
  const desc = await lookExact(s, c, id, valid);
  if (!desc || !stillOwned()) return false;
  const read = classifyWeapon({ name, look: desc });
  book.record(id, name, desc);
  pilot.saveWeaponMagic?.();
  if (read.class !== 'mundane' || read.made || !good.has(read.condition)) return false;
  // The Session opens an automatic hold on this exact cast. Do not await its
  // 30-second trance in the arming stage or freeze the protected survival ladder.
  const sent = await send(s, c, spell, [id], valid);
  if (!sent.sent) return false;
  state.pending = { id, name, began: now(), stillOwned };
  pilot.ledgerEvent('ocean_self_dedication_started', { room: ROOM, id, item: name });
  return true;
}
