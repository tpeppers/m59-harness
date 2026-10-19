// THE CURSE CYCLE: PICK UP JEWELLERY NOBODY HAS READ, AND LET A CURSE-BREAKER TELL THE GOOD FROM
// THE BAD BY WEARING IT.
//
//   strategy hook `curseCycle(ctx)` (substrate/strategies/, m59-strategies.mjs) answers, per keeper:
//     { pickup: ['magical ring'], keep: ['magical ring'], hall: ['magical ring'],
//       reserve: 3, karma_min: 20, mana_min: 9, hall_min: 1 }      or null for "not this character"
//
// The default is that NOBODY picks up an unidentified ring (`lootFloor`, UNREVEALED_JEWELLERY):
// item.kod:514 posts TryUseItem on the picker the moment a cursed item enters a pack, so for a
// ring the pickup IS the wear, and a cursed ring never comes off (lethring.kod ReqUnuse). That rule
// stays the rule for everybody this does not name. What changes the arithmetic is a character
// that can take the curse off itself:
//
//   * `remove curse` (remcurse.kod) is Shal'ille level 2: 9 mana, ONE EMERALD, and karma at or
//     above +20 (spell.kod GetRequiredKarma, level x 10). Its CastSpell is RemoveCurseAllItems
//     (player.kod), which UNUSES every cursed item worn -- it does not uncurse the item.
//   * A ring of lethargy reveals itself the moment it is worn (lethring.kod NewUsed ->
//     RevealHiddenAttributes), so a ring that cursed us is, from then on, NAMED "ring of
//     lethargy" -- on the floor too. CURSED_ITEMS refuses that name at every pickup, so a ring
//     dropped back on the floor is never picked up again by anybody.
//   * A ring that is NOT cursed never equips itself and stays "magical ring": unidentified,
//     known not to be the cursed one, and worth keeping.
//
// So the cycle is: take ONE unidentified ring, read the body back; if something cursed is now
// worn, cast remove curse on ourselves, check it came off, and drop it where we stand. The ring
// left in the pack is kept and carried to the guild hall.
//
// WHAT THIS MODULE IS: the pure half -- reading the hook's answer, the gate, and the plan filter.
// The keeper (`Autopilot.tendCurseCycle`) does the casting and the dropping; `lootFloor` asks
// `cycleMayLoot`. Which characters cycle, and with how many emeralds held back, is an ORDER, and
// lives in a private strategy file. With no strategy answering, every function here answers "off".
//
// WHAT IT NEVER DOES:
//   * spend the last emeralds. `reserve` (and the loadout's emerald floor, whichever is larger)
//     is held back for Rescue; below `reserve + 1` the gate is shut and the cycle is simply off;
//   * pick up an amulet. The Amulet of Shadows can call @Killed on its owner (shadowam.kod), so
//     the only jewellery a strategy may name here is a ring. Refused at normalisation, by name;
//   * pick up a second ring while a cursed one is still worn, or more than one per sweep.

const norm = s => String(s ?? '').trim().toLowerCase();
const names = v => [...new Set((Array.isArray(v) ? v : v == null ? [] : [v]).map(norm).filter(Boolean))];
const bounded = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
};

export const CURSE_CYCLE_SPELL = 'remove curse';
export const CURSE_CYCLE_REAGENT = 'emerald';
// remcurse.kod: viSpell_level 2, viMana 9. Karma: spell.kod GetRequiredKarma = level x 10.
export const CURSE_CYCLE_DEFAULTS = Object.freeze({ reserve: 2, karma_min: 20, mana_min: 9, hall_min: 1 });

// Only rings: an amulet can kill its wearer, and nothing else in the game equips itself on pickup.
const FORBIDDEN = /\bamulet\b|\bnecklace\b/;

/**
 * The hook's answer, read into a shape the keeper can trust. `{ cfg, problems }`; `cfg` is null
 * for "not this character" (no answer, or an answer with nothing to do). A refused name is named
 * in `problems` and dropped, never silently widened or kept.
 */
