#!/usr/bin/env node
// DOES THE EXIT REPORT EVER CALL A DOOR WALKABLE THAT IS ONLY REACHABLE BY FALLING?
//
//   node tools/m59-exitreport-test.mjs
//
// Offline. No map, no bake, no broker, no socket — every fixture below is built here, so
// this suite says the same thing on a fresh clone as it does on the machine that runs the
// fleet.
//
// WHAT IT PINS, AND WHY EACH ONE IS HERE. The report exists to keep two honest models from
// being read as one:
//
//   * `reachableFrom` floods with `moverStepLands`, ONE SQUARE AT A TIME. A fall of three
//     columns is not a step, so a door across one is unreachable to it — correctly.
//   * the bake's anchor routes embed declared falls as `(dr,dc)` and cross that ground.
//
// Collapsing those two is the whole Ukgoth argument: KNOWN_TRAPS[599] says the north exit
// "walks for ever", substrate/m59-falljumps.json says the operator has made that crossing,
// and the transit ledgers carry 313 arrivals on the far side. All three are true. So the
// assertions that matter here are the ones about the SEAM: a door that only a fall reaches
// must never be reported as walkable, must never be reported as absent, and must be named
// as needing the fall.
//
// The last case is the real 599 shape, kept as a fixture rather than a memory. It is the
// only room where getting this wrong has cost a character.
import { jumpsIn, fallWords, roomReport, oneWayRooms } from './m59-exitreport.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

// ------------------------------------------------------------------ the fall notation
//
// `replay` in m59-routebake.mjs spells an ordinary step as a direction letter and a fall as
// `(dr,dc)`, because a fall is a move of more than one square and has no direction.
console.log('\nreading a fall out of a baked route string');
ok('a plain walk carries no fall', jumpsIn('ccccdwwwccc').length === 0);
ok('the Ukgoth token is found and read', (() => {
  const j = jumpsIn('ccsbbsbccccc(0,-3)dddadaadad');
  return j.length === 1 && j[0].dr === 0 && j[0].dc === -3;
})());
ok('two falls in one route are two falls',
   jumpsIn('aa(1,2)bb(-3,-4)cc').length === 2);
ok('a malformed token is not a fall', jumpsIn('aa(1,x)bb').length === 0);
ok('an empty or absent path is not a fall',
   jumpsIn('').length === 0 && jumpsIn(null).length === 0 && jumpsIn(undefined).length === 0);

// A DELTA OF ZERO ON AN AXIS IS NOT A DIRECTION. The first version printed "0 rows north"
// for the Ukgoth fall, which reads as a claim about a movement that does not happen.
console.log('\nsaying a fall in words');
ok('a purely sideways fall says nothing about rows', fallWords({ dr: 0, dc: -3 }) === '3 cols west');
ok('a purely north-south fall says nothing about columns',
   fallWords({ dr: -2, dc: 0 }) === '2 rows north');
ok('both axes are joined, not comma-spliced',
   fallWords({ dr: 2, dc: 2 }) === '2 rows south and 2 cols east');
ok('one square is singular', fallWords({ dr: 1, dc: 0 }) === '1 row south');
ok('a fall that moves nothing says so rather than printing an empty string',
   fallWords({ dr: 0, dc: 0 }) === 'in place');

// ------------------------------------------------------------------ the fixture world
//
// Room 700 is Ukgoth's shape with the names filed off: three doors, and the north one is
// across a fall from the east one. Room 701 is an ordinary room where everything walks.
const NORTH = { kind: 'edge', dir: 'north', to: 2, row: 1, col: 27, region: 3, from_body: true };
const EAST = { kind: 'edge', dir: 'east', to: 598, row: 1, col: 66, region: 3, from_body: true };
const SOUTH = { kind: 'edge', dir: 'south', to: 589, row: 71, col: 2, region: 1, from_body: true };

