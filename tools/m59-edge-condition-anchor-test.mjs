// A WALK TO ONE EXIT OF A SPLIT BOUNDARY NEVER BORROWS THE OTHER EXIT'S ANCHOR. Offline: the baked map, the baked
// route table and the socketless fixture client; opens no socket and touches no roster.
//
//   node tools/m59-edge-condition-anchor-test.mjs
//
// Ko'catan, 2026-10-27. 2115 (Outside the Guard Tower) declares two east exits split by the body's row
// (ka5.kod: [LEAVE_EAST, RID_KB4, 39, 1, ROTATE_NONE, ROW_IS_LESS_THAN, 20] and [LEAVE_EAST, RID_KB5, 16, 1,
// ROTATE_NONE, ROW_IS_GREATER_THAN, 20]; room.kod StandardLeaveDir tests Send(what,@getrow) -- the coarse square row
// the body stands on -- against 20). row > 20 is 2125, the dragonfly farm; row < 20 is 2124, kriipa, level 160,
// outside the farm's confinement. The bake, World.exits() and the exit walker all honoured that. planRailDeparture
// (m59-pocket-rails.mjs) did not: for a goal on the boundary column it lent the goal the anchor of WHICHEVER exit sat
// in that column, and the only anchor in column 63 is 2124's r3c63 (2125's is r26c62, one column in). So a walk
// toward a 2125 stage such as r26c63 departed along the baked rail to the 2124 doorway, and keepers logged
//   [edge] t10 refused a step from 2115 r3c64 into 2124: outside the confinement
// This pins the condition on every layer a walk from 2115 to 2125 passes through.
import { bastionHarness } from './fixtures/bastion-fallback-client.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${name}${detail === undefined ? '' : ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); }
};

const h = await bastionHarness();
const { selectedEdgeAt, edgeConditionAllows } = await h.imp('m59-map.mjs');
const routes = await h.imp('m59-routes.mjs'), { activeRoutes, anchorFor } = routes;
const { planRailDeparture } = await h.imp('m59-pocket-rails.mjs');
const { withBodyCommand } = await h.imp('m59-body-command.mjs');
const table = activeRoutes();
const r2115 = h.map.rooms[2115], r2125 = h.map.rooms[2125];
const sq = p => `r${p.row}c${p.col}`;
const fineSquare = p => ({ row: Math.floor(p.y / 64), col: Math.floor(p.x / 64) });
const east2115 = row => selectedEdgeAt(r2115, 'east', { row, col: r2115.cols })?.to ?? null;

ok(r2115?.cols === 63 && r2115?.rows === 52 && r2125, 'the baked map carries 2115 (52x63) and 2125');
ok(routes.attachedMapRoom?.(2115) === r2115, 'the route table is attached to the same map the fixtures walk on');

// 1. THE SERVER'S RULE, AS THE MAP STATES IT. Row 20 itself satisfies neither condition and bumps.
{
  const wrong = [];
  for (let row = 1; row <= r2115.rows; row++) {
    const want = row < 20 ? 2124 : row > 20 ? 2125 : null;
    if (east2115(row) !== want) wrong.push({ row, got: east2115(row), want });
  }
  ok(!wrong.length, "2115's east edge fires 2124 for row < 20, 2125 for row > 20, and nothing at row 20", wrong);
  ok(edgeConditionAllows({ type: 1, threshold: 20 }, { row: 21 }) && !edgeConditionAllows({ type: 1, threshold: 20 }, { row: 20 })
     && edgeConditionAllows({ type: 2, threshold: 20 }, { row: 19 }) && !edgeConditionAllows({ type: 2, threshold: 20 }, { row: 20 }),
     'row> and row< are strict, in coarse squares');
}

// 2. THE BAKE: one anchor per DESTINATION, each inside its own condition.
{
  const a2125 = anchorFor(table, 2115, 2125), a2124 = anchorFor(table, 2115, 2124);
  ok(a2125 && a2125.row > 20 && east2115(a2125.row) === 2125, 'the baked 2115 -> 2125 anchor is in the row > 20 band', a2125);
  ok(a2124 && a2124.row < 20 && east2115(a2124.row) === 2124, 'the baked 2115 -> 2124 anchor is in the row < 20 band', a2124);
}

