// THE GUARD FOR m59-noderails.mjs — offline, no map, no socket, no room, no roster.
//
//   node tools/m59-noderails-test.mjs
//
// The edge test and the router are injected, so every case runs against a synthetic world whose
// shape is known exactly. One case per thing that has gone wrong on the real map, and the two
// that this bake exists to stop are `railSpan`'s unvalidated branch (a chord nobody traced,
// shipped as a rail) and `arrivalOf` (a flood reaching the VALLEY half of the stone's square and
// reporting it as the stone).
import { exitAnchorsOf, exitId, exitLabel, railSpan, railLeg, aimsAlong, arrivalOf,
         checkRoute, findRoute, stonesToBake, inMeldBox, fineEdge, bakeOne,
         MANANODE_RANGE, NODERAIL_VERSION, AIM_BUDGET } from './m59-noderails.mjs';
import { LATTICE, verifyRail, MIN_MOVER_STEP } from './m59-railcut.mjs';
import { MAX_STEP_HEIGHT } from './m59-roo.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);

const bounds = { w: 40960, h: 40960 };
const open = () => true;
const shut = () => false;
const flat = () => 1000;

// ---- the exits come from the bake, and a waypoint is not one ------------------------------
{
  // Room 27's anchor list really is this shape: two edges, a go, and FOURTEEN waypoints, one of
  // which IS the mana stone. Keeping them would bake a rail from the node to itself and would
  // put thirteen spawn points in a list of doors.
  const table = { rooms: { 27: { anchors: [
    { kind: 'edge', dir: 'west', to: 2500, row: 11, col: 1, region: 0 },
    { kind: 'go', dir: null, to: 5, row: 18, col: 30, region: 15 },
    { kind: 'waypoint', dir: null, to: null, row: 23, col: 53, region: 15 },
    { kind: 'waypoint', dir: null, to: null, row: 51, col: 14, region: 15 },
  ] } } };
  const ex = exitAnchorsOf(table, 27);
  eq(ex.length, 2, 'the waypoints are dropped and the two real exits kept');
  eq(ex.map(e => e.kind), ['edge', 'go'], 'both kinds of exit survive');
  ok(!ex.some(e => e.row === 23 && e.col === 53), 'the stone is not baked as one of its own exits');
  eq(exitAnchorsOf(table, 999), [], 'a room with no entry in the table has no exits, not a throw');
  eq(exitAnchorsOf(null, 27), [], '...and neither does a missing table');
  eq(exitId(ex[0]), 'edge:2500:r11c1', 'the id carries kind, destination and square');
  ok(/west -> 2500 r11c1/.test(exitLabel(ex[0])), 'the label is the one a person reads');
  // TWO EXITS ON ONE BOUNDARY ARE NOT ONE EXIT. Western border of the Twisted Wood declares
  // east->586 and east->597 on the same wall; an id keyed on direction alone would collide.
  const twoWays = { rooms: { 587: { anchors: [
    { kind: 'edge', dir: 'east', to: 586, row: 9, col: 67 },
    { kind: 'edge', dir: 'east', to: 597, row: 47, col: 67 },
  ] } } };
  const ids = exitAnchorsOf(twoWays, 587).map(exitId);
  eq(new Set(ids).size, 2, 'two exits through one wall get two ids');
}