const map = {
  geometryManifestSha256: 'fixture',
  rooms: {
    700: { num: 700, name: 'A room with a cliff in it', rows: 71, cols: 66, edgeExits: [] },
    // Three neighbours, three different landing squares. 598 lands near the east door,
    // 589 lands in the southern half, and 2 lands on the north door itself.
    598: { num: 598, name: 'Uphill', rows: 65, cols: 42,
           edgeExits: [{ leave: 1, leaveName: 'south', to: 700, arriveRow: 4, arriveCol: 63 }] },
    589: { num: 589, name: 'Downhill', rows: 50, cols: 50,
           edgeExits: [{ leave: 2, leaveName: 'north', to: 700, arriveRow: 67, arriveCol: 3 }] },
    2: { num: 2, name: 'Over the cliff', rows: 25, cols: 44,
         edgeExits: [{ leave: 3, leaveName: 'west', to: 700, arriveRow: 2, arriveCol: 27 }],
         // Three doors that all drop you on the same square are ONE arrival.
         goExits: [{ row: 5, col: 44, to: 701, arriveRow: 15, arriveCol: 17 },
                   { row: 4, col: 44, to: 701, arriveRow: 15, arriveCol: 17 },
                   { row: 3, col: 44, to: 701, arriveRow: 15, arriveCol: 17 }] },
    701: { num: 701, name: 'An ordinary room', rows: 20, cols: 20, edgeExits: [] },
    // Nothing anywhere in this graph has an exit into 702 — the Icky Cave's shape.
    702: { num: 702, name: 'A cave you can only be put into', rows: 60, cols: 60, edgeExits: [] },
  },
};

const key = a => `${a.row},${a.col}`;
const table = {
  format: 'm59-routes/1',
  rooms: {
    700: {
      room: 700, rows: 71, cols: 66, regions: 12, main_region: 4,
      main_region_squares: 4472, walkable: 4686,
      anchors: [SOUTH, EAST, NORTH],
      routes: {
        // The fall is on the leg that reaches the north door, and only there.
        [`${key(EAST)}>${key(NORTH)}`]: 'cccdwwccccc(0,-3)dddadaa',
        [`${key(EAST)}>${key(SOUTH)}`]: 'ccccwwwwcc',
        [`${key(NORTH)}>${key(SOUTH)}`]: 'sssscccc',
        [`${key(NORTH)}>${key(EAST)}`]: 'ssee(2,2)ee',
      },
      pivots: { [`${key(EAST)}>${key(NORTH)}`]: { squares: [], unverified: 1 } },
      gutters: [{ row: 67, col: 15, squares: 60, reaches: [key(SOUTH)] },
                { row: 49, col: 45, squares: null, reaches: ['67,15'] }],
      blink: { row: 42, col: 14, squares: 4237, reaches: [key(NORTH), key(EAST), key(SOUTH)] },
    },
    701: {
      room: 701, rows: 20, cols: 20, regions: 1, main_region: 0,
      main_region_squares: 300, walkable: 300,
      anchors: [{ kind: 'edge', dir: 'north', to: 2, row: 1, col: 5, region: 0, from_body: true },
                { kind: 'edge', dir: 'south', to: 700, row: 19, col: 5, region: 0, from_body: true }],
      routes: {}, gutters: [],
    },
  },
};

// The mover's own answer, faked to the measured shape of 599: from the 598 landing you can
// walk to the east and south doors and NOT the north one; from the 589 landing, nothing but
// south; from the north door itself, everywhere.
const WALKABLE_FROM = {
  '4,63': [598, 589],
  '67,3': [589],
  '2,27': [2, 598, 589],
  // Where the declared fall puts you: no door at all from down there, but the stone is
  // reachable. That asymmetry is the whole point of asking directed.
  '38,19': [],
};
// Shaped like `reachableFrom`: a SET of `row,col` keys the mover can step to from there,
// or null when the square is not standable. Directed on purpose — the fall's landing
// reaches the stone and the arrival square does not.
const fakeReachFrom = (m, roomNum, row, col) => {
  const list = WALKABLE_FROM[`${row},${col}`];
  if (!list) return null;
  const anchors = table.rooms[roomNum]?.anchors ?? [];
  const keys = anchors.filter(a => list.includes(Number(a.to))).map(a => `${a.row},${a.col}`);
  return new Set([...keys, ...(EXTRA_REACH[`${row},${col}`] ?? []), `${row},${col}`]);
};
// Squares other than anchors that a given landing can reach. `4,63` can walk to the fall's
// take-off; the fall's landing `38,19` can walk to the stone; the arrival cannot.
const EXTRA_REACH = {
  '4,63': ['36,16'],
  '38,19': ['45,32'],
};
// The declared falls, injected rather than read off disk: a suite that reads this machine's
// substrate says something different on a fresh clone, which is the opposite of a test.
// Shaped like substrate/m59-falljumps.json's entries.
const fakeFalls = () => ([
  { room: 700, from: { row: 36, col: 16 }, to: { row: 38, col: 19 }, kind: 'fall',
    observed_by: 'operator, 2026-09-03', part_of_cycle: false },
]);

