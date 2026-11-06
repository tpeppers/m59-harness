#!/usr/bin/env node
// THE NEEDLE: ONE STRIKER AT THE TIP, ARCHERS BEHIND, AND THE ROOM WALKS INTO IT.
//
//   node tools/m59-needle-farm.mjs derive --room 2143 --striker r35c42 --kill r34c43     candidate squares, and why
//   node tools/m59-needle-farm.mjs check  --site deep-jungle-2143                         prove a site file on the map
//   node tools/m59-needle-farm.mjs status --site deep-jungle-2143                         who holds what, right now
//   node tools/m59-needle-farm.mjs econ   --site deep-jungle-2143 [--since 2h] [--arrow-price 5]
//   ... add --json to any of them.
//
// CLI CONTRACT: squares are `rNcM` (r = row, c = col), the notation docs/m59-coordinates.md uses for humans.
// A site file and a strategy file say `{ row, col }`. Nothing positional, no bare pairs.
//
// THE OPERATOR, 2026-11-05: "We're going to switch to a 'Single Striker in the Needle' pattern for farming 2143 Deep in
// the Jungle ... a single striker stands in front of the safe-spot/choke-point and strikes at whatever monster stands in
// the front of the pack, regardless of if it changes ... the archers stand back safely and train their abilities ... the
// goal is it just becomes a killzone, and the monsters on the map all wander over into your stationary farming spot. If
// monsters aren't coming to the kill-needle location, the melee striker can step forward/aside, and the bower in the
// front can step out and shoot at an enemy before returning to their station". Follow-up: "Idle for 15s even is enough
// to be worth pulling ... the melee striker is optional but assumed -- my intuition is that the method can be close to
// break even at 1/(1-4) striker/archers ... but probably can't support just lone archers without incoming money."
//
// WHY THE NEEDLE EXISTS, FROM THE SERVER'S OWN RULES (docs/m59-routing.md, the safe wall; m59-safespots.mjs):
//
//   - On a stock server (`piLOS = LOS_OLD`, kod/util/settings.kod) MONSTERS MOVE ON THE COARSE GRID (CanMoveInRoom: the
//     source square's direction bit and the destination's floor bit). Players are walked by the client on the fine BSP.
//     Where the two disagree there are squares a player stands on that no monster can step onto.
//   - Room.LineOfSight (room.kod:2125) is a staircase of CanMoveInRoom steps, so under LOS_OLD a monster cannot SEE a
//     square its coarse grid cannot step toward -- and a monster attacks only with sight (monster.kod:1782). A player's
//     ranged attack checks range and facing, not sight (player.kod TargetWithinSightAndRange); sight only decides whether
//     the shot counts toward archery/fire improvement (player.kod:4096-4108: otherwise 1 in 25).
//   - So a NEEDLE is a coarse cul-de-sac: a monster component that narrows to a tip (the KILL square) beside a square the
//     striker holds, with player-only squares around it from which a bow sees the tip and nothing on the tip sees back.
//     In 2143 the coarse grid lets a monster at r34c43 step only NE, E or SW -- and SW is r35c42, the striker's square,
//     whose own only direction is back. With the striker standing there the pack stops at the tip.
//
// WHAT THIS FILE IS: pure decisions (the site's normal form, target choice, the role allocation and the striker
// replacement, the pull trigger and its rate limit, the economics) plus the offline derivation of a site from the map,
// plus the small shared-file store the keepers coordinate through. It opens no socket and touches no roster. The keeper
// half is tools/autopilot/needle.mjs; it is reached through ONE strategy field, `needle` (m59-strategy-schema.mjs), so
// silence -- no `needle` -- is exactly the farm pass that was there before.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSTRATE = join(HERE, '..', 'substrate');

// --------------------------------------------------------------------------------------------- the site's normal form

export const ROLES = Object.freeze(['striker', 'archer']);

export const SITE_DEFAULTS = Object.freeze({
  // A valid monster within this many squares (Euclidean, coarse) of the kill square counts as "the needle is busy":
  // it resets the pull clock.
  killRadius: 3,
  // Seconds a stale presence row is still believed. A keeper that stopped publishing (it fled, rested, died, logged
  // off, or its pass is somewhere else entirely) loses its slot after this long; that is the replacement rule's clock.
  staleS: 20,
  // Attack rounds per farm pass. One means the closest target is re-chosen before every swing -- the operator's
  // "if another valid target is closest, it just starts hitting the new closest". More rounds is fewer passes per kill
  // and slower re-targeting.
  rounds: 1,
});
const STRIKER_DEFAULTS = Object.freeze({ reach: 2, pullStep: null, minHealth: 0.5 });
const ARCHER_DEFAULTS = Object.freeze({ capacity: 4, reach: 17, pullSquare: null, minHealth: 0.3, minArrows: 1 });
// Operator 2026-11-05: "Idle for 15s even is enough to be worth pulling".
const PULL_DEFAULTS = Object.freeze({ idleS: 15, everyS: 20, maxPer10m: 20, excursionS: 25, minHealth: 0.7, legSteps: 16 });
const RESERVE_DEFAULTS = Object.freeze({ mode: 'farm', squares: [] });
const ECON_DEFAULTS = Object.freeze({ arrowPrice: null, tickMin: 5 });

const LIMITS = {
  killRadius: [1, 8], staleS: [5, 300], rounds: [1, 6],
  'striker.reach': [1, 3], 'striker.minHealth': [0, 1],
  'archers.capacity': [0, 12], 'archers.reach': [2, 100], 'archers.minHealth': [0, 1], 'archers.minArrows': [0, 1000],
  'pull.idleS': [5, 600], 'pull.everyS': [5, 3600], 'pull.maxPer10m': [0, 120], 'pull.excursionS': [5, 120],
  'pull.minHealth': [0, 1], 'pull.legSteps': [2, 60],
  'econ.tickMin': [1, 60],
};

const isNote = k => k.startsWith('_') || k === 'why' || k === 'describe' || k === 'derived';

