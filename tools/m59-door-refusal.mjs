#!/usr/bin/env node
// m59-door-refusal.mjs — A DOOR PRESS THAT DID NOT OPEN, WRITTEN DOWN WITH THE SCENE IT HAPPENED IN.
//
//   node tools/m59-door-refusal.mjs                                # last 24h, newest first
//   node tools/m59-door-refusal.mjs --room 714 --agent t17 --since 7d
//   node tools/m59-door-refusal.mjs --json
//   node tools/m59-door-refusal.mjs --export dp-3f2a9c01d4 [--out tools/fixtures/x.json] [--keep-names]
//
// THE INCIDENT, prod 2026-11-01 ~23:30-23:57Z. The `tree-farm` FleetScript's hall deposit (walk
// to 714, then door 55 and door 59 into the chest room) failed three times for two characters --
// Zoot twice, Statler once -- with `guild door 59 could not be crossed: the server refused 3 of 3
// presses as "unable to go anywhere"`. Earlier and later trips through the same doors worked, and
// the operator stood in the hall and saw nothing in the way. And there was NOTHING to read: not
// where the body was when the `go` went out, not which square the door logic thought it was on,
// not who else stood there, not whether it was seated, not what other walk was pulling at it.
//
// Operator: "when unexpectedly getting the server's 'unable to go anywhere' message, log it
// alongside a recording of the actual (and I suppose also expected) position, etc. -- like we
// want to be able to recreate and understand these situations on the shadow test server to debug
// and wrap them on the harness so that FleetScripts/LLMs/Players can deal with them in
// predictable ways".
//
// WHAT THE MESSAGE MEANS, AND WHY THE SCENE IS THE WHOLE ANSWER. `UserGo` (user.kod:5657) says
// "You are unable to go anywhere." in two situations that call for opposite fixes: PFLAG_NO_MOVE
// is set (seated, held, webbed), or `SomethingTryGo` found no exit/trigger at the SERVER's
// piRow/piCol -- the body is not on the square we think it is, because a competing walker dragged
// it off, or the walk was dead-reckoned and never landed. Both callers already stand before every
// press and confirm the square before it, so a refusal that still happens is exactly the case
// nobody has explained, and the explanation is in the scene: the pose AT THE PRESS (captured in
// the pacer callback that sends the `go`, not a second later), the trigger it was meant for, the
// posture, the movement generation and every order and cancel in flight, and the bodies round the
// trigger.
//
// ONE LEDGER ROW PER PRESS THAT DID NOT OPEN, kind `door_press_refused`, keyed by character name
// in the fleet ledger like every other event (m59-ledger.mjs). `verdict` says which: the server
// REFUSED it in words (`server_refused`), or no opening was observed and nothing was said
// (`not_verified`). Bounded: every list is capped, and a refusal LOOP (Kermit and Robin pressed a
// seated body 1,900 times in 2026-09) writes at most ROWS_PER_WINDOW rows per door per ten minutes,
// the next one carrying `suppressed_since_last`.
//
// AND THE REPLAY RING IS SEALED. A keeper runs with a replay recorder (m59-replay-recorder.mjs,
// on unless M59_REPLAY_CAPTURE=0) holding the last two minutes of client-observed scenes; a server
// refusal seals it under `substrate/replays/door_refused/` -- at most once per door per ten
// minutes -- and the row names the file. Its frames are the `scene` shape `m59-shadow-replay.mjs`
// stages on the shadow server (docs/m59-shadow.md); the `m59-death-replay.mjs` CLI loads only death
// bundles today, so running a seal there is a loader change still to make. `--export` turns one
// ledger row into a committable fixture, redacted the way m59-recordjam.mjs fixtures are.
//
// NEVER THROWS, NEVER WAITS. Everything here reads what the client already holds; no request, no
// await. The record must not break the play it is recording.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { recordEvent } from './m59-ledger.mjs';
import { fleetName, ledgerDirFor } from './m59-fleetpath.mjs';
import { OF } from './m59-parse.mjs';
import { movementReport, originLabel } from './m59-move-origin.mjs';
import { recentMoveAttempts } from './m59-movement-attempts.mjs';
import { codeProvenance, knownCharacterNames } from './m59-movement-incidents.mjs';
import { CANT_GO } from './m59-door-wait.mjs';

