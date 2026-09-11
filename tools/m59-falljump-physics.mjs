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
// finds a three-jump route to it in six seconds. Under `F * 1.5` the last of those three
// jumps missed by 666 units — which is 0.65 squares and not a rounding question, so the fix
// is right whatever becomes of that particular jump. It clears the closed form by only 1.57,
// and the discrete section at the bottom says that margin is INSIDE the client's own
// quantisation at every frame rate: a candidate for a body to settle, not arithmetic.
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

// =================== AND THE CLOSED FORM IS NOT THE CLIENT ===================
//
// Everything above is the continuous solution. The client integrates FORWARD EULER, in
// integers, once per frame, and moves in whole frames of horizontal:
//
//   moveobj.c:293   int dz = dt * m->v_z / 1000;                       <- INTEGER division
//   moveobj.c:295   m->z += (int)((double)dz * gravityAdjust);
//   moveobj.c:316   m->v_z += (int)(gravityAdjust * (double)(GRAVITY_ACCELERATION*dt/1000));
//   move.c:266      num_steps = max(1, min(20, 200 * dt / 1000));
//   move.c:268      xinc = dx / num_steps;                             <- INTEGER division
//   move.c:213-221  dt <  MOVE_DELAY -> gravityAdjust 1, horizontal scaled by dt/MOVE_DELAY
//                   dt >= MOVE_DELAY -> gravityAdjust = MOVE_DELAY/dt, horizontal unscaled
//
// ======================= THE FALL HAPPENS FIRST =======================
//
// CORRECTED 2026-09-10, AND THE FIRST VERSION OF THIS FILE HAD IT BACKWARDS. The order
// inside one frame is not a modelling choice, it is in the game loop:
//
//   statgame.c:385   void GameIdle(void) {
//   statgame.c:387      MoveUpdateServer();
//   statgame.c:388      AnimationTimerProc(hMain, 0);   // the FALL
//   statgame.c:389      HandleKeys();                   // the MOVE
//
// `AnimationTimerProc` reaches `ObjectsMove(dt)` (animate.c:128) and thence
// `MoveSingleVertically` (moveobj.c:254); `HandleKeys` reaches `UserMovePlayer`, which reads
// `z = max(player_obj->motion.z, GetFloorBase(last_x, last_y))` (move.c:286). So **motion.z
// has already dropped for this frame before any wall is tested.** And `UserMovePlayer` never
// writes `motion.z` at all — it sets only `dest_z` and `v_z` (move.c:408-421) — so every
// sub-step of a frame shares one z.
//
// Assuming move-then-fall flatters every candidate by about one frame of horizontal. This
// file did exactly that for one commit, and it turned "too close to call" into "clears
// comfortably" for the first candidate it was ever asked about.
//
// ======================= SO THE ANSWER IS A BRACKET, NOT A NUMBER =======================
//
// Because z changes once per frame and the body then moves a whole frame's worth, the reach
// is quantised: the last legal position is the end of the last frame whose post-fall z still
// permits the landing, and everything in the next frame is already too low. `spanBracket`
// returns that `[lo, hi]`, and a span landing INSIDE it is one the arithmetic cannot decide.
//
// Against the closed form, with the ordering right, there is no clean boundary — it sits
// below the bracket at some drops, inside it at others, and drifts above it for long falls:
//
//   drop       0     384    1024    2048    3072    4096    6144   10240
//   closed  1415    2204    3175    4354    5305    6125    7522    9770
//   dt=8   [1440   [2200   [3200   [4360   [5280   [6120   [7480   [9720
//           1480]   2240]   3240]   4400]   5320]   6160]   7520]   9760]
//           below  INSIDE   below   below  INSIDE  INSIDE   ABOVE   ABOVE
//
// An earlier version of this comment claimed the closed form was a conservative lower bound
// up to a drop of ~3517. That was measured with the ordering backwards and it is withdrawn.
//
// WHICH IS WHY maxSpan STAYS THE PLANNER'S GATE. It is a single, stable, frame-rate-free
// number in the right neighbourhood, and a proposer wants exactly that. The discrete model's
// job is not to replace it but to say when a candidate is too close to trust — and then the
// answer is a body, not more arithmetic.
//
// NOTE THAT gravityAdjust MAKES THE ARC FRAME-RATE INVARIANT, which is what it is for: at
// dt >= MOVE_DELAY both the per-frame fall and the per-frame gravity carry a 100/dt that
// cancels, and below MOVE_DELAY the horizontal is scaled instead. A slow client does not jump
// further. What moves with frame rate is the Euler error and the quantisation, and the
// bracket is how wide that is.

