// THE CASTING TRANCE, AS DATA: how long a spell charges, and the three sentences that bracket it.
//
// Pure, offline, no socket. The Pacer's hold (m59-game.mjs) is the door that keeps a trance
// unbroken; this file is what it asks about a spell.
//
// THE MECHANIC (Meridian59 kod; cited by symbol and line against the tree in M59_ROOT):
//
//   - A spell with `viCast_time` puts the caster in a trance (trance.kod). Mana and reagents are
//     taken up front. Trance.BreakTrance (trance.kod:96-112) IGNORES THE EVENT TYPE, so every
//     event it is sent breaks it: another cast (user.kod:4769), a guild command (:4842), an attack
//     (:4674), using, unusing or applying an item (:4619, :4643, :5842; so A GEAR SWAP MID-CAST
//     FIZZLES IT), any health lost (player.kod:5765), sitting down (player.kod:9991), changing
//     room (player.kod:1457), and logging off (user.kod:657).
//   - WALKING DOES NOT BREAK IT. RUNNING DOES. UserMove raises EVENT_RUN only under
//     `if speed > USER_WALKING_SPEED` (user.kod:2958, :2977), and USER_WALKING_SPEED is 18
//     (user.kod:46). A move sent at 18 or less keeps the trance.
//   - Speech does not break it (user.kod:4076, SomethingSaidDuringTrance).
//   - It lasts viCast_time * (150 - spellpower) / 100 (spell.kod:1883 GetTranceTime): 149% of the
//     catalogue figure at spellpower 1, 51% at 99. It is 0 for a spell with no cast time, and that
//     spell skips the trance entirely (spell.kod:1835).
//
// THE SENTENCES:
//   start    "You focus your whole will on casting %s."                 (spell.kod:125, sent :1874)
//   broken   "Your concentration is broken and the %s spell fizzles."   (spell.kod:126, sent :2306)
//   done     NOTHING GENERIC. Trance.EndEnchantment (trance.kod:58) calls CastSpell and only the
//            spell's own text follows, so completion is known by time, not by a sentence.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USER_WALKING_SPEED = 18;          // user.kod:46
export const SPELLPOWER_MIN = 1, SPELLPOWER_MAX = 99;   // blakston.khd:2089-2090

export const TRANCE_START = /^You focus your whole will on casting (.+?)\.?$/i;
export const TRANCE_BROKEN = /^Your concentration is broken and the (.+?) spell fizzles\.?$/i;
// Refusals that mean NO trance was ever entered: the cast was turned down before CanPayCosts, or
// failed inside it. Each one is a sentence spoken only to the caster.
export const CAST_REFUSED = [
  /unsuccessful in casting/i,                  // the chance roll in PayCosts
  /don'?t have the reagents/i,                 // spell.kod:52
  /not have enough mana|don'?t have enough mana|lack the mana/i,
  /can'?t cast while resting|must stand/i,
  /can'?t cast spells? (here|now|while)/i,
];

const HERE = dirname(fileURLToPath(import.meta.url));
let CATALOGUE = null;
function catalogue() {
  if (CATALOGUE) return CATALOGUE;
  CATALOGUE = new Map();
  try {
    const j = JSON.parse(readFileSync(join(HERE, '..', 'substrate', 'm59-spells.json'), 'utf8'));
    for (const sp of j.spells ?? []) if (sp?.name) CATALOGUE.set(String(sp.name).toLowerCase(), sp);
  } catch { /* no catalogue: every spell reads as no trance, which is the behaviour before this */ }
  return CATALOGUE;
}

/** The catalogue row for a spell, by name, or null. */
export function spellInfo(name) {
  return catalogue().get(String(name ?? '').trim().toLowerCase()) ?? null;
}

