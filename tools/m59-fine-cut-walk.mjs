// A WALK INSIDE ONE ROOM, CUT ON THE FINE GRID FROM WHERE THE BODY STANDS, CHECKED BEFORE ANYTHING MOVES.
//
// The square walker (walk_to) re-plans on coarse squares, and on interesting ground that is a false summary. Measured
// in Ukgoth (599), 2026-10-20, with the red-alert lockdown moved there: the recall lands everyone on the room-2
// entrance square r2c27, which sits on the room's north edge, and walk_to legs from it stepped Rowlf straight back over
// the edge into room 2, while Kermit's never moved off r5c13. The node tour already had the answer for The Badlands:
// cutTourWalk floods the mover's own geometry from the body's exact fine position to a target square, every edge
// proved, and fineclimb then walks those exact points. This is that half on its own, for any square in any room.
//
// planFineCutWalk(geo, from, to) -> { ok, why, route, check, points }
//   geo   roomGeometry(room)          from  { x, y } in CLIENT units (tourPosition's x_client / y_client)
//   to    { row, col } (or rNcM)      route a one-leg 'to_node' route in the noderails shape fineclimb follows
//
// Only the plan is here, pure and offline. tools/fleetscripts/ukgoth-walk.mjs is the errand that follows it.
import { edgeOf, floorAt } from './m59-ground.mjs';
import { cutTourWalk } from './m59-node-tour.mjs';
import { railLeg, checkRoute } from './m59-noderails.mjs';

export const SQUARE_CLIENT = 1024;
export function parseSquare(v) {
  if (v && typeof v === 'object' && Number.isInteger(v.row) && Number.isInteger(v.col)) return { row: v.row, col: v.col };
  const m = /^r(\d+)c(\d+)$/i.exec(String(v ?? '').trim());
  if (!m) throw Error(`not a square: ${JSON.stringify(v)} (want rNcM)`);
  return { row: Number(m[1]), col: Number(m[2]) };
}
// The centre of a coarse square, in client units: row is y and col is x, one square of margin less on the wire.
export const squareCentreClient = ({ row, col }) => ({ x: (col - 1) * SQUARE_CLIENT + SQUARE_CLIENT / 2, y: (row - 1) * SQUARE_CLIENT + SQUARE_CLIENT / 2 });

export function planFineCutWalk(geo, from, toSquare, { room = geo?.room ?? null } = {}) {
  const to = parseSquare(toSquare);
  if (!geo || !(to.row >= 1 && to.row <= geo.rows && to.col >= 1 && to.col <= geo.cols))
    return { ok: false, why: `r${to.row}c${to.col} is outside the room` };
  if (!Number.isFinite(from?.x) || !Number.isFinite(from?.y)) return { ok: false, why: 'no fine position for the body' };
  const target = { kind: 'cut', room, ...to, ...squareCentreClient(to) };
  const { proof, points } = cutTourWalk(geo, from, target);
  if (!points) return { ok: false, why: proof?.why ?? 'no cut', proof };
  const edge = edgeOf(geo);
  const walk = railLeg({ waypoints: points }, { edge, bounds: { w: geo.cols * SQUARE_CLIENT, h: geo.rows * SQUARE_CLIENT }, floorAt: (x, y) => floorAt(geo, x, y) });
  const sq = p => `r${Math.floor(p.y / SQUARE_CLIENT) + 1}c${Math.floor(p.x / SQUARE_CLIENT) + 1}`;
  const route = { ok: true, rail_complete: walk.unvalidated === 0, direction: 'to_node', exit: 'body-cut', exit_label: 'body-cut',
    from: sq(from), to: `r${to.row}c${to.col}`, legs: [walk], jumps: 0, all_declared: true, waypoints: walk.waypoints.length,
    confidence: 'body-seeded exact-endpoint walk, checked before following' };
  const check = checkRoute(route, { edge });
  if (!check.ok || check.skipped || !route.rail_complete) return { ok: false, why: 'the cut did not check', check, route, points };
  return { ok: true, why: null, route, check, points };
}
// The rail file fineclimb reads, holding just this one route under the stone name 'cut'.
export const cutRailFile = (room, route) => ({ stones: [{ node: 'cut', room, routes: [route] }] });