function square(v, where) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) throw new Error(`${where} ${JSON.stringify(v)} is a bare pair; write { row, col } (docs/m59-coordinates.md)`);
  if (typeof v === 'string') return parseSquare(v);
  const row = Number(v?.row), col = Number(v?.col);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || col < 1)
    throw new Error(`${where} ${JSON.stringify(v)} is not a whole 1-based { row, col }`);
  return { row, col };
}

function num(obj, key, def, path) {
  const v = obj?.[key];
  if (v === undefined || v === null) return def;
  const n = Number(v), [lo, hi] = LIMITS[path] ?? [-Infinity, Infinity];
  if (typeof v === 'boolean' || !Number.isFinite(n) || n < lo || n > hi) throw new Error(`needle ${path} must be a number from ${lo} to ${hi}`);
  return n;
}

function known(obj, keys, path) {
  if (obj == null) return;
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`needle ${path} must be an object`);
  const extra = Object.keys(obj).filter(k => !keys.includes(k) && !isNote(k));
  if (extra.length) throw new Error(`needle ${path} has unrecognised key(s) ${extra.join(', ')}`);
}

const agentList = (v, path) => {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new Error(`needle ${path} must be a list of agent names`);
  return v.map(x => String(x).trim()).filter(Boolean);
};

/** A safe site name: it becomes a file name and a directory name. */
export function siteName(v) {
  const s = String(v ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(s) || s.includes('..')) throw new Error(`needle site name "${s}" must be letters, digits, '.', '_' or '-'`);
  return s;
}

/**
 * The site file's normal form. Everything an operator can set, filled with its default; an unknown key is refused (a
 * setting that silently does nothing is the failure docs/m59-policy.md is about), except notes: keys starting with `_`,
 * and `why` / `describe` / `derived`.
 */
export function normSite(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('a needle site must be an object');
  known(v, ['name', 'room', 'kill', 'killRadius', 'striker', 'archers', 'pull', 'roster', 'reserve', 'staleS', 'rounds', 'econ'], 'site');
  const name = siteName(v.name);
  const room = Number(v.room);
  if (!Number.isInteger(room) || room <= 1) throw new Error('needle room must be a room number above 1');
  const kill = square(v.kill, 'needle kill');
  if (!kill) throw new Error('needle kill square is required: where the pack stops');
  const out = { name, room, kill };
  for (const k of Object.keys(SITE_DEFAULTS)) out[k] = num(v, k, SITE_DEFAULTS[k], k);

  known(v.striker, ['station', 'reach', 'pullStep', 'minHealth'], 'striker');
  const st = v.striker ?? {};
  out.striker = {
    station: square(st.station, 'needle striker.station'),
    reach: num(st, 'reach', STRIKER_DEFAULTS.reach, 'striker.reach'),
    pullStep: square(st.pullStep, 'needle striker.pullStep'),
    minHealth: num(st, 'minHealth', STRIKER_DEFAULTS.minHealth, 'striker.minHealth'),
  };
  if (!out.striker.station) throw new Error('needle striker.station is required (the striker is optional at run time, the square is not)');

  known(v.archers, ['stations', 'capacity', 'reach', 'pullSquare', 'minHealth', 'minArrows'], 'archers');
  const ar = v.archers ?? {};
  if (ar.stations != null && !Array.isArray(ar.stations)) throw new Error('needle archers.stations must be a list of { row, col }');
  const stations = [];
  for (const q of ar.stations ?? []) {
    const s = square(q, 'needle archer station');
    if (stations.some(x => x.row === s.row && x.col === s.col)) throw new Error(`needle archer station r${s.row}c${s.col} is listed twice`);
    if (s.row === out.striker.station.row && s.col === out.striker.station.col) throw new Error('an archer station cannot be the striker station');
    stations.push(s);
  }
  out.archers = {
    stations,
    capacity: num(ar, 'capacity', ARCHER_DEFAULTS.capacity, 'archers.capacity'),
    reach: num(ar, 'reach', ARCHER_DEFAULTS.reach, 'archers.reach'),
    pullSquare: square(ar.pullSquare, 'needle archers.pullSquare'),
    minHealth: num(ar, 'minHealth', ARCHER_DEFAULTS.minHealth, 'archers.minHealth'),
    minArrows: num(ar, 'minArrows', ARCHER_DEFAULTS.minArrows, 'archers.minArrows'),
  };

  known(v.pull, Object.keys(PULL_DEFAULTS), 'pull');
  out.pull = Object.fromEntries(Object.keys(PULL_DEFAULTS).map(k => [k, num(v.pull ?? {}, k, PULL_DEFAULTS[k], `pull.${k}`)]));

  known(v.roster, ['strikers', 'archers'], 'roster');
  out.roster = { strikers: agentList(v.roster?.strikers, 'roster.strikers'), archers: agentList(v.roster?.archers, 'roster.archers') };

  known(v.reserve, ['mode', 'squares'], 'reserve');
  const mode = v.reserve?.mode ?? RESERVE_DEFAULTS.mode;
  if (!['farm', 'hold'].includes(mode)) throw new Error('needle reserve.mode must be "farm" (ordinary farming) or "hold" (stand on a reserve square)');
  if (v.reserve?.squares != null && !Array.isArray(v.reserve.squares)) throw new Error('needle reserve.squares must be a list of { row, col }');
  out.reserve = { mode, squares: (v.reserve?.squares ?? []).map(q => square(q, 'needle reserve square')) };
  if (mode === 'hold' && !out.reserve.squares.length) throw new Error('needle reserve.mode "hold" needs reserve.squares');

  known(v.econ, Object.keys(ECON_DEFAULTS), 'econ');
  const price = v.econ?.arrowPrice;
  out.econ = {
    arrowPrice: price == null ? null : num(v.econ, 'arrowPrice', null, 'econ.arrowPrice'),
    tickMin: num(v.econ ?? {}, 'tickMin', ECON_DEFAULTS.tickMin, 'econ.tickMin'),
  };
  return out;
}

/** Effective archer slots: the capacity, never more than the stations listed. */
export const archerSlots = site => Math.min(site.archers.capacity, site.archers.stations.length);

