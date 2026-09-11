#!/usr/bin/env node
// DOES OUR MOVER REFUSE A TREAD THE CLIENT WOULD TAKE? — the step rule, calibrated per room.
//
//   node tools/m59-treadaudit.mjs 515            every legal upward tread, by rise
//   node tools/m59-treadaudit.mjs 515 --step 128 finer lattice
//   node tools/m59-treadaudit.mjs 515 --json
//
// WHY THIS EXISTS. "The stone is above ground we can reach" is the verdict on three of the
// mana nodes, and it has exactly two causes that look identical from outside: the climb is
// genuinely not there, or OUR STEP RULE IS STRICTER THAN THE CLIENT'S and we are refusing a
// staircase somebody walks up every day. Nothing downstream can tell those apart — both
// present as a flood that stops at a height.
//
// THE CLIENT ALLOWS A RISE OF EXACTLY MAX_STEP_HEIGHT. `move.c:551` compares `<=`:
//
//     (wall->z1 - below_height - z) <= MAX_STEP_HEIGHT
//
// so 384 is legal and 385 is not. A single `<` instead of `<=` anywhere in a flood, a bake or
// a candidate filter deletes every exact-384 tread in the world — and real staircases are
// built out of them, because a level designer laying out steps uses the round number the
// engine allows. m59-research found a flight in room 515 whose treads are SIX exact 384s.
// Under a strict comparison that flight does not exist and the room reports precisely the
// symptom the node-runner baseline records.
//
// A GREP CANNOT ANSWER THIS AND THAT IS THE POINT. Auditing every `MAX_STEP_HEIGHT` in the
// tree finds the comparisons that are SPELLED; it cannot find a cap applied through a
// rounding, an epsilon, a radius test that happens to bite at the same height, or a wall
// predicate that refuses for an unrelated reason on exactly the geometry where steps live.
// So this asks the mover itself, on real ground, and reports the answer as a RATE BY RISE.
//
// HOW TO READ IT. The refusal rate at 384 is meaningless on its own — plenty of treads are
// refused for honest reasons (a wall, the player radius, headroom) and those reasons do not
// care about the rise. What matters is the SHAPE:
//
//   * 384 refusing at ~100% while 257-320 refuses at ~30%  -> the cap is exclusive somewhere
//   * 384 refusing at a rate that tracks its neighbours     -> the step rule is calibrated and
//                                                             the refusals are geometry
//
// Measured in room 515: 1932 exact-384 treads tried, 273 refused, 14.1% — against 16.1% at
// 1-128 and 30.1% at 257-320. The mover accepts 85.9% of them, so the step rule is right and
// that room's unreachable stone is not this bug. A clean null, and it cost one run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { sharedRoomGeometry, MAX_STEP_HEIGHT } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { sampleFloor } from './m59-staircase.mjs';

/**
 * Which bucket a rise falls in. Pure, so the boundaries are testable without a map — and they
 * matter: `384` must be its own bucket or the signal this tool exists for is averaged away
 * into the band below it.
 */
export function riseBucket(rise, cap = MAX_STEP_HEIGHT) {
  if (rise <= 0 || rise > cap) return null;          // not a legal upward tread
  if (rise === cap) return `${cap} (exact)`;
  if (rise > cap * 0.83) return `${Math.floor(cap * 0.83) + 1}-${cap - 1}`;
  if (rise > cap * 0.66) return `${Math.floor(cap * 0.66) + 1}-${Math.floor(cap * 0.83)}`;
  if (rise > cap / 3) return `${Math.floor(cap / 3) + 1}-${Math.floor(cap * 0.66)}`;
  return `1-${Math.floor(cap / 3)}`;
}

/** The order buckets are reported in, coarsest rise last so `exact` sits beside its neighbour. */
export function bucketOrder(cap = MAX_STEP_HEIGHT) {
  return [`1-${Math.floor(cap / 3)}`,
          `${Math.floor(cap / 3) + 1}-${Math.floor(cap * 0.66)}`,
          `${Math.floor(cap * 0.66) + 1}-${Math.floor(cap * 0.83)}`,
          `${Math.floor(cap * 0.83) + 1}-${cap - 1}`,
          `${cap} (exact)`];
}

/**
 * THE VERDICT, as a pure function of the tallies, so the reading rule is one place and not a
 * paragraph somebody has to remember. An exclusive cap makes the exact bucket refuse at a
 * rate far above every other; geometry makes it track them.
 */
