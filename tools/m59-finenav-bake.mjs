#!/usr/bin/env node
// BAKE THE FINE NAVIGATION GRAPH: footings as nodes, edges proved by the mover's own trace.
//
//   node tools/m59-finenav-bake.mjs --rooms 578,599,2144,2154     these rooms, merged into the table
//   node tools/m59-finenav-bake.mjs --rooms all --jobs 2           every room; at most TWO workers
//   node tools/m59-finenav-bake.mjs --rooms 578 --check            bake and report, write nothing
//   node tools/m59-finenav-bake.mjs --out some/file.json.gz        somewhere else
//
// A SIBLING OF m59-routebake.mjs, NOT A CHANGE TO IT. It writes substrate/m59-finenav.json.gz
// with its own format version (FINE_NAV_VERSION in m59-finenav.mjs) and the map's geometry
// manifest; the routing table, `standPoint` and STEP_MASK_VERSION are untouched. Nothing on the
// hot path reads this file yet. docs/m59-fine-nav-design.md is the argument for every rule below.
//
// SHARES CORES WITH THE LIVE FLEET. It drops its own priority and every worker's, and refuses
// more than two workers: the routebake's `--jobs 8` habit froze a live broker once
// (offline-tests-share-cores-with-prod). All 264 rooms at pitch 256 is a few minutes per core.
//
// PER ROOM, IN ORDER:
//
//   1. SAMPLES. Each standable square on a `pitch` lattice (256 client units: 4x4), every
//      point on the wire lattice (a multiple of 16). A sample is a place a body can BE:
//      floor, an interior sector, not within 2 units of any wall line that is not a plain
//      step-compatible floor seam (so never ON a one-sided wall, the 578 r2c10 trap), and four
//      16-unit probes all free (so not inside PLAYER_RADIUS of a wall that blocks from this
//      side). A standable square with no such sample is resampled at `refine` (64).
//   2. FOOTINGS. Directed straight-trace edges between lattice neighbours, both ways asked;
//      footings are the strongly connected pieces. Directed, because walls are one-sided and
//      drops one-way: an undirected join called 578's r2c10 one place.
//   3. A REPRESENTATIVE per footing: the member deepest inside it (lattice distance to the
//      nearest non-member), ties to the centroid. Footing 0 of a square is the one holding
//      the square's legacy stand point, so `"row,col"` keys keep meaning what they meant.
//   4. EDGES, from the representative, to every footing in the 8 neighbour squares and the
//      other footings of its own square:
//        walk   the straight trace arrives at the target's representative
//        slide  it does not; the mover's own slide-and-quantize lands the body at `land`, and
//               the edge goes to the footing the body is really IN (a straight walk from
//               `land` reaches its representative) — whichever square that is
//        fall   `fall: true` arrives where a walk does not, onto lower ground, out to three
//               squares; `timed` when the frame-by-frame fall also proves it
//   5. EXITS attach to footings: every footing in a `go` door's square; for an edge exit,
//      the footing whose representative reaches the baked `fine_stand_on` of each approach
//      that fires THAT exit (`edgeCandidatesOf`), with the crossing target kept as published.
//   6. DOOR STATES. A room whose routing table carries `stepMaskVariants` is baked again in
//      each variant (`applySectorHeights` on a private geometry). Moving sectors listed in
//      substrate/m59-variable-sectors.json that no variant covers are recorded as
//      `moving.unmodelled` and every plan in that room says so.
//
// NOT IN THIS BAKE: declared fall-jumps (substrate/m59-falljumps.json is under audit and is
// left alone), string-pulled pivots (a plan is rep-to-rep, about a square a leg), ceilings
// that move (`m59-ceiling-doorbake.mjs` territory). Each is listed in the design doc.

import os from 'node:os';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { fork } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { loadMap, edgeCandidatesOf } from './m59-map.mjs';
import { routesFor } from './m59-routes.mjs';
import { sharedRoomGeometry, RoomGeometry, applySectorHeights, exitSquaresOf, protocolToClient,
         STEP_MASK_DIRS, MAX_STEP_HEIGHT, CLIENT_FINENESS as F } from './m59-roo.mjs';
