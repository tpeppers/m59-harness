// CROSS A DANGEROUS ROOM FROM SAFE WALL TO SAFE WALL, AND DO THE THINKING WHILE STANDING ON ONE.
//
// Operator, 2026-09-24: "One way to do it would be to path the route plan 'from safe spot to safe
// spot', such that time spent pausing for re-pathing is done from safety. Anything you put in we
// probably want as generally available travel solutions, as we have lots of deaths in Ukgoth."
//
// THE PROBLEM, MEASURED. Ukgoth (599) is 71x66 squares, holds level-90 trolls and a level-120
// StoneTroll ("Guardian of Zjiria"), and has ~218 recorded prod deaths. A crossing was one long
// plan made at the door against monster positions that were stale a few seconds later, walked in
// one go, and REPLANNED WHEREVER IT HAPPENED TO BE STANDING when the walker was blocked, slid, or
// hit — in the open, with the keeper's event loop blocked for 1.6 to 5.2 seconds by the planning
// itself (see sheltersAlong and threatsHere). A troll does about a fifth of a fifty-health bar a
// swing, so a five-second think in the open is a death.
//
// THE MECHANISM THAT MAKES A WALL WORTH PLANNING FROM. A safe wall is a square no monster's
// line of sight can reach within its reach disc (`safeWalls`, attackers === 0), and
// tools/m59-wallproof.mjs measured the contract in play on 2026-09-20: 1,290 seconds on such
// squares, not swinging, with monsters in reach and moving — ZERO attacks. So a body standing on
// one can spend as long as it likes deciding, and the only time it is exposed is the walk
// between two of them.
//
// SO A CROSSING IS A CHAIN OF SHORT LEGS, EACH ENDING ON A WALL. This module is the pure half:
//
//   legFlood(geo, from, maxLeg)   a bounded forward flood on the mover's own step relation
//                                 (the same `neighbors({collision:true})` the router plans on,
//                                 falls and declared jumps included), cached per geometry
//   legWalls(geo)                 the candidate stops: `safeSpots` minus the rim (the outer ring
//                                 ejects you — StandardLeaveDir) and minus squares nothing can
//                                 step into (hasAnyFooting)
//   planSafeLegs(geo, from, goal) Dijkstra over {start, walls, goal}, every edge a leg of at most
//                                 `maxLeg` steps, priced by its steps, a fixed charge per leg, and
//                                 the steps spent inside a live threat's reach. It answers the
//                                 WHOLE chain so a caller can see it, and the caller walks only
//                                 the first leg before asking again from the wall it reached.
//
// WHAT IT IS NOT. It never makes a character WAIT. A stop on a wall is bounded to the planning
// (this function, budgeted by `deadlineMs`) — the executor moves again as soon as the answer is
// in. Resting on a wall is still the existing shelter policy's decision (`shelterPolicy.need` /
// `onArrive`), taken only when the character is hurt, exactly as the travel doctrine already
// says: "a trip is refuge to refuge, and a rest stop is skipped when it is not needed".
// And it never forbids the room: no chain, a chain much longer than the direct route, or a
// planning budget spent all answer `found: false` with a reason, and the caller walks the
// direct route it always walked. See docs/m59-routing.md, "Safe-spot legs".
import { safeSpots, hasAnyFooting } from './m59-safespots.mjs';

// WHICH ROOMS, BY DEFAULT. One room, on the evidence: Ukgoth is the room this fleet dies in
// most on the road (218 recorded prod deaths; five of twenty in the 2026-09-24 convoy), it is on
// the only walking road to Castle Victoria, and it is the single entry in fleetScript's
// KNOWN_TRAPS. The list is a policy knob (`safe_legs.rooms`, M59_SAFE_LEG_ROOMS) rather than a
// derivation from the ledger on purpose: a room joins when a crossing trial
// (tools/m59-crossingtrial.mjs) says legs beat the direct walk THERE, not because it has deaths —
// a room with deaths and no walls between its doors gains nothing and loses the planning time.
export const SAFE_LEG_ROOMS = Object.freeze([599]);

