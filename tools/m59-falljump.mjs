#!/usr/bin/env node
// THE FALL-JUMP: RUN OFF A LEDGE, STAY IN THE AIR, LAND SOMEWHERE THE FLOOR DOES NOT REACH.
//
//   node tools/m59-falljump.mjs                    what is declared, and whether it checks out
//   node tools/m59-falljump.mjs --room 599
//   node tools/m59-falljump.mjs --profile 599 36,16 38,10   the terrain and the fall curve
//   node tools/m59-falljump.mjs --json
//
// CLI CONTRACT: square pairs passed to `--profile` are `row,col`
// (KOD/RoomGeometry order), not movement-facing `col,row`.
//
// OFFLINE. Reads the baked geometry; no server, no broker.
//
// WHY THIS EXISTS. There are places in this world joined only by running off a high ledge,
// keeping your horizontal speed, and landing on middle ground across a gulley the floor
// does not span. Ukgoth is one: the ONLY doorway to Castle Victoria is at row 1, col 27,
// on a cliff top reached by a run-and-fall from about 36,16 to about 38,10, and it is
// notorious among new players. Nothing in this repository could express that. The mover
// knows one vertical rule — `MAX_STEP_HEIGHT`, which gates CLIMBING — and a fall is not a
// climb, so a legitimate traversal the whole world uses was simply invisible.
//
// The cost of that gap was not a missing route. It was a WRONG one: with no way to say
// "you may only reach the north-west of Ukgoth by falling", the router found the doorway
// anyway, through a wall, because `moverStepLands` is over-permissive on that boundary
// (see m59-clipsweep.mjs — 211 rooms of it). Twenty-one characters "arrived" at Castle
// Victoria in 17-23 seconds through solid rock, and it was read as proof that routing
// worked. A model with no concept of a mechanic does not decline to use it; it invents
// something else and reports success.
//
// DECLARED, NOT DERIVED — AND THAT IS A MEASUREMENT, NOT LAZINESS.
//
// The physics are all known: GRAVITY_ACCELERATION = -5 * FINENESS, FALL_VELOCITY_0 =
// -FINENESS * 2/3 (clientd3d/moveobj.h:15, move.h:17), horizontal speed 5 squares/second
// at a run. So the arc can be computed. It was, against the one jump whose real endpoints
// an operator supplied — and the terrain there descends in STEPS which the fall curve
// tracks within about 30 client units, a thirtieth of a square:
//
//     d 2.5  floor 5872   faller 4891      <- the ledge ends
//     d 3.0  floor 4576   faller 4541      <- 35 units of clearance
//     d 4.0  floor 3712   faller 3687      <- 25 units
//
// A model whose margin is 25 units decides "makeable" on rounding. So `physics()` is
// reported as EVIDENCE and never as a verdict: `traversable()` answers from the declared
// table, and the arithmetic is there to argue with, not to gate on. If somebody later
// validates the model against a dozen known jumps, the gate can move — that day, not now.
//
// A DECLARATION IS A CLAIM ABOUT SOMEBODY ELSE'S SERVER, so it carries who saw it and
// when, the same as substrate/m59-crossings.json. An entry nobody has walked is a guess
// with a citation, and worth less than no entry at all.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const TABLE = join(REPO, 'substrate', 'm59-falljumps.json');

// clientd3d/moveobj.h:15, move.h:17, move.c:49,184 — see the header.
export const FINENESS = 1024;
export const GRAVITY = 5 * FINENESS;          // units/s/s, downward positive here
export const FALL_V0 = FINENESS * 2 / 3;      // initial downward speed when you leave a ledge
export const RUN_UNITS_PER_S = 5 * FINENESS;  // 5 squares/second at a run
export const WALK_UNITS_PER_S = 2.5 * FINENESS;

let cache = null, cachedAt = 0;
export function loadFallJumps() {
  try {
    const stat = existsSync(TABLE) ? readFileSync(TABLE, 'utf8') : null;
    if (stat == null) return { jumps: [] };
    if (cache && cachedAt === stat.length) return cache;
    cache = JSON.parse(stat); cachedAt = stat.length;
    return cache;
  } catch { return { jumps: [] }; }
}

/** Every declared fall-jump that starts in this room. */
export function fallJumpsIn(room) {
  return (loadFallJumps().jumps ?? []).filter(j => Number(j.room) === Number(room));
}

/**
 * MAY THIS CHARACTER MAKE THIS JUMP RIGHT NOW.
 *
 * Declared jumps only, and `requires.running` is the one gate that is honoured, because it
 * is the one an operator can state without arithmetic: at a walk you do not clear the gap.
 * A character below the run threshold is refused rather than allowed to try — falling into
 * a gulley is not a cheap mistake, and the whole point of the table is that the fleet
 * stops discovering these by accident.
 */
export function traversable(jump, { vigor = null, running = null } = {}) {
  if (!jump) return { ok: false, why: 'no such jump' };
  if (jump.requires?.running) {
    // VIGOR_RUN_THRESHOLD is 10 in user.kod; the broker keeps two points of headroom.
    const canRun = running ?? (vigor == null ? null : vigor >= 12);
    if (canRun === false) return { ok: false, why: 'this jump needs a run and vigor is too low' };
    if (canRun == null) return { ok: null, why: 'cannot tell whether this character can run' };
  }
  return { ok: true, why: 'declared, and the character can run it' };
}