/**
 * The STRATEGY FIELD's normal form: `{ site: '<name>' | {...a whole site}, role: 'striker' | 'archer' }`. A named site is
 * resolved at run time from this machine's substrate/needles/<name>.json (the squares and the roster are orders, so
 * they are this machine's); an inline one is normalised here.
 */
export function normNeedle(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('needle must be { site, role } or null');
  const extra = Object.keys(v).filter(k => !['site', 'role'].includes(k) && !isNote(k));
  if (extra.length) throw new Error(`needle has unrecognised key(s) ${extra.join(', ')}`);
  const role = String(v.role ?? '').toLowerCase();
  if (!ROLES.includes(role)) throw new Error(`needle.role must be one of ${ROLES.join(', ')}`);
  const site = typeof v.site === 'string' ? siteName(v.site) : normSite(v.site);
  return { site, role };
}

/** `r34c43` -> { row: 34, col: 43 }. Only this spelling: it names its axes. */
export function parseSquare(s) {
  const m = /^r(\d+)c(\d+)$/i.exec(String(s).trim());
  if (!m) throw new Error(`"${s}" is not an rNcM square (r = row, c = col)`);
  return { row: Number(m[1]), col: Number(m[2]) };
}
export const sq = p => (p ? `r${p.row}c${p.col}` : null);
const d2 = (a, b) => (a.row - b.row) ** 2 + (a.col - b.col) ** 2;
const dist = (a, b) => Math.sqrt(d2(a, b));
const same = (a, b) => !!a && !!b && a.row === b.row && a.col === b.col;

// ------------------------------------------------------------------------------------------------- weapons and reach

// weapon.kod:307 by type; m59-research reports/weapon-reach-and-range.md. Thrust 3, everything else in melee 2.
const THRUST = /\b(short sword|long sword|mystic sword|gold sword|nerudite sword|sword of riija|sword of the hunt|black dagger|dark blade)\b/i;
// The ranged weapons' own range values (ranged.kod; the same report).
const BOW_RANGE = [[/\blong ?bow\b|\bcrossbow\b/i, 100], [/\bmagic bow\b/i, 50], [/\bpractice bow\b/i, 30],
                   [/\bnerudite bow\b/i, 20], [/\bbattle bow\b/i, 17], [/\bbow\b/i, 17]];

/** Squares this weapon reaches: { reach, ranged }. Unknown or bare hands: 2, the safe answer. */
export function weaponReach(name) {
  const n = String(name ?? '');
  for (const [rx, r] of BOW_RANGE) if (rx.test(n)) return { reach: r, ranged: true };
  if (THRUST.test(n)) return { reach: 3, ranged: false };
  return { reach: 2, ranged: false };
}

/** The reach a role actually swings at: the site's number, never more than the weapon in hand can do. */
export function roleReach(site, role, wieldedName = null) {
  const configured = role === 'striker' ? site.striker.reach : site.archers.reach;
  if (!wieldedName) return role === 'striker' ? Math.min(configured, 2) : configured;
  const w = weaponReach(wieldedName);
  if (role === 'archer' && !w.ranged) return Math.min(configured, w.reach);
  return Math.min(configured, w.reach);
}

// ------------------------------------------------------------------------------------------------------ target choice

/**
 * THE CLOSEST VALID MONSTER IN REACH OF WHERE WE STAND. `candidates` are already valid (prey after every farm filter,
 * plus anything hitting us that is not spared) as `{ id, row, col }`. Closest wins, so a new monster stepping to the
 * front takes the next swing. A tie (within a tenth of a square) keeps the current target, so two equidistant monsters
 * do not swap every pass. `los(o)` (optional) breaks the remaining ties toward a target we can see: an archer's shot
 * without sight counts 1 in 25 toward improvement.
 */
export function chooseTarget(candidates, from, { reach, currentId = null, los = null } = {}) {
  if (!from || !Array.isArray(candidates)) return { target: null, inReach: [] };
  const inReach = candidates.filter(o => Number.isFinite(o?.row) && Number.isFinite(o?.col) && dist(o, from) <= reach + 1e-9)
    .map(o => ({ o, d: dist(o, from), seen: los ? !!safe(() => los(o)) : null }));
  inReach.sort((a, b) => a.d - b.d);
  if (!inReach.length) return { target: null, inReach: [] };
  const best = inReach[0].d;
  const tied = inReach.filter(x => x.d - best <= 0.1);
  const pick = tied.find(x => x.o.id === currentId) ?? tied.find(x => x.seen) ?? tied[0];
  return { target: pick.o, distance: +pick.d.toFixed(2), seen: pick.seen, inReach: inReach.map(x => x.o) };
}
const safe = f => { try { return f(); } catch { return false; } };

// --------------------------------------------------------------------------------------- the allocation and replacement

const prefIndex = (list, agent) => { const i = list.indexOf(agent); return i < 0 ? Infinity : i; };

/**
 * WHO HOLDS WHICH SQUARE, FROM EVERY KEEPER'S OWN PUBLISHED ROW. Each keeper runs this over the same rows and gets the
 * same answer; nobody is told. A row is `{ agent, role, room, at, fit, slot, health, why_unfit }`; `slot` is what that
 * keeper believed it held last time ('striker', 'archer:<i>', 'reserve', ...).
 *
 *   STRIKER      the first FIT, FRESH striker-role row: the incumbent (slot 'striker') first, so a fit striker is never
 *                displaced by a better-listed one arriving; then `roster.strikers` order, then name. THE REPLACEMENT
 *                RULE is just this rule re-run: the incumbent's row goes unfit (below striker.minHealth) or stale (its
 *                keeper's survival ladder took the body and its farm pass stopped publishing), and the next eligible
 *                melee in that order takes the station. A newcomer must be at least minHealth + 0.2 (capped 0.95) so a
 *                body the ladder just let go is not handed the tip at the edge of its flee line.
 *   ARCHERS      up to archerSlots(site): incumbents keep their station index; free stations fill lowest index first in
 *                `roster.archers` order, then name. The rest are OVERFLOW.
 *   RESERVE      fit strikers who are not the striker, and overflow archers: they do `reserve.mode` (ordinary farming, or
 *                hold a reserve square).
 *   PULLER       the archer on the lowest occupied station (the "front" archer). With no archer, the striker -- only if
 *                it has a `pullStep` to step to; otherwise nobody pulls and the needle waits for wanderers.
 *   MODE         'needle' (striker + archers), 'striker_only', 'archers_only' (the operator: "probably can't support just
 *                lone archers without incoming money" -- it runs, and it is reported as money-losing), 'empty'.
 */
