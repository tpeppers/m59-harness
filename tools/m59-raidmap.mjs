#!/usr/bin/env node
// THE RAID MAP — a recorded raid played back minute by minute: where every raider stood, under what order, and what went wrong.
//
//   node tools/m59-raidmap.mjs --run substrate/raids/ghost-shadow-2026-09-25T21-56-08
//   node tools/m59-raidmap.mjs --run <dir> --out /tmp/raid.html     # somewhere else
//   node tools/m59-raidmap.mjs --run <dir> --period 5                # fallback frame spacing, seconds
//   node tools/m59-raidmap.mjs --run <dir> --map substrate/m59-map.json
//
// Writes ONE self-contained HTML file (default `<run>/raidmap.html`): inline CSS and JS, the run
// embedded as JSON, no network, no fonts, nothing to keep running. Offline and read-only — it
// opens no socket and joins nobody. The Marauder's Map idea: scrub or play the run, see each
// raider as a dot with a dotted trail of where it walked, what it was ORDERED to do right then
// (the FleetScript step), what happened to it since the last minute-checkpoint, and the loose
// ends — idle characters, failed steps, deaths, the slowest step of every kind.
//
// Inputs, all read from the run directory and all optional except raid.json:
//   raid.json      fleet, agents, lightbearer, started, git, provenance
//   track.jsonl    every ~10 s: each unit's room, square, vitals, activity, current step, and the
//                  throne room's monsters (m59-ghostraid.mjs `startTrack`). THE input.
//   samples.jsonl  fight-only health samples — the fallback when there is no track: rooms and
//                  health, no squares. Finished `walk` steps and events that name a room fill in
//                  the muster, so a trackless run still shows who was where, just not on which square.
//   steps.jsonl    every FleetScript step (the ORDERS), events.jsonl, deaths.jsonl, report.json.
//
// Room geometry comes straight from substrate/m59-map.json (the .roo walls and the floor flags),
// read here rather than through m59-roomview.mjs's collectRoom, which also replays bakes, reads
// the tactics ledger and ranks safe spots — far more than a replay needs, for every room visited.
//
// Pure builders are exported (loadRun, buildRaidData, framesFromTrack, framesFromObservations,
// unitAt, orderAt, sinceWindow, sankeyBuckets, looseEnds, renderHtml) and pinned offline by
// m59-raidmap-test.mjs. Importing this module does nothing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { THRONE_GENERATORS, GHOST_ROOM, DOOR_ROOM } from './m59-ghostraid-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export const MINUTE = 60_000;
export const BUCKET_MS = 5 * MINUTE;       // the sankey's column width
export const IDLE_MS = 5 * MINUTE;         // same room and same order for longer than this is "idle"
export const GHOST_SQUARE = Object.freeze([2, 5]);                 // [row, col] where the ghost appears
export const THRONE_DOOR = Object.freeze([[23, 4], [23, 5]]);      // the door from room 38
export const HP_STALE_MS = 2 * MINUTE;     // a health reading older than this is not shown as current

// The unit tuple a frame carries per agent — arrays, not objects, because a three-hour run is a
// thousand frames of twenty-odd units and the page should open in well under a second.
export const U = Object.freeze({ room: 0, row: 1, col: 2, hp: 3, max: 4, mana: 5, mmax: 6, vigor: 7,
  act: 8, last: 9, step: 10, to: 11, since: 12, src: 13 });
export const SRC = Object.freeze({ track: 1, sample: 2, inferred: 3 });

// ------------------------------------------------------------------------------ reading a run

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function loadRun(dir) {
  const meta = readJson(path.join(dir, 'raid.json'));
  if (!meta) throw new Error(`no raid.json in ${dir}`);
  return {
    name: path.basename(path.resolve(dir)), dir,
    meta,
    track: readJsonl(path.join(dir, 'track.jsonl')),
    samples: readJsonl(path.join(dir, 'samples.jsonl')),
    steps: readJsonl(path.join(dir, 'steps.jsonl')),
    events: readJsonl(path.join(dir, 'events.jsonl')),
    deaths: readJsonl(path.join(dir, 'deaths.jsonl')),
    report: readJson(path.join(dir, 'report.json')),
  };
}

export function loadMapRooms(file = path.join(ROOT, 'substrate', 'm59-map.json')) {
  const w = readJson(file);
  if (!w?.rooms) return {};
  if (Array.isArray(w.rooms)) return Object.fromEntries(w.rooms.filter(Boolean).map(r => [String(r.num), r]));
  return w.rooms;
}

// ------------------------------------------------------------------------------ small pure helpers

/** A step's stable name: its label, else its `why`, else `do:to`. */
export function stepKey(s) {
  if (!s) return null;
  if (s.label) return String(s.label);
  if (s.why) return String(s.why);
  return `${s.do ?? '?'}${s.to != null ? ':' + s.to : ''}`;
}

/** "61/75" | 61 | {value,max} | {now,max} | {hp,max} -> {now, max} or null. */
export function parseVital(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? { now: v, max: null } : null;
  if (typeof v === 'string') {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?/.exec(v);
    return m ? { now: Number(m[1]), max: m[2] != null ? Number(m[2]) : null } : null;
  }
  if (typeof v === 'object') {
    const now = v.now ?? v.value ?? v.hp ?? v.current ?? null;
    return now == null ? null : { now: Number(now), max: v.max != null ? Number(v.max) : null };
  }
  return null;
}

/**
 * When a death HAPPENED. A deaths.jsonl row's `t` is the ledger row's, and in rehearsal 24 three
 * deaths forty seconds apart carry t ...517, ...518, ...519 — written in one batch. The post-mortem
 * file is named for the moment the keeper wrote it (`Eeee-2026-09-26T00-13-56-376Z.json`), so that
 * name wins when it parses and lies within five minutes BEFORE the recorded t.
 */
export function deathTime(d) {
  const t = Number(d?.t);
  const base = d?.postmortem ? String(d.postmortem).split(/[\\/]/).pop() : '';
  const m = /-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d+)Z\.json$/.exec(base);
  if (!m) return t;
  const pm = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(pm) && (!Number.isFinite(t) || (pm <= t && t - pm < 5 * MINUTE)) ? pm : t;
}

const num = v => (v == null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);

function makeInterner() {
  const S = [], at = new Map();
  const id = v => {
    if (v == null || v === '') return null;
    const k = String(v);
    let i = at.get(k);
    if (i == null) { i = S.length; S.push(k); at.set(k, i); }
    return i;
  };
  return { S, id };
}

// ------------------------------------------------------------------------------ geometry

/** One room from m59-map.json, reduced to what the replay draws: walls in SQUARE units, floor, exits. */
export function roomGeometry(r) {
  if (!r) return null;
  const rows = Number(r.rows) || 1, cols = Number(r.cols) || 1;
  const rawWalls = r.roo?.walls ?? [];
  // Same scale rule as m59-roomview.mjs: the .roo's fine units per square, as a power of two.
  let extent = 0;
  for (const w of rawWalls) extent = Math.max(extent, w[0], w[1], w[2], w[3]);
  const u = extent > 0 ? Math.pow(2, Math.round(Math.log2(extent / Math.max(rows, cols)))) : 1024;
  const q = v => Math.round((v / u) * 100) / 100;
  const walls = rawWalls.map(w => [q(w[0]), q(w[1]), q(w[2]), q(w[3])]);
  let floor = null;
  if (typeof r.roo?.flags === 'string') {
    try {
      const b = Buffer.from(r.roo.flags, 'base64');
      if (b.length >= rows * cols) { floor = ''; for (let i = 0; i < rows * cols; i++) floor += (b[i] & 1) ? '1' : '0'; }
    } catch { floor = null; }
  }
  const exits = (r.goExits ?? []).map(e => ({ row: e.row, col: e.col, to: e.to, locked: !!e.locked }));
  const edges = (r.edgeExits ?? []).map(e => ({ side: e.leaveName ?? e.leave ?? '?', to: e.to }));
  return { num: Number(r.num), name: r.name ?? `room ${r.num}`, rows, cols, walls, floor, exits, edges };
}

// ------------------------------------------------------------------------------ frames

/**
 * Track lines -> frames `{t, u:[tuple|null per agent], m?:{room, list:[[name,row,col]]}}`, sorted,
 * one per distinct t (the later line wins). A unit missing from one sample is carried forward from
 * the previous frame for up to `carryMs`, so one missed `fleet` row is not a blink.
 */
export function framesFromTrack(track, agentIndex, intern, { carryMs = MINUTE } = {}) {
  const lines = [...track].filter(l => Number.isFinite(Number(l?.t))).sort((a, b) => a.t - b.t);
  const out = [];
  for (const l of lines) {
    const t = Number(l.t);
    const u = new Array(agentIndex.size).fill(null);
    for (const x of l.units ?? []) {
      const ai = agentIndex.get(x.agent);
      if (ai == null) continue;
      const h = parseVital(x.health), m = parseVital(x.mana);
      const st = x.step ?? null;
      u[ai] = [num(x.room), num(x.row), num(x.col), h?.now ?? null, h?.max ?? null, m?.now ?? null, m?.max ?? null,
        num(parseVital(x.vigor)?.now), intern.id(x.activity), intern.id(x.last_action),
        st ? intern.id(st.label ?? st.why ?? st.do ?? '?') : null, st ? num(st.to) : null, st ? num(st.since) : null, SRC.track];
    }
    const f = { t, u };
    if (l.monsters && Array.isArray(l.monsters.list))
      f.m = { room: num(l.monsters.room), list: l.monsters.list.map(o => [String(o.name ?? '?'), num(o.row), num(o.col)]) };
    const prev = out[out.length - 1];
    if (prev) for (let i = 0; i < u.length; i++)
      if (!u[i] && prev.u[i] && t - (prev.ut?.[i] ?? prev.t) <= carryMs) { u[i] = prev.u[i]; (f.ut ??= [])[i] = prev.ut?.[i] ?? prev.t; }
    if (prev && prev.t === t) out[out.length - 1] = f; else out.push(f);
  }
  for (const f of out) delete f.ut;
  return out;
}