// ---- railSpan: the three ways a span settles ----------------------------------------------
{
  const a = { x: 1000, y: 1000 }, b = { x: 1512, y: 1000 };
  const chord = railSpan(a, b, { edge: open, bounds, floorAt: flat });
  eq(chord.how, 'chord', 'an open straight line is settled as a chord');
  eq(chord.points[chord.points.length - 1], { x: 1512, y: 1000, f: 1000 },
     'the span ends ON b, not on a snapped approximation of it');
  ok(chord.points.length === Math.ceil(512 / LATTICE), 'stepped at the lattice, one point a piece');
  ok(!chord.points.some(p => p.x === a.x && p.y === a.y), 'a is the caller\'s, and is not repeated');
}
{
  // A WALL ACROSS THE STRAIGHT LINE, WITH A WAY ROUND INSIDE THE SPAN. This is the case the
  // planner's own decimation gets wrong: it kept the two ends and never traced between them.
  const wall = (p, q) => !((p.y < 1100) !== (q.y < 1100)) || Math.min(p.x, q.x) >= 1400;
  const s = railSpan({ x: 1000, y: 1000 }, { x: 1000, y: 1200 },
                     { edge: wall, bounds, floorAt: flat });
  eq(s.how, 'flood', 'a blocked chord with a detour is settled by the flood');
  ok(s.points.length > 4, '...and the detour is longer than the straight line was');
  const end = s.points[s.points.length - 1];
  eq({ x: end.x, y: end.y }, { x: 1000, y: 1200 }, 'the flood span also ends exactly on b');
}
{
  const s = railSpan({ x: 1000, y: 1000 }, { x: 1000, y: 1200 },
                     { edge: shut, bounds, floorAt: flat });
  eq(s.how, 'unvalidated', 'a span nothing can walk is UNVALIDATED, not dropped');
  eq(s.points.length, 1, '...the planner\'s own point is kept');
  ok(/chord refused/.test(s.why), '...and it says which check refused and where');
  ok(/flood reached \d+/.test(s.why), '...and how far the flood got, so the refusal has a bound');
}

// ---- WHAT IS WRITTEN IS WHAT WAS CHECKED ----------------------------------------------------
{
  // The bake used to validate with `chordWalkable`'s fractional pieces and then WRITE the
  // rounded ones. `noderails check` re-traces what was written, so the two passes were asking
  // about two different lines and it refused 6 of 27 rails on ground the bake had just called
  // walkable. This is the invariant that killed that: everything emitted verifies under the
  // same edge, by construction.
  const hairline = (a, b) => !(b.x === 1256 && b.y === 0);   // one point is not standable
  const a = { x: 1000, y: 0 }, b = { x: 1512, y: 0 };
  const s = railSpan(a, b, { edge: hairline, bounds, floorAt: flat });
  ok(s.how !== 'chord', 'a chord through a refused point is not settled as a chord');
  const v = verifyRail([a, ...s.points], { edge: hairline });
  ok(v.ok || s.how === 'unvalidated',
     'whatever it emits, it verifies under the very edge it was cut with');
}
{
  // THE CURSOR. A flood span can stop half a lattice short of the point it aimed at; if the
  // next span starts from the AIM rather than from where the rail actually is, there is an
  // untraced hop between them and both spans report themselves settled.
  const leg = railLeg({ waypoints: [{ x: 1000, y: 0 }, { x: 1230, y: 0 }, { x: 1500, y: 0 }] },
                      { edge: open, bounds, floorAt: flat });
  const v = verifyRail(leg.waypoints, { edge: open });
  ok(v.ok, 'a two-span leg verifies end to end, with no gap at the joint');
  for (let i = 1; i < leg.waypoints.length; i++) {
    const p = leg.waypoints[i - 1], q = leg.waypoints[i];
    ok(Math.hypot(q.x - p.x, q.y - p.y) <= LATTICE * 1.5,
       `step ${i} of the dense rail is one lattice step, not a leap over a joint`);
  }
}

