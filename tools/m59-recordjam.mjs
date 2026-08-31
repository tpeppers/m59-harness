#!/usr/bin/env node
// m59-recordjam.mjs — RECORD JAM: every monster and person visible in one patch of one
// room, sampled for a few seconds, compressed to what moved and what did not, with the
// real fine-grid floor under it — so a live traffic jam can become an offline test.
//
//   node tools/m59-recordjam.mjs --room 108 --region 38,25-48,29
//   node tools/m59-recordjam.mjs --room "Sewers" --around 43,27 --radius 6 --seconds 8
//   node tools/m59-recordjam.mjs --room 108 --region 38,25-48,29 --out tools/fixtures/sewers-108-row27.json
//
// WHY. On 2026-08-27 three characters spent half a minute wiggling on row 27 of the Sewers
// of Barloque against a picket line of six giant rats, one per square centre, 64 units
// apart. Read at SQUARE resolution that is "a rat on every square, therefore blocked"; read
// at FINE resolution it is six exclusion zones of 16 units in a corridor wider than that —
// exactly the claim m59-needle-test.mjs pins for the Twisted Wood. The operator wanted the
// exact positions to write the same test for the sewers, and by the time they had been
// copied down by hand once, the next jam would have to be copied down by hand again.
//
// WHAT IT READS. The fleet's own keepers, over loopback: `/live` discovers process/session
// identity cheaply, then every keeper of the resolved fleet that is standing in the room is
// an observer and their demand-built `/state` object lists are unioned per sample. Nothing
// is sent to the game server — a keeper's room contents are already in memory — so sampling
// once a second costs the wire nothing. An older keeper with no `/live` may be discovered
// through its legacy `/health`, but ONLY after a definite 404/405; a timeout is silence, not
// permission to make the same busy event loop build an enriched health snapshot. It never
// starts a broker and never logs anybody in; if no keeper of this fleet is in the room it
// says so and exits 2, because a recording of an empty room is not a recording.
//
// WHAT IT WRITES. `m59-jam/1`: the room and its .roo, the region, then `static` (units seen
// at one position for the whole recording — one line each, with how many samples saw them)
// and `moving` (units with a trace of distinct positions and when each was first seen). And
// the ground: for every column of the region the fine y-extent of the floor and for every
// row the x-extent, measured off the BSP the way the needle suite measures it, because a
// test that only had the bodies would have to guess the corridor.
//
// NAMES ARE REDACTED BY DEFAULT. A fixture is committed, and nothing naming a character is
// — this fleet's rule, enforced elsewhere by the bard guard. Players become "player A",
// "player B"… in order of appearance (strangers "stranger A"…), stably within one file;
// monsters keep their names because a giant rat is not anybody. `--names` keeps real names
// for a local recording and refuses to write one under `tools/`.
//
// Everything that decides is a pure function exported below, and m59-recordjam-test.mjs
// drives those; only `main` touches the network.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFleet } from './m59-fleetpath.mjs';
import { sharedRoomGeometry, protocolToClient, KOD_FINENESS } from './m59-roo.mjs';
import { OF } from './m59-parse.mjs';
import { KEEPER_BAND_WIDTH, lookupKeeperBand } from './runtime/keeper-bands.mjs';

// WHAT A UNIT IS, from the flag word the server sent and not from its name: a player, a
// monster (attackable and not a player), or an item lying on the floor — an emerald on
// the square is not a body and a test that counted it as one would refuse a passable gap.
export function kindOf(u) {
  if (u.is_player || (u.flags & OF.PLAYER)) return 'player';
  if (u.flags == null) return 'monster';                 // an observer's own body, or an old keeper
  return (u.flags & OF.ATTACKABLE) ? 'monster' : 'item';
}

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');
export const FORMAT = 'm59-jam/1';

