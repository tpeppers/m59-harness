#!/usr/bin/env node
// A WALK FROM EVERY MANA STONE TO EVERY DOOR OF ITS ROOM, AND BACK, CUT AS A RAIL.
//
//   node tools/m59-noderails.mjs bake                  every stone, every exit, both ways
//   node tools/m59-noderails.mjs bake --node ancient   one stone
//   node tools/m59-noderails.mjs bake --candidates     let it invent jumps, and say so
//   node tools/m59-noderails.mjs show                  what is baked
//   node tools/m59-noderails.mjs show --node sentinel  one stone, route by route
//   node tools/m59-noderails.mjs check                 re-walk every baked rail against the map
//
// Offline. It opens no socket, reads no roster and moves nobody. `m59-fineclimb.mjs --rail`
// is the half that walks one.
//
// ---------------------------------------------------------------------------
// WHY THE EXISTING BAKE COULD NOT ANSWER THIS
//
// `m59-routebake.mjs` plans between EXIT ANCHORS on the square grid, because crossing a room
// is what a journey needs. A mana stone is neither an exit nor a square-grid destination:
// every one of them stands on ground where a square is a summary and on this ground it is a
// false one. `r40c33` in the Ancient Place spans 3520 to 10880 — the valley floor and the
// high ledge, one square, one number — so the square router asked to walk the spiral
// staircase plans straight through the valley, because that is what the square says is there.
//
// Declaring the stone as a WAYPOINT in `substrate/m59-waypoints.json` gets it into the square
// bake's anchor list, which is what room 27 already does. That buys a route only where the
// square grid is telling the truth. It cannot express a staircase whose treads are narrower
// than a square, and it cannot express a jump at all.
//
// So this is the other bake: same question, fine grid, full affordance set.
//
// ---------------------------------------------------------------------------
// THE AFFORDANCES, AND WHERE EACH ONE COMES FROM — nothing here is re-derived
//
//   walking      `fineRouter`'s closure flood, every edge validated with the mover's own
//                `traceFineMoveClient`. A plan the mover refuses is not a plan.
//   stairs       fall out of the above for free, and ONLY at this resolution. The Ancient
//                Place climbs 5152 -> 5504 -> 5856 -> 6208, +352 a tread against a 384 cap:
//                legal every one of them, and invisible to `moverStepLands`, which is a
//                square-to-square predicate and cannot see a tread narrower than a square.
//   drops        descent is UNBOUNDED in this game — only climbing is capped
//                (`clientd3d/move.c:55`) — so a walk leg may step off a ledge. Each leg
//                reports its `biggest_drop` and the rail reports every drop past the cap,
//                because a leg with one in it is ONE-WAY however symmetric it looks.
//   jumps        `substrate/m59-falljumps.json`, operator-declared and walked. Candidates
//                are off by default: the broker's `jump` verb refuses anything undeclared,
//                so the default output is exactly the set of rails executable today.
//
// AND A JUMP BUYS NO HEIGHT. `move.c:549-556` gates walking and falling with the SAME
// expression and a falling body has a LOWER z, so a jump is strictly worse at gaining height
// than a walk. A stone thousands of units up is a STAIRCASE question or a defect in our own
// flood, never a jump, at any `--max-jumps`. Nothing here will propose one.
//
// ---------------------------------------------------------------------------
// BOTH DIRECTIONS, BECAUSE THEY ARE TWO DIFFERENT QUESTIONS
//
// Never infer `b -> a` from `a -> b`. Two reasons, and both are measured:
//
//   A FALL IS ONE-WAY BY CONSTRUCTION. Room 589's stone is reached by the operator's
//   declared jump `r35c16 -> r38c19`; nothing declares the climb back, and this bake says so
//   out loud rather than assuming the reverse exists. First run: `sentinel` planned inbound
//   in 2.2s and answered `no route to 18,46 within 4 jump(s)` outbound.
//
//   ONE WALL IN FOURTEEN IS CLIMBABLE ONE WAY AND CAPPED THE OTHER. `move.c:530-539` picks
//   the sidedef FACING the body, so the below-texture short-circuit is a property of a SIDE.
//   Census of two-sided walls gated on one side only: 27->33/385, 45->36/885, 515->57/949,
//   589->13/204, 579->19/458, 750->9/336, and 39->68/86 — Castle Victoria's upstairs is
//   four-fifths one-way walls. A symmetric model calls that room connected when the return
//   leg does not exist.
//
// ---------------------------------------------------------------------------
// WHAT A RAIL IS HERE, AND WHY THE PLAN IS NOT ONE
//
// `fineRouter` emits a LINE: waypoints decimated on a heading change or every three quarters
// of a square, which is the right leash for a follower and is NOT a validated path. The chord
// between two decimated points was never checked the way the flood's own steps were, and
// `m59-railcut.mjs` says exactly why that matters: "Decimating on direction change replaces
// validated lattice steps with long straight lines that nothing checked the same way — two of
// twelve such legs refused when stepped."
//
// So every span of the planner's line is re-walked here at the 64-unit lattice:
//
//   the chord is stepped first (`chordWalkable`), because a walker sent to an aim point
//   travels in a STRAIGHT LINE and if that line is clear it is the rail;
//   otherwise the span is flooded at 64 and the flood's chain is the rail;
//   and a span that survives neither is KEPT, marked `unvalidated`, and counted — because
//   dropping it would quietly shorten the rail and dropping the rail would report a
//   reachable stone as unreachable.
//
// ONE TRACE OVER A LONG SPAN IS NOT AN ANSWER: from (17584,23296) in room 49 a 3300-unit
// chord traced ACCEPT as one call and 1 of 51 accepted when stepped in 64-unit pieces. Every
// check here steps.
//
// ---------------------------------------------------------------------------
// A REFUSAL QUOTES ITS BOUND
//
// "No route" from a bounded search is a statement about the bound. `m59-fineroute`'s answer
// is `no route to R,C within N jump(s)`, and this file keeps N, the largest closure it
// reached and the wall clock beside every refusal. A fine flood reaching 0 of N occupiable
// samples in the target is a statement about the ROOM; a search exhausting `--max-jumps` is
// not, and filing the second as the first is how "unreachable" gets written down about the
// world. `unreachable`, `impossible` and `needs new jumping mechanics` are inadmissible here
// — CLAUDE.md — and `node tools/m59-nodegap.mjs` is the tool that names the missing
// affordance instead.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fineRouter } from './m59-fineroute.mjs';
import { cutRail, chordWalkable, verifyRail, LATTICE, MIN_MOVER_STEP } from './m59-railcut.mjs';
import { budgetForTimeout } from './m59-railfollow.mjs';
import { STONES, attemptable } from './m59-stones.mjs';
import { CLIENT_FINENESS as F, MAX_STEP_HEIGHT } from './m59-roo.mjs';

