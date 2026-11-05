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

// TWO HOURS, NOT TEN MINUTES (operator 2026-10-30: a farmer confined to one room, Floyd in 2501, keeps nothing but three
// schools' disciple robes; at ten minutes every robe of the other three -- the same name, told apart only by colour -- and
// every tooth and scroll it had left became "already on the floor before the fight" and was picked up). A room change
// still clears it.
export const LOOT_ONLY_MEMORY_MS = 2 * 60 * 60_000;
const identity = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// "*": ANY ITEM ON THE FLOOR, WHOEVER DROPPED IT (operator 2026-11-05, Scooter in the Icky Cave: "explicitly limit him to only
// looting: purple mushrooms, sapphires, orc teeth, and edible mushrooms" -- small round shields and spare armour/weapons kept
// coming home because a creature rule filters only what is attributed to the kill just made, and older floor items loot as
// before). With "*" set, nothing off that list is picked up from any floor, after a kill or not. A creature rule still
// applies on top of it (an item must pass both).
export const ANY = '*';

// THE LOOT LIST GOVERNS THE WHOLE FLOOR BY DEFAULT (operator 2026-11-05: "almost always, we only want people applying their
// loot list + 'grab myself an armor if I'm missing one' as the rules for looting ... sometimes we literally only want
// characters picking up their loot list, but the default should be 'loot list + 1 armor for wearing'").
//   policy.lootOnlyFloor = null                         the default: { scope: 'floor', armor: true }
//   { scope: 'floor' }   a character with a loot list takes ONLY listed items from ANY floor: the "*" list if it has one,
//                        else every item any of its creature rules names. Creature rules still apply on top after a kill.
//   { scope: 'kill' }    the old behaviour: a creature rule filters only the kill's own drop ("*" still applies if set).
//   { armor: true }      the one exception: a character wearing NO body armour and carrying none picks up ONE piece.
//   { armor: false }     "literally only the loot list".
// A character with no loot list (lootOnly null) is unaffected: nothing here invents a list.
export const LOOT_ONLY_FLOOR_DEFAULTS = Object.freeze({ scope: 'floor', armor: true });
export const ARMOR_RX = /\b(armor|armour|mail|plate)\b/i;
export const isBodyArmor = name => ARMOR_RX.test(String(name ?? '')) && !/shield|helm|gauntlet|boots?|gloves?/i.test(String(name ?? ''));
export function lootFloorSpec(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error(`loot_only_floor is { scope: "floor" | "kill", armor: true | false } or null; got ${JSON.stringify(value)}`);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'scope') { if (v !== 'floor' && v !== 'kill') throw new Error('loot_only_floor.scope must be "floor" or "kill"'); out.scope = v; }
    else if (k === 'armor') { if (typeof v !== 'boolean') throw new Error('loot_only_floor.armor must be true or false'); out.armor = v; }
    else throw new Error(`loot_only_floor: unrecognised key ${k}`);
  }
  return Object.keys(out).length ? out : null;
}
export const lootFloorRule = value => ({ ...LOOT_ONLY_FLOOR_DEFAULTS, ...(value ?? {}) });
/** The list that governs the whole floor: "*" if set, else (scope floor) the union of the creature lists; null = none. */
export function floorAllowList(spec, rule = LOOT_ONLY_FLOOR_DEFAULTS) {
  if (!spec) return null;
  if (spec[ANY]) return spec[ANY];
  if (rule.scope !== 'floor') return null;
  const out = [];
  for (const items of Object.values(spec)) for (const it of items) if (!out.includes(it)) out.push(it);
  return out.length ? out : null;
}

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
    if (['__proto__', 'constructor', 'prototype'].includes(creature) || (!identity(creature) && creature.trim() !== ANY))
      throw new Error(`loot_only: ${JSON.stringify(creature)} is not a creature name`);
    const list = typeof items === 'string' ? null : items;
    if (!Array.isArray(list) || !list.length)
      throw new Error(`loot_only.${creature} must be a non-empty LIST of item names ` +
        `(whole names, e.g. ["purple mushroom"]); got ${JSON.stringify(items)}`);
    const names = [];
    for (const it of list) {
      // A COLOUR MAY BE NAMED: "robes of the disciple#126|203|236" takes that item only in those palette translations
      // (operator 2026-10-30: Qor, Kraanan and Shal'ille disciple robes -- every school's robe has the same name, and only
      // robedisc.kod's master translation tells them apart). The suffix stays on the stored name; the name part resolves.
      const hash = typeof it === 'string' ? it.lastIndexOf('#') : -1;
      const xlat = hash > 0 ? it.slice(hash + 1).trim() : null;
      if (xlat != null && !/^\d+(\|\d+)*$/.test(xlat))
        throw new Error(`loot_only.${creature}: ${JSON.stringify(it)} -- a colour suffix is #<n>|<n>... (palette translations)`);
      const base = hash > 0 ? it.slice(0, hash) : it;
      if (typeof it !== 'string' || !itemNameKey(base))
        throw new Error(`loot_only.${creature}: ${JSON.stringify(it)} is not an item name`);
      let name = base.trim();
      if (resolveItem) {
        try { name = resolveItem(name); }
        catch (e) { throw new Error(`loot_only.${creature}: ${e.message}`); }
      }
      if (xlat != null) name = `${name}#${xlat}`;
      if (!names.some(n => n === name || (!n.includes('#') && !name.includes('#') && itemNameKey(n) === itemNameKey(name))))
        names.push(name);
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
    if (key === ANY) continue;   // "*" is never a creature
    const test = typeof matcherFor === 'function' ? matcherFor(key)
      : live => identity(live) === identity(key);
    if (test(creatureName)) return { creature: key, items };
  }
  return null;
}

/** Is this floor row on the list? A listed name with a #n|n suffix matches only those palette translations. */
export const itemAllowed = (name, items = [], translation = null) =>
  items.some(want => {
    const s = String(want ?? ''), hash = s.lastIndexOf('#');
    const k = itemNameKey(hash > 0 ? s.slice(0, hash) : s);
    if (!k || k !== itemNameKey(name)) return false;
    return hash <= 0 || s.slice(hash + 1).split('|').map(Number).includes(Number(translation));
  });

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
                               now = Date.now(), matcherFor = null, floorRule = null, bareOfArmor = false } = {}) {
  const leave = [];
  if (!spec) return { leave, rule: null, attribution: null };
  const fr = lootFloorRule(floorRule), whole = floorAllowList(spec, fr);
  let armorTaken = false;
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
    if (whole && !itemAllowed(row.name, whole, row.translation ?? null)) {
      if (fr.armor && bareOfArmor && !armorTaken && isBodyArmor(row.name)) { armorTaken = true; continue; }   // the one armour, to wear
      leave.push({ id: row.id, name: row.name, why: `LOOT_ONLY ${spec[ANY] ? '*' : 'floor'} — this character loots only ${whole.join(', ')}, from any floor` +
        (fr.armor && isBodyArmor(row.name) ? (bareOfArmor ? ' (one armour already taken this sweep)' : ' (it already wears or carries body armour)') : '') });
      if (memory) memory.filtered++;
      continue;
    }
    if (!rule) continue;
    const fromThisKill = before ? !before.has(row.id) : true;
    if (!fromThisKill) continue;
    if (itemAllowed(row.name, rule.items, row.translation ?? null)) { if (memory) memory.taken_allowed++; continue; }
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
