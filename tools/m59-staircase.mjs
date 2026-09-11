#!/usr/bin/env node
// THE WAY UP THAT THE SQUARE GRID CANNOT SPELL.
//
//   node tools/m59-staircase.mjs 579                    every climb out of this room's body
//   node tools/m59-staircase.mjs 45 --to r63c46         can we climb to the Badlands stone?
//   node tools/m59-staircase.mjs 579 --from r40c33      from one square in particular
//   node tools/m59-staircase.mjs 45 --to r63c46 --json
//
// THE MOVER HAS EXACTLY ONE VERTICAL RULE AND IT GATES CLIMBING. `MAX_STEP_HEIGHT` is 384
// client units (24 KOD, `clientd3d/move.c:55`), descent is unbounded, and every refusal to
// reach high ground is that one number. So the question "how do we get up there" always has
// the same shape: is there a chain of rises, each one inside the cap, from ground we can
// already stand on?
//
// AND THE CHAIN IS INVISIBLE AT SQUARE RESOLUTION, WHICH IS WHY THIS FILE EXISTS. The Ancient
// Place's staircase climbs 5152 -> 5504 -> 5856 -> 6208 — **+352 a tread**, legal every one
// of them. Ask the coarse grid and it answers per square: `r40c33` spans 3520 to 10880, the
// valley floor and the high ledge in ONE number, so a step onto it reads as a 7000-unit cliff
// and the whole staircase disappears. `moverStepLands` is a square-to-square predicate and
// cannot see treads narrower than a square. THE FINE GRID IS THE REALITY; a square is a
// summary and on a staircase it is a false one.
//
// WHAT IT MEASURED THE DAY IT WAS WRITTEN. `m59-nodegap.mjs` had just established that not
// one unreached mana stone is BELOW the ground we can stand on — every one is above it:
// badlands +1280, sentinel +3984, peak +4640, all past the 384 cap. `m59-falljumps.json`
// declares FALLS, so there was no line anyone could add to it that would close any of them.
// This is the other half of that finding: if the way up is a staircase the walker cannot
// spell, then nothing is missing from the map at all and the defect is in the mover.
//
// IT RE-DERIVES NOTHING, AND IT VERIFIES WHAT IT REPORTS. Discovery floods a lattice on
// precomputed floor heights, which is cheap. Every tread of a chain it then PRINTS is
// re-walked through `traceFineMoveClient` — the mover's own fine-resolution trace, the thing
// the body actually obeys — so the output is a claim the mover has agreed to rather than a
// second opinion about the map. A tread the trace refuses is reported as refused.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap, movementMapFile, CHECKED_MAP_FILE } from './m59-map.mjs';
import { routesFor, attachStepMasks, reachableFrom } from './m59-routes.mjs';
import { sharedRoomGeometry, CLIENT_FINENESS, MAX_STEP_HEIGHT } from './m59-roo.mjs';

const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = (n, d = null) => {
  const at = argv.indexOf('--' + n);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
};
const sq = (row, col) => `r${row}c${col}`;
const parseSquare = v => {
  const m = /^r(\d+)c(\d+)$/i.exec(String(v ?? ''));
  return m ? { row: Number(m[1]), col: Number(m[2]) } : null;
};
/** A fine client point back to the square that contains it. */
const squareOf = (x, y) => ({ row: Math.floor(y / CLIENT_FINENESS), col: Math.floor(x / CLIENT_FINENESS) });

/**
 * SAMPLE THE ROOM'S FLOOR AT FINE RESOLUTION.
 *
 * `step` defaults to 256 client units — a quarter of a square, and the player's own collision
 * radius, so two adjacent samples are exactly one body apart. Finer than that costs time and
 * tells you nothing the mover can act on; coarser starts merging treads back together, which
 * is the whole failure this tool exists to undo.
 */
