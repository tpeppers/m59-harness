// WHERE A ROOM IS SEVERED, AND WHAT WOULD BRIDGE IT — FOUND RATHER THAN DESCRIBED.
//
//   node tools/m59-jumpfinder.mjs 579 --from 40,52 --to 51,30
//   node tools/m59-jumpfinder.mjs 108 --from 36,27 --to 21,37
//   node tools/m59-jumpfinder.mjs 579 --from 40,52 --to 51,30 --declare
//
// CLI CONTRACT: `--from` and `--to` are `row,col` (KOD/RoomGeometry order),
// so the first example searches from r40c52 to r51c30.
//
// THE WHOLE ALGORITHM IS ONE SENTENCE OF THE OPERATOR'S: A FALL IS A WALL.
//
// A ledge is not something to detect. It is what REMAINS when descending is forbidden. Run a
// never-descend closure from where a character is standing and the room falls apart into the
// ribbon it can actually walk — in the Ancient Place that is 41 squares out of 1,660, and it
// reproduced a climb the operator had walked to an average of 0.79 squares without being told
// where the ledge was.
//
// So the search is two alternating moves, and it matches how a person plays it:
//
//   WALK   the never-descend closure from here. Free, and it is the ledge.
//   JUMP   from the frontier of that closure to a point outside it. Expensive, rare, and the
//          only way between closures.
//
// which makes the room a small graph — closures as nodes, jumps as edges — and "can I get to
// the mana node" a breadth-first search over it, bounded by how many jumps you will accept.
//
// EVERYTHING IS FINE COORDINATES. A square is a summary and on this ground it is a false one:
// r40c52 is `walkable: true` with no floor at its centre, and r40c33 spans 3520 to 10880 — the
// valley floor and the high ledge, one square, one number. A search on square centres cannot
// see the first Ancient Place jump at all, because both its ends are inside one square. See
// docs/m59-routing.md.
//
// IT PROPOSES; IT DOES NOT BELIEVE ITSELF. A candidate is geometry saying a hop is possible,
// which is not the same as a body making it — the landing may be a sliver, the take-off may
// need a run-up, a creature may stand there. `--declare` writes to substrate/m59-falljumps.json
// only what has been CONFIRMED by a character actually arriving, and records the tally.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedRoomGeometry, CLIENT_FINENESS as F, MAX_STEP_HEIGHT } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { reachFor, fallenBy, maxSpan } from './m59-falljump-physics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = n => argv.includes('--' + n);

if (has('help') || !argv.length) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const ROOM = Number(argv.find(a => /^\d+$/.test(a)));
// CLI ADAPTER: parse the documented `row,col` pair into named fields immediately.
const pair = s => { const [r, c] = String(s).split(',').map(Number); return { row: r, col: c }; };
const FROM = flag('from') ? pair(flag('from')) : null;
const TO = flag('to') ? pair(flag('to')) : null;
const MAX_JUMPS = Number(flag('max-jumps', 4));
// Quarter of a square. Fine enough to walk a sliver, coarse enough that a closure over a
// 54x74 room is tens of thousands of points rather than millions.
const STEP = Number(flag('step', 256));
// A hair. Slopes wobble by less than this and a ledge that rises smoothly must not read as a
// descent because one sample sat a few units low.
const TOL = Number(flag('tolerance', 64));
// How far a body can throw itself. Eight squares is past anything observed; the ranking
// prefers short hops, so a generous bound costs candidates rather than correctness.
const REACH = Number(flag('reach', 8)) * F;

const world = JSON.parse(readFileSync(join(REPO, 'substrate', 'm59-map.json'), 'utf8'));
attachStepMasks(world);
const room = world.rooms[String(ROOM)];
if (!room) { console.error(`no room ${ROOM} in the map`); process.exit(1); }
const geo = sharedRoomGeometry(room);