export const KIND = 'door_press_refused';
export const FORMAT = 'm59-door-press/1';
export const FIXTURE_FORMAT = 'm59-door-press-fixture/1';
export const SEAL_KIND = 'door_refused';
export const UNITS_NOTE = 'square = 1-based {row, col}, `at` is rNcM; fine = KOD/protocol {x, y}, ' +
  '64 units per square, col = floor(x/64), row = floor(y/64) (docs/m59-coordinates.md). ' +
  'An object id is a handle valid for this capture only; the room is its map number.';
export const NEAR_RADIUS = 3;        // squares, Chebyshev, round the trigger and round the body
export const BODIES_RADIUS = 2;      // the count the one-line summary quotes
export const WINDOW_MS = 10 * 60_000;
export const ROWS_PER_WINDOW = 6;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clip = (v, n = 200) => (v == null ? null : String(v).slice(0, n));
const sq = (row, col) => (num(row) == null || num(col) == null ? null : { row: num(row), col: num(col), at: `r${row}c${col}` });
const cheb = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
const squareOf = p => Array.isArray(p) ? sq(p[0], p[1]) : p ? sq(p.row, p.col) : null;

/**
 * THE POSE AT THE PRESS. Call it inside the pacer callback, on the line before `c.go()` (or the
 * hall password), so it is the position the client believed when the packet left -- the thing
 * the record is for. A cheap copy and nothing else.
 */
export function doorPressPose(s, c = s?.client) {
  try {
    const p = c?.self;
    return {
      t: Date.now(),
      row: num(p?.row), col: num(p?.col), x: num(p?.x), y: num(p?.y), predicted: !!p?.predicted,
      room_object_id: c?.room?.id ?? null,
      generation: num(s?.movementGeneration),
      posture: c?.lastPostureCommand ? { verb: c.lastPostureCommand.verb ?? null, at: num(c.lastPostureCommand.at),
                                         room_object_id: c.lastPostureCommand.room_object_id ?? null } : null,
    };
  } catch { return null; }
}

function poseView(p, trigger, now) {
  if (!p) return null;
  const square = sq(p.row, p.col);
  return {
    ...(square ?? {}),
    fine: p.x != null || p.y != null ? { x: p.x, y: p.y, units: 'kod' } : null,
    predicted: !!p.predicted,
    on_trigger: square && trigger ? square.row === trigger.row && square.col === trigger.col : null,
    off_trigger: square && trigger ? { rows: square.row - trigger.row, cols: square.col - trigger.col,
                                      squares: cheb(square, trigger) } : null,
    // A fine point that does not fall in its own square is evidence in itself: a dead-reckoned
    // pose the server never confirmed reads exactly like this.
    fine_in_square: square && p.x != null && p.y != null
      ? Math.floor(p.x / 64) === square.col && Math.floor(p.y / 64) === square.row : null,
    ...(p.t ? { ms_before_record: Math.max(0, now - p.t) } : {}),
    ...(p.room_object_id != null ? { room_object_id: p.room_object_id } : {}),
  };
}

/** Seated is what the last posture command said in THIS room; anything else is unknown, not false. */
function postureOf(c, k, pose) {
  const cmd = pose?.posture ?? (c?.lastPostureCommand ? { verb: c.lastPostureCommand.verb,
    at: c.lastPostureCommand.at, room_object_id: c.lastPostureCommand.room_object_id } : null);
  const sameRoom = cmd ? cmd.room_object_id == null || cmd.room_object_id === (c?.room?.id ?? null) : null;
  const seated = !cmd || !sameRoom ? null : cmd.verb === 'rest' ? true : cmd.verb === 'stand' ? false : null;
  let ailments = null;
  try { ailments = (c?.ailments?.() ?? []).slice(0, 8).map(e => clip(e?.name ?? e, 60)); } catch { ailments = null; }
  return {
    seated,
    last_command: cmd?.verb ?? null,
    last_command_ago_ms: num(cmd?.at) != null ? Math.max(0, Date.now() - cmd.at) : null,
    same_room: sameRoom,
    // Held and webbed set the same PFLAG_NO_MOVE a rest does, and only an ailment says so.
    held: ailments ? ailments.some(a => /held|hold|web|paraly|stun|freez/i.test(a ?? '')) : null,
    ailments,
    keeper_doing: clip(k?.doing ?? null, 60),
  };
}

