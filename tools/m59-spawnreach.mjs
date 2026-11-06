#!/usr/bin/env node
// CAN THE MOVER REACH EVERY SPAWN POINT — AND COME BACK? AND IF NOT, WHICH STAND POINT IS WRONG. #movement
//
//   node tools/m59-spawnreach.mjs --extract              read every room's plGenerators out of the kod (M59_ROOT)
//                                                        into substrate/m59-generators.json
//   node tools/m59-spawnreach.mjs                        every room with generators, worst first
//   node tools/m59-spawnreach.mjs --room 27              one room: each generator, each trap, each proposed fix
//   node tools/m59-spawnreach.mjs --room 27 --write      record the VERIFIED proposals in substrate/m59-standpoints.json
//   node tools/m59-spawnreach.mjs ... --walks <dir> --walk-room 1664:27   use a real client's positions as evidence
//   node tools/m59-spawnreach.mjs ... --json
//
// CLI CONTRACT: squares are printed `rNcM` (r = row, c = col); `--walk-room` is `<object id>:<room number>`,
// because a walk log names a room by its object id and object ids are renumbered on every save.
//
// THE OPERATOR, 2026-11-05: fix the Icky Cave "trap", "ideally via some kind of a tool that can identify areas
// that need bake fixes to reach monster spawns ... lots of rooms have the same problem."
//
// WHAT THE TRAP TURNED OUT TO BE. r35c46-r35c48 (27) read as a trench the mover could not leave: `path` from
// r35c48 expands five squares. It is not a trench. Row 35 there is two floors in one square -- a ledge at 896 on
// its north half (sector 43) and floor 0 on its south half -- and wall 1032, the ledge's edge, runs along
// y = 35328, which is EXACTLY the centre line of the row. Every step in the bake is traced from a square's stand
// point, the stand point is the centre whenever the centre has floor, and this centre does, on the floor-0 side of
// the line -- so the body the bake imagines stands on the ledge's edge, pinned west and north. The operator's
// client walked out of those squares a dozen times in one evening (walk-2026-11-05T23-20-56), along the south
// half. docs/m59-routing.md has a name for this: the fine grid is the reality, a square is a summary.
//
// THE FIX HAS A HOME ALREADY: substrate/m59-standpoints.json, a declared stand point per square, read by
// `RoomGeometry.standPoint` for the planner and the mover at once. Fifteen were written by hand. This finds them:
//
//   1. SPAWN POINTS. `plGenerators`, [row, col], straight from each room's kod class (or its nearest ancestor that
//      declares one); 120 room classes declare them. Cached in substrate/m59-generators.json so nothing else
//      needs M59_ROOT.
//   2. REACH. The room's step graph -- `geo.neighbors(..., { collision: true })`, the baked mask plus declared
//      falls, the graph the router plans on -- and its HOME, the strongly connected region holding the most exit
//      anchors (else the largest). A generator is `ok` in home, a `trap` if you can walk to it and not back,
//      `unreachable` if you cannot walk to it, `cut_off` if neither, `no_floor` off the floor. Separately, every
//      TRAP REGION: ground reachable from home that cannot get back. That is where bodies chasing quarry end up,
//      spawn point or not -- the trench was not a spawn point.
//   3. A STAND POINT FOR EACH SQUARE OF A PROBLEM REGION, by trial. Candidates are the positions a real client
//      stood on in that square (walk logs, when given) and a 9x9 lattice of occupiable points. Each is substituted
//      for the square's stand point and every step to and from its eight neighbours is re-traced with the mover's
//      own predicate (`_traceMoverStep`, unmasked) -- no rule of this file's decides what lands. The candidate
//      that opens the most steps out of the region wins.
//   4. VERIFIED, NOT HOPED. All of a region's proposals are applied together and its reach is recomputed: a
//      proposal is `verified` only if the region then joins home both ways. Only verified ones are written.
//
// After `--write`, the mask is still the old one until the room is re-baked: the tool prints the
// `m59-routebake.mjs --rooms` line AND the `m59-doorbake.mjs --room --risk --write` line, because routebake drops a
// room's door-state variants (room 27 lost its Dispel Illusion state that way). A declared point the mover cannot reach "costs a refused step and authorises
// nothing" (m59-standpoints.json's own rule), so a bad proposal fails closed.
//
// OFFLINE. Reads the map, the bake, the kod and walk logs; writes only the two substrate files named above.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
export const GENERATORS_FILE = process.env.M59_GENERATORS || join(REPO, 'substrate', 'm59-generators.json');
export const STANDPOINTS_FILE = join(REPO, 'substrate', 'm59-standpoints.json');
const KOD_FINENESS = 64, CLIENT_PER_KOD = 16;
const protocolToClient = v => (v - KOD_FINENESS) * CLIENT_PER_KOD;     // m59-roo.mjs, the wire's one-square offset
const sq = p => `r${p.row}c${p.col}`;
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];

