// Offline comparison geometry only. This exporter is not Meridian's movement oracle.
// BSP ground axes become Recast X/Z; all three axes are measured in game squares.
import { createHash } from 'node:crypto';
import { CLIENT_FINENESS, PLAYER_HEIGHT, PLAYER_RADIUS, MAX_STEP_HEIGHT,
  WF, floorHeightAt, ceilingHeightAt } from '../../tools/m59-roo.mjs';

export const GEOMETRY_PROFILES = ['floor-wall', 'conventional'];
const SCALE = CLIENT_FINENESS;
const finitePoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

// A sector's floor and ceiling are planes. Rounding in the native height helper can
// move their intersection by one client unit, so locate its positive-space side by
// bisection rather than deriving a different slope equation here.
function positiveInterior(polygon, sector) {
  const gap = ([x, y]) => ceilingHeightAt(x, y, sector) - floorHeightAt(x, y, sector);
  const out = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const aInside = gap(a) > 0, bInside = gap(b) > 0;
    if (aInside) out.push(a);
    if (aInside === bInside) continue;
    let inside = aInside ? a : b, outside = aInside ? b : a;
    for (let j = 0; j < 30; j++) {
      const mid = [(inside[0] + outside[0]) / 2, (inside[1] + outside[1]) / 2];
      if (gap(mid) > 0) inside = mid; else outside = mid;
    }
    out.push(inside);
  }
  return out;
}

