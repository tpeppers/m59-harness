// AM I IN A SAFE WALL? ASKED OF THE GEOMETRY, AND OF NOTHING ELSE.
//
// This module exists to be the ONE answer to that question, so that no caller ever again
// derives it from `substrate/m59-safespots.json`. That book is retired
// (`m59-safespots-archive.mjs`), and the reason is worth keeping in front of whoever reads
// this next, because the argument for keeping it looked good four separate times:
//
//   Of 6,652 recorded failure events in it, 5,187 (78%) carry `failed_via: "fight"` and a
//   further 733 (11%) were recorded BEFORE the character reached the wall. The safe-wall
//   mechanic is that nothing can hit you UNLESS YOU SWING FIRST — so "hit while fighting
//   from a wall" is the mechanic WORKING, and the book was filing it as the wall failing.
//   89% of its failure column is the intended behaviour, recorded as its opposite. The
//   remainder is dominated by crowding: room 39 held 142 squares nothing can physically
//   reach, one of them with 431 failures, accrued when `max_bots_per_safe_spot` was 21.
//
// So the book's outcome column is not noisy, it is INVERTED — the better a wall is, the
// more the fleet fights from it, and the more failures it accrues. Nothing may rank, gate
// or report on it. Measured 2026-09-07.
//
// THERE ARE TWO MECHANISMS AND THEY ARE NOT THE SAME ONE. Both are real, both are
// computable, and this repository has been conflating them under one name:
//
//   SIGHT     `exposureAt().attackers === 0` — nothing within the monster disc (radius 3)
//             has line of sight to the square. A monster that cannot see you cannot target
//             you (monster.kod:1782). This is what `safeWalls()` has always tested, and it
//             is the rule in force.
//
//   APPROACH  `gridDisagreementAt().refused > 0` — the coarse grid offers an approach into
//             the square that the MOVER refuses. The monster paths to a square it believes
//             is next to you and the BSP will not let it make the step. This is the
//             operator's definition, and until now it only ever ORDERED the list.
//
// They overlap and neither implies the other. Which one actually keeps a character alive is
// an open question, and it is open BECAUSE the only outcome data anyone had was the book.
// `m59-restwatch.mjs` is the experiment that settles it: every predicate below is recorded
// on every rest, and one clean week says which of them has a violation and which does not.
//
// NOTHING HERE READS AN OUTCOME. This file is a function of geometry, and that is the whole
// point — a verdict that consults a history is a verdict that can be poisoned by one.

import { exposureAt, gridDisagreementAt, PLAYER_REACH } from './m59-safespots.mjs';

/**
 * The rule that decides `is_wall`, named so a ledger row can say which rule it was judged
 * under and a report can refuse to mix two.
 *
 * Changing this string is changing the definition, and every row recorded before the change
 * is then about a different question — which is what the `safespots` epoch in m59-epoch.mjs
 * is for. Change both together or the evidence silently blends.
 */
export const SAFE_WALL_RULE = 'no_line_of_sight';

/**
 * Every candidate reading of "safe wall", evaluated independently.
 *
 * The point of computing all of them on every observation is that the experiment costs
 * nothing extra and cannot be re-run: a character that rested last Tuesday cannot be asked
 * again what its square looked like. Recording only the rule in force is how the last book
 * became unable to answer the question it was built to answer.
 */
export const PREDICATES = Object.freeze({
  // Nothing within radius 3 can see this square. The rule in force.
  no_line_of_sight: (m) => m.attackers === 0,
  // ...and we can hit something that cannot hit back. `safeWalls()` requires this too, so
  // it is recorded separately: a wall with no free shots is still a wall to REST in, and
  // conflating "safe" with "useful to fight from" is why resting spots were scored on
  // whether they made good gun positions.
  no_los_with_free_shot: (m) => m.attackers === 0 && m.free_shots > 0,
  // The operator's definition: at least one approach the coarse grid offers, the mover
  // refuses. In room 39 this is 286 of 578 walkable squares (49.5%) — which is the reading
  // consistent with "most of the walls in upstairs CV appear to be safe spots".
  some_approach_refused: (m) => (m.refused_approaches ?? 0) > 0,
  // The strict reading of the same sentence. It finds 6 squares in room 39 and ZERO in
  // rooms 38 and 544, which cannot be right — the fleet demonstrably shelters in all three.
  // Kept because it is cheap and because being able to say "not this one" is worth a column.
  all_approaches_refused: (m) => (m.offered_approaches ?? 0) > 0
                              && m.refused_approaches === m.offered_approaches,
  // Standing somewhere the coarse grid calls unwalkable at all. The server paths monsters on
  // that grid (CanMoveInRoomFine is 2D — blakserv/roomdata.c:235), so a square it does not
  // believe in is a square nothing will path into.
  coarse_unwalkable: (m) => m.coarse_walkable === false,
});

export const PREDICATE_NAMES = Object.freeze(Object.keys(PREDICATES));

/**
 * Measure one square. Pure geometry, no history, no book.
 *
 * Returns `null` when the geometry cannot answer — a missing room, or collision that is not
 * baked. NULL IS NOT FALSE AND IS NOT TRUE. `moverStepLands` answers true for everything
 * when `collisionReady` is false, so a caller that reads "cannot tell" as "no disagreement"
 * scores every square in the world as ordinary floor and turns the criterion off silently.
 * That is the shape of failure this repository keeps finding: a measurement that degrades
 * to a plausible number rather than to an absence.
 */