// ------------------------------------------------------------------------------------------------------------
// 1. SPAWN POINTS, FROM THE KOD

/** Every kod class under `kod/object` -> { file, parent, text }. */
export function kodClasses(kodRoot) {
  const out = new Map();
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!name.endsWith('.kod')) continue;
      const text = readFileSync(p, 'latin1');
      const m = /^\s*(\w+)\s+is\s+(\w+)/m.exec(text);
      if (m) out.set(m[1].toLowerCase(), { cls: m[1], parent: m[2], file: p, text });
    }
  };
  walk(join(kodRoot, 'kod', 'object'));
  return out;
}

/** `plGenerators = [ [51, 14], ... ];` -> [{ row, col }]; null when the text declares none. */
export function parseGenerators(text) {
  const m = /plGenerators\s*=\s*\[([\s\S]*?)\]\s*;/.exec(String(text ?? ''));
  if (!m) return null;
  const out = [];
  for (const p of m[1].matchAll(/\[\s*(\d+)\s*,\s*(\d+)\s*\]/g)) out.push({ row: Number(p[1]), col: Number(p[2]) });
  return out;
}

/** Each map room's generators, from its class or the nearest ancestor that declares them. */
export function extractGenerators(map, kodRoot) {
  const classes = kodClasses(kodRoot);
  const rooms = {};
  for (const [num, room] of Object.entries(map.rooms ?? {})) {
    let c = classes.get(String(room.cls ?? '').toLowerCase()), hops = 0, gens = null, from = null;
    while (c && hops++ < 12) {
      gens = parseGenerators(c.text);
      if (gens) { from = c; break; }
      c = classes.get(String(c.parent).toLowerCase());
    }
    if (gens?.length) rooms[num] = { cls: room.cls, declared_by: from.cls,
      file: from.file.slice(from.file.toLowerCase().indexOf('kod')).replace(/\\/g, '/'), generators: gens };
  }
  return { format: 'm59-generators/1', note: 'plGenerators, [row, col], per room, read from the kod by tools/m59-spawnreach.mjs --extract',
           rooms };
}

export function loadGenerators(file = GENERATORS_FILE) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// ------------------------------------------------------------------------------------------------------------
// 2. REACH

/** The step graph over standable squares. `stepOk(r,c,rr,cc)` overrides the mask for the 8-neighbour steps it is
 *  asked about (null = use geo.neighbors as the router does). Declared/derived falls come from geo.neighbors. */
export function stepGraph(geo, { stepOk = null } = {}) {
  const N = geo.rows * geo.cols, key = (r, c) => (r - 1) * geo.cols + (c - 1);
  const out = Array.from({ length: N }, () => []), standable = new Uint8Array(N);
  for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) if (geo.standable(r, c)) standable[key(r, c)] = 1;
  for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
    const k = key(r, c);
    if (!standable[k]) continue;
    const seen = new Set();
    let ns = [];
    try { ns = geo.neighbors(r, c, { collision: true }); } catch { ns = []; }
    for (const n of ns) {
      if (stepOk && !n.fall && Math.abs(n.row - r) <= 1 && Math.abs(n.col - c) <= 1) continue;   // re-decided below
      const nk = key(n.row, n.col);
      if (!seen.has(nk)) { seen.add(nk); out[k].push(nk); }
    }
    if (stepOk) for (const [dr, dc] of DIRS) {
      const rr = r + dr, cc = c + dc;
      if (rr < 1 || cc < 1 || rr > geo.rows || cc > geo.cols || !standable[key(rr, cc)]) continue;
      const nk = key(rr, cc);
      if (!seen.has(nk) && stepOk(r, c, rr, cc)) { seen.add(nk); out[k].push(nk); }
    }
  }
  const inn = Array.from({ length: N }, () => []);
  out.forEach((list, k) => { for (const n of list) inn[n].push(k); });
  return { N, out, inn, standable, key, at: k => ({ row: Math.floor(k / geo.cols) + 1, col: (k % geo.cols) + 1 }) };
}