export function allocate(site, rows = [], { now = Date.now() } = {}) {
  const staleMs = site.staleS * 1000;
  const fresh = rows.filter(r => r && r.agent && Number(r.room) === site.room && now - Number(r.at) <= staleMs);
  const stale = rows.filter(r => r && r.agent && Number(r.room) === site.room && now - Number(r.at) > staleMs).map(r => r.agent);
  const unfit = fresh.filter(r => !r.fit).map(r => ({ agent: r.agent, role: r.role, why: r.why_unfit ?? 'unfit' }));

  const strikerRows = fresh.filter(r => r.role === 'striker' && r.fit);
  const newcomerFloor = Math.min(0.95, site.striker.minHealth + 0.2);
  const eligible = strikerRows.filter(r => r.slot === 'striker' || !Number.isFinite(r.health) || r.health >= newcomerFloor);
  eligible.sort((a, b) => ((a.slot === 'striker') ? 0 : 1) - ((b.slot === 'striker') ? 0 : 1)
    || prefIndex(site.roster.strikers, a.agent) - prefIndex(site.roster.strikers, b.agent)
    || String(a.agent).localeCompare(String(b.agent)));
  const striker = eligible[0]?.agent ?? null;
  const reserve = strikerRows.filter(r => r.agent !== striker).map(r => r.agent).sort();

  const slots = archerSlots(site);
  const archerRows = fresh.filter(r => r.role === 'archer' && r.fit);
  const order = (a, b) => prefIndex(site.roster.archers, a.agent) - prefIndex(site.roster.archers, b.agent)
    || String(a.agent).localeCompare(String(b.agent));
  const held = new Map();                                       // station index -> agent
  const placed = new Set();
  const incumbentIndex = r => { const m = /^archer:(\d+)$/.exec(String(r.slot ?? '')); return m ? Number(m[1]) : null; };
  for (const r of [...archerRows].sort(order)) {
    const i = incumbentIndex(r);
    if (i != null && i < slots && !held.has(i)) { held.set(i, r.agent); placed.add(r.agent); }
  }
  for (const r of [...archerRows].sort(order)) {
    if (placed.has(r.agent)) continue;
    let i = 0; while (i < slots && held.has(i)) i++;
    if (i >= slots) break;
    held.set(i, r.agent); placed.add(r.agent);
  }
  const archers = [...held.entries()].sort((a, b) => a[0] - b[0])
    .map(([index, agent]) => ({ agent, index, station: site.archers.stations[index] }));
  const overflow = archerRows.filter(r => !placed.has(r.agent)).map(r => r.agent).sort();

  let puller = null;
  if (archers.length) puller = { agent: archers[0].agent, role: 'archer', from: site.archers.pullSquare ?? archers[0].station };
  else if (striker && site.striker.pullStep) puller = { agent: striker, role: 'striker', from: site.striker.pullStep };

  const mode = striker && archers.length ? 'needle' : striker ? 'striker_only' : archers.length ? 'archers_only' : 'empty';
  const moneyLosing = mode === 'archers_only';
  return {
    mode, striker, archers, puller, reserve: [...reserve, ...overflow], overflow, unfit, stale,
    money_losing: moneyLosing,
    why: mode === 'archers_only' ? 'no fit striker: archers alone spend arrows faster than the loot pays (operator 2026-11-05); they also pull'
      : mode === 'striker_only' ? 'no archer at the needle: the striker holds alone' + (site.striker.pullStep ? ' and pulls from its pull step' : ', nobody can pull')
      : mode === 'empty' ? 'nobody fit is at the needle' : null,
  };
}

/** What one agent does under an allocation: { role: 'striker'|'archer'|'reserve'|'none', station, index }. */
export function slotOf(alloc, agent) {
  if (!alloc || !agent) return { role: 'none' };
  if (alloc.striker === agent) return { role: 'striker', slot: 'striker' };
  const a = alloc.archers.find(x => x.agent === agent);
  if (a) return { role: 'archer', slot: `archer:${a.index}`, index: a.index, station: a.station };
  if (alloc.reserve.includes(agent)) return { role: 'reserve', slot: 'reserve' };
  return { role: 'none', slot: null };
}

// --------------------------------------------------------------------------------------------------------- the pull

/**
 * IS A PULL DUE? The puller asks every pass it is idle on its station. All of these, or no:
 *   - the needle has been quiet (no valid monster within killRadius of the kill square, nor in the striker's reach) for
 *     pull.idleS seconds -- 15 by default, the operator's number;
 *   - something valid is visible in the room to pull (nothing visible: the room has nothing for us, waiting is free);
 *   - nothing is hitting the puller, and its health is at least pull.minHealth;
 *   - the last pull at this site (any puller's, from the shared rows) is at least pull.everyS ago, and fewer than
 *     pull.maxPer10m pulls happened in the last ten minutes. Bounded: a needle that pulls and gets nothing cannot loop.
 */
