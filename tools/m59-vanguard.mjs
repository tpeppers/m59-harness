// WHAT A SCOUT CAN HONESTLY SAY ABOUT THE ROOM AHEAD, and how it tells the convoy.
//
//   import { assessRoom, postScout, readScout } from './m59-vanguard.mjs';
//
// Somebody has to enter the room first. This is the machinery for that character being
// deliberately one hop ahead and reporting back, instead of the whole convoy discovering
// the trouble at once.
//
// TWO DESIGN DECISIONS THAT ARE NOT OBVIOUS, AND BOTH COST SOMETHING IF GOT WRONG.
//
// 1. THE CHANNEL IS A FILE, NOT AN IN-GAME TELL. `m59-party.report()` looks like the right
//    place and is not: every keeper is a separate PROCESS (see CLAUDE.md, corrected
//    2026-08-27), so that roster Map is per-process memory and a scout's report would never
//    reach the convoy. In-game `say`/tell does cross processes — the server carries it — but
//    prod is a SHARED SERVER, and "hold, eight trolls at 578, convoy behind me" is an
//    announcement to exactly the murderers a vanguard exists to detect. A file under
//    substrate/ is private, crosses processes, and survives a keeper restart.
//
// 2. IT REPORTS OBSERVATIONS, NOT ORDERS. The scout says what it saw and when; the strategy
//    that reads it decides whether that means hold. A scout that returns "HOLD" bakes one
//    fleet's risk appetite into a shared tool, and the next caller with a 20-health mule and
//    nothing to lose wants a different answer from the same facts.
//
// WHAT IS ACTUALLY OBSERVABLE, measured off a live keeper's /state in room 578 on
// 2026-08-30 while a convoy was stalled in it:
//   * every object: {id, name, flags, is_player, col, row} — 43 of them, 8 trolls and 4
//     black spiders among them
//   * exits: [{to, direction}]
//   * the keeper's own verdict: stuck.why = "room capped by creatures we will not fight"
// That last one is the most valuable field in the snapshot and it is free.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { evidenceDirFor } from './m59-fleetpath.mjs';
import { flaggedAggressor } from './m59-parse.mjs';

export const SCOUT_FILE = process.env.M59_SCOUT_FILE ||
  join(evidenceDirFor(), 'scout-board.json');

// A report older than this is a rumour. Bodies move; a room that was clear four minutes ago
// is not evidence about the room now.
export const DEFAULT_STALE_MS = 90_000;

/**
 * What one character can see from inside a room, reduced to the things a convoy behind it
 * would want to know. Pure — it takes a snapshot and returns a description.
 *
 * @param snap {objects, exits, stuck, room, self}  the keeper's /state, or the parts of it
 * @param opts.isFleetmate  (name) => boolean — ROSTER-backed. Never guess from flags.
 * @param opts.toward       room number the convoy means to leave by, if known
 */
export function assessRoom(snap = {}, { isFleetmate = () => false, toward = null } = {}) {
  const objects = snap.objects || [];
  const players = objects.filter(o => o.is_player);
  const creatures = objects.filter(o => !o.is_player && o.name);

  const byName = new Map();
  for (const c of creatures) byName.set(c.name, (byName.get(c.name) || 0) + 1);

  // STRANGERS ARE NOT ENEMIES, AND THE DIFFERENCE MATTERS ON A SHARED SERVER. Most players
  // out there are ordinary people going about their afternoon. What a convoy wants to know
  // is (a) who is not ours and (b) which of those the server itself has flagged.
  const strangers = players.filter(p => !isFleetmate(p.name));
  const aggressors = strangers.filter(p => flaggedAggressor(p.flags));

  // The exit we mean to take, if the caller said. A body sitting in a doorway is worth more
  // than the same body in a corner, and this is the only place that distinction can be made.
  const exits = snap.exits || [];
  const exitWanted = toward == null ? null : exits.find(e => Number(e.to) === Number(toward)) ?? null;

  // The keeper's own words. `stuck.why` is the cheapest, truest hazard signal available and
  // it costs nothing to forward: "room capped by creatures we will not fight" is a fact
  // about this room that no amount of counting objects would produce.
  const stuckWhy = snap.stuck?.why ?? null;

  return {
    room: snap.room?.num ?? null,
    room_name: snap.room?.name ?? null,
    at: Date.now(),
    creatures: [...byName.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
    creature_total: creatures.length,
    strangers: strangers.map(p => p.name),
    aggressors: aggressors.map(p => p.name),
    exits: exits.map(e => ({ to: e.to, direction: e.direction })),
    exit_wanted: exitWanted ? { to: exitWanted.to, direction: exitWanted.direction } : null,
    exit_missing: toward != null && !exitWanted,
    stuck_why: stuckWhy,
    health: snap.hp?.value ?? null,
    health_max: snap.hp?.max ?? null,
  };
}

// ---------------------------------------------------------------------- the shared board

function loadBoard() {
  try { return JSON.parse(readFileSync(SCOUT_FILE, 'utf8')); } catch { return { rooms: {} }; }
}
function saveBoard(b) {
  try { mkdirSync(dirname(SCOUT_FILE), { recursive: true }); } catch {}
  writeFileSync(SCOUT_FILE, JSON.stringify(b, null, 1));
}

/** Post one scout's observation. Last writer wins per room, which is what freshness means. */
export function postScout(agent, assessment) {
  if (!assessment || assessment.room == null) return null;
  const b = loadBoard();
  b.rooms[String(assessment.room)] = { ...assessment, by: agent };
  saveBoard(b);
  return b.rooms[String(assessment.room)];
}

/**
 * The freshest word on a room, or null. NULL MEANS NOBODY HAS LOOKED — never "it is clear".
 * A convoy that reads silence as safety has no vanguard, it has a delay.
 */
export function readScout(room, { staleMs = DEFAULT_STALE_MS, now = Date.now() } = {}) {
  const r = loadBoard().rooms?.[String(room)];
  if (!r) return null;
  if (now - (r.at ?? 0) > staleMs) return { ...r, stale: true, age_ms: now - (r.at ?? 0) };
  return { ...r, stale: false, age_ms: now - (r.at ?? 0) };
}

/** Everything on the board, newest first — for a human deciding whether to send a convoy. */
export function scoutBoard({ staleMs = DEFAULT_STALE_MS, now = Date.now() } = {}) {
  const rooms = loadBoard().rooms || {};
  return Object.values(rooms)
    .map(r => ({ ...r, stale: now - (r.at ?? 0) > staleMs, age_ms: now - (r.at ?? 0) }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