// HOW LONG ONE AIM MAY BE, AND IT IS A MEASUREMENT RATHER THAN A ROUND NUMBER.
//
// `m59-railfollow.mjs`'s AIM_BUDGET is three squares and its own note says that is the ceiling
// to plan INSIDE rather than one to wait out: measured on prod 2026-09-11, 3,072-unit legs
// aborted at 60-72 seconds with the body never moving, while 768-unit legs on the same follower
// completed at 0 units off the line. An aborted leg is broker-side and carries no reason, so it
// reads as a wall. `budgetForTimeout(60000)` is that pair turned into a number — 45 fine units
// a second, 40% safety — and it is 1,080 units, a hair over one square.
export const AIM_BUDGET = budgetForTimeout(60_000);

// THE SERVER'S OWN MELD TEST, AND IT HAS NO HEIGHT TERM.
//
//   abs(Send(who,@GetRow) - Send(self,@GetRow)) < MANANODE_RANGE  AND
//   abs(Send(who,@GetCol) - Send(self,@GetCol)) < MANANODE_RANGE
//     — kod/object/passive/mananode.kod TryActivate, MANANODE_RANGE = 3 (:17)
//
// Two squares each way on each axis, judged independently — a 5x5 BOX, not a radius — and
// nothing about z. That is the same sentence as CLAUDE.md's "THE SERVER IS TWO-DIMENSIONAL.
// HEIGHT IS OURS": every height rule in this game is the CLIENT's. So a rail that ends in the
// valley UNDER a stone, within two squares of it on both axes, satisfies the range test that
// the server actually applies.
//
// This file does not act on that. It MEASURES it — `meld_box` is the server's test, and
// `arrived_below` is how far under the stone's own footing the rail stopped — because the
// difference between "reached the stone" and "reached the square the stone is in" is exactly
// the split-square mistake this repository keeps paying for, and a bake that reports the
// second as the first is worse than one that refuses.
export const MANANODE_RANGE = 3;
export const inMeldBox = (a, b, range = MANANODE_RANGE) =>
  Math.abs(a.row - b.row) < range && Math.abs(a.col - b.col) < range;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
export const RAILS_FILE = () => process.env.M59_NODERAILS_FILE ||
  join(REPO, 'substrate', 'node-rails.json');
const ROUTES_FILE = () => process.env.M59_ROUTES_FILE ||
  join(REPO, 'substrate', 'm59-routes.json');

// BUMP THIS WHEN WHAT A ROUTE ENTRY *MEANS* CHANGES. `m59-routebake.mjs` learned this the
// expensive way: its resume check compared the map, the view and the step-mask version, none
// of which move when the bake's own logic does, so a fixed bake re-ran, changed nothing, and
// exited clean. A stale file that reads as fresh is the same undetectable wrong.
export const NODERAIL_VERSION = 1;

/** The stone's square. Row first, the KOD's own order — `m59-stones.mjs` is the one source. */
export const stoneSquare = (s) => ({ row: s.row, col: s.col });

/**
 * THE EXITS, TAKEN FROM THE BAKE RATHER THAN RE-DERIVED.
 *
 * A rail has to END where a journey BEGINS, and a journey begins at the anchor
 * `m59-routebake.mjs` chose — which is a ranked judgement about which staging square of a
 * boundary is actually reachable, not the first one the room published. Re-deriving it here
 * would give the two halves of one walk two different ideas of where the door is, and the
 * failure mode is not an error: it is a character standing two squares from a doorway that
 * the other half of the toolchain is certain it is at.
 *
 * `waypoint` anchors are dropped. They are not exits — and in room 27 one of them IS the
 * stone, so keeping them would bake a rail from the node to itself.
 */
export function exitAnchorsOf(table, roomNum) {
  const room = table?.rooms?.[String(roomNum)];
  return (room?.anchors ?? [])
    .filter(a => a.kind === 'edge' || a.kind === 'go')
    .map(a => ({ kind: a.kind, dir: a.dir ?? null, to: a.to ?? null,
                 row: a.row, col: a.col, region: a.region ?? null }));
}

/** One stable spelling, used as the key and in every line printed. */
export const exitId = (e) => `${e.kind}:${e.to ?? '?'}:r${e.row}c${e.col}`;
export const exitLabel = (e) =>
  `${e.dir ?? e.kind}${e.to != null ? ` -> ${e.to}` : ''} r${e.row}c${e.col}`;