import { FINE_NAV_FILE, FINE_NAV_FORMAT, FINE_NAV_VERSION, EDGE, STRAIGHT, encodeRoom, landFrom }
  from './m59-finenav.mjs';

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = 2;           // client units: the clearance probe (>= PLAYER_RADIUS + 2 from a facing wall)
const ON_LINE = 2;         // client units: "on a wall line"
const MIN_SLIDE = 32;      // a slide that moves the body less than this went nowhere
const FALL_SQUARES = 3;    // FALL_MAX_SQUARES in m59-roo.mjs

// ------------------------------------------------------------------------------- the bake

/** Walls that decide anything about where a body may be, bucketed by square. */
function wallBuckets(geo) {
  const buckets = new Map();
  for (const w of geo.walls ?? []) {
    if (w.passable) {
      const a = w.sector1?.floorHeight, b = w.sector2?.floorHeight;
      if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= MAX_STEP_HEIGHT) continue;
    }
    const x0 = Math.min(w.x0, w.x1) - ON_LINE, x1 = Math.max(w.x0, w.x1) + ON_LINE;
    const y0 = Math.min(w.y0, w.y1) - ON_LINE, y1 = Math.max(w.y0, w.y1) + ON_LINE;
    for (let c = Math.max(1, Math.floor(x0 / F) + 1); c <= Math.min(geo.cols, Math.floor(x1 / F) + 1); c++)
      for (let r = Math.max(1, Math.floor(y0 / F) + 1); r <= Math.min(geo.rows, Math.floor(y1 / F) + 1); r++) {
        const k = (r - 1) * geo.cols + (c - 1);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(w);
      }
  }
  return buckets;
}

function onWallLine(walls, x, y) {
  for (const w of walls ?? []) {
    const dx = w.x1 - w.x0, dy = w.y1 - w.y0, len2 = dx * dx + dy * dy;
    if (!(len2 > 0)) continue;
    const t = Math.max(0, Math.min(1, ((x - w.x0) * dx + (y - w.y0) * dy) / len2));
    if (Math.hypot(w.x0 + t * dx - x, w.y0 + t * dy - y) <= ON_LINE) return true;
  }
  return false;
}

function samplesOf(geo, row, col, pitch, walls, counter) {
  const N = Math.round(F / pitch), x0 = (col - 1) * F, y0 = (row - 1) * F;
  const pts = new Array(N * N).fill(null);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = x0 + Math.round((i + 0.5) * pitch), y = y0 + Math.round((j + 0.5) * pitch);
    if (!geo._occupiable(x, y)) continue;
    const h = geo.floorBaseAtClient(x, y);
    if (h == null || onWallLine(walls, x, y)) continue;
    let clear = true;
    for (const [px, py] of [[PROBE, 0], [-PROBE, 0], [0, PROBE], [0, -PROBE]]) {
      counter.traces++;
      if (!geo.traceFineMoveClient(x, y, x + px, y + py, STRAIGHT).arrived) { clear = false; break; }
    }
    if (clear) pts[j * N + i] = { x, y, h, i, j };
  }
  return { N, pts };
}

/** Does the square hold a floor band (heights within a step of each other) no clear sample is on? */
function missesABand(geo, row, col, pitch, pts) {
  const N = Math.round(F / pitch), x0 = (col - 1) * F, y0 = (row - 1) * F, hs = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = x0 + Math.round((i + 0.5) * pitch), y = y0 + Math.round((j + 0.5) * pitch);
    if (!geo._occupiable(x, y)) continue;
    const h = geo.floorBaseAtClient(x, y);
    if (h != null) hs.push(h);
  }
  if (!hs.length) return false;
  hs.sort((a, b) => a - b);
  const bands = [[hs[0], hs[0]]];
  for (const h of hs) { const b = bands.at(-1); if (h - b[1] <= MAX_STEP_HEIGHT) b[1] = h; else bands.push([h, h]); }
  if (bands.length < 2 && pts.some(Boolean)) return false;
  return bands.some(([lo, hi]) => !pts.some(p => p && p.h >= lo - MAX_STEP_HEIGHT && p.h <= hi + MAX_STEP_HEIGHT));
}

