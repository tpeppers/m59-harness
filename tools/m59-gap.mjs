#!/usr/bin/env node
// THE GAP BETWEEN HERE AND THERE — WHY THE MOVER STOPPED, AND WHAT WOULD BRIDGE IT.
//
//   node tools/m59-gap.mjs 49  --from 13,12 --to 26,12            the frontier, and why
//   node tools/m59-gap.mjs 49  --from 13,12 --to 26,12 --bridge   look again with a microscope
//   node tools/m59-gap.mjs 45  --to 63,46 --backwards             where could you DROP IN from
//   node tools/m59-gap.mjs 579 --from 40,52 --stairs              treads a walk cannot spell
//   node tools/m59-gap.mjs 49  --from 13,12 --to 26,12 --all --json
//
// CLI CONTRACT: `--from` and `--to` are `row,col`, KOD/RoomGeometry order, same as
// m59-fineroute.mjs. Offline, plan-only: it opens no socket and moves nobody.
//
// `no route` IS THE LEAST USEFUL TRUE ANSWER IN THIS REPOSITORY.
//
// The router answers whether a path exists. When it says no, every question an operator
// actually has is still open: where did the search stop, which rule stopped it, was it one
// rule or a region, and what would have to be true for it to continue. Without that, the
// only move left is to drive the body again — and on 2026-09-09 that produced ELEVEN
// refused departures from room 49 across two characters and three destinations, seven rim
// squares tried one at a time, and not one measurement of the ground. Eleven proofs of the
// same refusal.
//
// So this reports the SHAPE of the failure instead:
//
//   --frontier   flood from the body, then at the flood's boundary rank each cell by how
//                much closer a step outward would get you, and NAME THE PREDICATE that
//                refused that step.
//   --bridge     re-flood the frontier at high resolution with dense perpendicular
//                sampling, because a lattice cannot find a band narrower than its own
//                PHASE and that is a different failure from a wall.
//   --backwards  reverse-search from the GOAL over the edges a forward move would accept:
//                where could a body step, or FALL, into the target from?
//   --stairs     monotone ascending chains whose every tread is inside MAX_STEP_HEIGHT,
//                reported with the cell you must BOARD AT.
//
// IT USES THE ROUTER'S OWN PREDICATES AND DOES NOT RE-DERIVE ANY GEOMETRY. `standAt`,
// `floorAt`, `footing` and `geo.traceFineMoveClient` all come out of `fineRouter`, because a
// debugging view that computes its own floors is a second opinion about the map rather than
// a look at the one in play — and the whole value here is that its answers are the mover's.
//
// THE FOUR REASONS A FLOOD STOPS, and they have four different fixes. The flood in
// m59-fineroute.mjs refuses an outward step at one of these, and until now which one was
// not recoverable from the outside:
//
//   no_floor        the target has no floor under the body's footprint — the void
//   too_high        rise above MAX_STEP_HEIGHT (384 client units): a cliff, and real
//   mover_refused   floors are fine and the mover says no — a WALL between them
//   went_nowhere    the mover accepted and moved less than a quarter step: a scrape
//
// `too_high` wants a jump or a staircase. `mover_refused` wants a lane or a different
// approach angle. `went_nowhere` is usually a body or a sliver. `no_floor` is the map.
// Calling all four "it will not move" is what makes this expensive.
//
// WHY --bridge IS SEPARATE FROM --frontier, and it is the operator's own diagnosis of room
// 49: "you have to walk along the tiniest edge (you'll need to construct a fine movement
// bridge)". The flood steps 256 units with perpendicular nudges at thirds — offsets 0, ±85,
// ±170 — so a walkable band a hundred units wide sitting between those offsets is invisible,
// and m59-fineroute.mjs's own comment says why: steps of 256, 128 and 64 all failed
// identically on the Ancient Place's last strip, because THE PROBLEM IS PHASE, NOT STEP
// SIZE. A finer lattice with the wrong offset misses a narrow band just as reliably. The
// answer is not a finer lattice everywhere — it is a dense perpendicular sweep in the one
// place the coarse flood gave up.
//
// AND A DROP IS NOT A WALL. The operator's correction of 2026-09-04 is load-bearing here:
// 496 is the body's full WIDTH, but against a wall on ONE side the constraint is the
// RADIUS, 248 client units, and the drop on the other side is free to overhang — a drop is
// not a collision surface. So a ledge can be far narrower than a body and still walkable,
// which is exactly why these edges get written off as impossible.
//
// EVERYTHING HERE IS A CLAIM ABOUT GEOMETRY, WHICH IS NOT A ROUTE THAT WORKS. Only a
// character arriving says a hop is real. This narrows where to look; it does not promise.