export function pullDue({ site, now = Date.now(), quietSince, lastPullAt = 0, pullTimes = [], health = 1, attacked = false, visible = 0 }) {
  const p = site.pull;
  if (attacked) return { due: false, why: 'something is hitting the puller' };
  if (!(health >= p.minHealth)) return { due: false, why: `health ${Math.round(health * 100)}% is below the pull floor ${Math.round(p.minHealth * 100)}%` };
  if (!(visible > 0)) return { due: false, why: 'nothing valid in the room to pull; waiting for wanderers' };
  const quiet = now - (quietSince ?? now);
  if (quiet < p.idleS * 1000) return { due: false, why: `the needle has been quiet ${Math.round(quiet / 1000)}s of ${p.idleS}s` };
  const since = now - (lastPullAt || 0);
  if (since < p.everyS * 1000) return { due: false, why: `last pull ${Math.round(since / 1000)}s ago; at most one every ${p.everyS}s` };
  const recent = pullTimes.filter(t => now - t < 600_000).length;
  if (recent >= p.maxPer10m) return { due: false, why: `${recent} pulls in the last 10 minutes; the cap is ${p.maxPer10m}` };
  return { due: true, why: `quiet ${Math.round(quiet / 1000)}s with ${visible} valid in the room` };
}

/** Is the needle busy: any valid monster near the tip or in the striker's reach of its station. */
export function needleBusy(site, valid = []) {
  return valid.some(o => Number.isFinite(o?.row) && (dist(o, site.kill) <= site.killRadius + 1e-9
    || dist(o, site.striker.station) <= site.striker.reach + 1e-9));
}

// ------------------------------------------------------------------------------------------- deriving a site offline

/** The monster's coarse component from a square: CanMoveInRoom's rule (source direction bit, destination floor bit). */
export function monsterComponent(geo, from, cap = 20_000) {
  const k0 = `${from.row},${from.col}`, seen = new Set([k0]), q = [[from.row, from.col]];
  for (let i = 0; i < q.length && seen.size < cap; i++) {
    const [r, c] = q[i];
    for (const d of geo.openDirections(r, c, { fine: false }) ?? []) {
      const R = r + d.dr, C = c + d.dc, k = `${R},${C}`;
      if (seen.has(k) || !geo.inBounds(R, C) || !geo.walkable(R, C)) continue;
      seen.add(k); q.push([R, C]);
    }
  }
  return seen;
}

/**
 * DERIVE A NEEDLE FROM THE MAP. Given the striker station and the kill square (the operator's observation), it proves
 * the needle and ranks every square an archer could hold:
 *
 *   - the kill square is in the monster's coarse component, and the striker station is within the striker's reach of it;
 *   - CANDIDATES are squares the mover can walk to from the striker station (`reachableFrom`, the step rule the router
 *     plans on), with floor, NOT in the monster component, within bow range of the kill square;
 *   - THREAT: how many monster-component squares within monster reach (3, the worst case, monster.kod:1682) have line
 *     of sight to it -- the server's own staircase, on the coarse grid (lineOfSight fine:false). A station must be 0;
 *   - SEES THE TIP: the archer has coarse line of sight to the kill square, so its shots there count toward archery;
 *   - NEAR: monster squares within reach at all (sight or not). Fewer is the more robust choice if the sight model is
 *     off by a bit somewhere; it is the first ranking key;
 *   - COVERAGE: monster squares within bow range the square can see -- the pull square is the safe square within
 *     `pullWithin` (6) of the striker that sees most of the room;
 *   - RESERVE: safe squares with NO monster square within reach at all, nearest the striker -- the bench.
 *
 * `fine` reports whether the server's monster_grid (the grid a LOS_NEW_MONSTER server would use) reaches the square;
 * under that setting the pocket behind 2143's needle is monster ground and the whole site is wrong. It is reported, not
 * enforced, because the operator's observation (the pack stops at the tip) is only consistent with the coarse grid.
 */
export function deriveNeedle(geo, { kill, striker, strikerReach = 3, bowReach = 17, monsterReach = 3, pullWithin = 6, lib } = {}) {
  const { lineOfSight, reachableFrom } = lib;
  const problems = [];
  const M = monsterComponent(geo, kill);
  const inM = p => M.has(`${p.row},${p.col}`);
  if (!geo.walkable(kill.row, kill.col)) problems.push(`kill square ${sq(kill)} is not floor on the coarse grid`);
  if (d2(striker, kill) > strikerReach ** 2) problems.push(`striker ${sq(striker)} cannot reach the kill square ${sq(kill)} (reach ${strikerReach})`);
  const P = reachableFrom(geo, striker);
  if (!P) problems.push('no mover geometry: cannot tell which squares a player can walk to');
  const strikerDirs = (geo.openDirections(striker.row, striker.col, { fine: false }) ?? []).map(d => `${d.dr},${d.dc}`);
  // The fine (monster_grid) component, for the hedge.
  const F = new Set([`${kill.row},${kill.col}`]); const fq = [[kill.row, kill.col]];
  for (let i = 0; i < fq.length && F.size < 20_000; i++) {
    const [r, c] = fq[i];
    for (const d of geo.openDirections(r, c, { fine: true }) ?? []) {
      const R = r + d.dr, C = c + d.dc, k = `${R},${C}`;
      if (F.has(k) || !geo.inBounds(R, C)) continue; F.add(k); fq.push([R, C]);
    }
  }
  const mList = [...M].map(k => { const [row, col] = k.split(',').map(Number); return { row, col }; });
  const candidates = [];
  for (const k of P ?? []) {
    const [row, col] = k.split(',').map(Number), p = { row, col };
    if (M.has(k) || !geo.walkable(row, col) || same(p, striker)) continue;
    if (d2(p, kill) > bowReach ** 2) continue;
    let threat = 0, near = 0, minD2 = Infinity, coverage = 0;
    for (const m of mList) {
      const dd = d2(m, p);
      if (dd < minD2) minD2 = dd;
      if (dd <= monsterReach ** 2) { near++; if (lineOfSight(geo, m.row, m.col, row, col, { fine: false })) threat++; }
      if (dd <= bowReach ** 2 && lineOfSight(geo, row, col, m.row, m.col, { fine: false })) coverage++;
    }
    const seesTip = lineOfSight(geo, row, col, kill.row, kill.col, { fine: false });
    const stand = typeof geo.standPoint === 'function' ? !!safe(() => geo.standPoint(row, col)) : true;
    candidates.push({ square: sq(p), row, col, d2_kill: d2(p, kill), d2_striker: d2(p, striker), threat, near,
      min_d2_monster: minD2, sees_tip: seesTip, coverage, stand, monster_grid_reaches: F.has(k) });
  }
  const safeOnes = candidates.filter(c => c.threat === 0 && c.stand);
  const stations = safeOnes.filter(c => c.sees_tip)
    .sort((a, b) => a.near - b.near || a.d2_kill - b.d2_kill || a.row - b.row || a.col - b.col)
    .map(c => ({ ...c, why: `no monster square in reach can see it (threat 0, ${c.near} monster squares within ${monsterReach}); sees the tip; ${Math.sqrt(c.d2_kill).toFixed(1)} from it` }));
  const blind = safeOnes.filter(c => !c.sees_tip).sort((a, b) => a.d2_kill - b.d2_kill)
    .map(c => ({ ...c, why: 'safe, but cannot see the tip: a shot from here counts 1 in 25 toward archery (player.kod:4096-4108)' }));
  // A pull is an excursion: only squares within `pullWithin` of the striker, so it is a few steps out and back.
  const pull = safeOnes.filter(c => c.d2_striker <= pullWithin ** 2)
    .sort((a, b) => b.coverage - a.coverage || a.d2_striker - b.d2_striker)
    .slice(0, 5).map(c => ({ ...c, why: `safe, ${Math.sqrt(c.d2_striker).toFixed(1)} from the striker, sees ${c.coverage} monster squares within bow range` }));
  const reserve = safeOnes.filter(c => c.near === 0).sort((a, b) => a.d2_striker - b.d2_striker || a.row - b.row || a.col - b.col)
    .slice(0, 8).map(c => ({ ...c, why: `no monster square within ${monsterReach} at all` }));
  return {
    kill: sq(kill), striker: sq(striker), problems, monster_component: M.size, player_reachable: P?.size ?? null,
    striker_in_monster_component: inM(striker), striker_coarse_dirs: strikerDirs,
    kill_coarse_dirs: (geo.openDirections(kill.row, kill.col, { fine: false }) ?? []).map(d => `${d.dr},${d.dc}`),
    stations, blind, pull, reserve,
  };
}

