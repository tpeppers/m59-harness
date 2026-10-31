// m59-player-health.mjs — HOW HURT ANOTHER PLAYER IS, READ OFF THE GROAN THE SERVER PLAYS WHEN THEY ARE HIT.
//
// A player's health is never sent to anybody else. But every time a player takes damage the server plays a
// pain sound to the whole room, attached to the hurt player's object, and it CHOOSES THE SOUND BY THEIR HEALTH
// (kod player.kod `GetOuchSound`, sent through `SomethingWaveRoom` with #what = the hurt player):
//
//     ouchm1 / ouchf1   health above 75%
//     ouchm2 / ouchf2   above 50%
//     ouchm3 / ouchf3   above 25%
//     ouchm4 / ouchf4   25% or less
//
// So each groan is a four-band reading of that player's health at the moment of the blow, heard by every
// fleet character in the room. The client turns a BP_PLAY_WAVE carrying one of those eight sounds into a
// `groan` event (m59-client.mjs); CombatMode records it here for players who are not ours; and because the
// book is a shared file, a character one map away knows how hurt an enemy was when it walked out the door.
//
// It is an estimate with two honest limits: a band is a RANGE (a 26% and a 50% player groan alike), and it is
// a reading at the last blow -- a player who has since healed still reads as they last groaned. `age_ms` says
// how old it is; a reader decides what is too old.

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');

/** band -> the health percentage range it proves (inclusive). */
export const GROAN_BANDS = Object.freeze({
  1: Object.freeze({ min_pct: 76, max_pct: 100 }),
  2: Object.freeze({ min_pct: 51, max_pct: 75 }),
  3: Object.freeze({ min_pct: 26, max_pct: 50 }),
  4: Object.freeze({ min_pct: 0, max_pct: 25 }),
});

/** 'ouchm3' -> { band: 3, gender: 'm' }, anything else -> null. */
export function groanBand(stem) {
  const m = /^ouch([mf])([1-4])$/i.exec(String(stem ?? ''));
  return m ? { band: Number(m[2]), gender: m[1].toLowerCase() } : null;
}

export const HEALTH_FILE = () => {
  if (process.env.M59_PLAYER_HEALTH_FILE) return process.env.M59_PLAYER_HEALTH_FILE;
  let name = null;
  try { name = fleetName(); } catch { name = null; }
  return join(HERE, 'substrate', name ? `player-health-${name}.jsonl` : 'player-health.jsonl');
};

const norm = n => String(n ?? '').trim().replace(/\s+/g, ' ').slice(0, 64).toLowerCase();
const lastWritten = new Map();
const MAX_BYTES = 256 * 1024, TAIL_BYTES = 64 * 1024;

/** Append one groan. The same player and band from this process is written at most once a second. */
export function recordGroan({ name, band, room = null, reporter = null, at = Date.now() }) {
  if (!name || !GROAN_BANDS[band]) return false;
  const key = `${norm(name)}|${band}`;
  if (at - (lastWritten.get(key) ?? -Infinity) < 1000) return false;
  lastWritten.set(key, at);
  if (lastWritten.size > 512) lastWritten.clear();
  const file = HEALTH_FILE();
  try {
    mkdirSync(dirname(file), { recursive: true });
    try { if (statSync(file).size > MAX_BYTES) writeFileSync(file, ''); } catch { /* absent */ }
    appendFileSync(file, JSON.stringify({ at, name, band, room: Number(room) || null, reporter }) + '\n');
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

/** The latest groan-based reading for a player, or null when none is younger than `maxAgeMs`. */
export function latestHealth(name, { now = Date.now(), maxAgeMs = 120_000, file = HEALTH_FILE() } = {}) {
  const k = norm(name);
  if (!k) return null;
  const rows = tail(file, now);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (norm(r.name) !== k) continue;
    if (!(now - Number(r.at) <= maxAgeMs) || !GROAN_BANDS[r.band]) return null;
    return { band: r.band, ...GROAN_BANDS[r.band], at: Number(r.at), age_ms: now - Number(r.at), room: r.room ?? null, reporter: r.reporter ?? null };
  }
  return null;
}

/** Every groan heard in one room at or after `since`, oldest first: [{ at, name, band, reporter }]. */
export function roomGroans(room, { since = 0, now = Date.now(), file = HEALTH_FILE() } = {}) {
  return tail(file, now)
    .filter(r => Number(r.room) === Number(room) && Number(r.at) >= since && Number(r.at) <= now && GROAN_BANDS[r.band])
    .map(r => ({ at: Number(r.at), name: r.name, band: r.band, reporter: r.reporter ?? null }))
    .sort((a, b) => a.at - b.at);
}

/** Forget the read cache (tests). */
export const resetHealthCache = () => { cache = { file: null, read_at: 0, rows: [] }; lastWritten.clear(); };
