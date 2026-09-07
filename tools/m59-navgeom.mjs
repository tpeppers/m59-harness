// m59-navgeom.mjs -- OUR NAVIGATION VIEW OF A ROOM, KEPT OFF UPSTREAM'S GEOMETRY.
//
// `m59-roo.mjs` is shared with upstream and is merged from them constantly. Everything in
// THIS file is ours: the height model the mover plans climbs with, and the lenient fine
// path planner it walks with. Keeping them here is what lets roo stay close enough to
// upstream's copy that a merge is a formality rather than a hand-port -- which it was
// twice in one afternoon before this split.
//
// WHAT STAYED BEHIND, AND WHY. `fineWalkable` is still in roo, because roo's own gated
// paths (edgeCrossingCandidates, neighbors, path) call it when a caller asks for
// `fineNav`. Moving it here would make roo import this file and close a cycle. It is a
// primitive predicate about geometry; the SYSTEM built on top of it is what lives here.
//
// THE DEFAULT IS UPSTREAM'S ANSWER. Importing this module installs the height methods --
// which are pure additions, nothing upstream calls them -- and overrides
// `finePathProtocol` with our lenient planner. That override is safe to make globally
// because nothing in the ROUTING path calls it: its callers are m59-mover, m59-combat,
// m59-decide, m59-keeper-process and the motion probe, all of which are walking a body
// rather than deciding what is reachable. The distinction is the whole point of the
// split, and it is the one that cost 12 routing assertions when it was not observed.
//
// Import for the side effect, once, wherever the navigation system is set up:
//
//     import './m59-navgeom.mjs';
//
// EVERY MODULE-SCOPE SYMBOL THE MOVED METHODS TOUCH HAS TO BE NAMED HERE. They used to sit
// inside m59-roo.mjs and read its module scope for free; out here a missed one is a
// ReferenceError that fires only on the branch that reaches it — `floorHeightAt` and
// `MAX_STEP_HEIGHT` were both found that way, by two suites, after everything else passed.
// If you move another method in, re-derive this list rather than adding to it by hand.
//
// COORDINATE CONTRACT. Methods that take squares positionally use 1-based (row,col),
// matching RoomGeometry. finePathProtocol takes and returns protocol/KOD (x,y), with
// 64 units per square; BSP traces and floor heights use client units, 1024 per square.
// Conversions change scale and origin only--they never exchange the axes.
import {
  RoomGeometry, KOD_FINENESS, CLIENT_FINENESS, MAX_STEP_HEIGHT, PLAYER_RADIUS,
  floorHeightAt, protocolToClient, clientToProtocol,
} from './m59-roo.mjs';

