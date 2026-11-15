// #movement: pit-to-hall's route out of the orc pit complex, offline.
//
//   node tools/m59-pit-to-hall-test.mjs
//
// Pins: where each pit room is left from (approach squares on the mover's masks, fine rails from
// the very squares Zoot was stuck on 2026-11-15 in 2507's north part, clear of every other exit),
// the order of hops out and along the chain (fakes), and the refusals that name a position.
import assert from 'node:assert/strict';
import { roomGeometry } from './m59-ground.mjs';
import { loadMap, roomExitSquares } from './m59-map.mjs';
import { DIR, RoomGeometry } from './m59-roo.mjs';
import { applyCeilingDoors } from './m59-ceiling-doors.mjs';
import { cutRail } from './m59-railcut.mjs';
import { protocolToClient } from './m59-finepos.mjs';
import { PIT_OUT, CHAIN, pitOutNext, walkOutOfPit, walkChainToIsland, pitToHallStart } from './m59-pit-to-hall.mjs';
import { script } from './fleetscripts/pit-to-hall.mjs';

let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; }; const eq = (a, b, m) => { assert.deepEqual(a, b, m); passed++; };
const map = loadMap();
const flood = (g, r0, c0) => { const seen = new Set([r0 + ',' + c0]), q = [[r0, c0]];
  while (q.length) { const [r, c] = q.shift(); for (const d of Object.values(DIR)) { const nr = r + d.dr, nc = c + d.dc, k = nr + ',' + nc;
    if (nr < 1 || nc < 1 || nr > g.rows || nc > g.cols || seen.has(k)) continue;
    let s = false; try { s = g.moverStepLands(r, c, nr, nc); } catch {} if (s) { seen.add(k); q.push([nr, nc]); } } } return seen; };
const sq = p => [Math.floor(p.y / 64), Math.floor(p.x / 64)];
const anchorOf = (room, to) => map.rooms[room].edgeExits.find(e => e.to === to);

// 1. Each approach: reached from where the body arrives or was left, by a fine rail; clear of the
//    other exits; and one ordinary step-mask walk from the edge it hops over.
const STARTS = {
  // Zoot, 2026-11-15: r26c39, then x2311 y867 (r13c36), x2340 y795 (r12c36), x2673 y849 (r13c41); r35c27 the day before.
  2507: [[26, 39], [13, 36], [12, 36], [13, 41], [35, 27], [7, 61]],
  2508: [[8, 4], [20, 20]],
  2506: [[35, 5], [35, 67], [24, 41], [41, 53]],
};
const EDGE_SQUARE = { 2507: '6,61', 2508: '7,1', 2506: '57,1' };
ok(flood(roomGeometry(2509), 18, 43).has('105,43'), "2509: from 2506's arrival the step mask walks to the 2500 edge (one ordinary hop)");
for (const [room, out] of Object.entries(PIT_OUT)) {
  const g = roomGeometry(Number(room)), [ar, ac] = sq(out.approach);
  ok(flood(g, ar, ac).has(EDGE_SQUARE[room]), `${room}: approach r${ar}c${ac} walks to the edge to ${out.edgeTo}`);
  ok(anchorOf(Number(room), out.edgeTo), `${room}: has an edge to ${out.edgeTo}`);
  const avoid = roomExitSquares(map.rooms[room], { to: out.edgeTo, includeInland: true });
  ok(!avoid.has(`${ar},${ac}`), `${room}: approach r${ar}c${ac} is not another exit's square`);
  const edge = (a, b) => { if (avoid.has(Math.floor(b.y / 1024) + 1 + ',' + (Math.floor(b.x / 1024) + 1))) return false;
    const t = g.traceFineMoveClient(a.x, a.y, b.x, b.y, { slide: false }); return t.arrived && !t.blocked; };
  for (const [r, c] of STARTS[room]) {
    if (!g.standable(r, c)) continue;
    const from = { x: (c - 0.5) * 1024, y: (r - 0.5) * 1024 };
    const target = out.press ?? out.approach;
    const cut = cutRail(from, protocolToClient(target), { edge, bounds: { w: g.cols * 1024, h: g.rows * 1024 }, lattice: 128 });
    ok(cut.ok && cut.bridgeOk, `${room}: a fine rail from r${r}c${c} to the ${out.press ? 'door trigger' : 'approach'} (${cut.why ?? 'ok'})`);
  }
}

// 1b. 2506's door 1: shut, the trigger cannot reach the west approach; with the server's door-up
//     packets applied through the baked table (1a 380, 1b 274), it can.
{
  const out = PIT_OUT[2506];
  const rail = observed => {
    const g = RoomGeometry.fromJSON(map.rooms[2506].roo); g.roomNum = 2506;
    const st = applyCeilingDoors(map, 2506, observed, null, { geometryOf: () => g });
    const edge = (a, b) => { const t = g.traceFineMoveClient(a.x, a.y, b.x, b.y, { slide: false }); return t.arrived && !t.blocked; };
    return { st: st?.state, cut: cutRail(protocolToClient(out.press), protocolToClient(out.approach), { edge, bounds: { w: g.cols * 1024, h: g.rows * 1024 }, lattice: 128 }) };
  };
  const shut = rail(new Map()), open = rail(new Map([[1, { height: 380, type: 5 }], [2, { height: 274, type: 5 }]]));
  ok(shut.st && !shut.cut.ok, `2506 door 1 shut (${shut.st}): no way west from the trigger`);
  ok(open.st && open.cut.ok, `2506 door 1 up (${open.st}): trigger r57c15 to the west approach`);
  eq(sq(out.press), [57, 15], 'the trigger square is one orcpit1.kod:204 names (rows 56-57, cols 14-15)');
}

