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
