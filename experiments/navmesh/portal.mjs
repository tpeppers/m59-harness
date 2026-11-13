// Experimental, conservative polygon/portal baseline. No runtime navigation imports this.
// All points and distances are CLIENT/BSP units (1024 per square), named {x,y}.
// BSP leaves are not clearance-eroded navigation polygons: samples can miss a valid
// crossing, especially in thin partitions. A negative query is therefore UNKNOWN,
// while every returned chord is proved by the existing collision tracer.

const EPS = 0.05;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const finite = p => Number.isFinite(p?.x) && Number.isFinite(p?.y);
const cross = (ax, ay, bx, by) => ax * by - ay * bx;
const copy = p => ({ x: p.x, y: p.y });
const wire = p => ({ x: Math.round(p.x / 16) * 16, y: Math.round(p.y / 16) * 16 });
const chordSteps = (a, b) => Math.max(1, Math.ceil(distance(a, b) / 96));
const chordPoint = (a, b, i, n) => i === n ? copy(b) : wire({
  x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n });

// Emit exactly the points clear() checked. Simplified aims would let a follower
// choose a different rounded stepping sequence and hit a wall beside this one.
function provedPoints(aims) {
  if (!aims.length) return [];
  const points = [copy(aims[0])];
  for (let j = 1; j < aims.length; j++) {
    const a = aims[j - 1], b = aims[j], n = chordSteps(a, b);
    for (let i = 1; i <= n; i++) {
      const p = chordPoint(a, b, i, n), previous = points.at(-1);
      if (p.x !== previous.x || p.y !== previous.y) points.push(p);
    }
  }
  return points;
}

function inside(point, polygon) {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const z = cross(b.x - a.x, b.y - a.y, point.x - a.x, point.y - a.y);
    const length = distance(a, b);
    if (Math.abs(z) <= EPS * length) continue;
    const s = Math.sign(z);
    if (sign && sign !== s) return false;
    sign = s;
  }
  return true;
}

function overlap(e, f) {
  if (e.maxX < f.minX - EPS || f.maxX < e.minX - EPS
      || e.maxY < f.minY - EPS || f.maxY < e.minY - EPS) return null;
  const ux = (e.b.x - e.a.x) / e.length, uy = (e.b.y - e.a.y) / e.length;
  if (Math.abs(cross(ux, uy, f.a.x - e.a.x, f.a.y - e.a.y)) > EPS
      || Math.abs(cross(ux, uy, f.b.x - e.a.x, f.b.y - e.a.y)) > EPS) return null;
  const s = (f.a.x - e.a.x) * ux + (f.a.y - e.a.y) * uy;
  const t = (f.b.x - e.a.x) * ux + (f.b.y - e.a.y) * uy;
  const lo = Math.max(0, Math.min(s, t)), hi = Math.min(e.length, Math.max(s, t));
  if (hi - lo <= 1) return null;
  return { a: { x: e.a.x + ux * lo, y: e.a.y + uy * lo },
    b: { x: e.a.x + ux * hi, y: e.a.y + uy * hi }, length: hi - lo };
}

// Approach a portal from the polygon's interior. Several interior depths are
// retained because a BSP partition can be much thinner than a player's radius.
function approach(point, polygon, amount) {
  const dx = polygon.center.x - point.x, dy = polygon.center.y - point.y;
  const length = Math.hypot(dx, dy);
  if (length <= EPS) return null;
  const travel = Math.min(amount, length * 0.5);
  const p = wire({ x: point.x + dx / length * travel, y: point.y + dy / length * travel });
  return inside(p, polygon.points) ? p : null;
}

class Heap {
  constructor() { this.items = []; }
  get length() { return this.items.length; }
  push(value) {
    const a = this.items; let i = a.length; a.push(value);
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= value.f) break; a[i] = a[p]; i = p; }
    a[i] = value;
  }
  pop() {
    const a = this.items, first = a[0], last = a.pop();
    if (a.length) {
      let i = 0;
      while (2 * i + 1 < a.length) {
        let j = 2 * i + 1;
        if (j + 1 < a.length && a[j + 1].f < a[j].f) j++;
        if (last.f <= a[j].f) break;
        a[i] = a[j]; i = j;
      }
      a[i] = last;
    }
    return first;
  }
}