/**
 * THE MOVER'S OWN ANSWER, AND ONLY THE MOVER'S.
 *
 * `m59-guildrails.mjs` builds its edge as the fine trace AND `moverStepLands`, because a
 * ceiling door is entirely a headroom fact and only the step mask knows about it. That is
 * right for a hall of ceiling doors and WRONG here: `moverStepLands` is square-to-square, and
 * every one of these rooms is ground where a square is a summary. Anding it in would refuse
 * the Ancient Place staircase on the grounds that r40c33 spans seven thousand units — which
 * is the precise lie this bake exists to get out from under.
 *
 * The cost is real and is written down rather than papered over: a floor-based test cannot
 * see a CEILING at all, so a rail through room 750's sealed chamber (`icecave1.kod` lifts
 * MANA_DOOR 380 -> 510 when a yeti dies) is cut as though the ceiling were up. The bake
 * carries `ceiling_gated` for those rooms so a reader is told rather than misled.
 *
 * AND A SLIDE THAT ARRIVES SOMEWHERE ELSE IS NOT THIS EDGE. The client slides along the first
 * blocker rather than refusing, so `moved` on its own accepts a step that scraped a wall and
 * ended a long way from the aim — and a rail built out of those is a rail the walker cannot
 * follow, every leg of which "worked". Sliding is how you hug a wall and is not cheating, so
 * it stays on; landing more than one lattice step from the aim is what is refused.
 */
/**
 * THE FLOOR AT A POINT, READ AT THE POINT — not within thirty-two units of it.
 *
 * `fineRouter`'s own `floorAt` is memoised on `(x >> 5, y >> 5)`, a 32-unit cell, which is the
 * right trade for a flood asking millions of times and the WRONG one for a number written into
 * a rail: on a ledge the two halves of a 32-unit cell are different worlds, so the first point
 * to land in that cell decides the height of everything after it.
 *
 * MEASURED, and it produced a finding that was not true. The first cut of this bake recorded
 * heights from that cache and the Badlands rail came out with two rises past the step cap —
 * +640 and +1536 — which reads exactly like "the mover climbed something it should not have".
 * Re-read at the points themselves, both spans are ONE leaf, ONE sector, and dead flat across
 * all nine samples: the `from` height was a neighbour's, cached. The rail was fine and the
 * instrument was not, which is the shape CLAUDE.md names — "when a measurement is clean and
 * confident, ask what it is a measurement OF".
 *
 * This is the point floor rather than `standAt`'s footprint maximum, matching
 * `m59-guildrails.mjs`'s `floorOf`, because `m59-railfollow.mjs` compares a waypoint's `f`
 * against a body's own point floor and two different definitions of "the floor" in one
 * comparison is the fault this file is full of warnings about.
 */
export const exactFloor = (geo) => (x, y) => {
  try {
    const leaf = geo.leafAtClient(x, y);
    return leaf?.sector ? geo.floorBaseAtClient(x, y, leaf) : null;
  } catch { return null; }
};

export const fineEdge = (geo, { floorAt = null, step = MAX_STEP_HEIGHT } = {}) => {
  const floor = floorAt ?? exactFloor(geo);
  return (a, b) => {
    try {
      const t = geo.traceFineMoveClient(a.x, a.y, b.x, b.y, { slide: true });
      if (!t || !t.moved) return false;
      const landed = Math.hypot(t.x - b.x, t.y - b.y);
      // GROUND GAINED, NOT MERELY `moved`. A slide that ends no nearer the aim than the start
      // was is a body scraping a wall in place, and `moved` is true for it. `fineRouter`'s own
      // flood draws the same line with `< step / 4` and calls it "went nowhere".
      if (!(landed <= LATTICE && landed < Math.hypot(a.x - b.x, a.y - b.y))) return false;
      // AND THE SLID LANDING'S SHELF, WHICH IS THE ONE THAT DECIDES.
      //
      // A LATTICE RAIL'S WHOLE CLAIM IS THAT ITS POINTS ARE WHERE THE BODY WILL BE, and a
      // slide breaks that quietly. `fineRouter`'s flood is safe from this because it keys on
      // where the body ACTUALLY ended; a 64-lattice flood cannot, because it must stay on the
      // lattice, so it has to refuse the step instead.
      //
      // MEASURED, and it had already shipped a false finding. Room 45, aim (16714,7490):
      //
      //     moved true, arrived FALSE, blocked true, slid true, reason geometry_blocked
      //     body ends (16700,7505) — 20 units from the aim, and destinationFloor 1152
      //     floor at the aim                                                       4096
      //
      // Twenty units from the aim and 2,944 units below it. The distance test waved it
      // through, so the rail recorded a +2,944 climb in one 64-unit step — and the bake
      // reported a walkable rail onto the Badlands mesa, which every previous measurement of
      // that room says is closed. Room 579's known-good climb had the same shape at r43c47,
      // the split square this repository already has a paragraph about.
      //
      // This is `holdShelf`'s sentence, arriving at the bake instead of the follower: judge
      // the SLID LANDING, not the aim. `destinationFloor` is the trace's own answer and is
      // preferred to re-reading the geometry at a point it already resolved.
      const landedFloor = t.destinationFloor ?? floor(t.x, t.y);
      const aimFloor = floor(b.x, b.y);
      if (landedFloor == null || aimFloor == null) return false;
      return Math.abs(landedFloor - aimFloor) <= step;
    } catch { return false; }
  };
};

/**
 * ONE SPAN OF THE PLANNER'S LINE, RE-WALKED AT THE LATTICE.
 *
 * Returns the points from `a` to `b`, exclusive of `a` and inclusive of `b` — the caller owns
 * the joint — plus how the span was settled, which is the half worth reporting:
 *
 *   `chord`        the straight line is clear when stepped. This is what the walker will do.
 *   `flood`        it is not, and a 64-lattice flood found a way round inside the span.
 *   `unvalidated`  neither. The planner's own point is kept and the span is counted.
 */
