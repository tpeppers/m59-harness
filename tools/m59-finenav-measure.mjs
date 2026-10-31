#!/usr/bin/env node
// FINE-NAV BEFORE-NUMBERS: square-plan steps the body cannot walk, and a footing bake's cost.
//
// How often does the square planner plan a walk the body cannot make, and what would a
// (square, footing) graph cost to bake? Offline, read-only, below-normal priority.
//
//   node tools/m59-finenav-measure.mjs                          578, 599, 2144, 2154
//   node tools/m59-finenav-measure.mjs --rooms 578 --json out.json
//   node tools/m59-finenav-measure.mjs --pitch 128              8x8 samples a square, not 4x4
//   node tools/m59-finenav-measure.mjs --no-fine                skip the fineroute comparison
//   node tools/m59-finenav-measure.mjs --rooms all --footings-only   map-wide footing survey (~3 min)
//   node tools/m59-finenav-measure.mjs --jumps                  the declared fall-jumps' landing room
//   node tools/m59-finenav-measure.mjs --graph                  the AFTER half: the same replay on the footing
//                                                               graph (m59-finenav-bake.mjs; table, else baked here)
//
// ONE SUITE AT A TIME. This shares cores with the live fleet; it drops its own priority, and
// `--rooms all` is one core for about three minutes. Do not run copies in parallel.
//
// STAGE 1 OF docs/m59-fine-nav-design.md. It changes nothing: no table is written, no socket
// opened, no roster touched. It reads substrate/m59-map.json and substrate/m59-routes.json
// and asks the mover's own trace (`m59-roo.mjs`) the questions the design depends on.
//
// WHAT IT MEASURES, PER ROOM — and every one is a BEFORE number for the fine-nav work:
//
//   footings     Each standable square sampled on a `pitch` lattice (default 256 client units,
//                4x4 a square). Two samples are one FOOTING when the body-radius trace walks
//                straight between them (slide off, step height enforced). A square with more
//                than one footing is a square the square graph treats as one place and the
//                body does not. Timed, because this is half of what a footing bake costs.
//   footing edges  Footing to footing across the 8 neighbour squares, by the same straight
//                trace, representative to representative. Timed: the other half of the bake.
//   mask audit   For every step the baked mask allows (A -> B): where does the body ACTUALLY
//                stop (`_moverStepFrom` from A's stand point), and is that the same footing as
//                B's stand point — the point the NEXT step is planned from? Where it is not,
//                every step the mask allows out of B is retried from where the body really is.
//                A failure there is a two-step plan the square graph calls legal and the body
//                cannot walk: the 578 r2c11 -> r2c10 -> r2c9 shape, counted room-wide.
//   route replay Every baked anchor-to-anchor route, walked square by square from where the
//                body actually stops (not from stand points). First failure recorded.
//   hop replay   The same routes as `bakedPath` sends them (pivots, subdivided to <= 5
//                squares), each hop traced from the body's real position. A refused hop is
//                then skipped past, as `followRail` does, so the count is per hop.
//   fineroute    `fineRouter(room).plan` on the same pairs (walk only, no jumps), timed: the
//                existing fine planner as the comparison and as the closure-cost measurement.
//
// Squares here are `rNcM` (row N, col M). Fine points are CLIENT/BSP units, 1024 a square.

import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { loadMap } from './m59-map.mjs';
import { routesFor, bakedPath } from './m59-routes.mjs';
import { replay } from './m59-routebake.mjs';
import { sharedRoomGeometry, STEP_MASK_DIRS, MAX_STEP_HEIGHT, CLIENT_FINENESS as F }
  from './m59-roo.mjs';

// Offline work shares cores with the live fleet. Never compete with it.
try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = n => argv.includes('--' + n);
if (has('help')) {
  console.log('node tools/m59-finenav-measure.mjs [--rooms 578,599,2144,2154] [--pitch 256] [--json file] [--no-fine]');
  process.exit(0);
}
const ROOMS_ARG = String(flag('rooms', '578,599,2144,2154'));
const FOOTINGS_ONLY = has('footings-only');
const PITCH = Number(flag('pitch', 256));
const FINE = !has('no-fine');
const FINE_BUDGET_MS = Number(flag('fine-budget-ms', 120000));

const STRAIGHT = Object.freeze({ slide: false });   // body radius, step height enforced
const CLEAR = 16;                                  // client units: the clearance probe
const sq = (row, col) => `r${row}c${col}`;
const now = () => performance.now();

