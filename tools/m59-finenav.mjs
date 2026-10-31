// FINE NAVIGATION GRAPH: load a baked (square, footing) graph and plan on it. Nothing calls this yet.
//
// docs/m59-fine-nav-design.md is the argument; tools/m59-finenav-bake.mjs is the writer. This
// module is the READER and the QUERY, and it is deliberately OFF THE HOT PATH in this stage: no
// keeper, broker or walker imports it. It exists so the bake has a consumer that tests can hold
// to account before anything moves on it.
//
// WHAT A NODE IS. A FOOTING: a strongly connected piece of body-clear floor inside one square.
// "Body-clear" means a body can BE there (at least PLAYER_RADIUS from any wall that blocks it
// from that side, and never on a wall line); "strongly connected" because walls in this game
// are one-sided per sidedef and drops are one-way (clientd3d/move.c:530-540). 578's r2c10 is
// two footings, east and west of a one-sided wall at x=9728, and the square graph's single
// node for it is how a plan was made from a stand point the body never reached.
//
// WHAT AN EDGE IS, AND THE ONE PROPERTY THAT MATTERS. Every edge leaves from its footing's
// REPRESENTATIVE point and records WHERE THE BODY LANDS:
//
//   walk   straight trace rep(a) -> rep(b), arrives exactly at rep(b)
//   slide  aimed at rep(b) (`aim`), the mover slides and stops at `land` (a wire point); from
//          `land` a straight walk reaches rep(to). `to` is the footing the body is really in,
//          which is NOT necessarily b and not necessarily b's square
//   fall   rep(a) -> rep(b) only with `fall: true` (one-way, 2-3 squares); `timed` says whether
//          the frame-by-frame fall (m59-falltrace.mjs) also proves it
//
// So a plan is a chain rep -> (aim, land) -> rep -> ..., and every link was proved from where
// the body is at that moment. There is no "plan the next step from a stand point".
//
// COORDINATES. Points in this API are CLIENT/BSP units (1024 a square) unless a field says
// `wire` (KOD/protocol, 64 a square). Squares are named {row, col}. A footing is a room-local
// integer; `footingKey` spells it `"row,col#k"`, where k = 0 is the footing that holds the
// square's legacy stand point — so the legacy `"row,col"` key means footing 0, and only the
// 7% of squares with more than one footing ever need the suffix.
//
// ANIMATED SECTORS ARE NOT SILENTLY FROZEN. A room whose routing table carries door variants
// (`stepMaskVariants`) is baked once per variant; a plan names the state it used, and when the
// caller does not say which state the door is in the answer is flagged `door_state_assumed`.
// Moving sectors listed in substrate/m59-variable-sectors.json that no variant covers are
// reported on every plan in that room as `unmodelled_moving_sectors`.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { protocolToClient, clientToProtocol, protocolToward, MAX_STEP_HEIGHT,
         CLIENT_FINENESS as F } from './m59-roo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FINE_NAV_FILE = join(HERE, '..', 'substrate', 'm59-finenav.json.gz');
export const FINE_NAV_FORMAT = 'm59-finenav/1';
// Bump whenever what a footing or an edge MEANS changes. A table from another version is
// refused wholesale, exactly as a step mask from another predicate is (stepMaskCurrent).
export const FINE_NAV_VERSION = 1;

export const EDGE = Object.freeze({ WALK: 0, SLIDE: 1, FALL: 2, FALL_UNTIMED: 3 });
export const EDGE_NAME = ['walk', 'slide', 'fall', 'fall_untimed'];
// slide:false is kept for exactly three questions, all stricter than the live mover and all
// about PLACE rather than motion: the 2-unit clearance probes (a slide would hide the wall
// contact that says a body cannot stand there), the lattice adjacency inside a footing and the
// pulled chains through it (an unobstructed straight trace arrives identically with slide on —
// the slide branch is only taken on contact — so these are a subset of what the live mover
// makes), and membership tests in `footingAt`. Every EDGE is proved with the live options.
export const STRAIGHT = Object.freeze({ slide: false });

