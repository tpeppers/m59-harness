// #movement: OUT OF AN ORC PIT CHAMBER WHILE ITS FLOOR IS MOVED, ONTO A SPOKE THAT STAYS PUT.
//
// The pit puzzle (orcpitb.kod EvaluatePuzzle) holds each chamber's SOLUTIONSECTOR (sector 1) at a
// solution height for 60 s, then ResetPuzzle returns it to 500, where both chambers are pockets.
// The clock only matters until the body is OFF that sector: the spokes are fixed floors from which
// the room's edge to 2506 is an ordinary walk at rest (tools/m59-orc-pit-floors-test.mjs). So the
// "through" leg is two halves -- this short fine walk off the chamber, planned on the room with the
// solved floor applied, then an ordinary `walk(2506)`.
//
//   chamber A, 2507, 'squares' floor 600: east spoke (floor 600, ceiling 680), stop r86c39
//   chamber B, 2508, 'squares' floor 250: north spoke (floor 250),              stop r41c28
//
// The plan is cut on a FRESH geometry with the baked door state for that floor applied, and every
// chord is re-proved; the live mover still checks each step against the keeper's own geometry,
// which applies the same state when the server's BP_SECTOR_MOVE arrives.
import { RoomGeometry } from './m59-roo.mjs';
import { loadMap } from './m59-map.mjs';
import { applyCeilingDoors } from './m59-ceiling-doors.mjs';
import { cutRail, chordWalkable } from './m59-railcut.mjs';
import { protocolToClient, clientToProtocol } from './m59-finepos.mjs';

/** orcpitb.kod:15-29 -- which chamber height each solution sets. */
export const SOLVED_FLOORS = Object.freeze({ squares: Object.freeze({ A: 600, B: 250 }), plain: Object.freeze({ A: 900, B: 0 }) });
export const CHAMBER_ROOM = Object.freeze({ A: 2507, B: 2508 });
/** KOD protocol points on the fixed spoke floors, clear of the chamber sector. */
export const SPOKE_STOP = Object.freeze({ A: Object.freeze({ x: 2504, y: 5552 }), B: Object.freeze({ x: 1840, y: 2632 }) });

/** The room with the chamber floor at `floor`, as the runtime would hold it after the packet. */
export function solvedGeometry(room, floor, { map = loadMap() } = {}) {
  const g = RoomGeometry.fromJSON(map.rooms[room].roo); g.roomNum = room;
  const applied = applyCeilingDoors(map, room, new Map([[1, { height: floor, type: 4 }]]), null, { geometryOf: () => g });
  if (!applied?.state?.startsWith(`${floor},`)) throw Error(`orc_pit_floor_state_unbaked_${room}_${floor}`);
  return g;
}

/** Fine chords (KOD protocol) from `from` to the side's spoke stop, on the solved floor. */
export function planChamberExit(side, floor, from, { map } = {}) {
  const room = CHAMBER_ROOM[side], stop = SPOKE_STOP[side];
  if (!room) throw Error('orc_pit_side_' + side);
  const g = solvedGeometry(room, floor, { map });
  const edge = (a, b) => { const t = g.traceFineMoveClient(a.x, a.y, b.x, b.y, { slide: false }); return t.arrived && !t.blocked; };
  const a = protocolToClient(from), b = protocolToClient(stop);
  const cut = cutRail(a, b, { edge, bounds: { w: g.cols * 1024, h: g.rows * 1024 }, lattice: 128 });
  if (!cut.ok || !cut.bridgeOk) return { ok: false, why: cut.why ?? 'no fine route off the chamber', room, floor };
  const w = cut.waypoints, keep = [];
  for (let i = 0; i < w.length - 1;) {
    let j = w.length - 1;
    for (; j > i + 1; j--) if (chordWalkable(w[i], w[j], { edge, lattice: 128 }).ok) break;
    keep.push(w[j]); i = j;
  }
  if (!chordWalkable(keep.at(-1) ?? a, b, { edge, lattice: 128 }).ok) return { ok: false, why: 'stop not reachable', room, floor };
  return { ok: true, room, floor, waypoints: keep.map(clientToProtocol) };
}

const pause = ms => new Promise(r => setTimeout(r, ms));
const floorOf = l => { const m = l?.sector_movements?.['1'] ?? l?.sector_movements?.[1]; return m?.type === 4 ? m.height : null; };

/**
 * Wait for the server to report the solved floor, then walk the planned chords off the chamber.
 * `read` returns the keeper's fine body (readIslandFinePosition shape: room, you {x,y,row,col}
 * in KOD protocol, sector_movements, door_settling_until).
 */
