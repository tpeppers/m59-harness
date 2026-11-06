#!/usr/bin/env node
// CHASE ON FOOT: WALK TO A QUARRY AS IF TO STAND ON TOP OF IT. #movement
//
//   node tools/m59-chase.mjs census --room 27              how often "near" quarry is far on foot, offline
//   node tools/m59-chase.mjs plan --room 27 --from r35c45 --to r35c58
//
// THE OPERATOR, 2026-11-05, watching Scooter and Zoot farm the Icky Cave (27): they "frequently get stuck
// ... on the ledges/walls trying to fight targets on the other side of unpassable map.roo geometry. The bot
// should, once it has selected a target, *move as if it were trying to literally stand atop the target
// first* before engaging into combat with the target as soon as it gets into weapon range ... This can
// include needing to route around to find stairs up to get to somewhere that seems very close but requires
// walking relatively far away." And, of the fix: it should be universal, triggered by a geometry rejection
// on approach or by a check done in advance, and cheap.
//
// WHAT WAS WRONG, MEASURED. Every distance the farm pass used to choose and approach a quarry was a STRAIGHT
// LINE: findCreature sorts by it, the patrol engages within 8 squares of it, and fight() hands anything
// within 8 of it to walkToMeleeRange, whose fine body-detour searches a box of the two points widened by four
// squares for 100 ms. That box cannot contain the way round a ledge whose stairs are fifteen squares off.
// On the real map, pairs of standable squares at most 8 apart (this file's `census`):
//
//     room 27 Icky Cave         35.3% need a walk longer than straight+3; 29.0% leave the local box
//     room 2144 Trading Post     8.6% / 7.9%;   6.6% have no walk at all
//     room 2143 Deep in Jungle   5.3% / 3.7%
//
// e.g. r32c54 -> r32c57: three squares apart, 55 steps on foot. So in the cave a third of every quarry the
// patrol chose was one the approach could not reach; it reported `combat_approach_blocked`, the quarry was
// deferred for 30s, and when every quarry in reach was deferred the keeper stood "waiting" -- 17 stalls on
// prod 2026-11-05 at r35c48, the one-way step the operator named.
//
// THE FIX IS THE WALKER'S OWN PLANNER, ASKED ONE MORE QUESTION. `RoomGeometry.path` is A* over the baked step
// mask: `moverStepLands` is an array index, declared fall-jumps are edges, and it is exactly the plan
// `walkTo` will walk -- so a chase planned here can never disagree with the walk that executes it, which is
// the property a second planner would not have. It costs p50 0.02 ms, p99 ~3 ms on these rooms. Three uses:
//
//   1. ORDER quarry by walking distance, not straight distance (`orderByWalk`), so a spider six squares off
//      on our side outranks one two squares off below a cliff. Order only: a quarry with no plan is put LAST,
//      never dropped, because "no route" is a fact about the bake (docs/m59-routing.md) and the fine detour
//      can still find ground the mask does not model.
//   2. A PATROL engages what is near ON FOOT (`engageWalk`, m59-patrol-farm.mjs), so the loop meets the rest.
//   3. APPROACH by walking the plan toward the quarry's own square in bounded pieces (`chaseAim`), stopping
//      one step short -- you cannot stand on a body -- when the plan is a detour the local box cannot hold, or
//      when the local search found the quarry past its bounds (fight() in m59-skills.mjs), and for every quarry past
//      the local range (closeOnQuarry).
//
// Silence is the behaviour that was already there: with no geometry, no step mask, or a goal the grid calls
// floorless, every helper answers `known: false` and the callers do exactly what they did before.
//
// PURE PLANNING, plus `chasePiece`, which walks a session it is handed through that session's own walkTo, and a
// read-only CLI. It opens no socket and touches no roster.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const CHASE_DEFAULTS = Object.freeze({
  // A* expansions per plan. Room 599 is the largest at 4,686 standable squares; a plan that needs more than
  // this is reported as far (`budget`), not impossible.
  maxNodes: 6000,
  // Walk steps beyond ceil(straight distance) before a plan counts as a DETOUR -- the case the local fine
  // approach cannot hold. Three, so a doorway or a corner costs nothing.
  detourSlack: 3,
  // Squares walked per chase piece before the keeper looks at the room again. The quarry moves; a piece
  // longer than this walks to where it was.
  pieceSteps: 12,
  // Time spent ordering one pass's quarry. Past it the rest keep their straight-line order.
  budgetMs: 20,
  // Quarry planned per pass, nearest straight-line first.
  maxCandidates: 8,
  // A plan from one square to another is reused this long. Positions are squares, so a body standing still
  // and a quarry standing still are asked once.
  cacheMs: 4000,
});