// ------------------------------------------------------------------------------- encoding
//
// Per room, typed arrays as base64. Footings are sorted by square, footing 0 of each square
// first. 14 bits of an edge's Uint16 are the target footing and 2 bits its kind, so a room
// may hold at most 16383 footings; the bake refuses a room past that rather than wrap.
const b64 = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const un64 = (s, T) => { const b = Buffer.from(s, 'base64'); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
export const MAX_FOOTINGS = 0x3fff;

/** Encode one room graph (the bake's in-memory shape) for the table. */
export function encodeRoom(g) {
  const n = g.footings.length;
  if (n > MAX_FOOTINGS) throw new Error(`room ${g.room}: ${n} footings exceeds ${MAX_FOOTINGS}`);
  const sq = new Uint16Array(n), rep = new Uint16Array(n), floor = new Int32Array(n), deg = new Uint8Array(n);
  const eto = [], slides = [], vias = [];
  g.footings.forEach((f, i) => {
    sq[i] = (f.row - 1) * g.cols + (f.col - 1);
    // reps sit on the wire lattice (16 client units): offsets inside the square are 0..63
    rep[i] = (((f.rep.x - (f.col - 1) * F) >> 4) << 6) | ((f.rep.y - (f.row - 1) * F) >> 4);
    floor[i] = f.floor;
    if (f.edges.length > 255) throw new Error(`room ${g.room}: footing ${i} has ${f.edges.length} edges`);
    deg[i] = f.edges.length;
    for (const e of f.edges) {
      if (e.land) slides.push(eto.length, e.aim, clientToProtocol(e.land.x), clientToProtocol(e.land.y));
      if (e.via?.length) { vias.push(eto.length, e.via.length); for (const p of e.via) vias.push(clientToProtocol(p.x), clientToProtocol(p.y)); }
      eto.push((e.kind << 14) | e.to);
    }
  });
  return {
    rows: g.rows, cols: g.cols, footings: n, edges: eto.length,
    sq: b64(sq), rep: b64(rep), floor: b64(floor), deg: b64(deg), eto: b64(Uint16Array.from(eto)),
    slides: b64(Uint32Array.from(slides)), vias: b64(Uint32Array.from(vias)),
    exits: g.exits, stats: g.stats, moving: g.moving ?? null,
    ...(g.variants ? { variants: Object.fromEntries(Object.entries(g.variants).map(([k, v]) => [k, encodeRoom(v)])) } : {}),
    ...(g.variant ? { variant: g.variant } : {}),
  };
}

/** Decode a stored room into the query shape. */
export function decodeRoom(r, roomNum = null) {
  const sq = un64(r.sq, Uint16Array), rep = un64(r.rep, Uint16Array), floor = un64(r.floor, Int32Array);
  const deg = un64(r.deg, Uint8Array), eto = un64(r.eto, Uint16Array), sl = un64(r.slides, Uint32Array);
  const slideAt = new Map(), viaAt = new Map();
  const vs = r.vias ? un64(r.vias, Uint32Array) : new Uint32Array(0);
  for (let i = 0; i < vs.length;) {
    const at = vs[i], n = vs[i + 1], pts = [];
    for (let k = 0; k < n; k++) pts.push({ x: protocolToClient(vs[i + 2 + 2 * k]), y: protocolToClient(vs[i + 3 + 2 * k]) });
    viaAt.set(at, pts); i += 2 + 2 * n;
  }
  for (let i = 0; i < sl.length; i += 4)
    slideAt.set(sl[i], { aim: sl[i + 1], land: { x: protocolToClient(sl[i + 2]), y: protocolToClient(sl[i + 3]) } });
  const footings = [], bySquare = new Map();
  let e = 0;
  for (let i = 0; i < r.footings; i++) {
    const row = Math.floor(sq[i] / r.cols) + 1, col = (sq[i] % r.cols) + 1;
    const x = (col - 1) * F + ((rep[i] >> 6) << 4), y = (row - 1) * F + ((rep[i] & 63) << 4);
    const edges = [];
    for (let k = 0; k < deg[i]; k++, e++) {
      const kind = eto[e] >> 14, to = eto[e] & MAX_FOOTINGS;
      const edge = { to, kind, ...(slideAt.get(e) ?? {}) };
      if (viaAt.has(e)) edge.via = viaAt.get(e);
      edges.push(edge);
    }
    const list = bySquare.get(sq[i]) ?? [];
    const f = { id: i, row, col, k: list.length, rep: { x, y }, floor: floor[i], edges };
    list.push(i); bySquare.set(sq[i], list);
    footings.push(f);
  }
  const g = { room: roomNum, rows: r.rows, cols: r.cols, footings, bySquare, exits: r.exits ?? [],
              stats: r.stats ?? null, moving: r.moving ?? null, variant: r.variant ?? null, variants: null };
  if (r.variants) g.variants = Object.fromEntries(Object.entries(r.variants).map(([k, v]) => [k, decodeRoom(v, roomNum)]));
  return g;
}

// ------------------------------------------------------------------------------- loading

/** Read the table if it was baked from THIS map with THIS format. Null and a reason otherwise. */
export function loadFineNav(map, { file = FINE_NAV_FILE } = {}) {
  if (!existsSync(file)) return { table: null, why: `no fine-nav table — run node tools/m59-finenav-bake.mjs` };
  let t;
  try {
    const raw = readFileSync(file);
    t = JSON.parse((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
  } catch (err) { return { table: null, why: `fine-nav table unreadable: ${err.message}` }; }
  if (t.format !== FINE_NAV_FORMAT || t.version !== FINE_NAV_VERSION)
    return { table: null, why: `fine-nav table is ${t.format} v${t.version}; this build reads ${FINE_NAV_FORMAT} v${FINE_NAV_VERSION} — rebake` };
  if (map && t.geometryManifestSha256 !== map.geometryManifestSha256)
    return { table: null, why: 'fine-nav table was baked from different geometry — rebake' };
  t._decoded = new Map();
  return { table: t, why: null };
}

/**
 * The decoded graph for a room, in a given door state. `doorState` is a routing-table variant
 * key (`sector1@340`) or null for the shipped geometry. A state that was not baked is refused.
 */
export function fineNavRoom(table, roomNum, { doorState = null } = {}) {
  const stored = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
  if (!stored) return { graph: null, why: `room ${roomNum} is not in the fine-nav table` };
  let base = table._decoded?.get(String(roomNum));
  if (!base) { base = decodeRoom(stored, Number(roomNum)); table._decoded?.set(String(roomNum), base); }
  if (!doorState) return { graph: base, why: null, door_state_assumed: !!base.variants };
  const v = base.variants?.[doorState];
  return v ? { graph: v, why: null, door_state_assumed: false }
           : { graph: null, why: `room ${roomNum} has no baked door state ${doorState}` };
}

export const footingKey = (g, id) => {
  const f = g.footings[id];
  return f.k === 0 ? `${f.row},${f.col}` : `${f.row},${f.col}#${f.k}`;
};
export const footingsIn = (g, row, col) => (g.bySquare.get((row - 1) * g.cols + (col - 1)) ?? []);

// ------------------------------------------------------------------------------- the mover's arithmetic

/**
 * Where a body at `from` ends up when the mover is asked for `aim` — the same arithmetic as
 * `RoomGeometry._moverStepFrom` (slide, then round toward the start onto the wire lattice and
 * re-trace until it arrives), but aimed at a POINT rather than a square's stand point.
 * Returns the landing in client units on the wire lattice, or null if the body does not move.
 */
export function landFrom(geo, from, aim, opts = {}) {
  const requested = geo.traceFineMoveClient(from.x, from.y, aim.x, aim.y, { slide: true, ...opts });
  if (!requested.available || !requested.moved) return null;
  let qx = protocolToward(requested.x, from.x), qy = protocolToward(requested.y, from.y);
  for (let attempt = 0; attempt < 8; attempt++) {
    const x = protocolToClient(qx), y = protocolToClient(qy);
    const t = geo.traceFineMoveClient(from.x, from.y, x, y, { slide: true, ...opts });
    if (!t.available || !t.moved) return null;
    if (t.arrived) return { x, y, straight: !!requested.arrived };
    const nx = protocolToward(t.x, from.x), ny = protocolToward(t.y, from.y);
    if (nx === qx && ny === qy) return null;
    qx = nx; qy = ny;
  }
  return null;
}

/**
 * Which footing a body at `p` is in. `member`: the body can walk straight to the footing's
 * representative AND back (it is genuinely there). `walk_in`: only forward — enough to START
 * a plan, which is all the first leg needs. Looks in p's own square first, then its eight
 * neighbours (a body hugging a square edge is often closer to the next square's rep).
 */
export function footingAt(geo, g, p, { maxTraces = 32 } = {}) {
  const row = Math.floor(p.y / F) + 1, col = Math.floor(p.x / F) + 1;
  const h = geo.floorBaseAtClient(p.x, p.y);
  const cands = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++)
    for (const id of footingsIn(g, row + dr, col + dc)) {
      const f = g.footings[id];
      if (h != null && f.floor - h > MAX_STEP_HEIGHT) continue;            // a climb is not a way in
      cands.push({ id, d: Math.hypot(f.rep.x - p.x, f.rep.y - p.y) + (dr || dc ? F : 0) });
    }
  cands.sort((a, b) => a.d - b.d);
  // A forward-only way in may be a step OFF a ledge: a body on a high shelf whose own footing
  // will not take it back (it stands too close to a wall) can still walk into the valley. So
  // among forward-only answers the one at the body's own height wins, then the nearest —
  // never simply the first, which is how a first leg would drop the body off the cliff it is on.
  let traces = 0;
  const forward = [];
  for (const c of cands) {
    if (traces + 2 > maxTraces) break;
    const f = g.footings[c.id];
    if (c.d < 1) return { footing: c.id, how: 'member', traces };
    traces++;
    if (!geo.traceFineMoveClient(p.x, p.y, f.rep.x, f.rep.y, STRAIGHT).arrived) continue;
    traces++;
    if (geo.traceFineMoveClient(f.rep.x, f.rep.y, p.x, p.y, STRAIGHT).arrived) return { footing: c.id, how: 'member', traces };
    forward.push({ id: c.id, dh: h == null ? 0 : Math.abs(f.floor - h) > MAX_STEP_HEIGHT ? 1 : 0, d: c.d });
  }
  forward.sort((a, b) => a.dh - b.dh || a.d - b.d);
  return forward.length ? { footing: forward[0].id, how: 'walk_in', traces, drops: forward[0].dh > 0 }
                        : { footing: null, how: 'none', traces };
}

// ------------------------------------------------------------------------------- planning

/**
 * A* over footings. `goal` is one of:
 *   { footing }            exactly that footing
 *   { row, col }           any footing in that square
 *   { exitTo }             any footing an exit to that room attaches to
 * `falls`: 'timed' (default) uses only falls the frame-by-frame trace proves; 'any' also the
 * bake's plain `fall: true` ones, which is what the square bake has always used.
 */
export function planFootings(g, fromId, goal, { falls = 'timed', maxNodes = 200000 } = {}) {
  const goals = new Set();
  if (goal.footing != null) goals.add(goal.footing);
  else if (goal.exitTo != null) for (const e of g.exits) { if (Number(e.to) === Number(goal.exitTo)) goals.add(e.footing); }
  else for (const id of footingsIn(g, goal.row, goal.col)) goals.add(id);
  if (!goals.size) return { found: false, why: 'goal has no footing' };
  const goalPts = [...goals].map(id => g.footings[id].rep);
  const hfun = p => { let m = Infinity; for (const q of goalPts) m = Math.min(m, Math.hypot(p.x - q.x, p.y - q.y)); return m; };
  const dist = new Map([[fromId, 0]]), prev = new Map();
  // binary heap of [f, id]
  const heap = [[hfun(g.footings[fromId].rep), fromId]];
  const push = it => { heap.push(it); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  let expanded = 0, hit = null;
  while (heap.length) {
    const [, id] = pop();
    if (goals.has(id)) { hit = id; break; }
    if (++expanded > maxNodes) return { found: false, why: 'node budget' };
    const f = g.footings[id], d0 = dist.get(id);
    for (let ei = 0; ei < f.edges.length; ei++) {
      const e = f.edges[ei];
      if (e.kind === EDGE.FALL_UNTIMED && falls !== 'any') continue;
      const t = g.footings[e.to];
      const pts = [...(e.land ? [e.land] : []), ...(e.via ?? []), t.rep];
      let cost = 0, p = f.rep;
      for (const q of pts) { cost += Math.hypot(q.x - p.x, q.y - p.y); p = q; }
      const nd = d0 + cost;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { from: id, edge: ei }); push([nd + hfun(t.rep), e.to]); }
    }
  }
  if (hit == null) return { found: false, why: 'no route on the footing graph', expanded };
  const chain = [];
  for (let at = hit; at !== fromId; at = prev.get(at).from) chain.push({ to: at, ...prev.get(at) });
  chain.reverse();
  return { found: true, goal: hit, cost: dist.get(hit), expanded, chain };
}

/**
 * Turn a footing chain into LEGS the mover can be handed, each one proved from where the body
 * is when it starts. Client units.
 *   { kind: 'walk', aim }                       straight to aim; the body arrives at aim
 *   { kind: 'slide', aim, land, then }          aim, the body stops at land, then walk to `then`
 *   { kind: 'fall', aim, timed }                fall: true to aim
 */
export function legsOf(g, fromPoint, startFooting, chain) {
  const legs = [];
  const start = g.footings[startFooting];
  if (fromPoint && (fromPoint.x !== start.rep.x || fromPoint.y !== start.rep.y))
    legs.push({ kind: 'walk', aim: { ...start.rep }, footing: startFooting, first: true });
  for (const c of chain) legs.push(...edgeLegs(g, g.footings[c.from].edges[c.edge]));
  return legs;
}

/** The legs one edge stands for, from its footing's representative. */
export function edgeLegs(g, e) {
  const t = g.footings[e.to], via = e.via ?? [];
  if (e.kind === EDGE.WALK)
    return [...via.map(p => ({ kind: 'walk', aim: { ...p } })), { kind: 'walk', aim: { ...t.rep }, footing: e.to }];
  if (e.kind === EDGE.SLIDE) {
    const after = [...via, t.rep];
    return [{ kind: 'slide', aim: { ...g.footings[e.aim].rep }, land: { ...e.land }, then: { ...after[0] }, ...(after.length === 1 ? { footing: e.to } : {}) },
            ...after.slice(1).map((p, i, arr) => ({ kind: 'walk', aim: { ...p }, ...(i === arr.length - 1 ? { footing: e.to } : {}) }))];
  }
  // a fall with a recorded landing: the timed fall is aimed AT the landing (it was proved
  // there, and a timed fall never clips); the untimed one at the target it was baked against
  const timed = e.kind === EDGE.FALL;
  if (!e.land) return [{ kind: 'fall', aim: { ...t.rep }, timed, footing: e.to }];
  const after = [...via, t.rep];
  return [{ kind: 'fall', aim: timed ? { ...e.land } : { ...g.footings[e.aim].rep }, land: { ...e.land }, timed },
          ...after.map((p, i, arr) => ({ kind: 'walk', aim: { ...p }, ...(i === arr.length - 1 ? { footing: e.to } : {}) }))];
}

/**
 * Plan from a body's exact fine point to a goal on the footing graph, with a FLAGGED fallback
 * to the square planner. Never silent: every answer says which planner produced it and why.
 *
 *   planFine({ geo, graph, from: {x, y}, goal, doorStateAssumed, unmodelled })
 *     -> { ok, source: 'finenav' | 'square_fallback', fallback_reason?, legs?, footings?,
 *          squares, ... }
 */
export function planFine({ geo, graph, from, goal, falls = 'timed', doorStateAssumed = false,
                           squareFallback = true }) {
  const flags = { ...(doorStateAssumed ? { door_state_assumed: true } : {}),
                  ...(graph?.moving?.unmodelled?.length ? { unmodelled_moving_sectors: graph.moving.unmodelled } : {}) };
  const fallback = reason => {
    if (!squareFallback || !geo || goal.row == null) return { ok: false, source: 'finenav', why: reason, ...flags };
    const r = Math.floor(from.y / F) + 1, c = Math.floor(from.x / F) + 1;
    const p = geo.path(r, c, goal.row, goal.col);
    return { ok: !!p?.found, source: 'square_fallback', fallback: true, fallback_reason: reason,
             squares: p?.steps ?? null, ...flags };
  };
  if (!graph) return fallback('no fine-nav graph for this room');
  const at = footingAt(geo, graph, from);
  if (at.footing == null) return fallback('body is in no footing');
  const plan = planFootings(graph, at.footing, goal, { falls });
  if (!plan.found) return fallback(plan.why);
  const legs = legsOf(graph, from, at.footing, plan.chain);
  const ids = [at.footing, ...plan.chain.map(c => c.to)];
  return { ok: true, source: 'finenav', start: at, legs, footings: ids.map(id => footingKey(graph, id)),
           squares: ids.map(id => ({ row: graph.footings[id].row, col: graph.footings[id].col })),
           cost: plan.cost, expanded: plan.expanded, ...flags };
}

/**
 * Execute legs against the mover's own arithmetic, from `from`, and say where it breaks.
 * This is the check that a plan is one the BODY can make: every leg is sent from where the
 * previous one really left the body, never from where it was meant to. Offline only.
 */
export function replayLegs(geo, from, legs, { tolerance = 1 } = {}) {
  let body = { x: from.x, y: from.y };
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
  for (let i = 0; i < legs.length; i++) {
    const L = legs[i];
    if (L.kind === 'fall') {
      // sent as the live mover sends a fall: slide:true, fall:true (+ timedFall), onto the wire
      const got = landFrom(geo, body, L.aim, { fall: true, ...(L.timed ? { timedFall: true } : {}) });
      const want = L.land ?? L.aim;
      if (!got || !near(got, want)) return { ok: false, at: i, leg: L, body, reason: got ? 'fall_landed_elsewhere' : 'fall_not_arrived', stopped: got };
      body = { ...want };
      continue;
    }
    const got = landFrom(geo, body, L.aim);
    if (!got) return { ok: false, at: i, leg: L, body, reason: 'did_not_move' };
    if (L.kind === 'walk') {
      if (!near(got, L.aim)) return { ok: false, at: i, leg: L, body, reason: 'stopped_short', stopped: got };
      body = { ...L.aim };
    } else {
      if (!near(got, L.land)) return { ok: false, at: i, leg: L, body, reason: 'landed_elsewhere', stopped: got };
      const then = landFrom(geo, got, L.then);
      if (!then || !near(then, L.then)) return { ok: false, at: i, leg: L, body: got, reason: 'cannot_reach_footing_rep', stopped: then };
      body = { ...L.then };
    }
  }
  return { ok: true, body };
}