// 3. WHAT THE WORLD PUBLISHES: every 2125 crossing on rows > 20, every 2124 crossing on rows < 20.
const origins = [[44, 24], [23, 17], [22, 19], [12, 8], [1, 24]];
for (const [row, col] of origins) {
  const f = h.fixture({ from: { room: 2115, x: col * 64 + 32, y: row * 64 + 32 } });
  const exits = f.s.world.exits();
  for (const [to, inBand] of [[2125, r => r > 20], [2124, r => r < 20]]) {
    const crossings = exits.filter(e => e.kind === 'edge' && e.to === to)
      .flatMap(e => [e, ...(e.alternates ?? [])]).filter(c => c.fine_stand_on);
    const bad = crossings.map(c => fineSquare(c.fine_stand_on)).filter(c => !inBand(c.row) || east2115(c.row) !== to);
    ok(crossings.length && !bad.length, `from r${row}c${col} every published ${to} crossing is inside its own row band`,
       { crossings: crossings.length, bad: bad.map(sq) });
  }
}

// 4. THE DEFECT: a departure plan toward a boundary goal borrows only the anchor of the exit that goal fires.
const departure = (f, goal, extra = {}) => planRailDeparture(f.s.world.geometry, f.c.self, goal,
  { room: 2115, table, manifest: h.map.geometryManifestSha256, objects: f.c.room.objects, selfId: f.c.selfId, ...extra });
const railEnd = p => p?.rail?.squares?.at(-1) ?? null;
for (const [row, col] of [[22, 19], [44, 24]]) {
  const f = h.fixture({ from: { room: 2115, x: col * 64 + 32, y: row * 64 + 32 } });
  // The squares the 2125 boundary publishes on column 63, and the far end of that band.
  for (const goalRow of [21, 25, 26, 27, 30, 33, 40, 52]) {
    const goal = { row: goalRow, col: 63 }, p = departure(f, goal), end = railEnd(p);
    ok(!end || (end.row > 20 && east2115(end.row) === 2125),
       `from r${row}c${col} a departure to the 2125 stage ${sq(goal)} never rides a rail into the row < 20 (2124) band`,
       { via: p.via, end: end && sq(end), reason: p.reason });
    const into2124 = (p.rail?.squares ?? []).filter(s => s.col === 63 && s.row < 20);
    ok(!into2124.length, `from r${row}c${col} the ${sq(goal)} departure rail crosses no 2124 doorway square`, into2124.map(sq));
  }
  // Stages right beside the 2125 anchor keep their compatible boundary rail.
  for (const goalRow of [25, 26, 27]) {
    const goal = { row: goalRow, col: 63 }, end = railEnd(departure(f, goal));
    ok(end && end.row === 26 && end.col === 62, `from r${row}c${col} ${sq(goal)} still borrows the 2125 anchor r26c62`, end && sq(end));
  }
  // The 2124 exit is chosen for row < 20, and only there.
  for (const goalRow of [1, 3, 10, 19]) {
    const goal = { row: goalRow, col: 63 }, end = railEnd(departure(f, goal));
    ok(end && end.row === 3 && end.col === 63, `from r${row}c${col} the row < 20 goal ${sq(goal)} still borrows the 2124 anchor`, end && sq(end));
  }
  // Row 20 fires nothing, so it can borrow neither anchor.
  {
    const p = departure(f, { row: 20, col: 63 }), end = railEnd(p);
    ok(!end || (end.row !== 3 && !(end.row === 26 && end.col === 62)), `from r${row}c${col} r20c63 borrows no exit's anchor`, end && sq(end));
  }
  // With no map room to read the condition from, a side carrying two destinations lends nothing.
  {
    const end = railEnd(departure(f, { row: 26, col: 63 }, { mapRoom: null }));
    ok(!end || !(end.row === 3 && end.col === 63), `from r${row}c${col} without the map the ambiguous east side never lends r3c63`, end && sq(end));
  }
}

