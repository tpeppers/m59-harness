// PER-CREATURE LOOT FILTER: AFTER KILLING ONE OF THESE, TAKE ONLY THOSE.
//
//   import { lootOnlySpec, planLootOnly, newLootOnlyMemory } from './m59-loot-filter.mjs';
//
// The operator, 2026-10-02: Kermit (t1) farms living trees in Faronath (537) for wands and
// entroot berries, and should kill the spiders there too — "but not bother with their loot
// except purple mushrooms". Spiders roll the generic TID_MEDIUM_TOUGH treasure table, so an
// avoid list would have to name most of the game; an ALLOW list per creature names one item.
//
//   lootOnly: { "spider": ["purple mushroom"] }
//
// WHOLE NAMES, LIKE THE SUPPLY TOOL. Item names compare through `itemNameKey`
// (m59-items.mjs) — case, punctuation and plurals forgiven, words not: "purple mushroom" is
// not "mushroom", and "mushroom" is not "purple mushroom". Creature names compare through
// the same matcher `hunt` uses (huntMatcher), so "spider" is the creature called spider and
// not the black, baby or queen spider.
//
// ATTRIBUTION — WHICH ITEMS ON THE FLOOR CAME FROM THIS KILL. The server does not say. A
// Meridian monster has no corpse container: on death it creates its treasure as ordinary
// room objects at its square, and nothing on the wire ties an item to the monster that
// dropped it. So attribution is BY NOVELTY: `fight()` snapshots the ids of every gettable
// object in the room when it chooses its foe, and the post-kill loot treats an id that was
// NOT in that snapshot as the kill's drop. Only those are filtered. Things already on the
// floor are looted exactly as before (they are some earlier kill's, usually a tree's).
//
// The trade-offs, said out loud:
//   * Something that appears DURING the fight from another source — a fleetmate's kill in
//     the same room, a player's drop, an item that came into view as we stepped — reads as
//     this kill's drop and is filtered by this creature's list. In 537 with one character on
//     the room that is rare; it fails toward leaving loot, never toward taking spider junk.
//   * With no snapshot (a caller that did not take one) the filter falls back to "the last
//     kill was a <creature>" and applies to the WHOLE floor in reach for that one loot call.
//     Stricter, and it leaves an older tree drop until the next tree kill's loot takes it.
//   * What the filter left behind is REMEMBERED — by id AND name, in that room, for ten
//     minutes — so the next tree kill's ordinary loot, the clean-up sweep and the `loot`
//     tool do not walk over and pick the spider junk up anyway. The name check is there
//     because ids are handles that recycle (CLAUDE.md); a recycled id naming a different
//     item is not on the list. An explicit id list from a caller is never second-guessed.
//
// PURE. No client and no session: the session's lootFloor hands in the floor rows and the
// kill, and gets back the ids to leave and why.

import { itemNameKey } from './m59-items.mjs';

export const LOOT_ONLY_MEMORY_MS = 10 * 60_000;
const identity = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Validate and normalise a `lootOnly` policy.
 * null / undefined / {} -> null (inert). Otherwise { creature: [item, ...] } with string keys
 * and a NON-EMPTY list of item names per key (an empty list would mean "take nothing", which
 * is spelt as a list of one item nobody drops — refused here so a typo cannot mean it).
 * `resolveItem(name)` may canonicalise and must THROW on an unknown item (the broker passes
 * m59-items.mjs resolveItemName); without it the names are kept as given.
 * Throws with the reason on any other shape — never coerces to null.
 */
export function lootOnlySpec(value, { resolveItem = null } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('loot_only is an object of creature name -> list of item names, e.g. ' +
      `{"spider": ["purple mushroom"]}; got ${JSON.stringify(value)}`);
  const out = {};
  for (const [creature, items] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(creature) || !identity(creature))
      throw new Error(`loot_only: ${JSON.stringify(creature)} is not a creature name`);
    const list = typeof items === 'string' ? null : items;
    if (!Array.isArray(list) || !list.length)
      throw new Error(`loot_only.${creature} must be a non-empty LIST of item names ` +
        `(whole names, e.g. ["purple mushroom"]); got ${JSON.stringify(items)}`);
    const names = [];
    for (const it of list) {
      if (typeof it !== 'string' || !itemNameKey(it))
        throw new Error(`loot_only.${creature}: ${JSON.stringify(it)} is not an item name`);
      let name = it.trim();
      if (resolveItem) {
        try { name = resolveItem(name); }
        catch (e) { throw new Error(`loot_only.${creature}: ${e.message}`); }
      }
      if (!names.some(n => itemNameKey(n) === itemNameKey(name))) names.push(name);
    }
    const key = creature.trim().replace(/\s+/g, ' ');
    if (Object.keys(out).some(k => identity(k) === identity(key)))
      throw new Error(`loot_only names ${JSON.stringify(key)} twice`);
    out[key] = names;
  }
  return Object.keys(out).length ? out : null;
}

