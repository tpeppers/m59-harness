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
