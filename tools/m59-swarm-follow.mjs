// SWARM FOLLOW: the swarm walks with its leader -- a wedge behind him in the room, through the
// door he took between rooms.
//
// Operator, 2026-10-06: "Can you make them follow me in a formation in the room while swarming,
// as well as follow me between rooms?" with the answers: the swarm is whoever is in the leader's
// room when he presses S, PLUS anyone who later enters the room he is in; it overrides lockdown
// for its members (they go back to where they joined when it ends); a WEDGE behind him; and
// "I'd like the swarm to not include characters below 30 HP" -- read as MAXIMUM health, the same
// rule as lockdown's "never the hall below 30": a fact about the character, not about a wound,
// so membership does not flicker every time somebody is hit.
//
// Before this, S claimed movement and work for every in-game character everywhere and nothing
// ever moved them: followers stood still wherever they were, fought only if the leader's target
// was in their own room, and the 120 s lease was never renewed, so the swarm quietly ended
// after two minutes.
//
// THE PIECES, and why each lives where it does:
//   * this module is pure: the formation, the eligibility rule, the door inference, and the
//     two small state files -- so all of it is decided offline by m59-swarm-follow-test.mjs;
//   * tools/m59-swarm.mjs is the DRIVER the terminal starts: it decides MEMBERSHIP (who joins,
//     who is dropped), holds every member's movement+work claim with a heartbeat, and ends the
//     swarm by walking members home. Minute-scale decisions, so a separate process;
//   * the FOLLOW TICK runs in each member's keeper (CombatMode.swarmFollowTick, every 250 ms),
//     because holding a slot behind a moving leader is a body decision and the keeper owns the
//     body. Survival stays the keeper's throughout: a follower below its flee line stops
//     following and the survival ladder has it.
//
// TWO FILES, both under substrate/swarm/ and both this machine's (gitignored):
//   <fleet>.json            the driver's state: leader, members (with the room each joined
//                           from), phase (following | returning), formation.
//   <fleet>/<agent>.json    each keeper's SIGHTING, written while a swarm is on: which room it is
//                           in, whether it sees the leader, its maximum health. This is how the
//                           driver learns the leader's room (only a keeper that sees him knows
//                           the room NUMBER -- the proxy has only a temporary object id) and who
//                           has walked into it.

import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SWARM_MIN_MAX_HEALTH = 30;
// A sighting older than this is not evidence of anything: the keeper restarted or the body moved.
export const SIGHTING_FRESH_MS = 6_000;
// The driver renews each member's claim this often, with this lease. A driver that dies stops
// renewing, and within one lease every member is its keeper's again -- the safe direction.
export const HEARTBEAT_MS = 20_000;
export const LEASE_MS = 60_000;
// Formation spacing in squares, and how far from its slot a follower may stand before it moves.
// A square of slack is what stops twenty characters jittering every time the leader turns.
export const SPACING = 1;
export const SLACK = 1;
// At most one follow leg this often, so following never crowds out the keeper's own reads.
export const LEG_GAP_MS = 1_000;
// How long one follow leg may take before it is cancelled: a short walk in the room, a journey between rooms.
export const ROOM_LEG_MS = 8_000;
export const TRAVEL_LEG_MS = 240_000;
// The swarm's claim holder. CombatMode keys every warband behaviour on this prefix.
export const holderFor = leader => `swarm/${leader}@terminal`;

export const swarmDir = (root = HERE) => process.env.M59_SWARM_DIR || join(root, 'substrate', 'swarm');
export const statePath = (fleet, root) => join(swarmDir(root), `${fleet || 'default'}.json`);
export const sightingDir = (fleet, root) => join(swarmDir(root), fleet || 'default');

// ATOMIC, AND PATIENT ABOUT WINDOWS. Renaming over a file another process has open fails with
// EPERM or EBUSY on Windows, and every keeper reads the state file once a second -- the first lab
// swarm's driver died of exactly this after about twenty minutes. So the rename is retried for a
// moment, and a write that still fails throws to a caller that treats it as one missed beat.
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, path); return; }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code) || attempt >= 20) throw e;
      pause(10 + attempt * 5);
    }
  }
}
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

export const readState = (fleet, root) => readJson(statePath(fleet, root));
export const writeState = (fleet, state, root) => writeAtomic(statePath(fleet, root), state);
export const writeSighting = (fleet, agent, sighting, root) =>
  writeAtomic(join(sightingDir(fleet, root), `${agent}.json`), sighting);
export function readSightings(fleet, { now = Date.now(), root } = {}) {
  const dir = sightingDir(fleet, root);
  let files = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
  return files.map(f => readJson(join(dir, f))).filter(s => s && now - Number(s.at) < SIGHTING_FRESH_MS);
}

/** Is a swarm on, and is this keeper's agent one of its members? */
export function membership(state, agent) {
  if (!state?.leader || state.ended_at) return { on: false };
  const m = state.members?.[agent];
  return { on: true, member: !!m, leader: state.leader, phase: state.phase ?? 'following', home: m?.home_room ?? null };
}

