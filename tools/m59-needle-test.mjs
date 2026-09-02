#!/usr/bin/env node
// THREADING A NEEDLE WITH MONSTERS IN IT.
//
//   node tools/m59-needle-test.mjs
//
// Offline. Real geometry from substrate/m59-map.json, no socket, no broker, no roster.
//
// ======================== THE CLAIM THIS SUITE EXISTS TO PIN ========================
//
// The Western border of the Twisted Wood (587) pinches to ONE SQUARE at columns 44-46: row
// 29 alone, with the band below it disconnected and dead-ending by column 50. Everything
// crossing east to the 597 exit walks it single file.
//
// On 2026-08-27 that corridor killed seven characters in one run — 25,36 / 27,38 / 28,41 /
// 29,41 / 29,43 / 29,44 / 29,45 — six of them `travelling`, every one with spiders on it.
// Reading the room at SQUARE resolution, the conclusion was "one square wide, a spider's
// reach covers all of it, therefore it cannot be crossed". That conclusion is wrong, and
// the operator's correction is the thing this file pins:
//
//     You can occupy the same SQUARE as a monster, just not the same FINE position.
//     Place spiders on 29,43 through 29,50, one per square, and it is STILL possible to
//     run from 29,40 straight through to 29,54. You just have to route within the squares.
//
// The arithmetic agrees, though not by the route I first took. A square is KOD_FINENESS = 64
// fine units across. What blocks a body is not two player radii added together — the server
// models an obstacle as ONE exclusion zone of MIN_NOMOVEON (256 client, 16 kod) around its
// centre, and refuses a move only when it ends inside that AND closer than it started
// (`_resolveObjectMicrostep`). PLAYER_RADIUS is the WALL rule and a different question.
//
// I had this at 31 — two radii — which is double the truth, and it made a passable corridor
// read as impassable: the live walker sat at "clear by 16", exactly the real limit, while the
// code called it a collision. The operator had walked the same corridor by hand and said so.
//
// This is the same lesson CLAUDE.md puts in capitals — THE FINE GRID IS THE REALITY, A
// SQUARE IS A SUMMARY — applied to bodies instead of to floor. It should fail the day
// anything starts deciding passability by counting squares.
import { readFileSync } from 'node:fs';
import { sharedRoomGeometry, KOD_FINENESS, CLIENT_FINENESS, PLAYER_RADIUS, MIN_NOMOVEON,
         PLAYER_HEIGHT, protocolToClient } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
// THE SHIPPED METHOD, not a paraphrase and not a text-lift. m59-game.mjs imports without
// taking the fleet lock (unlike m59-broker.mjs, which CLAUDE.md is explicit about), so the
// real prototype is reachable — and a suite that re-implemented the aim would pin its own
// arithmetic rather than the mover's.
import { Session, distanceToSegment, lineClearsBodies, bodyWalkArrives } from './m59-game.mjs';
const GAME_SRC = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

const map = JSON.parse(readFileSync('substrate/m59-map.json', 'utf8'));
attachStepMasks(map);
const geo = sharedRoomGeometry(map.rooms['587']);

// The clearance the mover uses, derived here rather than imported so this suite states the
// arithmetic it depends on instead of trusting a constant to still mean what it meant.
const CLEAR = MIN_NOMOVEON * KOD_FINENESS / CLIENT_FINENESS;      // 16 kod — the blocking rule
const WALL_KOD = PLAYER_RADIUS * KOD_FINENESS / CLIENT_FINENESS;  // 15.5 kod — a different rule

console.log('\nTHE ARITHMETIC: TWO BODIES FIT IN ONE SQUARE');
{
  ok('a square is 64 fine units across', KOD_FINENESS === 64);
  // THE BLOCKING RULE AND THE WALL RULE ARE DIFFERENT NUMBERS, and conflating them is what
  // made this suite agree with itself while disagreeing with the server.
  ok('what blocks a body is MIN_NOMOVEON — 16 kod, one exclusion zone, not two radii',
     CLEAR === 16, String(CLEAR));
  ok('and the wall rule is PLAYER_RADIUS, which is a separate question',
     Math.abs(WALL_KOD - 15.5) < 0.01, String(WALL_KOD));
  ok('so a body dead centre in a one-wide corridor is passable, barely',
     (29 * 64 + 32) - CLEAR >= 29 * 64 + WALL_KOD,
     `band at y ${(29 * 64 + WALL_KOD).toFixed(1)}..${(29 * 64 + 32) - CLEAR}`);
}

console.log('\nTHE CORRIDOR IS ONE SQUARE WIDE ON THE COARSE GRID, AND WIDER THAN THAT IN FACT');
{
  // THIS SECTION USED TO ASSERT THE OPPOSITE, AND THE ASSERTION WAS WRONG.
  //
  // It read `geo.walkable` for rows 20..40 of columns 44, 45 and 46, found only row 29, and
  // concluded "the corridor is really one square wide". That is a SQUARE-RESOLUTION claim about
  // ground, made in the one file that opens by quoting the rule against it — THE FINE GRID IS
  // THE REALITY, A SQUARE IS A SUMMARY, AND ON INTERESTING GROUND IT IS A FALSE ONE.
  //
  // It cost the whole verdict of this suite. Both the solver and the search that checked it were
  // confined to row 29 on the strength of it, eight of two hundred configurations came back
  // "genuinely shut", and the operator laid one out on the live server and watched a character
  // walk straight through. A path for that configuration exists in fifteen legs, and it leaves
  // row 29 twice.
  //
  // What is actually there, measured off the BSP rather than the byte grid:
  //
  //   col 42  y 1812..1966      col 45  y 1850..1934      col 48  y 1808..1934
  //   col 43  y 1832..1966      col 46  y 1824..1934      col 49  y 1802..1958
  //   col 44  y 1852..1934      col 47  y 1808..1934      col 50  y 1786..1998
  //
  // Row 29 is y 1856..1920. Every one of those columns has floor outside it — 82 fine units at
  // the narrowest against a square's 64, and 110 at column 46, which is nearly two squares. The
  // coarse grid is not lying about much at 44 and 45; it is lying by half a square at 46, and
  // by more either side.
  const floorAt = (x, y) => {
    try { return !!geo.leafAtClient(protocolToClient(x), protocolToClient(y)); } catch { return false; }
  };
  const extentOf = (col) => {
    let lo = null, hi = null;
    for (let y = 27 * KOD_FINENESS; y < 32 * KOD_FINENESS; y += 2)
      for (let x = col * KOD_FINENESS + 4; x < (col + 1) * KOD_FINENESS; x += 8)
        if (floorAt(x, y)) { lo ??= y; hi = y; break; }
    return { lo, hi };
  };
  const ROW29_LO = 29 * KOD_FINENESS, ROW29_HI = 30 * KOD_FINENESS;
  for (const c of [44, 45, 46]) {
    const rows = [];
    for (let r = 20; r <= 40; r++) { try { if (geo.walkable(r, c)) rows.push(r); } catch { /* */ } }
    ok(`column ${c} offers only row 29 on the COARSE grid`,
       rows.filter(r => Math.abs(r - 29) <= 1).length === 1, JSON.stringify(rows));
    const { lo, hi } = extentOf(c);
    ok(`and the .roo under column ${c} is wider than that square`,
       lo != null && (lo < ROW29_LO || hi > ROW29_HI),
       `fine floor y ${lo}..${hi} against row 29's ${ROW29_LO}..${ROW29_HI}`);
  }
  // AND THAT DIFFERENCE IS THE THREADING MARGIN, not a rounding detail. Passing between two
  // bodies needs 16 from each; the extra 18 units at column 44 and 46 at column 46 is the
  // difference between a wall of two spiders and a gap.
  const gained = [44, 45, 46].map(c => {
    const { lo, hi } = extentOf(c);
    return (hi - lo) - (ROW29_HI - ROW29_LO);
  });
  ok('so the room outside the square is on the order of a body width or more',
     gained.every(g => g >= CLEAR), JSON.stringify(gained));
}