const hCache = new Map();
function floorAt(x, y) {
  const k = (x >> 5) * 100000 + (y >> 5);
  if (hCache.has(k)) return hCache.get(k);
  let h = null;
  try { const leaf = geo.leafAtClient(x, y); h = leaf?.sector ? geo.floorBaseAtClient(x, y, leaf) : null; }
  catch { h = null; }
  hCache.set(k, h);
  return h;
}

// A BODY HAS WIDTH. One infinitely thin sample at a ledge edge lands in whichever sector
// contains it, which is how a height profile can swing seven thousand units between two
// packets a second apart. The surface a character stands on is the highest floor under its
// footprint, so that is what this asks for.
function standAt(x, y) {
  let best = null;
  for (let dx = -160; dx <= 160; dx += 160)
    for (let dy = -160; dy <= 160; dy += 160) {
      const h = floorAt(x + dx, y + dy);
      if (h != null && (best == null || h > best)) best = h;
    }
  return best;
}

// A POINT WITH NO FLOOR IS NOT A PLACE, AND `standAt` WILL HAPPILY NAME ONE.
//
// The search reasons with a footprint — the highest floor under a body's width — because one
// infinitely thin sample at a ledge edge lands in whichever sector contains it. That is right
// for deciding whether a body can be somewhere and wrong for WRITING DOWN where: it names the
// centre of the footprint, which may itself be over the void, and `declaredFallJumps`
// validates the named point exactly. Both candidates for the Ancient Place were refused for
// precisely this — `to_fine` had `floorBaseAtClient` of null while the footprint around it was
// solid.
//
// So anything that leaves this tool is snapped to a point that has real floor under it.
function snapToFloor(pt) {
  if (floorAt(pt.x, pt.y) != null) return pt;
  for (let r = 40; r <= 320; r += 40)
    for (let a = 0; a < 12; a++) {
      const ang = a * Math.PI / 6;
      const x = Math.round(pt.x + Math.cos(ang) * r), y = Math.round(pt.y + Math.sin(ang) * r);
      if (floorAt(x, y) != null) return { x, y };
    }
  return null;
}

const key = (x, y) => ((x / STEP) | 0) + '|' + ((y / STEP) | 0);
const sqOf = (x, y) => ({ row: ((y / F) | 0) + 1, col: ((x / F) | 0) + 1 });

// The best footing inside a square, since the centre is routinely not it.
function footing(row, col) {
  const x0 = (col - 1) * F, y0 = (row - 1) * F;
  let best = null;
  for (let i = 1; i < 8; i++) for (let k = 1; k < 8; k++) {
    const x = x0 + Math.round(F * i / 8), y = y0 + Math.round(F * k / 8);
    const h = floorAt(x, y);
    if (h != null && (best == null || h > best.h)) best = { x, y, h };
  }
  return best;
}

/** Everywhere reachable from here WITHOUT EVER STEPPING DOWN. This is the ledge. */
function closure(start) {
  const seen = new Map([[key(start.x, start.y), start]]);
  const q = [start];
  const dirs = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) dirs.push([dx * STEP, dy * STEP]);
  while (q.length) {
    const cur = q.pop();
    const hc = standAt(cur.x, cur.y);
    if (hc == null) continue;
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx > room.cols * F || ny > room.rows * F) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      const hn = standAt(nx, ny);
      if (hn == null) continue;
      if (hn < hc - TOL) continue;                 // a fall is a wall
      if (hn > hc + MAX_STEP_HEIGHT) continue;     // and a cliff is a cliff
      seen.set(k, { x: nx, y: ny });
      q.push({ x: nx, y: ny });
    }
  }
  return seen;
}

