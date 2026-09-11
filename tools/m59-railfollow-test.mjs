// THE GUARD FOR m59-railfollow.mjs — offline, no map, no socket.
//
//   node tools/m59-railfollow-test.mjs
//
// The central case is the real one, with the real numbers: room 49's r25c17 holds four floors
// and the 2D rule picks a waypoint 2560 units above the body and calls it 304 units away.
import { nearestWaypoint, onSameShelf, advanced, OFF_SHELF_PENALTY,
         rejoinedBehind, REJOIN_BEHIND, distanceToSegment, distanceToRail } from './m59-railfollow.mjs';
import { MAX_STEP_HEIGHT } from './m59-roo.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);

// ---- the step cap is the whole definition of "same shelf" -------------------------------
ok(MAX_STEP_HEIGHT === 384, 'MAX_STEP_HEIGHT is 384 client units');
ok(onSameShelf(1024, 1024), 'the same floor is the same shelf');
ok(onSameShelf(1024, 1024 + MAX_STEP_HEIGHT), 'exactly one step up is still reachable');
ok(onSameShelf(1024, 1024 - MAX_STEP_HEIGHT), 'and exactly one step down');
ok(!onSameShelf(1024, 1024 + MAX_STEP_HEIGHT + 1), 'one unit past the cap is another shelf');
ok(onSameShelf(null, 1024), 'a waypoint with no floor cannot be excluded');
ok(onSameShelf(1024, null), 'and neither can a body whose floor could not be read');

// ---- ROOM 49, r25c17. The measurement this module exists for. --------------------------
{
  // Client units. The body is on the canyon floor; the rail crosses the square 2176 above it,
  // and waypoint 152 sits higher still on the 6400 rim, 304 units away in two dimensions.
  const body = { x: 16448, y: 24896 };
  const rail = [
    { x: 9400, y: 24896, f: 3840 },            // #0  the start, on the body's own shelf
    { x: 16448, y: 24592, f: 6400 },           // #1  304 units away, 2560 ABOVE the body
    { x: 16448, y: 25400, f: 6016 },           // #2  the line itself, 504 away and 2176 above
  ];
  const flat = rail.reduce((b, w, i) => {
    const d = Math.hypot(w.x - body.x, w.y - body.y); return d < b.d ? { d, i } : b;
  }, { d: Infinity, i: -1 });
  eq(flat.i, 1, 'the 2D rule picks the waypoint on the rim');
  eq(Math.round(flat.d), 304, 'and calls it 304 units away');

  const got = nearestWaypoint(rail, body, { floor: 3840 });
  eq(got.i, 0, 'the floor-aware rule picks the only waypoint on the body\'s own shelf');
  eq(Math.round(got.d), 7048, 'and reports the honest distance to it');
  ok(got.onShelf, 'and says the pick is reachable');
  ok(got.floorKnown, 'and that the floor was known');
  ok(flat.i !== got.i, 'THE TWO RULES DISAGREE — which is the whole finding');
}

// ---- degrading, rather than lying ------------------------------------------------------
{
  const rail = [{ x: 0, y: 0, f: 3840 }, { x: 100, y: 0, f: 6400 }];
  const got = nearestWaypoint(rail, { x: 100, y: 0 }, { floor: null });
  eq(got.i, 1, 'with no floor read it falls back to the 2D answer');
  ok(!got.floorKnown, 'and SAYS the floor was not known rather than implying a guard ran');
  ok(got.onShelf, 'a null floor cannot be off-shelf');
}
{
  // Every waypoint out of reach: still answer, but flagged. A follower with no answer stalls,
  // and a stall is indistinguishable from a refusal.
  const rail = [{ x: 0, y: 0, f: 9000 }, { x: 50, y: 0, f: 9000 }];
  const got = nearestWaypoint(rail, { x: 60, y: 0 }, { floor: 1024 });
  eq(got.i, 1, 'the nearest of the unreachable ones is still named');
  ok(!got.onShelf, 'and flagged as off every shelf');
  ok(got.d < OFF_SHELF_PENALTY, 'the reported distance has the penalty stripped back off');
  eq(Math.round(got.d), 10, 'so it is the true distance, not a sentinel');
}
{
  const got = nearestWaypoint([], { x: 0, y: 0 }, { floor: 0 });
  eq(got.i, -1, 'an empty rail names no waypoint');
  ok(got.empty, 'and says so');
}