export async function leaveChamber(ctx, side, solution = 'squares', { read, budgetMs = 45_000, pollMs = 500 } = {}) {
  const floor = SOLVED_FLOORS[solution]?.[side], room = CHAMBER_ROOM[side];
  if (floor == null || !room) throw Error(`orc_pit_unknown_${solution}_${side}`);
  const deadline = Date.now() + budgetMs;
  let l = await read();
  while (floorOf(l) !== floor || (Number(l?.door_settling_until) || 0) > Date.now()) {
    if (l?.room?.num !== room) throw Error(`orc_pit_left_room_${room}_for_${l?.room?.num}`);
    if (Date.now() >= deadline) throw Error(`orc_pit_floor_not_${floor}_saw_${floorOf(l)}`);
    await pause(pollMs); l = await read();
  }
  const plan = planChamberExit(side, floor, l.you);
  if (!plan.ok) throw Error('orc_pit_exit_unplanned_' + plan.why);
  for (const [i, p] of plan.waypoints.entries()) {
    const last = i === plan.waypoints.length - 1;
    const dist = Math.hypot(p.x - l.you.x, p.y - l.you.y);
    const r = await ctx.call('walk_to', { agent: ctx.agent, x: p.x, y: p.y, fine: true, stride: 16,
      max_steps: Math.ceil(dist / 16) + 4, arrive_within: last ? 4 : 8, hold_shelf: true }, 30_000);
    l = await read();
    if (l?.room?.num !== room) throw Error(`orc_pit_left_room_${room}_for_${l?.room?.num}`);
    if (!r?.arrived && Math.hypot(p.x - l.you.x, p.y - l.you.y) > 16)
      throw Error(`orc_pit_exit_refused_${r?.reason ?? 'not_arrived'}_at_r${l.you.row}c${l.you.col}`);
    if (Date.now() >= deadline) throw Error('orc_pit_exit_budget');
  }
  return { ok: true, side, floor, stop: { row: l.you.row, col: l.you.col }, chords: plan.waypoints.length };
}

// ---------------------------------------------------------------- back to a chamber, from anywhere
//
// THE ANTECHAMBERS DRAIN INTO A SINK. 2507's route from chamber A to its east edge descends ledges
// that cannot be climbed back (600 spoke -> 500 -> 450 at r57c37 -> 350 at r41c37 -> 200 at r26c39),
// and the north body it ends in (762 squares, where 2506's west edge lands at r7c61) reaches
// nothing but that edge. 2508 is the same shape (2506's east edge lands at r8c4). So a body in
// 2506 or a north body can reach its chamber only the long way: 2506 -> 2509 -> 2500 -> 2501, then
// 2501's north edge to 2508's corridor, or the Hollows transit to 2507's (2026-11-14 10:07Z: Zoot,
// left at 2507 r35c27 by a cleanup, crawled row 35 toward r83c25 until his budget ran out).
// Each corridor meets its chamber through the ceiling door the in-room walker already operates.
export const CHAMBER_SQUARE = Object.freeze({ A: Object.freeze([83, 25]), B: Object.freeze([48, 27]) });
const REACH = new Map();
/** Squares of the chamber's room that can walk to the chamber, at rest with the corridor door open. */
export function chamberReachers(side, { map = loadMap() } = {}) {
  if (REACH.has(side)) return REACH.get(side);
  const room = CHAMBER_ROOM[side];
  const g = RoomGeometry.fromJSON(map.rooms[room].roo); g.roomNum = room;
  applyCeilingDoors(map, room, new Map([[2, { height: 600, type: 5 }]]), null, { geometryOf: () => g });
  const [r0, c0] = CHAMBER_SQUARE[side], seen = new Set([r0 + ',' + c0]), q = [[r0, c0]];
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  while (q.length) {
    const [r, c] = q.shift();
    for (const [dr, dc] of dirs) {
      const nr = r + dr, nc = c + dc, k = nr + ',' + nc;
      if (nr < 1 || nc < 1 || nr > g.rows || nc > g.cols || seen.has(k)) continue;
      let s = false; try { s = g.moverStepLands(nr, nc, r, c); } catch {}
      if (s) { seen.add(k); q.push([nr, nc]); }
    }
  }
  REACH.set(side, seen);
  return seen;
}

/** The next room on the way back to `side`'s chamber, or 'there' / 'transit' / null (not on the map). */
export function nextTowardChamber(side, room, row, col) {
  const own = CHAMBER_ROOM[side], other = side === 'A' ? 'B' : 'A';
  if (room === own) return chamberReachers(side).has(`${row},${col}`) ? 'there' : 2506;
  if (room === CHAMBER_ROOM[other])
    // The other antechamber: its corridor drains to the caves, its north body to the lair.
    return chamberReachers(other).has(`${row},${col}`) ? (other === 'A' ? 2502 : 2501) : 2506;
  return { 2506: 2509, 2509: 2500, 2500: 2501, 2501: side === 'A' ? 2502 : 2508,
           2502: side === 'A' ? 'transit' : 2501 }[room] ?? null;
}

/**
 * Walk one hop at a time until the body stands where its chamber can be walked to. `hop(to)` is a
 * one-room crossing (island-route ordinaryHop), `transit()` the admitted Hollows north transit.
 */
export async function approachChamber(ctx, side, { look, hop, transit, maxHops = 10 } = {}) {
  const path = [];
  for (let i = 0; i <= maxHops; i++) {
    const l = await look();
    const room = Number(l?.room?.num), at = l?.you ?? {};
    const next = nextTowardChamber(side, room, Number(at.row), Number(at.col));
    if (next === 'there') return { ok: true, room, at: `r${at.row}c${at.col}`, path };
    if (next == null) throw Error(`orc_pit_approach_from_room_${room}`);
    path.push(next);
    if (next === 'transit') await transit();
    else {
      const leg = await hop(next);
      if (leg && leg.ok === false) throw Error(`orc_pit_approach_hop_${room}_to_${next}_${leg.reason ?? 'failed'}`);
    }
  }
  throw Error('orc_pit_approach_hop_budget');
}