import process from 'node:process';
import { fineRouter } from './m59-fineroute.mjs';
import { CLIENT_FINENESS as F, MAX_STEP_HEIGHT, PLAYER_RADIUS } from './m59-roo.mjs';

const argv = process.argv.slice(2);
const has = n => argv.includes(`--${n}`);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const positional = argv.filter(a => !a.startsWith('--') &&
  !argv.some((f, i) => f.startsWith('--') && argv[i + 1] === a));

const ROOM = Number(positional[0] ?? flag('room'));
const JSON_OUT = has('json');
const ALL = has('all');
const rowcol = (s) => {
  if (!s) return null;
  const [row, col] = String(s).split(',').map(v => Number(v.trim()));
  return Number.isFinite(row) && Number.isFinite(col) ? { row, col } : null;
};
const FROM = rowcol(flag('from'));
const TO = rowcol(flag('to'));

if (!Number.isFinite(ROOM)) {
  console.error('usage: node tools/m59-gap.mjs <room> --from row,col [--to row,col]');
  console.error('       [--frontier] [--bridge] [--backwards] [--stairs] [--all] [--json]');
  process.exit(1);
}

// The client's own fall physics. This used to be repeated here — "the constants are the
// game's, and this module should keep working if that one's private helpers move" — and the
// repetition is exactly what went wrong: FOUR files carried a copy and three of them capped
// a jump short. Now imported. Corrected 2026-09-10; see m59-falljump-physics.mjs.
import { maxSpan } from './m59-falljump-physics.mjs';

let R;
try {
  R = fineRouter(ROOM);
} catch (e) {
  console.error(`gap: cannot build geometry for room ${ROOM}: ${e.message}`);
  console.error('Is it in the bake? `node tools/m59-routes.mjs` says what is.');
  process.exit(2);
}
// `key` and `inClosure` come from the router: this module's first version re-derived the
// closure key as `x >> 5` with a comma, and every membership test silently answered false.
const { closure, footing, standAt, floorAt, geo, room, declared, key, inClosure } = R;

const colOf = x => Math.floor(x / F) + 1;
const rowOf = y => Math.floor(y / F) + 1;
const cellName = (x, y) => `r${rowOf(y)}c${colOf(x)}`;
const inRoom = (x, y) => x >= 0 && y >= 0 && x <= room.cols * F && y <= room.rows * F;

// A start point. Default to the middle of the room rather than guessing an anchor: this is a
// diagnostic, and a wrong anchor silently answers about somewhere else.
const startCell = FROM ?? { row: Math.floor(room.rows / 2), col: Math.floor(room.cols / 2) };
const start = footing(startCell.row, startCell.col);
if (!start) {
  console.error(`gap: no floor anywhere inside r${startCell.row}c${startCell.col} — ` +
    'pick a square with ground in it, or the answer is about the void.');
  process.exit(2);
}
const goal = TO ? footing(TO.row, TO.col) : null;
if (TO && !goal) {
  console.error(`gap: no floor inside the goal square r${TO.row}c${TO.col}.`);
  process.exit(2);
}
const distTo = (x, y) => (goal ? Math.hypot(x - goal.x, y - goal.y) : 0);

// ---------------------------------------------------------------- the forward closure

const fwd = closure({ x: start.x, y: start.y });
const fwdPoints = [...fwd.values()];

