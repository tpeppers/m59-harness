#!/usr/bin/env node
// EXIT TO EXIT, WORKED OUT ONCE, OFFLINE, AGAINST THE MAP THE MOVER ACTUALLY ENFORCES.
//
//   node tools/m59-routebake.mjs                 bake every room
//   node tools/m59-routebake.mjs --rooms 150,578 just these
//   node tools/m59-routebake.mjs --check         report, write nothing
//   node tools/m59-routebake.mjs --resume        keep what is already on disk, bake the rest
//   node tools/m59-routebake.mjs --grid          the old coarse view, for comparison only
//   node tools/m59-routebake.mjs --jobs 8      one room per core; 1680s -> ~250s
//
// THIRTEEN MINUTES ON THIS MACHINE, FLUSHED EVERY MINUTE. `--resume` adopts the rooms
// already in the table when — and only when — they were baked from the same geometry and
// the same view, so a killed bake costs a minute rather than the lot.
//
// WHAT THE RUNTIME ACTUALLY USES OUT OF THIS IS THE STEP MASK. The routes and the region
// labels are useful; the mask is the thing that changes behaviour, because it turns "would
// the mover take this step" from a 0.44ms trace into an array index and so lets the router
// plan on the same map the mover enforces without stopping the event loop.
//
// WHY THIS EXISTS, AND WHY IT IS A BAKE RATHER THAN A BUDGET.
//
// Since #18 movement is validated against the CLIENT's BSP — walls, sector heights, the
// player radius — while the router planned on the SERVER's coarse one-byte-a-square grid.
// Those disagree, and a router planning on a different map from the one the mover enforces
// does not produce a wrong route: it produces a character walking into a wall for ever.
//
// Making the router ask the mover's own trace fixes it and CANNOT BE DONE AT RUNTIME. The
// trace is synchronous and CPU-bound, A* calls it tens of thousands of times, and every
// session in the broker shares one event loop — so a cold path measured 1.2s during which
// no character's keepalive is answered. Shipped on by default, it took twelve of
// twenty-one characters out of the world in five minutes.
//
// Offline there is no loop to block. So the expensive, correct thing is done once here and
// the runtime does a lookup.
//
// ---------------------------------------------------------------------------
// WHAT IS STORED, AND THE TWO DIFFERENT QUESTIONS IT ANSWERS
//
//   components — every walkable square labelled by which collision-connected region it is
//                in, and each exit tagged with its region. This answers "is there a route
//                at all" in O(1), and that is the question that was most expensive to get
//                wrong: rooms 578 and 101 each burned a full A* exhaustion to conclude
//                "no route", every pass, for characters that genuinely cannot walk out.
//                A room with two regions is not broken — the Cragged Mountains has a cliff
//                and you need `blink` to get up it.
//
//   routes     — the actual step list between each ordered pair of exits in the same
//                region, as a direction string. One BFS per exit rather than one per PAIR:
//                a single search from an exit square yields the shortest path to every
//                other square in the room, including all the other exits.
//
// ONE BFS PER EXIT, NOT PER PAIR. The busiest room here has 58 exits; per-pair would be
// 3,306 searches for what 58 already answer.
//
// PATHS ARE STORED AS DIRECTIONS, NOT SQUARES. A step is one of eight neighbours, so it is
// one character; a forty-step route is forty bytes rather than forty coordinate pairs. The
// squares are recovered by walking the string from the known start.
//
// SERIALIZED COORDINATE CONTRACT: route/reach keys are `row,col>row,col`,
// pivot arrays are `[row,col]`, and step deltas are `(dr,dc)`. This is the writer
// for that existing machine format, not a movement-facing `(col,row)` API.
//
// A SIBLING FILE, NOT substrate/m59-map.json. That file is already 27 MB and is the
// checked map with its own manifest; this is derived from it and regenerable, and mixing
// the two would mean rebaking geometry to change a routing decision.

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync,
         rmSync } from 'node:fs';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap, edgeCandidatesOf } from './m59-map.mjs';
import { movementMapFile } from './m59-map-path.mjs';
import { sharedRoomGeometry, CLIENT_FINENESS, STEP_MASK_VERSION,
         PLAYER_RADIUS, WF } from './m59-roo.mjs';

// WHAT THIS BAKE COMPUTES, VERSIONED — because --resume could not tell that it had changed.
//
// The resume check compared the map, the view and the step-mask version, and a table that
// matched on all three was reused wholesale. None of them moves when the BAKE'S OWN LOGIC
// does. So fixing how the main region is chosen and re-running produced:
//
//     resuming: 264 room(s) already baked from the same map
//     baking 0 room(s) (264 already done)
//
// A clean exit, a written file, and not one number changed. That is the same undetectable
// wrong as a half-table stitched from two predicates, which the check three lines below
// already refuses — only for the algorithm rather than the geometry. Bump this whenever what
// a room's entry MEANS changes, and every stale table re-bakes itself instead of being
// silently kept.
//
//   2 — main region chosen by forward reach rather than largest SCC; blink points recorded
// 3 — plans STRICT-FIRST: where the coarse grid can connect two anchors, that is the route
//     baked, and the permissive plan is the fallback rather than the default. A v2 table
//     planned with clip steps everywhere, which in the 70 rooms where standable() answers
//     yes to every square meant planning with no floor test at all. Measured on the travel
//     corridor, v3 takes 599 from 147 squares of rock to 0 and 587 from 82 solid-wall
//     crossings to 12, losing no route in any room.
// 4 — the strict plan also PREFERS CLEARANCE: a square with a wall against it costs
//     1 + M59_ROUTE_CLEARANCE (3) instead of 1, so the line keeps a square off the rock
//     wherever the room allows it. A v3 route means "shortest"; a v4 route means "shortest
//     that is not scraping a corner", and the two are different lines — watched live,
//     runners ground along the corner at 29,50 in Ukgoth and took hits for as long as they
//     were stuck on it. Measured: 599 went from 80% of route squares touching a wall to
//     21%, and 586 from 58% to 5%, for 3% more length.
// 5 — a route with an unproved NON-TERMINAL ordinary pivot leg gets one proof-first
//     alternative. A final slide is harmless and stays byte-for-byte unchanged; a declared
//     fall is validated in fall mode and is not this signal. The alternative is adopted only
//     when stringPull proves strictly less composition risk, without adding a new fall or a
//     detour longer than one room diameter per risk removed. This keeps the mover's permissive
//     graph authoritative while preventing a slid landing from composing into a wall-crossing
//     rail on the next ideal-centre leg.
export const BAKE_VERSION = 5;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
export const ROUTES_FILE = () => process.env.M59_ROUTES_FILE ||
  join(REPO, 'substrate', 'm59-routes.json');

// The eight directions, in a fixed order, so a stored path is stable across bakes. The
// letter is what goes in the string.
export const STEP_DIRS = [
  ['n', -1, 0], ['s', 1, 0], ['e', 0, 1], ['w', 0, -1],
  ['a', -1, 1], ['b', 1, 1], ['c', 1, -1], ['d', -1, -1],
];
const BY_LETTER = new Map(STEP_DIRS.map(([ch, dr, dc]) => [ch, { dr, dc }]));

/**
 * Walk a stored direction string back into squares.
 * COORDINATE CONTRACT: the positional start is `(row,col)`; results are named.
 */
export function replay(fromRow, fromCol, path) {
  const out = [];
  let r = fromRow, c = fromCol;
  const str = String(path ?? '');
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    // An inline jump: `(dr,dc)`. See pathString — a fall is a single move of more than one
    // square and has no direction letter, so it is spelled out where it happens.
    if (ch === '(') {
      const close = str.indexOf(')', i);
      if (close < 0) return out;
      const m = /^(-?\d+),(-?\d+)$/.exec(str.slice(i + 1, close));
      if (!m) return out;
      r += Number(m[1]); c += Number(m[2]);
      out.push({ row: r, col: c });
      i = close;
      continue;
    }
    const d = BY_LETTER.get(ch);
    if (!d) return out;
    r += d.dr; c += d.dc;
    out.push({ row: r, col: c });
  }
  return out;
}

/** Number of unproved ordinary pivot legs whose landing starts another leg. */
export function compositionRisk(proved, squares) {
  if (!Array.isArray(proved) || !Array.isArray(squares) || proved.length < 2
      || squares.length !== proved.length + 1) return 0;
  let risk = 0;
  for (let i = 0; i < proved.length - 1; i++) {
    if (proved[i] !== false) continue;
    const a = squares[i], b = squares[i + 1];
    // A declared directed fall is validated in fall mode, so its ordinary no-slide result
    // is neither evidence of a bad jump nor the slid-square composition fault measured here.
    if (Math.abs(b[0] - a[0]) > 1 || Math.abs(b[1] - a[1]) > 1) continue;
    risk++;
  }
  return risk;
}

// ============ CONSERVATIVE REACHABILITY: WHERE A BODY CAN GET TO ON ITS OWN ============
//
// WHY A THIRD VIEW EXISTS AND WHAT IT IS ALLOWED TO DO. `exitAnchors` already ranks its
// staging squares by two reachability sets and the note there explains both: the collision
// body is too permissive (it walks 27 of 28 squares of rock across the top of Ukgoth) and
// the coarse grid is the corrective. In Lake of Jala's Song both waved through 2,1 -- a
// square sealed inside the wall in the northwest corner -- and the bake staked the whole
// west boundary on it. Characters ordered to Jasper walked at that square and piled up two
// squares away; one job record reads `walk to Yonder Inn of Jasper, took_s 2217`. The
// operator walked the room and named the real crossing, around 10,1.
//
// What separates the two, when nothing else did: 2,1's own aim point sits INSIDE a
// non-passable wall. `standPoint` returns a square's centre whenever it has floor and
// headroom and never asks whether the player CYLINDER fits -- deliberately, because
// `_traceMoverStep` is supposed to be the gate. It is not one here: it re-aims up to eight
// times at the quantized slid position, so a body slithers into the pocket and the step
// reports arrival.
//
// So this asks a deliberately conservative question -- can a body get here by steps between
// points it could actually STAND on, without leaning on the slide-retry -- and the answer is
// used for NOTHING except preferring one already-baked staging square over another.
//
// THAT RESTRAINT IS THE WHOLE SAFETY ARGUMENT. It does not touch `moverStepLands`, so no
// character walks differently because of it. It cannot delete a doorway, because
// `exitAnchors` orders and never filters: an exit with no conservatively-reachable stage
// falls through to the answer this file gave yesterday. Rooms where the strict view
// collapses (Outskirts of Tos goes to 8 squares) therefore express no preference and lose
// nothing, which is the correct behaviour for a view allowed to be wrong in one direction.

/** Walls a body cannot be on both sides of -- move.c:551's third term, on its own. */
const barrierSegments = geo => (geo.walls ?? []).filter(w => {
  const passable = sd => sd && (sd.flags & WF.PASSABLE);
  return !passable(w.posSidedefRec) || !passable(w.negSidedefRec);
});

