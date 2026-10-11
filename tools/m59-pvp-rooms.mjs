// PVP_ROOMS: WHERE A CHARACTER MAY FIGHT A PLAYER AT ALL.
//
// The operator's order, 2026-10-11: "stop people from fighting back outside of 599/2/38
// (Ukgoth <-> Castle Victoria)" — it "overrides fight back in maps outside of 599/2/38".
//
// `policy.pvpRooms` (broker `autopilot pvp_rooms`) is a list of MAP room numbers — `room.num`,
// never an object id, which is renumbered on every save. When it is set and non-empty, every
// path that can swing at a PLAYER asks this module first, and outside the list the answer is no:
//
//   * combat mode's return fire after a hit (`beginPvP`) and the war's engage-on-sight
//     (`beginWar`, reached from the scan and from a fleetmate's alarm);
//   * `syncPvP`, which ENDS a fight that walks out of the list — with its own reason, so a stop
//     for leaving the rooms never reads as "operator suspended connection";
//   * the keeper's `defendAgainstPlayers`, `engagePlayerTarget`, `respondToConflict` and the
//     player rows of `passFightBack`.
//
// WHAT IT DOES NOT DO. It never takes the body and never freezes it: a character hit outside the
// list is left to the keeper's own survival ladder (flee below the line, playDead, panic logoff),
// exactly like anything else hurting it that it will not fight. Monsters are untouched. And the
// character still REPORTS — the war sighting alarm keeps firing and an attack is written to the
// durable PvP log as `pvp_attacked_outside_rooms`, because fleet-mates standing in an allowed room
// fight on those alarms and a watchdog has to be able to see the attack that was not answered.
//
// SILENCE IS THE OLD BEHAVIOUR. Unset, null or [] means "every room", which is what there was
// before this key existed.

/** The configured list as numbers, or null when the key is silent (unset / null / empty). */
export function pvpRoomsOf(policy) {
  const raw = policy?.pvpRooms;
  if (!Array.isArray(raw) || !raw.length) return null;
  const rooms = raw.map(Number).filter(n => Number.isInteger(n) && n > 0);
  return rooms.length ? rooms : null;
}

/**
 * THE ONE DECISION. May this character engage a player while standing in `roomNum`?
 * True everywhere when the key is silent. With a list, true only in a listed room — and an
 * unknown room (mid-transition, no ROOM yet) is not a listed one.
 */
export function pvpAllowedHere(policy, roomNum) {
  const rooms = pvpRoomsOf(policy);
  if (!rooms) return true;
  const n = Number(roomNum);
  return Number.isInteger(n) && rooms.includes(n);
}

/** The refusal as data, or null when engaging here is allowed. */
export function pvpRoomsRefusal(policy, roomNum) {
  if (pvpAllowedHere(policy, roomNum)) return null;
  const rooms = pvpRoomsOf(policy);
  const room = Number.isFinite(Number(roomNum)) ? Number(roomNum) : null;
  return { room, rooms, reason: 'outside pvp_rooms',
    why: `room ${room ?? '?'} is outside pvp_rooms [${rooms.join(', ')}]; players are not engaged here` };
}

/** The `syncPvP` stop reason when a fight leaves the allowed rooms. Never the suspension text. */
export function pvpRoomsStopReason(refusal) {
  return `PvP: outside pvp_rooms (room ${refusal?.room ?? '?'}; allowed ${(refusal?.rooms ?? []).join(',')}); ` +
    'survival returns to the keeper ladder';
}

/**
 * The broker's validator for `autopilot pvp_rooms`. null or [] clears (returns null); otherwise
 * an array of positive whole room numbers. Anything else THROWS, naming the key — a room list
 * that silently dropped a typo would leave a character fighting where the operator said not to.
 */
export function validatePvpRooms(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value))
    throw new Error(`pvp_rooms must be an array of room numbers (map room.num), or null/[] to clear — got ${JSON.stringify(value)}`);
  if (!value.length) return null;
  const bad = value.filter(v => typeof v === 'boolean' || v === null || v === '' ||
    !Number.isInteger(Number(v)) || Number(v) <= 0);
  if (bad.length)
    throw new Error(`pvp_rooms must hold positive whole room numbers (map room.num, never object ids) — ` +
                    `refused ${bad.map(b => JSON.stringify(b)).join(', ')}`);
  return [...new Set(value.map(Number))];
}

/**
 * The war scan's choice for a hostile it can see: 'engage' (beginWar, which raises the alarm
 * itself), 'sighted' (report only), or null when nothing hostile is here. Engagement refused for
 * ANY reason — war off, the swarm leash, or pvp_rooms — still reports the sighting.
 */
export function warScanAction({ hostile, warEnabled, leashed, pvpAllowed }) {
  if (!hostile) return null;
  return warEnabled && !leashed && pvpAllowed ? 'engage' : 'sighted';
}

/**
 * The durable PvP-log row (substrate/pvp/<fleet>/<day>.jsonl, m59-pvp.mjs appendPvp) for a player
 * attack this character did NOT answer because it stood outside pvp_rooms. `kind: 'combat'` with
 * the attacker in `attackers`, so the battle reader counts it as hostile contact.
 */
export function outsideRoomsRow({ at = Date.now(), observer = null, room = null, attacker, rooms = [], text = null } = {}) {
  return { kind: 'combat', event: 'pvp_attacked_outside_rooms', at, observer, room,
    target: attacker ?? null, attacker: attacker ?? null, pvp_rooms: rooms, text,
    reason: 'outside pvp_rooms: not returning fire; the keeper ladder (flee/logoff) owns survival',
    decision: null, outcome: null,
    attackers: attacker ? [{ character: attacker, incoming_hits: 0, incoming_misses: 0,
      outgoing_hits: 0, outgoing_misses: 0 }] : [] };
}
