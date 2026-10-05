#!/usr/bin/env node
// m59-movement-incidents.mjs — THE MOVEMENT INCIDENT LOG: one self-contained record per movement
// failure that needs correcting, in a shape a script can pick up and replay.
//
//   node tools/m59-movement-incidents.mjs                        # the last 24h, newest first
//   node tools/m59-movement-incidents.mjs --room 48 --kind preempted --since 7d
//   node tools/m59-movement-incidents.mjs --agent t9 --json
//   node tools/m59-movement-incidents.mjs --export mi-3f2a9c01d4e7 [--out tools/fixtures/x.json] [--keep-names]
//
// Operator, 2026-10-04: "Can we make a log (with saves of locations, & 'failing to reach'-targets)
// of these errors that require corrections? For understanding how we still need to fix
// movement/pathing, we want chunks that we can work with using scripts like the
// mana-node/movement fleetscripts/fleetscratches."
//
// WHAT COUNTS. A journey or walk that did not arrive; a move cancelled or PRE-EMPTED by another
// issuer (m59-move-origin.mjs); a stage or exit refusal and `exits_exhausted`; a wedge given up
// on; a stall with no lever; and a FleetScript walk step that failed. Each record carries where
// the body stood (square AND fine point, units named per docs/m59-coordinates.md), what it was
// trying to reach (the room, and the stage square of the crossing that refused), the planned
// route and the hop it was on, the failure kind and reason, the travel `refusals`, `cancelled_by`
// with full provenance, a short position trail, health and threat context, and the code it ran
// on (harness sha, deploy tag, #movement epoch). A stable `id` names it for `--export`.
//
// ONE INCIDENT PER FAILURE, NOT ONE PER RETRY TICK. Camilla failed 48 -> 714 thirteen times in
// two minutes standing on the same stage; that is one incident seen thirteen times. The first
// occurrence of a DEDUPE KEY (agent, kind, from, to, target square, canceller, reason) is
// written whole; a repeat within `dedupeMs` writes a one-line `repeat` row naming the id, and
// the reader folds those into `repeats` and `last_at`.
//
// WHERE. `substrate/history/<fleet>/movement-incidents-YYYY-MM-DD.jsonl`, beside the fleet
// ledger and under the same `M59_LEDGER_DIR` override (m59-fleetpath.mjs `ledgerDirFor`), so it
// is gitignored with the rest of the history and a test can redirect it. Our own character names
// are fine in that log; `--export` writes a fixture that is REDACTED to roles (`player A`) the
// way m59-recordjam.mjs fixtures are, unless `--keep-names`.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fleetName, ledgerDirFor } from './m59-fleetpath.mjs';
import { originLabel } from './m59-move-origin.mjs';
import { recentMoveAttempts } from './m59-collision-trace.mjs';

export const FORMAT = 'm59-movement-incident/1';
export const FIXTURE_FORMAT = 'm59-movement-incident-fixture/1';
export const INCIDENT_KINDS = Object.freeze([
  'preempted',          // cancelled by ANOTHER issuer (a keeper rung, a bot, an operator)
  'cancelled',          // cancelled by its own issuer, or by nobody who said
  'exits_exhausted',    // the crossing refused at every candidate stage
  'refused',            // refused before or during the walk (gate, confinement, terminal reason)
  'wedge',              // a wedge the keeper gave up on
  'stall',              // a stall with no lever
  'died',               // died on the way
  'not_arrived',        // anything else that ended short
  'fleetscript_walk_failed',
]);
export const DEDUPE_MS = Number(process.env.M59_INCIDENT_DEDUPE_MS ?? 10 * 60_000);
export const UNITS_NOTE = 'square = 1-based {row, col}; fine = KOD/protocol {x, y}, 64 units per ' +
  'square, col = floor(x/64), row = floor(y/64). Never an unlabeled pair (docs/m59-coordinates.md).';

const IS_TEST = /[\\/]m59-[a-z-]+-test\.mjs$/.test(process.argv[1] || '');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- shape helpers

