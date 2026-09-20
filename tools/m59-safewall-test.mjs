#!/usr/bin/env node
// A SAFE WALL, ON REAL GEOMETRY, AGAINST SQUARES CHARACTERS ACTUALLY HELD.
//
//   node tools/m59-safewall-test.mjs
//
// Offline. Reads `substrate/m59-map.json` and `substrate/m59-safespots.json` and needs
// nothing live.
//
// WHY IT EXISTS, given there are already 141 safe-spot assertions. Those are about the
// BOOK-KEEPING — proving a square, disproving one, the settle grace, the pull detector,
// when a verdict may be written down. They are the epistemics of the record and they are
// right. What none of them touches is the MECHANISM, and the mechanism is tested only on
// synthetic 15x15 grids in `m59-combat-test.mjs`. Nothing asserted that the thing the
// fleet is standing on in the real world is a safe wall, or that the router still lets it
// get there.
//
// THE MECHANISM, in one line of kod each. `Monster.CanReach` calls `Room.LineOfSight`
// (`monster.kod:1782`); `Player.TargetWithinSightAndRange` (`player.kod:4115`) checks
// range and a facing cone and NEVER CALLS IT. So a square whose line to a patch of floor
// is broken, while that floor is still inside our weapon range, lets us hit what stands
// there and take nothing back. That asymmetry is what a player means by a safe wall, it
// is a fundamental part of what this game is balanced around, and the fleet's whole
// defensive game is built on it.
//
// AND IT IS THE SAME GEOMETRIC FACT AS THE POCKET TRAP, which is the reason this file was
// written the day the router learned to prefer open ground. A safe wall IS the coarse grid
// and the BSP disagreeing — measured: squares at a disagreement held 44.0% against 23.9%
// for ordinary floor, dose-responsively — so a routing preference for open ground is, if
// it is allowed to leak into the tactical questions, a preference against the best squares
// in the game. It leaked once already: `world.reach` measures how far a wall is and
// `nearestSafeSpot` ranks at -0.5 a step, and with the preference on, 36.7% of walks to a
// recorded held wall came back longer, worst +9 steps — 4.5 points against a proof bonus
// of 20. The last section here is the guard against that returning.
import { readFileSync, existsSync } from 'node:fs';
import { safeSpots, safeWalls, exposureAt, lineOfSight, nearestSafeSpot, geometryFor, MAX_ATTACKERS }
  from './m59-safespots.mjs';
import { RoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';

let pass = 0, fail = 0, skipped = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};
const skip = (what, why) => { skipped++; console.log(`  --   ${what} — ${why}`); };

const mapFile = new URL('../substrate/m59-map.json', import.meta.url);
const bookFile = new URL('../substrate/m59-safespots.json', import.meta.url);
if (!existsSync(mapFile) || !existsSync(bookFile)) {
  skip('everything', 'no baked map or no safe-spot book on this machine');
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}
const map = JSON.parse(readFileSync(mapFile, 'utf8'));
const book = JSON.parse(readFileSync(bookFile, 'utf8'));

// The squares the fleet has stood on under attack and not been hit on. `failed` retires a
// square permanently — one failure is enough — so these are held-and-never-failed.
const heldByRoom = new Map();
for (const [num, spots] of Object.entries(book.rooms || {})) {
  const held = Object.entries(spots)
    .filter(([, rec]) => rec.held > 0 && !rec.failed)
    .map(([key]) => { const [col, row] = key.split(',').map(Number); return { col, row, key }; });
  if (held.length) heldByRoom.set(num, held);
}
const totalHeld = [...heldByRoom.values()].reduce((n, l) => n + l.length, 0);

// ---------------------------------------------------------------------------
console.log('the asymmetry that makes a safe wall, on a real room');
{
  // Read it off the recorded squares rather than off a fixture, because a fixture is a
  // room somebody designed to demonstrate the mechanism and these are rooms the fleet
  // fought in. `free_shots` counts squares within OUR reach whose line back to us is
  // broken — the thing `Player.TargetWithinSightAndRange` cannot see and
  // `Monster.CanReach` can.
  let withFreeShots = 0, checked = 0, blindLines = 0, sightedLines = 0;
  for (const [num, held] of heldByRoom) {
    const geometry = geometryFor(map.rooms[num]);
    if (!geometry) continue;
    for (const spot of held) {
      const exposure = exposureAt(geometry, spot.row, spot.col);
      checked++;
      if (exposure.free_shots > 0) withFreeShots++;
      // And the line really is broken: at least one square in the disc that we can stand
      // and shoot at cannot see us back.
      for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
        const r = spot.row + dr, c = spot.col + dc;
        if ((!dr && !dc) || !geometry.walkable(r, c)) continue;
        if (dr * dr + dc * dc > 9) continue;
        if (lineOfSight(geometry, r, c, spot.row, spot.col) === false) blindLines++;
        else sightedLines++;
      }
    }
  }
  ok('there are recorded held squares to test against', checked > 50, `${checked}`);
  ok('most of them offer a shot that cannot be answered',
     withFreeShots / checked > 0.5, `${withFreeShots}/${checked}`);
  ok('and the broken line is real geometry, not a score',
     blindLines > 0 && sightedLines > 0, `${blindLines} blind, ${sightedLines} sighted`);
  ok('nothing held is a fully exposed square',
     [...heldByRoom].every(([num, held]) => {
       const geometry = geometryFor(map.rooms[num]);
       return !geometry || held.every(s => exposureAt(geometry, s.row, s.col).attackers < MAX_ATTACKERS);
     }));
}

