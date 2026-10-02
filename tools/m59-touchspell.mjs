// TOUCH SPELL TRAINING — the facts a keeper needs to swing a touch spell instead of a fist.
//
//   import { TOUCH_SPELLS, touchSpellName, classifyTouchLine, TouchSpellState }
//     from './m59-touchspell.mjs';
//
// The operator, 2026-10-02: "Acid touch is a touch spell and touch spells functions as a weapon
// replacement. when training it keeper needs to make sure other weapons aren't equipped, that the
// touch spell personal buff is active, and that they aren't accidentally punching instead of using
// their touch spell, which they can do by monitoring the combat logs ('your punch …' versus 'your
// acid touch …').. there's also a purple (in the player ui) server message sent when the effects
// of a touch spell start or stop that can be used to help trigger the keeper understanding whether
// or not the touch spell is active".
//
// ── WHAT THE KOD SAYS (C:/code/Meridian59/kod) ───────────────────────────────────────────────────
//
// A touch spell is a PERSONAL ENCHANTMENT that becomes the weapon (touchatk.kod:11-13, "a 'combat
// stroke' enchantment"). `Player.GetWeapon` returns the wielded melee weapon FIRST and consults
// the TouchAttackSpell enchantment only when the hand is empty (player.kod:4712-4729): so a
// wielded weapon SUPPRESSES the touch completely — the spell stays on and is never swung. That is
// why the hand has to be empty, not merely why it is tidy.
//
// Casting: `GetNumSpellTargets` is 0 (touchatk.kod:120-123) and `vbCanCastOnOthers` FALSE
// (:89-90); `PersonalEnchantment.CanPayCosts` turns an empty target list into [caster] and wants
// exactly one target (persench.kod:75-86). Casting at the caster's own object id is therefore the
// same request as an empty list, and the one shape that cannot land on somebody else — the fleet
// has already watched `target: "me"` resolve to a stranger. `CastSpell` strips any OTHER touch
// spell first (touchatk.kod:111-118), so two never coexist.
//
// Messages, all plain `MsgSendUser` with no colour code in the resource (persench.kod:132, 182,
// 203) — the "purple" the operator sees is how the client renders that system text:
//   START  vrEnchantment_On, sent to the target as the enchantment starts (persench.kod:182)
//   STOP   vrEnchantment_Off, from EndEnchantment when it expires or is removed (persench.kod:203)
//   ALREADY vrAlreadyEnchanted, when cast while it is still on and the server does not allow a
//          self-recast (persench.kod:117-133). Returned BEFORE `propagate`, so nothing is paid —
//          and it is positive evidence the touch is ON.
//
// Duration: Random(power/3, power/2) bounded 10..75, times 6s — ONE to SEVEN AND A HALF minutes
// (touchatk.kod:390-400). A recast is a matter of minutes, not seconds.
//
// The swing: `Battler.AssessHit` names the weapon with `GetAttackName` — the spell's own name for a
// touch, the resource "punch" for an empty hand — in "%sYour %s %s %s%s." (battler.kod:42, 47,
// 897-907, 959-961). So a landed touch reads "Your acid touch burns the living tree." and a landed
// fist "Your punch slaps the living tree.". A MISS names no weapon ("The living tree dodges your
// attack.", battler.kod:43, 984-996) and proves nothing either way. A KILL with a touch replaces
// "You killed ..." with the spell's own line (player.kod:4806-4812), e.g. acid's "%s%s screams and
// melts into an unobtrusive puddle." (acidtch.kod:33). `PlayerHitSomethingMsg` has no caller in
// the kod tree, so the "You watch ... scream in agony at your touch" resource is never sent.
//
// Training: a landed touch calls `ImproveStroke` on the SPELL (player.kod:4536-4541,
// touchatk.kod:99-104), and `GetStroke` reads the spell ability (touchatk.kod:182-189) — the
// spell is trained by HITTING with it, which is the whole point of this posture.

import { classifyCombatLine, stripCodes } from './m59-combatlog.mjs';

/**
 * The five touch spells in the kod tree. Costs are the classvars; reagents are `ResetReagents`.
 * Every entry is cited so that "can it be afforded" is a statement about the source, not a guess.
 */
