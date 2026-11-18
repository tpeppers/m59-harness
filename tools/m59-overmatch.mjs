// OVERMATCH: A FARMER FAR STRONGER THAN ITS PREY FIGHTS IN THE OPEN AND DOES NOT STOP.
//
// The operator, 2026-11-17/18: "Characters seem to rest far more than needed, especially when farming creatures
// significantly below their power level ... most of the fleet right now is 2x+ stronger than what they're farming and
// likely don't need to rest at all ... they could probably all just rely on second wind and constantly fight
// unless/until they find themselves below, say, 1/3rd max health." And: "we definitely don't want people farming
// monsters less than half their strength to be caring about safe spots at all."
//
// WHAT IT REPLACED, measured on prod over six hours. The Castle Victoria farmers (143-150 max health against level-75
// skeletons and level-55 zombies) spent 25-78% of their samples "holding a proven safe spot" and most of the rest
// "fighting from a proven safe spot": 78% of the room's kills were made from a wall and the room yielded 31% of its
// spawn ceiling. Three rules did it, none of which a policy could lower:
//
//   HEALTH   skills.safetyFor hard-codes engageAt 0.75, so every farmer stopped fighting below three quarters of
//            its bar, took a recovery wall and stayed until hold_resume_above (0.9).
//   VIGOR    the body read "hurt" whenever vigor was under the resting cap (80 of 200) -- and resting only restores
//            vigor TO that cap, so a farmer without a meal crossed one number for ever: fight to 79, wall, rest, 80.
//   WALLS    with two creatures inside melee reach (the normal state of a room that holds ten) the fight moved to a
//            wall and stayed there, pulling monsters to it one at a time.
//
// A live A/B on 2026-11-18 settled which of the three matters: taking only the combat wall away cut kills-from-a-wall
// from ~80% to under 10% and left the kill rate where it was. The health and vigor lines are the part that pays.
//
// THE PREDICATE. One question, asked by every faculty that used to answer it for itself:
//
//   overmatched  =  farming, and my maximum health is at least `preyRatio` times the level of the STRONGEST thing
//                   that can stand in this room -- every row of the room's spawn table, huntable or not, and every
//                   hostile creature in sight right now.
//
// Not "what I hunt": what can hit me while I hunt it. Room 377 is level-30 giant rats and a level-105 lupogg; a
// 150-health farmer there is not overmatched. An unknown creature in sight is a no, a room with no spawn table is a no,
// a body recovering from a death or carrying poison is a no, and a player-versus-player episode is a no -- a person is
// not in the table.
//
// A RATIO, SO IT MEANS THE SAME AT EVERY SIZE. A monster's blow is about level / 12 (Fuzzy(viLevel / Random(10,15)),
// monster.kod), so a body at exactly the ratio reaches its flee line with 0.25 x 1.8 x 12 = 5.4 of the room's hardest
// blows in hand, whether it has 54 health or 250. And nobody small is ever it: the weakest levelled room in the spawn
// table is level 30, so the smallest body this can call overmatched anywhere has 54 health, and the under-30 rule of
// skills.safetyFor (do not start a fight below nine tenths) is never the one overridden.
//
// WHILE IT IS ON (Autopilot.overmatch / healthLines, tools/autopilot/hunt-setup.mjs and senses.mjs):
//
//   rest_below    0.34   the one health line: below it the body stops opening fights and goes to a wall to mend
//   resume_above  0.67   and gets up again here, not at nine tenths
//   flee_below    0.25   where a fight is broken off and the logoff answers (safety().fleeAt; the doomed rung too)
//   vigor                only SPENT (under ORDINARY_VIGOR_FLOOR, 20) is a reason to sit; under the resting cap is not
//   walls                no fight opens from a wall and none is taken for a crowd, unless wall_at_attackers says so
//
// THE LOGOFF BELONGS TO THE FLEE LINE. A stop above it -- for health under the rest line, or for spent vigor -- takes its
// wall without the play-dead logoff a recovery performs on arrival: every logoff opens a healing session
// (m59-healing-session.mjs) that bars a second logoff and every town trip until FULL health, which a farmer that goes
// back to the fight at two thirds may not see for an hour. And a body that HAS spent its logoff heals as it always did:
// while that session is open its resume line is hold_resume_above again.
//
// Everything that is not farming is untouched: a journey keeps its own lines (travel_guard, travelHoldBelow), death
// recovery still rests to whole, and poison still shelters in place.
//
// THE POLICY: `overmatch`, from the broker's `overmatch`:
//   'auto' (default)   on when the predicate holds
//   true / 'on'        on whenever farming, whatever the prey (still off while held, recovering, poisoned or in PvP)
//   false / 'off'      never: the lines and walls this character had before
//   { mode, prey_ratio, rest_below, resume_above, flee_below, wall_at_attackers }
//
// PURE. The keeper's half is `Autopilot.overmatch` (tools/autopilot/hunt-setup.mjs).