// 2. The decisions.
for (const [r, c] of STARTS[2507].slice(0, 5)) eq(pitOutNext(2507, r, c)?.edgeTo, 2506, `2507 north part r${r}c${c}: out east to 2506`);
eq(pitOutNext(2507, 164, 25)?.hop, 2502, "2507's corridor: back to the Hollows");
eq(pitOutNext(2507, 83, 25)?.hop, 2502, 'chamber A: back to the Hollows');
eq(pitOutNext(2508, 8, 4)?.edgeTo, 2506, "2508's north part: out west to 2506");
eq(pitOutNext(2508, 125, 29)?.hop, 2501, "2508's corridor: back to 2501");
eq(pitOutNext(2506, 35, 5)?.edgeTo, 2509, '2506: west below row 42 to 2509');
eq(pitOutNext(2509, 18, 43)?.hop, 2500, '2509: one ordinary hop east to 2500');
eq(pitOutNext(2510, 30, 20)?.hop, 2504, '2510: the spring back to 2504');
for (const r of CHAIN) eq(pitOutNext(r, 10, 10), 'chain', `${r} is on the chain`);
eq(pitOutNext(27, 10, 10), null, 'the mainland cave is not this route');
eq(pitToHallStart(713, 5, 5, 713), 'hall'); eq(pitToHallStart(2507, 35, 27, 713), 'caves');
ok(/27 .*r10c10 is not in the orc pit complex/.test(pitToHallStart(27, 10, 10, 713).refuse), 'a start elsewhere is refused, named');

// 3. Out of the pit with fakes: the hop order from 2507's north part, and a refusal that names its place.
{
  const ARRIVE = { 2506: [35, 5], 2509: [18, 43], 2500: [23, 2] };
  let at = { room: 2507, row: 26, col: 39 }; const walks = [], hops = []; let gos = 0;
  const look = async () => ({ room: { num: at.room }, you: { row: at.row, col: at.col } });
  const r = await walkOutOfPit({}, { look,
    fineWalk: async (room, p, edgeTo) => { walks.push(`${room}>${edgeTo}`); [at.row, at.col] = sq(p); },
    go: async () => { gos++; },
    hop: async to => { hops.push(to); at = { room: to, row: ARRIVE[to][0], col: ARRIVE[to][1] }; return { ok: true }; } });
  ok(r.ok, 'out'); eq(hops, [2506, 2509, 2500], 'east to the lair, west to 2509, east to 2500');
  eq(walks, ['2507>2506', '2506>null', '2506>2509'], "a fine walk to each approach first, and onto 2506's door trigger");
  eq(gos, 1, 'door 1 pressed once');
  at = { room: 2507, row: 26, col: 39 };
  await assert.rejects(walkOutOfPit({}, { look, fineWalk: async () => { throw Error('fine_route_budget'); }, hop: async () => ({ ok: true }) }),
    /pit_out: walk 2507's north part to its east edge at 2507 r26c39: fine_route_budget/); passed++;
  await assert.rejects(walkOutOfPit({}, { look, fineWalk: async () => {}, hop: async () => ({ ok: false, reason: 'budget' }) }),
    /pit_out: hop 2507 -> 2506 at 2507 r26c39: budget/); passed++;
  at = { room: 27, row: 10, col: 10 };
  await assert.rejects(walkOutOfPit({}, { look, fineWalk: async () => {}, hop: async () => ({ ok: true }) }), /pit_out: no route from 27 r10c10/); passed++;
}

// 4. The chain with fakes: single transits for 2502 and 2505, the pool after 2504, resumable mid-chain.
for (const [start, want] of [[2500, ['2501', 'T2501>2502>2503', '2504', 'pool', 'T2504>2505>2000']], [2503, ['2504', 'pool', 'T2504>2505>2000']], [2000, []]]) {
  let room = start; const log = [];
  const r = await walkChainToIsland({}, { look: async () => ({ room: { num: room }, you: { row: 1, col: 1 } }),
    hop: async to => { log.push(String(to)); room = to; return { ok: true }; },
    transit: async (from, mid, to) => { log.push(`T${from}>${mid}>${to}`); room = to; },
    onPool: async () => log.push('pool') });
  ok(r.ok, `chain from ${start}`); eq(log, want, `chain from ${start}: ${want.join(' ')}`);
}

// 5. The script itself.
const steps = await script.steps({ agents: 't17', items: 'orc%20pit%20boss%20head,plate%20armor', hall: 713 });
eq(steps.map(s => s.do), ['act', 'verify', 'verify', 'verify', 'walk', 'verify'], 'stand, start check, pit, chain, hall, deposit');
eq(steps[4].to, 713, 'walks to the hall');
await assert.rejects(script.steps({ agents: 't17,t8', items: 'x' }), /exactly one agent/); passed++;
await assert.rejects(script.steps({ agents: 't17', items: '' }), /items= is required/); passed++;

console.log(`m59-pit-to-hall-test: ${passed} passed`);