/**
 * Distance from a point to the nearest barrier, capped -- past the cap it only breaks ties.
 *
 * A CLIFF IS NOT A BARRIER TO STANDING. Adding "the two floors differ by more than a step"
 * here was tried and it emptied the Cragged Mountains: `canCrossWallAt` only ever tests the
 * climb, so a drop is a fall the game allows, and treating it as a wall put a 248-unit
 * exclusion along every ledge in the room. Passability alone.
 */
function clearanceProbe(geo, cap = 512, cell = 512) {
  const segs = barrierSegments(geo).map(w => [w.x0, w.y0, w.x1, w.y1]);
  const bins = new Map();
  segs.forEach(([x0, y0, x1, y1], i) => {
    const cx0 = Math.floor(Math.min(x0, x1) / cell), cx1 = Math.floor(Math.max(x0, x1) / cell);
    const cy0 = Math.floor(Math.min(y0, y1) / cell), cy1 = Math.floor(Math.max(y0, y1) / cell);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const k = cx + ',' + cy; let b = bins.get(k); if (!b) bins.set(k, b = []); b.push(i);
    }
  });
  return (x, y) => {
    let best = cap;
    const cx0 = Math.floor((x - cap) / cell), cx1 = Math.floor((x + cap) / cell);
    const cy0 = Math.floor((y - cap) / cell), cy1 = Math.floor((y + cap) / cell);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const b = bins.get(cx + ',' + cy); if (!b) continue;
      for (const i of b) {
        const [x0, y0, x1, y1] = segs[i];
        const dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy;
        let t = L ? ((x - x0) * dx + (y - y0) * dy) / L : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const d = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
        if (d < best) { best = d; if (best === 0) return 0; }
      }
    }
    return best;
  };
}

/**
 * The point in a square a body could stand at, or null.
 *
 * `standPoint`'s algorithm with one word changed -- what counts as floor -- and the
 * objective deliberately left alone. Replacing the objective with "furthest from a wall"
 * was tried and it is wrong in the way standPoint's own comment warns about: it REWARDS a
 * point hard against the square's boundary whenever the neighbour is open, so the aim
 * drifts next door and the step lands there. Furthest-from-the-edge, counting outside the
 * square as edge, stays exactly as it was.
 */
// COORDINATE CONTRACT: the square is `(row,col)`; the result is named `{x,y}`
// in RoomGeometry's 1024-unit client BSP space.
function bodyStandPoint(geo, clearance, row, col, N = 9) {
  const x0 = (col - 1) * CLIENT_FINENESS, y0 = (row - 1) * CLIENT_FINENESS;
  const half = CLIENT_FINENESS / 2;
  const fits = (x, y) => geo._occupiable(x, y) && clearance(x, y) >= PLAYER_RADIUS;
  if (fits(x0 + half, y0 + half)) return { x: x0 + half, y: y0 + half };
  const step = CLIENT_FINENESS / N, floor = [];
  for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
    const x = x0 + Math.round((sx + 0.5) * step), y = y0 + Math.round((sy + 0.5) * step);
    if (fits(x, y)) floor.push({ x, y, sx, sy });
  }
  if (!floor.length) return null;
  const isFloor = new Set(floor.map(p => p.sx + ',' + p.sy));
  let best = floor[0], bestScore = -1;
  for (const p of floor) {
    let d = Infinity;
    for (let sy = -1; sy <= N; sy++) for (let sx = -1; sx <= N; sx++) {
      if (sx >= 0 && sx < N && sy >= 0 && sy < N && isFloor.has(sx + ',' + sy)) continue;
      const dd = Math.max(Math.abs(sx - p.sx), Math.abs(sy - p.sy));
      if (dd < d) d = dd;
    }
    const score = d * 1e6 - Math.hypot(p.x - (x0 + half), p.y - (y0 + half));
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return { x: best.x, y: best.y };
}

/**
 * Squares a body can reach from `seed` by single steps between standable points.
 *
 * One trace per step and NO re-aim: the eight-attempt retry in `_traceMoverStep` is exactly
 * what authorises the pocket, so a view whose job is to be conservative must not use it.
 */
export function bodyReachableFrom(geo, seeds) {
  // THE SEED DECIDES THE ANSWER, AND ONE SEED IS NOT ENOUGH -- the same lesson
  // `reachedFromBody` records a few lines above its own flood. Seeded from `mainSeed`
  // alone, Lake of Jala's Song answered 113 squares against 1826 permissive, because that
  // square is in a part of the lake this stricter view cannot leave. Seeded honestly it
  // answers 1694 and names the west crossing. So take the largest flood over the region
  // representatives, exactly as the permissive view does, and skip any representative an
  // earlier flood already covered -- if A is reachable from B then everything A reaches is
  // too, so A's set cannot be the larger one.
  const list = Array.isArray(seeds) ? seeds : seeds ? [seeds] : [];
  if (!geo?.collisionReady || !list.length) return new Set();
  const clearance = clearanceProbe(geo);
  const aim = new Map();
  const at = (r, c) => {
    const k = r + ',' + c;
    if (!aim.has(k)) aim.set(k, bodyStandPoint(geo, clearance, r, c));
    return aim.get(k);
  };
  const lands = (r, c, nr, nc) => {
    if (!geo.walkable(nr, nc)) return false;
    const A = at(r, c), B = at(nr, nc);
    if (!A || !B) return false;
    try {
      const t = geo.traceFineMoveClient(A.x, A.y, B.x, B.y, { slide: true });
      return !!t.arrived
        && Math.floor(t.x / CLIENT_FINENESS) + 1 === nc
        && Math.floor(t.y / CLIENT_FINENESS) + 1 === nr;
    } catch { return false; }
  };
  const floodFrom = (sr, sc) => {
    const seen = new Set([sr + ',' + sc]);
    const stack = [[sr, sc]];
    while (stack.length) {
      const [r, c] = stack.pop();
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr, nc = c + dc;
        if (nr < 1 || nc < 1 || nr > geo.rows || nc > geo.cols) continue;
        const k = nr + ',' + nc;
        if (seen.has(k) || !lands(r, c, nr, nc)) continue;
        seen.add(k); stack.push([nr, nc]);
      }
    }
    return seen;
  };
  // THE BODY IS THE REGION YOU CAN GET *TO*, NOT THE ONE YOU CAN GET *OUT OF*.
  //
  // "Largest flood wins" is the obvious rule and it is wrong here, because this relation is
  // DIRECTED. In Lake of Jala's Song the northwest corner is a one-way pocket: from inside
  // it you can walk out into the room, so a flood seeded there covers the pocket AND the
  // body -- 1738 squares against 1694 from the body itself -- and being the largest it won.
  // Which put 2,1 back in the answer, the very square this view exists to reject. Only
  // seeds inside the pocket (4,1, 7,1, 7,4, 10,7) ever reach it; no square in the room can.
  //
  // So a seed is judged by how many of the OTHER floods contain it. A square in the body is
  // reachable from all over the room; a square in a one-way pocket is reachable only from
  // itself. Pick the flood whose own seed is the most widely reachable, largest breaking
  // ties. That is seed-independent in the way "largest" is not.
  const floods = [];
  const covered = new Set();
  for (const sd of list) {
    const r = sd.r ?? sd.row, c = sd.c ?? sd.col;
    if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
    const k = r + ',' + c;
    if (covered.has(k)) continue;
    const set = floodFrom(r, c);
    for (const q of set) covered.add(q);
    floods.push({ k, set });
    if (floods.length >= 12) break;      // the tail is pockets; the bake is not a survey
  }
  if (!floods.length) return new Set();
  let best = floods[0], bestScore = -1;
  for (const f of floods) {
    const reachedFrom = floods.reduce((n, o) => n + (o.set.has(f.k) ? 1 : 0), 0);
    const score = reachedFrom * 1e7 + f.set.size;
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return best.set;
}

// DECLARED GUTTERS OVERRIDE THE DETECTOR, for the same reason declared fall jumps do.
//
// The detector below asks whether a square has lost exits relative to the room's body, and
// it answers on the collision model -- which has been too permissive all evening: it claims
// 49,45 and 39,16 in Ukgoth can still walk to the Castle Victoria door, and the operator,
// who has played the room, says they cannot. A model that cannot be told it is wrong is a
// model that stays wrong, so substrate/m59-gutters.json wins wherever it speaks.
//
// Additive and inert when absent: a room with no entry gets exactly the detector's answer,
// and a fresh clone with no file gets today's behaviour unchanged.
const GUTTER_FILE = join(REPO, 'substrate', 'm59-gutters.json');
let DECLARED_GUTTERS = null;
function declaredGutters(roomNum) {
  if (DECLARED_GUTTERS === null) {
    try { DECLARED_GUTTERS = JSON.parse(readFileSync(GUTTER_FILE, 'utf8')); }
    catch { DECLARED_GUTTERS = {}; }
  }
  const entry = DECLARED_GUTTERS[String(roomNum)];
  const rails = Array.isArray(entry?.rails) ? entry.rails : [];
  return rails
    .filter(r => Array.isArray(r.from) && Array.isArray(r.to)
                 && r.from.length === 2 && r.to.length === 2
                 && r.from.every(Number.isInteger) && r.to.every(Number.isInteger))
    .map(r => ({ row: r.from[0], col: r.from[1],
                 reaches: [{ row: r.to[0], col: r.to[1] }],
                 declared: true, why: r.why ?? null }));
}

/**
 * The squares a room's exits are used from.
 *
 * An edge exit is used from one of its approach squares — the model's own answer to "where
 * do you stand to cross this boundary". A `go` exit names its square outright. Both are
 * reduced to a square, because that is what a route ends at.
 */
