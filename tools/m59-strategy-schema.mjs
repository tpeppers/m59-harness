// FARMING STRATEGY FILES: THE SHAPE, AND WHAT A FILE MAY AND MAY NOT SAY.
//
//   import { validateStrategy, STRATEGY_FIELDS, KEY_FACULTY, STRATEGY_HOOKS } from './m59-strategy-schema.mjs';
//
// The operator, 2026-10-02: "autopilot should support a kind of generic 'farming strategy'-
// FleetScript file that it will execute on, with the FleetScript file outlining what weapons to
// use, what monsters to hunt/prioritize, what loot to prioritize, what maps to confine the farming
// to, etc." — and "the farming strategy files intend to be highly specialized for their tasks ...
// that specialized logic belongs in the farming strategy files", while "the generic touch spell
// support belongs in the keeper".
//
// So this file is the CONTRACT between the two. A strategy file is declarative first: every field
// below maps onto a policy key the keeper already obeys, through the SAME validator the broker's
// `autopilot` tool uses for that key. A file therefore cannot say anything an operator could not
// already say with one `autopilot` call — it only says it once, by name, for one task, with the
// task's own small hooks beside it. The engine (m59-strategy-engine.mjs) applies it; the keeper
// never reads a field of it.
//
// THREE CLASSES OF KEY, AND THE CLASS IS THE POINT:
//
//   * DIRECTIONAL — work, movement, economy. Listed in STRATEGY_FIELDS with the faculty each one
//     belongs to. The engine applies a key only while the keeper owns that faculty, and yields it
//     (says so, writes nothing) while a bot or a lease holds it. That is the two-writers rule.
//   * PROTECTED — when a character flees, rests, recovers, fights back, answers a war alarm or
//     holds after a PvP death. Those are identity/mortality/survival/recovery and the war paths,
//     and they are the keeper's (CLAUDE.md, the boundary table). A file naming one is REFUSED
//     whole: its author believed the file would change how the character survives, and applying
//     the rest while silently not doing that is the setting-that-does-nothing failure.
//   * EVERYTHING ELSE is unrecognised: reported, never applied, never dropped (docs/m59-policy.md).
//
// PURE apart from the item datastore the item-name validators read. No client, no keeper.

import { huntPrioritySpec } from './m59-hunt-priority.mjs';
import { lootOnlySpec } from './m59-loot-filter.mjs';
import { touchSpellName, touchCastTiming } from './m59-touchspell.mjs';
import { normalizeOverfarm } from './m59-overfarm.mjs';
import { normalizePractice } from './m59-deskpractice.mjs';
import { normalizeBuddy } from './m59-buddy.mjs';
import { spareBlockerMode } from './m59-spare.mjs';
import { normalizeRequires, normalizeFloor } from './m59-strategy-gate.mjs';
import { normalizeLootEject } from './m59-loot-eject.mjs';
import { normalizeGangUp } from './m59-gang-up.mjs';
import { unrevealedWeaponMode } from './m59-unrevealed-weapons.mjs';

// A name is also a file name, so it is a strict slug: no path, no dot-dot, no surprises.
export const STRATEGY_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const strList = (what, { lower = false } = {}) => (v) => {
  if (v === null) return null;
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim()))
    throw new Error(`${what} must be a list of names or null`);
  const out = [...new Set(v.map(x => lower ? x.trim().toLowerCase() : x.trim()))];
  return out.length ? out : null;
};
const roomNum = (what) => (v) => {
  if (v === null) return null;
  const n = Number(v);
  if (typeof v === 'boolean' || !Number.isInteger(n) || n <= 0) throw new Error(`${what} must be a room number or null`);
  return n;
};
const bool = (what) => (v) => {
  if (typeof v !== 'boolean') throw new Error(`${what} must be true or false`);
  return v;
};

function normHunt(v) {
  if (v === null) return null;
  const named = (Array.isArray(v) ? v : [v]).map(h => typeof h === 'string' ? h.trim() : h);
  if (!named.length || named.some(h => typeof h !== 'string' || !h))
    throw new Error('hunt is a creature name or a list of them');
  // The broker's own normal form: a single name stays a string.
  return named.length === 1 ? named[0] : named;
}