// ---------------------------------------------------------------- the region
//
// CLI CONTRACT: this tool defines `--region` as `c1,r1-c2,r2` and `--around` as
// `col,row`. That is recordjam's movement-facing order, not a repository-wide convention.
// A region is inclusive at both ends and accepts either corner first.
export function parseRegion(text) {
  const m = String(text ?? '').trim().match(/^(\d+)\s*,\s*(\d+)\s*-\s*(\d+)\s*,\s*(\d+)$/);
  if (!m) return null;
  const [c1, r1, c2, r2] = m.slice(1).map(Number);
  return { c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) };
}

export function regionAround(col, row, radius = 4) {
  const r = Math.max(0, Math.floor(radius));
  return { c1: Math.max(0, col - r), r1: Math.max(0, row - r), c2: col + r, r2: row + r };
}

export const inRegion = (o, region) =>
  !region || (o.col >= region.c1 && o.col <= region.c2 && o.row >= region.r1 && o.row <= region.r2);

// ---------------------------------------------------------------- redaction
//
// Roster names are this fleet's characters; anybody else in the room is a stranger and a
// real person, and neither belongs in a committed file. Roles are handed out in order of
// first appearance and are stable for the life of the redactor, so one file is consistent.
export function makeRedactor(rosterNames = new Set(), { keepNames = false } = {}) {
  const fold = n => String(n ?? '').trim().toLowerCase();
  const roster = new Set([...rosterNames].map(fold));
  const roles = new Map();
  let ours = 0, theirs = 0;
  const letter = i => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
  return (name, isPlayer) => {
    if (!isPlayer || keepNames) return name;
    const key = fold(name);
    if (!roles.has(key))
      roles.set(key, roster.has(key) ? `player ${letter(ours++)}` : `stranger ${letter(theirs++)}`);
    return roles.get(key);
  };
}

// ---------------------------------------------------------------- compression
//
// A sample is { t_ms, units: [{ key, name, is_player, col, row, x, y }] }. A player is keyed
// by NAME because two observers report the same person under the same name but the observer
// itself is absent from its own list; a monster is keyed by object id, which is unique for
// the life of a recording (ids only move on a server save, and a save mid-recording would
// show as a unit vanishing and a new one appearing, which is the truth).
// IDENTITY IS NOT KIND. The key names WHICH body this is and nothing else — a player by
// name, anything else by object id, which is unique across monsters and items alike — so it
// can be computed once, before names are redacted, and never forks a unit into two.
export const unitKey = o => (o.is_player || (o.flags & OF.PLAYER)
  ? `p:${String(o.name).toLowerCase()}` : `o:${o.id}`);

export function compress(samples) {
  const seen = new Map();
  for (const s of samples) {
    for (const u of s.units) {
      const k = u.key ?? unitKey(u);
      let rec = seen.get(k);
      if (!rec) {
        rec = { key: k, name: u.name, kind: kindOf(u), points: [], seen: 0 };
        seen.set(k, rec);
      }
      rec.seen++;
      const last = rec.points[rec.points.length - 1];
      if (!last || last.x !== u.x || last.y !== u.y)
        rec.points.push({ t_ms: s.t_ms, col: u.col, row: u.row, x: u.x, y: u.y });
    }
  }
  const all = [...seen.values()];
  const byPlace = (a, b) => a.points[0].row - b.points[0].row || a.points[0].x - b.points[0].x;
  const isStatic = r => r.points.length === 1;
  return {
    static: all.filter(isStatic).sort(byPlace)
      .map(r => ({ name: r.name, kind: r.kind, ...r.points[0], t_ms: undefined, seen: r.seen })),
    moving: all.filter(r => !isStatic(r)).sort(byPlace)
      .map(r => ({ name: r.name, kind: r.kind, seen: r.seen, points: r.points })),
  };
}

