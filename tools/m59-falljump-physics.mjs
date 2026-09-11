// HOW FAR CAN A RUNNING BODY THROW ITSELF — the client's fall arithmetic, in ONE place.
//
// Pure, offline, no imports but the fineness constant. Nothing here reads a map, a bake or a
// socket, so it can be tested without any of them — which is the point, because two tools were
// carrying their own copy of these five lines and BOTH had the same bug in the same branch.
//
// THE FOUR CONSTANTS, FROM SOURCE.
//
//   FALL_VELOCITY_0        -FINENESS * 2 / 3   = 682.67 u/s   clientd3d/move.h:17
//   GRAVITY_ACCELERATION   -5 * FINENESS       = 5120 u/s^2   clientd3d/moveobj.h:15
//   run speed              2 * MOVEUNITS / MOVE_DELAY = 5120 u/s = 5 squares/s
//                                                              clientd3d/move.c:184,49
//   walk speed             MOVEUNITS / MOVE_DELAY     = 2560 u/s = 2.5 squares/s   move.c:187
//
// `MoveSingleVertically` integrates them straight (`clientd3d/moveobj.c:295,316`), so the drop
// after `t` seconds is
//
//     drop(t) = 682.67*t + 2560*t^2                (client units)
//
// A BODY LEAVING A LEDGE IS ALREADY FALLING. There is no jump button in this game and no
// upward impulse: `FALL_VELOCITY_0` is NEGATIVE, so the instant you run off an edge you are
// moving downward at 682 units a second. That is why the reach at DEAD LEVEL is finite —
// 1.38 squares, not "as far as you like" — and it is the fact the two hand-written copies of
// this arithmetic each got wrong in a different direction.
//
// ====================== THE LANDING RULE IS ONE EXPRESSION ======================
//
// The client accepts a landing when the body has not fallen further than the landing sits
// below the take-off, plus the step it may still climb on arrival:
//
//     fallenBy(t) <= drop + MAX_STEP_HEIGHT
//
// so the furthest a run can carry you from a take-off is
//
//     maxSpan(drop) = reachFor(drop + MAX_STEP_HEIGHT)
//
// ONE formula for a level hop, a small rise and a long fall — no branch, no special case, and
// no magic constant. `drop` is negative for a landing ABOVE the take-off, which is legal:
// at one square you may land up to +145 above where you left, because you have only fallen
// 239 units by then and 384 of climb is still available to you.
//
// WHAT THE BRANCHED VERSION COST. `m59-jumpfinder.mjs` and `m59-fineroute.mjs` both had:
//
//     if (drop <= MAX_STEP_HEIGHT) { if (span > F * 1.5) return false; }
//     else if (span > reachFor(drop) + F / 2) return false;
//
//   drop:        0     96    192    288    384    512   1024   2048
//   that cap:    1536  1536  1536   1536   1536   2219  3139   4459
//   true:        1415  1637  1840   2028   2204   2422  3175   4354
//   error (sq): +0.12 -0.10 -0.30  -0.48  -0.65  -0.20 -0.04  +0.10
//
// Permissive by 0.12 squares at dead level and RESTRICTIVE BY 0.65 SQUARES at the top of the
// same branch. The restrictive half is the expensive one: a candidate the tool never offers
// is a gap nobody learns is crossable. Room 27's mana node had been called unreachable by
// four separate measurements, and `BASELINE.md` said "there is no line anyone could add to
// that file today that would fix room 27" — with this rule in place `m59-jumpfinder.mjs`
// finds a three-jump route to it in six seconds, and the last of those three jumps clears
// the cap by ONE AND A HALF CLIENT UNITS out of 2203. Under `F * 1.5` it missed by 666.
//
// Derived by the m59-research session from `clientd3d/moveobj.c`; the correction to this
// repository's copies is theirs.

/** clientd3d/drawdefs.h:42. The CLIENT's fineness — kod's is 64, and they are 16x apart. */
export const CLIENT_FINENESS = 1024;

/** m59-roo.mjs: MAX_STEP_HEIGHT_KOD = 24, heightKodToClient shifts by 4. */
export const MAX_STEP_HEIGHT = 384;

export const FALL_V0 = CLIENT_FINENESS * 2 / 3;   // 682.67 u/s, positive here for readability
export const GRAVITY = 5 * CLIENT_FINENESS;       // 5120 u/s^2
export const RUN_SPEED = 5 * CLIENT_FINENESS;     // 5120 u/s — five squares a second
export const WALK_SPEED = 2.5 * CLIENT_FINENESS;  // 2560 u/s

/** How far the body has fallen `t` seconds after leaving the ledge, in client units. */
export const fallenBy = t => FALL_V0 * t + (GRAVITY / 2) * t * t;

/** Seconds of air before the body has fallen `drop` units. Zero for a rise or a level line. */
export function airTime(drop) {
  if (!(drop > 0)) return 0;
  const a = GRAVITY / 2;
  return (-FALL_V0 + Math.sqrt(FALL_V0 * FALL_V0 + 4 * a * drop)) / (2 * a);
}

/** Horizontal distance covered before falling `drop` units, at `speed`. */
export const reachFor = (drop, speed = RUN_SPEED) => speed * airTime(drop);

/**
 * THE WHOLE RULE. The furthest a body may travel horizontally and still land legally, given
 * the landing is `drop` units BELOW the take-off (negative for above).
 *
 * Use it as `span > maxSpan(drop)` -> refuse. One line, every case.
 */
export const maxSpan = (drop, { speed = RUN_SPEED, step = MAX_STEP_HEIGHT } = {}) =>
  reachFor(drop + step, speed);

/**
 * Where the body is, vertically, after travelling `span` horizontally from a take-off at
 * `takeOffFloor`. This is the height the client tests a wall crossing against while airborne
 * — the `motionZ` the flood throws away, which is why a memoryless step predicate cannot
 * represent a jump at all.
 */
export const heightAfter = (takeOffFloor, span, speed = RUN_SPEED) =>
  takeOffFloor - fallenBy(span / speed);