// HOW FAR A BODY ACTUALLY GOES, FROM THE CLIENT'S OWN PHYSICS.
//
// clientd3d/move.h and moveobj.h, which are the authority because the client computes this
// and the server takes its word for it:
//
//     FINENESS             1024                 client units per square
//     FALL_VELOCITY_0      -FINENESS * 2 / 3    -682.7 units/sec, the moment you leave
//     GRAVITY_ACCELERATION -5 * FINENESS        -5120 units/sec/sec
//
// and MoveSingleVertically integrates them straight: `dz = dt * v_z / 1000` with
// `v_z += GRAVITY * dt / 1000` while falling. So a drop of h takes the positive root of
//
//     682.7 t + 2560 t^2 = h
//
// and the horizontal distance available is the run speed times that. The run is about five
// squares a second — the operator's own recorded climb shows single packets of 317 kod units
// at one packet a second, which is 5072 client units, and the note in this repository says
// the same.
//
// THIS IS WHAT MAKES THE DIFFERENCE BETWEEN A JUMP AND A WISH. Asked without it, this tool
// proposed `45,36 -> 51,30`: one hop from the ledge onto the mana node, seven and a half
// squares across a void. The physics gives a 3024 drop 0.96 seconds of air and 4.8 squares of
// travel, so it is short by nearly three squares — and a character sent to try it walked to
// the edge and stopped dead, six legs and a hundred and fifty steps without moving. The
// geometry said yes and the arithmetic said no, and the arithmetic was right.
// THE ARITHMETIC LIVES IN ONE PLACE NOW. This file and `m59-fineroute.mjs` each carried a
// hand-written copy, and both had the same bug in the same branch — see
// `m59-falljump-physics.mjs` for the constants, their citations, and what the branch cost.
const RUN_SPEED = Number(flag('run-speed', 5)) * F;   // units/sec, overridable for experiments

// YOU CANNOT JUMP THROUGH A CLIFF, AND CHECKING ONLY THE ENDS SAYS YOU CAN.
//
// The first version of this asked whether the take-off had floor and the landing had floor,
// and nothing about the ground between them — the same mistake the route bake made twice, once
// in the string-pull and once in the step veto. It immediately proposed `45,36 -> 51,30`: one
// six-square hop from the ledge straight onto the mana node, straight THROUGH the wall the
// whole climb exists to get around. Geometrically both ends are floor. It is not a jump, it is
// a wish.
//
// A body leaving a ledge is falling: it starts at the take-off height and only goes down. So
// anything under the line that stands ABOVE the take-off is something it would hit. That is
// the cheap, correct-enough test — it does not model an arc, and it does not need to, because
// the failure it exists to catch is a hop that passes through a mountain.
function clearBetween(a, b, hFrom, hTo) {
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  const drop = hFrom - hTo;
  // 1. CAN THE BODY EVEN GET THERE.
  //
  // ONE LINE, BECAUSE THE CLIENT'S RULE IS ONE EXPRESSION. A landing is legal when the body
  // has not fallen further than the landing is below it, plus the step it may still climb:
  //
  //     fallenBy(t) <= drop + MAX_STEP_HEIGHT
  //
  // so the furthest a run can carry you is `reachFor(drop + MAX_STEP_HEIGHT)` — the same
  // formula for a level hop, a small rise and a long fall, with no branch and no fudge.
  //
  // CORRECTED 2026-09-10. This used to be two cases with two magic constants — `F * 1.5` for
  // anything not falling further than a step, and `reachFor(drop) + F / 2` beyond — and BOTH
  // were wrong, in opposite directions, which is why neither looked wrong:
  //
  //   drop:        0     96    192    288    384    512   1024   2048
  //   old cap:     1536  1536  1536   1536   1536   2219  3139   4459
  //   true:        1415  1637  1840   2028   2204   2422  3175   4354
  //   error (sq): +0.12 -0.10 -0.30  -0.48  -0.65  -0.20 -0.04  +0.10
  //
  // At dead level it was PERMISSIVE by 0.12 squares — the true level reach is 1.38 squares,
  // not 1.5, because a running body starts falling the instant it leaves and has 384 units to
  // give away. At the top of the same branch it was RESTRICTIVE BY 0.65 SQUARES, and that half
  // is the expensive one: a candidate the tool never offers is a gap nobody knows is crossable.
  // The `+ F / 2` fudge made the second branch restrictive across the mid range too.
  //
  // Found by the m59-research session reading `clientd3d/moveobj.c` against this file.
  if (span > maxSpan(drop, { speed: RUN_SPEED })) return false;
  // 2. AND DOES IT CLEAR WHAT IS IN THE WAY, along the arc rather than the straight line.
  const n = Math.max(2, Math.ceil(span / (F / 4)));
  for (let i = 1; i < n; i++) {
    const f = i / n;
    const x = Math.round(a.x + (b.x - a.x) * f);
    const y = Math.round(a.y + (b.y - a.y) * f);
    const h = standAt(x, y);
    if (h == null) continue;                        // open air under the arc is the point
    const t = (span * f) / RUN_SPEED;
    const zHere = hFrom - fallenBy(t);
    if (h > zHere + MAX_STEP_HEIGHT) return false;  // the ground is above us: we hit it
  }
  return true;
}