// ---------------------------------------------------------------- the ground
//
// Floor extents off the BSP, the needle suite's measure: for a column, the lowest and
// highest fine y at which any x across the column has floor; for a row, the same in x.
// Sampled every 2 units along the axis being measured and every 8 across it.
export function floorExtents(geo, region) {
  const floorAt = (x, y) => {
    try { return !!geo.leafAtClient(protocolToClient(x), protocolToClient(y)); } catch { return false; }
  };
  const byCol = {}, byRow = {};
  const y0 = region.r1 * KOD_FINENESS, y1 = (region.r2 + 1) * KOD_FINENESS;
  const x0 = region.c1 * KOD_FINENESS, x1 = (region.c2 + 1) * KOD_FINENESS;
  for (let col = region.c1; col <= region.c2; col++) {
    let lo = null, hi = null;
    for (let y = y0; y < y1; y += 2)
      for (let x = col * KOD_FINENESS + 4; x < (col + 1) * KOD_FINENESS; x += 8)
        if (floorAt(x, y)) { lo ??= y; hi = y; break; }
    byCol[col] = { lo, hi };
  }
  for (let row = region.r1; row <= region.r2; row++) {
    let lo = null, hi = null;
    for (let x = x0; x < x1; x += 2)
      for (let y = row * KOD_FINENESS + 4; y < (row + 1) * KOD_FINENESS; y += 8)
        if (floorAt(x, y)) { lo ??= x; hi = x; break; }
    byRow[row] = { lo, hi };
  }
  return { floor_y_by_col: byCol, floor_x_by_row: byRow,
           note: 'fine kod units, 64 per square; null means no floor found in that column/row of the region' };
}

// ---------------------------------------------------------------- the record
export function buildJam({ room, region, samples, redact, seconds, intervalMs, observers, geometry, fleet }) {
  // KEYS BEFORE NAMES. A unit keyed by its real name in one sample and by its role in the
  // next is two units; the first fixture built through this had every player twice.
  const redacted = samples.map(s => ({
    t_ms: s.t_ms,
    units: s.units.map(u => {
      const isPlayer = !!(u.is_player || (u.flags & OF.PLAYER));
      return { ...u, key: u.key ?? unitKey(u), is_player: isPlayer, name: redact(u.name, isPlayer) };
    }),
  }));
  const { static: still, moving } = compress(redacted);
  return {
    format: FORMAT,
    captured_at: new Date(samples[0]?.at ?? Date.now()).toISOString(),
    fleet: fleet ?? null,
    room: { num: room.num, name: room.name, roo: room.rooFile ?? null,
            cols: room.cols ?? null, rows: room.rows ?? null },
    region,
    units_note: 'fine coordinates are kod units, 64 per coarse square; col = floor(x/64), row = floor(y/64). ' +
                'A body blocks a move that would END within 16 units of its centre (MIN_NOMOVEON) — see m59-needle-test.mjs',
    seconds, interval_ms: intervalMs, samples: samples.length,
    observers: observers.map(o => redact(o, true)),
    static: still,
    moving,
    geometry,
  };
}

export function summarise(jam) {
  const lines = [];
  lines.push(`${jam.room.name} (${jam.room.num}, ${jam.room.roo ?? '?'}) — region ${jam.region.c1},${jam.region.r1}-${jam.region.c2},${jam.region.r2} — ` +
             `${jam.samples} sample(s) over ${jam.seconds}s, seen by ${jam.observers.length} observer(s)`);
  lines.push(`static (${jam.static.length}):`);
  for (const u of jam.static)
    lines.push(`  ${u.name.padEnd(16)} ${u.kind.padEnd(7)} col ${String(u.col).padStart(2)} row ${String(u.row).padStart(2)}  x ${String(u.x).padStart(5)} y ${String(u.y).padStart(5)}  seen ${u.seen}x`);
  lines.push(`moving (${jam.moving.length}):`);
  for (const u of jam.moving)
    lines.push(`  ${u.name.padEnd(16)} ${u.kind.padEnd(7)} ${u.points.map(p => `${p.x},${p.y}@${(p.t_ms / 1000).toFixed(0)}s`).join(' -> ')}`);
  const cols = Object.entries(jam.geometry?.floor_y_by_col ?? {});
  if (cols.length)
    lines.push('floor y-extent by column: ' + cols.map(([c, e]) => `${c}:${e.lo ?? '-'}..${e.hi ?? '-'}`).join('  '));
  return lines;
}

