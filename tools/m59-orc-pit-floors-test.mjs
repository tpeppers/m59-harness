// #movement: THE ORC PIT CHAMBERS' MOVING FLOORS, AND WHICH SOLUTION LETS EACH CHAMBER OUT.
//
//   node tools/m59-orc-pit-floors-test.mjs      offline: kod scan, baked door table, step masks
//
// riija-pitboss, 2026-11-14 08:11Z: the lever switched and all three bodies then failed
// `walk(2506)` "in three attempts", Robin and Camilla walking out of 2508 the long way to 2500/2509.
// Each chamber is a pocket at floor 500 (SOLUTIONSECTOR, sector 1) whose only way to the boss is a
// spoke the floor reaches only while EvaluatePuzzle holds it at a solution height for 60 s
// (orcpitb.kod:15-29, :233-262; edges orcpita.kod:71 east -> 2506 r35c5, orcpitb.kod west ->
// 2506 r35c67). Nothing knew those heights: DoSolution sets `#height = height`, a parameter, so
// m59-varsectors dropped the sector and no mask existed for any moved floor.
//
// Pinned here: the scan now resolves the callers' heights; the door table carries every chamber
// position beside the ceiling door; the runtime applies an observed floor packet; and what each
// position opens, measured on the mover's own step mask:
//   2508 (B): 0, 100 and 250 all reach the west edge to 2506 (r7c1).
//   2507 (A): 600 reaches the east edge (r6c61) by the east spoke (floor 600, ceiling 680);
//             900 -- the "plain" solution -- does NOT: its west spoke is sealed by a zero-headroom
//             sector at r85-86 c12 and its south loop is a dead end. So chamber A needs 'squares'.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RoomGeometry, DIR } from './m59-roo.mjs';
import { loadMap } from './m59-map.mjs';
import { applyCeilingDoors } from './m59-ceiling-doors.mjs';
import { sectorsInSource, callHeightsInSource, messageParams, constantsInSource } from './m59-varsectors.mjs';
import { PIT, pitRoles } from './m59-riija.mjs';
import { planChamberExit, leaveChamber, solvedGeometry, SPOKE_STOP, SOLVED_FLOORS } from './m59-orc-pit-exit.mjs';
import { protocolToClient } from './m59-finepos.mjs';

let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; }; const eq = (a, b, m) => { assert.deepEqual(a, b, m); passed++; };

// 1. The scanner: a height passed as a parameter is resolved through its callers.
const pitb = `
constants:
   SOLUTIONSECTOR = 1
   SOLUTIONHEIGHTB1 = 0
   SOLUTIONHEIGHTA1 = 900
   REGULARHEIGHTB = 500
properties:
   piRoom_num = RID_ORC_PIT_B
messages:
   EvaluatePuzzle()
   {
      oRoomA = Send(SYS,@FindRoombynum,#num=RID_ORC_PIT_A);
      send(oRoomA,@DoSolution,#height=SOLUTIONHEIGHTA1);
      send(Self,@DoSolution,#height=SOLUTIONHEIGHTB1);
   }
   ResetPuzzle()
   {
      Send(Self,@DoSolution,#Height=REGULARHEIGHTB,#Speed=50);
   }
   DoSolution(height=500,speed=50)
   {
   send(self,@setsector,#sector=SOLUTIONSECTOR,#animation=ANIMATE_FLOOR_LIFT,
      #height = height,#speed=speed);
   return;
   }
`;
eq(messageParams(pitb, pitb.indexOf('@setsector'))?.name, 'dosolution', 'the enclosing message is found');
const calls = callHeightsInSource(pitb, 'RID_ORC_PIT_B');
eq(calls.map(c => c.key + '=' + c.height).sort(),
  ['RID_ORC_PIT_A|dosolution=900', 'RID_ORC_PIT_B|dosolution=0', 'RID_ORC_PIT_B|dosolution=500'],
  'receivers resolve: a local from FindRoomByNum names room A, Self names this room');
const callHeights = new Map();
for (const c of calls) callHeights.set(c.key, [...(callHeights.get(c.key) ?? []), c.height]);
eq(sectorsInSource(pitb, { callHeights, rid: 'RID_ORC_PIT_B' }).map(s => [s.sector, s.heights]), [[1, [0, 500]]],
  'the parameter height is the default plus what this room is sent');