export const SAFE_LEG_DEFAULTS = Object.freeze({
  // The longest leg, in mover steps. About eight to ten seconds of walking at the fleet's pace
  // (MOVE_INTERVAL ~0.6-0.8s a step with slides), which is roughly one troll swing cycle's worth
  // of exposure, and long enough that a room with walls every dozen squares has a chain at all.
  maxLeg: 14,
  // What a stop costs, in steps. A leg is a turn, a plan and a confirmation read; without a
  // charge the planner would happily chain eleven walls one square apart.
  legCost: 3,
  // Each step inside a live threat's reach costs this many steps more. Large, because the
  // alternative to walking past a troll is almost always a few squares of walking round it.
  threatWeight: 6,
  // Chebyshev squares. A monster's reach is a disc of radius 2-3 (monster.kod:1682); one more
  // square is the step it takes to close while we pass.
  threatRadius: 4,
  // A chain may be this much longer than the direct route (plus `slack` steps) before the
  // direct route wins. Exposure is time, and a chain three times as long as the road is more
  // time in the room, however safe its stops are.
  maxDetour: 1.8,
  slack: 12,
  // THE PLANNING BUDGET, in wall-clock ms. The keeper's event loop is shared with its socket and
  // its survival clock, and the whole point is to stop blocking it: past this the planner
  // answers `deadline` and the caller walks directly.
  deadlineMs: 150,
  // How close to the exit square the last wall has to be to hand over to the exit walker. The
  // exit's stand-on square is often a doorway pocket the strict step relation cannot enter
  // (docs/m59-routing.md, "the mask may only ever prefer"), so reaching a NEIGHBOUR counts.
  goalRadius: 1,
  // How far either side of a baked track a leg may go, in squares. 4 is measured, not chosen:
  // in 599 at 2 the walked band holds too few walls for a 14-step leg (no chain), at 3 it chains
  // only with 18-step legs, and at 5 it readmits the r21c45 shortcut the walker cannot make.
  corridorRadius: 4,
});

const key = (r, c) => `${r},${c}`;
const cheb = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
const now = () => (globalThis.performance?.now?.() ?? Date.now());

// ------------------------------------------------------------------ the flood

// Cached per geometry object and per step mask, for the same reason the safe-spot description
// is (see describedWalls in m59-safespots.mjs): the step relation is static until a door swaps
// the mask. LRU-bounded because the start squares change as a body walks.
const FLOODS = new WeakMap();
const FLOOD_CAP = 512;

/**
 * Every square reachable from `from` in at most `maxLeg` mover steps, with the step count and
 * the square it was reached from. `{ dist: Map<"r,c", n>, prev: Map<"r,c", "r,c"> }`.
 *
 * Uses `geo.neighbors(r, c, { collision: true })` — the router's own step relation, falls and
 * declared jumps included — so a leg the planner offers is a leg `walkTo` can plan. Without a
 * step mask there is no collision view and the flood falls back to the coarse grid, exactly as
 * `path()` does.
 */
export function legFlood(geo, from, maxLeg = SAFE_LEG_DEFAULTS.maxLeg, allow = null, also = null) {
  if (!geo || !from || typeof geo.neighbors !== 'function') return null;
  const r0 = Number(from.row), c0 = Number(from.col);
  if (!Number.isInteger(r0) || !Number.isInteger(c0)) return null;
  let byGeo = FLOODS.get(geo);
  const mask = geo._stepMask ?? null;
  if (!byGeo || byGeo.mask !== mask) { byGeo = { mask, map: new Map() }; FLOODS.set(geo, byGeo); }
  // A corridor is part of the question, so it is part of the key. Identified by the object:
  // a caller that builds one per crossing gets one cache line per crossing.
  const k = `${r0},${c0}|${maxLeg}|${allow ? corridorId(allow) + '|' + (also ? [...also][0] : '') : '-'}`;
  const hit = byGeo.map.get(k);
  if (hit) { byGeo.map.delete(k); byGeo.map.set(k, hit); return hit; }
  const dist = new Map([[key(r0, c0), 0]]);
  const prev = new Map();
  let frontier = [[r0, c0]];
  const collision = !!geo.hasStepMask;
  for (let d = 1; d <= maxLeg && frontier.length; d++) {
    const next = [];
    for (const [r, c] of frontier) {
      let ns = [];
      try { ns = geo.neighbors(r, c, { collision }) || []; } catch { ns = []; }
      for (const n of ns) {
        const nk = key(n.row, n.col);
        if (dist.has(nk)) continue;
        if (allow && !allow.has(nk) && !also?.has(nk)) continue;
        dist.set(nk, d);
        prev.set(nk, key(r, c));
        next.push([n.row, n.col]);
      }
    }
    frontier = next;
  }
  const out = { dist, prev };
  byGeo.map.set(k, out);
  if (byGeo.map.size > FLOOD_CAP) byGeo.map.delete(byGeo.map.keys().next().value);
  return out;
}

