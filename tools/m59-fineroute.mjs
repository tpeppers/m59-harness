#!/usr/bin/env node
// A ROUTE THROUGH GROUND THE SQUARE GRID CANNOT DESCRIBE — PLANNED, NEVER WALKED.
//
//   node tools/m59-fineroute.mjs 579 --from 40,52 --to 52,30
//   node tools/m59-fineroute.mjs 589 --from 18,46 --to 45,32 --json
//   node tools/m59-fineroute.mjs 579 --from 40,52 --to 52,30 --allow-candidates
//
// CLI CONTRACT: `--from` and `--to` are `row,col` (KOD/RoomGeometry order).
//
// WHAT THIS IS FOR. The ordinary router plans on squares, and on the ground the mana nodes sit
// on a square is a lie: r40c33 in the Ancient Place spans 3520 to 10880 — the valley floor and
// the high ledge, one square, one number. Ask the square router to walk the spiral staircase up
// that cliff and it plans through the valley, because that is what the square says is there.
//
// So this is the OPT-IN one. Nothing consults it on the hot path; a caller that knows it is
// about to cross interesting geometry asks for a plan, gets a list of legs, and executes them
// with the verbs that already exist. It opens no socket and moves nobody.
//
// THE ALGORITHM IS `m59-jumpfinder.mjs`'S, AND THE ONE SENTENCE IS THE OPERATOR'S: A FALL IS
// A WALL. Run a never-descend closure from where the body stands and the room falls apart into
// the ribbon it can actually walk. Jumps are the only edges between ribbons. So the room is a
// small graph — closures as nodes, jumps as edges — and the search is breadth-first over it.
//
// TWO THINGS THIS ADDS, AND BOTH ARE WHY THE FINDER COULD NOT BE USED DIRECTLY:
//
//   IT EMITS THE WALK, NOT ONLY THE JUMPS. The finder answers "which hops bridge this room",
//   which is the question you ask once. A caller needs "and how do I get to the take-off",
//   which is a path INSIDE a closure, and the closure flood already knows it — it just threw
//   the parents away. Every waypoint comes out as a FINE POINT with real floor under it.
//
//   That is the whole of the r43c47 fix. A character told to `walk_to` the staircase in room
//   579 boarded it correctly and then stopped at r43c47 — a square spanning 4672 to 6208, the
//   gully floor AND stair four, one square, two worlds. Aiming at its centre is aiming at a
//   coin toss. Aiming at a fine point on the 6208 shelf is not.
//
//   IT PREFERS THE JUMPS SOMEBODY WALKED. `substrate/m59-falljumps.json` is operator-declared
//   and confirmed by a character arriving; a candidate this file invents is neither. So
//   declared jumps are tried first and offered alone unless `--allow-candidates` says
//   otherwise, and every leg says which kind it is. A plan made of declared jumps can be
//   executed by the broker's `jump` verb as it stands, because that verb ALREADY refuses
//   anything undeclared — so the default output is exactly the set of plans that are
//   executable today.
//
// EVERYTHING IT RETURNS IS A CLAIM ABOUT GEOMETRY, WHICH IS NOT THE SAME AS A ROUTE THAT
// WORKS. The finder's own warning applies unchanged: only a character arriving says a hop is
// real. `confidence` on the plan says which half you are holding.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedRoomGeometry, CLIENT_FINENESS as F, MAX_STEP_HEIGHT } from './m59-roo.mjs';
import { fallJumpsIn } from './m59-falljump.mjs';
import { clientToProtocol, protocolToClient } from './m59-finepos.mjs';
import { quantizeRailPoint } from './m59-railfollow.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// The client's own fall physics — clientd3d/move.h. Repeated here rather than imported so this
// module keeps working if m59-falljump.mjs's exports move; the constants are the game's.
// The fall arithmetic is shared with `m59-jumpfinder.mjs` — both files used to carry their
// own copy and both had the same bug. See m59-falljump-physics.mjs.
import { RUN_SPEED, reachFor, fallenBy, maxSpan } from './m59-falljump-physics.mjs';