function normItems(what) {
  return (v, { resolveItem } = {}) => {
    if (v === null) return null;
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim()))
      throw new Error(`${what} must be a list of item names`);
    if (v.length > 24) throw new Error(`${what} may contain at most 24 items`);
    const out = [];
    for (const raw of v) {
      let name = raw.trim();
      if (resolveItem) { try { name = resolveItem(name); } catch (e) { throw new Error(`${what}: ${e.message}`); } }
      if (!out.some(n => n.toLowerCase() === name.toLowerCase())) out.push(name);
    }
    return out;
  };
}

function normOverfarm(v) {
  if (v === null) return null;
  const norm = normalizeOverfarm(v);
  const bad = [...norm.rejected, ...norm.unknown.map(k => `unrecognised key ${k}`)];
  if (bad.length) throw new Error(`overfarm refused: ${bad.join('; ')}`);
  const { unknown, rejected, ...policy } = norm;
  return policy;
}

function normPractice(v) {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v) || v.enabled !== true)
    throw new Error('practice must be null or an enabled settings object');
  const cfg = normalizePractice(v);
  if (cfg?.problems?.length) throw new Error(`practice refused: ${cfg.problems.join('; ')}`);
  // Stored as written, like the broker does: the keeper normalises on every pass.
  return JSON.parse(JSON.stringify(v));
}

function normFightAbove(v) {
  const n = Number(v);
  if (typeof v === 'boolean' || v === null || !Number.isFinite(n) || n < 0 || n > 200)
    throw new Error('vigor.fightAbove must be a number from 0 to 200');
  return n;
}

const TRAINING_STYLES = ['normal', 'short_sword', 'unarmed', 'alternate', 'alternate_on_improve'];

/**
 * Every field a strategy file may set. `path` is where it lives in the file, `keys` the policy
 * keys it writes (one, except the vigor floor which the broker also writes twice), `faculty`
 * which owner it yields to, `arg` the broker `autopilot` argument for the same key — used to
 * warn a caller that a strategy is shadowing what it just asked for.
 */
