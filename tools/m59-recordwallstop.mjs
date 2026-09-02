#!/usr/bin/env node
// A WALL STOP THAT KILLED, AS A FIXTURE.
//
// The record of 2026-09-02, both fleets: a traveller in a room of nine to eighteen monsters
// takes "a wall on the way past" — a square the geometry calls unreachable — stands on it,
// is reached anyway, and dies without moving, a median of two to three minutes later. This
// tool turns each such postmortem into a committed fixture, redacted like the jam fixtures
// (nothing naming a character survives), so `m59-wallstop-test.mjs` can pin, on the real
// geometry, that the map DOES offer that square as a wall and that the crowd rule now
// offers no wall there at all.
//
//   node tools/m59-recordwallstop.mjs --from <postmortem dir> [--from <dir>...]
//        [--roster <json>...] [--since <hours>=48] [--min-still <s>=60]
//        [--max-wall-distance <squares>=3] [--out tools/fixtures] [--dry-run]
//
// A fixture is one SPOT (room + square the body died standing on); several deaths on the
// same spot become `occurrences[]` of one fixture. What each carries: the room, the stop
// square, the wall the keeper chose and what the geometry claimed for it (`can_reach_you`,
// `free_shots`, `back_cover`), the monsters present and the most seen at once, how long the
// body stood, the health trail, the hits that landed while it stood there and who landed
// them, the last decisions, and the server's own last sentences — every player name in any
// of it replaced by a role.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { makeRedactor } from './m59-recordjam.mjs';

export const FORMAT = 'm59-wallstop/1';

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const flags = (name) => argv.map((a, i) => a === '--' + name ? argv[i + 1] : null).filter(Boolean);
const has = (name) => argv.includes('--' + name);

// Every string under a name-like key in a roster file is a name to redact. The roster's
// shape is not this tool's business, and a password is never a name-like key.
export function rosterNamesFrom(files) {
  const names = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (/^(character|name|agent|slot|display_name|player)$/i.test(k) && typeof x === 'string') names.add(x);
      else if (typeof x === 'object') walk(x);
    }
  };
  for (const f of files) { try { walk(JSON.parse(readFileSync(f, 'utf8'))); } catch { /* not a roster */ } }
  return names;
}