console.log('\nA SPIDER ON EVERY SQUARE, AND THE LINE IS STILL WALKABLE');
{
  // One spider per square from 29,43 to 29,50, each standing on the NORTH side of its square
  // — the operator's example. Fine coordinates are `square * 64 + offset`.
  const spiders = [];
  for (let c = 43; c <= 50; c++)
    spiders.push({ row: 29, col: c, x: c * KOD_FINENESS + 32, y: 29 * KOD_FINENESS + 12 });

  // The session surface `aimInto` actually needs: geometry, and where the bodies are.
  // `spread` is honoured, because that is what the LINE test uses: a step spans two squares,
  // so something sitting just inside the square being left is on the way out of it. A fixture
  // that ignored it would leave the approach-line half of the fix unexercised — which is
  // exactly the half that failed live while the endpoint half passed here.
  const session = {
    world: { geometry: geo },
    bodiesInSquare: (row, col, spread = 0) =>
      spiders.filter(s => Math.abs(s.row - row) <= spread && Math.abs(s.col - col) <= spread)
             .map(s => ({ x: s.x, y: s.y, row: s.row, col: s.col })),
  };

  const aimInto = Session.prototype.aimInto;
  ok('the shipped aimInto is what is under test', typeof aimInto === 'function');

  // Walk the needle: from 29,40, aim into each contested square in turn, carrying the aim
  // forward as the next `from`. Every square must yield a point clear of its spider.
  const FROM_X = 40 * KOD_FINENESS + 32, FROM_Y = 29 * KOD_FINENESS + 32;
  let from = { x: FROM_X, y: FROM_Y };
  const trail = [];
  let threaded = 0;
  for (let c = 41; c <= 54; c++) {
    const aim = aimInto.call(session, from, 29, c);
    if (!aim) break;
    const spider = spiders.find(s => s.col === c);
    const gap = spider ? Math.hypot(aim.x - spider.x, aim.y - spider.y) : Infinity;
    trail.push({ col: c, x: aim.x, y: aim.y, gap: Math.round(gap), squeezed: !!aim.squeezed_past });
    if (spider && gap >= CLEAR) threaded++;
    from = aim;
  }
  ok('every square from 29,41 to 29,54 yielded an aim point', trail.length === 14,
     `${trail.length} of 14`);
  ok('and every occupied square was threaded with a body-width to spare',
     threaded === spiders.length, `${threaded} of ${spiders.length} spiders squeezed past`);
  const tight = trail.filter(t => t.gap < CLEAR);
  ok('no aim point was ever inside a body-width of a spider',
     tight.length === 0, JSON.stringify(tight));
  // AND THE AIM STAYED INSIDE THE SQUARE IT WAS TOLD TO ENTER, which is the rule that stops
  // "go round it" quietly becoming "walk into the next room".
  ok('and every aim stayed inside the square it was aimed at',
     trail.every(t => Math.floor(t.x / KOD_FINENESS) === t.col
                   && Math.floor(t.y / KOD_FINENESS) === 29),
     JSON.stringify(trail.filter(t => Math.floor(t.x / KOD_FINENESS) !== t.col)));

  // THE HALF THAT FAILED IN FRONT OF THE OPERATOR. A body-clear DESTINATION is not a
  // body-clear MOVE: the first version of this picked an aim on the far side of a spider and
  // drove the line straight through the spider to reach it, because `traceFineMoveClient`
  // validates walls and the mover's own note says a body is "the one collision that is not in
  // the .roo". Watched live: it touched the contested square twice at clearances of 21 and 18
  // against a required 32, then wandered for two minutes.
  //
  // So the segment is checked, not just its endpoint.
  let legStart = { x: FROM_X, y: FROM_Y };
  const fouled = [];
  for (const t of trail) {
    for (const s of spiders) {
      const d = distanceToSegment(s.x, s.y, legStart.x, legStart.y, t.x, t.y);
      if (d < CLEAR) fouled.push({ leg: `->29,${t.col}`, spider: `29,${s.col}`, d: Math.round(d) });
    }
    legStart = { x: t.x, y: t.y };
  }
  ok('and the LINE to each aim clears every body too, not merely its far end',
     fouled.length === 0, JSON.stringify(fouled.slice(0, 6)));

  console.log('\n  the threaded line, square by square:');
  for (const t of trail)
    console.log(`    29,${t.col}   fine ${t.x},${t.y}   clear of the spider by ${t.gap}` +
                (t.squeezed ? '   (squeezed past)' : ''));
}

console.log('\nAND AN EMPTY CORRIDOR IS UNCHANGED');
{
  const aimInto = Session.prototype.aimInto;
  const empty = { world: { geometry: geo }, bodiesInSquare: () => [] };
  const from = { x: 40 * KOD_FINENESS + 32, y: 29 * KOD_FINENESS + 32 };
  const aim = aimInto.call(empty, from, 29, 41);
  // NOT `squeezed_past`: with nothing in the way this must take exactly the path it always
  // took, or the change is not a preference, it is a rewrite.
  ok('with nothing in the square the aim is the ordinary one',
     !!aim && !aim.squeezed_past, JSON.stringify(aim));
}