const straightOf = (a, b) => Math.hypot(a.row - b.row, a.col - b.col);
const sq = p => `r${p.row}c${p.col}`;

/** Whether this geometry can answer at all: a planner and a baked step mask. Without the mask the coarse grid
 *  is the only opinion and it is not the mover's, so we stay silent rather than steer by it. */
export function chaseCapable(geo) {
  return !!geo && typeof geo.path === 'function' && geo.hasStepMask === true;
}

/**
 * The walk from `from` to stand on `to`, on the walker's own planner. Never throws.
 *   { known, found, length, straight, detour, budget, steps, reason }
 * `known: false` -- this geometry cannot say (no mask, goal off the floor, planner threw); caller keeps its
 * old behaviour. `found: false, known: true` -- no route the mover can walk (`budget: true` if the search ran
 * out rather than the room). `steps` excludes the start and ends ON `to`.
 */
export function walkPlan(geo, from, to, { maxNodes = CHASE_DEFAULTS.maxNodes,
                                          detourSlack = CHASE_DEFAULTS.detourSlack, extraCost = null } = {}) {
  const straight = from && to ? straightOf(from, to) : Infinity;
  const unknown = reason => ({ known: false, found: false, length: null, straight, detour: false, budget: false,
                               steps: null, reason });
  if (!chaseCapable(geo)) return unknown('no step mask');
  if (![from?.row, from?.col, to?.row, to?.col].every(Number.isInteger)) return unknown('no position');
  if (from.row === to.row && from.col === to.col)
    return { known: true, found: true, length: 0, straight: 0, detour: false, budget: false, steps: [], reason: null };
  let p;
  try { p = geo.path(from.row, from.col, to.row, to.col, { maxNodes, ...(extraCost ? { extraCost } : {}) }); }
  catch (e) { return unknown(`planner threw: ${e.message}`); }
  if (!p?.found) {
    // The grid calling the quarry's own square floorless says nothing about whether we can reach it -- a
    // body is standing there. That is the planner's blind spot, not a wall.
    if (/no floor|outside the room/.test(String(p?.reason ?? ''))) return unknown(p.reason);
    const budget = p?.reason === 'search budget exhausted';
    // A strict search that expanded only a handful of squares started in a POCKET: see POCKET_MAX.
    return { known: true, found: false, length: null, straight, detour: true, budget, steps: null,
             reason: p?.reason ?? 'no route', ...(!budget && Number(p?.expanded) <= POCKET_MAX ? { pocket: true } : {}) };
  }
  const length = p.steps.length;
  return { known: true, found: true, length, straight, detour: length > Math.ceil(straight) + detourSlack,
           budget: false, steps: p.steps, reason: null, ...(p.goal_exempt ? { goal_exempt: true } : {}) };
}

// A STRICT SEARCH THAT EXPANDED THIS FEW SQUARES STARTED IN A POCKET, and the plan says so (`pocket: true`) rather
// than pretending to a way out. Measured 2026-11-05: r35c48 in the Icky Cave is the bottom of the row-35 trench
// (floor 0 against 1152 east of it, a climb three times MAX_STEP_HEIGHT -- the operator's "only east-to-west"), and
// `path` from there expands five squares. A way out exists only through the goal exemption (a step the mover
// refuses, allowed as the last step of a walk), and walking it in the socketless harness burned a 900-packet
// budget: the fine collision really does refuse it. So no escape is planned here. A body in a pocket keeps the old
// behaviour, and the pocket is a missing affordance in substrate/m59-falljumps.json for the bake to name.
const POCKET_MAX = 16;

/**
 * Where to walk this piece: up to `pieceSteps` along the plan, and never onto the quarry's own square (the
 * last step). Null when the plan is one step or less -- we are already beside it on foot.
 *   { row, col, index, remaining }   `remaining` = plan steps still between the aim and the quarry
 */
export function chaseAim(plan, { pieceSteps = CHASE_DEFAULTS.pieceSteps } = {}) {
  if (!plan?.found || !Array.isArray(plan.steps) || plan.steps.length <= 1) return null;
  const last = plan.steps.length - 2;                       // the square before the quarry's
  const index = Math.max(0, Math.min(last, Math.max(1, pieceSteps) - 1));
  const s = plan.steps[index];
  return { row: s.row, col: s.col, index, remaining: plan.steps.length - 1 - index };
}

/**
 * A plan cache keyed by (room, from square, to square), so a pass that asks about the same pair twice -- the
 * order, then the patrol filter, then the approach -- plans once. Bounded and time-limited.
 */