export function exitAnchors(room, geometry,
                            { reachable = null, playerReachable = null,
                              bodyReachable = null } = {}) {
  const out = [];
  for (const e of room.edgeExits ?? []) {
    const dir = e.leaveName ?? null;
    if (!dir) continue;
    // A BOUNDARY PUBLISHES MANY STAGING SQUARES AND THEY ARE NOT INTERCHANGEABLE. This
    // took the first one offered and called that the exit, which is how room 578 came out
    // with all four of its exits "unreachable" while a character can plainly walk to three
    // of them — the first square on the list happened to be one the mover cannot get to,
    // and the other ten were never considered. `reachable` is the room's own body, so a
    // square it can walk to always beats a square merely printed first.
    // ASK PER EXIT, NOT PER DIRECTION — A WALL CAN LEAD TO TWO DIFFERENT ROOMS.
    //
    // `edgeApproachCandidates(dir)` answers "where can I cross this boundary", and a
    // boundary is frequently more than one exit. Western border of the Twisted Wood
    // declares east->586 `row < 19` AND east->597 `row > 20`: the same wall, split. Taking
    // the direction's first candidate gave BOTH exits the anchor 9,67, which satisfies
    // `row < 19` — so a character asked to walk to The Twisted Wood was sent to a square
    // that puts it in Main gate to Tos instead. Not a failure to arrive; arriving in the
    // WRONG ROOM, which nothing downstream would have reported as an error.
    //
    // `edgeCandidatesOf(room, e)` is the per-exit question and already exists: it runs
    // `selectedEdgeAt`, which simulates StandardLeaveDir's own ordered scan of
    // plEdge_Exits, so a candidate is kept only if crossing THERE actually fires THIS
    // exit. The world model has always used it; the bake reached past it to the raw list.
    // The operator's recorded crossings agree — 587 -> 597 is walked from row 47.
    // AND A THIRD PREFERENCE ABOVE BOTH, WHICH IS THE CLIPSWEEP FINDING PUT TO WORK.
    //
    // `reachable` is the room's body in the COLLISION view — the view that is too
    // permissive, and the one that walks 27 of the 28 squares of rock across the top of
    // Ukgoth. So "the body can reach this square" is satisfied by a square only a clip can
    // reach, and picking it bakes a doorway that works for a bot and not for a player.
    //
    // `playerReachable` is the coarse grid's main component: the map monsters move on,
    // which is too tight about individual tiles and does NOT invent a wall across the
    // middle of a room. A stage outside it is one no walking route reaches without crossing
    // ground the grid calls solid.
    //
    // Ukgoth is the case. Its north exit publishes 2,26 first and 1,27 second; 2,26 is a
    // ONE-SQUARE island in the coarse grid and 1,27 is in the main body of 1,679 — and 1,27
    // is the doorway the operator names. Preferring the coarse-connected stage is the whole
    // difference between the two.
    //
    // Ordered, never filtered: a stage that satisfies neither is still baked, because a
    // bake must never be the reason a doorway disappears.
    // AND A FOURTH PREFERENCE ABOVE ALL THREE: A STAGE A BODY CAN ACTUALLY GET TO.
    //
    // See `bodyReachableFrom`. Both sets below waved through Lake of Jala's Song's 2,1, a
    // pocket sealed in the wall, and the whole west boundary was staked on it. This asks
    // the conservative question instead and, in that room, walks past 2,1 to the crossing
    // at 9,1 that the operator names -- candidate 75 of 183 rather than 8.
    //
    // Ranked, not required, exactly like the two below it: a room whose strict view
    // collapses expresses no preference and keeps the answer it had. `strict` is recorded
    // so a reader can tell a chosen doorway from an inherited one.
    let strict = null, best = null, second = null, fallback = null;
    try {
      for (const a of edgeCandidatesOf(room, e)) {
        for (const stage of a.stages ?? []) {
          fallback ??= stage;
          const k = `${stage.row},${stage.col}`;
          const bodyOk = !reachable || reachable.has(k);
          const playerOk = !playerReachable || playerReachable.has(k);
          if (bodyReachable?.has(k) && bodyOk && playerOk) { strict = stage; break; }
          if (bodyOk && playerOk) best ??= stage;
          else if (bodyOk) second ??= stage;
        }
        if (strict) break;
      }
    } catch { /* an unbaked direction simply offers nothing */ }
    const chosen = strict ?? best ?? second ?? fallback;
    best = chosen;
    if (!best) continue;
    out.push({ kind: 'edge', dir, to: e.to, row: best.row, col: best.col,
               ...(strict ? { body_reachable: true } : {}) });
  }
  for (const g of room.goExits ?? []) {
    if (!Number.isInteger(g.row) || !Number.isInteger(g.col)) continue;
    out.push({ kind: 'go', to: g.to, row: g.row, col: g.col, locked: !!g.locked });
  }
  // TWO EXITS SHARING A SQUARE ARE ONE PLACE TO WALK TO AND STILL TWO EXITS.
  //
  // This used to drop the later one, which is right about the ROUTING — the pair share a
  // square so they share a path — and wrong about everything else, because the discarded
  // entry takes its `to` with it. Western border of the Twisted Wood declares east->586
  // AND east->597, both staging at 9,67; the table therefore had no anchor for 597 at all,
  // and a caller asking "where do I stand to reach The Twisted Wood" got nothing and fell
  // back to deriving one live — which is how a character ended up walking at a phantom.
  //
  // So every declared exit is kept, and the deduplication moves to where the cost actually
  // is: one BFS per DISTINCT SQUARE rather than per exit. Nothing is recomputed and
  // nothing is lost.
  return out;
}

/** The distinct squares among a set of anchors — one BFS each is all the work there is. */
export function anchorSquares(anchors) {
  const seen = new Map();
  for (const a of anchors) {
    const k = `${a.row},${a.col}`;
    if (!seen.has(k)) seen.set(k, { row: a.row, col: a.col });
  }
  return [...seen.values()];
}

// WHICH VIEW OF "CAN I STEP THERE" THE BAKE USES — AND THE CORRECTION THAT MADE THE
// STRICT ONE USABLE AT ALL.
//
// This file used to say the mover's own view could not be baked: on room 150 it refused
// 10% of grid-adjacent walkable pairs and broke every room into 109 to 214 disconnected
// regions, which is plainly not what a room is. That measurement was real and the
// conclusion drawn from it was wrong, because it was measuring the wrong predicate.
//
// `RoomGeometry.stepAllowedByCollision` asks whether the straight line between two square
// CENTRES arrives exactly, with no sliding. `Session.validateFineTarget` — the thing that
// actually decides whether a step happens — slides, quantizes toward the start, and cares
// only that the endpoint is IN the target square, because `walkTo` compares squares. The
// player is a disc of radius 248 in a square of 1024, so centres near walls are places
// nobody stands and a person walking that corridor never tries to.
//
// Asked the mover's real question (`RoomGeometry.moverStepLands`), the same rooms come out
// as rooms: 150 in 15 regions with 96% of it in one, 578 in TWO with 99.4% in one, 545 in
// 10 with 98.5% in one, against 159, 214 and 101 before. That is the difference between a
// routing table that shatters and one that can be planned on.
//
// So the mover's view is now the DEFAULT here and `--grid` asks for the old coarse one.
// The file records which view it used, because mixing the two silently would produce a
// table that is right about some rooms and confidently wrong about others with nothing on
// its face to say which.
// A REGION IS A SET OF SQUARES THAT CAN ALL REACH EACH OTHER, WHICH MEANS THIS HAS TO BE
// A STRONGLY CONNECTED COMPONENT AND NOT A FLOOD FILL.
//
// The mover's step graph is DIRECTED, and heavily so: measured on room 150, 2,606 of
// 23,219 adjacent pairs (11%) are one-way. That is not a modelling artifact — the stock
// client's wall test only blocks a move that gets CLOSER to a wall, so a square whose
// centre already lies inside a wall's radius is one a character can leave and cannot
// enter. There really are such squares and they really are one-way.
//
// THE DOZENS OF TINY REGIONS AGAINST THE WALLS ARE NOT NOISE — THEY ARE THE SAFE SPOTS.
// A room coming out in ninety pieces is ninety-odd real features: one big body of floor
// and a scatter of corners the BSP hems in. That is the same geometric fact the safe-spot
// book measures from the other side (`substrate/m59-safespots.json`, and the note in
// CLAUDE.md): a square whose lines to the surrounding floor are broken is a square whose
// line to a MONSTER is broken, and `Room.LineOfSight` is checked for the monster and never
// for us. Held rates run 28% at zero refused neighbours and 70% at four or more. So this
// pass is a safe-spot predictor as much as a routing one, and smoothing the pockets away
// to make the count look tidy would throw away the more valuable half.
//
// What was actually wrong with the old flood is narrower and matters for both uses: it
// labelled "everything reachable FROM here", so the answer depended on which square it
// happened to start from and it was not a partition — and it could not tell a pocket you
// can leave but not enter from one you can enter but not leave. Those are opposite facts.
// For routing, one is a trap and the other is a detour. For a safe spot, the one you can
// step into and out of is the one worth walking to. Tarjan keeps every pocket and
// distinguishes them; `sizes` is what says which is which.
//
// Iterative, because these rooms reach 8,639 walkable squares and recursion would not
// survive the Cragged Mountains.
export function components(geometry, { collision = true } = {}) {
  const { rows, cols } = geometry;
  const at = (r, c) => r * (cols + 2) + c;
  const label = new Int32Array((rows + 2) * (cols + 2)).fill(-1);
  const index = new Int32Array((rows + 2) * (cols + 2)).fill(-1);
  const low = new Int32Array((rows + 2) * (cols + 2)).fill(0);
  const onStack = new Uint8Array((rows + 2) * (cols + 2));
  const sccStack = [];
  const sizes = [];
  let counter = 0, next = 0;

  for (let r0 = 1; r0 <= rows; r0++) {
    for (let c0 = 1; c0 <= cols; c0++) {
      // `standable`, the same predicate `neighbors` plans with. Labelling only the coarse
      // grid's squares would leave every square the BSP adds unlabelled — outside every
      // region, and so "unreachable" to anything that asks whether two exits connect.
      if (!geometry.standable(r0, c0) || index[at(r0, c0)] !== -1) continue;
      // Each frame is one square plus how many of its neighbours have been dealt with.
      const work = [{ r: r0, c: c0, i: 0, ns: null }];
      while (work.length) {
        const frame = work[work.length - 1];
        const k = at(frame.r, frame.c);
        if (frame.i === 0) {
          index[k] = counter; low[k] = counter; counter++;
          sccStack.push(k); onStack[k] = 1;
          // The MOVER's neighbours, not the grid's — that is the whole point of the bake.
          frame.ns = geometry.neighbors(frame.r, frame.c, { collision });
        }
        if (frame.i < frame.ns.length) {
          const n = frame.ns[frame.i++];
          const nk = at(n.row, n.col);
          if (index[nk] === -1) work.push({ r: n.row, c: n.col, i: 0, ns: null });
          else if (onStack[nk]) low[k] = Math.min(low[k], index[nk]);
          continue;
        }
        work.pop();
        if (work.length) {
          const parent = at(work[work.length - 1].r, work[work.length - 1].c);
          low[parent] = Math.min(low[parent], low[k]);
        }
        if (low[k] === index[k]) {
          const id = next++;
          let size = 0, popped;
          do { popped = sccStack.pop(); onStack[popped] = 0; label[popped] = id; size++; }
          while (popped !== k);
          sizes.push(size);
        }
      }
    }
  }
  return { label, at, count: next, sizes };
}


// A STEP IS NOT ALWAYS ONE SQUARE, AND `coarseFloor` ONLY EVER CHECKED WHERE IT LANDED.
//
// `neighbors` returns moves of up to three squares — a mover packet carries distance, so a
// (-3,3) diagonal is one step, not three. The floor veto asked only whether the DESTINATION
// was ground, which lets a step take off from floor, fly over rock and land on floor. In a
// room whose BSP calls every square standable nothing else objects, so this is how a route
// crosses a wall while every square stored in it is walkable. Measured on 578's east route,
// after the string-pull was already fixed, four legs and all four of them multi-square:
//
//     28,49 -> 28,47   over 28,48
//     27,46 -> 24,43   over 26,45 25,44
//     15,29 -> 18,26   over 16,28 17,27
//     18,16 -> 18,13   over 18,15 18,14
//
// So the span is checked, not just the landing. Adjacent steps are unaffected — there is
// nothing between them — which is why this changes nothing in the 204 rooms whose fine
// geometry was carrying the veto already.
function coarseSpanClear(geometry, r, c, nr, nc) {
  const dr = nr - r, dc = nc - c;
  const n = Math.max(Math.abs(dr), Math.abs(dc));
  for (let k = 1; k <= n; k++) {
    const rr = r + Math.round(dr * k / n), cc = c + Math.round(dc * k / n);
    if (geometry.walkable(rr, cc) !== true) return false;
  }
  return true;
}

