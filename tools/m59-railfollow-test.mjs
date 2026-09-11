// THE GUARD FOR m59-railfollow.mjs — offline, no map, no socket.
//
//   node tools/m59-railfollow-test.mjs
//
// The central case is the real one, with the real numbers: room 49's r25c17 holds four floors
// and the 2D rule picks a waypoint 2560 units above the body and calls it 304 units away.
import { nearestWaypoint, onSameShelf, advanced, OFF_SHELF_PENALTY } from './m59-railfollow.mjs';
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

// ---- progress ---------------------------------------------------------------------------
ok(advanced(10, 11), 'a higher index on the same shelf is progress');
ok(!advanced(11, 10), 'going backwards is not');
ok(!advanced(10, 10), 'standing still is not');
ok(!advanced(10, 90, { onShelf: false }), 'a huge jump OFF the shelf is not progress — ' +
   'this is the follower that rode 163 waypoints to the wrong place');
ok(advanced(10, 90, { onShelf: true }), 'the same jump on the shelf is');

console.log(`\nm59-railfollow: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