const NAV = {
  /**
   * Floor height (client/BSP units) at the CENTER of a square, from the BSP sector
   * under it. Inputs are KOD-style 1-based (row,col). Returns null if no sector
   * covers the square center (rare — a square whose center falls in a zero-area gap
   * between polygons, or outside the room).
   *
   * This is the source of truth for height: the sector a leaf occupies has a floorHeight
   * (and possibly a slope). Two adjacent squares with a floor-height difference greater
   * than one step (~1024) are a ledge — you can't walk across it, and a drop is a fall.
   * Flat rooms (most outdoor hunting) have one height everywhere and this is a no-op.
   */
  floorHeightAtCell(row, col) {
    if (!this.inBounds(row, col)) return null;
    const x = ((col - 1) + 0.5) * 1024;   // cell center, fine units
    const y = ((row - 1) + 0.5) * 1024;
    const leaf = this.leafAtClient(x, y);
    if (!leaf?.sector) return null;
    const h = floorHeightAt(x, y, leaf.sector);
    return Number.isFinite(h) ? h : null;
  },

  /**
   * Per-square floor-height map, 0-indexed [row][col] flattened to length rows*cols.
   * Values are fine units; -1 marks a square with no BSP floor (treat as a void/cliff edge).
   * Cached on the instance.
   */
  heightMap() {
    if (this._heightMap) return this._heightMap;
    const out = new Int32Array(this.rows * this.cols).fill(-1);
    for (let row = 1; row <= this.rows; row++) {
      for (let col = 1; col <= this.cols; col++) {
        const h = this.floorHeightAtCell(row, col);
        if (h != null) out[(row - 1) * this.cols + (col - 1)] = h;
      }
    }
    this._heightMap = out;
    return out;
  },

  /**
   * Is stepping from (r0,c0) to (r1,c1) a legal height change?
   * Legal if both have a floor and the difference is at most one step (STEP_UNITS).
   * A missing floor on either side is treated as blocked (void/cliff).
   */
  heightStepOk(r0, c0, r1, c1, STEP_UNITS = MAX_STEP_HEIGHT) {
    const h0 = this.floorHeightAtCell(r0, c0);
    const h1 = this.floorHeightAtCell(r1, c1);
    if (h0 == null || h1 == null) return false;
    // The game's client enforces a 384-unit climb (move.c). A full cell is 1024,
    // so any adjacent cells at different BSP floor heights are, by a wide margin,
    // a ledge either up or down. Same-height cells (flat floor) always pass.
    return Math.abs(h0 - h1) <= STEP_UNITS;
  },

  // Cells the coarse grid calls WALL but the fine grid is open in: asymmetric safe
  // spots. The character (fine-grid, any direction) can stand here; a monster (NSEW on
  // the coarse grid) cannot step in. Returns [[c, r], ...] interior cells only (the
  // 1-cell border is always wall in the coarse grid and never farmable).
  //
  // Each result is also height-checked: we only keep cells reachable from at least one
  // adjacent coarse-walkable cell at a step-ok height (i.e. we can get in and, if we
  // want, step back out). A hidden cell on a clifftop we could fall off is not safe.
  hiddenCells() {
    const out = [];
    for (let r = 1; r < this.rows - 1; r++) {
      for (let c = 1; c < this.cols - 1; c++) {
        if (this.walkable(r, c)) continue;        // coarse says walkable: not hidden
        if (this.fineWalkable(r, c) !== true) continue;  // fine says wall/unknown: skip
        // Reachable from a coarse-walkable neighbour at a step-ok height?
        let reachable = false;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nr = r + dr, nc = c + dc;
          if (this.walkable(nr, nc) && this.heightStepOk(r, c, nr, nc)) { reachable = true; break; }
        }
        if (reachable) out.push([c, r]);
      }
    }
    return out;
  },

  _finePathProtocolImpl(fromX, fromY, toX, toY, {
    step = 8,
    margin = 12 * KOD_FINENESS,
    maxNodes = 20000,
  } = {}) {
    if (!this.collisionReady || ![fromX, fromY, toX, toY].every(Number.isFinite))
      return { found: false, reason: 'collision_geometry_unavailable', waypoints: [] };

    // QUANTIZED SQUARE-GRID A* (the fix for the multi-second fine A*). The old version
    // searched a fine lattice in protocol coordinates (step=8, ~100k nodes for a 40x39
    // room) with each edge validated by traceFineMoveClient (a physics trace). That was
    // the whole cost: 85k physics traces = 2.1s. The search is now on the SQUARE grid
    // (one node per square, ~1560 nodes max for 40x39). Edge validation is
    // `moverStepLands` — the baked step-mask validator whose stated purpose is closing
    // "the router plans steps the mover will not make". It is an O(1) mask lookup, so
    // the A* stays sub-millisecond, and it validates the EDGE between squares, not just
    // the destination square: a wall that sits between two fine-walkable squares
    // (fineWalkable(a)=fineWalkable(b)=true, step a->b walled) is invisible to a
    // destination-only check, which was the trap — the A* planned a straight path
    // THROUGH a wall, the mover's step search picked the same walled neighbor, and
    // every walkTo was refused with `geometry_blocked` while the A* kept insisting the
    // route was clear. The step mask knows the edge is walled (it was baked from the
    // physics traces), so the A* routes around it, exactly as the old fine-lattice
    // search did — without re-paying the per-edge physics trace.
    const toKod = v => Math.floor(v / KOD_FINENESS); // protocol -> containing 1-based square
    const fromC = toKod(fromX), fromR = toKod(fromY), toC = toKod(toX), toR = toKod(toY);

    // EDGE PREDICATE: radius-free trace between stand points (or square centers if the
    // stand point is null), with small lateral offsets to handle walls that run along
    // a square's centre line. This checks "is there a wall segment ON this edge?" —
    // it accepts corridors where the full player radius clips a nearby wall (the mover
    // handles fine positioning via sliding) and refuses edges with a real wall crossing.
    // Memoized on the geometry object (this._edgeOk) so the traces are paid ONCE per
    // room, not once per finePathProtocol call. The geometry is static; an edge that
    // is walkable now is walkable forever. Without this, the mover's 10 calls/s of
    // finePathProtocol each re-trace ~1600 edges × up to 5 offsets = 8000 traces/s,
    // blocking the event loop for ~1-2s per call and making swings 3s apart.
    const edgeOk = (this._edgeOk ??= new Map());
    // ORIGIN-TRAP ESCAPE. The character may start the A* on a square that is not
    // `standable` (a respawn point, a ledge edge, a fine-unwalkable square) — `standPoint`
    // returns null there, so `moverStepLands` refuses EVERY first edge out of it and the
    // A* expands 1 node and gives up (the (45,11) Raza case). The character is ALREADY on
    // that square; we only need to get OFF it. For the first edge out of a non-standable
    // origin, fall back to a lenient radius-248 trace (the old edge test) so the search
    // can leave the trap square. Every OTHER edge uses the strict `moverStepLands`, so
    // the found path is still guaranteed walkable by the mover from that point on.
    const originR = fromR, originC = fromC;
    const originStandable = this.standable ? this.standable(fromR, fromC) : true;
    const lenientEdge = (r1, c1, r2, c2) => {
      let a = this.standPoint(r1, c1);
      let b = this.standPoint(r2, c2);
      // CLIENT coordinates (1024/square), matching standPoint's scale. The
      // stand points live on the fine geometry in client units; a KOD-scale
      // fallback (64/square) lands 16x too close to the origin and in a spot
      // with no floor, so the trace reports start_has_no_floor and the escape
      // never happens. This is the committed A*'s fallback, kept identical.
      if (!a) a = { x: (c1 - 1) * CLIENT_FINENESS + CLIENT_FINENESS / 2, y: (r1 - 1) * CLIENT_FINENESS + CLIENT_FINENESS / 2 };
      if (!b) b = { x: (c2 - 1) * CLIENT_FINENESS + CLIENT_FINENESS / 2, y: (r2 - 1) * CLIENT_FINENESS + CLIENT_FINENESS / 2 };
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const px = -dy / len, py = dx / len;
      const t = (ox, oy) => this.traceFineMoveClient(a.x + ox, a.y + oy, b.x + ox, b.y + oy,
        { slide: false, playerRadius: PLAYER_RADIUS }).arrived === true;
      return t(0,0) || t(px*128,py*128) || t(-px*128,-py*128) || t(px*256,py*256) || t(-px*256,-py*256);
    };
    const edgeWalkable = (r1, c1, r2, c2) => {
      const ek = `${r1},${c1}>${r2},${c2}`; // ledges and steps are directed
      const hit = edgeOk.get(ek);
      if (hit !== undefined) return hit;
      // THE SAME PREDICATE THE MOVER USES. `moverStepLands` is the function the
      // mover's step search consults to decide whether it will accept a step
      // (standable destination + a slide:true trace that ARRIVES in the
      // destination square at a consistent height, memoized in the step mask).
      // Using it here means an A* "found" path only uses edges the mover will
      // actually take, so the character follows it to completion instead of
      // reaching a square the planner promised but the mover refuses (the
      // (37,10)<->(37,11) oscillation).
      //
      // EXCEPT the first edge out of a non-standable origin square: there,
      // `moverStepLands` refuses everything (no stand point to start from), so we
      // use the lenient trace to let the search escape the trap square. This is
      // Option A with the one necessary carve-out: the planner and the mover use
      // the same predicate, except the planner must be able to start from a square
      // the mover would never step INTO.
      let ok;
      if (originStandable === false &&
          ((r1 === originR && c1 === originC) || (r2 === originR && c2 === originC))) {
        ok = lenientEdge(r1, c1, r2, c2);
      } else {
        ok = this.moverStepLands(r1, c1, r2, c2);
      }
      edgeOk.set(ek, ok);
      return ok;
    };

    // Direct leg: if the straight line is clear EDGE BY EDGE, return immediately.
    // Walk the line square by square and validate each consecutive hop with the same
    // edge predicate the A* uses, so the direct answer and the searched answer cannot
    // disagree about the same wall.
    if (this.inBounds(fromR, fromC) && this.inBounds(toR, toC)) {
      const clearSafe = (ax, ay, bx, by) => {
        const aC = toKod(ax), aR = toKod(ay), bC = toKod(bx), bR = toKod(by);
        if (aC === bC && aR === bR) return true;
        const steps = Math.max(Math.abs(bC - aC), Math.abs(bR - aR));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const c = Math.round(aC + (bC - aC) * t);
          const r = Math.round(aR + (bR - aR) * t);
          const pc = i === 1 ? aC : Math.round(aC + (bC - aC) * ((i - 1) / steps));
          const pr = i === 1 ? aR : Math.round(aR + (bR - aR) * ((i - 1) / steps));
          if (this.fineWalkable && this.fineWalkable(r, c) === false) return false;
          if (!edgeWalkable(pr, pc, r, c)) return false;
        }
        return true;
      };
      if (clearSafe(fromX, fromY, toX, toY))
        return { found: true, waypoints: [{ x: toX, y: toY }], expanded: 0, coarse: true };
    }

    // Square-grid A*. Nodes are (row, col) in 1-based kod coordinates.
    // Edge validation: fineWalkable (O(1) grid lookup), not traceFineMoveClient.
    const heuristic = (r, c) => Math.hypot(toC - c, toR - r);
    const open = [{ r: fromR, c: fromC, g: 0, f: heuristic(fromR, fromC) }];
    const best = new Map([[`${fromR},${fromC}`, 0]]);
    const came = new Map();
    const closed = new Set();
    const key = (r, c) => `${r},${c}`;
    const push = node => {
      open.push(node);
      let i = open.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (open[parent].f <= node.f) break;
        open[i] = open[parent]; i = parent;
      }
      open[i] = node;
    };
    const pop = () => {
      const root = open[0], tail = open.pop();
      if (open.length && tail) {
        let i = 0;
        while (true) {
          let child = i * 2 + 1;
          if (child >= open.length) break;
          if (child + 1 < open.length && open[child + 1].f < open[child].f) child++;
          if (open[child].f >= tail.f) break;
          open[i] = open[child]; i = child;
        }
        open[i] = tail;
      }
      return root;
    };
    // 8-neighbor moves on the square grid.
    const sqMoves = [-1, 0, 1].flatMap(dr => [-1, 0, 1]
      .filter(dc => dc || dr).map(dc => ({ dr, dc, cost: (dr && dc) ? Math.SQRT2 : 1 })));
    let goalKey = null, expanded = 0;
    while (open.length && expanded < maxNodes) {
      const cur = pop(), ck = key(cur.r, cur.c);
      if (closed.has(ck)) continue;
      closed.add(ck); expanded++;
      if (cur.r === toR && cur.c === toC) { goalKey = ck; break; }
      for (const m of sqMoves) {
        const nr = cur.r + m.dr, nc = cur.c + m.dc;
        if (!this.inBounds(nr, nc)) continue;
        const nk = key(nr, nc);
        if (closed.has(nk)) continue;
        // Edge validation: the destination square must be fine-walkable AND the EDGE
        // must be passable (radius-free trace with lateral offsets — detects wall
        // segments on the edge without the false positives of full-radius standPoint
        // traces). Accepts corridors where the player radius clips a nearby wall
        // (the mover handles fine positioning via sliding); refuses real walls.
        if (this.fineWalkable && this.fineWalkable(nr, nc) === false) continue;
        if (!edgeWalkable(cur.r, cur.c, nr, nc)) continue;
        const g = cur.g + m.cost;
        if (g >= (best.get(nk) ?? Infinity)) continue;
        best.set(nk, g);
        came.set(nk, { key: ck, r: cur.r, c: cur.c });
        push({ r: nr, c: nc, g, f: g + heuristic(nr, nc) });
      }
    }
    if (!goalKey) return { found: false, reason: 'no fine path', waypoints: [], expanded };

    // Reconstruct the square path.
    const raw = [{ r: toR, c: toC }];
    let at = goalKey;
    while (came.has(at)) {
      const prior = came.get(at);
      raw.push({ r: prior.r, c: prior.c }); at = prior.key;
    }
    raw.reverse();
    if (raw.length && raw[0].r === fromR && raw[0].c === fromC) raw.shift();

    // GUARD: validate every consecutive edge of the reconstructed path with the SAME
    // predicate the mover uses (moverStepLands). If any edge is blocked, the path is not
    // actually walkable — return found:false so the caller blacklists the target and picks
    // the next-reachable one, instead of walking a dead-end that ping-pongs and then
    // force-pushes through walls. This is the backstop for the case where the search's
    // edge validation and the mover's step validator disagree (a one-way step-height edge
    // that the search admitted but the mover refuses): rather than trust the search, the
    // path must prove itself edge-by-edge before it is called "found".
    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i], b = raw[i + 1];
      if (!this.moverStepLands(a.r, a.c, b.r, b.c))
        return { found: false, reason: 'path edge not walkable', waypoints: [], expanded };
    }

    // Convert square path to protocol waypoints (center of each square).
    const waypoints = raw.map(({ r, c }) => ({
      x: c * KOD_FINENESS + KOD_FINENESS / 2,
      y: r * KOD_FINENESS + KOD_FINENESS / 2,
    }));
    // Append the exact destination as the final waypoint.
    waypoints.push({ x: toX, y: toY });
    return { found: true, waypoints, expanded };
  },

  // A bounded local A* for sub-square approaches that need to round a corner.
  // Arguments, step/margin distances, and returned waypoints are protocol/KOD
  // (x,y), 64 units/square. This is deliberately not the room router: the coarse
  // grid gets us near the exit,
  // then this resolves only the final BSP-scale gap with locally validated segments.
  finePathProtocol(fromX, fromY, toX, toY, {
    step = 8,
    margin = 12 * KOD_FINENESS,
    maxNodes = 20000,
  } = {}) {
    const _fpT0 = Date.now();
    const _fpResult = this._finePathProtocolImpl(fromX, fromY, toX, toY, { step, margin, maxNodes });
    const _fpMs = Date.now() - _fpT0;
    if (_fpMs > 1000) console.error(`[slow-finepath] room ${this.file}: finePathProtocol took ${_fpMs}ms (found=${_fpResult?.found})`);
    return _fpResult;
  },
};

// INSTALLED ONCE, AND NEVER OVER SOMETHING UPSTREAM ADDED LATER. If a name here ever turns
// up in roo itself, that is upstream having grown its own answer, and theirs should win a
// look before ours silently shadows it -- so say so rather than clobbering quietly.
const collisions = [];
for (const [name, fn] of Object.entries(NAV)) {
  if (name === 'finePathProtocol') {           // deliberate override, see the header
    RoomGeometry.prototype[name] = fn;
    continue;
  }
  if (Object.prototype.hasOwnProperty.call(RoomGeometry.prototype, name)) collisions.push(name);
  RoomGeometry.prototype[name] = fn;
}
if (collisions.length)
  console.error(`[navgeom] shadowing RoomGeometry method(s) upstream now defines: ${collisions.join(', ')}`);

export { RoomGeometry, KOD_FINENESS, protocolToClient, clientToProtocol };