/** Shortest collision-valid path from one square to every other, as a came-from map. */
// `coarseFloor` adds back the one veto `neighbors` deliberately dropped, and it is NOT the
// return of "the coarse grid may refuse a step". It is narrower: the destination square has
// to be ground the server's grid agrees exists.
//
// WHY IT IS NEEDED AGAIN, AFTER BEING ARGUED AWAY. The reason the veto went is measured and
// still true — in 587 a person ran two steps the coarse grid calls impossible. The reason it
// is back is that `standable`, which was supposed to be the floor test that replaced it,
// ANSWERS YES TO EVERY SQUARE IN 70 OF THE 264 BAKED ROOMS. Ukgoth is one: all 4,686 of them.
// A predicate that cannot say no is not a floor test, and in those rooms the planner has been
// running with no floor test at all — which is how a route was baked through the rock faces
// of 599 and crossed four solid walls.
//
// So this is used as a PREFERENCE, never a veto: `bakeRoom` plans strictly first and keeps
// that path when one exists, and falls back to the permissive plan when it does not. 587
// keeps its corridor, because there the strict plan simply has no path and the fallback runs.
function bfs(geometry, fromRow, fromCol,
             { collision = true, coarseFloor = false, clearance = 0,
               preferProved = false, terminalKeys = null,
               allowedFallEdges = null } = {}) {
  const { cols } = geometry;
  const came = new Map();
  const key = (r, c) => r * (cols + 2) + c;
  const start = key(fromRow, fromCol);
  came.set(start, null);

  if (!clearance && !preferProved) {
    let frontier = [[fromRow, fromCol]];
    while (frontier.length) {
      const nextFrontier = [];
      for (const [r, c] of frontier) {
        for (const n of geometry.neighbors(r, c, { collision })) {
          if (coarseFloor && !coarseSpanClear(geometry, r, c, n.row, n.col)) continue;
          const k = key(n.row, n.col);
          if (came.has(k)) continue;
          came.set(k, { row: r, col: c, dir: n.dir });
          nextFrontier.push([n.row, n.col]);
        }
      }
      frontier = nextFrontier;
    }
    return { came, key };
  }

  // KEEP A SQUARE OFF THE WALL WHERE THE ROOM ALLOWS IT.
  //
  // An unweighted BFS returns A shortest path, and among the shortest it returns whichever
  // it happened to expand first — which is routinely the one scraping the inside of a
  // corner, because that is the shortest. Watched live in Ukgoth: runners ground along the
  // corner at 29,50, lost speed to it, and took extra hits from the trolls they were
  // running past for as long as they were stuck on it.
  //
  // The fix is not a different path, it is a PREFERENCE. A square with all eight neighbours
  // walkable costs 1; one with a wall against it costs 1 + `clearance`. So the search takes
  // a detour of up to `clearance` squares to avoid hugging, and still goes through the tight
  // place when the room offers nothing else — which is what "wherever possible" has to mean
  // in a corridor two squares wide.
  //
  // Costs are small integers, so this is a bucket queue rather than a heap: no comparator,
  // no library, and it stays O(edges) the way the BFS it replaces was.
  const dist = new Map([[start, 0]]);
  // A NO-SLIDE TRACE IS A PREFERENCE, NEVER AN AUTHORITY OVER REACHABILITY.
  //
  // `moverStepLands` deliberately accepts a slid endpoint anywhere inside the requested
  // square. That is the right answer for one move and it does not compose: the next baked
  // edge is tested from that square's ideal stand point, not from the off-centre point the
  // previous edge actually reached. In room 578 this made r47c14 -> r46c15 -> r45c16 look
  // like an ordinary route through a wall even though the first direct trace hits wall 679.
  //
  // This pass asks the stricter question only to order routes. The penalty is larger than
  // the maximum base cost of a simple path through the room, so unproved ordinary edges are
  // minimized first and clearance/length break ties. The caller still compares the finished
  // candidate with stringPull and keeps it only when measured non-terminal, non-fall risk is
  // strictly lower, total unverified evidence does not rise, exact fall identities are not
  // expanded, and the detour stays bounded. Falls are already proved by
  // `fallTargets(..., { fall:true })`; they are neither penalized nor reversed here.
  const proofPenalty = preferProved
    ? geometry.rows * geometry.cols * (1 + Math.max(0, clearance)) + 1
    : 0;
  const roomy = (r, c) => {
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        if (geometry.walkable(r + dr, c + dc) !== true) return false;
      }
    return true;
  };
  const visit = (d, r, c, enqueue) => {
    if (dist.get(key(r, c)) !== d) return;          // superseded by a cheaper way here
    for (const n of geometry.neighbors(r, c, { collision })) {
      if (n.fall && allowedFallEdges
          && !allowedFallEdges.has(`${r},${c}>${n.row},${n.col}`)) continue;
      if (coarseFloor && !coarseSpanClear(geometry, r, c, n.row, n.col)) continue;
      const k = key(n.row, n.col);
      // A refusal on the LAST leg has no later ideal-centre assumption to invalidate. All
      // anchor destinations are exempt here so one one-to-many search can honour that
      // target-specific fact; the finished candidate's exact stringPull evidence remains
      // the adoption authority if a path happens to pass through another anchor en route.
      const unproved = preferProved && !n.fall && !terminalKeys?.has(k)
        && geometry.stepAllowedByCollision(r, c, n.row, n.col) !== true;
      const cost = d + 1 + (roomy(n.row, n.col) ? 0 : clearance)
        + (unproved ? proofPenalty : 0);
      const seen = dist.get(k);
      if (seen !== undefined && seen <= cost) continue;
      dist.set(k, cost);
      came.set(k, { row: r, col: c, dir: n.dir });
      enqueue(cost, n.row, n.col);
    }
  };

  if (!preferProved) {
    const buckets = [[[fromRow, fromCol]]];
    for (let d = 0; d < buckets.length; d++) {
      const bucket = buckets[d];
      if (!bucket) continue;
      while (bucket.length) {
        const [r, c] = bucket.pop();
        visit(d, r, c, (cost, nr, nc) => (buckets[cost] ??= []).push([nr, nc]));
      }
    }
  } else {
    // The proof penalty is intentionally much larger than the ordinary bucket costs. A
    // sparse bucket array would therefore make its highest INDEX proportional to the
    // number of unproved edges, even though only O(squares) entries exist. Keep the same
    // numeric ordering in a tiny binary heap instead.
    const heap = [[0, fromRow, fromCol]];
    const push = item => {
      let i = heap.push(item) - 1;
      while (i) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= item[0]) break;
        heap[i] = heap[p]; i = p;
      }
      heap[i] = item;
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        let i = 0;
        while (true) {
          let child = i * 2 + 1;
          if (child >= heap.length) break;
          if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0]) child++;
          if (heap[child][0] >= last[0]) break;
          heap[i] = heap[child]; i = child;
        }
        heap[i] = last;
      }
      return top;
    };
    while (heap.length) {
      const [d, r, c] = pop();
      visit(d, r, c, (cost, nr, nc) => push([cost, nr, nc]));
    }
  }
  return { came, key };
}

// How far out of its way the strict plan will go to keep a square between itself and a wall.
// Three: measured against 2 (which still hugged two of the four Ukgoth corners) and 5 (which
// started taking visibly silly detours in open ground for no gain).
const CLEARANCE_PENALTY = Number(process.env.M59_ROUTE_CLEARANCE ?? 3);

const LETTER = new Map(STEP_DIRS.map(([ch, dr, dc]) => [`${dr},${dc}`, ch]));

function pathString(came, key, fromRow, fromCol, toRow, toCol) {
  const steps = [];
  let r = toRow, c = toCol;
  for (;;) {
    const prev = came.get(key(r, c));
    if (prev === undefined) return null;          // unreachable
    if (prev === null) break;                     // reached the start
    // A JUMP IS WRITTEN INLINE, NOT IN A SEPARATE TABLE.
    //
    // The eight letters cover every unit step and nothing else, so a route containing a
    // FALL — Ukgoth's cliff is row 36,col 16 to row 38,col 10, two rows and six columns in
    // one move — could not be spelled and was dropped WHOLE. Room 599 has three anchors,
    // six ordered pairs between them, and exactly one baked route; the crossing a traveller
    // actually needs was reachable, unspellable, and therefore absent.
    //
    // The first fix here put those pairs in a separate squares-only table, which made the
    // two encodings alternatives — and they are not. A real route is mostly ordinary steps
    // WITH a jump in the middle of it, so one string has to be able to say both. `(dr,dc)`
    // is that: every old string still decodes unchanged, and a jump costs a few bytes where
    // it occurs instead of costing the route its place in the table.
    const dr = r - prev.row, dc = c - prev.col;
    const ch = LETTER.get(`${dr},${dc}`) ?? `(${dr},${dc})`;
    steps.push(ch);
    r = prev.row; c = prev.col;
    if (r === fromRow && c === fromCol) break;
  }
  return steps.reverse().join('');
}

// THE BLINK POINT, IF THE KOD DECLARED ONE. Read lazily and tolerated when absent: a clone
// without a Meridian 59 source tree has no substrate/m59-blink.json and must still bake.
let BLINK_BOOK = undefined;
function blinkPointFor(roomNum) {
  if (BLINK_BOOK === undefined) {
    try {
      const f = new URL('../substrate/m59-blink.json', import.meta.url);
      BLINK_BOOK = JSON.parse(readFileSync(f, 'utf8')).rooms ?? {};
    } catch { BLINK_BOOK = {}; }
  }
  return BLINK_BOOK[roomNum] ?? BLINK_BOOK[String(roomNum)] ?? null;
}