/** Check an undeclared fall on actual centre floors and integer wire endpoints. */
export function proveCandidateFall(geo, candidate) {
  const floor=p=>geo.floorBaseAtClient(p.x,p.y,geo.leafAtClient(p.x,p.y));
  const a=candidate.fromFine,b=candidate.toFine,fa=floor(a),fb=floor(b);
  const span=Math.hypot(b.x-a.x,b.y-a.y),budget=maxSpan(fa-fb);
  let reason=!Number.isFinite(fa)||!Number.isFinite(fb)?'endpoint_has_no_floor'
    :span>budget?'fall_span_exceeds_actual_floor_budget':null;
  const trace=reason?null:geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{fall:true,timedFall:true});
  if(!reason&&trace?.arrived!==true)reason=trace?.reason??'timed_fall_not_proved';
  const quantize=p=>quantizeRailPoint(p,{floorAt:(x,y)=>floor({x,y}),
    edge:(a,b)=>geo.traceFineMoveClient(a.x,a.y,b.x,b.y)?.arrived===true});
  const fromWire=reason?null:quantize(a),toWire=reason?null:quantize(b);
  if(!reason&&(!fromWire.ok||!toWire.ok))reason='wire_endpoint_not_proved';
  const wireSpan=fromWire?.ok&&toWire?.ok?Math.hypot(toWire.client.x-fromWire.client.x,toWire.client.y-fromWire.client.y):null;
  if(!reason&&wireSpan>maxSpan(fromWire.floor-toWire.floor))reason='wire_fall_span_exceeds_budget';
  const wireTrace=reason?null:geo.traceFineMoveClient(fromWire.client.x,fromWire.client.y,toWire.client.x,toWire.client.y,{fall:true,timedFall:true});
  if(!reason&&wireTrace?.arrived!==true)reason=wireTrace?.reason??'wire_timed_fall_not_proved';
  return {model_proved:!reason,reason,from_floor_client:fa,to_floor_client:fb,
    span_client:span,max_span_client:budget,trace,from_wire:fromWire,to_wire:toWire,wire_trace:wireTrace};
}

/** Keep corners unless the mover proves the replacement chord reaches its endpoint. */
export function checkedWalkWaypoints(geo, points, { maxGap = F * 0.75, allowUnprovedEdges = false } = {}) {
  if (!points?.length) return { ok: true, points: [] };
  const lands = (a, b) => geo.traceFineMoveClient(a.x, a.y, b.x, b.y, { slide: true })?.arrived === true;
  const out = [points[0]], unproved = [];
  for (let i = 1; i < points.length; i++) {
    const anchor = out.at(-1), point = points[i];
    if (Math.hypot(point.x - anchor.x, point.y - anchor.y) <= maxGap && lands(anchor, point)) continue;
    const corner = points[i - 1];
    if (corner.x !== anchor.x || corner.y !== anchor.y) out.push(corner);
    if (!lands(corner, point)) {
      const failure = { reason: 'fine_walk_edge_not_proved', index: i, from: corner, to: point,
        trace: geo.traceFineMoveClient(corner.x, corner.y, point.x, point.y) };
      if (!allowUnprovedEdges) return { ok: false, ...failure };
      unproved.push(failure);out.push(point);
    }
  }
  const last = points.at(-1), anchor = out.at(-1);
  if (last.x !== anchor.x || last.y !== anchor.y) out.push(last);
  return { ok: true, points: out, unproved };
}

/**
 * A planner bound to one room. Built once and reused: the floor cache is the expensive part
 * and it is per room.
 */
