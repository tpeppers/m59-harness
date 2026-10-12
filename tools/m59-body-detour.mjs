// Bounded local A* around live bodies. All points/distances are KOD (64/square).
// Use the same wall/body microstep trace as the mover; send-time validation still owns packets.
import { blocksMovement } from './m59-parse.mjs';
import { protocolToClient, protocolToward } from './m59-roo.mjs';

export function blockingBodySnapshot(objects, selfId) {
  return [...(objects?.values?.() ?? [])].filter(o => o.id !== selfId && blocksMovement(o.flags ?? 0)
    && Number.isFinite(o.x) && Number.isFinite(o.y))
    .map(o => ({ id: o.id, x: protocolToClient(o.x), y: protocolToClient(o.y) }));
}

export function planBodyDetour(geo, from, goal, { objects, selfId, roomFlags = 0,
  overrideDepths = null, avoidSquares = null, maxNodes = 768, maxMs = 35, now = performance.now.bind(performance) } = {}) {
  if (!geo?.collisionReady || typeof geo.traceFineMoveClient !== 'function')
    return { found: false, reason: 'collision_geometry_unavailable' };
  if (![from?.x, from?.y, goal?.x, goal?.y].every(Number.isFinite))
    return { found: false, reason: 'own_position_unknown' };
  if (Math.max(Math.abs(goal.x - from.x), Math.abs(goal.y - from.y)) > 8 * 64)
    return { found: false, reason: 'body detour exceeds local bounds' };
  const obstacles = blockingBodySnapshot(objects, selfId), startTime = now(), spacing = 8;
  const bounds = { minX: Math.min(from.x, goal.x) - 128, maxX: Math.max(from.x, goal.x) + 128,
    minY: Math.min(from.y, goal.y) - 128, maxY: Math.max(from.y, goal.y) + 128 };
  const key = p => `${Math.round((p.x - from.x) / spacing)},${Math.round((p.y - from.y) / spacing)}`;
  const allowed = p => p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY
    && !avoidSquares?.has?.(`${Math.floor(p.y / 64)},${Math.floor(p.x / 64)}`);
  const edge = (a, b) => {
    if (!allowed(b)) return null;
    const samples = Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/spacing));
    for (let i=1;i<samples;i++) if (!allowed({x:a.x+(b.x-a.x)*i/samples,y:a.y+(b.y-a.y)*i/samples})) return null;
    const t = geo.traceFineMoveClient(protocolToClient(a.x), protocolToClient(a.y),
      protocolToClient(b.x), protocolToClient(b.y), { slide: false, obstacles, roomFlags, overrideDepths });
    if (!t?.moved || t.reason === 'object_blocked' || t.available === false) return null;
    const p = { x: protocolToward(t.x, a.x), y: protocolToward(t.y, a.y) };
    return Math.hypot(p.x - b.x, p.y - b.y) <= 1 && allowed(p) ? p : null;
  };
  const open = [{ ...from, g: 0, f: Math.hypot(goal.x - from.x, goal.y - from.y) }];
  const best = new Map([[key(from), 0]]), parents = new Map();
  let nodes = 0;
  while (open.length && nodes < maxNodes) {
    if (now() - startTime >= maxMs) return { found: false, reason: 'body detour budget exhausted', nodes };
    open.sort((a, b) => b.f - a.f); const cur = open.pop(), ck = key(cur);
    if (cur.g > best.get(ck)) continue;
    nodes++;
    // Only try the exact goal within one lattice edge; never tunnel through a crowd.
    const end = Math.hypot(goal.x - cur.x, goal.y - cur.y) <= spacing * Math.SQRT2
      ? edge(cur, goal) : null;
    if (end || Math.hypot(cur.x - goal.x, cur.y - goal.y) <= 1) {
      const waypoints = end ? [end] : [];
      for (let p = cur; parents.has(key(p)); p = parents.get(key(p))) waypoints.push({ x: p.x, y: p.y });
      waypoints.reverse();
      // Keep proved bends, not every eight-unit lattice point. Otherwise a tiny
      // sidestep pays a separate paced/confirmed packet for every search edge.
      const pulled = []; let at = from;
      for (let i = 0; i < waypoints.length;) {
        let last = i;
        for (let j = i + 1; j < waypoints.length && now() - startTime < maxMs; j++) {
          if (Math.hypot(waypoints[j].x - at.x,waypoints[j].y - at.y) > 64) break;
          if (!edge(at,waypoints[j])) break;
          last = j;
        }
        at = waypoints[last]; pulled.push(at); i = last + 1;
      }
      return { found: true, waypoints: pulled, nodes, bodies: obstacles.length };
    }
    for (const dx of [-spacing, 0, spacing]) for (const dy of [-spacing, 0, spacing]) {
      if (!dx && !dy) continue;
      const p = edge(cur, { x: cur.x + dx, y: cur.y + dy }); if (!p) continue;
      const pk = key(p), g = cur.g + Math.hypot(p.x - cur.x, p.y - cur.y);
      if (g >= (best.get(pk) ?? Infinity)) continue;
      best.set(pk, g); parents.set(pk, cur);
      open.push({ ...p, g, f: g + Math.hypot(goal.x - p.x, goal.y - p.y) });
    }
  }
  return { found: false, reason: open.length ? 'body detour budget exhausted' : 'no clear local body route', nodes };
}