export function sampleFloor(geo, rows, cols, { step = 256 } = {}) {
  const w = Math.floor((cols * CLIENT_FINENESS) / step);
  const h = Math.floor((rows * CLIENT_FINENESS) / step);
  const floor = new Float64Array(w * h).fill(NaN);
  let occupiable = 0;
  for (let iy = 0; iy < h; iy++) {
    const y = iy * step + (step >> 1);
    for (let ix = 0; ix < w; ix++) {
      const x = ix * step + (step >> 1);
      let ok = false;
      try { ok = geo._occupiable(x, y); } catch { ok = false; }
      if (!ok) continue;
      let f = null;
      try { f = geo.floorBaseAtClient(x, y); } catch { f = null; }
      if (f == null || !Number.isFinite(f)) continue;
      floor[iy * w + ix] = f;
      occupiable++;
    }
  }
  return { floor, w, h, step, occupiable,
           xOf: ix => ix * step + (step >> 1), yOf: iy => iy * step + (step >> 1) };
}

/**
 * FLOOD FROM THE GROUND WE CAN STAND ON, OBEYING THE ONE VERTICAL RULE.
 *
 * A climb of more than `MAX_STEP_HEIGHT` is refused; a descent of any size is allowed,
 * because the mover's rule is one-directional and a fall is not a step. Eight-connected,
 * because the mover moves diagonally.
 *
 * `prev` is kept so a chain can be reconstructed — a reachability answer with no path in it
 * is the same unhelpful "no route" this repository keeps paying for.
 */
export function floodClimb(grid, seeds, { maxStep = MAX_STEP_HEIGHT, canStep = null } = {}) {
  const { floor, w, h } = grid;
  const seen = new Int32Array(w * h).fill(-1);       // index of predecessor, -2 for a seed
  const queue = [];
  for (const s of seeds) {
    if (s < 0 || s >= w * h || Number.isNaN(floor[s])) continue;
    if (seen[s] !== -1) continue;
    seen[s] = -2; queue.push(s);
  }
  const N = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi], ix = i % w, iy = (i / w) | 0, from = floor[i];
    for (const [dx, dy] of N) {
      const nx = ix + dx, ny = iy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (seen[j] !== -1) continue;
      const to = floor[j];
      if (Number.isNaN(to)) continue;
      // THE ONE RULE. Up is capped; down is free.
      if (to - from > maxStep) continue;
      // AND A HEIGHT TEST IS NOT A WALK. The first version of this flood knew only about
      // floors, so it happily climbed THROUGH walls: on its first run against room 579 it
      // produced an eleven-tread chain of which the mover refused SIX with
      // `geometry_blocked`. A chain the body cannot walk is worse than no chain, because it
      // reads as an answer. `canStep` is the mover's own fine trace, and with it the flood
      // only ever crosses ground the body would cross.
      if (canStep && !canStep(i, j)) continue;
      seen[j] = i; queue.push(j);
    }
  }
  return { seen, reached: queue.length };
}

/**
 * WHERE WOULD YOU HAVE TO BE STANDING TO GET THERE?
 *
 * "Not reachable by climbing" is the same unhelpful shape as "no route" unless it says what
 * WOULD work. Descent is free and only climbing is capped, so the set of points that can
 * reach a target is found by flooding BACKWARDS from it: `j` can step to `i` when
 * `floor[i] - floor[j] <= maxStep`, so from `i` we admit any neighbour `j` at most one step
 * below — and any neighbour ABOVE it at all, because falling to `i` costs nothing.
 *
 * The result is the target's BASIN: every sample from which the stone is reachable. Intersect
 * it with the ground the square model can stand on and the answer is one of two sentences —
 * "you can already get there and the router cannot see it", or "the basin and our ground do
 * not touch, so the way in is from somewhere else entirely."
 */