export const TOUCH_SPELLS = Object.freeze({
  'acid touch': Object.freeze({
    name: 'acid touch', school: 'Qor', level: 2, mana: 10,
    reagents: Object.freeze([{ item: 'entroot berry', match: /entroot/i, count: 1 }]),
    on: 'The corrosive spittle of Qor\'s love oozes from the pores of your hand.',
    off: 'Your hands no longer drip with acidic ooze.',
    already: 'Your hands are already dripping with acidic ooze.',
    kill: /^(?:The |An? )?(.+?) screams and melts into an unobtrusive puddle\.$/i,
    cite: 'persench/touchatk/acidtch.kod:19-28 (name, on, off, already), :33 (kill), ' +
          ':60-64 (Qor, level 2, 10 mana), :89-94 (1 entroot berry)',
  }),
  'touch of flame': Object.freeze({
    name: 'touch of flame', school: 'Faren', level: 2, mana: 9,
    reagents: Object.freeze([{ item: 'red mushroom', match: /red mushroom/i, count: 1 }]),
    on: 'Jets of flame erupt from your fingers.',
    off: 'Your hands are no longer shrouded in flame.',
    already: 'Your hands are already shrouded in flame.',
    kill: null,
    cite: 'persench/touchatk/flametch.kod:19-28, :66-70, :96',
  }),
  'holy touch': Object.freeze({
    name: 'holy touch', school: 'Shal\'ille', level: 2, mana: 12,
    reagents: Object.freeze([{ item: 'emerald', match: /emerald/i, count: 2 }]),
    on: 'Your hands are bathed in Shal\'ille\'s love.',
    off: 'Your hands are no longer bathed in Shal\'ille\'s love.',
    already: 'Your hands are already bathed in Shal\'ille\'s love.',
    kill: null,
    cite: 'persench/touchatk/holytch.kod:19-29, :65-69, :97',
  }),
  'icy fingers': Object.freeze({
    name: 'icy fingers', school: 'Faren', level: 2, mana: 6,
    reagents: Object.freeze([{ item: 'red mushroom', match: /red mushroom/i, count: 1 }]),
    on: 'A frost of absolute cold shrouds your hands.',
    off: 'Your hands are no longer shrouded in frost.',
    already: 'Your hands are already shrouded in frost.',
    kill: null,
    cite: 'persench/touchatk/icyfing.kod:19-28, :61-65, :93',
  }),
  'zap': Object.freeze({
    name: 'zap', school: 'Faren', level: 1, mana: 6,
    reagents: Object.freeze([{ item: 'blue mushroom', match: /blue mushroom/i, count: 1 }]),
    on: 'Sparks jump and crackle from your fingertips.',
    off: 'Your fingers are no longer charged with electrical power.',
    already: 'Your hands already crackle with electric charge.',
    kill: null,
    cite: 'persench/touchatk/zap.kod:19-27, :58-62, :90',
  }),
});

export const TOUCH_SPELL_NAMES = Object.freeze(Object.keys(TOUCH_SPELLS));

/**
 * The policy value, normalised. null/''/false are OFF. An unknown name THROWS rather than being
 * coerced to off: a setting that silently does nothing is the `purpose` bug this repository has
 * paid for, and an operator who typed "acid tuoch" has to be told.
 */
export function touchSpellName(value) {
  if (value == null || value === false || value === '') return null;
  if (typeof value !== 'string') throw new Error('touch_spell must be a touch spell name or null');
  const n = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!n) return null;
  if (!Object.hasOwn(TOUCH_SPELLS, n))
    throw new Error(`touch_spell must be one of ${TOUCH_SPELL_NAMES.join(', ')} (or null), ` +
      `not ${JSON.stringify(value)}`);
  return n;
}

/** The spec for a policy value, or null. Never throws: a bad stored value reads as OFF here. */
export function touchSpellSpec(value) {
  try { const n = touchSpellName(value); return n ? TOUCH_SPELLS[n] : null; } catch { return null; }
}

const norm = (t) => stripCodes(t).replace(/\s+/g, ' ').trim();

/**
 * What one line of server prose says about THIS touch spell.
 *   'start'   — the enchantment began (the operator's purple line)
 *   'stop'    — it ended
 *   'already' — a cast found it still on; nothing was paid
 *   'touch'   — a landed swing with this touch spell (or a touch kill)
 *   'punch'   — a landed swing with an EMPTY hand and no touch: the buff is not on
 *   'weapon'  — a landed swing with something else in the hand: the touch is suppressed
 *   null      — nothing to do with it (including every miss, which names no weapon)
 */