// ---------------------------------------------------------------- one outward step, judged
//
// THE PREDICATES ARE THE ROUTER'S, IN THE ROUTER'S ORDER. This mirrors the flood in
// m59-fineroute.mjs exactly — same `standAt`, same MAX_STEP_HEIGHT, same
// `geo.traceFineMoveClient(..., {slide:true})`, same "went nowhere" threshold — and differs
// only in that it RETURNS WHY instead of `continue`. If the two ever disagree, this one is
// wrong and the flood is right.
function judgeStep(fromX, fromY, toX, toY, { step = 256 } = {}) {
  if (!inRoom(toX, toY)) return { ok: false, why: 'off_map' };
  const hc = standAt(fromX, fromY);
  const hn = standAt(toX, toY);
  if (hn == null) return { ok: false, why: 'no_floor' };
  if (hc != null && hn > hc + MAX_STEP_HEIGHT)
    return { ok: false, why: 'too_high', rise: hn - hc, cap: MAX_STEP_HEIGHT };
  const t = geo.traceFineMoveClient(fromX, fromY, toX, toY, { slide: true });
  if (!t || !t.moved) return { ok: false, why: 'mover_refused' };
  const px = Math.round(t.x), py = Math.round(t.y);
  if (Math.hypot(px - fromX, py - fromY) < step / 4)
    return { ok: false, why: 'went_nowhere', slid_to: cellName(px, py) };
  const hs = standAt(px, py);
  if (hs == null) return { ok: false, why: 'slid_into_void' };
  if (hc != null && hs > hc + MAX_STEP_HEIGHT)
    return { ok: false, why: 'slid_too_high', rise: hs - hc };
  return { ok: true, x: px, y: py, floor: hs };
}

// ---------------------------------------------------------------- --frontier

function frontier({ step = 256, limit = 12 } = {}) {
  const PERP = [0, step / 3, -step / 3, (2 * step) / 3, -(2 * step) / 3];
  const dirs = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) dirs.push([dx * step, dy * step]);
  const rows = [];
  const reasons = new Map();
  for (const p of fwdPoints) {
    const here = distTo(p.x, p.y);
    for (const [dx, dy] of dirs) {
      const len = Math.hypot(dx, dy) || 1;
      const ux = -dy / len, uy = dx / len;
      let accepted = false;
      let worst = null;
      for (const off of PERP) {
        const nx = Math.round(p.x + dx + ux * off);
        const ny = Math.round(p.y + dy + uy * off);
        const j = judgeStep(p.x, p.y, nx, ny, { step });
        if (j.ok) { accepted = true; break; }
        // Keep the refusal from the straight-on aim; the nudges are the same question.
        if (worst == null) worst = { ...j, nx, ny };
      }
      if (accepted || !worst) continue;
      const gain = here - distTo(worst.nx, worst.ny);
      reasons.set(worst.why, (reasons.get(worst.why) ?? 0) + 1);
      // Only the steps that would have made PROGRESS are interesting; a refusal pointing
      // away from the goal is the room's edge doing its job.
      if (goal && gain <= 0) continue;
      rows.push({
        at: cellName(p.x, p.y), toward: cellName(worst.nx, worst.ny),
        gain: Math.round(gain), why: worst.why,
        floor_here: standAt(p.x, p.y), floor_there: standAt(worst.nx, worst.ny),
        rise: worst.rise ?? null, cap: worst.cap ?? null, slid_to: worst.slid_to ?? null,
      });
    }
  }
  rows.sort((a, b) => b.gain - a.gain);
  // One row per cell: the same cell refusing eight directions is one finding.
  const seen = new Set();
  const best = [];
  for (const r of rows) { if (seen.has(r.at)) continue; seen.add(r.at); best.push(r); if (best.length >= limit) break; }
  return { closure_size: fwd.size, refusals_by_reason: Object.fromEntries(reasons), best };
}