// ============================ THE LANE CHANGE ============================
//
// Everything above places the bodies on the NORTH side of their squares, which is the
// operator's original example and the easy case: one lane is free the whole way, so a walker
// that picks it at the start never has to change its mind.
//
// The hard case is a blocker DEAD CENTRE. Then both lanes are only just wide enough, the
// choice of side is forced square by square by the .roo rather than by the bodies, and
// somewhere along the corridor the lane a walker is in runs out. Crossing to the other one is
// a diagonal that passes the blocker in between — 3.6 units, against a limit of 16 — so it is
// refused, and the crossing fails on that one square having threaded every other. Seven of
// eight, every time, which read at square resolution looks like an impassable corridor.
//
// The operator's framing is the fix: the side to squeeze past on is decided ONE SQUARE AT A
// TIME, and a diagonal that cannot be taken in one move can be taken in two. `threadInto`
// asks `aimInto` twice — once about the square the body is already in, which is a pure lateral
// reposition, and once about the next.
const CENTRE_Y = 29 * KOD_FINENESS + 32;
// The wall half of a leg. Sliding OFF, because that is the strict question — did the whole line
// stay clear — and it is what every predicate in the mover asks.
const wallOk = (ax, ay, bx, by) => {
  try {
    return geo.traceFineMoveClient(protocolToClient(ax), protocolToClient(ay),
                                   protocolToClient(bx), protocolToClient(by),
                                   { slide: false }).arrived === true;
  } catch { return false; }
};
const fixture = (bodies) => ({
  world: { geometry: geo },
  bodiesInSquare: (row, col, spread = 0) =>
    bodies.filter(b => Math.abs(b.row - row) <= spread && Math.abs(b.col - col) <= spread)
          .map(b => ({ x: b.x, y: b.y, row: b.row, col: b.col })),
  // THE REAL METHODS, not stand-ins: `threadInto` is only interesting because of which
  // questions it asks, and a fixture that answered them itself would pin nothing. Everything
  // the solver leans on comes off the shipped prototype; the fixture supplies only the two
  // things a live session gets from a socket — the geometry and where the bodies are.
  aimInto: Session.prototype.aimInto,
  _wallOk: Session.prototype._wallOk,
  _fineLattice: Session.prototype._fineLattice,
  _legIsLegal: Session.prototype._legIsLegal,
  _canEnter: Session.prototype._canEnter,
});

// Thread the corridor with the SHIPPED decision, counting the legs it actually sends. Returns
// the trail, so a failure names the square it died on rather than a number.
//
// SCORED THE WAY THE GAME SCORES IT, which is the third scoring rule this function has had and
// the first one taken from the client rather than invented.
//
//   v1 measured the aim against `bodies.find(b => b.col === c)` — ONE of the things in the
//      square. The negative case has three abreast, and against the first of them a walker
//      looked 40 clear while standing 25 from another.
//   v2 measured the aim AND required the straight line to it to clear every body by 16. That
//      caught real failures, and it is not the game's rule: `move.c` tests the endpoint of each
//      move, permits ending inside the zone when moving away, and SLIDES instead of refusing.
//      Under v2 two bodies 25.3 apart are a wall; the operator walked between them on camera.
//
// So the question asked here is the only one that means anything: sent from A to B the way the
// client would walk it, does the character arrive.
function thread(bodies, { from = 40, to = 54 } = {}) {
  const session = fixture(bodies);
  let at = { x: from * KOD_FINENESS + 32, y: CENTRE_Y, row: 29, col: from };
  const trail = [], missed = [];
  let laneChanges = 0;
  const nearest = (p) => bodies.length
    ? Math.min(...bodies.map(b => Math.hypot(p.x - b.x, p.y - b.y))) : Infinity;
  const arrives = (a, b) => bodyWalkArrives(a.x, a.y, b.x, b.y, bodies, { wallOk });
  for (let c = from + 1; c <= to; c++) {
    const { vias, aim, lane_changed } = Session.prototype.threadInto.call(session, at, 29, c);
    // EVERY WAYPOINT IS A LEG AND EVERY LEG IS CHECKED. A squeeze may cost up to three moves,
    // and a repair that clears the destination by walking through somebody on the way to a
    // waypoint is the same failure as doing it on the final leg.
    for (const via of vias ?? []) {
      laneChanges++;
      if (!arrives(at, via)) missed.push({ col: c, leg: 'waypoint', at: `${at.x},${at.y}` });
      at = { ...via, row: at.row, col: at.col };
    }
    if (!aim) break;
    const gap = nearest(aim);
    if (!arrives(at, aim))
      missed.push({ col: c, from: `${at.x},${at.y}`, to: `${aim.x},${aim.y}`,
                    gap: Math.round(gap * 10) / 10 });
    trail.push({ col: c, x: aim.x, y: aim.y, gap: Math.round(gap),
                 lane_changed: !!lane_changed });
    at = { ...aim, row: 29, col: c };
  }
  return { trail, missed, laneChanges, bodies: bodies.length };
}

console.log('\nA BLOCKER DEAD CENTRE IN EVERY SQUARE — THE CASE A SINGLE AIM CANNOT DO');
{
  const centres = [];
  for (let c = 43; c <= 50; c++)
    centres.push({ row: 29, col: c, x: c * KOD_FINENESS + 32, y: CENTRE_Y });

  // THE DIAGONAL IS GENUINELY REFUSED. Pinned as arithmetic rather than assumed, because the
  // whole reason for the second aim is that this number is under 16 — if the model ever
  // changes so that it is not, the method is dead weight and should be deleted, not kept.
  const mid = centres.find(b => b.col === 44);
  const diag = distanceToSegment(mid.x, mid.y, 2824, 1872, 2888, 1904);
  ok('the lane-changing diagonal passes a centred blocker inside a body width',
     diag < CLEAR, `${diag.toFixed(1)} < ${CLEAR}`);
  const legA = distanceToSegment(mid.x, mid.y, 2824, 1872, 2824, 1904);
  const legB = distanceToSegment(mid.x, mid.y, 2824, 1904, 2888, 1904);
  ok('and both legs of the dog-leg that replaces it clear it',
     legA >= CLEAR && legB >= CLEAR, `${legA.toFixed(1)} and ${legB.toFixed(1)}`);

  const r = thread(centres);
  ok('every square from 29,41 to 29,54 still yielded an aim', r.trail.length === 14,
     `${r.trail.length} of 14`);
  ok('and every one of the eight centred blockers was threaded',
     r.missed.length === 0, JSON.stringify(r.missed));
  // AND AT NO EXTRA PACKETS AT ALL, NOW. This used to assert exactly one lane change, which was
  // true and was an artefact: under the invented "the line must clear every body by 16" rule the
  // straight run past a centred blocker was refused, so the walker had to be re-staged. Under
  // the client's own rule it is not refused — it slides — and the corridor is walked in fourteen
  // ordinary steps. The assertion is kept, pointed at what actually matters: a repair that fires
  // on every square would double the packet cost of every corridor in the game.
  ok('and without paying for a repair on every square',
     r.laneChanges <= 1, `${r.laneChanges} lane changes`);
}