/**
 * May this character be in the swarm? Every refusal names itself, because the driver logs it and
 * "why is Robin not following me" has to be answerable from the log.
 */
export function eligibility(s, { minMaxHealth = SWARM_MIN_MAX_HEALTH, leader } = {}) {
  if (!s) return { ok: false, why: 'no sighting' };
  if (s.agent === leader) return { ok: false, why: 'the leader' };
  if (s.host) return { ok: false, why: 'a menagerie host' };
  if (s.noncombatant) return { ok: false, why: 'a war noncombatant' };
  if (s.piloted) return { ok: false, why: 'held by a human client' };
  if (!(Number(s.max_health) >= minMaxHealth))
    return { ok: false, why: `max health ${s.max_health ?? 'unread'} is under ${minMaxHealth}` };
  if (!(Number(s.room) > 1)) return { ok: false, why: 'not in a map (Underworld or unknown)' };
  return { ok: true };
}

/** The leader's room NUMBER, from the freshest keeper that can see him. */
export function leaderRoom(sightings) {
  const seeing = sightings.filter(s => s.sees_leader && Number(s.room) > 1).sort((a, b) => b.at - a.at);
  return seeing.length ? Number(seeing[0].room) : null;
}

// ------------------------------------------------------------------ the wedge

/** Unit heading from two squares (row, col), or null when they are the same square. */
export function headingBetween(from, to) {
  const dr = Number(to.row) - Number(from.row), dc = Number(to.col) - Number(from.col);
  const n = Math.hypot(dr, dc);
  return n > 0 ? { dr: dr / n, dc: dc / n } : null;
}

/**
 * Slot `index` of a wedge behind a leader at `leader` heading `heading` (a unit {dr, dc}).
 * Index 0 is directly behind-left, 1 behind-right, 2 two back on the left, ... -- a V that
 * opens behind him. Squares are rounded, so neighbours never share one at spacing >= 1.
 */
export function wedgeSlot(leader, heading, index, spacing = SPACING) {
  const rank = Math.floor(index / 2) + 1;
  const side = index % 2 === 0 ? -1 : 1;
  // Behind = minus heading. Perpendicular = heading rotated a quarter turn.
  const back = { dr: -heading.dr, dc: -heading.dc };
  const perp = { dr: -heading.dc, dc: heading.dr };
  return {
    row: Math.round(Number(leader.row) + (back.dr * rank + perp.dr * side * rank) * spacing),
    col: Math.round(Number(leader.col) + (back.dc * rank + perp.dc * side * rank) * spacing),
  };
}

/**
 * Which slot is mine: members in the room, sorted by agent id, so every follower in the room
 * computes the same assignment from the same view without talking to the others.
 */
export function slotIndex(agent, presentMembers) {
  const order = [...new Set([...presentMembers, agent])].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return order.indexOf(agent);
}

export const chebyshev = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));

/**
 * The heading a still leader is assumed to face: away from where his swarm already stands, so a
 * wedge forms on the side it is already on instead of every follower crossing over him.
 */
export function restingHeading(leader, followers) {
  if (!followers.length) return { dr: -1, dc: 0 };
  const mean = { row: followers.reduce((s, f) => s + f.row, 0) / followers.length,
                 col: followers.reduce((s, f) => s + f.col, 0) / followers.length };
  return headingBetween(mean, leader) ?? { dr: -1, dc: 0 };
}

// ------------------------------------------------------------------ which door he took

/**
 * The room the leader most likely went to, from the last square he was seen on in this room.
 * A `go` exit within reach of that square wins; otherwise a room edge he was standing against.
 * Null when neither is close enough -- the follower then waits for the driver's sighting of
 * where he is, rather than guessing a door.
 */
export function inferExit(room, lastSeen, { reach = 3 } = {}) {
  if (!room || !lastSeen) return null;
  const open = (room.goExits ?? []).filter(e => !e.locked && Number(e.to) > 0 && Number(e.to) !== Number(room.num));
  let best = null;
  for (const e of open) {
    const d = Math.hypot(e.row - lastSeen.row, e.col - lastSeen.col);
    if (d <= reach && (!best || d < best.d)) best = { d, to: Number(e.to), via: `door r${e.row}c${e.col}` };
  }
  if (best) return best;
  const edge = side => (room.edgeExits ?? []).find(e => e.leaveName === side && Number(e.to) > 0);
  const near = 2;
  const sides = [];
  if (lastSeen.row <= near) sides.push('north');
  if (lastSeen.row >= (room.rows ?? Infinity) - near + 1) sides.push('south');
  if (lastSeen.col <= near) sides.push('west');
  if (lastSeen.col >= (room.cols ?? Infinity) - near + 1) sides.push('east');
  for (const side of sides) { const e = edge(side); if (e) return { d: 0, to: Number(e.to), via: `${side} edge` }; }
  return null;
}