// ---------------------------------------------------------------- --bridge
//
// LOOK AGAIN WITH A MICROSCOPE, AND ONLY WHERE THE COARSE FLOOD GAVE UP.
//
// A dense perpendicular sweep is far too expensive to run over a room — that is exactly why
// the flood samples five offsets. But it is cheap over a few dozen frontier cells, and a
// band narrower than the coarse phase is precisely what lives there.
function bridge({ step = 96, sweep = 24, seeds = 10, rounds = 60 } = {}) {
  const front = frontier({ limit: seeds }).best;
  if (!front.length) return { found: false, why: 'no frontier cell would make progress' };
  const fine = new Map();
  const keyOf = (x, y) => `${x >> 5},${y >> 5}`;
  const q = [];
  for (const f of front) {
    // Re-derive the frontier cell's fine point from its name via footing, so the seed is a
    // real standable point rather than a square centre.
    const row = Number(f.at.match(/r(\d+)/)[1]), col = Number(f.at.match(/c(\d+)/)[1]);
    const p = footing(row, col);
    if (!p) continue;
    if (fine.has(keyOf(p.x, p.y))) continue;
    fine.set(keyOf(p.x, p.y), { x: p.x, y: p.y, from: null });
    q.push({ x: p.x, y: p.y });
  }
  const dirs = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) dirs.push([dx * step, dy * step]);
  // The dense half: offsets every `step/sweep` units across a full step either way. This is
  // the phase search the coarse flood cannot afford.
  const PERP = [];
  for (let i = -sweep; i <= sweep; i++) PERP.push((i * step) / sweep);
  PERP.sort((a, b) => Math.abs(a) - Math.abs(b));

  let head = 0, expanded = 0, best = null;
  while (head < q.length && expanded < rounds * 200) {
    const cur = q[head++];
    expanded++;
    const d = distTo(cur.x, cur.y);
    if (goal && (best == null || d < best.d)) best = { ...cur, d };
    if (goal && d < F) break;                       // within a square of the target
    for (const [dx, dy] of dirs) {
      const len = Math.hypot(dx, dy) || 1;
      const ux = -dy / len, uy = dx / len;
      for (const off of PERP) {
        const nx = Math.round(cur.x + dx + ux * off);
        const ny = Math.round(cur.y + dy + uy * off);
        const j = judgeStep(cur.x, cur.y, nx, ny, { step });
        if (!j.ok) continue;
        const k = keyOf(j.x, j.y);
        if (fine.has(k)) continue;
        fine.set(k, { x: j.x, y: j.y, from: keyOf(cur.x, cur.y) });
        q.push({ x: j.x, y: j.y });
        break;
      }
    }
  }
  // Did the microscope reach anywhere the coarse flood did not?
  const escaped = [...fine.values()].filter(p => !inClosure(fwd, p.x, p.y));
  const path = [];
  if (best) {
    let cur = fine.get(keyOf(best.x, best.y));
    let guard = 0;
    while (cur && guard++ < 4000) {
      path.push({ at: cellName(cur.x, cur.y), x: cur.x, y: cur.y, floor: standAt(cur.x, cur.y) });
      cur = cur.from ? fine.get(cur.from) : null;
    }
    path.reverse();
  }
  return {
    found: escaped.length > 0,
    fine_points: fine.size,
    beyond_the_coarse_flood: escaped.length,
    step, perpendicular_offsets: PERP.length,
    closest: best ? { at: cellName(best.x, best.y), squares_from_goal: +(best.d / F).toFixed(2) } : null,
    waypoints: path.length > 1 ? path : null,
  };
}