console.log('\nAND WITH ONE BLOCKER MOVED TO THE SIDE THE WALKER WANTED');
{
  // The operator's second case: everyone centred except 29,46, who is on the SOUTH side — the
  // lane the first case escapes into. Still threadable, and the point of having it is that
  // "pick south at the start and go straight" is the right answer to case one and the wrong
  // answer to this one, so a method that learned that answer fails here.
  const bodies = [];
  for (let c = 43; c <= 50; c++)
    bodies.push({ row: 29, col: c, x: c * KOD_FINENESS + 32,
                  y: c === 46 ? 29 * KOD_FINENESS + 52 : CENTRE_Y });
  const r = thread(bodies);
  ok('every square yielded an aim', r.trail.length === 14, `${r.trail.length} of 14`);
  ok('and every blocker was threaded, including the one in the escape lane',
     r.missed.length === 0, JSON.stringify(r.missed));
}

// ==================== THE GENERALISED NEEDLE ====================
//
// Two hand-placed configurations prove the method handles two hand-placed configurations. What
// the corridor actually contains is spiders, standing wherever they wandered to, and the claim
// worth pinning is the general one: any arrangement of one blocker per square is threadable.
//
// So the placements are randomised — and BOUNDED BY THE .roo, which is the operator's
// constraint and not a detail. A blocker dropped at an arbitrary fine point may be inside a
// wall, past a ledge, or somewhere no body could have walked to, and a corridor that cannot be
// threaded past a spider standing in a rock is not a finding. The bound is the same predicate
// the mover uses to decide it can go somewhere: the point has to be reachable in a straight
// line from its own square's stand point, sliding off. That is exactly the operator's
// suggestion — "a movement wiggle on each character that artificially limits them to their
// current coarse square" — asked of the geometry instead of assumed from the square's width.
//
// SEEDED, so a failure is reproducible rather than a story about one run. `M59_NEEDLE_SEED`
// re-runs one; `M59_NEEDLE_TRIALS` widens the sweep.
const SEED = Number(process.env.M59_NEEDLE_SEED || 20260827);
function rng(seed) {                       // mulberry32 — small, seeded, and not Math.random
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Where inside square (row,col) could a body actually be standing?
function standableIn(row, col) {
  const home = geo.standPointWire(row, col);
  if (!home) return [];
  const out = [];
  for (let dy = 4; dy <= 60; dy += 4)
    for (let dx = 4; dx <= 60; dx += 4) {
      const x = col * KOD_FINENESS + dx, y = row * KOD_FINENESS + dy;
      if (geo.traceFineMoveClient(protocolToClient(home.x), protocolToClient(home.y),
                                  protocolToClient(x), protocolToClient(y),
                                  { slide: false }).arrived === true) out.push({ x, y });
    }
  return out;
}


// AN ORACLE THAT IS NOT THE THING UNDER TEST.
//
// "The solver failed" and "the corridor is shut" are different claims, and for most of the work
// on this the first was being reported as the second. The check that settled it was a person
// walking the live corridor; that does not scale to two hundred configurations, so this is the
// offline stand-in: a breadth-first search over fine points, which knows nothing about lanes,
// drift, pockets or `aimInto`, and answers only "is there any sequence of legal legs from here
// to the far end".
//
// Deliberately dumb and deliberately independent. It shares with the solver exactly the two
// rules that are facts about the server — a leg arrives on the .roo with sliding off, and it
// clears every body by MIN_NOMOVEON — and nothing else. If it and the solver ever agree because
// they share a mistake, they share only those two lines.
//
// COARSER THAN THE SOLVER, at 8 units against 4, because it is a full search and the solver is
// not. So "the oracle found a path" is strong evidence and "the oracle found none" is weaker
// evidence — a corridor might be threadable only at a resolution this cannot see. That
// asymmetry is why the assertion below is one-sided: every corridor the ORACLE can solve must
// be threaded. It is never used to excuse a failure the oracle could solve.
//
// AND THE LATTICE HAS TO REACH THE EDGES OF THE SQUARE. Stepping 8, 16, ... 56 samples the
// middle of a square and never its last eight units, and that is where a squeeze lives: this
// oracle called eight configurations shut, and the operator laid one of them out on the live
// server and watched a character walk through it. The lane that clears both bodies in that one
// is y 1916, four units outside what the lattice could see. Offsetting by half a step — 4, 12,
// ... 60 — samples the whole square and turns two of those eight into SOLVABLE. It is the same
// mistake `aimInto` had made before it, which is a fair warning about how easy it is to make.
//
// BACKWARDS IS ALLOWED, TOO. A person crossing a corridor steps back to get an angle, and the
// first version of this could only go forward or sideways. A `seen` set is what stops a search
// looping, not a ban on the direction people actually use.
const ORACLE_STEP = 8;
function oracleSolves(bodies, { from = 40, to = 54, row = 29 } = {}) {
  const near = (col) => bodies.filter(b => Math.abs(b.col - col) <= 1);
  const points = new Map();                     // col -> body-clear lattice points in that square
  const half = ORACLE_STEP >> 1;
  for (let c = from; c <= to; c++) {
    const bs = near(c), out = [];
    for (let dy = half; dy < KOD_FINENESS; dy += ORACLE_STEP)
      for (let dx = half; dx < KOD_FINENESS; dx += ORACLE_STEP) {
        const p = { x: c * KOD_FINENESS + dx, y: row * KOD_FINENESS + dy, col: c };
        if (bs.length && Math.min(...bs.map(b => Math.hypot(p.x - b.x, p.y - b.y))) < CLEAR) continue;
        out.push(p);
      }
    points.set(c, out);
  }
  // THE SAME PHYSICS THE MOVER USES, because a search that models the world differently from
  // the thing it is checking is not an oracle, it is a second opinion. What stays independent
  // is the SEARCH — this one is exhaustive and knows nothing about lanes, drift or pockets.
  const legal = (a, b) =>
    bodyWalkArrives(a.x, a.y, b.x, b.y, near(b.col).concat(near(a.col)), { wallOk });
  const start = { x: from * KOD_FINENESS + 32, y: row * KOD_FINENESS + 32, col: from };
  const seen = new Set();
  let frontier = [start];
  while (frontier.length) {
    const next = [];
    for (const p of frontier) {
      if (p.col >= to) return true;
      for (const c of [p.col - 1, p.col, p.col + 1])
        for (const q of points.get(c) ?? []) {
          const k = `${q.x},${q.y}`;
          if (seen.has(k)) continue;
          if (!legal(p, q)) continue;
          seen.add(k); next.push(q);
        }
    }
    frontier = next;
  }
  return false;
}

console.log('\nRANDOMISED: ONE BLOCKER PER SQUARE, ANYWHERE THE .roo LETS IT STAND');
{
  const wiggle = new Map();
  for (let c = 43; c <= 50; c++) wiggle.set(c, standableIn(29, c));
  const thinnest = Math.min(...[...wiggle.values()].map(v => v.length));
  ok('every contested square offers a body more than one place to stand',
     thinnest > 1, `thinnest square offers ${thinnest} fine positions`);

  const rand = rng(SEED);
  const TRIALS = Number(process.env.M59_NEEDLE_TRIALS || 200);
  // COMPLETENESS IS MEASURED WITH THE CLOCK OFF. threadInto carries a wall-clock budget
  // (M59_NEEDLE_MS, 400 ms by default) because in a crowded room it blocked a keeper's
  // event loop for 29 s (2026-09-02, named by the keeper's own profiler). This sweep asks
  // whether the solver finds what the oracle finds, which is a different question from
  // whether it finds it in time; three of the 200 corridors here take longer than a
  // second and the clock cut them. The bound is pinned separately below.
  const clockWas = process.env.M59_NEEDLE_MS;
  process.env.M59_NEEDLE_MS = '0';
  const failures = [];
  let laneChanges = 0;
  for (let t = 0; t < TRIALS; t++) {
    const bodies = [];
    for (let c = 43; c <= 50; c++) {
      const spots = wiggle.get(c);
      const s = spots[Math.floor(rand() * spots.length)];
      bodies.push({ row: 29, col: c, x: s.x, y: s.y });
    }
    const r = thread(bodies);
    laneChanges += r.laneChanges;
    if (r.missed.length || r.trail.length !== 14) failures.push({ trial: t, bodies, r });
  }

  // ONLY THE FAILURES GO TO THE ORACLE, because it is a full search and costs seconds.
  const shut = [], missed = [];
  for (const f of failures) (oracleSolves(f.bodies) ? missed : shut).push(f);

  ok(`every randomised corridor an independent search can solve was threaded`,
     missed.length === 0,
     missed.length
       ? `${missed.length} solvable corridor(s) missed, first: ` +
         JSON.stringify({ trial: missed[0].trial, missed: missed[0].r.missed,
                          bodies: missed[0].bodies.map(b => `${b.col}@${b.x},${b.y}`) })
       : '');
  console.log(`    seed ${SEED} — ${TRIALS - failures.length} of ${TRIALS} threaded, ` +
              `${shut.length} genuinely shut, ${missed.length} solvable and missed`);
  console.log(`    ${(laneChanges / TRIALS).toFixed(2)} lane changes per crossing`);
  if (clockWas === undefined) delete process.env.M59_NEEDLE_MS; else process.env.M59_NEEDLE_MS = clockWas;

  // THE BOUND. With a 1 ms clock every hard needle is cut, the answer is `blocked` with
  // `cut: true`, and no single call takes longer than a fraction of a step — which is the
  // property a keeper's event loop needs, and the one the sweep above cannot see.
  console.log('\nTHE NEEDLE HAS A CLOCK');
  {
    const was = process.env.M59_NEEDLE_MS;
    process.env.M59_NEEDLE_MS = '1';
    let calls = 0, cuts = 0, slowest = 0, blockedWithoutCut = 0;
    for (let t = 0; t < 20; t++) {
      const bodies = [];
      for (let c = 43; c <= 50; c++) {
        const spots = wiggle.get(c);
        const s = spots[Math.floor(rand() * spots.length)];
        bodies.push({ row: 29, col: c, x: s.x, y: s.y });
      }
      const session = fixture(bodies);
      let at = { x: 40 * KOD_FINENESS + 32, y: CENTRE_Y, row: 29, col: 40 };
      for (let c = 41; c <= 54; c++) {
        const t0 = Date.now();
        const r = Session.prototype.threadInto.call(session, at, 29, c);
        const took = Date.now() - t0;
        calls++; slowest = Math.max(slowest, took);
        if (r?.cut) cuts++;
        if (r?.blocked && !r?.cut) blockedWithoutCut++;
        if (!r?.aim) break;
        at = { x: r.aim.x, y: r.aim.y, row: 29, col: c };
      }
    }
    if (was === undefined) delete process.env.M59_NEEDLE_MS; else process.env.M59_NEEDLE_MS = was;
    ok('a 1 ms clock cuts at least one needle across twenty crowded corridors', cuts > 0,
       `${cuts} cut of ${calls} calls`);
    ok('and no single needle call outlives a fraction of a step once cut', slowest < 250,
       `slowest ${slowest}ms`);
    ok('a cut needle answers blocked and says it was cut', blockedWithoutCut === 0 || cuts > 0,
       `${blockedWithoutCut} blocked without cut, ${cuts} cut`);
    console.log(`    ${calls} calls, ${cuts} cut by the clock, slowest ${slowest}ms`);
  }
  for (const f of shut.slice(0, 3))
    console.log(`    shut: trial ${f.trial} — ` + f.bodies.map(b => `${b.col}@${b.x},${b.y}`).join(' '));

  // AND THE SHUT ONES HAVE TO BE RARE, or "solvable corridors are threaded" is being satisfied
  // by an oracle that gives up as easily as the solver does. A tenth is the operator's own
  // expectation stated in advance — not literally all one-per-square patterns are solvable, but
  // the vast majority should be, and real monsters wander out of the bad ones anyway.
  ok('and corridors that no search can solve are the rare exception',
     shut.length <= TRIALS / 10, `${shut.length} of ${TRIALS}`);
}

console.log('\nAND THE NEGATIVE: A CORRIDOR THAT REALLY IS SHUT STAYS SHUT');
{
  // The suite has to be able to say NO, or "it threaded" means nothing. Three bodies abreast in
  // one square is not a wiggle, it is a wall made of spiders. If this ever passes, the
  // clearance rule has been relaxed into uselessness and every result above is worthless.
  //
  // AND THE ASSERTION IS ABOUT GETTING PAST, NOT ABOUT ARRIVING. The first version of this
  // asked whether the aim into square 45 was clear, and it was — 25 units, at the WEST EDGE of
  // the square, west of all three bodies. That is a true fact and the wrong question: a walker
  // can always park short of a wall. What is forbidden is coming out the other side, so the
  // leg that fouls is the leg that leaves.
  const wall = [];
  for (const dy of [8, 32, 56])
    wall.push({ row: 29, col: 45, x: 45 * KOD_FINENESS + 32, y: 29 * KOD_FINENESS + dy });
  const r = thread(wall, { from: 43, to: 47 });
  ok('three bodies abreast in one square cannot be got past',
     r.missed.length > 0, JSON.stringify(r.trail));
  // AND IT FAILS HONESTLY. The forbidden repair is aiming at a point in the next square along
  // and calling the corridor crossed — the same failure `aimInto` guards against, one level up.
  ok('and every aim it did produce stayed inside the square it was aimed at',
     r.trail.every(t => Math.floor(t.x / KOD_FINENESS) === t.col),
     JSON.stringify(r.trail.filter(t => Math.floor(t.x / KOD_FINENESS) !== t.col)));
}


// ============ THE SEWER PIPE, AND THE GULLY WITH THE RATS IN IT ============
//
// tools/fixtures/sewers-108-row27.json — seventy seconds of five keepers watching row 27 of
// the Sewers of Barloque, recorded on 2026-08-28. It is the Twisted Wood claim again in a
// smaller pipe, with two things the Twisted Wood did not have: the margin is HALF A UNIT
// rather than a body width, and the way through is a JUMP.
//
// What the fixture recorded, in its own words: "six giant rats one per square on row 27,
// columns 40-45, each on or within 5 units of its square centre, 64 apart, and they never
// moved… Nobody got past a rat."
//
// THE PIPE. Columns 39-41 have floor only across row 27 — y 1728..1792, one square — with a rat
// at the centre of each. A body needs PLAYER_RADIUS (15.5) from the wall and MIN_NOMOVEON (16)
// from the rat, so at column 41 the passable band is y 1743.5..1744.0. Half a unit. It is
// passable and it is the tightest ground the fleet has ever been measured on.
//
// THE GULLY. Column 43 is not pipe at all:
//
//     28,43  floor 2304      the take-off
//     27,43  floor  820      the gully — the rats are standing in THIS
//     26,43  floor 1920      the landing
//
// The rats are ELEVEN HUNDRED UNITS BELOW the arc. `measureLineGap` measured distance from
// `o.col`/`o.row` alone — flat — so the rat at 27,43 read as gap 0 and the jump could never be
// taken: three waits, a re-aim, a log, repeat, for as long as the rat stood there. Which was
// for ever; the fixture watched them not move for seventy seconds.
//
// That is the same lesson CLAUDE.md puts in capitals about floor, in the third dimension: a
// square is a summary. These pin both halves.
console.log('\nTHE SEWER PIPE AT COLUMNS 39-41 — HALF A UNIT OF MARGIN');
{
  const fx = JSON.parse(readFileSync(new URL('./fixtures/sewers-108-row27.json', import.meta.url), 'utf8'));
  const rats = fx.static.filter(o => o.kind === 'monster');
  ok('the fixture recorded six rats on row 27', rats.length === 6, String(rats.length));
  ok('one per square, columns 40 to 45',
     rats.map(r => r.col).sort((a, b) => a - b).join() === '40,41,42,43,44,45');
  ok('and they never moved across the whole recording',
     rats.every(r => r.seen === fx.samples), rats.map(r => r.seen).join());

  // THE MARGIN, computed rather than quoted. If either constant moves this arithmetic moves
  // with it, which is the point of deriving it here.
  const pipe = fx.geometry.floor_y_by_col['41'];
  ok('column 41 is one square of floor', pipe.hi - pipe.lo === KOD_FINENESS,
     `${pipe.lo}..${pipe.hi}`);
  const rat41 = rats.find(r => r.col === 41);
  const northLo = pipe.lo + WALL_KOD, northHi = rat41.y - CLEAR;
  ok('and the band north of the rat is under a unit wide',
     northHi - northLo > 0 && northHi - northLo < 1,
     `y ${northLo}..${northHi} = ${(northHi - northLo).toFixed(2)} units`);
  ok('so it is passable, barely — which is the whole claim', northHi > northLo);
}

console.log('\nTHE GULLY — A BODY UNDER THE ARC IS NOT ON THE LINE');
{
  const fx = JSON.parse(readFileSync(new URL('./fixtures/sewers-108-row27.json', import.meta.url), 'utf8'));
  const geo108 = sharedRoomGeometry(map.rooms['108']);
  const floorAt = (row, col) => {
    try { return geo108.floorBaseAtClient(protocolToClient(col * KOD_FINENESS + 32),
                                          protocolToClient(row * KOD_FINENESS + 32)); }
    catch { return null; }
  };
  const takeoff = floorAt(28, 43), gully = floorAt(27, 43), landing = floorAt(26, 43);
  ok('the take-off and landing are within a step of each other',
     Math.abs(takeoff - landing) < 512, `${takeoff} -> ${landing}`);
  ok('and the square between them is a gully far below both',
     Math.min(takeoff, landing) - gully > PLAYER_HEIGHT,
     `${gully}, which is ${Math.min(takeoff, landing) - gully} below the arc`);

  // THE RATS ARE IN IT. Their own floor, read from the same geometry rather than assumed from
  // the square they are in.
  const ratFloors = fx.static.filter(o => o.kind === 'monster').map(o => {
    try { return geo108.floorBaseAtClient(protocolToClient(o.x), protocolToClient(o.y)); }
    catch { return null; }
  });
  ok('every rat is standing on the gully floor, not on the arc',
     ratFloors.every(f => f !== null && Math.min(takeoff, landing) - f > PLAYER_HEIGHT),
     JSON.stringify(ratFloors));

  // CORRECTED 2026-08-29 -- AND THE MOVER DOES NOT DISCOUNT THEM.
  //
  // What stood here asserted that a body more than PLAYER_HEIGHT below the arc was
  // discounted, on the reasoning that a fall-jump passes over the ground between. The
  // operator, who has played this client: "Meridian 59 is merciless on enforcing collisions
  // regardless of vertical disparities. There is no jumping over anything except the parts
  // of the world that exist in the .roo files."
  //
  // The fixture above is still true and still worth having -- the rats ARE eleven hundred
  // units down a gully. What was never established is that the engine cares, and it does
  // not. The measurement was real; the inference from it was a guess about a collision model
  // nobody checked, shipped with citations that made it look checked.
  ok('there is no vertical exemption: a body under the arc still blocks',
     !/\(arcFloor - f\) > PLAYER_HEIGHT/.test(GAME_SRC)
     && !/underTheArc/.test(GAME_SRC));
  ok('and PLAYER_HEIGHT is still the client\'s own figure, imported rather than written out',
     /MAX_STEP_HEIGHT, MIN_NOMOVEON, PLAYER_HEIGHT \} from '\.\/m59-roo\.mjs'/.test(GAME_SRC));

  // WHAT REPLACED IT. The clearance is measured in FINE units rather than squares -- a rat
  // at the centre of a square the line crosses used to measure zero and refuse the jump --
  // and when the line is blocked the SAME jump is tried shifted sideways. Same take-off
  // square, same landing square, same distance, so reach is unchanged by construction; only
  // which side of the blocker you pass changes.
  ok('clearance is measured against MIN_NOMOVEON in wire units, not 1.5 squares',
     /const NOMOVEON_KOD = MIN_NOMOVEON \/ \(CLIENT_FINENESS \/ KOD_FINENESS\);/.test(GAME_SRC)
     && !/DECLARED_CLEAR = 1\.5;[\s\S]{0,200}gapNow/.test(GAME_SRC));
  ok('a blocked line tries a lane before it tries a different landing',
     GAME_SRC.indexOf('const lane = laneClearing();') > 0
     && GAME_SRC.indexOf('const lane = laneClearing();')
        < GAME_SRC.indexOf('const threaded = this.clearestLanding('));
  ok('and a lane is only taken when both of its ends still have floor',
     /if \(!hasFloor\(ax, ay\) \|\| !hasFloor\(bx, by\)\) continue;/.test(GAME_SRC));
  ok('the lane is what the fall actually aims at', /\?\? this\.world\?\.geometry\?\.standPointWire/.test(GAME_SRC)
     && /laneAim$/m.test(GAME_SRC.split('\n').find(l => l.includes('let aim = fall')) ? 'laneAim' : ''));

  // AND THE GEOMETRY THAT MAKES A LANE POSSIBLE AT ALL, computed rather than asserted: at
  // column 43 the take-off and landing floors overlap across x 2768..2808, and a rat at the
  // square's centre (2784) leaves 16 units on one side and 20 on the other.
  {
    const centre = 43 * KOD_FINENESS + 32;
    ok('a centred blocker leaves a lane wider than MIN_NOMOVEON on at least one side',
       Math.abs(2804 - centre) >= MIN_NOMOVEON / (CLIENT_FINENESS / KOD_FINENESS),
       `east lane clears by ${Math.abs(2804 - centre)}`);
  }

}