// The squares of the flood's path from its origin to `to`, origin excluded, in walking order.
export function floodPath(flood, to) {
  const out = [];
  let k = typeof to === 'string' ? to : key(to.row, to.col);
  for (let guard = 0; k && flood.prev.has(k) && guard < 4096; guard++) {
    const [r, c] = k.split(',').map(Number);
    out.push({ row: r, col: c });
    k = flood.prev.get(k);
  }
  return out.reverse();
}

const CORRIDOR_IDS = new WeakMap();
let corridorSeq = 0;
function corridorId(set) {
  if (!CORRIDOR_IDS.has(set)) CORRIDOR_IDS.set(set, `c${++corridorSeq}`);
  return CORRIDOR_IDS.get(set);
}

/**
 * THE GROUND SOMEBODY HAS ACTUALLY WALKED, AS A SET OF SQUARES.
 *
 * The router's step relation is a model, and in Ukgoth it is wrong in exactly the place the
 * crossing starts: the first live run of this planner chose legs from the 598 door straight down
 * the east side (r8c58 -> r20c52, r22c46, r21c45), which the router believes in and the walker
 * could not make — `no_ground_gained` eighteen times over six characters, a hundred seconds each,
 * while the track somebody walked goes along row 13. A baked track (m59-tracks.mjs) is that
 * evidence: its waypoints are fine points a body stood on, joined by straight runs it walked.
 *
 * So when a crossing has one, legs are planned INSIDE it: every square within `radius` of the
 * polyline, the walls in that band, and nothing else. `waypoints` are fine client points
 * {x, y} at 64 kod units a square (the track book's own unit); squares are 1-based.
 */
export function trackCorridor(waypoints, { radius = 2, rows = Infinity, cols = Infinity, fine = 64 } = {}) {
  const out = new Set();
  if (!Array.isArray(waypoints) || waypoints.length < 1) return out;
  const sq = wp => ({ row: Math.floor(Number(wp.y) / fine) + 1, col: Math.floor(Number(wp.x) / fine) + 1 });
  const mark = (r, c) => {
    for (let dr = -radius; dr <= radius; dr++)
      for (let dc = -radius; dc <= radius; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 1 && cc >= 1 && rr <= rows && cc <= cols) out.add(key(rr, cc));
      }
  };
  let prev = sq(waypoints[0]);
  mark(prev.row, prev.col);
  for (let i = 1; i < waypoints.length; i++) {
    const cur = sq(waypoints[i]);
    const n = Math.max(Math.abs(cur.row - prev.row), Math.abs(cur.col - prev.col));
    for (let k = 1; k <= n; k++)
      mark(Math.round(prev.row + (cur.row - prev.row) * k / n), Math.round(prev.col + (cur.col - prev.col) * k / n));
    prev = cur;
  }
  return out;
}

// ------------------------------------------------------------------ the walls

/**
 * The squares a leg may end on. Membership is `safeSpots` — the red squares, attackers === 0 —
 * narrowed only by two facts that make a square useless as a STOP rather than as a wall:
 *
 *   the rim     the outermost ring of a room ejects a body through StandardLeaveDir, so a leg
 *               ending there can leave the room by accident;
 *   no footing  a square with nowhere adjacent to stand cannot be stepped into (hasAnyFooting).
 *
 * `occupied` ("r,c" set) drops squares a body is standing on right now, and `unreachable`
 * ("r,c" set) drops squares this crossing has already failed to walk to.
 */
export function legWalls(geo, { occupied = null, unreachable = null } = {}) {
  if (!geo) return [];
  let all = [];
  try { all = safeSpots(geo, { limit: Infinity }); } catch { all = []; }
  return all.filter(s => !s.rim
    && hasAnyFooting(geo, s.row, s.col)
    && !occupied?.has?.(key(s.row, s.col))
    && !unreachable?.has?.(key(s.row, s.col)));
}

// How many of a path's squares sit inside some threat's reach. `threats` are {row, col}.
export function exposure(path, threats, radius = SAFE_LEG_DEFAULTS.threatRadius) {
  if (!threats?.length || !path?.length) return 0;
  let n = 0;
  for (const p of path)
    for (const t of threats)
      if (Number.isFinite(t?.row) && Number.isFinite(t?.col) && cheb(p, t) <= radius) { n++; break; }
  return n;
}