function footingsOfSquare(geo, row, col, N, pts, counter) {
  const adj = pts.map(() => []);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const ka = j * N + i, a = pts[ka];
    if (!a) continue;
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      if (i + di >= N || j + dj >= N) continue;
      const kb = (j + dj) * N + i + di, b = pts[kb];
      if (!b) continue;
      counter.traces += 2;
      if (geo.traceFineMoveClient(a.x, a.y, b.x, b.y, STRAIGHT).arrived) adj[ka].push(kb);
      if (geo.traceFineMoveClient(b.x, b.y, a.x, a.y, STRAIGHT).arrived) adj[kb].push(ka);
    }
  }
  const reach = pts.map((p, k) => {
    if (!p) return null;
    const seen = new Set([k]), q = [k];
    for (let h = 0; h < q.length; h++) for (const n of adj[q[h]]) if (!seen.has(n)) { seen.add(n); q.push(n); }
    return seen;
  });
  const owner = new Array(pts.length).fill(-1), out = [];
  pts.forEach((p, k) => {
    if (!p || owner[k] >= 0) return;
    const members = [];
    for (const m of reach[k]) if (reach[m]?.has(k)) { owner[m] = k; members.push(m); }
    const set = new Set(members);
    const cx = members.reduce((s, m) => s + pts[m].x, 0) / members.length;
    const cy = members.reduce((s, m) => s + pts[m].y, 0) / members.length;
    let best = null, bestScore = -Infinity;
    for (const m of members) {
      const p = pts[m];
      let d = Infinity;
      for (let jj = -1; jj <= N; jj++) for (let ii = -1; ii <= N; ii++) {
        if (ii >= 0 && ii < N && jj >= 0 && jj < N && set.has(jj * N + ii)) continue;
        d = Math.min(d, Math.max(Math.abs(ii - p.i), Math.abs(jj - p.j)));
      }
      const score = d * 1e6 - Math.hypot(p.x - cx, p.y - cy);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    // members and their directed adjacency are kept until the edges are built: an edge that
    // cannot be proved representative to representative is proved through them (`chain`).
    const local = new Map(members.map((m, i) => [m, i]));
    out.push({ row, col, rep: { x: best.x, y: best.y }, floor: best.h, size: members.length,
               samples: members.map(m => ({ x: pts[m].x, y: pts[m].y, h: pts[m].h })),
               madj: members.map(m => adj[m].filter(n => local.has(n)).map(n => local.get(n))),
               repLocal: local.get(pts.indexOf(best)), edges: [] });
  });
  return out;
}

/**
 * Bake one room's graph on `geo`. Returns the in-memory shape `encodeRoom` takes.
 * `exitSource` is the room object exits are read from (always the map's room).
 */