/** The catalogue's viCast_time in ms (0 when the spell has no trance, or is unknown). */
export function baseTranceMs(name) {
  const t = Number(spellInfo(name)?.cast_time_ms);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * How long the trance lasts at a given spellpower, by GetTranceTime. With no spellpower known
 * this answers the LONGEST it can be (spellpower 1), because a hold that ends early breaks the
 * cast and a hold that ends late costs a few seconds of standing still.
 */
export function tranceMs(name, { spellpower = null } = {}) {
  const base = baseTranceMs(name);
  if (!base) return 0;
  const sp = Number.isFinite(spellpower)
    ? Math.max(SPELLPOWER_MIN, Math.min(SPELLPOWER_MAX, spellpower)) : SPELLPOWER_MIN;
  return Math.ceil(base * (150 - sp) / 100);
}

/** What a message says about a trance: 'start' | 'broken' | 'refused' | null, and the spell. */
export function classifyTranceLine(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  let m = TRANCE_START.exec(t);
  if (m) return { kind: 'start', spell: m[1].toLowerCase() };
  m = TRANCE_BROKEN.exec(t);
  if (m) return { kind: 'broken', spell: m[1].toLowerCase() };
  if (CAST_REFUSED.some(re => re.test(t))) return { kind: 'refused', spell: null };
  return null;
}

// WHAT A CAST REALLY COSTS. spell.kod:1544 GetManaCost: the catalogue viMana, less 1 at spellpower over 40 and another
// at over 80, then less ceil(cost * pct / 100) for a caster USING the shield of the Princess' army, bound below at 1
// (and 0 stays 0). The shield's pct is prinshld.kod GetSpellManaReduction: 5 at faction rank 1 rising to 25 at rank 10.
export const PRINCESS_MANA_REDUCTION_MIN = 5, PRINCESS_MANA_REDUCTION_MAX = 25;   // prinshld.kod:160-186
export const PRINCESS_SHIELD = /shield of the princess/i;                          // prinshld.kod:30

/** The Princess shield's mana reduction (%) at faction rank 1..10 (prinshld.kod GetSpellManaReduction). */
export function princessReductionPct(rank) {
  const r = Math.max(1, Math.min(10, Math.trunc(Number(rank))));
  return Math.trunc((r - 1) * (PRINCESS_MANA_REDUCTION_MAX - PRINCESS_MANA_REDUCTION_MIN) / 9) + PRINCESS_MANA_REDUCTION_MIN;
}

/** spell.kod GetManaCost for one spellpower and one reduction %, in kod's integer arithmetic. */
export function manaCostAt(full, { spellpower = SPELLPOWER_MIN, reductionPct = 0 } = {}) {
  let cost = Math.trunc(Number(full));
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  if (spellpower > 40) cost -= 1;
  if (spellpower > 80) cost -= 1;
  if (reductionPct > 0) cost -= Math.trunc((cost * reductionPct + 99) / 100);
  return Math.max(1, cost);
}

/**
 * The range a COMPLETED cast of `name` can cost, `{ min, max, full }`, or null with no catalogue price.
 * `spellpower` null is unknown: anything from the full price down to the two-point discount. `princess` true is a caster
 * wearing the Princess shield and `princessRank` its rank (null: anywhere from 5% to 25%). `princess` null or false is
 * no shield, which is what an unread body is assumed to wear.
 */
export function expectedManaCost(name, { spellpower = null, princess = null, princessRank = null } = {}) {
  const full = Number(spellInfo(name)?.mana);
  if (!Number.isFinite(full)) return null;
  const sps = Number.isFinite(spellpower) ? [spellpower] : [SPELLPOWER_MIN, SPELLPOWER_MAX];
  const pcts = !princess ? [0]
    : princessRank != null && Number.isFinite(Number(princessRank)) ? [princessReductionPct(princessRank)]
    : [PRINCESS_MANA_REDUCTION_MIN, PRINCESS_MANA_REDUCTION_MAX];
  const costs = sps.flatMap(sp => pcts.map(p => manaCostAt(full, { spellpower: sp, reductionPct: p })));
  return { min: Math.min(...costs), max: Math.max(...costs), full };
}

export const CAST_UNSUCCESSFUL = /unsuccessful in casting/i;   // spell.kod:73 spell_failed_by_chance, sent by SpellFailed

/**
 * WHAT ONE CAST CAME TO.
 *
 *   refused      nothing was taken: turned down before CanPayCosts (wrong target, no reagents, ...)
 *   failed roll  HALF the mana and NO reagents (spell.kod:1150 SpellFailed, which returns before the reagents are
 *                taken at :1279): the chance roll lost, so no trance was entered. Bad luck, not a fault.
 *   broken       the trance started and something broke it: full mana AND every reagent gone for nothing.
 *   completed    full price, and for a trance spell no "concentration is broken" before the hold ran out.
 *   null         nothing read can tell: UNKNOWN IS NOT REFUSED, as before -- and a price both readings explain is
 *                unknown too, never a guess.
 *
 * THE SERVER'S OWN WORDS FIRST, then the reagents, and the price only when neither says:
 *   `ended`        the session's `pacer.lastTranceEnd.why` when it ended its automatic hold after this cast. Only
 *                  "concentration broken" is read from it; a trance that finishes ends by the clock with no sentence
 *                  at all (trance.kod:58), so a missing line is not evidence.
 *   `said`         the messages since the cast went out. "Your concentration is broken ..." is broken; "You were
 *                  unsuccessful in casting %s." is a failed roll (SpellFailed sends it after taking half the mana).
 *   `reagentsPaid` true when every reagent the spell takes left the pack. A failed roll takes NONE, so that cast went
 *                  through (a later break is still caught by `ended`/`said`). False, for a spell with reagents that
 *                  spent mana, is a failed roll. Null when the pack was not read, or not read in time.
 *   `spent`        the mana delta, against expectedManaCost: a completed cast costs the DISCOUNTED price (spellpower
 *                  over 40/80, the Princess shield), a failed roll half of that, and either can read a point light
 *                  when regeneration lands between the two readings.
 *
 * Operator, 2026-10-30: Zoot's 125 edible mushrooms looked like broken concentration. The ledger said 43 haste casts,
 * "100% worked" -- because a failed roll spends mana, and mana was all `ok` asked about.
 *
 * 2026-11-13, the other direction: Pepe (Princess soldier, remove curse ~81, catalogue 9 mana) logged 41 remove curse
 * casts as 40 "failed roll" and 1 refused, 162 mana spent, about 4 a cast. The line was a flat three quarters of the
 * catalogue price (6.75), and a COMPLETED remove curse on his body costs 5 or 6 (9, less 2 for spellpower over 80,
 * less the shield's 5-25%). Every completed cast read as the dice, and the drill counted a working spell as idle.
 */
export function practiceOutcome({ name, spent = null, ended = null, said = null, reagentsPaid = null,
                                  spellpower = null, princess = null, princessRank = null } = {}) {
  const lines = (Array.isArray(said) ? said : said == null ? [] : [said]).map(l => String(l ?? '').trim());
  if (/broken/i.test(String(ended ?? '')) || lines.some(l => TRANCE_BROKEN.test(l))) return 'broken';
  if (lines.some(l => CAST_UNSUCCESSFUL.test(l))) return 'failed roll';
  if (reagentsPaid === true) return 'completed';
  if (spent == null) return null;
  if (!(spent > 0)) return 'refused';
  if (reagentsPaid === false && (spellInfo(name)?.reagents ?? []).length > 0) return 'failed roll';
  const cost = expectedManaCost(name, { spellpower, princess, princessRank });
  if (!cost || !(cost.max > 1)) return 'completed';
  const failHi = Math.trunc(cost.max / 2), compLo = cost.min - 1;
  const inFail = spent <= failHi, inComp = spent >= compLo;
  if (inFail && !inComp) return 'failed roll';
  if (inComp && !inFail) return 'completed';
  if (inFail && inComp) return null;
  // In the gap between the two: the nearer one, and a tie is unknown.
  const toFail = spent - failHi, toComp = compLo - spent;
  return toFail < toComp ? 'failed roll' : toComp < toFail ? 'completed' : null;
}

/** A move speed that will not break a trance: anything above walking is clamped to walking. */
export const tranceSafeSpeed = (speed) =>
  Number.isFinite(speed) && speed > USER_WALKING_SPEED ? USER_WALKING_SPEED : speed;
