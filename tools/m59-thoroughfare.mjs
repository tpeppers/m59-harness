// A THOROUGHFARE IS NOT A SEAT. Which squares are passages, and how an idle body gets out of one.
//
// East Jasper (350), 2026-10-16. The stairs from West Jasper land at r51c28, inside a tunnel
// r51c27..c33 that is one mover step wide and the only way between the two halves of the town.
// `nearestSafeSpot` scored r51c28 the best safe wall in the room — `can_reach_you: 0`, which is
// true of every square in a pipe, because nothing can stand beside you there. So every idle
// character that settled to rest in East Jasper walked INTO the tunnel and sat in it. Scooter
// did; Fozzie, travelling east to 568, then stood behind him for forty-five minutes, retrying
// "taking the exit as the nearest wall" every two minutes. The walker's whole body ladder
// (queue, sidestep, lane, perp walk) assumes the blocker is going somewhere, and an idle one is
// not: in a pipe there is no side, and the body in it never moves.
//
// The pocket-rail book (`fineChokesFor`) already refuses recorded chokes, but only the ones
// somebody recorded. This is the geometric answer, and it needs no book: a square is a CHOKE
// when its open neighbours cannot reach one another, within a few squares, without passing
// through it. A dead-end alcove is not one (one opening), nor is a corner seat (its openings
// touch each other); the middle of a corridor is.
//
// Two uses, both narrow on purpose:
//   - `restingSquare` asks `nearestSafeSpot` to skip chokes (`avoidChokes`). Combat walls are
//     untouched: a corridor square with two approaches is a fine place to FIGHT from, and
//     changing what the fleet fights from is not what this fixes.
//   - an IDLE keeper standing in a choke with another player within two squares walks out to
//     open ground, away from that player (`thoroughfareYield`). That covers the body already
//     parked there, and the stair landing, which puts every arrival inside the tunnel.

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
const FINE = 64;

function stepper(geo) {
  if (!geo || typeof geo.moverStepLands !== 'function') return null;
  return (r0, c0, r1, c1) => {
    try { return geo.moverStepLands(r0, c0, r1, c1) === true; } catch { return false; }
  };
}

export function openNeighbours(geo, row, col, lands = stepper(geo)) {
  if (!lands) return [];
  const out = [];
  for (const [dr, dc] of DIRS) if (lands(row, col, row + dr, col + dc)) out.push({ row: row + dr, col: col + dc });
  return out;
}

/**
 * Is (row, col) a choke: do its open neighbours fall into more than one group when the square
 * itself is removed, searching no further than `radius` squares from it?
 *
 * The radius is what makes this LOCAL. A tunnel whose two ends meet again on the far side of a
 * building is still a tunnel to the two bodies in it; a loop that closes within three squares
 * is a doorway with room to step round.
 */
export function isChokeSquare(geo, row, col, { radius = 3, cache = null } = {}) {
  const k = `${row},${col}`;
  if (cache?.has(k)) return cache.get(k);
  const lands = stepper(geo);
  const answer = (() => {
    if (!lands) return false;
    const open = openNeighbours(geo, row, col, lands);
    if (open.length < 2) return false;
    const key = p => `${p.row},${p.col}`;
    const near = p => Math.max(Math.abs(p.row - row), Math.abs(p.col - col)) <= radius;
    const seen = new Set([key(open[0]), k]);
    const queue = [open[0]];
    while (queue.length) {
      const p = queue.shift();
      for (const [dr, dc] of DIRS) {
        const q = { row: p.row + dr, col: p.col + dc };
        const qk = key(q);
        if (seen.has(qk) || !near(q) || !lands(p.row, p.col, q.row, q.col)) continue;
        seen.add(qk); queue.push(q);
      }
    }
    return open.some(p => !seen.has(key(p)));
  })();
  cache?.set(k, answer);
  return answer;
}

