#!/usr/bin/env node
// MAGIC FOR: the dedicated weapon against THESE quarries, a mundane one against everything else.
//
//   import { normalizeMagicFor, magicForWant, decideMagicFor } from './m59-magic-for.mjs';
//
// Operator, 2026-11-06, about the mollusk hunters in The Great Ocean (552) and its shore (562):
// "have them kill the slimes with other weapons (non-dedicated)" ... "Slimes or fungus, whatever
// else is on that map". A Kraanan dedication lapses after 1-25 h and wears with use, so every swing
// at a frogman, slime or fungus beast is spent on a creature a plain axe kills just as well.
//
// The policy had only GLOBAL switches (`preferMagicWeapon`, `preferMundaneWeapon`), which answer
// "which weapon" once for the whole day. This answers it per QUARRY: `magicWeaponFor` is a list of
// name fragments, matched case-insensitively as substrings of the quarry's name the fight chose.
//
//   * quarry in the list   -> 'magic'   (a weapon the weapon-magic book reads bypasses_nonmagic)
//   * any other quarry     -> 'mundane' (any weapon NOT read magic, any family -- a hammer or long
//                                        sword beside the dedicated axe counts)
//   * no quarry named      -> the last decision stands (an equip between fights does not undo it)
//   * key absent / null    -> null: today's behaviour exactly, the global switches decide
//
// The mode is a RANKING, never a refusal: weaponRanking (m59-skills.mjs) puts the wanted kind first,
// so when none is carried the ordinary order decides and the weapon already in hand stays. Nothing
// here can unarm a character or refuse a fight. The cursed / unread / banned / broken filters are
// weaponRanking's and are untouched; an unread weapon never counts as the wanted mundane kind.
//
// RATE-LIMITED: a room holding both kinds would otherwise swap at every fight entry. The mode may
// change at most once per `gapMs` (10 s); a change asked for inside that window is HELD, and the
// weapon in hand keeps swinging.
//
// PURE. No client, no keeper, no clock of its own (`now` is passed in).

export const MAGIC_FOR_GAP_MS = 10_000;

/** The broker / strategy normal form: a de-duplicated lower-case list, or null for silence. */
export function normalizeMagicFor(v, what = 'weapons.magicFor') {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim()))
    throw new Error(`${what} must be a list of creature name fragments (e.g. ["mollusk creature"]) or null`);
  const out = [...new Set(v.map(x => x.trim().toLowerCase()))];
  return out.length ? out : null;
}

/** 'magic' | 'mundane' for a named quarry under this list; null when the list is silent or no quarry. */
export function magicForWant(list, quarry) {
  if (!Array.isArray(list) || !list.length) return null;
  const q = String(quarry ?? '').trim().toLowerCase();
  if (!q) return null;
  return list.some(p => q.includes(String(p).toLowerCase())) ? 'magic' : 'mundane';
}

/**
 * One fight entry's decision.
 *
 *   decideMagicFor(state, { list, quarry, now, gapMs })
 *   -> { mode, want, changed, held, state }
 *
 * `state` is `{ mode, at }` from the previous call (or null). `mode` is what the ranking should use
 * now; `changed` says it moved this call, `held` that a change was wanted and refused by the rate limit.
 */
export function decideMagicFor(state, { list, quarry = null, now = Date.now(), gapMs = MAGIC_FOR_GAP_MS } = {}) {
  if (!Array.isArray(list) || !list.length)
    return { mode: null, want: null, changed: false, held: false, state: null };
  const prev = state && (state.mode === 'magic' || state.mode === 'mundane') ? state : null;
  const want = magicForWant(list, quarry);
  if (want == null || want === prev?.mode)
    return { mode: prev?.mode ?? null, want, changed: false, held: false, state: prev };
  if (prev && now - (Number(prev.at) || 0) < gapMs)
    return { mode: prev.mode, want, changed: false, held: true, state: prev };
  const next = { mode: want, at: now, quarry: String(quarry) };
  return { mode: want, want, changed: true, held: false, state: next };
}
