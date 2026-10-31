// m59-pvp-focus.mjs — WHO IN THE FLEET IS HITTING WHICH PLAYER, IN WHICH ROOM, RIGHT NOW.
//
// Every keeper is its own fight: it knows its own target and nobody else's. A strategy that paces by
// how many of us are on one enemy (the `pvpPace` hook, m59-strategies.mjs) needs the fleet's view, so
// every attack a keeper sends at a player -- swing, zap or targeted cast -- appends one line here:
//
//     { at, room, attacker, target }
//
// and every one of its own blows the server confirms DID DAMAGE (CombatMode.observeOwnBlow) appends another,
//
//     { at, room, attacker, target, hit: true }
//
// so a reader can count the distinct attackers per target inside a short window, and separately the distinct
// HITTERS -- whose damage the target actually felt -- inside a shorter one. Like the groan book
// (m59-player-health.mjs) it is a shared file, not a message: a keeper that crashed simply stops
// appearing, and nothing has to be told.
//
// It is written ONLY while some enabled strategy answers `pvpPace` (CombatMode.attackSent). A fleet
// with no such strategy writes nothing and fights exactly as before.
//
// THE FIGHT. "For the rest of combat" needs a start that every keeper agrees on, including one that
// walked in late. The fight in a room is the unbroken run of lines there with no gap longer than
// FIGHT_GAP_MS; `started_at` is its first line. A room that goes quiet for that long is a new fight.

import { appendFileSync, mkdirSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');

/** An attacker who has not sent anything at a target for this long is no longer on it. */
export const FOCUS_WINDOW_MS = 8000;
/** A hitter whose last confirmed hit on a target is older than this is no longer counted on it. */
export const HIT_WINDOW_MS = 4000;
/** A room with no attack line for this long has finished its fight. */
export const FIGHT_GAP_MS = 30_000;

export const FOCUS_FILE = () => {
  if (process.env.M59_PVP_FOCUS_FILE) return process.env.M59_PVP_FOCUS_FILE;
  let name = null;
  try { name = fleetName(); } catch { name = null; }
  return join(HERE, 'substrate', name ? `pvp-focus-${name}.jsonl` : 'pvp-focus.jsonl');
};

const norm = n => String(n ?? '').trim().replace(/\s+/g, ' ').slice(0, 64).toLowerCase();
const lastWritten = new Map();
const MAX_BYTES = 256 * 1024, TAIL_BYTES = 64 * 1024;

/** Append one attack, or with `hit` one confirmed hit. Each kind per attacker and target at most twice a second. */
export function recordFocus({ room, attacker, target, hit = false, at = Date.now() }) {
  if (!(Number(room) > 1) || !attacker || !target) return false;
  const key = `${norm(attacker)}|${norm(target)}|${hit ? 'hit' : 'sent'}`;
  if (at - (lastWritten.get(key) ?? -Infinity) < 500) return false;
  lastWritten.set(key, at);
  if (lastWritten.size > 512) lastWritten.clear();
  const file = FOCUS_FILE();
  try {
    mkdirSync(dirname(file), { recursive: true });
    try { if (statSync(file).size > MAX_BYTES) writeFileSync(file, ''); } catch { /* absent */ }
    appendFileSync(file, JSON.stringify({ at, room: Number(room), attacker, target, ...(hit ? { hit: true } : {}) }) + '\n');
    // Our own line must be in our next read: the pace is recomputed the instant a hit is recorded.
    cache.read_at = -Infinity;
    return true;
  } catch { return false; }
}

let cache = { file: null, read_at: 0, rows: [] };
function tail(file, now) {
  if (cache.file === file && now - cache.read_at < 250) return cache.rows;
  let rows = [];
  try {
    const size = statSync(file).size, start = Math.max(0, size - TAIL_BYTES);
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* a torn first line after the cut */ }
      }
    } finally { closeSync(fd); }
  } catch { rows = []; }
  cache = { file, read_at: now, rows };
  return rows;
}

/**
 * The fleet's fight in one room: who is on whom inside the window, who has HIT whom inside the hit window,
 * and when the fight began.
 *   { engaged: [attacker], targets: { <target>: [attacker] }, hitters: { <target>: [attacker] }, started_at }
 * Names keep the spelling of their latest line; lookups should fold case. started_at is null when the
 * room has had no attack line inside FIGHT_GAP_MS.
 */
export function roomFocus(room, { now = Date.now(), windowMs = FOCUS_WINDOW_MS, hitWindowMs = HIT_WINDOW_MS, file = FOCUS_FILE() } = {}) {
  const out = { engaged: [], targets: {}, hitters: {}, started_at: null };
  const rows = tail(file, now).filter(r => Number(r.room) === Number(room) && Number(r.at) <= now)
    .sort((a, b) => a.at - b.at);
  if (!rows.length || now - rows.at(-1).at > FIGHT_GAP_MS) return out;
  let start = rows.at(-1).at;
  for (let i = rows.length - 2; i >= 0 && start - rows[i].at <= FIGHT_GAP_MS; i--) start = rows[i].at;
  out.started_at = start;
  const engaged = new Map(), targets = new Map(), hitters = new Map();
  for (const r of rows) {
    if (r.hit && now - r.at <= hitWindowMs) {
      const h = hitters.get(norm(r.target)) ?? { name: r.target, attackers: new Map() };
      h.name = r.target; h.attackers.set(norm(r.attacker), r.attacker);
      hitters.set(norm(r.target), h);
    }
    if (now - r.at > windowMs) continue;
    engaged.set(norm(r.attacker), r.attacker);
    const t = targets.get(norm(r.target)) ?? { name: r.target, attackers: new Map() };
    t.name = r.target; t.attackers.set(norm(r.attacker), r.attacker);
    targets.set(norm(r.target), t);
  }
  out.engaged = [...engaged.values()];
  for (const t of targets.values()) out.targets[t.name] = [...t.attackers.values()];
  for (const h of hitters.values()) out.hitters[h.name] = [...h.attackers.values()];
  return out;
}

/** Forget the read cache and the write throttle (tests). */
export const resetFocusCache = () => { cache = { file: null, read_at: 0, rows: [] }; lastWritten.clear(); };