export const OVERMATCH_DEFAULTS = Object.freeze({
  mode: 'auto',
  // Maximum health over the level of the strongest thing that can stand in the room. 1.8 and not 2: the operator
  // counts Kermit (143), Lew (146), Rizzo (148) and Piggy (149) as overmatched against level-75 skeletons, which is
  // 1.91 to 1.99. A strict 2 excludes all four.
  preyRatio: 1.8,
  restBelow: 0.34,      // "below, say, 1/3rd max health"
  resumeAbove: 0.67,
  fleeBelow: 0.25,
  // null: no wall is taken for a crowd. A number puts the response wall back at that many creatures in melee reach.
  wallAtAttackers: null,
});

// How far above the ordinary vigor floor a body that sat down SPENT must be before it gets up, when Second Wind is
// its vigor supply. Above the trigger at 25, so the first swings after the rest are the ones that fire the skill.
export const OVERMATCH_VIGOR_MARGIN = 10;

const MODES = new Set(['auto', 'on', 'off']);
const SHAPE = 'overmatch must be auto, on, off, true, false or { mode, prey_ratio, rest_below, resume_above, flee_below, wall_at_attackers }';
// camelCase and snake_case of each key, like second_wind_farming: a roster may carry either.
const KEYS = Object.freeze({
  mode: ['mode'],
  preyRatio: ['preyRatio', 'prey_ratio'],
  restBelow: ['restBelow', 'rest_below'],
  resumeAbove: ['resumeAbove', 'resume_above'],
  fleeBelow: ['fleeBelow', 'flee_below'],
  wallAtAttackers: ['wallAtAttackers', 'wall_at_attackers'],
});
const KNOWN = new Set(Object.values(KEYS).flat());

function pick(v, name) {
  const [a, b] = KEYS[name];
  if (b && v[a] !== undefined && v[b] !== undefined && v[a] !== v[b])
    throw new Error(`overmatch gives both ${a} and ${b}, and they disagree`);
  return v[a] !== undefined ? v[a] : (b ? v[b] : undefined);
}

function fraction(v, name, fallback) {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1)
    throw new Error(`overmatch.${name} must be a fraction of maximum health above 0 and at most 1`);
  return v;
}

/** The normal form of the policy value; throws on nonsense so a push is refused rather than misread. */
export function normOvermatch(v) {
  if (v === undefined || v === null) return { ...OVERMATCH_DEFAULTS };
  if (v === true) return { ...OVERMATCH_DEFAULTS, mode: 'on' };
  if (v === false) return { ...OVERMATCH_DEFAULTS, mode: 'off' };
  if (typeof v === 'string') {
    if (!MODES.has(v)) throw new Error(SHAPE);
    return { ...OVERMATCH_DEFAULTS, mode: v };
  }
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(SHAPE);
  const extra = Object.keys(v).filter(k => !KNOWN.has(k));
  if (extra.length) throw new Error(`overmatch has unrecognised key(s) ${extra.join(', ')}`);
  // An object without a mode is 'auto': nobody writes a ratio or a line for a mode that is off.
  const m = pick(v, 'mode');
  const mode = m === undefined ? 'auto' : m === true ? 'on' : m === false ? 'off' : m;
  if (!MODES.has(mode)) throw new Error('overmatch.mode must be auto, on or off');
  const ratio = pick(v, 'preyRatio') ?? OVERMATCH_DEFAULTS.preyRatio;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 1 || ratio > 20)
    throw new Error('overmatch.prey_ratio must be a number from 1 to 20');
  const restBelow = fraction(pick(v, 'restBelow'), 'rest_below', OVERMATCH_DEFAULTS.restBelow);
  const resumeAbove = fraction(pick(v, 'resumeAbove'), 'resume_above', OVERMATCH_DEFAULTS.resumeAbove);
  const fleeBelow = fraction(pick(v, 'fleeBelow'), 'flee_below', OVERMATCH_DEFAULTS.fleeBelow);
  // THE THREE LINES ARE ORDERED, or two faculties disagree: a ladder that flees above the line the fight gate opens at
  // breaks off every fight it starts, and a rest that ends below the line that began it begins again at once.
  if (!(fleeBelow < restBelow))
    throw new Error(`overmatch.flee_below (${fleeBelow}) must be under rest_below (${restBelow})`);
  if (!(restBelow < resumeAbove))
    throw new Error(`overmatch.rest_below (${restBelow}) must be under resume_above (${resumeAbove})`);
  const w = pick(v, 'wallAtAttackers');
  let wallAtAttackers = OVERMATCH_DEFAULTS.wallAtAttackers;
  if (w !== undefined && w !== null) {
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > 20)
      throw new Error('overmatch.wall_at_attackers must be a whole number from 1 to 20, or null for no wall');
    wallAtAttackers = w;
  }
  return { mode, preyRatio: ratio, restBelow, resumeAbove, fleeBelow, wallAtAttackers };
}