export const STRATEGY_FIELDS = Object.freeze([
  { path: 'hunt', keys: ['hunt'], faculty: 'work', arg: 'hunt', normalize: normHunt },
  { path: 'huntPriority', keys: ['huntPriority'], faculty: 'work', arg: 'hunt_priority',
    normalize: v => huntPrioritySpec(v) },
  { path: 'lootOnly', keys: ['lootOnly'], faculty: 'economy', arg: 'loot_only',
    normalize: (v, o = {}) => lootOnlySpec(v, { resolveItem: o.resolveItem ?? null }) },
  // ADDITIVE: the file's items are added to whatever the character already protects. A strategy
  // that REPLACED the list would quietly unprotect the reagents the roster put there, and the next
  // sell would take them (memory: reagents-need-protected-items).
  { path: 'protect', keys: ['protectedItems'], faculty: 'economy', arg: 'protect_items',
    normalize: normItems('protect'), merge: 'union' },
  { path: 'overfarm', keys: ['overfarm'], faculty: 'economy', arg: 'overfarm', normalize: normOverfarm },
  // WHEN A FULL PACK GOES TO TOWN (sellAtLoad, 0..1): 1.0 is "sell only when the pack is full". Where it goes is the town
  // table for where the character stands (m59-autopilot.mjs townTable: the island sells at Ko'catan, never the mainland).
  { path: 'sellAtLoad', keys: ['sellAtLoad'], faculty: 'economy', arg: 'sell_at_load',
    normalize: v => { const n = Number(v); if (typeof v === 'boolean' || !Number.isFinite(n) || n < 0 || n > 1)
      throw new Error('sellAtLoad must be a pack fullness from 0 to 1'); return n; } },
  // LOOT EJECTION (m59-loot-eject.mjs): hand the sale pile to a station or courier of ours in the same room.
  { path: 'lootEject', keys: ['lootEject'], faculty: 'economy', arg: 'loot_eject', normalize: v => normalizeLootEject(v) },
  // UNIDENTIFIED WEAPONS OFF THE FLOOR (m59-unrevealed-weapons.mjs): 'always' | 'desk' | 'never'. A cursed weapon
  // wields itself on pickup (item.kod:508-514), so 'desk' takes one only while a remove-curse desk publishes.
  // What to pick up is economy, like lootOnly; the keeper's own refusal of a cursed NAME is not this key's.
  { path: 'lootUnrevealedWeapons', keys: ['lootUnrevealedWeapons'], faculty: 'economy', arg: 'loot_unrevealed_weapons',
    normalize: v => unrevealedWeaponMode(v) },
  { path: 'weapons.touchSpell', keys: ['touchSpell'], faculty: 'work', arg: 'touch_spell',
    normalize: v => touchSpellName(v) },
  { path: 'weapons.touchSpellTiming', keys: ['touchSpellTiming'], faculty: 'work', arg: 'touch_spell_timing',
    normalize: v => v === null ? null : touchCastTiming(v) },
  { path: 'weapons.priority', keys: ['weaponPriority'], faculty: 'work', arg: 'weapon_priority',
    normalize: strList('weapons.priority') },
  { path: 'weapons.banned', keys: ['bannedWeapons'], faculty: 'work', arg: 'banned_weapons',
    normalize: strList('weapons.banned', { lower: true }) },
  // CREATURES NEVER SWUNG AT, even when they attack (m59-spare.mjs). WHAT to fight, so it is `work`
  // and yields to a bot holding the hunt. It is NOT one of the protected survival keys: the keeper
  // still rests, flees and recovers exactly as before -- it just never picks a spared monster as a
  // target, and the client refuses the packet if anything else tries.
  { path: 'spare', keys: ['spareCreatures'], faculty: 'work', arg: 'spare_creatures',
    normalize: strList('spare', { lower: true }) },
  // AND WHAT TO DO WHEN A SPARED CREATURE STANDS IN THE WAY (m59-spare.mjs, `lureSparedBlocker`):
  // 'lure' backs off so it follows us out of a pipe, 'provoke' swings once first. Movement-shaped.
  { path: 'spareBlockers', keys: ['spareBlockers'], faculty: 'movement', arg: 'spare_blockers',
    normalize: v => spareBlockerMode(v) },
  { path: 'weapons.style', keys: ['trainingStyle'], faculty: 'work', arg: 'training_style',
    normalize: v => { if (!TRAINING_STYLES.includes(v))
      throw new Error(`weapons.style must be one of ${TRAINING_STYLES.join(', ')}`); return v; } },
  // WHICH WEAPON THE ARMED TRAINING STYLE HOLDS (and the create weapon roulette conjures while its
  // proficiency is under 70): `weapons.style: 'short_sword'` with `weapons.trainingWeapon: 'axe'`.
  { path: 'weapons.trainingWeapon', keys: ['trainingWeapon'], faculty: 'work', arg: 'training_weapon',
    normalize: v => { const w = String(v ?? '').trim().toLowerCase();
      if (!w) throw new Error('weapons.trainingWeapon must name a weapon'); return w; } },
  // AND ONLY THAT WEAPON: equipBest may choose nothing else while the armed style is in force
  // (Autopilot trainingWeaponOnlyNow / s.equipOnly).
  { path: 'weapons.trainingWeaponOnly', keys: ['trainingWeaponOnly'], faculty: 'work', arg: 'training_weapon_only',
    normalize: bool('weapons.trainingWeaponOnly') },
  { path: 'weapons.preferMagic', keys: ['preferMagicWeapon'], faculty: 'work', arg: 'prefer_magic_weapon',
    normalize: bool('weapons.preferMagic') },
  { path: 'weapons.preferMundane', keys: ['preferMundaneWeapon'], faculty: 'work', arg: 'prefer_mundane_weapon',
    normalize: bool('weapons.preferMundane') },
  { path: 'confine.rooms', keys: ['confineRooms'], faculty: 'movement', arg: 'confine_rooms',
    normalize: v => { if (v === null) return null;
      if (!Array.isArray(v) || !v.length) throw new Error('confine.rooms must be a non-empty list of room numbers or null');
      return [...new Set(v.map(roomNum('confine.rooms')))]; } },
  { path: 'confine.station', keys: ['assignedRoom'], faculty: 'movement', arg: 'assigned_room',
    normalize: roomNum('confine.station') },
  // THE ROAD IN, walked in order from outside the confinement (Autopilot.approachLegs).
  { path: 'confine.approach', keys: ['approachRooms'], faculty: 'movement', arg: 'approach_rooms',
    normalize: v => { if (v === null) return null;
      if (!Array.isArray(v) || !v.length) throw new Error('confine.approach must be a non-empty list of room numbers or null');
      return v.map(roomNum('confine.approach')); } },
  // PULL THROUGH A CROWD (Autopilot.pull / closestPullable): skip the crowd refusal, take the nearest target.
  { path: 'pull.throughCrowd', keys: ['pullThroughCrowd'], faculty: 'work', arg: 'pull_through_crowd',
    normalize: bool('pull.throughCrowd') },
  { path: 'confine.roam', keys: ['roam'], faculty: 'movement', arg: 'roam', normalize: bool('confine.roam') },
  { path: 'vigor.fightAbove', keys: ['fightAboveVigor', 'vigorFloor'], faculty: 'work', arg: 'fight_above_vigor',
    normalize: normFightAbove },
  // HOW HIGH TO EAT ONCE A CLIMB HAS STARTED (provision.mjs: below the fight floor it eats, up to this). The island band,
  // 2026-10-27: fight above 100 (rest caps at 80 and nobody had food, so 150 meant no fights), eat on to 195.
  { path: 'vigor.ceiling', keys: ['vigorCeiling'], faculty: 'work', arg: 'vigor_ceiling',
    normalize: v => { const n = Number(v); if (typeof v === 'boolean' || v === null || !Number.isFinite(n) || n < 0 || n > 200)
      throw new Error('vigor.ceiling must be a number from 0 to 200'); return n; } },
  { path: 'practice', keys: ['practiceSpells'], faculty: 'work', arg: 'practice_spells', normalize: normPractice },
  // THE BUDDY SYSTEM (m59-buddy.mjs): { pairs: { tagger: killer }, wait_s, tries, reach, quarry }. One
  // value for every member, each keeper finds its own role in it, so one file can be assigned to all.
  { path: 'buddy', keys: ['buddy'], faculty: 'work', arg: 'buddy', normalize: v => normalizeBuddy(v) },
  // WHERE IN A ROOM PREY MAY BE CHOSEN (Autopilot.huntAreaHere): { room, squares: [[row, col], ...] }. In that room
  // only quarry standing on a listed square is selected, and an idle farmer walks back onto the area. Elsewhere
  // nothing changes. Operator 2026-10-16: farm Castle Victoria's undead but stay in sight of the bastion door.
  { path: 'huntArea', keys: ['huntArea'], faculty: 'work', arg: 'hunt_area', normalize: normHuntArea },
  // A CREATURE FOUGHT ONLY TWO-ON-ONE, OR MORE (m59-gang-up.mjs): { creature: { min, radius } }. A listed creature is
  // quarry only while min-1 OTHER fleet-mates stand within radius coarse squares (Chebyshev) of it in this keeper's own
  // room view (Autopilot.gangUpFilter); otherwise it is handled as if `hunt` did not name it. It never widens the hunt.
  // Operator 2026-10-27, the Guardians of Zjiria in Ukgoth: "fight it 2-on-1 ... the only change from regular trolls".
  { path: 'gangUp', keys: ['gangUp'], faculty: 'work', arg: 'gang_up', normalize: v => normalizeGangUp(v) },
]);

