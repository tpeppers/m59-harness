// WALKING WHERE THE SQUARE LATTICE CANNOT EXPRESS THE ROUTE.
//
// Everything else here plans in SQUARES: `path()` searches square to square, and
// `moverStepLands` asks whether the mover, aiming from one square's stand point at the
// next one's, lands in it. That is the right unit for open floor and it is the wrong unit
// for a safe wall — which IS the coarse grid and the BSP disagreeing, measured, and is
// exactly the terrain where no stand-point-to-stand-point step is legal at all.
//
// Those places are not a curiosity. 12,633 squares in 3,929 separate pockets carry four or
// more refused neighbours, they are scattered through every outdoor room in the world, and
// they are the squares a monster cannot reach — so they are simultaneously the best places
// to stand and the places a square-stepping walker cannot enter. The fleet has been getting
// stuck OUTSIDE them, which is precisely what a monster does.
//
// So this searches in FINE units, on a sub-square lattice, validating every move with the
// same `traceFineMoveClient` the mover uses. It is not a fallback and it is not a relaxation:
// it is stricter than square planning, because it checks a real body sliding along a real
// line rather than assuming a stand point it may never occupy.
//
// WHY A LATTICE AND NOT FREE SPACE. A continuous search over a room is a motion-planning
// problem; a lattice of `RESOLUTION` points per square is a graph, and A* over it is the
// same code everything else here already reads. 4 per square (256 client units apart) is
// finer than the 248-unit player radius, which is the width that decides whether a gap is
// passable at all — anything coarser cannot see a gap a body fits through, and anything
// finer costs time without finding new gaps.
//
// COORDINATE CONTRACT. Fine point objects and fine-distance thresholds here use
// client/BSP (x,y), 1024 units per square with a zero-based room origin. Named square
// records are 1-based {row,col}; positional square helpers take (row,col).
import { KOD_FINENESS, CLIENT_FINENESS } from './m59-roo.mjs';

// Client units per square, and how many lattice points we lay across one.
export const CLIENT_PER_SQUARE = KOD_FINENESS * (CLIENT_FINENESS / KOD_FINENESS);
export const RESOLUTION = Number(process.env.M59_FINE_RESOLUTION || 4);
export const STEP = CLIENT_PER_SQUARE / RESOLUTION;          // 256 client units
// How close counts as arrived. Half a lattice step: closer than this and no further move
// can improve matters.
export const ARRIVE_WITHIN = STEP / 2;

const key = (x, y) => Math.round(x / STEP) + ',' + Math.round(y / STEP);
export const squareOf = (x, y) => ({ row: Math.floor(y / CLIENT_PER_SQUARE) + 1,
                                     col: Math.floor(x / CLIENT_PER_SQUARE) + 1 });

// The eight headings, plus their cost. Diagonals cost what they actually are.
const MOVES = [];
for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
  if (!dx && !dy) continue;
  MOVES.push({ dx: dx * STEP, dy: dy * STEP, cost: Math.hypot(dx, dy) });
}

/**
 * Can a body at (x0,y0) reach (x1,y1) in one lattice move?
 *
 * SLIDING IS ALLOWED AND ARRIVAL IS REQUIRED. The mover slides — that is what it does —
 * so refusing a slid move would model a body that does not exist. What is required is that
 * the slide ends within `ARRIVE_WITHIN` of where it was aimed, because a move that ends
 * somewhere else is not the edge we are putting in the graph, and a graph full of edges
 * that go somewhere else is exactly the failure square planning already has.
 */
function moveLands(geo, x0, y0, x1, y1) {
  const t = geo.traceFineMoveClient(x0, y0, x1, y1, { slide: true });
  if (!t) return null;
  if (Math.hypot(t.x - x1, t.y - y1) > ARRIVE_WITHIN) return null;
  return { x: t.x, y: t.y };
}

/**
 * A* in fine coordinates, from one point to another, both in CLIENT units.
 *
 * Returns `{ found, points }` where points are the fine waypoints to walk, INCLUDING the
 * destination and excluding the start — the same shape `path()` returns in squares, so a
 * caller can treat the two the same way.
 *
 * `bounds` keeps the search local. A fine search over a whole outdoor room is tens of
 * thousands of nodes and is not what this is for: it exists to cross a POCKET, and the
 * caller knows where the pocket is. With no bounds it will still work and simply cost more.
 */