/**
 * The arc, as EVIDENCE. Never a verdict — see the header.
 * Returns where a runner leaving `from` at `speed` would first meet floor, given a
 * `floorAt(row, col)` the caller supplies from the room geometry.
 */
export function physics(from, toward, floorAt, { speed = RUN_UNITS_PER_S, step = 0.25, maxSquares = 14 } = {}) {
  const z0 = floorAt(from.row, from.col);
  if (z0 == null) return { ok: false, why: 'no floor at the take-off square' };
  const dr = toward.row - from.row, dc = toward.col - from.col;
  const len = Math.hypot(dr, dc) || 1;
  const ur = dr / len, uc = dc / len;
  const samples = [];
  let leftLedge = false;
  for (let d = step; d <= maxSquares; d += step) {
    const row = Math.round(from.row + ur * d), col = Math.round(from.col + uc * d);
    const t = d * FINENESS / speed;
    const z = z0 - (FALL_V0 * t + 0.5 * GRAVITY * t * t);
    const floor = floorAt(row, col);
    samples.push({ d, row, col, floor, z: Math.round(z) });
    // "Left the ledge" means the ground has actually dropped away beneath us. Without
    // this the trace lands on the take-off square itself at the first sample.
    if (floor != null && floor < z0 - 1) leftLedge = true;
    if (leftLedge && floor != null && z <= floor)
      return { ok: true, lands: { row, col }, after_squares: d, seconds: t, drop: Math.round(z0 - z), samples };
  }
  return { ok: false, why: 'no floor met within range — this arc falls past everything', samples };
}

// ---------------------------------------------------------------------------- cli
// Direct execution, asked the way m59-path-test.mjs insists on: a hand-built `file://`
// URL is wrong on Windows and wrong for any path with a space in it, and the lint that
// says so is a test rather than a convention.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const table = loadFallJumps();

  if (argv.includes('--profile')) {
    const room = Number(arg('--profile'));
    const [a, b] = argv.slice(argv.indexOf('--profile') + 2, argv.indexOf('--profile') + 4);
    const [fr, fc] = String(a).split(',').map(Number);
    const [tr, tc] = String(b).split(',').map(Number);
    const { sharedRoomGeometry } = await import('./m59-roo.mjs');
    const { loadMap } = await import('./m59-map.mjs');
    const map = await loadMap();
    const g = sharedRoomGeometry(map.rooms[room]);
    const floorAt = (row, col) => { const sp = g.standPoint?.(row, col); return sp ? (g.floorBaseAtClient?.(sp.x, sp.y) ?? null) : null; };
    const r = physics({ row: fr, col: fc }, { row: tr, col: tc }, floorAt);
    console.log(`room ${room}: ${fr},${fc} -> ${tr},${tc}   (evidence only, not a verdict)`);
    console.log(' d(sq)   square    floor   faller-z');
    for (const s of r.samples ?? [])
      console.log('  ' + s.d.toFixed(2).padStart(5), (s.row + ',' + s.col).padStart(9),
        String(s.floor ?? '--').padStart(8), String(s.z).padStart(9));
    console.log(r.ok ? `\nwould first meet floor at ${r.lands.row},${r.lands.col} after ${r.after_squares} squares (${r.seconds.toFixed(2)}s, ${r.drop} units)`
                     : `\n${r.why}`);
    process.exit(0);
  }

  const only = arg('--room') ? Number(arg('--room')) : null;
  const jumps = (table.jumps ?? []).filter(j => only == null || Number(j.room) === only);
  if (argv.includes('--json')) { console.log(JSON.stringify(jumps, null, 1)); process.exit(0); }

  if (!jumps.length) {
    console.log('no fall-jumps declared' + (only != null ? ` for room ${only}` : '') +
                `\n  declare them in ${TABLE}`);
    process.exit(0);
  }
  console.log(`${jumps.length} declared fall-jump(s)\n`);
  console.log('room  from      to        needs run  seen by');
  for (const j of jumps)
    console.log(String(j.room).padStart(4),
      `${j.from.row},${j.from.col}`.padEnd(10),
      (j.to ? `${j.to.row},${j.to.col}` : 'UNMEASURED').padEnd(10),
      String(!!j.requires?.running).padEnd(10), j.observed_by ?? '(nobody — a guess)');
  const unseen = jumps.filter(j => !j.observed_by);
  if (unseen.length) console.log(`\n${unseen.length} entr(y/ies) nobody has walked — worth less than no entry at all`);
}

// Prefer the requested declared landing before accepting a nearby variation.
export function selectDeclaredFall(candidates,{from,to}) {
  let best=null,score=Infinity;
  for(const candidate of candidates){
    const target=Math.hypot(candidate.to.row-to.row,candidate.to.col-to.col);
    const start=Math.hypot(candidate.from.row-from.row,candidate.from.col-from.col);
    const rank=target*100+start;
    if(rank<score){best=candidate;score=rank;}
  }
  return best;
}