/** { room, squares } -> { room, squares: [[row, col], ...] } (deduplicated), or null. */
export function normHuntArea(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('huntArea must be { room, squares } or null');
  const room = Number(v.room);
  if (!Number.isInteger(room) || room <= 1) throw new Error('huntArea.room must be a room number above 1');
  if (!Array.isArray(v.squares) || !v.squares.length || v.squares.length > 4000)
    throw new Error('huntArea.squares must be a non-empty list (at most 4000) of [row, col] or { row, col }');
  const seen = new Set(), squares = [];
  for (const q of v.squares) {
    const row = Number(Array.isArray(q) ? q[0] : q?.row), col = Number(Array.isArray(q) ? q[1] : q?.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) throw new Error(`huntArea square ${JSON.stringify(q)} is not a whole [row, col]`);
    const k = `${row},${col}`;
    if (!seen.has(k)) { seen.add(k); squares.push([row, col]); }
  }
  return { room, squares };
}

// A GUARD ZONE is the same shape as a hunt area, given to ONE character as an order rather than to everyone
// who runs a strategy file, and it wins over the file's area in its room (Autopilot.huntAreaHere). Operator
// 2026-10-16: "assign a Guard zone ... click-and-drag ... from this (coarse grid square) to this". So besides
// { room, squares } it takes the rectangle as drawn, { room, from: {row, col}, to: {row, col} }, either corner
// first. Kept as `{ room, squares, rect? }` so a reader can draw the rectangle it was given.
/** { room, squares } | { room, from, to } -> { room, squares, rect? }, or null. */
export function normGuardZone(v) {
  if (v === null) return null;
  if (v && typeof v === 'object' && !Array.isArray(v) && v.from != null && v.to != null) {
    const corner = (q, which) => {
      const row = Number(Array.isArray(q) ? q[0] : q?.row), col = Number(Array.isArray(q) ? q[1] : q?.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0)
        throw new Error(`guardZone.${which} ${JSON.stringify(q)} is not a whole { row, col }`);
      return { row, col };
    };
    const a = corner(v.from, 'from'), b = corner(v.to, 'to');
    const rect = { row1: Math.min(a.row, b.row), col1: Math.min(a.col, b.col), row2: Math.max(a.row, b.row), col2: Math.max(a.col, b.col) };
    if ((rect.row2 - rect.row1 + 1) * (rect.col2 - rect.col1 + 1) > 4000) throw new Error('guardZone rectangle covers more than 4000 squares');
    const squares = [];
    for (let row = rect.row1; row <= rect.row2; row++) for (let col = rect.col1; col <= rect.col2; col++) squares.push([row, col]);
    return { ...normHuntArea({ room: v.room, squares }), rect };
  }
  try { return normHuntArea(v); } catch (e) { throw new Error(e.message.replace(/huntArea/g, 'guardZone')); }
}