/** Strongly connected components (iterative Kosaraju). Returns comp[] (-1 for non-standable). */
export function components(g) {
  const { N, out, inn, standable } = g, order = [], seen = new Uint8Array(N);
  for (let s = 0; s < N; s++) {
    if (!standable[s] || seen[s]) continue;
    const stack = [[s, 0]]; seen[s] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1], list = out[top[0]];
      if (top[1] < list.length) { const n = list[top[1]++]; if (!seen[n]) { seen[n] = 1; stack.push([n, 0]); } }
      else { order.push(top[0]); stack.pop(); }
    }
  }
  const comp = new Int32Array(N).fill(-1);
  let id = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const s = order[i];
    if (comp[s] !== -1) continue;
    const stack = [s]; comp[s] = id;
    while (stack.length) { const k = stack.pop(); for (const p of inn[k]) if (comp[p] === -1) { comp[p] = id; stack.push(p); } }
    id++;
  }
  return comp;
}

const flood = (starts, edges, N) => {
  const seen = new Uint8Array(N), stack = [...starts];
  for (const s of starts) seen[s] = 1;
  while (stack.length) { const k = stack.pop(); for (const n of edges[k]) if (!seen[n]) { seen[n] = 1; stack.push(n); } }
  return seen;
};

/**
 * One room's reach: home, every generator's status, and every trap region.
 *   anchors  routes-table anchors ({ kind, row, col }) -- exits choose home
 */