/** Prove a site file against the map: every square standable and walkable to, every archer station safe and sighted. */
export function checkSite(site, geo, lib) {
  const derived = deriveNeedle(geo, { kill: site.kill, striker: site.striker.station, strikerReach: site.striker.reach,
    bowReach: site.archers.reach, lib });
  const byKey = new Map([...derived.stations, ...derived.blind].map(c => [c.square, c]));
  const P = lib.reachableFrom(geo, site.striker.station);
  const rows = [];
  const look = (what, p, wantSafe) => {
    if (!p) return;
    const k = `${p.row},${p.col}`;
    const c = byKey.get(sq(p));
    const ok = !!P?.has(k) && (!wantSafe || (c && c.threat === 0));
    rows.push({ what, square: sq(p), walkable_to: !!P?.has(k), threat: c?.threat ?? null, sees_tip: c?.sees_tip ?? null,
      monster_grid_reaches: c?.monster_grid_reaches ?? null, ok,
      why: !P?.has(k) ? 'the mover cannot walk here from the striker station' : wantSafe && !c ? 'not a safe square (a monster can reach or see it)' : null });
  };
  look('striker station', site.striker.station, false);
  look('striker pull step', site.striker.pullStep, false);
  site.archers.stations.forEach((s, i) => look(`archer station ${i + 1}${i === 0 ? ' (front)' : ''}`, s, true));
  look('archer pull square', site.archers.pullSquare, true);
  site.reserve.squares.forEach((s, i) => look(`reserve ${i + 1}`, s, true));
  return { site: site.name, room: site.room, ok: !derived.problems.length && rows.every(r => r.ok), problems: derived.problems, rows,
    blind_stations: rows.filter(r => r.what.startsWith('archer station') && r.sees_tip === false).map(r => r.square) };
}

// --------------------------------------------------------------------------------------------------------- economics

/** Shillings in a looted list, from the keeper's own "<name> x<amount>" strings. */
export function shillingsIn(looted) {
  const items = Array.isArray(looted) ? looted : String(looted ?? '').split(/,\s*/);
  let n = 0;
  for (const s of items) {
    const m = /^\s*shillings?\b(?:\s*x\s*(\d+))?/i.exec(String(s));
    if (m) n += m[1] ? Number(m[1]) : 1;
  }
  return n;
}

/**
 * THE BREAK-EVEN READOUT. Never a count without its denominator: every rate is per 30 minutes OF DUTY in that role, and
 * duty minutes are the keepers' own `needle_duty` rows (time actually spent at the needle, gaps over two minutes not
 * counted), printed beside it. Kills are the `killed` ledger rows the needle tagged with its site and role -- the same
 * rows every kills/30m in this repository counts. Arrows spent are shots attempted (every attempted shot spends one:
 * fire.kod:143-160). Income is the shillings in those kills' loot; nothing else is valued, and the report says so.
 */