export function bakeRoom(room, geo, { pitch = 256, refine = 64, variant = null } = {}) {
  const t0 = performance.now();
  const counter = { traces: 0 };
  const buckets = wallBuckets(geo);
  const stats = { squares: 0, refined: 0, empty: 0, multi: 0 };
  // 1-3: samples, footings, representatives
  const perSquare = new Map();
  for (let row = 1; row <= geo.rows; row++) for (let col = 1; col <= geo.cols; col++) {
    if (!geo.standable(row, col)) continue;
    stats.squares++;
    const walls = buckets.get((row - 1) * geo.cols + (col - 1));
    let s = samplesOf(geo, row, col, pitch, walls, counter);
    // REFINE WHERE THE COARSE LATTICE MISSED A FLOOR, not only where it found none. A ledge
    // narrower than the pitch inside a square that also holds the valley floor is exactly the
    // ground this graph exists for: 578's r32c46 is valley at 3200 with a 7072 shelf through
    // it that the walk to the south exit uses, and pitch 256 sampled only the valley. Floors
    // are cheap to read (no trace), so every square is asked which height bands it holds.
    // and once more at half the refine pitch if a band is STILL unrepresented: a shelf a body
    // fits on can be narrower than 64 units of free centre line.
    for (const p of [refine, refine / 2]) {
      if (!(p && p < pitch) || !(!s.pts.some(Boolean) || missesABand(geo, row, col, p, s.pts))) break;
      stats.refined++;
      const finer = samplesOf(geo, row, col, p, walls, counter);
      if (finer.pts.some(Boolean)) s = finer;
    }
    if (!s.pts.some(Boolean)) { stats.empty++; continue; }
    const list = footingsOfSquare(geo, row, col, s.N, s.pts, counter);
    if (list.length > 1) stats.multi++;
    list.sort((a, b) => b.size - a.size);       // largest first; footing 0 is chosen below
    perSquare.set((row - 1) * geo.cols + (col - 1), { list });
  }
  // FOOTING 0 holds the square's legacy stand point (mutual straight walk), else the largest.
  const footings = [];
  for (let row = 1; row <= geo.rows; row++) for (let col = 1; col <= geo.cols; col++) {
    const entry = perSquare.get((row - 1) * geo.cols + (col - 1));
    if (!entry) continue;
    const list = entry.list, sp = geo.standPoint(row, col);
    let zi = -1;
    if (sp && list.length > 1) {
      const ranked = list.map((f, i) => ({ i, d: Math.min(...f.samples.map(p => Math.hypot(p.x - sp.x, p.y - sp.y))) }))
                         .sort((a, b) => a.d - b.d);
      for (const { i } of ranked.slice(0, 3)) {
        const f = list[i];
        counter.traces += 2;
        if (geo.traceFineMoveClient(sp.x, sp.y, f.rep.x, f.rep.y, STRAIGHT).arrived
            && geo.traceFineMoveClient(f.rep.x, f.rep.y, sp.x, sp.y, STRAIGHT).arrived) { zi = i; break; }
      }
    }
    if (zi > 0) list.unshift(...list.splice(zi, 1));
    for (const f of list) { f.id = footings.length; footings.push(f); }
  }
  const bySquare = new Map();
  for (const f of footings) {
    const k = (f.row - 1) * geo.cols + (f.col - 1);
    if (!bySquare.has(k)) bySquare.set(k, []);
    bySquare.get(k).push(f);
  }
  const at = (row, col) => (row >= 1 && col >= 1 && row <= geo.rows && col <= geo.cols)
    ? (bySquare.get((row - 1) * geo.cols + (col - 1)) ?? []) : [];
  // A WALK INSIDE ONE FOOTING, sample to sample. The footing is strongly connected over
  // straight lattice steps, so a chain always exists; it is then pulled tight with the same
  // straight trace, so every link handed out is one the mover was asked about.
  const straight = (p, q) => { counter.traces++; return geo.traceFineMoveClient(p.x, p.y, q.x, q.y, STRAIGHT).arrived; };
  const pull = pts => {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1;) {
      let j = pts.length - 1;
      while (j > i + 1 && !straight(pts[i], pts[j])) j--;
      out.push(pts[j]); i = j;
    }
    return out;
  };
  const chain = (f, fromLocal, toLocal) => {
    if (fromLocal === toLocal) return [f.samples[fromLocal]];
    const prev = new Map([[fromLocal, -1]]), q = [fromLocal];
    for (let h = 0; h < q.length && !prev.has(toLocal); h++)
      for (const n of f.madj[q[h]]) if (!prev.has(n)) { prev.set(n, q[h]); q.push(n); }
    if (!prev.has(toLocal)) return null;
    const out = [];
    for (let k = toLocal; k !== -1; k = prev.get(k)) out.push(f.samples[k]);
    return pull(out.reverse());
  };
  const pt = p => ({ x: p.x, y: p.y });
  // WHERE A LANDED BODY REALLY IS: a footing it can walk to the representative of — straight,
  // or straight to one of its samples and then along the footing. Checked, never assumed.
  // Returns { f, via } where via is the points after `p`, ending at rep(f).
  const placeLanding = (p, prefer, exclude) => {
    const row = Math.floor(p.y / F) + 1, col = Math.floor(p.x / F) + 1;
    const cands = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++)
      for (const f of at(row + dr, col + dc)) if (f !== exclude)
        cands.push({ f, d: Math.hypot(f.rep.x - p.x, f.rep.y - p.y) - (f === prefer ? 1 : 0) });
    cands.sort((a, b) => a.d - b.d);
    for (const { f } of cands.slice(0, 6)) if (straight(p, f.rep)) return { f, via: [pt(f.rep)] };
    for (const { f } of cands.slice(0, 4)) {
      const near = f.samples.map((s, i) => ({ i, d: Math.hypot(s.x - p.x, s.y - p.y) })).sort((a, b) => a.d - b.d).slice(0, 6);
      for (const { i } of near) {
        if (!straight(p, f.samples[i])) continue;
        const c = chain(f, i, f.repLocal);
        if (c) return { f, via: c.map(pt) };
      }
    }
    return null;
  };
  // 4: edges
  const kinds = { walk: 0, walk_via: 0, slide: 0, fall: 0, fall_untimed: 0, slide_unplaced: 0 };
  for (const a of footings) {
    const best = new Map();             // target id -> edge, walk beats slide beats fall
    const rank = e => e.kind === EDGE.WALK ? 0 : e.kind === EDGE.SLIDE ? 1 : 2;
    const offer = e => { const old = best.get(e.to); if (!old || rank(e) < rank(old) || (rank(e) === rank(old) && e.cost < old.cost)) best.set(e.to, e); };
    const pathCost = (from, pts) => { let c = 0, p = from; for (const q of pts) { c += Math.hypot(q.x - p.x, q.y - p.y); p = q; } return c; };
    const near = [...at(a.row, a.col).filter(b => b !== a)];
    for (const d of STEP_MASK_DIRS) near.push(...at(a.row + d.dr, a.col + d.dc));
    for (const b of near) {
      // PROVED WITH THE LIVE MOVER'S OWN OPTIONS: `queueValidatedMove` sends slide:true and
      // rounds onto the wire toward the start (`landFrom`). A walk edge is one where that
      // lands EXACTLY on rep(b); anything else is a slide edge that records where it lands.
      counter.traces += 2;
      const land = landFrom(geo, a.rep, b.rep);
      if (land && land.x === b.rep.x && land.y === b.rep.y) {
        offer({ to: b.id, kind: EDGE.WALK, cost: Math.hypot(b.rep.x - a.rep.x, b.rep.y - a.rep.y) });
        continue;
      }
      if (land && Math.hypot(land.x - a.rep.x, land.y - a.rep.y) >= MIN_SLIDE) {
        const placed = placeLanding(land, b, a);
        if (placed) {
          const via = placed.via.slice(0, -1);
          offer({ to: placed.f.id, kind: EDGE.SLIDE, aim: b.id, land: { x: land.x, y: land.y }, via,
                  cost: Math.hypot(land.x - a.rep.x, land.y - a.rep.y) + pathCost(land, placed.via) });
        } else kinds.slide_unplaced++;
      }
      if (best.get(b.id)?.kind === EDGE.WALK) continue;
      // THROUGH THE SAMPLES: the representatives cannot see each other, but a narrow ledge
      // that winds through both squares still joins them. Find a sample of `a` that walks
      // straight onto a sample of `b`, and go rep(a) -> along a -> across -> along b -> rep(b).
      const pairs = [];
      for (let i = 0; i < a.samples.length; i++) for (let k = 0; k < b.samples.length; k++) {
        const sa = a.samples[i], sb = b.samples[k], d = Math.hypot(sa.x - sb.x, sa.y - sb.y);
        if (d <= 384 && Math.abs(sa.h - sb.h) <= MAX_STEP_HEIGHT * 4) pairs.push({ i, k, d });
      }
      pairs.sort((p, q) => p.d - q.d);
      for (const { i, k } of pairs.slice(0, 12)) {
        if (!straight(a.samples[i], b.samples[k])) continue;
        const ca = chain(a, a.repLocal, i), cb = chain(b, k, b.repLocal);
        if (!ca || !cb) continue;
        const via = pull([...ca, ...cb]).slice(1, -1).map(pt);
        offer({ to: b.id, kind: EDGE.WALK, via, cost: pathCost(a.rep, [...via, b.rep]) });
        break;
      }
    }
    // falls: onto lower ground a walk does not reach, out to FALL_SQUARES
    const fallTo = [...near];
    for (const d of STEP_MASK_DIRS) for (let k = 2; k <= FALL_SQUARES; k++) fallTo.push(...at(a.row + d.dr * k, a.col + d.dc * k));
    for (const b of fallTo) {
      if (best.get(b.id)?.kind === EDGE.WALK || !(b.floor < a.floor - MAX_STEP_HEIGHT)) continue;
      // AND A FALL WITH THE OPTIONS A FALL IS SENT WITH: slide:true, fall:true
      // (m59-session-walk.mjs "SLIDING STAYS ON FOR A FALL TOO"). A fall that slides along the
      // lip and still lands on its aim is a fall the live mover makes — 579 r38c31's take-off
      // is 256 units from wall 399, 599's cliff lip is one-sided wall 39 (falljump audit,
      // 2026-10-31). One that slides and lands ELSEWHERE records where, like a slide edge.
      // No span gate: the trace alone decides (`maxSpan` measures take-off to landing and
      // `traceFallMotion` includes the level run before the lip, so it refuses real jumps).
      counter.traces += 2;
      const got = landFrom(geo, a.rep, b.rep, { fall: true });
      if (!got || Math.hypot(got.x - a.rep.x, got.y - a.rep.y) < MIN_SLIDE) continue;
      const exact = got.x === b.rep.x && got.y === b.rep.y;
      const placed = exact ? { f: b, via: [pt(b.rep)] } : placeLanding(got, b, a);
      if (!placed || placed.f === a || !(placed.f.floor < a.floor - MAX_STEP_HEIGHT)) continue;
      counter.traces++;
      // timed: the frame-by-frame fall (m59-falltrace.mjs) from rep(a) to the exact landing,
      // with the same slide:true the live timed fall is sent with
      const timed = !!geo.traceFineMoveClient(a.rep.x, a.rep.y, got.x, got.y, { slide: true, fall: true, timedFall: true }).arrived;
      const via = placed.via.slice(0, -1);
      offer({ to: placed.f.id, kind: timed ? EDGE.FALL : EDGE.FALL_UNTIMED,
              ...(exact ? {} : { aim: b.id, land: { x: got.x, y: got.y } }), ...(via.length ? { via } : {}),
              cost: Math.hypot(got.x - a.rep.x, got.y - a.rep.y) + pathCost(got, placed.via) });
    }
    a.edges = [...best.values()].sort((x, y) => x.to - y.to);
    for (const e of a.edges) {
      kinds[['walk', 'slide', 'fall', 'fall_untimed'][e.kind]]++;
      if (e.kind === EDGE.WALK && e.via?.length) kinds.walk_via++;
      if (!e.via?.length) delete e.via;
    }
  }
  // 5: exits
  const exits = [];
  const seenExit = new Set();
  for (const e of room.edgeExits ?? []) {
    if (!(Number(e.to) > 0)) continue;
    let cands = [];
    try { cands = edgeCandidatesOf(room, e); } catch { cands = []; }
    for (const c of cands) {
      if (!c.fine_stand_on) continue;
      const stand = { x: protocolToClient(c.fine_stand_on.x), y: protocolToClient(c.fine_stand_on.y) };
      const target = c.edge_target ? { x: protocolToClient(c.edge_target.x), y: protocolToClient(c.edge_target.y) } : null;
      const row = Math.floor(stand.y / F) + 1, col = Math.floor(stand.x / F) + 1;
      const fs = [...at(row, col)].sort((p, q) => Math.hypot(p.rep.x - stand.x, p.rep.y - stand.y) - Math.hypot(q.rep.x - stand.x, q.rep.y - stand.y));
      // rep -> stand straight, or along the footing to a sample that reaches it straight
      for (const f of fs) {
        let via = null;
        counter.traces++;
        const got = landFrom(geo, f.rep, stand);
        if (got && Math.hypot(got.x - stand.x, got.y - stand.y) <= 1) via = [];
        else {
          const near = f.samples.map((p, i) => ({ i, d: Math.hypot(p.x - stand.x, p.y - stand.y) })).sort((p, q) => p.d - q.d).slice(0, 6);
          for (const { i } of near) {
            if (!straight(f.samples[i], stand)) continue;
            const c = chain(f, f.repLocal, i);
            if (c) { via = c.slice(1).map(pt); break; }
          }
        }
        if (!via) continue;
        const k = `${e.to}|${e.leaveName}|${f.id}`;
        if (!seenExit.has(k)) { seenExit.add(k); exits.push({ to: Number(e.to), kind: 'edge', dir: e.leaveName ?? null, footing: f.id, stand, target, ...(via.length ? { via } : {}) }); }
        break;
      }
    }
  }
  for (const g of room.goExits ?? []) {
    if (g.locked || !(Number(g.to) > 0)) continue;
    for (const f of at(g.row, g.col)) {
      const k = `${g.to}|go|${f.id}`;
      if (!seenExit.has(k)) { seenExit.add(k); exits.push({ to: Number(g.to), kind: 'go', footing: f.id, row: g.row, col: g.col }); }
    }
  }
  const covered = new Set(exits.map(x => `${x.kind}|${x.to}|${x.dir ?? ''}`));
  const declared = [...(room.edgeExits ?? []).filter(e => Number(e.to) > 0).map(e => `edge|${Number(e.to)}|${e.leaveName ?? ''}`),
                    ...(room.goExits ?? []).filter(g => !g.locked && Number(g.to) > 0).map(g => `go|${Number(g.to)}|`)];
  stats.exits_declared = new Set(declared).size;
  stats.exits_unattached = [...new Set(declared)].filter(k => !covered.has(k));
  for (const f of footings) { delete f.samples; delete f.size; delete f.madj; delete f.repLocal; }
  Object.assign(stats, { footings: footings.length, edges: kinds, traces: counter.traces,
                         ms: Math.round(performance.now() - t0) });
  return { room: room.num, rows: geo.rows, cols: geo.cols, footings, exits, stats, ...(variant ? { variant } : {}) };
}