/** Footings of one room: Map(squareIndex -> [{id, samples:[{x,y,h}], rep}]). */
function footingsOf(geo) {
  const N = Math.round(F / PITCH);
  const bySquare = new Map();
  let samples = 0, traces = 0, unclear = 0;
  const t0 = now();
  for (let row = 1; row <= geo.rows; row++) for (let col = 1; col <= geo.cols; col++) {
    if (!geo.standable(row, col)) continue;
    const x0 = (col - 1) * F, y0 = (row - 1) * F;
    const pts = new Array(N * N).fill(null);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = x0 + Math.round((i + 0.5) * PITCH), y = y0 + Math.round((j + 0.5) * PITCH);
      if (!geo._occupiable(x, y)) continue;
      const h = geo.floorBaseAtClient(x, y);
      if (h == null) continue;
      samples++;
      // A PLACE A BODY CAN BE, not merely a point with floor: inside PLAYER_RADIUS of a
      // blocking wall a body is pushed off it, so the sample cannot be arrived at and would
      // otherwise appear as a one-point "footing" of its own. Four short probes all moving
      // freely is clearance >= the body radius, to within the probe length.
      let clear = true;
      for (const [px, py] of [[CLEAR, 0], [-CLEAR, 0], [0, CLEAR], [0, -CLEAR]]) {
        traces++;
        if (!geo.traceFineMoveClient(x, y, x + px, y + py, STRAIGHT).arrived) { clear = false; break; }
      }
      if (!clear) { unclear++; continue; }
      pts[j * N + i] = { x, y, h, i, j };
    }
    // A FOOTING IS A STRONGLY CONNECTED PIECE, NOT A CONNECTED ONE. Walls in this game are
    // one-sided (a sidedef may be null, and `IntersectNode` skips a wall whose facing sidedef
    // is null — clientd3d/move.c:530-540), and a drop is one-way. 578's r2c10 is cut by a
    // one-sided wall at x=9728: from its stand point ON that line the body walks east, and
    // from x=10080 it cannot walk back. Undirected union-find calls that one place; it is two.
    // So: directed 4-neighbour edges, each asked both ways, then mutual reachability.
    const adj = pts.map(() => []);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = pts[j * N + i];
      if (!a) continue;
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        if (i + di >= N || j + dj >= N) continue;
        const kb = (j + dj) * N + i + di, b = pts[kb], ka = j * N + i;
        if (!b) continue;
        traces += 2;
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
    const owner = new Array(pts.length).fill(-1), groups = new Map();
    pts.forEach((p, k) => {
      if (!p || owner[k] >= 0) return;
      const g = [];
      for (const m of reach[k]) if (reach[m]?.has(k)) { owner[m] = k; g.push(pts[m]); }
      groups.set(k, g);
    });
    const list = [...groups.values()].map((s, id) => {
      const cx = s.reduce((a, p) => a + p.x, 0) / s.length, cy = s.reduce((a, p) => a + p.y, 0) / s.length;
      let rep = s[0], best = Infinity;
      for (const p of s) { const d = Math.hypot(p.x - cx, p.y - cy); if (d < best) { best = d; rep = p; } }
      return { id, samples: s, rep, h: rep.h };
    });
    bySquare.set((row - 1) * geo.cols + (col - 1), list);
  }
  return { bySquare, samples, unclear, traces, ms: now() - t0 };
}

/** Which footing of (row,col) a fine point belongs to: same height band and a straight point-probe. */
function footingAt(geo, foot, row, col, x, y) {
  const list = foot.bySquare.get((row - 1) * geo.cols + (col - 1));
  if (!list?.length) return null;
  const h = geo.floorBaseAtClient(x, y);
  const cands = [];
  for (const f of list) for (const p of f.samples) {
    if (h != null && Math.abs(p.h - h) > MAX_STEP_HEIGHT) continue;
    cands.push({ f, d: Math.hypot(p.x - x, p.y - y), p });
  }
  cands.sort((a, b) => a.d - b.d);
  // Mutual, with the body's own radius: a point belongs to a footing when the body can walk
  // from it to a sample of that footing AND back. One direction is how a one-sided wall hides.
  // A slid landing rests exactly PLAYER_RADIUS off the wall it slid along, so "and back" is
  // asked of a point a few units off it toward the sample: the body is there, not in the wall.
  for (const c of cands.slice(0, 8)) {
    if (c.d < 1) return c.f;
    if (!geo.traceFineMoveClient(x, y, c.p.x, c.p.y, STRAIGHT).arrived) continue;
    const k = Math.min(1, CLEAR * 2 / c.d);
    const bx = x + (c.p.x - x) * k, by = y + (c.p.y - y) * k;
    if (geo.traceFineMoveClient(c.p.x, c.p.y, x, y, STRAIGHT).arrived
        || geo.traceFineMoveClient(c.p.x, c.p.y, bx, by, STRAIGHT).arrived) return c.f;
  }
  return null;
}

