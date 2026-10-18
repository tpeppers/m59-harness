// m59-pvp-callout.mjs — LOUD PVP: A LINE SAID OUT LOUD WHEN A HOSTILE PLAYER ENTERS OUR MAP.
//
// Operator, 2026-10-18: "randomized (said outloud, via say) PVP-activation phrases ... used when a hostile
// target enters the same map as a LOUD PVP target. We want all actual engaging PVP targets to be loud for
// now. It should be a mode that characters can choose to enable and when enabling PVP mode, and anything
// said, quotes should always be included in PvP logs".
//
// THE MODE. A character is loud when its policy says `pvp_loud: true` (autopilot start/set), or while a
// combat order it is carrying says `loud` (combat / combat_order; an order is loud unless it says
// `loud: false`). Silence is the default, so a fresh clone says nothing.
//
// THE MOMENT. CombatMode.scanForEnemies, on a player the war book or the server marks hostile -- or the
// player a combat order names -- who was not in this map a moment ago (ARRIVAL_GAP_MS). One per keeper per
// arrival, after a short random pause, and at most CHORUS loud characters per map per arrival fleet-wide:
// the keepers are separate processes, so they coordinate through callouts-<day>.jsonl beside the PvP log,
// which is also the record of every callout made. Fifteen fighters in Castle Victoria do not all shout.
//
// THE LINES are this machine's: substrate/pvp-callouts.json (gitignored; m59-private carries the fleet's),
// falling back to the committed substrate/pvp-callouts.example.json. Either a bare array of strings or
// { "lines": [...] }. `{enemy}` is replaced with the player's name and `{me}` with the speaker's. Re-read when
// the file changes, so new lines need no restart.
//
// THE LOG. What is said goes out through M59Client.say, whose tap (tapSent 'say') lands in the PvP actions
// file with the text, the say type and -- for a callout -- the player that triggered it. Speech HEARD during
// a PvP window goes to the messages file as kind 'said' with the speaker. The text log (m59-pvp.mjs
// --battle) and the PvP page print both in quotes.
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CALLOUTS_FILE = (env = process.env) => env.M59_PVP_CALLOUTS ?? join(HERE, 'substrate', 'pvp-callouts.json');
export const CALLOUTS_EXAMPLE = join(HERE, 'substrate', 'pvp-callouts.example.json');
export const ARRIVAL_GAP_MS = 120_000;     // gone this long from the map, then back, is a new arrival
export const CHORUS_WINDOW_MS = 30_000;    // callouts at one arrival, fleet-wide, are counted over this
export const CHORUS = 2;                   // ...and at most this many loud characters speak to it
export const MAX_PAUSE_MS = 1_500;         // the random pause before speaking, so the chorus is not one tick
export const STARTUP_QUIET_MS = 15_000;    // a keeper just started sees everyone as "arriving"

export function parseCallouts(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.lines) ? raw.lines : null;
  if (!list) throw new Error('callouts: expected an array of lines or { "lines": [...] }');
  const lines = list.map(s => String(s ?? '').trim()).filter(Boolean);
  if (!lines.length) throw new Error('callouts: no lines');
  if (lines.some(l => l.length > 200)) throw new Error('callouts: a line is longer than 200 characters');
  return lines;
}

const cache = { file: null, mtime: 0, lines: null, error: null };
/** The lines in force: the local file, else the example. Never throws; `error` says why it fell back. */
export function loadCallouts({ file = CALLOUTS_FILE(), example = CALLOUTS_EXAMPLE } = {}) {
  for (const f of [file, example]) {
    try {
      if (!existsSync(f)) continue;
      const mtime = statSync(f).mtimeMs;
      if (cache.file === f && cache.mtime === mtime && cache.lines) return { lines: cache.lines, file: f, error: null };
      const lines = parseCallouts(JSON.parse(readFileSync(f, 'utf8')));
      Object.assign(cache, { file: f, mtime, lines, error: null });
      return { lines, file: f, error: null };
    } catch (e) { cache.error = `${f}: ${e.message}`; }
  }
  return { lines: [], file: null, error: cache.error ?? 'no callout lines' };
}

/** A random line, avoiding the ones said most recently (fleet-wide), with {enemy}/{me} filled in. */
export function pickCallout(lines, { recent = [], enemy = '', me = '', random = Math.random } = {}) {
  if (!lines?.length) return null;
  const used = new Set(recent);
  const fresh = lines.map((l, i) => i).filter(i => !used.has(i));
  const pool = fresh.length ? fresh : lines.map((l, i) => i);
  const index = pool[Math.floor(random() * pool.length) % pool.length];
  const text = lines[index].replaceAll('{enemy}', String(enemy)).replaceAll('{me}', String(me)).replace(/\s+/g, ' ').trim();
  return { index, text };
}

const dayOf = at => new Date(at).toISOString().slice(0, 10);
function tailRows(file, bytes = 32_768) {
  try {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size, len = Math.min(size, bytes), buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const out = [];
      for (const line of buf.toString('utf8').split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch {} }
      return out;
    } finally { closeSync(fd); }
  } catch { return []; }
}
/** Recent callout rows, fleet-wide (today's and, near midnight, yesterday's file). */
export function recentCallouts(dir, now = Date.now(), windowMs = 10 * 60_000) {
  const files = [...new Set([dayOf(now - windowMs), dayOf(now)])].map(d => join(dir, `callouts-${d}.jsonl`));
  return files.flatMap(f => tailRows(f)).filter(r => r.at >= now - windowMs && r.at <= now + 5_000);
}

/** May this character speak to this arrival? The fleet-wide chorus cap, and never twice itself. */
export function chorusVerdict(rows, { room, player, speaker, now = Date.now(), chorus = CHORUS, windowMs = CHORUS_WINDOW_MS }) {
  const key = String(player).toLowerCase();
  const same = rows.filter(r => r.room === room && String(r.player).toLowerCase() === key && now - r.at <= windowMs);
  if (same.some(r => String(r.speaker).toLowerCase() === String(speaker).toLowerCase())) return { speak: false, why: 'already spoke to this arrival' };
  if (same.length >= chorus) return { speak: false, why: `chorus full (${same.length}/${chorus})` };
  return { speak: true, why: `chorus ${same.length + 1}/${chorus}` };
}
