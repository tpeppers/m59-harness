// THE GUARD FOR m59-ground.mjs — offline, no map, no keeper, no socket.
//
//   node tools/m59-ground-test.mjs
//
// The geometry is INJECTED as a fake with the three methods the real one exposes
// (leafAtClient, floorBaseAtClient, traceFineMoveClient), so every case below describes a world
// whose shape is known exactly. That matters more here than in most suites: this tool's whole job
// is to say what it cannot see, and a test against the real bake could not tell a correct caveat
// from a lucky one.
//
// A peer caught this module shipping without a test at all, which it should not have.
import { headingsFrom, floorsInSquare, reachability, floorAt, edgeOf, traceReport, floodReport, HEADINGS, REACHES }
  from './m59-ground.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);

/** A fake room: `floors(x,y)` decides the floor, `passable(a,b)` decides an edge. */
const fakeGeo = ({ floors = () => 1024, passable = () => true, rows = 30, cols = 30 } = {}) => ({
  rows, cols,
  leafAtClient: (x, y) => (floors(x, y) == null ? null : { sector: {} }),
  floorBaseAtClient: (x, y) => floors(x, y),
  traceFineMoveClient: (ax, ay, bx, by) => ({ arrived: passable({ x: ax, y: ay }, { x: bx, y: by }), x: bx, y: by }),
});

// ---- the shape of the constants -----------------------------------------------------------
eq(HEADINGS.map((h) => h[0]), ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
   'all eight headings, clockwise from north');
eq(REACHES, [64, 256, 512], 'three reaches: one lattice step, four, eight');

// ---- floorAt: null is "no floor", not zero ------------------------------------------------
{
  const g = fakeGeo({ floors: (x) => (x < 1000 ? 6144 : null) });
  eq(floorAt(g, 500, 0), 6144, 'a floor is returned');
  eq(floorAt(g, 2000, 0), null, 'and absence is null, never 0 — 0 is a legal floor height');
}
{
  const thrower = { leafAtClient: () => { throw new Error('bad leaf'); } };
  eq(floorAt(thrower, 0, 0), null, 'geometry that throws answers null rather than killing the caller');
}

// ---- edgeOf: the mover's own trace, and its failure modes --------------------------------
{
  const g = fakeGeo({ passable: (a, b) => b.y >= a.y });     // may not go north
  const edge = edgeOf(g);
  ok(edge({ x: 0, y: 0 }, { x: 0, y: 64 }), 'south is accepted');
  ok(!edge({ x: 0, y: 64 }, { x: 0, y: 0 }), 'north is refused');
  eq(edgeOf({ traceFineMoveClient: () => { throw new Error('nope'); } })({ x: 0, y: 0 }, { x: 1, y: 1 }),
     false, 'a trace that throws is a refusal, not an exception');
  eq(edgeOf({ traceFineMoveClient: () => null })({ x: 0, y: 0 }, { x: 1, y: 1 }), false,
     'and a trace that answers nothing is a refusal');
}

// ---- headingsFrom: THE CASE THIS TOOL WAS BUILT FOR --------------------------------------
{
  // Measured room 45, rail leg 233: a slid landing below the requested shelf.
  const trace = { moved: true, arrived: false, reason: 'geometry_blocked', wall: 700,
    x: 15931.67, y: 18231.33, destinationFloor: 1664 };
  const g = fakeGeo({ floors: x => x === 16032 ? 2432 : 1664 });
  g.traceFineMoveClient = () => trace;
  const a = { x: 15776, y: 18336 }, b = { x: 16032, y: 18272 };
  ok(!edgeOf(g)(a,b), 'partial movement cannot create a lattice edge');
  const r = traceReport(g,a,b);
  eq(r.arrived,false,'diagnostic refuses the same slide');
  eq(r.steps.length,1,'stop at first refusal, never seed the next leg at the fictional aim');
  eq(r.steps[0].landed.floor_client,1664,'report actual landing floor');
  eq(r.to.floor_client,2432,'report requested shelf separately');
  eq(r.predicate,'geometry_blocked','retain the named refusing predicate');
  g.traceFineMoveClient = () => ({ ok: true, moved: true, arrived: false });
  ok(!edgeOf(g)(a,b),'a generic ok cannot override explicit nonarrival');
}
{
  // Marco at r23c17: every heading accepted except due SOUTH, at every reach. That asymmetry is
  // the entire difference between "wedged" and "blocked in the one direction I wanted", and it
  // took a hand-rolled node -e block to see before this existed.
  const g = fakeGeo({ passable: (a, b) => !(b.x === a.x && b.y > a.y) });
  const rows = headingsFrom(g, { x: 16784, y: 23296 });
  eq(rows.length, 3, 'one row per reach');
  for (const r of rows) {
    eq(r.refused, ['S'], `at reach ${r.reach}, only S is refused`);
    eq(r.accepted.length, 7, `and 7 of 8 accepted at reach ${r.reach}`);
  }
}
{
  // Sealed in every direction is a DIFFERENT finding and must read differently.
  const g = fakeGeo({ passable: () => false });
  const rows = headingsFrom(g, { x: 0, y: 0 });
  ok(rows.every((r) => r.accepted.length === 0), 'a sealed point accepts nothing');
  ok(rows.every((r) => r.refused.length === 8), 'and refuses all eight');
}
{
  // A heading open close in and shut further out — the reaches exist to catch exactly this.
  const g = fakeGeo({ passable: (a, b) => Math.hypot(b.x - a.x, b.y - a.y) <= 100 });
  const rows = headingsFrom(g, { x: 0, y: 0 });
  ok(rows[0].accepted.length === 8, 'everything is open at 64 units');
  ok(rows[2].accepted.length === 0, 'and nothing at 512 — one reach would have missed that');
}