export function normalizeCurseCycle(answer) {
  const problems = [];
  if (!answer || typeof answer !== 'object') return { cfg: null, problems };
  const pickup = names(answer.pickup).filter(n => {
    if (!FORBIDDEN.test(n)) return true;
    problems.push(`"${n}" refused: an amulet can kill its wearer (shadowam.kod), only rings may cycle`);
    return false;
  });
  const keep = names(answer.keep), hall = names(answer.hall);
  if (!pickup.length && !keep.length && !hall.length) return { cfg: null, problems };
  const d = CURSE_CYCLE_DEFAULTS;
  return {
    cfg: {
      pickup, keep, hall,
      reserve: bounded(answer.reserve, 0, 100, d.reserve),
      karma_min: bounded(answer.karma_min, 20, 100, d.karma_min),
      mana_min: bounded(answer.mana_min, 9, 200, d.mana_min),
      hall_min: bounded(answer.hall_min, 1, 1000, d.hall_min),
      ...(answer.why ? { why: String(answer.why) } : {}),
    },
    problems,
  };
}

/**
 * MAY THIS CHARACTER CYCLE RIGHT NOW? `{ open, why, spare }`. Every input is a reading the caller
 * took this pass; an unknown one shuts the gate, because "could not tell" must never read as
 * "allowed". The gate answers the PICKUP: a ring already worn is uncursed whenever the spell can
 * be paid for (see `uncurseAffordable`), gate or no gate.
 */
export function curseCycleGate(cfg, { knowsSpell = false, karma = null, mana = null, emeralds = 0,
                                       floor = 0, cursedWorn = 0 } = {}) {
  if (!cfg?.pickup?.length) return { open: false, why: 'nothing to pick up' };
  if (!knowsSpell) return { open: false, why: `does not know ${CURSE_CYCLE_SPELL}` };
  const k = Number(karma);
  if (karma == null || !Number.isFinite(k)) return { open: false, why: 'karma unknown' };
  if (k < cfg.karma_min) return { open: false, why: `karma ${k} is below ${cfg.karma_min}` };
  const reserve = Math.max(cfg.reserve, Number(floor) || 0);
  const spare = Math.max(0, (Number(emeralds) || 0) - reserve);
  if (spare < 1) return { open: false, spare, why: `no spare emerald: ${emeralds} held, ${reserve} kept back` };
  const m = Number(mana);
  if (mana == null || !Number.isFinite(m) || m < cfg.mana_min)
    return { open: false, spare, why: `mana ${mana ?? 'unknown'} is below ${cfg.mana_min}` };
  if (cursedWorn > 0) return { open: false, spare, why: 'a cursed item is still worn' };
  return { open: true, spare, why: 'ok' };
}

/** Can the uncurse be paid for? The reserve still holds: a worn ring of lethargy is not an emergency. */
export function uncurseAffordable(cfg, { knowsSpell = false, karma = null, mana = null, emeralds = 0, floor = 0 } = {}) {
  if (!knowsSpell) return { ok: false, why: `does not know ${CURSE_CYCLE_SPELL}` };
  if (!(Number(karma) >= (cfg?.karma_min ?? CURSE_CYCLE_DEFAULTS.karma_min))) return { ok: false, why: `karma ${karma} too low` };
  const reserve = Math.max(cfg?.reserve ?? CURSE_CYCLE_DEFAULTS.reserve, Number(floor) || 0);
  if ((Number(emeralds) || 0) - reserve < 1) return { ok: false, why: `no spare emerald (${emeralds} held, ${reserve} kept back)` };
  if (!(Number(mana) >= (cfg?.mana_min ?? CURSE_CYCLE_DEFAULTS.mana_min))) return { ok: false, why: `mana ${mana} too low` };
  return { ok: true };
}

/**
 * May `lootFloor` take this unidentified jewellery? Only with an open gate, only a name the
 * strategy listed, and only ONE per sweep (`taken` is the sweep's own set, updated here).
 */
export function cycleMayLoot(name, gate, taken = new Set()) {
  const n = norm(name);
  if (!gate?.open || !gate.pickup?.includes(n) || FORBIDDEN.test(n) || taken.size) return false;
  taken.add(n);
  return true;
}

/**
 * A guild plan narrowed to the names a character is carrying to the hall for the cycle. For a
 * character with `guild_wants` off: the hall run then fills those lines and nothing else, so
 * turning the cycle on does not also turn on every other deposit in the plan.
 */
export function restrictPlan(plan, keep) {
  if (!plan?.chests) return plan;
  const want = new Set(names(keep));
  const chests = new Map();
  for (const [slot, items] of plan.chests)
    chests.set(slot, (items ?? []).filter(e => [e.item, ...(e.also ?? [])].some(n => want.has(norm(n)))));
  return { ...plan, chests };
}