export function econReport(events = [], { site, arrowPrice = null, sinceMs = null, now = Date.now() } = {}) {
  const roles = {};
  const R = role => (roles[role] ??= { role, agents: new Set(), duty_min: 0, kills: 0, shots: 0, shillings: 0, pulls: 0 });
  const modes = {};
  for (const e of events) {
    if (e?.type !== 'event') continue;
    if (e.kind === 'needle_duty' && e.site === site) {
      const r = R(e.role ?? 'unknown');
      r.agents.add(e.agent ?? e.character);
      r.duty_min += Number(e.minutes) || 0;
      r.shots += Number(e.shots) || 0;
      r.pulls += Number(e.pulls) || 0;
      if (e.mode) modes[e.mode] = (modes[e.mode] ?? 0) + (Number(e.minutes) || 0);
    } else if (e.kind === 'killed' && e.needle?.site === site) {
      const r = R(e.needle.role ?? 'unknown');
      r.agents.add(e.agent ?? e.character);
      r.kills++;
      r.shillings += shillingsIn(e.looted);
    }
  }
  // ARROWS AS BOUGHT: the keeper's own `bought` rows (journal.mjs) for an arrow, by an agent who stood a needle duty in
  // the window, filed under the role it spent most duty minutes in. Purchases a coordinator or courier made on its
  // behalf are not keeper rows and are not here (the caveat says so).
  const dutyBy = new Map();                                   // agent -> { role -> minutes }
  for (const e of events) if (e?.type === 'event' && e.kind === 'needle_duty' && e.site === site) {
    const a = e.agent ?? e.character, m = dutyBy.get(a) ?? {};
    m[e.role] = (m[e.role] ?? 0) + (Number(e.minutes) || 0); dutyBy.set(a, m);
  }
  for (const e of events) {
    if (e?.type !== 'event' || e.kind !== 'bought' || !/\barrows?\b/i.test(String(e.what ?? ''))) continue;
    const m = dutyBy.get(e.agent ?? e.character);
    if (!m) continue;
    const role = Object.entries(m).sort((a, b) => b[1] - a[1])[0][0];
    const r = R(role);
    r.bought = (r.bought ?? 0) + (Number(e.cost) || 0);
  }
  const per30 = (n, min) => (min > 0 ? +(n * 30 / min).toFixed(2) : null);
  const out = Object.values(roles).map(r => {
    const arrowCost = arrowPrice != null ? r.shots * arrowPrice : null;
    return { role: r.role, agents: [...r.agents].filter(Boolean).sort(), duty_min: +r.duty_min.toFixed(1),
      kills: r.kills, kills_30m: per30(r.kills, r.duty_min), shots: r.shots, arrows_30m: per30(r.shots, r.duty_min),
      shillings: r.shillings, shillings_30m: per30(r.shillings, r.duty_min), pulls: r.pulls,
      arrows_bought_sh: r.bought ?? 0, arrows_bought_30m: per30(r.bought ?? 0, r.duty_min),
      arrow_cost: arrowCost, net_30m: arrowCost != null ? per30(r.shillings - arrowCost, r.duty_min) : null };
  }).sort((a, b) => a.role.localeCompare(b.role));
  const total = out.reduce((t, r) => ({ duty_min: t.duty_min + r.duty_min, kills: t.kills + r.kills, shots: t.shots + r.shots,
    shillings: t.shillings + r.shillings, arrows_bought_sh: t.arrows_bought_sh + r.arrows_bought_sh }),
    { duty_min: 0, kills: 0, shots: 0, shillings: 0, arrows_bought_sh: 0 });
  const arrowCost = arrowPrice != null ? total.shots * arrowPrice : null;
  return { site, since_ms: sinceMs, arrow_price: arrowPrice, roles: out, modes_min: modes,
    total: { ...total, duty_min: +total.duty_min.toFixed(1), arrow_cost: arrowCost,
      net: arrowCost != null ? total.shillings - arrowCost : null,
      net_as_bought: total.shillings - total.arrows_bought_sh },
    caveats: ['income counts only shillings looted on needle kills; sold loot (fern, claws, nerudite) is not valued here',
      'arrows spent = shots attempted (each attempt spends one); arrows_bought_sh = the needle keepers own bought rows; arrows a courier or coordinator bought for them are not counted',
      arrowPrice == null ? 'no --arrow-price: arrow cost and net are null, not zero' : `arrow cost at ${arrowPrice} shillings each`] };
}

// --------------------------------------------------------------------------------------------- the shared state store

export const NEEDLE_STATE_DIR = () => process.env.M59_NEEDLE_STATE_DIR || join(SUBSTRATE, '.needle');
export const NEEDLE_SITE_DIRS = () => [process.env.M59_NEEDLE_DIR || join(SUBSTRATE, 'needles'),
  ...String(process.env.M59_NEEDLE_PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)];

/** One writer per file: each keeper writes only its own row. Atomic (tmp + rename), like substrate/.buddy. */
export function writePresence(site, agent, row, { dir = NEEDLE_STATE_DIR(), now = Date.now() } = {}) {
  const d = join(dir, siteName(site));
  mkdirSync(d, { recursive: true });
  const file = join(d, `${siteName(agent)}.json`), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...row, agent, at: now }));
  renameSync(tmp, file);
}

/** Every row for a site. Unreadable rows are skipped (a half-written file is a missing row, never an error). */
export function readPresence(site, { dir = NEEDLE_STATE_DIR() } = {}) {
  const d = join(dir, siteName(site));
  let files = [];
  try { files = readdirSync(d).filter(f => f.endsWith('.json')); } catch { return []; }
  const rows = [];
  for (const f of files) { try { rows.push(JSON.parse(readFileSync(join(d, f), 'utf8'))); } catch { /* skip */ } }
  return rows;
}

/** A site by name from this machine's directories (`extraDirs` for the CLI's example fallback). { site, file, mtime }. */
export function loadSite(name, { dirs = NEEDLE_SITE_DIRS(), extraDirs = [] } = {}) {
  const n = siteName(name);
  for (const d of [...dirs, ...extraDirs]) {
    const file = join(d, `${n}.json`);
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const site = normSite({ ...raw, name: raw.name ?? n });
    if (site.name !== n) throw new Error(`${file} names itself "${site.name}", not "${n}"`);
    return { site, file, mtime: statSync(file).mtimeMs };
  }
  throw new Error(`no needle site named ${n} (looked in ${[...dirs, ...extraDirs].join(', ')})`);
}