// ---------------------------------------------------------------- --backwards
//
// PLAY TO THE TEST. The forward question is "where can this body get to", and it is the
// wrong question when you already know the destination. The backward one is "what would
// have to be true one step before arriving" — and because DESCENT IS UNBOUNDED and only
// climbing is capped, the set of places you could arrive FROM is far richer than the set you
// can walk to. Every ledge above the target is a candidate, at any height.
//
// So: reverse-search from the goal over edges a FORWARD move would accept. A cell A is an
// arrival point for cell B when a body at A could step to B (rise into B within
// MAX_STEP_HEIGHT, mover willing) or FALL to B (A strictly above B, horizontal gap inside
// the client's own fall reach for that drop).
function backwards({ step = 256, limit = 14 } = {}) {
  if (!goal) return { error: 'backwards needs --to: it searches from the target' };
  const seen = new Map([[key(goal.x, goal.y), { x: goal.x, y: goal.y, kind: 'goal', from: null }]]);
  const q = [{ x: goal.x, y: goal.y }];
  const dirs = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) dirs.push([dx * step, dy * step]);
  let head = 0;
  const dropIns = [];
  while (head < q.length && seen.size < 40000) {
    const cur = q[head++];
    const hc = standAt(cur.x, cur.y);
    if (hc == null) continue;
    for (const [dx, dy] of dirs) {
      const nx = Math.round(cur.x + dx), ny = Math.round(cur.y + dy);
      if (!inRoom(nx, ny)) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      const hn = standAt(nx, ny);
      if (hn == null) continue;
      // Could a body at (nx,ny) STEP to (cur)? That is the forward test, run backwards.
      const j = judgeStep(nx, ny, cur.x, cur.y, { step });
      if (j.ok) {
        seen.set(k, { x: nx, y: ny, kind: 'step', from: key(cur.x, cur.y) });
        q.push({ x: nx, y: ny });
        continue;
      }
      // Could it FALL to it? TWO THINGS WERE WRONG HERE and both lost candidates.
      //
      //   * `drop > MAX_STEP_HEIGHT` meant a LEVEL hop was never even considered. A body
      //     running off an edge is airborne whether or not the landing is below it — the
      //     level reach is 1.38 squares, not zero — so every level and short-drop crossing
      //     was invisible to this search. Room 27's stone is level with its take-off.
      //   * `reachFor(drop)` forgets the step the body may still climb on arrival. The
      //     client's rule is `fallenBy(t) <= drop + MAX_STEP_HEIGHT`, so the reach is
      //     `maxSpan(drop)` — larger at every drop, by a third of a square near level.
      //
      // `judgeStep` above has already claimed anything that is an ordinary walk, so there is
      // no need to gate on the drop at all: what reaches here is what walking refused.
      const drop = hn - hc;
      {
        const gap = Math.hypot(nx - cur.x, ny - cur.y);
        if (gap <= maxSpan(drop)) {
          seen.set(k, { x: nx, y: ny, kind: 'fall', from: key(cur.x, cur.y) });
          q.push({ x: nx, y: ny });
          dropIns.push({ from: cellName(nx, ny), onto: cellName(cur.x, cur.y),
                         drop, squares: +(gap / F).toFixed(2),
                         reach_squares: +(maxSpan(drop) / F).toFixed(2) });
        }
      }
    }
  }
  // WHERE THE TWO SETS MEET IS THE PLAN; WHERE THEY DO NOT, THE SMALLEST GAP IS THE JUMP
  // SOMEBODY HAS TO DECLARE. This is the payoff of searching from both ends.
  let meet = null, nearest = null;
  for (const p of fwdPoints) {
    if (seen.has(key(p.x, p.y))) { meet = cellName(p.x, p.y); break; }
  }
  if (!meet) {
    for (const p of fwdPoints) for (const b of seen.values()) {
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (nearest == null || d < nearest.d) nearest = { d, a: p, b };
    }
  }
  dropIns.sort((x, y) => y.drop - x.drop);
  const uniq = [];
  const seenFrom = new Set();
  for (const d of dropIns) { if (seenFrom.has(d.from)) continue; seenFrom.add(d.from); uniq.push(d); if (uniq.length >= limit) break; }
  return {
    arrival_set: seen.size,
    drop_in_points: uniq,
    meets_forward_closure_at: meet,
    smallest_unbridged_gap: meet || !nearest ? null : {
      from: cellName(nearest.a.x, nearest.a.y), to: cellName(nearest.b.x, nearest.b.y),
      squares: +(nearest.d / F).toFixed(2),
      floor_from: standAt(nearest.a.x, nearest.a.y), floor_to: standAt(nearest.b.x, nearest.b.y),
      note: 'declare this in substrate/m59-falljumps.json with from_fine/to_fine if a body can make it',
    },
  };
}

