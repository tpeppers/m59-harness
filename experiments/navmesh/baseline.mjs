// In-process adapter over the current production fine-route search. Inputs and
// returned waypoints are CLIENT/BSP coordinates; avoidSquares uses row,col keys
// and minimumFloor is a CLIENT height. No worker startup is included here.
import { clientToProtocol } from '../../tools/m59-roo.mjs';
import { floorConstraintAllows } from '../../tools/m59-body-detour.mjs';
import { findFineGuide } from '../../tools/m59-fine-guides.mjs';
import { cutRail, chordWalkable } from '../../tools/m59-railcut.mjs';

export function currentFineQuery(geo, fromClient, goalClient, {
  obstacles = [], avoidSquares = [], minimumFloor = null,
  roomFlags = 0, maxMs = 10000
} = {}) {
  if (!geo?.collisionReady || ![fromClient?.x, fromClient?.y, goalClient?.x, goalClient?.y].every(Number.isFinite)) {
    return { found: false, waypoints: [], reason: 'collision_geometry_or_endpoint_unavailable', visited: 0,
      guide: null, bridgeOk: false, goalBridgeOk: false };
  }
  const avoided = new Set(avoidSquares);
  const allowed = b => !avoided.has(`${Math.floor(clientToProtocol(b.y) / 64)},${Math.floor(clientToProtocol(b.x) / 64)}`)
    && floorConstraintAllows(geo, { x: clientToProtocol(b.x), y: clientToProtocol(b.y) }, minimumFloor);
  const traceEdge = withBodies => (a, b) => {
    if (!allowed(b)) return false;
    const trace = geo.traceFineMoveClient(a.x, a.y, b.x, b.y, {
      slide: false, roomFlags, ...(withBodies ? { obstacles } : {})
    });
    return trace?.arrived === true && trace.blocked !== true;
  };
  const edge = traceEdge(true), geometryEdge = traceEdge(false);
  const settings = {
    bounds: { w: geo.cols * 1024, h: geo.rows * 1024 }, lattice: 128, maxMs,
    floorAt: (x, y) => {
      const leaf = geo.leafAtClient(x, y);
      return leaf?.sector ? geo.floorBaseAtClient(x, y, leaf) : null;
    }
  };
  // Match fine-rail.mjs cut worker: a current-geometry guide is preferred only
  // when its entire retained route also clears the captured blocking bodies.
  const baked = findFineGuide(geo, fromClient, goalClient, { edge: geometryEdge });
  const clearBaked = baked && baked.waypoints.slice(1).every((p, i) => edge(baked.waypoints[i], p));
  const cut = clearBaked ? baked : cutRail(fromClient, goalClient, { ...settings, edge });
  const base = { visited: cut.visited ?? 0, guide: clearBaked ? (baked.guide ?? true) : null,
    bridge: cut.bridge ?? 0, bridgeOk: cut.bridgeOk === true };
  if (!cut.ok || !cut.bridgeOk || cut.partial || !cut.waypoints?.length) {
    return { ...base, found: false, waypoints: [], reason: cut.why ?? 'fine_route_not_complete', goalBridgeOk: false };
  }
  // cutRail intentionally ends on its snapped target. Apply the same explicit
  // endpoint-completion requirement used by the comparison's other planner;
  // this is one checked bridge, not a new search or a refuge-prefix fallback.
  const waypoints = cut.waypoints.map(p => ({ ...p }));
  const end = waypoints.at(-1), gap = Math.hypot(end.x - goalClient.x, end.y - goalClient.y);
  if (gap > 0 && (!edge(end, goalClient) || !chordWalkable(end, goalClient, { edge, lattice: 128 }).ok)) {
    return { ...base, found: false, waypoints: [], reason: 'fine_route_exact_goal_bridge_unproved', goalBridgeOk: false };
  }
  if (gap > 0) waypoints.push({ ...goalClient });
  return { ...base, found: true, waypoints, reason: null, goalBridgeOk: true };
}