/** Bake one room. */
export function bakeRoom(room, { collision = true, preferCoarseFloor = true } = {}) {
  let strictRoutes = 0;
  const geometry = sharedRoomGeometry(room);
  if (!geometry?.collisionReady)
    return { room: room.num, skipped: 'no collision geometry' };
  // THE MASK FIRST, BECAUSE EVERYTHING ELSE HERE IS THEN A LOOKUP. Attaching it makes
  // `neighbors({collision:true})` an array index for the component pass and every BFS
  // below, instead of eight traces a square repeated by each of them.
  const mask = collision ? geometry.buildStepMask() : null;
  if (mask) geometry.attachStepMask(mask);
  const comp = components(geometry, { collision });
  // THE ROOM ITSELF IS THE BIGGEST REGION AND EVERY OTHER ONE IS A POCKET — but "outside
  // the main region" is NOT the same as "cannot be walked to", and conflating the two is
  // the trap this bake nearly shipped. An exit anchor is usually a pocket by design: you
  // step into the doorway and you cannot step back off it into the room. So what a
  // consumer needs is one-directional — can the body of the room REACH this square —
  // which is one flood from any square of the main region, not an equality test.
  //
  // Computed BEFORE the anchors, because choosing which staging square on a boundary is
  // "the exit" is exactly the decision that needs this answer.
  // THE BIGGEST STRONGLY CONNECTED SET IS NOT THE ROOM, AND IN WEST JASPER IT IS A TRAP.
  //
  // `components` is Tarjan, so a region here is a set of MUTUALLY reachable squares, which is
  // the right definition. Picking the largest one as "the room" is the part that is wrong,
  // because a one-way ledge inside the body splits it into several SCCs while a dead-end
  // pocket above the ledge stays whole. West Jasper measured, 2,669 walkable squares:
  //
  //     largest SCC                          795 squares, and 34 of 35 exits "stranded"
  //     forward reach from the inn doorway  1,464 squares, and 6 of 6 other doors
  //     forward reach from the north edge     795 squares, and 0 of 6 other doors
  //
  // The 795 IS the north-edge pocket -- a body that walks in from Sweet Grass Prairies can
  // reach no exit at all -- and the bake crowned it the room and called every real door
  // unreachable. What `reachedFromBody` is asked for is one-directional ("can the body of the
  // room reach this square"), so the honest seed is simply whichever square reaches the most,
  // not whichever mutual clique is biggest.
  //
  // Cheap despite looking quadratic: candidates are one square per SCC, largest first, and
  // any candidate already inside an earlier flood is SKIPPED -- if A is reachable from B then
  // everything A reaches is reachable from B, so A's set cannot be the larger one and cannot
  // be lost by skipping it.
  const floodFrom = (r, c) => {
    const seen = new Set([`${r},${c}`]);
    const stack = [{ r, c }];
    while (stack.length) {
      const at = stack.pop();
      for (const n of geometry.neighbors(at.r, at.c, { collision })) {
        const k = `${n.row},${n.col}`;
        if (seen.has(k)) continue;
        seen.add(k);
        stack.push({ r: n.row, c: n.col });
      }
    }
    return seen;
  };
  const reps = [];
  {
    const seenLabel = new Set();
    for (let r = 1; r <= geometry.rows; r++)
      for (let c = 1; c <= geometry.cols; c++) {
        if (!geometry.standable(r, c)) continue;
        const id = comp.label[comp.at(r, c)];
        if (id < 0 || seenLabel.has(id)) continue;
        seenLabel.add(id);
        reps.push({ r, c, id, size: comp.sizes[id] ?? 0 });
      }
    reps.sort((x, y) => y.size - x.size);
  }
  let mainSeed = null, mainRegion = -1, mainSize = 0;
  let reachedFromBody = new Set();
  {
    const covered = new Set();
    for (const rep of reps) {
      if (covered.has(`${rep.r},${rep.c}`)) continue;
      const set = floodFrom(rep.r, rep.c);
      for (const k of set) covered.add(k);
      if (set.size > reachedFromBody.size) {
        reachedFromBody = set;
        mainSeed = { r: rep.r, c: rep.c };
        mainRegion = rep.id;
      }
    }
    // `main_region_squares` now means what every consumer already read it as: how much of the
    // room the body can actually walk to. It used to mean the size of a mutual clique, which
    // is a different and much less useful number.
    mainSize = reachedFromBody.size;
  }

  // The coarse grid's own main component — see `playerReachable` in exitAnchors. Computed
  // here rather than passed in because it is one flood fill over squares already in memory,
  // and the bake is the only caller that needs it.
  const coarseBody = (() => {
    const seen = new Map(); let id = 0, best = -1, bestId = -1;
    for (let r = 0; r <= geometry.rows; r++) for (let c = 0; c <= geometry.cols; c++) {
      if (!geometry.walkable(r, c) || seen.has(`${r},${c}`)) continue;
      const stack = [[r, c]]; seen.set(`${r},${c}`, id); let n = 0;
      while (stack.length) {
        const [a, b] = stack.pop(); n++;
        for (const nb of geometry.neighbors(a, b, { collision: false })) {
          if (!geometry.walkable(nb.row, nb.col)) continue;
          const k = `${nb.row},${nb.col}`;
          if (seen.has(k)) continue;
          seen.set(k, id); stack.push([nb.row, nb.col]);
        }
      }
      if (n > best) { best = n; bestId = id; }
      id++;
    }
    const out = new Set();
    for (const [k, v] of seen) if (v === bestId) out.add(k);
    return out;
  })();
  // Seeded from the same square the permissive flood found most of the room from, so the
  // two views are answering about the same room rather than about two different corners.
  const bodyReachable = bodyReachableFrom(geometry, [mainSeed, ...reps].filter(Boolean));
  const anchors = exitAnchors(room, geometry,
    { reachable: reachedFromBody, playerReachable: coarseBody, bodyReachable });
  const regionOf = a => comp.label[comp.at(a.row, a.col)];
  const tagged = anchors.map(a => ({ ...a, region: regionOf(a),
                                     from_body: reachedFromBody.has(`${a.row},${a.col}`) }));
  const strandedExits = tagged.filter(a => !a.from_body).length;

  // ONE BFS PER ANCHOR, AND NO SAME-REGION FILTER ON IT.
  //
  // This used to skip any pair of anchors in different regions, which was right when a
  // region was a flood fill and is wrong now that it is a strongly connected component:
  // an exit square is very often a POCKET ON PURPOSE — you can step onto it and you cannot
  // step back off it into the room, because that is what standing in a doorway is. Under
  // mutual reachability every one of room 578's four exits sits outside the main body, and
  // filtering on that would have baked no routes to any of them.
  //
  // The BFS already answers the only question that matters — is there a way from here to
  // there — so it is simply asked, and a pair with no path silently produces no entry.
  // ONE BFS PER DISTINCT SQUARE, not per exit — see anchorSquares. Two exits on one
  // square asked the same question twice.
  const squares = anchorSquares(tagged.filter(a => a.region >= 0));

  // BLINK IS A ONE-WAY PORTAL AND EVERY ROOM HAS ONE — see tools/m59-blink.mjs.
  //
  // `blink.kod` teleports the caster to viTeleport_row/col, a fixed square declared per room,
  // from ANYWHERE in the room. So every exit that square can walk to is reachable from
  // anywhere a character can cast, whatever ledge it walked itself into. In West Jasper that
  // is the difference between one door and all seven; measured across the whole map it makes
  // a difference in 8 rooms and none at all in the rest, which is the expected shape.
  //
  // KEPT APART FROM WALKING, DELIBERATELY. It costs mana, a character may have to rest to
  // afford it, and a cast can fail and need repeating — so this is never merged into `reach`,
  // which is what the router plans on. A caller that has run out of walking answers can ask
  // for this one; nothing gets it by accident.
  const blinkAt = blinkPointFor(room.num);
  const blink = (() => {
    if (!blinkAt || !geometry.walkable(blinkAt.row, blinkAt.col)) return null;
    const from = floodFrom(blinkAt.row, blinkAt.col);
    return { row: blinkAt.row, col: blinkAt.col, squares: from.size,
             reaches: squares.filter(q => from.has(`${q.row},${q.col}`))
                        .map(q => `${q.row},${q.col}`).sort() };
  })();

  const routes = {};
  const pivots = {};
  // WHETHER A PAIR IS JOINED AT ALL, RECORDED SEPARATELY FROM THE ROUTE BETWEEN THEM.
  //
  // Those were the same fact until a jump appeared in one. `pathString` encodes a route as
  // one letter per step, in `STEP_DIRS`, which is the eight unit directions — and a fall is
  // a single move of two or three squares. `LETTER.get('3,-3')` is undefined, `pathString`
  // returns null, and the pair silently produces no entry: the BFS reached it, the bake
  // dropped it, and `bakedPath` — which m59-world.mjs reads as "can walking join these two
  // exits" — answered no.
  //
  // Found in Ukgoth, and it is exactly the room where it costs the most. The route from the
  // Castle Victoria doorway to the Sentinel doorway is 83 steps and its FIRST move is a
  // fall, 2,26 -> 5,23. So the transit check refused a crossing the mover can make, and
  // m59-routing-test's "the directed answer still offers the way that works" went red the
  // moment the north anchor moved off the rock island onto the real door.
  //
  // `reach` is the honest half: a BFS answer, kept whether or not the steps can be spelled.
  // `routes` and `pivots` stay exactly as they were — a caller wanting the SQUARES still
  // gets null and still has to work them out — and `unspellable` counts what was dropped,
  // because a bake that quietly omits a thing is how this went unnoticed.
  const reach = {};
  let unspellable = 0;
  const pulledRoute = (from, p) => {
    try {
      const steps = replay(from.row, from.col, p);
      const pts = [{ row: from.row, col: from.col }, ...steps]
        .map(s => ({ x: (s.col - 0.5) * CLIENT_FINENESS,
                     y: (s.row - 0.5) * CLIENT_FINENESS }));
      // ON THE COARSE GRID TOO. The trace alone proves nothing in a room whose BSP
      // calls every square standable, and those are exactly the rooms this fleet dies
      // in. See RoomGeometry.stringPull for the measurement.
      const pulled = geometry.stringPull(pts, { onWalkable: true });
      const fallEdges = new Set();
      let prev = from;
      for (const step of steps) {
        if (Math.abs(step.row - prev.row) > 1 || Math.abs(step.col - prev.col) > 1)
          fallEdges.add(`${prev.row},${prev.col}>${step.row},${step.col}`);
        prev = step;
      }
      // SERIALIZED CONTRACT: route-table pivot arrays are `[row,col]`.
      const squares = pulled.points.map(pt =>
        [Math.round(pt.y / CLIENT_FINENESS - 0.5) + 1,
         Math.round(pt.x / CLIENT_FINENESS - 0.5) + 1]);
      return {
        pivot: {
          squares,
          unverified: pulled.unverified,
        },
        proved: pulled.proved ?? [],
        risk: compositionRisk(pulled.proved, squares),
        steps: steps.length,
        fallEdges,
      };
    } catch { return null; }
  };
  for (const from of squares) {
    const targets = squares.filter(t => t.row !== from.row || t.col !== from.col);
    if (!targets.length) continue;
    const { came, key } = bfs(geometry, from.row, from.col, { collision });
    // The strict plan is computed alongside and preferred wherever it arrives. `reach` stays
    // the permissive answer, because whether a place can be got to at all is a different
    // question from which line we would rather walk to it.
    const strict = preferCoarseFloor
      ? bfs(geometry, from.row, from.col,
            { collision, coarseFloor: true, clearance: CLEARANCE_PENALTY })
      : null;
    // One search per exact set of directed falls the established routes already use. A
    // candidate never earns permission to introduce a different jump merely because falls
    // carry no no-slide penalty.
    const proofFirst = new Map();                  // expensive and needed only after evidence
    const terminalKeys = new Set(targets.map(t => key(t.row, t.col)));
    for (const to of targets) {
      const pair = `${from.row},${from.col}>${to.row},${to.col}`;
      if (came.has(key(to.row, to.col))) reach[pair] = 1;
      let p = null;
      let usedStrict = false;
      if (strict && strict.came.has(strict.key(to.row, to.col))) {
        p = pathString(strict.came, strict.key, from.row, from.col, to.row, to.col);
        usedStrict = p != null;
      }
      if (p == null) p = pathString(came, key, from.row, from.col, to.row, to.col);
      if (p == null) { if (reach[pair]) unspellable++; continue; }

      // AND THE PIVOTS, WHICH ARE WHAT A WALKER SHOULD ACTUALLY BE GIVEN.
      //
      // A square-by-square route reproduces the failure the whole bake exists to avoid:
      // stepping between square CENTRES runs an axis-aligned move into wall faces that
      // are 54.9% non-axis-aligned in these rooms, and measured on 587 that refuses 218
      // of 311 steps — 200 of them without moving the character at all.
      //
      // `stringPull` reaches as far along the route as the straight line still ARRIVES
      // with `slide:false`, which is stricter than the ordinary mover. Doing it HERE
      // rather than at walk time is the point of a bake: every leg is proved before any
      // character walks it, once, offline, instead of being rediscovered per journey.
      // `unverified` counts the legs it could not prove — a route that is mostly those is
      // one the walker will still struggle with, and the table should say so rather than
      // let it be inferred.
      let evidence = pulledRoute(from, p);

      // A slid unit edge is valid on its own but its off-centre landing does not compose
      // with the next edge, which starts at the ideal centre again. Only pay for a second
      // search once the final string-pull evidence says the preferred route has such a
      // gap. A final unproved leg is harmless: there is no following leg that assumes its
      // slid landing was the ideal square centre. `compositionRisk` therefore ignores it,
      // and a route with no non-terminal risk is left byte-for-byte alone.
      //
      // The candidate keeps the coarse-floor preference and no more directed falls than
      // the established route. Evidence, not the search's proxy, decides. A global detour
      // bound permits at most one room diameter of extra raw steps and pivots for each risky
      // leg removed; that admits 578's real reverse corridor without turning a one-square
      // terminal slide into a room-scale tour.
      if (preferCoarseFloor && evidence?.risk > 0) {
        const searchKey = [...evidence.fallEdges].sort().join('|');
        if (!proofFirst.has(searchKey)) {
          proofFirst.set(searchKey, bfs(geometry, from.row, from.col, {
            collision, coarseFloor: true, clearance: CLEARANCE_PENALTY, preferProved: true,
            terminalKeys, allowedFallEdges: evidence.fallEdges,
          }));
        }
        const proof = proofFirst.get(searchKey);
        if (proof.came.has(proof.key(to.row, to.col))) {
          const candidate = pathString(proof.came, proof.key,
                                       from.row, from.col, to.row, to.col);
          const candidateEvidence = candidate == null ? null : pulledRoute(from, candidate);
          const saved = candidateEvidence ? evidence.risk - candidateEvidence.risk : 0;
          const detour = saved * Math.max(geometry.rows, geometry.cols);
          if (candidateEvidence && saved > 0
              && candidateEvidence.pivot.unverified <= evidence.pivot.unverified
              && [...candidateEvidence.fallEdges].every(edge => evidence.fallEdges.has(edge))
              && candidateEvidence.steps <= evidence.steps + detour
              && candidateEvidence.pivot.squares.length <= evidence.pivot.squares.length + detour) {
            p = candidate;
            evidence = candidateEvidence;
            usedStrict = true;
          }
        }
      }

      routes[pair] = p;
      if (usedStrict) strictRoutes++;
      if (evidence) pivots[pair] = evidence.pivot;
    }
  }

  // ============================== GUTTERS ==============================
  //
  // A GUTTER IS A PLACE YOU FALL INTO AND CANNOT CLIMB OUT OF. The operator named it, and
  // named the case: Ukgoth's basin, below the declared jump at 36,16 -> 38,10. "There's
  // nowhere else valid to go in Ukgoth once you've missed the Ukgoth jump" -- the only move
  // is out through 589 and the long way round, 589 -> 579 -> 578 -> 587, back to Ukgoth to
  // try the jump again.
  //
  // Measured: from 58,29 a character reaches 319 squares. The 589 door at 71,2 is one of
  // them. The Castle Victoria door at 1,27 and the Sentinel door at 1,66 are NOT. The body
  // can fall in; nothing walks back out.
  //
  // Every route above is baked ANCHOR TO ANCHOR, so a character down there asks for a line
  // to 71,2, is told "no baked line to the anchor", and stops. Seven of thirteen deaths in
  // one 30-minute run were in Ukgoth, every health trail the same shape -- a body pinned at
  // a low number that stops changing. They were not being killed by a hard road. They were
  // standing in a hole with no way out written down.
  //
  // So: one rail per gutter, from a square inside it to every anchor it CAN reach. Nothing
  // else changes -- anchor-to-anchor is untouched, and a region that can walk home is not a
  // gutter and gets nothing.
  //
  // BOUNDED, because a room has as many regions as it has corners. Only components big
  // enough to strand somebody are considered, and only a few per room: the world has 9,375
  // pockets and almost all of them are two squares behind a rock.
  const GUTTER_MIN_SQUARES = 24;
  const GUTTER_LIMIT = 6;
  const gutters = [];
  {
    // WHICH EXITS CAN THIS SQUARE STILL GET TO — asked of every square at once.
    //
    // Walking the strongly connected components missed the case entirely: a basin walled by
    // one-way ledges is mostly SINGLETONS, so the very square the operator's characters were
    // standing on had a component of one and was skipped, while its forward reach is 319
    // squares. Components describe shape; a gutter is about lost options.
    //
    // So the edges are reversed once and flooded from each anchor. That gives, for every
    // square, the set of exits it can still reach -- three floods for a room, not thousands.
    // A square whose set is a PROPER SUBSET of the body's is in a gutter: it is still
    // somewhere, but not everywhere it should be. Group by that set, and each group gets one
    // rail from its deepest square to the exits it has left.
    const back = new Map();                       // "r,c" -> array of squares that step INTO it
    for (let r = 1; r <= geometry.rows; r++)
      for (let cc = 1; cc <= geometry.cols; cc++) {
        if (!geometry.standable(r, cc)) continue;
        for (const n of geometry.neighbors(r, cc, { collision })) {
          const k = `${n.row},${n.col}`;
          const list = back.get(k); if (list) list.push([r, cc]); else back.set(k, [[r, cc]]);
        }
      }
    const reachesAnchor = new Map();              // "r,c" -> Set of anchor keys it can reach
    for (const a of squares) {
      const seedKey = `${a.row},${a.col}`;
      const seen = new Set([seedKey]);
      const stack = [seedKey];
      while (stack.length) {
        const cur = stack.pop();
        for (const [pr, pc] of back.get(cur) ?? []) {
          const k = `${pr},${pc}`;
          if (seen.has(k)) continue;
          seen.add(k); stack.push(k);
        }
      }
      for (const k of seen) {
        const set = reachesAnchor.get(k); if (set) set.add(seedKey);
        else reachesAnchor.set(k, new Set([seedKey]));
      }
    }
    const anchorKeys = new Set(squares.map(q => `${q.row},${q.col}`));
    const bodySig = reachesAnchor.get(mainSeed ? `${mainSeed.r},${mainSeed.c}` : '') ?? new Set();
    const groups = new Map();                     // signature -> squares carrying it
    for (const [k, set] of reachesAnchor) {
      if (anchorKeys.has(k)) continue;
      if (set.size === 0 || set.size >= bodySig.size) continue;   // loses nothing
      let subset = true;
      for (const a of set) if (!bodySig.has(a)) { subset = false; break; }
      if (!subset) continue;                      // reaches something the body cannot: not a loss
      const sig = [...set].sort().join('|');
      const g = groups.get(sig); if (g) g.push(k); else groups.set(sig, [k]);
    }
    for (const [sig, members] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      if (gutters.length >= GUTTER_LIMIT) break;
      if (members.length < GUTTER_MIN_SQUARES) continue;
      // The rail starts from the square FURTHEST from the exits it has left, because that is
      // the one a character is most likely to be standing on and least able to leave.
      const targets = sig.split('|').map(s => { const [r, c] = s.split(',').map(Number); return { row: r, col: c }; });
      let deepest = members[0], best = -1;
      for (const m of members) {
        const [r, c] = m.split(',').map(Number);
        const d = Math.min(...targets.map(t => Math.max(Math.abs(t.row - r), Math.abs(t.col - c))));
        if (d > best) { best = d; deepest = m; }
      }
      const [gr, gc] = deepest.split(',').map(Number);
      gutters.push({ row: gr, col: gc, squares: members.length, reaches: targets });
    }
  }
  // The operator's rails, added to whatever the detector found. A declared head that the
  // detector also found is kept once -- the declaration carries the `why`, so it wins.
  //
  // TWO RAILS OUT OF ONE HEAD IS TWO DESTINATIONS, NOT A CORRECTION.
  //
  // `declaredGutters` returns one record per DECLARED RAIL, each carrying a single-element
  // `reaches`, and this merged them by spreading the later record over the earlier one. So
  // a head with three rails kept only the LAST -- silently, with the file's own `_shape`
  // line promising that "each entry bakes one route from `from` to `to`". Declaring
  // 8,33 -> 1,13 / 49,12 / 35,1 for the Cragged Mountains produced exactly one route,
  // `8,33>35,1`, and the northbound line the head was added for was simply absent from the
  // table. Ukgoth never showed it because its four rails happen to have four distinct
  // heads; a second rail off 67,15 would have vanished the same way.
  //
  // `reaches` is a SET of destinations, so it is unioned. Everything else about the record
  // -- `why`, `declared` -- is still last-wins, which is what a later line in a hand-edited
  // file should mean, and `squares` stays the detector's count because a declaration says
  // where the head is and not how big the pocket is.
  const sameSquare = (a, b) => a.row === b.row && a.col === b.col;
  for (const d of declaredGutters(room.num)) {
    const i = gutters.findIndex(g => `${g.row},${g.col}` === `${d.row},${d.col}`);
    if (i < 0) { gutters.push({ ...d, squares: null }); continue; }
    const merged = [...(gutters[i].reaches ?? [])];
    for (const to of d.reaches ?? [])
      if (!merged.some(x => sameSquare(x, to))) merged.push(to);
    gutters[i] = { ...gutters[i], ...d, reaches: merged, squares: gutters[i].squares };
  }
  for (const g of gutters) {
    const { came, key } = bfs(geometry, g.row, g.col, { collision });
    const strict = preferCoarseFloor
      ? bfs(geometry, g.row, g.col, { collision, coarseFloor: true, clearance: CLEARANCE_PENALTY })
      : null;
    for (const to of g.reaches) {
      const pair = `${g.row},${g.col}>${to.row},${to.col}`;
      if (came.has(key(to.row, to.col))) reach[pair] = 1;
      let p = null;
      if (strict && strict.came.has(strict.key(to.row, to.col))) {
        p = pathString(strict.came, strict.key, g.row, g.col, to.row, to.col);
        if (p != null) strictRoutes++;
      }
      if (p == null) p = pathString(came, key, g.row, g.col, to.row, to.col);
      if (p == null) { if (reach[pair]) unspellable++; continue; }
      routes[pair] = p;
    }
  }

  return {
    room: room.num,
    rows: geometry.rows, cols: geometry.cols,
    // ONE BYTE A SQUARE, ONE BIT A DIRECTION, in `STEP_MASK_DIRS` order — the whole of
    // `moverStepLands`, so the runtime never has to trace. 510,789 squares across 264
    // rooms is 0.49 MB raw and 0.65 MB base64; the trace it replaces cost 1.2s on one
    // cold path and took twelve characters out of the world. See RoomGeometry.buildStepMask.
    ...(mask ? { stepMask: Buffer.from(mask).toString('base64') } : {}),
    security: geometry.security ?? null,
    view: collision ? 'collision' : 'grid',
    regions: comp.count,
    main_region: mainRegion,
    main_region_squares: mainSize,
    ...(blink ? { blink } : {}),
    walkable: comp.sizes.reduce((n, s) => n + s, 0),
    // Every region that is not the room proper, smallest first. These are the corners the
    // BSP hems in — the safe-spot candidates — and a one-square one is the strongest.
    pockets: comp.sizes.filter((_, id) => id !== mainRegion).length,
    stranded_exits: strandedExits,
    // Anchor pairs the BFS joined, including the ones whose steps cannot be spelled — see
    // the note above `reach`. `unspellable` is how many of those there were.
    reach,
    ...(unspellable ? { unspellable } : {}),
    // How many routes came from the strict plan rather than the permissive one. A room that
    // reports 0 here is one where the coarse grid could not connect its exits at all.
    ...(strictRoutes ? { strict_routes: strictRoutes } : {}),
    // `from_body` is the one a router should read: can the room walk to this exit. `region`
    // is kept beside it because a pocket exit and a main-body exit behave differently once
    // you are standing on one — the first cannot be stepped back off.
    // `body_reachable` records WHICH VIEW CHOSE this square: present means the conservative
    // one named it, absent means that view had nothing to say here and the square is the one
    // the older tiers picked. It is the only way to tell a doorway this bake reasoned about
    // from one it inherited, which is exactly what has to be auditable after a bake changes
    // where twenty-one characters walk.
    anchors: tagged.map(a => ({ kind: a.kind, dir: a.dir ?? null, to: a.to ?? null,
                                row: a.row, col: a.col, region: a.region,
                                from_body: !!a.from_body,
                                ...(a.body_reachable ? { body_reachable: true } : {}) })),
    routes,
    // GUTTERS — see the block that bakes them. A place the room can drop you into and not
    // walk you out of, with the anchors it CAN still reach. Recorded because "why is there a
    // rail from the middle of a room" is a fair question, and because a room growing a new
    // gutter is a fact about the map worth noticing rather than a line in a route table.
    ...(gutters.length ? { gutters: gutters.map(g => ({ row: g.row, col: g.col, squares: g.squares,
                                                       reaches: g.reaches.map(q => `${q.row},${q.col}`) })) } : {}),
    // The same routes as verified PIVOTS. See where these are built: a walker given
    // squares re-discovers the off-plan problem; a walker given pivots does not.
    pivots,
  };
}