// ---------------------------------------------------------------- --stairs
//
// TREADS A WALK CANNOT SPELL. The operator's account of these puzzles is a staircase of low
// treads up to a high area, and 579's is 5152 -> 5504 -> 5856 -> 6208, +352 each against a
// 384 cap — every tread legal, and the whole flight invisible unless you BOARD AT THE
// BOTTOM, because the gully beside stair two sits 832 below it and reads as a wall.
//
// So: find monotone ascending chains where every rise is inside MAX_STEP_HEIGHT, and report
// the boarding cell — the bottom — and whether the body can already reach it.
function stairs({ step = 256, minTreads = 3, limit = 10 } = {}) {
  const pts = new Map();
  for (let y = 0; y <= room.rows * F; y += step)
    for (let x = 0; x <= room.cols * F; x += step) {
      const h = standAt(x, y);
      if (h != null) pts.set(`${x},${y}`, { x, y, h });
    }
  // Heights strictly increase along a chain, so the ascending graph is a DAG and the longest
  // ascending path is one pass in height order.
  const order = [...pts.values()].sort((a, b) => a.h - b.h);
  const bestTo = new Map();       // key -> { treads, rise, from }
  for (const p of order) {
    const k = `${p.x},${p.y}`;
    if (!bestTo.has(k)) bestTo.set(k, { treads: 1, rise: 0, from: null });
    const mine = bestTo.get(k);
    for (let dx = -step; dx <= step; dx += step) for (let dy = -step; dy <= step; dy += step) {
      if (!dx && !dy) continue;
      const nk = `${p.x + dx},${p.y + dy}`;
      const n = pts.get(nk);
      if (!n) continue;
      const rise = n.h - p.h;
      if (rise <= 0 || rise > MAX_STEP_HEIGHT) continue;
      const cand = { treads: mine.treads + 1, rise: mine.rise + rise, from: k };
      const cur = bestTo.get(nk);
      if (!cur || cand.treads > cur.treads || (cand.treads === cur.treads && cand.rise > cur.rise))
        bestTo.set(nk, cand);
    }
  }
  const flights = [];
  for (const [k, v] of bestTo) {
    if (v.treads < minTreads) continue;
    const [x, y] = k.split(',').map(Number);
    // Walk back to the bottom of the flight.
    let cur = k, guard = 0, chain = [];
    while (cur && guard++ < 500) { const [cx, cy] = cur.split(',').map(Number); chain.push({ x: cx, y: cy }); cur = bestTo.get(cur)?.from; }
    chain.reverse();
    const bottom = chain[0];
    flights.push({
      board_at: cellName(bottom.x, bottom.y), top: cellName(x, y),
      treads: v.treads, total_rise: v.rise,
      floor_bottom: standAt(bottom.x, bottom.y), floor_top: standAt(x, y),
      bottom_is_reachable: inClosure(fwd, bottom.x, bottom.y),
      top_is_reachable: inClosure(fwd, x, y),
    });
  }
  flights.sort((a, b) => b.total_rise - a.total_rise);
  const out = [];
  const tops = new Set();
  for (const f of flights) { if (tops.has(f.top)) continue; tops.add(f.top); out.push(f); if (out.length >= limit) break; }
  return { sampled_points: pts.size, flights: out };
}

// ---------------------------------------------------------------- report

const want = {
  frontier: ALL || has('frontier') || (!has('bridge') && !has('backwards') && !has('stairs')),
  bridge: ALL || has('bridge'),
  backwards: ALL || has('backwards'),
  stairs: ALL || has('stairs'),
};

const out = {
  room: ROOM, room_size: { rows: room.rows, cols: room.cols },
  from: `r${startCell.row}c${startCell.col}`, from_floor: standAt(start.x, start.y),
  to: TO ? `r${TO.row}c${TO.col}` : null, to_floor: goal ? standAt(goal.x, goal.y) : null,
  declared_jumps: declared?.length ?? 0,
};
if (want.frontier) out.frontier = frontier();
if (want.bridge) out.bridge = bridge();
if (want.backwards) out.backwards = backwards();
if (want.stairs) out.stairs = stairs();

if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const H = (s) => { console.log(''); console.log(s); console.log('-'.repeat(s.length)); };
console.log('');
console.log(`room ${ROOM} — ${room.rows} rows x ${room.cols} cols, ${out.declared_jumps} declared jump(s)`);
console.log(`from  ${out.from} floor ${out.from_floor}` + (out.to ? `    to  ${out.to} floor ${out.to_floor}` : ''));