export function auditReach(geo, { generators = [], anchors = [], graph = null } = {}) {
  const g = graph ?? stepGraph(geo);
  const comp = components(g);
  const sizes = new Map();
  for (let k = 0; k < g.N; k++) if (comp[k] >= 0) sizes.set(comp[k], (sizes.get(comp[k]) ?? 0) + 1);
  const exitVotes = new Map();
  for (const a of anchors) {
    if (!['edge', 'go'].includes(a?.kind) || !Number.isInteger(a.row) || !Number.isInteger(a.col)) continue;
    if (a.row < 1 || a.col < 1 || a.row > geo.rows || a.col > geo.cols) continue;
    const c = comp[g.key(a.row, a.col)];
    if (c >= 0) exitVotes.set(c, (exitVotes.get(c) ?? 0) + 1);
  }
  const pick = m => [...m.entries()].sort((a, b) => b[1] - a[1] || (sizes.get(b[0]) ?? 0) - (sizes.get(a[0]) ?? 0))[0]?.[0];
  const home = exitVotes.size ? pick(exitVotes) : pick(sizes);
  const homeKeys = [];
  for (let k = 0; k < g.N; k++) if (comp[k] === home) homeKeys.push(k);
  const fwd = flood(homeKeys, g.out, g.N), back = flood(homeKeys, g.inn, g.N);
  const status = k => !g.standable[k] ? 'no_floor' : comp[k] === home ? 'ok'
    : fwd[k] && !back[k] ? 'trap' : !fwd[k] && back[k] ? 'unreachable' : !fwd[k] ? 'cut_off' : 'ok';
  const gens = generators.map(p => {
    const inRoom = p.row >= 1 && p.col >= 1 && p.row <= geo.rows && p.col <= geo.cols;
    return { ...p, status: inRoom ? status(g.key(p.row, p.col)) : 'outside_room' };
  });
  // Trap regions: reachable-not-returnable ground, grouped by adjacency.
  const regionOf = new Int32Array(g.N).fill(-1), regions = [];
  for (let k = 0; k < g.N; k++) {
    if (status(k) !== 'trap' || regionOf[k] !== -1) continue;
    const id = regions.length, stack = [k], keys = [];
    regionOf[k] = id;
    while (stack.length) {
      const x = stack.pop(); keys.push(x);
      const { row, col } = g.at(x);
      for (const [dr, dc] of DIRS) {
        const rr = row + dr, cc = col + dc;
        if (rr < 1 || cc < 1 || rr > geo.rows || cc > geo.cols) continue;
        const nk = g.key(rr, cc);
        if (regionOf[nk] === -1 && status(nk) === 'trap') { regionOf[nk] = id; stack.push(nk); }
      }
    }
    const entered = new Set();
    for (const x of keys) for (const p of g.inn[x]) if (comp[p] === home) entered.add(sq(g.at(p)) + '->' + sq(g.at(x)));
    regions.push({ kind: 'trap', size: keys.length, squares: keys.map(x => g.at(x)),
                   generators: gens.filter(p => keys.includes(g.key(p.row, p.col))).map(sq), entered_from: [...entered].slice(0, 6) });
  }
  // A generator outside home that is not in a trap region gets its own region: the non-home ground around it.
  for (const p of gens.filter(x => x.status === 'unreachable' || x.status === 'cut_off')) {
    const start = g.key(p.row, p.col), want = status(start), keys = [], stack = [start], seen = new Set([start]);
    while (stack.length && keys.length < 200) {
      const x = stack.pop(); keys.push(x);
      const { row, col } = g.at(x);
      for (const [dr, dc] of DIRS) {
        const rr = row + dr, cc = col + dc;
        if (rr < 1 || cc < 1 || rr > geo.rows || cc > geo.cols) continue;
        const nk = g.key(rr, cc);
        if (!seen.has(nk) && g.standable[nk] && comp[nk] !== home && status(nk) === want) { seen.add(nk); stack.push(nk); }
      }
    }
    regions.push({ kind: want, size: keys.length, squares: keys.map(x => g.at(x)), generators: [sq(p)], entered_from: [] });
  }
  // A REGION WITH ITS OWN EXIT IS ANOTHER PART OF THE ROOM, NOT A TRAP: a lower floor with its own door is left by
  // that door. Informational, and never counted as a problem.
  const exitKeys = new Set(anchors.filter(a => ['edge', 'go'].includes(a?.kind) && Number.isInteger(a.row) && Number.isInteger(a.col)
    && a.row >= 1 && a.col >= 1 && a.row <= geo.rows && a.col <= geo.cols).map(a => g.key(a.row, a.col)));
  for (const r of regions) {
    r.own_exit = r.squares.some(p => exitKeys.has(g.key(p.row, p.col)));
    if (r.own_exit) for (const p of gens) if (r.generators.includes(sq(p))) p.status = 'own_exit';
  }
  return { home, home_size: homeKeys.length, standable: [...g.standable].filter(Boolean).length,
           generators: gens, regions, graph: g, comp };
}

// ------------------------------------------------------------------------------------------------------------
// 3. STAND POINTS, BY TRIAL

/** Real-client positions per square, in client units, from walk logs: Map("row,col" -> [{x,y}]). */
export function walkPoints(dir, objIds) {
  const out = new Map();
  if (!dir || !existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let p; try { p = JSON.parse(line); } catch { continue; }
      if (!objIds.has(p.room) || ![p.x, p.y, p.row, p.col].every(Number.isFinite)) continue;
      const k = `${p.row},${p.col}`;
      const list = out.get(k) ?? [];
      if (list.length < 24) list.push({ x: protocolToClient(p.x), y: protocolToClient(p.y), human: true });
      out.set(k, list);
    }
  }
  return out;
}

/** Substitute a stand point for one square, run fn, restore. The mover's caches are cleared both ways. */
function withStandPoint(geo, row, col, point, fn) {
  const memo = (geo._standPoint ??= new Array(geo.rows * geo.cols));
  const i = (row - 1) * geo.cols + (col - 1), was = memo[i];
  memo[i] = point; geo._moverStepCache = new Map();
  try { return fn(); } finally { memo[i] = was; geo._moverStepCache = new Map(); }
}

/** Candidate points in a square: human positions first, then a 9x9 lattice of occupiable points. */
function candidates(geo, row, col, humans = []) {
  const x0 = (col - 1) * 1024, y0 = (row - 1) * 1024, out = [];
  for (const h of humans) if (h.x >= x0 && h.x < x0 + 1024 && h.y >= y0 && h.y < y0 + 1024 && geo._occupiable(h.x, h.y)) out.push(h);
  const N = 9, step = 1024 / N;
  for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
    const x = x0 + Math.round((sx + 0.5) * step), y = y0 + Math.round((sy + 0.5) * step);
    if (geo._occupiable(x, y)) out.push({ x, y });
  }
  return out;
}

