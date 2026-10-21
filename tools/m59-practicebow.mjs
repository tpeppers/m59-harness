// THE DECISIONS BEHIND tools/fleetscripts/practice-bow.mjs, kept pure so they can be tested offline.
//
// Operator, 2026-10-20: train the bow skills (fire, archery) on a practice bow until whichever of
// them the character holds reach 99, mend the same bow at a service desk whenever it wears, and
// keep arrows coming from the room's arrow-dropping monsters when they run out.
//
// Game facts, read from kod and filed in m59-research reports/archery-training.md and
// reports/mend-and-item-repair.md:
//
//   - fire improves only while fire < the target's level, and archery likewise
//     (stroke.kod:104-118). A character without archery puts every roll on fire. So the target
//     sets the ceiling: a level-60 battered skeleton stops teaching at 60.
//   - The bow loses a point on 74% of landed non-killing hits (weapon.kod:491-500); every shot
//     spends an arrow, hit or miss (fire.kod:143-160).
//   - Mend keeps 75-94% of the CURRENT maximum, so it shrinks the bow every cast and the new
//     maximum does not depend on how worn the bow is (mend.kod:112-134). Mend late. A broken
//     bow (0) can never be mended (mend.kod:86-92).
//   - At most 10 ability points per 15-22 minute window, across every skill and spell
//     (player.kod:66-68). Arrows shot past the cap teach nothing.
import { readFileSync } from 'node:fs';

export const BOW_SKILLS = Object.freeze(['fire', 'archery']);
export const MAX_ABILITY = 99;

// --------------------------------------------------------------------------- abilities

/**
 * Which of fire and archery the character holds, and which still have room to rise.
 * `rows` is the `skills` array of the abilities tool. A skill the character never learned is
 * absent (or reads 0) and is NOT a goal: "won't continue because it doesn't have 99 in archery"
 * (operator) means a character without archery stops when fire is done.
 */
export function bowSkillState(rows = [], { only = BOW_SKILLS } = {}) {
  const held = {}, unknown = [];
  for (const name of only) {
    const r = (rows ?? []).find(x => String(x?.name ?? '').toLowerCase() === name);
    if (!r) continue;
    // LISTED WITH NO NUMBER: the skill is known but its ability has not been read (the live read
    // returns no ability slots, and the keeper's book fills only from the server's push on the
    // first change, m59-broker.mjs abilities). Held, level unknown: trained as if low, never "done".
    if (r.ability == null) { unknown.push(name); held[name] = 1; continue; }
    const a = Number(r.ability);
    if (Number.isFinite(a) && a > 0) held[name] = a;
  }
  const training = Object.keys(held).filter(k => held[k] < MAX_ABILITY);
  return { held, training, unknown, done: Object.keys(held).length > 0 && training.length === 0,
           none: Object.keys(held).length === 0 };
}

/**
 * Points gained (any skill or spell) inside the trailing window, from the abilities tool's
 * `advancement.recent` log. The server allows ADVANCEMENT_LIMIT = 10 per window; the window is
 * 15-22 minutes, so 22 is the conservative length.
 */
export const ADVANCEMENT_LIMIT = 10;
export const WINDOW_MS = 22 * 60_000;
export function gainsInWindow(recent = [], now = Date.now(), windowMs = WINDOW_MS) {
  const rows = (recent ?? []).filter(h => Number(h?.by) > 0 && now - Number(h?.at) < windowMs);
  const points = rows.reduce((n, h) => n + Number(h.by), 0);
  const oldest = rows.length ? Math.min(...rows.map(h => Number(h.at))) : null;
  return { points, capped: points >= ADVANCEMENT_LIMIT,
           resumeAt: oldest == null ? null : oldest + windowMs };
}

// --------------------------------------------------------------------------- the bow