if (out.frontier) {
  H('FRONTIER — where the flood stops, and which predicate stopped it');
  console.log(`the body can reach ${out.frontier.closure_size} fine point(s)`);
  console.log('refusals by reason: ' + (Object.entries(out.frontier.refusals_by_reason)
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '(none)'));
  if (!out.frontier.best.length) console.log('  no refused step would have made progress toward the goal');
  for (const r of out.frontier.best)
    console.log(`  ${r.at} -> ${r.toward}  ${String(r.why).padEnd(14)} ` +
      `floor ${r.floor_here} -> ${r.floor_there}` +
      (r.rise != null ? `  rise ${r.rise} (cap ${r.cap})` : '') +
      (r.slid_to ? `  slid to ${r.slid_to}` : '') +
      `  gains ${(r.gain / F).toFixed(2)} sq`);
}

if (out.bridge) {
  H('BRIDGE — the same frontier, swept densely across the direction of travel');
  const b = out.bridge;
  if (b.why) { console.log(`  ${b.why}`); }
  else {
    console.log(`step ${b.step} with ${b.perpendicular_offsets} perpendicular offsets ` +
      `(the coarse flood uses 5)`);
    console.log(`${b.fine_points} fine point(s), ${b.beyond_the_coarse_flood} of them BEYOND ` +
      `the coarse flood`);
    if (b.closest) console.log(`closest approach ${b.closest.at}, ${b.closest.squares_from_goal} squares from the goal`);
    if (b.found) {
      console.log('  *** A BAND THE COARSE FLOOD MISSED. This is a phase failure, not a wall. ***');
      if (b.waypoints) {
        console.log(`  ${b.waypoints.length} fine waypoint(s) — the bridge:`);
        for (const w of b.waypoints.slice(0, 24)) console.log(`    ${w.at}  x${w.x} y${w.y}  floor ${w.floor}`);
        if (b.waypoints.length > 24) console.log(`    ... ${b.waypoints.length - 24} more`);
      }
    } else console.log('  nothing beyond the coarse flood — the refusal is real, not a phase artifact');
  }
}

if (out.backwards) {
  H('BACKWARDS — what would have to be true one step before arriving');
  const b = out.backwards;
  if (b.error) console.log(`  ${b.error}`);
  else {
    console.log(`${b.arrival_set} point(s) could reach the goal in one move`);
    if (b.meets_forward_closure_at)
      console.log(`  *** MEETS the forward closure at ${b.meets_forward_closure_at} — there IS a way ***`);
    else if (b.smallest_unbridged_gap) {
      const g = b.smallest_unbridged_gap;
      console.log(`  the two sets do NOT meet. Smallest gap:`);
      console.log(`    ${g.from} (floor ${g.floor_from})  ->  ${g.to} (floor ${g.floor_to})` +
        `   ${g.squares} squares, drop ${g.floor_from - g.floor_to}`);
      console.log(`    ${g.note}`);
    }
    if (b.drop_in_points.length) {
      console.log('  places you could DROP IN from (deepest first):');
      for (const d of b.drop_in_points)
        console.log(`    ${d.from} -> ${d.onto}  drop ${d.drop}  ${d.squares} sq ` +
          `(fall reach ${d.reach_squares} sq)`);
    }
  }
}

if (out.stairs) {
  H('STAIRS — ascending chains whose every tread is inside the 384 cap');
  console.log(`sampled ${out.stairs.sampled_points} standable point(s)`);
  if (!out.stairs.flights.length) console.log('  no flight of 3 or more legal treads');
  for (const f of out.stairs.flights)
    console.log(`  board at ${f.board_at} (floor ${f.floor_bottom})  ->  ${f.top} (floor ${f.floor_top})` +
      `   ${f.treads} treads, +${f.total_rise}` +
      `   bottom ${f.bottom_is_reachable ? 'REACHABLE' : 'not reachable'}` +
      `, top ${f.top_is_reachable ? 'reachable' : 'NOT reachable'}`);
}
console.log('');
