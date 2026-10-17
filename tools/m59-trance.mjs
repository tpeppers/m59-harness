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

/** A move speed that will not break a trance: anything above walking is clamped to walking. */
export const tranceSafeSpeed = (speed) =>
  Number.isFinite(speed) && speed > USER_WALKING_SPEED ? USER_WALKING_SPEED : speed;