export function railSpan(a, b, { edge, bounds, floorAt, lattice = LATTICE } = {}) {
  const at = p => ({ x: Math.round(p.x), y: Math.round(p.y),
                     f: floorAt ? floorAt(Math.round(p.x), Math.round(p.y)) : null });
  // CHECK THE POINTS THAT WILL BE WRITTEN, NOT THE ONES THAT WERE COMPUTED.
  //
  // `chordWalkable` steps a chord at fractional positions; a rail stores INTEGERS. Rounding
  // moves a point by up to half a unit, and at a hairline — a doorway, a ledge lip — half a
  // unit is the whole answer. Measured: the first cut of this validated with `chordWalkable`
  // and emitted the rounded points, and `noderails check` — which re-traces what was written —
  // then refused 6 of 27 rails at a handful of steps each, on ground the bake had just called
  // walkable. Neither pass was wrong; they were checking two different lines.
  //
  // So the candidate points are built first, rounded, and then validated pairwise starting
  // from `a`. Construction and verification are now the same question, and `check` failing
  // means the MAP moved rather than that the two disagree about arithmetic.
  const walkPairs = (from, pts) => {
    let cur = from;
    for (const p of pts) { if (!edge(cur, p)) return false; cur = p; }
    return true;
  };
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d / lattice));
  const chord = [];
  for (let k = 1; k <= n; k++)
    chord.push(at({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n }));
  if (walkPairs(a, chord)) return { how: 'chord', points: chord, pieces: n };

  const cut = cutRail(a, b, { edge, bounds, floorAt, lattice });
  if (cut.ok) {
    // `cutRail` prepends the body's raw position and ends on the SNAPPED goal, so the last
    // point is up to half a lattice short of `b`. Closing that gap is a STEP like any other
    // and is traced like one; when it refuses, the span ends on the snapped point and the
    // caller carries on from there — which is why `railLeg` walks a cursor rather than
    // assuming each span begins where the planner's waypoint was.
    let pts = cut.waypoints.slice(1).map(p => ({ x: p.x, y: p.y, f: p.f ?? null }));
    if (pts.length) {
      const end = at(b), last = pts[pts.length - 1];
      if ((last.x !== end.x || last.y !== end.y) && edge(last, end)) pts.push(end);
      // THE SNAPPED SEED IS NOT ALWAYS A STEP. `cutRail` reports `bridgeOk` for the hop from
      // the body to the lattice and returns `ok: true` either way, so the first emitted point
      // can be somewhere the cursor cannot step to. Measured on the Badlands inbound rail: the
      // cursor at (54827,1920) and the seed at (54848,1920) are TWENTY-ONE units apart — under
      // the mover's 128-unit floor, so the trace will not move at all — and that one joint was
      // the last surviving disagreement between the bake and `noderails check`.
      //
      // Dropping the redundant seed is better than declaring a hole: the cursor already IS
      // that point for every purpose a walker has. So the rule is the one stated at the top of
      // this file and now applies to every branch without exception — WHAT IS EMITTED IS
      // VALIDATED PAIRWISE FROM THE CURSOR — and a span that cannot satisfy it is unvalidated.
      if (!walkPairs(a, pts) && pts.length > 1) pts = pts.slice(1);
      if (walkPairs(a, pts)) {
        const reached = pts[pts.length - 1].x === at(b).x && pts[pts.length - 1].y === at(b).y;
        return { how: 'flood', points: pts, visited: cut.visited, pieces: pts.length,
                 ...(reached ? {} : { short_of_goal: true }) };
      }
    }
  }
  return { how: 'unvalidated', points: [at(b)], pieces: 1,
           why: `chord refused, flood reached ${cut.visited ?? 0}` };
}

/**
 * A PLANNER WALK LEG -> A RAIL LEG. Every span re-walked, the drops measured on the DENSE
 * points rather than the decimated ones, and the unvalidated spans counted rather than hidden.
 */
export function railLeg(leg, { edge, bounds, floorAt, lattice = LATTICE } = {}) {
  const wps = leg.waypoints ?? [];
  const sq = p => ({ row: ((p.y / F) | 0) + 1, col: ((p.x / F) | 0) + 1 });
  if (wps.length === 0)
    return { kind: 'walk', waypoints: [], spans: [], unvalidated: 0, biggest_drop: 0,
             committing_drops: [] };
  const first = { x: Math.round(wps[0].x), y: Math.round(wps[0].y) };
  const out = [{ ...first, f: floorAt ? floorAt(first.x, first.y) : null, ...sq(first) }];
  const spans = [];
  let unvalidated = 0;
  // A CURSOR, NOT THE PLANNER'S WAYPOINT. A flood span can end half a lattice short of the
  // point it was aiming at, and starting the next span from the aim rather than from where the
  // rail actually is puts an untraced hop between them — invisible, because both spans report
  // themselves settled. The cursor is the last point on the rail, always.
  let cursor = out[0];
  for (let i = 1; i < wps.length; i++) {
    const s = railSpan(cursor, wps[i], { edge, bounds, floorAt, lattice });
    spans.push({ i: i - 1, how: s.how, pieces: s.pieces,
                 ...(s.short_of_goal ? { short_of_goal: true } : {}),
                 ...(s.why ? { why: s.why } : {}) });
    if (s.how === 'unvalidated') unvalidated++;
    // A POINT NOBODY CLAIMED IS MARKED, BECAUSE `check` CANNOT TELL OTHERWISE. An unvalidated
    // span's point was kept rather than proved, so re-tracing it refuses — correctly — and a
    // checker that counts that as drift is permanently red and stops being read. `u` is the
    // difference between "this was never a claim" and "the map moved under a claim".
    for (const p of s.points)
      out.push({ ...p, ...sq(p), ...(s.how === 'unvalidated' ? { u: true } : {}) });
    cursor = out[out.length - 1];
  }
  // THE DROPS, ON THE DENSE RAIL. A decimated line under-reports them: two kept waypoints are
  // several flood steps apart, so what reads as one drop between them is a sum of steps.
  const drops = [];
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1].f, b = out[i].f;
    if (a == null || b == null) continue;
    if (a - b > MAX_STEP_HEIGHT) drops.push({ at: i, from: a, to: b, drop: a - b });
  }
  const aims = aimsAlong(out, { edge, lattice });
  return { kind: 'walk', waypoints: out, spans, unvalidated,
           aims,
           // Aims the geometry would not let us merge past the mover's 128-unit floor. Each one
           // is a round trip that may move nobody while answering `arrived: true`, so a
           // follower is told the count rather than left to discover it a leg at a time.
           short_aims: aims.shortAims?.length ?? 0,
           biggest_drop: leg.biggest_drop ?? 0, committing_drops: drops };
}