// ---------------------------------------------------------------- finding observers
//
// The keepers of this fleet, by asking every port in the fleet's band who they are. The
// band comes from substrate/keeper-bands.json exactly as the broker allocates it; a keeper
// can be re-allocated off its default port, which is why this scans rather than computes.
//
// IDENTITY FIRST, ENRICHMENT SECOND. `/live` is intentionally too small to name a room;
// discovery asks `/state` once only after a live keeper has identified itself. The same
// endpoint supplies the recording frames below, so `/health` is no longer a hidden full-
// snapshot API contract.
const identityFold = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
const explicitlyNotLive = value => value?.in_game === false || value?.connected === false || value?.ok === false;
export const RECORDING_STATE_MAX_AGE_MS = 2500;

const recordingStateAgeIsBounded = value =>
  typeof value?.as_of_ms === 'number' && Number.isFinite(value.as_of_ms) &&
  value.as_of_ms >= 0 && value.as_of_ms <= RECORDING_STATE_MAX_AGE_MS;

async function cancelResponseBody(response) {
  try { await response?.body?.cancel?.(); } catch { /* best-effort connection reuse */ }
}

async function readKeeperJson(url, { timeoutMs, fetchImpl }) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await cancelResponseBody(response);
    return { response, value: null };
  }
  return { response, value: await response.json() };
}