{
  // THE SNAPPED SEED. `cutRail` snaps the start to the lattice and reports `bridgeOk` for the
  // hop to it, returning ok either way — so a flood span can BEGIN with a step the cursor
  // cannot take. On the real bake that joint was 21 units, under the mover's 128-unit floor,
  // and it was the last disagreement between the bake and `check`.
  const seen = [];
  const refuseShort = (a, b) => {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    seen.push(Math.round(d));
    if (d < 32) return false;                       // the mover will not move at all
    return !((a.y < 1100) !== (b.y < 1100)) || Math.min(a.x, b.x) >= 1400;
  };
  const s2 = railSpan({ x: 1021, y: 1000 }, { x: 1021, y: 1200 },
                      { edge: refuseShort, bounds, floorAt: flat });
  ok(s2.how !== 'chord', 'the straight line is blocked, so this is the flood branch');
  if (s2.how === 'flood') {
    const first = s2.points[0];
    ok(Math.hypot(first.x - 1021, first.y - 1000) >= 32,
       'the emitted span does not open with a step below the mover floor');
    ok(verifyRail([{ x: 1021, y: 1000 }, ...s2.points], { edge: refuseShort }).ok,
       'and the flood span verifies pairwise from the cursor, seed included');
  } else {
    ok(s2.how === 'unvalidated', 'a flood span that cannot be validated from the cursor is not a rail');
  }
}

// ---- railLeg: the drops are measured on the DENSE points -----------------------------------
{
  // A staircase: four treads of 352 against a 384 cap. Every one is legal, and a decimated line
  // that keeps only the ends would read the whole climb as one 1,408-unit wall.
  const stair = { 1000: 5152, 1064: 5504, 1128: 5856, 1192: 6208, 1256: 6560 };
  const floorAt = (x) => stair[x] ?? 6560;
  const leg = railLeg({ waypoints: [{ x: 1000, y: 0 }, { x: 1256, y: 0 }], biggest_drop: 0 },
                      { edge: open, bounds, floorAt });
  eq(leg.committing_drops.length, 0, 'a staircase of legal treads has no committing drop');
  ok(leg.waypoints.length === 5, 'the dense rail has every tread, not just the two ends');
  eq(leg.waypoints[0].row, 1, 'a dense point carries its square too — row');
  eq(leg.waypoints[0].col, 1, '...and col, 1-based like the rest of this repository');
}
{
  // THE LEDGE. One step off it is 2,000 units down — past the cap, so it is a FALL, and a leg
  // with one in it is one-way however symmetric the two endpoints look.
  const floorAt = (x) => (x >= 1064 ? 3000 : 5000);
  const leg = railLeg({ waypoints: [{ x: 1000, y: 0 }, { x: 1128, y: 0 }] },
                      { edge: open, bounds, floorAt });
  eq(leg.committing_drops.length, 1, 'a drop past MAX_STEP_HEIGHT is reported');
  eq(leg.committing_drops[0].drop, 2000, '...with the size of it');
  ok(leg.committing_drops[0].drop > MAX_STEP_HEIGHT, '...and it is past the cap by definition');
}
{
  const empty = railLeg({ waypoints: [] }, { edge: open, bounds, floorAt: flat });
  eq(empty.waypoints, [], 'an empty leg is empty rather than a throw');
  eq(empty.unvalidated, 0, '...and counts nothing');
}
{
  const one = railLeg({ waypoints: [{ x: 1000, y: 0 }] }, { edge: open, bounds, floorAt: flat });
  eq(one.waypoints.length, 1, 'a one-point leg keeps its point');
  eq(one.spans, [], '...and has no spans to settle');
}