/**
 * THE FEWEST POINTS A WALKER CAN BE TOLD, AND NOT ONE MORE THAN THE FLOOD ALREADY PROVED.
 *
 * WHY BOTH LISTS SHIP. `waypoints` is the proof — every leg one lattice step the mover's own
 * trace accepted, deliberately not decimated, per `m59-railcut.mjs`. `aims` is what a follower
 * drives, because a 1,249-waypoint rail driven one `walk_to` per point is twenty minutes of
 * packets for a walk that takes one. Throwing away either loses something real: the dense list
 * cannot be walked at a sensible rate and the sparse list cannot be checked.
 *
 * AN AIM IS THE END OF A STRAIGHT RUN, AND THAT IS EXACT RATHER THAN A HEURISTIC. A chord over
 * consecutive lattice steps that all share a heading IS those steps: `chordWalkable` cuts a
 * chord into `ceil(d / 64)` pieces, and over a straight run those pieces are the very steps
 * the flood already accepted. So merging them asks no new question and costs no trace. The
 * moment the heading changes, the chord is a line across a corner that nothing has traced, and
 * this stops.
 *
 * WHICH IS NOT WHAT `fineRouter` DOES, and the distinction is the point: it also decimates on
 * a heading change but keeps the point AFTER the change, so its kept pairs span corners. That
 * is the "two of twelve such legs refused when stepped" case in `m59-railcut.mjs`.
 *
 * AND `furthestTraceable` IS THE RIGHT TOOL FOR A LIVE BODY AND THE WRONG ONE HERE. It walks
 * outward re-stepping every candidate chord, which is what you want from where a body actually
 * stands and is quadratic in the window: 64 candidates by up to 48 pieces is ~3,000 traces an
 * aim, and a trace is 0.44ms, so a 4,688-point rail would cost minutes to decimate and would
 * still be re-asked live. The follower calls it; the bake does not.
 */
export function aimsAlong(waypoints, { edge = null, lattice = LATTICE, budget = AIM_BUDGET,
                                       minAim = MIN_MOVER_STEP } = {}) {
  const n = Array.isArray(waypoints) ? waypoints.length : 0;
  if (n < 2) return waypoints ?? [];
  const at = i => waypoints[i];
  const gap = (i, j) => Math.hypot(at(j).x - at(i).x, at(j).y - at(i).y);
  const heading = (i) => {
    const dx = at(i).x - at(i - 1).x, dy = at(i).y - at(i - 1).y;
    const len = Math.hypot(dx, dy) || 1;
    return { key: `${Math.round(dx / len * 64)},${Math.round(dy / len * 64)}`, len };
  };
  // The end of the maximal straight run starting at `i`. Free: a chord over steps that share a
  // heading IS those steps. It stops at the budget and at a step longer than one lattice cell,
  // which is an UNVALIDATED span — `railSpan` kept the planner's own point there because
  // neither the chord nor a flood would have it, so a merge across it would quietly carry a
  // walker over the one place that refused.
  const endOfRun = (i) => {
    if (i >= n - 1) return n - 1;
    let j = i + 1;
    const h0 = heading(j);
    if (h0.len > lattice * 1.5) return j;
    while (j < n - 1) {
      const h = heading(j + 1);
      if (h.key !== h0.key || h.len > lattice * 1.5) break;
      if (gap(i, j + 1) > budget) break;
      j++;
    }
    return j;
  };

  const out = [at(0)];
  const shortAims = [];
  let last = 0;
  while (last < n - 1) {
    let j = endOfRun(last);
    // AN AIM SHORTER THAN THE MOVER'S MINIMUM STEP IS A NO-OP THAT REPORTS SUCCESS.
    //
    // `walkFine` floors every step at 8 protocol units = 128 CLIENT units and answers a closer
    // aim with `arrived: true, steps: 0`. Measured on Marco's 169 logged legs in room 49: 51 of
    // them (30%) took zero steps that way. Measured on THIS bake before the loop below, on the
    // Ancient Place's west rail: 410 of 602 aim gaps — 68% — were under 128, median 64. Two
    // thirds of the round trips would have moved nobody, and each one reads as arrival.
    //
    // So a short run is extended across the NEXT corner, and the chord over that corner is
    // stepped before it is accepted, because a corner is exactly where a straight line stops
    // being made of steps anybody traced. Traces are paid only here, which is why this is not
    // `furthestTraceable` on every aim: on a long straight run the extension never runs.
    while (j < n - 1 && gap(last, j) < minAim) {
      const k = endOfRun(j);
      if (k === j || gap(last, k) > budget) break;
      if (!edge || !chordWalkable(at(last), at(k), { edge, lattice }).ok) break;
      j = k;
    }
    if (j <= last) j = last + 1;
    if (gap(last, j) < minAim && j < n - 1) shortAims.push(out.length);
    out.push(at(j));
    last = j;
  }
  // AND SAY SO WHERE IT COULD NOT BE FIXED. A short aim that survives is one the geometry would
  // not let us merge past — a genuine hairpin. It is kept, because dropping it would hand the
  // walker a chord round a corner nothing traced, and it is counted, because a follower that
  // cannot tell a no-op from an arrival will call the run finished.
  if (shortAims.length) Object.defineProperty(out, 'shortAims', { value: shortAims });
  return out;
}

