// MAY A SURVIVAL EXIT LEAVE THE CONFINEMENT? -- the one decision, pure, so it can be tested without a keeper.
//
// PROBATIONARY, FROM 2026-10-30; REVISIT 2026-11-30. Operator: "if we don't have PVP problems with it in the next
// month we can revisit it." See docs/m59-boundary.md, "A survival exit may leave the confinement (probationary)".
//
// THE CONFLICT IT SETTLES. Two rules disagreed and both were survival code. `leaveForCasters` and the no-safe-spot
// `survival_exit` pick the nearest way out of a room that is killing the body, whatever the confinement says; the
// step guard (`Session.edgeCrossingBlock`) refuses every step over an edge out of the confinement, whichever faculty
// chose it. Prod 2026-10-27..31: 228 journeys walked a hurt body across a room to an edge the guard then refused,
// threw, and were re-issued every ~30 s (2142 -> 2133, 2501 -> 2508, 599 -> 589). fix/travel-threw stopped the
// walk; this decides which side wins.
//
// THE RULE. Surviving the next second outranks staying on the farm map, so a survival or caster exit may cross the
// confinement into the ONE room it was sent to -- unless that room is
//   - in the character's `bannedDestinations`, or
//   - a room where one of ours died to a player within the fleet's own PvP return hold (`pvpReturnDelayMs`,
//     two hours by default) -- so a red-alert lockdown still keeps bodies out of the room the enemy is killing in.
// Everything else about the confinement stands: no other journey, no other room, no second hop.

import { PVP_RETURN_DELAY_MS_DEFAULT } from './m59-pvp-return.mjs';

export const SURVIVAL_EDGE_ORIGINS = new Set(['survival_exit', 'caster_exit']);
export const SURVIVAL_EDGE_SINCE = '2026-10-30';
export const SURVIVAL_EDGE_REVISIT = '2026-11-30';

/** Is this journey a survival exit the pass is for? `casterExit` is the caster leg's own flag. */
export function isSurvivalExit({ origin = null, casterExit = false } = {}) {
  return casterExit === true || SURVIVAL_EDGE_ORIGINS.has(origin?.name);
}

/**
 * -> `{ allowed, why }`. `pvpRooms` is a Set of rooms with a recent PvP death (m59-pvp-return.mjs
 * `recentPvpDeathRooms`); the caller reads it, so this stays pure.
 */
export function survivalEdgeVerdict({ to, policy = null, pvpRooms = new Set() } = {}) {
  const room = to == null || to === '' ? NaN : Number(to);   // Number(null) is 0, a room nobody meant
  if (!Number.isFinite(room)) return { allowed: false, why: 'no destination' };
  const banned = (Array.isArray(policy?.bannedDestinations) ? policy.bannedDestinations : []).map(Number);
  if (banned.includes(room)) return { allowed: false, why: `room ${room} is in bannedDestinations` };
  if (pvpRooms?.has?.(room)) return { allowed: false, why: `one of ours died to a player in room ${room} within the PvP hold` };
  return { allowed: true, why: `survival exit into room ${room} (probationary since ${SURVIVAL_EDGE_SINCE})` };
}

export const pvpWindowMs = policy =>
  Number.isFinite(Number(policy?.pvpReturnDelayMs)) && Number(policy.pvpReturnDelayMs) > 0
    ? Number(policy.pvpReturnDelayMs) : PVP_RETURN_DELAY_MS_DEFAULT;
