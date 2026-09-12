// CUT A RAIL FROM WHERE THE BODY IS, NOW — because a rail is only valid from where it was cut.
//
// A pre-baked rail is a path found by a flood seeded somewhere. Walk a body along it and the body
// drifts: the mover slides, a fan takes a wide heading, a step lands short. Once it is off the
// line, the line is no longer a path it can follow — the question "how do I get from HERE to the
// goal" has a different answer than it had at the seed, and boarding back to the old line assumes
// the old answer still applies.
//
// MEASURED, room 49, 2026-09-12. Marco drifted 240 units from the seed the rail was cut at. From
// the seed, a step due SOUTH is accepted and the rail's first legs use it. From where he actually
// stood, due south is REFUSED — offline and live, which agree exactly:
//
//     S     offline refuse   live: arrived=true, body moved 0u
//     SE    offline ACCEPT   live: body moved 64u
//     SW    offline ACCEPT   live: body moved 128u
//
// So the rail was valid and he was not on it, and sixteen legs of correct boarding-and-following
// produced no along-track progress at all: 4832 -> 4686 units to go, no trend, never leaving the
// square. Re-cutting from his position is the fix, and it is cheap — a 64-unit flood over one room
// is 15k-165k points and takes a couple of seconds, which is nothing against a leg that takes six.
//
// THE LATTICE PHASE TRAP, WRITTEN DOWN BECAUSE IT COST AN HOUR. A flood stepping 64 units from
// x = 17648 (48 mod 64) can never land on a goal at x ≡ 0 mod 64: the two grids are offset for
// ever. The first cut of this reported "goal NOT reached" after 165,104 points, which reads exactly
// like "the exit is unreachable from here" and would have been filed as a fact about the world.
// So: snap the seed, snap the goal, and PREPEND the body's raw position so the first leg bridges
// the snap. `snap` is not a detail, it is the difference between a path and a false negative.
import { MAX_STEP_HEIGHT } from './m59-roo.mjs';

export const LATTICE = 64;

/** Nearest lattice point. A body is never on the lattice; a flood only visits lattice points. */
export const snap = (v, lattice = LATTICE) => Math.round(v / lattice) * lattice;

/**
 * Flood a room from `seed` and return the parent map, using the caller's own edge test.
 *
 * `edge(a, b)` is the mover's trace, passed in rather than imported, so this module has no opinion
 * about what walking means and cannot drift from whatever the mover actually enforces.
 */
export function flood(seed, { edge, bounds, lattice = LATTICE, stopAt = null, cap = 400_000 }) {
  const key = (x, y) => `${x},${y}`;
  const parent = new Map([[key(seed.x, seed.y), null]]);
  const q = [seed];
  const stopKey = stopAt ? key(stopAt.x, stopAt.y) : null;
  const dirs = [[lattice, 0], [-lattice, 0], [0, lattice], [0, -lattice],
                [lattice, lattice], [lattice, -lattice], [-lattice, lattice], [-lattice, -lattice]];
  let head = 0;
  while (head < q.length && parent.size < cap) {
    const p = q[head++];
    if (stopKey && key(p.x, p.y) === stopKey) break;
    for (const [dx, dy] of dirs) {
      const nx = p.x + dx, ny = p.y + dy;
      if (nx < 0 || ny < 0 || nx >= bounds.w || ny >= bounds.h) continue;
      const k = key(nx, ny);
      if (parent.has(k)) continue;
      if (!edge(p, { x: nx, y: ny })) continue;
      parent.set(k, { x: p.x, y: p.y });
      q.push({ x: nx, y: ny });
    }
  }
  return parent;
}

/** Walk a flood's parent chain back from `goal`, seed first. Null when the goal was not reached. */
export function chainTo(parent, goal) {
  const key = (x, y) => `${x},${y}`;
  if (!parent.has(key(goal.x, goal.y))) return null;
  const out = [];
  let cur = { x: goal.x, y: goal.y };
  while (cur) { out.push(cur); cur = parent.get(key(cur.x, cur.y)); }
  return out.reverse();
}

/**
 * A rail from `body` to `goal`, in client units, every leg being one lattice step the flood's own
 * edge test accepted.
 *
 * DELIBERATELY NOT DECIMATED. Decimating on direction change replaces validated lattice steps with
 * long straight lines that nothing checked the same way — two of twelve such legs refused when
 * stepped, and the original hand-cut rails were all built and "verified" this way, with ONE trace
 * across spans up to 24,320 units. That is a claim about an endpoint, not about a path.
 */
export function cutRail(body, goal, { edge, bounds, floorAt, lattice = LATTICE } = {}) {
  const seed = { x: snap(body.x, lattice), y: snap(body.y, lattice) };
  const target = { x: snap(goal.x, lattice), y: snap(goal.y, lattice) };
  const bridge = Math.hypot(seed.x - body.x, seed.y - body.y);
  // The bridge must itself be walkable, or the rail starts with a step the body cannot take.
  const bridgeOk = bridge === 0 || edge(body, seed);
  const parent = flood(seed, { edge, bounds, lattice, stopAt: target });
  const chain = chainTo(parent, target);
  if (!chain) return { ok: false, why: 'the flood did not reach the goal', visited: parent.size,
                       seed, target, bridge, bridgeOk };
  const points = (bridge === 0 ? chain : [{ x: body.x, y: body.y }, ...chain]);
  const waypoints = points.map(p => ({ x: p.x, y: p.y, f: floorAt ? floorAt(p.x, p.y) : null }));
  return { ok: true, waypoints, visited: parent.size, seed, target, bridge, bridgeOk,
           legs: waypoints.length - 1 };
}