/** One frame's horizontal advance, with move.c's two integer divisions. */
function frameAdvance(dt) {
  const MOVE_DELAY = 100, MOVEUNITS = CLIENT_FINENESS >> 2;
  const dx = dt < MOVE_DELAY
    ? Math.trunc(2 * MOVEUNITS * dt / MOVE_DELAY)
    : 2 * MOVEUNITS;
  const numSteps = Math.max(1, Math.min(20, Math.trunc(200 * dt / 1000)));
  const xinc = Math.trunc(dx / numSteps);          // move.c:268
  return { perFrame: xinc * numSteps, numSteps, xinc };
}

/**
 * THE BRACKET THE CLIENT'S OWN ARITHMETIC PUTS THE LANDING IN, at frame time `dt`.
 *
 * `lo` is the end of the last frame whose post-fall z still permits the landing; `hi` is the
 * end of the frame after it, every position in which is already too low. A span at or below
 * `lo` is legal at this frame rate, a span above `hi` is not, and a span BETWEEN them is
 * undecidable from here — that is the honest output and the reason this returns two numbers.
 */
export function spanBracket(drop, { dt = 16, step = MAX_STEP_HEIGHT } = {}) {
  const limit = drop + step;
  const MOVE_DELAY = 100;
  if (!(limit > 0)) return { lo: 0, hi: 0, dt };
  const gravityAdjust = dt < MOVE_DELAY ? 1.0 : MOVE_DELAY / dt;
  const { perFrame } = frameAdvance(dt);
  if (perFrame <= 0) return { lo: 0, hi: 0, dt };
  let z = 0, vz = Math.trunc(-CLIENT_FINENESS * 2 / 3), x = 0, lastLegal = 0;
  for (let i = 0; i < 100_000; i++) {
    // 1. AnimationTimerProc: the frame falls first (statgame.c:388).
    z += Math.trunc(Math.trunc(dt * vz / 1000) * gravityAdjust);
    vz += Math.trunc(gravityAdjust * Math.trunc(-5 * CLIENT_FINENESS * dt / 1000));
    // 2. HandleKeys: then it moves, every sub-step sharing this z (move.c:286).
    if (-z > limit) return { lo: lastLegal, hi: x + perFrame, dt };
    x += perFrame; lastLegal = x;
  }
  return { lo: lastLegal, hi: lastLegal, dt };
}

/**
 * The client's own reach at one frame rate — the bracket's LOWER edge, which is the last
 * position actually known to be legal. Use `spanBracket` when the margin matters.
 */
export const maxSpanDiscrete = (drop, opts = {}) => spanBracket(drop, opts).lo;

/**
 * Is this candidate too close for the arithmetic to call? Checks the span against the bracket
 * at a spread of plausible frame times, and says `needsBody` when any of them straddles it.
 */
export function jumpConfidence(drop, span, { rates = [8, 16, 33, 66, 100] } = {}) {
  const brackets = rates.map(dt => spanBracket(drop, { dt }));
  const clears = brackets.every(b => span <= b.lo);
  const fails = brackets.every(b => span > b.hi);
  return {
    brackets, clears, fails,
    needsBody: !clears && !fails,
    verdict: clears ? 'clears at every frame rate'
           : fails ? 'refused at every frame rate'
           : 'INSIDE the bracket — the arithmetic cannot decide this one, walk it',
  };
}