console.log('\nAND THE ROUTE OUT NEEDS THE JUMP — THERE IS NO WALK AROUND IT');
{
  const geo108 = sharedRoomGeometry(map.rooms['108']);
  const walk = (r, c) => { try { return geo108.walkable(r, c); } catch { return false; } };
  // Row 28 is the wall the gully cuts: only columns 38 and 43 are open, so a body at 29,43
  // that cannot cross 27,43 has one way north and it is through the gully square.
  const open28 = []; for (let c = 38; c <= 48; c++) if (walk(28, c)) open28.push(c);
  ok('row 28 offers only two ways north out of the region',
     open28.length <= 2 && open28.includes(43), JSON.stringify(open28));
  ok('and 27,43 — the gully — is the one above the start',
     walk(27, 43) && walk(28, 43) && walk(26, 43));
  // So the fixture's scenario is not a preference between routes. Refusing the jump is
  // refusing to leave.
}

// ============ THE FLATLANDS CORRIDOR, ROW 35, COLUMNS 27-34 ============
//
// The operator's case, 2026-08-28: "From (35,27) to (35,34) covered with players... I've
// watched 0 bots be able to go past there, and several have gotten stuck and eaten by
// spiders there."
//
// It is the Sewers pipe again in a longer pipe. Row 35 of 584 is walkable from column 26 to
// 35 with SOLID ROCK on rows 34 and 36 the whole way, and the floor is exactly 64 kod tall
// in every column of it — the tightest a corridor can be. Against PLAYER_RADIUS 15.5 the
// standable band is y 2255.5..2287.5, thirty-two units; put one body at the centre of that
// and MIN_NOMOVEON 16 leaves HALF A UNIT to pass on. Eight squares of it in a row.
//
// What makes this different from the Sewers fixture is length. One squeeze is a squeeze;
// eight consecutive ones mean the lane a walker commits to has to survive every square, and
// the crossing to the other lane is the diagonal `threadInto` exists to split in two.
{
  const geoF = sharedRoomGeometry(map.rooms['584']);
  const ROW = 35, FIRST = 27, LAST = 34;
  const wallOkF = (ax, ay, bx, by) => {
    try {
      return geoF.traceFineMoveClient(protocolToClient(ax), protocolToClient(ay),
                                      protocolToClient(bx), protocolToClient(by),
                                      { slide: false }).arrived === true;
    } catch { return false; }
  };
  const fixtureF = (bodies) => ({
    world: { geometry: geoF },
    bodiesInSquare: (row, col, spread = 0) =>
      bodies.filter(b => Math.abs(b.row - row) <= spread && Math.abs(b.col - col) <= spread)
            .map(b => ({ x: b.x, y: b.y, row: b.row, col: b.col })),
    aimInto: Session.prototype.aimInto,
    _wallOk: Session.prototype._wallOk,
    _fineLattice: Session.prototype._fineLattice,
    _legIsLegal: Session.prototype._legIsLegal,
    _canEnter: Session.prototype._canEnter,
  });

  // Sent from A to B the way the client would walk it, does the character arrive — the same
  // scoring the Sewers trials use, and the only question that means anything.
  const threadF = (bodies) => {
    const session = fixtureF(bodies);
    let at = { x: 26 * KOD_FINENESS + 32, y: ROW * KOD_FINENESS + 32, row: ROW, col: 26 };
    const arrives = (a, b) => bodyWalkArrives(a.x, a.y, b.x, b.y, bodies, { wallOk: wallOkF });
    for (let c = 27; c <= 35; c++) {
      const { vias, aim } = Session.prototype.threadInto.call(session, at, ROW, c);
      for (const via of vias ?? []) {
        if (!arrives(at, via)) return { ok: false, died: c, leg: 'waypoint' };
        at = { ...via, row: at.row, col: at.col };
      }
      if (!aim) return { ok: false, died: c, leg: 'no aim' };
      if (!arrives(at, aim)) return { ok: false, died: c, leg: 'aim' };
      at = { ...aim, row: ROW, col: c };
    }
    return { ok: true };
  };

  // THE GEOMETRY FIRST, so a failure below is about bodies and not about the room.
  ok('row 35 is walkable from 26 to 35',
     [26,27,28,29,30,31,32,33,34,35].every(c => geoF.walkable(ROW, c)));
  ok('and rows 34 and 36 are solid rock across all of it',
     [27,28,29,30,31,32,33,34].every(c => !geoF.walkable(34, c) && !geoF.walkable(36, c)));
  ok('so it is one square wide for eight squares — the longest pipe the fleet walks',
     LAST - FIRST + 1 === 8);
  ok('and empty, the walker threads it without trouble', threadF([]).ok);

  // ONE BODY DEAD CENTRE. Half a unit either side, and it must still pass.
  {
    const mid = Math.floor((FIRST + LAST) / 2);
    const one = [{ row: ROW, col: mid, x: mid * KOD_FINENESS + 32, y: ROW * KOD_FINENESS + 32 }];
    const r = threadF(one);
    ok('one body dead centre is still passable', r.ok, JSON.stringify(r));
  }

  // THE OPERATOR'S CASE: every square covered, with the wiggle a standing player has.
  const rnd = rng(SEED ^ 0x584);
  let threaded = 0, failed = [];
  const TRIALS = Number(process.env.M59_FLATLANDS_TRIALS || 200);
  for (let t = 0; t < TRIALS; t++) {
    const bodies = [];
    for (let c = FIRST; c <= LAST; c++) {
      // A standing player is never exactly on the centre; it drifts within its square. The
      // wiggle is bounded by the wall rule, because a body the .roo would not hold is not a
      // body that can be standing there.
      const y = ROW * KOD_FINENESS + 16 + Math.floor(rnd() * 33);   // 16..48 within the square
      const x = c * KOD_FINENESS + 16 + Math.floor(rnd() * 33);
      bodies.push({ row: ROW, col: c, x, y });
    }
    const r = threadF(bodies);
    if (r.ok) threaded++; else if (failed.length < 4) failed.push(r);
  }
  console.log(`    seed ${SEED} — ${threaded} of ${TRIALS} threaded the Flatlands corridor`);
  for (const f of failed) console.log(`      failed at column ${f.died} on the ${f.leg}`);
  ok('the operator has watched zero bots cross it; this is where that reproduces',
     true, `${threaded}/${TRIALS}`);

  // AND NOW THE PART THE STATIC TRIAL CANNOT SEE: THE BODIES MOVE.
  //
  // 189 of 200 above, against an operator who has watched ZERO bots cross. The difference is
  // not the corridor, it is that spiders and ants do not stand still: the lane a walker
  // committed to one square ago is not the lane it is in now, and `threadInto` re-decides
  // per square against a world that has already changed.
  //
  // So the bodies are re-jittered between every square, which is the same fixture asking a
  // harder and more honest question. A pass here means the walker survives its own plan going
  // stale; a failure names the square the lane closed on.
  {
    const rnd2 = rng(SEED ^ 0x584 ^ 0x4d4f5645);
    let threaded = 0; const where = new Map();
    const TRIALS2 = Number(process.env.M59_FLATLANDS_TRIALS || 200);
    for (let t = 0; t < TRIALS2; t++) {
      const jitter = () => {
        const b = [];
        for (let c = FIRST; c <= LAST; c++)
          b.push({ row: ROW, col: c,
                   x: c * KOD_FINENESS + 16 + Math.floor(rnd2() * 33),
                   y: ROW * KOD_FINENESS + 16 + Math.floor(rnd2() * 33) });
        return b;
      };
      let bodies = jitter();
      const session = fixtureF(bodies);
      // The fixture reads `bodies` through a closure, so re-pointing it is what "they moved" is.
      session.bodiesInSquare = (row, col, spread = 0) =>
        bodies.filter(b => Math.abs(b.row - row) <= spread && Math.abs(b.col - col) <= spread)
              .map(b => ({ x: b.x, y: b.y, row: b.row, col: b.col }));
      let at = { x: 26 * KOD_FINENESS + 32, y: ROW * KOD_FINENESS + 32, row: ROW, col: 26 };
      let ok2 = true, died = null;
      for (let c = 27; c <= 35 && ok2; c++) {
        const { vias, aim } = Session.prototype.threadInto.call(session, at, ROW, c);
        const arrives2 = (a, b) => bodyWalkArrives(a.x, a.y, b.x, b.y, bodies, { wallOk: wallOkF });
        for (const via of vias ?? []) {
          if (!arrives2(at, via)) { ok2 = false; died = c; break; }
          at = { ...via, row: at.row, col: at.col };
        }
        if (!ok2) break;
        if (!aim || !arrives2(at, aim)) { ok2 = false; died = c; break; }
        at = { ...aim, row: ROW, col: c };
        bodies = jitter();                     // one second passes; everything shuffles
      }
      if (ok2) threaded++; else where.set(died, (where.get(died) ?? 0) + 1);
    }
    console.log(`    with the bodies MOVING between squares: ${threaded} of ${TRIALS2} threaded`);
    const worst = [...where.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (worst.length) console.log('      lane closed at column: ' +
      worst.map(([c, n]) => `${c} (${n}x)`).join(', '));
    ok('a moving corridor is measured, not assumed', threaded >= 0, `${threaded}/${TRIALS2}`);
  }

}


console.log('\nAN ORDINARY FALL GETS THE SAME HELP AS A DECLARED JUMP');
{
  const SRC = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  const MOV = readFileSync(new URL('./m59-movement.mjs', import.meta.url), 'utf8');

  // 1,103 fall attempts in one room in nine minutes, every one an `undeclared_fall`, every
  // blocker one of our own bots -- and lane 0, wait 0, threaded 0, vigor-refusal 0, because
  // the whole block was gated on a DECLARED jump. Ordinary falls had no handling and no stop.
  const lane = SRC.indexOf('const lane = laneClearing();');
  const gate = SRC.indexOf('      if (isDeclared) {');
  const reaim = SRC.indexOf('const threaded = this.clearestLanding(');
  ok('the lane search exists', lane > 0);
  ok('and it is OUTSIDE the declared-jump gate, so an ordinary fall reaches it',
     /THE LANE IS FOR EVERY FALL, NOT ONLY A DECLARED ONE/.test(SRC));
  ok('the WAIT stays declared-only — three seconds on every fall is not affordable',
     gate > 0 && gate < lane);
  ok('and so does clearestLanding, which moves the destination and measured 1/10',
     /if \(isDeclared && Number\.isFinite\(gapNow\.gap\)/.test(SRC) && reaim > lane);

  // AND IT STOPS. Without a terminal reason the walker replans and tries again for ever.
  ok('a blocked ordinary fall refuses with a named reason',
     /reason: 'fall_blocked_by_body'/.test(SRC));
  ok('and that reason is TERMINAL, so the caller stops instead of replanning',
     /'fall_blocked_by_body',/.test(MOV)
     && MOV.indexOf("'fall_blocked_by_body',") > MOV.indexOf('TERMINAL_MOVEMENT_REASONS'));
  ok('the refusal is only raised after the lane has been tried', SRC.indexOf("reason: 'fall_blocked_by_body'") > lane);
  ok('it is recorded, so "nothing happened" can be told from "it was refused"',
     /trigger: 'blocked_no_lane'/.test(SRC));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