export function classifyTouchLine(text, spellName) {
  const spec = touchSpellSpec(spellName);
  if (!spec) return null;
  const s = norm(text);
  if (!s) return null;
  if (s.toLowerCase() === norm(spec.on).toLowerCase()) return 'start';
  if (s.toLowerCase() === norm(spec.off).toLowerCase()) return 'stop';
  if (s.toLowerCase() === norm(spec.already).toLowerCase()) return 'already';
  if (spec.kill && spec.kill.test(s)) return 'touch';
  const c = classifyCombatLine(s);
  if (c?.kind !== 'my-swing' || !c.landed || !c.weapon) return null;
  const w = c.weapon.toLowerCase();
  if (w === spec.name) return 'touch';
  if (w === 'punch') return 'punch';
  // Another touch spell's name is not ours; anything else is a weapon in the hand.
  if (Object.hasOwn(TOUCH_SPELLS, w)) return 'other-touch';
  return 'weapon';
}

/**
 * The keeper's belief about one touch spell, driven by the server's own prose.
 *
 * `active` is TRI-STATE on purpose: null means "this process has not been told", which is the
 * honest state after a keeper restart — the enchantment may well still be on from the last one.
 * Unknown is answered with ONE cast: either it lands (and START follows) or the server says
 * ALREADY at no cost. Both settle it.
 */
export class TouchSpellState {
  constructor(name) {
    this.name = name;
    this.active = null;
    this.lastStart = null;
    this.lastStop = null;
    this.lastAlready = null;
    this.punchesSinceCast = 0;
    this.touchHits = 0;
    this.weaponSwings = 0;
    this.recasts = 0;
    this.castAttempts = 0;
    this.castsUnproven = 0;
    this.lastCastAt = null;
    this.lastCastResult = null;
    this.blockedReason = null;
    this.needDisarm = false;
    this.cursor = 0;
    this.client = null;
  }

  /** Feed one line; returns what it was, or null. */
  observe(text, at = Date.now()) {
    const kind = classifyTouchLine(text, this.name);
    switch (kind) {
      case 'start': this.active = true; this.lastStart = at; break;
      // ALREADY proves it is on NOW, and dates nothing: the server answers it before paying for
      // anything (persench.kod:117-133), so the enchantment it found may be about to end.
      case 'already': this.active = true; this.lastAlready = at; break;
      case 'stop': this.active = false; this.lastStop = at; break;
      case 'touch': this.active = true; this.touchHits++; break;
      // A punch PROVES the buff is not on: an empty hand with a touch enchantment swings the
      // touch (player.kod:4718-4727). Our belief was wrong, whatever it was.
      case 'punch': this.active = false; this.punchesSinceCast++; break;
      case 'other-touch': this.active = false; break;
      // A weapon swing says nothing about the buff and everything about the hand.
      case 'weapon': this.weaponSwings++; this.needDisarm = true; break;
      default: break;
    }
    return kind;
  }

  /** Read every new message on this client. A reconnect replaces the client: start over. */
  consume(c) {
    if (!c) return [];
    if (c !== this.client) { this.client = c; this.cursor = 0; }
    const evs = typeof c.eventsSince === 'function' ? c.eventsSince(this.cursor) : [];
    const seen = [];
    for (const e of evs) {
      if (e?.kind === 'message' && typeof e.text === 'string') {
        const k = this.observe(e.text, e.at ?? Date.now());
        if (k) seen.push(k);
      }
    }
    if (Number.isFinite(c.evSeq)) this.cursor = c.evSeq;
    return seen;
  }

  snapshot() {
    return {
      name: this.name, active: this.active,
      last_start: this.lastStart, last_stop: this.lastStop, last_already: this.lastAlready,
      punches_since_cast: this.punchesSinceCast, touch_hits: this.touchHits,
      weapon_swings: this.weaponSwings, recasts: this.recasts,
      cast_attempts: this.castAttempts, casts_unproven: this.castsUnproven,
      last_cast_at: this.lastCastAt, last_cast_result: this.lastCastResult,
      blocked_reason: this.blockedReason,
    };
  }
}