function kindOfObject(o, c) {
  if ((o.flags & OF.PLAYER) || c?.playersOnline?.has?.(o.id)) return 'player';
  if (o.flags & OF.ATTACKABLE) return 'monster';
  return 'item';
}

/** Everything within NEAR_RADIUS of the trigger or the body, nearest the trigger first, capped. */
function nearbyOf(c, trigger, body) {
  const out = [];
  let scanned = 0, total = 0;
  for (const o of c?.room?.objects?.values?.() ?? []) {
    if (++scanned > 2048) break;
    if (o?.id === c.selfId || !Number.isFinite(o?.row) || !Number.isFinite(o?.col)) continue;
    const here = { row: o.row, col: o.col };
    const dT = trigger ? cheb(here, trigger) : null, dB = body?.row != null ? cheb(here, body) : null;
    if ((dT == null || dT > NEAR_RADIUS) && (dB == null || dB > NEAR_RADIUS)) continue;
    total++;
    let name = null;
    try { name = clip(c.rsc?.get?.(o.nameRsc) || o.name || null, 60); } catch { name = clip(o.name, 60); }
    out.push({ name, kind: kindOfObject(o, c), handle: o.id ?? null, ...sq(o.row, o.col),
               fine: Number.isFinite(o.x) && Number.isFinite(o.y) ? { x: o.x, y: o.y, units: 'kod' } : null,
               from_trigger: dT, from_body: dB });
  }
  out.sort((a, b) => (a.from_trigger ?? 99) - (b.from_trigger ?? 99) || (a.from_body ?? 99) - (b.from_body ?? 99));
  // A body is something with collision. A logoff ghost or an item on the floor has none
  // (MOVEON_YES), so it is listed and never counted.
  const bodies = out.filter(o => o.kind !== 'item' && o.from_trigger != null && o.from_trigger <= BODIES_RADIUS).length;
  return { radius: NEAR_RADIUS, total, bodies_within_2: bodies, objects: out.slice(0, 10) };
}

function movementOf(s, k, pose) {
  let report = null;
  try { report = movementReport(s); } catch { report = null; }
  const job = s?.job && !s.job.done ? { label: clip(s.job.label, 120), kind: s.job.kind ?? null, to: num(s.job.to),
    ordered_by: s.job.origin ? originLabel(s.job.origin) : null } : null;
  let attempts = null;
  try {
    const all = recentMoveAttempts(s?.name);
    attempts = { evicted: all.evicted + Math.max(0, all.attempts.length - 6), units: all.units,
                 last: all.attempts.slice(-6) };
  } catch { attempts = null; }
  return {
    generation_at_press: pose?.generation ?? null,
    generation_now: num(s?.movementGeneration),
    order: report?.order ? { kind: report.order.kind, to: report.order.to, ordered_by: report.order.ordered_by,
                             since_s: report.order.since_s } : null,
    job,
    keeper_in_flight: k?.stageInFlight?.size ? [...k.stageInFlight.keys()].slice(0, 8) : [],
    suspended_journey: k?.suspendedJourney ? { to: num(k.suspendedJourney.to ?? k.suspendedJourney),
                                               why: clip(k.suspendedJourney.why ?? null, 80) } : null,
    last_cancel: report?.last_cancel ? { summary: clip(report.last_cancel.summary, 240),
                                         ago_s: report.last_cancel.ago_s } : null,
    preemptions: (report?.preemptions ?? []).slice(-3).map(p => ({ summary: clip(p.summary, 240), ago_s: p.ago_s })),
    recent_commands: attempts,
  };
}

function messagesSince(c, since) {
  if (since == null) return [];
  let events = [];
  try { events = c?.eventsSince?.(since) ?? (c?.events ?? []).filter(e => e.seq > since); } catch { events = []; }
  return events.filter(e => e?.kind === 'message' && e.text).slice(0, 4).map(e => clip(e.text, 200));
}

/** "body at r20c10, trigger r19c10, seated:false, 2 bodies within 2 sq" -- the line an error carries. */
export function describeDoorScene(d) {
  if (!d) return null;
  const body = d.actual?.at_press ?? d.actual?.after;
  const parts = [`body at ${body?.at ?? 'unknown'}`, `trigger ${d.expected?.trigger?.at ?? 'unknown'}`,
                 `seated:${d.posture?.seated ?? 'unknown'}`];
  if (d.posture?.held) parts.push('held');
  parts.push(`${d.nearby?.bodies_within_2 ?? 0} bodies within 2 sq`);
  const g0 = d.movement?.generation_at_press, g1 = d.movement?.generation_now;
  if (g0 != null && g1 != null && g1 !== g0) parts.push(`movement gen +${g1 - g0} since press`);
  if (body?.predicted) parts.push('pose predicted');
  return parts.join(', ');
}