// ---------------------------------------------------------------------------------------------------------------- CLI

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const val = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const json = argv.includes('--json');
  const cmd = argv[0];
  const usage = 'usage: node tools/m59-needle-farm.mjs derive --room <n> --striker rNcM --kill rNcM [--bow 17] [--striker-reach 3]\n' +
    '       node tools/m59-needle-farm.mjs check --site <name> | status --site <name> | econ --site <name> [--since 2h] [--arrow-price N]   [--json]';
  const example = join(SUBSTRATE, 'needles.example');
  const geometryFor = async room => {
    const { loadMap } = await import('./m59-map.mjs');
    const { attachStepMasks } = await import('./m59-routes.mjs');
    const { sharedRoomGeometry } = await import('./m59-roo.mjs');
    const lib = await import('./m59-safespots.mjs');
    const map = loadMap(); attachStepMasks(map);
    const r = map.rooms[String(room)];
    if (!r) { console.error(`room ${room} is not in the map`); process.exit(2); }
    return { geo: sharedRoomGeometry(r), lib, name: r.name };
  };
  const print = (o, text) => console.log(json ? JSON.stringify(o, null, 1) : text());
  if (cmd === 'derive') {
    const room = Number(val('--room'));
    const kill = parseSquare(val('--kill')), striker = parseSquare(val('--striker'));
    const { geo, lib, name } = await geometryFor(room);
    const d = deriveNeedle(geo, { kill, striker, strikerReach: Number(val('--striker-reach') ?? 3), bowReach: Number(val('--bow') ?? 17), lib });
    print(d, () => [
      `${room} ${name}: striker ${d.striker}, kill ${d.kill}; monster component ${d.monster_component} squares, player reaches ${d.player_reachable}`,
      `  kill square coarse directions [${d.kill_coarse_dirs.join(' ')}]; striker [${d.striker_coarse_dirs.join(' ')}]` +
        `${d.striker_in_monster_component ? ' (the striker square is the needle\'s dead end: a monster can step in only from the tip, and the striker stands in it)' : ''}`,
      ...(d.problems.length ? d.problems.map(p => '  PROBLEM ' + p) : []),
      '  archer stations (safe, sees the tip), best first:',
      ...d.stations.slice(0, 10).map(c => `    ${c.square.padEnd(8)} near ${c.near} d ${Math.sqrt(c.d2_kill).toFixed(1)} covers ${c.coverage}${c.monster_grid_reaches ? ' [monster_grid reaches]' : ''}`),
      '  pull squares (safe, most of the room in sight):',
      ...d.pull.map(c => `    ${c.square.padEnd(8)} covers ${c.coverage} sees tip ${c.sees_tip}`),
      '  reserve (no monster square within 3):', '    ' + d.reserve.map(c => c.square).join(' '),
      `  blind but safe (1-in-25 training): ${d.blind.length} squares, nearest ${d.blind.slice(0, 6).map(c => c.square).join(' ')}`,
    ].join('\n'));
    process.exitCode = d.problems.length ? 1 : 0;
  } else if (cmd === 'check') {
    const { site, file } = loadSite(val('--site'), { extraDirs: [example] });
    const { geo, lib, name } = await geometryFor(site.room);
    const r = checkSite(site, geo, lib);
    print({ file, ...r }, () => [`${site.name} (${file}) in ${site.room} ${name}: ${r.ok ? 'ok' : 'NOT OK'}`,
      ...r.problems.map(p => '  PROBLEM ' + p),
      ...r.rows.map(x => `  ${x.ok ? 'ok  ' : 'FAIL'} ${x.what.padEnd(26)} ${x.square.padEnd(8)}` +
        (x.threat != null ? ` threat ${x.threat} sees tip ${x.sees_tip}` : '') + (x.monster_grid_reaches ? ' [monster_grid reaches]' : '') + (x.why ? ` -- ${x.why}` : ''))].join('\n'));
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'status') {
    const { site } = loadSite(val('--site'), { extraDirs: [example] });
    const rows = readPresence(site.name);
    const a = allocate(site, rows);
    print({ allocation: a, rows }, () => [`${site.name}: mode ${a.mode}${a.money_losing ? ' (MONEY-LOSING)' : ''}${a.why ? ' -- ' + a.why : ''}`,
      `  striker ${a.striker ?? '-'}; puller ${a.puller ? `${a.puller.agent} from ${sq(a.puller.from)}` : '-'}`,
      ...a.archers.map(x => `  archer ${x.index + 1} ${sq(x.station)} ${x.agent}`),
      `  reserve ${a.reserve.join(' ') || '-'}; unfit ${a.unfit.map(u => `${u.agent} (${u.why})`).join(' ') || '-'}; stale ${a.stale.join(' ') || '-'}`].join('\n'));
  } else if (cmd === 'econ') {
    const { site } = loadSite(val('--site'), { extraDirs: [example] });
    const m = /^(\d+(?:\.\d+)?)([mhd])$/.exec(val('--since') ?? '2h');
    const sinceMs = m ? Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]] : 2 * 3600e3;
    const { readLedger } = await import('./m59-ledger.mjs');
    const { events, source } = readLedger({ sinceMs });
    const price = val('--arrow-price') != null ? Number(val('--arrow-price')) : site.econ.arrowPrice;
    const r = econReport(events, { site: site.name, arrowPrice: price, sinceMs });
    print({ source, ...r }, () => [`${site.name} over ${val('--since') ?? '2h'} (ledger ${source.dir}${source.exists ? '' : ' -- MISSING'})`,
      ...r.roles.map(x => `  ${x.role.padEnd(8)} ${x.agents.length} agents, ${x.duty_min} duty-min: ${x.kills} kills (${x.kills_30m ?? '-'}/30m),` +
        ` ${x.shots} shots (${x.arrows_30m ?? '-'} arrows/30m), ${x.shillings} sh (${x.shillings_30m ?? '-'}/30m)` +
        `, arrows bought ${x.arrows_bought_sh} sh (${x.arrows_bought_30m ?? '-'}/30m)` + (x.net_30m != null ? `, net ${x.net_30m}/30m at the price` : '')),
      `  total: ${r.total.duty_min} duty-min, ${r.total.kills} kills, ${r.total.shillings} sh looted, ${r.total.arrows_bought_sh} sh of arrows bought: net ${r.total.net_as_bought} as bought` +
        (r.total.net != null ? `, ${r.total.net} at the price` : ''),
      `  modes (duty-min): ${Object.entries(r.modes_min).map(([k, v]) => `${k} ${v.toFixed(1)}${k === 'archers_only' ? ' MONEY-LOSING' : ''}`).join(', ') || '-'}`,
      ...r.caveats.map(c => '  note: ' + c)].join('\n'));
  } else {
    console.log(usage);
    process.exitCode = cmd ? 2 : 0;
  }
}