function footingEdges(geo, foot) {
  const t0 = now();
  let traces = 0, edges = 0, nodes = 0;
  for (const [idx, list] of foot.bySquare) {
    const row = Math.floor(idx / geo.cols) + 1, col = (idx % geo.cols) + 1;
    nodes += list.length;
    for (const d of STEP_MASK_DIRS) {
      const r = row + d.dr, c = col + d.dc;
      const there = foot.bySquare.get((r - 1) * geo.cols + (c - 1));
      if (!there) continue;
      for (const a of list) for (const b of there) {
        traces++;
        if (geo.traceFineMoveClient(a.rep.x, a.rep.y, b.rep.x, b.rep.y, STRAIGHT).arrived) edges++;
      }
    }
  }
  return { nodes, edges, traces, ms: now() - t0 };
}

function maskAudit(geo, foot, roomNum) {
  const t0 = now();
  let edges = 0, landedOther = 0, landedNoFooting = 0, tripleFail = 0, edgesWithFail = 0, triples = 0;
  let anyRefused = 0, straightFirst = 0, twoStep = 0;
  const watched = [];
  // The pinned TODO in m59-peninsula-test.mjs; reported when this audit finds it on its own.
  const WATCH = new Set(roomNum === 578 ? ['r2c11>r2c10>r2c9'] : []);
  const examples = [];
  const spFoot = new Map();
  const footOfSP = (row, col) => {
    const k = (row - 1) * geo.cols + (col - 1);
    if (!spFoot.has(k)) { const sp = geo.standPoint(row, col); spFoot.set(k, sp ? footingAt(geo, foot, row, col, sp.x, sp.y) : null); }
    return spFoot.get(k);
  };
  for (let row = 1; row <= geo.rows; row++) for (let col = 1; col <= geo.cols; col++) {
    if (!geo.standable(row, col)) continue;
    const sp = geo.standPoint(row, col);
    if (!sp) continue;
    for (const d of STEP_MASK_DIRS) {
      const r = row + d.dr, c = col + d.dc;
      if (!geo.moverStepLands(row, col, r, c)) continue;
      edges++;
      const land = geo._moverStepFrom(sp.x, sp.y, r, c);
      if (!land.lands) continue;                      // mask and live trace disagree outright; rare, not this question
      // CLASSIFICATION-FREE: every two-step plan A -> B -> C the mask allows, the second step
      // asked from where the first one really stopped. Only deflected first steps can differ.
      for (const e of STEP_MASK_DIRS) {
        const r2x = r + e.dr, c2x = c + e.dc;
        if (!(r2x === row && c2x === col) && geo.moverStepLands(r, c, r2x, c2x)) twoStep++;
      }
      if (!land.straight) for (const e of STEP_MASK_DIRS) {
        const r2 = r + e.dr, c2 = c + e.dc;
        if ((r2 === row && c2 === col) || !geo.moverStepLands(r, c, r2, c2)) continue;
        if (!geo._moverStepFrom(land.x, land.y, r2, c2).lands) {
          anyRefused++;
          const t = `${sq(row, col)}>${sq(r, c)}>${sq(r2, c2)}`;
          if (WATCH.has(t)) watched.push(t);
        }
      } else straightFirst++;
      const want = footOfSP(r, c), got = footingAt(geo, foot, r, c, land.x, land.y);
      if (want && got === want) continue;
      if (!got) landedNoFooting++; else landedOther++;
      // the next step is planned from r,c's stand point: ask each one from where the body stopped
      let failedHere = 0;
      for (const e of STEP_MASK_DIRS) {
        const r2 = r + e.dr, c2 = c + e.dc;
        if (!geo.moverStepLands(r, c, r2, c2)) continue;
        if (r2 === row && c2 === col) continue;       // stepping straight back is not a plan
        triples++;
        if (!geo._moverStepFrom(land.x, land.y, r2, c2).lands) {
          failedHere++; tripleFail++;
          if (examples.length < 12) examples.push(`${sq(row, col)} -> ${sq(r, c)} stops at (${land.x},${land.y}); ${sq(r, c)} -> ${sq(r2, c2)} refused from there`);
        }
      }
      if (failedHere) edgesWithFail++;
    }
  }
  return { mask_edges: edges, first_step_straight: straightFirst, two_step_plans: twoStep, two_step_plans_refused_from_real_landing: anyRefused,
           watched_cases_reproduced: watched, landed_other_footing: landedOther, landed_no_footing: landedNoFooting,
           continuation_triples_checked: triples, continuation_triples_refused: tripleFail,
           mask_edges_with_a_refused_continuation: edgesWithFail, examples, ms: now() - t0 };
}