export function floodBasin(grid, target, { maxStep = MAX_STEP_HEIGHT, canStep = null } = {}) {
  const { floor, w, h } = grid;
  const seen = new Int32Array(w * h).fill(-1);
  if (target < 0 || Number.isNaN(floor[target])) return { seen, reached: 0 };
  const queue = [target];
  seen[target] = -2;
  const N = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi], ix = i % w, iy = (i / w) | 0, here = floor[i];
    for (const [dx, dy] of N) {
      const nx = ix + dx, ny = iy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (seen[j] !== -1) continue;
      const there = floor[j];
      if (Number.isNaN(there)) continue;
      // Reversed: j -> i must be a legal climb, so j may be any height ABOVE i, or at most
      // one step below it.
      if (here - there > maxStep) continue;
      if (canStep && !canStep(j, i)) continue;
      seen[j] = i; queue.push(j);
    }
  }
  return { seen, reached: queue.length };
}

/** Walk the predecessor chain back to its seed. */
export function chainTo(grid, seen, target) {
  const out = [];
  let i = target;
  while (i >= 0 && seen[i] !== -1) {
    const ix = i % grid.w, iy = (i / grid.w) | 0;
    out.push({ i, x: grid.xOf(ix), y: grid.yOf(iy), floor: grid.floor[i] });
    if (seen[i] === -2) break;
    i = seen[i];
  }
  return out.reverse();
}

/**
 * THE TREADS, which is what a person can actually act on.
 *
 * A chain of a thousand lattice points is not a staircase; the useful artifact is where the
 * climbing HAPPENS. This keeps only the points where the floor rises, and reports each rise
 * with the square it lands in — so the answer reads "board at rNcM and climb these six".
 */
export function treadsOf(chain, { minRise = 1 } = {}) {
  const treads = [];
  for (let k = 1; k < chain.length; k++) {
    const rise = chain[k].floor - chain[k - 1].floor;
    if (rise < minRise) continue;
    treads.push({ from: chain[k - 1], to: chain[k], rise,
                  square: squareOf(chain[k].x, chain[k].y) });
  }
  return treads;
}

/** Ask the mover itself whether each tread is walkable. A claim it has not agreed to is a guess. */
export function verifyTreads(geo, treads) {
  return treads.map(t => {
    let r = null;
    try { r = geo.traceFineMoveClient(t.from.x, t.from.y, t.to.x, t.to.y); }
    catch (e) { r = { blocked: true, reason: e.message }; }
    return { ...t, walked: !!(r && r.arrived && !r.blocked), reason: r?.reason ?? null };
  });
}

