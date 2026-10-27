// GANG UP: A CREATURE THIS FLEET FIGHTS ONLY TWO-ON-ONE, OR MORE.
//
//   import { normalizeGangUp, gangUpRuleFor, gangUpQuorum, GANG_UP_DEFAULTS } from './m59-gang-up.mjs';
//
// Operator, 2026-10-27 ~19:35Z, of the Guardians of Zjiria in Ukgoth (599) -- kod StoneTroll, level 120,
// difficulty 8, attack rating 840; i9.kod makes three at game hour 0 whenever none is alive and never
// removes them: "If a guardian is seen, they should try to fight it 2-on-1 (or more than 2 against it),
// that's the only change it should have from regular trolls."
//
// THE INCIDENT THIS IS SHAPED BY. Minutes earlier a coordinator script had switched every crew member in
// 599 to the guardian strategy because two or more crew were in the ROOM. Janice (t7, 79 max health) was
// the only one near the guardian cluster -- Bunsen was forty rows away -- and she fought it alone
// (substrate/postmortems/Janice-2026-10-27T19-41-42-645Z.json). A room is not a party. So the quorum is
// about fleet-mates AT THE MONSTER, and it is decided by the keeper itself, at the moment it chooses its
// quarry, from its own room view -- never by a script that cannot see who is standing where.
//
//   gangUp: { 'guardian of zjiria': { min: 2, radius: 4 } }
//
// A listed creature is a LEGAL TARGET only while at least `min - 1` OTHER fleet-mates stand within
// `radius` coarse squares of THAT creature, measured Chebyshev (max of |d row|, |d col|), in this keeper's
// own view of the room. "Fleet-mate" is `party.isFleetmate` -- the roster plus the menagerie's hosts, the
// same answer "do not shoot" uses -- and never a stranger: a stranger beside the guardian is one more thing
// that may hit us, not a second swinger. Where somebody is standing is all a keeper can see of who is
// fighting what (the party register is per process), so position near it is the whole test.
//
// Without its quorum the creature is handled EXACTLY AS IF `hunt` DID NOT NAME IT, which is the operator's
// "the only change from regular trolls" read literally:
//
//   * it is not chosen, approached or pulled (Autopilot.gangUpFilter on the prey list, closestPullable,
//     the buddy tagger), and a pull already out for it is dropped when the quorum lapses -- the keeper
//     hunts its other prey;
//   * if it walks up to us it is a BYSTANDER (passFarm), so the regular rules answer it unchanged: the
//     engagement ceiling's "will not trade blows with this" for a body it outclasses, hitting back at one
//     inside the band; and the fight-back edict and the survival ladder never consult this at all. A
//     gang-up creature that attacks first is answered as it always was, never passively.
//
// With its quorum it is prey like any other `hunt` entry -- and prey is never measured against the
// engagement ceiling (m59-spawns.mjs huntingGrounds: "THE THREAT CEILING IS ABOUT BYSTANDERS, NOT ABOUT THE
// PREY"). That is the point: an under-80 character may not take a level-120 guardian alone, and may with a
// fleet-mate at it. The one chooser that did apply the ceiling to prey, closestPullable (pull.throughCrowd),
// applies only its karma half to a gang-up creature whose quorum is met.
//
// IT NEVER WIDENS THE HUNT. A creature `hunt` does not name is not prey with or without a quorum; status
// reports such a rule as `ignored`, the way hunt_priority reports an entry hunt never produces.
//
// PURE: no client, no world, no roster. The keeper hands in the players it sees, its fleet-mate test and
// the same matcher it uses for `hunt`, so 'guardian of zjiria' here means what it means there (the
// catalogue's StoneTroll, aliases "Guardian of Zjiria" and "stone troll").

export const GANG_UP_DEFAULTS = Object.freeze({ min: 2, radius: 4 });
export const GANG_UP_MAX_MIN = 24;
export const GANG_UP_MAX_RADIUS = 16;
export const GANG_UP_MAX_CREATURES = 24;

const identity = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// A coordinate, or NaN. Not Number(): Number(null) is 0, and a creature with no square would stand on r0c0.
const coord = v => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate and normalise a `gangUp` spec. null / undefined / {} -> null (inert).
 *   { 'Guardian of Zjiria ': { min: 2 } }  ->  { 'guardian of zjiria': { min: 2, radius: 4 } }
 * Anything malformed THROWS with the reason: a rule coerced to nothing would let the keeper walk into the
 * cluster alone while the file reads as though it forbids exactly that.
 */
