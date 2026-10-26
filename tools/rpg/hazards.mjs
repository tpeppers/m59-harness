// WHAT DOES IT COST TO WALK THROUGH THAT? The ground effects the harness sees (m59-ground-effects.mjs),
// priced in health from the kod, so a pak can decide to cross one rather than stand beside it.
//
// THE SERVER DOES NOT STOP US. A wall element is MOVEON_NOTIFY (wallelem.kod:38; blakston.khd:57): "can
// move on", with a notification. It hurts; it does not block. Treating a firewall as a wall is OUR choice
// (m59-ground-effects.mjs marks it `avoid`), and the operator's 2026-10-25 complaint is the cost of that
// choice: melee characters standing beside a firewall for minutes while something shoots them.
//
// A WALL OF FIRE (wallfire.kod, firewall.kod):
//   * one hit on stepping onto the square (SomethingMoved -> CheckForEffect, wallelem.kod:100-131), then one
//     every EFFECT_INTERVAL = 1500 ms, jittered 90-110% (wallelem.kod:21,88-92), for whoever is still there;
//     a per-cycle list stops a second hit in the same cycle (156-161);
//   * damage Random(0, piMaxDamage), piMaxDamage = Bound(power/6, 1, 16) -- so 0..16 (firewall.kod:79-80),
//     fire-typed (ATCK_SPELL_FIRE), resisted as damage * (100 - resist) / 100 (battler.kod:251-266);
//   * and NEVER LESS THAN 1 for a player: AssessDamage raises a non-absolute 0 to 1 (player.kod ~4597). So
//     100% resistance still costs 1 a tick. Crossing one square is one hit, at most 16, usually about 8;
//   * it lasts 30-200 s (wallfire.kod:65-74) and the caster is never hurt by it.
// A wall of lightning is the same machine, shock-typed (wallltng.kod). Fog, spores and webs are priced
// unknown: they are reported, and a pak that crosses one is doing so without a number.
export const HAZARDS = Object.freeze({
  firewall: { element: 'fire', max_hit: 16, period_ms: 1500, min_hit: 1, cite: 'wallfire.kod:106-107, firewall.kod:79-80, wallelem.kod:21' },
  lightning_wall: { element: 'shock', max_hit: 16, period_ms: 1500, min_hit: 1, cite: 'wallltng.kod (WallElement), wallelem.kod:21' },
});

/**
 * The price of `squares` steps through `effect` (a groundEffect row) for a character with `sheet`
 * (rpg/sheet.mjs). `dwell_ms` is extra time standing in it. Returns null for an effect we cannot price.
 */
export function crossingCost(effect, sheet = {}, { squares = 1, dwell_ms = 0 } = {}) {
  const h = HAZARDS[effect?.kind];
  if (!h) return null;
  const resist = Math.max(0, Math.min(100, Number(sheet?.resist?.[h.element] ?? 0)));
  const ticks = squares + Math.floor(Math.max(0, dwell_ms) / (h.period_ms * 0.9));
  const scale = (100 - resist) / 100;
  const worst = Math.max(h.min_hit, Math.floor(h.max_hit * scale));
  const expected = Math.max(h.min_hit, (h.max_hit / 2) * scale);
  const health = Number(sheet?.health);
  return {
    kind: effect.kind, element: h.element, resist_pct: resist, ticks,
    worst_hit: worst, expected_hit: Math.round(expected * 10) / 10,
    worst_total: worst * ticks, expected_total: Math.round(expected * ticks * 10) / 10,
    health_after_worst: Number.isFinite(health) ? health - worst * ticks : null,
    period_ms: h.period_ms, cite: h.cite,
  };
}
