import { recordEvent } from './m59-ledger.mjs';

const CURSE = "Kara'hol's curse";
const EXHAUSTION = /^Your body freezes as total exhaustion grips your limbs\.$/i;
const HOLD_START = /^A magical tingling pulses through your body\./i;
const HOLD_END = /^The magical hold lifts/i;
const HOLD_PACKET_WINDOW_MS = 2500;
const HOLD_CARRY_AGE_MS = 20_000;
const LOGIN_PROOF_MS = 10_000;
const HOLD_REPLAY_SETTLE_MS = 150;
const captures = new WeakMap();
const isHold = e => e?.type === 1 && String(e.name).trim().toLowerCase() === 'hold';
const nameKey = name => String(name ?? '').trim().toLowerCase();

export function isKaraholCurse(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z]/g, '') === 'karaholscurse';
}

export function watchKaraholHold(pilot, { strategy, farmStrategy }) {
  const client = pilot.s.client;
  if (!client || client.onFarmBuffEvent || client.enchantments?.().some(e => isKaraholCurse(e.name))) return;
  observeKaraholHold(pilot, client, { strategy, farmStrategy });
}

export function prepareKaraholHoldReconnect(session, offlineMs, record = recordEvent) {
  const captured = captures.get(session.client)?.();
  if (!captured || session.client.attach) return null;
  const { character, host, port } = session.credentials ?? {};
  if (!character || !host || !Number.isFinite(Number(port)) ||
      nameKey(session.client.me?.name) !== nameKey(character)) return null;
  const deadline = Date.now() + offlineMs + LOGIN_PROOF_MS;
  return (client, identity) => {
    if (Date.now() > deadline || nameKey(identity.character) !== nameKey(character) ||
        nameKey(identity.host) !== nameKey(host) || Number(identity.port) !== Number(port)) return;
    observeKaraholHold(captured.pilot, client, captured, { ...captured, character, deadline, record });
  };
}

function observeKaraholHold(pilot, client, { strategy, farmStrategy }, previous = null) {
  const s = pilot.s;
  const startedAt = Date.now();
  let hp = previous ? null : client.vitals?.()?.health?.value;
  let curseApplied = false, hold = null, holdAt = previous?.holdAt ?? null, confirmed = false;
  const pendingDamage = [];
  let replayTimer = null;

  const stop = () => {
    clearTimeout(replayTimer);
    if (client.onFarmBuffEvent === observe) client.onFarmBuffEvent = null;
    captures.delete(client);
  };
  const sameBody = () => client.inGame && nameKey(client.me?.name) === nameKey(previous.character) &&
    client.selfId === previous.bodyId && client.room?.id === previous.roomId;
  const damage = (event, before) => {
    const lost = before - event.value;
    pilot.tally.karahol_hold_damage_events = (pilot.tally.karahol_hold_damage_events ?? 0) + 1;
    pilot.tally.karahol_hold_damage_hp = (pilot.tally.karahol_hold_damage_hp ?? 0) + lost;
    const row = {
      strategy, farm_strategy: farmStrategy, agent: s.name, room: 552, source: CURSE, review_required: true,
      hp_before: before, hp_after: event.value, hp_max: event.max ?? null, hp_lost: lost,
      observed_at: event.at, hold_at: holdAt, fatal: event.value === 0,
      ...(previous ? { observed_after_reconnect: true } : {}),
    };
    if (previous && s.client !== client) previous.record(client.me.name, 'karahol_hold_damage', row);
    else pilot.ledgerEvent('karahol_hold_damage', row);
  };
  const observe = event => {
    const wrongConnection = previous
      ? (s.client && s.client !== client) || (client.inGame && !sameBody()) || (!confirmed && event.at > previous.deadline)
      : s.client !== client || s.world?.room?.num !== 552 ||
        (!curseApplied && event.at - startedAt > 5000) || (!confirmed && event.at - startedAt > 120_000);
    const message = event.kind === 'message' ? String(event.text ?? '').trim() : '';
    if (wrongConnection || pilot.policy?.farmStrategy !== farmStrategy ||
        ((hold || previous) && HOLD_END.test(message)) ||
        (previous && (HOLD_START.test(message) || EXHAUSTION.test(message)))) {
      stop();
      return;
    }
    if (previous && event.kind === 'enchantment' && isHold(event.added)) {
      if (!sameBody() || hold || event.added.id !== previous.holdId ||
          !(client.enchantmentsRequestedAt >= startedAt && event.at >= client.enchantmentsRequestedAt)) {
        stop();
        return;
      }
      hold = event.added;
      // A fresh Hold sends personal onset prose after its icon; the requested replay only
      // sends icons. Keep early new-socket HP pushes provisional through that distinction.
      replayTimer = setTimeout(() => {
        if (!sameBody() || (s.client && s.client !== client) || pilot.policy?.farmStrategy !== farmStrategy ||
            !client.enchantments?.().includes(hold)) { stop(); return; }
        confirmed = true;
        for (const [hit, before] of pendingDamage) damage(hit, before);
        pendingDamage.length = 0;
        if (hp === 0) stop();
      }, HOLD_REPLAY_SETTLE_MS);
      replayTimer.unref?.();
    } else if (!previous && event.kind === 'enchantment' && event.added) {
      if (isKaraholCurse(event.added.name)) curseApplied = true;
      else if (curseApplied && isHold(event.added)) {
        hold = event.added;
        holdAt = event.at;
        confirmed = false;
      }
    }
    // Karahol's EndEnchantment applies Hold before sending this unique exhaustion line.
    if (!previous && hold && event.at - holdAt <= HOLD_PACKET_WINDOW_MS &&
        EXHAUSTION.test(message) && client.enchantments?.().includes(hold)) confirmed = true;
    if (confirmed && !client.enchantments?.().includes(hold)) { stop(); return; }
    if (event.kind !== 'stat' || event.name !== 'health' || !Number.isFinite(event.value)) return;

    if (previous && !sameBody()) return;
    if (Number.isFinite(hp) && event.value < hp) {
      if (confirmed) damage(event, hp);
      else if (previous && pendingDamage.length < 16) pendingDamage.push([event, hp]);
    }
    hp = event.value;
    if (hp <= 0 && (!previous || confirmed)) stop();
  };
  client.onFarmBuffEvent = observe;
  if (!previous) captures.set(client, () => {
    if (!confirmed || !(hp > 0) || Date.now() - holdAt > HOLD_CARRY_AGE_MS ||
        s.world?.room?.num !== 552 || pilot.policy?.farmStrategy !== farmStrategy ||
        !client.enchantments?.().includes(hold) ||
        ![client.selfId, client.room?.id, hold.id].every(Number.isInteger)) return null;
    return { pilot, strategy, farmStrategy, holdId: hold.id, holdAt, bodyId: client.selfId, roomId: client.room.id };
  });
}