/** How long to wait before the next cast attempt, given how the last few went. */
export function touchRecastBackoffMs(unprovenInARow) {
  if (!(unprovenInARow > 0)) return TOUCH_RECAST_MIN_MS;
  return Math.min(TOUCH_RECAST_MAX_MS, TOUCH_RECAST_MIN_MS * 2 ** Math.min(unprovenInARow, 4));
}
// Ten seconds between attempts at the least: a landed touch lasts at least a minute, and the only
// reason to cast sooner is a refusal we have not understood, which a faster retry will not fix.
export const TOUCH_RECAST_MIN_MS = Number(process.env.M59_TOUCH_RECAST_MS || 10_000);
export const TOUCH_RECAST_MAX_MS = 120_000;

// ── WHEN TO CAST: AT THE TARGET, NOT ONLY AT THE SWING ──────────────────────────────────────────
//
// The operator, 2026-10-02: "Acid touch as a self-cast spell can be done before starting the fight,
// too, the buff lasts maybe a minute or two, but often it makes sense to wait until you've found
// your next target." Casting before the first swing (the original trigger) spends the opening
// round of every fight on a cast; casting the moment the farm pass has CHOSEN its next quarry
// puts the cast in the approach, where it costs nothing. Casting any earlier than that spends
// buff time on an empty room.
//
//   'on_target'    (the default) also cast when a NEW quarry is chosen, before the approach, and
//                  then refresh a buff that may be about to lapse.
//   'before_swing' only before a swing, which is what the keeper did before this existed.
//
// Both keep every reactive trigger — the STOP line, a swing that read "Your punch", an unknown
// state — and the same rate limit. Only the proactive refresh is new.
export const TOUCH_CAST_TIMINGS = Object.freeze(['on_target', 'before_swing']);

/** The policy value, normalised. null/'' is the default ('on_target'); an unknown value THROWS. */
export function touchCastTiming(value) {
  if (value == null || value === '') return 'on_target';
  const v = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : value;
  if (!TOUCH_CAST_TIMINGS.includes(v))
    throw new Error(`touch_spell_timing must be one of ${TOUCH_CAST_TIMINGS.join(', ')} (or null for ` +
      `on_target), not ${JSON.stringify(value)}`);
  return v;
}

// HOW LONG A TOUCH LASTS, which nothing on the wire says. `Random(power/3, power/2)` bounded to
// 10..75 ticks of 6s (touchatk.kod:390-400): one to seven and a half minutes. The power is not
// known to the keeper, so the estimate is the SHORTEST buff — conservative on purpose, because
// recasting early costs ten mana and a berry and lapsing mid-fight costs a round of punches.
export const TOUCH_MIN_DURATION_MS = 10 * 6_000;
export const TOUCH_MAX_DURATION_MS = 75 * 6_000;
// Refresh when this little of the shortest possible buff may be left.
export const TOUCH_REFRESH_MARGIN_MS = Number(process.env.M59_TOUCH_REFRESH_MARGIN_MS || 20_000);

/**
 * Should a NEW target get a cast before the approach? Pure; reads a TouchSpellState.
 *   { due, refresh, why, remaining_ms }
 * `refresh: true` means "it is on, but may lapse": the caller casts over an active buff. An
 * ALREADY answer inside the margin settles it — the server just said it is on, and asking again
 * on every target would spend a cast slot per target to be told the same thing.
 */
export function touchRefreshDue(st, now = Date.now(), { minDurationMs = TOUCH_MIN_DURATION_MS,
                                                        marginMs = TOUCH_REFRESH_MARGIN_MS } = {}) {
  if (!st) return { due: false, refresh: false, why: 'no touch spell', remaining_ms: null };
  if (st.active !== true)
    return { due: true, refresh: false, remaining_ms: 0,
             why: st.active === false ? 'the touch is off' : 'the touch state is unknown' };
  if (st.lastAlready != null && now - st.lastAlready < marginMs)
    return { due: false, refresh: false, remaining_ms: null,
             why: `the server said it was on ${Math.round((now - st.lastAlready) / 1000)}s ago` };
  if (st.lastStart == null)
    return { due: true, refresh: true, remaining_ms: null,
             why: 'it is on but nothing here saw it start, so its age is unknown' };
  const remaining = minDurationMs - (now - st.lastStart);
  if (remaining > marginMs)
    return { due: false, refresh: false, remaining_ms: remaining,
             why: `at least ~${Math.round(remaining / 1000)}s left even of the shortest buff` };
  return { due: true, refresh: true, remaining_ms: Math.max(0, remaining),
           why: `under ${Math.round(marginMs / 1000)}s may be left of the shortest buff` };
}