export async function discoverKeeperAtPort(port, { timeoutMs = 4000, fetchImpl = globalThis.fetch } = {}) {
  let identity = null;
  try {
    const live = await readKeeperJson(`http://127.0.0.1:${port}/live`, { timeoutMs, fetchImpl });
    if (live.response.ok) {
      identity = live.value;
    } else if (live.response.status === 404 || live.response.status === 405) {
      // ROLLING-UPGRADE COMPATIBILITY, NOT A SECOND CHANCE AFTER SILENCE. An old keeper
      // predates /live and says so synchronously. A timeout or 5xx can be a keeper busy in
      // one long pass; immediately asking it for the expensive legacy projection doubles
      // the load precisely when it is least able to answer.
      const old = await readKeeperJson(`http://127.0.0.1:${port}/health`, { timeoutMs, fetchImpl });
      if (!old.response.ok) return null;
      identity = old.value;
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const identityAgent = String(identity?.agent ?? '');
  if (!identityAgent || explicitlyNotLive(identity)) return null;
  const identityPid = Number(identity.pid);
  const identityCharacter = identityFold(identity.character);
  // PID is the process generation. Agent aliases and character names can be reused on a
  // newly bound port; without a positive PID there is no fact a later /state frame can be
  // matched against, so this port is not safe to record through.
  if (!Number.isSafeInteger(identityPid) || identityPid <= 0 || !identityCharacter) return null;

  // `/health` is identity-only compatibility. Room selection and every recording frame
  // must come from `/state`, with explicit generation evidence and bounded staleness.
  let state = null;
  try {
    const q = new URLSearchParams({
      agent: identityAgent,
      character: String(identity.character),
      keeper_pid: String(identityPid),
    });
    const current = await readKeeperJson(`http://127.0.0.1:${port}/state?${q}`, { timeoutMs, fetchImpl });
    if (!current.response.ok) return null;
    state = current.value;
  } catch {
    return null;
  }

  // A port can be rebound between the two reads. Never attach another process's room to
  // the identity that answered first, and never record a snapshot too old to bound.
  if (!state || String(state.agent ?? '') !== identityAgent) return null;
  if (explicitlyNotLive(state)) return null;
  const statePid = Number(state.pid);
  if (!Number.isSafeInteger(statePid) || statePid <= 0 || identityPid !== statePid) return null;
  const stateCharacter = identityFold(state.character);
  if (!stateCharacter || stateCharacter !== identityCharacter) return null;
  if (!recordingStateAgeIsBounded(state)) return null;
  return {
    port,
    agent: identityAgent,
    character: state.character,
    pid: identityPid,
    room: state.room ?? null,
  };
}

export async function findKeepers({ fleet, base = null, span = null, timeoutMs = 4000,
                                    fetchImpl = globalThis.fetch } = {}) {
  let start = base;
  if (start == null) {
    const band = lookupKeeperBand(fleet ?? null);
    if (!band) return [];
    start = band.base;
    span ??= band.width;
  }
  span ??= KEEPER_BAND_WIDTH;
  if (!Number.isSafeInteger(start) || start < 1 ||
      !Number.isSafeInteger(span) || span < 1 || start + span - 1 > 65535)
    throw new RangeError('keeper scan must be a bounded positive port range');
  const ports = Array.from({ length: span }, (_, i) => start + i);
  const found = await Promise.all(ports.map(port =>
    discoverKeeperAtPort(port, { timeoutMs, fetchImpl })));
  return found.filter(Boolean);
}

const roomMatches = (room, want) => {
  if (!room) return false;
  if (/^\d+$/.test(String(want))) return Number(room.num) === Number(want);
  return new RegExp(String(want), 'i').test(room.name ?? '');
};

export async function sampleOnce(observers, region, t0,
                                 { timeoutMs = 8000, fetchImpl = globalThis.fetch,
                                   now = Date.now } = {}) {
  const at = now();
  const views = await Promise.all(observers.map(async o => {
    try {
      const q = new URLSearchParams({
        agent: String(o.agent),
        character: String(o.character),
        keeper_pid: String(o.pid),
      });
      const read = await readKeeperJson(`http://127.0.0.1:${o.port}/state?${q}`,
                                       { timeoutMs, fetchImpl });
      if (!read.response.ok) return null;
      const state = read.value;
      // The direct endpoint names itself. A port reallocated between discovery and a
      // sample is a missing observer for this frame, never somebody else's bodies filed
      // under the selected keeper.
      if (String(state?.agent ?? '') !== String(o.agent)) return null;
      const expectedCharacter = identityFold(o.character);
      const observedCharacter = identityFold(state?.character);
      const expectedPid = Number(o.pid);
      const observedPid = Number(state?.pid);
      if (!expectedCharacter || observedCharacter !== expectedCharacter) return null;
      if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0 ||
          !Number.isSafeInteger(observedPid) || observedPid <= 0 || observedPid !== expectedPid) return null;
      if (explicitlyNotLive(state)) return null;
      if (!recordingStateAgeIsBounded(state)) return null;
      return state;
    } catch { return null; }
  }));
  const units = new Map();
  views.forEach((h, i) => {
    if (!h) return;
    const me = h.you;
    if (me && Number.isFinite(me.x))
      units.set(`p:${String(h.character).toLowerCase()}`,
                { key: `p:${String(h.character).toLowerCase()}`, name: h.character, is_player: true,
                  col: me.col, row: me.row, x: me.x, y: me.y, observer: observers[i].agent });
    for (const o of h.objects ?? []) {
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) continue;
      const k = unitKey(o);
      if (!units.has(k))
        units.set(k, { key: k, id: o.id, name: o.name, is_player: !!o.is_player, flags: o.flags,
                       col: o.col, row: o.row, x: o.x, y: o.y });
    }
  });
  return { at, t_ms: at - t0, units: [...units.values()].filter(u => inRegion(u, region)) };
}