export function finePath(geo, from, to, { bounds = null, maxNodes = 20000, goalSquare = null } = {}) {
  if (!geo?.collisionReady || typeof geo.traceFineMoveClient !== 'function')
    return { found: false, reason: 'no collision geometry' };
  const inBounds = (x, y) => !bounds
    || (x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY);
  if (!inBounds(to.x, to.y)) return { found: false, reason: 'target outside the search bounds' };

  const h = (x, y) => Math.hypot(x - to.x, y - to.y) / STEP;
  // THE NODE IS THE REAL BODY POSITION; THE KEY IS THE LATTICE CELL IT LANDED IN.
  //
  // Keying by the point we AIMED at while carrying the point we LANDED on is the bug this
  // file was written to avoid, and it bit here first: a slid move ends a little off the
  // lattice, so every node became unique, the graph stopped closing, and a four-square hop
  // burned twenty thousand nodes and gave up. Snapping only the KEY keeps the search finite
  // while the geometry is still checked against where the body actually is — which is the
  // whole reason for planning in fine units rather than on stand points.
  const start = { x: from.x, y: from.y };
  const open = [{ x: start.x, y: start.y, g: 0, f: h(start.x, start.y) }];
  const seen = new Map([[key(start.x, start.y), 0]]);
  const cameFrom = new Map();
  let nodes = 0;

  while (open.length) {
    // A sorted insert beats a heap at this size and reads like the rest of the repository.
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    if (++nodes > maxNodes) return { found: false, reason: 'fine search gave up', nodes };
    // A square walk needs an occupiable point in that square. Its center can
    // lie inside a wall even though the same square has a usable edge. Exact
    // point callers retain their distance contract unless they opt into this.
    const square = goalSquare ? squareOf(cur.x, cur.y) : null;
    if (goalSquare ? square.row === goalSquare.row && square.col === goalSquare.col
                   : Math.hypot(cur.x - to.x, cur.y - to.y) <= ARRIVE_WITHIN) {
      const points = [];
      let node = { x: cur.x, y: cur.y };
      while (node) {
        points.push({ x: Math.round(node.x), y: Math.round(node.y) });
        node = cameFrom.get(key(node.x, node.y));
      }
      points.reverse();
      points.shift();                                  // the start is where we already are
      return { found: true, points, nodes };
    }
    const curKey = key(cur.x, cur.y);
    if (seen.get(curKey) < cur.g) continue;            // a better way here was already found
    for (const m of MOVES) {
      const aimX = cur.x + m.dx, aimY = cur.y + m.dy;
      if (!inBounds(aimX, aimY)) continue;
      const landed = moveLands(geo, cur.x, cur.y, aimX, aimY);
      if (!landed) continue;
      const k = key(landed.x, landed.y);
      if (k === curKey) continue;                      // slid back into the cell we are in
      const g = cur.g + m.cost;
      if (seen.has(k) && seen.get(k) <= g) continue;
      seen.set(k, g);
      cameFrom.set(k, { x: cur.x, y: cur.y });
      open.push({ x: landed.x, y: landed.y, g, f: g + h(landed.x, landed.y) });
    }
  }
  return { found: false, reason: 'no fine route', nodes };
}

// Directed connectivity on the same body-sized lattice as finePath. Only a fully
// exhausted, room-bounded search can rule out a square; budget exhaustion is unknown.
// This does not equate coarse components, or reverse a one-way movement edge.
// A COMPLETE ANSWER HAS TO SURVIVE THE LATTICE'S PHASE. The lattice is laid from wherever the
// body stands, and a slid landing that rounds onto a key already seen is dropped, so one phase
// can seal itself into a few squares that other phases walk straight out of. Measured in The
// Clearing of the Trading Post (2144) from Piggy's own position on 2026-10-30, kod (3125,1672)
// = client (48976,25728): this answered "complete, 8 squares", while the same search started
// 64-192 units away in y answered ~2150 -- the whole room -- and a body-sized flood on a fixed
// lattice reaches the west door. `exits()` reads "complete and not in the set" as PROOF of
// disconnection, marked every door to 2101 unverified, and the bake's anchor on the palisade
// led the crossing again.
//
// So a complete component is re-asked ONCE from another phase the body can step to directly,
// and the answer is the UNION, complete only if that search exhausts too. A square is then ruled
// out only when two phases both miss it. (Requiring the second search to stay inside the first
// set is too strict: phases differ by a square at a component's ragged edge, and that refused
// the 567 phantom-island proof m59-routing-test pins.) In 2144 the second phase walks out into
// the whole room and runs out of budget, so the answer is unknown -- never a proof. An
// incomplete first search -- every search of a big open room inside its budget -- is returned
// exactly as before, so the common case costs nothing; the complete case costs one more search
// of a component small enough to exhaust, under its own node and time budget.
const PHASES = [[0, STEP / 2], [STEP / 2, 0], [STEP / 2, STEP / 2]];
export function fineReachableSquares(geo, from, { maxNodes = 20000, maxMs = 500 } = {}) {
  const squares = new Set();
  const result = (complete, reason, nodes) => ({ complete, reason, nodes, squares });
  if (!geo?.collisionReady || typeof geo.traceFineMoveClient !== 'function'
      || !Number.isFinite(from?.x) || !Number.isFinite(from?.y))
    return result(false, 'no collision geometry or origin', 0);
  const inside = p => p.x >= 0 && p.y >= 0
    && p.x < geo.cols * CLIENT_PER_SQUARE && p.y < geo.rows * CLIENT_PER_SQUARE;
  if (!inside(from)) return result(false, 'origin outside room', 0);
  if (typeof geo._occupiable === 'function' && !geo._occupiable(from.x, from.y))
    return result(false, 'origin has no occupiable floor', 0);
  // One search from one seed, adding the squares it touches to `into`.
  const flood = (seed, into) => {
    const started = Date.now();
    const queue = [{ x: seed.x, y: seed.y }], seen = new Set([key(seed.x, seed.y)]);
    for (let i = 0; i < queue.length; i++) {
      if (i >= maxNodes || (i % 64 === 0 && Date.now() - started >= maxMs))
        return { done: false, reason: 'fine connectivity budget exhausted', nodes: i };
      const cur = queue[i], square = squareOf(cur.x, cur.y);
      into.add(`${square.row},${square.col}`);
      for (const m of MOVES) {
        const aim = { x: cur.x + m.dx, y: cur.y + m.dy };
        if (!inside(aim)) continue;
        let landed;
        try { landed = moveLands(geo, cur.x, cur.y, aim.x, aim.y); }
        catch { return { done: false, reason: 'fine connectivity unavailable', nodes: i }; }
        if (!landed || !inside(landed)) continue;
        const k = key(landed.x, landed.y);
        if (seen.has(k)) continue;
        seen.add(k); queue.push(landed);
      }
    }
    return { done: true, nodes: queue.length };
  };
  const first = flood(from, squares);
  if (!first.done) return result(false, first.reason, first.nodes);
  for (const [dx, dy] of PHASES) {
    const aim = { x: from.x + dx, y: from.y + dy };
    if (!inside(aim)) continue;
    let seed;
    try { seed = moveLands(geo, from.x, from.y, aim.x, aim.y); }
    catch { return result(false, 'fine connectivity unavailable', first.nodes); }
    if (!seed || !inside(seed)) continue;
    const again = flood(seed, squares);
    if (!again.done) return result(false, again.reason, first.nodes + again.nodes);
    return result(true, 'fine component exhausted', first.nodes + again.nodes);
  }
  return result(true, 'fine component exhausted', first.nodes);
}

