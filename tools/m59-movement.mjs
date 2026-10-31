// Movement results that cannot become legal by retrying another heading or pretending
// a square is occupied. These are failures of the local collision contract or of the
// state needed to apply it; callers must propagate them before any further packet.
export const TERMINAL_MOVEMENT_REASONS = Object.freeze([
  'collision_geometry_unavailable',
  'collision_geometry_changed',
  'room_security_unknown',
  'room_geometry_mismatch',
  'room_changed_before_move',
  'position_confirmation_timeout',
  'own_position_unknown',
  'start_has_no_floor',
  // SPLIT OUT OF `start_has_no_floor` 2026-08-21, and terminal for exactly the same
  // reason it is: no heading fixes it. The character's coordinates and the loaded room
  // geometry belong to different rooms, so every square the search can reach is empty —
  // and re-planning against the wrong map produces another wrong plan, faster.
  //
  // It is separated because the two were indistinguishable in the record and the common
  // one is not the one the old name describes: 1,535 of 2,361 shadow-fleet hop failures
  // in fourteen hours read `start_has_no_floor`, and the room they mostly left is ten
  // rows by thirteen columns with every square in it walkable. See the note at the
  // refusal site in m59-broker.mjs.
  'position_outside_room_geometry',
  'invalid_move_target',
  // A DECLARED JUMP THE CHARACTER CANNOT RUN. Terminal for the same reason as the rest:
  // no other heading fixes it. The jump is the only legal edge down that face -- every
  // walking step off the Ukgoth ledge is 864 to 1296 units against a MAX_STEP_HEIGHT of
  // 384 -- so a retry from a different angle is not a different attempt, it is the same
  // attempt at a body that still cannot run.
  //
  // It is only ever raised AFTER resting on the take-off ledge has already failed to
  // recover vigor, so by the time a caller sees it the cheap remedy has been tried. What
  // it must NOT do is feed the replan loop: the character is standing somewhere it can
  // stand, and the honest answer is that this road is shut right now.
  'jump_needs_run',
  // A FALL WITH A BODY ON ITS LINE AND NO LANE PAST IT. Terminal for the same reason as
  // `jump_needs_run`: the drop is the only legal edge down that face, so another heading is
  // the same attempt again. Raised only AFTER the lane search has failed, so by the time a
  // caller sees it both sides of the blocker have been tried.
  //
  // What its absence cost: 1,103 fall attempts in one room in nine minutes, twelve characters
  // standing on each other's lines, every one retrying until the run ended. Nothing handled
  // them and nothing stopped them either.
  'fall_blocked_by_body',
  // A DECLARED JUMP WHOSE ROOM IS NOT IN THE STATE IT NEEDS (`requires.sectors`,
  // m59-jump-precondition.mjs). Brax's north ledge is a fall only with the lift up; with it down
  // it is a 4416-unit climb, and no heading changes which state the lift is in. `_unknown` is the
  // server not having reported the sector at all, refused rather than guessed from the .roo.
  'jump_precondition_unmet',
  'jump_precondition_unknown',
]);

const TERMINAL = new Set(TERMINAL_MOVEMENT_REASONS);

export function isTerminalMovementReason(reason) {
  return typeof reason === 'string' && TERMINAL.has(reason);
}

export function terminalMovementResult(result) {
  return result && isTerminalMovementReason(result.reason) ? result : null;
}