/**
 * ONE STONE, ONE EXIT, ONE DIRECTION.
 *
 * `ok:false` is an answer and carries its bound. It is never shortened to "unreachable".
 */
export function bakeOne(router, from, to, { maxJumps = 4, allowCandidates = false,
                                            edge, bounds, floorAt } = {}) {
  const t0 = Date.now();
  const plan = router.plan(from, to, { maxJumps, allowCandidates });
  if (!plan.ok) {
    const reached = (plan.trace ?? []).reduce((a, t) => Math.max(a, t.squares ?? 0), 0);
    return { ok: false, why: plan.why,
             bound: { max_jumps: maxJumps, candidates: allowCandidates },
             closure_squares: reached, ms: Date.now() - t0 };
  }
  const legs = [];
  for (const leg of plan.legs) {
    if (leg.kind === 'jump') { legs.push(leg); continue; }
    legs.push(railLeg(leg, { edge, bounds, floorAt }));
  }
  const walk = legs.filter(l => l.kind === 'walk');
  const unvalidated = walk.reduce((a, l) => a + l.unvalidated, 0);
  return { ok: true, legs, jumps: plan.jumps, all_declared: plan.all_declared,
           confidence: plan.confidence,
           ...arrivalOf(legs, to, router),
           waypoints: walk.reduce((a, l) => a + l.waypoints.length, 0),
           aims: walk.reduce((a, l) => a + (l.aims?.length ?? 0), 0),
           unvalidated,
           // A RAIL WITH A HOLE IN IT IS STILL WORTH KEEPING AND IS NOT THE SAME THING.
           //
           // The planner floods at 256 with perpendicular nudges and keys on where a slide
           // actually LANDED, so a span it crossed can be one no 64-lattice step can walk —
           // a band narrower than the lattice phase, most often. Refusing the whole route
           // over one of those would throw away good lines; presenting it as a checked rail
           // would be the lie this file exists to stop. So it ships, flagged, and `findRoute`
           // hands out complete rails first.
           rail_complete: unvalidated === 0,
           committing_drops: walk.reduce((a, l) => a + l.committing_drops.length, 0),
           ms: Date.now() - t0 };
}

/**
 * WHERE THE RAIL ACTUALLY STOPS, AGAINST WHERE IT WAS FOR.
 *
 * `fineRouter`'s success test is `sqOf(p) === the goal square` — a SQUARE test, and on this
 * ground a square is a summary of two different places. Room 45's stone stands on a plateau at
 * floor 4096 with the valley immediately under it; a flood that reaches the valley half of
 * `r63c46` satisfies that test exactly as a flood that reaches the plateau does. That is the
 * split-square mistake this whole toolchain exists to avoid, committed one level up, and it
 * would ship as "a rail to the Badlands stone".
 *
 * So the arrival is measured: which square the rail ends in, what floor it ends on, what floor
 * the target's own footing is, and the difference. `arrived_below` past one step height means
 * the rail ended UNDER its destination, which for a door is a failure and for a stone is a
 * question the server answers differently — see MANANODE_RANGE above.
 */
export function arrivalOf(legs, to, router) {
  const walk = legs.filter(l => l.kind === 'walk' && l.waypoints.length);
  const last = walk[walk.length - 1];
  if (!last) return {};
  const end = last.waypoints[last.waypoints.length - 1];
  const foot = router.footing(to.row, to.col);
  const targetFloor = foot?.h ?? null;
  const out = { arrival: { row: end.row, col: end.col, x: end.x, y: end.y, f: end.f ?? null },
                target_floor: targetFloor,
                arrived_in_square: end.row === to.row && end.col === to.col };
  if (targetFloor != null && end.f != null) {
    out.arrived_below = targetFloor - end.f;
    out.arrived_off_shelf = (targetFloor - end.f) > MAX_STEP_HEIGHT;
  }
  return out;
}

/** Re-walk a baked rail against the map. The guard that says a bake has gone stale. */
export function checkRoute(route, { edge } = {}) {
  const bad = [];
  let legs = 0, skipped = 0;
  for (const [li, leg] of (route.legs ?? []).entries()) {
    if (leg.kind !== 'walk') continue;
    // SPLIT AT THE POINTS NOBODY CLAIMED. An unvalidated point was kept, not proved, so the
    // step into it was never a claim and re-tracing it is not evidence of anything. Each run
    // between them is verified whole, which is what `verifyRail` is for.
    const wps = leg.waypoints ?? [];
    let run = [], base = 0;
    const flush = () => {
      if (run.length < 2) return;
      const v = verifyRail(run, { edge });
      legs += v.legs;
      for (const b of v.bad) bad.push({ leg: li, ...b, i: b.i + base });
    };
    for (let i = 0; i < wps.length; i++) {
      if (wps[i].u) { flush(); skipped++; run = [wps[i]]; base = i; continue; }
      if (!run.length) base = i;
      run.push(wps[i]);
    }
    flush();
  }
  return { ok: bad.length === 0, legs, bad, skipped };
}

/** Rooms whose sectors move at runtime — a floor-based bake holds ONE frame of them. */
export function variableSectorRooms(repo = REPO) {
  try {
    const j = JSON.parse(readFileSync(join(repo, 'substrate', 'm59-variable-sectors.json'), 'utf8'));
    const out = new Map();
    for (const r of Object.values(j.rooms ?? {})) {
      const n = Number(r.room);
      if (!Number.isFinite(n)) continue;
      const gating = (r.sectors ?? []).filter(s => s.gates || s.gate_risk || s.headroom_risk);
      if (gating.length) out.set(n, gating.map(s => s.name ?? `sector ${s.sector}`));
    }
    return out;
  } catch { return new Map(); }
}