// 5. THE WALK THE DEPARTURE DRIVES: no packet onto a 2124 doorway square, and it arrives at the 2125 stage.
{
  const f = h.fixture({ from: { room: 2115, x: 19 * 64 + 32, y: 22 * 64 + 32 } }, { maxPackets: 300, maxMs: 60000 });
  const goal = { row: 26, col: 63 };
  const wrongDoor = f.s.world.wrongExitSquares({ to: 2125, direction: 'east' });
  ok(wrongDoor.has('3,63') && wrongDoor.has('19,63') && !wrongDoor.has('26,63'), "2115's wrong door for 2125 is the row < 20 band of column 63");
  const p = departure(f, goal, { avoidSquares: wrongDoor });
  const r = p.found ? await withBodyCommand(f.s, async () => {
    const legs = await f.s.walkDepartureLegs(p.waypoints, p.square, {});
    return legs.arrived ? f.s.continueDeparture({ ...legs, rail: p.rail }, goal.col, goal.row, { maxSteps: 200, avoidSquares: wrongDoor }) : legs;
  }, 'edge-condition-anchor-departure') : { arrived: false, reason: p.reason };
  const onWrongDoor = f.packets.filter(q => q.room === 2115 && wrongDoor.has(`${q.row},${q.col}`));
  const offMap = f.packets.filter(q => q.col > r2115.cols);
  ok(r.arrived && f.c.self.row === goal.row && f.c.self.col === goal.col, 'the departure walk from r22c19 arrives on the 2125 stage r26c63',
     { arrived: r.arrived, reason: r.reason, at: f.c.self && sq(f.c.self) });
  ok(!onWrongDoor.length, 'and never sends a packet onto a square whose east step fires 2124', onWrongDoor.map(sq));
  ok(!offMap.length && !f.crossings.length, 'and never steps past the east edge while walking to a stage', offMap.map(sq));
  ok(f.packets.length < 60, `and goes the short way (${f.packets.length} packets; the 2124 detour cost 94)`);
}

// 6. THE WHOLE CROSSING: leaving 2115 for 2125 crosses on a row > 20 and lands in 2125.
for (const [row, col] of [[44, 24], [23, 17], [1, 24]]) {
  const f = h.fixture({ from: { room: 2115, x: col * 64 + 32, y: row * 64 + 32 } }, { maxPackets: 300, maxMs: 60000 });
  const r = await withBodyCommand(f.s, () => f.s.leaveViaAny(f.s.world.exits().filter(e => e.to === 2125)), 'edge-condition-anchor-cross');
  const outward = f.packets.filter(q => q.room === 2115 && q.col > r2115.cols);
  const stages = f.asks.map(a => a.stage).filter(Boolean);
  ok(r.left && f.crossings.length === 1 && f.crossings[0].to === 2125, `from r${row}c${col} 2115 -> 2125 lands in 2125`,
     { left: r.left, crossings: f.crossings });
  ok(outward.length && outward.every(q => q.row > 20 && east2115(q.row) === 2125), `from r${row}c${col} the outward step is on a row > 20`, outward.map(sq));
  ok(stages.every(s => s.row > 20), `from r${row}c${col} every stage walked to is in the row > 20 band`, stages.map(sq));
}

// 7. 2125 -> 2115 IS NOT THE SAME BUG: its departures toward the west exit borrow the 2115 anchor, never 2135's r5c49.
for (const [row, col] of [[20, 20], [37, 44], [10, 40]]) {
  const f = h.fixture({ from: { room: 2125, x: col * 64 + 32, y: row * 64 + 32 } });
  for (const goal of [{ row: 15, col: 1 }, { row: 15, col: 2 }, { row: 17, col: 1 }, { row: 18, col: 1 }]) {
    const p = planRailDeparture(f.s.world.geometry, f.c.self, goal,
      { room: 2125, table, manifest: h.map.geometryManifestSha256, objects: f.c.room.objects, selfId: f.c.selfId });
    const end = railEnd(p);
    ok(!end || (end.row === 16 && end.col === 1), `2125 from r${row}c${col}: ${sq(goal)} departs toward 2115's r16c1, never 2135's r5c49`, end && sq(end));
  }
}

console.log(`m59-edge-condition-anchor-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