/**
 * WHAT A FARM STRATEGY FILE MAY SAY: whether this farm is an overmatch farm, at what ratio, and whether a crowd still
 * earns a wall. NOT the health lines -- when a character rests and flees is survival and stays with the keeper and the
 * operator (m59-strategy-schema.mjs PROTECTED_NAMES); the operator sets them with the `overmatch` order.
 */
export function normOvermatchForStrategy(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const lines = [...KEYS.restBelow, ...KEYS.resumeAbove, ...KEYS.fleeBelow].filter(k => v[k] !== undefined);
    if (lines.length)
      throw new Error(`overmatch.${lines.join(', overmatch.')} is survival and stays with the keeper: a strategy says ` +
        'whether its farm is an overmatch farm (mode, prey_ratio, wall_at_attackers), never when the character rests or flees');
  }
  normOvermatch(v);
  return v;
}

const levelsOf = list => (Array.isArray(list) ? list : []).map(Number).filter(n => Number.isFinite(n) && n > 0);

/**
 * The verdict for one moment.
 *   policy          the raw policy value (normalised here)
 *   farming         the keeper is in farm mode with something to hunt
 *   held            null, or one sentence saying why the body is not the farm's right now (a journey, an errand, a lease)
 *   maxHealth       the character's maximum health
 *   roomLevels      levels of EVERY row of this room's spawn table, huntable or not; null when the table is unknown
 *   roomUnknown     names of creatures the table can produce whose level is not known (a townsperson is not one)
 *   visibleLevels   levels of the hostile creatures in sight
 *   visibleUnknown  names of hostile creatures in sight whose level is not known
 *   recovering      resting to whole after a death
 *   ailing          null/false, or the poison or disease on the body: the ordinary ladder shelters and mends it first
 *   pvp             null/false, or what makes this a player-versus-player moment
 * Returns { active, mode, why, ratio, prey_level, prey_ratio_wanted, rest_below, resume_above, flee_below,
 *           wall_at_attackers }. Every inactive verdict says why in one sentence.
 */
export function overmatchVerdict({ policy, farming = false, held = null, maxHealth = null, roomLevels = null,
                                   roomUnknown = [], visibleLevels = [], visibleUnknown = [], recovering = false,
                                   ailing = null, pvp = null } = {}) {
  let p;
  try { p = normOvermatch(policy); }
  catch (e) {
    return { active: false, mode: 'invalid', why: `the overmatch policy is unreadable (${e.message}), which is the old behaviour`,
             ratio: null, prey_level: null, prey_ratio_wanted: null,
             rest_below: null, resume_above: null, flee_below: null, wall_at_attackers: null };
  }
  const room = levelsOf(roomLevels), seen = levelsOf(visibleLevels);
  const all = [...room, ...seen];
  const preyLevel = all.length ? Math.max(...all) : null;
  const health = Number(maxHealth);
  const knownHealth = Number.isFinite(health) && health > 0;
  const ratio = preyLevel && knownHealth ? +(health / preyLevel).toFixed(2) : null;
  const base = { mode: p.mode, ratio, prey_level: preyLevel, prey_ratio_wanted: p.preyRatio,
                 rest_below: p.restBelow, resume_above: p.resumeAbove, flee_below: p.fleeBelow,
                 wall_at_attackers: p.wallAtAttackers };
  const no = why => ({ active: false, why, ...base });
  if (p.mode === 'off') return no('overmatch is off for this character');
  if (!farming) return no('not farming');
  if (held) return no(String(held));
  if (!knownHealth) return no('own maximum health unknown');
  if (recovering) return no('recovering from a death: resting to whole first');
  if (ailing)
    return no(`${typeof ailing === 'string' ? ailing : 'poisoned or diseased'}: the ordinary ladder shelters and mends it first`);
  if (pvp) return no(typeof pvp === 'string' ? pvp : 'a player-versus-player episode: a person is not in the spawn table');
  if (p.mode === 'on')
    return { active: true, why: 'overmatch is on for this character, whatever the prey', ...base };
  if (!room.length) return no('nothing known about what this room spawns');
  const names = list => [...new Set((Array.isArray(list) ? list : []).filter(Boolean).map(String))].slice(0, 3).join(', ');
  if (names(roomUnknown)) return no(`this room can spawn a creature of unknown level (${names(roomUnknown)})`);
  if (names(visibleUnknown)) return no(`a creature of unknown level is in sight (${names(visibleUnknown)})`);
  // Compared unrounded: 143 over 75 is 1.9067, and a ratio rounded for the journal must never decide the verdict.
  if (health < p.preyRatio * preyLevel)
    return no(`not overmatched: ${health} health over the strongest thing here (level ${preyLevel}) is ${ratio}, under ${p.preyRatio}`);
  return { active: true,
           why: `${health} health over the strongest thing here (level ${preyLevel}) is ${ratio}, at least ${p.preyRatio}`,
           ...base };
}