/** Hops from the edge of a closure to standable ground outside it. */
function jumpsFrom(seen) {
  const out = [];
  const tried = new Set();
  for (const p of seen.values()) {
    const hp = standAt(p.x, p.y);
    if (hp == null) continue;
    for (let a = 0; a < 16; a++) {
      const ang = a * Math.PI / 8;
      for (let d = F; d <= REACH; d += F / 2) {
        const nx = Math.round(p.x + Math.cos(ang) * d), ny = Math.round(p.y + Math.sin(ang) * d);
        if (nx < 0 || ny < 0 || nx > room.cols * F || ny > room.rows * F) continue;
        if (seen.has(key(nx, ny))) continue;
        const hn = standAt(nx, ny);
        if (hn == null) continue;
        const k = key(nx, ny);
        if (tried.has(k)) continue;
        tried.add(k);
        if (!clearBetween(p, { x: nx, y: ny }, hp, hn)) continue;
        out.push({ from: p, to: { x: nx, y: ny }, d, drop: hp - hn, hFrom: hp, hTo: hn });
      }
    }
  }
  // ONE CANDIDATE PER LANDING SQUARE, AND RANKED BY WHAT IT BUYS.
  //
  // Sorting by shortest hop first was the first thing tried and it was useless: the search
  // spent its whole budget on one-square shuffles along the edge of the closure —
  // `46,42 -> 45,41`, `45,42 -> 46,41` — which land back on the same ledge and open nothing.
  // A jump is worth taking when it reaches ground the walk could not, and when there is a
  // destination, when it gets closer to it. Short is a tie-break, not the objective.
  const bySquare = new Map();
  for (const c of out) {
    const s = sqOf(c.to.x, c.to.y);
    const k = s.row + ',' + s.col;
    const prev = bySquare.get(k);
    if (!prev || c.d < prev.d) bySquare.set(k, c);
  }
  const list = [...bySquare.values()];
  const goal = TO ? footing(TO.row, TO.col) : null;
  const toGoal = c => goal ? Math.hypot(c.to.x - goal.x, c.to.y - goal.y) : 0;
  return list.sort((a, b) =>
    (goal ? toGoal(a) - toGoal(b) : 0) ||
    (b.hTo - a.hTo) ||          // no destination: climbing is what ledges are for
    (a.d - b.d));
}

const startFooting = FROM ? footing(FROM.row, FROM.col) : null;
if (FROM && !startFooting) { console.error(`no footing anywhere inside ${FROM.row},${FROM.col}`); process.exit(1); }

console.log(`room ${ROOM} — ${room.name}   ${room.rows}x${room.cols}`);
if (FROM) console.log(`from ${FROM.row},${FROM.col}  (footing at fine ${startFooting.x},${startFooting.y}, floor ${startFooting.h})`);
if (TO) console.log(`to   ${TO.row},${TO.col}`);
console.log('');

