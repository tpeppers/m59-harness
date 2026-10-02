// CREATURES THIS CHARACTER LEAVES ALIVE, EVEN WHEN THEY ATTACK IT.
//
//   policy.spareCreatures = ['spider']        (a farm strategy's `spare`, or an `autopilot` push)
//
// The operator, 2026-10-02, Icky Cave (27): "clear all the orcs from the cave, and specifically leave
// the spiders alive even if they attack our characters". cave2.kod spawns orc/spider 50/50 against a
// room cap of 10 (monsroom.kod piMonster_count_max) and OkayToGetChalice refuses while ANY orc is in
// the room. So the cave is held orc-free by letting ten spiders fill the cap -- and one spider killed
// by a reflex swing reopens a slot an orc can take.
//
// WHAT IT IS: a filter on WHAT TO SWING AT, applied in two places, and nothing else.
//   * findCreature skips a spared monster, so every caller that picks a target -- hunting, the
//     fight loop, fight-back -- moves on to something else or reports nothing to fight;
//   * the client's attackVeto refuses the packet, so a path that names the id directly is still
//     covered. Every attack reaches M59Client.attack; that is the point of putting it there.
// WHAT IT IS NOT: a change to survival. The keeper still rests, flees at its flee line and recovers
// exactly as before; a character being bitten by a spared spider walks away from it rather than
// swinging. Players are never matched: this is about monsters, and the war paths are untouched.
//
// Matching is by WHOLE WORD, case-insensitive: 'spider' spares "spider", "giant spider" and "spider
// queen", and never matches "spiderweb mushroom" or a player called "Spiderman".
import { OF } from './m59-parse.mjs';

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cache = new WeakMap();

/** The compiled matcher for a pattern list, or null when nothing is spared. */
export function spareMatcher(patterns) {
  if (!Array.isArray(patterns) || !patterns.length) return null;
  if (cache.has(patterns)) return cache.get(patterns);
  const words = patterns.map(p => String(p ?? '').trim().toLowerCase()).filter(Boolean);
  const re = words.length ? new RegExp(`(^|[^a-z])(${words.map(esc).join('|')})($|[^a-z])`, 'i') : null;
  const fn = re ? name => re.test(String(name ?? '')) : null;
  cache.set(patterns, fn);
  return fn;
}

/** Is this room object a spared MONSTER under these patterns? Players never are. */
export function isSpared(client, o, patterns) {
  if (!o || (o.flags & OF.PLAYER)) return false;
  const m = spareMatcher(patterns);
  if (!m) return false;
  return m(client?.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
}

/** The session's spare list, published by its Autopilot (`s.sparePatterns`). */
export const sparePatternsOf = s => {
  try { return typeof s?.sparePatterns === 'function' ? s.sparePatterns() : null; } catch { return null; }
};

/** The attackVeto half: refuse an attack packet at a spared monster in the current room. */
export function vetoSpared(session, client, id) {
  const patterns = sparePatternsOf(session);
  if (!patterns?.length) return false;
  return isSpared(client, client?.room?.objects?.get?.(id), patterns);
}