// ---- aimsAlong: a straight run is free, a corner is not ------------------------------------
{
  const straight = [];
  for (let i = 0; i <= 8; i++) straight.push({ x: 1000 + i * LATTICE, y: 1000, f: 1000 });
  const aims = aimsAlong(straight);
  eq(aims.length, 2, 'a straight run of lattice steps collapses to its two ends');
  eq(aims[1], straight[8], '...ending on the last point of the run');
}
{
  // A CORNER IS KEPT, and the aim is the point BEFORE the heading changes — not after it, which
  // is what `fineRouter` does and what puts an untraced chord across a corner.
  const bend = [{ x: 1000, y: 1000, f: 1 }, { x: 1064, y: 1000, f: 1 }, { x: 1128, y: 1000, f: 1 },
                { x: 1128, y: 1064, f: 1 }, { x: 1128, y: 1128, f: 1 }];
  const aims = aimsAlong(bend);
  eq(aims.length, 3, 'two straight runs meeting at a corner give three aims');
  eq(aims[1], bend[2], 'the corner itself is an aim');
  eq(aims[2], bend[4], '...and the far end closes the line');
}
{
  // A long straight run is still split at the budget, because an aim longer than the walker's
  // leg budget is an ABORT with no reason attached, not a slow leg.
  const long = [];
  for (let i = 0; i <= 80; i++) long.push({ x: 1000 + i * LATTICE, y: 0, f: 1 });
  const aims = aimsAlong(long);
  ok(aims.length > 2, 'a run longer than the budget is split');
  for (let i = 1; i < aims.length; i++)
    ok(Math.hypot(aims[i].x - aims[i - 1].x, aims[i].y - aims[i - 1].y) <= AIM_BUDGET + LATTICE,
       `aim ${i} is inside the budget`);
  ok(AIM_BUDGET < 3072, 'the budget is the measured one, not railfollow\'s three-square ceiling');
}
{
  // AN UNVALIDATED SPAN MUST NOT BE MERGED INTO A CHORD. It is a long step nothing traced; a
  // merge either side of it would hand a walker a straight line across the one place that
  // refused.
  const withGap = [{ x: 1000, y: 0, f: 1 }, { x: 1064, y: 0, f: 1 },
                   { x: 3000, y: 0, f: 1 },                       // the unvalidated leap
                   { x: 3064, y: 0, f: 1 }, { x: 3128, y: 0, f: 1 }];
  const aims = aimsAlong(withGap);
  ok(aims.some(p => p.x === 1064), 'the point before the leap is an aim');
  ok(aims.some(p => p.x === 3000), '...and the landing is an aim of its own');
}
{
  eq(aimsAlong([]), [], 'no waypoints, no aims');
  eq(aimsAlong([{ x: 1, y: 1 }]).length, 1, 'one waypoint is its own aim');
}

// ---- an aim shorter than the mover's minimum step is a no-op that reports success ----------
{
  // A ZIGZAG: every step 64 units and every heading different, which is what a diagonal
  // staircase looks like on the lattice. Each corner is its own aim, so without the extension
  // below every aim is 64 units — half the mover's floor — and `walkFine` answers each one
  // with `arrived: true, steps: 0`. Measured on the real bake before this loop existed: 410 of
  // 602 aim gaps on the Ancient Place's west rail were under 128, median 64.
  const zig = [];
  for (let i = 0; i <= 40; i++)
    zig.push({ x: 1000 + i * LATTICE, y: 1000 + (i % 2) * LATTICE, f: 1 });
  const naive = aimsAlong(zig, { edge: null });
  ok(naive.length > 20, 'with no edge to ask, every corner stays an aim');
  const merged = aimsAlong(zig, { edge: open });
  ok(merged.length < naive.length, 'a traced chord merges the corners');
  for (let i = 1; i < merged.length - 1; i++) {
    const d = Math.hypot(merged[i].x - merged[i - 1].x, merged[i].y - merged[i - 1].y);
    ok(d >= MIN_MOVER_STEP, `aim ${i} is at least the mover's minimum step (${Math.round(d)})`);
  }
  eq(merged[merged.length - 1], zig[zig.length - 1], 'the rail still ends where the rail ends');
}
{
  // AND IT IS NOT ALLOWED TO CHEAT THE CORNER. When the chord over a corner refuses, the short
  // aim SURVIVES — dropping it would hand the walker a straight line round a hairpin that
  // nothing traced, which is the exact fault this bake was written to remove.
  const zig = [];
  for (let i = 0; i <= 10; i++)
    zig.push({ x: 1000 + i * LATTICE, y: 1000 + (i % 2) * LATTICE, f: 1 });
  const aims = aimsAlong(zig, { edge: shut });
  ok(aims.length > 5, 'a refused merge keeps the corners as aims');
  ok(Array.isArray(aims.shortAims) && aims.shortAims.length > 0,
     '...and says how many of them are below the mover floor, rather than hiding it');
  const straight = [];
  for (let i = 0; i <= 8; i++) straight.push({ x: 1000 + i * LATTICE, y: 1000, f: 1 });
  eq(aimsAlong(straight, { edge: shut }).length, 2,
     'a straight run needs no trace at all, so a refusing edge cannot shorten it');
}