eq(sectorsInSource(pitb), [], 'without callers it is still not a claim');

// 2. The shipped scan and the baked tables.
const vs = JSON.parse(readFileSync(new URL('../substrate/m59-variable-sectors.json', import.meta.url)));
const solution = n => vs.rooms.find(r => r.room === n)?.sectors.find(s => s.sector === 1)?.heights;
eq(solution(2507), [500, 600, 750, 900], '2507 SOLUTIONSECTOR heights (REGULARHEIGHTA, SOLUTIONHEIGHTA3/2/1)');
eq(solution(2508), [0, 100, 250, 500], '2508 SOLUTIONSECTOR heights (SOLUTIONHEIGHTB1/2/3, REGULARHEIGHTB)');
const table = JSON.parse(readFileSync(new URL('../substrate/m59-ceiling-doors.json', import.meta.url)));
for (const [n, heights] of [[2507, [500, 600, 750, 900]], [2508, [0, 100, 250, 500]]]) {
  const r = table.rooms[n];
  eq(r.doors.map(d => [d.id, d.kind ?? 'ceiling']), [[1, 'floor'], [2, 'ceiling']], `${n}: the chamber floor beside the corridor door`);
  for (const h of heights) for (const door of [500, 600]) ok(r.states[`${h},${door}`]?.mask, `${n}: state ${h},${door} is baked`);
}

// 3. What each floor opens, through the runtime's own application of an observed packet.
const map = loadMap();
const flood = (g, r0, c0) => { const seen = new Set([r0 + ',' + c0]), q = [[r0, c0]];
  while (q.length) { const [r, c] = q.shift(); for (const d of Object.values(DIR)) { const nr = r + d.dr, nc = c + d.dc, k = nr + ',' + nc;
    if (nr < 1 || nc < 1 || nr > g.rows || nc > g.cols || seen.has(k)) continue;
    let s = false; try { s = g.moverStepLands(r, c, nr, nc); } catch {} if (s) { seen.add(k); q.push([nr, nc]); } } } return seen; };
const observedAt = (n, floor) => {
  const g = RoomGeometry.fromJSON(map.rooms[n].roo); g.roomNum = n;
  const observed = new Map(floor == null ? [] : [[1, { height: floor, type: 4 }]]);
  const r = applyCeilingDoors(map, n, observed, null, { geometryOf: () => g });
  return { g, state: r?.state };
};
const exitA = '6,61', exitB = '7,1', chamberA = [86, 25], chamberB = [48, 27];
{ const { g, state } = observedAt(2507, null); eq(state, '500,500', '2507 at rest');
  ok(!flood(g, ...chamberA).has(exitA), '2507 at rest: chamber A is a pocket'); }
{ const { g, state } = observedAt(2507, 600); eq(state, '600,500', 'an observed floor packet selects the 600 state');
  ok(flood(g, ...chamberA).has(exitA), "2507 at 600 ('squares'): chamber A reaches the east edge to 2506"); }
{ const { g } = observedAt(2507, 900);
  ok(!flood(g, ...chamberA).has(exitA), "2507 at 900 ('plain'): chamber A does NOT reach 2506 -- sealed west spoke"); }
{ const { g } = observedAt(2507, 750); ok(flood(g, ...chamberA).has(exitA), '2507 at 750: the north spoke also reaches it'); }
{ const { g } = observedAt(2508, null); ok(!flood(g, ...chamberB).has(exitB), '2508 at rest: chamber B is a pocket'); }
for (const h of [0, 100, 250]) { const { g, state } = observedAt(2508, h); eq(state, `${h},500`, `2508 ${h} state`);
  ok(flood(g, ...chamberB).has(exitB), `2508 at ${h}: chamber B reaches the west edge to 2506`); }
const edges = n => map.rooms[n].edgeExits.filter(e => e.to === 2506).map(e => [e.leaveName, e.arriveRow, e.arriveCol]);
eq(edges(2507), [['east', 35, 5]], 'orcpita.kod:71'); eq(edges(2508), [['west', 35, 67]], 'orcpitb.kod LEAVE_WEST');