const inTarget = (seen) => {
  if (!TO) return false;
  for (const p of seen.values()) { const s = sqOf(p.x, p.y); if (s.row === TO.row && s.col === TO.col) return true; }
  return false;
};

// Closures as nodes, jumps as edges, breadth-first out to --max-jumps.
const t0 = Date.now();
let frontier = [{ at: startFooting, path: [] }];
const visited = new Set();
let answer = null;

for (let depth = 0; depth <= MAX_JUMPS && !answer; depth++) {
  const next = [];
  for (const node of frontier) {
    const k = key(node.at.x, node.at.y);
    if (visited.has(k)) continue;
    visited.add(k);
    const seen = closure(node.at);
    const squares = new Set([...seen.values()].map(p => { const s = sqOf(p.x, p.y); return s.row + ',' + s.col; }));
    console.log(`  ${depth} jump(s) in: closure of ${seen.size} points / ${squares.size} squares` +
                (node.path.length ? `   after ${node.path.map(j => j.label).join(' then ')}` : ''));
    if (inTarget(seen)) { answer = { path: node.path, seen, squares }; break; }
    if (depth === MAX_JUMPS) continue;
    const cands = jumpsFrom(seen).slice(0, Number(flag('branch', 12)));
    for (const c of cands) {
      const fromPt = snapToFloor(c.from), toPt = snapToFloor(c.to);
      if (!fromPt || !toPt) continue;          // cannot name it, will not propose it
      // RE-VALIDATE ON THE POINTS ACTUALLY NAMED. The search reasons with footprint maxima
      // and then snaps to real floor, and those are not the same place: one candidate was
      // computed as "down 3152" from the footprint and is 3744 -> 4800 UPHILL at the points
      // that went into the file. The geometry refused it, correctly, and the tool had
      // written a fall that falls upward. Whatever is proposed must survive the physics at
      // the coordinates proposed, not at the ones it was found with.
      const fa = floorAt(fromPt.x, fromPt.y), fb = floorAt(toPt.x, toPt.y);
      if (fa == null || fb == null) continue;
      const realDrop = fa - fb;
      if (realDrop <= 0) continue;             // a fall does not go up
      if (!clearBetween(fromPt, toPt, fa, fb)) continue;
      const a = sqOf(fromPt.x, fromPt.y), b = sqOf(toPt.x, toPt.y);
      next.push({ at: toPt, path: [...node.path, {
        from: a, to: b, fromFine: fromPt, toFine: toPt, drop: realDrop,
        label: `${a.row},${a.col}->${b.row},${b.col}`,
      }] });
    }
  }
  frontier = next;
}

console.log('');
if (!answer) {
  console.log(`no route to ${TO ? TO.row + ',' + TO.col : 'anywhere new'} within ${MAX_JUMPS} jump(s).`);
  process.exit(2);
}
console.log(`REACHED ${TO.row},${TO.col} with ${answer.path.length} jump(s), ${((Date.now() - t0) / 1000).toFixed(1)}s of search:`);
for (const j of answer.path)
  console.log(`   jump ${String(j.from.row + ',' + j.from.col).padStart(7)} -> ${String(j.to.row + ',' + j.to.col).padEnd(7)}` +
              `  fine ${j.fromFine.x},${j.fromFine.y} -> ${j.toFine.x},${j.toFine.y}   ${j.drop > 0 ? 'down ' + j.drop : 'up ' + (-j.drop)}`);
console.log('');
console.log('these are CANDIDATES. Geometry says the hop is possible; only a character arriving');
console.log('says it is real. Confirm with a bot before --declare writes any of them down.');

if (has('json')) {
  const out = join(REPO, 'substrate', `jumpfinder-${ROOM}.json`);
  writeFileSync(out, JSON.stringify({ room: ROOM, from: FROM, to: TO, jumps: answer.path }, null, 1));
  console.log(`wrote ${out}`);
}
