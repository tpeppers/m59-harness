// THE GUARD FOR m59-railfollow.mjs — offline, no map, no socket.
//
//   node tools/m59-railfollow-test.mjs
//
// The central case is the real one, with the real numbers: room 49's r25c17 holds four floors
// and the 2D rule picks a waypoint 2560 units above the body and calls it 304 units away.
import { nearestWaypoint, onSameShelf, advanced, OFF_SHELF_PENALTY,
         rejoinedBehind, REJOIN_BEHIND, distanceToSegment, distanceToRail, aimAhead, AIM_BUDGET, aimPoint, budgetForTimeout, aimOrBoard } from './m59-railfollow.mjs';
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

// ---- A STRIDE IN WAYPOINTS IS MEANINGLESS ON A SPARSE RAIL. Marco, room 49. --------------
{
  // The real rim rail: 6 waypoints, one leg 24 squares long.
  const rim = [
    { x: 20544, y:    64, f: 6144 },   // 0  r1c21
    { x: 20544, y:  1280, f: 6144 },   // 1  r2c21
    { x: 20544, y:  1642, f: 6144 },   // 2  r2c21
    { x: 20544, y: 25962, f: 6144 },   // 3  r26c21   <- 24320 units from wp 2
    { x: 20544, y: 26415, f: 6016 },   // 4  r26c21
    { x: 19520, y: 27136, f: 6016 },   // 5  r27c20
  ];
  // Standing on segment 2, nearest vertex 3. A stride of 12 waypoints resolves to the last one.
  eq(Math.min(3 + 12, rim.length - 1), 5, 'stride 12 on a 6-waypoint rail means "aim at the end"');
  const aim = aimAhead(rim, 2);
  eq(aim.i, 3, 'the distance budget aims at the NEXT waypoint when the segment is long');
  eq(aim.spanned, 1, 'spanning exactly one waypoint');
  ok(aim.dist > 3 * 1024, 'even though that one leg already exceeds the budget');
  ok(!aim.atEnd, 'and it is not pretending to be at the end of the rail');

  // Near the end the short legs let it span more than one.
  const tail = aimAhead(rim, 3);
  ok(tail.i > 3, 'from waypoint 3 it still advances');
  ok(tail.i <= 5, 'and never past the end');
  eq(aimAhead(rim, 5).atEnd, true, 'from the last waypoint it reports the end');
  eq(aimAhead(rim, 99).i, 5, 'an index past the end clamps to the end');
  eq(aimAhead(rim, -4).i >= 1, true, 'and a negative one clamps to the start, then advances');
}
{
  // A DENSE rail must still stride many waypoints, or a 650-waypoint rail becomes 650 legs.
  const dense = [];
  for (let k = 0; k < 200; k++) dense.push({ x: k * 64, y: 0, f: 1024 });
  const aim = aimAhead(dense, 0);
  eq(aim.i, 48, 'on 64-unit legs the budget spans 48 waypoints');
  ok(aim.dist <= 3 * 1024, 'without exceeding the budget');
  ok(aimAhead(dense, 0, { budget: 1024 }).i === 16, 'and the budget is honoured when changed');
}
{
  eq(aimAhead([], 0).i, -1, 'an empty rail aims nowhere');
  eq(aimAhead([{ x: 0, y: 0, f: 1 }], 0).atEnd, true, 'a one-waypoint rail is already at its end');
}