// ---- ties and ordering -----------------------------------------------------------------
{
  const rail = [{ x: 0, y: 0, f: 100 }, { x: 0, y: 0, f: 100 }];
  eq(nearestWaypoint(rail, { x: 0, y: 0 }, { floor: 100 }).i, 0, 'a tie takes the earlier index');
}
{
  // An on-shelf waypoint always beats an off-shelf one, however much further away it is.
  const rail = [{ x: 0, y: 0, f: 6400 }, { x: 500000, y: 0, f: 3840 }];
  const got = nearestWaypoint(rail, { x: 0, y: 0 }, { floor: 3840 });
  eq(got.i, 1, 'a distant reachable waypoint beats an adjacent unreachable one');
  ok(got.onShelf, 'and is reported reachable');
}

// ---- THE BODY LEFT THE ROOM. Marco, the Badlands, 2026-09-11. -------------------------
{
  const rail = [{ x: 0, y: 0, f: 1664 }, { x: 1000, y: 0, f: 1664 }];
  const got = nearestWaypoint(rail, { x: 0, y: 0 },
                              { floor: 3840, railRoom: 45, bodyRoom: 1 });
  eq(got.i, -1, 'a body in another room is nowhere on this line');
  ok(got.wrongRoom, 'and the answer SAYS so rather than naming a waypoint');
  eq([got.railRoom, got.bodyRoom], [45, 1], 'naming both rooms, so the caller can log which');
  ok(!got.floorKnown, 'a floor measured in the wrong room is not knowledge');
}
{
  // The same room still answers normally — the guard must not fire on the happy path.
  const rail = [{ x: 0, y: 0, f: 1664 }];
  const got = nearestWaypoint(rail, { x: 0, y: 0 }, { floor: 1664, railRoom: 45, bodyRoom: 45 });
  eq(got.i, 0, 'the same room answers normally');
  ok(!got.wrongRoom, 'and does not flag a room problem');
}
{
  // Unknown rooms must not be treated as a mismatch, or every caller that cannot read a room
  // number is refused an answer it could have had.
  const rail = [{ x: 0, y: 0, f: 1664 }];
  ok(!nearestWaypoint(rail, { x: 0, y: 0 }, { railRoom: 45, bodyRoom: null }).wrongRoom,
     'an unknown body room is not a mismatch');
  ok(!nearestWaypoint(rail, { x: 0, y: 0 }, { railRoom: null, bodyRoom: 1 }).wrongRoom,
     'and neither is an undeclared rail room');
}

// ---- progress ---------------------------------------------------------------------------
ok(advanced(10, 11), 'a higher index on the same shelf is progress');
ok(!advanced(11, 10), 'going backwards is not');
ok(!advanced(10, 10), 'standing still is not');
ok(!advanced(10, 90, { onShelf: false }), 'a huge jump OFF the shelf is not progress — ' +
   'this is the follower that rode 163 waypoints to the wrong place');
ok(advanced(10, 90, { onShelf: true }), 'the same jump on the shelf is');