/** Moving sectors in this room, and which of them a baked variant covers. */
function movingOf(roomNum, variantKeys) {
  let j = null;
  try { j = JSON.parse(readFileSync(join(HERE, '..', 'substrate', 'm59-variable-sectors.json'), 'utf8')); } catch { return null; }
  const entry = Object.values(j.rooms ?? {}).find(v => Number(v.room) === Number(roomNum));
  if (!entry) return null;
  const sectors = (entry.sectors ?? []).map(s => ({ sector: s.sector, kind: s.kind, heights: s.heights, gates: !!s.gates }));
  const modelled = new Set(variantKeys.flatMap(k => k.split('+').map(p => Number(/^sector(\d+)@/.exec(p)?.[1]))));
  return { sectors, variants: variantKeys, unmodelled: sectors.filter(s => !modelled.has(s.sector)).map(s => s.sector) };
}

/** Bake a room in every baked door state. */
export function bakeRoomAllStates(map, table, roomNum, opts = {}) {
  const room = map.rooms[roomNum];
  const geo = sharedRoomGeometry(room);
  if (!geo?.collisionReady) return null;
  const g = bakeRoom(room, geo, opts);
  const variants = table?.rooms?.[roomNum]?.stepMaskVariants ?? null;
  const keys = variants ? Object.keys(variants) : [];
  g.moving = movingOf(roomNum, keys);
  if (keys.length) {
    g.variants = {};
    for (const k of keys) {
      const v = variants[k];
      const vg = RoomGeometry.fromJSON(room.roo);
      vg.roomNum = Number(roomNum); vg.exitSquares = exitSquaresOf(room);
      const bytes = Buffer.from(v.mask, 'base64');
      const moved = applySectorHeights(vg, (v.sectors ?? []).map(s => ({ index: s.index, floor: s.floor, ceiling: s.ceiling })),
        { mask: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length) });
      if (!moved.moved) { g.variants[k] = { ...bakeRoom(room, vg, { ...opts, variant: k }), note: moved.why ?? 'nothing moved' }; continue; }
      g.variants[k] = bakeRoom(room, vg, { ...opts, variant: k });
    }
  }
  return g;
}