const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** A position, with both halves named: `{room, square: {row, col}, fine: {x, y, units}}`. */
export function positionOf(p, room = null) {
  if (!p || typeof p !== 'object') return null;
  const row = num(p.row ?? p.square?.row), col = num(p.col ?? p.square?.col);
  const x = num(p.x ?? p.fine?.x), y = num(p.y ?? p.fine?.y);
  if (row == null && col == null && x == null && y == null) return null;
  return {
    room: num(p.room ?? room),
    ...(row != null || col != null ? { square: { row, col }, at: `r${row}c${col}` } : {}),
    ...(x != null || y != null ? { fine: { x, y, units: 'kod' } } : {}),
  };
}

/** What a failed journey was. `cancel` is the session's last cancel record (m59-move-origin.mjs). */
export function classifyJourneyFailure(outcome = {}, cancel = null) {
  const reason = String(outcome?.reason ?? outcome?.why ?? '');
  if (outcome?.died || /underworld|died/i.test(reason)) return 'died';
  if (outcome?.cancelled || /cancelled by a newer command/.test(reason)) {
    return cancel?.by && cancel.preempted && !cancel.self_cancel ? 'preempted' : 'cancelled';
  }
  if (/exits?_exhausted|exits exhausted/i.test(reason)) return 'exits_exhausted';
  if (outcome?.wedged) return 'wedge';
  if (outcome?.refused || outcome?.confined) return 'refused';
  return 'not_arrived';
}

const normReason = r => String(r ?? '').replace(/\d+(\.\d+)?/g, '#').slice(0, 80);

/** The dedupe key: the same failure seen again, not a new one. */
export function incidentKey(rec) {
  const t = rec.target ?? {};
  return [rec.agent ?? rec.character ?? '?', rec.kind, rec.from?.room ?? rec.start?.room ?? '?',
          t.room ?? '?', t.square ? `r${t.square.row}c${t.square.col}` : '-',
          rec.cancelled_by?.by_label ?? '-', normReason(rec.reason)].join('|');
}

export const incidentId = (key, at) =>
  'mi-' + createHash('sha1').update(`${key}|${at}`).digest('hex').slice(0, 12);

// The code the failure happened on: computed once per process and cached. A keeper is long-lived
// and a git spawn costs once; a failure to ask is `null`, never a guess.
let codeCache = null;
export function codeProvenance({ refresh = false } = {}) {
  if (codeCache && !refresh) return codeCache;
  const git = args => { try { return execFileSync('git', args, { cwd: REPO, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, windowsHide: true }).trim() || null; } catch { return null; } };
  codeCache = { harness_sha: git(['rev-parse', '--short=12', 'HEAD']),
                deploy_tag: git(['describe', '--tags', '--always']) };
  return codeCache;
}

/**
 * ONE RECORD, built from whatever the caller knows. Everything is optional except `kind`; an
 * unknown is `null`, never a default that reads like a fact.
 */