// ---------------------------------------------------------------- the rate limit

const windows = new Map();     // key -> { from, rows, suppressed, sealedAt }
function admit(key, now) {
  let w = windows.get(key);
  if (!w || now - w.from >= WINDOW_MS) {
    const carried = w?.suppressed ?? 0;
    w = { from: now, rows: 0, suppressed: carried, sealedAt: w?.sealedAt ?? 0 };
    windows.set(key, w);
    if (windows.size > 256) windows.delete(windows.keys().next().value);
  }
  if (w.rows >= ROWS_PER_WINDOW) { w.suppressed++; return { ok: false, w }; }
  w.rows++;
  const suppressed = w.suppressed; w.suppressed = 0;
  return { ok: true, w, suppressed };
}
/** For tests: forget every window. */
export function resetDoorRefusalWindows() { windows.clear(); }

/**
 * ONE PRESS THAT DID NOT OPEN. Builds the scene from what the session already holds, writes it to
 * the fleet ledger as `door_press_refused`, seals the replay ring on a server refusal, and returns
 * `{ written, verdict, summary, detail }`. Never throws.
 *
 *   source         'guild_passage' | 'counter_door' | 'operable_door' | 'exit_go' | 'same_room_door'
 *   door           { sector?, name?, kind?, direction?, secret?, gate?, to? }
 *   trigger        the square the press was meant for: [row, col] or {row, col}
 *   across         where a crossing would land, same shapes, optional
 *   since          the client event sequence taken just before the press
 *   pose           doorPressPose(...) from the pacer callback
 *   messages       server sentences already collected (else read from `since`)
 */
export function noteDoorPressRefused(s, { source = 'door', door = {}, trigger = null, across = null,
    since = null, pose = null, messages = null, verdict = null, openingReason = null, attempt = null,
    attempts = null, refused = null, keeper = null, now = Date.now(), record = recordEvent,
    seal = true } = {}) {
  try {
    const c = s?.client ?? s?.need?.();
    const trig = squareOf(trigger);
    const said = Array.isArray(messages) ? messages.slice(0, 4).map(m => clip(m, 200)) : messagesSince(c, since);
    const refusal = said.find(m => CANT_GO.test(m ?? '')) ?? null;
    const v = verdict ?? (refusal ? 'server_refused' : 'not_verified');
    const roomNum = num(s?.world?.room?.num);
    const afterPose = doorPressPose(s, c);
    const k = keeper ?? null;
    const detail = {
      format: FORMAT,
      agent: s?.name ?? null,
      source,
      verdict: v,
      server_message: refusal,
      said,
      opening_reason: clip(openingReason, 240),
      attempt: num(attempt), attempts: num(attempts), refused_so_far: num(refused),
      room: { num: roomNum, name: clip(s?.world?.room?.name ?? null, 80),
              object_id_at_capture: c?.room?.id ?? null },
      door: { sector: num(door.sector), name: clip(door.name ?? null, 60), kind: door.kind ?? null,
              direction: door.direction ?? null, secret: !!door.secret, gate: clip(door.gate ?? null, 60),
              to: num(door.to) },
      expected: {
        trigger: trig,
        // The server matches the SQUARE (`SomethingTryGo` compares piRow/piCol), so the centre is
        // where a lean aims, not a tolerance the server applies.
        trigger_fine: trig ? { x: trig.col * 64 + 32, y: trig.row * 64 + 32, units: 'kod', what: 'square centre' } : null,
        across: squareOf(across),
      },
      actual: { at_press: poseView(pose, trig, now), after: poseView(afterPose, trig, now) },
      posture: postureOf(c, k, pose),
      vitals: (() => { try { const vv = c?.vitals?.(); return vv ? { health: num(vv.health?.value),
        max_health: num(vv.health?.max), vigor: num(vv.vigor?.value) } : null; } catch { return null; } })(),
      movement: movementOf(s, k, pose),
      nearby: nearbyOf(c, trig, pose?.row != null ? pose : afterPose),
      code: (() => { try { return { ...codeProvenance() }; } catch { return null; } })(),
      units_note: UNITS_NOTE,
    };
    detail.summary = describeDoorScene(detail);
    detail.id = 'dp-' + createHash('sha1').update(`${detail.agent}|${now}|${detail.door.sector}|${source}`)
      .digest('hex').slice(0, 10);
    const key = [detail.agent, roomNum, source, detail.door.sector, v].join('|');
    const gate = admit(key, now);
    if (!gate.ok) return { written: false, suppressed: true, verdict: v, summary: detail.summary, detail };
    if (gate.suppressed) detail.suppressed_since_last = gate.suppressed;
    // THE RING, ONCE PER DOOR PER WINDOW, AND ONLY FOR THE UNEXPLAINED CASE. A seal is a whole
    // two-minute ring; a refusal loop must not write one per press.
    if (seal && v === 'server_refused' && s?.replayRecorder?.seal && now - (gate.w.sealedAt ?? 0) >= WINDOW_MS) {
      try {
        const r = s.replayRecorder.seal(SEAL_KIND, { refusal_id: detail.id, room: roomNum, sector: detail.door.sector,
          source, summary: detail.summary, expected: detail.expected, actual: detail.actual });
        if (r) { gate.w.sealedAt = now; detail.replay_seal = { id: r.id ?? null, file: r.file ?? null, status: r.status ?? null }; }
      } catch (e) { detail.replay_seal = { error: clip(e.message, 120) }; }
    }
    const character = c?.me?.name ?? s?.client?.me?.name ?? null;
    let written = false;
    if (character) { try { record(character, KIND, detail); written = true; } catch { written = false; } }
    return { written, verdict: v, summary: detail.summary, detail };
  } catch (e) {
    return { written: false, verdict: verdict ?? null, summary: null, error: e.message };
  }
}