/** The steps a square's stand point opens with its 8 neighbours, traced (unmasked). */
function stepsAt(geo, row, col) {
  const outs = [], ins = [];
  for (const [dr, dc] of DIRS) {
    const rr = row + dr, cc = col + dc;
    if (rr < 1 || cc < 1 || rr > geo.rows || cc > geo.cols || !geo.standable(rr, cc)) continue;
    if (geo._traceMoverStep(row, col, rr, cc)) outs.push({ row: rr, col: cc });
    if (geo._traceMoverStep(rr, cc, row, col)) ins.push({ row: rr, col: cc });
  }
  return { outs, ins };
}

/**
 * Proposals for one region: for each square, the candidate point that opens the most steps OUT of the region
 * (then the most steps in all), never fewer steps in than the current point -- a fix must not close the way in.
 * Then all of them applied together and the region's reach recomputed.
 */
export function proposeRegion(geo, audit, region, { humans = new Map(), maxSquares = 40 } = {}) {
  const inRegion = new Set(region.squares.map(sq));
  const proposals = [];
  for (const s of region.squares.slice(0, maxSquares)) {
    const now = stepsAt(geo, s.row, s.col);
    const outsideOuts = l => l.filter(t => !inRegion.has(sq(t))).length;
    const base = { out: outsideOuts(now.outs), all: now.outs.length + now.ins.length, ins: now.ins.length };
    let best = null;
    for (const p of candidates(geo, s.row, s.col, humans.get(`${s.row},${s.col}`) ?? [])) {
      const st = withStandPoint(geo, s.row, s.col, { x: p.x, y: p.y }, () => stepsAt(geo, s.row, s.col));
      const score = { out: outsideOuts(st.outs), all: st.outs.length + st.ins.length, ins: st.ins.length };
      if (score.ins < base.ins) continue;
      if (!best || score.out > best.score.out || (score.out === best.score.out && (score.all > best.score.all
          || (score.all === best.score.all && p.human && !best.p.human))))
        best = { p, score, st };
    }
    if (best && (best.score.out > base.out || best.score.all > base.all))
      proposals.push({ row: s.row, col: s.col, fine: { x: best.p.x, y: best.p.y }, human: !!best.p.human,
        before: base, after: best.score, opens: best.st.outs.filter(t => !now.outs.some(o => o.row === t.row && o.col === t.col)).map(sq) });
  }
  // Apply together, re-trace the steps they touch, recompute reach.
  const memo = (geo._standPoint ??= new Array(geo.rows * geo.cols));
  const saved = proposals.map(p => [p, memo[(p.row - 1) * geo.cols + (p.col - 1)]]);
  for (const p of proposals) memo[(p.row - 1) * geo.cols + (p.col - 1)] = p.fine;
  geo._moverStepCache = new Map();
  const touched = new Set(proposals.map(sq));
  let joined = false;
  try {
    const graph = stepGraph(geo, { stepOk: (r, c, rr, cc) =>
      touched.has(`r${r}c${c}`) || touched.has(`r${rr}c${cc}`) ? geo._traceMoverStep(r, c, rr, cc) : geo.moverStepLands(r, c, rr, cc) });
    const after = auditReach(geo, { graph, anchors: audit.anchors ?? [] });
    joined = region.squares.every(s => after.comp[graph.key(s.row, s.col)] === after.comp[graph.key(audit.homeSquare.row, audit.homeSquare.col)]);
  } finally {
    for (const [p, was] of saved) memo[(p.row - 1) * geo.cols + (p.col - 1)] = was;
    geo._moverStepCache = new Map();
  }
  return { proposals, verified: joined && proposals.length > 0 };
}

// ------------------------------------------------------------------------------------------------------------
// ONE ROOM, END TO END

