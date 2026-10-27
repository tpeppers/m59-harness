// A DESK THAT GOES WHERE ITS SERVER GOES.
//
// Operator, 2026-10-27: "Have Loial's chalice desk be self-centered, wherever he goes it goes (add that if it doesn't
// exist, we're gonna want that for other things)". A desk used to be a ROOM (the chalice station, a vault counter's
// inn, a service desk's post) that its server walked back to. A following desk is a PERSON: its room is wherever the
// server stands now. The server never walks "home" for it, and everyone else reads the room off the server's own
// published desk record (`at` + `room`), so a stale record (the server logged off, the keeper hung) reads as "no desk
// known" rather than sending a traveller to where the server used to be.
//
// Config: `room: 'holder'` (or `'server'`, `'follow'`) in place of a room number. Pure.
export const FOLLOW_WORDS = Object.freeze(['holder', 'server', 'follow', 'self']);
export const DESK_RECORD_MAX_AGE_MS = 2 * 60_000;

/** Is this room setting a following one? */
export const isFollowing = v => typeof v === 'string' && FOLLOW_WORDS.includes(v.trim().toLowerCase());

/**
 * Where the desk is now.
 *   fixed      the configured room (a number), when the desk does not follow
 *   follows    true for a following desk
 *   isServer   is the asker the desk's server
 *   here       the asker's own room
 *   record     the server's published desk record { room, at }
 * -> a room number, or null when it cannot honestly be said (a following desk whose record is missing or stale).
 */
export function deskRoom({ fixed = null, follows = false, isServer = false, here = null, record = null,
                           now = Date.now(), maxAgeMs = DESK_RECORD_MAX_AGE_MS } = {}) {
  if (!follows) return Number.isFinite(Number(fixed)) && fixed != null ? Number(fixed) : null;
  if (isServer) return Number.isFinite(Number(here)) && here != null ? Number(here) : null;
  const room = Number(record?.room), at = Number(record?.at);
  if (!Number.isFinite(room) || room <= 0 || !Number.isFinite(at) || now - at > maxAgeMs) return null;
  return room;
}