/**
 * The order to bake rooms in: the ones the fleet actually stands in, first.
 *
 * A PARTIAL TABLE IS USEFUL IN PROPORTION TO WHICH ROOMS ARE IN IT, and until now the
 * order was `Object.values(map.rooms)`, i.e. whatever the map happened to list. That makes
 * the first twenty minutes of a bake worth almost nothing to a running fleet, because the
 * rooms it walks are scattered through the file. Rooms without a mask degrade individually
 * to the coarse grid, so an interrupted bake in this order is a table that already covers
 * the routes anybody is on.
 *
 * Three tiers, and the third is why islands sort last:
 *
 *   1. VISITED, by how often. `substrate/history/` records a room NAME on every sample and
 *      event — 110 distinct rooms across this machine's records, from 22,722 samples in
 *      Upstairs in Castle Victoria down to single figures. Walk logs add the operator's own
 *      rooms by object id.
 *   2. NEAR something visited, by hop distance over the room graph. A room one door from
 *      the fleet's ground is a room the fleet is one decision away from entering.
 *   3. Everything else, in map order.
 *
 * A NAME IS NOT A ROOM AND TWO ROOMS SHARE A NAME. "The King's Way" is 575 and 576; "The
 * Cragged Mountains" is 578 and 598. Both get the credit, which is right for an ordering —
 * the cost of baking one room early is nothing, and resolving the ambiguity would need
 * per-sample coordinates the history does not carry.
 *
 * Ordering only. It never drops a room, so the finished table is identical either way.
 */