export async function auditRoom(num, { map, geo, routesRoom = null, generators = [], humans = new Map(), propose = true } = {}) {
  const anchors = routesRoom?.anchors ?? [];
  const reach = auditReach(geo, { generators, anchors });
  const homeKey = reach.comp.findIndex(c => c === reach.home);
  const audit = { anchors, homeSquare: reach.graph.at(homeKey) };
  const regions = reach.regions.map(r => ({ ...r }));
  if (propose) for (const r of regions.filter(x => !x.own_exit)) Object.assign(r, proposeRegion(geo, audit, r, { humans }));
  return { room: Number(num), name: map.rooms[num]?.name ?? null, roo: map.rooms[num]?.rooFile ?? null,
           standable: reach.standable, home_size: reach.home_size,
           generators: reach.generators, regions };
}

const problem = r => !r.own_exit;
const summaryOf = a => ({ room: a.room, name: a.name, generators: a.generators.length,
  bad_generators: a.generators.filter(g => !['ok', 'own_exit'].includes(g.status)).length,
  traps: a.regions.filter(r => r.kind === 'trap' && problem(r)).length,
  trap_squares: a.regions.filter(r => r.kind === 'trap' && problem(r)).reduce((n, r) => n + r.size, 0),
  regions: a.regions.filter(problem).length,
  fixable: a.regions.filter(r => problem(r) && r.verified).length });

