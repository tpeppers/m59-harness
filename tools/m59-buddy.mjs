// m59-buddy.mjs — THE BUDDY SYSTEM: one character TAGS a monster, its fixed partner KILLS it.
//
// Operator, 2026-10-09: "the Qor disciple will pick full-health targets, attack them, and then pull
// them back to a safe spot that's next to their friendly buddy ... the Qor disciple attacks the
// target, then runs back into the corner and stays there while the buddy kills the target. This
// system lets the Qor disciple gain hitpoints, because you can get hitpoints off a monster as long as
// it's the last thing you attacked and you don't leave the map or log out".
//
// THE KOD IT RESTS ON (player.kod, Meridian59 upstream):
//   * SomethingKilled(what, victim) reaches EVERY object in the room (holder.kod:676). A player whose
//     poKill_target is the victim runs AdvancementCheck with killing_blow=FALSE when someone else
//     landed the blow (player.kod SomethingKilled). Leave the room first and the message never arrives.
//   * AdvancementCheck needs PFLAG_DID_DAMAGE -- set only by DidDamage(amount > 0). A MISS DOES NOT
//     COUNT; the tag is "landed", not "swung".
//   * Attacking anything else switches poKill_target and calls ResetGainFlags: one swing at a
//     bystander throws the tag away. Being HIT by something else does not (AssessDamage only sets
//     poKill_target when it is empty).
//   * Without the killing blow, the roll happens only when monster level > the tagger's BASE max
//     health (gain 2, rolled). At or below it a non-killer gets nothing. So the quarry must out-level
//     the tagger: skeletons (75) do for every Qor disciple of 2026-10-09 (45-69); zombies (55) only
//     for the ones under 55.
//   * Karma moves only for the KILLER (KilledSomething -> AddKarma). The tagger's karma is untouched,
//     which is why a karma-locked disciple wants somebody else to land the blow.
//
// This module is the half that is not the keeper: the policy value's normal form, the per-character
// record two keeper PROCESSES share (the party register in m59-party.mjs is per-process, so a
// partner in another keeper process can never read it), and the pure choices. The behaviour is
// `Autopilot.passBuddy` in m59-autopilot.mjs.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BUDDY_DIR = process.env.M59_BUDDY_DIR || join(HERE, '..', 'substrate', '.buddy');
export const BUDDY_STALE_MS = 45_000;
const AGENT = /^[A-Za-z0-9_-]{1,32}$/;

// ------------------------------------------------------------------------------ the policy value
//
//   { pairs: { t5: 't4', t6: 't10' }, wait_s: 120, tries: 3, reach: 2, quarry: ['skeleton'] }
//
// `pairs` maps TAGGER -> KILLER, both roster slots. One map for the whole system, so every keeper is
// handed the same value and works out its own role -- which is what lets one strategy file be
// assigned to all ten characters, and what makes "keep the same buddy" a fact of the file.
export function normalizeBuddy(v) {
  if (v == null || v === false) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('buddy must be an object { pairs: { tagger: killer } } or null');
  const known = new Set(['pairs', 'wait_s', 'tries', 'reach', 'quarry', 'enabled']);
  const unknown = Object.keys(v).filter(k => !known.has(k));
  if (unknown.length) throw new Error(`buddy: unrecognised key(s) ${unknown.join(', ')}`);
  const pairs = v.pairs;
  if (!pairs || typeof pairs !== 'object' || Array.isArray(pairs) || !Object.keys(pairs).length)
    throw new Error('buddy.pairs must map at least one tagger slot to a killer slot');
  const out = {};
  const seen = new Set();
  for (const [tagger, killer] of Object.entries(pairs)) {
    if (!AGENT.test(tagger) || typeof killer !== 'string' || !AGENT.test(killer))
      throw new Error(`buddy.pairs: ${JSON.stringify(tagger)} -> ${JSON.stringify(killer)} is not slot -> slot`);
    if (tagger === killer) throw new Error(`buddy.pairs: ${tagger} cannot be its own buddy`);
    // EXCLUSIVE, like m59-party: a character in two pairs is in none -- both taggers would wait on
    // one killer standing at only one of their walls.
    for (const a of [tagger, killer]) {
      if (seen.has(a)) throw new Error(`buddy.pairs: ${a} appears in more than one pair`);
      seen.add(a);
    }
    out[tagger] = killer;
  }
  const num = (k, lo, hi, d) => {
    if (v[k] == null) return d;
    const n = Number(v[k]);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`buddy.${k} must be ${lo}..${hi}`);
    return n;
  };
  const quarry = v.quarry == null ? null
    : (Array.isArray(v.quarry) && v.quarry.every(q => typeof q === 'string' && q.trim()))
      ? v.quarry.map(q => q.trim().toLowerCase())
      : (() => { throw new Error('buddy.quarry must be a list of creature names'); })();
  return { enabled: v.enabled !== false, pairs: out, wait_s: num('wait_s', 10, 900, 120),
           tries: num('tries', 1, 20, 12), reach: num('reach', 1, 6, 2), quarry };
}