export function chaseCache({ ttlMs = CHASE_DEFAULTS.cacheMs, max = 512 } = {}) {
  const m = new Map();
  return {
    get(key, now = Date.now()) { const v = m.get(key); if (!v) return null; if (now - v.at > ttlMs) { m.delete(key); return null; } return v.plan; },
    set(key, plan, now = Date.now()) {
      m.delete(key); m.set(key, { at: now, plan });
      while (m.size > max) m.delete(m.keys().next().value);
    },
    get size() { return m.size; },
  };
}

/** The cached plan from `self` to `foe` in `room`, planned on a miss. */
export function cachedWalk(cache, room, geo, self, foe, opts = {}) {
  const key = `${room}|${sq(self)}>${sq(foe)}`;
  const hit = cache?.get(key, opts.now);
  if (hit) return hit;
  const plan = walkPlan(geo, self, foe, opts);
  // Keep the summary only; the steps are re-planned when somebody walks them.
  const summary = { ...plan, steps: undefined, first: plan.steps?.[0] ?? null };
  cache?.set(key, summary, opts.now);
  return summary;
}

/**
 * ORDER quarry by how far they are ON FOOT. Pure over its inputs.
 *   candidates  room objects with { id, row, col }
 * Returns { ordered, walks: Map(id -> plan summary), planned, ms }.
 *
 * The nearest `maxCandidates` by straight line are planned, within `budgetMs`. The sort key is the walk
 * length when known and found; the straight distance when not planned (a lower bound, so an unplanned one is
 * never pushed behind a known detour it might beat); and LAST, by straight distance, when the planner says no
 * route or ran out of budget. Stable, so equal walks keep the incoming (straight-line) order -- which is what
 * rankQuarries already uses as its tie-break, so a room with no mask orders exactly as before.
 */
export function orderByWalk(candidates, geo, self, { room = null, cache = null, now = Date.now(),
  maxCandidates = CHASE_DEFAULTS.maxCandidates, budgetMs = CHASE_DEFAULTS.budgetMs,
  clock = () => performance.now(), ...opts } = {}) {
  const walks = new Map();
  if (!Array.isArray(candidates) || !candidates.length || !self || !chaseCapable(geo))
    return { ordered: candidates, walks, planned: 0, ms: 0 };
  const t0 = clock();
  const byStraight = candidates.map((o, i) => ({ o, i, d: straightOf(o, self) })).sort((a, b) => a.d - b.d || a.i - b.i);
  let planned = 0;
  for (const x of byStraight) {
    if (planned >= maxCandidates || clock() - t0 > budgetMs) break;
    if (![x.o.row, x.o.col].every(Number.isInteger)) continue;
    walks.set(x.o.id, cachedWalk(cache, room, geo, self, x.o, { ...opts, now }));
    planned++;
  }
  const key = x => {
    const w = walks.get(x.o.id);
    if (!w || !w.known) return [0, x.d];
    if (w.found) return [0, w.length];
    return [1, x.d];
  };
  const ordered = candidates.map((o, i) => ({ o, i, d: straightOf(o, self) }))
    .sort((a, b) => { const ka = key(a), kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1] || a.i - b.i; })
    .map(x => x.o);
  return { ordered, walks, planned, ms: +(clock() - t0).toFixed(2) };
}

/**
 * WALK ONE PIECE OF THE CHASE. The only function here that moves anything, and it moves only through the
 * session's own `walkTo` -- the same walker, door work, body detours and terminal-reason handling as every
 * other walk -- toward the square `chaseAim` picked. Never throws.
 *
 *   s           a Session (s.need(), s.world.geometry, s.walkTo)
 *   targetId    the quarry's object id, re-read here: a captured object carries a stale position
 *   plan        a walkPlan with steps, or null to plan now
 *
 * Returns { moved, arrived, steps, reason, in_reach, beside, unknown, no_route, chase: {...summary}, walk }.
 * `beside`: already one step from it on foot, nothing walked. `in_reach`: straight distance <= reach after
 * the piece -- the caller swings.
 */