// ---------------------------------------------------------------- reading

/** Every door_press_refused row in the ledger since `sinceMs` ago, newest first. */
export function readDoorRefusals({ dir = null, fleet = null, sinceMs = 24 * 3600_000, now = Date.now(),
                                   room = null, agent = null, id = null } = {}) {
  const d = dir ?? ledgerDirFor(fleet ?? fleetName());
  if (!existsSync(d)) return [];
  const from = now - sinceMs;
  const firstDay = Number.isFinite(from) && from > 0 ? new Date(from).toISOString().slice(0, 10) : '0000-00-00';
  const out = [];
  for (const f of readdirSync(d).filter(f => /^fleet-\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort()) {
    if (!id && f.slice(6, 16) < firstDay) continue;
    for (const line of readFileSync(join(d, f), 'utf8').split('\n')) {
      // A cheap prefilter: the ledger is large and almost none of it is this.
      if (!line.includes(`"${KIND}"`)) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.type !== 'event' || r.kind !== KIND) continue;
      if (id ? !(r.id === id || String(r.id ?? '').startsWith(id)) : r.t < from) continue;
      if (room != null && room !== '' && r.room?.num !== Number(room)) continue;
      if (agent && r.agent !== agent && r.character !== agent) continue;
      out.push(r);
    }
  }
  return out.sort((a, b) => b.t - a.t);
}

// ---------------------------------------------------------------- export as a fixture

/**
 * One row as a COMMITTABLE FIXTURE. Players near the door become `player B`/`stranger A` roles
 * (m59-recordjam's redactor), the subject is `player A`, and every string is scrubbed of this
 * machine's character names, unless `keepNames`. `replay` says how to stage it again.
 */
