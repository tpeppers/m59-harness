const CURSE = "Kara'hol's curse";
const EXHAUSTION = /^Your body freezes as total exhaustion grips your limbs\.$/i;
const HOLD_PACKET_WINDOW_MS = 2500;

export function isKaraholCurse(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z]/g, '') === 'karaholscurse';
}

export function watchKaraholHold(pilot, { strategy, farmStrategy }) {
  const s = pilot.s, client = s.client;
  if (!client || client.onFarmBuffEvent || client.enchantments?.().some(e => isKaraholCurse(e.name))) return;
  const startedAt = Date.now();
  let hp = client.vitals?.().health?.value, curseApplied = false, hold = null, holdAt = null, confirmed = false;

  const stop = () => { if (client.onFarmBuffEvent === observe) client.onFarmBuffEvent = null; };
  const observe = event => {
    if (s.client !== client || s.world?.room?.num !== 552 || pilot.policy?.farmStrategy !== farmStrategy ||
        (!curseApplied && event.at - startedAt > 5000) || (!confirmed && event.at - startedAt > 120_000)) {
      stop();
      return;
    }
    if (event.kind === 'enchantment' && event.added) {
      if (isKaraholCurse(event.added.name)) curseApplied = true;
      else if (curseApplied && String(event.added.name).trim().toLowerCase() === 'hold') {
        hold = event.added;
        holdAt = event.at;
        confirmed = false;
      }
    }
    // Karahol's EndEnchantment applies Hold before sending this unique exhaustion line.
    if (event.kind === 'message' && hold && event.at - holdAt <= HOLD_PACKET_WINDOW_MS &&
        EXHAUSTION.test(event.text) && client.enchantments?.().includes(hold)) confirmed = true;
    if (confirmed && !client.enchantments?.().includes(hold)) { stop(); return; }
    if (event.kind !== 'stat' || event.name !== 'health' || !Number.isFinite(event.value)) return;

    if (confirmed && Number.isFinite(hp) && event.value < hp) {
      const lost = hp - event.value;
      pilot.tally.karahol_hold_damage_events = (pilot.tally.karahol_hold_damage_events ?? 0) + 1;
      pilot.tally.karahol_hold_damage_hp = (pilot.tally.karahol_hold_damage_hp ?? 0) + lost;
      pilot.ledgerEvent('karahol_hold_damage', {
        strategy, farm_strategy: farmStrategy, agent: s.name, room: 552, source: CURSE, review_required: true,
        hp_before: hp, hp_after: event.value, hp_max: event.max ?? null, hp_lost: lost,
        observed_at: event.at, hold_at: holdAt, fatal: event.value === 0,
      });
    }
    hp = event.value;
    if (hp <= 0) stop();
  };
  client.onFarmBuffEvent = observe;
}