export async function chasePiece(s, targetId, { reach = 2, plan = null, pieceSteps = CHASE_DEFAULTS.pieceSteps,
                                                movementGeneration, controlToken } = {}) {
  let c;
  try { c = s.need(); } catch (e) { return { moved: false, reason: e.message }; }
  const me = c.self, foe = c.room?.objects?.get?.(targetId), geo = s.world?.geometry;
  if (!foe) return { moved: false, reason: 'quarry_left_room' };
  if (!me || me.predicted) return { moved: false, reason: 'own_position_unknown' };
  plan ??= walkPlan(geo, me, foe);
  const chase = { straight: +plan.straight.toFixed(1), on_foot: plan.length, detour: plan.detour,
                  from: sq(me), to: sq(foe) };
  if (!plan.known) return { moved: false, unknown: true, reason: plan.reason, chase };
  if (!plan.found) return { moved: false, no_route: true, reason: plan.reason, chase };
  const aim = chaseAim(plan, { pieceSteps });
  const inReach = () => { const p = c.self, q = c.room?.objects?.get?.(targetId);
    return !!p && !p.predicted && !!q && Math.hypot(p.row - q.row, p.col - q.col) <= reach; };
  if (!aim) return { moved: false, beside: true, in_reach: inReach(), chase };
  chase.aim = sq(aim); chase.remaining = aim.remaining;
  let walk;
  try {
    walk = await s.walkTo(aim.col, aim.row, { maxSteps: aim.index + 1 + 8, movementGeneration, controlToken });
  } catch (e) { walk = { arrived: false, steps: 0, reason: e.message }; }
  const moved = (walk?.steps ?? 0) > 0 || walk?.arrived === true;
  return { moved, arrived: walk?.arrived === true, steps: walk?.steps ?? 0, reason: walk?.arrived ? null : (walk?.reason ?? null),
           in_reach: inReach(), chase, walk };
}

// ------------------------------------------------------------------------------------------------------------
// OFFLINE: the census that measured the problem, and one plan drawn out.

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const val = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const parse = s => { const m = /^r(\d+)c(\d+)$/i.exec(String(s ?? '')); if (!m) throw new Error(`"${s}" is not rNcM`); return { row: +m[1], col: +m[2] }; };
  const cmd = argv[0];
  if (!['census', 'plan'].includes(cmd) || !val('--room')) {
    console.log('usage: node tools/m59-chase.mjs census --room <n> [--pairs 1500] [--within 8]\n' +
                '       node tools/m59-chase.mjs plan --room <n> --from rNcM --to rNcM');
    process.exit(cmd ? 2 : 0);
  }
  const { loadMap } = await import('./m59-map.mjs');
  const { attachStepMasks } = await import('./m59-routes.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const map = loadMap(); attachStepMasks(map);
  const room = map.rooms[String(val('--room'))];
  if (!room) { console.error(`room ${val('--room')} is not in the map`); process.exit(2); }
  const geo = sharedRoomGeometry(room);
  if (cmd === 'plan') {
    const from = parse(val('--from')), to = parse(val('--to'));
    const p = walkPlan(geo, from, to);
    console.log(`${sq(from)} -> ${sq(to)}: straight ${p.straight.toFixed(1)}, ` +
      (p.found ? `on foot ${p.length} steps${p.detour ? ' (DETOUR)' : ''}` : `no walk: ${p.reason}${p.pocket ? ' (starts in a POCKET)' : ''}`));
    if (p.found) {
      console.log('  ' + p.steps.map(s => sq(s) + (s.fall ? '!' : '')).join(' '));
      const aim = chaseAim(p);
      if (aim) console.log(`  first piece aims at ${sq(aim)}, ${aim.remaining} steps short of the quarry`);
    }
  } else {
    const within = Number(val('--within') ?? 8), N = Number(val('--pairs') ?? 1500);
    const squares = [];
    for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) if (geo.standable(r, c)) squares.push({ row: r, col: c });
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const st = { pairs: 0, none: 0, direct: 0, detour: 0, outside: 0, ms: [] };
    while (st.pairs < N && squares.length > 1) {
      const a = squares[Math.floor(rnd() * squares.length)], b = squares[Math.floor(rnd() * squares.length)];
      const e = straightOf(a, b); if (e === 0 || e > within) continue;
      st.pairs++;
      const t0 = performance.now(), p = walkPlan(geo, a, b); st.ms.push(performance.now() - t0);
      if (!p.found) { st.none++; continue; }
      if (!p.detour) { st.direct++; continue; }
      st.detour++;
      const r0 = Math.min(a.row, b.row) - 4, r1 = Math.max(a.row, b.row) + 4, c0 = Math.min(a.col, b.col) - 4, c1 = Math.max(a.col, b.col) + 4;
      if (p.steps.some(s => s.row < r0 || s.row > r1 || s.col < c0 || s.col > c1)) st.outside++;
    }
    const q = f => { const s = [...st.ms].sort((x, y) => x - y); return (s[Math.min(s.length - 1, Math.floor(f * s.length))] ?? 0).toFixed(2); };
    const pc = n => (100 * n / Math.max(1, st.pairs)).toFixed(1) + '%';
    console.log(`room ${val('--room')}: ${squares.length} standable, mask ${geo.hasStepMask ? 'yes' : 'NO'}, ${st.pairs} pairs within ${within}`);
    console.log(`  direct ${pc(st.direct)}  detour ${pc(st.detour)} (leave the local box ${pc(st.outside)})  no walk ${pc(st.none)}`);
    console.log(`  plan ms p50 ${q(.5)} p90 ${q(.9)} p99 ${q(.99)}`);
  }
}
