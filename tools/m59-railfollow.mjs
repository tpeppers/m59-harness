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
export function nearestWaypoint(waypoints, point, { floor = null, step = MAX_STEP_HEIGHT } = {}) {
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