function routeReplay(geo, baked, roomNum, table) {
  const t0 = now();
  const out = { routes: 0, walked: 0, failed: 0, failures: [], hops: 0, hops_refused: 0, hop_reasons: {}, hop_examples: [] };
  for (const [key, spelled] of Object.entries(baked.routes ?? {})) {
    if (typeof spelled !== 'string') continue;
    const [a, b] = key.split('>');
    const [fr, fc] = a.split(',').map(Number), [tr, tc] = b.split(',').map(Number);
    const sp0 = geo.standPoint(fr, fc);
    if (!sp0) continue;
    out.routes++;
    // 1. square by square, from where the body really stops
    let cur = { ...sp0 }, failedAt = null;
    const squares = replay(fr, fc, spelled);
    let prev = { row: fr, col: fc };
    for (let i = 0; i < squares.length; i++) {
      const s = squares[i];
      const isFall = Math.max(Math.abs(s.row - prev.row), Math.abs(s.col - prev.col)) > 1;
      let st;
      if (isFall) {
        // A baked fall (`(dr,dc)` in the route string) is proved stand point to stand point
        // with fall:true. Ask it from where the body actually is.
        const to = geo.standPoint(s.row, s.col);
        const t = to ? geo.traceFineMoveClient(cur.x, cur.y, to.x, to.y, { slide: false, fall: true }) : null;
        st = t?.arrived ? { lands: true, x: to.x, y: to.y } : { lands: false };
        if (isFall) out.falls = (out.falls ?? 0) + 1;
      } else st = geo._moverStepFrom(cur.x, cur.y, s.row, s.col);
      if (!st.lands) {
        // Would it have landed from the stand point the planner assumed? Then the plan was
        // made for a body that was not there — the class this whole measurement is about.
        const sp = geo.standPoint(prev.row, prev.col);
        const fromSP = isFall
          ? !!geo.traceFineMoveClient(sp.x, sp.y, geo.standPoint(s.row, s.col).x, geo.standPoint(s.row, s.col).y, { slide: false, fall: true }).arrived
          : geo._moverStepFrom(sp.x, sp.y, s.row, s.col).lands;
        failedAt = { i, of: squares.length, at: sq(s.row, s.col), fall: isFall, lands_from_stand_point: fromSP,
          prev: sq(prev.row, prev.col), body: { x: Math.round(cur.x), y: Math.round(cur.y) } };
        break;
      }
      cur = { x: st.x, y: st.y };
      prev = s;
    }
    if (failedAt) { out.failed++; if (failedAt.lands_from_stand_point) out.failed_but_lands_from_stand_point = (out.failed_but_lands_from_stand_point ?? 0) + 1; if (out.failures.length < 12) out.failures.push({ route: `${sq(fr, fc)}>${sq(tr, tc)}`, ...failedAt }); }
    else out.walked++;
    // 2. as bakedPath sends it, hop by hop from the body's real position
    const hops = bakedPath(table, roomNum, { row: fr, col: fc }, { row: tr, col: tc }) ?? [];
    cur = { ...sp0 };
    for (const h of hops.slice(1)) {
      const target = geo.standPoint(h.row, h.col);
      if (!target) continue;
      out.hops++;
      const st = geo._moverStepFrom(cur.x, cur.y, h.row, h.col);
      if (st.lands) { cur = { x: st.x, y: st.y }; continue; }
      // a hop that crosses a baked fall may be a fall, not a walk
      if (geo.traceFineMoveClient(cur.x, cur.y, target.x, target.y, { slide: false, fall: true }).arrived) { cur = { ...target }; continue; }
      out.hops_refused++;
      const t = geo.traceFineMoveClient(cur.x, cur.y, target.x, target.y, { slide: true });
      const why = t.arrived ? 'lands_wrong_height_or_quantised_out' : (t.reason ?? 'not_arrived');
      out.hop_reasons[why] = (out.hop_reasons[why] ?? 0) + 1;
      if (out.hop_examples.length < 8) out.hop_examples.push(`${key}: (${Math.round(cur.x)},${Math.round(cur.y)}) -> ${sq(h.row, h.col)} ${why}`);
      cur = { ...target };                             // followRail skips past a refused hop
    }
  }
  out.ms = now() - t0;
  return out;
}