// ---- CHOOSING A RAIL IS A SEGMENT QUESTION. Marco, room 49, 2026-09-11. -----------------
{
  // A dot on a segment: 100 units off a line that has no vertex within 5000.
  const sparse = [{ x: 0, y: 0, f: 6144 }, { x: 10000, y: 0, f: 6144 }];
  eq(Math.round(distanceToSegment({ x: 5000, y: 100 }, sparse[0], sparse[1])), 100,
     'a point beside the middle of a segment is 100 from the LINE');
  eq(Math.round(nearestWaypoint(sparse, { x: 5000, y: 100 }, { floor: 6144 }).d), 5001,
     '...and 5001 from the nearest vertex — which is why vertices cannot choose a rail');

  // Past the end of a segment clamps to the endpoint rather than projecting off it.
  eq(Math.round(distanceToSegment({ x: 12000, y: 0 }, sparse[0], sparse[1])), 2000,
     'beyond the end, the distance is to the endpoint');
  eq(Math.round(distanceToSegment({ x: -500, y: 0 }, sparse[0], sparse[1])), 500,
     'and before the start, to the start');
  eq(distanceToSegment({ x: 5, y: 0 }, { x: 3, y: 0, f: 1 }, { x: 3, y: 0, f: 1 }), 2,
     'a degenerate zero-length segment is just the point');

  // THE REAL CHOICE. Marco at r22c21 on the 6144 rim: dense climb rail vs sparse rim rail.
  const body = { x: 20 * 1024 + 512, y: 21 * 1024 + 512 };     // r22c21 in client units
  const rim = [{ x: 20 * 1024 + 512, y: 1 * 1024 + 512, f: 6144 },
               { x: 20 * 1024 + 512, y: 25 * 1024 + 512, f: 6144 }];   // the long leg 2
  const climb = [];
  for (let k = 0; k < 163; k++)                        // dense, and 3 squares to the west
    climb.push({ x: 17 * 1024 + 512, y: (k % 27) * 1024 + 512, f: 6016 });

  const byVertex = [['rim', nearestWaypoint(rim, body, { floor: 6144 }).d],
                    ['climb', nearestWaypoint(climb, body, { floor: 6144 }).d]]
                   .sort((a, b) => a[1] - b[1])[0][0];
  const bySegment = [['rim', distanceToRail(rim, body, { floor: 6144 }).d],
                     ['climb', distanceToRail(climb, body, { floor: 6144 }).d]]
                    .sort((a, b) => a[1] - b[1])[0][0];
  eq(byVertex, 'climb', 'nearest VERTEX picks the dense rail — the bug');
  eq(bySegment, 'rim', 'nearest SEGMENT picks the line the body is standing on — the fix');
  ok(distanceToRail(rim, body, { floor: 6144 }).d === 0,
     'and it correctly says the body is ON the rim line, distance 0');
}
{
  // A segment with one end on another shelf is not a segment this body may ride.
  const ledge = [{ x: 0, y: 0, f: 6144 }, { x: 10000, y: 0, f: 1024 }];
  const r = distanceToRail(ledge, { x: 5000, y: 0 }, { floor: 6144 });
  ok(!r.onShelf, 'a segment that leaves the shelf halfway is flagged off-shelf');
  ok(r.d < OFF_SHELF_PENALTY, 'and the reported distance still has the penalty stripped off');
  eq(distanceToRail([], { x: 0, y: 0 }, { floor: 0 }).empty, true, 'an empty rail is empty');
  eq(Math.round(distanceToRail([{ x: 300, y: 0, f: 1 }], { x: 0, y: 0 }, { floor: 1 }).d), 300,
     'a one-waypoint rail falls back to the point distance');
}

// ---- the high-water mark, and the run it aborted -----------------------------------------
{
  // Marco, room 49, 2026-09-11: mark at 137 on the rim, rejoined at 3 on the canyon floor.
  const r = rejoinedBehind(137, 3);
  ok(r.reset, 'rejoining 134 waypoints behind resets the progress measure');
  eq([r.from, r.to, r.behindBy], [137, 3, 134], 'and reports the jump so it can be logged');

  ok(!rejoinedBehind(137, 130).reset, 'wobbling 7 waypoints back is not a rejoin');
  ok(!rejoinedBehind(137, 117).reset, 'exactly the threshold is still a wobble');
  ok(rejoinedBehind(137, 116).reset, 'one past it is a rejoin');
  ok(!rejoinedBehind(3, 51).reset, 'moving FORWARD is never a rejoin');
  ok(!rejoinedBehind(-1, 0).reset, 'the initial unset mark does not trigger one');
}
{
  // Bounded: a body falling back to the same place for ever IS stuck, and the detector must
  // still be able to say so rather than resetting itself indefinitely.
  const r = rejoinedBehind(137, 3, { rejoins: 3, maxRejoins: 3 });
  ok(!r.reset, 'the budget is finite — a repeated fall is a real stall');
  ok(r.exhausted, 'and it says the budget is what stopped it, not the distance');
  ok(rejoinedBehind(137, 3, { rejoins: 2, maxRejoins: 3 }).reset, 'the last rejoin is allowed');
}
{
  ok(!rejoinedBehind(null, 3).reset, 'a missing mark cannot trigger a reset');
  ok(!rejoinedBehind(137, undefined).reset, 'nor a missing position');
  ok(REJOIN_BEHIND === 20, 'the default gap is 20 waypoints, comfortably over a 12-waypoint leg');
}

console.log(`\nm59-railfollow: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
