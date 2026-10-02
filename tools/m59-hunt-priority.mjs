// HUNT PRIORITY: WHICH OF THE ACCEPTABLE QUARRY TO TAKE FIRST.
//
//   import { huntPrioritySpec, orderByHuntPriority, huntPriorityProblems } from './m59-hunt-priority.mjs';
//
// `hunt` is a SET of acceptable quarry and the keeper takes whichever is in front of it
// (m59-spawns.mjs huntNames). That is right for a two-generator room worked for the room's
// whole spawn rate, and wrong for one the operator named on 2026-10-02: Kermit (t1) farms
// Faronath (537) for living trees, and "should probably actually prioritize spiders when
// farming ... since all the Qor casters can't/won't kill them because of the karma effect".
// A spider in 537 is 5% of the table and a fleetmate that will not touch it holds a cap slot
// for ever; the one character that can clear it should clear it FIRST.
//
// So `huntPriority` is an ORDER LAID OVER THE SET, and only that:
//
//   * IT NEVER WIDENS THE HUNT. It reorders the list the keeper has already built — after
//     findCreature's hunt match, confinement, the proved-unreachable avoid set, pull cooling
//     and the island filter. A creature none of those passed is not in the list and no
//     priority can put it there, so every safety gate that shapes the list still applies,
//     and every gate after selection (engage health, vigor floor, wall, flee line, crowd)
//     still applies to whatever comes first. A priority name outside `hunt` matches nothing
//     in the list; it is reported by `huntPriorityProblems`, never acted on.
//   * IT FALLS THROUGH. No spider in the list means the head of the list is whatever the
//     next priority (then the unlisted remainder) puts there, in the order the keeper would
//     have used anyway — distance, then claim occupancy (rankQuarries).
//   * THE WOUNDED FOE STAYS FIRST. A kill pays only a character that damaged the creature
//     AND still targets it (player.kod:7764-7816), so `preferId` — a pending pull, the foe
//     already hurt, a partner's agreed target — outranks the priority. Abandoning a tree at
//     40% for a spider that just walked in would throw that work away.
//   * SILENCE IS THE OLD BEHAVIOUR. null or [] returns the list untouched.
//
// PURE: no client, no world. The keeper hands in a name reader and the same matcher it uses
// for `hunt` (huntMatch -> m59-spawns.mjs huntMatcher), so "spider" here means exactly what
// "spider" means in `hunt` — the creature called spider, not the black or baby one.

const identity = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Validate and normalise a `huntPriority` order. null / undefined / [] -> null (inert).
 * An array of non-empty strings -> trimmed, de-duplicated by creature identity, in order.
 * Anything else THROWS with the reason: a malformed order coerced to null would report
 * success and prioritise nothing, which is the silent-disable shape this repository refuses.
 */
export function huntPrioritySpec(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string')
    throw new Error('hunt_priority is an ordered LIST of creature names, e.g. ["spider", ' +
      `"living tree"]; got the single string ${JSON.stringify(value)} — wrap it in a list`);
  if (!Array.isArray(value))
    throw new Error(`hunt_priority is an ordered list of creature names or null; got ${JSON.stringify(value)}`);
  const out = [], seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string' || !identity(raw))
      throw new Error(`hunt_priority entries are creature names; ${JSON.stringify(raw)} is not one`);
    const name = raw.trim().replace(/\s+/g, ' ');
    if (seen.has(identity(name))) continue;
    seen.add(identity(name));
    out.push(name);
  }
  if (out.length > 20) throw new Error('hunt_priority names at most 20 creatures');
  return out.length ? out : null;
}

/**
 * Priority names the hunt set will never produce, so the order can never act on them.
 * `matcherFor(want)` returns a predicate over live names (the keeper's huntMatch); a
 * priority name is covered when the hunt set accepts a creature of that name.
 */
export function huntPriorityProblems(priority, hunt, { matcherFor } = {}) {
  const order = Array.isArray(priority) ? priority : [];
  if (!order.length) return [];
  const names = (Array.isArray(hunt) ? hunt : hunt == null ? [] : [hunt]).filter(h => identity(h));
  if (!names.length)
    return order.map(name => ({ name, why: 'nothing is being hunted, so there is nothing to order' }));
  const accepts = typeof matcherFor === 'function'
    ? matcherFor(names)
    : live => names.some(h => identity(h) === identity(live));
  return order.filter(name => !accepts(name)).map(name => ({
    name, why: `not in hunt (${names.join(', ')}): hunt_priority only orders what hunt allows, ` +
               'so this entry is ignored' }));
}

/**
 * Reorder `found` (already filtered, already ranked) by the priority order.
 * Returns a NEW array; `found` itself is untouched. Stable within each bucket.
 *
 *   nameOf(o)      -> the live display name of a candidate
 *   matcherFor(n)  -> predicate over live names for one priority entry
 *   preferId       -> the one candidate that stays first regardless (the wounded foe / pull)
 */
export function orderByHuntPriority(found, priority, { nameOf = o => o?.name ?? '', matcherFor = null,
                                                      preferId = null } = {}) {
  const list = Array.isArray(found) ? found : [];
  const order = Array.isArray(priority) ? priority : [];
  if (!order.length || list.length < 2) return list.slice();
  const tests = order.map(name => typeof matcherFor === 'function'
    ? matcherFor(name) : live => identity(live) === identity(name));
  const bucketOf = o => {
    if (preferId != null && o?.id === preferId) return -1;
    const n = nameOf(o);
    const i = tests.findIndex(t => t(n));
    return i === -1 ? tests.length : i;
  };
  return list.map((o, at) => ({ o, at, b: bucketOf(o) }))
    .sort((x, y) => x.b - y.b || x.at - y.at)
    .map(x => x.o);
}

/** Which priority entry (index, name) the chosen quarry answered to, for status/notes. */
export function priorityRankOf(name, priority, { matcherFor = null } = {}) {
  const order = Array.isArray(priority) ? priority : [];
  for (let i = 0; i < order.length; i++) {
    const t = typeof matcherFor === 'function' ? matcherFor(order[i])
      : live => identity(live) === identity(order[i]);
    if (t(name)) return { rank: i, entry: order[i] };
  }
  return { rank: null, entry: null };
}