/**
 * What a trackless run still knows about where each raider was: samples (room + health), finished
 * `walk` steps (arrived in `to`), events naming a room (`where`, `room`) and deaths (health 0).
 */
export function observations(run, agentIndex) {
  const obs = new Map([...agentIndex.values()].map(i => [i, []]));
  const push = (agent, o) => { const i = agentIndex.get(agent); if (i != null && Number.isFinite(o.t)) obs.get(i).push(o); };
  for (const s of run.samples ?? []) push(s.agent, { t: Number(s.t), room: num(s.room_num ?? s.room), hp: num(s.hp), max: num(s.max), src: SRC.sample });
  for (const s of run.steps ?? []) if (s.do === 'walk' && s.ok && num(s.to) != null && Number.isFinite(s.t0))
    push(s.agent, { t: s.t0 + (s.ms ?? 0), room: num(s.to), src: SRC.inferred });
  for (const e of run.events ?? []) {
    const room = num(e.where ?? e.room);
    if (e.agent && room != null && ['buffs', 'left', 'gear', 'entered'].includes(e.kind)) push(e.agent, { t: Number(e.t), room, src: SRC.inferred });
    if (e.agent && e.kind === 'died') push(e.agent, { t: Number(e.t), hp: 0, src: SRC.inferred, dead: true });
  }
  for (const d of run.deaths ?? []) push(d.agent, { t: deathTime(d), hp: 0, room: num(d.room), src: SRC.inferred, dead: true });
  for (const list of obs.values()) list.sort((a, b) => a.t - b.t);
  return obs;
}

/** Frames every `period` ms over [t0, t1] from observations: room carried forward, health only while fresh. */
export function framesFromObservations(obs, nAgents, { t0, t1, period = 10_000, hpStaleMs = HP_STALE_MS } = {}) {
  const frames = [];
  if (!(t1 >= t0)) return frames;
  const ptr = new Array(nAgents).fill(0), room = new Array(nAgents).fill(null), roomSrc = new Array(nAgents).fill(null),
        hp = new Array(nAgents).fill(null);
  for (let t = t0; t <= t1 + period - 1; t += period) {
    const tt = Math.min(t, t1);
    const u = new Array(nAgents).fill(null);
    for (let i = 0; i < nAgents; i++) {
      const list = obs.get(i) ?? [];
      while (ptr[i] < list.length && list[ptr[i]].t <= tt) {
        const o = list[ptr[i]++];
        if (o.room != null) { room[i] = o.room; roomSrc[i] = o.src; }
        if (o.hp != null) hp[i] = { now: o.hp, max: o.max ?? hp[i]?.max ?? null, t: o.t };
      }
      const h = hp[i] && tt - hp[i].t <= hpStaleMs ? hp[i] : null;
      if (room[i] == null && !h) continue;
      u[i] = [room[i], null, null, h?.now ?? null, h?.max ?? null, null, null, null, null, null, null, null, null, roomSrc[i] ?? SRC.inferred];
    }
    frames.push({ t: tt, u });
    if (tt === t1) break;
  }
  return frames;
}

// The four helpers below are ALSO the page's: their source is injected into the HTML verbatim, so
// they are self-contained `function`s (no module constants, no arrows over outer names) and the
// tests exercise exactly the code the map runs.