// ---- floorsInSquare: a square is a summary, and often a false one -----------------------
{
  // The real case: one square in Kardde's Canyon holding four floors.
  const g = fakeGeo({ floors: (x, y) => {
    const dx = x % 1024, dy = y % 1024;
    if (dy < 256) return 3840;
    if (dy < 512) return 6016;
    if (dx < 512) return 6144;
    return 6400;
  } });
  const fs = floorsInSquare(g, 25, 17);
  eq(fs.map((f) => f.floor), [3840, 6016, 6144, 6400], 'all four floors are reported, ascending');
  ok(fs.every((f) => f.samples > 0), 'each with a sample count, so a sliver is visibly a sliver');
  eq(fs.reduce((n, f) => n + f.samples, 0), 256, '16x16 samples at a 64-unit step');
}
{
  const g = fakeGeo({ floors: () => 6144 });
  eq(floorsInSquare(g, 23, 17), [{ floor: 6144, samples: 256 }],
     'a genuinely flat square reports exactly one floor');
}
{
  const g = fakeGeo({ floors: () => null });
  eq(floorsInSquare(g, 1, 1), [], 'a square with no floor anywhere reports none, not a zero');
}

// ---- reachability: THE VERDICT CARRIES ITS OWN LIMITS -----------------------------------
{
  const g = fakeGeo({ floors: () => 6144, rows: 30, cols: 30 });
  const r = reachability(g, { x: 64, y: 64 }, { x: 640, y: 64 });
  ok(r.reached, 'an open room reaches');
  ok(r.legs > 0, 'and reports how many legs');
  eq(r.lattice, 64, 'naming its lattice');
  ok(r.seed && r.target, 'and its snapped seed and target');
  ok(/only ever visits points of that phase/.test(r.caveat),
     'the caveat states the phase limitation IN the answer, not as a footnote');
  ok(/walkable/.test(r.caveat), 'and whether the body can board the lattice at all');
}
{
  // THE LATTICE-PHASE TRAP. An off-phase body is snapped, so this must still reach — the whole
  // point of snapping. Before it, a flood from 48-mod-64 reported "NOT reached after 165,104
  // points", which reads exactly like "the exit is unreachable" and is a false negative.
  const g = fakeGeo({ floors: () => 6144 });
  const r = reachability(g, { x: 17648, y: 23280 }, { x: 19456, y: 26624 });
  ok(r.reached, 'an off-phase body still reaches, because the seed is snapped');
  ok(r.bridge > 0, 'and the bridge from the body to the lattice is measured');
  ok(r.bridgeWalkable, 'and checked, not assumed');
}
{
  // Genuinely sealed: says NOT reached, says why, and says how much it looked at — and the CLI
  // adds the "re-ask from another seed" line, because "not reached" is never "unreachable".
  const g = fakeGeo({ floors: () => 6144, passable: (a, b) => a.y === b.y && a.y === 64 });
  const r = reachability(g, { x: 64, y: 64 }, { x: 64, y: 1024 });
  ok(!r.reached, 'a sealed target is not reached');
  ok(r.visited > 1, 'and it reports how many points it visited before concluding that');
  ok(typeof r.why === 'string' && r.why.length > 0, 'with a reason');
}
{
  // A body that cannot even step onto the lattice: the rail is unboardable and the caveat SAYS so,
  // which is a different failure from an unreachable goal.
  const g = fakeGeo({ floors: () => 6144,
                      passable: (a, b) => !(Math.hypot(b.x - a.x, b.y - a.y) < 64) });
  const r = reachability(g, { x: 17648, y: 23280 }, { x: 19456, y: 26624 });
  ok(!r.bridgeWalkable, 'an unboardable lattice is reported as such');
  ok(/NOT walkable/.test(r.caveat), 'and the caveat says the rail cannot be boarded');
}

{
  const g=fakeGeo({rows:4,cols:4});
  ok(floodReport(g,{x:64,y:64},{row:2,col:2},{lattice:256,box:0}).reached,'exact flood reaches an open box');
  eq(floodReport(g,{x:0,y:0},{row:4,col:4},{cap:3,box:0}).predicate,'search_cap','bounded search never reports exhaustion as terrain');
  g.traceFineMoveClient=()=>({moved:true,arrived:false,x:0,y:0});
  eq(floodReport(g,{x:0,y:0},{row:4,col:4},{box:0}).visited,1,'partial slides cannot grow fictional flood vertices');
}
console.log(`\nm59-ground: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
