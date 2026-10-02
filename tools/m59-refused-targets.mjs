// A TARGET THE SERVER WILL NOT LET US HIT, HERE. One memory, keyed by (map room number,
// target name), consulted by every path that swings at a player.
//
// Operator, 2026-10-01: "The bots are getting 'distracted' by a character they cannot attack,
// getting the message 'Only those in guilds may attack each other here.' -- make getting this
// message when trying to attack a target disable the attack attempts for that target in that
// map".
//
// THE SENTENCE. room.kod resource `room_guild_combat`, "Only those in guilds may attack each
// other here.", sent with MsgSendUser to the ATTACKER by Room::ReqSomethingAttack when the room
// carries ROOM_GUILD_PK_ONLY (0x8 -- Castle Victoria 38, Tos, Barloque, Jasper, Cor Noth, Kocatan
// and the arena antechambers), the attacker and the victim are both players (or there is no
// victim), PK is enabled server-wide, and Room::AllowGuildAttack says no: the ATTACKER is
// unguilded/not a murderer/no soldier shield, or the VICTIM has no token, no guild, is not a
// murderer and has no soldier shield. It is a spoken refusal, not a wire error: `attack` reports
// ok and nothing lands. The fleet is guilded, so in practice it names the VICTIM -- an unguilded
// stranger standing in a guild-only town -- which makes it a fact about one target in one room,
// NOT about the room. Other players there may be perfectly fair game.
//
// KEYED BY ROOM NUMBER AND NAME, NEVER BY OBJECT ID. Ids are renumbered on every save and
// recycled within hours (CLAUDE.md, "An object id is a temporary handle"). `world.room.num` is
// the map's own number and a player's name is the player.
//
// EXPIRY. An entry is forgotten when the character leaves that room (the operator's "in that
// map"), and after REFUSED_TTL_MS as a backstop even if it never leaves: the same player becomes
// attackable the moment they join a guild, pick up a token or a soldier shield, or turn murderer.
//
// IT SUPPRESSES SWINGS, NOT THREAT. Nothing here hides a player from survival: a refused player
// who is hurting us is still something the keeper's flee/rest ladder answers. Only OUR attack
// attempts on them are withheld, and monster targeting never consults this.
import { OF } from './m59-parse.mjs';

export const REFUSED_TTL_MS = 10 * 60_000;
// The refusal names nobody; it is attributed to the player we last swung or cast at, if that
// was within this long. The server answers the request synchronously, so this is generous.
export const ATTEMPT_WINDOW_MS = 5000;

const clean = t => String(t ?? '').replace(/~[A-Za-z]/g, '').replace(/\s+/g, ' ').trim();
export const normName = n => clean(n).toLowerCase();

/** room.kod `room_guild_combat`, matched through colour codes and whitespace. */
export const GUILD_ONLY_REFUSAL = /only those in guilds may attack each other here/i;
export const isGuildOnlyRefusal = text => GUILD_ONLY_REFUSAL.test(clean(text));

export class RefusedTargets {
  constructor({ now = Date.now, ttl = REFUSED_TTL_MS } = {}) {
    this.now = now; this.ttl = ttl;
    this.entries = new Map();          // `${room}|${name}` -> entry
    this.room = null;
  }

  /** The body is in `room` now. Leaving a room forgets everything learned in it. */
  enterRoom(room) {
    if (!(Number.isSafeInteger(room) && room > 0)) return;     // unknown is not "somewhere else"
    if (room === this.room) return;
    for (const [k, e] of this.entries) if (e.room !== room) this.entries.delete(k);
    this.room = room;
  }

  /** Record a refusal. Returns { entry, fresh } -- fresh is true the first time per (room, name). */
  refuse({ room, name, why = 'guild_only', text = null, at = this.now() } = {}) {
    const n = normName(name);
    if (!n || !(Number.isSafeInteger(room) && room > 0)) return null;
    this.enterRoom(room);
    const key = `${room}|${n}`;
    const prev = this.entries.get(key);
    if (prev && at - prev.at < this.ttl) {
      prev.count++; prev.last_at = at;
      return { entry: prev, fresh: false };
    }
    const entry = { room, name: clean(name), key: n, why, text: text ? clean(text) : null,
      at, last_at: at, count: 1 };
    this.entries.set(key, entry);
    if (this.entries.size > 256) this.entries.delete(this.entries.keys().next().value);
    return { entry, fresh: true };
  }