/** The file's value laid over another writer's: replaced, or (merge 'union') added to it. */
export function mergeOver(field, base, value) {
  if (field?.merge !== 'union' || !Array.isArray(value)) return value;
  const out = [];
  for (const v of [...(Array.isArray(base) ? base : []), ...value])
    if (!out.some(o => String(o).toLowerCase() === String(v).toLowerCase())) out.push(v);
  return out;
}

const KEY_FIELD = new Map(STRATEGY_FIELDS.flatMap(f => f.keys.map(k => [k, f])));
/** The field that writes a policy key. */
export const fieldForKey = (key) => KEY_FIELD.get(key) ?? null;

/** policy key -> faculty, for everything a strategy can set. */
export const KEY_FACULTY = Object.freeze(Object.fromEntries(
  STRATEGY_FIELDS.flatMap(f => f.keys.map(k => [k, f.faculty]))));
/** broker autopilot argument -> the policy keys it writes, for the shadow warning. */
export const ARG_KEYS = Object.freeze(Object.fromEntries(STRATEGY_FIELDS.map(f => [f.arg, f.keys])));
const FIELD_BY_PATH = new Map(STRATEGY_FIELDS.map(f => [f.path, f]));
export const fieldFor = (path) => FIELD_BY_PATH.get(path) ?? null;
const GROUPS = new Set(STRATEGY_FIELDS.filter(f => f.path.includes('.')).map(f => f.path.split('.')[0]));