function main() {
  const asked = argv.find(a => /^\d+$/.test(a));
  if (!asked) {
    console.log('name a room:  node tools/m59-staircase.mjs 579 [--to rNcM] [--from rNcM]');
    process.exit(2);
  }
  const roomNum = Number(asked);
  const mapFile = has('checked') ? CHECKED_MAP_FILE : movementMapFile();
  const map = loadMap(mapFile);
  const table = routesFor(map.geometryManifestSha256);
  if (table) attachStepMasks(map);
  const room = map.rooms[String(roomNum)];
  if (!room) { console.log(`room ${roomNum} is not in the map`); process.exit(2); }

  const geo = sharedRoomGeometry(room);
  const step = Number(flag('step', 256));
  const grid = sampleFloor(geo, room.rows, room.cols, { step });

  // THE SEEDS ARE THE GROUND WE CAN ALREADY STAND ON, and that is the whole comparison this
  // tool makes: the square model says these squares, and the fine model says what they can
  // climb to. Seeding from anywhere else answers a question nobody asked.
  const fromArg = parseSquare(flag('from', null));
  let seedSquares = [];
  if (fromArg) seedSquares = [fromArg];
  else {
    for (const [id, r] of Object.entries(map.rooms)) {
      for (const e of (r.edgeExits ?? [])) if (Number(e.to) === roomNum) seedSquares.push({ row: e.arriveRow, col: e.arriveCol, from: Number(id) });
      for (const g of (r.goExits ?? [])) if (Number(g.to) === roomNum) seedSquares.push({ row: g.arriveRow, col: g.arriveCol, from: Number(id) });
    }
  }
  if (!seedSquares.length) { console.log(`nothing arrives in room ${roomNum}, and no --from given`); process.exit(2); }

  // Every fine sample inside a square the SQUARE model can reach from the arrival.
  const reachSquares = new Set();
  for (const s of seedSquares) {
    const seen = reachableFrom(map, roomNum, s.row, s.col);
    if (seen) for (const k of seen) reachSquares.add(k);
    else reachSquares.add(`${s.row},${s.col}`);
  }
  // SEEDING EVERY SAMPLE INSIDE A REACHABLE SQUARE IS CHEATING, AND IT IS THE SPLIT-SQUARE
  // TRAP WEARING A NEW HAT. `r40c33` in this very room spans 3520 to 10880 — the valley floor
  // AND the high ledge, one square. A body that "can reach" that square stands on the valley
  // half; seeding the ledge half hands the flood the summit for free and it reports a climb
  // that starts where nobody can stand.
  //
  // Measured the first time this ran: it seeded a sample at 12800, called it reached, and
  // produced a chain of ZERO treads — a staircase whose first step is the top.
  //
  // So a sample is a seed only if it is within one step of the square's own STAND POINT,
  // which is where the mover actually puts the body.
  const seeds = [];
  for (const key of reachSquares) {
    const [row, col] = key.split(',').map(Number);
    let sp = null; try { sp = geo.standPoint(row, col); } catch { sp = null; }
    if (!sp) continue;
    let spFloor = null; try { spFloor = geo.floorBaseAtClient(sp.x, sp.y); } catch { spFloor = null; }
    if (spFloor == null || !Number.isFinite(spFloor)) continue;
    const x0 = col * CLIENT_FINENESS, y0 = row * CLIENT_FINENESS;
    for (let y = y0; y < y0 + CLIENT_FINENESS; y += step)
      for (let x = x0; x < x0 + CLIENT_FINENESS; x += step) {
        const ix = Math.floor(x / step), iy = Math.floor(y / step);
        if (ix >= grid.w || iy >= grid.h) continue;
        const i = iy * grid.w + ix;
        const f = grid.floor[i];
        if (Number.isNaN(f)) continue;
        if (Math.abs(f - spFloor) > MAX_STEP_HEIGHT) continue;   // the other half of a split square
        seeds.push(i);
      }
  }

  // THE EDGE TEST IS THE MOVER'S OWN FINE TRACE, unless asked for the cheap one. It costs
  // about 45 microseconds a call and there are a few hundred thousand of them, which is
  // seconds — worth it for a diagnostic whose entire value is being TRUE.
  const fast = has('fast');
  const canStep = fast ? null : (i, j) => {
    const ix = i % grid.w, iy = (i / grid.w) | 0, jx = j % grid.w, jy = (j / grid.w) | 0;
    let r = null;
    try { r = geo.traceFineMoveClient(grid.xOf(ix), grid.yOf(iy), grid.xOf(jx), grid.yOf(jy)); }
    catch { return false; }
    return !!(r && r.arrived && !r.blocked);
  };
  const t0 = Date.now();
  const { seen, reached } = floodClimb(grid, seeds, { canStep });
  const floodMs = Date.now() - t0;

  // Where the square model tops out, and where the fine flood does.
  let squareTop = -Infinity, fineTop = -Infinity, fineTopIdx = -1;
  for (const key of reachSquares) {
    const [row, col] = key.split(',').map(Number);
    let p = null; try { p = geo.standPoint(row, col); } catch {}
    if (!p) continue;
    let f = null; try { f = geo.floorBaseAtClient(p.x, p.y); } catch {}
    if (f != null && f > squareTop) squareTop = f;
  }
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] === -1 || Number.isNaN(grid.floor[i])) continue;
    if (grid.floor[i] > fineTop) { fineTop = grid.floor[i]; fineTopIdx = i; }
  }

  console.log(`room ${roomNum} — ${room.name} — ${room.rows}x${room.cols} squares`);
  console.log(`  lattice ${grid.w}x${grid.h} at ${step} client units (${grid.occupiable} occupiable samples)`);
  console.log(`  seeded from ${seedSquares.map(s => sq(s.row, s.col)).join(', ')}` +
              ` -> ${reachSquares.size} square(s) the SQUARE model can reach`);
  console.log(`  the fine flood reaches ${reached} sample(s) in ${floodMs}ms` +
              (fast ? ' (--fast: heights only, walls NOT checked)'
                    : ' (every edge walked by the mover own fine trace)'));
  console.log(`  highest floor the SQUARE model stands on: ${squareTop === -Infinity ? '?' : squareTop}`);
  console.log(`  highest floor the FINE climb reaches:     ${fineTop === -Infinity ? '?' : fineTop}` +
              (fineTop > squareTop ? `   <-- ${fineTop - squareTop} units HIGHER` : '   (no higher)'));

  const toArg = parseSquare(flag('to', null));
  let target = null;
  if (toArg) {
    // Any sample inside the target square, highest first — the stone sits on the high part.
    const x0 = toArg.col * CLIENT_FINENESS, y0 = toArg.row * CLIENT_FINENESS;
    let best = -1, bestF = -Infinity;
    for (let y = y0; y < y0 + CLIENT_FINENESS; y += step)
      for (let x = x0; x < x0 + CLIENT_FINENESS; x += step) {
        const ix = Math.floor(x / step), iy = Math.floor(y / step);
        if (ix >= grid.w || iy >= grid.h) continue;
        const i = iy * grid.w + ix;
        if (seen[i] === -1 || Number.isNaN(grid.floor[i])) continue;
        if (grid.floor[i] > bestF) { bestF = grid.floor[i]; best = i; }
      }
    if (best < 0) {
      console.log(`\n  ${sq(toArg.row, toArg.col)} is NOT reachable by climbing from this ground.`);
      // AND THAT IS ONLY HALF AN ANSWER. "Not reachable" is the same unhelpful shape as "no
      // route" unless it says what WOULD work. Flood BACKWARDS from the stone to find every
      // sample that could reach it, and say whether that basin touches anything we can stand
      // on — which turns one refusal into one of two actionable sentences.
      const x1 = toArg.col * CLIENT_FINENESS, y1 = toArg.row * CLIENT_FINENESS;
      let anchor = -1, anchorF = -Infinity;
      for (let y = y1; y < y1 + CLIENT_FINENESS; y += step)
        for (let x = x1; x < x1 + CLIENT_FINENESS; x += step) {
          const ix = Math.floor(x / step), iy = Math.floor(y / step);
          if (ix >= grid.w || iy >= grid.h) continue;
          const i2 = iy * grid.w + ix;
          if (!Number.isNaN(grid.floor[i2]) && grid.floor[i2] > anchorF) { anchorF = grid.floor[i2]; anchor = i2; }
        }
      if (anchor < 0) {
        console.log(`  and no sample inside ${sq(toArg.row, toArg.col)} is even occupiable — the`);
        console.log(`  square may be solid, or the stone may sit on scenery rather than floor.`);
        return;
      }
      const basin = floodBasin(grid, anchor, { canStep });
      const basinSquares = new Set();
      let lowest = Infinity, lowestIdx = -1;
      for (let i2 = 0; i2 < basin.seen.length; i2++) {
        if (basin.seen[i2] === -1) continue;
        const ix = i2 % grid.w, iy = (i2 / grid.w) | 0;
        const s2 = squareOf(grid.xOf(ix), grid.yOf(iy));
        basinSquares.add(`${s2.row},${s2.col}`);
        if (grid.floor[i2] < lowest) { lowest = grid.floor[i2]; lowestIdx = i2; }
      }
      const touches = [...basinSquares].filter(k => reachSquares.has(k));
      console.log(`  its BASIN — every sample from which the stone IS reachable — is ` +
                  `${basin.reached} sample(s)`);
      console.log(`  across ${basinSquares.size} square(s), bottoming out at ${lowest}.`);
      if (touches.length) {
        console.log(`  AND IT TOUCHES GROUND WE CAN STAND ON at ${touches.length} square(s), e.g. ` +
                    touches.slice(0, 6).map(k => sq(...k.split(',').map(Number))).join(', ') + '.');
        console.log(`  So the stone IS reachable and the square-resolution model cannot see it:`);
        console.log(`  a MOVER defect, not a missing affordance. Aim a crawl at one of those.`);
      } else {
        const lx = lowestIdx % grid.w, ly = (lowestIdx / grid.w) | 0;
        const ls = squareOf(grid.xOf(lx), grid.yOf(ly));
        console.log(`  AND IT TOUCHES NOTHING WE CAN STAND ON. Its lowest point is ` +
                    `${sq(ls.row, ls.col)} at ${lowest},`);
        console.log(`  which is ${lowest - squareTop} units above our own highest ground.`);
        console.log(`  So the way in is NOT a climb and NOT a jump from here — the stone's ground`);
        console.log(`  is a separate island. Look for another ENTRANCE to this room, a trigger, or`);
        console.log(`  a fall INTO the basin from a room that is higher still.`);
      }
      return;
    }
    target = best >= 0 ? best : null;
  } else if (fineTopIdx >= 0 && fineTop > squareTop) {
    target = fineTopIdx;
  }

  if (target == null) {
    console.log('\n  nothing to climb to: the fine flood reaches no higher than the square model.');
    return;
  }

  const chain = chainTo(grid, seen, target);
  const treads = verifyTreads(geo, treadsOf(chain));
  const board = treads.length ? treads[0].from : chain[0];
  const climbed = treads.reduce((n, t) => n + t.rise, 0);
  const refused = treads.filter(t => !t.walked);

  // A CHAIN WITH NO TREADS IN IT IS NOT A CLIMB. "A CLIMB EXISTS — board at the destination"
  // is a sentence that reads like an answer and contains none; when the target was already
  // standable ground, say that instead.
  if (!treads.length) {
    console.log(`\n  NO CLIMB IS NEEDED: ${toArg ? sq(toArg.row, toArg.col) : 'the target'} is ` +
                `already on ground the fine`);
    console.log(`  flood walks to without gaining height (${chain.length} lattice step(s), 0 ` +
                `treads). If a live attempt`);
    console.log(`  fails here, the obstacle is bodies or the last-squares mover, not the terrain.`);
    return;
  }

  console.log(`\n  A CLIMB EXISTS. ${treads.length} tread(s), ${climbed} units of rise, ` +
              `${chain.length} lattice step(s) total.`);
  console.log(`  BOARD AT ${sq(...Object.values(squareOf(board.x, board.y)))} ` +
              `(fine x${board.x} y${board.y}, floor ${board.floor}) — a staircase is invisible ` +
              `unless you board it at the bottom.`);
  for (const t of treads.slice(0, Number(flag('treads', 20))))
    console.log(`    +${String(t.rise).padStart(5)} -> ${String(t.to.floor).padStart(6)} ` +
                `at ${sq(t.square.row, t.square.col)} (x${t.to.x} y${t.to.y})` +
                `${t.walked ? '' : `   REFUSED BY THE MOVER: ${t.reason ?? 'blocked'}`}`);
  if (treads.length > 20) console.log(`    ...and ${treads.length - 20} more`);
  console.log(`\n  every tread re-walked through the mover's own fine trace: ` +
              `${treads.length - refused.length}/${treads.length} agreed` +
              (refused.length ? ` — ${refused.length} REFUSED, so this chain is not walkable as reported`
                              : ' — the mover agrees with all of them'));
  if (!refused.length && treads.length)
    console.log(`  So nothing is missing from the MAP here. The way up exists and every tread is\n` +
                `  legal; what cannot see it is the square-resolution step model the router\n` +
                `  plans on. That is a mover defect, not a missing affordance.`);

  if (has('json'))
    console.log(JSON.stringify({ room: roomNum, squareTop, fineTop, treads, chainLength: chain.length }, null, 1));
}

if (process.argv[1] && /m59-staircase\.mjs$/.test(process.argv[1])) main();