export function buildIncident(input = {}, { now = Date.now(), fleet = null } = {}) {
  const kind = INCIDENT_KINDS.includes(input.kind) ? input.kind : 'not_arrived';
  const cancel = input.cancel ?? input.cancelled_by ?? null;
  const rec = {
    format: FORMAT,
    t: now, iso: new Date(now).toISOString(),
    fleet: fleet ?? input.fleet ?? null,
    agent: input.agent ?? null, character: input.character ?? null,
    kind,
    source: input.source ?? 'keeper',
    reason: input.reason != null ? String(input.reason).slice(0, 400) : null,
    room: input.room ? { num: num(input.room.num ?? input.room), name: input.room.name ?? null } : null,
    start: positionOf(input.start, input.from?.room ?? input.from),
    from: input.from != null ? { room: num(input.from?.room ?? input.from) } : null,
    end: positionOf(input.end, input.room?.num ?? input.room),
    target: input.target ? {
      room: num(input.target.room), name: input.target.name ?? null,
      ...(positionOf(input.target) ? (({ room: _r, ...p }) => p)(positionOf(input.target)) : {}),
      ...(input.target.kind ? { kind: input.target.kind } : {}),
    } : null,
    route: input.route ? {
      planned: Array.isArray(input.route.planned) ? input.route.planned.map(num) : null,
      hop_index: num(input.route.hop_index), legs_done: num(input.route.legs_done),
      next_hop: num(input.route.next_hop),
    } : null,
    refusals: Array.isArray(input.refusals) && input.refusals.length ? input.refusals.slice(0, 8) : null,
    ordered_by: input.origin ? { origin: input.origin, label: originLabel(input.origin) } : null,
    cancelled_by: cancel?.by ? {
      by: cancel.by, by_label: cancel.by_label ?? originLabel(cancel.by), why: cancel.why ?? null,
      at: cancel.at ?? null, preempted: cancel.preempted ?? null, self_cancel: !!cancel.self_cancel,
      summary: cancel.summary ?? null,
    } : null,
    trail: Array.isArray(input.trail) && input.trail.length
      ? input.trail.slice(-8).map(p => ({ ...positionOf(p, p.room) ?? {}, at: num(p.at),
                                          ...(p.health != null ? { health: num(p.health) } : {}),
                                          ...(p.doing ? { doing: String(p.doing).slice(0, 60) } : {}) }))
      : null,
    vitals: input.vitals ? { health: num(input.vitals.health), max_health: num(input.vitals.max_health),
                             health_at_start: num(input.vitals.health_at_start),
                             vigor: num(input.vitals.vigor) } : null,
    threats: input.threats ? { count: num(input.threats.count),
                               nearest: input.threats.nearest ?? null,
                               names: Array.isArray(input.threats.names) ? input.threats.names.slice(0, 8) : null } : null,
    ms: num(input.ms),
    movement_attempts: recentMoveAttempts(input.agent),
    // The code it ran on. The #movement epoch is passed by the caller (the keeper and FleetScript
    // already hold `epochId('movement')`), so this module never runs the epoch's git scan itself.
    code: input.code ?? { ...codeProvenance(), movement_epoch: input.epoch ?? null },
    units_note: UNITS_NOTE,
  };
  rec.key = incidentKey(rec);
  rec.id = input.id ?? incidentId(rec.key, now);
  return rec;
}

// ---------------------------------------------------------------- writing

export const incidentFile = (dir, t = Date.now()) =>
  join(dir, `movement-incidents-${new Date(t).toISOString().slice(0, 10)}.jsonl`);

/**
 * A log with its own dedupe memory. `dir` defaults to this fleet's history directory.
 * `record(input)` returns `{ id, written: 'incident'|'repeat'|false, repeats }`.
 */
export function createIncidentLog({ dir = null, fleet = null, dedupeMs = DEDUPE_MS, clock = Date.now } = {}) {
  const seen = new Map();   // key -> { id, at, n }
  const target = () => dir ?? ledgerDirFor(fleet ?? fleetName());
  let warned = false;
  const append = (row, t) => {
    if (IS_TEST && !dir && !process.env.M59_LEDGER_DIR) {
      if (!warned) { warned = true; console.error('[incidents] refusing to write from a test without M59_LEDGER_DIR'); }
      return false;
    }
    try {
      const d = target(); mkdirSync(d, { recursive: true });
      appendFileSync(incidentFile(d, t), JSON.stringify(row) + '\n');
      return true;
    } catch { return false; }   // never let the record break the play it is recording
  };
  return {
    dir: target,
    record(input = {}) {
      const now = clock();
      const rec = buildIncident(input, { now, fleet: fleet ?? input.fleet ?? null });
      const prior = seen.get(rec.key);
      if (prior && now - prior.at < dedupeMs) {
        prior.n++; prior.last = now;
        const ok = append({ format: FORMAT, type: 'repeat', id: prior.id, t: now,
                            iso: new Date(now).toISOString(), n: prior.n }, now);
        return { id: prior.id, written: ok ? 'repeat' : false, repeats: prior.n, record: null };
      }
      seen.set(rec.key, { id: rec.id, at: now, n: 0 });
      if (seen.size > 500) seen.delete(seen.keys().next().value);
      const ok = append({ ...rec, type: 'incident' }, now);
      return { id: rec.id, written: ok ? 'incident' : false, repeats: 0, record: rec };
    },
  };
}