export function parsePostmortemTime(file) {
  const m = basename(file).match(/(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d\d\d)Z/);
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`).getTime() : null;
}

const WALL_WORDS = /taking a wall on the way past|took a safe spot|resting at a refuge on the way|rested at a wall mid-journey/;

// One postmortem -> one occurrence, or null when it is not a wall stop that killed.
export function occurrenceFrom(j, at, { minStillMs = 60_000, maxWallDistance = 3, redact } = {}) {
  const decs = Array.isArray(j.decisions) ? j.decisions : [];
  const wallDecs = decs.filter(d => WALL_WORDS.test(String(d?.what ?? '')));
  if (!wallDecs.length) return null;
  const stood = Number(j.was?.ms_since_moved ?? 0);
  if (!(stood >= minStillMs)) return null;
  const stop = { row: Number(j.where?.row), col: Number(j.where?.col) };
  if (!Number.isFinite(stop.row) || !Number.isFinite(stop.col)) return null;
  const chosen = wallDecs.at(-1);
  const wallSq = chosen?.where ?? j.was?.in_safe_spot ?? null;
  const wall = wallSq && Number.isFinite(Number(wallSq.row))
    ? { row: Number(wallSq.row), col: Number(wallSq.col),
        claims: { can_reach_you: chosen?.can_reach_you ?? null, free_shots: chosen?.free_shots ?? null,
                  back_cover: chosen?.back_cover ?? null, proven_before: chosen?.proven_before ?? null,
                  proven: j.was?.in_safe_spot?.proven ?? null },
        decided_ms_before_death: Number.isFinite(Number(chosen?.at)) ? at - Number(chosen.at) : null }
    : null;
  const dist = wall ? Math.max(Math.abs(wall.row - stop.row), Math.abs(wall.col - stop.col)) : Infinity;
  if (dist > maxWallDistance) return null;
  const hits = (Array.isArray(j.hits) ? j.hits : []).filter(h => at - Number(h.last_at ?? 0) <= stood + 5_000);
  const onStop = hits.filter(h => Number(h.row) === stop.row && Number(h.col) === stop.col);
  const R = redact ?? ((s) => s);
  const red = (s) => String(s ?? '').replace(/\b([A-Z][a-z]{2,})\b/g, (w) => R(w, true) === w ? w : R(w, true));
  return {
    fleet_role: null,                                   // filled by the caller: 'prod' | 'shadow'
    at: new Date(at).toISOString(),
    room: { num: Number(j.where?.num), name: String(j.where?.room ?? '') },
    stop, wall, wall_distance: Number.isFinite(dist) ? dist : null,
    stood_ms: stood,
    subject: { level: j.vitals?.level ?? null, max_health: Math.max(0, ...hits.map(h => Number(h.max) || 0), Number(j.frames?.at?.(-1)?.max) || 0) || null,
               health_trail: Array.isArray(j.vitals?.trail) ? j.vitals.trail.slice(-24) : [],
               health_per_second: j.vitals?.health_per_second ?? null, flee_threshold: j.vitals?.flee_threshold ?? null,
               doing_at_death: j.was?.doing ?? null, moving_at_death: j.was?.moving ?? null },
    threats: { most_at_once: j.threats?.most_at_once ?? null,
               present_at_the_end: (j.threats?.present_at_the_end ?? []).slice(0, 24),
               players_present: (j.threats?.players_present ?? []).map(n => R(n, true)) },
    hits_while_standing: hits.map(h => ({ s_before_death: Math.round((at - Number(h.last_at)) / 1000), row: h.row, col: h.col,
                                          doing: h.doing, hits: h.hits, lost: h.lost, health_after: h.health, by: h.by ?? [] })),
    hits_on_the_stop_square: onStop.reduce((a, h) => a + (Number(h.hits) || 0), 0),
    lost_on_the_stop_square: onStop.reduce((a, h) => a + (Number(h.lost) || 0), 0),
    decisions: decs.slice(-8).map(d => ({ s_before_death: Number.isFinite(Number(d?.at)) ? Math.round((at - Number(d.at)) / 1000) : null,
                                         what: red(d?.what), why: red(String(d?.why ?? '').slice(0, 240)),
                                         ...(d?.where ? { where: { row: d.where.row, col: d.where.col } } : {}),
                                         ...(d?.health != null ? { health: d.health } : {}) })),
    last_words: (Array.isArray(j.text) ? j.text : []).slice(-10).map(t => ({ s_before_death: Math.round((at - Number(t.at)) / 1000), text: red(t.text) })),
  };
}

function main() {
  const dirs = flags('from');
  if (!dirs.length) { console.error('usage: --from <postmortem dir> [--roster <json>...] [--since h] [--min-still s] [--max-wall-distance n] [--out dir] [--dry-run]'); process.exit(2); }
  const sinceMs = Number(flag('since', 48)) * 3600e3;
  const minStillMs = Number(flag('min-still', 60)) * 1000;
  const maxWallDistance = Number(flag('max-wall-distance', 3));
  const out = flag('out', 'tools/fixtures');
  const rosterFiles = flags('roster');
  for (const d of ['substrate/fleets']) if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith('.json')) rosterFiles.push(join(d, f));
  if (existsSync('substrate/fleet-state.json')) rosterFiles.push('substrate/fleet-state.json');
  const names = rosterNamesFrom(rosterFiles);
  const spots = new Map();
  let seen = 0, kept = 0;
  const now = Date.now();
  for (const dir of dirs) {
    const fleetRole = /prod/i.test(dir) ? 'prod' : /shadow|mindmap/i.test(dir) ? 'shadow' : 'unknown';
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const at = parsePostmortemTime(f); if (!at || now - at > sinceMs) continue;
      let j; try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
      seen++;
      // the subject's own names are roster names too, whatever the roster files say
      const subjectNames = new Set([...names, j.character, j.agent].filter(Boolean));
      const redact = makeRedactor(subjectNames);
      const occ = occurrenceFrom(j, at, { minStillMs, maxWallDistance, redact });
      if (!occ) continue;
      // The agent alias says which fleet better than the directory does: t1..t21 is prod's
      // roster and shadowNN the shadow fleet's; anything else keeps the directory's guess.
      occ.fleet_role = /^t\d+$/.test(String(j.agent ?? '')) ? 'prod'
                     : /^shadow\d+$/.test(String(j.agent ?? '')) ? 'shadow' : fleetRole;
      kept++;
      const key = `${occ.room.num}-r${occ.stop.row}c${occ.stop.col}`;
      if (!spots.has(key)) spots.set(key, { format: FORMAT, captured_at: new Date(now).toISOString(), room: occ.room, stop: occ.stop,
        why: 'A traveller took "a wall on the way past" here, stood on it, was reached anyway, and died without moving. ' +
             'The geometry offered the square; the crowd rule now offers no wall in a room this full. m59-wallstop-test.mjs pins both.',
        coordinate_note: 'row/col are coarse grid squares (rNcM); hits carry the square the blow landed on',
        occurrences: [] });
      spots.get(key).occurrences.push(occ);
    }
  }
  console.log(`${seen} postmortem(s) read, ${kept} wall-stop death(s) kept, ${spots.size} spot(s)`);
  for (const [key, fx] of [...spots.entries()].sort((a, b) => b[1].occurrences.length - a[1].occurrences.length)) {
    const o = fx.occurrences;
    const most = Math.max(...o.map(x => x.threats.most_at_once || 0));
    const stood = Math.round(Math.max(...o.map(x => x.stood_ms)) / 1000);
    console.log(`  ${key.padEnd(16)} ${String(o.length).padStart(2)}x  ${String(fx.room.name).slice(0, 26).padEnd(26)} most x${String(most).padEnd(3)} stood up to ${stood}s  fleets ${[...new Set(o.map(x => x.fleet_role))].join('+')}`);
    if (has('dry-run')) continue;
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `wallstop-${key}.json`), JSON.stringify(fx, null, 1) + '\n');
  }
  if (!has('dry-run')) console.log(`written to ${out}/wallstop-*.json`);
}

if (process.argv[1] && /m59-recordwallstop\.mjs$/.test(process.argv[1])) main();