export function calibration(tallies, cap = MAX_STEP_HEIGHT) {
  const exact = tallies[`${cap} (exact)`];
  if (!exact?.tried) return { verdict: 'no data', why: `no exact-${cap} treads in this room` };
  const rate = exact.refused / exact.tried;
  const others = Object.entries(tallies)
    .filter(([k, v]) => k !== `${cap} (exact)` && v.tried >= 20)
    .map(([, v]) => v.refused / v.tried);
  if (rate > 0.95)
    return { rate, verdict: 'EXCLUSIVE CAP',
             why: `every exact-${cap} tread is refused — something compares < rather than <=` };
  if (!others.length)
    return { rate, verdict: 'inconclusive', why: 'no other bucket has enough samples to compare' };
  const worst = Math.max(...others);
  if (rate > worst * 1.5 && rate > 0.5)
    return { rate, verdict: 'SUSPECT',
             why: `refused ${(100 * rate).toFixed(1)}% against ${(100 * worst).toFixed(1)}% ` +
                  `at the worst other bucket — the cap may be exclusive on some paths` };
  return { rate, verdict: 'calibrated',
           why: `refused ${(100 * rate).toFixed(1)}%, inside the range of the other buckets ` +
                `(worst ${(100 * worst).toFixed(1)}%) — refusals here are geometry, not the step rule` };
}

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('m59-treadaudit.mjs');

if (isMain) {
  if (argv.includes('--help') || !argv.length) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  }
  const ROOM = Number(argv.find(a => /^\d+$/.test(a)));
  const STEP = Number(flag('step', 256));
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
  const world = JSON.parse(readFileSync(join(REPO, 'substrate', 'm59-map.json'), 'utf8'));
  attachStepMasks(world);
  const room = world.rooms[String(ROOM)];
  if (!room) { console.error(`no room ${ROOM} in the map`); process.exit(1); }
  const geo = sharedRoomGeometry(room);
  const grid = sampleFloor(geo, geo.rows, geo.cols, { step: STEP });

  const N = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  const tallies = {}, examples = [];
  for (let iy = 0; iy < grid.h; iy++) for (let ix = 0; ix < grid.w; ix++) {
    const i = iy * grid.w + ix;
    if (Number.isNaN(grid.floor[i])) continue;
    for (const [dx, dy] of N) {
      const jx = ix + dx, jy = iy + dy;
      if (jx < 0 || jy < 0 || jx >= grid.w || jy >= grid.h) continue;
      const j = jy * grid.w + jx;
      if (Number.isNaN(grid.floor[j])) continue;
      const rise = grid.floor[j] - grid.floor[i];
      const b = riseBucket(rise);
      if (!b) continue;
      const t = geo.traceFineMoveClient(grid.xOf(ix), grid.yOf(iy), grid.xOf(jx), grid.yOf(jy),
                                        { slide: false });
      const ok = !!(t?.available && t.arrived);
      (tallies[b] ??= { tried: 0, refused: 0, reasons: {} }).tried++;
      if (!ok) {
        tallies[b].refused++;
        const why = String(t?.reason ?? 'unknown');
        tallies[b].reasons[why] = (tallies[b].reasons[why] ?? 0) + 1;
        if (rise === MAX_STEP_HEIGHT && examples.length < 4)
          examples.push({ from: [grid.xOf(ix), grid.yOf(iy)], to: [grid.xOf(jx), grid.yOf(jy)],
                          floors: [grid.floor[i], grid.floor[j]], reason: why });
      }
    }
  }
  const verdict = calibration(tallies);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ room: ROOM, step: STEP, tallies, verdict, examples }, null, 1));
    process.exit(0);
  }
  console.log(`\nroom ${ROOM} — ${room.name ?? '?'} — legal upward treads through the mover's own trace`);
  console.log(`  lattice ${grid.w}x${grid.h} at ${STEP} client units\n`);
  console.log('  rise bucket        tried   refused    rate   top reason');
  for (const b of bucketOrder()) {
    const e = tallies[b];
    if (!e) { console.log(`  ${b.padEnd(16)}     0`); continue; }
    const top = Object.entries(e.reasons).sort((a, c) => c[1] - a[1])[0];
    console.log(`  ${b.padEnd(16)} ${String(e.tried).padStart(6)} ${String(e.refused).padStart(9)}  ` +
                `${(100 * e.refused / e.tried).toFixed(1).padStart(6)}%  ${top ? `${top[0]} x${top[1]}` : '-'}`);
  }
  console.log(`\n  ${verdict.verdict}: ${verdict.why}`);
  if (verdict.verdict !== 'calibrated' && examples.length) {
    console.log('\n  refused exact-cap treads:');
    for (const x of examples)
      console.log(`    (${x.from}) -> (${x.to})   ${x.floors[0]} -> ${x.floors[1]}   ${x.reason}`);
  }
  console.log();
}