/** This slot's part in the system: { role: 'tag'|'kill', partner } or null. */
export function roleIn(buddy, agent) {
  if (!buddy?.enabled || !buddy.pairs) return null;
  if (Object.hasOwn(buddy.pairs, agent)) return { role: 'tag', partner: buddy.pairs[agent] };
  for (const [tagger, killer] of Object.entries(buddy.pairs))
    if (killer === agent) return { role: 'kill', partner: tagger };
  return null;
}

// ------------------------------------------------------------------------- the shared record
//
// One file per character, written only by that character's keeper (tmp + rename, so a reader sees
// the old record or the new one, never half of one). No lock: there is exactly one writer.

const fileFor = (agent, dir = BUDDY_DIR) => {
  if (!AGENT.test(String(agent))) throw new Error(`not a slot: ${agent}`);
  return join(resolve(dir), `${agent}.json`);
};

export function writeBuddyRecord(agent, rec, { dir = BUDDY_DIR, now = Date.now() } = {}) {
  const file = fileFor(agent, dir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...rec, agent, at: now }));
  renameSync(tmp, file);
}

/** The partner's record, or null when absent, unreadable or older than BUDDY_STALE_MS. */
export function readBuddyRecord(agent, { dir = BUDDY_DIR, now = Date.now(), staleMs = BUDDY_STALE_MS } = {}) {
  try {
    const r = JSON.parse(readFileSync(fileFor(agent, dir), 'utf8'));
    if (!r || !Number.isFinite(r.at) || now - r.at > staleMs) return null;
    return r;
  } catch { return null; }
}

// ---------------------------------------------------------------------------- pure choices

const chebyshev = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));

/**
 * WHICH MONSTER TO TAG. "Full health" is not on the wire (no creature carries a health field), so
 * it is read as UNTOUCHED: no player -- ours or anyone's -- within `crowd` squares of it, and not one
 * this tagger already tagged in this room. A monster next to a player is in somebody's fight.
 *   monsters: [{id,row,col,name}]  players: [{row,col}]  me: {row,col}
 * Nearest first, so the walk out is short.
 */
export function pickFreshTarget({ monsters = [], players = [], me, quarry = null, tagged = new Set(), crowd = 2 } = {}) {
  if (!me) return null;
  // EXACT names, never a substring: "skeleton" (level 75) must not match "battered skeleton" (level 60),
  // because the roll needs the monster's level ABOVE the tagger's base max health and 60 is not above 64.
  const norm = n => String(n ?? '').toLowerCase().trim().replace(/^(the|a|an)s+/, '');
  const wanted = m => !quarry?.length || quarry.some(q => norm(m.name) === norm(q));
  const fresh = monsters.filter(m => wanted(m) && !tagged.has(m.id)
    && !players.some(p => chebyshev(p, m) <= crowd));
  fresh.sort((a, b) => chebyshev(me, a) - chebyshev(me, b));
  return fresh[0] ?? null;
}

/**
 * DID THE TAG LAND? A combat line (classifyCombatLine) that is OUR swing, landed, not a full resist,
 * against the tagged creature's name. Misses, "out of range" and resists do not set PFLAG_DID_DAMAGE.
 */
export function tagLanded(parsed, name) {
  if (!parsed || parsed.kind !== 'my-swing' || parsed.landed !== true || parsed.tier === 'fail') return false;
  const other = String(parsed.other ?? '').toLowerCase().replace(/^(the|a|an)\s+/, '');
  const want = String(name ?? '').toLowerCase().replace(/^(the|a|an)\s+/, '');
  return !!want && (other === want || other.endsWith(want));
}