// CONDITION BANDS, by the item's own description (item.kod:150-195; bow wording bow.kod:36-38,
// the poor band is the weapon's, weapon.kod:87-92). Ordered best to worst.
export const BANDS = Object.freeze(['top', 'good', 'med', 'poor', 'broken']);
export function bowBand(description) {
  const t = String(description ?? '').toLowerCase();
  if (!t) return null;
  if (/broken and in pieces|has been shattered|is broken/.test(t)) return 'broken';
  if (/well worn|may not last much longer/.test(t)) return 'poor';
  if (/crack and fray|notched and stained|still an? effective/.test(t)) return 'med';
  if (/slightly worn|slightly tarnished|generally good condition/.test(t)) return 'good';
  if (/flawless condition|excellent condition/.test(t)) return 'top';
  return null;
}
export const bandAtOrBelow = (band, threshold) =>
  BANDS.indexOf(band) >= 0 && BANDS.indexOf(band) >= BANDS.indexOf(threshold);

const nameOf = i => String(i?.name ?? '').toLowerCase();
/** The bow to train with: the named one first, else any bow that is not a crossbow. */
export function findBow(items = [], want = 'practice bow') {
  const w = String(want ?? '').toLowerCase();
  const rows = (items ?? []).filter(i => Number(i?.id) > 0);
  return rows.find(i => nameOf(i) === w) ?? rows.find(i => w && nameOf(i).includes(w)) ??
         (w === 'practice bow' ? null : rows.find(i => /\bbow\b/.test(nameOf(i)) && !/crossbow/.test(nameOf(i)))) ?? null;
}

export function arrowCount(items = []) {
  return (items ?? []).filter(i => /\barrows?\b/.test(nameOf(i)) && !/bolt/.test(nameOf(i)))
    .reduce((n, i) => n + (Number(i.amount) || 1), 0);
}

// A melee weapon to fight for arrows with. Bows and anything ranged are not one.
const MELEE = /\b(sword|axe|mace|hammer|scimitar|dagger|blade)\b/;
export function findMelee(items = []) {
  return (items ?? []).filter(i => Number(i?.id) > 0 && MELEE.test(nameOf(i)) && !i.broken)[0] ?? null;
}

/**
 * The bow wore from a fresh mend to the mend band in fewer than `retireSwings` swings, so its
 * maximum is nearly gone: each further cycle is shorter, and a burst between condition reads
 * could break it. Retire it (buy another) rather than risk the "beyond salvage" that loses it.
 */
export const shouldRetire = (swingsSinceMend, retireSwings) =>
  Number(retireSwings) > 0 && Number.isFinite(Number(swingsSinceMend)) && swingsSinceMend < retireSwings;

// --------------------------------------------------------------------------- monsters

/**
 * Name -> { level, treasure } from tools/monsters.json, following `parent` for anything a class
 * inherits (the 2026-09-05 lesson in m59-research: half the skeletons' treasure was inherited).
 * The display name is the class's own vrName resource, never every string in its resources.
 */
export function loadBestiary(file = new URL('./monsters.json', import.meta.url)) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return new Map(); }
  const rows = Array.isArray(raw) ? raw : Object.values(raw);
  const byClass = new Map(rows.map(m => [String(m.class ?? '').toLowerCase(), m]));
  const inherit = (m, key, seen = new Set()) => {
    for (let at = m; at && !seen.has(at); at = byClass.get(String(at.parent ?? '').toLowerCase())) {
      seen.add(at);
      if (at[key] != null) return at[key];
    }
    return null;
  };
  const out = new Map();
  for (const m of rows) {
    const level = Number(inherit(m, 'viLevel'));
    const treasure = inherit(m, 'viTreasure_type');
    const rscKey = inherit(m, 'vrName');
    const display = m._res?.[rscKey]?.[0] ?? null;
    const entry = { cls: m.class, level: Number.isFinite(level) ? level : null, treasure };
    if (display) out.set(String(display).toLowerCase(), entry);
    if (m.class) out.set(String(m.class).toLowerCase(), out.get(String(m.class).toLowerCase()) ?? entry);
  }
  return out;
}

/** Treasure types whose table holds any arrow, from compendium/data/treasure.json. */
export function arrowTreasures(file = new URL('../compendium/data/treasure.json', import.meta.url)) {
  try {
    const t = JSON.parse(readFileSync(file, 'utf8'));
    return new Set(Object.entries(t.itemDroppedBy ?? {})
      .filter(([cls]) => /arrow/i.test(cls)).flatMap(([, tids]) => tids));
  } catch { return new Set(); }
}