  /** The live entry for this name in this room, or null. */
  refusedHere(name, room, at = this.now()) {
    const n = normName(name);
    if (!n || !(Number.isSafeInteger(room) && room > 0)) return null;
    this.enterRoom(room);
    const key = `${room}|${n}`;
    const e = this.entries.get(key);
    if (!e) return null;
    if (at - e.at >= this.ttl) { this.entries.delete(key); return null; }
    return e;
  }

  list(at = this.now()) {
    return [...this.entries.values()].filter(e => at - e.at < this.ttl)
      .map(e => ({ room: e.room, name: e.name, why: e.why, at: e.at, count: e.count,
        expires_at: e.at + this.ttl }));
  }
}

/** The session's one memory. Every attack path asks this one. */
export function refusedTargets(session) {
  if (!session) return null;
  return session.refusedTargets ??= new RefusedTargets();
}

const agentOf = s => s?.combat?.agentId ?? s?.agentId ?? s?.name ?? '?';
const roomOf = s => s?.world?.room?.num;

/** Is `name` refused in the room the session stands in? */
export function refusedHere(session, name, at) {
  return refusedTargets(session)?.refusedHere(name, roomOf(session), at) ?? null;
}

/**
 * Record a refusal for `name` in the session's current room, logging once per (room, target).
 * `at` lets a caller with its own clock (CombatMode) keep the TTL on that clock.
 */
export function noteRefused(session, name, { why = 'guild_only', text = null, at, source = null } = {}) {
  const m = refusedTargets(session), room = roomOf(session);
  const r = m?.refuse({ room, name, why, text, ...(at != null ? { at } : {}) });
  if (!r) return null;
  if (r.fresh) {
    const line = `[combat] ${agentOf(session)}: ${r.entry.name} cannot be attacked in room ${room} ` +
      `(${why === 'guild_only' ? 'guild-only' : why}); not retrying here`;
    try { (session.refusedLog ?? console.error)(line); } catch {}
    try { session.recorder?.line?.('combat', { event: 'target_refused_here', target: r.entry.name, room,
      why, text: r.entry.text, source }); } catch {}
  }
  return r;
}

/** What the client last swung or cast at, as the client recorded it (M59Client.noteAttackTarget). */
function lastPlayerAttempt(client, at) {
  const a = client?.lastAttackTarget;
  if (!a || !a.player || !a.name) return null;
  if (at - a.at > ATTEMPT_WINDOW_MS) return null;
  return a;
}

/**
 * The session's event hook. Tracks the room (leaving forgets) and attributes a guild-only refusal
 * to the player this client last attacked. Returns the entry recorded, or null.
 */
export function observeRefusal(session, client, ev) {
  const m = refusedTargets(session);
  if (!m) return null;
  m.enterRoom(roomOf(session));
  if (ev?.kind !== 'message' || !ev.text || !isGuildOnlyRefusal(ev.text)) return null;
  const a = lastPlayerAttempt(client, Date.now());
  if (!a) return null;
  // Never one of ours: we do not swing at fleetmates, so a buff cast on one is not what was refused.
  try { if (session.combat?.isOurs?.(a.name)) return null; } catch {}
  return noteRefused(session, a.name, { text: ev.text, source: a.via })?.entry ?? null;
}

/**
 * The last line of defence, installed on the client as `attackVeto`: an attack packet at a player
 * refused in this room is not sent. Every caller that reaches `c.attack` is covered by it, which
 * is the point; the callers that choose targets also skip refused names so they move on.
 */
export function vetoAttack(session, client, id) {
  const o = client?.room?.objects?.get?.(id);
  if (!o || !(o.flags & OF.PLAYER)) return false;
  const name = client.rsc?.get?.(o.nameRsc) ?? o.name;
  return !!(name && refusedHere(session, name));
}