let defaultLog = null;
/** The process-wide log for this fleet. Never throws. */
export function recordMovementIncident(input) {
  try {
    defaultLog ??= createIncidentLog({});
    return defaultLog.record(input);
  } catch { return { id: null, written: false }; }
}

// ---------------------------------------------------------------- reading

/** Every incident in `dir` since `sinceMs` ago, repeats folded in, newest first. */
export function readIncidents({ dir = null, fleet = null, sinceMs = 24 * 3600_000, now = Date.now(),
                                room = null, kind = null, agent = null, id = null } = {}) {
  const d = dir ?? ledgerDirFor(fleet ?? fleetName());
  if (!existsSync(d)) return [];
  const from = now - sinceMs;
  const firstDay = Number.isFinite(from) && from > 0 ? new Date(from).toISOString().slice(0, 10) : '0000-00-00';
  const byId = new Map();
  for (const f of readdirSync(d).filter(f => /^movement-incidents-\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort()) {
    if (!id && f.slice(19, 29) < firstDay) continue;
    for (const line of readFileSync(join(d, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.type === 'repeat') {
        const base = byId.get(r.id);
        if (base) { base.repeats = Math.max(base.repeats ?? 0, r.n ?? 0); base.last_at = r.t; }
        continue;
      }
      if (r.type !== 'incident') continue;
      byId.set(r.id, { ...r, repeats: 0, last_at: r.t });
    }
  }
  const want = v => v == null || v === '';
  return [...byId.values()].filter(r =>
    (id ? r.id === id || r.id.startsWith(id) : r.t >= from) &&
    (want(room) || r.room?.num === Number(room) || r.from?.room === Number(room) || r.target?.room === Number(room)) &&
    (want(kind) || r.kind === kind) &&
    (want(agent) || r.agent === agent || r.character === agent))
    .sort((a, b) => b.t - a.t);
}

// ---------------------------------------------------------------- export as a fixture

/** Every character name this machine's rosters know — slot names and character fields only. */
export function knownCharacterNames(repo = REPO) {
  const names = new Set();
  const add = n => { if (typeof n === 'string' && n.trim().length > 1) names.add(n.trim()); };
  const files = [join(repo, 'substrate', 'fleet-state.json')];
  const fd = join(repo, 'substrate', 'fleets');
  if (existsSync(fd)) for (const f of readdirSync(fd)) if (f.endsWith('.json')) files.push(join(fd, f));
  for (const file of files) {
    let r; try { r = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    if (!r || typeof r !== 'object') continue;
    for (const [slot, v] of Object.entries(r)) {
      if (!v || typeof v !== 'object' || !(v.credentials || v.account || v.password)) continue;
      add(slot); add(v.character); add(v.name); add(v.credentials?.character);
    }
  }
  return names;
}

const NEVER_REDACT = new Set(['name', 'room_name', 'to_name', 'format', 'units', 'units_note', 'kind',
                              'source', 'harness_sha', 'deploy_tag', 'movement_epoch', 'id', 'key']);

/**
 * One incident as a COMMITTABLE FIXTURE, shaped beside m59-recordjam's `m59-jam/1`: a `subject`
 * (the body, redacted to a role), the `journey` (from, to, route, hop), the `target` it failed to
 * reach, the `failure`, and a `replay` hint a fleetscratch / mana-node style script can act on.
 * Names are redacted to `player A` and every string is scrubbed of known character names, unless
 * `keepNames`.
 */
export function exportIncident(rec, { keepNames = false, names = null } = {}) {
  const roster = keepNames ? [] : [...new Set([...(names ?? knownCharacterNames()),
    rec.agent, rec.character].filter(n => typeof n === 'string' && n.length > 1))]
    .sort((a, b) => b.length - a.length);
  const scrub = s => { if (typeof s !== 'string') return s; for (const n of roster) s = s.split(n).join('player A'); return s; };
  const deep = v => typeof v === 'string' ? scrub(v)
    : Array.isArray(v) ? v.map(deep)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, NEVER_REDACT.has(k) ? x : deep(x)]))
    : v;
  const who = keepNames ? (rec.character ?? rec.agent) : 'player A';
  const t = rec.target ?? {};
  const fixture = {
    format: FIXTURE_FORMAT,
    incident_id: rec.id,
    captured_at: rec.iso,
    fleet: rec.fleet ?? null,
    kind: rec.kind,
    room: rec.room,
    units_note: UNITS_NOTE,
    subject: { name: who, start: rec.start, end: rec.end, vitals: rec.vitals, trail: rec.trail },
    journey: { from: rec.from?.room ?? rec.start?.room ?? null, to: t.room ?? null, route: rec.route,
               ordered_by: rec.ordered_by },
    target: t,
    failure: { kind: rec.kind, reason: rec.reason, refusals: rec.refusals, cancelled_by: rec.cancelled_by,
               threats: rec.threats, movement_attempts: rec.movement_attempts ?? null,
               ms: rec.ms, repeats: rec.repeats ?? 0, last_at: rec.last_at ?? rec.t },
    code: rec.code,
    // WHAT A SCRIPT DOES WITH IT. `walk` is the FleetScript step that reproduces the journey; a
    // stage square is what a `crawlTo` / mana-node style approach aims at (the 5x5 meld box is
    // the stone's business, a crossing's is its stand_on square).
    replay: {
      walk: t.room != null ? { to: t.room } : null,
      start_room: rec.start?.room ?? rec.from?.room ?? null,
      start_square: rec.start?.square ?? null,
      aim: t.square ? { room: rec.room?.num ?? rec.start?.room ?? null, ...t.square } : null,
    },
  };
  return deep(fixture);
}

