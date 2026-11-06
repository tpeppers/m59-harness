// SECOND WIND FARMING: AGAINST WEAK PREY, LET THE SKILL BE THE LARDER.
//
// The operator, 2026-11-05, of Scooter and Zoot in the Icky Cave: "significantly stronger than the monsters they're
// fighting ... and have the skill second wind: Let them not eat and just have second wind keep giving them vigor back
// (and a chance for an improve!) -- let's make that a harness default if the character has second wind and is farming
// things significantly smaller than them, disable eating entirely (w/optional override)."
//
// THE MECHANIC (secwind.kod, player.kod AddExertion). Second Wind is automatic: on any exertion while vigor is under 25
// and the skill is not already running, it adds 40 + stamina/2 + ability vigor at once (about 100-140) and rolls its
// 50% chance to improve. For the 5-10 minutes it runs, the vigor rest threshold is pinned at 10 -- resting earns
// nothing -- and food is REFUSED ("Still feeling a surge of vitality, you have no interest in food or drink right
// now"). When it ends the rest threshold becomes 80 + (ability+1)/5.
//
// So for a character that knows it, eating is worse than useless on a farm: every meal holds vigor above 25, which is
// the one place the skill pays, and the fight floor the keeper holds out for (95 for Scooter, with three edible
// mushrooms in the pack) idled him for 60% of a 20-minute window on 2026-11-05. With this on, the fight floor is 0
// and nothing is eaten: the character fights down to the trigger, the trigger refills it, and every trigger is a
// chance at the skill.
//
// WHY ONLY AGAINST WEAK PREY. Low vigor is not free: health regenerates (200-vigor)^2/6 + 1000 ms per point
// (player.kod CalculateHealthTime), about 2.6x slower at 10 vigor than at 100, and below 12 a body cannot run. The
// fleet's own record (provision.mjs) has characters at or below 85 vigor dying at 101.8 per thousand observations
// against 4.4 at 86-120 -- fleet-wide, mostly against prey of their own size. So the default asks that the character's
// maximum health be at least `preyRatio` times the level of the WORST huntable creature the room's spawn table can
// produce, not merely the one being hunted. Survival -- flee lines, the 1-second ladder, ORDINARY_VIGOR_FLOOR (20,
// below the trigger at 25, so a fighting character triggers first) -- is untouched.
//
// THE POLICY: `secondWindFarming`, from the broker's `second_wind_farming`:
//   'off' (default)   never; the old floor and the old meals -- until a farm strategy says `secondWind`
//   'auto'            on when the character knows Second Wind, is farming, and the room's prey is weak enough
//   true / 'on'       on whenever it knows Second Wind and is farming, whatever the prey
//   false             the same as 'off'
//   { mode, preyRatio, eat }   eat: true keeps the meals while still dropping the floor
//
// PURE. The keeper's half is `Autopilot.secondWindFarming` (tools/autopilot/hunt-setup.mjs).

export const SECOND_WIND_DEFAULTS = Object.freeze({
  // OFF by default: a farm strategy turns it on (`secondWind: 'auto'`). Operator 2026-11-05: Icky Cave first, then wider.
  mode: 'off',
  // Character max health over the level of the worst huntable creature in the room's spawn table. Scooter and Zoot,
  // 120 health against the cave's level-50 spider, are 2.4.
  preyRatio: 2,
  eat: false,
});

const MODES = new Set(['auto', 'on', 'off']);

/** The normal form of the policy value; throws on nonsense so a push is refused rather than misread. */
export function normSecondWindFarming(v) {
  if (v === undefined || v === null) return { ...SECOND_WIND_DEFAULTS };
  if (v === true) return { ...SECOND_WIND_DEFAULTS, mode: 'on' };
  if (v === false) return { ...SECOND_WIND_DEFAULTS, mode: 'off' };
  if (typeof v === 'string') {
    if (!MODES.has(v)) throw new Error(`second_wind_farming must be auto, on, off, true, false or { mode, prey_ratio, eat }`);
    return { ...SECOND_WIND_DEFAULTS, mode: v };
  }
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('second_wind_farming must be auto, on, off, true, false or an object');
  const known = new Set(['mode', 'preyRatio', 'prey_ratio', 'eat']);
  const extra = Object.keys(v).filter(k => !known.has(k));
  if (extra.length) throw new Error(`second_wind_farming has unrecognised key(s) ${extra.join(', ')}`);
  // An object without a mode is 'auto': nobody writes a prey ratio for a mode that is off.
  const mode = v.mode === undefined ? 'auto' : v.mode === true ? 'on' : v.mode === false ? 'off' : v.mode;
  if (!MODES.has(mode)) throw new Error('second_wind_farming.mode must be auto, on or off');
  const ratio = v.preyRatio ?? v.prey_ratio ?? SECOND_WIND_DEFAULTS.preyRatio;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0.5 || ratio > 20)
    throw new Error('second_wind_farming.prey_ratio must be a number from 0.5 to 20');
  if (v.eat !== undefined && typeof v.eat !== 'boolean') throw new Error('second_wind_farming.eat must be true or false');
  return { mode, preyRatio: ratio, eat: v.eat ?? SECOND_WIND_DEFAULTS.eat };
}

/**
 * The verdict for one pass.
 *   policy       the raw policy value (normalised here)
 *   farming      the keeper is in farm mode
 *   knows        the character has Second Wind (ability > 0, or the skill in its list when the ability is unread)
 *   maxHealth    the character's maximum health
 *   preyLevels   levels of the huntable creatures the room's spawn table can produce
 * Returns { active, eat, why, ratio, prey_level, mode }.
 */
export function secondWindVerdict({ policy, farming, knows, maxHealth, preyLevels = [] } = {}) {
  let p;
  try { p = normSecondWindFarming(policy); } catch (e) { return { active: false, eat: true, mode: 'invalid', why: e.message }; }
  const base = { mode: p.mode, prey_ratio_wanted: p.preyRatio };
  if (p.mode === 'off') return { ...base, active: false, eat: true, why: 'second_wind_farming is off' };
  if (!farming) return { ...base, active: false, eat: true, why: 'not farming' };
  if (!knows) return { ...base, active: false, eat: true, why: 'does not know Second Wind' };
  const levels = preyLevels.map(Number).filter(n => Number.isFinite(n) && n > 0);
  const preyLevel = levels.length ? Math.max(...levels) : null;
  const ratio = preyLevel && Number.isFinite(maxHealth) && maxHealth > 0 ? +(maxHealth / preyLevel).toFixed(2) : null;
  if (p.mode === 'on')
    return { ...base, active: true, eat: p.eat, ratio, prey_level: preyLevel, why: 'second_wind_farming is on' };
  if (ratio === null)
    return { ...base, active: false, eat: true, ratio, prey_level: preyLevel,
             why: preyLevel === null ? 'nothing known about what this room spawns' : 'own maximum health unknown' };
  if (ratio < p.preyRatio)
    return { ...base, active: false, eat: true, ratio, prey_level: preyLevel,
             why: `prey too strong: ${maxHealth} health over level ${preyLevel} is ${ratio}, under ${p.preyRatio}` };
  return { ...base, active: true, eat: p.eat, ratio, prey_level: preyLevel,
           why: `${maxHealth} health over the room's worst prey (level ${preyLevel}) is ${ratio}, at least ${p.preyRatio}` };
}