console.log('\nwhere a body lands coming in, and what it can take from there');
const rep = roomReport(map, table, 700, { reachFrom: fakeReachFrom, falls: fakeFalls });
ok('every neighbour that leads here is listed', rep.inbound.length === 3);
ok('three doors onto one landing square are ONE arrival, not three',
   rep.inbound.filter(a => a.from === 2).length === 1);
ok('an arrival is the square you appear on, never the anchor you leave by',
   rep.inbound.find(a => a.from === 598).row === 4 &&
   rep.inbound.find(a => a.from === 598).col === 63);

const from598 = rep.inbound.find(a => a.from === 598);
const from589 = rep.inbound.find(a => a.from === 589);
ok('the door across the fall is NOT reported as walkable from the 598 landing',
   !from598.canTake.some(x => x.to === 2));
ok('and it is reported as explicitly unreachable rather than left out',
   from598.cannotTake.some(x => x.to === 2));
ok('the southern landing can walk to nothing but the door it came in by',
   from589.canTake.length === 1 && from589.canTake[0].to === 589);

console.log('\nthe seam: a door only a FALL reaches must be named as one');
const northRow = rep.reach.find(r => r.from.to === 598 && r.to.to === 2);
ok('the bake still has a route to it', northRow.hasRoute);
ok('and the route is marked as containing a fall', northRow.jumps.length === 1);
ok('the fall is the one the bake actually stored',
   northRow.jumps[0].dr === 0 && northRow.jumps[0].dc === -3);
ok('an unverified pivot leg is carried through, not rounded off',
   northRow.unverifiedPivots === 1);
ok('a leg with no fall is not marked as having one',
   rep.reach.find(r => r.from.to === 598 && r.to.to === 589).jumps.length === 0);

// The asymmetry is the point. north->east falls; east->north falls; and they are different
// falls, because a fall is one-way and the way back is a different piece of ground.
const backRow = rep.reach.find(r => r.from.to === 2 && r.to.to === 598);
ok('the return leg is a DIFFERENT fall, not the same one reversed',
   backRow.jumps.length === 1 && backRow.jumps[0].dr === 2 && backRow.jumps[0].dc === 2);
ok('the matrix has an entry for every ordered pair of doors and no self-pairs',
   rep.reach.length === 6 && !rep.reach.some(r => r.from === r.to));

console.log('\nthe rest of the room');
ok('the gutters come through with what they can still reach',
   rep.gutters.length === 2 && rep.gutters[0].reaches[0] === '71,2');
ok('the blink point is reported separately from walking',
   rep.blink && rep.blink.row === 42 && rep.blink.col === 14);
ok('a room the map does not have is an error, not an empty report',
   roomReport(map, table, 4242, { reachFrom: fakeReachFrom, falls: fakeFalls }).error);
ok('a room with no bake says so instead of answering from nothing', (() => {
  const bare = roomReport({ rooms: { 9: { num: 9, name: 'unbaked', rows: 5, cols: 5 } } },
                          { rooms: {} }, 9, { reachFrom: fakeReachFrom, falls: fakeFalls });
  return bare.baked === false && bare.anchors.length === 0;
})());

// A ROOM NOTHING ARRIVES IN IS A REAL ANSWER. Room 27, the Icky Cave, has no inbound exit
// in the world graph at all — you get in by walking onto a trigger in room 587 — and a
// report that printed an empty list without saying so would read as a bug in the bake.
ok('a room nothing in the world graph arrives in reports an empty inbound list',
   roomReport(map, table, 702, { reachFrom: fakeReachFrom, falls: fakeFalls }).inbound.length === 0);

