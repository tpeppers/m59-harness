// Recovery asks where this body can get safe now, independently of a future quarry.
import { OF, blocksMovement } from './m59-parse.mjs';

export const REFUGE_PROGRESS_MS = 8000;

// A new command or a new survival decision is not movement. Retain the best
// confirmed remaining route across retries so a short oscillation cannot keep
// renewing an approach. Route distance allows detours around an internal wall.
export function observeRefugeProgress(state, geo, position, target, now = Date.now()) {
  if (!state) state = { startedAt: now, progressedAt: now, best: Infinity };
  if (position && !position.predicted) {
    const square=`${position.row},${position.col}`;
    if(state.square===square)return state;
    state.square=square;
    let remaining = Infinity;
    if (position.row === target.row && position.col === target.col) remaining = 0;
    else if (geo?.path) {
      try {
        const path = geo.path(position.row, position.col, target.row, target.col, { clearance: 0 });
        if (path?.found) remaining = path.steps.length;
      } catch { /* an unreadable path is not progress */ }
    }
    if (remaining < state.best) {
      state.best = remaining;
      state.progressedAt = now;
    }
  }
  return state;
}

export function recoveryOccupiedSquares(objects, selfId, playersOnline = null) {
  // Geometry.path's established avoid grammar is "row,col". Occupied targets and
  // routes through these squares are both excluded; adjacent monsters are not a veto.
  const occupied = new Set();
  for (const o of objects?.values?.() ?? []) {
    if (!o || o.id === selfId || !Number.isFinite(o.row) || !Number.isFinite(o.col)) continue;
    if (blocksMovement(o.flags ?? 0) || (o.flags & (OF.ATTACKABLE | OF.PLAYER))
        || playersOnline?.has?.(o.id)) occupied.add(`${o.row},${o.col}`);
  }
  return occupied;
}

export function recoveryRefugeReach(geo, from, objects, selfId, playersOnline = null) {
  const occupied = recoveryOccupiedSquares(objects, selfId, playersOnline);
  return (col, row) => {
    if (!geo?.path || !from) return { reachable: false, why: 'recovery route unavailable' };
    if (occupied.has(`${row},${col}`)) return { reachable: false, why: 'recovery spot occupied' };
    try {
      const path = geo.path(from.row, from.col, row, col,
        { avoid: occupied, clearance: 0, goalExempt: false });
      return { reachable: !!path?.found, steps: path?.found ? path.steps.length : null,
        path: path?.found ? path.steps : null,
        why: path?.found ? undefined : path?.reason ?? 'no clear recovery route' };
    } catch { return { reachable: false, why: 'recovery route unavailable' }; }
  };
}

// OUT THROUGH A DOOR THE MONSTERS CANNOT USE.
//
// Castle Victoria's room 38 is one room to the server and twenty-three regions to a body:
// small chambers joined to the hall only by `go` doors back into the room itself
// (castle1.kod:88-98). A monster cannot operate those doors, so crossing one ends every
// attack exactly as crossing a room boundary does — and the east chamber (r4-8 c30-34, 25
// squares, four walls) is where Waldorf, Statler, Sweetums, Zoot and Gonzo died inside one
// hour on 2026-10-06/07. Each stood on r7c32, the door's landing square, with the way out at
// r8c32 ONE SQUARE SOUTH, while the recovery search reported "walls considered 112,
// eligible 0" at one-second intervals for 35-50 seconds. The search looked only inside the
// chamber, the chamber's four walls were occupied or had just failed, and the door was not
// a candidate for anything. Nothing moved until they died.
//
// So when there is no wall on this side, a door whose far side HAS one is the refuge: walk
// to the door, cross, and take the wall over there. This only plans. The caller crosses and
// then searches again from where the body actually landed, because a plan made from this
// side of a wall is a guess about the other.
//
//   doors      the room's same-room doors (sameRoomDoors), each {row,col,arriveRow,arriveCol}
//   component  Set of "row,col" this body can walk to without a door (reachableFrom). A door
//              must be on our side of the wall, and its landing must NOT be — a door that
//              lands on ground we can already walk to leads nowhere new.
//   reach      (col,row) -> {reachable, steps}, the recovery route from here: it avoids bodies,
//              so a monster standing on the door square makes that door unavailable.
//   farRefuge  ({row,col}) -> {spot, steps} | null — the best wall reachable from a landing.
//
// Ranked by the whole walk, door then wall, and nothing else: the same distance-only rule
// every recovery choice uses (m59-safespots.mjs, "THE NEAREST ONE").
export function planDoorEscape({ doors = [], component = null, reach, farRefuge } = {}) {
  const counts = { doors: doors.length, on_our_side: 0, in_reach: 0, onto_new_ground: 0, with_refuge: 0 };
  let best = null;
  for (const door of doors) {
    const here = `${door.row},${door.col}`, there = `${door.arriveRow},${door.arriveCol}`;
    if (component && !component.has(here)) continue;
    counts.on_our_side++;
    if (component && component.has(there)) continue;
    counts.onto_new_ground++;
    const toDoor = reach?.(door.col, door.row);
    if (!toDoor?.reachable) continue;
    counts.in_reach++;
    const landing = { row: door.arriveRow, col: door.arriveCol };
    const beyond = farRefuge?.(landing);
    if (!beyond?.spot) continue;
    counts.with_refuge++;
    const stepsToDoor = Number.isFinite(toDoor.steps) ? toDoor.steps : 0;
    const stepsBeyond = Number.isFinite(beyond.steps) ? beyond.steps : 0;
    const total = stepsToDoor + stepsBeyond;
    if (!best || total < best.total)
      best = { door, landing, refuge: beyond.spot, steps_to_door: stepsToDoor,
               steps_beyond: stepsBeyond, total };
  }
  return { escape: best, counts };
}