// ---- the meld test is the SERVER'S, and it is a box with no height term --------------------
{
  eq(MANANODE_RANGE, 3, 'MANANODE_RANGE is 3 — mananode.kod:17');
  const stone = { row: 23, col: 53 };
  ok(inMeldBox({ row: 25, col: 55 }, stone), 'two off on BOTH axes is inside the 5x5 box');
  ok(!inMeldBox({ row: 26, col: 53 }, stone), 'three off on one axis is outside it');
  ok(!inMeldBox({ row: 23, col: 56 }, stone), '...on either axis');
  ok(inMeldBox({ row: 23, col: 53 }, stone), 'the stone\'s own square is inside it');
  // A EUCLIDEAN RADIUS SCORES THIS WRONG IN BOTH DIRECTIONS, which is why the axes are judged
  // independently: 2,2 is 2.83 away and melds; 0,3 is 3.0 away and does not.
  ok(inMeldBox({ row: 21, col: 51 }, stone) && !inMeldBox({ row: 23, col: 50 }, stone),
     'the diagonal corner melds while a nearer square on one axis does not');
}

// ---- arrivalOf: reaching the SQUARE is not reaching the STONE -------------------------------
{
  // Room 45's shape, reduced: the stone stands on a plateau at 4096 and the valley runs under it.
  // `fineRouter`'s success test is `sqOf(p) === goal square`, which the valley satisfies.
  const router = { footing: () => ({ x: 0, y: 0, h: 4096 }) };
  const legs = [{ kind: 'walk', waypoints: [
    { x: 0, y: 0, f: 800, row: 60, col: 46 },
    { x: 64, y: 0, f: 800, row: 63, col: 46 },
  ] }];
  const a = arrivalOf(legs, { row: 63, col: 46 }, router);
  eq(a.arrival.row, 63, 'the arrival is the last point of the last walk leg');
  eq(a.target_floor, 4096, 'the target floor is the footing of the destination square');
  eq(a.arrived_below, 3296, 'and the gap under it is measured, not assumed away');
  ok(a.arrived_off_shelf, 'past one step height, the rail ended UNDER its destination');
  ok(a.arrived_in_square, '...while still being in the right square, which is the whole trap');
}
{
  const router = { footing: () => ({ h: 1000 }) };
  const legs = [{ kind: 'walk', waypoints: [{ x: 0, y: 0, f: 1000, row: 5, col: 5 }] }];
  const a = arrivalOf(legs, { row: 5, col: 5 }, router);
  eq(a.arrived_below, 0, 'a rail that ends on its target\'s own shelf is 0 below it');
  ok(!a.arrived_off_shelf, '...and is not off-shelf');
}
{
  const router = { footing: () => null };
  const legs = [{ kind: 'walk', waypoints: [{ x: 0, y: 0, f: null, row: 1, col: 1 }] }];
  const a = arrivalOf(legs, { row: 1, col: 1 }, router);
  ok(!('arrived_below' in a), 'an unreadable floor reports NO comparison rather than a zero');
  eq(arrivalOf([], { row: 1, col: 1 }, router), {}, 'no walk leg, no arrival claim');
}