// ------------------------------------------------------------------ the point target
//
// ARRIVING IN THE ROOM IS NOT ARRIVING AT THE STONE. A mana node is judged by a 5x5 BOX
// around ONE SQUARE (mananode.kod:177), so "can I get into 589" and "can I get to r45c32"
// are different questions and the second is the one a node run actually has. Measured in
// room 589 the same night: from BOTH entrances the stone is unreachable by walking, and
// from the Ukgoth side a declared fall bridges it. Nothing printed that before.
console.log('\nthe square, not just the room');
{
  const goal = { row: 45, col: 32 };
  const withGoal = roomReport(map, table, 700, { reachFrom: fakeReachFrom, falls: fakeFalls, goal });
  const in598 = withGoal.inbound.find(a => a.from === 598);
  const in589 = withGoal.inbound.find(a => a.from === 589);
  ok('a goal the step flood cannot reach is reported as unreachable, not as absent',
     in598.reachesGoal === false);
  ok('and the declared fall that DOES bridge it is named',
     in598.goalViaFall && in598.goalViaFall.from.row === 36 && in598.goalViaFall.from.col === 16);
  ok('an arrival that cannot even reach the take-off gets no fall offered',
     in589.reachesGoal === false && in589.goalViaFall === null);
  ok('with no --to asked for, the goal fields stay null rather than defaulting to a verdict',
     rep.inbound.every(a => a.reachesGoal === null && a.goalViaFall == null));

  // HOW FAR OUT, not just "no". Measured in room 27 the same night: the Icky Cave stone at
  // r23c53 is unreachable from every entrance and the closest the mover gets is r19c57 —
  // FOUR squares, against a meld box of two. "Unreachable by 4" is a movement defect worth
  // chasing; "unreachable by 40" is a different room. Only one of those is worth a night.
  const far = { row: 23, col: 53 };
  const withFar = roomReport(map, table, 700,
                             { reachFrom: fakeReachFrom, falls: fakeFalls, goal: far });
  const near = withFar.inbound.find(a => a.from === 589).nearestToGoal;
  ok('an unreachable goal reports the closest square the mover DOES get to',
     near && Number.isInteger(near.row) && Number.isInteger(near.col));
  ok('and the distance is Chebyshev, the metric the server range-tests with',
     near.away === Math.max(Math.abs(near.row - far.row), Math.abs(near.col - far.col)));
  ok('a goal that IS reachable gets no nearest-square consolation prize',
     withFar.inbound.every(a => a.reachesGoal !== true || a.nearestToGoal === null));
}

// A TARGET IS OFTEN A BOX AND NOT A POINT, and the square a thing STANDS ON is frequently
// not standable — because the thing is standing on it. Measured across all seven mana
// stones the same night: asked as a point, room 750's stone is unreachable; asked as the
// box the game actually tests (2 per axis, mananode.kod:177) it is reachable, and the
// skill's own table had it filed under "needs new jumping mechanics".
console.log('\na box target is a different question from a point target');
{
  const asPoint = roomReport(map, table, 700,
    { reachFrom: fakeReachFrom, falls: fakeFalls, goal: { row: 45, col: 32 } });
  const asBox = roomReport(map, table, 700,
    { reachFrom: fakeReachFrom, falls: fakeFalls, goal: { row: 34, col: 15 }, box: 2 });
  ok('a square the mover cannot stand on is out of reach as a POINT',
     asPoint.inbound.find(a => a.from === 598).reachesGoal === false);
  ok('and a BOX around it is reachable when any square inside the box is',
     asBox.inbound.find(a => a.from === 598).reachesGoal === true);
  ok('box widens and never narrows: what a point reaches, a box reaches too', (() => {
    const at = r => r.inbound.find(a => a.from === 598).reachesGoal;
    const p = roomReport(map, table, 700,
      { reachFrom: fakeReachFrom, falls: fakeFalls, goal: { row: 36, col: 16 } });
    const b = roomReport(map, table, 700,
      { reachFrom: fakeReachFrom, falls: fakeFalls, goal: { row: 36, col: 16 }, box: 2 });
    return at(p) === true && at(b) === true;
  })());
}

console.log('\nthe world sweep');
const oneWay = oneWayRooms(map, table, {
  reachVia: (t, roomNum, from, to) => {
    if (roomNum !== 700) return 'walk';
    // South reaches nothing by walking; everything else does.
    if (from.to === 589) return 'blink';
    return 'walk';
  },
});
ok('a room whose doors are all mutually walkable is not listed',
   !oneWay.some(r => r.room === 701));
ok('a room with a one-way pair is listed with the count',
   oneWay.some(r => r.room === 700 && r.no === 2 && r.pairs === 6));
ok('and the falls in it are counted', oneWay.find(r => r.room === 700).jumps === 2);
ok('the gutter count rides along, because that is where a missed fall puts you',
   oneWay.find(r => r.room === 700).gutters === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
