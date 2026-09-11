// LOCALISING ON A RAIL IS A THREE-DIMENSIONAL QUESTION, AND DOING IT IN TWO IS A FALSE ARRIVAL.
//
// A rail is a list of fine waypoints `{x, y, f}` in CLIENT units — f is the floor the line runs
// on. A follower drives it by asking "which waypoint am I nearest, and what is the next one",
// and the obvious answer, `hypot(dx, dy)`, is wrong everywhere the world is interesting.
//
// THE MEASUREMENT. Room 49 (Kardde's Canyon), square r25c17, which holds FOUR floors — 3840,
// 6016, 6144 and 6400 — with the canyon rail crossing it at 6016:
//
//     square centre reads             6016     so a centre-based fix says "on the rail"
//     body actually standing on       3840     the canyon floor, 2176 below the line
//     2D nearest waypoint            #152      floor 6400, 304 units away  <- 2560 ABOVE the body
//     floor-aware nearest waypoint     #0      floor 3840, 7031 units away
//
// The 2D rule picks a waypoint on a shelf the body cannot step onto, calls it 304 units away,
// and drives on — which is how a follower rode 163 canyon waypoints with zero refusals and put
// the body at r16c15 instead of the exit at r27c20. The floor-aware answer is unflattering and
// true: the body has come off the line, and the only point on its own shelf is the start.
//
// This is the same sentence as the repo's `walk_to` defect ("reaches the right square and the
// wrong shelf inside it") and the same sentence as the routing rule that a square is a summary
// and on a ledge a false one. A follower that cannot tell two shelves apart cannot tell
// arrival from falling.
//
// WHAT THIS IS NOT. It does not decide whether a step is legal — `walkFine`'s `holdShelf` does
// that, anchored on the destination's floor, and it is the thing that stops a body leaving the
// line in the first place. This decides only WHERE ON THE LINE a body is, which is the question
// asked once per leg and answered wrong for free.
import { MAX_STEP_HEIGHT } from './m59-roo.mjs';

/** A waypoint is off-shelf when no single step could reach the body's floor from it. */
export const onSameShelf = (waypointFloor, bodyFloor, step = MAX_STEP_HEIGHT) =>
  waypointFloor == null || bodyFloor == null || Math.abs(waypointFloor - bodyFloor) <= step;

// Pushed to the back rather than excluded, so a follower whose floor read failed — or which
// genuinely is off every shelf — still has somewhere to aim instead of stalling with no answer.
export const OFF_SHELF_PENALTY = 1e6;

/**
 * Which waypoint is a body at `point` nearest, judged on the shelf it is standing on?
 *
 * `floor` is the body's own floor in client units; pass `null` when it cannot be read and the
 * result degrades to the 2D answer, reporting `floorKnown: false` so a caller can say so rather
 * than believing a guard that did not run.
 */
export function nearestWaypoint(waypoints, point, {
  floor = null, step = MAX_STEP_HEIGHT, railRoom = null, bodyRoom = null,
} = {}) {
  // A POSITION IN ANOTHER ROOM IS NOT A POSITION ON THIS LINE AT ALL.
  //
  // Measured 2026-09-11: Marco died in the Badlands, the server put him in the Underworld
  // (room 1), and the follower drove on for SIX MINUTES — asking room 45's geometry for the
  // floor under a body in room 1, getting numbers, and steering by them. `r24c10 … floor 3840
  // … room 1 … aiming wp 256`. Nothing errored. The stall detector eventually stopped it,
  // which is the wrong guard catching the right problem far too late.
  //
  // Coordinates are only meaningful inside the room they were measured in, so this refuses to
  // answer rather than answering about the wrong room — the caller has to stop, and a follower
  // that cannot tell "off the line" from "not in the building" will always mistake one for the
  // other.
  if (railRoom != null && bodyRoom != null && railRoom !== bodyRoom)
    return { i: -1, d: Infinity, onShelf: false, floorKnown: false,
             wrongRoom: true, railRoom, bodyRoom };
  if (!Array.isArray(waypoints) || !waypoints.length)
    return { i: -1, d: Infinity, onShelf: false, floorKnown: floor != null, empty: true };
  let i = -1, best = Infinity, onShelf = false;
  for (let k = 0; k < waypoints.length; k++) {
    const w = waypoints[k];
    const flat = Math.hypot(w.x - point.x, w.y - point.y);
    const same = onSameShelf(w.f, floor, step);
    const d = same ? flat : flat + OFF_SHELF_PENALTY;
    if (d < best) { best = d; i = k; onShelf = same; }
  }
  return { i, d: best >= OFF_SHELF_PENALTY ? best - OFF_SHELF_PENALTY : best,
           onShelf, floorKnown: floor != null };
}

/**
 * Did a leg actually advance along the line? A follower that counts "nearer in two dimensions"
 * as progress will happily walk the length of a valley underneath its own route.
 */
export function advanced(fromIndex, toIndex, { onShelf = true } = {}) {
  if (!onShelf) return false;
  return Number.isFinite(fromIndex) && Number.isFinite(toIndex) && toIndex > fromIndex;
}

/**
 * Perpendicular distance from a point to the segment a-b, in the same units.
 * A rail is segments, not dots; a body can sit exactly ON a line and be nowhere near a vertex.
 */