// ---- bakeOne: a refusal carries its bound ---------------------------------------------------
{
  const router = {
    plan: () => ({ ok: false, why: 'no route to 20,17 within 4 jump(s)',
                   trace: [{ jumps: 0, points: 900, squares: 366 }] }),
    footing: () => ({ h: 0 }),
  };
  const r = bakeOne(router, { row: 1, col: 1 }, { row: 20, col: 17 },
                    { maxJumps: 4, edge: open, bounds, floorAt: flat });
  ok(!r.ok, 'a refused plan is a refused bake');
  eq(r.bound, { max_jumps: 4, candidates: false }, 'the bound is recorded beside the refusal');
  eq(r.closure_squares, 366, '...and so is how far the search actually got');
  ok(/within 4 jump\(s\)/.test(r.why), 'the reason still names the bound in its own words');
  ok(!/unreachable|impossible/i.test(r.why), 'and never says "unreachable"');
}
{
  const router = {
    plan: () => ({ ok: true, jumps: 0, all_declared: true, confidence: 'walk only — no jump involved',
                   legs: [{ kind: 'walk', waypoints: [{ x: 0, y: 0 }, { x: 512, y: 0 }],
                            biggest_drop: 0 }] }),
    footing: () => ({ h: 1000 }),
  };
  const r = bakeOne(router, { row: 1, col: 1 }, { row: 1, col: 1 },
                    { edge: open, bounds, floorAt: flat });
  ok(r.ok, 'a plan that walks bakes a rail');
  ok(r.waypoints > 2, 'the rail is DENSER than the plan it came from — that is the whole point');
  ok(r.aims >= 2, '...and carries an aim list a follower can drive');
  eq(r.unvalidated, 0, 'nothing unvalidated on open ground');
}

// ---- checkRoute: the guard that says a bake has gone stale ---------------------------------
{
  const route = { legs: [{ kind: 'walk', waypoints: [
    { x: 0, y: 0 }, { x: 64, y: 0 }, { x: 128, y: 0 },
  ] }] };
  ok(checkRoute(route, { edge: open }).ok, 'a rail the map still accepts passes');
  const v = checkRoute(route, { edge: (a) => a.x < 64 });
  ok(!v.ok, 'a rail the map now refuses fails');
  eq(v.bad[0].leg, 0, '...naming the leg');
  ok(v.bad[0].i >= 0, '...and the step inside it');
  eq(checkRoute({ legs: [{ kind: 'jump', from: {}, to: {} }] }, { edge: shut }).legs, 0,
     'a jump leg is not re-traced as a walk — it is a declaration, not a path');
}
{
  // A POINT NOBODY CLAIMED IS NOT DRIFT. An unvalidated span kept the planner's point rather
  // than proving it, so re-tracing the step into it refuses every time, on every map, for ever
  // — and a checker permanently red is a checker nobody reads. Measured on the real bake: both
  // Badlands inbound rails are INCOMPLETE and were the only two `check` refused.
  const withHole = { legs: [{ kind: 'walk', waypoints: [
    { x: 0, y: 0 }, { x: 64, y: 0 },
    { x: 2000, y: 0, u: true },                  // the span nothing could walk
    { x: 2064, y: 0 }, { x: 2128, y: 0 },
  ] }] };
  const v = checkRoute(withHole, { edge: (a, b) => Math.hypot(b.x - a.x, b.y - a.y) <= 91 });
  ok(v.ok, 'the step into an unvalidated point is skipped rather than counted as a refusal');
  eq(v.skipped, 1, '...and the skip is reported, so it cannot be silent');
  ok(v.legs >= 3, '...while every step either side of it is still re-traced');
  // AND THE INDEX STILL POINTS AT THE RIGHT STEP. Verifying each run separately restarts the
  // count at zero, so a refusal in the second run would be reported as if it were in the first.
  const drift = checkRoute(withHole, { edge: (a, b) => !(a.x === 2064) });
  ok(!drift.ok, 'real drift after the hole is still caught');
  eq(drift.bad[0].i, 3, '...and its index is the position in the WHOLE rail, not in the run');
}