// 4. The team the script builds: 'squares' is the default, and three bodies can do it.
eq(pitRoles(['a', 'b', 'c']).map(r => [r.side, r.row, r.col, r.lever]),
  [['A', 83, 25, false], ['B', 45, 29, true], ['B', 51, 29, false]],
  'three: A on r83c25, the puller on r45c29 (3 from the lever, lever.kod:61-62), the other on r51c29');
ok(Math.abs(45 - PIT.B.lever.row) <= PIT.B.lever.range && Math.abs(29 - PIT.B.lever.col) <= PIT.B.lever.range, 'r45c29 is in lever range');
eq(pitRoles(['a', 'b', 'c', 'd']).filter(r => r.side === 'B').map(r => [r.row, r.col]), [[48, 27], [45, 29], [51, 29]],
  'four: the puller off the marked squares, both marked squares held');

// 5. The fine exit the "through" step walks: every squares role square, onto a fixed spoke.
const kod = (r, c) => ({ x: c * 64 + 32, y: r * 64 + 32 });
for (const [side, squares] of [['A', [[83, 25], [86, 25], [85, 24], [87, 26]]], ['B', [[45, 29], [51, 29], [48, 27]]]]) {
  const floor = SOLVED_FLOORS.squares[side], room = side === 'A' ? 2507 : 2508, g = solvedGeometry(room, floor);
  for (const [r, c] of squares) {
    const plan = planChamberExit(side, floor, kod(r, c));
    ok(plan.ok, `${side} r${r}c${c}: a fine exit on the ${floor} floor`);
    eq(plan.waypoints.at(-1), SPOKE_STOP[side], `${side} r${r}c${c}: ends at the spoke stop`);
    ok(plan.waypoints.length <= 4, `${side} r${r}c${c}: ${plan.waypoints.length} chord(s)`);
  }
  const stop = protocolToClient(SPOKE_STOP[side]);
  ok(g.leafAtClient(stop.x, stop.y)?.sector?.serverId !== 1, `${side}: the stop is off the moving sector`);
  const rest = observedAt(room, null).g, sq = [Math.floor(SPOKE_STOP[side].y / 64), Math.floor(SPOKE_STOP[side].x / 64)];
  ok(flood(rest, ...sq).has(side === 'A' ? exitA : exitB), `${side}: from the stop the edge is reachable after the floor resets`);
}
ok(!planChamberExit('A', SOLVED_FLOORS.plain.A, kod(86, 25)).ok, "plain: chamber A has no exit at 900");

// 6. leaveChamber: waits for the server's floor packet, then walks the chords; refuses the wrong floor.
{
  let body = { ...kod(45, 29), row: 45, col: 29 }, moves = [], reads = 0;
  const read = async () => ({ room: { num: 2508 }, you: body, sector_movements: { 1: { height: ++reads > 2 ? 250 : 500, type: 4 } }, door_settling_until: 0 });
  const ctx = { agent: 't8', call: async (name, a) => { assert.equal(name, 'walk_to'); moves.push(a); body = { x: a.x, y: a.y, row: Math.floor(a.y / 64), col: Math.floor(a.x / 64) }; return { arrived: true }; } };
  const r = await leaveChamber(ctx, 'B', 'squares', { read, pollMs: 1 });
  ok(r.ok && reads > 2, 'it waited for the 250 packet before moving');
  eq(moves.at(-1).x + ',' + moves.at(-1).y, SPOKE_STOP.B.x + ',' + SPOKE_STOP.B.y, 'and walked to the spoke stop');
  ok(moves.every(m => m.fine === true), 'fine walk_to chords');
  await assert.rejects(leaveChamber(ctx, 'B', 'squares', { read: async () => ({ room: { num: 2508 }, you: body, sector_movements: { 1: { height: 500, type: 4 } } }), budgetMs: 30, pollMs: 5 }),
    /orc_pit_floor_not_250_saw_500/); passed++;
  await assert.rejects(leaveChamber(ctx, 'A', 'squares', { read: async () => ({ room: { num: 2508 }, you: body }), pollMs: 1 }),
    /orc_pit_left_room_2507_for_2508/); passed++;
}

console.log(`m59-orc-pit-floors-test: ${passed} passed`);