/**
 * Where an idle body standing in a choke should go so the player beside it can pass.
 *
 *   me       { row, col, x, y } — x/y in kod fine units (64 to the square)
 *   players  bodies to make way for: { row, col, x, y }; anything else is ignored
 *
 * Returns null when there is nothing to do (not in a choke, nobody within `near` squares, or
 * no open ground within `maxDepth` steps), else `{ to: {row, col}, path, steps, from_player }`.
 *
 * The search never steps toward a player that is within one and a half squares — in a pipe
 * that body IS the wall in that direction, and the client refuses a move that closes on a body
 * inside its no-move-on square anyway — and never enters a square a player stands on. The goal
 * is a square that is not a choke and touches none, so the body ends up beside the passage's
 * mouth rather than plugging it from the outside.
 */
export function thoroughfareYield(geo, me, players, { near = 2, maxDepth = 12, radius = 3 } = {}) {
  const lands = stepper(geo);
  if (!lands || !me || !Number.isFinite(me.row) || !Number.isFinite(me.col)) return null;
  const pos = p => ({ x: Number.isFinite(p.x) ? p.x : p.col * FINE + FINE / 2,
                      y: Number.isFinite(p.y) ? p.y : p.row * FINE + FINE / 2 });
  const here = pos(me);
  const others = (players ?? []).filter(p => p && Number.isFinite(p.row) && Number.isFinite(p.col));
  const close = others.filter(p => Math.max(Math.abs(p.row - me.row), Math.abs(p.col - me.col)) <= near);
  if (!close.length) return null;
  const cache = new Map();
  const choke = (r, c) => isChokeSquare(geo, r, c, { radius, cache });
  if (!choke(me.row, me.col)) return null;

  const key = (r, c) => `${r},${c}`;
  const occupied = new Set(others.map(p => key(p.row, p.col)));
  occupied.delete(key(me.row, me.col));
  // Bodies that are the wall in their own direction: within a square and a half, fine units.
  const walls = close.map(pos).filter(p => Math.hypot(p.x - here.x, p.y - here.y) <= FINE * 1.5);
  const towardAWall = (r, c) => walls.some(w => {
    const dx = (c * FINE + FINE / 2) - here.x, dy = (r * FINE + FINE / 2) - here.y;
    return dx * (w.x - here.x) + dy * (w.y - here.y) > 0;
  });
  // Clear of the passage if we can; merely out of it if that is all there is (a stair landing
  // at a tunnel's dead end has no open ground behind it, but the yard beside it is off the line).
  const strict = (r, c) => !choke(r, c)
    && openNeighbours(geo, r, c, lands).every(n => !choke(n.row, n.col));
  const loose = (r, c) => !choke(r, c);
  for (const goal of [strict, loose]) {
    const found = searchOut(geo, lands, me, goal, { occupied, towardAWall, maxDepth });
    if (!found) continue;
    const nearest = close.reduce((a, b) =>
      Math.hypot(pos(a).x - here.x, pos(a).y - here.y) <= Math.hypot(pos(b).x - here.x, pos(b).y - here.y) ? a : b);
    return { ...found, clear: goal === strict, from_player: { row: nearest.row, col: nearest.col } };
  }
  return null;
}

function searchOut(geo, lands, me, goal, { occupied, towardAWall, maxDepth }) {
  const key = (r, c) => `${r},${c}`;
  const prev = new Map([[key(me.row, me.col), null]]);
  let frontier = [{ row: me.row, col: me.col }];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const p of frontier) {
      for (const [dr, dc] of DIRS) {
        const r = p.row + dr, c = p.col + dc, k = key(r, c);
        if (prev.has(k) || occupied.has(k) || !lands(p.row, p.col, r, c)) continue;
        if (depth === 1 && towardAWall(r, c)) continue;
        prev.set(k, key(p.row, p.col));
        if (goal(r, c)) {
          const path = [];
          for (let at = k; at; at = prev.get(at)) {
            const [pr, pc] = at.split(',').map(Number);
            path.unshift({ row: pr, col: pc });
          }
          path.shift();
          return { to: { row: r, col: c }, path, steps: path.length };
        }
        next.push({ row: r, col: c });
      }
    }
    frontier = next;
  }
  return null;
}