// ---- AIM AT A POINT ON THE LINE. "ran out of steps", Marco, 2026-09-11. -----------------
{
  // The rim rail again. Body at r22c21 on the long segment; wp 3 is 3946 units further south.
  const rim = [
    { x: 20544, y:    64, f: 6144 },
    { x: 20544, y:  1280, f: 6144 },
    { x: 20544, y:  1642, f: 6144 },
    { x: 20544, y: 25962, f: 6144 },
    { x: 20544, y: 26415, f: 6016 },
    { x: 19520, y: 27136, f: 6016 },
  ];
  const body = { x: 20544, y: 22016 };

  // What the old aim asked for, and why 60 steps could not do it.
  const toWp3 = Math.hypot(rim[3].x - body.x, rim[3].y - body.y);
  eq(Math.round(toWp3), 3946, 'the next waypoint is 3946 units away');
  ok(Math.ceil(toWp3 / 64) > 60, `which needs ${Math.ceil(toWp3 / 64)} steps against a budget of 60`);

  const aim = aimPoint(rim, body, { floor: 6144 });
  eq(aim.dist, 3 * 1024, 'the aim point is exactly one budget along the line');
  eq(aim.x, 20544, 'still on the rail column');
  ok(aim.y > body.y && aim.y < rim[3].y, 'between the body and the next waypoint');
  eq(aim.stepsNeeded, 48, 'and it says how many steps it needs, so the caller stops guessing');
  ok(!aim.atEnd, 'not the end of the rail');
  eq(aim.i, 2, 'and it names the segment it lies on');

  // Short remaining distance: it clamps to the final waypoint rather than overshooting.
  const nearEnd = aimPoint(rim, { x: 19600, y: 27000 }, { floor: 6016 });
  ok(nearEnd.atEnd, 'close to the end, it reports the end');
  eq([nearEnd.x, nearEnd.y], [19520, 27136], 'and aims exactly at the last waypoint');
}
{
  // A dense rail gets the same treatment and the same budget — one leg, not 48 legs.
  const dense = [];
  for (let k = 0; k < 200; k++) dense.push({ x: k * 64, y: 0, f: 1024 });
  const aim = aimPoint(dense, { x: 0, y: 0 }, { floor: 1024 });
  eq(aim.dist, 3 * 1024, 'the budget is the budget regardless of sampling density');
  eq(aim.x, 3072, 'and the point is 3072 units along');
  eq(aim.stepsNeeded, 48, 'needing 48 steps');
}
{
  ok(aimPoint([], { x: 0, y: 0 }) === null, 'an empty rail has no aim point');
  const one = aimPoint([{ x: 500, y: 0, f: 1 }], { x: 0, y: 0 }, { floor: 1 });
  eq([one.x, one.y], [500, 0], 'a one-waypoint rail aims at that waypoint');
  ok(one.atEnd, 'and reports the end');
  // A body off the line still gets an aim ON it, which is the point of projecting.
  const off = aimPoint([{ x: 0, y: 0, f: 1 }, { x: 10000, y: 0, f: 1 }], { x: 5000, y: 900 },
                       { floor: 1, budget: 1024 });
  eq(off.y, 0, 'the aim lands on the line, not beside it');
  eq(off.x, 6024, 'one budget along from the projection');
}

// ---- A LEG MUST FIT THE TIMEOUT. The 60s ceiling, measured. -----------------------------
{
  // The live prod broker caps a fine walk at keeperAction's 60s default and carries no raised
  // allowance at all, so this is the ceiling to plan inside.
  const b = budgetForTimeout(60_000);
  ok(b < 3 * 1024, `a 60s leg budget (${b}u) is under the 3072u that aborted six times`);
  ok(b >= 1024, 'but still at least a square, or the follower takes a hundred legs');
  ok(budgetForTimeout(5 * 60_000) > b, 'a five-minute allowance buys a longer leg');
  eq(budgetForTimeout(0), 64, 'a zero timeout still yields one step rather than zero');
  ok(budgetForTimeout(60_000, { safety: 1 }) > budgetForTimeout(60_000, { safety: 0.4 }),
     'the safety margin is what leaves room for a fan feeling its way round something');

  // And the measured pair: 768 completed, 3072 aborted. The budget must admit the first.
  ok(768 <= budgetForTimeout(60_000), '768u — the leg length that completed — fits the budget');
}