/** The look tool's monsters: attackable, not players. Names keep their case for the keeper. */
export const monstersIn = (look) => (look?.objects ?? [])
  .filter(o => !o.is_player && (o.can ?? []).includes('attack') && o.name)
  .map(o => ({ id: o.id, name: String(o.name), distance: o.distance ?? null }));

// Exact display name first; else the longest catalogue name the wire name contains, so a
// prefixed or re-cased name still resolves without "skeleton" matching every skeleton.
function lookupName(bestiary, name) {
  const q = String(name ?? '').toLowerCase();
  if (bestiary.has(q)) return bestiary.get(q);
  let best = null, len = 0;
  for (const [k, v] of bestiary) if (k.length > len && k.includes(' ') && q.includes(k)) { best = v; len = k.length; }
  return best;
}
const levelOf = (bestiary, name) => lookupName(bestiary, name)?.level ?? null;

/**
 * WHAT TO SHOOT. A target teaches a skill only while the skill is below its level, so:
 *   1. the weakest monster here that teaches EVERY skill still training (above the highest);
 *   2. else the weakest that teaches at least one (above the lowest);
 *   3. else nothing, and the room cannot teach this character any more.
 * Weakest, because a harder monster teaches no faster (skill.kod:395-439 reads ability 0 for
 * skills, so its factor is already 100 from level 45) and hits harder.
 */
export function pickTarget(monsters = [], bestiary, skills = {}) {
  const levels = Object.values(skills).filter(Number.isFinite);
  if (!levels.length) return { target: null, why: 'no bow skill left to train' };
  const hi = Math.max(...levels), lo = Math.min(...levels);
  const rated = monsters.map(m => ({ ...m, level: levelOf(bestiary, m.name) }))
    .filter(m => Number.isFinite(m.level));
  const byLevel = (a, b) => a.level - b.level || (a.distance ?? 99) - (b.distance ?? 99);
  const all = rated.filter(m => m.level > hi).sort(byLevel)[0];
  if (all) return { target: all, teaches: 'all' };
  const some = rated.filter(m => m.level > lo).sort(byLevel)[0];
  if (some) return { target: some, teaches: 'some' };
  const best = rated.sort((a, b) => b.level - a.level)[0];
  return { target: null, why: best
    ? `the strongest monster here is ${best.name} (level ${best.level}); training skills are at ${lo}-${hi}`
    : `no monster here has a known level (${monsters.map(m => m.name).join(', ') || 'room empty'})` };
}

/** Arrow-dropping monsters standing here, nearest first. */
export function arrowDroppersIn(monsters = [], bestiary, tids = arrowTreasures()) {
  return monsters.filter(m => tids.has(lookupName(bestiary, m.name)?.treasure))
    .sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99));
}

// --------------------------------------------------------------------------- the desk

/** A desk that lists Mend as available right now: `store.desk()` rows. Named one first. */
// A desk republishes its menu every minute while its keeper runs (chalicePublishDesk), so an
// entry older than `maxAgeMs` is a desk nobody is sitting at.
export function pickMendDesk(desks = {}, want = null, { now = Date.now(), maxAgeMs = 15 * 60_000 } = {}) {
  const rows = Object.entries(desks ?? {}).map(([key, d]) => ({ ...d, name: d?.server ?? key }))
    .filter(d => (d.menu ?? []).some(m => m.kind === 'mend'))
    .filter(d => !(Number(d.at) > 0) || now - Number(d.at) < maxAgeMs);
  const pick = want ? rows.filter(d => d.name.toLowerCase() === String(want).toLowerCase()) : rows;
  const ok = pick.find(d => d.menu.find(m => m.kind === 'mend').ok);
  if (ok) return { desk: ok };
  if (pick.length) return { desk: null, why: `${pick[0].name} lists Mend but cannot now: ${pick[0].menu.find(m => m.kind === 'mend').why}` };
  return { desk: null, why: want ? `${want} does not offer Mend (no published desk lists it)`
                                 : 'no published desk offers Mend' };
}