/** The last frame index with frames[i].t <= t, or -1. */
export function frameIndexAt(frames, t) {
  var lo = 0, hi = frames.length - 1, ans = -1;
  while (lo <= hi) { var mid = (lo + hi) >> 1; if (frames[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

/**
 * Agent `ai` at time t: the frame at or before t, with the square linearly interpolated toward the
 * next frame when both are in the same room and no more than `maxGap` ms apart. Null before the
 * first frame or when that frame does not know the unit.
 */
export function unitAt(frames, ai, t, maxGap) {
  if (maxGap == null) maxGap = 60000;
  var i = frameIndexAt(frames, t);
  if (i < 0) return null;
  var a = frames[i].u[ai];
  if (!a) return null;
  var o = { room: a[0], row: a[1], col: a[2], hp: a[3], max: a[4], mana: a[5], mmax: a[6], vigor: a[7],
            act: a[8], last: a[9], step: a[10], to: a[11], since: a[12], src: a[13], ft: frames[i].t, fi: i };
  var f = frames[i + 1], b = f ? f.u[ai] : null;
  if (b && a[1] != null && b[1] != null && a[2] != null && b[2] != null && a[0] === b[0] && f.t > frames[i].t && f.t - frames[i].t <= maxGap) {
    var k = (t - frames[i].t) / (f.t - frames[i].t);
    if (k > 0) { o.row = a[1] + (b[1] - a[1]) * k; o.col = a[2] + (b[2] - a[2]) * k; }
  }
  return o;
}

/** The step agent `ai` was executing at t, from the steps list `{a, k, d, to, t0, ms, ...}` (latest start wins). */
export function orderAt(steps, ai, t) {
  var best = null;
  for (var j = 0; j < steps.length; j++) {
    var s = steps[j];
    if (s.a !== ai || s.t0 > t) continue;
    var end = s.t0 + (s.ms == null ? 0 : s.ms);
    if (t >= end) continue;
    if (!best || s.t0 >= best.t0) best = s;
  }
  return best;
}

/**
 * "Since the last checkpoint": what happened to `ai` in (t - w, t] — its events, the steps it
 * FINISHED, and its deaths. `ai === -1` asks for the fleet-wide events (the ones naming no raider).
 */
export function sinceWindow(data, ai, t, w) {
  if (w == null) w = 60000;
  var lo = t - w, ev = [], st = [], de = [];
  var events = data.events || [], steps = data.steps || [], deaths = data.deaths || [];
  for (var i = 0; i < events.length; i++) { var e = events[i]; if (e.a === ai && e.t > lo && e.t <= t) ev.push(e); }
  if (ai >= 0) {
    for (var j = 0; j < steps.length; j++) { var s = steps[j]; var end = s.t0 + (s.ms == null ? 0 : s.ms); if (s.a === ai && end > lo && end <= t) st.push(s); }
    for (var k = 0; k < deaths.length; k++) { var d = deaths[k]; if (d.a === ai && d.t > lo && d.t <= t) de.push(d); }
  }
  return { events: ev, steps: st, deaths: de };
}

// ------------------------------------------------------------------------------ sankey

/**
 * Raiders flowing through `key` (a room, or a step label) over `bucketMs` columns. Each raider is
 * counted once per column, under the key it held in most of that column's frames. The `topK` keys
 * by raider-columns keep their own row; the rest become `other`; a raider with no key is `unknown`.
 * Returns `{bucketMs, keys, cols:[{t, nodes:{key:n}}], links:[{c, from, to, n}]}` — links run c -> c+1.
 */
export function sankeyBuckets(frames, nAgents, keyOf, { t0, t1, bucketMs = BUCKET_MS, topK = 12 } = {}) {
  if (!frames.length) return { bucketMs, keys: [], cols: [], links: [] };
  t0 ??= frames[0].t; t1 ??= frames[frames.length - 1].t;
  const nb = Math.max(1, Math.ceil((t1 - t0 + 1) / bucketMs));
  const counts = Array.from({ length: nb }, () => Array.from({ length: nAgents }, () => new Map()));
  for (const f of frames) {
    const b = Math.min(nb - 1, Math.max(0, Math.floor((f.t - t0) / bucketMs)));
    for (let ai = 0; ai < nAgents; ai++) {
      const k = keyOf(f.u[ai], ai, f.t);
      if (k == null) continue;
      counts[b][ai].set(k, (counts[b][ai].get(k) ?? 0) + 1);
    }
  }
  // key per (bucket, agent)
  const raw = counts.map(row => row.map(m => { let best = null, bn = 0; for (const [k, n] of m) if (n > bn) { best = k; bn = n; } return best; }));
  const total = new Map();
  for (const row of raw) for (const k of row) if (k != null) total.set(k, (total.get(k) ?? 0) + 1);
  const ranked = [...total].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(x => x[0]);
  const kept = new Set(ranked.slice(0, topK));
  const norm = k => k == null ? 'unknown' : kept.has(k) ? String(k) : 'other';
  const keyed = raw.map(row => row.map(norm));
  const keys = [...ranked.slice(0, topK).map(String)];
  if (ranked.length > topK) keys.push('other');
  if (keyed.some(row => row.includes('unknown'))) keys.push('unknown');
  const cols = keyed.map((row, c) => {
    const nodes = {};
    for (const k of row) nodes[k] = (nodes[k] ?? 0) + 1;
    return { t: t0 + c * bucketMs, nodes };
  });
  const links = [];
  for (let c = 0; c + 1 < keyed.length; c++) {
    const m = new Map();
    for (let ai = 0; ai < nAgents; ai++) { const id = keyed[c][ai] + '\u0000' + keyed[c + 1][ai]; m.set(id, (m.get(id) ?? 0) + 1); }
    for (const [id, n] of m) { const [from, to] = id.split('\u0000'); links.push({ c, from, to, n }); }
  }
  return { bucketMs, keys, cols, links };
}

// ------------------------------------------------------------------------------ loose ends

/**
 * What went wrong, as lists a person can click through:
 *   idle     — same room and same order (or no order) for longer than IDLE_MS
 *   failed   — steps that returned ok:false
 *   deaths   — with killed_by and the step it died in
 *   slowest  — the slowest step of every label, with its median and count
 *   refusals — failed casts and similar events, counted per raider and kind
 *   unseen   — raiders the run names and no source ever placed
 */
export function looseEnds(data, { idleMs = IDLE_MS } = {}) {
  const { frames, steps, agents, S } = data;
  const nA = agents.length;
  const idle = [];
  for (let ai = 0; ai < nA; ai++) {
    let run = null;
    const close = endT => { if (run && run.room != null && endT - run.from > idleMs) idle.push({ a: ai, room: run.room, order: run.order, from: run.from, to: endT, ms: endT - run.from }); };
    for (const f of frames) {
      const u = f.u[ai];
      const room = u ? u[U.room] : null;
      let order = u && u[U.step] != null ? S[u[U.step]] : null;
      if (order == null) { const o = orderAt(steps, ai, f.t); order = o ? o.k : null; }
      const key = room + '|' + order;
      if (!run || run.key !== key) { if (run) close(f.t); run = { key, room, order, from: f.t }; }
      run.last = f.t;
    }
    if (run) close(run.last);
  }
  idle.sort((a, b) => b.ms - a.ms);
  const failed = steps.filter(s => s.ok === false).map(s => ({ a: s.a, k: s.k, d: s.d, to: s.to, t0: s.t0, ms: s.ms, outcome: s.outcome ?? null, dead: !!s.dead }))
    .sort((a, b) => a.t0 - b.t0);
  const deaths = data.deaths.map(d => ({ a: d.a, t: d.t, killed_by: d.killed_by ?? null, step: d.step ?? null, room: d.room ?? null }))
    .sort((a, b) => a.t - b.t);
  const byLabel = new Map();
  for (const s of steps) if (s.ms != null) { const l = byLabel.get(s.k) ?? []; l.push(s); byLabel.set(s.k, l); }
  const slowest = [...byLabel].map(([k, l]) => {
    const ms = l.map(s => s.ms).sort((a, b) => a - b);
    const top = l.reduce((m, s) => s.ms > m.ms ? s : m);
    return { k, n: l.length, median: ms[Math.floor((ms.length - 1) / 2)], max: top.ms, a: top.a, t0: top.t0 };
  }).sort((a, b) => b.max - a.max);
  const refusalKinds = { heal_failed: 1, light: 1, dazzle: 1, buffs: 1 };
  const rmap = new Map();
  for (const e of data.events) {
    if (!refusalKinds[e.kind]) continue;
    const bad = e.kind === 'heal_failed' || (e.kind === 'buffs' && (e.failed ?? 0) > 0)
      || ((e.kind === 'light' || e.kind === 'dazzle') && e.outcome && !/^(cast|landed|ok|already)/i.test(String(e.outcome)));
    if (!bad) continue;
    const id = e.a + '|' + e.kind;
    const r = rmap.get(id) ?? { a: e.a, kind: e.kind, n: 0, first: e.t, why: null };
    r.n += e.kind === 'buffs' ? (e.failed ?? 1) : 1;
    r.why ??= e.why ? (typeof e.why === 'string' ? e.why : Object.keys(e.why)[0]) : (e.outcome ?? null);
    rmap.set(id, r);
  }
  const refusals = [...rmap.values()].sort((a, b) => b.n - a.n);
  const seen = new Set();
  for (const f of frames) f.u.forEach((u, i) => { if (u) seen.add(i); });
  const unseen = agents.map((_, i) => i).filter(i => !seen.has(i));
  return { idle, failed, deaths, slowest, refusals, unseen, idleMs };
}

// ------------------------------------------------------------------------------ the whole model

export function buildRaidData(run, { rooms = {}, period = 10_000, bucketMs = BUCKET_MS, topK = 12 } = {}) {
  const meta = run.meta ?? {};
  const intern = makeInterner();

  // Who: raid.json's agents first, then anybody else a source names.
  const agentList = [];
  const agentIndex = new Map();
  const addAgent = a => { if (a && !agentIndex.has(a)) { agentIndex.set(a, agentList.length); agentList.push(a); } };
  for (const a of meta.agents ?? []) addAgent(a);
  for (const l of run.track ?? []) for (const u of l.units ?? []) addAgent(u.agent);
  for (const s of run.samples ?? []) addAgent(s.agent);
  for (const s of run.steps ?? []) addAgent(s.agent);
  const character = new Map();
  const note = (a, c) => { if (a && c && !character.has(a)) character.set(a, String(c)); };
  for (const l of run.track ?? []) for (const u of l.units ?? []) note(u.agent, u.character);
  for (const s of run.samples ?? []) note(s.agent, s.character);
  for (const e of run.events ?? []) note(e.agent, e.character);
  for (const d of run.deaths ?? []) note(d.agent, d.character);
  for (const r of run.report?.rows ?? []) note(r.agent, r.character);
  const roleOf = new Map((run.report?.rows ?? []).map(r => [r.agent, r.role]));
  const healers = new Set(String(meta.healers ?? '').split(/[,\s]+/).filter(Boolean));
  const agents = agentList.map(a => ({ agent: a, character: character.get(a) ?? a,
    role: a === meta.lightbearer ? 'light' : healers.has(a) ? 'healer' : (roleOf.get(a) ?? 'raider') }));
  const charToAgent = new Map(agents.map((x, i) => [x.character, i]));

  // Orders.
  const steps = (run.steps ?? []).filter(s => agentIndex.has(s.agent) && Number.isFinite(Number(s.t0)))
    .map(s => ({ a: agentIndex.get(s.agent), k: stepKey(s), d: s.do ?? null, to: num(s.to), t0: Number(s.t0), ms: num(s.ms),
                 ok: s.ok !== false, dead: !!s.dead, outcome: s.outcome ?? null, script: s.script ?? null }))
    .sort((a, b) => a.t0 - b.t0);

  // Events, attributed to a raider where they name one.
  const whoOf = e => {
    for (const f of ['agent', 'by', 'seen_by']) if (e[f] && agentIndex.has(e[f])) return agentIndex.get(e[f]);
    return -1;
  };
  const events = (run.events ?? []).filter(e => Number.isFinite(Number(e.t))).map(e => ({ ...e, t: Number(e.t), a: whoOf(e) }))
    .sort((a, b) => a.t - b.t);
  const deaths = (run.deaths ?? []).filter(d => Number.isFinite(Number(d.t)))
    .map(d => ({ t: deathTime(d), recorded: Number(d.t), a: agentIndex.get(d.agent) ?? charToAgent.get(d.character) ?? -1, killed_by: d.killed_by ?? null,
                 step: d.step ?? null, room: num(d.room), postmortem: d.postmortem ? path.basename(String(d.postmortem)) : null }))
    .filter(d => d.a >= 0);
  // A raid-observed death the ledger did not record is still a death.
  for (const e of events) if (e.kind === 'died' && e.a >= 0 && !deaths.some(d => d.a === e.a && Math.abs(d.t - e.t) < 3 * MINUTE))
    deaths.push({ t: e.t, a: e.a, killed_by: null, step: orderAt(steps, e.a, e.t)?.k ?? null, room: null, postmortem: null, observed: true });
  deaths.sort((a, b) => a.t - b.t);

  // The span.
  const ts = [];
  const started = Date.parse(meta.started ?? '');
  if (Number.isFinite(started)) ts.push(started);
  for (const l of run.track ?? []) ts.push(Number(l.t));
  for (const s of run.samples ?? []) ts.push(Number(s.t));
  for (const s of steps) { ts.push(s.t0); if (s.ms != null) ts.push(s.t0 + s.ms); }
  for (const e of events) ts.push(e.t);
  for (const d of deaths) ts.push(d.t);
  const good = ts.filter(Number.isFinite);
  const t0 = good.length ? Math.min(...good) : 0, t1 = good.length ? Math.max(...good) : 0;

  // Frames: the track where there is one, observations before it (or instead of it).
  const trackFrames = framesFromTrack(run.track ?? [], agentIndex, intern);
  const hasTrack = trackFrames.length > 0;
  let frames;
  if (hasTrack) {
    const obs = observations(run, agentIndex);
    const lead = trackFrames[0].t - period > t0
      ? framesFromObservations(obs, agentList.length, { t0, t1: trackFrames[0].t - 1, period }) : [];
    const tail = t1 > trackFrames[trackFrames.length - 1].t + 3 * period
      ? framesFromObservations(obs, agentList.length, { t0, t1, period }).filter(f => f.t > trackFrames[trackFrames.length - 1].t + period) : [];
    frames = [...lead.filter(f => f.t < trackFrames[0].t), ...trackFrames, ...tail];
  } else {
    frames = framesFromObservations(observations(run, agentIndex), agentList.length, { t0, t1, period });
  }

  // Rooms: every room anybody stood in, and every room an order pointed at.
  const visited = new Map();
  for (let i = 0; i < frames.length; i++) {
    const dt = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : period;
    for (const u of frames[i].u) if (u && u[U.room] != null) visited.set(u[U.room], (visited.get(u[U.room]) ?? 0) + dt);
  }
  const named = new Set([...visited.keys(), ...steps.map(s => s.to).filter(v => v != null), GHOST_ROOM, DOOR_ROOM]);
  const roomNames = {};
  for (const n of named) roomNames[n] = rooms[String(n)]?.name ?? null;
  const geo = {};
  for (const n of visited.keys()) { const g = roomGeometry(rooms[String(n)]); if (g) geo[n] = g; }
  const visitedList = [...visited].sort((a, b) => b[1] - a[1]).map(([n, ms]) => ({ num: n, ms }));

  // Timeline markers.
  const markerKinds = { entered: 'entered the throne room', ghost_gone: 'ghost gone', ghost_spawn: 'ghost spawned',
    phase: 'phase', checkpoint: 'checkpoint', stranger: 'stranger', left: 'left' };
  const markers = [];
  for (const e of events) if (markerKinds[e.kind]) {
    let text = markerKinds[e.kind];
    if (e.kind === 'phase') text += ' ' + (e.phase ?? '');
    if (e.kind === 'ghost_gone' && e.after_s != null) text += ` (${e.after_s}s after entry)`;
    if (e.kind === 'entered' && e.arrived != null) text += ` (${e.arrived}/${e.expected ?? '?'} arrived)`;
    if (e.kind === 'stranger') text += ': ' + (e.names ?? []).join(', ');
    if (e.a >= 0) text += ' — ' + agents[e.a].character;
    markers.push({ t: e.t, kind: e.kind, text });
  }
  for (const d of deaths) markers.push({ t: d.t, kind: 'died', text: `${agents[d.a].character} died${d.killed_by ? ' — ' + d.killed_by : ''}${d.step ? ' (' + d.step + ')' : ''}` });
  markers.sort((a, b) => a.t - b.t);

  // Sankeys: by room, and by order.
  const sankeyRoom = sankeyBuckets(frames, agentList.length, u => (u && u[U.room] != null ? String(u[U.room]) : null), { t0, t1, bucketMs, topK });
  const sankeyOrder = sankeyBuckets(frames, agentList.length, (u, ai, t) => {
    if (u && u[U.step] != null) return intern.S[u[U.step]];
    const o = orderAt(steps, ai, t);
    return o ? o.k : '(no order)';
  }, { t0, t1, bucketMs, topK });

  const git = meta.git ?? {};
  const rep = run.report ?? null;
  const data = {
    v: 1,
    meta: {
      name: run.name ?? null, fleet: meta.fleet ?? null, started: meta.started ?? null, lightbearer: meta.lightbearer ?? null,
      composed: meta.composed ?? null, minutes: meta.minutes ?? null, lab: meta.lab ?? null,
      git: { sha: git.sha ?? null, short: git.short ?? (git.sha ? String(git.sha).slice(0, 7) : null), branch: git.branch ?? null, dirty: !!git.dirty },
      provenance: meta.provenance ?? null,
      report: rep ? { ghost_killed: rep.ghost_killed ?? null, fight_seconds: rep.fight_seconds ?? null, participants: rep.participants ?? null,
                      survivors: rep.survivors ?? null, deaths_in_fight: rep.deaths_in_fight ?? null, deaths_in_window: rep.deaths_in_window ?? null } : null,
      generatedAt: new Date().toISOString(),
    },
    span: { t0, t1 }, period, hasTrack,
    trackRange: hasTrack ? { t0: trackFrames[0].t, t1: trackFrames[trackFrames.length - 1].t, n: trackFrames.length } : null,
    agents, S: intern.S, frames, steps, events, deaths,
    rooms: geo, roomNames, visited: visitedList, markers,
    sankey: { room: sankeyRoom, order: sankeyOrder },
    special: { ghostRoom: GHOST_ROOM, doorRoom: DOOR_ROOM, generators: THRONE_GENERATORS.map(g => [...g]), ghostSquare: [...GHOST_SQUARE], door: THRONE_DOOR.map(d => [...d]) },
  };
  data.loose = looseEnds(data);
  return data;
}

// ------------------------------------------------------------------------------ the page

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Pull the embedded data back out of a page (what the test does, and anyone checking a file). */
export function extractData(html) {
  const m = /<script type="application\/json" id="raid-data">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

export function renderHtml(data) {
  const LS = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
  const BS = String.fromCharCode(92);   // a backslash, spelled so no escape sequence has to survive an editor
  const json = JSON.stringify(data).replace(/</g, BS + 'u003c').replace(LS, c => BS + 'u' + c.charCodeAt(0).toString(16));
  const shared = [frameIndexAt, unitAt, orderAt, sinceWindow].map(f => f.toString()).join('\n\n');
  const title = `Raid map ${data.meta.name ?? ''}`.trim();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body>
<header id="hdr"></header>
<section id="timeline">
  <div class="controls">
    <button id="b-start" title="Start (Home)">&#x23EE;</button>
    <button id="b-min-back" title="Back one minute (Shift+Left)">&minus;1m</button>
    <button id="b-back" title="Back one sample (Left)">&lsaquo;</button>
    <button id="b-play" class="play" title="Play / pause (Space)">&#x25B6;</button>
    <button id="b-fwd" title="Forward one sample (Right)">&rsaquo;</button>
    <button id="b-min-fwd" title="Forward one minute (Shift+Right)">+1m</button>
    <button id="b-end" title="End (End)">&#x23ED;</button>
    <label>speed <select id="speed">
      <option value="10">10&times;</option><option value="30">30&times;</option><option value="60" selected>60&times;</option>
      <option value="120">120&times;</option><option value="300">300&times;</option><option value="600">600&times;</option></select></label>
    <label>trail <input id="trail" type="number" min="0" max="120" value="5"> min</label>
    <label class="chk"><input id="follow" type="checkbox" checked> auto-follow</label>
    <div class="clock"><span id="clock"></span><span id="elapsed"></span></div>
  </div>
  <div class="scrub"><div id="marks"></div><div id="cover"></div><input id="scrub" type="range" min="0" max="1" step="1" value="0"></div>
  <div id="legend-marks" class="legend"></div>
</section>
<nav id="world"></nav>
<main>
  <section id="roompane">
    <div id="roomhead"></div>
    <div class="roomwrap"><svg id="room" xmlns="http://www.w3.org/2000/svg"><g id="static"></g><g id="dyn"></g></svg>
      <aside id="roomside"></aside></div>
  </section>
  <section id="side"><h2>Raiders <small id="sidecount"></small></h2><div id="fleetwide"></div><div id="units"></div></section>
</main>
<section id="sankeypane"><h2>Flow <span class="seg"><button data-mode="room" class="on">by room</button><button data-mode="order">by order</button></span>
  <small>raiders per 5-minute column; click a column to jump there</small></h2>
  <div class="sankeywrap"><svg id="sankey" xmlns="http://www.w3.org/2000/svg"></svg></div><div id="sankeylegend" class="legend"></div></section>
<section id="loose"><h2>Loose ends <small>click any line to go there</small></h2><div class="cols" id="loosecols"></div></section>
<footer id="foot"></footer>
<script type="application/json" id="raid-data">${json}</script>
<script>
${shared}
${PAGE_JS}
</script>
</body></html>
`;
}

const CSS = `
:root{
  --paper:#f4ecd8; --panel:#fbf6ea; --sunk:#ebe0c6; --ink:#2f2417; --muted:#6f5e46; --faint:#a8987c; --rule:#d6c7a6;
  --accent:#7a3b1d; --good:#3f7d3a; --warn:#b7791f; --bad:#b0322a; --dead:#6b6259; --mon:#8f1d4a; --ghost:#6a3fb0;
  --floor:#efe4c9; --wall:#3a2c1c; --spawn:#b0322a; --hi:#fff3c4;
  color-scheme: light;
}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
  --paper:#1b1814; --panel:#24201b; --sunk:#2c2721; --ink:#eadfc8; --muted:#b3a58a; --faint:#7d7260; --rule:#3d362d;
  --accent:#e0a26c; --good:#79b86d; --warn:#e0b14f; --bad:#e46a5c; --dead:#8c8479; --mon:#e2679a; --ghost:#b395f0;
  --floor:#2b261f; --wall:#d9c9a8; --spawn:#e46a5c; --hi:#3b3322; color-scheme: dark; } }
:root[data-theme="dark"]{
  --paper:#1b1814; --panel:#24201b; --sunk:#2c2721; --ink:#eadfc8; --muted:#b3a58a; --faint:#7d7260; --rule:#3d362d;
  --accent:#e0a26c; --good:#79b86d; --warn:#e0b14f; --bad:#e46a5c; --dead:#8c8479; --mon:#e2679a; --ghost:#b395f0;
  --floor:#2b261f; --wall:#d9c9a8; --spawn:#e46a5c; --hi:#3b3322; color-scheme: dark; }
*{box-sizing:border-box}
html,body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.4 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
.mono,.clock,small,.num{font-family:ui-monospace,"Cascadia Mono",Consolas,Menlo,monospace}
h1,h2{font-weight:600;letter-spacing:.02em;margin:0}
h2{font-size:15px;font-variant:small-caps;letter-spacing:.06em;color:var(--accent);margin:0 0 6px}
h2 small{font-variant:normal;letter-spacing:0;color:var(--muted);font-weight:400;font-size:11px;margin-left:8px}
button,select,input{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--rule);border-radius:4px}
button{cursor:pointer;padding:3px 9px}
button:hover{border-color:var(--accent)}
button.on{background:var(--accent);color:var(--panel);border-color:var(--accent)}
header{padding:12px 16px 8px;border-bottom:1px double var(--rule);display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline}
header h1{font-size:22px;font-style:italic;margin-right:8px}
header .chip{font-size:12px;color:var(--muted)} header .chip b{color:var(--ink);font-weight:600}
header .flag{color:var(--bad);font-weight:600}
#timeline{padding:8px 16px;background:var(--sunk);border-bottom:1px solid var(--rule);position:sticky;top:0;z-index:5}
.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.controls label{font-size:12px;color:var(--muted);display:flex;gap:4px;align-items:center}
.controls input[type=number]{width:52px;padding:2px 4px}
.controls .play{min-width:40px;font-weight:700}
.clock{margin-left:auto;font-size:14px;display:flex;gap:12px}
#elapsed{color:var(--muted)}
.scrub{position:relative;height:34px;margin-top:6px}
#scrub{position:absolute;left:0;right:0;bottom:0;width:100%;margin:0;accent-color:var(--accent)}
#marks,#cover{position:absolute;left:8px;right:8px;top:0;height:18px}
#cover div{position:absolute;top:14px;height:4px;background:var(--good);opacity:.35;border-radius:2px}
.mk{position:absolute;top:0;width:3px;height:14px;margin-left:-1px;cursor:pointer;border-radius:1px}
.mk:hover{transform:scaleX(2)}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--muted);margin-top:2px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
#world{padding:8px 16px;display:flex;flex-wrap:wrap;gap:5px;border-bottom:1px solid var(--rule)}
.rc{font-size:12px;padding:2px 7px;border:1px solid var(--rule);border-radius:3px;background:var(--panel);cursor:pointer;color:var(--faint);white-space:nowrap}
.rc b{font-family:ui-monospace,Consolas,monospace;color:inherit}
.rc.occ{color:var(--ink);border-color:var(--muted)}
.rc.occ .n{background:var(--accent);color:var(--panel);border-radius:8px;padding:0 5px;margin-left:4px;font-family:ui-monospace,Consolas,monospace}
.rc.cur{outline:2px solid var(--accent);outline-offset:1px}
main{display:grid;grid-template-columns:minmax(0,1fr) 440px;gap:14px;padding:12px 16px}
#roompane{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:10px;min-width:0}
#roomhead{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}
#roomhead .rn{font-size:18px;font-style:italic}
#roomhead small{color:var(--muted)}
.roomwrap{display:flex;gap:10px;align-items:flex-start}
svg#room{flex:1;min-width:0;height:640px;background:var(--sunk);border-radius:4px}
#roomside{width:190px;font-size:12px;max-height:640px;overflow:auto}
#roomside h3{font-size:12px;font-variant:small-caps;color:var(--accent);margin:4px 0}
#roomside div{padding:1px 0}
#side{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:10px;max-height:760px;overflow:auto}
#fleetwide{font-size:12px;margin-bottom:6px}
.u{border-top:1px solid var(--rule);padding:5px 2px 6px}
.u.here{background:linear-gradient(90deg,var(--hi),transparent 80%)}
.u.dead{background:linear-gradient(90deg,color-mix(in srgb,var(--bad) 22%,transparent),transparent 85%)}
.u .l1{display:flex;gap:6px;align-items:baseline}
.u .nm{font-weight:600} .u .ag{font-size:11px;color:var(--faint)}
.u .role{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent)}
.u .rm{margin-left:auto;font-size:11px;padding:0 5px;cursor:pointer}
.bar{position:relative;height:10px;background:var(--sunk);border-radius:2px;margin:3px 0;overflow:hidden}
.bar i{position:absolute;left:0;top:0;bottom:0}
.bar span{position:absolute;right:3px;top:-2px;font-size:10px;font-family:ui-monospace,Consolas,monospace;color:var(--ink);text-shadow:0 0 2px var(--panel),0 0 2px var(--panel),0 0 3px var(--panel)}
.ord{font-size:12px} .ord b{color:var(--accent)} .ord .dur{color:var(--muted);font-family:ui-monospace,Consolas,monospace;font-size:11px}
.act{font-size:11px;color:var(--muted);font-style:italic}
.since{display:flex;flex-wrap:wrap;gap:3px;margin-top:3px}
.tag{font-size:10.5px;padding:0 5px;border-radius:3px;background:var(--sunk);font-family:ui-monospace,Consolas,monospace}
.tag.bad{background:var(--bad);color:var(--panel)} .tag.ok{color:var(--good)} .tag.warn{color:var(--warn)}
#sankeypane,#loose{margin:0 16px 14px;background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:10px}
.seg{margin-left:10px;font-variant:normal} .seg button{font-size:11px;padding:1px 8px}
.sankeywrap{overflow-x:auto}
#sankey text{font-family:ui-monospace,Consolas,monospace;font-size:10px;fill:var(--ink)}
#loose .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}
#loose h3{font-size:13px;font-variant:small-caps;color:var(--accent);margin:0 0 4px}
#loose .li{font-size:12px;padding:2px 4px;border-radius:3px;cursor:pointer}
#loose .li:hover{background:var(--sunk)}
#loose .box{max-height:300px;overflow:auto}
#loose .none{color:var(--faint);font-size:12px}
footer{padding:8px 16px 20px;font-size:11px;color:var(--faint)}
svg text{font-family:ui-monospace,Consolas,monospace}
@media (max-width:1100px){ main{grid-template-columns:1fr} #side{max-height:none} }
`;

const PAGE_JS = String.raw`
var D = JSON.parse(document.getElementById('raid-data').textContent);
var S = D.S, A = D.agents, F = D.frames, T0 = D.span.t0, T1 = Math.max(D.span.t1, D.span.t0 + 1);
var $ = function(id){ return document.getElementById(id); };
function s(i){ return i == null ? null : S[i]; }
function esc(x){ return String(x == null ? '' : x).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function css(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function pad(n){ return (n < 10 ? '0' : '') + n; }
function clock(t){ var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function dur(ms){ if (ms == null) return '?'; var x = Math.round(ms/1000), h = Math.floor(x/3600), m = Math.floor(x%3600/60), sec = x%60;
  return h ? h + 'h' + pad(m) + 'm' : m ? m + 'm' + pad(sec) + 's' : sec + 's'; }
function tplus(t){ var x = Math.round((t - T0)/1000), neg = x < 0; x = Math.abs(x);
  return 'T' + (neg ? '-' : '+') + Math.floor(x/3600) + ':' + pad(Math.floor(x%3600/60)) + ':' + pad(x%60); }
function rname(n){ if (n == null) return '?'; var nm = D.roomNames[n] || (D.rooms[n] && D.rooms[n].name); return n + (nm ? ' ' + nm : ''); }
function hcol(frac){ return frac == null ? css('--faint') : frac >= .66 ? css('--good') : frac >= .33 ? css('--warn') : css('--bad'); }
function hue(i){ return 'hsl(' + Math.round((i * 137.508) % 360) + ' 55% 45%)'; }
function keyColor(k){ if (k === 'other') return css('--faint'); if (k === 'unknown') return css('--rule');
  var h = 0; for (var i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return 'hsl(' + (h % 360) + ' 45% 52%)'; }
var MK = { entered:'--accent', ghost_gone:'--good', ghost_spawn:'--ghost', died:'--bad', phase:'--warn', checkpoint:'--muted', stranger:'--mon', left:'--faint' };
var MKLABEL = { entered:'entered', ghost_gone:'ghost gone', ghost_spawn:'ghost spawn', died:'death', phase:'phase', checkpoint:'checkpoint', stranger:'stranger', left:'left' };

var st = { t: T0, playing: false, speed: 60, trail: 5, follow: true, room: null, mode: 'room', last: 0, drawnRoom: null, sideKey: null };
var stepsBy = A.map(function(){ return []; });
D.steps.forEach(function(x){ if (stepsBy[x.a]) stepsBy[x.a].push(x); });
var deathsBy = A.map(function(){ return []; });
D.deaths.forEach(function(d){ if (deathsBy[d.a]) deathsBy[d.a].push(d); });
function orderFor(ai, u, t){
  if (u && u.step != null) return { k: s(u.step), to: u.to, t0: u.since, src: 'track' };
  var o = orderAt(stepsBy[ai], ai, t); return o ? { k: o.k, to: o.to, t0: o.t0, d: o.d } : null;
}
function deadAt(ai, u, t){
  var ds = deathsBy[ai], last = null;
  for (var i = 0; i < ds.length; i++) if (ds[i].t <= t) last = ds[i];
  if (!last || t - last.t > 90000) return null;
  if (u && u.hp > 0 && u.ft > last.t + 5000) return null;
  return last;
}
function units(t){ return A.map(function(_, ai){ return unitAt(F, ai, t); }); }

// ------------------------------------------------------------------ header
(function(){
  var m = D.meta, h = '<h1>' + esc(m.name || 'raid') + '</h1>';
  function chip(k, v){ return v == null || v === '' ? '' : '<span class="chip">' + k + ' <b>' + esc(v) + '</b></span>'; }
  h += chip('fleet', m.fleet) + chip('git', (m.git.short || '') + (m.git.branch ? ' @ ' + m.git.branch : '') + (m.git.dirty ? ' (dirty)' : ''));
  h += chip('provenance', m.provenance == null ? null : typeof m.provenance === 'string' ? m.provenance : JSON.stringify(m.provenance));
  h += chip('started', m.started ? new Date(m.started).toLocaleString() : null) + chip('span', dur(T1 - T0));
  h += chip('raiders', A.length) + chip('light-bearer', m.lightbearer ? (A.filter(function(a){ return a.agent === m.lightbearer; })[0] || {}).character || m.lightbearer : null);
  if (m.report) h += chip('ghost', m.report.ghost_killed ? 'killed in ' + m.report.fight_seconds + 's' : 'not killed') + chip('survivors', m.report.survivors + '/' + m.report.participants);
  h += '<span class="chip">deaths <b>' + D.deaths.length + '</b></span>';
  if (!D.hasTrack) h += '<span class="chip flag">no track.jsonl — rooms and health only, no squares</span>';
  $('hdr').innerHTML = h;
  $('foot').textContent = 'Generated ' + m.generatedAt + ' by tools/m59-raidmap.mjs — ' + F.length + ' frames, ' + D.steps.length + ' steps, ' + D.events.length + ' events. '
    + 'Keys: Space play/pause, Left/Right one sample, Shift+Left/Right one minute, Home/End.';
})();

// ------------------------------------------------------------------ timeline
var scrub = $('scrub'); scrub.min = T0; scrub.max = T1;
(function(){
  var h = '', seen = {};
  D.markers.forEach(function(k, i){
    seen[k.kind] = 1;
    h += '<div class="mk" data-i="' + i + '" style="left:' + ((k.t - T0) / (T1 - T0) * 100).toFixed(3) + '%;background:var(' + (MK[k.kind] || '--muted') + ')" title="' + esc(clock(k.t) + '  ' + k.text) + '"></div>';
  });
  $('marks').innerHTML = h;
  $('marks').onclick = function(e){ var i = e.target.getAttribute('data-i'); if (i != null) setT(D.markers[+i].t, true); };
  var lg = ''; Object.keys(seen).forEach(function(k){ lg += '<span><i style="background:var(' + MK[k] + ')"></i>' + MKLABEL[k] + '</span>'; });
  if (D.trackRange) lg += '<span><i style="background:var(--good);opacity:.4"></i>track recorded</span>';
  $('legend-marks').innerHTML = lg;
  if (D.trackRange) $('cover').innerHTML = '<div style="left:' + ((D.trackRange.t0 - T0)/(T1 - T0)*100) + '%;width:' + ((D.trackRange.t1 - D.trackRange.t0)/(T1 - T0)*100) + '%"></div>';
})();
scrub.oninput = function(){ setT(+scrub.value, true); };
function setT(t, user){ st.t = Math.max(T0, Math.min(T1, t)); if (user) st.playing = false; render(); }
function stepSample(dir){
  var i = frameIndexAt(F, st.t);
  if (dir > 0) { var j = i + 1; while (j < F.length && F[j].t <= st.t) j++; setT(j < F.length ? F[j].t : T1, true); }
  else { var k = (i >= 0 && F[i].t < st.t) ? i : i - 1; setT(k >= 0 ? F[k].t : T0, true); }
}
$('b-start').onclick = function(){ setT(T0, true); };
$('b-end').onclick = function(){ setT(T1, true); };
$('b-back').onclick = function(){ stepSample(-1); };
$('b-fwd').onclick = function(){ stepSample(1); };
$('b-min-back').onclick = function(){ setT(st.t - 60000, true); };
$('b-min-fwd').onclick = function(){ setT(st.t + 60000, true); };
$('b-play').onclick = togglePlay;
$('speed').onchange = function(){ st.speed = +this.value; };
$('trail').onchange = function(){ st.trail = Math.max(0, +this.value || 0); render(); };
$('follow').onchange = function(){ st.follow = this.checked; render(); };
function togglePlay(){ if (!st.playing && st.t >= T1) st.t = T0; st.playing = !st.playing; st.last = performance.now(); if (st.playing) requestAnimationFrame(tick); render(); }
function tick(now){
  if (!st.playing) return;
  var dt = Math.min(250, now - st.last); st.last = now;
  st.t += dt * st.speed;
  if (st.t >= T1) { st.t = T1; st.playing = false; }
  render();
  if (st.playing) requestAnimationFrame(tick);
}
document.addEventListener('keydown', function(e){
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range' || e.target.tagName === 'SELECT') return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? setT(st.t - 60000, true) : stepSample(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? setT(st.t + 60000, true) : stepSample(1); }
  else if (e.key === 'Home') { e.preventDefault(); setT(T0, true); }
  else if (e.key === 'End') { e.preventDefault(); setT(T1, true); }
});

// ------------------------------------------------------------------ world strip
function renderWorld(us){
  var count = {};
  us.forEach(function(u){ if (u && u.room != null) count[u.room] = (count[u.room] || 0) + 1; });
  var h = '';
  D.visited.forEach(function(v){
    var n = count[v.num] || 0;
    h += '<span class="rc' + (n ? ' occ' : '') + (v.num === st.room ? ' cur' : '') + '" data-room="' + v.num + '" title="' + esc(rname(v.num)) + ' — ' + dur(v.ms) + ' raider-time">'
      + '<b>' + v.num + '</b> ' + esc(((D.roomNames[v.num] || '') + '').slice(0, 22)) + (n ? '<span class="n">' + n + '</span>' : '') + '</span>';
  });
  $('world').innerHTML = h || '<span class="rc">no room was ever observed</span>';
  return count;
}
$('world').onclick = function(e){ var el = e.target.closest('[data-room]'); if (el) pickRoom(+el.getAttribute('data-room')); };
function pickRoom(n){ st.room = n; st.follow = false; $('follow').checked = false; render(); }

// ------------------------------------------------------------------ room view
var SVGNS = 'http://www.w3.org/2000/svg';
function drawStatic(n){
  var g = D.rooms[n], svg = $('room'), h = '';
  if (!g) { svg.setAttribute('viewBox', '0 0 10 10'); $('static').innerHTML = '<text x="5" y="5" text-anchor="middle" font-size=".6" fill="' + css('--muted') + '">no geometry for room ' + n + '</text>'; return; }
  var P = 1.5;
  svg.setAttribute('viewBox', (-P) + ' ' + (-P) + ' ' + (g.cols + 2*P) + ' ' + (g.rows + 2*P));
  h += '<rect x="0" y="0" width="' + g.cols + '" height="' + g.rows + '" fill="none" stroke="' + css('--rule') + '" stroke-width=".05"/>';
  if (g.floor) for (var r = 0; r < g.rows; r++) for (var c = 0; c < g.cols; c++) if (g.floor[r*g.cols + c] === '1')
    h += '<rect x="' + c + '" y="' + r + '" width="1" height="1" fill="' + css('--floor') + '" stroke="' + css('--rule') + '" stroke-width=".02"/>';
  if (g.walls.length) { var d = ''; g.walls.forEach(function(w){ d += 'M' + w[0] + ' ' + w[1] + 'L' + w[2] + ' ' + w[3]; });
    h += '<path d="' + d + '" stroke="' + css('--wall') + '" stroke-width=".12" stroke-linecap="round" fill="none" opacity=".85"/>'; }
  g.exits.forEach(function(e){
    h += '<rect x="' + (e.col - 1 + .1) + '" y="' + (e.row - 1 + .1) + '" width=".8" height=".8" fill="none" stroke="' + css('--accent') + '" stroke-width=".08" stroke-dasharray=".15 .1"><title>exit to ' + esc(rname(e.to)) + '</title></rect>';
    h += '<text x="' + (e.col - .5) + '" y="' + (e.row - 1 - .12) + '" font-size=".55" text-anchor="middle" fill="' + css('--accent') + '">&#x2192;' + e.to + '</text>';
  });
  // every 5th row/col numbered, so a square named in a log can be found
  for (var rr = 5; rr <= g.rows; rr += 5) h += '<text x="-.3" y="' + (rr - .3) + '" font-size=".5" text-anchor="end" fill="' + css('--faint') + '">r' + rr + '</text>';
  for (var cc = 5; cc <= g.cols; cc += 5) h += '<text x="' + (cc - .5) + '" y="-.3" font-size=".5" text-anchor="middle" fill="' + css('--faint') + '">c' + cc + '</text>';
  if (g.edges.length) h += '<text x="0" y="' + (g.rows + 1) + '" font-size=".55" fill="' + css('--accent') + '">edges: ' + esc(g.edges.map(function(e){ return e.side + ' → ' + e.to; }).join(', ')) + '</text>';
  if (n === D.special.ghostRoom) {
    D.special.generators.forEach(function(p, i){
      h += '<g><circle cx="' + (p[1] - .5) + '" cy="' + (p[0] - .5) + '" r=".46" fill="none" stroke="' + css('--spawn') + '" stroke-width=".07" stroke-dasharray=".12 .08"/>'
        + '<text x="' + (p[1] - .5) + '" y="' + (p[0] - .5 + .2) + '" font-size=".5" text-anchor="middle" fill="' + css('--spawn') + '">S' + (i + 1) + '</text><title>spawn square r' + p[0] + 'c' + p[1] + '</title></g>';
    });
    var gs = D.special.ghostSquare;
    h += '<g><rect x="' + (gs[1] - 1 + .05) + '" y="' + (gs[0] - 1 + .05) + '" width=".9" height=".9" rx=".2" fill="none" stroke="' + css('--ghost') + '" stroke-width=".08"/>'
      + '<text x="' + (gs[1] - .5) + '" y="' + (gs[0] - .5 + .2) + '" font-size=".55" text-anchor="middle" fill="' + css('--ghost') + '">G</text><title>where the ghost appears, r' + gs[0] + 'c' + gs[1] + '</title></g>';
    D.special.door.forEach(function(p){ h += '<rect x="' + (p[1] - 1) + '" y="' + (p[0] - .25) + '" width="1" height=".25" fill="' + css('--accent') + '"><title>door to room 38</title></rect>'; });
  }
  $('static').innerHTML = h;
}
function renderRoom(us, count){
  var n = st.room;
  if (st.drawnRoom !== n) { drawStatic(n); st.drawnRoom = n; }
  var g = D.rooms[n], h = '', here = [], unplaced = [];
  us.forEach(function(u, ai){ if (u && u.room === n) (u.row != null ? here : unplaced).push(ai); });
  // trails
  if (st.trail > 0 && g) {
    var i0 = Math.max(0, frameIndexAt(F, st.t - st.trail * 60000)), i1 = frameIndexAt(F, st.t);
    A.forEach(function(_, ai){
      var segs = [], cur = [];
      for (var i = i0; i <= i1; i++) {
        var u = F[i].u[ai];
        if (u && u[0] === n && u[1] != null) cur.push((u[2] - .5).toFixed(2) + ',' + (u[1] - .5).toFixed(2));
        else if (cur.length) { segs.push(cur); cur = []; }
      }
      var now = us[ai]; if (now && now.room === n && now.row != null && cur.length) cur.push((now.col - .5).toFixed(2) + ',' + (now.row - .5).toFixed(2));
      if (cur.length) segs.push(cur);
      segs.forEach(function(sg){ if (sg.length > 1) h += '<polyline points="' + sg.join(' ') + '" fill="none" stroke="' + hue(ai) + '" stroke-width=".16" stroke-linecap="round" stroke-dasharray=".01 .32" opacity=".9"/>'; });
    });
  }
  // monsters
  var fi = frameIndexAt(F, st.t), mons = [];
  for (var j = fi; j >= 0 && j > fi - 3; j--) if (F[j].m) { if (F[j].m.room === n) mons = F[j].m.list; break; }
  mons.forEach(function(m){
    if (m[1] == null) return;
    var ghost = /ghost/i.test(m[0]), x = m[2] - .5, y = m[1] - .5, r = ghost ? .42 : .3;
    h += '<g><path d="M' + x + ' ' + (y - r) + 'L' + (x + r) + ' ' + y + 'L' + x + ' ' + (y + r) + 'L' + (x - r) + ' ' + y + 'Z" fill="' + css(ghost ? '--ghost' : '--mon') + '" opacity=".85"/><title>' + esc(m[0]) + ' r' + m[1] + 'c' + m[2] + '</title></g>';
  });
  // raiders, grouped by square so a stack reads as a stack
  var groups = {};
  here.forEach(function(ai){ var u = us[ai]; var k = Math.round(u.row) + ',' + Math.round(u.col); (groups[k] = groups[k] || []).push(ai); });
  Object.keys(groups).forEach(function(k){
    var g2 = groups[k], nn = g2.length;
    g2.forEach(function(ai, idx){
      var u = us[ai], dd = deadAt(ai, u, st.t), frac = u.hp != null && u.max ? u.hp / u.max : null;
      var ang = idx / nn * Math.PI * 2, off = nn > 1 ? Math.min(.42, .16 + nn * .03) : 0;
      var x = u.col - .5 + Math.cos(ang) * off, y = u.row - .5 + Math.sin(ang) * off;
      var fill = dd ? css('--dead') : hcol(frac);
      h += '<g><circle cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r=".34" fill="' + fill + '" stroke="' + hue(ai) + '" stroke-width=".1"/>';
      if (dd) h += '<text x="' + x.toFixed(2) + '" y="' + (y + .18).toFixed(2) + '" font-size=".5" text-anchor="middle" fill="' + css('--panel') + '">&#x2020;</text>';
      h += '<title>' + esc(A[ai].character + ' (' + A[ai].agent + ') r' + Math.round(u.row) + 'c' + Math.round(u.col) + (u.hp != null ? ' — ' + u.hp + '/' + (u.max || '?') : '') + (dd ? ' — DEAD: ' + (dd.killed_by || '?') : '')) + '</title></g>';
    });
    var u0 = us[g2[0]];
    var label = A[g2[0]].character + (nn > 1 ? ' +' + (nn - 1) : '');
    h += '<text x="' + (u0.col + .05).toFixed(2) + '" y="' + (u0.row - .55).toFixed(2) + '" font-size=".58" fill="' + css('--ink') + '" stroke="' + css('--sunk') + '" stroke-width=".14" paint-order="stroke">' + esc(label) + '<title>' + esc(g2.map(function(ai){ return A[ai].character; }).join(', ')) + '</title></text>';
  });
  $('dyn').innerHTML = h;
  // header + side list
  var nm = rname(n);
  $('roomhead').innerHTML = '<span class="rn">' + esc(nm) + '</span><small>' + (count[n] || 0) + ' raider(s) here' + (g ? ' · ' + g.rows + '×' + g.cols + ' squares' : '') + (st.follow ? ' · auto-following the busiest room' : '') + '</small>';
  var side = '';
  if (here.length) side += '<h3>on a square</h3>' + here.map(function(ai){ return unitLine(ai, us[ai]); }).join('');
  if (unplaced.length) side += '<h3>here, square unknown</h3>' + unplaced.map(function(ai){ return unitLine(ai, us[ai]); }).join('');
  if (mons.length) side += '<h3>monsters (' + mons.length + ')</h3>' + mons.map(function(m){ return '<div>' + esc(m[0]) + (m[1] != null ? ' <small>r' + m[1] + 'c' + m[2] + '</small>' : '') + '</div>'; }).join('');
  var rc = null; D.events.forEach(function(e){ if (e.kind === 'room' && e.t <= st.t && n === D.special.ghostRoom) rc = e; });
  if (rc && rc.count && st.t - rc.t < 120000) side += '<h3>raid count, ' + dur(st.t - rc.t) + ' ago</h3>' + Object.keys(rc.count).map(function(k){ return '<div>' + esc(k) + ' <b>' + rc.count[k] + '</b></div>'; }).join('');
  if (!here.length && !unplaced.length) side += '<div style="color:var(--faint)">nobody here at this moment</div>';
  $('roomside').innerHTML = side;
}
function unitLine(ai, u){
  var frac = u.hp != null && u.max ? u.hp / u.max : null, dd = deadAt(ai, u, st.t);
  return '<div><span style="color:' + (dd ? css('--dead') : hcol(frac)) + '">&#x25CF;</span> ' + esc(A[ai].character) + ' <small>' + (u.hp != null ? u.hp + '/' + (u.max || '?') : '') + (dd ? ' dead' : '') + '</small></div>';
}

// ------------------------------------------------------------------ side panel
function tagEvent(e){
  var k = e.kind, bad = /died|heal_failed|retreat|left|stranger/.test(k) || (k === 'buffs' && e.failed > 0), txt = k;
  if (k === 'retreat') txt += ' ' + Math.round((e.health || 0) * 100) + '%';
  else if (k === 'kill') txt += ' ' + (e.creature || '');
  else if (k === 'heal_failed') txt += ' on ' + (e.on || '?');
  else if (k === 'buffs') txt += ' ' + (e.bless || 0) + 'b/' + (e.strength || 0) + 's' + (e.failed ? ' ' + e.failed + ' failed' : '');
  else if (k === 'light' || k === 'dazzle') txt += ' ' + (e.outcome || '');
  else if (k === 'left') txt += ' to ' + e.room;
  else if (k === 'phase') txt += ' ' + (e.phase || '');
  return '<span class="tag' + (bad ? ' warn' : '') + '" title="' + esc(clock(e.t) + ' ' + JSON.stringify(e)) + '">' + esc(txt) + '</span>';
}
function tagStep(x){
  return '<span class="tag ' + (x.ok ? 'ok' : 'bad') + '" title="' + esc(clock(x.t0) + ' ' + x.d + (x.to != null ? ' to ' + x.to : '') + (x.outcome ? ' — ' + x.outcome : '')) + '">' + (x.ok ? '&#x2713; ' : '&#x2717; ') + esc(x.k) + ' ' + dur(x.ms) + '</span>';
}
function renderSide(us){
  var key = Math.floor(st.t / 1000);
  if (st.sideKey === key + '|' + st.room) return;
  st.sideKey = key + '|' + st.room;
  var fw = sinceWindow(D, -1, st.t, 60000); fw.events = fw.events.filter(function(e){ return e.kind !== 'room'; });
  $('fleetwide').innerHTML = fw.events.length ? '<b>Fleet, last minute:</b> ' + fw.events.map(tagEvent).join(' ') : '';
  var order = A.map(function(_, i){ return i; }).sort(function(a, b){ return A[a].character.localeCompare(A[b].character); });
  var h = '', placed = 0;
  order.forEach(function(ai){
    var u = us[ai], o = orderFor(ai, u, st.t), w = sinceWindow(D, ai, st.t, 60000), dd = deadAt(ai, u, st.t);
    if (u) placed++;
    var frac = u && u.hp != null && u.max ? u.hp / u.max : null;
    h += '<div class="u' + (u && u.room === st.room ? ' here' : '') + (dd || w.deaths.length ? ' dead' : '') + '">';
    h += '<div class="l1"><span class="nm">' + esc(A[ai].character) + '</span><span class="ag">' + esc(A[ai].agent) + '</span>' + (A[ai].role !== 'raider' ? '<span class="role">' + esc(A[ai].role) + '</span>' : '')
      + (u && u.room != null ? '<button class="rm" data-room="' + u.room + '">' + esc(rname(u.room).slice(0, 28)) + (u.row != null ? ' · r' + Math.round(u.row) + 'c' + Math.round(u.col) : '') + '</button>' : '<span class="rm" style="color:var(--faint)">not seen</span>') + '</div>';
    if (u && u.hp != null) h += '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, (frac || 0) * 100)).toFixed(0) + '%;background:' + (dd ? css('--dead') : hcol(frac)) + '"></i><span>' + u.hp + '/' + (u.max || '?') + (u.mana != null ? '  mana ' + u.mana + '/' + (u.mmax || '?') : '') + (u.vigor != null ? '  vig ' + u.vigor : '') + '</span></div>';
    else h += '<div class="bar" title="no health reading this minute"><span>health —</span></div>';
    if (o) h += '<div class="ord">&#x25B8; <b>' + esc(o.k) + '</b>' + (o.to != null ? ' &#x2192; ' + esc(rname(o.to)) : '') + (o.t0 != null ? ' <span class="dur">' + dur(st.t - o.t0) + '</span>' : '') + '</div>';
    else h += '<div class="ord" style="color:var(--faint)">no order</div>';
    var act = u ? [s(u.act), s(u.last)].filter(Boolean).join(' · ') : '';
    if (act) h += '<div class="act">' + esc(act) + '</div>';
    var tags = w.deaths.map(function(d){ return '<span class="tag bad">&#x2020; ' + esc(d.killed_by || 'died') + (d.step ? ' · ' + esc(d.step) : '') + '</span>'; })
      .concat(w.steps.map(tagStep), w.events.map(tagEvent));
    if (tags.length) h += '<div class="since">' + tags.join('') + '</div>';
    h += '</div>';
  });
  $('units').innerHTML = h;
  $('sidecount').textContent = placed + '/' + A.length + ' placed · since ' + clock(st.t - 60000);
}
$('units').onclick = function(e){ var el = e.target.closest('[data-room]'); if (el) pickRoom(+el.getAttribute('data-room')); };

// ------------------------------------------------------------------ sankey
var SK = { colW: 74, unit: 9, gap: 6, top: 18, left: 8 };
function drawSankey(){
  var sk = D.sankey[st.mode], svg = $('sankey');
  if (!sk.cols.length) { svg.setAttribute('width', 300); svg.setAttribute('height', 30); svg.innerHTML = '<text x="8" y="20">nothing to draw</text>'; $('sankeylegend').innerHTML = ''; return; }
  var order = {}; sk.keys.forEach(function(k, i){ order[k] = i; });
  var pos = [], H = 0;
  sk.cols.forEach(function(c, ci){
    var y = SK.top, p = {};
    sk.keys.forEach(function(k){ var n = c.nodes[k]; if (!n) return; p[k] = { y: y, h: n * SK.unit, out: y, inn: y }; y += n * SK.unit + SK.gap; });
    pos.push(p); H = Math.max(H, y);
  });
  var W = SK.left + sk.cols.length * SK.colW + 60, nw = 12, h = '';
  sk.links.forEach(function(l){
    var a = pos[l.c][l.from], b = pos[l.c + 1][l.to]; if (!a || !b) return;
    var x0 = SK.left + l.c * SK.colW + nw, x1 = SK.left + (l.c + 1) * SK.colW, th = l.n * SK.unit, ya = a.out + th/2, yb = b.inn + th/2; a.out += th; b.inn += th;
    var mx = (x0 + x1) / 2;
    h += '<path d="M' + x0 + ' ' + ya + 'C' + mx + ' ' + ya + ' ' + mx + ' ' + yb + ' ' + x1 + ' ' + yb + '" stroke="' + keyColor(l.from) + '" stroke-width="' + th + '" fill="none" opacity="' + (l.from === l.to ? .28 : .5) + '"><title>' + esc(label(l.from) + ' → ' + label(l.to) + ': ' + l.n) + '</title></path>';
  });
  sk.cols.forEach(function(c, ci){
    var x = SK.left + ci * SK.colW;
    h += '<rect class="col" data-t="' + c.t + '" x="' + (x - 4) + '" y="0" width="' + SK.colW + '" height="' + H + '" fill="transparent"/>';
    h += '<text x="' + x + '" y="11" fill="' + css('--muted') + '">' + clock(c.t).slice(0, 5) + '</text>';
    Object.keys(pos[ci]).forEach(function(k){
      var p = pos[ci][k];
      h += '<rect x="' + x + '" y="' + p.y + '" width="' + nw + '" height="' + p.h + '" fill="' + keyColor(k) + '" pointer-events="none"><title>' + esc(label(k) + ': ' + c.nodes[k]) + '</title></rect>';
      if (p.h >= 9) h += '<text x="' + (x + nw + 2) + '" y="' + (p.y + Math.min(p.h, 18)/2 + 3) + '" pointer-events="none">' + esc(short(k)) + '</text>';
    });
  });
  h += '<line id="skcur" y1="0" y2="' + H + '" stroke="' + css('--bad') + '" stroke-width="2"/>';
  svg.setAttribute('width', W); svg.setAttribute('height', H + 4); svg.innerHTML = h;
  $('sankeylegend').innerHTML = sk.keys.map(function(k){ return '<span><i style="background:' + keyColor(k) + '"></i>' + esc(label(k)) + '</span>'; }).join('');
}
function label(k){ return st.mode === 'room' && /^\d+$/.test(k) ? rname(+k) : k; }
function short(k){ var t = label(k); return t.length > 11 ? t.slice(0, 10) + '…' : t; }
function sankeyCursor(){
  var sk = D.sankey[st.mode], c = $('skcur'); if (!c || !sk.cols.length) return;
  var x = SK.left + (st.t - sk.cols[0].t) / sk.bucketMs * SK.colW;
  c.setAttribute('x1', x); c.setAttribute('x2', x);
}
$('sankey').onclick = function(e){ var t = e.target.getAttribute('data-t'); if (t) setT(+t, true); };
document.querySelectorAll('#sankeypane .seg button').forEach(function(b){ b.onclick = function(){
  st.mode = b.getAttribute('data-mode'); document.querySelectorAll('#sankeypane .seg button').forEach(function(x){ x.classList.toggle('on', x === b); }); drawSankey(); sankeyCursor(); }; });

// ------------------------------------------------------------------ loose ends
(function(){
  var L = D.loose, cols = [];
  function li(t, room, html){ return '<div class="li" data-t="' + t + '"' + (room != null ? ' data-go="' + room + '"' : '') + '>' + html + '</div>'; }
  function box(title, items, empty){ return '<div><h3>' + title + ' <small>(' + items.length + ')</small></h3><div class="box">' + (items.length ? items.join('') : '<div class="none">' + empty + '</div>') + '</div></div>'; }
  cols.push(box('Deaths', L.deaths.map(function(d){ return li(d.t, d.room, '<b style="color:var(--bad)">&#x2020; ' + esc(A[d.a].character) + '</b> ' + clock(d.t) + ' <small>' + tplus(d.t) + '</small> — ' + esc(d.killed_by || '?') + (d.step ? ' <small>in ' + esc(d.step) + '</small>' : '')); }), 'nobody died'));
  cols.push(box('Idle &gt; ' + Math.round(L.idleMs / 60000) + ' min <small>same room, same order</small>', L.idle.slice(0, 80).map(function(x){ return li(x.from, x.room, '<b>' + esc(A[x.a].character) + '</b> ' + dur(x.ms) + ' in ' + esc(rname(x.room)) + ' under <i>' + esc(x.order || 'no order') + '</i> <small>' + clock(x.from) + '–' + clock(x.to) + '</small>'); }), 'nobody sat still that long'));
  cols.push(box('Failed steps', L.failed.map(function(x){ return li(x.t0, null, '<b>' + esc(A[x.a].character) + '</b> <span class="tag bad">' + esc(x.k) + '</span> after ' + dur(x.ms) + ' <small>' + clock(x.t0) + (x.outcome ? ' — ' + esc(x.outcome) : '') + (x.dead ? ' — died' : '') + '</small>'); }), 'every step returned ok'));
  cols.push(box('Slowest step of each kind', L.slowest.map(function(x){ return li(x.t0, null, '<b>' + esc(x.k) + '</b> ' + dur(x.max) + ' <small>(' + esc(A[x.a].character) + '; median ' + dur(x.median) + ', n=' + x.n + ')</small>'); }), 'no steps recorded'));
  cols.push(box('Refused casts and failures', L.refusals.map(function(x){ return li(x.first, null, '<b>' + esc(x.a >= 0 ? A[x.a].character : 'fleet') + '</b> ' + esc(x.kind) + ' &times;' + x.n + (x.why ? ' <small>' + esc(String(x.why).slice(0, 90)) + '</small>' : '')); }), 'none recorded'));
  if (L.unseen.length) cols.push(box('Never placed', L.unseen.map(function(ai){ return li(T0, null, esc(A[ai].character + ' (' + A[ai].agent + ')') + ' — no source ever put it in a room'); }), ''));
  $('loosecols').innerHTML = cols.join('');
  $('loosecols').onclick = function(e){ var el = e.target.closest('[data-t]'); if (!el) return; var r = el.getAttribute('data-go'); if (r != null && r !== 'null') { st.room = +r; st.follow = false; $('follow').checked = false; } setT(+el.getAttribute('data-t'), true); window.scrollTo({ top: 0, behavior: 'smooth' }); };
})();

// ------------------------------------------------------------------ render
function busiest(count){
  var best = st.room, bn = best != null ? (count[best] || 0) : -1;
  Object.keys(count).forEach(function(k){ var n = count[k]; k = +k; if (n > bn || (n === bn && k === D.special.ghostRoom)) { best = k; bn = n; } });
  return best;
}
function render(){
  var us = units(st.t);
  var count = {}; us.forEach(function(u){ if (u && u.room != null) count[u.room] = (count[u.room] || 0) + 1; });
  if (st.follow || st.room == null) st.room = busiest(count) != null ? busiest(count) : (D.visited[0] ? D.visited[0].num : D.special.ghostRoom);
  renderWorld(us);
  renderRoom(us, count);
  renderSide(us);
  scrub.value = st.t;
  $('clock').textContent = clock(st.t);
  $('elapsed').textContent = tplus(st.t) + ' / ' + dur(T1 - T0);
  $('b-play').innerHTML = st.playing ? '&#x275A;&#x275A;' : '&#x25B6;';
  sankeyCursor();
}
// Where to open: #t=<epoch ms | ISO | T+h:mm:ss>&room=<num> (shareable), else the first moment
// anybody is placed. The hash is kept current while scrubbing, so a link names the moment on screen.
function fromHash(){
  var q = {}; location.hash.replace(/^#/, '').split('&').forEach(function(p){ var kv = p.split('='); if (kv[0]) q[kv[0]] = decodeURIComponent(kv[1] || ''); });
  var t = null;
  if (q.t) { var m = /^T\+?(\d+):(\d\d):(\d\d)$/.exec(q.t);
    t = m ? T0 + ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 : /^\d+$/.test(q.t) ? +q.t : Date.parse(q.t); }
  if (q.room) { st.room = +q.room; st.follow = false; $('follow').checked = false; }
  return t != null && isFinite(t) ? t : null;
}
var firstPlaced = T0;
for (var fi0 = 0; fi0 < F.length; fi0++) if (F[fi0].u.some(function(u){ return u && u[0] != null; })) { firstPlaced = F[fi0].t; break; }
var startT = fromHash();
st.t = Math.max(T0, Math.min(T1, startT != null ? startT : firstPlaced));
var hashTimer = null;
var _render = render;
render = function(){ _render(); if (!st.playing) { clearTimeout(hashTimer); hashTimer = setTimeout(function(){
  try { history.replaceState(null, '', '#t=' + Math.round(st.t) + (st.follow ? '' : '&room=' + st.room)); } catch (e) {} }, 300); } };
drawSankey();
render();
`;

// ------------------------------------------------------------------------------ CLI

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

export function main() {
  const run = arg('--run') ?? process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!run) {
    console.error('usage: node tools/m59-raidmap.mjs --run <raid dir> [--out <file>] [--map <m59-map.json>] [--period <s>]');
    process.exit(2);
  }
  const dir = path.resolve(run);
  const loaded = loadRun(dir);
  const rooms = loadMapRooms(arg('--map') ?? path.join(ROOT, 'substrate', 'm59-map.json'));
  const period = Math.max(1, Number(arg('--period', 10))) * 1000;
  const data = buildRaidData(loaded, { rooms, period });
  const out = path.resolve(arg('--out') ?? path.join(dir, 'raidmap.html'));
  fs.writeFileSync(out, renderHtml(data));
  console.log(`${data.frames.length} frames (${data.hasTrack ? `track: ${data.trackRange.n} samples` : 'no track — rooms and health only'}), `
    + `${data.agents.length} raiders, ${data.visited.length} rooms, ${data.deaths.length} deaths`);
  console.log(out);
}

// Windows argv[1] is a drive path rather than a URL, and not comparable to import.meta.url.
const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) main();