// ---- findRoute: a missing rail is not a missing route ---------------------------------------
{
  const baked = { stones: [{ node: 'sentinel', routes: [
    { direction: 'to_node', ok: true, waypoints: 1249, exit: 'edge:599:r18c46', exit_label: 'east -> 599 r18c46' },
    { direction: 'to_node', ok: true, waypoints: 400, exit: 'edge:579:r43c1', exit_label: 'west -> 579 r43c1' },
    { direction: 'to_exit', ok: false, why: 'no route to 18,46 within 4 jump(s)' },
  ] }] };
  eq(findRoute(baked, { node: 'sentinel' }).waypoints, 400,
     'with no exit named, the shortest inbound rail wins');
  eq(findRoute(baked, { node: 'sentinel', exit: 'edge:599:r18c46' }).waypoints, 1249,
     'a named exit is taken literally');
  eq(findRoute(baked, { node: 'sentinel', exit: 'east -> 599 r18c46' }).waypoints, 1249,
     '...by label as well as by id');
  eq(findRoute(baked, { node: 'sentinel', direction: 'to_exit' }), null,
     'THE REVERSE OF A FALL IS NOT A RAIL, and the bake does not invent one');
  eq(findRoute(baked, { node: 'nosuch' }), null, 'an unknown stone answers null');
  eq(findRoute(null, { node: 'sentinel' }), null, '...and so does an unbaked file');
}

// ---- stonesToBake reads the census, and the census only -------------------------------------
{
  const all = stonesToBake();
  ok(all.length >= 13, 'every stone in m59-stones.mjs is baked, not a hand-written subset');
  ok(all.some(s => s.key === 'ukgoth'), '...including the ones nobody will attempt');
  eq(stonesToBake({ only: 'peak' }).map(s => s.key), ['peak'], '--node takes a key');
  eq(stonesToBake({ only: 'seafarer' }).map(s => s.key), ['peak'],
     '...and the documented alias, because nodes/<key>.md is found from both sides');
  eq(stonesToBake({ only: 'cave,ice' }).map(s => s.key), ['cave', 'ice'], '...and a list');
  eq(stonesToBake({ only: 'nosuch' }), [], 'an unknown name bakes nothing rather than everything');
  ok(stonesToBake({ includeConditional: false }).length < all.length,
     'the conditional stones can be left out');
}

// ---- fineEdge: a slide that arrives somewhere else is not this edge --------------------------
{
  const level = () => 1000;
  const geo = { traceFineMoveClient: (ax, ay, bx, by) => ({ moved: true, x: bx, y: by }) };
  ok(fineEdge(geo, { floorAt: level })({ x: 0, y: 0 }, { x: 64, y: 0 }),
     'a step that lands on the aim is an edge');
  const slid = { traceFineMoveClient: () => ({ moved: true, x: 0, y: 0 }) };
  ok(!fineEdge(slid, { floorAt: level })({ x: 0, y: 0 }, { x: 64, y: 0 }),
     'a step that "moved" and ended back at the start is NOT an edge');
  const scraped = { traceFineMoveClient: () => ({ moved: true, x: 20, y: 0 }) };
  ok(fineEdge(scraped, { floorAt: level })({ x: 0, y: 0 }, { x: 64, y: 0 }),
     'a small slide is kept — sliding is how you hug a wall, not cheating');
  const stuck = { traceFineMoveClient: () => ({ moved: false }) };
  ok(!fineEdge(stuck, { floorAt: level })({ x: 0, y: 0 }, { x: 64, y: 0 }),
     'a refused trace is no edge');
  const thrown = { traceFineMoveClient: () => { throw new Error('no geometry'); } };
  ok(!fineEdge(thrown, { floorAt: level })({ x: 0, y: 0 }, { x: 64, y: 0 }),
     'a geometry that throws refuses rather than crashing the bake');

  // THE ONE THAT SHIPPED A FALSE FINDING. Room 45, aim (16714,7490): the trace reports
  // `moved: true` and lands 20 units from the aim — well inside every distance test — having
  // slid along a wall and stayed on the floor 2,944 units BELOW it. Accepting that records a
  // 64-unit step that climbs onto a mesa, and the bake reported a rail to the Badlands stone
  // that every other measurement of that room says does not exist.
  const cliff = { traceFineMoveClient: () => ({ moved: true, x: 16700, y: 7505,
                                                arrived: false, slid: true, blocked: true,
                                                destinationFloor: 1152 }) };
  const shelves = (x, y) => (x === 16714 && y === 7490 ? 4096 : 1152);
  ok(!fineEdge(cliff, { floorAt: shelves })({ x: 16742, y: 7547 }, { x: 16714, y: 7490 }),
     'a slide that lands NEAR the aim and 2,944 units below it is not an edge');
  const sameShelf = { traceFineMoveClient: () => ({ moved: true, x: 16700, y: 7505,
                                                    slid: true, destinationFloor: 4096 }) };
  ok(fineEdge(sameShelf, { floorAt: shelves })({ x: 16742, y: 7547 }, { x: 16714, y: 7490 }),
     '...while the same slide landing on the shelf the aim is on still is one');
  // `destinationFloor` is the trace's own answer and beats re-reading the geometry, because
  // re-reading resolves a point the trace has already resolved and the two can disagree at a
  // ledge edge — which is the whole failure this guard exists for.
  const noFloorField = { traceFineMoveClient: () => ({ moved: true, x: 16700, y: 7505 }) };
  ok(!fineEdge(noFloorField, { floorAt: shelves })({ x: 16742, y: 7547 }, { x: 16714, y: 7490 }),
     'with no destinationFloor the landing point is read instead, and still refuses');
  const unreadable = { traceFineMoveClient: () => ({ moved: true, x: 64, y: 0 }) };
  ok(!fineEdge(unreadable, { floorAt: () => null })({ x: 0, y: 0 }, { x: 64, y: 0 }),
     'an unreadable floor refuses rather than passing a guard that did not run');
}