/**
 * THE FURTHEST WAYPOINT WHOSE STRAIGHT CHORD FROM HERE IS ACTUALLY WALKABLE.
 *
 * A walker sent to an aim point travels in a STRAIGHT LINE. The rail is a sequence of validated
 * lattice steps, which says nothing about whether the chord across several of them is walkable — and
 * on real ground it usually is not. So `maxDeviation` heuristics are guessing at a question the
 * geometry can simply be asked.
 *
 * MEASURED, and this is why it matters. Seven legs on room 49's rail, aims bounded by a 256-unit
 * chord-deviation heuristic: 29,497 client units travelled for 4,607 net — EIGHTY-FOUR PER CENT
 * wasted — 136 revisited points, and a mean of 0.86 of every step SLIDING. move.c slides along the
 * first blocker rather than refusing, so a slid step is the body scraping a wall. The lattice path
 * was legal at every step and the chords across it were not.
 *
 * Asking costs one trace per candidate and the candidates are few, against a leg that costs six
 * seconds and can waste 84% of its travel.
 *
 * Binary search would be wrong here: walkability along a rail is not monotonic — a chord to
 * waypoint 20 can be clear while the chord to 12 is blocked — so this walks outward and keeps the
 * last CONTIGUOUSLY reachable one, which is the only claim it can honestly make.
 */
/**
 * IS THIS STRAIGHT LINE WALKABLE — asked by STEPPING it, because one long call is not an answer.
 *
 * MEASURED 2026-09-12, and it invalidated the first version of `furthestTraceable` entirely. From
 * (17584,23296) in room 49, a 3300-unit chord to the south-east:
 *
 *     whole-line traceFineMoveClient(from, to)   ACCEPT
 *     the same line stepped in 64-unit pieces    1 of 51 accepted, refused at piece 2
 *
 * So a single trace over a long span does not examine the middle, and every "traceable chord" the
 * first version claimed was vacuous — which is exactly why the mover could not walk chords this
 * tool had approved. The mover steps; so must the check.
 *
 * The cost is one trace per lattice-length piece, microseconds each, against a leg that takes six
 * seconds and can waste 84% of its travel.
 */
export function chordWalkable(a, b, { edge, lattice = LATTICE } = {}) {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d / lattice));
  for (let k = 1; k <= n; k++) {
    const p = { x: a.x + (b.x - a.x) * (k - 1) / n, y: a.y + (b.y - a.y) * (k - 1) / n };
    const q = { x: a.x + (b.x - a.x) * k / n,       y: a.y + (b.y - a.y) * k / n };
    if (!edge(p, q)) return { ok: false, refusedAt: k, of: n, distance: Math.round(d) };
  }
  return { ok: true, of: n, distance: Math.round(d) };
}

export function furthestTraceable(waypoints, body, { edge, fromIndex = 0, maxAhead = 64,
                                                     budget = Infinity, lattice = LATTICE } = {}) {
  if (!Array.isArray(waypoints) || waypoints.length === 0 || typeof edge !== 'function') return null;
  const last = waypoints.length - 1;
  const start = Math.max(0, Math.min(fromIndex, last));
  let best = null;
  for (let i = start + 1; i <= Math.min(last, start + maxAhead); i++) {
    const w = waypoints[i];
    const d = Math.hypot(w.x - body.x, w.y - body.y);
    if (d > budget) break;
    // STEPPED, not a single call over the whole chord — see chordWalkable.
    if (!chordWalkable(body, w, { edge, lattice }).ok) break;   // contiguity: stop at the first gap
    best = { i, x: w.x, y: w.y, f: w.f, dist: Math.round(d), spanned: i - start };
  }
  // Nothing ahead is chord-reachable. The next waypoint is one validated lattice step, so it is the
  // honest fallback — and saying WHY matters, because "the chord to the next waypoint is blocked"
  // is a much stronger statement than "the leg was short".
  if (!best) {
    const i = Math.min(start + 1, last);
    const w = waypoints[i];
    return { i, x: w.x, y: w.y, f: w.f, spanned: i - start,
             dist: Math.round(Math.hypot(w.x - body.x, w.y - body.y)),
             fallback: true,
             why: 'no chord from here to any waypoint ahead is walkable; aiming one lattice step' };
  }
  return best;
}

/**
 * Verify a rail AT THE GRANULARITY THE FLOOD USED, never finer.
 *
 * A leg that IS one lattice step was already validated by the flood. Splitting it into two 45-unit
 * pieces asks a different question and gets a different answer, because the trace tests endpoints:
 * a half-step can be refused while the whole step is accepted. Two such "refusals" were that
 * artifact and read exactly like a broken rail.
 */
export function verifyRail(waypoints, { edge, lattice = LATTICE } = {}) {
  const oneStep = Math.ceil(Math.hypot(lattice, lattice));      // 91 for a 64 lattice
  const bad = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d <= oneStep) { if (!edge(a, b)) bad.push({ i, d, why: 'one lattice step refused' }); continue; }
    const n = Math.ceil(d / lattice);
    for (let k = 1; k <= n; k++) {
      const p1 = { x: a.x + (b.x - a.x) * (k - 1) / n, y: a.y + (b.y - a.y) * (k - 1) / n };
      const p2 = { x: a.x + (b.x - a.x) * k / n,       y: a.y + (b.y - a.y) * k / n };
      if (!edge(p1, p2)) { bad.push({ i, d, piece: k, of: n, why: 'long leg refused when stepped' }); break; }
    }
  }
  return { ok: bad.length === 0, bad, legs: Math.max(0, waypoints.length - 1) };
}

export { MAX_STEP_HEIGHT };