// ---------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const argOf = (f, d = null) => { const i = argv.indexOf(`--${f}`); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const has = f => argv.includes(`--${f}`);
  const want = argOf('room');
  if (!want) {
    console.error('usage: node tools/m59-recordjam.mjs --room <num|name> (--region c1,r1-c2,r2 | --around col,row [--radius N]) ' +
                  '[--seconds 5] [--interval 1000] [--out path] [--names] [--fleet name]');
    process.exit(1);
  }
  let region = null;
  if (argOf('region')) {
    region = parseRegion(argOf('region'));
    if (!region) { console.error(`--region wants c1,r1-c2,r2, got "${argOf('region')}"`); process.exit(1); }
  } else if (argOf('around')) {
    const m = String(argOf('around')).match(/^(\d+)\s*,\s*(\d+)$/);
    if (!m) { console.error(`--around wants col,row, got "${argOf('around')}"`); process.exit(1); }
    region = regionAround(Number(m[1]), Number(m[2]), Number(argOf('radius', 4)));
  }
  const seconds = Math.max(1, Number(argOf('seconds', 5)));
  const intervalMs = Math.max(250, Number(argOf('interval', 1000)));
  const keepNames = has('names');

  const fleetInfo = resolveFleet(argv);
  let roster = {};
  try { roster = JSON.parse(readFileSync(fleetInfo.stateFile, 'utf8')); } catch { /* no roster: nobody redacted as ours */ }
  const rosterNames = new Set(Object.values(roster).map(e => e?.credentials?.character).filter(Boolean));

  const keepers = await findKeepers({ fleet: fleetInfo.fleet || null });
  const observers = keepers.filter(k => roomMatches(k.room, want));
  if (!observers.length) {
    console.error(`no keeper of fleet "${fleetInfo.label}" is standing in room "${want}" ` +
                  `(${keepers.length} keeper(s) answered; rooms: ${[...new Set(keepers.map(k => k.room?.num))].join(', ') || 'none'})`);
    process.exit(2);
  }
  const roomNum = observers[0].room.num;
  const map = JSON.parse(readFileSync(join(HERE, 'substrate', 'm59-map.json'), 'utf8'));
  const roomRec = map.rooms?.[String(roomNum)] ?? { num: roomNum, name: observers[0].room.name };
  region ??= { c1: 0, r1: 0, c2: (roomRec.cols ?? 100) - 1, r2: (roomRec.rows ?? 100) - 1 };

  console.error(`recording ${roomRec.name} (${roomNum}) region ${region.c1},${region.r1}-${region.c2},${region.r2} ` +
                `for ${seconds}s every ${intervalMs}ms from ${observers.length} observer(s)`);
  const t0 = Date.now();
  const samples = [];
  const n = Math.floor(seconds * 1000 / intervalMs) + 1;
  for (let i = 0; i < n; i++) {
    const s = await sampleOnce(observers, region, t0);
    samples.push(s);
    const movers = s.units.filter(u => u.is_player).map(u => `${keepNames ? u.name : '·'}${u.x},${u.y}`).join(' ');
    console.error(`  ${String(Math.round(s.t_ms / 1000)).padStart(3)}s  ${s.units.length} unit(s) in region  ${movers}`);
    const next = t0 + (i + 1) * intervalMs;
    if (i < n - 1) await new Promise(r => setTimeout(r, Math.max(0, next - Date.now())));
  }

  let geometry = null;
  try { geometry = floorExtents(sharedRoomGeometry(roomRec), region); }
  catch (e) { geometry = { error: `no geometry: ${e.message}` }; }

  const redact = makeRedactor(rosterNames, { keepNames });
  const jam = buildJam({ room: { ...roomRec, num: roomNum }, region, samples, redact, seconds, intervalMs,
                         observers: observers.map(o => o.character ?? o.agent), geometry,
                         fleet: fleetInfo.label });
  if (!keepNames) jam.redaction = 'player names replaced by roles in order of appearance; --names keeps them (local files only)';

  const stamp = new Date(t0).toISOString().replace(/[:.]/g, '-');
  const out = argOf('out') ?? join(HERE, 'substrate', 'jams',
    `jam-${roomNum}-${region.c1}x${region.r1}-${region.c2}x${region.r2}-${stamp}.json`);
  if (keepNames && relative(join(HERE, 'tools'), resolve(out)).startsWith('..') === false) {
    console.error(`refusing to write a recording WITH character names under tools/ (${out}) — drop --names, or --out somewhere gitignored`);
    process.exit(1);
  }
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(jam, null, 1));
  for (const line of summarise(jam)) console.log(line);
  console.log(`\nwrote ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