export async function exportDoorRefusal(row, { keepNames = false, names = null } = {}) {
  const roster = new Set([...(names ?? knownCharacterNames(REPO)), row.character, row.agent]
    .filter(n => typeof n === 'string' && n.length > 1));
  const { makeRedactor } = await import('./m59-recordjam.mjs');
  const redact = makeRedactor(roster, { keepNames });
  if (!keepNames) redact(row.character ?? row.agent ?? 'subject', true);   // the subject takes `player A`
  // WHOLE WORDS ONLY. Slot names are `t1`..`t21`; a substring scrub would mangle any string that
  // happens to contain one.
  const patterns = [...roster].sort((a, b) => b.length - a.length)
    .map(n => new RegExp(`(?<![A-Za-z0-9_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g'));
  const scrub = v => {
    if (typeof v === 'string') { if (keepNames) return v; for (const p of patterns) v = v.replace(p, 'player'); return v; }
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) =>
      [k, ['units_note', 'format', 'units', 'harness_sha', 'deploy_tag', 'id'].includes(k) ? x : scrub(x)]));
    return v;
  };
  const nearby = row.nearby ? { ...row.nearby, objects: (row.nearby.objects ?? []).map(o =>
    ({ ...o, name: o.kind === 'player' ? redact(o.name, true) : o.name })) } : null;
  return scrub({
    format: FIXTURE_FORMAT,
    refusal_id: row.id ?? null,
    captured_at: row.iso ?? null,
    units_note: row.units_note ?? UNITS_NOTE,
    room: row.room, door: row.door, source: row.source,
    expected: row.expected,
    subject: { name: keepNames ? (row.character ?? row.agent) : 'player A', actual: row.actual,
               posture: row.posture, vitals: row.vitals },
    nearby,
    movement: row.movement,
    failure: { verdict: row.verdict, server_message: row.server_message, said: row.said,
               opening_reason: row.opening_reason, attempt: row.attempt, attempts: row.attempts,
               refused_so_far: row.refused_so_far, summary: row.summary },
    code: row.code,
    ...(keepNames ? {} : { redaction: 'player names replaced by roles; --keep-names keeps them (local files only)' }),
    // HOW TO STAGE IT AGAIN. Stand the subject on `stand_on` in `room` (a shadow `walk` then
    // `crawl_to`), put the listed bodies where they were, and press. `seal` is the keeper's replay
    // bundle for the same moment, which `m59-shadow-replay.mjs` loads (docs/m59-shadow.md).
    replay: {
      room: row.room?.num ?? null,
      stand_on: row.expected?.trigger ?? null,
      body_was: row.actual?.at_press ?? row.actual?.after ?? null,
      press: row.door?.secret ? 'say the hall password' : 'go',
      walk: row.room?.num != null ? { to: row.room.num } : null,
      seal: row.replay_seal?.file ?? null,
    },
  });
}

// ---------------------------------------------------------------- CLI

function parseSince(s) {
  const m = String(s ?? '').match(/^(\d+(?:\.\d+)?)\s*([smhd])?$/);
  if (!m) return 24 * 3600_000;
  return Number(m[1]) * ({ s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] ?? 'h']);
}

function line(r) {
  return `${r.id ?? '?'}  ${String(r.iso ?? '').slice(0, 19)}Z  ${r.agent ?? '?'}  room ${r.room?.num ?? '?'}  ` +
         `door ${r.door?.sector ?? '?'} (${r.source})  ${r.verdict}  ` +
         `${r.attempt != null ? `press ${r.attempt}/${r.attempts ?? '?'}  ` : ''}— ${r.summary ?? ''}` +
         `${r.suppressed_since_last ? `  (+${r.suppressed_since_last} suppressed)` : ''}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
  const has = n => argv.includes('--' + n);
  const fleet = flag('fleet') ?? undefined, dir = flag('dir') ?? undefined;
  const exportId = flag('export');
  if (exportId) {
    const [row] = readDoorRefusals({ dir, fleet, id: exportId, sinceMs: Infinity });
    if (!row) { console.error(`no door refusal ${exportId}`); process.exit(1); }
    const out = flag('out');
    if (out && has('keep-names') && !relative(join(REPO, 'tools'), resolve(out)).startsWith('..')) {
      console.error(`refusing to write a fixture WITH character names under tools/ (${out}) — drop --keep-names`);
      process.exit(1);
    }
    const fx = await exportDoorRefusal(row, { keepNames: has('keep-names') });
    if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(out, JSON.stringify(fx, null, 2) + '\n'); console.log(`wrote ${out}`); }
    else console.log(JSON.stringify(fx, null, 2));
    process.exit(0);
  }
  const rows = readDoorRefusals({ dir, fleet, sinceMs: parseSince(flag('since', '24h')),
                                  room: flag('room'), agent: flag('agent') });
  if (has('json')) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
  if (!rows.length) { console.log('no door press refusals in that window'); process.exit(0); }
  const byVerdict = rows.reduce((m, r) => (m[r.verdict] = (m[r.verdict] ?? 0) + 1, m), {});
  console.log(`${rows.length} door press(es) that did not open: ` +
              Object.entries(byVerdict).map(([k, n]) => `${n} ${k}`).join(', '));
  for (const r of rows.slice(0, Number(flag('limit', 50)))) console.log(line(r));
}