/** The stones to bake, in the census's own order. `--node` takes a key or a documented alias. */
export function stonesToBake({ only = null, includeConditional = true } = {}) {
  const wanted = only ? new Set(String(only).split(',').map(s => s.trim().toLowerCase())) : null;
  return Object.entries(STONES)
    .filter(([k, s]) => {
      if (wanted) return wanted.has(k) || (s.alias ?? []).some(a => wanted.has(String(a).toLowerCase()));
      return includeConditional || attemptable(s);
    })
    .map(([key, stone]) => ({ key, stone }));
}

export function bakeNodeRails({ only = null, maxJumps = 4, allowCandidates = false,
                                table = null, onProgress = null } = {}) {
  const routes = table ?? JSON.parse(readFileSync(ROUTES_FILE(), 'utf8'));
  const varRooms = variableSectorRooms();
  const out = { version: NODERAIL_VERSION, cut: new Date().toISOString(),
                lattice: LATTICE, max_jumps: maxJumps, candidates: allowCandidates,
                built_from: { routes_built_at: routes.builtAt ?? null,
                              bake_version: routes.bakeVersion ?? null,
                              geometry: routes.geometryManifestSha256 ?? null },
                stones: [] };
  for (const { key, stone } of stonesToBake({ only })) {
    const room = Number(stone.room);
    const entry = { node: key, room, kod: stone.node, where: stone.where,
                    stone: `r${stone.row}c${stone.col}`,
                    attemptable: attemptable(stone),
                    ...(stone.conditional ? { conditional: true } : {}),
                    ...(stone.appears ? { appears: stone.appears } : {}),
                    ...(varRooms.has(room) ? { ceiling_gated: varRooms.get(room) } : {}),
                    exits: 0, routes: [] };
    let router = null;
    try { router = fineRouter(room); }
    catch (e) {
      // A ROOM WITH NO COLLISION GEOMETRY IS A FACT ABOUT THE BAKE, NOT THE WORLD, and it has
      // to read differently from "no route".
      entry.error = String(e.message ?? e);
      out.stones.push(entry);
      onProgress?.({ node: key, room, error: entry.error });
      continue;
    }
    const edge = fineEdge(router.geo);
    const bounds = { w: router.room.cols * F, h: router.room.rows * F };
    // NOT `router.floorAt` — see exactFloor. A cached height is fine for a flood and wrong in a
    // file somebody reads a drop off.
    const floorAt = exactFloor(router.geo);
    const exits = exitAnchorsOf(routes, room);
    entry.exits = exits.length;
    if (!exits.length) onProgress?.({ node: key, room, note: 'no exit anchor in the routing table' });
    const target = stoneSquare(stone);
    for (const e of exits) {
      for (const direction of ['to_node', 'to_exit']) {
        const from = direction === 'to_node' ? { row: e.row, col: e.col } : target;
        const to   = direction === 'to_node' ? target : { row: e.row, col: e.col };
        const r = bakeOne(router, from, to, { maxJumps, allowCandidates, edge, bounds, floorAt });
        // THE MELD IS THE SERVER'S TEST, NOT OURS, and it is the only one that decides whether
        // walking here accomplished anything. Recorded only inbound, because arriving at a
        // DOOR is a different question and `arrived_in_square` is the one that answers it.
        if (direction === 'to_node' && r.ok && r.arrival)
          r.meld_box = inMeldBox(r.arrival, target);
        entry.routes.push({ exit: exitId(e), exit_label: exitLabel(e), direction,
                            from: `r${from.row}c${from.col}`, to: `r${to.row}c${to.col}`, ...r });
        onProgress?.({ node: key, room, exit: exitLabel(e), direction, result: r });
      }
    }
    out.stones.push(entry);
  }
  return out;
}

/** One baked route by node + direction + exit, for a follower. */
export function findRoute(baked, { node, direction = 'to_node', exit = null,
                                   allowIncomplete = false } = {}) {
  const s = (baked?.stones ?? []).find(x => x.node === node);
  if (!s) return null;
  const rs = (s.routes ?? []).filter(r => r.direction === direction && r.ok)
    .filter(r => allowIncomplete || r.rail_complete !== false);
  if (!rs.length) return null;
  // THE ROOM TRAVELS WITH THE ROUTE. A rail is a line inside ONE room and a caller holding one
  // has no other way to find out which — `m59-fineclimb.mjs` built a router for the room the
  // BODY was in and followed a rail cut for another, which plans, prints and drives without
  // anything reading as wrong.
  const withRoom = r => ({ ...r, room: s.room, node: s.node, stone: s.stone });
  if (exit) {
    const hit = rs.find(r => r.exit === exit || r.exit_label === exit);
    return hit ? withRoom(hit) : null;
  }
  // No exit named: the shortest rail, because a caller that did not choose wants the cheapest
  // way in and a caller that cares names one.
  return withRoom(rs.slice().sort((a, b) => a.waypoints - b.waypoints)[0]);
}

