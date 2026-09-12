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
 * A LEG MUST FINISH INSIDE THE CALLER'S TIMEOUT, AND THAT IS A DISTANCE BUDGET.
 *
 * `keeperAction` defaults to 60 seconds and a fine walk covers roughly 64 units a step at
 * roughly one step per `MOVE_DELAY`. A leg longer than the timeout can carry is not a slow leg —
 * it is an ABORTED one, and the abort is broker-side with no reason attached, so the caller sees
 * `arrived: undefined` and cannot tell it from a wall.
 *
 * Measured on prod 2026-09-11: 3072-unit legs aborted at 60, 63, 72, 61, 60 and 62 seconds with
 * the body never moving, while 768-unit legs on the same follower completed at 0 units off the
 * line. The broker there carries no raised allowance at all, so this is the ceiling to plan
 * inside rather than one to wait out.
 *
 * `safety` leaves room for a fan that has to feel its way round something; without it a leg
 * sized exactly to the timeout aborts the moment anything goes slightly wrong.
 */
export const OBSERVED_FINE_UNITS_PER_SECOND = 45;

export function budgetForTimeout(timeoutMs, { unitsPerSecond = OBSERVED_FINE_UNITS_PER_SECOND,
                                              safety = 0.4, floor = 64 } = {}) {
  // THE RATE IS MEASURED, NOT DERIVED, AND THE DERIVED FIGURE IS TWELVE TIMES TOO FAST.
  //
  // The arithmetic invites `MOVEUNITS / MOVE_DELAY` — 64 units per 100ms, 640 u/s — and the
  // first cut of this function used it, producing a 15,360-unit budget for a 60-second cap.
  // Its own test refused that immediately, because the thing being budgeted for is a 3,072-unit
  // leg that did NOT finish in sixty seconds. So the real end-to-end rate of a fine walk is
  // under 51 u/s: the per-step geometry, the heading fan, the pacer and the round trip all cost
  // more than the packet does. 45 u/s is the conservative figure taken from that pair — 3072
  // aborted at 60s, 768 completed — and it is a MEASUREMENT, so it should be re-taken rather
  // than reasoned about if the mover changes.
  const secs = Math.max(0, Number(timeoutMs) || 0) / 1000;
  return Math.max(floor, Math.floor(secs * unitsPerSecond * safety));
}

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

/**
 * WHERE TO AIM, AS A POINT ON THE LINE — because a waypoint can be further than one leg.
 *
 * `aimAhead` picks a WAYPOINT, and on a sparse rail the next waypoint may be 24,320 units away.
 * A fine walk covers roughly 64 units a step, so that leg needs about 380 steps and the caller
 * asks for 60. Measured 2026-09-11: Marco aimed from r22c21 at wp 3 (r26c21), 3,946 units off,
 * needing 62 steps against a `max_steps: 60`, and every leg came back `ran out of steps` — two
 * steps short, five times running, read as a refusal. Stepping the same line by hand accepted
 * all 62, so the ground was never the problem.
 *
 * A rail is a continuous line. Aim at a point on it, at most `budget` units along, and let the
 * waypoints be the shape of the line rather than the only places a body may aim.
 *
 * Returns the point, the segment it lies on, and `stepsNeeded` so a caller can size its own step
 * budget instead of guessing — the guess is what failed.
 */
/**
 * How far the walker's CHORD may stray from the rail's ARC before the aim must stop short.
 *
 * A walker sent to an aim point travels in a STRAIGHT LINE to it. On a winding rail that is not
 * the same journey as the rail, and the difference is exactly the ground the rail was avoiding.
 * Measured 2026-09-12: raising the budget to 5400 units — legal once the broker's fine-walk
 * ceiling moved to five minutes — made the aim land at the END of a 53-leg path that winds, so the
 * mover walked a chord straight across it and came back "ran out of steps".
 *
 * So the leg budget is bounded by TWO things and the timeout is only one of them: how far the
 * walker can travel, and how far the rail stays straight. This is the second.
 */
export const MAX_CHORD_DEVIATION = 256;