// ---------------------------------------------------------------- CLI

function parseSince(s) {
  const m = String(s ?? '').match(/^(\d+(?:\.\d+)?)\s*([smhd])?$/);
  if (!m) return 24 * 3600_000;
  return Number(m[1]) * ({ s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] ?? 'h']);
}

function line(r) {
  const at = r.start?.at ? ` at ${r.start.at}` : '';
  const tgt = r.target?.room != null ? ` -> ${r.target.room}${r.target.at ? ` (${r.target.at})` : ''}` : '';
  const by = r.cancelled_by ? ` by ${r.cancelled_by.by_label}` : '';
  const rep = r.repeats ? ` x${r.repeats + 1}` : '';
  return `${r.id}  ${r.iso.slice(0, 19)}Z  ${String(r.kind).padEnd(16)} ${r.agent ?? '?'}  ` +
         `room ${r.room?.num ?? r.from?.room ?? '?'}${at}${tgt}${by}${rep}  — ${String(r.reason ?? '').slice(0, 90)}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
  const has = n => argv.includes('--' + n);
  const fleet = flag('fleet') ?? undefined;
  const dir = flag('dir') ?? undefined;
  const exportId = flag('export');
  if (exportId) {
    const [rec] = readIncidents({ dir, fleet, id: exportId, sinceMs: Infinity });
    if (!rec) { console.error(`no incident ${exportId}`); process.exit(1); }
    const fx = exportIncident(rec, { keepNames: has('keep-names') });
    const out = flag('out');
    if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(out, JSON.stringify(fx, null, 2) + '\n'); console.log(`wrote ${out}`); }
    else console.log(JSON.stringify(fx, null, 2));
    process.exit(0);
  }
  const rows = readIncidents({ dir, fleet, sinceMs: parseSince(flag('since', '24h')),
                               room: flag('room'), kind: flag('kind'), agent: flag('agent') });
  if (has('json')) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
  if (!rows.length) { console.log('no movement incidents in that window'); process.exit(0); }
  const byKind = rows.reduce((m, r) => (m[r.kind] = (m[r.kind] ?? 0) + 1, m), {});
  console.log(`${rows.length} incident(s): ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  for (const r of rows.slice(0, Number(flag('limit', 50)))) console.log(line(r));
}