// ---------------------------------------------------------------- CLI
const isMain = import.meta.url === `file://${process.argv[1]}` ||
               process.argv[1]?.endsWith('m59-noderails.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv.find(a => !a.startsWith('--')) ?? 'show';
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };
  if (has('help')) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n').slice(1).filter(l => l.startsWith('//'))
      .map(l => l.replace(/^\/\/ ?/, '')).join('\n').split('\n\n').slice(0, 2).join('\n\n'));
    process.exit(0);
  }
  const JSONOUT = has('json');
  const pct = (a, b) => (b ? Math.round(a * 100 / b) : 0);
  const arrow = d => (d === 'to_node' ? '->stone' : 'stone->');

  if (cmd === 'bake') {
    const baked = bakeNodeRails({
      only: flag('node'), maxJumps: Number(flag('max-jumps', 4)),
      allowCandidates: has('candidates'),
      onProgress: JSONOUT ? null : (p) => {
        if (p.error) { console.log(`  ${p.node.padEnd(10)} room ${p.room}: ${p.error}`); return; }
        if (p.note) { console.log(`  ${p.node.padEnd(10)} room ${p.room}: ${p.note}`); return; }
        const r = p.result;
        console.log(`  ${p.node.padEnd(10)} ${arrow(p.direction)} ${p.exit.padEnd(22)} ` +
          (r.ok ? `RAIL ${String(r.waypoints).padStart(4)} wp / ${r.aims} aim(s), ${r.jumps} jump(s)` +
                  `${r.unvalidated ? `, INCOMPLETE: ${r.unvalidated} unvalidated span(s)` : ''}` +
                  `${r.committing_drops ? `, ${r.committing_drops} committing drop(s)` : ''}` +
                  `${r.arrived_off_shelf ? `, ENDS ${r.arrived_below} BELOW the target` : ''}` +
                  `${r.meld_box === false ? ', OUTSIDE the meld box' : ''}`
                : `no rail — ${r.why}`) + `  ${r.ms}ms`);
      },
    });
    const file = flag('out', RAILS_FILE());
    // COMPACT, like `substrate/m59-routes.json` and unlike `substrate/rail-714.json`. Nothing
    // reads this by eye — `show` is for that — and a dense rail indents to 5.2MB against 2.1.
    if (!has('dry-run')) writeFileSync(file, JSON.stringify(baked));
    if (JSONOUT) { console.log(JSON.stringify(baked, null, 1)); process.exit(0); }
    const all = baked.stones.flatMap(s => s.routes ?? []);
    const ok = all.filter(r => r.ok).length;
    console.log('');
    console.log(`${ok}/${all.length} rail(s) (${pct(ok, all.length)}%) across ` +
                `${baked.stones.length} stone(s)${has('dry-run') ? '' : ` -> ${file}`}`);
    process.exit(0);
  }

  const file = flag('file', RAILS_FILE());
  if (!existsSync(file)) {
    console.error(`m59-noderails: nothing baked yet (${file}). Run: node tools/m59-noderails.mjs bake`);
    process.exit(2);
  }
  const baked = JSON.parse(readFileSync(file, 'utf8'));

  if (cmd === 'show') {
    const only = flag('node');
    if (JSONOUT) { console.log(JSON.stringify(baked, null, 1)); process.exit(0); }
    console.log(`baked ${baked.cut}  lattice ${baked.lattice}  max_jumps ${baked.max_jumps}` +
                `  candidates ${baked.candidates}`);
    for (const s of baked.stones) {
      if (only && s.node !== only) continue;
      const rs = s.routes ?? [];
      const ok = rs.filter(r => r.ok).length;
      console.log('');
      console.log(`${s.node.toUpperCase()}  room ${s.room}, ${s.where}, stone at ${s.stone}` +
                  `${s.attemptable ? '' : '  [not an errand]'}${s.conditional ? '  [conditional]' : ''}`);
      if (s.error) { console.log(`  ${s.error}`); continue; }
      console.log(`  ${ok}/${rs.length} rail(s) over ${s.exits} exit(s)`);
      if (s.ceiling_gated)
        console.log(`  NOTE: this room MOVES ${s.ceiling_gated.length} sector(s) at runtime ` +
                    `(${s.ceiling_gated.slice(0, 3).join(', ')}). A floor-based rail holds one ` +
                    `frame and cannot see a ceiling at all.`);
      for (const r of rs) {
        console.log(`    ${arrow(r.direction).padEnd(8)} ${r.exit_label.padEnd(22)} ` +
          (r.ok ? `${String(r.waypoints).padStart(4)} wp / ${String(r.aims).padStart(3)} aim  ` +
                  `${r.jumps} jump(s)  ${r.all_declared ? 'declared' : 'CANDIDATES'}` +
                  `${r.unvalidated ? `  INCOMPLETE (${r.unvalidated} unvalidated)` : ''}` +
                  `${r.committing_drops ? `  ${r.committing_drops} committing drop(s)` : ''}`
                : `no rail — ${r.why} (closure reached ${r.closure_squares} square(s))`));
        if (r.ok && (r.arrived_off_shelf || r.meld_box === false || !r.arrived_in_square))
          console.log(`             ends r${r.arrival.row}c${r.arrival.col} at floor ` +
            `${r.arrival.f}, target footing ${r.target_floor}` +
            `${r.arrived_off_shelf ? ` — ${r.arrived_below} BELOW it` : ''}` +
            `${r.meld_box === false ? ' — OUTSIDE the 5x5 meld box' : ''}` +
            `${r.meld_box === true && r.arrived_off_shelf
                ? ' — but INSIDE it, and the server\'s range test has no height term' : ''}`);
      }
    }
    process.exit(0);
  }

  if (cmd === 'check') {
    let bad = 0, checked = 0, steps = 0, skippedTotal = 0;
    for (const s of baked.stones) {
      if (!(s.routes ?? []).some(r => r.ok)) continue;
      let geo = null;
      try { geo = fineRouter(s.room).geo; } catch { continue; }
      const edge = fineEdge(geo);
      for (const r of s.routes ?? []) {
        if (!r.ok) continue;
        checked++;
        const v = checkRoute(r, { edge });
        steps += v.legs;
        skippedTotal += v.skipped ?? 0;
        if (!v.ok) {
          bad++;
          console.log(`${s.node} ${r.direction} ${r.exit_label}: ${v.bad.length} of ${v.legs} ` +
                      `step(s) REFUSED — first at leg ${v.bad[0].leg} step ${v.bad[0].i} ` +
                      `(${v.bad[0].why})`);
        }
      }
    }
    console.log(`${checked - bad}/${checked} baked rail(s) still walk on this map ` +
                `(${steps} lattice step(s) re-traced` +
                `${skippedTotal ? `, ${skippedTotal} unvalidated point(s) not re-asked` : ''})`);
    process.exit(bad ? 1 : 0);
  }

  console.error(`m59-noderails: unknown command "${cmd}" (bake | show | check)`);
  process.exit(2);
}