async function fineCompare(roomNum, baked, map) {
  const { fineRouter } = await import('./m59-fineroute.mjs');
  const t0 = now();
  const R = fineRouter(roomNum, { worldMap: map });
  const build = now() - t0;
  const out = { router_build_ms: Math.round(build), pairs: 0, ok: 0, not_ok: 0, why: {}, closures: [], budget_hit: false };
  const seenStart = new Set();
  for (const key of Object.keys(baked.routes ?? {})) {
    if (now() - t0 > FINE_BUDGET_MS) { out.budget_hit = true; break; }
    const [a, b] = key.split('>');
    const [fr, fc] = a.split(',').map(Number), [tr, tc] = b.split(',').map(Number);
    const t1 = now();
    const p = R.plan({ row: fr, col: fc }, { row: tr, col: tc }, { maxJumps: 0 });
    const ms = now() - t1;
    out.pairs++;
    if (p.ok) out.ok++; else { out.not_ok++; out.why[p.why?.replace(/\d+,\d+/g, 'R,C')] = (out.why[p.why?.replace(/\d+,\d+/g, 'R,C')] ?? 0) + 1; }
    if (!seenStart.has(a)) {
      seenStart.add(a);
      const pts = p.trace?.[0]?.points ?? null, sqs = p.trace?.[0]?.squares ?? null;
      out.closures.push({ from: sq(fr, fc), first_plan_ms: Math.round(ms), points: pts, squares: sqs });
    }
  }
  out.ms = Math.round(now() - t0);
  return out;
}

// ------------------------------------------------------------------------------------- jumps
//
// THE PER-JUMP SUBPROBLEM'S RAW MATERIAL. For each declared fall-jump: what a timed-fall proof
// costs, how much of the landing shelf a run from the declared take-off actually reaches (the
// room a "deviation" has to work in), and how much of the take-off shelf reaches the declared
// landing. `--jumps` runs only this.
async function jumpSurvey(map) {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const table = JSON.parse(readFileSync(fileURLToPath(new URL('../substrate/m59-falljumps.json', import.meta.url)), 'utf8'));
  const { maxSpan, jumpConfidence } = await import('./m59-falljump-physics.mjs');
  const rows = [];
  for (const j of table.jumps ?? []) {
    const room = map.rooms[j.room];
    if (!room) continue;
    const geo = sharedRoomGeometry(room);
    const a = j.from_fine ?? geo.standPoint(j.from.row, j.from.col), b = j.to_fine ?? geo.standPoint(j.to.row, j.to.col);
    if (!a || !b) continue;
    const ha = geo.floorBaseAtClient(a.x, a.y), hb = geo.floorBaseAtClient(b.x, b.y);
    const fall = (p, q) => geo.traceFineMoveClient(p.x, p.y, q.x, q.y, { slide: false, fall: true, timedFall: true });
    const times = [];
    let proof = null;
    for (let k = 0; k < 5; k++) { const t0 = now(); proof = fall(a, b); times.push(now() - t0); }
    times.sort((x, y) => x - y);
    const shelf = (c, h, R) => {
      const out = [];
      for (let dy = -R; dy <= R; dy += 32) for (let dx = -R; dx <= R; dx += 32) {
        if (dx * dx + dy * dy > R * R) continue;
        const x = Math.round(c.x + dx), y = Math.round(c.y + dy), f = geo.floorBaseAtClient(x, y);
        if (f != null && Math.abs(f - h) <= 64) out.push({ x, y });
      }
      return out;
    };
    // landing points on the declared landing's shelf within 3/4 square; take-offs within 1/2
    const L = shelf(b, hb, 768), T = shelf(a, ha, 512);
    let t0 = now(), lOk = 0, nearestBad = Infinity;
    for (const q of L) {
      if (fall(a, q).arrived) lOk++;
      else nearestBad = Math.min(nearestBad, Math.hypot(q.x - b.x, q.y - b.y));
    }
    const landMs = now() - t0;
    t0 = now();
    let tOk = 0;
    for (const p of T) if (fall(p, b).arrived) tOk++;
    const takeMs = now() - t0;
    const span = Math.hypot(b.x - a.x, b.y - a.y), drop = ha - hb;
    const row = { room: j.room, from: sq(j.from.row, j.from.col), to: sq(j.to.row, j.to.col), fine: !!j.from_fine,
      drop, span: Math.round(span), max_span: Math.round(maxSpan(drop)), verdict: jumpConfidence(drop, span).verdict,
      proof_arrived: !!proof?.arrived, proof_reason: proof?.reason ?? null, flight_ms: proof?.fall_motion?.elapsed_ms ?? null,
      trace_ms_median: +times[2].toFixed(2),
      landing_shelf_samples: L.length, landing_reached: lOk,
      landing_margin_to_first_miss: Number.isFinite(nearestBad) ? Math.round(nearestBad) : null,
      takeoff_shelf_samples: T.length, takeoff_reaching: tOk,
      ms_per_proof: +((landMs + takeMs) / Math.max(1, L.length + T.length)).toFixed(2) };
    rows.push(row);
    console.log(`${j.room} ${row.from}->${row.to}${row.fine ? '' : ' (stand points)'}: drop ${drop}, span ${row.span}/${row.max_span}, ` +
      `proof ${row.proof_arrived ? 'arrives' : 'REFUSED ' + row.proof_reason}, air ${row.flight_ms} ms, trace ${row.trace_ms_median} ms; ` +
      `landing shelf ${lOk}/${L.length} reached (first miss ${row.landing_margin_to_first_miss}u from aim); ` +
      `take-off shelf ${tOk}/${T.length} reaches it; ${row.ms_per_proof} ms/proof`);
  }
  return rows;
}