// ------------------------------------------------------------------------------- CLI

function readTable(file) {
  if (!existsSync(file)) return null;
  try { const raw = readFileSync(file); return JSON.parse((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')); }
  catch { return null; }
}
function writeTable(file, t) {
  mkdirSync(dirname(file), { recursive: true });
  const body = Buffer.from(JSON.stringify(t));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, file.endsWith('.gz') ? gzipSync(body, { level: 9 }) : body);
  rmSync(file, { force: true });
  writeFileSync(file, readFileSync(tmp)); rmSync(tmp, { force: true });
  return { raw: body.length, disk: statSync(file).size };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].replace(/\//g, '\\').toLowerCase()
  || process.argv[1]?.endsWith('m59-finenav-bake.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const has = n => argv.includes('--' + n);
  const map = loadMap();
  const routes = routesFor(map.geometryManifestSha256);
  const pitch = Number(flag('pitch', 256)), refine = Number(flag('refine', 64));
  const roomsArg = flag('rooms', null);
  if (!roomsArg) { console.error('need --rooms 578,599 or --rooms all'); process.exit(2); }
  const rooms = roomsArg === 'all'
    ? Object.keys(map.rooms).map(Number).filter(n => map.rooms[n]?.roo)
    : roomsArg.split(',').map(Number);
  if (has('worker')) {
    const out = {};
    for (const n of rooms) {
      const g = bakeRoomAllStates(map, routes, n, { pitch, refine });
      if (g) out[n] = encodeRoom(g);
    }
    writeFileSync(flag('out'), JSON.stringify(out));
    process.exit(0);
  }
  const jobs = Math.min(2, Math.max(1, Number(flag('jobs', 1))));
  if (Number(flag('jobs', 1)) > 2) console.log('--jobs capped at 2: this machine runs the live fleet');
  const file = flag('out', FINE_NAV_FILE);
  const started = Date.now();
  let baked = {};
  if (jobs === 1) {
    for (const n of rooms) {
      const g = bakeRoomAllStates(map, routes, n, { pitch, refine });
      if (!g) { console.log(`${n}: no collision geometry, skipped`); continue; }
      baked[n] = encodeRoom(g);
      const s = g.stats;
      console.log(`${n} ${map.rooms[n].name}: ${s.squares} squares, ${s.footings} footings (${s.multi} squares >1, ${s.refined} refined, ${s.empty} empty), ` +
        `edges ${JSON.stringify(s.edges)}, exits ${g.exits.length}${s.exits_unattached.length ? ' UNATTACHED ' + s.exits_unattached.join(' ') : ''}` +
        `${g.variants ? ', door states ' + Object.keys(g.variants).join(' ') : ''}${g.moving?.unmodelled?.length ? ', unmodelled moving sectors ' + g.moving.unmodelled.join(' ') : ''}; ${s.ms} ms`);
    }
  } else {
    // largest rooms first, alternating, so the two workers finish together
    const sized = rooms.map(n => ({ n, size: (map.rooms[n]?.rows ?? 0) * (map.rooms[n]?.cols ?? 0) })).sort((a, b) => b.size - a.size);
    const chunks = Array.from({ length: jobs }, () => []), load = new Array(jobs).fill(0);
    for (const r of sized) { const i = load.indexOf(Math.min(...load)); chunks[i].push(r.n); load[i] += r.size; }
    const tmpDir = join(os.tmpdir(), `m59-finenav-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });
    await Promise.all(chunks.map((list, i) => new Promise((res, rej) => {
      const out = join(tmpDir, `w${i}.json`);
      const child = fork(fileURLToPath(import.meta.url), ['--worker', '--rooms', list.join(','), '--out', out,
        '--pitch', String(pitch), '--refine', String(refine)], { stdio: 'inherit' });
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
      child.on('exit', code => code === 0 ? res(Object.assign(baked, JSON.parse(readFileSync(out, 'utf8')))) : rej(new Error(`worker ${i} exit ${code}`)));
    })));
    rmSync(tmpDir, { recursive: true, force: true });
  }
  const wall = Math.round((Date.now() - started) / 1000);
  let total = { footings: 0, edges: 0 };
  for (const r of Object.values(baked)) { total.footings += r.footings; total.edges += r.edges; }
  console.log(`baked ${Object.keys(baked).length} room(s) in ${wall}s wall: ${total.footings} footings, ${total.edges} edges`);
  if (has('check')) process.exit(0);
  const prior = readTable(file);
  const keep = prior && prior.format === FINE_NAV_FORMAT && prior.version === FINE_NAV_VERSION
    && prior.geometryManifestSha256 === map.geometryManifestSha256 && prior.pitch === pitch ? prior.rooms : {};
  const table = { format: FINE_NAV_FORMAT, version: FINE_NAV_VERSION, geometryManifestSha256: map.geometryManifestSha256,
                  pitch, refine, builtAt: new Date().toISOString(), rooms: { ...keep, ...baked } };
  const size = writeTable(file, table);
  console.log(`wrote ${file}: ${Object.keys(table.rooms).length} room(s), ${(size.raw / 1048576).toFixed(2)} MB JSON, ${(size.disk / 1048576).toFixed(2)} MB on disk`);
}