function sourceDigest(geo) {
  const source = {
    file: geo.file, version: geo.version, security: geo.security,
    rows: geo.rows, cols: geo.cols,
    sectors: geo.sectors,
    leaves: geo.leaves.map(({ sectorNum, polygon }) => ({ sectorNum, polygon })),
    walls: geo.walls.map(w => ({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1,
      posSector: w.posSector, negSector: w.negSector,
      pos: w.posSidedefRec, neg: w.negSidedefRec,
      heights: [w.z0, w.z1, w.z2, w.z3, w.zz0, w.zz1, w.zz2, w.zz3] })),
  };
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

/**
 * Build a Recast triangle soup from native BSP leaves and collision walls.
 *
 * floor-wall omits global ceilings because Meridian checks player headroom at
 * particular wall crossings, not everywhere beneath a low ceiling. conventional
 * adds those ceilings to expose the effect of ordinary Recast headroom filtering.
 * Both profiles collapse sidedef asymmetry conservatively into two-way barriers;
 * neither represents native directional climbs, jumps, doors or falling clocks.
 * wallThickness is in SQUARE units and adds a small conservative obstacle margin.
 */
export function roomTriangles(geo, { profile = 'floor-wall', wallThickness = 1 / SCALE,
  roomFlags = 0, overrideDepths = null } = {}) {
  if (!GEOMETRY_PROFILES.includes(profile)) throw new Error(`Unknown geometry profile: ${profile}`);
  if (!(wallThickness > 0) || !Number.isFinite(wallThickness)) throw new Error('wallThickness must be positive');
  if (!geo?.collisionReady || !Array.isArray(geo.leaves) || !Array.isArray(geo.walls)
      || !Array.isArray(geo.sectors)) throw new Error('Validated BSP collision geometry is required');

  const positions = [], indices = [];
  const counts = { sourceLeaves: geo.leaves.length, sourceWalls: geo.walls.length,
    floorLeaves: 0, voidLeaves: 0, emptyLeaves: 0, clippedLeaves: 0,
    floorTriangles: 0, ceilingTriangles: 0, wallTriangles: 0,
    solidWallPrisms: 0, lowerWallPrisms: 0, upperWallPrisms: 0,
    asymmetricWalls: 0, degenerateTriangles: 0 };
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const voidSectors = typeof geo.voidSectors === 'function' ? geo.voidSectors() : new Set();
  const asymmetricWalls = [];

  function triangle(a, b, c, kind, face = null) {
    if (![...a, ...b, ...c].every(Number.isFinite)) throw new Error('Non-finite triangle');
    const ab = b.map((v, i) => v - a[i]), ac = c.map((v, i) => v - a[i]);
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0]];
    if (Math.hypot(...cross) < 1e-12) { counts.degenerateTriangles++; return; }
    if ((face === 'up' && cross[1] < 0) || (face === 'down' && cross[1] > 0)) [b, c] = [c, b];
    for (const p of [a, b, c]) {
      indices.push(positions.length / 3);
      positions.push(...p);
      for (let axis = 0; axis < 3; axis++) {
        bounds.min[axis] = Math.min(bounds.min[axis], p[axis]);
        bounds.max[axis] = Math.max(bounds.max[axis], p[axis]);
      }
    }
    counts[kind]++;
  }
  const point = (x, y, height) => [x / SCALE, height / SCALE, y / SCALE];
  const quad = (a, b, c, d, face = null) => {
    triangle(a, b, c, 'wallTriangles', face);
    triangle(a, c, d, 'wallTriangles', face);
  };

  for (const leaf of geo.leaves) {
    if (voidSectors.has(leaf.sectorNum)) { counts.voidLeaves++; continue; }
    const sector = leaf.sector ?? geo.sectors[leaf.sectorNum - 1];
    if (!sector || !Array.isArray(leaf.polygon) || leaf.polygon.length < 3
        || !leaf.polygon.every(finitePoint)) throw new Error('Invalid BSP leaf');
    const polygon = positiveInterior(leaf.polygon, sector);
    if (polygon.length < 3) { counts.emptyLeaves++; continue; }
    if (polygon.length !== leaf.polygon.length || polygon.some((p, i) => p !== leaf.polygon[i])) counts.clippedLeaves++;
    const floor = polygon.map(([x, y]) => point(x, y,
      geo.floorBaseAtClient(x, y, { ...leaf, sector }, { roomFlags, overrideDepths })));
    const ceiling = profile === 'conventional'
      ? polygon.map(([x, y]) => point(x, y, ceilingHeightAt(x, y, sector))) : null;
    for (let i = 1; i < polygon.length - 1; i++) {
      triangle(floor[0], floor[i], floor[i + 1], 'floorTriangles', 'up');
      if (ceiling) triangle(ceiling[0], ceiling[i], ceiling[i + 1], 'ceilingTriangles', 'down');
    }
    counts.floorLeaves++;
  }

  // Thin prisms avoid depending on zero-width vertical triangles rasterizing at
  // every cell alignment. Their top faces deliberately point down: obstacle tops
  // are not additional authored floor, and must not be marked walkable by Recast.
  function wallPrism(w, bottom0, bottom1, top0, top1, countKey) {
    if (![bottom0, bottom1, top0, top1].every(Number.isFinite)) throw new Error('Invalid wall height');
    if (top0 <= bottom0 && top1 <= bottom1) return;
    const dx = w.x1 - w.x0, dy = w.y1 - w.y0, length = Math.hypot(dx, dy);
    if (!length) return;
    const offset = wallThickness * SCALE / 2, ox = -dy / length * offset, oy = dx / length * offset;
    const p = (end, side, height) => point(end ? w.x1 + side * ox : w.x0 + side * ox,
      end ? w.y1 + side * oy : w.y0 + side * oy, height);
    const a = p(0, -1, bottom0), b = p(1, -1, bottom1), c = p(1, 1, bottom1), d = p(0, 1, bottom0);
    const A = p(0, -1, top0), B = p(1, -1, top1), C = p(1, 1, top1), D = p(0, 1, top0);
    quad(a, b, B, A); quad(b, c, C, B); quad(c, d, D, C); quad(d, a, A, D);
    quad(a, d, c, b, 'down'); quad(A, B, C, D, 'down');
    counts[countKey]++;
  }

  if (!counts.floorTriangles) throw new Error('Room exported no usable floor');
  const authoredHeights = [bounds.min[1] * SCALE, bounds.max[1] * SCALE,
    ...geo.walls.flatMap(w => [w.z0, w.z1, w.z2, w.z3, w.zz0, w.zz1, w.zz2, w.zz3]).filter(Number.isFinite)];
  const solidBottom = Math.min(...authoredHeights) - PLAYER_HEIGHT;
  const solidTop = Math.max(...authoredHeights) + PLAYER_HEIGHT;
  for (let index = 0; index < geo.walls.length; index++) {
    const w = geo.walls[index], sides = [w.posSidedefRec, w.negSidedefRec].filter(Boolean);
    if (!sides.length) continue; // Native collision skips a missing sidedef.
    const signature = s => s ? [!!(s.flags & WF.PASSABLE), !!s.belowType, !!s.aboveType] : [true, false, false];
    if (JSON.stringify(signature(w.posSidedefRec)) !== JSON.stringify(signature(w.negSidedefRec))) {
      counts.asymmetricWalls++; asymmetricWalls.push(index + 1);
    }
    if (sides.some(s => !(s.flags & WF.PASSABLE))) {
      // Nonpassable walls block at any carried height. Extend beyond all authored
      // room surfaces so no artificial short wall can become a route over its cap.
      wallPrism(w, solidBottom, solidBottom, solidTop, solidTop, 'solidWallPrisms');
    } else {
      if (sides.some(s => s.belowType)) wallPrism(w, w.z0, w.zz0, w.z1, w.zz1, 'lowerWallPrisms');
      if (sides.some(s => s.aboveType)) wallPrism(w, w.z2, w.zz2, w.z3, w.zz3, 'upperWallPrisms');
    }
  }
  if (!indices.length) throw new Error('Room exported no triangles');
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices), counts, bounds,
    provenance: {
      format: 'm59-recast-triangles/1', profile, room: geo.roomNum ?? null, sourceFile: geo.file,
      sourceDigest: sourceDigest(geo), sourceSecurity: geo.security,
      units: 'game squares', axes: { x: 'BSP x / 1024', y: 'BSP height / 1024', z: 'BSP y / 1024' },
      wallThickness, roomFlags, overrideDepths,
      agent: { radius: PLAYER_RADIUS / SCALE, height: PLAYER_HEIGHT / SCALE, climb: MAX_STEP_HEIGHT / SCALE },
      asymmetricWalls,
      caveats: [
        'Approximate symmetric triangle soup; native directional sidedefs are not preserved.',
        'No off-mesh jumps, trigger exits, animated door states or carried falling-height model.',
        'Thin wall prisms conservatively reduce passage width by wallThickness.',
        'Obstacle caps and ceilings are deliberately downward-facing and not authored walkable floor.',
        'Every candidate route still requires native fine collision validation.',
      ],
    } };
}