export function normalizeGangUp(v) {
  if (v === undefined || v === null) return null;
  if (!isPlain(v))
    throw new Error('gangUp is { "<creature>": { min, radius } } -- e.g. { "guardian of zjiria": { min: 2, radius: 4 } } -- ' +
                    `or null; got ${JSON.stringify(v)}`);
  const entries = Object.entries(v);
  if (entries.length > GANG_UP_MAX_CREATURES) throw new Error(`gangUp names at most ${GANG_UP_MAX_CREATURES} creatures`);
  const out = {}, seen = new Map();
  for (const [raw, rule] of entries) {
    const name = String(raw).trim().replace(/\s+/g, ' ').toLowerCase();
    if (!identity(name)) throw new Error(`gangUp: ${JSON.stringify(raw)} is not a creature name`);
    if (seen.has(identity(name)))
      throw new Error(`gangUp names one creature twice (${JSON.stringify(seen.get(identity(name)))} and ${JSON.stringify(raw)})`);
    seen.set(identity(name), raw);
    if (!isPlain(rule)) throw new Error(`gangUp["${name}"] must be { min, radius }; got ${JSON.stringify(rule)}`);
    const unknown = Object.keys(rule).filter(k => k !== 'min' && k !== 'radius');
    if (unknown.length) throw new Error(`gangUp["${name}"]: unrecognised ${unknown.join(', ')} (a rule has only min and radius)`);
    const min = rule.min === undefined ? GANG_UP_DEFAULTS.min : rule.min;
    const radius = rule.radius === undefined ? GANG_UP_DEFAULTS.radius : rule.radius;
    if (!Number.isInteger(min) || min < 2 || min > GANG_UP_MAX_MIN)
      throw new Error(`gangUp["${name}"].min must be a whole number from 2 to ${GANG_UP_MAX_MIN} -- the bodies on it, ` +
                      `this one included; 1 would be a rule that changes nothing. Got ${JSON.stringify(rule.min)}`);
    if (!Number.isInteger(radius) || radius < 1 || radius > GANG_UP_MAX_RADIUS)
      throw new Error(`gangUp["${name}"].radius must be a whole number of coarse squares from 1 to ${GANG_UP_MAX_RADIUS}; ` +
                      `got ${JSON.stringify(rule.radius)}`);
    out[name] = { min, radius };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The rule a live creature answers to, or null when the spec does not list it.
 * `matcherFor(key)` -> predicate over live names (the keeper's huntMatch); without one, names compare by identity.
 *   -> { creature, min, radius }
 */
export function gangUpRuleFor(spec, liveName, { matcherFor = null } = {}) {
  if (!isPlain(spec) || !liveName) return null;
  for (const [creature, rule] of Object.entries(spec)) {
    let hit = false;
    try { hit = typeof matcherFor === 'function' ? !!matcherFor(creature)(liveName) : identity(creature) === identity(liveName); }
    catch { hit = false; }
    if (hit) return { creature, min: rule.min, radius: rule.radius };
  }
  return null;
}

/** Chebyshev distance in coarse squares: the number of king's moves between two squares. */
export const chebyshev = (a, b) => Math.max(Math.abs(coord(a.row) - coord(b.row)), Math.abs(coord(a.col) - coord(b.col)));

/**
 * Is the quorum met for one creature? `players` are the OTHER players this keeper sees (never itself),
 * as { name, row, col }; `isFleetmate(name)` is party.isFleetmate.
 *   -> { creature, min, radius, need, mates: [name], strangers_near, met, why? }
 * A creature whose square is not known fails closed: nobody can be shown to be standing at it.
 */
export function gangUpQuorum(rule, monster, players = [], { isFleetmate = () => false } = {}) {
  const need = Math.max(0, Number(rule?.min ?? GANG_UP_DEFAULTS.min) - 1);
  const radius = Number(rule?.radius ?? GANG_UP_DEFAULTS.radius);
  const at = { row: coord(monster?.row), col: coord(monster?.col) };
  const known = Number.isFinite(at.row) && Number.isFinite(at.col);
  const mates = [];
  let strangers = 0;
  if (known) for (const p of players ?? []) {
    if (!p || !Number.isFinite(coord(p.row)) || !Number.isFinite(coord(p.col))) continue;
    if (chebyshev(p, at) > radius) continue;
    let ours = false;
    try { ours = !!isFleetmate(p.name); } catch { ours = false; }
    if (ours) mates.push(p.name); else strangers++;
  }
  const met = known && mates.length >= need;
  return { creature: rule?.creature ?? null, min: need + 1, radius, need, mates, strangers_near: strangers, met,
           ...(known ? {} : { why: 'its square is not known, so nobody can be shown to be standing at it' }) };
}
