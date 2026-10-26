// THE DOORS BETWEEN TWO ROOMS, AND WHERE TO STAND TO MEET WHOEVER COMES THROUGH THEM.
//
// "Fan out to the doors between these two maps so anything coming through can be hit at once" used to be
// a hand-written door file per door (m59-private strategy/pvp/doors.json: arrival square, approach square,
// posts). Every one of those numbers is already in the baked map: an exit carries the square it leaves
// from and the square it lands on (m59-map.mjs exitsOf: row/col, arriveRow/arriveCol). So a door is
// DERIVED -- every exit from A into B, grouped by where it lands in B -- and the posts around a landing
// square are the walkable squares of the same connected part of B that are not themselves exits.
//
// Both directions are returned, because "the doors between 38 and 39" means people coming either way.
// Square-level on purpose: posts are for standing, and a fine-coordinate question is the mover's.
import { loadMap, exitsOf } from '../m59-map.mjs';
import { RoomGeometry } from '../m59-roo.mjs';

const key = (r, c) => `${r},${c}`;
const cheb = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));

/** Every way from room `from` into room `to`, grouped by landing square: [{ from, to, arrive, leaves: [...] }]. */
export function doorsInto(from, to, { map = loadMap() } = {}) {
  const room = map.rooms[String(from)];
  if (!room) throw new Error(`no room ${from} in the map`);
  const groups = new Map();
  for (const e of exitsOf(room)) {
    if (Number(e.to) !== Number(to) || e.arriveRow == null || e.arriveCol == null) continue;
    const k = key(e.arriveRow, e.arriveCol);
    const g = groups.get(k) ?? { from: Number(from), to: Number(to), arrive: { row: e.arriveRow, col: e.arriveCol }, leaves: [] };
    g.leaves.push({ kind: e.kind, row: e.row ?? null, col: e.col ?? null, direction: e.direction ?? null });
    groups.set(k, g);
  }
  return [...groups.values()].map(g => ({ ...g, name: `${from}->${to}@r${g.arrive.row}c${g.arrive.col}` }));
}

/** The doors between two rooms, both ways. */
export function doorsBetween(a, b, opts = {}) {
  return [...doorsInto(a, b, opts), ...doorsInto(b, a, opts)];
}

/** The walkable squares of `room` connected (4-way) to `at`. */
export function partOf(room, at, { map = loadMap() } = {}) {
  const r = map.rooms[String(room)];
  if (!r?.roo) throw new Error(`no geometry for room ${room}`);
  const g = RoomGeometry.fromJSON(r.roo);
  const part = new Set([key(at.row, at.col)]), queue = [[at.row, at.col]];
  while (queue.length) {
    const [row, col] = queue.pop();
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(row + dr, col + dc);
      if (part.has(k) || !g.walkable(row + dr, col + dc)) continue;
      part.add(k); queue.push([row + dr, col + dc]);
    }
  }
  return { part, geometry: g };
}

/**
 * Posts around a door's landing square, nearest first: walkable, in the same connected part, never an exit
 * square (standing on one leaves the room), and never the landing square itself (the arrival lands there;
 * a body on it is in the way of the very thing we are waiting for, and the operator's standing order is
 * that a lockdown never blocks a door). `radius` in squares, default 2 -- melee reach is 2-3 squares.
 */
export function postsAround(door, { map = loadMap(), radius = 2, keepClear = 0 } = {}) {
  const room = map.rooms[String(door.to)];
  const exits = new Set(exitsOf(room).filter(e => e.row != null).map(e => key(e.row, e.col)));
  const { part } = partOf(door.to, door.arrive, { map });
  const out = [];
  for (let dr = -radius; dr <= radius; dr++) for (let dc = -radius; dc <= radius; dc++) {
    const p = { row: door.arrive.row + dr, col: door.arrive.col + dc };
    const k = key(p.row, p.col);
    if (!part.has(k) || exits.has(k) || cheb(p, door.arrive) <= keepClear) continue;
    out.push({ ...p, distance: Math.hypot(dr, dc) });
  }
  return out.sort((x, y) => x.distance - y.distance || x.row - y.row || x.col - y.col);
}

/**
 * Hand out guards to the doors between two rooms: round-robin across doors (so every door is covered before
 * any gets a second guard), each guard to the nearest free post of its door. Returns
 * [{ guard, door: name, room, row, col, approach: { room, row, col } }]. `approach` is the square in the
 * OTHER room that leads onto the door -- walking there first and then through is how a split room's right
 * half is reached (the cv-east-stairs lesson).
 */
export function assignPosts(guards, doors, { map = loadMap(), radius = 2, keepClear = 0 } = {}) {
  const posts = doors.map(d => postsAround(d, { map, radius, keepClear }));
  const taken = new Set(), out = [];
  let i = 0;
  for (const guard of guards) {
    let placed = false;
    for (let tries = 0; tries < doors.length && !placed; tries++, i++) {
      const di = i % doors.length, d = doors[di];
      const p = posts[di].find(q => !taken.has(`${d.to}:${key(q.row, q.col)}`));
      if (!p) continue;
      taken.add(`${d.to}:${key(p.row, p.col)}`);
      const leave = d.leaves.find(l => l.row != null) ?? null;
      out.push({ guard, door: d.name, room: d.to, row: p.row, col: p.col,
        approach: leave ? { room: d.from, row: leave.row, col: leave.col } : { room: d.from } });
      placed = true;
    }
    if (!placed) out.push({ guard, door: null, room: null, row: null, col: null, approach: null, why: 'no free post' });
  }
  return out;
}