export function fineRouter(roomNum, {
  step = 256,          // flood resolution, client units. F/4 — a quarter square.
  reach = 8,           // how many squares out to look for a candidate jump
  // HOW FAR A WALK MAY STEP DOWN, AND WHY IT IS NOT ZERO.
  //
  // `m59-jumpfinder.mjs` floods with NEVER-DESCEND, and that is right for what it does: a
  // fall is a wall, so forbidding descent carves the room into the ledges a body can walk
  // without committing. It is the wrong rule for a ROUTE. Measured here: the never-descend
  // closure from room 589's east anchor is 22 squares, while a character walked from r21c43
  // to the take-off at r35c16 in 37 steps — because that walk goes gently DOWNHILL, which is
  // an ordinary thing a walk does and which never-descend calls a cliff.
  //
  // Bounding it by MAX_STEP_HEIGHT in both directions was the next thing tried, and it is
  // still wrong: the closure from that same anchor was 128 squares and the take-off at
  // r35c16 was outside it, because the real walk crosses a drop of about two thousand units
  // on its way down the shelf. Swept against the walk a character actually made:
  //
  //     maxDescend  384/768/1536   128 squares   take-off NOT reachable
  //     maxDescend  3072          1280 squares   take-off reachable, node still not
  //     maxDescend  Infinity      1517 squares   take-off reachable, node still not
  //
  // So descent is UNBOUNDED, which is also what the game does — only climbing is capped
  // (clientd3d/move.c:55); walking off a drop is allowed and you simply fall. The important
  // half of that table is the last column: even with descent free, the node is NOT in the
  // closure, so the jump is genuinely load-bearing rather than an artifact of a strict flood.
  //
  // The cost is that a walk leg may contain a committing drop, so each one reports its
  // largest single descent. Pass `maxDescend: 64` for the finder's ledge-carving behaviour.
  maxDescend = Infinity,
  // How far apart consecutive waypoints may be. This is the follower's leash, not a drawing
  // resolution — see pathWithin.
  maxGap = F * 0.75,
  // Validate every flood edge with the mover's own fine trace. On by default: a plan the mover
  // refuses is not a plan. Off makes the flood a pure height model, which is what it was.
  strict = true,
  // Checked callers need reusable straight edges; legacy rails repair clipped slides.
  exactWalk = false,
  worldMap = null,
  geometry = null,     // live animated sectors, when supplied by a Session
} = {}) {
  const world = worldMap ?? JSON.parse(readFileSync(join(REPO, 'substrate', 'm59-map.json'), 'utf8'));
  const room = world.rooms?.[roomNum] ?? world.rooms?.[String(roomNum)];
  if (!room) throw new Error(`no room ${roomNum} in the map`);
  if (exactWalk && !strict) throw new Error('exactWalk requires collision tracing');
  const geo = geometry ?? sharedRoomGeometry(room);
  if (!geo?.collisionReady) throw new Error(`room ${roomNum} has no collision geometry`);
  // THE MASK FIRST. Without one, `neighbors({collision:true})` silently falls back to the
  // SERVER'S COARSE GRID, which holds a veto the mover does not — that is the trap that made a
  // hand-written probe report a cliff in room 578 that is not there.
  const mask = geo.buildStepMask();
  if (mask) geo.attachStepMask(mask);

  const hCache = new Map();
  const floorAt = (x, y) => {
    const k = (x >> 5) * 100000 + (y >> 5);
    if (hCache.has(k)) return hCache.get(k);
    let h = null;
    try { const leaf = geo.leafAtClient(x, y); h = leaf?.sector ? geo.floorBaseAtClient(x, y, leaf) : null; }
    catch { h = null; }
    hCache.set(k, h);
    return h;
  };
  // A BODY HAS WIDTH: what it stands on is the HIGHEST floor under its footprint, not the one
  // sample at its centre. One thin sample at a ledge edge is how a height profile swings seven
  // thousand units between two packets a second apart.
  // Memoised on the same grid as `floorAt`: nine lookups a call, and the flood asks for it on
  // every candidate of every direction. Uncached it was most of the search.
  const sCache = new Map();
  const standAt = (x, y) => {
    const k = (x >> 5) * 100000 + (y >> 5);
    if (sCache.has(k)) return sCache.get(k);
    let best = null;
    for (let dx = -160; dx <= 160; dx += 160)
      for (let dy = -160; dy <= 160; dy += 160) {
        const h = floorAt(x + dx, y + dy);
        if (h != null && (best == null || h > best)) best = h;
      }
    sCache.set(k, best);
    return best;
  };
  // `standAt` will happily name a point with no floor under it — the centre of a footprint can
  // be over the void. Anything that LEAVES this module is snapped to real floor, because that
  // is what the mover and `declaredFallJumps` validate.
  const snapToFloor = pt => {
    if (pt && floorAt(pt.x, pt.y) != null) return pt;
    for (let r = 40; r <= 320; r += 40)
      for (let a = 0; a < 12; a++) {
        const ang = a * Math.PI / 6;
        const x = Math.round(pt.x + Math.cos(ang) * r), y = Math.round(pt.y + Math.sin(ang) * r);
        if (floorAt(x, y) != null) return { x, y };
      }
    return null;
  };
  const key = (x, y) => ((x / step) | 0) + '|' + ((y / step) | 0);
  const sqOf = (x, y) => ({ row: ((y / F) | 0) + 1, col: ((x / F) | 0) + 1 });
  // The best footing inside a square, since the centre is routinely not it.
  const footing = (row, col) => {
    const x0 = (col - 1) * F, y0 = (row - 1) * F;
    let best = null;
    for (let i = 1; i < 8; i++) for (let k = 1; k < 8; k++) {
      const x = x0 + Math.round(F * i / 8), y = y0 + Math.round(F * k / 8);
      const h = floorAt(x, y);
      if (h != null && (best == null || h > best.h)) best = { x, y, h };
    }
    return best;
  };

  // MEMOISED, BECAUSE THE SEARCH ASKS FOR THE SAME FLOOD SEVERAL TIMES OVER. Every frontier
  // node floods, and then `plan` floods again to rebuild each leg's waypoints — so the winning
  // route's closures were being computed twice each. With the perpendicular offsets a flood is
  // no longer cheap (19,000 points, up to five traces a direction at the edges), and the
  // Ancient Place climb went from 8s to 384s before this. Keyed on the quantised start, which
  // is the same key the flood itself uses: two starts in one cell have the same closure.
  const closureCache = new Map();
  /** Everywhere reachable from here WITHOUT EVER STEPPING DOWN — and how we got to each. */
  function closure(start) {
    const ck0 = key(start.x, start.y);
    const hit = closureCache.get(ck0);
    if (hit) return hit;
    const built = closureUncached(start);
    closureCache.set(ck0, built);
    return built;
  }
  function closureUncached(start) {
    const seen = new Map([[key(start.x, start.y), { x: start.x, y: start.y, from: null }]]);
    // BREADTH-FIRST, AND THE DIFFERENCE IS THE WHOLE OUTPUT. Depth-first reaches exactly the
    // same points — the closure is the closure — but the parent chain it leaves behind is a
    // DFS tree, so walking it back gives the order the flood happened to visit rather than a
    // route. Measured: the first version emitted a 317-waypoint leg for room 589 that toured
    // the entire east shelf twice on its way to a take-off thirty seconds away. The set was
    // right and the path was nonsense.
    const q = [start];
    let head = 0;                        // an index, not shift(): shift() is O(n) per step
    const dirs = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) dirs.push([dx * step, dy * step]);
    // Straight on first, then nudged either way across the direction of travel. Thirds of
    // a step resolves a band of ~290 units against a step of 256.
    const PERP = [0, step / 3, -step / 3, (2 * step) / 3, -(2 * step) / 3];
    while (head < q.length) {
      const cur = q[head++];
      const hc = standAt(cur.x, cur.y);
      if (hc == null) continue;
      const ck = key(cur.x, cur.y);
      for (const [dx, dy] of dirs) {
        // A LATTICE CANNOT FIND A BAND NARROWER THAN ITS OWN PHASE, AND THE LAST STRIP OF THE
        // ANCIENT PLACE IS EXACTLY THAT.
        //
        // The operator's re-recorded crossing r37c33 -> r36c34 runs at CONSTANT y = 37638,
        // x 32200 -> 35055, hugging the south wall. The shelf is floor 7040 and about 290
        // units wide, with the valley at 3392 immediately north — against a body 496 wide
        // (2 * PLAYER_RADIUS). Only a narrow band of y is walkable at all.
        //
        // This flood steps a fixed `step` from wherever the last jump landed, so WHICH y it
        // samples inside that band is an accident of the landing. From the jump-1 landing it
        // sampled 37520 and 37776 — either side of the band — topped out at 8640 and never
        // found the spiral. Seeded by hand at the operator's own point, the SAME flood
        // reached 10880 and everything past it. Steps of 256, 128 and 64 all failed
        // identically, because the problem is PHASE, NOT STEP SIZE: a finer lattice with the
        // wrong offset misses a narrow band just as reliably.
        //
        // So each direction is also tried at a few offsets PERPENDICULAR to it, and the first
        // the mover accepts wins. Straight on is tried first and almost always succeeds, so
        // the extra traces are paid only at the edges — which is where the room is.
        const len = Math.hypot(dx, dy) || 1;
        const ux = -dy / len, uy = dx / len;          // unit perpendicular to this direction
        for (const off of PERP) {
          let nx = Math.round(cur.x + dx + ux * off);
          let ny = Math.round(cur.y + dy + uy * off);
          // Rounding a corner after planning can move its chord into a wall.
          // Search the integer wire lattice in checked mode, using the shared conversion.
          if (exactWalk) ({ x: nx, y: ny } = protocolToClient(clientToProtocol({ x: nx, y: ny })));
          if (nx < 0 || ny < 0 || nx > room.cols * F || ny > room.rows * F) continue;
          // NOT `seen.has(aimedKey)`, which was its own bug: a cell already reached by some
          // other aim says nothing about whether THIS aim lands somewhere new, and skipping
          // here threw away legitimate approaches before they were ever traced. Only the
          // position actually REACHED is checked against `seen`, below.
          const hn = standAt(nx, ny);
          if (hn == null) continue;
          if (hn < hc - maxDescend) continue;        // past this it is a fall, not a step
          if (hn > hc + MAX_STEP_HEIGHT) continue;   // and a cliff is a cliff
          // AND THE MOVER'S OWN ANSWER, WHICH IS THE ONLY ONE THAT DECIDES. Two floors being
          // level says the step is not a cliff; it says nothing about a WALL between them,
          // and the follower came off this very spiral scraping one (`slid: 0.75`).
          //
          // SLIDING IS NOT CHEATING, IT IS HOW YOU HUG A WALL. With `slide:false` this refused
          // so much that the chain broke at jump 2 — refusing the exact move the operator
          // describes as "hug the eastern wall and follow it round". The client slides; a
          // model that does not is stricter than the game. So the neighbour is wherever the
          // body actually ended up, not where it was aimed, which is also why the flood is
          // keyed on quantised position: two aims that slide to the same place are one place.
          let px = nx, py = ny;
          if (strict) {
            const t = geo.traceFineMoveClient(cur.x, cur.y, nx, ny, { slide: true });
            // Following a new aim at a slide's endpoint is a different command;
            // it need not retrace the original slide around the wall.
            if (!t || !t.moved || (exactWalk && t.arrived !== true)) continue;
            px = exactWalk ? nx : Math.round(t.x); py = exactWalk ? ny : Math.round(t.y);
            if (Math.hypot(px - cur.x, py - cur.y) < step / 4) continue;   // went nowhere
            const hs = standAt(px, py);
            if (hs == null || hs < hc - maxDescend || hs > hc + MAX_STEP_HEIGHT) continue;
          }
          const pk = key(px, py);
          if (seen.has(pk)) continue;
          seen.set(pk, { x: px, y: py, from: ck });
          q.push({ x: px, y: py });
          break;            // this direction is served; do not also take its nudges
        }
      }
    }
    return seen;
  }

  // THE PARENTS THE FINDER THREW AWAY. Walk them back and you have the path inside the ribbon,
  // in fine points, every one of which the flood already proved is standable from the last.
  function pathWithin(seen, toPt) {
    let k = key(toPt.x, toPt.y);
    if (!seen.has(k)) return null;
    const back = [];
    while (k != null) { const n = seen.get(k); if (!n) break; back.push({ x: n.x, y: n.y }); k = n.from; }
    back.reverse();
    // A moved slide is not a straight edge to its clipped endpoint. The closure
    // in exactWalk mode records only arrived edges. Legacy rails retain clipped
    // slides for their repair pass; both modes preserve proved corners.
    // Ice Caves emitted 33 refused chords after skipping its narrow bends.
    const checked = checkedWalkWaypoints(geo, back, { maxGap, allowUnprovedEdges: !exactWalk });
    return checked.ok ? checked.points : null;
  }

  // YOU CANNOT JUMP THROUGH A CLIFF, AND CHECKING ONLY THE ENDS SAYS YOU CAN.
  function clearBetween(a, b, hFrom, hTo) {
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const drop = hFrom - hTo;
    // ONE LINE, because the client's rule is one expression: `fallenBy(t) <= drop + step`.
    // This was the same two-branch cap `m59-jumpfinder.mjs` carried, permissive by 0.12
    // squares at dead level and RESTRICTIVE BY 0.65 at a one-step drop — and the restrictive
    // half hides real routes silently. See m59-falljump-physics.mjs. Corrected 2026-09-10.
    if (span > maxSpan(drop)) return false;
    const n = Math.max(2, Math.ceil(span / (F / 4)));
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const x = Math.round(a.x + (b.x - a.x) * f), y = Math.round(a.y + (b.y - a.y) * f);
      const h = standAt(x, y);
      if (h == null) continue;                        // open air under the arc is the point
      const t = (span * f) / RUN_SPEED;
      if (h > hFrom - fallenBy(t) + MAX_STEP_HEIGHT) return false;
    }
    return true;
  }

  // THE JUMPS SOMEBODY WALKED, AS FINE POINTS. `declaredFallJumps` answers in squares and the
  // squares are the half that lies here, so the raw table is read for `from_fine`/`to_fine`
  // where the operator supplied them and the square footing is used where they did not.
  const declared = (fallJumpsIn(roomNum) ?? []).map(j => {
    const fromFine = j.from_fine ? { x: j.from_fine.x, y: j.from_fine.y } : footing(j.from.row, j.from.col);
    const toFine = j.to_fine ? { x: j.to_fine.x, y: j.to_fine.y } : footing(j.to.row, j.to.col);
    return fromFine && toFine
      ? { from: j.from, to: j.to, fromFine, toFine, declared: true,
          requires: j.requires ?? null, note: j.note ?? null }
      : null;
  }).filter(Boolean);

  /** Candidate hops off the edge of a closure — invented, not walked. */
  function candidatesFrom(seen, goalPt, { audit = null, prove = true } = {}) {
    const out = [], tried = new Set();
    const refuse = (reason, from, to, hFrom, hTo) => {
      if (!audit) return;
      audit.rejections ??= {}; audit.examples ??= [];
      audit.rejections[reason] = (audit.rejections[reason] ?? 0) + 1;
      if (audit.examples.length < 48) audit.examples.push({ reason, from, to,
        from_footprint_floor_client: hFrom, to_footprint_floor_client: hTo,
        span_client: Math.hypot(to.x-from.x,to.y-from.y), max_span_client: maxSpan(hFrom-hTo) });
    };
    for (const p of seen.values()) {
      const hp = standAt(p.x, p.y);
      if (hp == null) continue;
      for (let a = 0; a < 16; a++) {
        const ang = a * Math.PI / 8;
        for (let d = F; d <= reach * F; d += F / 2) {
          const nx = Math.round(p.x + Math.cos(ang) * d), ny = Math.round(p.y + Math.sin(ang) * d);
          if (nx < 0 || ny < 0 || nx > room.cols * F || ny > room.rows * F) continue;
          if (seen.has(key(nx, ny))) continue;
          const hn = standAt(nx, ny);
          if (hn == null) continue;
          const k = key(nx, ny);
          if (tried.has(k)) continue;
          const aim = { x: nx, y: ny };
          if (Math.hypot(nx-p.x,ny-p.y) > maxSpan(hp-hn)) {
            refuse('fall_span_exceeds_budget', {x:p.x,y:p.y}, aim, hp, hn); continue;
          }
          if (!clearBetween(p, aim, hp, hn)) {
            refuse('intermediate_floor_above_fall_arc', {x:p.x,y:p.y}, aim, hp, hn); continue;
          }
          const candidate={fromFine:{x:p.x,y:p.y},toFine:aim};
          const proof=prove?proveCandidateFall(geo,candidate):null;
          if(proof&&!proof.model_proved){
            refuse(proof.reason,candidate.fromFine,aim,hp,hn);continue;
          }
          // Check walls BEFORE remembering a landing or spending the branch budget.
          // A failed approach does not disprove the landing from another takeoff.
          // Peak's entrance (5056) poisoned every landing before its 8896 shelf
          // was examined, leaving zero proposed jumps. Remember only a proposal.
          tried.add(k);
          out.push({ fromFine: proof?.from_wire.client??candidate.fromFine,
            toFine: proof?.to_wire.client??aim, d, hTo: hn });
        }
      }
    }
    // One per landing square, ranked by what it BUYS. Shortest-first spends the whole budget on
    // one-square shuffles along the ledge that land back where they started.
    const bySquare = new Map();
    for (const c of out) {
      const s = sqOf(c.toFine.x, c.toFine.y), k = s.row + ',' + s.col;
      const prev = bySquare.get(k);
      if (!prev || c.d < prev.d) bySquare.set(k, c);
    }
    const toGoal = c => goalPt ? Math.hypot(c.toFine.x - goalPt.x, c.toFine.y - goalPt.y) : 0;
    return [...bySquare.values()]
      .sort((a, b) => (goalPt ? toGoal(a) - toGoal(b) : 0) || (b.hTo - a.hTo) || (a.d - b.d))
      .map(c => ({ from: sqOf(c.fromFine.x, c.fromFine.y), to: sqOf(c.toFine.x, c.toFine.y),
                   fromFine: c.fromFine, toFine: c.toFine, declared: false }));
  }

  /**
   * Plan a route. Returns { ok, legs, jumps, confidence, ... }.
   * `legs` alternate walk and jump and are executable as they stand:
   *   { kind: 'walk', waypoints: [{x,y,row,col}...] }   -> walk_to { x, y }
   *   { kind: 'jump', from, to, fromFine, toFine }      -> jump { to_row, to_col }
   */
  // A WALK LEG SAYS HOW FAR IT DROPS. With descent unbounded the flood will happily route a
  // body off a ledge, and that is usually right and occasionally a fall the caller would
  // rather know about before it happens.
  // WHERE INSIDE THE TAKE-OFF SQUARE THE FLOOD ACTUALLY GOT, at the height the jump leaves
  // from. Null when the closure only reached some other shelf of that square, which is a real
  // answer: standing in the valley under a ledge is not standing on the ledge.
  function reachableTakeoff(seen, j) {
    const want = standAt(j.fromFine.x, j.fromFine.y);
    if (want == null) return null;
    const { row, col } = j.from;
    let best = null;
    for (const p of seen.values()) {
      if (((p.y / F) | 0) + 1 !== row || ((p.x / F) | 0) + 1 !== col) continue;
      const h = standAt(p.x, p.y);
      if (h == null || Math.abs(h - want) > MAX_STEP_HEIGHT) continue;
      const d = Math.hypot(p.x - j.fromFine.x, p.y - j.fromFine.y);
      if (!best || d < best.d) best = { d, x: p.x, y: p.y };
    }
    return best ? snapToFloor({ x: best.x, y: best.y }) : null;
  }

  function walkLeg(points) {
    const waypoints = points.map(p => ({ ...p, ...sqOf(p.x, p.y) }));
    let worst = 0;
    for (let i = 1; i < waypoints.length; i++) {
      const a = standAt(waypoints[i - 1].x, waypoints[i - 1].y);
      const b = standAt(waypoints[i].x, waypoints[i].y);
      if (a != null && b != null && a - b > worst) worst = a - b;
    }
    const unproved = waypoints.slice(1).flatMap((p, i) => {
      const from = waypoints[i], trace = geo.traceFineMoveClient(from.x, from.y, p.x, p.y);
      return trace?.arrived === true ? [] : [{ index: i + 1, from, to: p, trace }];
    });
    return { kind: 'walk', waypoints, biggest_drop: worst, walk_proof: { checked: unproved.length === 0, unproved } };
  }

  function plan(from, to, { maxJumps = 4, allowCandidates = false, branch = 12 } = {}) {
    const startPt = from.x != null && from.y != null
      ? snapToFloor({ x: from.x, y: from.y }) : footing(from.row, from.col);
    if (!startPt) return { ok: false, why: `no footing anywhere inside ${from.row},${from.col}` };
    const goalPt = footing(to.row, to.col);
    if (!goalPt) return { ok: false, why: `no footing anywhere inside ${to.row},${to.col}` };

    const inTarget = seen => {
      for (const p of seen.values()) { const s = sqOf(p.x, p.y); if (s.row === to.row && s.col === to.col) return true; }
      return false;
    };
    const pointInTarget = seen => {
      // Prefer the closure point nearest the goal's own footing, so the last walk ends on the
      // part of the square that has floor rather than at its centre.
      let best = null;
      for (const p of seen.values()) {
        const s = sqOf(p.x, p.y);
        if (s.row !== to.row || s.col !== to.col) continue;
        const d = Math.hypot(p.x - goalPt.x, p.y - goalPt.y);
        if (!best || d < best.d) best = { d, p };
      }
      return best?.p ?? null;
    };

    const t0 = Date.now();
    let frontier = [{ at: startPt, path: [] }];
    const visited = new Set();
    const trace = [];
    for (let depth = 0; depth <= maxJumps; depth++) {
      const next = [];
      for (const node of frontier) {
        const k = key(node.at.x, node.at.y);
        if (visited.has(k)) continue;
        visited.add(k);
        const seen = closure(node.at);
        const squares = new Set([...seen.values()].map(p => { const s = sqOf(p.x, p.y); return s.row + ',' + s.col; }));
        trace.push({ jumps: node.path.length, points: seen.size, squares: squares.size,
                     after: node.path.map(j => `${j.from.row},${j.from.col}->${j.to.row},${j.to.col}`) });
        if (inTarget(seen)) {
          const end = pointInTarget(seen);
          const legs = [];
          let cursor = { seen, at: node.at };
          // Rebuild leg by leg: each jump's take-off is a walk inside the closure it leaves.
          let walkSeen = closure(startPt), here = startPt;
          for (const j of node.path) {
            const wp = pathWithin(walkSeen, j.fromFine);
            if (!wp) return { ok: false, why: 'fine walk to takeoff is not proved', trace, ms: Date.now() - t0 };
            legs.push(walkLeg(wp));
            legs.push({ kind: 'jump', from: j.from, to: j.to, fromFine: j.fromFine, toFine: j.toFine,
                        declared_from: j.declaredFrom ?? j.fromFine,
                        declared_to: j.declaredTo ?? j.toFine,
                        declared: j.declared === true, requires: j.requires ?? null });
            here = j.toFine;
            walkSeen = closure(here);
          }
          const wp = pathWithin(walkSeen, end);
          if (!wp) return { ok: false, why: 'fine walk to goal is not proved', trace, ms: Date.now() - t0 };
          legs.push(walkLeg(wp));
          void cursor;
          const jumps = legs.filter(l => l.kind === 'jump');
          return { ok: true, room: roomNum, from, to, legs, trace,
                   jumps: jumps.length,
                   all_declared: jumps.every(j => j.declared),
                   confidence: jumps.length === 0 ? 'walk only — no jump involved'
                     : jumps.every(j => j.declared)
                       ? 'every jump is operator-declared and was walked by a character'
                       : 'CONTAINS UNDECLARED CANDIDATES — geometry says possible, nobody has walked it',
                   ms: Date.now() - t0 };
        }
        if (depth === maxJumps) continue;
        // DECLARED FIRST, ALWAYS. A jump somebody walked outranks one this file invented, and
        // the broker's `jump` verb will only execute the former anyway.
        //
        // AND "IS THE TAKE-OFF REACHABLE" IS NOT `seen.has(itsFinePoint)`. That was the bug
        // this module shipped with, and it is the SAME split-square mistake it exists to fix,
        // committed one level up. r40c33 in the Ancient Place spans 3520 to 10880; the flood
        // reaches its valley half and not its ledge, so the square is "in the closure" while
        // the exact quarter-square cell under the declared take-off is not. Jump 1 — the one
        // the whole climb turns on — was silently never offered.
        //
        // So ask the right question: is there a flooded cell INSIDE the take-off square,
        // standing at the take-off's own height. That cell is also where the walk should
        // actually be sent, which is why it is returned rather than merely tested.
        const usable = declared.map(j => {
          const at = reachableTakeoff(seen, j);
          // KEEP THE DECLARED POINT AS WELL AS THE REACHABLE ONE. `fromFine` becomes the cell
          // the flood actually got to, which is what the WALK should aim at; but the JUMP has
          // to leave from the point the operator left from. They sit about eighty units apart
          // on jump 1 of the Ancient Place, which does not sound like much and is the whole
          // difference between firing `from: {40,33}` and `from: {41,34}` — one lands, the
          // other reports success and moves nobody.
          return at ? { ...j, fromFine: at, declaredFrom: j.fromFine, declaredTo: j.toFine } : null;
        }).filter(Boolean);
        const cands = allowCandidates ? candidatesFrom(seen, goalPt).slice(0, branch) : [];
        for (const c of [...usable, ...cands]) {
          const fromPt = snapToFloor(c.fromFine), toPt = snapToFloor(c.toFine);
          if (!fromPt || !toPt) continue;
          const fa = floorAt(fromPt.x, fromPt.y), fb = floorAt(toPt.x, toPt.y);
          if (fa == null || fb == null) continue;
          // A DECLARED JUMP IS NOT RE-ADJUDICATED. Somebody stood on that ledge and made it;
          // the physics here is a model and the model is the thing that has been wrong before.
          // Candidates get the full test, because nothing else vouches for them.
          if (!c.declared) {
            // maxSpan(drop + step) permits level and small uphill landings too.
            // A second downhill-only rule contradicted the shared fall arithmetic.
            if (!clearBetween(fromPt, toPt, fa, fb)) continue;
          }
          next.push({ at: toPt, path: [...node.path, { ...c, fromFine: fromPt, toFine: toPt }] });
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return { ok: false, why: `no route to ${to.row},${to.col} within ${maxJumps} jump(s)`,
             trace, ms: Date.now() - t0 };
  }

  // HAND OUT THE KEY, BECAUSE EVERY CONSUMER THAT RE-DERIVED IT GOT IT WRONG.
  //
  // `closure` returns a Map keyed by QUANTISED position — `((x/step)|0)+'|'+((y/step)|0)`,
  // with `step` the flood resolution, not a fixed constant. A caller asking "is this point in
  // the closure" has to reproduce both the arithmetic and the separator, and m59-gap.mjs's
  // first version used `x >> 5` with a comma: every membership test answered FALSE, including
  // for the closure's own start point, and the report confidently said a reachable square was
  // unreachable. An undefined-shaped lookup that cannot fail loudly is the commonest bug in
  // this repository, so the key is part of the API now.
  return { plan, closure, candidateJumps: candidatesFrom, footing, floorAt, standAt, declared, geo, room, key, step,
           inClosure: (set, x, y) => set.has(key(x, y)) };
}

// ---------------------------------------------------------------- CLI
if (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith('m59-fineroute.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };
  const pair = s => { const [a, b] = String(s).split(',').map(Number); return { row: a, col: b }; };
  const ROOM = Number(argv.find(a => !a.startsWith('--')));
  if (!ROOM || has('help')) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n').slice(1).filter(l => l.startsWith('//'))
      .map(l => l.replace(/^\/\/ ?/, '')).join('\n').split('\n\n').slice(0, 2).join('\n\n'));
    process.exit(ROOM ? 0 : 2);
  }
  const from = flag('from') ? pair(flag('from')) : null;
  const to = flag('to') ? pair(flag('to')) : null;
  if (!from || !to) { console.error('need --from row,col and --to row,col'); process.exit(2); }
  const R = fineRouter(ROOM, { exactWalk: has('exact-walk') });
  const out = R.plan(from, to, { maxJumps: Number(flag('max-jumps', 4)),
                                 allowCandidates: has('allow-candidates') });
  if (has('json')) { console.log(JSON.stringify(out, null, 1)); process.exit(out.ok ? 0 : 2); }
  console.log(`room ${ROOM} — ${R.room.name}`);
  console.log(`from ${from.row},${from.col}  to ${to.row},${to.col}` +
              `   (${R.declared.length} declared jump(s) in this room)`);
  for (const t of out.trace ?? [])
    console.log(`  ${t.jumps} jump(s) in: ${t.points} points / ${t.squares} squares` +
                (t.after.length ? `   after ${t.after.join(' then ')}` : ''));
  console.log('');
  if (!out.ok) { console.log(out.why); process.exit(2); }
  console.log(`PLAN — ${out.jumps} jump(s), ${out.ms}ms`);
  console.log(`  ${out.confidence}`);
  for (const [i, leg] of out.legs.entries()) {
    if (leg.kind === 'walk')
      console.log(`  ${String(i + 1).padStart(2)}. walk  ${leg.waypoints.length} waypoint(s)` +
                  (leg.biggest_drop ? `  (biggest drop ${leg.biggest_drop})` : '') + '  ' +
                  leg.waypoints.map(p => `r${p.row}c${p.col}`).join(' > '));
    else
      console.log(`  ${String(i + 1).padStart(2)}. JUMP  r${leg.from.row}c${leg.from.col} -> ` +
                  `r${leg.to.row}c${leg.to.col}   fine ${leg.fromFine.x},${leg.fromFine.y} -> ` +
                  `${leg.toFine.x},${leg.toFine.y}  ${leg.declared ? '[declared]' : '[CANDIDATE]'}`);
  }
  console.log('');
  console.log('A plan is a claim about geometry. Only a character arriving says it is real.');
}