/**
 * Trim a fine route to the corners that matter.
 *
 * The lattice produces a step every 256 units; most of a route is straight, and sending
 * every lattice point would be forty packets where four would do. This is the same argument
 * as `stringPull` for squares, applied to the same geometry — and it is checked the same
 * way, by asking whether the direct line actually lands.
 */
export function pullFine(geo, from, points) {
  if (!Array.isArray(points) || points.length < 2) return points ?? [];
  const out = [];
  let anchor = { x: from.x, y: from.y };
  let i = 0;
  while (i < points.length) {
    let best = i;
    for (let j = points.length - 1; j > i; j--) {
      if (moveLands(geo, anchor.x, anchor.y, points[j].x, points[j].y)) { best = j; break; }
    }
    out.push(points[best]);
    anchor = points[best];
    i = best + 1;
  }
  return out;
}

/** The stand point of a 1-based (row,col) square, returned in client/BSP (x,y). */
export const pointOfSquare = (geo, row, col) => geo.standPoint?.(row, col)
  ?? { x: (col - 0.5) * CLIENT_PER_SQUARE, y: (row - 0.5) * CLIENT_PER_SQUARE };

/**
 * A search box around a set of squares, with a margin, so a pocket crossing stays local.
 */
export function boundsAround(squares, margin = 3) {
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const s of squares) {
    minR = Math.min(minR, s.row); maxR = Math.max(maxR, s.row);
    minC = Math.min(minC, s.col); maxC = Math.max(maxC, s.col);
  }
  return { minX: (minC - 1 - margin) * CLIENT_PER_SQUARE, maxX: (maxC + margin) * CLIENT_PER_SQUARE,
           minY: (minR - 1 - margin) * CLIENT_PER_SQUARE, maxY: (maxR + margin) * CLIENT_PER_SQUARE };
}

// A coarse route may contain a stand point a real body cannot occupy, even
// though the corridor continues beyond it. Search a bounded prefix for a fine
// route to rejoin; every leg still uses the ordinary collision trace.
export function fineRouteDetour(geo, from, route, { maxAhead = 4, maxNodes = 4000, margin = 4 } = {}) {
  const square = { row: Math.floor(from.y / CLIENT_PER_SQUARE) + 1,
                   col: Math.floor(from.x / CLIENT_PER_SQUARE) + 1 };
  let spent = 0;
  // Rejoin beyond the pocket first. Spending the whole search on the same
  // unreachable intermediate square cannot discover the corridor beyond it.
  // A declared fall bounds the prefix; it must still be executed separately.
  let end = Math.min(route.length, maxAhead + 1);
  for (let i = 0; i < end; i++) if (route[i].fall) { end = i; break; }
  for (let index = end - 1; index >= 0; index--) {
    const target = route[index];
    if (spent >= maxNodes) break;
    const found = finePath(geo, from, pointOfSquare(geo, target.row, target.col),
      { bounds: boundsAround([square, target], margin), maxNodes: maxNodes - spent, goalSquare: target });
    spent += found.nodes ?? 0;
    if (found.found) return { ...found, target, index, nodes: spent };
  }
  return { found: false, nodes: spent };
}