// ---------------------------------------------------------------------------
console.log('\nthe model recognises the walls that actually held');
{
  // THE CHECK THAT WOULD CATCH THE MODEL DRIFTING AWAY FROM THE GAME. A change to
  // exposureAt, backCover, the disc, or the boundary-ring exclusion that stopped
  // nominating the squares real characters have survived on would be invisible to every
  // other suite here — they all run on fixtures — and would show up live as a fleet that
  // slowly stops finding walls.
  let offered = 0, missing = [];
  let heldFree = 0, heldCover = 0, heldN = 0;
  let floorFree = 0, floorCover = 0, floorN = 0;
  for (const [num, held] of heldByRoom) {
    const geometry = geometryFor(map.rooms[num]);
    if (!geometry) continue;
    const nominated = new Map(safeSpots(geometry, { limit: Infinity })
      .map(s => [`${s.col},${s.row}`, s]));
    for (const spot of held) {
      const scored = nominated.get(spot.key);
      if (!scored) { missing.push(`${num}:${spot.key}`); continue; }
      offered++; heldN++;
      heldFree += scored.free_shots; heldCover += scored.back_cover;
    }
    // Ordinary floor in the SAME rooms is the baseline. Comparing against a different
    // room would be comparing rooms rather than squares.
    let seed = Number(num) * 7919 + 13;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 200; i++) {
      const r = 1 + ((rnd() * geometry.rows) | 0), c = 1 + ((rnd() * geometry.cols) | 0);
      if (!geometry.walkable(r, c)) continue;
      if (exposureAt(geometry, r, c).our_ground === 0) continue;
      floorN++;
      floorFree += exposureAt(geometry, r, c).free_shots;
      floorCover += nominated.get(`${c},${r}`)?.back_cover ?? 0;
    }
  }
  // Corrected 2026-08-27: the book's held squares were recorded under two earlier
  // definitions (open floor graded by enclosure, then coarse-refused squares) and most of
  // them are not safe walls by the verified one — the red squares in the debug client. The
  // book is EVIDENCE about squares, not membership, so this is reported, not required.
  console.log(`  (held squares also in the safe-wall set: ${offered}; recorded under an older definition and not in it: ${missing.length})`);
  ok('the safe-wall set is one function for the picture and the choice',
     (() => { for (const [num] of heldByRoom) { const g = geometryFor(map.rooms[num]); if (!g) continue;
       const a = new Set(safeWalls(g).map(w => `${w.col},${w.row}`));
       const b = new Set(safeSpots(g, { limit: Infinity }).map(w => `${w.col},${w.row}`));
       if (a.size !== b.size || [...a].some(k => !b.has(k))) return false; } return true; })());
  ok('and there are enough of them for the comparison to mean anything',
     offered > 100 && floorN > 500, `${offered} held, ${floorN} floor`);
  // Measured 2026-08-16 across 37 rooms and 256 squares: 3.24 against 1.49, and 3.46
  // against 0.85. The thresholds are deliberately well inside those, because the book is
  // written by a live fleet and grows between runs — this asserts the SEPARATION, which is
  // the claim, not the day's exact numbers.
  const heldFreeMean = heldFree / heldN, floorFreeMean = floorFree / floorN;
  const heldCoverMean = heldCover / heldN, floorCoverMean = floorCover / floorN;
  ok('a held square offers materially more unanswerable shots than ordinary floor',
     heldFreeMean > floorFreeMean * 1.5,
     `${heldFreeMean.toFixed(2)} vs ${floorFreeMean.toFixed(2)}`);
  ok('and materially more wall at its back',
     heldCoverMean > floorCoverMean * 2,
     `${heldCoverMean.toFixed(2)} vs ${floorCoverMean.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
console.log('\nrouting must not teach the fleet away from the walls');
{
  // THE REGRESSION THIS FILE WAS WRITTEN FOR. `clearanceField` keeps long routes off the
  // walls, which is right for crossing a room and catastrophic if it reaches the tactical
  // questions: a safe wall is a tight square BY DEFINITION, so a preference for open
  // ground is a preference against the best squares in the game.
  const byRoo = new Map();
  attachStepMasks(map, { geometryOf: room => {
    let geometry = byRoo.get(room);
    if (!geometry) { geometry = RoomGeometry.fromJSON(room.roo); byRoo.set(room, geometry); }
    return geometry;
  } });
  const masked = new Map();
  for (const [num, room] of Object.entries(map.rooms))
    if (byRoo.has(room) && byRoo.get(room).hasStepMask) masked.set(num, byRoo.get(room));

  if (!masked.size) {
    skip('the default route to a wall is the untaxed one', 'no baked step masks on this machine');
    skip('the preference never refuses a wall', 'ditto');
    skip('a tight square is not down-ranked out of the safe-spot choice', 'ditto');
  } else {
    let compared = 0, differed = 0, taxed = 0, refusedPlain = 0, refusedTaxed = 0;
    let worstExtra = 0;
    for (const [num, held] of heldByRoom) {
      const geometry = masked.get(num);
      if (!geometry) continue;
      let seed = Number(num) * 104729 + 7;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const floor = [];
      for (let r = 1; r <= geometry.rows; r++) for (let c = 1; c <= geometry.cols; c++)
        if (geometry.walkable(r, c)) floor.push({ r, c });
      for (const spot of held) {
        for (let i = 0; i < 2; i++) {
          const from = floor[(rnd() * floor.length) | 0];
          if (!from) continue;
          // What `world.reach` asks — and it must be the zero-weight answer.
          const plain = geometry.path(from.r, from.c, spot.row, spot.col);
          const explicit = geometry.path(from.r, from.c, spot.row, spot.col, { clearance: 0 });
          const withPref = geometry.path(from.r, from.c, spot.row, spot.col, { clearance: 0.6 });
          if (!plain.found) { refusedPlain++; continue; }
          if (!withPref.found) { refusedTaxed++; continue; }
          compared++;
          if (JSON.stringify(plain.steps) !== JSON.stringify(explicit.steps)) differed++;
          if (withPref.steps.length > plain.steps.length) {
            taxed++;
            worstExtra = Math.max(worstExtra, withPref.steps.length - plain.steps.length);
          }
        }
      }
    }
    ok('there were real walls to route to', compared > 100, `${compared} walks`);
    // The assertion is about the DEFAULT, because the default is what world.reach takes
    // and world.reach is what the safe-spot ranking is denominated in.
    ok('the default route to a held wall is the untaxed one, step for step',
       differed === 0, `${differed} of ${compared} differed`);
    // And the preference, where it IS asked for, may only ever prefer.
    ok('the preference never refuses a wall it would otherwise reach',
       refusedTaxed === 0, `${refusedTaxed} refused`);
    // Stated as evidence rather than as a threshold: this is the size of the distortion
    // that would return if the default were flipped back on, and it is why it is off.
    ok('and it WOULD have lengthened a real share of those walks, which is why it is off ' +
       'by default', taxed > 0,
       `${taxed}/${compared} longer, worst +${worstExtra} steps ` +
       `= ${(worstExtra * 0.5).toFixed(1)} points against a proof bonus of 20`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nthe choice itself still lands on a proven wall');
{
  // End to end through the thing `withdraw()` and every rest path actually call. A pocket
  // is only a trap if you cannot leave it; it is the strongest defensive move in the game
  // if you can, and this asserts the fleet still picks one.
  let asked = 0, provenPicked = 0, tightPicked = 0;
  for (const [num, held] of heldByRoom) {
    const geometry = geometryFor(map.rooms[num]);
    if (!geometry || held.length < 3) continue;
    const target = held[0];
    // Stand a few squares off a wall the fleet has held and ask the real chooser.
    const from = { col: Math.max(2, target.col - 3), row: Math.max(2, target.row - 3) };
    if (!geometry.walkable(from.row, from.col)) continue;
    asked++;
    // The `book` option this used to pass is gone from nearestSafeSpot's signature along
    // with the book itself, so the chooser is asked with geometry alone — which is all it
    // consults now.
    const picked = nearestSafeSpot(geometry, from, {
      within: Math.max(geometry.rows, geometry.cols),
      room: Number(num),
    });
    if (!picked) continue;
    if ((picked.attackers ?? picked.can_reach_you ?? 1) === 0) provenPicked++;
    // A safe wall is a tight square, so the pick should have wall at its back. This is
    // the assertion that goes red if anything ever starts preferring open ground.
    if (picked.back_cover >= 3) tightPicked++;
  }
  ok('the chooser was asked in real rooms', asked > 5, `${asked} rooms`);
  ok('and it lands on a square with wall at its back',
     tightPicked / asked > 0.8, `${tightPicked}/${asked}`);
  // THIS ASSERTION WAS VACUOUS FOR AS LONG AS IT TOOK TO NOTICE. It read
  // `if (picked.proven) provenPicked++` and claimed the chooser "prefers one that has
  // already held where the book has one". `proven` is now unconditionally true for every
  // wall the geometry names — there is no history left to inherit it from — so the counter
  // could not fail, and a test that cannot fail is worse than no test. It now counts what
  // actually matters and what the live proof is about: that the square picked is one
  // NOTHING WITHIN REACH CAN SEE.
  ok('and every square it picks is one nothing within reach can see',
     provenPicked === asked || provenPicked > asked * 0.95,
     `${provenPicked}/${asked} with attackers === 0`);
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