export function measureSquare(geo, row, col, { los = 0 } = {}) {
  if (!geo || !Number.isInteger(row) || !Number.isInteger(col)) return null;
  let ex = null;
  try { ex = exposureAt(geo, row, col); } catch { return null; }
  if (!ex) return null;
  const dis = gridDisagreementAt(geo, row, col);   // null when collision is not baked
  let coarse = null;
  try { coarse = typeof geo.walkable === 'function' ? !!geo.walkable(row, col) : null; }
  catch { coarse = null; }
  return {
    row, col,
    attackers: ex.attackers,
    free_shots: ex.free_shots,
    our_ground: ex.our_ground,
    // null, never 0, when collision is not baked. See the note above.
    refused_approaches: dis ? dis.refused : null,
    offered_approaches: dis ? dis.offered : null,
    coarse_walkable: coarse,
    collision_ready: dis != null,
    player_reach: PLAYER_REACH,
  };
}

/**
 * The verdict for one square: is this a safe wall, under the rule in force, and what does
 * every other candidate reading say about it.
 *
 * `is_wall` is `null` — not false — when the geometry could not be measured, because
 * "I do not know" and "you are exposed" lead to opposite correct actions and a caller that
 * cannot tell them apart will pick the wrong one at 3am.
 */
export function safeWallVerdict(geo, row, col, { los = 0, rule = SAFE_WALL_RULE } = {}) {
  const m = measureSquare(geo, row, col, { los });
  if (!m) {
    return { is_wall: null, rule, why: 'no geometry for this square, so nothing is claimed',
             predicates: null, measured: null };
  }
  const predicates = {};
  for (const [name, fn] of Object.entries(PREDICATES)) {
    // A predicate whose inputs are absent answers null rather than false, for the same
    // reason `is_wall` does.
    predicates[name] = (name === 'some_approach_refused' || name === 'all_approaches_refused')
      && !m.collision_ready ? null : !!fn(m);
  }
  const is_wall = predicates[rule] ?? null;
  return {
    is_wall, rule, predicates, measured: m,
    why: is_wall === null ? 'the rule in force could not be evaluated here'
      : is_wall ? `nothing within reach has line of sight to r${row}c${col}`
                : `${m.attackers} square(s) within reach can see r${row}c${col}`,
  };
}

/**
 * A verdict built from a spot row that was ALREADY measured, rather than from geometry.
 *
 * The keeper chose its wall from a `safeSpots()` row and then stood on it for minutes. Asking
 * the geometry again at the moment of the outcome would record a different measurement from
 * the one that was ACTED ON — and where the two differ is exactly where the interesting bugs
 * are. So the ledger records the numbers the decision was made with.
 *
 * `collision_ready` is inferred from whether the row carried an approach count at all, which
 * is the same "null means cannot tell" rule as everywhere else in this file.
 */
export function verdictFromRow(row, { rule = SAFE_WALL_RULE } = {}) {
  if (!row) return { is_wall: null, rule, predicates: null, measured: null,
                     why: 'no measured row, so nothing is claimed' };
  const m = {
    row: row.row ?? null, col: row.col ?? null,
    attackers: row.can_reach_you ?? null,
    free_shots: row.free_shots ?? null,
    our_ground: row.our_ground ?? null,
    refused_approaches: row.refused_approaches ?? null,
    offered_approaches: row.offered_approaches ?? null,
    coarse_walkable: row.coarse_walkable ?? null,
    collision_ready: Number.isFinite(row.offered_approaches),
  };
  const predicates = {};
  for (const [name, fn] of Object.entries(PREDICATES)) {
    const needsApproach = name === 'some_approach_refused' || name === 'all_approaches_refused';
    predicates[name] = needsApproach && !m.collision_ready ? null
      : (name === 'coarse_unwalkable' && m.coarse_walkable === null) ? null
      : Number.isFinite(m.attackers) || needsApproach ? !!fn(m) : null;
  }
  return { is_wall: predicates[rule] ?? null, rule, predicates, measured: m,
           why: 'recorded from the row the keeper actually chose this wall with' };
}

/**
 * The shape the broker and the keeper report as "am I in a safe spot right now".
 *
 * Deliberately the same shape the book's `in_a_safe_spot_now` used to return — `{ at, works,
 * evidence }` — so that every existing caller keeps working while the SOURCE of the answer
 * changes from a history to a measurement. `works` is now a fact about the square rather
 * than a tally of what happened to whoever stood on it.
 */
export function standingVerdict(geo, at, { los = 0 } = {}) {
  if (!at || !Number.isInteger(at.row) || !Number.isInteger(at.col)) return false;
  const v = safeWallVerdict(geo, at.row, at.col, { los });
  if (v.is_wall === null) return false;
  return {
    at: { col: at.col, row: at.row },
    works: v.is_wall,
    rule: v.rule,
    reachable_by: v.measured.attackers,
    refused_approaches: v.measured.refused_approaches,
    evidence: v.why,
  };
}
