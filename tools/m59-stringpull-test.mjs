#!/usr/bin/env node
// A ROUTE OF SQUARES IS NOT A ROUTE OF MOVES — the contract test for stringPull.
//
//   node tools/m59-stringpull-test.mjs
//
// Offline. Runs against the real baked geometry rather than a fixture, because the whole
// finding is about geometry that a fixture would not reproduce: room 587's wall length is
// 54.9% NOT axis-aligned, and it is the diagonal faces that refuse an axis-aligned step
// between two square centres.
//
// WHAT THIS IS GUARDING. Stepping centre-to-centre along a grid route in 587, with the
// real fine position carried forward, 143 of 242 steps fail — and 136 of those, 95%, do
// not move the character at all. `stringPull` replaces those steps with straight legs
// that have each been checked to ARRIVE. The two properties that make it safe are the
// ones tested hardest here:
//
//   * a leg is only kept if the straight line arrives with `slide: false`, which is
//     STRICTER than the ordinary mover, so this can never authorise a traversal the
//     mover would refuse;
//   * the first and last point are preserved exactly, so a caller that asked to end on a
//     particular square still ends on it.
//
// If this file goes red, the fleet is walking somewhere the geometry did not agree to.
import { readFileSync, existsSync } from 'node:fs';
import { RoomGeometry, CLIENT_FINENESS } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { movementMapFile, announceMovementMap } from './m59-map-path.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

// Which map this planned on. See m59-map-path.mjs: the local bake and the committed
// reference disagree, and a suite that does not say which it used cannot be compared.
announceMovementMap();
const mapFile = movementMapFile();
if (!existsSync(mapFile)) {
  console.log('no baked map — skipping (this suite is about real geometry, not a fixture)');
  process.exit(0);
}

const map = JSON.parse(readFileSync(mapFile, 'utf8'));
const byRoom = new Map();
attachStepMasks(map, { geometryOf: r => {
  let g = byRoom.get(r); if (!g) { g = RoomGeometry.fromJSON(r.roo); byRoom.set(r, g); } return g; } });

const geo = byRoom.get(map.rooms['587']);
ok('room 587 geometry loaded', !!geo);
// THE SAME POINT THE PLANNER AND THE MOVER USE, not the square's centre. `standPoint` is
// the centre for every ordinary square, so this changes nothing in open ground — but a
// square a diagonal wall cuts in half has its centre inside the wall, and feeding those
// centres in asks `stringPull` to verify legs between points nobody ever aims at. Measured
// that way it reported 36 of 66 legs unverified while doing its job perfectly.
const C = (r, c) => geo.standPoint(r, c)
                 ?? { x: (c - 0.5) * CLIENT_FINENESS, y: (r - 0.5) * CLIENT_FINENESS };
const arrives = (a, b) => {
  const t = geo.traceFineMoveClient(a.x, a.y, b.x, b.y, { slide: false });
  return !!t && Math.hypot(t.x - b.x, t.y - b.y) <= 64;
};

// ---------------------------------------------------------------- shape
ok('an empty route comes back unchanged', geo.stringPull([]).points.length === 0);
const one = [C(10, 10)];
ok('a single point comes back unchanged', geo.stringPull(one).points.length === 1);

// ---------------------------------------------------------------- the real routes
const STARTS = [{ row: 20, col: 9 }, { row: 35, col: 39 }, { row: 1, col: 4 },
                { row: 45, col: 20 }, { row: 10, col: 50 }, { row: 30, col: 12 }];
const GOAL = { row: 14, col: 1 };

let gridSteps = 0, pivots = 0, routes = 0, unverifiedTotal = 0;
let everyLegArrives = true, endpointsKept = true, neverGrows = true;
for (const s of STARTS) {
  const p = geo.path(s.row, s.col, GOAL.row, GOAL.col);
  if (!p.found) continue;
  routes++;
  const pts = [C(s.row, s.col), ...p.steps.map(x => C(x.row, x.col))];
  const res = geo.stringPull(pts);
  const pulled = res.points;
  unverifiedTotal += res.unverified;

  gridSteps += pts.length - 1;
  pivots += pulled.length - 1;

  // THE SAFETY PROPERTY, stated exactly. A leg that SPANS MORE THAN ONE grid step is one
  // this function created, and it must arrive without sliding. A single-step leg is the
  // original route's own step, passed through untouched — it inherits whatever the square
  // walk already had, and asserting it would be asserting the bug this exists to route
  // around. `unverified` is how the caller learns how many of those there were.
  const idx = new Map(pts.map((p, i) => [p.x + ',' + p.y, i]));
  for (let i = 1; i < pulled.length; i++) {
    const span = (idx.get(pulled[i].x + ',' + pulled[i].y) ?? 0) -
                 (idx.get(pulled[i - 1].x + ',' + pulled[i - 1].y) ?? 0);
    if (span > 1 && !arrives(pulled[i - 1], pulled[i])) everyLegArrives = false;
  }

  // THE CALLER'S PROPERTY. The ends are what was asked for.
  const a = pulled[0], b = pulled[pulled.length - 1];
  const a0 = pts[0], b0 = pts[pts.length - 1];
  if (a.x !== a0.x || a.y !== a0.y || b.x !== b0.x || b.y !== b0.y) endpointsKept = false;

  // It is a SIMPLIFICATION. It may not invent moves.
  if (pulled.length > pts.length) neverGrows = false;
}

ok(`six real routes in 587 planned (${routes})`, routes >= 5);
ok('every CREATED leg arrives with slide:false — it cannot authorise what the mover refuses',
   everyLegArrives);
ok(`most legs are created rather than passed through (${unverifiedTotal} unverified of ${pivots})`,
   pivots > 0 && unverifiedTotal < pivots * 0.5,
   `${unverifiedTotal}/${pivots} were the original refused step`);
ok('the first and last point are preserved exactly', endpointsKept);
ok('it never returns more points than it was given', neverGrows);
ok(`it is a real reduction (${gridSteps} grid steps -> ${pivots} pivots)`,
   pivots > 0 && gridSteps / pivots >= 2,
   `only ${(gridSteps / Math.max(1, pivots)).toFixed(1)}x`);

// ---------------------------------------------------------------- the reason it exists
//
// The centre-to-centre walk this replaces, measured here so the number is pinned rather
// than quoted from a commit message. If this assertion ever goes green-by-improvement,
// the grid walk has been fixed and stringPull may not be needed — which is worth knowing.
let refused = 0, stationary = 0, total = 0;
for (const s of STARTS) {
  const p = geo.path(s.row, s.col, GOAL.row, GOAL.col);
  if (!p.found) continue;
  let pos = C(s.row, s.col);
  for (const st of p.steps) {
    const want = C(st.row, st.col);
    const t = geo.traceFineMoveClient(pos.x, pos.y, want.x, want.y, { slide: true });
    const end = { x: t?.x ?? pos.x, y: t?.y ?? pos.y };
    total++;
    if (Math.hypot(end.x - want.x, end.y - want.y) > 64) {
      refused++;
      if (Math.hypot(end.x - pos.x, end.y - pos.y) < 1) stationary++;
    }
    pos = end;
  }
}
ok(`the grid walk it replaces still fails a lot (${refused}/${total} steps)`,
   refused > total * 0.3, `only ${refused}/${total}`);
ok(`and most of those failures do not move at all (${stationary}/${refused})`,
   refused > 0 && stationary > refused * 0.5,
   `${stationary}/${refused} — if this drops, the retry loop is no longer the problem`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