// ---- the version is a fact about the LOGIC, not the map --------------------------------------
{
  ok(Number.isInteger(NODERAIL_VERSION) && NODERAIL_VERSION >= 1,
     'the bake carries a version of its own meaning, so a fixed bake cannot read as fresh');
}


// ---- A PARTIAL BAKE MUST NOT DELETE THE OTHER STONES ----------------------------------------
{
  // `bake --node fey` rebakes one stone and writes the WHOLE file. Before the carry-forward it
  // left a table holding fey and nothing else, and every other stone's rails vanished. That was
  // survivable while the artefact was committed — the diff was enormous — and went silent the
  // moment it became gitignored, which is the trade that decision makes.
  const prior = { version: 1, max_jumps: 4, candidates: false, cut: 'then',
                  stones: [{ node: 'fey', routes: [1] }, { node: 'ancient', routes: [2] },
                           { node: 'victoria', routes: [3] }] };
  const fresh = { version: 1, max_jumps: 4, candidates: false, cut: 'now',
                  stones: [{ node: 'fey', routes: ['new'] }] };
  const carry = (baked, old) => {
    const same = old.version === baked.version && old.max_jumps === baked.max_jumps
              && old.candidates === baked.candidates;
    const have = new Set(baked.stones.map(s => s.node));
    return same ? (old.stones ?? []).filter(s => !have.has(s.node)) : [];
  };
  const kept = carry(fresh, prior);
  eq(kept.map(s => s.node), ['ancient', 'victoria'], 'the stones not rebaked are carried forward');
  ok(!kept.some(s => s.node === 'fey'), '...and the rebaked one is NOT duplicated');

  // A MIXED TABLE IS WORSE THAN A SHORT ONE. A stone kept from a run under different settings
  // is not the same claim as the ones beside it.
  eq(carry(fresh, { ...prior, max_jumps: 6 }), [], 'a different max_jumps carries nothing forward');
  eq(carry(fresh, { ...prior, candidates: true }), [], '...nor a different candidate policy');
  eq(carry(fresh, { ...prior, version: 0 }), [], '...nor an older NODERAIL_VERSION');
}

console.log(`\nm59-noderails: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