export function bakeOrder(map, { historyDir = null, walksDir = null } = {}) {
  const byName = new Map();
  for (const r of Object.values(map.rooms)) {
    const k = String(r?.name ?? '').trim().toLowerCase();
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(Number(r.num));
  }
  const visits = new Map();
  const bump = (num, n) => visits.set(num, (visits.get(num) ?? 0) + n);

  const hist = historyDir ?? join(REPO, 'substrate', 'history');
  const walk = (dir, depth = 0) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (depth < 2) walk(full, depth + 1); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      let text = '';
      try { text = readFileSync(full, 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/"room":"([^"]*)"/g))
        for (const num of byName.get(m[1].trim().toLowerCase()) ?? []) bump(num, 1);
    }
  };
  walk(hist);

  // The operator's own recorded walks, which name rooms by the SERVER's object id.
  const byObj = new Map();
  for (const r of Object.values(map.rooms)) if (r?.objId) byObj.set(r.objId, Number(r.num));
  const wdir = walksDir ?? join(REPO, 'substrate', 'walks');
  try {
    for (const f of readdirSync(wdir)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const m of readFileSync(join(wdir, f), 'utf8').matchAll(/"room":(\d+)/g)) {
        const num = byObj.get(Number(m[1]));
        if (num != null) bump(num, 1);
      }
    }
  } catch { /* no walk logs is not an error */ }

  // Hop distance from the visited set, over whatever exits the map declares.
  const neighbours = num => {
    const r = map.rooms[String(num)];
    const out = new Set();
    for (const e of r?.edgeExits ?? []) if (e?.to != null) out.add(Number(e.to));
    for (const e of r?.goExits ?? []) if (e?.to != null && Number(e.to) > 0) out.add(Number(e.to));
    return [...out];
  };
  const dist = new Map();
  let frontier = [...visits.keys()];
  for (const n of frontier) dist.set(n, 0);
  for (let d = 1; frontier.length && d <= 12; d++) {
    const next = [];
    for (const n of frontier)
      for (const m of neighbours(n))
        if (!dist.has(m)) { dist.set(m, d); next.push(m); }
    frontier = next;
  }

  return { visits, dist,
    compare: (a, b) => {
      const va = visits.get(Number(a.num)) ?? 0, vb = visits.get(Number(b.num)) ?? 0;
      if (va !== vb) return vb - va;                       // most-visited first
      const da = dist.get(Number(a.num)) ?? 99, db = dist.get(Number(b.num)) ?? 99;
      if (da !== db) return da - db;                       // then nearest to somewhere visited
      return Number(a.num) - Number(b.num);                // then stable
    } };
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const val = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const only = val('--rooms')?.split(',').map(Number).filter(Number.isFinite) ?? null;
  const check = argv.includes('--check');
  // The mover's view is the point of the bake now; `--grid` asks for the old coarse one,
  // which is only useful for comparing the two.
  const collision = !argv.includes('--grid');

  const map = loadMap(movementMapFile());

  // THE SHARD CHILD, and it deliberately shares nothing with the parent's bookkeeping.
  //
  // It adopts no table, flushes nothing, and writes exactly the rooms it was handed to the
  // file it was given. Keeping it this dumb is what makes `--jobs` safe: a shard cannot
  // half-write the real table, and the parent is the only thing that ever touches it.
  const shardRooms = val('--shard-rooms')?.split(',').map(Number).filter(Number.isFinite) ?? null;
  const shardOut = val('--shard-out');
  if (shardRooms && shardOut) {
    const acc = { rooms: {}, skipped: 0, pairs: 0, pockets: 0, stranded: 0 };
    for (const num of shardRooms) {
      const room = map.rooms[String(num)];
      if (!room?.roo) { acc.skipped++; continue; }
      const baked = bakeRoom(room, { collision });
      if (baked.skipped) { acc.skipped++; continue; }
      acc.rooms[baked.room] = baked;
      acc.pairs += Object.keys(baked.routes).length;
      acc.pockets += baked.pockets ?? 0;
      acc.stranded += baked.stranded_exits ?? 0;
      process.send?.({ done: 1, room: baked.room });
    }
    writeFileSync(shardOut, JSON.stringify(acc));
    process.exit(0);
  }
  const manifest = map.geometryManifestSha256 ?? null;
  const rooms = Object.values(map.rooms)
    .filter(r => r?.roo && (!only || only.includes(Number(r.num))));
  // MOST-WALKED FIRST — see bakeOrder. A bake that is interrupted, or read while still
  // running, then covers the rooms the fleet is actually in rather than a scatter.
  const order = bakeOrder(map);
  rooms.sort(order.compare);

  // THIRTEEN MINUTES THAT USED TO BE ALL-OR-NOTHING. The whole table was one write after
  // the loop, so a Ctrl-C, a reboot or an OOM at room 250 of 264 produced nothing at all
  // and the next run started from the beginning. Two things fix that and they are the same
  // mechanism: the partial table is flushed as it goes, and a rerun can adopt what is
  // already on disk.
  //
  // ADOPTION IS GATED ON THE MANIFEST AND ON THE VIEW, because a half-table stitched from
  // two different maps is exactly the confidently-wrong artifact this file keeps warning
  // about — and unlike a stale table, nothing downstream could detect it. Same geometry
  // and same view, or the existing rooms are ignored and it bakes from scratch.
  const resume = argv.includes('--resume');
  const out = {};
  // `--rooms` MEANS "REBAKE THESE", NOT "THE TABLE IS NOW THESE".
  //
  // It used to start from an empty table and write back only what it baked, so
  // `--rooms 2,38,50,...` turned a 264-room table into a 21-room one and every room
  // outside the list lost its routes. It set `complete: false`, which is honest and
  // useless: nothing on the read side refuses an incomplete table, so the broker came up
  // fine and simply could not plan a journey anywhere it had not been asked to bake.
  // Caught by counting routes before and after — 16,311 -> 2,748 — and only because the
  // count was checked, which is not a safety net anybody should rely on twice.
  //
  // So a partial bake adopts the rest of the table under exactly the same gate `--resume`
  // uses, and REFUSES rather than writing a hole when the gate says no.
  const adopt = resume || !!only;
  if (adopt) {
    try {
      const prior = JSON.parse(readFileSync(ROUTES_FILE(), 'utf8'));
      const sameMap = prior?.geometryManifestSha256 && manifest
        && prior.geometryManifestSha256 === manifest;
      const sameView = (prior?.view ?? 'grid') === (collision ? 'collision' : 'grid');
      // A half-table stitched from two PREDICATES is the same kind of undetectable wrong
      // as one stitched from two maps, so --resume refuses it for the same reason.
      const samePredicate = (prior?.stepMaskVersion ?? 1) === STEP_MASK_VERSION;
      const sameBake = (prior?.bakeVersion ?? 1) === BAKE_VERSION;
      if (sameMap && sameView && samePredicate && sameBake) {
        // ADOPT EVERYTHING EXCEPT WHAT WAS ASKED FOR. `--rooms 589` means room 589 is the
        // one room whose baked copy is NOT to be trusted — adopting it too would make the
        // flag a no-op that reports success, which is how the first version of this fix
        // "baked 264 rooms in 0.0s — 0 routes" and changed nothing.
        const askedFor = only ? new Set(only.map(String)) : null;
        for (const [num, baked] of Object.entries(prior.rooms ?? {}))
          if (baked && !baked.skipped && !askedFor?.has(String(num))) out[num] = baked;
        console.error(only
          ? `keeping ${Object.keys(out).length} room(s) from the table on disk, rebaking ${only.length}`
          : `resuming: ${Object.keys(out).length} room(s) already baked from the same map`);
      } else {
        console.error(`ignoring the table on disk — ` +
          (!sameMap ? 'it was baked from different geometry'
           : !sameView ? `it is the ${prior?.view} view`
           : !samePredicate ? `it was baked with step-mask v${prior?.stepMaskVersion ?? 1}, this build is v${STEP_MASK_VERSION}`
           : `it was baked by bake v${prior?.bakeVersion ?? 1}, this build is v${BAKE_VERSION}`));
      }
    } catch { console.error('nothing usable on disk to resume from'); }
    // A partial bake that could not adopt would silently drop every room it was not asked
    // for. That is the one outcome worth refusing outright.
    if (only && Object.keys(out).length === 0) {
      console.error('refusing to write a table containing only the rooms named by --rooms: ' +
                    'there is nothing on disk to merge them into, so every other room would ' +
                    'lose its routes. Bake the whole map once (no --rooms), then use --rooms.');
      process.exit(1);
    }
  }
  const todo = rooms.filter(r => !(String(r.num) in out));
  console.error(`baking ${todo.length} room(s)${resume && todo.length !== rooms.length
    ? ` (${rooms.length - todo.length} already done)` : ''}…`);

  let skipped = 0, pairs = 0, pockets = 0, stranded = 0;
  const t0 = Date.now();
  // Flushed on a CLOCK rather than every N rooms, because room sizes vary by two orders
  // of magnitude here: 264 rooms is anything from 18ms to 30s each, so "every 25 rooms"
  // is thirty seconds in one place and six minutes in another.
  const FLUSH_MS = 60_000;
  let lastFlush = Date.now();
  const write = () => {
    mkdirSync(dirname(ROUTES_FILE()), { recursive: true });
    writeFileSync(ROUTES_FILE(), JSON.stringify({
      format: 'm59-routes/1',
      view: collision ? 'collision' : 'grid',
      builtAt: new Date().toISOString(),
      builtFrom: movementMapFile(),
      geometryManifestSha256: manifest,
      // WHAT THE MASK BITS MEAN. The manifest above hashes the geometry and therefore
      // cannot notice the PREDICATE changing, so a table baked by older code against the
      // same map verifies perfectly and encodes the wrong doors. See STEP_MASK_VERSION.
      stepMaskVersion: STEP_MASK_VERSION,
      bakeVersion: BAKE_VERSION,
      // Says outright that the table is short of the map it was built from, so a partial
      // flush cannot be mistaken for a finished bake by anything reading it.
      complete: Object.keys(out).length + skipped >= rooms.length && !only,
      rooms: out,
    }));
  };

  // ============================ ONE ROOM PER CORE ============================
  //
  // A full bake was 1680s here, single-threaded, on a machine with cores to spare. Every
  // room is independent — `bakeRoom` reads the map and returns a record, and the only
  // shared thing in the whole run is the table it goes into — so the work is embarrassingly
  // parallel and was only sequential because nothing had asked it not to be.
  //
  // WHY CHILD PROCESSES AND NOT WORKERS. `bakeRoom` is CPU-bound and synchronous, and it
  // reaches through `sharedRoomGeometry` into a module-level cache; a worker thread would
  // need that cache to be thread-safe or per-thread, and a fork gets the second for free.
  // The map is re-read per child, which costs a few seconds once and nothing after.
  //
  // ROUND-ROBIN OVER THE COST ORDER, NOT CONTIGUOUS BLOCKS. `todo` is sorted most-walked
  // first and room cost spans two orders of magnitude (18ms to 30s), so contiguous blocks
  // would put every expensive room in shard 0 and the run would take as long as that shard.
  // Dealing them out one at a time gives each shard the same mix.
  //
  // A shard that dies takes its rooms with it and the parent says so and exits non-zero,
  // rather than writing a table with a hole in it — the same refusal `--rooms` already makes
  // for the same reason.
  const jobs = Math.max(1, Number(val('--jobs') || 1));
  let ranParallel = false;
  if (jobs > 1 && todo.length > 1) {
    const shardDir = join(tmpdir(), `m59-bake-${process.pid}`);
    mkdirSync(shardDir, { recursive: true });
    const lists = Array.from({ length: Math.min(jobs, todo.length) }, () => []);
    todo.forEach((r, i) => lists[i % lists.length].push(Number(r.num)));
    console.error(`  ${lists.length} shard(s): ${lists.map(l => l.length).join(', ')} room(s) each`);
    let done = 0;
    const started = Date.now();
    const children = lists.map((list, i) => {
      const outFile = join(shardDir, `shard-${i}.json`);
      const args = ['--shard-rooms', list.join(','), '--shard-out', outFile];
      if (!collision) args.push('--grid');
      const child = fork(fileURLToPath(import.meta.url), args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      child.on('message', m => {
        if (!m?.done) return;
        done++;
        process.stderr.write(`\r  ${done}/${todo.length} room(s) across ${lists.length} shard(s), ` +
          `${((Date.now() - started) / 1000).toFixed(0)}s      `);
      });
      return new Promise((res, rej) => {
        child.on('exit', code => code === 0 ? res(outFile)
          : rej(new Error(`shard ${i} exited ${code} with ${list.length} room(s) unbaked`)));
        child.on('error', rej);
      });
    });
    let files;
    try { files = await Promise.all(children); }
    catch (e) {
      process.stderr.write('\n');
      console.error(`parallel bake failed: ${e.message}`);
      console.error('nothing was written — rerun, or drop --jobs to bake in one process');
      try { rmSync(shardDir, { recursive: true, force: true }); } catch {}
      process.exit(1);
    }
    process.stderr.write('\n');
    for (const f of files) {
      const part = JSON.parse(readFileSync(f, 'utf8'));
      for (const [num, baked] of Object.entries(part.rooms ?? {})) out[num] = baked;
      skipped += part.skipped ?? 0; pairs += part.pairs ?? 0;
      pockets += part.pockets ?? 0; stranded += part.stranded ?? 0;
    }
    try { rmSync(shardDir, { recursive: true, force: true }); } catch {}
    ranParallel = true;
  }

  for (const [i, room] of (ranParallel ? [] : todo).entries()) {
    const t = Date.now();
    const baked = bakeRoom(room, { collision });
    if (baked.skipped) { skipped++; continue; }
    out[baked.room] = baked;
    pairs += Object.keys(baked.routes).length;
    pockets += baked.pockets ?? 0;
    stranded += baked.stranded_exits ?? 0;
    if (todo.length > 5)
      process.stderr.write(`\r  ${i + 1}/${todo.length}  room ${baked.room} ` +
        `${baked.anchors.length} exits, ${baked.main_region_squares}/${baked.walkable} ` +
        `in the main body, ${baked.pockets} pocket(s), ` +
        `${Object.keys(baked.routes).length} routes, ${Date.now() - t}ms      `);
    if (!check && Date.now() - lastFlush >= FLUSH_MS) { write(); lastFlush = Date.now(); }
  }
  process.stderr.write('\n');
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`baked ${Object.keys(out).length} room(s) in ${took}s — ${pairs} routes, ` +
                `${skipped} without collision geometry, ${pockets} pocket(s) off the main ` +
                `body (safe-spot candidates), ${stranded} exit(s) stranded outside it`);

  if (check) {
    // WHAT A ROOM ACTUALLY LOOKS LIKE, rather than a region count. A room in a hundred
    // pieces with 99% of its floor in one of them is a normal room with a lot of corners.
    // The line worth acting on is an exit THE BODY OF THE ROOM CANNOT REACH.
    //
    // AND THAT IS A CLAIM ABOUT THIS MODEL, NOT ABOUT THE WORLD. This report used to say
    // "walking cannot join those; that is what blink is for" about every such exit, which
    // is an overclaim three ways over. Most of them are neither:
    //
    //   * a doorway is a POCKET BY DESIGN — you step onto the exit square and cannot step
    //     back off it into the room — and is reached perfectly well from the body;
    //   * this model is stricter than the client it models, so an unreachable reading is
    //     as likely to be ours as the map's;
    //   * the one place in the world genuinely joined only by blink is the CRAGGED
    //     MOUNTAINS cliff (578, and 598 by the same name): entering by the north-west, the
    //     south-west and south-east exits are a one-way trip unless you blink up the cliff
    //     near the north-west corner.
    //
    // So this says what it measured and leaves the conclusion to somebody who can go and
    // look. A refusal we invented reads exactly like a wall, which is the failure this
    // whole routing path exists to stop repeating.
    const rows = Object.values(out).sort((a, b) =>
      (b.stranded_exits - a.stranded_exits) || (a.main_region_squares / a.walkable) - (b.main_region_squares / b.walkable));
    for (const r of rows.slice(0, 12))
      console.error(`  room ${String(r.room).padEnd(5)} ` +
        `${String(Math.round(100 * r.main_region_squares / Math.max(1, r.walkable))).padStart(3)}% of ${String(r.walkable).padStart(5)} squares in one body, ` +
        `${String(r.pockets).padStart(4)} pocket(s), ` +
        (r.stranded_exits
          ? `${r.stranded_exits} of ${r.anchors.length} exit(s) this model cannot walk to from that body — go and look before believing it`
          : `all ${r.anchors.length} exit(s) reachable from it`));
  } else {
    write();
    const mb = (readFileSync(ROUTES_FILE()).length / 1048576).toFixed(2);
    console.error(`wrote ${ROUTES_FILE()} (${mb} MB)`);
  }
}