export function buildPortalPlanner(geo) {
  const started = performance.now();
  if (!geo?.collisionReady || typeof geo.traceFineMoveClient !== 'function')
    throw new Error('Portal planner requires complete collision geometry');
  const polygons = [], byLeaf = new Map(), edges = [], nodes = [];
  for (const leaf of geo.leaves ?? []) {
    const points = (leaf.polygon ?? []).map(p => Array.isArray(p) ? { x: p[0], y: p[1] } : copy(p));
    if (points.length < 3 || !points.every(finite)) continue;
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length]; area += cross(a.x, a.y, b.x, b.y);
    }
    if (Math.abs(area) <= EPS) continue;
    const center = { x: points.reduce((s, p) => s + p.x, 0) / points.length,
      y: points.reduce((s, p) => s + p.y, 0) / points.length };
    const polygon = { id: polygons.length, leaf, points, center, nodes: [] };
    polygons.push(polygon); byLeaf.set(leaf, polygon);
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length], length = distance(a, b);
      if (length <= EPS) continue;
      edges.push({ a, b, length, polygon,
        minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) });
    }
  }
  edges.sort((a, b) => a.minX - b.minX);
  let sharedBoundaries = 0, samplePairs = 0;
  const duplicates = new Set();
  const add = (point, polygon) => {
    const node = { id: nodes.length, point, polygon, crossing: [] };
    nodes.push(node); polygon.nodes.push(node.id); return node;
  };
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    for (let j = i + 1; j < edges.length && edges[j].minX <= e.maxX + EPS; j++) {
      const f = edges[j]; if (e.polygon === f.polygon) continue;
      const common = overlap(e, f); if (!common) continue;
      const idA = Math.min(e.polygon.id, f.polygon.id), idB = Math.max(e.polygon.id, f.polygon.id);
      const segmentKey = [idA, idB, common.a.x, common.a.y, common.b.x, common.b.y]
        .map(v => Math.round(v * 100)).join(':');
      if (duplicates.has(segmentKey)) continue;
      duplicates.add(segmentKey); sharedBoundaries++;
      const fractions = common.length > 2048 ? [0.1, 0.25, 0.5, 0.75, 0.9] : [0.2, 0.5, 0.8];
      for (const t of fractions) {
        const p = { x: common.a.x + (common.b.x - common.a.x) * t,
          y: common.a.y + (common.b.y - common.a.y) * t };
        // A deeper approach is useful when the trace rejects a sub-minimum move.
        // Both are candidates; neither implies that passage is physically allowed.
        for (const amount of [128, 384]) {
          const a = approach(p, e.polygon, amount), b = approach(p, f.polygon, amount);
          if (!a || !b || distance(a, b) <= EPS) continue;
          const na = add(a, e.polygon), nb = add(b, f.polygon);
          na.crossing.push(nb.id); nb.crossing.push(na.id); samplePairs++;
        }
      }
    }
  }
  const stats = { algorithm: 'sampled BSP polygon portals', polygons: polygons.length,
    polygonEdges: edges.length, sharedBoundaries, samplePairs, nodes: nodes.length,
    buildMs: performance.now() - started,
    limitation: 'Finite portal samples may miss valid passages; no mesh erosion, jump links or live executor changes.' };

  function query(from, to, options = {}) {
    const began = performance.now(), maxMs = options.maxMs ?? 4000, maxNodes = options.maxNodes ?? 20000;
    let checkedEdges = 0, expanded = 0, exhausted = false;
    const deadline = began + maxMs;
    const finish = (found, reason, waypoints = []) => {
      const aimWaypoints = waypoints.length;
      if (found) waypoints = provedPoints(waypoints);
      let length = 0; for (let i = 1; i < waypoints.length; i++) length += distance(waypoints[i - 1], waypoints[i]);
      return { found, reason, waypoints, points: waypoints, aim_waypoints: aimWaypoints, length: found ? length : null,
        nodes: expanded, checkedEdges, ms: performance.now() - began, method: stats.algorithm,
        ...(!found ? { complete: false } : {}) };
    };
    if (!finite(from) || !finite(to)) return finish(false, 'invalid_endpoint');
    const traceOptions = { slide: false, obstacles: options.obstacles ?? [],
      roomFlags: options.roomFlags ?? 0, overrideDepths: options.overrideDepths ?? null };
    const avoid = options.avoidSquares instanceof Set ? options.avoidSquares : new Set(options.avoidSquares ?? []);
    const allowed = p => {
      const row = Math.floor(p.y / 1024) + 1, col = Math.floor(p.x / 1024) + 1;
      if (avoid.has(`${row},${col}`)) return false;
      if (Number.isFinite(options.minimumFloor)) {
        const leaf = geo.leafAtClient(p.x, p.y);
        const h = leaf?.sector ? geo.floorBaseAtClient(p.x, p.y, leaf,
          { roomFlags: traceOptions.roomFlags, overrideDepths: traceOptions.overrideDepths }) : null;
        if (!Number.isFinite(h) || h < options.minimumFloor) return false;
      }
      return true;
    };
    const clear = (a, b) => {
      // Nodes are quantized to exact wire positions during graph construction.
      // Retain the true starting pose; prove every subsequent packet-sized chord.
      // 96-unit sampling leaves room for rounding while staying below 128 units.
      const n = chordSteps(a, b);
      let previous = a;
      for (let i = 1; i <= n; i++) {
        if (performance.now() >= deadline) { exhausted = true; return false; }
        const point = chordPoint(a, b, i, n);
        if (!allowed(point)) return false;
        if (point.x === previous.x && point.y === previous.y && i !== n) continue;
        checkedEdges++;
        const t = geo.traceFineMoveClient(previous.x, previous.y, point.x, point.y, traceOptions);
        if (t?.available === false || t?.arrived !== true || t?.blocked === true
            || !finite(t) || distance(t, point) > EPS) return false;
        previous = point;
      }
      return true;
    };
    if (clear(from, to)) return finish(true, null, [copy(from), copy(to)]);
    if (exhausted) return finish(false, 'portal_search_budget');
    const leafPolygon = p => {
      const leaf = geo.leafAtClient(p.x, p.y);
      return byLeaf.get(leaf) ?? polygons.find(q => q.leaf.node === leaf?.node);
    };
    const fromPolygon = leafPolygon(from), toPolygon = leafPolygon(to);
    if (!fromPolygon || !toPolygon) return finish(false, 'endpoint_polygon_unavailable');
    const startId = nodes.length, goalId = startId + 1;
    const get = id => id === startId ? { id, point: from, polygon: fromPolygon, crossing: [] }
      : id === goalId ? { id, point: to, polygon: toPolygon, crossing: [] } : nodes[id];
    const open = new Heap(), best = new Map([[startId, 0]]), parents = new Map(), tested = new Map();
    open.push({ id: startId, g: 0, f: distance(from, to) });
    while (open.length && expanded < maxNodes) {
      if (exhausted || performance.now() >= deadline) return finish(false, 'portal_search_budget');
      const state = open.pop(); if (state.g !== best.get(state.id)) continue;
      expanded++;
      if (state.id === goalId) {
        const raw = []; let id = goalId;
        while (id !== undefined) { raw.push(copy(get(id).point)); id = parents.get(id); }
        raw.reverse();
        // Pull only chords the exact current tracer accepts. The graph route remains
        // useful if the optional shortcut allowance is exhausted.
        const pulled = [raw[0]];
        for (let i = 0; i < raw.length - 1;) {
          let j = i + 1;
          for (let k = raw.length - 1; k > j && performance.now() - began < maxMs; k--)
            if (clear(raw[i], raw[k])) { j = k; break; }
          pulled.push(raw[j]); i = j;
        }
        return finish(true, null, pulled);
      }
      const node = get(state.id), candidates = [...node.polygon.nodes, ...node.crossing];
      if (node.polygon === toPolygon) candidates.push(goalId);
      for (const id of candidates) {
        if (exhausted || performance.now() >= deadline) return finish(false, 'portal_search_budget');
        if (id === state.id) continue;
        const next = get(id), g = state.g + distance(node.point, next.point);
        if (g >= (best.get(id) ?? Infinity)) continue;
        const key = `${state.id}>${id}`;
        let allowed = tested.get(key);
        if (allowed === undefined) { allowed = clear(node.point, next.point); tested.set(key, allowed); }
        if (!allowed) continue;
        best.set(id, g); parents.set(id, state.id);
        open.push({ id, g, f: g + distance(next.point, to) });
      }
    }
    return finish(false, exhausted ? 'portal_search_budget' : open.length ? 'portal_node_budget' : 'sampled_portal_graph_disconnected');
  }
  return { query, stats };
}