export function distanceToSegment(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/**
 * HOW FAR IS THIS BODY FROM THIS LINE — the question to ask when CHOOSING between rails.
 *
 * `nearestWaypoint` answers a different question, and using it to pick a rail is biased by
 * SAMPLING DENSITY. Measured 2026-09-11: room 49 has two rails across it, a 163-waypoint climb
 * from the canyon floor and a 6-waypoint walk along the rim. Marco stood at r22c21 on the 6144
 * rim — exactly on the rim rail's long leg from r2c21 to r26c21 — and the chooser sent him to
 * the climb rail every time, because 163 dense vertices always produce a nearer vertex than 6
 * sparse ones. He then oscillated between four squares five rows short of the exit, aiming at a
 * waypoint 2858 units away, and the run was scored as a stall.
 *
 * A 6-waypoint rail is 5 long segments. Judge it by those.
 */
export function distanceToRail(waypoints, point, { floor = null, step = MAX_STEP_HEIGHT } = {}) {
  if (!Array.isArray(waypoints) || waypoints.length === 0)
    return { d: Infinity, empty: true, onShelf: false };
  if (waypoints.length === 1) {
    const w = waypoints[0];
    return { d: Math.hypot(w.x - point.x, w.y - point.y), i: 0,
             onShelf: onSameShelf(w.f, floor, step) };
  }
  let best = Infinity, bestI = -1, bestOn = false;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    // A segment is walkable only if BOTH ends are on the body's shelf — half a segment on
    // another shelf is the ledge case, and riding it is the fall this module exists to stop.
    const on = onSameShelf(a.f, floor, step) && onSameShelf(b.f, floor, step);
    const d = distanceToSegment(point, a, b) + (on ? 0 : OFF_SHELF_PENALTY);
    if (d < best) { best = d; bestI = i; bestOn = on; }
  }
  return { d: best >= OFF_SHELF_PENALTY ? best - OFF_SHELF_PENALTY : best,
           i: bestI, onShelf: bestOn, floorKnown: floor != null };
}

/** How far along the line to aim in one leg, in client units. Three squares. */
export const AIM_BUDGET = 3 * 1024;

/**
 * WHICH WAYPOINT TO AIM AT, MEASURED IN DISTANCE RATHER THAN IN WAYPOINTS.
 *
 * A follower strides "every Nth waypoint", which is a sensible unit on a 650-waypoint rail whose
 * legs are 64 units apart and meaningless on a 6-waypoint rail whose legs are 24,000. Measured
 * 2026-09-11: on room 49's rim rail, stride 12 of 6 waypoints resolves to the LAST one, so a body
 * at r22c21 aimed at r27c20 — cutting the corner diagonally off the rim — instead of at r26c21,
 * straight south along the column it was standing on. Seven legs, zero refusals, one column of
 * movement, and the run scored as a stall.
 *
 * So: walk forward accumulating segment lengths and stop at the budget. Always at least one
 * waypoint ahead, because aiming at the one you are already standing on is a no-op that reads as
 * a refusal.
 */
export function aimAhead(waypoints, fromIndex, { budget = AIM_BUDGET } = {}) {
  if (!Array.isArray(waypoints) || waypoints.length === 0) return { i: -1, dist: 0 };
  const last = waypoints.length - 1;
  const from = Math.max(0, Math.min(Number(fromIndex) || 0, last));
  if (from >= last) return { i: last, dist: 0, atEnd: true };
  let i = from, acc = 0;
  while (i < last) {
    const a = waypoints[i], b = waypoints[i + 1];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    // Take the first segment unconditionally — one waypoint ahead is the floor — then keep
    // going only while the budget still covers the next one.
    if (i > from && acc + seg > budget) break;
    acc += seg; i++;
  }
  return { i, dist: acc, spanned: i - from, atEnd: i >= last };
}

/** Default gap, in waypoints, that separates rejoining the line from wobbling on it. */
export const REJOIN_BEHIND = 20;

/**
 * A HIGH-WATER MARK IS NOT A PROGRESS MEASURE ON GROUND YOU CAN FALL OFF.
 *
 * A follower judges progress by "did my waypoint index beat the furthest I have reached", which
 * is right on a line you stay on and wrong the moment you leave it. Measured 2026-09-11: Marco
 * localised at waypoint 137 on room 49's 6144 rim, left the shelf, landed on the canyon floor,
 * honestly re-joined the line at waypoint 3, then climbed 3 -> 15 -> 27 -> 39 -> 51 with every
 * leg 0 units off the line — and the stall detector stopped him at the seventh leg for "no
 * progress past waypoint 137". Climbing from the bottom can never beat a mark set at the top, so
 * a run that was working was aborted as stuck.
 *
 * Falling and rejoining lower down restarts the journey, so it restarts the measure. Bounded,
 * because a body that falls back to the same place for ever IS stuck and saying so is the whole
 * job of a stall detector.
 *
 * Returns whether the mark should be reset, so the caller can log it — a progress measure that
 * silently restarts itself is how a stall becomes invisible.
 */
export function rejoinedBehind(furthest, current, { behind = REJOIN_BEHIND, rejoins = 0,
                                                    maxRejoins = 3 } = {}) {
  if (!Number.isFinite(furthest) || !Number.isFinite(current)) return { reset: false };
  if (rejoins >= maxRejoins)
    return { reset: false, exhausted: true, behindBy: Math.max(0, furthest - current) };
  const behindBy = furthest - current;
  if (behindBy <= behind) return { reset: false, behindBy };
  return { reset: true, behindBy, from: furthest, to: current };
}