// ------------------------------------------------------------------ the plan

/**
 * The chain of legs from `from` to `goal`, or `{ found: false, reason }`.
 *
 * `goal` is the square the exit walker will take over from — the exit's stand-on square. The
 * last leg ends at `goal` itself or within `goalRadius` of it, and is `kind: 'exit'`; every leg
 * before it ends on a wall, `kind: 'wall'`. A caller walks `legs[0]` and asks again.
 *
 * Returned beside the chain, because a refusal has to be explainable from the record:
 *   direct_steps  the unbounded shortest step count from `from` to the goal (null: none)
 *   steps         the chain's total steps;  exposed  steps inside a threat's reach
 *   ms, walls, expanded   what the plan cost
 */
export function planSafeLegs(geo, from, goal, opts = {}) {
  const o = { ...SAFE_LEG_DEFAULTS, ...opts };
  const t0 = now();
  const out = (x) => ({ ...x, ms: Math.round((now() - t0) * 10) / 10 });
  if (!geo || !from || !goal) return out({ found: false, reason: 'no_geometry' });
  const start = { row: Number(from.row), col: Number(from.col) };
  const target = { row: Number(goal.row), col: Number(goal.col) };
  if (![start.row, start.col, target.row, target.col].every(Number.isInteger))
    return out({ found: false, reason: 'bad_square' });
  const threats = (o.threats ?? []).filter(t => Number.isFinite(t?.row) && Number.isFinite(t?.col));
  // IN A CORRIDOR, ONLY ITS OWN WALLS, AND ONLY ITS OWN GROUND. The start and the goal ring are
  // always allowed: a body placed a square off the band has to be able to step onto it, and the
  // exit's doorway pocket is the one place the band is allowed to be wrong about.
  const corridor = o.corridor instanceof Set && o.corridor.size ? o.corridor : null;
  // OCCUPIED IS A FACT ABOUT THE NEXT STOP, NOT ABOUT THE CHAIN. A convoy walks one chain, so
  // the walls ahead are routinely standing-room for the character in front — and dropping them
  // from the graph left the second character with no chain at all (live, 2026-09-24: `no_chain`
  // from r17c30 with r23c39 held by a fleet-mate). A held wall may be a later stop, because it
  // will have been left by the time we get there; it may not be the FIRST, which is walked now.
  const occupied = o.occupied instanceof Set && o.occupied.size ? o.occupied : null;
  let walls = o.walls ?? legWalls(geo, { unreachable: o.unreachable });
  if (corridor) walls = walls.filter(w => corridor.has(key(w.row, w.col)));
  const wallKeys = new Map(walls.map(w => [key(w.row, w.col), w]));
  const goalKeys = new Set();
  for (let dr = -o.goalRadius; dr <= o.goalRadius; dr++)
    for (let dc = -o.goalRadius; dc <= o.goalRadius; dc++)
      goalKeys.add(key(target.row + dr, target.col + dc));
  // Dijkstra over stops. `best` is the cheapest known cost to a stop, `via` how it was reached.
  const startKey = key(start.row, start.col);
  const best = new Map([[startKey, 0]]);
  const via = new Map();
  const done = new Set();
  const open = [{ k: startKey, row: start.row, col: start.col, cost: 0 }];
  let expanded = 0, goalHit = null;
  while (open.length) {
    if (now() - t0 > o.deadlineMs) return out({ found: false, reason: 'deadline', expanded, walls: walls.length });
    // The open list is small (a few hundred stops at most), so a linear min is cheaper than a heap.
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].cost < open[bi].cost) bi = i;
    const u = open.splice(bi, 1)[0];
    if (done.has(u.k)) continue;
    done.add(u.k);
    if (u.k === '#goal') { goalHit = u; break; }
    expanded++;
    const flood = legFlood(geo, u, o.maxLeg, corridor, corridor ? goalKeys : null);
    if (!flood) continue;
    // To the goal, directly from here: the nearest goal-ring square the flood reached.
    let gBest = null;
    for (const gk of goalKeys) {
      const d = flood.dist.get(gk);
      if (d == null) continue;
      // The exit square itself beats a neighbour at the same count.
      const score = d + (gk === key(target.row, target.col) ? 0 : 0.5);
      if (!gBest || score < gBest.score) gBest = { gk, d, score };
    }
    if (gBest) {
      const path = floodPath(flood, gBest.gk);
      const cost = u.cost + gBest.d + o.threatWeight * exposure(path, threats, o.threatRadius);
      if (cost < (best.get('#goal') ?? Infinity)) {
        best.set('#goal', cost);
        via.set('#goal', { from: u.k, to: gBest.gk, steps: gBest.d, path });
        open.push({ k: '#goal', row: target.row, col: target.col, cost });
      }
    }
    // To every wall this leg can reach.
    for (const [wk, d] of flood.dist) {
      if (d === 0 || done.has(wk) || !wallKeys.has(wk)) continue;
      if (occupied && u.k === startKey && occupied.has(wk)) continue;
      const path = floodPath(flood, wk);
      const cost = u.cost + d + o.legCost + o.threatWeight * exposure(path, threats, o.threatRadius);
      if (cost >= (best.get(wk) ?? Infinity)) continue;
      best.set(wk, cost);
      via.set(wk, { from: u.k, to: wk, steps: d, path });
      const w = wallKeys.get(wk);
      open.push({ k: wk, row: w.row, col: w.col, cost });
    }
  }
  if (!goalHit) return out({ found: false, reason: 'no_chain', expanded, walls: walls.length });

  // Walk the chain back from the goal.
  const legs = [];
  for (let k = '#goal', guard = 0; k !== startKey && guard < 512; guard++) {
    const v = via.get(k);
    if (!v) return out({ found: false, reason: 'broken_chain', expanded, walls: walls.length });
    const [r, c] = v.to.split(',').map(Number);
    legs.push({ row: r, col: c, kind: k === '#goal' ? 'exit' : 'wall', steps: v.steps,
                exposed: exposure(v.path, threats, o.threatRadius) });
    k = v.from;
  }
  legs.reverse();
  const steps = legs.reduce((a, l) => a + l.steps, 0);
  const exposed = legs.reduce((a, l) => a + l.exposed, 0);
  const direct = directSteps(geo, start, target, goalKeys, o);
  const plan = { legs, steps, exposed, direct_steps: direct, expanded, walls: walls.length };
  // A CHAIN MUCH LONGER THAN THE ROAD IS MORE TIME IN THE ROOM, however safe its stops are.
  if (direct != null && steps > direct * o.maxDetour + o.slack)
    return out({ found: false, reason: 'detour', ...plan });
  return out({ found: true, ...plan });
}