// The hooks a file may carry. Task logic that cannot be declared; see m59-strategy-engine.mjs for
// how they are run (synchronously, timed, isolated — a throwing hook is disabled, never fatal).
export const STRATEGY_HOOKS = Object.freeze(['onPass', 'onCombatLine', 'onServerMessage', 'beforeSwing', 'onKill']);

// NAMES THAT BELONG TO THE KEEPER, at any depth of the file. The reason travels with the refusal.
const SURVIVAL = 'is survival/recovery and stays with the keeper: a strategy chooses what to hunt, ' +
                 'never when the character flees, rests or recovers';
const WAR = 'is a war/PvP path and stays with the keeper: a strategy cannot change how a character ' +
            'answers a player';
export const PROTECTED_NAMES = Object.freeze({
  flee: SURVIVAL, fleeBelow: SURVIVAL, rest: SURVIVAL, restBelow: SURVIVAL, restAnywhere: SURVIVAL,
  holdResumeAbove: SURVIVAL, survivalEnabled: SURVIVAL, survival_enabled: SURVIVAL, survival: SURVIVAL, mortality: SURVIVAL, recovery: SURVIVAL,
  identity: SURVIVAL, travelGuard: SURVIVAL, panicLogoff: SURVIVAL, breakOutViaLogoff: SURVIVAL,
  breakOutAbove: SURVIVAL, freezeMs: SURVIVAL, doomedInSpotBelow: SURVIVAL, healWandBelow: SURVIVAL,
  askForHelp: SURVIVAL, retreatToInn: SURVIVAL, escapeLadder: SURVIVAL,
  defendAgainstPlayers: WAR, defendChase: WAR, fightBack: WAR, fightBackAfterMs: WAR,
  pvpReturnDelayMs: WAR, pvpRooms: WAR, pvp_rooms: WAR, pvp: WAR, war: WAR, warResponse: WAR, warSentinel: WAR, warband: WAR,
  keepOff: WAR, leash: WAR, combatOrder: WAR, combat_order: WAR, guildOnly: WAR,
  // Not survival, but not the file's either: the mode is the switch the ASSIGNMENT throws.
  mode: 'is not a strategy key: pass mode:"farm" with the assignment (autopilot action=start mode=farm farm_strategy=...)',
  farmStrategy: 'is the assignment itself and cannot be set from inside a strategy',
});
// `requires` and `floor` are not policy keys: they gate the farm (m59-strategy-gate.mjs) rather than set it.
const KNOWN_TOP = new Set(['name', 'describe', 'hooks', 'requires', 'floor', 'otherwise',
  ...STRATEGY_FIELDS.filter(f => !f.path.includes('.')).map(f => f.path), ...GROUPS]);

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function protectedIn(obj, prefix = '') {
  const out = [];
  if (!isPlainObject(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (Object.hasOwn(PROTECTED_NAMES, k)) out.push({ path, why: `${path} ${PROTECTED_NAMES[k]}` });
    // Hooks are code, not keys; their names are checked separately.
    if (path !== 'hooks' && GROUPS.has(k) && isPlainObject(v)) out.push(...protectedIn(v, path));
  }
  return out;
}

/**
 * Validate one loaded module's default export.
 *
 *   validateStrategy(exported, { file: 'qor-acid-touch-trees.mjs', resolveItem })
 *   -> { ok, why, problems: [{ path, why }], unrecognised: [path], strategy }
 *
 * `strategy` (only when ok) is what the engine applies:
 *   { name, describe, desired: { policyKey: value }, faculties: { policyKey: faculty },
 *     fields: [{ path, keys, faculty }], hooks: { hookName: fn } }
 *
 * `ok: false` means NOTHING from the file is applied: a malformed value, a protected name, a
 * hook that is not a function, or a name that does not match the file. Unrecognised keys do not
 * make it false — they are reported and the rest applies (docs/m59-policy.md, the fourth rule).
 */
export function validateStrategy(exported, { file = null, resolveItem = null } = {}) {
  const problems = [], unrecognised = [];
  const refuse = (why) => ({ ok: false, why, problems, unrecognised, strategy: null });
  if (!isPlainObject(exported)) return refuse('the default export is not a plain object shaped like a farming strategy');
  const s = exported;
  if (typeof s.name !== 'string' || !STRATEGY_NAME.test(s.name))
    return refuse(`name must be a lower-case slug (${STRATEGY_NAME}); got ${JSON.stringify(s.name)}`);
  const base = file ? String(file).replace(/\\/g, '/').split('/').pop().replace(/\.mjs$/, '') : null;
  if (base && base !== s.name)
    return refuse(`name "${s.name}" does not match its file "${base}.mjs" — the assignment names the file, ` +
                  'so the two must agree');
  if (s.describe !== undefined && typeof s.describe !== 'string')
    problems.push({ path: 'describe', why: 'describe must be a sentence' });

  const prot = protectedIn(s);
  if (prot.length) { problems.push(...prot); return refuse(prot.map(p => p.why).join('; ')); }

  for (const k of Object.keys(s)) if (!KNOWN_TOP.has(k)) unrecognised.push(k);
  for (const g of GROUPS) {
    if (s[g] === undefined) continue;
    if (!isPlainObject(s[g])) { problems.push({ path: g, why: `${g} must be an object` }); continue; }
    for (const k of Object.keys(s[g])) if (!FIELD_BY_PATH.has(`${g}.${k}`)) unrecognised.push(`${g}.${k}`);
  }

  const desired = {}, faculties = {}, fields = [];
  for (const f of STRATEGY_FIELDS) {
    const [a, b] = f.path.split('.');
    const v = b ? (isPlainObject(s[a]) ? s[a][b] : undefined) : s[a];
    if (v === undefined) continue;                      // silence: the key is not this file's
    let value;
    try { value = f.normalize(v, { resolveItem }); }
    catch (e) { problems.push({ path: f.path, why: e.message }); continue; }
    for (const k of f.keys) { desired[k] = value; faculties[k] = f.faculty; }
    fields.push({ path: f.path, keys: f.keys, faculty: f.faculty });
  }

  // WHAT THE BODY NEEDS, AND HOW MUCH IT MUST KILL (m59-strategy-gate.mjs). Not policy keys: the engine
  // stands the farm down while either fails, and the broker refuses an assignment whose requirement is unmet.
  let requires = null, floor = null;
  try { requires = normalizeRequires(s.requires); } catch (e) { problems.push({ path: 'requires', why: e.message }); }
  try { floor = normalizeFloor(s.floor); } catch (e) { problems.push({ path: 'floor', why: e.message }); }
  // AND WHAT TO DO INSTEAD when no desk can fix it: another farm strategy, by name (the catch-all orders).
  let otherwise = null;
  if (s.otherwise != null) {
    if (typeof s.otherwise !== 'string' || !STRATEGY_NAME.test(s.otherwise))
      problems.push({ path: 'otherwise', why: 'otherwise must name another farm strategy file' });
    else if (s.otherwise === s.name) problems.push({ path: 'otherwise', why: 'otherwise cannot name the strategy itself' });
    else otherwise = s.otherwise;
  }

  const hooks = {};
  if (s.hooks !== undefined) {
    if (!isPlainObject(s.hooks)) problems.push({ path: 'hooks', why: 'hooks must be an object of functions' });
    else for (const [k, fn] of Object.entries(s.hooks)) {
      if (!STRATEGY_HOOKS.includes(k)) { unrecognised.push(`hooks.${k}`); continue; }
      if (typeof fn !== 'function') { problems.push({ path: `hooks.${k}`, why: `hooks.${k} must be a function` }); continue; }
      hooks[k] = fn;
    }
  }
  if (problems.length) return refuse(problems.map(p => `${p.path}: ${p.why}`).join('; '));
  if (!fields.length && !Object.keys(hooks).length)
    return refuse('the file declares no field and no hook, so assigning it would change nothing — ' +
                  'which reads exactly like a strategy that works');
  return { ok: true, why: null, problems, unrecognised,
           strategy: { name: s.name, describe: s.describe ?? null, desired, faculties, fields, hooks, requires, floor, otherwise } };
}