// ------------------------------------------------------------------------------------- main
const map = loadMap();
const table = routesFor(map.geometryManifestSha256);
if (!table) { console.error('no routing table matching this map — run node tools/m59-routebake.mjs'); process.exit(2); }
const report = { pitch: PITCH, rooms: {} };
if (has('jumps')) {
  report.jumps = await jumpSurvey(map);
  const o = flag('json'); if (o) writeFileSync(o, JSON.stringify(report, null, 1));
  process.exit(0);
}
const ROOMS = ROOMS_ARG === 'all' ? Object.keys(table.rooms).map(Number) : ROOMS_ARG.split(',').map(Number);
if (has('graph')) {
  // THE AFTER HALF: the same three questions asked of the footing graph.
  //   two-step  every edge a->f followed by every edge out of f, executed from where the first
  //             really left the body (`replayLegs`, the mover's slide-and-quantize arithmetic)
  //   routes    every baked anchor pair, planned on the graph from the body at the from
  //             square's stand point, then executed leg by leg from where each leg left it
  // The graph comes from the table on disk when it is current, else is baked here.
  const FN = await import('./m59-finenav.mjs');
  const { bakeRoomAllStates } = await import('./m59-finenav-bake.mjs');
  const loaded = FN.loadFineNav(map);
  report.graph = {};
  for (const n of ROOMS) {
    const room = map.rooms[n], baked = table.rooms[n];
    if (!room || !baked) continue;
    const geo = sharedRoomGeometry(room);
    let g = loaded.table ? FN.fineNavRoom(loaded.table, n).graph : null;
    let source = 'table';
    if (!g) { const t0 = now(); g = FN.decodeRoom(FN.encodeRoom(bakeRoomAllStates(map, table, n)), n); source = `baked here in ${Math.round(now() - t0)} ms`; }
    console.log(`\n== ${n} ${room.name} — footing graph (${source}): ${g.footings.length} footings`);
    // two-step
    let t0 = now(), pairs = 0, refused = 0;
    const reasons = {}, ex = [];
    for (const a of g.footings) for (const e of a.edges) {
      if (e.kind === FN.EDGE.FALL_UNTIMED) continue;
      for (const e2 of g.footings[e.to].edges) {
        if (e2.kind === FN.EDGE.FALL_UNTIMED) continue;
        pairs++;
        const r = FN.replayLegs(geo, a.rep, [...FN.edgeLegs(g, e), ...FN.edgeLegs(g, e2)]);
        if (!r.ok) { refused++; reasons[r.reason] = (reasons[r.reason] ?? 0) + 1; if (ex.length < 6) ex.push(`${FN.footingKey(g, a.id)} -> ${FN.footingKey(g, e.to)} -> ${FN.footingKey(g, e2.to)}: ${r.reason} at leg ${r.at}`); }
      }
    }
    console.log(`two-step plans on the graph refused from the real landing: ${refused} of ${pairs} ${JSON.stringify(reasons)}; ${Math.round(now() - t0)} ms`);
    for (const s of ex) console.log('   ' + s);
    // routes
    t0 = now();
    const out = { routes: 0, planned: 0, walked: 0, failed: 0, fallback: 0, fallback_found: 0, why: {}, failures: [], legs: 0, plan_ms: [] };
    for (const key of Object.keys(baked.routes ?? {})) {
      const [a, b] = key.split('>');
      const [fr, fc] = a.split(',').map(Number), [tr, tc] = b.split(',').map(Number);
      const sp = geo.standPoint(fr, fc);
      if (!sp) continue;
      out.routes++;
      const t1 = now();
      const p = FN.planFine({ geo, graph: g, from: sp, goal: { row: tr, col: tc } });
      out.plan_ms.push(now() - t1);
      if (p.source !== 'finenav') { out.fallback++; if (out.failures.length < 8) out.failures.push(`${sq(fr, fc)}>${sq(tr, tc)}: fallback (${p.fallback_reason ?? p.why})${FN.planFine({ geo, graph: g, from: sp, goal: { row: tr, col: tc }, falls: 'any', squareFallback: false }).ok ? ' — found with untimed falls' : ''}`); if (p.ok) out.fallback_found++; out.why[p.fallback_reason ?? p.why] = (out.why[p.fallback_reason ?? p.why] ?? 0) + 1; continue; }
      out.planned++; out.legs += p.legs.length;
      const r = FN.replayLegs(geo, sp, p.legs);
      if (r.ok) out.walked++;
      else { out.failed++; if (out.failures.length < 8) out.failures.push(`${sq(fr, fc)}>${sq(tr, tc)}: leg ${r.at + 1}/${p.legs.length} ${r.leg.kind} ${r.reason} from (${r.body.x},${r.body.y})`); }
    }
    out.plan_ms.sort((x, y) => x - y);
    const med = out.plan_ms[Math.floor(out.plan_ms.length / 2)] ?? 0, max = out.plan_ms.at(-1) ?? 0;
    console.log(`routes: ${out.routes} pairs; planned on the graph ${out.planned}, executed end to end ${out.walked}, broke ${out.failed}; ` +
      `fell back to the square planner ${out.fallback} (${out.fallback_found} of those found) ${JSON.stringify(out.why)}; ` +
      `${out.legs} legs; plan median ${med.toFixed(1)} ms, max ${max.toFixed(1)} ms; ${Math.round(now() - t0)} ms`);
    for (const f of out.failures) console.log('   ' + f);
    report.graph[n] = { footings: g.footings.length, two_step: { pairs, refused, reasons }, routes: { ...out, plan_ms: undefined, plan_median_ms: +med.toFixed(1), plan_max_ms: +max.toFixed(1) } };
  }
  const o = flag('json'); if (o) writeFileSync(o, JSON.stringify(report, null, 1));
  process.exit(0);
}
const total = { rooms: 0, standable: 0, footings: 0, multi: 0, multiHeight: 0, zero: 0, nodes: 0, edges: 0, ms: 0, traces: 0, worst: [] };
for (const n of ROOMS) {
  const room = map.rooms[n], baked = table.rooms[n];
  if (!room || !baked || typeof baked.stepMask !== 'string') { console.log(`room ${n}: not in map/table`); continue; }
  const geo = sharedRoomGeometry(room);
  const bytes = Buffer.from(baked.stepMask, 'base64');
  geo.attachStepMask(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
  console.log(`\n== ${n} ${room.name}  ${geo.rows}x${geo.cols}`);
  const foot = footingsOf(geo);
  const hist = { 0: 0, 1: 0, 2: 0, '3+': 0 };
  let standable = 0, footings = 0, multiHeight = 0;
  for (const list of foot.bySquare.values()) {
    standable++; footings += list.length;
    hist[list.length >= 3 ? '3+' : list.length]++;
    const hs = list.map(f => f.h).sort((a, b) => a - b);
    if (hs.length > 1 && hs.at(-1) - hs[0] > MAX_STEP_HEIGHT) multiHeight++;
  }
  console.log(`footings: ${standable} standable squares, ${footings} footings; per square ${JSON.stringify(hist)}; ` +
              `${multiHeight} squares hold footings > MAX_STEP_HEIGHT apart; ${foot.samples} floor samples (${foot.unclear} inside body radius of a wall, dropped), ${foot.traces} traces, ${Math.round(foot.ms)} ms`);
  const fe = footingEdges(geo, foot);
  console.log(`footing edges: ${fe.nodes} nodes, ${fe.edges} straight edges from ${fe.traces} traces, ${Math.round(fe.ms)} ms`);
  total.rooms++; total.standable += standable; total.footings += footings; total.multi += standable - hist[0] - hist[1];
  total.multiHeight += multiHeight; total.zero += hist[0]; total.nodes += fe.nodes; total.edges += fe.edges;
  total.ms += foot.ms + fe.ms; total.traces += foot.traces + fe.traces;
  total.worst.push({ room: n, ms: Math.round(foot.ms + fe.ms), standable, multi: standable - hist[0] - hist[1] });
  if (FOOTINGS_ONLY) { report.rooms[n] = { standable, footings, footings_per_square: hist, squares_multi_height: multiHeight, nodes: fe.nodes, edges: fe.edges, ms: Math.round(foot.ms + fe.ms) }; continue; }
  const ma = maskAudit(geo, foot, n);
  console.log(`mask audit: ${ma.mask_edges} mask steps; body stops on a different footing from the next step's stand point on ` +
              `${ma.landed_other_footing} (+${ma.landed_no_footing} on no sampled footing); of ${ma.continuation_triples_checked} ` +
              `continuations from those landings ${ma.continuation_triples_refused} are refused, spoiling ${ma.mask_edges_with_a_refused_continuation} mask steps; ${Math.round(ma.ms)} ms`);
  console.log(`   two-step plans A>B>C refused from the body's real landing: ${ma.two_step_plans_refused_from_real_landing} of ${ma.two_step_plans} ` +
              `(${ma.mask_edges - ma.first_step_straight} of ${ma.mask_edges} first steps are deflected)` +
              (ma.watched_cases_reproduced.length ? `; pinned TODO reproduced: ${ma.watched_cases_reproduced.join(', ')}` : ''));
  for (const e of ma.examples.slice(0, 4)) console.log('   ' + e);
  const rr = routeReplay(geo, baked, n, table);
  console.log(`route replay: ${rr.routes} baked routes, ${rr.walked} walked to the end following the body, ${rr.failed} fail; ` +
              `hops: ${rr.hops_refused}/${rr.hops} refused ${JSON.stringify(rr.hop_reasons)}; ${Math.round(rr.ms)} ms`);
  const fromSP = rr.failed_but_lands_from_stand_point ?? 0;
  console.log(`   of those failures, ${fromSP}/${rr.failed} WOULD land from the planner's stand point (plan made for a body that was not there); falls stepped: ${rr.falls ?? 0}`);
  for (const f of rr.failures.slice(0, 4)) console.log(`   ${f.route}: step ${f.i + 1}/${f.of} ${f.prev} -> ${f.at}${f.fall ? ' (fall)' : ''} refused from body (${f.body.x},${f.body.y}); from stand point: ${f.lands_from_stand_point ? 'lands' : 'refused too'}`);
  for (const e of rr.hop_examples.slice(0, 3)) console.log('   hop ' + e);
  const entry = { name: room.name, rows: geo.rows, cols: geo.cols, standable, footings, footings_per_square: hist,
    squares_multi_height: multiHeight, footing_bake: { samples: foot.samples, traces: foot.traces, ms: Math.round(foot.ms) },
    footing_edges: { ...fe, ms: Math.round(fe.ms) }, mask_audit: { ...ma, ms: Math.round(ma.ms) },
    route_replay: { ...rr, ms: Math.round(rr.ms) } };
  if (FINE) {
    const fc = await fineCompare(n, baked, map);
    entry.fineroute = fc;
    console.log(`fineroute (walk only): ${fc.ok}/${fc.pairs} pairs planned, ${fc.not_ok} not ${JSON.stringify(fc.why)}; build ${fc.router_build_ms} ms, total ${fc.ms} ms` + (fc.budget_hit ? ' (BUDGET HIT)' : ''));
    for (const c of fc.closures.slice(0, 6)) console.log(`   closure from ${c.from}: ${c.points} points / ${c.squares} squares, first plan ${c.first_plan_ms} ms`);
  }
  report.rooms[n] = entry;
}
if (total.rooms > 1) {
  total.worst.sort((a, b) => b.ms - a.ms);
  console.log(`
== TOTAL ${total.rooms} rooms: ${total.standable} standable squares, ${total.footings} footings, ` +
    `${total.multi} squares (${(100 * total.multi / total.standable).toFixed(1)}%) with >1 footing, ${total.multiHeight} with footings > MAX_STEP_HEIGHT apart, ` +
    `${total.zero} with none at this pitch; ${total.edges} straight footing edges; ${total.traces} traces in ${Math.round(total.ms)} ms single-threaded`);
  console.log('   slowest: ' + total.worst.slice(0, 6).map(w => `${w.room} ${w.ms}ms/${w.standable}sq`).join(', '));
  report.total = { ...total, worst: total.worst.slice(0, 20), ms: Math.round(total.ms) };
}
const out = flag('json');
if (out) { writeFileSync(out, JSON.stringify(report, null, 1)); console.log(`\nwrote ${out}`); }