// ---- BOARD BEFORE FOLLOWING. The canyon oscillation, 2026-09-12. ------------------------
{
  const line = [{ x: 0, y: 0, f: 6144 }, { x: 0, y: 20000, f: 6144 }];   // a long north-south line

  // On the line: follow, and the aim advances along it.
  const on = aimOrBoard(line, { x: 0, y: 5000 }, { floor: 6144, budget: 1024 });
  eq(on.mode, 'follow', 'a body on the line follows it');
  eq([on.x, on.y], [0, 6024], 'advancing one budget along');

  // Slightly off: still follow — a small offset is not worth a whole leg to correct.
  const near = aimOrBoard(line, { x: 200, y: 5000 }, { floor: 6144, budget: 1024 });
  eq(near.mode, 'follow', '200 units off a 1024 budget still follows');

  // Far off: board. This is the canyon case — 820 units off with a 384 budget.
  const far = aimOrBoard(line, { x: 820, y: 5000 }, { floor: 6144, budget: 384 });
  eq(far.mode, 'board', '820 units off a 384 budget boards instead');
  eq([far.x, far.y], [0, 5000], 'aiming at the projection — straight at the line, not along it');
  eq(far.dist, 820, 'spending the whole leg on the 820 units that matter');
  eq(far.offLine, 820, 'and reporting how far off it was, so a log can show the mode flipping');

  // The threshold is a fraction of the budget, because "far" is only meaningful per leg.
  eq(aimOrBoard(line, { x: 500, y: 5000 }, { floor: 6144, budget: 384 }).mode, 'board',
     'the same 500u offset boards on a short budget');
  eq(aimOrBoard(line, { x: 500, y: 5000 }, { floor: 6144, budget: 3072 }).mode, 'follow',
     '...and follows on a long one');
  ok(aimOrBoard(line, { x: 820, y: 5000 }, { floor: 6144, budget: 384, boardWhen: 5 }).mode === 'follow',
     'and the threshold is tunable');
  ok(aimOrBoard([], { x: 0, y: 0 }) === null, 'an empty rail still has no aim');
}

// ---- THE CHORD IS NOT THE ARC. A winding rail bounds the leg, not the timeout. -----------
{
  // A straight rail: the budget binds, as before.
  const straight = [];
  for (let k = 0; k < 200; k++) straight.push({ x: k * 64, y: 0, f: 1 });
  const a = aimPoint(straight, { x: 0, y: 0 }, { floor: 1, budget: 3072 });
  eq(a.bound, 'budget', 'on a straight rail the budget is what stops the aim');
  eq(a.dist, 3072, 'and it spends all of it');

  // A rail that turns a hard corner: the aim must NOT cut across it.
  const corner = [{ x: 0, y: 0, f: 1 }];
  for (let k = 1; k <= 40; k++) corner.push({ x: k * 64, y: 0, f: 1 });       // east 2560u
  for (let k = 1; k <= 40; k++) corner.push({ x: 2560, y: k * 64, f: 1 });    // then south 2560u
  const c = aimPoint(corner, { x: 0, y: 0 }, { floor: 1, budget: 5120 });
  eq(c.bound, 'straightness', 'a corner stops the aim before the budget does');
  ok(c.dist <= 2560 + 256, 'the aim stays on the straight run, not past the corner');
  ok(c.y <= 256, 'and it is at most one tolerance past the corner, not across it');
  ok(c.dist > 1024, 'while still being a useful leg, not one waypoint');

  // Tighten the tolerance and the aim shortens; loosen it and it lengthens.
  const tight = aimPoint(corner, { x: 0, y: 0 }, { floor: 1, budget: 5120, maxDeviation: 16 });
  const loose = aimPoint(corner, { x: 0, y: 0 }, { floor: 1, budget: 5120, maxDeviation: 4096 });
  ok(tight.dist <= c.dist, 'a tighter deviation bound never lengthens the aim');
  ok(loose.dist >= c.dist, 'and a looser one never shortens it');
  ok(['budget', 'end'].includes(loose.bound),
     'with a huge tolerance straightness stops binding — here the rail simply runs out');
}
{
  // A zig-zag so sharp that no chord tracks it: the aim falls back to the next waypoint, because
  // standing still is not an option and one waypoint is one validated lattice step.
  const zig = [{ x: 0, y: 0, f: 1 }];
  for (let k = 1; k <= 20; k++) zig.push({ x: (k % 2) * 64, y: k * 64, f: 1 });
  const z = aimPoint(zig, { x: 0, y: 0 }, { floor: 1, budget: 4096, maxDeviation: 8 });
  ok(z !== null, 'a rail nothing can chord still yields an aim');
  ok(z.dist > 0, 'and it is not the point we are standing on');
  ok(['straightness', 'next-waypoint'].includes(z.bound), 'reporting which bound stopped it');
}
{
  // The bound is REPORTED, so a log can show which constraint is actually in play — the whole
  // reason the 5400-unit budget looked reasonable for six runs.
  const straight = [{ x: 0, y: 0, f: 1 }, { x: 10000, y: 0, f: 1 }];
  ok(aimPoint(straight, { x: 0, y: 0 }, { floor: 1, budget: 1024 }).bound === 'budget',
     'and it names the budget when the budget binds');
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
