// Bounded local A* around live bodies. All points/distances are KOD (64/square).
// Use the same wall/body microstep trace as the mover; send-time validation still owns packets.
import { blocksMovement } from './m59-parse.mjs';
import { protocolToClient, protocolToward } from './m59-roo.mjs';

export function blockingBodySnapshot(objects, selfId) {
  return [...(objects?.values?.() ?? [])].filter(o => o.id !== selfId && blocksMovement(o.flags ?? 0)
    && Number.isFinite(o.x) && Number.isFinite(o.y))
    .map(o => ({ id: o.id, x: protocolToClient(o.x), y: protocolToClient(o.y) }));
}

// Points are KOD wire units; the minimum height is in CLIENT geometry units.
export function floorConstraintAllows(geo,p,minimumFloor){
  if(!Number.isFinite(minimumFloor))return true;
  const x=protocolToClient(p.x),y=protocolToClient(p.y),leaf=geo.leafAtClient(x,y);
  const height=leaf?.sector?geo.floorBaseAtClient(x,y,leaf):null;
  return Number.isFinite(height)&&height>=minimumFloor;
}

export function planBodyDetour(geo, from, goal, { objects, selfId, roomFlags = 0,
  overrideDepths = null, avoidSquares = null, minimumFloor = null, goalSquare = null, marginSquares = 2, maxRangeSquares = 8, spacingUnits = 8, maxNodes = 768, maxMs = 35,
  threats = [], threatWeight = 0, threatRadius = 4, now = performance.now.bind(performance) } = {}) {
  if (!geo?.collisionReady || typeof geo.traceFineMoveClient !== 'function')
    return { found: false, reason: 'collision_geometry_unavailable' };
  if (![from?.x, from?.y, goal?.x, goal?.y].every(Number.isFinite))
    return { found: false, reason: 'own_position_unknown' };
  if (Math.max(Math.abs(goal.x - from.x), Math.abs(goal.y - from.y)) > Math.max(8, Math.min(24, maxRangeSquares)) * 64)
    return { found: false, reason: 'body detour exceeds local bounds' };
  const obstacles = blockingBodySnapshot(objects, selfId), startTime = now(), spacing = spacingUnits === 16 ? 16 : 8;
  const dangers=threats.map(t=>({x:Number.isFinite(t.x)?t.x:t.col*64+32,y:Number.isFinite(t.y)?t.y:t.row*64+32}))
    .filter(t=>Number.isFinite(t.x)&&Number.isFinite(t.y));
  const pressure=p=>threatWeight>0?dangers.reduce((cost,t)=>Math.max(cost,
    Math.max(0,1-Math.hypot(t.x-p.x,t.y-p.y)/(threatRadius*64))*threatWeight),0):0;
  const travelCost=(a,b)=>{
    const distance=Math.hypot(b.x-a.x,b.y-a.y);
    if(!(threatWeight>0)||!dangers.length)return distance;
    const samples=Math.max(1,Math.ceil(distance/spacing));let cost=0;
    for(let i=1;i<=samples;i++)cost+=pressure({x:a.x+(b.x-a.x)*i/samples,y:a.y+(b.y-a.y)*i/samples});
    return distance*(1+cost/samples);
  };
  // A square refuge accepts only a collision-proved point inside the square.
  // Invalid square descriptors retain the explicit fine-point contract.
  const squareGoal = Number.isInteger(goalSquare?.row) && Number.isInteger(goalSquare?.col)
    ? goalSquare : null;
  const margin = Math.max(2,Math.min(24,marginSquares))*64;
  const reached = p => squareGoal ? Math.floor(p.x/64)===squareGoal.col&&Math.floor(p.y/64)===squareGoal.row : Math.hypot(p.x-goal.x,p.y-goal.y)<=1;
  const distance = p => squareGoal ? Math.hypot(Math.max(squareGoal.col*64+1-p.x,0,p.x-(squareGoal.col+1)*64+1),Math.max(squareGoal.row*64+1-p.y,0,p.y-(squareGoal.row+1)*64+1)) : Math.hypot(goal.x-p.x,goal.y-p.y);
  const bounds = { minX: Math.min(from.x, goal.x) - margin, maxX: Math.max(from.x, goal.x) + margin,
    minY: Math.min(from.y, goal.y) - margin, maxY: Math.max(from.y, goal.y) + margin };
  const key = p => `${Math.round((p.x - from.x) / spacing)},${Math.round((p.y - from.y) / spacing)}`;
  const allowed = p => p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY
    && !avoidSquares?.has?.(`${Math.floor(p.y / 64)},${Math.floor(p.x / 64)}`)
    && floorConstraintAllows(geo,p,minimumFloor);
  const edge = (a, b) => {
    if (!allowed(b)) return null;
    const samples = Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/spacing));
    for (let i=1;i<samples;i++) if (!allowed({x:a.x+(b.x-a.x)*i/samples,y:a.y+(b.y-a.y)*i/samples})) return null;
    const t = geo.traceFineMoveClient(protocolToClient(a.x), protocolToClient(a.y),
      protocolToClient(b.x), protocolToClient(b.y), { slide: false, obstacles, roomFlags, overrideDepths });
    if (!t?.moved || t.blocked === true || t.reason === 'object_blocked' || t.available === false) return null;
    const p = { x: protocolToward(t.x, protocolToClient(a.x)), y: protocolToward(t.y, protocolToClient(a.y)) };
    if(Math.hypot(t.x-protocolToClient(b.x),t.y-protocolToClient(b.y))>0.01
        ||Math.hypot(p.x-b.x,p.y-b.y)>1||!allowed(p))return null;
    if(p.x!==b.x||p.y!==b.y){
      const exact=geo.traceFineMoveClient(protocolToClient(a.x),protocolToClient(a.y),protocolToClient(p.x),protocolToClient(p.y),
        {slide:false,obstacles,roomFlags,overrideDepths});
      if(!exact?.moved||exact.blocked===true||Math.hypot(exact.x-protocolToClient(p.x),exact.y-protocolToClient(p.y))>0.01)return null;
    }
    return p;
  };
  // The wider departure search can visit thousands of nodes. Keep its frontier
  // in a heap so sorting the entire frontier cannot spend the recovery budget.
  const open = []; let sequence=0;
  const precedes=(a,b)=>a.f<b.f||(a.f===b.f&&a.sequence>b.sequence);
  const push=p=>{p.sequence=sequence++;open.push(p);let i=open.length-1;while(i){const parent=(i-1)>>1;if(!precedes(open[i],open[parent]))break;[open[i],open[parent]]=[open[parent],open[i]];i=parent;}};
  const pop=()=>{const first=open[0],last=open.pop();if(open.length){open[0]=last;let i=0;for(;;){let next=i;for(const child of [2*i+1,2*i+2])if(child<open.length&&precedes(open[child],open[next]))next=child;if(next===i)break;[open[i],open[next]]=[open[next],open[i]];i=next;}}return first;};
  push({ ...from, g: 0, f: distance(from) });
  const best = new Map([[key(from), 0]]), parents = new Map();
  let nodes = 0;
  while (open.length && nodes < maxNodes) {
    if (now() - startTime >= maxMs) return { found: false, reason: 'body detour budget exhausted', nodes };
    const cur = pop(), ck = key(cur);
    if (cur.g > best.get(ck)) continue;
    nodes++;
    // Only try the exact goal within one lattice edge; never tunnel through a crowd.
    const end = Math.hypot(goal.x - cur.x, goal.y - cur.y) <= spacing * Math.SQRT2
      ? edge(cur, goal) : null;
    if (end || reached(cur)) {
      const waypoints = end ? [end] : [];
      for (let p = cur; parents.has(key(p)); p = parents.get(key(p))) waypoints.push({ x: p.x, y: p.y });
      waypoints.reverse();
      // Keep proved bends, not every eight-unit lattice point. Otherwise a tiny
      // sidestep pays a separate paced/confirmed packet for every search edge.
      const pulled = []; let at = from;
      for (let i = 0; i < waypoints.length;) {
        let last = i,originalCost=travelCost(at,waypoints[i]),previous=waypoints[i];
        for (let j = i + 1; j < waypoints.length && now() - startTime < maxMs; j++) {
          if (Math.hypot(waypoints[j].x - at.x,waypoints[j].y - at.y) > 64) break;
          originalCost+=travelCost(previous,waypoints[j]);previous=waypoints[j];
          const landed=edge(at,waypoints[j]);
          if (!landed||landed.x!==waypoints[j].x||landed.y!==waypoints[j].y) break;
          if(travelCost(at,waypoints[j])>originalCost+0.01)continue;
          last = j;
        }
        at = waypoints[last]; pulled.push(at); i = last + 1;
      }
      return { found: true, waypoints: pulled, nodes, bodies: obstacles.length };
    }
    for (const dx of [-spacing, 0, spacing]) for (const dy of [-spacing, 0, spacing]) {
      if (!dx && !dy) continue;
      const p = edge(cur, { x: cur.x + dx, y: cur.y + dy }); if (!p) continue;
      const pk = key(p), g = cur.g + travelCost(cur,p);
      if (g >= (best.get(pk) ?? Infinity)) continue;
      best.set(pk, g); parents.set(pk, cur);
      push({ ...p, g, f: g + distance(p) });
    }
  }
  return { found: false, reason: open.length ? 'body detour budget exhausted' : 'no clear local body route', nodes };
}