/** The rule for a killed creature, or null. `matcherFor(key)` -> predicate over live names. */
export function lootOnlyRule(spec, creatureName, { matcherFor = null } = {}) {
  if (!spec || !creatureName) return null;
  for (const [key, items] of Object.entries(spec)) {
    const test = typeof matcherFor === 'function' ? matcherFor(key)
      : live => identity(live) === identity(key);
    if (test(creatureName)) return { creature: key, items };
  }
  return null;
}

export const itemAllowed = (name, items = []) =>
  items.some(want => { const k = itemNameKey(want); return !!k && k === itemNameKey(name); });

export function newLootOnlyMemory() {
  return { room: null, left: new Map(), kills: 0, filtered: 0, taken_allowed: 0, last: null };
}

function prune(memory, room, now) {
  if (!memory) return;
  if (room != null && memory.room !== room) { memory.left.clear(); memory.room = room; }
  for (const [id, e] of memory.left) if (now - e.at > LOOT_ONLY_MEMORY_MS) memory.left.delete(id);
}

/**
 * Decide which floor rows to leave.
 *
 *   spec      normalised lootOnly policy (null -> nothing is filtered, memory is still honoured
 *             only while a spec is set; with no spec the old behaviour is exact)
 *   kill      { name, before?: Set<id> | id[] } — the creature this loot call follows, and the
 *             gettable ids that were on the floor when the fight began. null for a loot call
 *             that does not follow a kill (clean-up, the loot tool, a tree kill's own loot is
 *             a kill too — it just has no rule).
 *   floor     [{ id, name }] — the candidates lootFloor is about to take.
 *   memory    newLootOnlyMemory() state, mutated: what was left is remembered.
 *   room      room NUMBER (never an object id) the floor is in.
 *
 * Returns { leave: [{ id, name, why }], rule, attribution }.
 */
export function planLootOnly({ spec, kill = null, floor = [], memory = null, room = null,
                               now = Date.now(), matcherFor = null } = {}) {
  const leave = [];
  if (!spec) return { leave, rule: null, attribution: null };
  prune(memory, room, now);
  const rule = kill?.name ? lootOnlyRule(spec, kill.name, { matcherFor }) : null;
  const before = kill?.before == null ? null
    : kill.before instanceof Set ? kill.before : new Set([].concat(kill.before));
  const attribution = !rule ? null : before ? 'new-since-the-fight' : 'whole-floor';
  if (rule && memory) { memory.kills++; memory.last = { creature: rule.creature, at: now, attribution }; }
  for (const row of floor) {
    const remembered = memory?.left.get(row.id);
    if (remembered && itemNameKey(remembered.name) === itemNameKey(row.name)) {
      leave.push({ id: row.id, name: row.name,
        why: `LOOT_ONLY — left earlier after a ${remembered.creature} kill; ` +
             `loot_only takes only ${remembered.items.join(', ')} from it` });
      continue;
    }
    if (!rule) continue;
    const fromThisKill = before ? !before.has(row.id) : true;
    if (!fromThisKill) continue;
    if (itemAllowed(row.name, rule.items)) { if (memory) memory.taken_allowed++; continue; }
    leave.push({ id: row.id, name: row.name,
      why: `LOOT_ONLY — dropped by the ${rule.creature} just killed, and loot_only takes only ` +
           `${rule.items.join(', ')} from a ${rule.creature}` +
           (before ? '' : ' (no floor snapshot, so the whole floor was read as this kill\'s)') });
    if (memory) {
      memory.left.set(row.id, { name: row.name, creature: rule.creature, items: rule.items, at: now });
      memory.filtered++;
    }
  }
  return { leave, rule, attribution };
}

/** For autopilot status. null when the policy is unset. */
export function lootOnlyStatus(spec, memory = null) {
  if (!spec) return null;
  return {
    rules: spec,
    kills_filtered: memory?.kills ?? 0,
    items_left: memory?.filtered ?? 0,
    allowed_taken: memory?.taken_allowed ?? 0,
    remembered_on_floor: memory?.left?.size ?? 0,
    last: memory?.last ?? null,
    attribution: 'items new since the fight began are the kill\'s; older floor items loot as before',
  };
}

/** The gettable ids on the floor now — the snapshot fight() takes when it picks a foe. */
export function floorSnapshot(objects, isGettable) {
  const ids = new Set();
  for (const o of objects ?? []) if (o && isGettable(o)) ids.add(o.id);
  return ids;
}