// The plain shortest step count to the goal ring, unbounded — the yardstick for `maxDetour`.
// A breadth-first flood of the same relation, stopped at the first goal-ring square.
function directSteps(geo, start, target, goalKeys, o) {
  const seen = new Set([key(start.row, start.col)]);
  let frontier = [[start.row, start.col]];
  const collision = !!geo.hasStepMask;
  for (let d = 0; frontier.length && d < 4096; d++) {
    for (const [r, c] of frontier) if (goalKeys.has(key(r, c))) return d;
    if (now() > (o._directDeadline ?? Infinity)) return null;
    const next = [];
    for (const [r, c] of frontier) {
      let ns = [];
      try { ns = geo.neighbors(r, c, { collision }) || []; } catch { ns = []; }
      for (const n of ns) {
        const nk = key(n.row, n.col);
        if (seen.has(nk)) continue;
        seen.add(nk);
        next.push([n.row, n.col]);
      }
    }
    frontier = next;
  }
  return null;
}

// ------------------------------------------------------------------ the switch

/**
 * Is this room one to cross by legs, for this caller? `policy` is `{ rooms, off }` or a boolean;
 * `env` defaults to process.env. M59_SAFE_LEG_ROOMS="599,578" replaces the room list,
 * M59_SAFE_LEGS=0 turns the feature off. A policy `rooms` list outranks both; `off: true` or
 * `false` outranks everything.
 */
export function safeLegsFor(room, policy = null, env = globalThis.process?.env ?? {}) {
  const num = Number(room);
  if (!Number.isFinite(num)) return false;
  if (policy === false || policy?.off === true) return false;
  if (env.M59_SAFE_LEGS === '0') return false;
  let rooms = SAFE_LEG_ROOMS;
  if (typeof env.M59_SAFE_LEG_ROOMS === 'string')
    rooms = env.M59_SAFE_LEG_ROOMS.split(',').map(s => Number(s.trim())).filter(Number.isFinite);
  if (Array.isArray(policy?.rooms)) rooms = policy.rooms.map(Number).filter(Number.isFinite);
  return rooms.includes(num);
}