// ------------------------------------------------------------------------------------------------------------
// CLI

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const val = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const has = k => argv.includes(k);
  if (has('--help')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).join('\n')); process.exit(0); }
  const { loadMap } = await import('./m59-map.mjs');
  const { attachStepMasks } = await import('./m59-routes.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const map = loadMap(); attachStepMasks(map);

  if (has('--extract')) {
    const root = val('--kod') || process.env.M59_ROOT || 'C:/code/Meridian59';
    if (!existsSync(join(root, 'kod'))) { console.error(`no kod tree under ${root} (set M59_ROOT or --kod)`); process.exit(2); }
    const out = extractGenerators(map, root);
    writeFileSync(GENERATORS_FILE, JSON.stringify(out, null, 1) + '\n');
    const n = Object.keys(out.rooms).length, g = Object.values(out.rooms).reduce((s, r) => s + r.generators.length, 0);
    console.log(`${GENERATORS_FILE}: ${n} rooms, ${g} generators`);
    process.exit(0);
  }

  const gens = loadGenerators();
  if (!gens) { console.error(`no ${GENERATORS_FILE}; run --extract first`); process.exit(2); }
  let routes = null;
  try { routes = JSON.parse(readFileSync(join(REPO, 'substrate', 'm59-routes.json'), 'utf8')); } catch { routes = null; }
  const objIdsFor = num => {
    const ids = new Set([map.rooms[num]?.objId].filter(x => x != null));
    for (const a of argv.flatMap((x, i) => x === '--walk-room' ? [argv[i + 1]] : [])) {
      const [id, room] = String(a).split(':').map(Number);
      if (room === Number(num) && Number.isFinite(id)) ids.add(id);
    }
    return ids;
  };
  const walksDir = val('--walks');
  const one = val('--room');
  const nums = one ? [String(one)] : Object.keys(gens.rooms);
  const results = [];
  for (const num of nums) {
    const room = map.rooms[num];
    if (!room) { if (one) { console.error(`room ${num} is not in the map`); process.exit(2); } continue; }
    let geo; try { geo = sharedRoomGeometry(room); } catch { continue; }
    if (!geo?.collisionReady || !geo.hasStepMask) continue;
    const humans = walksDir ? walkPoints(walksDir, objIdsFor(num)) : new Map();
    results.push(await auditRoom(num, { map, geo, routesRoom: routes?.rooms?.[num] ?? null,
      generators: gens.rooms[num]?.generators ?? [], humans, propose: !!one || has('--propose') }));
  }

  if (has('--write')) {
    if (!one) { console.error('--write takes --room: proposals are reviewed one room at a time'); process.exit(2); }
    const table = JSON.parse(readFileSync(STANDPOINTS_FILE, 'utf8'));
    const a = results[0];
    const today = new Date().toISOString().slice(0, 10);
    let added = 0;
    for (const r of a.regions.filter(x => x.verified)) for (const p of r.proposals) {
      const k = `${String(a.roo).toLowerCase()}|${p.row},${p.col}`;
      if (table.points.some(q => `${String(q.roo).toLowerCase()}|${q.row},${q.col}` === k)) continue;
      table.points.push({ roo: a.roo, room: a.room, row: p.row, col: p.col, fine: p.fine,
        why: `${a.name ?? 'room ' + a.room}: ${r.kind} region of ${r.size} square(s)${r.generators.length ? ' holding spawn point(s) ' + r.generators.join(', ') : ''}` +
             `${r.entered_from.length ? ', entered by ' + r.entered_from.join(', ') : ''}. The centre stand point opened ${p.before.out} step(s) out of the region` +
             ` and ${p.before.all} in all; this point opens ${p.after.out} out and ${p.after.all} in all (new: ${p.opens.join(', ') || 'none'})` +
             `${p.human ? ', and a real client stood on it' : ''}. With the region's points applied together the region joins the room's home both ways.`,
        observed_by: `m59-spawnreach.mjs proposal, _traceMoverStep verified, ${today}${p.human ? ' (walk-log position)' : ''}` });
      added++;
    }
    if (added) writeFileSync(STANDPOINTS_FILE, JSON.stringify(table, null, 2) + '\n');   // the file's own style
    // BOTH BAKES: routebake --rooms rewrites the room WITHOUT its door-state variants; doorbake puts them back on the new
    // stand points. Room 27 lost its Dispel Illusion state this way on 2026-11-05 and four suites went red.
    console.log(`${STANDPOINTS_FILE}: ${added} point(s) added. Re-bake the room so the masks use them -- BOTH lines:\n` +
      `  node tools/m59-routebake.mjs --rooms ${a.room}\n` +
      `  node tools/m59-doorbake.mjs --room ${a.room} --risk --write    # routebake drops the door-state variants`);
  }

  if (has('--json')) { console.log(JSON.stringify(one ? results[0] : results.map(summaryOf), null, 1)); process.exit(0); }
  if (!one) {
    const rows = results.map(summaryOf).filter(r => r.bad_generators || r.traps)
      .sort((a, b) => b.bad_generators - a.bad_generators || b.trap_squares - a.trap_squares);
    console.log(`${results.length} rooms with generators and a step mask; ${rows.length} with a spawn point off home or a trap region:\n`);
    console.log('room  spawns-off/total  traps(squares)  fixable/regions  name');
    for (const r of rows) console.log(`${String(r.room).padStart(4)}  ${String(r.bad_generators).padStart(4)}/${String(r.generators).padEnd(10)} ${String(r.traps).padStart(4)} (${r.trap_squares})`.padEnd(36)
      + (has('--propose') ? `${String(r.fixable).padStart(6)}/${String(r.regions).padEnd(8)}` : '     -/-      ') + `  ${r.name ?? ''}`);
    console.log('\nnode tools/m59-spawnreach.mjs --room <n>   for the detail and the proposed stand points');
  } else {
    const a = results[0];
    if (!a) { console.error('that room has no collision geometry or step mask'); process.exit(2); }
    console.log(`room ${a.room} ${a.name ?? ''} (${a.roo}): ${a.standable} standable, home ${a.home_size}`);
    for (const g of a.generators) console.log(`  spawn ${sq(g)}  ${g.status}`);
    for (const r of a.regions) {
      if (r.own_exit) { console.log(`\n  (${r.kind} region of ${r.size} square(s) with its OWN exit: another part of the room, not a fault)`); continue; }
      console.log(`\n  ${r.kind.toUpperCase()} region, ${r.size} square(s): ${r.squares.slice(0, 16).map(sq).join(' ')}${r.size > 16 ? ' ...' : ''}`);
      if (r.generators.length) console.log(`    spawn points: ${r.generators.join(', ')}`);
      if (r.entered_from.length) console.log(`    entered by: ${r.entered_from.join(', ')}`);
      for (const p of r.proposals ?? [])
        console.log(`    ${sq(p)} stand at (${p.fine.x},${p.fine.y})${p.human ? ' [a real client stood here]' : ''}: out of region ${p.before.out}->${p.after.out}, steps ${p.before.all}->${p.after.all}${p.opens.length ? ', opens ' + p.opens.join(' ') : ''}`);
      console.log(`    ${r.verified ? 'VERIFIED: applied together, the region joins home both ways' : (r.proposals?.length ? 'not verified: the region still does not join home' : 'no stand point in it opens anything: a jump, a lift or a real wall')}`);
    }
  }
}