export function aimPoint(waypoints, point, { floor = null, budget = AIM_BUDGET,
                                             step = MAX_STEP_HEIGHT, unitsPerStep = 64,
                                             maxDeviation = MAX_CHORD_DEVIATION } = {}) {
  if (!Array.isArray(waypoints) || waypoints.length === 0) return null;
  if (waypoints.length === 1) {
    const w = waypoints[0];
    return { x: w.x, y: w.y, i: 0, dist: Math.hypot(w.x - point.x, w.y - point.y),
             atEnd: true, stepsNeeded: Math.ceil(Math.hypot(w.x - point.x, w.y - point.y) / unitsPerStep) };
  }
  // Which segment are we on, and where does the body project onto it?
  const seg = distanceToRail(waypoints, point, { floor, step });
  let i = Math.max(0, Math.min(seg.i, waypoints.length - 2));
  const a = waypoints[i], b = waypoints[i + 1];
  const vx = b.x - a.x, vy = b.y - a.y, len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : ((point.x - a.x) * vx + (point.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));

  // Walk forward along the line spending the budget — and stop early if the CHORD from where we
  // stand to the candidate aim would stray from the rail by more than `maxDeviation`. Every
  // waypoint passed on the way is checked against that chord, because the walker will fly straight
  // past all of them.
  const start = { x: a.x + t * vx, y: a.y + t * vy };
  let left = budget, px = start.x, py = start.y;
  const passed = [];
  // WHICH CONSTRAINT STOPPED US IS PART OF THE ANSWER. Reaching the end of the rail is not the
  // same as the chord straying off it, and labelling both "straightness" hid the difference — its
  // own test caught that: a loose tolerance with budget to spare still reported straightness when
  // the truth was simply that the rail had run out.
  let strayed = false;
  const strays = (cx, cy) =>
    passed.some((w) => distanceToSegment(w, start, { x: cx, y: cy }) > maxDeviation);
  while (i < waypoints.length - 1) {
    const q = waypoints[i + 1];
    const remain = Math.hypot(q.x - px, q.y - py);
    if (remain > left) {
      const k = left / remain;
      const cx = Math.round(px + (q.x - px) * k), cy = Math.round(py + (q.y - py) * k);
      if (strays(cx, cy)) { strayed = true; break; }   // the budget is not what binds here
      return { x: cx, y: cy, i, dist: budget, atEnd: false, bound: 'budget',
               stepsNeeded: Math.ceil(budget / unitsPerStep) };
    }
    if (strays(q.x, q.y)) { strayed = true; break; }
    left -= remain; px = q.x; py = q.y; passed.push({ x: q.x, y: q.y }); i++;
  }
  // Stopped by straightness rather than by budget: aim at the last point whose chord still tracks
  // the rail, which is the previous waypoint (or the projection, if we never advanced).
  if (i > 0 && (px !== start.x || py !== start.y)) {
    const d = Math.hypot(px - point.x, py - point.y);
    return { x: Math.round(px), y: Math.round(py), i, dist: d, atEnd: i >= waypoints.length - 1,
             bound: strayed ? 'straightness' : 'end', stepsNeeded: Math.ceil(d / unitsPerStep) };
  }
  if (px !== start.x || py !== start.y) {
    const d = Math.hypot(px - point.x, py - point.y);
    return { x: Math.round(px), y: Math.round(py), i, dist: d, atEnd: false,
             bound: strayed ? 'straightness' : 'end', stepsNeeded: Math.ceil(d / unitsPerStep) };
  }
  // Could not advance at all without straying: aim at the very next waypoint, because standing
  // still is not an option and one waypoint is by construction one lattice step.
  {
    const q = waypoints[Math.min(i + 1, waypoints.length - 1)];
    const d = Math.hypot(q.x - point.x, q.y - point.y);
    return { x: q.x, y: q.y, i, dist: d, atEnd: i + 1 >= waypoints.length - 1,
             bound: 'next-waypoint', stepsNeeded: Math.max(1, Math.ceil(d / unitsPerStep)) };
  }
  const d = Math.hypot(px - point.x, py - point.y);
  return { x: Math.round(px), y: Math.round(py), i: waypoints.length - 2, dist: d, atEnd: true,
           stepsNeeded: Math.ceil(d / unitsPerStep) };
}

/**
 * BOARD THE LINE BEFORE FOLLOWING IT, or spend every leg doing half of each.
 *
 * `aimPoint` walks the budget ALONG the line from the body's projection, which is right when the
 * body is ON the line and wrong when it is not: a body 800 units off-line is asked to travel ~880
 * units diagonally on a budget sized for 384, never arrives, ends the leg further off, and does it
 * again. Measured on prod 2026-09-12, 29 legs in the canyon: the body MOVED on 25 of them, drifted
 * 101u -> 820u off the rail, oscillated between r23c17 and r23c18, and closed 624 units of 4,918 —
 * about 21 units a leg, with the exit 200 legs away. Not wedged. Wasting the budget.
 *
 * So: far from the line, spend the whole budget getting ONTO it and nothing on advancing. The
 * threshold is a fraction of the budget rather than an absolute, because "far" only means anything
 * relative to how far one leg can travel.
 */
export function aimOrBoard(waypoints, point, { floor = null, budget = AIM_BUDGET,
                                               boardWhen = 0.5, step = MAX_STEP_HEIGHT } = {}) {
  const seg = distanceToRail(waypoints, point, { floor, step });
  const follow = aimPoint(waypoints, point, { floor, budget, step });
  if (!follow) return null;
  if (!(seg.d > budget * boardWhen)) return { ...follow, mode: 'follow', offLine: seg.d };

  // The projection itself: the nearest point on the line, which is where boarding aims.
  const i = Math.max(0, Math.min(seg.i, waypoints.length - 2));
  const a = waypoints[i], b = waypoints[i + 1];
  const vx = b.x - a.x, vy = b.y - a.y, len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : ((point.x - a.x) * vx + (point.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = Math.round(a.x + t * vx), py = Math.round(a.y + t * vy);
  const d = Math.hypot(px - point.x, py - point.y);
  return { x: px, y: py, i, dist: d, atEnd: false, mode: 'board', offLine: seg.d,
           stepsNeeded: Math.ceil(d / 64) };
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
