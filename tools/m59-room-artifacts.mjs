// Compact, immutable room artifacts that may be adopted before RoomGeometry is decoded.
//
// The routing bake already holds two answers useful at startup: one proven staging square
// for each routable declared edge, and the mover step mask.  Keeping those answers here
// lets the lab build its static room graph without first materialising every BSP tree.
// Geometry remains authoritative: callers use topology only as positive evidence and
// fall back to RoomGeometry whenever the bake cannot prove an answer.

const MASK_BY_ROO = new WeakMap();
const TOPOLOGY_BY_ROOM = new WeakMap();
const EDGE_DIRECTIONS = new Set(['north', 'south', 'west', 'east']);

function rooOf(roomOrRoo) {
  return roomOrRoo?.roo ?? roomOrRoo;
}

function canonicalBase64Length(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return -1;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    return -1;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

/**
 * Register one room's current, complete bake without constructing RoomGeometry.
 * Returns counters suitable for attachStepMasks' ordinary startup summary.
 */
export function registerLazyRoomArtifacts(room, baked) {
  const roo = rooOf(room);
  if (!room || !roo || typeof roo !== 'object' || !baked || typeof baked !== 'object')
    return { registered: false, topology: 0, deferred: false, refused: false };

  // Re-registration replaces evidence; a later invalid/stale row must never leave an
  // earlier table's topology or mask active for this room.
  TOPOLOGY_BY_ROOM.delete(room);
  MASK_BY_ROO.delete(roo);

  // A dimension disagreement makes every coordinate and mask byte ambiguous.  Do not
  // adopt even the topology; the ordinary geometry path will report/refuse it instead.
  const rows = Number(room.rows), cols = Number(room.cols);
  const roomNumberMatches = Number.isInteger(Number(room.num)) &&
                            Number(baked.room) === Number(room.num);
  const securityMatches = room.roo?.security != null && baked.security != null &&
                          Number(baked.security) === Number(room.roo.security);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0 ||
      Number(baked.rows) !== rows || Number(baked.cols) !== cols ||
      !roomNumberMatches || !securityMatches) {
    return { registered: false, topology: 0, deferred: false,
             refused: typeof baked.stepMask === 'string' };
  }

  // Copy only the fields needed to prove that a boundary has a routable crossing.  Never
  // expose the mutable JSON objects held by activeRoutes(), and key topology by the room
  // rather than its .roo because exits belong to the graph, not to collision geometry.
  const anchors = Object.freeze((Array.isArray(baked.anchors) ? baked.anchors : [])
    .filter(anchor => anchor?.kind === 'edge' && EDGE_DIRECTIONS.has(anchor.dir) &&
                      Number.isInteger(anchor.row) && Number.isInteger(anchor.col) &&
                      Number.isFinite(Number(anchor.to)))
    .map(anchor => Object.freeze({
      kind: 'edge', dir: anchor.dir, to: Number(anchor.to),
      row: anchor.row, col: anchor.col,
    })));
  TOPOLOGY_BY_ROOM.set(room, anchors);

  const expected = rows * cols;
  const mask = typeof baked.stepMask === 'string' &&
               canonicalBase64Length(baked.stepMask) === expected
    ? baked.stepMask : null;
  if (mask) MASK_BY_ROO.set(roo, { encoded: mask, consumed: false, attached: false });

  return {
    registered: true,
    topology: anchors.length,
    deferred: !!mask,
    refused: typeof baked.stepMask === 'string' && !mask,
  };
}

/** Frozen positive topology evidence for this exact map room, or null. */
export function lazyRoomTopology(room) {
  return room && typeof room === 'object' ? (TOPOLOGY_BY_ROOM.get(room) ?? null) : null;
}

/** Attach and consume a deferred mask when its RoomGeometry is first requested. */
export function attachDeferredStepMask(roomOrRoo, geometry) {
  const roo = rooOf(roomOrRoo);
  const record = roo && typeof roo === 'object' ? MASK_BY_ROO.get(roo) : null;
  if (!record || !geometry) return false;
  if (record.consumed) return record.attached;
  record.consumed = true;
  try {
    const bytes = Buffer.from(record.encoded, 'base64');
    record.attached = geometry.attachStepMask(
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
  } catch {
    record.attached = false;
  }
  // activeRoutes() owns the on-disk string already; do not retain a second reference here.
  record.encoded = null;
  return record.attached;
}
