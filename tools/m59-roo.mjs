#!/usr/bin/env node
// Room geometry: the walkability grid a .roo file carries, which is the same data
// the player's minimap is drawn from.
//
//   node tools/m59-roo.mjs show <file.roo|roomName>     render the room as a minimap
//   node tools/m59-roo.mjs path <room> <c1,r1> <c2,r2>  route through the geometry
//   node tools/m59-roo.mjs stats                        parse every room, report
//
// CLI CONTRACT: `path` pairs are `col,row` (movement-facing order); the command
// adapts them to RoomGeometry's positional `(row,col)` contract.
//
// Why this matters even though the server does not enforce walls for players
// (UserMove goes straight to Room.SomethingMoved; ReqSomethingMoved is only called
// for monsters and dropped items): an agent that cannot see geometry has to discover
// it by bumping into it, one move per second, and it can never plan. This file is
// the densest state the client holds, and handing it to an agent is the difference
// between stepping blind and navigating.
//
// FORMAT, from blakserv/roofile.c BSPRooFileLoadServer:
//
//   "ROO\xB1"      4 bytes magic
//   version        4, int LE, must be >= 4
//   security       4
//   main_off       4   absolute offset of the client section
//   server_off     4   absolute offset of the server section
//
//   at server_off:
//     rows                     4, int LE
//     cols                     4, int LE
//     grid[rows][cols]         1 byte per square — 8 direction bits
//     flags[rows][cols]        1 byte per square — bit 0 is "there is floor here"
//     monster_grid[rows][cols] 1 byte per square, version >= 12 only
//
//   at main_off (the client section, for sector heights and the BSP):
//     room_w, room_h, node_off, cwall_off, rwall_off, sidedef_off,
//     sector_off, extra_off   — eight 4-byte absolute offsets
//
// The grid byte is NOT "is this square open". It is a per-direction adjacency mask
// on the square you are LEAVING (blakserv/roomdata.c:31):
//
//   N 0x01  NE 0x02  E 0x04  SE 0x08  S 0x10  SW 0x20  W 0x40  NW 0x80
//
// so geometry is a directed graph, and a one-way ledge is expressible. The flags
// byte's bit 0 (ROOM_FLAG_WALKABLE, roomdata.h:40) says the DESTINATION has floor.
// CanMoveInRoom checks the destination's floor bit and the source's direction bit,
// which is why both grids are needed to answer one question.
//
// Rows and cols here are 0-BASED. kod is 1-based and ccode.c subtracts one on the
// way in (blakserv/ccode.c:1504), so a kod row R is grid row R-1. Every public
// square-index method uses kod's 1-based convention, because that is what the
// protocol speaks and what an agent will have in hand from perception. Fine-point
// methods use the units and origin stated in their own contracts below.
//
// COORDINATE CONTRACT: positional square arguments in RoomGeometry are always
// `(row,col)`. Fine-point units belong to each method or field contract; `{x,y}`
// names axes, not scale. BSP/collision primitives consume 1024-unit client points,
// while edge-crossing `fine_stand_on`, `edge_target`, and `finePathProtocol`
// results use 64-unit KOD/protocol points. Adapters convert explicitly.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { movementMapFile } from './m59-map-path.mjs';
import { attachDeferredStepMask } from './m59-room-artifacts.mjs';

const ROO_MAGIC = Buffer.from([0x52, 0x4f, 0x4f, 0xb1]);
const ROO_MIN_VERSION = 4;
const MONSTER_GRID_VERSION = 12;         // roofile.c: "optional monster grid for v12+"

export const ROOM_FLAG_WALKABLE = 0x01;  // blakserv/roomdata.h:40

// Sidedef flags, clientd3d/bsp.h:16. Three of these decide what the minimap shows
// and whether a wall is really a wall:
//   WF_PASSABLE   the "wall" can be walked through — a doorway or archway
//   WF_MAP_NEVER  never draw it on the map (secret doors, ceiling edges)
//   WF_MAP_ALWAYS draw it even in parts of the room the player has not seen
export const WF = {
  BACKWARDS: 0x00000001, TRANSPARENT: 0x00000002, PASSABLE: 0x00000004,
  MAP_NEVER: 0x00000008, MAP_ALWAYS: 0x00000010, NOLOOKTHROUGH: 0x00000020,
  HAS_ANIMATED: 0x00000400,
};

// clientd3d/drawdefs.h:42 — the client's fine coordinate space, 1024 units per grid
// square, which is what wall endpoints are expressed in. kod's own fine space is 64
// units per square (FinenessKodToClient shifts left by 4 to convert).
export const CLIENT_FINENESS = 1024;
export const LOG_CLIENT_FINENESS = 10;
export const KOD_FINENESS = 64;                  // drawdefs.h:52
export const LOG_KOD_FINENESS = 6;
// clientd3d/bsp.h:303. BSP leaves are fixed-capacity convex polygons in the
// canonical client; accepting a larger count would overrun that client's Poly.
export const MAX_BSP_POINTS = 20;
// drawdefs.h:60 — heights are stored in kod units and shifted into client units by
// the same 4 bits as fine coordinates. Both directions, because the .roo stores kod
// and every comparison in move.c is done in client units.
export const heightKodToClient = h => h << (LOG_CLIENT_FINENESS - LOG_KOD_FINENESS);
export const heightClientToKod = h => h >> (LOG_CLIENT_FINENESS - LOG_KOD_FINENESS);

// THE CLIMB LIMIT IS NOT IN kod. It is `clientd3d/move.c:55`:
//
//   #define MAX_STEP_HEIGHT (HeightKodToClient(24))
//
// which is worth saying out loud because the plan that sent me looking expected to
// find it in kod, and there is nothing there to find. That is not an oversight in the
// game — it is the same fact as everything else here: `UserMove` does no geometry, so
// the step limit only ever needed to exist in the collision detector, and the
// collision detector is the client. We are the client. If we do not enforce 24, then
// for us it does not exist, and we will walk up cliffs.
export const MAX_STEP_HEIGHT_KOD = 24;
export const MAX_STEP_HEIGHT = heightKodToClient(MAX_STEP_HEIGHT_KOD);   // 384 client units
// How far a body may carry across a gap. Three squares is the operator's Cragged Mountains
// crossing with room to spare; more would start inventing traversals nobody has walked.
// The declared fall-jump table, read once and cached. Kept here rather than imported from
// m59-falljump.mjs so this module stays free of a dependency cycle: the tool imports the
// geometry, not the other way round. An unreadable or absent table declares nothing.
let DECLARED_FALL_JUMPS;
function declaredFallJumpTable() {
  if (DECLARED_FALL_JUMPS !== undefined) return DECLARED_FALL_JUMPS;
  try {
    const url = new URL('../substrate/m59-falljumps.json', import.meta.url);
    DECLARED_FALL_JUMPS = JSON.parse(fs.readFileSync(url, 'utf8'));
  } catch { DECLARED_FALL_JUMPS = null; }
  return DECLARED_FALL_JUMPS;
}
export const FALL_MAX_SQUARES = Number(process.env.M59_FALL_MAX_SQUARES || 3);

/**
 * DOES THIS ROOM CONTAIN A DECLARED ONE-WAY DROP.
 *
 * A room-level question, where `declaredFallJumps` answers a square-level one. It exists
 * because a fall is the one thing in this game that makes a room DIRECTED: the squares
 * below Ukgoth's cliff can be reached from above and cannot reach it back, so "these two
 * doors are in the same region" and "I can get from here to that door" stop being the same
 * question — and every flood in this repository answers the first.
 *
 * Callers use it as a caution rather than as geometry: in a room with a declared drop, a
 * door the live flood cannot reach from where a body is standing is probably genuinely
 * unreachable from there, and a bake that walked it from the room's body is not evidence
 * about the bottom of a cliff.
 */
export function roomHasDeclaredFallJump(roomNum) {
  const table = declaredFallJumpTable();
  const n = Number(roomNum);
  return (table?.jumps ?? []).some(j => Number(j.room) === n && j?.from && j?.to);
}

// What a planned step onto ground the COARSE GRID calls solid is charged. The argument,
// the measurement and why it is a cost rather than a refusal are all at `clipCost` in
// `path`. Zero restores the behaviour from before it existed.
export const CLIP_STEP_COST = Number(process.env.M59_CLIP_STEP_COST ?? 2);

// clientd3d/draw3d.c:80 — how far a wading sector sinks you, indexed by the sector's
// two depth bits. This matters to movement and not just to drawing: standing in water
// LOWERS you, so the far side of a wall is easier to step onto out of deep water than
// off dry land, and move.c subtracts it before the climb test.
export const SECTOR_DEPTHS = [0, (CLIENT_FINENESS / 5) | 0, (2 * CLIENT_FINENESS / 5) | 0,
                              (3 * CLIENT_FINENESS / 5) | 0];   // {0, 204, 409, 614}
export const sectorDepth = flags => flags & 0x03;                // bsp.h:70

// Sector flags, clientd3d/bsp.h:62.
export const SF = {
  DEPTH_MASK: 0x00000003,
  SCROLL_MASK: 0x0000000C,
  SCROLL_FLOOR: 0x00000080, SCROLL_CEILING: 0x00000100,
  FLICKER: 0x00000200,
  SLOPED_FLOOR: 0x00000400, SLOPED_CEILING: 0x00000800,
  HAS_ANIMATED: 0x00001000,
};

// THE PLAYER IS A CYLINDER, and both of its dimensions are movement rules.
// clientd3d/game.c:261. `min_distance` — how close to a wall you may get — is
// width/2 (move.c:122), so a corner inset for route planning is 248 client units,
// not zero. The height is what decides whether you fit UNDER something.
export const PLAYER_WIDTH = 31 * KOD_FINENESS / 4;   // 496 client units
export const PLAYER_RADIUS = PLAYER_WIDTH / 2;       // 248 — move.c:122
export const PLAYER_HEIGHT = 3 * CLIENT_FINENESS / 4; // 768 — game.c:262
export const MIN_NOMOVEON = CLIENT_FINENESS / 4;     // 256 — move.c:62
export const MIN_SIDE_MOVE = CLIENT_FINENESS / 16;   // 64 — MOVEUNITS / 4

// Versioned because old baked maps contain only the five minimap fields of each
// wall. Treating those as collision data would silently bring the original bug
// back: a drawable/passable bit alone cannot distinguish a low step from a cliff.
export const COLLISION_VERSION = 2;

// Answers to `collisionReady`, keyed by geometry instance — see the note on that getter.
// A WeakMap rather than a field so it never reaches toJSON, and so a dropped room's
// answer is collected with the room.
const COLLISION_READY_CACHE = new WeakMap();
const SIDE_EXISTS = 0x01;
const SIDE_PASSABLE = 0x02;
const SIDE_ABOVE = 0x04;
const SIDE_BELOW = 0x08;
const CLIENT_PER_KOD = CLIENT_FINENESS / KOD_FINENESS;
const GEOMETRY_EPSILON = 1e-6;
const f32 = Math.fround;
// COORDINATE CONTRACT: these convert one scalar axis only—there is no X/Y swap.
// KOD/protocol space is 64 units per square with its 1-based square offset;
// client/BSP space is 1024 units per square with a 0-based origin.
export const protocolToClient = value => (value - KOD_FINENESS) * CLIENT_PER_KOD;
export const clientToProtocol = value => value / CLIENT_PER_KOD + KOD_FINENESS;

// A CLIENT COORDINATE, ROUNDED TO THE INTEGER PROTOCOL UNIT THE WIRE CARRIES — AND
// ROUNDED TOWARD WHERE THE MOVE STARTED, never to nearest.
//
// The trace answers in client units; the packet can only carry integer KOD ones. Rounding
// to nearest can round PAST what the trace allowed, which is a coordinate the collision
// pass never approved — so the bias is always back toward the start, and the result is
// then re-traced to prove it is reachable.
//
// One home, two callers: `Session.validateFineTarget` in m59-broker.mjs decides what to
// send, `RoomGeometry.moverStepLands` below decides what to plan. Those must be the same
// arithmetic or the router plans steps the mover will not make, which is the whole bug
// this pair of functions exists to close.
export const protocolToward = (value, fromValue) => {
  const wire = value / CLIENT_PER_KOD + KOD_FINENESS;
  if (value > fromValue) return Math.floor(wire + 1e-9);
  if (value < fromValue) return Math.ceil(wire - 1e-9);
  return Math.round(wire);
};

/**
 * Cut every loop out of a route: if it visits a square twice, drop everything between.
 *
 * A FREE FUNCTION AND NOT ONLY A STATIC, because the callers that need it most are the
 * `Session` methods in `m59-broker.mjs`, and those are lifted out of that file BY TEXT and
 * evaluated by the test suites. A lifted method can be handed a function; it cannot be
 * handed a class it has no import for. `RoomGeometry.elideLoops` delegates here so there
 * is one implementation rather than two that agree by luck.
 *
 * `key` decides what "the same place" means, and the caller has to choose it, because the
 * two callers mean different things. A planned ROUTE is a list of squares and two visits
 * to a square are a loop. A BREADCRUMB is a validated move with exact `from`/`to` fine
 * coordinates chained end to end, and there the key must be the exact landing point: the
 * chain's invariant is `crumb[i].to === crumb[i+1].from`, so excising between two crumbs
 * that landed on the SAME POINT leaves `crumb[i].to` followed by a `from` equal to it and
 * the chain still joins exactly. Keyed by square instead, two landings in one square at
 * different fine positions would break that join — and the retreat drops a broken trail
 * WHOLE, so a sloppy key here would lose the entire escape rather than shorten it.
 *
 * See the class method's note for the argument that this can only ever REMOVE steps.
 */
export function elideLoops(squares, key = sq => `${sq.row},${sq.col}`) {
  const out = [];
  const seenAt = new Map();
  for (const sq of squares ?? []) {
    const k = key(sq);
    const had = seenAt.get(k);
    if (had !== undefined) {
      // Everything after the first visit is a round trip back to here. Drop it, and forget
      // the entries that only ever existed inside the cycle.
      for (let i = had + 1; i < out.length; i++) seenAt.delete(key(out[i]));
      out.length = had + 1;
      continue;
    }
    seenAt.set(k, out.length);
    out.push(sq);
  }
  return out;
}

// Separators are floats in the stock client. Keep every multiply/add in float32;
// JS's default double arithmetic changes a handful of exact boundary decisions.
function separatorValue(separator, x, y) {
  return f32(f32(f32(separator.a * f32(x)) + f32(separator.b * f32(y)))
    + separator.c);
}

function collisionDigest({ file, security, version, rows, cols, grid, flags, monsterGrid,
                           walls, edgeOpenings, edgeApproaches, collision }) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ file, security, version, rows, cols, grid, flags, monsterGrid,
                               walls, edgeOpenings, edgeApproaches }));
  for (const key of ['wallSides', 'sectors', 'leaves', 'nodes']) {
    hash.update('\0' + key + '\0');
    hash.update(Buffer.from(collision[key], 'base64'));
  }
  return hash.digest('hex');
}

const sideBits = sd => !sd ? 0
  : SIDE_EXISTS
    | ((sd.flags & WF.PASSABLE) ? SIDE_PASSABLE : 0)
    | (sd.aboveType ? SIDE_ABOVE : 0)
    | (sd.belowType ? SIDE_BELOW : 0);

const sideFromBits = bits => !(bits & SIDE_EXISTS) ? null : ({
  flags: (bits & SIDE_PASSABLE) ? WF.PASSABLE : 0,
  aboveType: (bits & SIDE_ABOVE) ? 1 : 0,
  belowType: (bits & SIDE_BELOW) ? 1 : 0,
});

function pointOnSegment(x, y, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const cross = (x - x0) * dy - (y - y0) * dx;
  if (Math.abs(cross) > GEOMETRY_EPSILON * Math.max(1, Math.abs(dx), Math.abs(dy))) return false;
  return x >= Math.min(x0, x1) - GEOMETRY_EPSILON && x <= Math.max(x0, x1) + GEOMETRY_EPSILON
      && y >= Math.min(y0, y1) - GEOMETRY_EPSILON && y <= Math.max(y0, y1) + GEOMETRY_EPSILON;
}

// BSP leaves are convex in the game, but a generic even/odd test costs essentially
// the same and remains correct for hand-built regression fixtures. Boundary points
// count as inside; `preferSectorNum` below resolves a shared edge deterministically.
function pointInPolygon(x, y, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if (pointOnSegment(x, y, xi, yi, xj, yj)) return true;
    if ((yi > y) !== (yj > y)) {
      const atX = (xj - xi) * (y - yi) / (yj - yi) + xi;
      if (x < atX) inside = !inside;
    }
  }
  return inside;
}

// Collision surfaces are baked as compact binary payloads. The public surface
// objects used by the RTS renderer are much richer; repeating 88,000 leaf objects
// in pretty-printed map JSON turns a 12 MB map into a 53 MB one. Movement needs only
// heights/slopes, leaf polygons, and six directional bytes per displayed wall.
const COLLISION_SECTOR_BYTES = 76;

function encodeCollisionSectors(sectors) {
  const buf = Buffer.allocUnsafe(4 + sectors.length * COLLISION_SECTOR_BYTES);
  buf.writeUInt32LE(sectors.length, 0);
  let p = 4;
  for (const sector of sectors) {
    buf.writeInt32LE(Math.round(sector.floorHeight), p);
    buf.writeInt32LE(Math.round(sector.ceilingHeight), p + 4);
    buf.writeUInt16LE(sector.depth ?? 0, p + 8);
    buf.writeUInt8((sector.slopedFloor ? 1 : 0) | (sector.slopedCeiling ? 2 : 0), p + 10);
    buf.writeUInt8(0, p + 11);
    for (const [offset, slope] of [[12, sector.slopedFloor], [44, sector.slopedCeiling]]) {
      for (const [n, key] of ['a', 'b', 'c', 'd'].entries())
        buf.writeDoubleLE(slope ? slope[key] : 0, p + offset + n * 8);
    }
    p += COLLISION_SECTOR_BYTES;
  }
  return buf.toString('base64');
}

function decodeCollisionSectors(encoded) {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 4) throw new Error('truncated collision sector header');
  const count = buf.readUInt32LE(0);
  if (buf.length !== 4 + count * COLLISION_SECTOR_BYTES)
    throw new Error('collision sector payload length mismatch');
  const sectors = [];
  let p = 4;
  for (let i = 0; i < count; i++, p += COLLISION_SECTOR_BYTES) {
    const mask = buf.readUInt8(p + 10);
    const depth = buf.readUInt16LE(p + 8);
    if (mask & ~0x03) throw new Error('invalid collision sector slope mask');
    if (buf.readUInt8(p + 11) !== 0) throw new Error('invalid collision sector reserved byte');
    if (!SECTOR_DEPTHS.includes(depth)) throw new Error('invalid collision sector depth');
    const slope = offset => {
      const out = {};
      for (const [n, key] of ['a', 'b', 'c', 'd'].entries()) {
        out[key] = buf.readDoubleLE(p + offset + n * 8);
        if (!Number.isFinite(out[key])) throw new Error('non-finite collision slope');
      }
      if (out.c === 0) throw new Error('invalid collision slope plane');
      return out;
    };
    const floorHeight = buf.readInt32LE(p);
    const ceilingHeight = buf.readInt32LE(p + 4);
    if (!Number.isFinite(floorHeight) || !Number.isFinite(ceilingHeight))
      throw new Error('non-finite collision sector height');
    sectors.push({
      id: i + 1,
      floorHeight,
      ceilingHeight,
      depth,
      slopedFloor: (mask & 1) ? slope(12) : null,
      slopedCeiling: (mask & 2) ? slope(44) : null,
    });
  }
  return sectors;
}

function encodeCollisionLeaves(leaves) {
  const bytes = 4 + leaves.reduce((n, leaf) => n + 6 + leaf.polygon.length * 8, 0);
  const buf = Buffer.allocUnsafe(bytes);
  buf.writeUInt32LE(leaves.length, 0);
  let p = 4;
  for (const leaf of leaves) {
    buf.writeUInt16LE(leaf.node, p);
    buf.writeUInt16LE(leaf.sectorNum, p + 2);
    buf.writeUInt8(leaf.polygon.length, p + 4);
    buf.writeUInt8(0, p + 5);
    p += 6;
    for (const [x, y] of leaf.polygon) {
      buf.writeFloatLE(x, p); buf.writeFloatLE(y, p + 4); p += 8;
    }
  }
  return buf.toString('base64');
}

function decodeCollisionLeaves(encoded, sectors) {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 4) throw new Error('truncated collision leaf header');
  const count = buf.readUInt32LE(0);
  const leaves = [];
  let p = 4;
  for (let i = 0; i < count; i++) {
    if (p + 6 > buf.length) throw new Error('truncated collision leaf');
    const node = buf.readUInt16LE(p), sectorNum = buf.readUInt16LE(p + 2);
    const pointCount = buf.readUInt8(p + 4); p += 6;
    if (!node) throw new Error('invalid collision leaf node');
    if (!sectorNum || sectorNum > sectors.length) throw new Error('invalid collision leaf sector');
    if (pointCount < 3 || pointCount > MAX_BSP_POINTS || p + pointCount * 8 > buf.length)
      throw new Error('invalid collision leaf polygon');
    const polygon = [];
    for (let n = 0; n < pointCount; n++) {
      const x = buf.readFloatLE(p), y = buf.readFloatLE(p + 4); p += 8;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('non-finite collision leaf point');
      polygon.push([x, y]);
    }
    const xs = polygon.map(point => point[0]), ys = polygon.map(point => point[1]);
    leaves.push({ type: 'leaf', node, sectorNum, sector: sectors[sectorNum - 1],
                  bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
                  polygon });
  }
  if (p !== buf.length) throw new Error('collision leaf payload has trailing bytes');
  return leaves;
}

const COLLISION_NODE_BYTES = 48;

function encodeCollisionNodes(nodes, root = 1, firstWalls = new Map()) {
  if (!Array.isArray(nodes) || nodes.length > 0xffff || root < 1 || root > nodes.length)
    throw new Error('invalid BSP tree for collision bake');
  const internals = nodes.filter(node => node.type === 'internal');
  const buf = Buffer.allocUnsafe(6 + internals.length * COLLISION_NODE_BYTES);
  buf.writeUInt16LE(root, 0);
  buf.writeUInt16LE(nodes.length, 2);
  buf.writeUInt16LE(internals.length, 4);
  let p = 6;
  for (const node of internals) {
    buf.writeUInt16LE(node.node, p);
    buf.writeUInt16LE(node.positive, p + 2);
    buf.writeUInt16LE(node.negative, p + 4);
    buf.writeDoubleLE(node.separator.a, p + 6);
    buf.writeDoubleLE(node.separator.b, p + 14);
    buf.writeDoubleLE(node.separator.c, p + 22);
    buf.writeUInt16LE(firstWalls.get(node.node) ?? 0, p + 30);
    if (!Array.isArray(node.bbox) || node.bbox.length !== 4
        || !node.bbox.every(Number.isFinite)) throw new Error('invalid collision BSP bounds');
    for (let i = 0; i < 4; i++) buf.writeFloatLE(node.bbox[i], p + 32 + i * 4);
    p += COLLISION_NODE_BYTES;
  }
  return buf.toString('base64');
}

function decodeCollisionNodes(encoded, leaves) {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 6) throw new Error('truncated collision node header');
  const root = buf.readUInt16LE(0), total = buf.readUInt16LE(2), count = buf.readUInt16LE(4);
  if (!root || root > total || buf.length !== 6 + count * COLLISION_NODE_BYTES)
    throw new Error('collision node payload length mismatch');
  const nodes = Array(total).fill(null);
  for (const leaf of leaves) {
    if (leaf.node > total || nodes[leaf.node - 1]) throw new Error('duplicate collision BSP node');
    nodes[leaf.node - 1] = leaf;
  }
  let p = 6;
  for (let i = 0; i < count; i++, p += COLLISION_NODE_BYTES) {
    const node = buf.readUInt16LE(p), positive = buf.readUInt16LE(p + 2);
    const negative = buf.readUInt16LE(p + 4);
    const separator = { a: buf.readDoubleLE(p + 6), b: buf.readDoubleLE(p + 14),
                        c: buf.readDoubleLE(p + 22) };
    const firstCollisionWall = buf.readUInt16LE(p + 30);
    const bbox = [0, 1, 2, 3].map(n => buf.readFloatLE(p + 32 + n * 4));
    const normalLength = Math.hypot(separator.a, separator.b);
    if (!node || node > total || nodes[node - 1] || positive > total || negative > total
        || !Object.values(separator).every(Number.isFinite) || !bbox.every(Number.isFinite)
        || Math.abs(normalLength - CLIENT_FINENESS) > 0.01)
      throw new Error('invalid collision BSP node');
    nodes[node - 1] = { type: 'internal', node, positive, negative, separator,
                        firstCollisionWall, bbox };
  }
  if (nodes.some(node => !node)) throw new Error('incomplete collision BSP tree');
  const visiting = new Uint8Array(total);
  const stack = [[root, false]];
  while (stack.length) {
    const [id, leaving] = stack.pop();
    if (leaving) { visiting[id - 1] = 2; continue; }
    if (visiting[id - 1] === 1) throw new Error('cycle in collision BSP tree');
    if (visiting[id - 1] === 2) continue;
    visiting[id - 1] = 1;
    stack.push([id, true]);
    const node = nodes[id - 1];
    if (node.type === 'internal') for (const child of [node.negative, node.positive]) {
      if (child) stack.push([child, false]);
    }
  }
  if (visiting.some(state => state !== 2)) throw new Error('unreachable collision BSP node');
  return { root, nodes };
}

const COLLISION_WALL_BYTES = 10;

function encodeCollisionWallSides(walls, nextWalls = []) {
  if (walls.some(wall => !wall.collisionMetadata || !wall.collisionNode))
    throw new Error('wall lacks collision metadata');
  const buf = Buffer.allocUnsafe(4 + walls.length * COLLISION_WALL_BYTES);
  buf.writeUInt32LE(walls.length, 0);
  let p = 4;
  for (const [i, wall] of walls.entries()) {
    buf.writeUInt16LE(wall.posSector ?? 0, p);
    buf.writeUInt16LE(wall.negSector ?? 0, p + 2);
    buf.writeUInt8(sideBits(wall.posSidedefRec), p + 4);
    buf.writeUInt8(sideBits(wall.negSidedefRec), p + 5);
    buf.writeUInt16LE(wall.collisionNode, p + 6);
    buf.writeUInt16LE(nextWalls[i] ?? 0, p + 8);
    p += COLLISION_WALL_BYTES;
  }
  return buf.toString('base64');
}

function decodeCollisionWallSides(encoded, count, sectors, nodes) {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 4 || buf.readUInt32LE(0) !== count
      || buf.length !== 4 + count * COLLISION_WALL_BYTES)
    throw new Error('collision wall payload length mismatch');
  const out = [];
  for (let i = 0, p = 4; i < count; i++, p += COLLISION_WALL_BYTES) {
    const posSector = buf.readUInt16LE(p), negSector = buf.readUInt16LE(p + 2);
    const posBits = buf.readUInt8(p + 4), negBits = buf.readUInt8(p + 5);
    if ((posBits & ~0x0f) || (negBits & ~0x0f)
        || (!(posBits & SIDE_EXISTS) && posBits) || (!(negBits & SIDE_EXISTS) && negBits))
      throw new Error('invalid collision sidedef bits');
    const posSidedefRec = sideFromBits(posBits);
    const negSidedefRec = sideFromBits(negBits);
    const collisionNode = buf.readUInt16LE(p + 6);
    const nextCollisionWall = buf.readUInt16LE(p + 8);
    const owner = nodes[collisionNode - 1];
    if (posSector < 0 || negSector < 0 || posSector > sectors.length || negSector > sectors.length
        || (!posSector && !negSector) || (!posSidedefRec && !negSidedefRec)
        || owner?.type !== 'internal' || nextCollisionWall > count)
      throw new Error('invalid collision wall metadata');
    out.push({ posSector, negSector, posSidedefRec, negSidedefRec, collisionNode,
               nextCollisionWall });
  }
  for (const node of nodes) if (node?.type === 'internal' && node.firstCollisionWall > count)
    throw new Error('invalid collision BSP wall-chain root');
  const owned = new Uint8Array(count);
  for (const node of nodes) {
    if (node?.type !== 'internal') continue;
    let wallNumber = node.firstCollisionWall, guard = 0;
    while (wallNumber) {
      if (wallNumber > count || guard++ >= count || owned[wallNumber - 1]
          || out[wallNumber - 1].collisionNode !== node.node)
        throw new Error('invalid collision BSP wall chain');
      owned[wallNumber - 1] = 1;
      wallNumber = out[wallNumber - 1].nextCollisionWall;
    }
  }
  if (owned.some(value => value !== 1)) throw new Error('unreachable collision wall');
  return out;
}

// blakserv/roomdata.c:31. Row grows SOUTH, col grows EAST — the same convention
// Room.SomethingMoved uses when it decides which edge you crossed.
export const DIR = {
  N:  { mask: 0x01, dr: -1, dc:  0, name: 'north' },
  NE: { mask: 0x02, dr: -1, dc:  1, name: 'northeast' },
  E:  { mask: 0x04, dr:  0, dc:  1, name: 'east' },
  SE: { mask: 0x08, dr:  1, dc:  1, name: 'southeast' },
  S:  { mask: 0x10, dr:  1, dc:  0, name: 'south' },
  SW: { mask: 0x20, dr:  1, dc: -1, name: 'southwest' },
  W:  { mask: 0x40, dr:  0, dc: -1, name: 'west' },
  NW: { mask: 0x80, dr: -1, dc: -1, name: 'northwest' },
};
const DIRS = Object.values(DIR);

// THE BIT ORDER OF A BAKED STEP MASK, AND IT MAY NEVER BE REORDERED.
//
// `RoomGeometry.buildStepMask` writes it and `moverStepLands` reads it, and a mask read
// against a different order is not a degraded map — it is a confident map of the wrong
// doors, which nothing downstream can detect. It is deliberately the same order as `DIR`
// so there is one table rather than two that agree by luck.
export const STEP_MASK_DIRS = DIRS;

// WHAT THE BITS MEAN, VERSIONED — because the manifest cannot notice this.
//
// `geometryManifestSha256` hashes the GEOMETRY, so a mask baked by different CODE against
// the same map matches it perfectly and is attached without a word. That is exactly what
// happened when `moverStepLands` stopped gating on the server's coarse grid and started
// gating on `standable`: every mask on disk still encoded the old, stricter answer, still
// verified, and silently kept the fleet out of 773 steps per room that the new predicate
// allows. Bump this whenever the predicate changes, and an old table degrades to "plan on
// the coarse grid" — which is loud, correct, and fixed by a rebake — instead of lying.
//
//   1  gated on ROOM_FLAG_WALKABLE, aimed centre to centre
//   2  gates on standable() — BSP floor rather than the server's one-byte grid
//   3  and aims at standPoint() rather than the square's centre. The two are not separable
//      and v2 alone was nearly inert: recognising a square a diagonal wall cuts in half,
//      while still aiming at its middle, leaves it recognised and unreachable. Measured in
//      Western border of the Twisted Wood, v2 alone turned 277 such squares into 277
//      isolated one-square regions; with the aim as well, the room's connected body goes
//      from 1403 squares to 1612. v3 also requires a sector with an INTERIOR rather than
//      merely a floor height — see `_occupiable`, which is what stops the room compiler's
//      solid filler being read as ground (2,582 slabs of it in The King's Way alone).
//   4  and refuses a CLIMB of more than MAX_STEP_HEIGHT, measured against the body's
//      carried height rather than the floor beneath it — so a drop-jump, where you run off
//      a ledge and keep steering while airborne over lower ground, reads as a fall and not
//      as a climb out of the place you flew over. Paired with a landing-height check in
//      `_traceMoverStep`, without which the rule is inert: a square can straddle a cliff
//      face, and the mover was landing on the low half while `walkTo` counted the square
//      as reached. See `enforceStepHeight`.
//   5  and stops demanding that a sector be taller than the player before a body may STAND
//      in it. `_occupiable` required `ceiling - floor >= PLAYER_HEIGHT`, which is a rule
//      Meridian 59 does not have: the client's only height test is at a wall crossing with
//      an above texture (move.c:551), never against the ceiling you are standing under.
//      It deleted 3961 squares over 74 rooms -- the General Store of Jasper at 672, East
//      Ende at 640, The Hungry Vaults at 592 -- and among them the eight-square sewer pipe
//      that is the only way to room 108's jump take-off, which is why 52->110 and 2->110
//      never once completed. A mask baked before this encodes those squares as sealed, and
//      a mask that verifies while encoding the wrong doors is the thing this counter is
//      for.
export const STEP_MASK_VERSION = 6;

/**
 * HOW CLOSE DOES ANY BODY COME TO THIS LINE? In WIRE units, which is what the mover sends.
 *
 * Lifted out of `Session.step`'s fall branch so the lane past a body is computed in ONE
 * place. It was a closure inside the `fall` case, which meant an ordinary walk could not
 * reach it -- see `lanePastBodies`.
 */
export function gapAlongLine(ax, ay, bx, by, bodies) {
  if (!bodies?.length) return { gap: Infinity, who: [] };
  const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
  let best = Infinity, who = [];
  for (const o of bodies) {
    const t = len2 ? Math.max(0, Math.min(1, ((o.x - ax) * vx + (o.y - ay) * vy) / len2)) : 0;
    const d = Math.hypot(ax + t * vx - o.x, ay + t * vy - o.y);
    if (d < best) { best = d; who = [o.name]; } else if (d < best + 0.01) who.push(o.name);
  }
  return { gap: best, who };
}

/**
 * THE SAME MOVE, SHIFTED SIDEWAYS UNTIL IT CLEARS THE BODY IN IT.
 *
 * A BODY IN A ONE-SQUARE CORRIDOR IS NOT A WALL AND IS NOT A SQUARE. The walker's answer to
 * something in the way is `sidestepAround`, which tries the squares either side -- and in a
 * corridor one square wide there are none, so it falls through to marking the square taken
 * and replanning, which in a corridor means the long way or no way at all.
 *
 * But the pass is not a different SQUARE. It is a different fine `y` inside the same one.
 * Worked from the recorded jam in `tools/fixtures/sewers-108-row27.json` -- six giant rats
 * one per square centre on row 27 of the Sewers, 64 wire units apart, that never moved in
 * seventy seconds while three characters oscillated in the gaps and nobody got past:
 *
 *     corridor floor        y 1728 .. 1792     (64 wire units: exactly one square)
 *     a body fits between   y 1743.5 .. 1776.5 (PLAYER_RADIUS 15.5 off each wall)
 *     a rat sits at         y 1760, blocking within MIN_NOMOVEON = 16
 *     so a pass needs       y <= 1744  or  y >= 1776
 *
 * The two windows are half a unit wide, and the wire carries integers, so there is EXACTLY
 * ONE aim point on each side: 1744 and 1776. Aim anywhere else -- a square centre, a slid
 * position, the next square along -- and the move is refused. That is the seventy seconds.
 *
 * Offsets are tried nearest-first and a lane is kept only if BOTH ends still have floor,
 * because a lane that leaves the floor is not a lane, it is a fall.
 *
 * IT RETURNS AN AIM, NOT A PROMISE. `_traceMoverStep` still decides whether the step lands,
 * and a lane it refuses costs one refused step and authorises nothing.
 */
export function lanePastBodies({ fromX, fromY, toX, toY, bodies, hasFloor,
                                 minGap = MIN_NOMOVEON / (CLIENT_FINENESS / KOD_FINENESS),
                                 minOffset = 4, maxOffset = 28, step = 1,
                                 bodyRadius = PLAYER_RADIUS / (CLIENT_FINENESS / KOD_FINENESS) }) {
  if (!bodies?.length || typeof hasFloor !== 'function') return null;
  const dx = toX - fromX, dy = toY - fromY;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len;
  let best = null;
  for (let off = minOffset; off <= maxOffset; off += step) {
    for (const sign of [1, -1]) {
      const ox = px * off * sign, oy = py * off * sign;
      const ax = Math.round(fromX + ox), ay = Math.round(fromY + oy);
      const bx = Math.round(toX + ox), by = Math.round(toY + oy);
      if (!hasFloor(ax, ay) || !hasFloor(bx, by)) continue;
      // A LANE THE BODY CANNOT STAND IN IS NOT A LANE.
      //
      // `hasFloor` answers for a POINT, and a body is PLAYER_RADIUS wide. Shifting the line
      // sideways moves it toward one wall of the corridor, so the floor test that matters is
      // at the body's outer edge on that side, not at its centre. Measured on
      // tools/fixtures/flatlands-584-row35.json: a corridor 64 tall (y 2240..2304), a
      // spider on its centre line, and this proposed a lane starting at y 2249 — nine units
      // inside the 15.5 the mover keeps from a wall — which the mover then refused as
      // `body_lane` "no side to step to", twenty-one times in one afternoon, while three
      // characters were eaten in the pipe. The sewers arithmetic in m59-lane-test.mjs says
      // where the real lane is: exactly one integer per side of a centred body, half a unit
      // of margin, and the lane finder was aiming past it.
      const wx = px * sign * bodyRadius, wy = py * sign * bodyRadius;
      if (!hasFloor(Math.round(ax + wx), Math.round(ay + wy))
          || !hasFloor(Math.round(bx + wx), Math.round(by + wy))) continue;
      const m = gapAlongLine(ax, ay, bx, by, bodies);
      if (!(m.gap >= minGap)) continue;
      if (!best || m.gap > best.gap)
        best = { x: bx, y: by, fromX: ax, fromY: ay, gap: m.gap, off: off * sign };
    }
    if (best) break;
  }
  return best;
}

/**
 * THE PERP WALK — past a line of blockers by hugging the wall side that has room.
 *
 * The operator's description, 2026-09-01: measure each blocker's distance to the nearby
 * .roo edges, pick the side with sufficient clearance, draw the line perpendicular to the
 * blocker-to-wall line — that is, a line parallel to the wall at the clearance point —
 * and walk it past the blocker. It differs from `lanePastBodies` in what it measures: that
 * shifts the walker's OWN line sideways and asks whether the shifted line clears; this
 * starts from the BODIES and the WALLS and derives the one line a person would actually
 * walk, whichever way the walker happened to be facing.
 *
 * The arithmetic is the sewers' (m59-lane-test.mjs): a body needs `radius` (15.5) from a
 * wall and `clearance` (16) from a blocker's centre, and the client sweeps walls but not
 * bodies, so a step whose ENDPOINT is outside every blocker's disc is legal however close
 * the line passed. So the hug line is a straight line parallel to the walk axis at an
 * across-offset `h` with, for every blocker: h at least `clearance` from the blocker on the
 * chosen side, and h at most (floor extent - radius) toward the wall. The window between
 * those is often under a unit wide — in a 64-tall pipe with a centred body it is half a
 * unit — and the wire carries integers, so the points are rounded and re-checked.
 *
 * Returns null when nothing obstructs the stretch; otherwise the side, the offset, the
 * slack in the window, and two points: get on the hug line here, and the point past the
 * last blocker. A caller walks those with the fine mover and lets the ordinary walker
 * take over from the far point. The whole thing is pure, so the recorded Flatlands jam
 * pins it offline.
 */
// KEEP TO THE RIGHT WALL IN A CORRIDOR. A sewer pipe is one COARSE square wide — 64 fine
// units — and a character is a disc of radius 15.5 (PLAYER_RADIUS, 248 client units) that
// blocks another at MIN_NOMOVEON (16) between centres. So a pipe fits two lanes: a body
// hugging each wall leaves 64 - 2 * (15.5 + 2) = 29 between centres, nearly twice the
// blocking distance. The rule of the road is the operator's, 2026-09-01: BOTH directions
// keep to the right wall for THEIR direction of travel, so two characters meeting in a pipe
// pass like ships in the night instead of each aiming at the centre line and stalling nose
// to nose, which is what the recorded jams show (the sewers' row 27, the Flatlands' row 35).
// It applies always, not only when a body is in sight, because the character coming the
// other way is usually not visible yet when the lane is chosen — and the same rule has to
// be in every keeper for it to work at all. "Right" is the right-hand normal of the
// direction of travel in the game's y-down coordinates: (-uy, ux). A floor wider than
// `maxWidth` (a square and a half) is not a corridor and gets no lane; a corridor too
// narrow to shift in keeps the stand point (offset 0). Coordinates are wire (kod) units.
export function keepRightAim({ fromX, fromY, toX, toY, hasFloor,
                               radius = 15.5, margin = 2, probe = 4, maxWidth = 96 }) {
  const dx = toX - fromX, dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  if (!(len > 0.5) || typeof hasFloor !== 'function') return null;
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;                              // right of travel, y down
  const extent = (sx, sy) => {
    let d = 0;
    while (d < maxWidth && hasFloor(toX + sx * (d + probe), toY + sy * (d + probe))) d += probe;
    return d;
  };
  const right = extent(nx, ny), left = extent(-nx, -ny);
  const width = right + left;
  if (width > maxWidth) return { corridor: false, width, right, left, offset: 0, x: toX, y: toY };
  const offset = Math.max(0, right - radius - margin);
  return { corridor: true, width, right, left, offset,
           x: toX + nx * offset, y: toY + ny * offset };
}

export function perpWalkPastBodies({ fromX, fromY, toX, toY, bodies, hasFloor,
                                     radius = PLAYER_RADIUS / (CLIENT_FINENESS / KOD_FINENESS),
                                     clearance = MIN_NOMOVEON / (CLIENT_FINENESS / KOD_FINENESS),
                                     probe = 96, stride = 32,
                                     // PRECHECK THE LINE BEFORE WALKING IT. `segmentClear(ax, ay,
                                     // bx, by)` answers { ok, reason } for one straight fine move
                                     // — the caller hands in the room's own tracer with every
                                     // body as an obstacle — and a line that fails it is returned
                                     // as a refusal with `precheck` set, never walked. Measured
                                     // in tour 5: 13 of 20 failures were the first sidestep being
                                     // refused by geometry or by a body beside the walk, each one
                                     // a wasted packet at a square something was already hitting.
                                     segmentClear = null }) {
  if (!bodies?.length || typeof hasFloor !== 'function') return null;
  const dx = toX - fromX, dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const along = p => (p.x - fromX) * ux + (p.y - fromY) * uy;
  const across = p => (p.x - fromX) * nx + (p.y - fromY) * ny;
  const inWay = bodies.filter(b => Number.isFinite(b?.x) && Number.isFinite(b?.y))
    .map(b => ({ ...b, a: along(b), c: across(b) }))
    .filter(b => b.a > -clearance && b.a < len + clearance && Math.abs(b.c) < clearance + radius)
    .sort((p, q) => p.a - q.a);
  if (!inWay.length) return null;
  // How far the floor runs from a blocker's centre toward each wall, in units.
  const extent = (b, sign) => {
    let t = 0;
    for (; t <= probe; t += 1)
      if (!hasFloor(Math.round(b.x + nx * sign * t), Math.round(b.y + ny * sign * t))) break;
    return Math.max(0, t - 1);
  };
  const sides = [];
  for (const sign of [1, -1]) {
    let nearWall = sign > 0 ? Infinity : -Infinity;      // the tightest wall limit on this side
    let offBody = sign > 0 ? -Infinity : Infinity;       // the tightest body limit on this side
    for (const b of inWay) {
      const d = extent(b, sign);
      const wallLimit = b.c + sign * (d - radius);
      const bodyLimit = b.c + sign * clearance;
      if (sign > 0) { nearWall = Math.min(nearWall, wallLimit); offBody = Math.max(offBody, bodyLimit); }
      else { nearWall = Math.max(nearWall, wallLimit); offBody = Math.min(offBody, bodyLimit); }
    }
    const lo = sign > 0 ? offBody : nearWall, hi = sign > 0 ? nearWall : offBody;
    const slack = hi - lo;
    if (!(slack >= 0)) { sides.push({ sign, slack, feasible: false }); continue; }
    // NEAREST LEGAL LINE PAST THE BODY, NOT THE MIDDLE OF THE WINDOW. Measured in the wild
    // (tour 5, 2026-09-01): in a tight pipe the window is half a unit and the middle is the
    // only choice; in open ground the window was 64 wide, the middle put the first sidestep
    // 48 units out, and ten of twenty-one attempts were refused by geometry on that step. A
    // line a few units clear of the blocker is legal on both sides and a short sidestep.
    const lean = Math.min(slack / 2, 4);
    sides.push({ sign, slack, feasible: true, h: sign > 0 ? lo + lean : hi - lean, lo, hi });
  }
  const feasible = sides.filter(s => s.feasible).sort((p, q) => q.slack - p.slack);
  if (!feasible.length)
    return { side: null, bodies: inWay.length, sides,
             why: 'neither side has room for a body between the blockers and the wall' };
  const best = feasible[0];
  const last = inWay[inWay.length - 1].a;
  const past = last + clearance + stride;
  const P = a => ({ x: Math.round(fromX + ux * a + nx * best.h), y: Math.round(fromY + uy * a + ny * best.h) });
  const points = [];
  for (let a = 0; a < past; a += stride) points.push(P(a));
  points.push(P(past));
  // Every body in the room, not only the ones on the axis: a sidestep that lands inside
  // somebody standing beside the walk is refused just the same (object_blocked, tour 5).
  const everyBody = bodies.filter(b => Number.isFinite(b?.x) && Number.isFinite(b?.y));
  const clearOf = p => everyBody.every(b => {
    const ddx = b.x - p.x, ddy = b.y - p.y;
    return ddx * ddx + ddy * ddy >= clearance * clearance - 1e-6;
  });
  const bad = points.find(p => !hasFloor(p.x, p.y) || !clearOf(p));
  if (bad)
    return { side: best.sign, offset: best.h, slack: best.slack, bodies: inWay.length, sides,
             why: `the hug line ${hasFloor(bad.x, bad.y) ? 'enters a blocker\'s disc' : 'leaves the floor'} at ${bad.x},${bad.y}` };
  // The sidestep onto the line, sampled against every body: a body beside the walk is not
  // on the axis and `inWay` never saw it, but the step lands in its disc all the same.
  const start = { x: Math.round(fromX), y: Math.round(fromY) };
  const sidestep = points[0];
  const steps = Math.max(1, Math.ceil(Math.hypot(sidestep.x - start.x, sidestep.y - start.y) / 4));
  for (let i = 1; i <= steps; i++) {
    const p = { x: Math.round(start.x + (sidestep.x - start.x) * i / steps),
                y: Math.round(start.y + (sidestep.y - start.y) * i / steps) };
    const hit = everyBody.find(b => { const ddx = b.x - p.x, ddy = b.y - p.y; return ddx * ddx + ddy * ddy < clearance * clearance - 1e-6; });
    if (hit)
      return { side: best.sign, offset: best.h, slack: best.slack, bodies: inWay.length, sides,
               precheck: 'body', why: `precheck: the sidestep to the line passes through ${hit.name ?? 'a body'} at ${p.x},${p.y}` };
  }
  if (typeof segmentClear === 'function') {
    const legs = [[start, sidestep], ...points.slice(1).map((p, i) => [points[i], p])];
    for (const [a, b] of legs) {
      let verdict = null;
      try { verdict = segmentClear(a.x, a.y, b.x, b.y); } catch (e) { verdict = { ok: false, reason: 'precheck threw: ' + e.message }; }
      if (verdict && verdict.ok === false)
        return { side: best.sign, offset: best.h, slack: best.slack, bodies: inWay.length, sides,
                 precheck: verdict.reason === 'object_blocked' ? 'body' : 'geometry',
                 why: `precheck: ${verdict.reason ?? 'refused'} on ${a.x},${a.y} -> ${b.x},${b.y}` };
    }
  }
  return { side: best.sign, offset: best.h, slack: best.slack, bodies: inWay.length, sides,
           axis: { ux, uy }, points: [points[0], points[points.length - 1]], waypoints: points, past };
}

const STEP_MASK_BIT = new Map(DIRS.map((d, i) => [`${d.dr},${d.dc}`, 1 << i]));

// Where the .roo files live. The server tree and the client tree are separate copies
// and can differ (a mismatch black-screens the real client in that room), so prefer
// the server's, which is the one the geometry checks actually run against.
export const DEFAULT_ROO_DIRS = [
  process.env.M59_ROO_DIR,
  process.env.M59_ROOT && path.join(process.env.M59_ROOT, 'resource', 'rooms'),
  process.env.M59_ROOT && path.join(process.env.M59_ROOT, 'resource'),
  process.env.M59_ROOT && path.join(process.env.M59_ROOT, 'run', 'localclient', 'resource'),
  'C:/code/meridian59/resource/rooms',
  'C:/code/meridian59/run/localclient/resource',
  'C:/Program Files (x86)/Steam/steamapps/common/Meridian 59/resource',
].filter(Boolean);

// THE CLIP SWITCH, AND THE EXPERIMENT THAT SET IT.
//
// `M59_CLIP_STEPS=0` requires a step to END on ground the COARSE grid agrees exists.
// Default ON, and that is a measured result rather than the status quo winning by default.
//
// The permission plainly causes harm — see moverStepLands: one character aimed at the
// grid-solid square 7,15 sixty-one times in seventy seconds while holding a live order to
// cross the room, and 598 has 187 clip squares over 5.3% of its steps. So it was switched
// OFF and the offline suite asked what that costs. The answer was decisive and the wrong
// way round:
//
//   the Cragged Mountains' walkable body        2450 squares -> 672, in 1555 REGIONS
//   the mover vs the strict centre-to-centre    refuses MORE (1323) than strict (1186),
//                                               inverting the invariant routing depends on
//   exits reachable from the basin              cut
//
// So the fine-only ground in 598 is not a curiosity at its edges; it is most of the room.
// Requiring the coarse grid does not stop bots wandering into rock, it stops them walking
// at all. The permission stays until something replaces it with a PATH — see the note in
// moverStepLands about the rail this was supposed to be.
const CLIP_STEPS = process.env.M59_CLIP_STEPS !== '0';

export class RoomGeometry {
  constructor({ file, version, security, rows, cols, grid, flags, monsterGrid, walls, sidedefs,
                sectors, nodes, leaves, bspRoot = 0, clientSize, collisionVersion = null,
                edgeOpenings = null, edgeApproaches = null }) {
    Object.assign(this, { file, version, security, rows, cols, grid, flags, monsterGrid, walls,
                          sidedefs, sectors, nodes, leaves, bspRoot, clientSize, collisionVersion,
                          edgeOpenings, edgeApproaches });
    this._edgeOpeningCache = new Map();
    this._edgeApproachCache = new Map();
  }

  // The relief as a quick spread. Precise surfaces now live in `leaves`: each convex
  // polygon is directly associated with its sector and slope plane.
  get heightSummary() {
    if (!this.sectors?.length) return null;
    const f = this.sectors.map(s => s.floorHeight), c = this.sectors.map(s => s.ceilingHeight);
    return {
      sectors: this.sectors.length,
      floorMin: Math.min(...f), floorMax: Math.max(...f),
      ceilingMin: Math.min(...c), ceilingMax: Math.max(...c),
      sloped: this.sectors.filter(s => s.slopedFloor || s.slopedCeiling).length,
      wading: this.sectors.filter(s => s.depth > 0).length,
      // The interesting number: walls whose lower step is real but climbable, i.e.
      // stairs. A room with none of these is flat and the Z check cannot change it.
      steps: (this.walls || []).filter(w => w.z1 > w.z0 && (w.z1 - w.z0) <= MAX_STEP_HEIGHT).length,
      cliffs: (this.walls || []).filter(w => (w.z1 - w.z0) > MAX_STEP_HEIGHT).length,
    };
  }

  // Which grid to trust. monster_grid is the newer, stricter geometry — kod picks
  // between them with the server's LOS setting (Room.ReqSomethingMoved reads
  // GetLOS and calls CanMoveInRoomFine for the fine one). For planning, the
  // stricter grid is the safer answer: a route it accepts, the loose one accepts too.
  get moveGrid() { return this.monsterGrid || this.grid; }

  // WHICH GRID GOVERNS WHOM, and it is not a property of the room.
  //
  // room.kod:2102 reads ONE server-wide setting and picks per moving object:
  //
  //   LOS_OLD (0)          nobody uses the fine grid — coarse for players AND monsters
  //   LOS_NEW_MONSTER (1)  monsters fine, players coarse
  //   LOS_NEW_PLAYER (2)   players fine, monsters coarse
  //   LOS_NEW_BOTH (3)     everyone fine
  //
  // `piLOS = LOS_OLD` is the default (kod/util/settings.kod:119), so on a stock server
  // MONSTERS MOVE ON THE COARSE GRID. That matters more than it sounds: in West Merchant
  // Way the coarse grid connects 24% of the floor to the clifftop and the fine grid
  // connects 99.9%, so the two grids disagree about the whole point of the room.
  //
  // Everything in this file defaulted to fine:true, which is a reasonable default for
  // planning OUR OWN movement and a badly wrong one for predicting a monster's. Five
  // characters stood where the fine grid said a centipede could reach them and the coarse
  // grid said it could not, and the coarse grid was right.
  static LOS = { OLD: 0, NEW_MONSTER: 1, NEW_PLAYER: 2, NEW_BOTH: 3 };
  static monsterUsesFine(los) { return los === 1 || los === 3; }
  static playerUsesFine(los) { return los === 2 || los === 3; }

  // CAN A MONSTER STANDING THERE ACTUALLY GET TO HERE?
  //
  // Directed, because the search follows the outgoing direction bits of each square it
  // leaves, and a one-way ledge is expressible in that graph. This is the question the
  // safe-spot chooser has to ask and never did: it asked whether WE could reach the
  // square, which on a cliff is exactly the wrong end.
  // COORDINATE CONTRACT: both square pairs are `(row,col)`.
  monsterCanReach(fromRow, fromCol, toRow, toCol, { los = 0, maxNodes = 200000 } = {}) {
    const fine = RoomGeometry.monsterUsesFine(los);
    const r = this.path(fromRow, fromCol, toRow, toCol, { fine, maxNodes });
    return { reachable: !!r.found, steps: r.found ? r.steps.length : null,
             grid: fine ? 'fine' : 'coarse', los,
             ...(r.found ? {} : { why: r.reason }) };
  }

  // COORDINATE CONTRACT: square arguments are `(row,col)`.
  inBounds(row, col) { return row >= 1 && row <= this.rows && col >= 1 && col <= this.cols; }

  // Fine movement is allowed only with the complete, versioned collision payload.
  // Five-field legacy wall tuples can still draw a minimap, but cannot distinguish
  // directional sidedefs, low steps, low ceilings, or cliffs.
  // MEMOISED, BECAUSE THIS IS ASKED PER PATHFINDING NODE AND ANSWERS BY SCANNING THE ROOM.
  // The two `every()` walks below are O(leaves + walls), and `moverStepLands`/`walkable`
  // consult this for every candidate step — so a single path re-scanned the whole room
  // thousands of times. Measured on the live fleet before this cache: 96.6% of the broker's
  // entire CPU was in this file and 87% of it in these nine lines, which pegged the event
  // loop hard enough that only 2 or 3 of 21 characters ever reached the world.
  //
  // Safe to cache because the fields it reads are fixed at construction: nothing in this
  // repository assigns walls, leaves, sectors, nodes, bspRoot, security or collisionVersion
  // after a geometry is built, and a changed room arrives as a NEW instance via fromJSON.
  // Kept in a module-level WeakMap rather than on the object so it cannot reach toJSON and
  // end up baked into substrate/m59-map.json as a stored answer about geometry.
  get collisionReady() {
    const cached = COLLISION_READY_CACHE.get(this);
    if (cached !== undefined) return cached;
    const ready = this.collisionVersion === COLLISION_VERSION
      && Number.isInteger(this.security)
      && Array.isArray(this.walls) && Array.isArray(this.sectors) && this.sectors.length > 0
      && Array.isArray(this.leaves) && this.leaves.length > 0
      && Number.isInteger(this.bspRoot) && this.bspRoot > 0
      && Array.isArray(this.nodes) && this.nodes.length > 0
      && this.leaves.every(leaf => !!leaf.sector)
      && this.walls.every(wall => !wall.drawable || (wall.collisionMetadata === true
        && this.nodes[wall.collisionNode - 1]?.type === 'internal'));
    COLLISION_READY_CACHE.set(this, ready);
    return ready;
  }

  // COORDINATE CONTRACT: `(x,y)` is a fine point in 1024-unit client BSP space.
  leafAtClient(x, y, { preferSectorNum = null } = {}) {
    // BSPFindLeafByPoint (drawbsp.c) deliberately chooses the positive child on a
    // separator tie. Polygon containment cannot reproduce that rule on shared edges,
    // so collision-ready geometry always traverses the baked tree first.
    if (this.bspRoot && Array.isArray(this.nodes)) {
      let id = this.bspRoot;
      for (let depth = 0; id && depth <= this.nodes.length; depth++) {
        const node = this.nodes[id - 1];
        if (!node) return null;
        if (node.type === 'leaf') return node;
        // BSPFindLeafByPoint assigns its float expression to a C `long` before
        // branching. Values in (-1,1) therefore take the zero/positive-child path.
        const side = Math.trunc(separatorValue(node.separator, x, y));
        id = side === 0 ? (node.positive || node.negative)
          : side > 0 ? node.positive : node.negative;
      }
      return null;
    }
    if (!Array.isArray(this.leaves)) return null;
    const hits = [];
    for (const leaf of this.leaves) {
      if (Array.isArray(leaf.bbox) && leaf.bbox.length === 4) {
        const minX = Math.min(leaf.bbox[0], leaf.bbox[2]);
        const maxX = Math.max(leaf.bbox[0], leaf.bbox[2]);
        const minY = Math.min(leaf.bbox[1], leaf.bbox[3]);
        const maxY = Math.max(leaf.bbox[1], leaf.bbox[3]);
        if (x < minX - GEOMETRY_EPSILON || x > maxX + GEOMETRY_EPSILON
            || y < minY - GEOMETRY_EPSILON || y > maxY + GEOMETRY_EPSILON) continue;
      }
      if (pointInPolygon(x, y, leaf.polygon)) hits.push(leaf);
    }
    if (!hits.length) return null;
    return hits.find(leaf => leaf.sectorNum === preferSectorNum)
      ?? hits.sort((a, b) => (a.node ?? 0) - (b.node ?? 0))[0];
  }

  // COORDINATE CONTRACT: `(x,y)` is a fine point in 1024-unit client BSP space.
  floorBaseAtClient(x, y, leaf = null, { roomFlags = 0, overrideDepths = null } = {}) {
    leaf = leaf ?? this.leafAtClient(x, y);
    if (!leaf?.sector) return null;
    const depth = leaf.sector.depth ?? 0;
    const depthIndex = Number.isInteger(leaf.sector.flags)
      ? sectorDepth(leaf.sector.flags) : SECTOR_DEPTHS.indexOf(depth);
    const overrideBit = depthIndex > 0 ? 1 << (depthIndex - 1) : 0;
    if (overrideBit && (roomFlags & overrideBit)
        && Number.isFinite(overrideDepths?.[depthIndex])) return overrideDepths[depthIndex];
    return floorHeightAt(x, y, leaf.sector) - depth;
  }

  _blockingWall(from, to, leaf, {
    playerRadius, playerHeight, roomFlags, overrideDepths, motionZ,
  }) {
    const floor = this.floorBaseAtClient(from.x, from.y, leaf, { roomFlags, overrideDepths });
    if (floor == null) return { reason: 'start_has_no_floor' };
    // UserMovePlayer keeps the body's physical z for the whole command and tests
    // each substep at max(physical z, the floor under the previous point). In
    // particular, walking downhill does not make the body fall instantaneously and
    // thereby fit under an arch later in the same coordinate packet.
    const suppliedMin = Number.isFinite(motionZ?.min) ? motionZ.min
      : Number.isFinite(motionZ) ? motionZ : floor;
    const suppliedMax = Number.isFinite(motionZ?.max) ? motionZ.max
      : Number.isFinite(motionZ) ? motionZ : floor;
    const zMin = Math.max(Math.min(suppliedMin, suppliedMax), floor);
    const zMax = Math.max(Math.max(suppliedMin, suppliedMax), floor);
    const squareDistance = (x0, y0, x1, y1) => {
      const dx = f32(f32(x0) - f32(x1));
      const dy = f32(f32(y0) - f32(y1));
      return f32(f32(dx * dx) + f32(dy * dy));
    };
    const intersectNode = node => {
      if (Array.isArray(node.bbox) && node.bbox.length === 4) {
        if (f32(f32(node.bbox[0]) - f32(to.x)) > playerRadius
            || f32(f32(to.x) - f32(node.bbox[2])) > playerRadius
            || f32(f32(node.bbox[1]) - f32(to.y)) > playerRadius
            || f32(f32(to.y) - f32(node.bbox[3])) > playerRadius) return null;
      }
      const planeDistance = separatorValue(node.separator, to.x, to.y);
      const oldDistance = separatorValue(node.separator, from.x, from.y);
      const newDistance = f32(Math.abs(planeDistance) / CLIENT_FINENESS);
      if (newDistance > playerRadius || Math.abs(planeDistance) > Math.abs(oldDistance)) return null;
      let wallNumber = node.firstCollisionWall, guard = 0;
      while (wallNumber) {
        if (wallNumber > this.walls.length || guard++ >= this.walls.length)
          return { reason: 'collision_geometry_unavailable' };
        const wall = this.walls[wallNumber - 1];
        if (wall.collisionNode !== node.node) return { reason: 'collision_geometry_unavailable' };
        const minX = f32(Math.min(wall.x0, wall.x1) - playerRadius);
        const maxX = f32(Math.max(wall.x0, wall.x1) + playerRadius);
        const minY = f32(Math.min(wall.y0, wall.y1) - playerRadius);
        const maxY = f32(Math.max(wall.y0, wall.y1) + playerRadius);
        if (to.x >= minX && to.x <= maxX && to.y >= minY && to.y <= maxY) {
          const side = oldDistance > 0.001 ? 'pos' : 'neg';
          const crossable = canCrossWallAt(wall, to.x, to.y, zMin, side, { playerHeight })
            && canCrossWallAt(wall, to.x, to.y, zMax, side, { playerHeight });
          if (!crossable) {
            const d0 = squareDistance(to.x, to.y, wall.x0, wall.y0);
            const d1 = squareDistance(to.x, to.y, wall.x1, wall.y1);
            const wallLength2 = squareDistance(wall.x0, wall.y0, wall.x1, wall.y1);
            const radius2 = f32(playerRadius * playerRadius);
            let blocked = false;
            if (d0 > wallLength2) {
              const oldEnd = squareDistance(from.x, from.y, wall.x1, wall.y1);
              blocked = d1 < radius2 && d1 <= oldEnd;
            } else if (d1 > wallLength2) {
              const oldEnd = squareDistance(from.x, from.y, wall.x0, wall.y0);
              blocked = d0 < radius2 && d0 <= oldEnd;
            } else blocked = true;
            if (blocked) return { wall, index: wallNumber - 1, reason: 'geometry_blocked' };
          }
        }
        wallNumber = wall.nextCollisionWall;
      }
      return null;
    };

    // FindIntersection is pre-order DFS: current splitter, then positive subtree,
    // then negative subtree. The first blocking wall determines the stock slide.
    const stack = [this.bspRoot];
    while (stack.length) {
      const node = this.nodes?.[stack.pop() - 1];
      if (!node || node.type === 'leaf') continue;
      const hit = intersectNode(node);
      if (hit) return hit;
      if (node.negative) stack.push(node.negative);
      if (node.positive) stack.push(node.positive);
    }
    return null;
  }

  _resolveClientMicrostep(from, to, {
    slide, playerRadius, playerHeight, roomFlags, overrideDepths, motionZ,
  }) {
    const fromLeaf = this.leafAtClient(from.x, from.y, { preferSectorNum: from.sectorNum });
    if (!fromLeaf) return { ...from, moved: false, blocked: true, reason: 'start_has_no_floor' };
    const toLeaf = this.leafAtClient(to.x, to.y, { preferSectorNum: fromLeaf.sectorNum });
    if (!toLeaf) return { ...from, moved: false, blocked: true, reason: 'destination_has_no_floor' };

    const hit = this._blockingWall(from, to, fromLeaf,
      { playerRadius, playerHeight, roomFlags, overrideDepths, motionZ });
    if (!hit) return { x: to.x, y: to.y, sectorNum: toLeaf.sectorNum,
                       moved: Math.hypot(to.x - from.x, to.y - from.y) > GEOMETRY_EPSILON,
                       blocked: false };
    if (!hit.wall || !slide)
      return { ...from, moved: false, blocked: true, reason: hit.reason,
               wallIndex: hit.index };

    const dx = to.x - from.x, dy = to.y - from.y;
    const collisionOptions = {
      playerRadius, playerHeight, roomFlags, overrideDepths, motionZ,
    };
    const inspect = candidate => {
      const leaf = this.leafAtClient(candidate.x, candidate.y,
        { preferSectorNum: fromLeaf.sectorNum });
      if (!leaf) return { candidate, leaf: null, hit: { reason: 'destination_has_no_floor' } };
      return { candidate, leaf,
        hit: this._blockingWall(from, candidate, fromLeaf, collisionOptions) };
    };
    const project = (candidate, wall) => {
      const wallDx = wall.x1 - wall.x0, wallDy = wall.y1 - wall.y0;
      const denom = wallDx * wallDx + wallDy * wallDy;
      if (denom <= GEOMETRY_EPSILON) return { x: from.x, y: from.y };
      const moveDx = candidate.x - from.x, moveDy = candidate.y - from.y;
      const scale = (moveDx * wallDx + moveDy * wallDy) / denom;
      // SlideAlongWall assigns a C `(int)` projection: truncate toward zero.
      return { x: from.x + Math.trunc(wallDx * scale),
               y: from.y + Math.trunc(wallDy * scale) };
    };

    // Match UserMovePlayer's retry ladder. Project the entire requested substep
    // along the first blocking wall, retry against a second wall, then try one
    // small perpendicular move on either side before giving up. Higher-level FAN
    // headings are useful route exploration, but are not a replacement for these
    // within-command corner retries.
    let attempt = inspect(project(to, hit.wall));
    if (attempt.hit?.reason === 'collision_geometry_unavailable')
      return { ...from, moved: false, blocked: true, reason: attempt.hit.reason };
    if (attempt.hit?.wall) {
      attempt = inspect(project(attempt.candidate, attempt.hit.wall));
      if (attempt.hit?.reason === 'collision_geometry_unavailable')
        return { ...from, moved: false, blocked: true, reason: attempt.hit.reason };
    }

    if (attempt.hit) {
      const length = Math.hypot(dx, dy);
      if (length > GEOMETRY_EPSILON) {
        const sideX = -dy / length * MIN_SIDE_MOVE;
        const sideY = dx / length * MIN_SIDE_MOVE;
        const left = inspect({ x: from.x + Math.trunc(sideX),
                               y: from.y + Math.trunc(sideY) });
        if (left.hit?.reason === 'collision_geometry_unavailable')
          return { ...from, moved: false, blocked: true, reason: left.hit.reason };
        if (!left.hit) attempt = left;
        else {
          const right = inspect({ x: from.x - Math.trunc(sideX),
                                  y: from.y - Math.trunc(sideY) });
          if (right.hit?.reason === 'collision_geometry_unavailable')
            return { ...from, moved: false, blocked: true, reason: right.hit.reason };
          if (!right.hit) attempt = right;
        }
      }
    }

    if (attempt.hit) return { ...from, moved: false, blocked: true,
      reason: hit.reason, wallIndex: hit.index };
    const moved = Math.hypot(attempt.candidate.x - from.x,
      attempt.candidate.y - from.y) > GEOMETRY_EPSILON;
    return { x: attempt.candidate.x, y: attempt.candidate.y,
             sectorNum: attempt.leaf.sectorNum, moved,
             blocked: true, slid: moved, reason: hit.reason, wallIndex: hit.index };
  }

  _resolveObjectMicrostep(from, to, obstacles, {
    playerRadius, playerHeight, roomFlags, overrideDepths, motionZ,
  }) {
    for (const obstacle of obstacles) {
      if (!Number.isFinite(obstacle?.x) || !Number.isFinite(obstacle?.y)) continue;
      let dx = Math.abs(obstacle.x - to.x), dy = Math.abs(obstacle.y - to.y);
      const newDistance = dx * dx + dy * dy;
      const radius = obstacle.radius ?? MIN_NOMOVEON;
      if (dx > radius || dy > radius || newDistance > radius * radius) continue;
      const oldDx = Math.abs(obstacle.x - from.x), oldDy = Math.abs(obstacle.y - from.y);
      const oldDistance = oldDx * oldDx + oldDy * oldDy;
      if (newDistance > oldDistance) continue;

      // MoveObjectAllowed represents an OF_MOVEON_NO object as a square, pushes one
      // coordinate to its edge, then accepts the modified point only if walls allow it.
      const candidate = { x: to.x, y: to.y };
      if (dx < radius) candidate.x = obstacle.x > to.x ? obstacle.x - radius : obstacle.x + radius;
      else if (dy < radius) candidate.y = obstacle.y > to.y ? obstacle.y - radius : obstacle.y + radius;
      const staticResult = this._resolveClientMicrostep(from, candidate,
        { slide: false, playerRadius, playerHeight, roomFlags, overrideDepths, motionZ });
      const clearOfObjects = staticResult.moved && !staticResult.blocked && obstacles.every(other => {
        if (!Number.isFinite(other?.x) || !Number.isFinite(other?.y)) return true;
        const r = other.radius ?? MIN_NOMOVEON;
        const ox = staticResult.x - other.x, oy = staticResult.y - other.y;
        return ox * ox + oy * oy >= r * r - GEOMETRY_EPSILON;
      });
      if (clearOfObjects) return { ...staticResult, blocked: true, slid: true,
                                   stop: true, reason: 'object_blocked', objectId: obstacle.id };
      return { ...from, moved: false, blocked: true, stop: true,
               reason: 'object_blocked', objectId: obstacle.id };
    }
    return to;
  }

  // Simulate the real client's local collision pass for one fine-coordinate move.
  // Input and output are CLIENT units (1024/square). The broker converts its KOD
  // units (64/square) at the boundary and emits only the returned legal endpoint.
  traceFineMoveClient(x0, y0, x1, y1, {
    slide = true,
    playerRadius = PLAYER_RADIUS,
    playerHeight = PLAYER_HEIGHT,
    maxMicrostep = PLAYER_RADIUS / 2,
    obstacles = [],
    roomFlags = 0,
    overrideDepths = null,
    motionZ = null,
    // ON. See the refusal it controls, and STEP_MASK_VERSION 4.
    enforceStepHeight = true,
    // A BODY IN THE AIR, WHICH IS A DIFFERENT TRAVERSAL FROM A WALK.
    //
    // OFF BY DEFAULT AND IT MUST STAY THAT WAY. Everything about walking is pinned by 182
    // collision assertions and 122 refusals, several of them specifically about the body
    // keeping its physical z downhill and being blocked by a low overhang. Making this the
    // default was tried and it moved which WALL refuses a checked-in trace, which is the
    // one thing m59-impossible-test exists to catch. So a fall is asked for explicitly, by
    // the only thing that has any business asking: `fallTargets`.
    //
    // What it changes is one line of bookkeeping. Walking, the carried z follows the floor
    // in BOTH directions, so crossing a gully tests the walls at the bottom of it. Falling,
    // the body keeps the height it left with — that is what being in the air means — so the
    // walls it sails over are tested against a body above them. The operator's account of
    // the Cragged Mountains: the ground goes HIGH, LOW, MEDIUM, and a player runs off the
    // high side and lands on the medium side without ever standing on the low one. "The
    // player isn't walking from below, it's falling from above."
    fall = false,
  } = {}) {
    if (!this.collisionReady) return {
      available: false, moved: false, blocked: true, x: x0, y: y0,
      reason: 'collision_geometry_unavailable',
      note: 'this map predates collision metadata; rebuild or refresh its baked .roo geometry',
    };
    const startLeaf = this.leafAtClient(x0, y0);
    const startFloor = this.floorBaseAtClient(x0, y0, startLeaf,
      { roomFlags, overrideDepths });
    if (startFloor == null) return {
      available: true, moved: false, blocked: true, x: x0, y: y0,
      reason: 'start_has_no_floor',
    };
    // This is the player's physical height (or conservative vertical-motion range)
    // for one command. The floor under each previous microstep may raise collision
    // z, but a descent cannot lower it instantaneously inside the packet.
    const commandMotionZ = Number.isFinite(motionZ?.min) && Number.isFinite(motionZ?.max)
      ? { min: Math.min(motionZ.min, motionZ.max), max: Math.max(motionZ.min, motionZ.max) }
      : Number.isFinite(motionZ) ? motionZ : startFloor;
    let carriedMotionZ = Number.isFinite(commandMotionZ?.min)
      ? { min: Math.min(commandMotionZ.min, startFloor),
          max: Math.max(commandMotionZ.max, startFloor) }
      : { min: Math.min(commandMotionZ, startFloor), max: Math.max(commandMotionZ, startFloor) };
    const distance = Math.hypot(x1 - x0, y1 - y0);
    if (distance <= GEOMETRY_EPSILON)
      return { available: true, moved: false, blocked: false, arrived: true,
               x: x0, y: y0, motionZ: carriedMotionZ, destinationFloor: startFloor };
    const count = Math.max(1, Math.ceil(distance / Math.max(1, maxMicrostep)));
    const dx = (x1 - x0) / count, dy = (y1 - y0) / count;
    let at = { x: x0, y: y0, sectorNum: this.leafAtClient(x0, y0)?.sectorNum };
    // The ORIGIN square, so the per-microstep fineWalkable check can exempt it — see the
    // note at the check. Computed once here because it is the trace's own start, not the
    // character's reported square (a slid or respawned character can start off-centre).
    const startSqCol = Math.floor(clientToProtocol(x0) / KOD_FINENESS);
    const startSqRow = Math.floor(clientToProtocol(y0) / KOD_FINENESS);
    let blocked = false, slid = false, reason = null, wallIndex = null;
    for (let i = 0; i < count; i++) {
      const next = this._resolveClientMicrostep(at, { x: at.x + dx, y: at.y + dy },
        { slide, playerRadius, playerHeight, roomFlags, overrideDepths,
          motionZ: carriedMotionZ });
      const resolved = next.moved
        ? this._resolveObjectMicrostep(at, next, obstacles,
          { playerRadius, playerHeight, roomFlags, overrideDepths,
            motionZ: carriedMotionZ })
        : next;
      blocked ||= !!resolved.blocked;
      slid ||= !!resolved.slid;
      reason = resolved.reason ?? reason;
      wallIndex = resolved.wallIndex ?? wallIndex;
      if (!resolved.moved) break;
      const stepFrom = at;
      at = { x: resolved.x, y: resolved.y, sectorNum: resolved.sectorNum };
      // PER-MICROSTEP WALL CHECK: after each microstep,
      // verify the new position is in a fineWalkable
      // square. The BSP collision pass can miss thin
      // wall segments when the microstep lands on the
      // edge. An explicit square check catches it.
      //
      // ONLY ON SQUARES WE ENTER, NOT THE ONE WE LEAVE. A character can be standing on
      // a fine-unwalkable square — the server is client-authoritative and accepts any
      // position, and the fine grid is stricter than the server's own coarse grid, so
      // respawns and slid steps land on squares fineWalkable calls false. Blocking the
      // first microstep because the ORIGIN square is fine-unwalkable refuses all eight
      // edges from that square (every trace dies with fine_wall_edge on microstep one)
      // and traps the character in place for ever: JayB at Raza Inn (4,7), standing on
      // fineWalkable=false in an otherwise open room, unable to move in any direction
      // while the step mask and the coarse grid both said every step was legal. The
      // check keeps its purpose — a path that CROSSES a fine-unwalkable square in the
      // middle is still blocked — it just no longer vetoes the square the character
      // is already standing on and needs to walk off of.
      // A CELL-CENTRE TEST MAY NOT VETO A FINE TRACE, AND A DOORWAY IS WHY.
      //
      // This block used to reject the whole trace whenever a microstep TRANSITED a
      // square whose centre was `fineWalkable === false`. But fineWalkable tests the
      // CELL CENTRE against wall segments within the player radius (248), and a doorway
      // is exactly a cell whose centre sits close to its own frame. So every narrow
      // passage in the game became impassable.
      //
      // Measured on the shipped geometry for room 106, the Brownestone Inn -- the narrow
      // strip a character has to cross to leave the 300-unit pocket, which
      // m59-collision-test has guarded by name for a long time:
      //
      //   with this block:     arrived: false, blocked: true, reason: 'fine_wall_edge'
      //   without it:          arrived: true,  blocked: false
      //
      // And it was not buying anything: with the block removed, m59-mover-test's
      // "the mover did NOT cross the wall segment" still passes, because SEGMENT
      // crossing is caught by _blockingWall, which is the right test and was already
      // there. This was a coarse approximation vetoing a physics trace.
      //
      // Since movement is client-authoritative, our model is the only collision check
      // there is -- so a false refusal here is not a conservative choice, it is a
      // character that cannot leave a room.
      const leaf = this.leafAtClient(at.x, at.y, { preferSectorNum: at.sectorNum });
      const floor = this.floorBaseAtClient(at.x, at.y, leaf, { roomFlags, overrideDepths });
      // A CLIFF IS NOT A WALL, AND ONLY WALLS CAN REFUSE A CLIMB. OFF BY DEFAULT — THIS IS
      // A DIAGNOSIS WITH A SWITCH ON IT, NOT A FIX. Read the whole note before enabling it.
      //
      // `MAX_STEP_HEIGHT` had exactly one enforcement site in this file — `canCrossWallAt`
      // — and that returns TRUE immediately for a null sidedef. In the Cragged Mountains
      // the terrace edge has no sidedef at all: the wall there starts at z 4800, the TOP
      // of the drop, and runs up to the ceiling, so nothing spans the 1600 units between
      // the 3200 floor and the 4800 one. The face is a bare discontinuity between two
      // sectors, no wall crosses the step, and so nothing was ever asked.
      //
      // The result was a router that plans a 48-step walk out of a basin a player cannot
      // climb out of: 578's north exit sits at floor 3200 with 1503 squares around it, and
      // every other exit is at 4800 or above. The operator's account is that you arrive
      // there from The King's Way, cannot reach any other exit on foot, and blink is what
      // puts you on top of the cliff — which is what "joined only by blink" meant.
      //
      // PER MICROSTEP, WHICH IS WHAT SEPARATES A CLIFF FROM A RAMP. The Underworld climbs
      // hundreds of units over a square and is entirely legitimate, because it does it in
      // many small steps — profiled, 2176 -> 2560 and 3360 -> 3680, each inside the limit.
      // The Cragged Mountains face profiles flat at 3200 for seven eighths of the step and
      // then 1600 in one. Measured over 235,701 legal steps in ten rooms, 98.34% rise no
      // more than MAX_STEP_HEIGHT in any microstep and 1.66% would be refused, almost all
      // of them in 578. A rule that severed real staircases would show up here as a large
      // number; it does not.
      //
      // AGAINST THE BODY'S CARRIED HEIGHT, NOT THE FLOOR IT IS OVER — because you keep
      // moving horizontally while you fall.
      //
      // This comment used to say the opposite, and give a reason: measuring from
      // `carriedMotionZ.max` would let a body that had walked over a high ledge climb
      // anything for the rest of the command. That is not an abuse, it is the game's
      // DROP-JUMP, and the operator had already described it twice before I understood
      // it: you run off a ledge, you keep steering while airborne, you pass OVER a lower
      // place without ever standing in it, you catch the far side, and you take a ramp
      // back up.
      //
      // Measured floor-to-floor, that reads as a climb out of the gully you flew over. In
      // Ukgoth a 3-square gully with ledges at 5280 either side and 4576 between them came
      // out as a 704-unit ascent and was refused — while the operator crosses it. Measured
      // against the carried height, the body leaves 5280 and lands on 5280: no climb at
      // all, and the traversal stays legal.
      //
      // The cliff is unaffected, which is the point: standing in the Cragged Mountains
      // basin the carried height IS 3200, so the step to 4800 is still +1600 and still
      // refused. `carriedMotionZ` only ever rises within one step, so this cannot lower
      // the bar for a genuine climb from level ground — it only stops a fall being
      // mistaken for one.
      //
      // WHY IT IS OFF. Switched on it gets room 578 exactly right — the north exit can no
      // longer reach the southern ones, the southern ones still walk to it in 54 steps,
      // and the room splits into 13 regions, which is the operator's own account of the
      // place. It also costs more than that buys: 3 controls in m59-collision-test and 1
      // in m59-impossible-test break, all of them LEGITIMATE moves it now refuses —
      // Ukgoth's boundary crossings and the checked-in sloped-step case — and room 578's
      // routing view fragments to 146 pieces. Those are slopes, and a slope is a
      // continuous legal climb that this blanket per-microstep test cannot tell from a
      // face.
      //
      // WHAT A REAL FIX NEEDS. The stock client checks height when you cross BETWEEN
      // SECTORS, and a slope lies inside one sector, so the distinction is already the
      // right one — but narrowing this to `resolved.sectorNum !== stepFrom.sectorNum` was
      // tried and never fires, because the microstep resolver does not report a sector
      // transition at this face. Finding the crossing properly — the line between the two
      // leaves, and its floor heights on each side — is the work. Until then the
      // consequence is known and bounded: the router will offer a walking route out of the
      // Cragged Mountains basin that only a character holding blink can take.
      if (enforceStepHeight && Number.isFinite(floor)) {
        const carried = carriedMotionZ?.max;
        if (Number.isFinite(carried) && floor - carried > MAX_STEP_HEIGHT) {
          at = stepFrom;                       // the climb never happened
          blocked = true;
          reason = 'step_too_high';
          break;
        }
      }
      if (Number.isFinite(floor)) carriedMotionZ = fall
        // Airborne: the height only ever RISES to meet higher ground. Ground below the
        // body is passed over, not stood on, so it may not pull the tested z down with it.
        ? { min: Math.max(carriedMotionZ.min, Math.min(floor, carriedMotionZ.max)),
            max: Math.max(carriedMotionZ.max, floor) }
        : { min: Math.min(carriedMotionZ.min, floor),
            max: Math.max(carriedMotionZ.max, floor) };
      if (resolved.stop) break;
    }
    const moved = Math.hypot(at.x - x0, at.y - y0) > GEOMETRY_EPSILON;
    const arrived = Math.hypot(at.x - x1, at.y - y1) <= GEOMETRY_EPSILON;
    // STANDABLE, NOT WALKABLE. The coarse grid is a 1-byte-per-square projection that
    // lags the BSP on ledge edges and door alcoves — the Raza Blacksmith's door square is
    // coarse-blocked but fine-standable, and this check (the only coarse veto in the trace)
    // was the thing pinning a character at the room edge: every fine path to the door
    // crossed a coarse-walled square, so A* found nothing and the character sat down. The
    // client is AUTHORITATIVE for movement — nothing server-side consults the coarse grid
    // for a player move — so a square the BSP says holds somebody must not be vetoed by a
    // coarse byte that says otherwise. `standable` is exactly "coarse-walkable OR fine-
    // occupiable", which is what the mover's step predicate already uses.
    // A DESTINATION OFF THE MAP IS NOT A WALL, AND THIS TEST COULD NOT TELL THE DIFFERENCE.
    //
    // This rejected any trace whose destination square was not `standable`. But
    // `edgeCrossingRanges` traces from INSIDE a room to a point deliberately OUTSIDE the
    // grid -- that is what crossing a boundary IS -- so the destination is never standable
    // and EVERY crossing was rejected. Measured on room 536 north: 4 open ranges upstream,
    // ZERO here, and with the ranges empty edgeCrossingCandidates returns nothing, which
    // is why six assertions about edge approaches went red and, more to the point, why a
    // character could not find the way out of a room.
    //
    // It is the same mistake as the cell-centre veto removed from this trace earlier: a
    // COARSE standable test overruling a fine physics trace. The trace already knows
    // whether the move lands; `standable` only knows whether the server's one-byte grid
    // has floor there, and outside the room it has nothing at all.
    //
    // Added by 624e29a. Upstream has no such check.
    const destinationLeaf = this.leafAtClient(at.x, at.y, { preferSectorNum: at.sectorNum });
    const destinationFloor = this.floorBaseAtClient(at.x, at.y, destinationLeaf,
      { roomFlags, overrideDepths });
    return { available: true, x: at.x, y: at.y, moved, arrived,
             motionZ: carriedMotionZ, destinationFloor,
             blocked: blocked || !arrived, slid, reason: arrived ? null : (reason ?? 'geometry_blocked'),
             ...(wallIndex == null ? {} : { wallIndex }) };
  }

  // Fine BSP openings across each server room bound. StandardLeaveDir fires at the
  // first out-of-bounds KOD coordinate, so scan exactly to wire 63 on north/west and
  // `(size + 1) * 64` on south/east. An old square-centre target overshot this by
  // another 32 KOD units and turned legal edge exits into apparent wall collisions.
  edgeCrossingRanges(direction) {
    const name = String(direction ?? '').toLowerCase();
    if (!['north', 'south', 'west', 'east'].includes(name) || !this.collisionReady) return [];
    if (this._edgeOpeningCache.has(name)) return this._edgeOpeningCache.get(name);
    const baked = this.edgeOpenings?.[name];
    if (Array.isArray(baked)) {
      this._edgeOpeningCache.set(name, baked);
      return baked;
    }
    const horizontal = name === 'north' || name === 'south';
    const alongSquares = horizontal ? this.cols : this.rows;
    const insideFixed = name === 'north' || name === 'west'
      ? KOD_FINENESS + (KOD_FINENESS >> 1)
      : ((horizontal ? this.rows : this.cols) * KOD_FINENESS) + (KOD_FINENESS >> 1);
    const outsideFixed = name === 'north' || name === 'west'
      ? KOD_FINENESS - 1
      : ((horizontal ? this.rows : this.cols) + 1) * KOD_FINENESS;
    const ranges = [];
    let start = null, prior = null;
    for (let along = KOD_FINENESS; along < (alongSquares + 1) * KOD_FINENESS; along++) {
      const inside = horizontal ? { x: along, y: insideFixed } : { x: insideFixed, y: along };
      const outside = horizontal ? { x: along, y: outsideFixed } : { x: outsideFixed, y: along };
      const trace = this.traceFineMoveClient(
        protocolToClient(inside.x), protocolToClient(inside.y),
        protocolToClient(outside.x), protocolToClient(outside.y), { slide: false });
      const valid = trace.available && trace.arrived;
      if (valid && start == null) start = along;
      if (!valid && start != null) { ranges.push([start, prior]); start = null; }
      prior = along;
    }
    if (start != null) ranges.push([start, prior]);
    const frozen = ranges.map(range => Object.freeze(range));
    this._edgeOpeningCache.set(name, frozen);
    return frozen;
  }

  // THE FINE FALLBACK IS OPT-IN, AND UPSTREAM'S COARSE ANSWER IS THE DEFAULT.
  //
  // Wherever this file consults the server's coarse grid, a MOVER wants to fall back to
  // the BSP when the grid says wall: the grid is not authoritative for players (see
  // _occupiable), and 137 of 2164 recorded client positions sit in squares it calls
  // unwalkable. That is right for walking and WRONG FOR ROUTING, which is a different
  // question — "may a route be planned through here", where being generous invents roads.
  //
  // Applied everywhere it cost 12 assertions in m59-routing-test: room 27 began offering
  // the stranded 2500 boundary and planning an eight-hop route through it. So the fine
  // view is now asked for by the caller that wants it, and every caller that does not ask
  // gets exactly the upstream answer.
  edgeCrossingCandidates(direction, { fineNav = false } = {}) {
    const name = String(direction ?? '').toLowerCase();
    const horizontal = name === 'north' || name === 'south';
    if (!['north', 'south', 'west', 'east'].includes(name)) return [];
    const fixedInside = name === 'north' || name === 'west'
      ? KOD_FINENESS + (KOD_FINENESS >> 1)
      : ((horizontal ? this.rows : this.cols) * KOD_FINENESS) + (KOD_FINENESS >> 1);
    const fixedOutside = name === 'north' || name === 'west'
      ? KOD_FINENESS - 1
      : ((horizontal ? this.rows : this.cols) + 1) * KOD_FINENESS;
    const alongValues = new Set();
    for (const [start, end] of this.edgeCrossingRanges(name)) {
      // Square centres preserve ordinary grid paths where they really cross. The
      // midpoint and ends retain sub-square openings such as Cor Noth/Farol.
      for (let square = Math.floor(start / KOD_FINENESS);
           square <= Math.floor(end / KOD_FINENESS); square++) {
        const centre = square * KOD_FINENESS + (KOD_FINENESS >> 1);
        if (centre >= start && centre <= end) alongValues.add(centre);
      }
      alongValues.add(Math.round((start + end) / 2));
      alongValues.add(start);
      alongValues.add(end);
    }
    const all = [...alongValues].sort((a, b) => a - b).map(along => {
      const fineStand = horizontal ? { x: along, y: fixedInside } : { x: fixedInside, y: along };
      const edgeTarget = horizontal ? { x: along, y: fixedOutside } : { x: fixedOutside, y: along };
      return {
        fine_stand_on: fineStand,
        edge_target: edgeTarget,
        col: Math.floor(fineStand.x / KOD_FINENESS),
        row: Math.floor(fineStand.y / KOD_FINENESS),
      };
    })
    // YOU CANNOT CROSS OFF A SQUARE THE SERVER WILL NOT LET YOU STAND ON.
    //
    // These candidates come from tracing the BSP, and the BSP is not the authority on
    // where a player may BE — the server's one-byte movement grid is. The two disagree,
    // and the disagreement publishes exits that do not exist.
    //
    // Measured on the west wall of Main gate to the city of Tos, whose real openings are
    // at rows 20-23 and 43-48: a crossing was published at row 12, because the BSP does
    // have floor at that fine point. Square 12,1 is `walkable: false`. Its staging square
    // 12,3 is perfectly real — walkable, in the main body, three mover-neighbours — so
    // the router walked to it happily and then could never finish, because `neighbors()`
    // gates on the same grid that calls 12,1 unwalkable. From mid-room that phantom was
    // the NEAREST candidate, so it was chosen first, every time. Watched in the client it
    // is a character "trying to run north through a wall", which is exactly what it was.
    //
    // The operator's own knowledge of this wall — "48 to 46 is all the invisible wall
    // exit" — agrees with the grid and not with the BSP.
    //
    // AND IT MAY ONLY EVER PREFER — A FILTER MUST NEVER BE THE REASON A DOORWAY
    // DISAPPEARS. This is the same rule the step mask already lives under, and it is not
    // theoretical here: applied as a hard filter world-wide, three of 237 declared edge
    // directions lost every candidate. Being wrong about a phantom costs a walk; deleting
    // a real doorway costs the errand, silently, for ever.
    //
    // CORRECTION, 2026-08-18: the example named here used to be **Cor Noth west**, called
    // "a door that real players walk through every day". **There is no west exit from Cor
    // Noth** — the operator confirms it and the model was right. So that case argues the
    // OPPOSITE of what it was cited for, and this fallback is justified by the other two
    // directions rather than by it. The rule stands on the asymmetry alone, which is the
    // only part of the argument that was ever load-bearing.
    //
    // So the grid's opinion is applied only when it leaves something behind. The two
    // outcomes are not symmetric and the fallback is the safe one.
    //
    // Deliberately narrow in the other direction too: this is about EDGE crossings, where
    // leaving requires first standing on a boundary square. `go` exits are untouched —
    // their door tile is routinely unwalkable by design (the Royal Bank of Jasper) and
    // they are reached by fine positioning rather than by occupying the square.
    ;
    // THE GATE IS COARSE-FIRST, FINE-SECOND, ALL-LAST. The coarse grid is the server's own
    // map, so a candidate it calls walkable is the most trustworthy — it is what the server
    // will actually let the character stand on. But the coarse grid also holds a silent veto
    // over fine-open cells (coarse-wall/fine-open), and in a pocket the staging square can be
    // coarse-unwalkable while the fine geometry has real floor there. A filter must never be
    // the reason a doorway disappears, so a candidate the coarse grid vetoes is still offered
    // when the fine grid (the actual wall segments the game collides against) says it is open.
    //
    // Order of preference: coarse-walkable (server authority) > fine-walkable (geometry open)
    // > everything (the existing safe fallback — being wrong about a wall costs a walk, and
    // offering the whole crossing lets leaveViaAny try each square and report what happened).
    const coarseOk = all.filter(c => this.walkable(c.row, c.col));
    if (coarseOk.length) return coarseOk;
    if (fineNav) {
      const fineOk = all.filter(c => this.fineWalkable(c.row, c.col) === true);
      if (fineOk.length) return fineOk;
    }
    return all;
  }

  // A boundary opening is useful only when the character can approach it from a
  // square that the ordinary room router can reach. A perpendicular inside/outside
  // trace alone over-advertises decorative slits on the outside of a wall (Cor Noth
  // is the concrete counterexample). Resolve that question while baking and keep
  // the live exits() hot path to one coarse flood fill.
  edgeApproachCandidates(direction, { fineNav = false } = {}) {
    const name = String(direction ?? '').toLowerCase();
    if (!['north', 'south', 'west', 'east'].includes(name) || !this.collisionReady) return [];
    if (this._edgeApproachCache.has(name)) return this._edgeApproachCache.get(name);

    const baked = this.edgeApproaches?.[name];
    if (Array.isArray(baked)) {
      // SERIALIZED CONTRACT: each legacy entry is
      // `[fineX,fineY,edgeX,edgeY,stages,graph]`; the first four values are
      // x/y KOD/protocol units and every stage is `[col,row]`.
      const restored = baked.map(entry => Object.freeze({
        fine_stand_on: Object.freeze({ x: entry[0], y: entry[1] }),
        edge_target: Object.freeze({ x: entry[2], y: entry[3] }),
        col: Math.floor(entry[0] / KOD_FINENESS),
        row: Math.floor(entry[1] / KOD_FINENESS),
        stages: Object.freeze(entry[4].map(([col, row]) => Object.freeze({ col, row }))),
        graph_routable: entry[5] !== 0,
      }));
      // THE SAME GROUNDING RULE THE LIVE PATH USES, APPLIED ON READ.
      //
      // The bake carries crossings the SERVER'S MOVEMENT GRID says cannot be stood on,
      // because it was computed from BSP traces alone. Main gate to the city of Tos bakes
      // west approaches staging for rows 8,9,10,11,12,13,20,23,46,47,48 — and only 20, 23
      // and 46-48 are grid-walkable. The row-12 phantom is nearer to the middle of the
      // room than either real opening, so `exits()` chose it first, every time, and a
      // character walked to a staging square that is perfectly real, next to a crossing
      // that is not, and hugged that wall for ever.
      //
      // Filtered HERE rather than only in edgeCrossingCandidates because `exits()` reads
      // the baked list and never calls that function — which is why fixing it there
      // changed nothing on screen, and is worth writing down: the live derivation and the
      // baked table are two code paths for one question, and a rule added to one of them
      // is not a rule.
      //
      // Applied as a PREFERENCE, exactly as it is there: if grounding leaves an edge with
      // nothing, the unfiltered list stands.
      //
      // CORRECTION, 2026-08-18: this used to cite Cor Noth west as the case forcing that
      // fallback, "a door real players use daily whose crossings are all ungrounded".
      // There is no west exit from Cor Noth. The fallback is still right — it is the
      // asymmetry that justifies it, not that example.
      const groundedBake = restored.filter(a => this.walkable(a.row, a.col));
      const keep = Object.freeze(groundedBake.length ? groundedBake : restored);
      this._edgeApproachCache.set(name, keep);
      return keep;
    }

    const approaches = [];
    const MAX_STAGE_RADIUS = 4;
    for (const crossing of this.edgeCrossingCandidates(name, { fineNav })) {
      const stages = [];
      const seen = new Set();
      let firstStageRadius = null;
      for (let radius = 0; radius <= MAX_STAGE_RADIUS; radius++) {
        for (let row = crossing.row - radius; row <= crossing.row + radius; row++) {
          for (let col = crossing.col - radius; col <= crossing.col + radius; col++) {
            if (Math.max(Math.abs(row - crossing.row), Math.abs(col - crossing.col)) !== radius)
              continue;
            const key = `${col},${row}`;
            if (seen.has(key) || !this.inBounds(row, col) || !this.walkable(row, col)) continue;
            seen.add(key);
            const centreX = col * KOD_FINENESS + (KOD_FINENESS >> 1);
            const centreY = row * KOD_FINENESS + (KOD_FINENESS >> 1);
            const trace = this.traceFineMoveClient(
              protocolToClient(centreX), protocolToClient(centreY),
              protocolToClient(crossing.fine_stand_on.x),
              protocolToClient(crossing.fine_stand_on.y), { slide: false });
            if (trace.available && trace.arrived) stages.push({ col, row });
          }
        }
        if (stages.length && firstStageRadius == null) firstStageRadius = radius;
        // Nearby stages that reach the same fine point cover ordinary component
        // variation. Scanning all 81 squares for every simple square-centre edge made
        // a full setup bake take minutes without improving any executable route.
        if (firstStageRadius != null && radius >= Math.min(MAX_STAGE_RADIUS, firstStageRadius + 1))
          break;
      }
      if (stages.length) approaches.push(Object.freeze({
        ...crossing,
        fine_stand_on: Object.freeze({ ...crossing.fine_stand_on }),
        edge_target: Object.freeze({ ...crossing.edge_target }),
        stages: Object.freeze(stages.map(stage => Object.freeze(stage))),
        graph_routable: true,
      }));
    }
    const frozen = Object.freeze(approaches);
    this._edgeApproachCache.set(name, frozen);
    return frozen;
  }

  // PULL THE STRING TIGHT: A ROUTE OF SQUARES BECOMES A ROUTE OF PIVOTS.
  //
  // THE SQUARE IS THE WRONG UNIT AND THE GEOMETRY SAYS SO. Measured on room 587, whose
  // wall length is 54.9% NOT axis-aligned (45 deg and 135 deg are the largest non-axis
  // components): stepping centre-to-centre along a grid route, with the real fine
  // position carried forward, 143 of 242 steps fail — and 136 of those 143, **95%**, do
  // not move the character AT ALL. They are not slides landing in a neighbouring square;
  // they are one refused step, retried. `walkTo` then replans from an unchanged position,
  // gets the identical route, and asks for the same refused step again. Watched from
  // inside the game that is a character "barely wiggling" against a wall.
  //
  // The cause is that an axis-aligned step between two square CENTRES runs at 45 degrees
  // into a wall face that is itself at 45 degrees, and the trace refuses it. The operator
  // put it better than the measurements did: the rooms are "parallel lines going
  // diagonally", the walkable squares read as "bishop diagonals" over continuous floor,
  // and the natural unit would be a diamond rather than a box.
  //
  // SO DO NOT ARGUE WITH THE GRID — USE IT AND THEN THROW AWAY THE STEPS. The grid A* is
  // good at "which way round", which is the part the geometry makes hard. It is bad at
  // "and then walk it", which is the part the geometry makes unnecessary: most of a route
  // is straight line. Greedily reaching as far along the route as still clears geometry
  // turns 311 grid steps into 66 pivots across six routes in 587 — 4.7x fewer moves.
  //
  // EVERY LEG IS CHECKED WITH `slide: false`, WHICH IS STRICTER THAN A STEP. A slid step
  // is allowed to end somewhere other than it aimed; a leg here is kept only if the
  // straight line ARRIVES. So this cannot authorise a traversal the ordinary mover would
  // refuse — it can only refuse ones the mover would have allowed, which is the safe
  // direction and is why it needs no separate safety argument.
  //
  // IT SIMPLIFIES A ROUTE; IT DOES NOT REPAIR ONE. That distinction is the contract and
  // it was got wrong first time. When no further point on the route clears, the only
  // thing to fall back to is the ORIGINAL next step — which, on this geometry, is
  // frequently the very step the mover refuses. So the output can contain a leg that does
  // not arrive, and pretending otherwise would be a promise this cannot keep.
  //
  // The property that IS guaranteed: every leg spanning more than one grid step has been
  // checked to arrive. A single-step leg is passed through untouched and carries whatever
  // the square walk already had. `unverified` counts them, because a route that is mostly
  // unverified legs is one string-pulling cannot help with and the caller should know
  // rather than infer.
  //
  // Input and output are CLIENT units. `points` is the grid route including the start.
  /**
   * Cut every loop out of a route: if it visits a square twice, drop everything between.
   *
   * NOTHING SURPRISES A WALKER HERE. The walls were in the .roo before the character
   * logged in, and they will be there tomorrow — so a route that leaves a square and comes
   * back to it has learned nothing in between and the detour was pure waste. That is
   * trivial to see once the route is laid out in SPACE and effectively invisible while it
   * is being lived through one step at a time, which is exactly why the fleet used to
   * bounce `4,15->5,15` / `5,15->4,16` eight times and call it travelling.
   *
   * Last occurrence wins, in one pass with a Map: the final visit is the one that led
   * somewhere, and every earlier visit to the same square is the top of a cycle.
   *
   * WHAT IT CANNOT DO IS INVENT A TRAVERSAL, and that is the whole safety argument. Every
   * step it keeps was already in the route, adjacent to the step now before it, because
   * both ends of an excised cycle are THE SAME SQUARE — so the join is `X -> (whatever
   * followed X the last time)`, a pair the route itself already contained. It only ever
   * removes.
   *
   * Squares in, squares out. Give it `{row, col}` and it returns the same objects.
   */
  static elideLoops(squares) { return elideLoops(squares); }

  // `onWalkable` IS NOT OPTIONAL FOR A BAKE, AND THE DEFAULT IS OFF ONLY FOR COMPATIBILITY.
  //
  // The fine trace answers "does the straight line ARRIVE", which is a question about the
  // BSP. In 60 of 264 rooms the BSP has no opinion — `standable` is true for every square
  // in them — so the trace arrives through anything and the pull yanks the line across
  // whatever the COARSE grid calls rock. The three worst are the three rooms this fleet
  // dies in:
  //
  //     599 Ukgoth    standable all 4686   walkable 1753    8 deaths
  //     598 Cragged   standable all 2730   walkable  952    4 deaths
  //     578 Cragged   standable all 2450   walkable 1033    3 deaths
  //
  // Measured on 578's north route, 49,12 -> 1,13: the per-square route refuses zero
  // squares and the PULLED route walks 17 refused ones, including 42,10 -> 36,10, which
  // is a six-square straight run north with five of its squares solid. The route was
  // right and the pull broke it.
  //
  // So this samples the coarse grid under the line at half-square resolution and requires
  // every square to be floor. It is the same rule the mover enforces, applied at the one
  // moment it is cheap — once, offline, per leg. Callers that are not baking a route keep
  // the old behaviour, because a live caller asking "can I aim here" has the mover behind
  // it and does not need the pull to be conservative as well.
  // COORDINATE CONTRACT: input/output `{x,y}` points and the distance options are
  // all in 1024-units-per-square client/BSP space.
  stringPull(points, { arriveWithin = 64, maxProbe = 64, onWalkable = false } = {}) {
    if (!Array.isArray(points) || points.length < 2)
      return { points: points ?? [], unverified: 0, legs: 0 };
    const F = CLIENT_FINENESS;
    const sqOf = (x, y) => [Math.round(y / F - 0.5) + 1, Math.round(x / F - 0.5) + 1];
    // HALF A SQUARE, because a full-square stride can step over a one-square-thick wall
    // and report a line that is clear on both sides of the thing blocking it.
    const coarseClear = (a, b) => {
      const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (F / 2)));
      for (let k = 0; k <= n; k++) {
        const [r, c] = sqOf(a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n);
        if (this.walkable(r, c) !== true) return false;
      }
      return true;
    };
    const clear = (a, b) => {
      if (onWalkable && !coarseClear(a, b)) return false;
      const t = this.traceFineMoveClient(a.x, a.y, b.x, b.y, { slide: false });
      return !!t && Math.hypot(t.x - b.x, t.y - b.y) <= arriveWithin;
    };
    const out = [points[0]];
    // WHICH legs it proved, not just how many it could not. A caller that walks these
    // pivots has to know: a PROVED leg is a straight line the mover was shown to arrive
    // along, so every point on it is safe to aim at without asking again — which is the
    // whole reason to pull a route offline. An UNPROVED leg is the ordinary single step
    // that the pull fell back to, and it carries no such promise. Reported as a parallel
    // array so the existing `points`/`unverified` contract is untouched.
    const proved = [];
    let at = 0, unverified = 0;
    while (at < points.length - 1) {
      // FURTHEST FIRST, so the common case — a long clear run — costs one trace rather
      // than one per square. `maxProbe` bounds the scan on a very long route; without it
      // a 200-step route is O(n^2) traces at 0.44ms each, which is the cost that made
      // running the collision trace live cause a rejoin storm.
      const limit = Math.min(points.length - 1, at + maxProbe);
      let next = -1;
      for (let j = limit; j > at; j--)
        if (clear(points[at], points[j])) { next = j; break; }
      if (next < 0) { next = at + 1; unverified++; proved.push(false); }
      else proved.push(true);
      out.push(points[next]);
      at = next;
    }
    return { points: out, unverified, legs: out.length - 1, proved };
  }





  // COORDINATE CONTRACT: square arguments are `(row,col)`, kod-style 1-based.
  // Is there floor on this square?
  walkable(row, col) {
    if (!this.inBounds(row, col)) return false;
    return (this.flags[(row - 1) * this.cols + (col - 1)] & ROOM_FLAG_WALKABLE) !== 0;
  }







  // Fine-grid collision: is the centre of cell (r, c) inside an impassable wall
  // segment? This is the ground truth the game's collision actually uses (the wall
  // segments), NOT the coarse grid (this.walkable), which is a coarser approximation
  // that can mark open space as wall or vice versa.
  //
  // Why it matters: a player character moves on the fine grid (any direction, through
  // gaps the coarse grid calls wall), but monsters path NSEW on the coarse grid and
  // cannot enter a cell the grid marks as wall. So a cell that is coarse-WALL but
  // fine-open is a one-way safe spot: we can stand in it, a monster cannot step into it.
  //
  // Returns: true if walkable on the fine grid, false if inside a wall, null if the
  // geometry has no wall data (can't decide).
  fineWalkable(r, c) {
    const walls = this.walls;
    if (!walls || !walls.length) return null;
    const blocked = walls.filter(w => w.passable === false);
    if (!blocked.length) return true;
    const fx = (c + 0.5) * CLIENT_FINENESS, fy = (r + 0.5) * CLIENT_FINENESS;
    // A cell centre is blocked if it is within a quarter cell (256 fine units) of an
    // impassable segment. 256 is the player radius in fine units (the client collides
    // the character circle, not a point).
    const R = 256;
    for (const w of blocked) {
      const dx = w.x1 - w.x0, dy = w.y1 - w.y0;
      const L2 = dx * dx + dy * dy;
      let t = 0;
      if (L2 > 0) t = Math.max(0, Math.min(1, ((fx - w.x0) * dx + (fy - w.y0) * dy) / L2));
      const cx = w.x0 + t * dx, cy = w.y0 + t * dy;
      if (Math.hypot(fx - cx, fy - cy) < R) return false;
    }
    return true;
  }



  /**
   * Could a player be at this exact point? Floor under it, and a sector with an INTERIOR.
   *
   * "HAS A FLOOR HEIGHT" IS NOT "IS A PLACE", AND THE DIFFERENCE IS 33.8% OF THE WORLD.
   * `floorBaseAtClient` answers for any leaf carrying a sector, and the room compiler emits
   * sectors for the solid space OUTSIDE the room as well — filler with `ceilingHeight`
   * exactly equal to `floorHeight`. Asked for floor alone, 85,261 of the world's 252,320
   * unwalkable squares answer yes, and in The King's Way that swallowed 2,708 slabs of
   * rock into the room's own body, 263 of which the mover would have stepped into.
   *
   * AND THE SPACE HAS TO BE TALLER THAN THE PLAYER, which is not a rule about ducking.
   * I first wrote this as `ceiling > floor` and argued from a distribution that anything
   * finer was inventing a mechanic the game does not have: across six rooms 92.5% of leaf
   * sectors are 1536 units or taller, 5.7% are exactly zero, and the 24 in between are
   * 0.8%. That reasoning was wrong twice over. The measurement behind "and none of them is
   * a square the mover would enter" was itself broken, and when the operator was walked to
   * one of the survivors — The Queen's Way 22,10, floor 5632, ceiling 6144, 512 units of
   * room — it turned out to be the inside of a LOCKED TOWER. A building, not a crawlspace.
   *
   * So the rule is not "can you duck under it", it is "a 768-unit player is not inside a
   * 512-unit space". `PLAYER_HEIGHT` is the client's own figure (game.c:262) and it is the
   * same constant `traceFineMoveClient` already enforces for the space a move passes
   * through; asking it of the destination as well is consistency, not a new model.
   *
   * `ceilingHeightAt`/`floorHeightAt` rather than the raw sector fields, because both can
   * be sloped and a slope is exactly where the two could cross.
   */
  // COORDINATE CONTRACT: `(x,y)` is a fine point in client/BSP units.
  _occupiable(x, y) {
    const leaf = this.leafAtClient(x, y);
    if (!leaf?.sector) return false;
    if (this.floorBaseAtClient(x, y, leaf) == null) return false;
    const ceiling = ceilingHeightAt(x, y, leaf.sector);
    const floor = floorHeightAt(x, y, leaf.sector);
    if (!Number.isFinite(ceiling) || !Number.isFinite(floor)) return false;
    // AND THE SPACE HAS TO BE A SPACE -- BUT NOT TALLER THAN THE PLAYER. The paragraph above
    // this one is kept because its first half is right and its second half cost the 52->110
    // leg. Filler sectors with `ceilingHeight` equal to `floorHeight` are still refused, and
    // that is what stops rock being swallowed into a room body. `>= PLAYER_HEIGHT` is a
    // different claim, and the game does not make it.
    //
    // The client asks about height in exactly one place, at a WALL CROSSING, and only when
    // the wall carries an above texture (clientd3d/move.c:551):
    //
    //     (sidedef->above_bmap == NULL ||
    //      (sidedef->above_bmap != NULL && wall->z2 - z >= player.height))
    //
    // That is the wall's upper edge against the player's FEET. Nothing in the client and
    // nothing server-side (`UserMove` bypasses `ReqSomethingMoved`) asks whether a body fits
    // under the ceiling it is standing beneath. `stepAllowedByCollision` and
    // `_traceMoverStep` already enforce the crossing rule, which is where height lives.
    //
    // AND HEIGHT DOES NOT SORT WALKABLE FROM UNWALKABLE, which is the load-bearing fact. The
    // argument for 768 was one counter-example, The Queen's Way 22,10 at 512 units, found to
    // be the inside of a locked tower. But the whole distribution under 768 is a continuum,
    // and it is full of ground people walk on every day: the General Store of Jasper is 672,
    // East Ende is 640 across 354 squares, The Hungry Vaults 592 across 308. There is no
    // threshold that keeps the tower out and lets the shop in, because stature is not what
    // separates them -- ENCLOSURE is, and the trace already decides enclosure.
    //
    // WHAT THE INVENTED RULE COST. Room 108's jump take-off is entered by a sewer pipe at col
    // 47, rows 35-42: eight squares of dead-flat floor, 961 of 961 fine points standable at
    // one height, 704 units of headroom against the 768 demanded here. All eight refused,
    // `standPoint` null for every one, and the only way in vanished -- stranding the take-off
    // 29,43 on a 12-square island no anchor reached. That is the "no baked line to the anchor
    // 21,37" the ledger wrote 91 times, and why 52->110 and 2->110 never completed once. The
    // jump was never the problem: placed on the ledge, it clears 3 for 3.
    //
    // It returns 1.15% of the world -- 3961 squares over 74 rooms. An isolated pocket that no
    // route reaches costs bake time; a deleted corridor costs a leg that can never run.
    return ceiling - floor > 0;
  }

  /**
   * Is there anywhere in this square a player could be? A PRE-FILTER, not an authority.
   *
   * THE SERVER'S GRID IS NOT AUTHORITATIVE FOR PLAYERS AND NEVER WAS. `UserMove` bypasses
   * `ReqSomethingMoved` — room.kod's own comment is "already been checked by client
   * (HAHA!)" — so nothing server-side consults `ROOM_FLAG_WALKABLE` when a person walks.
   * The client is the only collision detector, and the client uses the BSP.
   *
   * Measured against the operator's own recorded walks: **137 of 2164 positions a real
   * client occupied are in squares this grid calls unwalkable, and every one of the 137
   * has real BSP floor under it**. 102 of them are in Western border of the Twisted Wood,
   * which is the room the fleet gets stuck in. The grid is one byte for a 1024-unit square
   * and this room's wall length is 54.9% NOT axis-aligned, so a 1-2 square wide corridor
   * cutting diagonally leaves squares that are 41%, 47%, 50%, 56% floor — and a byte has
   * to round them. 61 squares in that room are more than half floor and called wall.
   *
   * WHY A CHARACTER STANDING IN ONE COULD NOT MOVE AT ALL. `buildStepMask` gated on
   * `walkable` for the square being left as well as the square being entered, so such a
   * square got a mask byte of ZERO — no legal step in any direction. A character that slid
   * into one had no route to anywhere, replanned, was refused, and replanned again, which
   * on the board reads as `travelling` while the character twitches in a corner next to
   * the door it is trying to use.
   *
   * PERMISSIVE ON PURPOSE, BECAUSE THE TRACE IS THE REAL GATE. This only asks whether any
   * point in the square has floor; it does not ask whether the player CYLINDER fits, and
   * it must not, because `_traceMoverStep` already decides that with the stock client's
   * own rules and refuses to record an arrival otherwise. Being loose here costs bake
   * time. Being tight here deletes real ground, which is the failure above.
   *
   * The grid's YES is always honoured, so nothing that worked before can stop working.
   */
  // COORDINATE CONTRACT: square arguments are `(row,col)`.
  standable(row, col) {
    if (!this.inBounds(row, col)) return false;
    if (this.walkable(row, col)) return true;
    const i = (row - 1) * this.cols + (col - 1);
    const memo = (this._standable ??= new Uint8Array(this.rows * this.cols));
    if (memo[i]) return memo[i] === 2;
    // A 5x5 lattice — 205 units apart, comfortably finer than the 496-unit player
    // width, so a sliver that could actually hold somebody cannot fall between samples.
    let found = false;
    const x0 = (col - 1) * CLIENT_FINENESS, y0 = (row - 1) * CLIENT_FINENESS;
    for (let sy = 0; sy < 5 && !found; sy++)
      for (let sx = 0; sx < 5; sx++) {
        const x = x0 + Math.round((sx + 0.5) * CLIENT_FINENESS / 5);
        const y = y0 + Math.round((sy + 0.5) * CLIENT_FINENESS / 5);
        if (this._occupiable(x, y)) { found = true; break; }
      }
    memo[i] = found ? 2 : 1;
    return found;
  }

  /**
   * The point in this square to aim at, in CLIENT units, or null if there is nowhere.
   *
   * A SQUARE IS 1024 UNITS AND THE PLAYER IS 496 WIDE, SO "THE SQUARE" IS NOT A PLACE.
   * Every step in this repository was aimed at a square's CENTRE, which is the right point
   * for a square that is entirely floor and the wrong one for a square a diagonal wall cuts
   * in half — there, the centre is inside the wall, the trace refuses, and the square is
   * reported unreachable although a person walks through it daily.
   *
   * That is not a rare shape. Western border of the Twisted Wood has 54.9% of its wall
   * length off the axes and a corridor 1-2 squares wide running diagonally through it, so
   * the squares along it are 41%, 47%, 50%, 56% floor. Recognising them as ground
   * (`standable`) without moving the aim leaves them recognised and unreachable: measured,
   * that turned 277 of them into 277 isolated one-square regions.
   *
   * THE CENTRE WINS WHENEVER THE CENTRE HAS FLOOR, and that is what keeps this change from
   * rewriting behaviour it was not meant to touch. Every ordinary square in the world is
   * aimed at exactly as before, so the checked-in refusal traces and the collision suite
   * are asking the same questions they were.
   *
   * Otherwise the square is sampled and the FURTHEST-FROM-THE-EDGE floor sample wins —
   * crudely the medial axis of the floor within the square, which is where a body fits if
   * a body fits anywhere. It is an aim, not a promise: `_traceMoverStep` still has to get
   * there, still slides, and still has to land in this square, so a point this returns
   * that the mover cannot reach costs a refused step and authorises nothing.
   */
  // COORDINATE CONTRACT: square arguments are `(row,col)`; the named result is
  // `{x,y}` in 1024-unit client BSP space.
  standPoint(row, col) {
    if (!this.inBounds(row, col)) return null;
    const i = (row - 1) * this.cols + (col - 1);
    const memo = (this._standPoint ??= new Array(this.rows * this.cols));
    const hit = memo[i];
    if (hit !== undefined) return hit;
    const x0 = (col - 1) * CLIENT_FINENESS, y0 = (row - 1) * CLIENT_FINENESS;
    const half = CLIENT_FINENESS / 2;
    const centre = { x: x0 + half, y: y0 + half };
    if (!this.collisionReady || this._occupiable(centre.x, centre.y))
      return (memo[i] = centre);
    // N x N samples; N odd so the centre is one of them and the lattice is symmetric.
    const N = 9, step = CLIENT_FINENESS / N;
    const floor = [];
    for (let sy = 0; sy < N; sy++)
      for (let sx = 0; sx < N; sx++) {
        const x = x0 + Math.round((sx + 0.5) * step), y = y0 + Math.round((sy + 0.5) * step);
        if (this._occupiable(x, y)) floor.push({ x, y, sx, sy });
      }
    if (!floor.length) return (memo[i] = null);
    // Distance to the nearest sample that is NOT floor, counting the outside of the square
    // as not-floor: a point hard against the square's own boundary is a point whose body
    // hangs into the neighbour, and aiming there is how a step lands next door.
    const isFloor = new Set(floor.map(p => `${p.sx},${p.sy}`));
    let best = floor[0], bestScore = -1;
    for (const p of floor) {
      let d = Infinity;
      for (let sy = -1; sy <= N; sy++)
        for (let sx = -1; sx <= N; sx++) {
          if (sx >= 0 && sx < N && sy >= 0 && sy < N && isFloor.has(`${sx},${sy}`)) continue;
          const dd = Math.max(Math.abs(sx - p.sx), Math.abs(sy - p.sy));
          if (dd < d) d = dd;
        }
      // Ties go to the sample nearest the centre, so the answer is stable and as close to
      // the old behaviour as the geometry allows.
      const toCentre = Math.hypot(p.x - centre.x, p.y - centre.y);
      const score = d * 1e6 - toCentre;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return (memo[i] = { x: best.x, y: best.y });
  }

  /**
   * The same point, in WIRE units, ready to be put in a movement packet.
   *
   * ONE HOME FOR THE CONVERSION. The planner works in client units and the packet carries
   * wire units, and this repository has already paid once for that conversion being
   * written out at the call site — `x * 16` instead of `(x - 64) * 16` is a whole square,
   * and it fails hardest exactly where the geometry is tightest, so it reads as a local
   * map defect rather than as arithmetic.
   *
   * For any square whose centre is floor this returns `col * KOD_FINENESS + half` exactly,
   * which is the integer every caller used to compute inline — so ordinary movement is
   * unchanged to the byte, and only the squares a wall cuts in half move at all.
   */
  // COORDINATE CONTRACT: square arguments are `(row,col)`; the named result is
  // `{x,y}` in 64-unit kod wire space.
  standPointWire(row, col) {
    const p = this.standPoint(row, col);
    if (!p) return null;
    return { x: Math.round(p.x / CLIENT_PER_KOD + KOD_FINENESS),
             y: Math.round(p.y / CLIENT_PER_KOD + KOD_FINENESS) };
  }

  // COORDINATE CONTRACT: square arguments are `(row,col)`.
  // The eight direction bits of the square you are standing on.
  openDirections(row, col, { fine = true } = {}) {
    if (!this.inBounds(row, col)) return [];
    const g = (fine ? this.moveGrid : this.grid)[(row - 1) * this.cols + (col - 1)];
    return DIRS.filter(d => (g & d.mask) !== 0);
  }

  // CanMoveInRoom, faithfully — including its two surprising allowances: a move to
  // a square OUTSIDE the grid is not rejected here (that is how you leave a room),
  // and a jump of more than one square is waved through as a teleport.
  // COORDINATE CONTRACT: both square pairs are `(row,col)`.
  canMove(fromRow, fromCol, toRow, toCol, { fine = true } = {}) {
    const toInside = this.inBounds(toRow, toCol);
    if (toInside && !this.walkable(toRow, toCol)) return false;
    if (!this.inBounds(fromRow, fromCol)) return true;
    const dr = Math.sign(toRow - fromRow), dc = Math.sign(toCol - fromCol);
    if (Math.abs(toRow - fromRow) > 1 || Math.abs(toCol - fromCol) > 1) return true;
    if (dr === 0 && dc === 0) return true;
    const d = DIRS.find(x => x.dr === dr && x.dc === dc);
    const g = (fine ? this.moveGrid : this.grid)[(fromRow - 1) * this.cols + (fromCol - 1)];
    return (g & d.mask) !== 0;
  }

  // Every square reachable in one step, as an agent would actually step.
  /**
   * CAN THE MOVER ACTUALLY TAKE THIS STEP? Asked with the same trace the movement path
   * uses, because a router that plans on a different map from the one the mover enforces
   * does not produce a wrong route — it produces a character walking into a wall for ever.
   *
   * The two views really do disagree. `openDirections` and `walkable` are the SERVER's
   * coarse grid, one byte a square; `traceFineMoveClient` is the client's BSP with walls,
   * sector heights and the player radius in it. Since movement began being validated
   * against the second, planning against the first put the fleet in exactly that state:
   * squares the grid calls open, that the mover then refuses, re-planned every pass.
   *
   * MEMOISED, because A* on a 46x70 outdoor room asks this tens of thousands of times and
   * the answer for a given pair of adjacent squares never changes. The geometry object is
   * shared across sessions (sharedRoomGeometry), so the cache is filled once per room.
   *
   * NO GEOMETRY MEANS NO OPINION, not "refused". A room whose collision could not be baked
   * still has a usable coarse grid, and this must not be the thing that makes it unroutable.
   */
  // COORDINATE CONTRACT: both square pairs are `(row,col)`.
  stepAllowedByCollision(fromRow, fromCol, toRow, toCol) {
    if (!this.collisionReady || typeof this.traceFineMoveClient !== 'function') return true;
    const cache = (this._stepCollisionCache ??= new Map());
    const k = ((fromRow * this.cols + fromCol) << 4) ^ ((toRow - fromRow + 1) * 3 + (toCol - fromCol + 1));
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    const half = KOD_FINENESS >> 1;
    let ok = true;
    try {
      const t = this.traceFineMoveClient(
        protocolToClient(fromCol * KOD_FINENESS + half),
        protocolToClient(fromRow * KOD_FINENESS + half),
        protocolToClient(toCol * KOD_FINENESS + half),
        protocolToClient(toRow * KOD_FINENESS + half),
        { slide: false });
      ok = !!(t?.available && t?.arrived);
    } catch { ok = true; }        // a trace that throws is not evidence of a wall
    cache.set(k, ok);
    return ok;
  }

  // WHAT THE MOVER ACTUALLY DOES — WHICH IS NOT WHAT `stepAllowedByCollision` ASKS.
  //
  // The two questions look interchangeable and produce different worlds.
  //
  //   stepAllowedByCollision — does the straight line from one square CENTRE to the next
  //     arrive exactly, without sliding? A fair question about a LINE, and the wrong one
  //     about a character. The player is a disc of radius 248 in a square of 1024, so any
  //     centre within a quarter-square of a wall is a place nobody can stand — and a person
  //     walking that corridor never tries to stand there. Measured: it refuses 10% of
  //     grid-adjacent walkable pairs and breaks room 150 into 159 pieces and room 578 into
  //     214. That is plainly not what a room is, and it is why the collision-aware router
  //     was turned off rather than fixed.
  //
  //   this one — what `Session.validateFineTarget` will do with the same request: aim at
  //     the centre, SLIDE (the stock client's UserMovePlayer does), quantize toward the
  //     start, re-trace until an integer protocol endpoint is proved reachable — and then
  //     ask only whether that endpoint is IN THE TARGET SQUARE. `walkTo` compares squares,
  //     so an off-centre arrival is an arrival.
  //
  // The same rooms under the second question: 150 in 15 pieces with 96% of it in one, 578
  // in TWO with 99.4% in one, 545 in 10 with 98.5% in one. THAT is what a room is, and it
  // is why a router may plan on this and could never plan on the other.
  //
  // GEOMETRY ONLY, AND IT FAILS OPEN. The live mover also has monsters, room flags and
  // vertical motion in front of it and none of those can be baked, so this models the
  // WALLS and nothing else. Every step it allows is still validated for real before a
  // packet is sent; every step it refuses only costs a longer route. Being wrong here
  // cannot put a character through a wall — the direction the whole file cares about.
  //
  // MEMOISED, for the same reason `stepAllowedByCollision` is: A* asks tens of thousands
  // of times and the answer for a pair of adjacent squares never changes. The geometry is
  // shared across sessions, so the cache is filled once per room rather than once per
  // character. Prefer the baked mask (`attachStepMask`) where there is one — the cold cost
  // of filling this cache for a whole big room is seconds, which is exactly what stopped
  // the event loop the first time collision-aware routing shipped.
  /**
   * Squares this one can be JUMPED to — reached by running off an edge and landing
   * further on, over ground too low to walk out of.
   *
   * THE ROUTER PLANS IN SINGLE SQUARES AND A JUMP IS NOT ONE. Walked square by square the
   * Cragged Mountains crossing decomposes into HIGH -> LOW (a drop, allowed) and then
   * LOW -> MEDIUM (a climb of well over `MAX_STEP_HEIGHT`, refused), so the router
   * concludes the crossing is impossible. It is not: the player never stands on the LOW
   * square. In the operator's words, "the player isn't walking from below, it's falling
   * from above". Measured in room 598, 156 such triples exist and the walk refuses every
   * one of them; that room is the only way in and out of Castle Victoria, and a fleet sent
   * there stopped at The Twisted Wood and tried the same refused boundary seven times.
   *
   * FOUR CONDITIONS, AND EACH ONE IS LOAD-BEARING:
   *
   *   * DOWNHILL ONLY. The landing floor may not be above the take-off floor. This is the
   *     line between a fall, which gravity gives you, and a climb, which it does not — and
   *     without it this would re-open every cliff `enforceStepHeight` exists to close.
   *   * OVER A REAL GAP. Some square between the two must be lower than BOTH ends by more
   *     than `MAX_STEP_HEIGHT`. That is what makes it a jump rather than a slope, and it is
   *     why this cannot quietly become a way to skip along ordinary ground.
   *   * NOT ALREADY WALKABLE. If the square-by-square route exists, the walker should take
   *     it; a jump is strictly a last resort and never a shortcut.
   *   * AND THE BODY HAS TO ARRIVE. The fall trace has to land IN the target square, which
   *     is the same question `moverStepLands` asks of a step.
   *
   * DIRECTED, and deliberately: falling off a ledge does not give you a way back up. The
   * regions in the bake are strongly connected components, so a one-way fall shows up as
   * exactly that — which is what keeps `transitOk` honest about a return leg that does not
   * exist.
   */
  /**
   * Fall-jumps somebody WALKED and wrote down, starting on this square.
   *
   * Read lazily and cached per geometry, because most rooms declare none and the table is
   * tiny. The room number is the one the geometry was built for; a declaration for another
   * room is not this room's business.
   *
   * VALIDATED THE SAME WAY THE DETECTOR IS. A declared landing still has to be somewhere a
   * body can be (`standable`) and still has to be DOWNHILL, because the one thing a fall
   * must never become is a way to gain height — that is the line `enforceStepHeight` and
   * `fallTargets` both hold, and a hand-written table is exactly where somebody would
   * cross it by accident. An entry that fails either check is dropped rather than trusted,
   * and an entry with no landing square yet (`to: null`) is inert by construction.
   */
  // COORDINATE CONTRACT: square arguments are `(row,col)`; results use named fields.
  declaredFallJumps(row, col, options = null) {
    if (!this._declaredJumps) {
      this._declaredJumps = new Map();
      // Built in the same pass, because the two are the same table and letting them be
      // populated separately is how one of them ends up stale.
      this._declaredReverse = new Map();
      let table = null;
      try { table = declaredFallJumpTable(); } catch { table = null; }
      const mine = (table?.jumps ?? []).filter(j => Number(j.room) === Number(this.roomNum ?? this.num ?? -1));
      for (const j of mine) {
        if (!j?.from || !j?.to) continue;                       // unmeasured: inert
        // FINE COORDINATES WIN WHEN THE DECLARATION CARRIES THEM.
        //
        // A square is a summary and on jumping ground it is a false one — 40,33 in the
        // Ancient Place spans 3520 to 10880, the valley floor and the high ledge in one
        // square with one stand point. Validating a jump at stand points therefore asks
        // about a place the jump has nothing to do with: two candidates derived between
        // real footings were refused as "uphill" because the SQUARES read uphill while the
        // points did not.
        //
        // So `from_fine`/`to_fine` — client units, the same space `leafAtClient` speaks —
        // are used for every height and footing test when present, and the squares stay as
        // the index callers ask by. A declaration without them behaves exactly as before.
        const a = j.from_fine ?? this.standPoint(j.from.row, j.from.col);
        const b = j.to_fine ?? this.standPoint(j.to.row, j.to.col);
        // NOWHERE TO LAND is asked of the point when there is one, because the landing is
        // routinely a sliver: 38,30 is `walkable: false` and you jump onto it deliberately.
        if (j.to_fine) {
          const f = this.floorBaseAtClient(b.x, b.y, this.leafAtClient(b.x, b.y));
          if (!Number.isFinite(f)) continue;                     // no floor at the named point
        } else if (!this.standable(j.to.row, j.to.col)) continue; // nowhere to land
        if (a && b) {
          const fa = this.floorBaseAtClient(a.x, a.y), fb = this.floorBaseAtClient(b.x, b.y);
          if (Number.isFinite(fa) && Number.isFinite(fb) && fb > fa) continue;   // uphill is not a fall
        }
        const k = `${j.from.row},${j.from.col}`;
        const list = this._declaredJumps.get(k) ?? [];
        list.push({ row: j.to.row, col: j.to.col, dir: 'fall',
                    distance: Math.max(2, Math.round(Math.hypot(j.to.row - j.from.row, j.to.col - j.from.col))) });
        this._declaredJumps.set(k, list);
        // THE SAME DECLARATION, READ BACKWARDS. Indexed from the LANDING, naming the
        // take-off, so `neighbors` can ask "is this edge the reverse of a fall" without
        // re-scanning the table. It is not a second claim: a drop nobody can express as a
        // step is a climb nobody can make, and this is that fact filed under the square a
        // character in the hole is actually standing on.
        const rk = `${j.to.row},${j.to.col}`;
        const rlist = this._declaredReverse.get(rk) ?? [];
        rlist.push({ row: j.from.row, col: j.from.col });
        this._declaredReverse.set(rk, rlist);
      }
    }
    return options?.reverse
      ? (this._declaredReverse.get(`${row},${col}`) ?? [])
      : (this._declaredJumps.get(`${row},${col}`) ?? []);
  }

  // COORDINATE CONTRACT: square arguments are `(row,col)`; results use named fields.
  fallTargets(row, col, { maxDistance = FALL_MAX_SQUARES } = {}) {
    if (!this.collisionReady || !this.standable(row, col)) return [];
    const cache = (this._fallCache ??= new Map());
    const ck = `${row},${col}`;
    const hit = cache.get(ck);
    if (hit) return hit;
    const floorAt = (r, c) => {
      const p = this.standPoint(r, c);
      if (!p) return null;
      const f = this.floorBaseAtClient(p.x, p.y, this.leafAtClient(p.x, p.y));
      return Number.isFinite(f) ? f : null;
    };
    const from = this.standPoint(row, col);
    const startFloor = floorAt(row, col);
    const out = [];
    if (from && startFloor != null) {
      for (const d of DIRS) {
        for (let dist = 2; dist <= maxDistance; dist++) {
          const tr = row + d.dr * dist, tc = col + d.dc * dist;
          if (!this.inBounds(tr, tc) || !this.standable(tr, tc)) continue;
          const landFloor = floorAt(tr, tc);
          if (landFloor == null || landFloor > startFloor) continue;      // downhill only
          // a real gap under the flight path
          let gap = false;
          for (let k = 1; k < dist; k++) {
            const gr = row + d.dr * k, gc = col + d.dc * k;
            const gf = this.inBounds(gr, gc) ? floorAt(gr, gc) : null;
            if (gf == null) { gap = true; break; }                        // no floor at all
            if (startFloor - gf > MAX_STEP_HEIGHT && landFloor - gf > MAX_STEP_HEIGHT) gap = true;
          }
          if (!gap) continue;
          // already walkable, square by square? then this is not a jump.
          let walkable = true, at = { r: row, c: col };
          for (let k = 1; k <= dist && walkable; k++) {
            const nr = row + d.dr * k, nc = col + d.dc * k;
            if (!this.moverStepLands(at.r, at.c, nr, nc)) walkable = false;
            at = { r: nr, c: nc };
          }
          if (walkable) continue;
          const to = this.standPoint(tr, tc);
          if (!to) continue;
          const t = this.traceFineMoveClient(from.x, from.y, to.x, to.y, { slide: false, fall: true });
          if (!t?.available || !t.arrived) continue;
          out.push({ row: tr, col: tc, dir: d.name, distance: dist,
                     drop: startFloor - landFloor, fall: true });
          break;                        // the nearest landing in this direction is enough
        }
      }
    }
    cache.set(ck, out);
    return out;
  }

  // COORDINATE CONTRACT: both square pairs are `(row,col)`.
  moverStepLands(fromRow, fromCol, toRow, toCol) {
    if (!this.collisionReady || typeof this.traceFineMoveClient !== 'function') return true;
    if (!this.inBounds(toRow, toCol)) return false;
    // ======================= FINE-ONLY TERRAIN: ON BY DEFAULT  =======================
    //
    // `standable` returns true for a square the coarse grid calls SOLID whenever any part
    // of it holds fine floor. Requiring only that let the mover authorise a step INTO rock,
    // and the argument for it was sound in isolation: the coarse grid is a server artifact,
    // nothing server-side consults it for a player move, and vetoing on it removes ground
    // people demonstrably walk on.
    //
    // WHAT IT WAS FOR, AND WHAT IT BECAME. The idea was a rail. Precompute the fine walk
    // across a stretch of fine-only terrain between two reachable exits, and when a bot
    // reached the edge of the coarse grid it would clip ONTO that precomputed line, follow
    // it, and come off the far side back into ordinary travel. An alternative navigation
    // system for ground the coarse grid cannot express.
    //
    // No rail was ever consulted here. What survived is the permission without the path —
    // so instead of "follow the known line across", it means "the edge of the grid is
    // steppable", and a walker that meets one steps off the grid into rock, slides, and
    // comes back. Measured in the Cragged Mountains: square 7,15 is grid-solid, this
    // returned true for the step onto it, and one character aimed at it SIXTY-ONE times in
    // seventy seconds while holding a live order to cross the room. That room has 187 clip
    // squares and 334 clip steps, 5.3% of everything in it. It is not a shortcut; it is a
    // pit that opens wherever the grid ends.
    //
    // CORRECTED 2026-08-28. The paragraphs above are the argument for requiring the coarse
    // grid, and they end with "so the destination must be ground the coarse grid agrees
    // exists" — which is NOT what the line below does and has not been for some time. The
    // switch was flipped off, measured, and flipped back; CLIP_STEPS' own declaration holds
    // the numbers and is the authority. Re-measured today and unchanged: room 598's largest
    // connected body is 2513 squares with the permission and 720 without it, 578 goes 1439
    // -> 778. Requiring the coarse grid does not stop a bot walking into rock, it stops it
    // walking.
    //
    // So `M59_CLIP_STEPS=0` is the STRICT setting and it is NOT the default. This comment
    // said the reverse, and a reader who trusted it proposed "fixing" the polarity of the
    // line below — which would have taken 71% of the Cragged Mountains away from both live
    // fleets. See clipsweep, which has always called this disagreement the one that
    // "cannot be explained by coarseness".
    if (!(CLIP_STEPS ? this.standable(toRow, toCol) : this.walkable(toRow, toCol))) return false;
    const mask = this._stepMask;
    if (mask) {
      const bit = STEP_MASK_BIT.get(`${toRow - fromRow},${toCol - fromCol}`);
      if (bit !== undefined && this.inBounds(fromRow, fromCol))
        return (mask[(fromRow - 1) * this.cols + (fromCol - 1)] & bit) !== 0;
    }
    const cache = (this._moverStepCache ??= new Map());
    const k = ((fromRow * this.cols + fromCol) * 9)
            + ((toRow - fromRow + 1) * 3 + (toCol - fromCol + 1));
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    const ok = this._traceMoverStep(fromRow, fromCol, toRow, toCol);
    cache.set(k, ok);
    return ok;
  }

  // `validateFineTarget`'s arithmetic, with the live half (obstacles, room flags, vertical
  // motion) left out — see moverStepLands. Kept separate so the memo above stays a lookup.
  // COORDINATE CONTRACT: both square pairs are `(row,col)`.
  _traceMoverStep(fromRow, fromCol, toRow, toCol) {
    // AIMED AT THE SQUARE'S STAND POINT, WHICH IS ITS CENTRE FOR EVERY ORDINARY SQUARE.
    // See standPoint: a square a diagonal wall cuts in half has its centre in the wall, so
    // aiming there refuses a step people make daily. The sender must use the SAME point —
    // `Session.step` and walkTo's coalescer both call standPoint — or the planner and the
    // mover are back to asking different questions, which is the bug this file exists for.
    const from = this.standPoint(fromRow, fromCol);
    const to = this.standPoint(toRow, toCol);
    if (!from || !to) return false;
    const fromX = from.x, fromY = from.y, toX = to.x, toY = to.y;
    try {
      const requested = this.traceFineMoveClient(fromX, fromY, toX, toY, { slide: true });
      if (!requested.available || !requested.moved) return false;
      let qx = protocolToward(requested.x, fromX), qy = protocolToward(requested.y, fromY);
      let arrived = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        const trace = this.traceFineMoveClient(fromX, fromY,
          protocolToClient(qx), protocolToClient(qy), { slide: true });
        if (!trace.available || !trace.moved) return false;
        if (trace.arrived) { arrived = true; break; }
        const nx = protocolToward(trace.x, fromX), ny = protocolToward(trace.y, fromY);
        if (nx === qx && ny === qy) return false;
        qx = nx; qy = ny;
      }
      if (!arrived) return false;
      if (Math.floor(qx / KOD_FINENESS) !== toCol || Math.floor(qy / KOD_FINENESS) !== toRow)
        return false;
      // AND AT A HEIGHT CONSISTENT WITH THE SQUARE WE ARE RECORDING IT AS. A square is
      // 1024 units and a cliff face does not respect the lattice, so a square can straddle
      // one — 12,12 in the Cragged Mountains does. The mover slides up to the face and
      // stops on the square's LOW half, `walkTo` compares squares, and that counted as
      // arriving; the next step was then planned from the square's stand point 1600 units
      // higher than the character actually stood. Without this the climb rule above never
      // bites, because the step "succeeds" without ever going up.
      const landedFloor = this.floorBaseAtClient(protocolToClient(qx), protocolToClient(qy));
      const aimFloor = this.floorBaseAtClient(toX, toY);
      if (Number.isFinite(landedFloor) && Number.isFinite(aimFloor)
          && Math.abs(landedFloor - aimFloor) > MAX_STEP_HEIGHT) return false;
      return true;
    } catch { return true; }        // a trace that throws is not evidence of a wall
  }

  // ONE BYTE A SQUARE, ONE BIT A DIRECTION — the whole of `moverStepLands`, precomputed.
  //
  // This is what makes collision-aware routing affordable. The trace is correct and far
  // too slow to run in a keeper pass: synchronous, CPU-bound, and every session in the
  // broker shares one event loop, so a cold path in a big room measured 1.2s during which
  // no character's keepalive is answered. Shipped on by default it took twelve of
  // twenty-one characters out of the world in five minutes. Built offline it costs nothing
  // anybody is waiting on, and the runtime does an array index.
  //
  // The bit order is `STEP_MASK_DIRS` and it must never be reordered: a stored mask read
  // against a different order is a map of confidently wrong doors, which is worse than no
  // mask at all. That is why this lives here, next to the reader, rather than in the bake.
  buildStepMask() {
    const mask = new Uint8Array(this.rows * this.cols);
    for (let row = 1; row <= this.rows; row++) {
      for (let col = 1; col <= this.cols; col++) {
        // BOTH GATES ARE `standable` NOW, AND THE ONE ON THE SQUARE BEING LEFT IS THE ONE
        // THAT MATTERED. A square the coarse grid called wall got a mask byte of zero, so
        // a character standing in it — which happens, 137 recorded times — had no legal
        // step in any direction and could not plan its way out of a corridor it was
        // standing in the middle of.
        if (!this.standable(row, col)) continue;
        let bits = 0;
        for (let i = 0; i < STEP_MASK_DIRS.length; i++) {
          const d = STEP_MASK_DIRS[i];
          const r = row + d.dr, c = col + d.dc;
          if (!this.inBounds(r, c) || !this.standable(r, c)) continue;
          if (this._traceMoverStep(row, col, r, c)) bits |= (1 << i);
        }
        mask[(row - 1) * this.cols + (col - 1)] = bits;
      }
    }
    return mask;
  }

  // Adopt a mask built by tools/m59-routebake.mjs. Refused unless it is exactly the right
  // size for this room, because a mask off by one row is a map of the wrong doors and
  // nothing downstream would ever notice.
  attachStepMask(mask) {
    const usable = (mask instanceof Uint8Array) && mask.length === this.rows * this.cols;
    this._stepMask = usable ? mask : null;
    return usable;
  }

  get hasStepMask() { return !!this._stepMask; }

  // `blockedEdges` is a Set of "fromRow,fromCol>toRow,toCol" the CALLER has learned the
  // mover refuses — see walkTo in m59-broker.mjs. It is an edge and not a square on
  // purpose: a step is refused by the wall BETWEEN two squares, and blaming the square
  // removes a perfectly good place to stand that other neighbours can still reach.
  // COORDINATE CONTRACT: square arguments are `(row,col)`; results use named fields.
  neighbors(row, col, { fine = true, collision = false, blockedEdges = null,
                        allowInto = null, fineWiden = false } = {}) {
    const out = [];
    // WHICH MAP GETS TO SAY A STEP IS IMPOSSIBLE — and it must not be both.
    //
    // This iterated `openDirections`, which is the SERVER'S COARSE GRID: one byte a square,
    // and the thing MONSTERS move and see on. The mover's own answer was then applied as a
    // second filter. So a step needed permission from both, the coarse grid held a silent
    // veto, and the fleet navigated with monster permissions while being enforced with
    // player collision. That is the whole of "the bots behave like monsters", and it is why
    // a person walks corridors the router calls impossible.
    //
    // MEASURED AGAINST A HUMAN WALKING, 2026-08-17, room 587. Two steps taken at a run,
    // one second apart, in a corridor with nothing wrong with it:
    //
    //   53,28 -> 52,27   moverStepLands TRUE    coarse grid FALSE   router refused
    //   33,20 -> 34,20   moverStepLands TRUE    coarse grid FALSE   router refused
    //
    // Every square on both paths is walkable, has floor under its centre, and is 44-100%
    // covered. Nothing is wrong with the SQUARES; the EDGES were being vetoed by a map that
    // is not about players. `path()` reported no route at all between points the operator
    // ran between in one second.
    //
    // So with a baked mask, `moverStepLands` is the authority and the coarse grid gets no
    // veto: consider every direction and let the mover decide. WITHOUT a mask nothing
    // changes — the coarse grid is then the only opinion available, and a checkout that has
    // never run the bake behaves exactly as it always has, which is the property that makes
    // this safe to ship.
    //
    // THE DESTINATION GATE WAS `walkable` AND IS NOW `standable`, AND THAT WAS THE SECOND
    // HALF. This comment used to say the square question was left alone deliberately,
    // because both failing steps at the time had walkable endpoints and changing two
    // things at once is how a fix stops being measurable. That was right, and the
    // measurement has since been made: the coarse grid is a SERVER artifact that nothing
    // server-side consults for a player move, and 137 of 2164 positions in the operator's
    // own walk logs are squares it calls wall with real BSP floor under every one.
    //
    // Leaving it on `walkable` made the rest of this change inert. `moverStepLands` can be
    // as permissive as it likes; if `neighbors` never OFFERS the square, the router never
    // asks. Measured: converting only the mover moved room 587's region count not at all.
    const authoritative = collision && this.hasStepMask;
    // FINE-GRID FALLBACK: when the room has wall data but no baked step mask, the coarse
    // grid (openDirections) holds a silent veto over fine-open cells. The player moves on
    // the fine grid (any direction, through gaps the grid calls wall), so for unbaked
    // rooms we consider all eight directions and let fineWalkable(via wall-segment test)
    // decide per-destination. This is much cheaper than the full BSP trace in
    // moverStepLands (it is a point-near-segment test, not a raycast), so it is affordable
    // in a keeper pass even without a precomputed mask.
    //
    // It is a PERMISSIVE widening: a step the coarse grid already allows is kept (we do
    // not re-veto it); a step the coarse grid vetoes is reconsidered against the fine grid
    // and kept only if the destination is actually open in the wall segments. This means
    // a room whose coarse grid and walls agree behaves exactly as before.
    // `fineWiden` forces the fine fallback on even in the coarse (collision: false) path.
    // This is how exits()'s reachability flood can see past the coarse grid's silent veto
    // into fine-open cells (pockets), WITHOUT changing the coarse path for every other
    // caller — they simply don't pass fineWiden, and behave exactly as before.
    const fineFallback = !authoritative && fineWiden && (this.walls?.length > 0);
    const coarseDirs = fineFallback ? new Set(this.openDirections(row, col, { fine }).map(d => `${d.dr},${d.dc}`)) : null;
    const dirs = authoritative || fineFallback ? DIRS : this.openDirections(row, col, { fine });
    for (const d of dirs) {
      const r = row + d.dr, c = col + d.dc;
      if (!this.inBounds(r, c)) continue;          // leaving the room is a separate act
      // A cell is walkable if EITHER grid says so. The coarse grid is
      // the server's 1-byte-per-cell projection (what monsters use);
      // the fine grid is the BSP wall segments (what the player's
      // collision circle uses). For PATHFINDING we want the more
      // permissive option: if the coarse grid says a cell is open, the
      // server will accept a step there even if the BSP has a
      // no-collision decoration (tree, flagpole) in it. The fine grid
      // only blocks when the BSP actually has an impassable wall.
      if (fineFallback) {
        const fine = this.fineWalkable(r, c);
        const coarse = this.standable(r, c);
        if (fine === false && !coarse) continue;  // both say wall
        // fine === true OR coarse === true: allow the step
      } else {
        if (!this.standable(r, c)) continue;             // no wall data: use coarse grid
      }
      // AN OBSERVATION OUTRANKS A MODEL, AND THE GOAL IS EXEMPT FROM ONLY ONE OF THEM.
      // `blockedEdges` is a step we actually asked for and were actually refused, so it
      // applies everywhere including the last one — exempting the goal there is how a
      // walker loops forever on the step it has already failed. The collision mask is a
      // MODEL, and it is stricter than the world at exactly the squares that matter here:
      // a doorway is a pocket by design, and 346 of the 383 exit anchors this bake cannot
      // reach are `go` exits, whose square is the door tile itself. Refusing to plan a
      // route to a door because the model dislikes the last step into it costs the whole
      // errand; being wrong about that step costs one refused packet and a fine-positioned
      // correction, which `leaveVia` already does.
      if (blockedEdges?.size && blockedEdges.has(`${row},${col}>${r},${c}`)) continue;
      const isGoal = allowInto && r === allowInto.row && c === allowInto.col;
      // The mover's own answer, last because it is the expensive one.
      if (collision && !isGoal && !this.moverStepLands(row, col, r, c)) continue;
      out.push({ row: r, col: c, dir: d.name, diagonal: d.dr !== 0 && d.dc !== 0 });
    }
    // AND THE JUMPS. See fallTargets: a crossing the walk decomposes into a drop and then
    // an impossible climb is one a body makes in the air, in one move, without ever
    // standing on the low ground between. Offered only in the COLLISION view, because that
    // is the only view that knows how high anything is — on the coarse grid a fall is
    // indistinguishable from a walk and needs no help.
    //
    // A refused EDGE still refuses. `blockedEdges` is a step we asked for and were told no
    // about, and that answer is about the two squares, not about how we meant to travel
    // between them.
    if (collision && this.collisionReady) {
      for (const f of this.fallTargets(row, col)) {
        if (blockedEdges?.size && blockedEdges.has(`${row},${col}>${f.row},${f.col}`)) continue;
        if (out.some(o => o.row === f.row && o.col === f.col)) continue;
        out.push({ row: f.row, col: f.col, dir: f.dir, diagonal: false,
                   fall: true, distance: f.distance });
      }
      // AND THE ONES A PERSON HAD TO WALK TO FIND. `fallTargets` detects a jump from the
      // shape of the ground, and its second condition — some square between must be lower
      // than BOTH ends by more than MAX_STEP_HEIGHT — is what stops it becoming a way to
      // skip along ordinary terrain. That condition is right and it is not complete.
      //
      // Ukgoth is the counter-example. The operator's route to the ONLY doorway to Castle
      // Victoria is a run-and-fall from about 36,16 to about 38,10, and the ground under it
      // steps DOWN rather than opening into a gulley: 5872, 4576, 3712, 3840. The deepest
      // point is 128 units below the landing, well inside the 384 threshold, so no gap is
      // detected and `fallTargets` returns nothing at any reach. The jump is real; the
      // shape test cannot see it.
      //
      // The cost of having no way to say so was not a missing route. The router found the
      // doorway anyway, through ground the coarse grid calls solid, and twenty-one
      // characters "arrived" at Castle Victoria through rock in 17-23 seconds while the run
      // was read as proof that routing worked. A model with no word for a mechanic does not
      // decline to use it — it invents something else and reports success.
      //
      // So a declared jump is an OVERRIDE for the detector, never a replacement: it is
      // additive, it is still charged by distance like any other fall, a refused edge still
      // refuses it, and an entry with no landing square is inert. Nobody may declare their
      // way past `blockedEdges`. See substrate/m59-falljumps.json and m59-falljump.mjs.
      for (const j of this.declaredFallJumps(row, col)) {
        if (blockedEdges?.size && blockedEdges.has(`${row},${col}>${j.row},${j.col}`)) continue;
        if (out.some(o => o.row === j.row && o.col === j.col)) continue;
        out.push({ row: j.row, col: j.col, dir: j.dir ?? 'fall', diagonal: false,
                   fall: true, declared: true, distance: j.distance });
      }
      // A FALL IS ONE-WAY, AND ITS REVERSE MUST NOT BE AN EDGE.
      //
      // A declared jump exists precisely because the drop cannot be expressed as a step —
      // Ukgoth's is 5872 down to 3840, and the ground between it steps 1296 and 864 against
      // a MAX_STEP_HEIGHT of 384. The climb back is those same numbers upward. So the
      // reverse of a declared fall is, by construction, a traversal nobody can make.
      //
      // Nothing said so, and `moverStepLands` is permissive enough to offer some of those
      // reverse edges anyway: measured in 599, the single step 48,9 -> 47,10 climbs 416
      // units by the squares' own floors, `stepAllowedByCollision` refuses it and
      // `moverStepLands` — which is what the router plans on, deliberately — allows it.
      // One such edge is enough. A character in the gulley at 38,13 plans a SEVENTY-STEP
      // route back up to the take-off, walks at it, is refused, and re-plans the same route
      // for as long as anybody watches. From inside the game that is a bot swaying between
      // 44,19, 50,21 and 49,26 for ever, which is exactly what the operator reported.
      //
      // Barring the reverse is not a new claim about the map. It is the SAME claim the
      // declaration already makes, applied in the direction it was always true in.
      for (const j of this.declaredFallJumps(row, col, { reverse: true })) {
        const at = out.findIndex(o => o.row === j.row && o.col === j.col);
        if (at >= 0) out.splice(at, 1);
      }
    }
    return out;
  }

  // The nearest square with floor on it, for when something has put us somewhere the
  // geometry says is solid. That happens: an admin teleport, an in-game teleporter
  // whose landing square the .roo disagrees about, or a room whose grid and object
  // positions were authored slightly apart. From such a square NOTHING is reachable,
  // because every route starts by leaving it, so a caller that cannot get off it is
  // stuck for good.
  // COORDINATE CONTRACT: square arguments are `(row,col)`; the result is named.
  nearestWalkable(row, col, { maxRadius = 12 } = {}) {
    if (this.walkable(row, col)) return { row, col, distance: 0 };
    for (let r = 1; r <= maxRadius; r++) {
      let best = null;
      for (let dr = -r; dr <= r; dr++) {
        for (let dc = -r; dc <= r; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== r) continue;   // ring only
          const rr = row + dr, cc = col + dc;
          if (!this.walkable(rr, cc)) continue;
          const d = Math.hypot(dr, dc);
          if (!best || d < best.distance) best = { row: rr, col: cc, distance: d };
        }
      }
      if (best) return best;
    }
    return null;
  }

  // A* over the real geometry. Diagonals cost slightly more so paths hug the
  // straight line rather than staircasing, which matters because every step is a
  // separate second of wall-clock time.
  // `avoid` is a Set of "row,col" the caller has discovered are impassable even though
  // the geometry says otherwise — almost always a monster standing on one. The map
  // knows about walls and nothing about occupancy, so without this a route through a
  // blocked square is replanned identically for ever: the walker steps, does not move,
  // asks for a route from the same place, and is given the same one.
  // `threats` is the SOFT version of `avoid`, and the difference is the point.
  //
  // A monster is not a wall. Routing round it is worth some detour and not an
  // unbounded one, and a route that only exists through its reach is still a route we
  // have to take. So threats add COST rather than removing squares, and a path always
  // exists if the geometry allows one.
  //
  // The numbers come from the monster's own AI rather than from taste
  // (`monster.kod:1676`, `:1682`):
  //
  //   GetVisionDistance()  4 + viDifficulty/2   — "either 4, 5, or 6"
  //   GetAttackRange()     Bound(2 + viDifficulty/6, 2, 3)
  //
  // So there is a real band, two to three squares wide, where it has SEEN you and
  // still has to close the distance — which is exactly the band worth buying with a
  // detour, because crossing it at a run costs nothing and standing in it costs a
  // fight. Inside the attack radius you are simply being hit.
  //
  // Note this is `CanSee`, not line of sight: it is a plain distance test, so a
  // monster through a wall still notices. Revenants override vision to 9999 and cannot
  // be routed around at all, which is why the caller supplies the radius per monster
  // instead of this file assuming one.
  //
  // Each entry: { row, col, vision, reach }. Both radii optional; the defaults are the
  // middle of the published range.
  threatField(threats, { reachPenalty = 14, visionPenalty = 3 } = {}) {
    if (!threats?.length) return null;
    const pen = new Map();
    for (const t of threats) {
      const vision = t.vision ?? 6, reach = t.reach ?? 3;
      for (let r = t.row - vision; r <= t.row + vision; r++) {
        for (let c = t.col - vision; c <= t.col + vision; c++) {
          if (!this.inBounds(r, c)) continue;
          // Euclidean, because SquaredDistanceTo is (dr^2 + dc^2) on squares — the
          // same disc the monster itself measures, not a chebyshev box.
          const d = Math.hypot(r - t.row, c - t.col);
          if (d > vision) continue;
          // Full weight inside reach, then tapering out to nothing at the edge of
          // vision, so the router prefers the far side of a corridor without
          // refusing the near one.
          const add = d <= reach ? reachPenalty
                                 : visionPenalty * (1 - (d - reach) / Math.max(0.001, vision - reach));
          const k = (r - 1) * this.cols + (c - 1);
          pen.set(k, (pen.get(k) ?? 0) + add);
        }
      }
    }
    return (r, c) => pen.get((r - 1) * this.cols + (c - 1)) ?? 0;
  }

  // DO NOT HUG THE WALL ON THE WAY PAST IT — the routing half of the safe-spot lesson.
  //
  // A safe spot is a square the geometry hems in, and that is exactly what makes it worth
  // standing on. It is the last thing worth ROUTING THROUGH. A* with a plain step cost is
  // indifferent between the middle of a corridor and the wall of it, so it threads
  // characters along the tight side of every gap — where a step slides, the mover lands
  // somewhere the plan did not expect, and the walker starts the bounce this whole file
  // has been fighting. The clearance in a doorway is real and has to be spent; the
  // clearance in the open is free and was being given away.
  //
  // Expressed as COST, never as a prohibition, for the same reason threats are: a route
  // that only exists through a tight gap is still a route we have to take, and a bake must
  // never be the reason a doorway disappears. A square with all eight neighbours open pays
  // nothing; one wedged in a corner pays the most, and the router happily pays it when
  // there is no other way through.
  //
  // Measured off the MOVER's own step relation when a mask is baked, because that is the
  // thing that will be enforced — the coarse grid calls the tight side of a gap open, and
  // agreeing with it here is how the plan and the walk come apart. With no mask this
  // returns null and the router costs exactly as it did before any of this existed.
  // Weight ZERO by default, the same as `path`'s: this is a preference a caller asks for,
  // and the two defaults must agree or "the router's default" means one thing here and
  // another there.
  clearanceField({ weight = 0 } = {}) {
    if (!weight || !this.hasStepMask) return null;
    if (this._clearance?.weight !== weight) {
      const pen = new Float32Array(this.rows * this.cols);
      for (let r = 1; r <= this.rows; r++) {
        for (let c = 1; c <= this.cols; c++) {
          if (!this.standable(r, c)) continue;
          let open = 0;
          for (const d of DIRS) {
            const rr = r + d.dr, cc = c + d.dc;
            // Same predicate the router plans with, or the clearance penalty is measured
            // against a ring of neighbours that is not the ring it can actually step to.
            if (this.inBounds(rr, cc) && this.standable(rr, cc)
                && this.moverStepLands(r, c, rr, cc)) open++;
          }
          pen[(r - 1) * this.cols + (c - 1)] = (DIRS.length - open) * weight;
        }
      }
      this._clearance = { weight, pen };
    }
    const { pen } = this._clearance;
    return (r, c) => pen[(r - 1) * this.cols + (c - 1)] ?? 0;
  }

  // COORDINATE CONTRACT: both square pairs are `(row,col)`; returned steps are
  // named `{row,col}` objects. Movement callers must adapt their `(col,row)` API.
  path(fromRow, fromCol, toRow, toCol,
       { fine = true, maxNodes = 200000, avoid = null, threats = null, threatCost = null,
         blockedEdges = null, extraCost = null, fineNav = false,
         // How hard to prefer the open side of a gap — see clearanceField.
         //
         // OFF BY DEFAULT, AND THAT IS THE SAFE DIRECTION. A preference that shapes a long
         // route is a distortion in a short one: `world.reach` measures how far a SAFE
         // WALL is and `nearestSafeSpot` ranks at -0.5 a step, so switching this on
         // everywhere quietly became a penalty on the tight squares — which is what a safe
         // wall IS. Measured against the recorded book before it was turned off: 36.7% of
         // walks to a held wall came back longer, worst +9 steps, 4.5 points against a
         // proof bonus of 20. So callers doing LARGE routing ask for it — `leaveVia` does
         // — and everything tactical plans exactly as it did before any of this existed.
         clearance = 0,
         // ON WHEN, AND ONLY WHEN, IT IS FREE.
         //
         // Turning this on fleet-wide once caused a rejoin storm: the trace is synchronous
         // and CPU-bound, A* calls it tens of thousands of times, and every session in the
         // broker shares one event loop — so a cold 1.2s path stops the loop, keepalives go
         // unanswered, and twelve of twenty-one characters were out of the world in five
         // minutes. The idea was right and the cost was fatal.
         //
         // A baked mask (`attachStepMask`) removes the cost entirely: the answer is an
         // array index, so there is nothing left to budget. So the default is "collision-
         // aware if this room has a mask, coarse grid exactly as before if it does not" —
         // and a checkout that has never run tools/m59-routebake.mjs behaves precisely as
         // it did, which is the property that makes this safe to ship on.
         collision = this.hasStepMask,
         // WHAT A STEP ONTO GROUND THE COARSE GRID CALLS SOLID COSTS.
         //
         // THE INVARIANT THIS PRICES IS THE ONE THE WHOLE SUBSYSTEM RESTS ON, AND IT RUNS
         // BACKWARDS IN 211 ROOMS. The collision view is supposed to be STRICTER than the
         // coarse grid — a safe wall IS the two disagreeing, and the disagreement is meant
         // to run one way: the grid offers a neighbour and the BSP refuses it. That is why
         // a bake can only ever cost a walk and never authorise one. `m59-clipsweep.mjs`
         // counts where it runs the other way: 30,878 steps the mover allows onto squares
         // the grid calls solid, 1.8% of all steps, and 116 rooms whose baked exit anchor
         // can only be reached across them.
         //
         // Ukgoth is the case that cost an afternoon. Row 1 of room 599 is two patches of
         // floor with rock between; the mover walks 27 of the 28 squares of it, so the
         // router planned the crossing and twenty-one characters "arrived" at Castle
         // Victoria through solid rock in 17-23 seconds, which was read as proof that
         // routing worked.
         //
         // A COST AND NEVER A PROHIBITION, and the reason is measured too: 137 of the 2,164
         // positions in the operator's own recorded walk logs are squares the coarse grid
         // calls wall with real BSP floor under every one. Refusing those outright would
         // refuse the ground a person was standing on — the exact mistake `neighbors` was
         // changed to stop making. So the grid gets a VOTE, not a veto.
         //
         // Two is the number because it is what flips Ukgoth. From the 598 arrival to the
         // north doorway the clipping route is 110 steps of which 27 are rock, and the
         // honest route round is 153: at +2 a clip step the cheat prices out at 164 and
         // loses, at +1.5 it prices at 150 and still wins. Below 2 it does nothing; far
         // above 2 it starts pushing walks off legitimate tight corridors.
         //
         // The GOAL is exempt, for the same reason it is exempt from `clearance`: an exit
         // anchor and a safe wall are both squares somebody chose deliberately, and taxing
         // the destination for being tight prices the fleet out of its own doorways.
         clipCost = CLIP_STEP_COST,
         // WHETHER THE LAST STEP INTO THE GOAL MAY BE ONE THE MOVER REFUSES.
         //
         // `null` means "try without it, and only then with it", which is the default and
         // the whole point. See the two-pass below.
         goalExempt = null } = {}) {
    // TWO PASSES, STRICT FIRST — because the exemption is a FALLBACK, not a preference.
    //
    // `neighbors` lets the final step into the goal skip `moverStepLands`, so that a
    // doorway the model dislikes is never simply deleted from the map. That is right, and
    // on its own it is also how a walker gets a plan whose LAST step it can never take:
    // A* sees all eight approaches as equal, takes the cheapest, and hands back a route
    // ending in a step the mover refuses. `walkTo` then re-sends that step, lands
    // somewhere else, replans into the same corner, and reports "kept ending up somewhere
    // other than the planned square" — measured in Deep Forest of Farol, where the goal
    // 2,30 is reachable from FIVE of its eight neighbours and the planner chose the one
    // refused diagonal, stalling the character 21 steps from a door it could see.
    //
    // Asking strictly first costs nothing when a legal approach exists — same room, same
    // 12 steps, approached from 3,30 instead of 3,29 — and changes nothing when one does
    // not, because the second pass is exactly the old behaviour. So this can only ever
    // turn an unwalkable plan into a walkable one of the same length, never remove a
    // route: the property that makes it safe to ship against a live fleet.
    if (goalExempt === null) {
      const strict = this.path(fromRow, fromCol, toRow, toCol,
        { fine, maxNodes, avoid, threats, threatCost, blockedEdges, clearance, collision,
          clipCost, goalExempt: false });
      if (strict.found) return strict;
      const relaxed = this.path(fromRow, fromCol, toRow, toCol,
        { fine, maxNodes, avoid, threats, threatCost, blockedEdges, clearance, collision,
          clipCost, goalExempt: true });
      // Saying WHICH pass answered is what lets a caller — and a post-mortem — tell "the
      // mover will walk every step of this" from "the last step is a model disagreement
      // and may need a fine-positioned correction", which `leaveVia` already does.
      return relaxed.found ? { ...relaxed, goal_exempt: true } : relaxed;
    }
    threatCost = threatCost ?? this.threatField(threats);
    const clearanceCost = this.clearanceField({ weight: clearance });
    if (!this.inBounds(fromRow, fromCol)) return { found: false, reason: 'start is outside the room grid' };
    if (!this.inBounds(toRow, toCol)) return { found: false, reason: 'goal is outside the room grid' };
    if (!this.standable(toRow, toCol)) {
      // THE MOVER'S VIEW, ON REQUEST ONLY — see the note on edgeCrossingCandidates.
      // With fineNav the BSP overrules the coarse grid for the goal square; without it
      // the coarse grid is final, which is upstream's answer and the router's.
      const fine = fineNav && this.walls?.length > 0 ? this.fineWalkable(toRow, toCol) : null;
      if (!fineNav || fine === false)
        return { found: false, reason: 'goal square has no floor' };
    }
    if (fromRow === toRow && fromCol === toCol) return { found: true, steps: [] };

    // STANDING ON A SQUARE IS PROOF THAT IT IS STANDABLE, whatever the grid says.
    //
    // This used to refuse outright — `stuck: true`, "nothing is reachable from here
    // until you step onto solid ground" — and it was self-inflicted bad news. The
    // character IS there. The server put it there and is perfectly happy about it. The
    // only thing claiming otherwise is a one-byte-per-square projection we have now
    // caught being wrong three separate ways in one afternoon: a doorway strip in the
    // Brownestone Inn, half a square edge in the Limping Toad, and this.
    //
    // And it does not even need the grid to be wrong. Our position can simply be a
    // moment stale — moves are dead-reckoned and the server is the authority — so a
    // character mid-step reads as standing in a wall, which is the same thing a person
    // sees when the client lags behind the server and the door will not open for a
    // second.
    //
    // Either way the refusal is the worst available answer: it is returned BEFORE any
    // packet is sent, so a character that could simply have walked is told it is
    // trapped. It accounted for the first of the seven refusals on every failed edge
    // crossing, and it is emitted by us, about us, on no evidence.
    //
    // So: start from the nearest square the grid does believe in and prepend the step
    // to it. Fine movement covers that first hop with local BSP collision, not the grid.
    let start = { row: fromRow, col: fromCol }, lead = null;
    // ...and `standable` is what makes that comment true rather than aspirational. Asked
    // the grid's way, a character standing in a diagonal corridor square was "off the
    // floor" and had its route start somewhere else — every walk, from a square it was
    // legitimately on.
    if (!this.standable(fromRow, fromCol)) {
      // Fine grid is the source of truth. If the fine grid says the start
      // is walkable, the character is fine — don't drag it to nearestWalkable.
      const fine = fineNav && this.walls?.length > 0 ? this.fineWalkable(fromRow, fromCol) : null;
      if (fine !== true) {
        const near = this.nearestWalkable(fromRow, fromCol);
        if (!near) return { found: false, reason: 'no floor anywhere near the starting square', stuck: true };
        start = near;
        lead = { row: near.row, col: near.col, dir: null, recovered: true };
        if (near.row === toRow && near.col === toCol) return { found: true, steps: [lead] };
      }
    }
    fromRow = start.row; fromCol = start.col;

    const key = (r, c) => (r - 1) * this.cols + (c - 1);
    const h = (r, c) => {
      const dr = Math.abs(r - toRow), dc = Math.abs(c - toCol);
      return Math.max(dr, dc) + 0.001 * Math.min(dr, dc);
    };
    const gScore = new Map([[key(fromRow, fromCol), 0]]);
    const came = new Map();
    // A binary heap keeps this usable on the big outdoor rooms, which reach
    // 60x60 and would make a linear scan quadratic.
    const heap = [{ r: fromRow, c: fromCol, f: h(fromRow, fromCol) }];
    const push = n => {
      heap.push(n);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p].f <= heap[i].f) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l].f < heap[m].f) m = l;
          if (r < heap.length && heap[r].f < heap[m].f) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };

    let expanded = 0;
    const closed = new Set();
    while (heap.length && expanded < maxNodes) {
      const cur = pop();
      const ck = key(cur.r, cur.c);
      if (closed.has(ck)) continue;
      closed.add(ck);
      expanded++;
      if (cur.r === toRow && cur.c === toCol) {
        const steps = [];
        let at = ck, rr = cur.r, cc = cur.c;
        while (came.has(at)) {
          const prev = came.get(at);
          steps.push({ row: rr, col: cc, dir: prev.dir,
                       ...(prev.fall ? { fall: true, distance: prev.distance } : {}) });
          rr = prev.row; cc = prev.col; at = key(rr, cc);
        }
        steps.reverse();
        // `lead` is the recovery step onto believable floor, when we started somewhere
        // the grid does not think exists. It is first because it happened first.
        return { found: true, steps: lead ? [lead, ...steps] : steps, expanded,
                 ...(lead ? { recovered_from: { row: start.row, col: start.col } } : {}) };
      }
      for (const n of this.neighbors(cur.r, cur.c,
             { fine, collision, blockedEdges,
               allowInto: goalExempt ? { row: toRow, col: toCol } : null })) {
        const nk = key(n.row, n.col);
        if (closed.has(nk)) continue;
        // Never the GOAL, only the way there: if the destination itself is occupied we
        // still want the route, because whatever is standing on it will move and the
        // caller would otherwise be told the square is unreachable for ever.
        if (avoid && !(n.row === toRow && n.col === toCol) && avoid.has(`${n.row},${n.col}`)) continue;
        // THE GOAL IS EXEMPT FROM THE CLEARANCE COST, and only from that one. Walking to
        // a wall corner is the point of a safe spot, and taxing the destination for being
        // a tight square would price the fleet out of the one move that keeps it alive.
        // It shapes which way we go, never where we may go.
        const atGoal = n.row === toRow && n.col === toCol;
        // A JUMP COVERS SEVERAL SQUARES AND MUST BE PRICED FOR THEM. Charged as one step it
        // would be the cheapest move on the board and the router would look for cliffs to
        // throw itself off; charged by its distance it competes with the walk on honest
        // terms and wins only where the walk cannot go at all.
        const cost = (gScore.get(ck) ?? Infinity)
                   + (n.fall ? (n.distance ?? 2) : n.diagonal ? 1.4142 : 1)
                   + (threatCost ? threatCost(n.row, n.col) : 0)
                   + (clearanceCost && !atGoal ? clearanceCost(n.row, n.col) : 0)
                   // BOTH TERMS, because they are different questions that happened to
                   // land on the same line. `extraCost` is this checkout's caller-supplied
                   // penalty; `clipCost` is upstream's charge for a square the coarse grid
                   // calls unwalkable. Taking either side alone silently drops a cost the
                   // other half of the merge depends on.
                   + (extraCost && !atGoal ? extraCost(n.row, n.col) : 0)
                   + (clipCost && !atGoal && !this.walkable(n.row, n.col) ? clipCost : 0);
        if (cost >= (gScore.get(nk) ?? Infinity)) continue;
        gScore.set(nk, cost);
        // AND WHETHER THIS STEP IS A FALL, WHICH THE PLAN USED TO THROW AWAY.
        //
        // `neighbors` marks a drop `fall: true` and `fallTargets` proved it with
        // `traceFineMoveClient(..., { fall: true })` — a different predicate from the walk
        // trace, and the only one that lets a body leave a ledge. Reconstructing the route
        // kept `row`, `col` and `dir` and dropped the flag, so every caller downstream saw
        // an ordinary two-square step, attempted it in walk mode, and was refused by the
        // cliff face. That is the whole of why the mountain rooms cost two to three times
        // the theoretical minimum while every flat room on the same road costs exactly 1.00x.
        came.set(nk, { row: cur.r, col: cur.c, dir: n.dir,
                       ...(n.fall ? { fall: true, distance: n.distance ?? 2 } : {}) });
        push({ r: n.row, c: n.col, f: cost + h(n.row, n.col) });
      }
    }
    // WHICH VIEW SAID NO IS PART OF THE ANSWER. "No route on the coarse grid" is a claim
    // about the room; "no route the mover will walk" is a claim about our model of it, and
    // the caller is entitled to retry on the grid rather than report a wall where people
    // walk. Without this the two are one string and nothing can tell them apart.
    return { found: false, expanded,
             ...(collision ? { collision_view: true } : {}),
             ...(blockedEdges?.size ? { blocked_edges: blockedEdges.size } : {}),
             reason: expanded >= maxNodes ? 'search budget exhausted'
                   : collision || blockedEdges?.size
                     ? 'no route the mover can walk through this geometry'
                     : 'no route through the geometry' };
  }

  // How much of the room is floor. A near-zero figure usually means the parse is
  // wrong rather than that the room is solid, so it doubles as a sanity check.
  get walkableCount() {
    let n = 0;
    for (let i = 0; i < this.flags.length; i++) if (this.flags[i] & ROOM_FLAG_WALKABLE) n++;
    return n;
  }

  // The minimap, as text. This is the point of the whole file: one glance and both
  // an agent and a human can see the shape of the room, where the walls are, and
  // where everything stands.
  //
  //   '#' no floor          '.' floor
  //   '+' floor you cannot leave in any direction (a hole in the adjacency graph)
  //   digits/letters are marks, passed in as {row, col, ch, label}
  render({ marks = [], fine = true, legend = true } = {}) {
    const markAt = new Map();
    for (const m of marks) if (this.inBounds(m.row, m.col)) markAt.set((m.row - 1) * this.cols + (m.col - 1), m);

    const wide = this.cols > 100;
    const lines = [];
    // Column ruler in tens, so a coordinate can be read off the picture.
    const tens = ' '.repeat(5) + Array.from({ length: this.cols }, (_, i) =>
      (i + 1) % 10 === 0 ? String(Math.floor((i + 1) / 10) % 10) : ' ').join('');
    lines.push(tens);

    for (let row = 1; row <= this.rows; row++) {
      let s = String(row).padStart(4) + ' ';
      for (let col = 1; col <= this.cols; col++) {
        const k = (row - 1) * this.cols + (col - 1);
        const m = markAt.get(k);
        if (m) { s += m.ch; continue; }
        if (!this.walkable(row, col)) { s += '#'; continue; }
        s += this.openDirections(row, col, { fine }).length ? '.' : '+';
      }
      lines.push(s);
    }
    if (legend) {
      lines.push('');
      lines.push(`${this.rows} rows x ${this.cols} cols, ${this.walkableCount} walkable squares` +
                 `${this.monsterGrid ? ' (fine grid present)' : ' (no fine grid — v' + this.version + ')'}`);
      lines.push(`# no floor   . floor   + floor with no exits` +
                 (marks.length ? '   ' + marks.map(m => `${m.ch} ${m.label ?? ''}`).join('  ') : ''));
      if (wide) lines.push('(wide room — the picture may wrap in a narrow terminal)');
    }
    return lines.join('\n');
  }

  // The minimap the way the client draws it: wall segments, not squares. Rendered at
  // twice the grid resolution so a wall BETWEEN two floor squares is visible — which
  // is the whole point, since the walkability grids disagree by 21% of squares and a
  // wall on a square boundary is what they are disagreeing about.
  //
  // Coordinates in the wall list are the client's fine units (1024 per square), so a
  // wall endpoint maps to canvas cell (2*x/1024, 2*y/1024).
  // includeMapNever defaults TRUE here, unlike the client. WF_MAP_NEVER hides walls
  // that would clutter a player's map — outer shells, counter edges — but an agent is
  // not looking at a picture, it is reasoning about a space, and a room drawn without
  // them has holes in its outline that read as ways out.
  renderWalls({ marks = [], includePassable = true, includeMapNever = true } = {}) {
    if (!this.walls?.length) return null;
    const H = this.rows * 2 + 1, W = this.cols * 2 + 1;
    const canvas = Array.from({ length: H }, () => new Array(W).fill(' '));

    // Floor squares first, so walls draw over them.
    for (let r = 1; r <= this.rows; r++)
      for (let c = 1; c <= this.cols; c++)
        if (this.walkable(r, c)) canvas[(r - 1) * 2 + 1][(c - 1) * 2 + 1] = '.';

    const put = (cx, cy, ch) => {
      if (cy < 0 || cy >= H || cx < 0 || cx >= W) return;
      // A real wall always beats a passable one, and both beat floor.
      const cur = canvas[cy][cx];
      if (ch === '·' && cur !== ' ' && cur !== '.') return;
      canvas[cy][cx] = ch;
    };

    for (const w of this.walls) {
      if (!w.drawable) continue;                      // map.c skips these outright
      if (w.mapNever && !includeMapNever) continue;   // WF_MAP_NEVER
      if (w.passable && !includePassable) continue;
      const s = 2 / CLIENT_FINENESS;
      let x0 = Math.round(w.x0 * s), y0 = Math.round(w.y0 * s);
      const x1 = Math.round(w.x1 * s), y1 = Math.round(w.y1 * s);
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      // A doorway is drawn differently because walking through it is legal, and an
      // agent reading the picture needs to see the difference between a wall and a way.
      const ch = w.passable ? '·' : (dx === 0 ? '|' : dy === 0 ? '-' : (sx === sy ? '\\' : '/'));
      let err = dx - dy;
      for (;;) {
        put(x0, y0, ch);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx) { err += dx; y0 += sy; }
      }
    }

    for (const m of marks) {
      if (!this.inBounds(m.row, m.col)) continue;
      canvas[(m.row - 1) * 2 + 1][(m.col - 1) * 2 + 1] = m.ch;
    }

    const lines = [];
    for (let y = 0; y < H; y++) {
      const row = Math.floor(y / 2) + (y % 2 ? 1 : 0);
      const label = y % 2 ? String(row).padStart(4) + ' ' : '     ';
      lines.push(label + canvas[y].join(''));
    }
    return lines.join('\n');
  }

  // What the wall list says about the room, as counts. Useful as a parse check: a
  // room with zero drawable walls is almost certainly a misread rather than a void.
  get wallSummary() {
    if (!this.walls) return null;
    return {
      total: this.walls.length,
      drawable: this.walls.filter(w => w.drawable).length,
      passable: this.walls.filter(w => w.passable).length,
      map_never: this.walls.filter(w => w.mapNever).length,
      map_always: this.walls.filter(w => w.mapAlways).length,
    };
  }

  // Compact enough to bake into JSON: three base64 byte planes plus optional public
  // render surfaces. Collision has its own compact payload, including the internal
  // BSP splitters needed to choose a directional sidedef exactly like move.c.
  toJSON({ includeWalls = true, includeSurfaces = true, includeCollision = true,
           graphEntrySquares = null, edgeDirections = null } = {}) {
    const out = {
      file: path.basename(this.file || ''), security: this.security,
      version: this.version, rows: this.rows, cols: this.cols,
      grid: Buffer.from(this.grid).toString('base64'),
      flags: Buffer.from(this.flags).toString('base64'),
      monsterGrid: this.monsterGrid ? Buffer.from(this.monsterGrid).toString('base64') : null,
    };
    const drawableWalls = includeWalls && this.walls ? this.walls.filter(w => w.drawable) : null;
    const drawableNumber = new Map(drawableWalls?.map((wall, index) => [wall, index + 1]) ?? []);
    const firstCollisionWalls = new Map();
    const nextCollisionWalls = [];
    if (drawableWalls && this.nodes) {
      const nextDrawable = rawNumber => {
        let number = rawNumber, guard = 0;
        while (number && guard++ <= this.walls.length) {
          const wall = this.walls[number - 1];
          if (!wall) return 0;
          const encoded = drawableNumber.get(wall);
          if (encoded) return encoded;
          number = wall.nextWall ?? wall.nextCollisionWall;
        }
        return 0;
      };
      for (const node of this.nodes) if (node.type === 'internal')
        firstCollisionWalls.set(node.node, nextDrawable(node.firstWall ?? node.firstCollisionWall));
      for (const wall of drawableWalls)
        nextCollisionWalls.push(nextDrawable(wall.nextWall ?? wall.nextCollisionWall));
    }
    if (includeWalls && this.walls) {
      // Keep the established five-field minimap tuples. Collision metadata is a
      // compact aligned payload below so this generated file remains reviewable.
      out.walls = drawableWalls.map(w =>
        [w.x0, w.y0, w.x1, w.y1,
         (w.passable ? 1 : 0) | (w.mapNever ? 2 : 0) | (w.mapAlways ? 4 : 0)]);
    }
    if (includeCollision && drawableWalls && this.sectors?.length && this.leaves?.length
        && this.nodes?.length && this.bspRoot
        && drawableWalls.every(wall => wall.collisionMetadata && wall.collisionNode)) {
      out.collisionVersion = COLLISION_VERSION;
      const bakedDirections = edgeDirections == null
        ? new Set(['north', 'south', 'west', 'east'])
        : new Set([...edgeDirections].map(direction => String(direction).toLowerCase()));
      out.edgeOpenings = Object.fromEntries(['north', 'south', 'west', 'east']
        .map(direction => [direction, bakedDirections.has(direction)
          ? this.edgeCrossingRanges(direction).map(range => [...range]) : []]));
      // SERIALIZED CONTRACT: edgeApproaches is
      // `[fineX,fineY,edgeX,edgeY,stages,graph]`; its first four values are x/y
      // KOD/protocol units and stages are `[col,row]`. Compact tuple: inside x/y,
      // minimum out-of-bounds x/y, then the coarse staging squares with a direct
      // stock-collision-safe approach to the opening.
      let graphReachable = null;
      if (Array.isArray(graphEntrySquares) && graphEntrySquares.length) {
        graphReachable = new Set();
        const queue = [];
        for (const entry of graphEntrySquares) {
          const start = this.walkable(entry.row, entry.col)
            ? { row: entry.row, col: entry.col }
            : this.nearestWalkable(entry.row, entry.col);
          if (!start) continue;
          const key = `${start.col},${start.row}`;
          if (!graphReachable.has(key)) { graphReachable.add(key); queue.push(start); }
        }
        for (let index = 0; index < queue.length; index++) {
          for (const next of this.neighbors(queue[index].row, queue[index].col)) {
            const key = `${next.col},${next.row}`;
            if (graphReachable.has(key)) continue;
            graphReachable.add(key);
            queue.push(next);
          }
        }
      }
      out.edgeApproaches = Object.fromEntries(['north', 'south', 'west', 'east']
        .map(direction => [direction, !bakedDirections.has(direction) ? []
          : this.edgeApproachCandidates(direction).map(candidate => [
          candidate.fine_stand_on.x, candidate.fine_stand_on.y,
          candidate.edge_target.x, candidate.edge_target.y,
          candidate.stages.map(stage => [stage.col, stage.row]),
          (graphReachable == null ? candidate.graph_routable !== false
            : candidate.stages.some(stage =>
              graphReachable.has(`${stage.col},${stage.row}`))) ? 1 : 0,
        ])]));
      out.collision = {
        wallSides: encodeCollisionWallSides(drawableWalls, nextCollisionWalls),
        sectors: encodeCollisionSectors(this.sectors),
        leaves: encodeCollisionLeaves(this.leaves),
        nodes: encodeCollisionNodes(this.nodes, this.bspRoot, firstCollisionWalls),
      };
      out.collision.digest = collisionDigest({ ...out, collision: out.collision });
    }
    if (includeSurfaces && this.sectors && this.leaves) {
      out.sectors = this.sectors.map((s, i) => ({
        id: i + 1,
        serverId: s.serverId,
        floorType: s.floorType,
        ceilingType: s.ceilingType,
        tx: s.tx, ty: s.ty,
        floorHeight: s.floorHeight,
        ceilingHeight: s.ceilingHeight,
        light: s.light,
        flags: s.flags,
        speed: s.speed,
        depth: s.depth,
        slopedFloor: s.slopedFloor ? { ...s.slopedFloor } : null,
        slopedCeiling: s.slopedCeiling ? { ...s.slopedCeiling } : null,
      }));
      out.leaves = this.leaves.map(leaf => ({
        node: leaf.node,
        sector: leaf.sectorNum,
        bbox: [...leaf.bbox],
        polygon: leaf.polygon.map(([x, y]) => [x, y]),
      }));
    }
    return out;
  }

  static fromJSON(j) {
    let collisionSectors = null, collisionLeaves = null, collisionNodes = null;
    let collisionRoot = 0, collisionSides = null;
    let collisionValid = false;
    if (j.collisionVersion === COLLISION_VERSION && j.collision && Array.isArray(j.walls)) {
      try {
        const edgeOpenings = j.edgeOpenings;
        if (!edgeOpenings || !['north', 'south', 'west', 'east'].every(direction => {
          const max = ((direction === 'north' || direction === 'south') ? j.cols : j.rows) + 1;
          return Array.isArray(edgeOpenings[direction]) && edgeOpenings[direction].every(range =>
            Array.isArray(range) && range.length === 2 && range.every(Number.isInteger)
            && range[0] >= KOD_FINENESS && range[0] <= range[1]
            && range[1] < max * KOD_FINENESS);
        })) throw new Error('invalid collision edge openings');
        const edgeApproaches = j.edgeApproaches;
        const approachMatchesDirection = (direction, entry) => {
          const horizontal = direction === 'north' || direction === 'south';
          const low = direction === 'north' || direction === 'west';
          const fixedInside = low
            ? KOD_FINENESS + (KOD_FINENESS >> 1)
            : ((horizontal ? j.rows : j.cols) * KOD_FINENESS) + (KOD_FINENESS >> 1);
          const fixedOutside = low
            ? KOD_FINENESS - 1
            : ((horizontal ? j.rows : j.cols) + 1) * KOD_FINENESS;
          const along = horizontal ? entry[0] : entry[1];
          return (horizontal
            ? entry[1] === fixedInside && entry[3] === fixedOutside && entry[2] === along
            : entry[0] === fixedInside && entry[2] === fixedOutside && entry[3] === along)
            && edgeOpenings[direction].some(([start, end]) => along >= start && along <= end);
        };
        if (!edgeApproaches || !['north', 'south', 'west', 'east'].every(direction =>
          Array.isArray(edgeApproaches[direction]) && edgeApproaches[direction].every(entry =>
            Array.isArray(entry) && entry.length === 6
            && entry.slice(0, 4).every(value => Number.isInteger(value) && value >= 0
              && value <= 0xffff)
            && Array.isArray(entry[4]) && entry[4].length > 0
            && entry[4].every(stage => Array.isArray(stage) && stage.length === 2
              && Number.isInteger(stage[0]) && stage[0] >= 1 && stage[0] <= j.cols
              && Number.isInteger(stage[1]) && stage[1] >= 1 && stage[1] <= j.rows)
            && (entry[5] === 0 || entry[5] === 1)
            && approachMatchesDirection(direction, entry))))
          throw new Error('invalid collision edge approaches');
        if (!j.walls.every(tuple => Array.isArray(tuple) && tuple.length === 5
            && tuple.slice(0, 4).every(Number.isFinite)
            && Number.isInteger(tuple[4]) && (tuple[4] & ~0x07) === 0))
          throw new Error('invalid collision wall tuple');
        if (typeof j.collision.digest !== 'string'
            || j.collision.digest !== collisionDigest({ ...j, collision: j.collision }))
          throw new Error('collision payload digest mismatch');
        collisionSectors = decodeCollisionSectors(j.collision.sectors);
        collisionLeaves = decodeCollisionLeaves(j.collision.leaves, collisionSectors);
        const decodedTree = decodeCollisionNodes(j.collision.nodes, collisionLeaves);
        collisionNodes = decodedTree.nodes;
        collisionRoot = decodedTree.root;
        collisionSides = decodeCollisionWallSides(j.collision.wallSides, j.walls.length,
          collisionSectors, collisionNodes);
        collisionValid = true;
      } catch (e) {
        if (process.env.M59_FROMJSON_DEBUG) console.error(`[fromJSON] ${j?.file}: ${e.message}`);
        // A malformed or truncated generated payload is not permission to move.
        // Keep the minimap usable and make fine movement fail closed.
      }
    }
    const sectors = collisionValid ? collisionSectors : Array.isArray(j.sectors) ? j.sectors.map((s, i) => ({
      ...s,
      id: i + 1,
      slopedFloor: s.slopedFloor ? { ...s.slopedFloor } : null,
      slopedCeiling: s.slopedCeiling ? { ...s.slopedCeiling } : null,
    })) : collisionSectors;
    const leaves = collisionValid ? collisionLeaves : Array.isArray(j.leaves) ? j.leaves.map(leaf => ({
      type: 'leaf', node: leaf.node, sectorNum: leaf.sector,
      sector: sectors?.[leaf.sector - 1] ?? null,
      bbox: Array.isArray(leaf.bbox) ? [...leaf.bbox] : [],
      polygon: Array.isArray(leaf.polygon) ? leaf.polygon.map(p => [...p]) : [],
    })) : collisionLeaves;
    const walls = j.walls ? j.walls.map((tuple, index) => {
      const [x0, y0, x1, y1, f] = tuple;
      // Nine-field tuples were emitted briefly during development; accepting them
      // costs nothing and makes the decoder tolerant of that intermediate format.
      const inline = tuple.length >= 9 ? {
        posSector: tuple[5], negSector: tuple[6],
        posSidedefRec: sideFromBits(tuple[7]), negSidedefRec: sideFromBits(tuple[8]),
      } : null;
      // A versioned collision payload is the sole collision authority. Historical
      // inline metadata may still render an intermediate development map, but must
      // never override the separately decoded and validated payload.
      const metadata = collisionValid ? collisionSides?.[index] : inline;
      return {
        x0, y0, x1, y1, drawable: true,
        passable: !!(f & 1), mapNever: !!(f & 2), mapAlways: !!(f & 4),
        posSector: metadata?.posSector ?? 0,
        negSector: metadata?.negSector ?? 0,
        posSidedefRec: metadata?.posSidedefRec ?? null,
        negSidedefRec: metadata?.negSidedefRec ?? null,
        collisionNode: metadata?.collisionNode ?? 0,
        nextCollisionWall: metadata?.nextCollisionWall ?? 0,
        collisionMetadata: !!metadata,
      };
    }) : null;
    if (walls && sectors) for (const wall of walls) setWallHeights(wall, sectors);
    if (collisionValid) {
      // A wall's owner is security-critical: it selects the source-facing sidedef.
      // Bind every decoded wall to the exact normalized splitter it claims, so a
      // damaged owner byte cannot silently turn a one-way wall around.
      for (const wall of walls) {
        if (![wall.x0, wall.y0, wall.x1, wall.y1, wall.z0, wall.z1, wall.z2, wall.z3,
              wall.zz0, wall.zz1, wall.zz2, wall.zz3].every(Number.isFinite)) {
          collisionValid = false;
          break;
        }
        const separator = collisionNodes[wall.collisionNode - 1]?.separator;
        if (!separator) { collisionValid = false; break; }
        const distance = (x, y) => Math.abs(separator.a * x + separator.b * y + separator.c)
          / Math.max(1, Math.hypot(separator.a, separator.b));
        if (distance(wall.x0, wall.y0) > 0.05 || distance(wall.x1, wall.y1) > 0.05) {
          collisionValid = false;
          break;
        }
      }
    }
    const geometry = new RoomGeometry({
      file: j.file, version: j.version, security: j.security,
      rows: j.rows, cols: j.cols,
      grid: Buffer.from(j.grid, 'base64'),
      flags: Buffer.from(j.flags, 'base64'),
      monsterGrid: j.monsterGrid ? Buffer.from(j.monsterGrid, 'base64') : null,
      walls,
      sectors, nodes: collisionValid ? collisionNodes : null, leaves,
      bspRoot: collisionValid ? collisionRoot : 0,
      collisionVersion: collisionValid ? COLLISION_VERSION : null,
      edgeOpenings: collisionValid ? j.edgeOpenings : null,
      edgeApproaches: collisionValid ? j.edgeApproaches : null,
    });
    if (collisionValid) {
      // The digest protects bytes; these checks protect their meaning. A corrupted
      // or incorrectly generated approach must not make a sealed graph edge routable.
      for (const direction of ['north', 'south', 'west', 'east']) {
        for (const candidate of geometry.edgeApproachCandidates(direction)) {
          const outward = geometry.traceFineMoveClient(
            protocolToClient(candidate.fine_stand_on.x),
            protocolToClient(candidate.fine_stand_on.y),
            protocolToClient(candidate.edge_target.x),
            protocolToClient(candidate.edge_target.y), { slide: false });
          if (!outward.arrived || !candidate.stages.every(stage => {
            if (!geometry.walkable(stage.row, stage.col)) return false;
            const x = stage.col * KOD_FINENESS + (KOD_FINENESS >> 1);
            const y = stage.row * KOD_FINENESS + (KOD_FINENESS >> 1);
            return geometry.traceFineMoveClient(protocolToClient(x), protocolToClient(y),
              protocolToClient(candidate.fine_stand_on.x),
              protocolToClient(candidate.fine_stand_on.y), { slide: false }).arrived;
          })) {
            geometry.collisionVersion = null;
            geometry.edgeOpenings = null;
            geometry.edgeApproaches = null;
            geometry._edgeOpeningCache.clear();
            geometry._edgeApproachCache.clear();
            return geometry;
          }
        }
      }
    }
    return geometry;
  }
}

// The map object is shared across sessions, and decoded collision geometry is
// immutable (live flags/objects are supplied to each trace). Decode each room once
// per loaded map rather than once per character; a fleet otherwise duplicates tens
// of megabytes of BSP trees for every session.
const SHARED_ROOM_GEOMETRY = new WeakMap();
export function sharedRoomGeometry(roomOrRoo) {
  const roo = roomOrRoo?.roo ?? roomOrRoo;
  if (!roo || typeof roo !== 'object') return null;
  if (!SHARED_ROOM_GEOMETRY.has(roo)) SHARED_ROOM_GEOMETRY.set(roo, RoomGeometry.fromJSON(roo));
  const g = SHARED_ROOM_GEOMETRY.get(roo);
  // A lab may adopt the current routing bake without decoding every room at startup.
  // Attach its mask on first real geometry access; ordinary/eager processes register
  // nothing here and retain exactly their previous path.
  attachDeferredStepMask(roomOrRoo, g);
  // WHICH ROOM THIS IS, when the caller happened to know. The geometry is built from a
  // `.roo` and a `.roo` does not carry its own room number — but `declaredFallJumps` has
  // to match a table keyed by room, and a table entry applied to the wrong room would be
  // a jump offered where there is no cliff. Stamped only from a caller that passed the
  // map's room object; a geometry built from a bare `.roo` keeps `roomNum` null and
  // declares nothing, which is the safe direction.
  if (g && g.roomNum == null && Number.isFinite(Number(roomOrRoo?.num))) g.roomNum = Number(roomOrRoo.num);
  return g;
}

// Read-only cache visibility for startup tests and for lazy attachment to geometry that a
// caller happened to construct before attachStepMasks(). It never creates a geometry.
export function peekSharedRoomGeometry(roomOrRoo) {
  const roo = roomOrRoo?.roo ?? roomOrRoo;
  return roo && typeof roo === 'object' ? (SHARED_ROOM_GEOMETRY.get(roo) ?? null) : null;
}

// EAGERLY PARSE EVERY ROOM'S GEOMETRY. sharedRoomGeometry is lazy — the first access to a
// room parses its .roo (BSP, walls, sectors) via RoomGeometry.fromJSON, which is ~tens of
// ms per room. The route search (findPath) visits many rooms and each first access pays
// that parse, which is the ~12s half of the cold-start stall (the other half was the
// inferred-reverse build). Calling this at startup populates SHARED_ROOM_GEOMETRY for all
// rooms so the first tick does no geometry parsing — the cost is paid at startup, off the
// tick path, while the keeper is already busy. It is idempotent (the cache is checked), so
// a room already built is untouched.
export function buildAllRoomGeometry(map) {
  const built = [];
  for (const room of Object.values(map?.rooms ?? {})) {
    if (room?.roo) built.push(room.num);
    sharedRoomGeometry(room);
  }
  return built.length;
}

// The wall list — the minimap, properly. clientd3d/map.c:294 draws exactly this:
// one line per wall from (x0,y0) to (x1,y1), skipped when the sidedef says
// WF_MAP_NEVER and drawn early when it says WF_MAP_ALWAYS. Nothing else is on the
// map except dots for objects.
//
// Layout from clientd3d/bspload.c LoadWalls (line 419):
//
//   next_num(2) pos_sidedef(2) neg_sidedef(2)
//   x0(4) y0(4) x1(4) y1(4)          int32 below version 13, float32 from 13
//   length(2 below v13, else 4 float)
//   pos_xoffset(2) neg_xoffset(2) pos_yoffset(2) neg_yoffset(2)
//   pos_sector(2) neg_sector(2)
//
// and sidedefs from LoadSidedefs (line 500), a fixed 13 bytes each:
//
//   server_id(2) normal_type(2) above_type(2) below_type(2) flags(4) speed(1)
//
// Sidedef numbers are 1-BASED with 0 meaning "no sidedef on that side", which is how
// a one-sided wall at the edge of the world is expressed.
function readCoord(buf, p, version) {
  return version >= 13 ? buf.readFloatLE(p) : buf.readInt32LE(p);
}

// The BSP node section is the missing link between a sector (which owns height,
// light, and textures) and a patch of floor on the map. In Meridian terminology a
// leaf is also the subsector: one convex polygon, clockwise looking down, with a
// mandatory 1-based sector reference (clientd3d/bspload.c LoadNodes/RoomSwizzle).
//
// Layout at nodeOff:
//   count(2)
//   node[count]: type(1), bbox x0/y0/x1/y1 (4 each), then
//     internal: separator a/b/c (4 each), positive(2), negative(2), first_wall(2)
//     leaf: sector(2), point_count(2), point x/y pairs (4 each)
//
// Coordinates are returned exactly as encoded. Version 13+ stores IEEE floats;
// earlier versions store signed int32. In particular, polygon winding is preserved.
export function parseRooNodes(buf, version, nodeOff, sectors = null, wallCount = null, nodeEnd = null) {
  if (!(nodeOff > 0 && nodeOff + 2 <= buf.length))
    return { root: 0, nodes: [], leaves: [], bytes: 0 };

  const limit = Number.isInteger(nodeEnd) && nodeEnd > nodeOff && nodeEnd <= buf.length
    ? nodeEnd : buf.length;
  let q = nodeOff;
  const count = buf.readUInt16LE(q); q += 2;
  // A leaf with zero points is still 21 bytes. Reject an impossible count before
  // allocating or looping over attacker-controlled data.
  if (count > Math.floor((limit - q) / 21))
    throw new Error(`BSP declares ${count} nodes but its section has room for fewer than that`);

  const nodes = [];
  const leaves = [];
  const need = (bytes, what) => {
    if (q + bytes > limit)
      throw new Error(`truncated BSP ${what}: need ${bytes} bytes at ${q}, section ends at ${limit}`);
  };
  const value = what => {
    need(4, what);
    const n = readCoord(buf, q, version); q += 4;
    if (!Number.isFinite(n)) throw new Error(`non-finite BSP ${what}`);
    return n;
  };

  for (let i = 0; i < count; i++) {
    need(17, `node ${i + 1} header`);
    const type = buf.readUInt8(q++);
    const bbox = [value('bbox x0'), value('bbox y0'), value('bbox x1'), value('bbox y1')];
    if (type === 1) {
      const separator = { a: value('separator a'), b: value('separator b'), c: value('separator c') };
      need(6, `internal node ${i + 1} references`);
      const positive = buf.readUInt16LE(q); q += 2;
      const negative = buf.readUInt16LE(q); q += 2;
      const firstWall = buf.readUInt16LE(q); q += 2;
      nodes.push({ type: 'internal', node: i + 1, bbox, separator, positive, negative, firstWall });
      continue;
    }
    if (type !== 2) throw new Error(`unknown BSP node type ${type} at node ${i + 1}`);

    need(4, `leaf ${i + 1} header`);
    const sectorNum = buf.readUInt16LE(q); q += 2;
    const pointCount = buf.readUInt16LE(q); q += 2;
    if (pointCount < 3 || pointCount > MAX_BSP_POINTS)
      throw new Error(`BSP leaf ${i + 1} has ${pointCount} points; expected 3..${MAX_BSP_POINTS}`);
    need(pointCount * 8, `leaf ${i + 1} polygon`);
    const polygon = [];
    for (let p = 0; p < pointCount; p++) polygon.push([value('point x'), value('point y')]);
    if (!sectorNum) throw new Error(`BSP leaf ${i + 1} has no sector reference`);
    if (Array.isArray(sectors) && sectorNum > sectors.length)
      throw new Error(`BSP leaf ${i + 1} references sector ${sectorNum}; only ${sectors.length} parsed`);
    const leaf = {
      type: 'leaf', node: i + 1, bbox, sectorNum,
      sector: Array.isArray(sectors) ? sectors[sectorNum - 1] : null,
      polygon,
    };
    nodes.push(leaf);
    leaves.push(leaf);
  }

  // RoomSwizzle validates the same 1-based references before traversing. Do it
  // iteratively here so a maliciously deep tree cannot overflow the JS call stack.
  for (const node of nodes) {
    if (node.type !== 'internal') continue;
    for (const [name, ref] of [['positive', node.positive], ['negative', node.negative]]) {
      if (ref < 0 || ref > count)
        throw new Error(`BSP node ${node.node} ${name} child ${ref} outside 0..${count}`);
    }
    if (Number.isInteger(wallCount) && (node.firstWall < 0 || node.firstWall > wallCount))
      throw new Error(`BSP node ${node.node} first wall ${node.firstWall} outside 0..${wallCount}`);
  }
  const color = new Uint8Array(count); // 0 unseen, 1 visiting, 2 complete
  for (let start = 1; start <= count; start++) {
    if (color[start - 1]) continue;
    const stack = [[start, false]];
    while (stack.length) {
      const [id, leaving] = stack.pop();
      if (leaving) { color[id - 1] = 2; continue; }
      if (color[id - 1] === 1) throw new Error(`cycle in BSP tree at node ${id}`);
      if (color[id - 1] === 2) continue;
      color[id - 1] = 1;
      stack.push([id, true]);
      const node = nodes[id - 1];
      if (node.type !== 'internal') continue;
      // Reverse push keeps the canonical positive-then-negative traversal order.
      for (const child of [node.negative, node.positive]) {
        if (!child) continue;
        if (color[child - 1] === 1) throw new Error(`cycle in BSP tree at node ${child}`);
        if (!color[child - 1]) stack.push([child, false]);
      }
    }
  }

  return { root: count ? 1 : 0, nodes, leaves, bytes: q - nodeOff };
}

// A SECTOR RECORD IS NOT FIXED-LENGTH, which is the whole reason this needs care.
// clientd3d/bspload.c LoadSectors (line 736) reads 19 bytes, then a speed byte from
// version 10, and THEN — inline, still inside the same loop iteration — a 46-byte
// slope block for the floor if SF_SLOPED_FLOOR is set and another for the ceiling if
// SF_SLOPED_CEILING is. So sectors cannot be indexed by multiplying; they have to be
// walked in order, and a parser that assumes a stride silently reads garbage from the
// first sloped sector onward. Meridian has sloped floors in the outdoor areas, so
// "it worked on the room I tested" is exactly how that bug would present.
//
//   server_id(2) floor_type(2) ceiling_type(2) tx(2) ty(2)
//   floor_height(2) ceiling_height(2) light(1) flags(4) [speed(1) if v>=10]
//   [slope(46) if SF_SLOPED_FLOOR] [slope(46) if SF_SLOPED_CEILING]
//
// Heights are read into a `WORD` by the stock client and then shifted left 4.
// Preserve that unsigned interpretation; sign-extending 0xffff would turn the
// client's very high 1,048,560-unit surface into -16 and could fail collision open.
const SLOPE_BYTES = 4 * 4 + 4 + 4 + 4 + 3 * 6;   // plane a,b,c,d | p0.x p0.y | angle | junk

function readSlope(buf, p, version) {
  const val = q => version >= 13 ? buf.readFloatLE(q) : buf.readInt32LE(q);
  // bspload.c LoadSlopeInfo. c === 0 is a vertical plane, which the client rejects and
  // replaces rather than dividing by zero; do the same so GetFloorHeight cannot NaN.
  let a = val(p), b = val(p + 4), c = val(p + 8), d = val(p + 12);
  if (c === 0) { a = 0; b = 0; c = 1024; d = 0; }
  return {
    a, b, c, d,
    x0: val(p + 16), y0: val(p + 20),
    // Unlike the other slope values this remains an integer angle in v13+ too.
    // The renderer needs it to orient the floor/ceiling texture on the plane.
    textureAngle: buf.readInt32LE(p + 24),
  };
}

export function parseRooSectors(buf, version, sectorOff) {
  const sectors = [];
  if (!(sectorOff > 0 && sectorOff + 2 <= buf.length)) return sectors;
  let q = sectorOff;
  const n = buf.readUInt16LE(q); q += 2;
  const fixed = 19 + (version >= 10 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    if (q + fixed > buf.length) throw new Error(`truncated sector ${i + 1}`);
    const flags = buf.readInt32LE(q + 15);
    const s = {
      // These five are WORDs in bsp.h/LoadSectors. Resource ids routinely cross
      // 32767 (barrent.roo is one), so signed reads turn valid textures negative.
      serverId: buf.readUInt16LE(q),
      floorType: buf.readUInt16LE(q + 2),
      ceilingType: buf.readUInt16LE(q + 4),
      tx: buf.readUInt16LE(q + 6), ty: buf.readUInt16LE(q + 8),
      // Kept in CLIENT units, because that is the space every comparison happens in.
      floorHeight: heightKodToClient(buf.readUInt16LE(q + 10)),
      ceilingHeight: heightKodToClient(buf.readUInt16LE(q + 12)),
      light: buf.readUInt8(q + 14),
      flags,
      speed: version >= 10 ? buf.readUInt8(q + 19) : 0,
      depth: SECTOR_DEPTHS[sectorDepth(flags)],
      slopedFloor: null, slopedCeiling: null,
    };
    q += fixed;
    if (flags & SF.SLOPED_FLOOR) {
      if (q + SLOPE_BYTES > buf.length) throw new Error(`truncated floor slope in sector ${i + 1}`);
      s.slopedFloor = readSlope(buf, q, version); q += SLOPE_BYTES;
    }
    if (flags & SF.SLOPED_CEILING) {
      if (q + SLOPE_BYTES > buf.length) throw new Error(`truncated ceiling slope in sector ${i + 1}`);
      s.slopedCeiling = readSlope(buf, q, version); q += SLOPE_BYTES;
    }
    sectors.push(s);
  }
  return sectors;
}

// bspload.c GetFloorHeight / GetCeilingHeight. A flat sector is its stored height; a
// sloped one solves its plane for z at that point. Both in client units.
export function floorHeightAt(x, y, sector) {
  if (!sector) return 0;
  const s = sector.slopedFloor;
  if (!s) return sector.floorHeight;
  return slopeHeightAt(x, y, s);
}
export function ceilingHeightAt(x, y, sector) {
  if (!sector) return CLIENT_FINENESS;
  const s = sector.slopedCeiling;
  if (!s) return sector.ceilingHeight;
  return slopeHeightAt(x, y, s);
}

// The stock helpers operate on C floats and use roundf (half away from zero).
// Keeping the intermediate operations at float32 avoids one-unit differences at
// the exact 24-unit step and 768-unit headroom thresholds.
function slopeHeightAt(x, y, slope) {
  const ax = f32(f32(slope.a) * f32(x));
  const by = f32(f32(slope.b) * f32(y));
  const numerator = f32(f32(f32(-ax) - by) - f32(slope.d));
  const value = f32(numerator / f32(slope.c));
  return value < 0 ? Math.ceil(value - 0.5) : Math.floor(value + 0.5);
}

// bspload.c SetWallHeights (line 1324), the non-bowtie path. z0/z1 are the bottom and
// top of the LOWER wall at endpoint 0 — the step — and z2/z3 the normal/upper split,
// which is the headroom. zz* are the same four at endpoint 1.
//
// Bowties follow the modern client's gD3DEnabled branch. IntersectNode still reads
// endpoint-0 z1/z2 for movement, so these apparently rendering-only assignments are
// observable collision rules (notably on passable walls in Marion).
export function setWallHeights(wall, sectors) {
  const S1 = wall.posSector > 0 ? sectors[wall.posSector - 1] : null;
  const S2 = wall.negSector > 0 ? sectors[wall.negSector - 1] : null;
  wall.sector1 = S1; wall.sector2 = S2;

  if (!S1 && !S2) {
    wall.z0 = wall.z1 = wall.zz0 = wall.zz1 = 0;
    wall.z2 = wall.z3 = wall.zz2 = wall.zz3 = CLIENT_FINENESS;
    return wall;
  }
  const only = S1 || S2;
  if (!S1 || !S2) {
    wall.z0 = wall.z1 = floorHeightAt(wall.x0, wall.y0, only);
    wall.z2 = wall.z3 = ceilingHeightAt(wall.x0, wall.y0, only);
    wall.zz0 = wall.zz1 = floorHeightAt(wall.x1, wall.y1, only);
    wall.zz2 = wall.zz3 = ceilingHeightAt(wall.x1, wall.y1, only);
    return wall;
  }

  // WALL_HEIGHT_CHECK clamps the two-sector samples before any assignment.
  const checked = value => Math.min(value, 65535);
  const f1a = checked(floorHeightAt(wall.x0, wall.y0, S1));
  const f2a = checked(floorHeightAt(wall.x0, wall.y0, S2));
  const f1b = checked(floorHeightAt(wall.x1, wall.y1, S1));
  const f2b = checked(floorHeightAt(wall.x1, wall.y1, S2));
  if (f1a > f2a) {
    if (f1b >= f2b) {
      wall.z1 = f1a; wall.zz1 = f1b;
      wall.z0 = f2a; wall.zz0 = f2b;
      wall.bowtie = false;
    } else {
      wall.z1 = f1a; wall.zz1 = f1b;
      wall.z0 = f2a; wall.zz0 = f1b;
      wall.bowtie = true;
    }
  } else {
    if (f2b >= f1b) {
      wall.z1 = f2a; wall.zz1 = f2b;
      wall.z0 = f1a; wall.zz0 = f1b;
      wall.bowtie = false;
    } else {
      wall.z1 = f1a; wall.zz1 = f1b;
      wall.z0 = f1a; wall.zz0 = f2b;
      wall.bowtie = true;
    }
  }

  const c1a = checked(ceilingHeightAt(wall.x0, wall.y0, S1));
  const c2a = checked(ceilingHeightAt(wall.x0, wall.y0, S2));
  const c1b = checked(ceilingHeightAt(wall.x1, wall.y1, S1));
  const c2b = checked(ceilingHeightAt(wall.x1, wall.y1, S2));
  if (c1a > c2a) {
    if (c1b >= c2b) {
      wall.z3 = c1a; wall.zz3 = c1b;
      wall.z2 = c2a; wall.zz2 = c2b;
    } else {
      wall.z3 = c1a; wall.zz3 = c2b;
      wall.z2 = c2a; wall.zz2 = c1b;
    }
  } else if (c2b >= c1b) {
    wall.z3 = c2a; wall.zz3 = c2b;
    wall.z2 = c1a; wall.zz2 = c1b;
  } else {
    wall.z3 = c2a; wall.zz3 = c1b;
    wall.z2 = c1a; wall.zz2 = c2b;
  }
  return wall;
}

// CAN A PLAYER STANDING AT HEIGHT z CROSS THIS WALL? clientd3d/move.c:551, and it is
// a three-part AND that must ALL hold before the wall is skipped:
//
//   (no below texture OR the step up is within MAX_STEP_HEIGHT)
//   AND (no above texture OR there is player.height of headroom)
//   AND the sidedef is WF_PASSABLE
//
// The middle and the last are the ones this repository had wrong by omission. We
// treated `passable` as the whole answer, and it is only the third of three: a wall
// flagged passable STILL BLOCKS if the step up is too tall or the gap too low. That is
// precisely how a staircase and a cliff edge are told apart in this format, and
// without it a route can be planned straight up a wall we would then fail to climb —
// which reads, from the outside, as the server refusing a legal move.
//
// `side` is which side we are coming FROM: move.c picks the sidedef facing us and the
// sector BEHIND the wall, because the wading depth that matters is the one we are
// stepping INTO.
export function canCrossWall(wall, z = 0, side = 'pos', { playerHeight = PLAYER_HEIGHT } = {}) {
  return canCrossWallAt(wall, wall.x0, wall.y0, z, side, { playerHeight });
}

// IntersectNode uses the wall's endpoint-0 z1/z2 values even for slopes and bowties.
// Preserve that quirk for exact client compatibility; sampling a nicer contact-point
// height can authorize a climb the stock client refuses.
export function canCrossWallAt(wall, _x, _y, z = 0, side = 'pos',
                               { playerHeight = PLAYER_HEIGHT } = {}) {
  const sd = side === 'pos' ? wall.posSidedefRec : wall.negSidedefRec;
  const other = side === 'pos' ? wall.sector2 : wall.sector1;
  if (!sd) return true;                       // move.c `continue`s on a null sidedef
  const belowHeight = other ? other.depth : 0;
  const stepOk = !sd.belowType || (wall.z1 - belowHeight - z) <= MAX_STEP_HEIGHT;
  const headOk  = !sd.aboveType || (wall.z2 - z) >= playerHeight;
  return stepOk && headOk && !!(sd.flags & WF.PASSABLE);
}

export function parseRooWalls(buf, version) {
  const mainOff = buf.readInt32LE(12);
  if (mainOff <= 0 || mainOff >= buf.length) return null;

  let p = mainOff;
  const width = buf.readInt32LE(p); p += 4;
  const height = buf.readInt32LE(p); p += 4;
  const nodeOff = buf.readInt32LE(p); p += 4;
  const wallOff = buf.readInt32LE(p); p += 4;
  p += 4;                                     // roomedit's own wall list — not this one
  const sidedefOff = buf.readInt32LE(p); p += 4;
  const sectorOff = buf.readInt32LE(p); p += 4;

  // Sidedefs first: a wall's flags live on its sidedefs, not on the wall.
  const sidedefs = [];
  if (sidedefOff > 0 && sidedefOff + 2 <= buf.length) {
    let q = sidedefOff;
    const n = buf.readUInt16LE(q); q += 2;
    for (let i = 0; i < n; i++) {
      if (q + 13 > buf.length) throw new Error(`truncated sidedef ${i + 1}`);
      sidedefs.push({
        // WORDs in bsp.h, exactly like the sector fields, and the same trap:
        // resource ids run to 60003, so a signed read turns every wall texture
        // at or above 32768 negative. Nothing in this repository could see it —
        // canCrossWall only tests these against zero, and a negative is just
        // as truthy — but m59-mb, which renders the ids, found 12 of its 22
        // "missing" wall textures were files on disk under the id plus
        // 0x10000. Its boundary normalisation stays (it guards older
        // checkouts); the truth now leaves here unsigned.
        serverId: buf.readUInt16LE(q),
        normalType: buf.readUInt16LE(q + 2),
        aboveType: buf.readUInt16LE(q + 4),
        belowType: buf.readUInt16LE(q + 6),
        flags: buf.readInt32LE(q + 8),
        speed: buf.readUInt8(q + 12),
      });
      q += 13;
    }
  }

  const walls = [];
  if (wallOff > 0 && wallOff + 2 <= buf.length) {
    let q = wallOff;
    const n = buf.readUInt16LE(q); q += 2;
    const lenBytes = version >= 13 ? 4 : 2;
    const recBytes = 2 + 2 + 2 + 16 + lenBytes + 8 + 4;
    for (let i = 0; i < n; i++) {
      if (q + recBytes > buf.length) throw new Error(`truncated wall ${i + 1}`);
      const posNum = buf.readUInt16LE(q + 2);
      const negNum = buf.readUInt16LE(q + 4);
      if (posNum > sidedefs.length || negNum > sidedefs.length)
        throw new Error(`wall ${i + 1} references missing sidedef`);
      const x0 = readCoord(buf, q + 6, version);
      const y0 = readCoord(buf, q + 10, version);
      const x1 = readCoord(buf, q + 14, version);
      const y1 = readCoord(buf, q + 18, version);
      // map.c prefers the positive sidedef and falls back to the negative; a wall
      // with neither is not drawn at all.
      const pos = posNum ? sidedefs[posNum - 1] : null;
      const neg = negNum ? sidedefs[negNum - 1] : null;
      const sd = pos || neg;
      walls.push({
        x0, y0, x1, y1,
        nextWall: buf.readUInt16LE(q),
        posSidedef: posNum, negSidedef: negNum,
        // Both sidedefs kept, not just the drawing one: a crossing test asks about the
        // side it is approaching from, and `sd` above is whichever the MAP prefers.
        posSidedefRec: pos, negSidedefRec: neg,
        flags: sd ? sd.flags : 0,
        drawable: !!sd,
        passable: !!(sd && (sd.flags & WF.PASSABLE)),
        mapNever: !!(sd && (sd.flags & WF.MAP_NEVER)),
        mapAlways: !!(sd && (sd.flags & WF.MAP_ALWAYS)),
        posSector: buf.readUInt16LE(q + recBytes - 4),
        negSector: buf.readUInt16LE(q + recBytes - 2),
        collisionMetadata: false,
      });
      q += recBytes;
    }
  }

  // Sectors last, because the heights they carry are what turns a wall list into a
  // relief map — and then straight back onto the walls, which is where every
  // movement check reads them from.
  const sectors = parseRooSectors(buf, version, sectorOff);
  for (const [index, wall] of walls.entries()) {
    if (wall.nextWall < 0 || wall.nextWall > walls.length
        || wall.posSector < 0 || wall.negSector < 0
        || wall.posSector > sectors.length || wall.negSector > sectors.length)
      throw new Error(`wall ${index + 1} has an invalid collision reference`);
    setWallHeights(wall, sectors);
  }
  // A BSP leaf is the renderable subsector. Parsing it after sectors lets us
  // resolve each mandatory 1-based reference to the exact sector object now.
  const bsp = parseRooNodes(buf, version, nodeOff, sectors, walls.length, wallOff);

  // RoomSwizzle normalizes every separator and recalculates c from the first wall
  // in its plane before either BSP traversal or IntersectNode uses it. The raw .roo
  // coefficients are close but not identical; preserving them changes tie-breaking
  // and can select the wrong directional sidedef.
  for (const node of bsp.nodes) {
    if (node.type !== 'internal') continue;
    if (!node.firstWall || node.firstWall > walls.length)
      throw new Error(`internal BSP node ${node.node} has no valid splitter wall`);
    const wall = walls[node.firstWall - 1];
    // RoomSwizzle performs this in float32, including its overflow-avoidance
    // branch. Preserve the exact evaluation order: later leaf selection truncates
    // a float separator result to long, so a few ulps can choose another child.
    const overflowAmount = 0x7fffffff >> (LOG_CLIENT_FINENESS * 2);
    const raw = node.separator;
    let a = f32(raw.a), b = f32(raw.b);
    const a2 = f32(a * a), b2 = f32(b * b);
    let norm;
    if (a2 > overflowAmount || b2 > overflowAmount || f32(a2 + b2) > overflowAmount) {
      a = f32(raw.a); b = f32(raw.b);
      norm = f32(Math.sqrt(f32(a2 + b2)));
      if (a2 < 0 || b2 < 0 || norm <= 0) norm = 1;
    } else {
      a = f32(a * CLIENT_FINENESS); b = f32(b * CLIENT_FINENESS);
      norm = f32(Math.sqrt(f32(f32(a * a) + f32(b * b))));
    }
    if (!(norm > 0) || !Number.isFinite(norm))
      throw new Error(`internal BSP node ${node.node} has an invalid separator`);
    a = f32(f32(a * CLIENT_FINENESS) / norm);
    b = f32(f32(b * CLIENT_FINENESS) / norm);
    const p1 = f32(f32(a * f32(wall.x1)) + f32(b * f32(wall.y1)));
    const p0 = f32(f32(a * f32(wall.x0)) + f32(b * f32(wall.y0)));
    node.separator = { a, b, c: f32(-f32(p1 + p0) / 2) };
  }

  // Each wall chain belongs to one internal BSP splitter. IntersectNode chooses the
  // positive or negative sidedef from that splitter's old-point sign; sector ids
  // cannot substitute because many legitimate walls use one sector on both sides.
  const owners = new Uint16Array(walls.length);
  for (const node of bsp.nodes) {
    if (node.type !== 'internal') continue;
    node.firstCollisionWall = node.firstWall;
    let wallNum = node.firstWall, guard = 0;
    while (wallNum) {
      if (wallNum > walls.length || guard++ >= walls.length)
        throw new Error(`invalid BSP wall chain at node ${node.node}`);
      if (owners[wallNum - 1] && owners[wallNum - 1] !== node.node)
        throw new Error(`wall ${wallNum} belongs to multiple BSP nodes`);
      owners[wallNum - 1] = node.node;
      wallNum = walls[wallNum - 1].nextWall;
    }
  }
  for (let i = 0; i < walls.length; i++) {
    const wall = walls[i];
    wall.collisionNode = owners[i] || 0;
    wall.nextCollisionWall = wall.nextWall;
    wall.collisionMetadata = !wall.drawable || !!wall.collisionNode;
    if (wall.drawable && (!wall.collisionNode || (!wall.posSector && !wall.negSector)))
      throw new Error(`drawable wall ${i + 1} lacks collision ownership`);
    if (wall.drawable) {
      const separator = bsp.nodes[wall.collisionNode - 1].separator;
      const divisor = Math.max(1, Math.hypot(separator.a, separator.b));
      const d0 = Math.abs(separator.a * wall.x0 + separator.b * wall.y0 + separator.c) / divisor;
      const d1 = Math.abs(separator.a * wall.x1 + separator.b * wall.y1 + separator.c) / divisor;
      if (d0 > 0.05 || d1 > 0.05)
        throw new Error(`wall ${i + 1} does not lie on BSP node ${wall.collisionNode}`);
    }
  }

  return {
    width, height,
    cols: width >> LOG_CLIENT_FINENESS, rows: height >> LOG_CLIENT_FINENESS,
    offsets: { nodeOff, wallOff, sidedefOff, sectorOff },
    sidedefs, walls, sectors,
    root: bsp.root, nodes: bsp.nodes, leaves: bsp.leaves,
  };
}

// Reproduce BSPRooFileLoad's 32-bit checksum before trusting any collision field.
// The header is not itself proof: a damaged file can retain its old header while a
// passability bit or height changes. The stock client sums selected raw WORD/INT bit
// patterns while loading, wraps as a 32-bit int, then XORs this constant.
export function computeRooSecurity(buf, version = buf.readInt32LE(4)) {
  const mainOff = buf.readInt32LE(12);
  const need = (at, bytes, what) => {
    if (at < 0 || at + bytes > buf.length)
      throw new Error(`truncated ${what} while computing room security`);
  };
  need(mainOff, 32, 'client header');
  const nodeOff = buf.readInt32LE(mainOff + 8);
  const wallOff = buf.readInt32LE(mainOff + 12);
  const sidedefOff = buf.readInt32LE(mainOff + 20);
  const sectorOff = buf.readInt32LE(mainOff + 24);
  let security = version >>> 0;
  const add = value => { security = (security + (value >>> 0)) >>> 0; };

  need(nodeOff, 2, 'BSP node count');
  let q = nodeOff, count = buf.readUInt16LE(q); q += 2;
  for (let i = 0; i < count; i++) {
    need(q, 17, `BSP node ${i + 1}`);
    const type = buf.readUInt8(q); q += 17; // type plus bbox
    if (type === 1) {
      need(q, 18, `BSP internal node ${i + 1}`);
      add(buf.readInt32LE(q)); add(buf.readInt32LE(q + 4)); add(buf.readInt32LE(q + 8));
      add(buf.readUInt16LE(q + 16));
      q += 18;
    } else if (type === 2) {
      need(q, 4, `BSP leaf ${i + 1}`);
      const points = buf.readUInt16LE(q + 2); q += 4;
      if (points > MAX_BSP_POINTS) throw new Error(`invalid BSP leaf point count ${points}`);
      need(q, points * 8, `BSP leaf ${i + 1} points`);
      for (let p = 0; p < points; p++, q += 8) {
        add(buf.readInt32LE(q)); add(buf.readInt32LE(q + 4));
      }
    } else throw new Error(`unknown BSP node type ${type}`);
  }

  need(wallOff, 2, 'wall count');
  q = wallOff; count = buf.readUInt16LE(q); q += 2;
  const wallBytes = 2 + 2 + 2 + 16 + (version >= 13 ? 4 : 2) + 8 + 4;
  for (let i = 0; i < count; i++, q += wallBytes) {
    need(q, wallBytes, `wall ${i + 1}`);
    add(buf.readUInt16LE(q + 2)); add(buf.readUInt16LE(q + 4));
    for (const offset of [6, 10, 14, 18]) add(buf.readInt32LE(q + offset));
    add(buf.readUInt16LE(q + wallBytes - 4)); add(buf.readUInt16LE(q + wallBytes - 2));
  }

  need(sidedefOff, 2, 'sidedef count');
  q = sidedefOff; count = buf.readUInt16LE(q); q += 2;
  for (let i = 0; i < count; i++, q += 13) {
    need(q, 13, `sidedef ${i + 1}`);
    add(buf.readUInt16LE(q));
    add(buf.readUInt16LE(q + 2)); add(buf.readUInt16LE(q + 4)); add(buf.readUInt16LE(q + 6));
    add(buf.readInt32LE(q + 8));
  }

  need(sectorOff, 2, 'sector count');
  q = sectorOff; count = buf.readUInt16LE(q); q += 2;
  const fixed = 19 + (version >= 10 ? 1 : 0);
  for (let i = 0; i < count; i++) {
    need(q, fixed, `sector ${i + 1}`);
    const flags = buf.readInt32LE(q + 15);
    add(buf.readUInt16LE(q));
    add(buf.readUInt16LE(q + 2)); add(buf.readUInt16LE(q + 4));
    add(buf.readUInt16LE(q + 10)); add(buf.readUInt16LE(q + 12));
    add(buf.readUInt8(q + 14)); add(flags);
    q += fixed;
    if (flags & SF.SLOPED_FLOOR) { need(q, SLOPE_BYTES, 'floor slope'); q += SLOPE_BYTES; }
    if (flags & SF.SLOPED_CEILING) { need(q, SLOPE_BYTES, 'ceiling slope'); q += SLOPE_BYTES; }
  }
  return (security ^ 0x89ab786c) >>> 0;
}

export function parseRoo(buf, file = '') {
  if (buf.length < 20 || !buf.subarray(0, 4).equals(ROO_MAGIC))
    throw new Error('not a .roo file (bad magic)');
  const version = buf.readInt32LE(4);
  if (version < ROO_MIN_VERSION) throw new Error(`.roo version ${version} below minimum ${ROO_MIN_VERSION}`);
  const security = buf.readUInt32LE(8);
  const computedSecurity = computeRooSecurity(buf, version);
  if (computedSecurity !== security)
    throw new Error(`room security checksum mismatch: header ${security}, computed ${computedSecurity}`);
  const serverOff = buf.readInt32LE(16);
  if (serverOff <= 0 || serverOff >= buf.length)
    throw new Error(`server section offset ${serverOff} outside a ${buf.length}-byte file`);

  let p = serverOff;
  const rows = buf.readInt32LE(p); p += 4;
  const cols = buf.readInt32LE(p); p += 4;
  if (rows <= 0 || cols <= 0 || rows > 4096 || cols > 4096)
    throw new Error(`implausible room dimensions ${rows}x${cols}`);

  const plane = () => {
    const need = rows * cols;
    if (p + need > buf.length) throw new Error(`truncated: need ${need} bytes at ${p}, file is ${buf.length}`);
    const out = buf.subarray(p, p + need);
    p += need;
    return out;
  };
  const grid = plane();
  const flags = plane();
  // The monster grid is present only from version 12. Guard on the remaining length
  // as well as the version: a file that claims v12 but stops early would otherwise
  // hand back a truncated plane full of zeroes, which reads as "nothing is walkable"
  // rather than as an error.
  let monsterGrid = null;
  if (version >= MONSTER_GRID_VERSION && p + rows * cols <= buf.length) monsterGrid = plane();

  // The wall list is in the client section, and it is what the minimap actually
  // draws. A failure to read it is not fatal — the walkability grids alone are
  // enough to move — so it degrades to null rather than throwing.
  let client = null;
  try { client = parseRooWalls(buf, version); } catch { client = null; }

  return new RoomGeometry({ file, version, security, rows, cols, grid, flags, monsterGrid,
                            walls: client ? client.walls : null,
                            sidedefs: client ? client.sidedefs : null,
                            sectors: client ? client.sectors : null,
                            nodes: client ? client.nodes : null,
                            leaves: client ? client.leaves : null,
                            bspRoot: client ? client.root : 0,
                            collisionVersion: client ? COLLISION_VERSION : null,
                            clientSize: client ? { width: client.width, height: client.height,
                                                   rows: client.rows, cols: client.cols } : null });
}

// ------------------------------------------------------------------- loading

const cache = new Map();

export const MAX_ROO_FILE_BYTES = 64 * 1024 * 1024;

export function readRooFileBounded(file, maximum = MAX_ROO_FILE_BYTES) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_ROO_FILE_BYTES)
    throw new Error(`ROO read ceiling must be in 1..${MAX_ROO_FILE_BYTES} bytes`);
  const descriptor = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${file} is not a regular ROO file`);
    if (before.size < 1 || before.size > maximum)
      throw new Error(`${file} exceeds the ${maximum}-byte ROO ceiling`);
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error(`${file} ended during its bounded ROO read`);
      offset += count;
    }
    const probe = Buffer.allocUnsafe(1);
    if (fs.readSync(descriptor, probe, 0, 1, bytes.length) !== 0)
      throw new Error(`${file} grew during its bounded ROO read`);
    const after = fs.fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs || after.dev !== before.dev || after.ino !== before.ino)
      throw new Error(`${file} changed during its bounded ROO read`);
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function loadRoo(nameOrPath, dirs = DEFAULT_ROO_DIRS, { strict = false } = {}) {
  if (!strict && cache.has(nameOrPath)) return cache.get(nameOrPath);
  const candidates = [];
  if (path.isAbsolute(nameOrPath) || nameOrPath.includes('/') || nameOrPath.includes('\\'))
    candidates.push(nameOrPath);
  const base = path.basename(nameOrPath);
  const withExt = base.toLowerCase().endsWith('.roo') ? base : `${base}.roo`;
  for (const d of dirs) {
    candidates.push(path.join(d, withExt));
    // The resource directories are case-sensitive on Linux and the .roo names are
    // inconsistently cased in the tree (c4.roo, KA0.roo), so try both.
    candidates.push(path.join(d, withExt.toLowerCase()));
    candidates.push(path.join(d, withExt.toUpperCase().replace(/\.ROO$/, '.roo')));
  }
  for (const c of candidates) {
    try {
      const g = parseRoo(readRooFileBounded(c), c);
      if (strict && !g.collisionReady)
        throw new Error('client BSP collision section did not parse completely');
      if (!strict) cache.set(nameOrPath, g);
      return g;
    } catch (e) {
      if (e.code !== 'ENOENT' && strict)
        throw new Error(`failed to parse ${c}: ${e.message}`, { cause: e });
    }
  }
  return null;
}

// ------------------------------------------------------------------- cli

if (import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2).filter(a => a !== '--walls');
  const wantWalls = process.argv.includes('--walls') || !!process.env.M59_WALLS;
  const [cmd, ...rest] = argv;

  // Resolve a room by number or name through the room graph. The map JSON is read
  // directly rather than imported: m59-map.mjs imports THIS file to bake geometry
  // in, so importing it back would deadlock on the circular top-level await.
  const mapPath = movementMapFile();
  const viaMap = needle => {
    let map;
    try { map = JSON.parse(fs.readFileSync(mapPath, 'utf8')); }
    catch { return null; }
    const s = String(needle).trim().toLowerCase();
    const all = Object.values(map.rooms);
    const room = (/^\d+$/.test(s) && map.rooms[s])
      || all.find(r => r.name.toLowerCase() === s)
      || all.find(r => r.name.toLowerCase().includes(s) || r.cls.toLowerCase() === s)
      || all.find(r => (r.rooFile || '').toLowerCase() === s);
    if (!room) return null;
    return { room, geo: room.roo ? RoomGeometry.fromJSON(room.roo) : loadRoo(room.rooFile || '') };
  };

  if (cmd === 'show') {
    const needle = rest.join(' ');
    let geo = null, label = needle;
    if (needle.toLowerCase().endsWith('.roo')) { geo = loadRoo(needle); }
    else {
      const hit = viaMap(needle);
      if (hit) { geo = hit.geo; label = `${hit.room.name} (room ${hit.room.num}, ${hit.room.rsc})`; }
    }
    if (!geo) { console.error(`could not load geometry for "${needle}"`); process.exit(1); }
    console.log(label);
    if (wantWalls) {
      const wm = geo.renderWalls();
      if (!wm) console.error('(no wall list in this room)');
      else {
        console.log(wm);
        console.log(`| - / \\ walls   · doorway (WF_PASSABLE)   . floor`);
        console.log(JSON.stringify(geo.wallSummary));
      }
    } else {
      console.log(geo.render());
    }
    process.exit(0);
  }

  if (cmd === 'path') {
    const [needle, from, to] = [rest.slice(0, -2).join(' '), rest.at(-2), rest.at(-1)];
    const hit = viaMap(needle);
    const geo = hit ? hit.geo : loadRoo(needle);
    if (!geo) { console.error(`could not load geometry for "${needle}"`); process.exit(1); }
    // CLI CONTRACT: `path` accepts `<col,row>` while RoomGeometry.path is `(row,col)`.
    const [c1, r1] = from.split(',').map(Number);
    const [c2, r2] = to.split(',').map(Number);
    const res = geo.path(r1, c1, r2, c2);
    if (!res.found) { console.log(`no path: ${res.reason}`); process.exit(1); }
    console.log(`${res.steps.length} step(s), ${res.expanded} squares examined`);
    const marks = [{ row: r1, col: c1, ch: 'A', label: 'start' }, { row: r2, col: c2, ch: 'B', label: 'goal' }];
    for (const s of res.steps.slice(0, -1)) marks.push({ row: s.row, col: s.col, ch: 'o' });
    console.log(geo.render({ marks }));
    console.log(res.steps.map(s => s.dir).join(' -> '));
    process.exit(0);
  }

  if (cmd === 'stats') {
    // Parse every room the graph knows about, from the .roo files rather than from
    // the baked copy, so this stays an independent check on the format.
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    let ok = 0, failed = [], noFine = 0, totalSquares = 0, totalWalkable = 0;
    const mismatch = [];
    for (const room of Object.values(map.rooms)) {
      const geo = loadRoo(room.rooFile || '');
      if (!geo) { failed.push(`${room.name} (${room.rsc})`); continue; }
      ok++;
      if (!geo.monsterGrid) noFine++;
      totalSquares += geo.rows * geo.cols;
      totalWalkable += geo.walkableCount;
      // The .roo grid dimensions must agree with the room object's piRows/piCols,
      // or coordinates from perception index the wrong square.
      if (room.rows != null && (geo.rows !== room.rows || geo.cols !== room.cols))
        mismatch.push(`${room.name}: kod says ${room.rows}x${room.cols}, .roo says ${geo.rows}x${geo.cols}`);
    }
    console.log(`parsed ${ok}/${Object.keys(map.rooms).length} rooms`);
    console.log(`${noFine} without a fine (monster) grid`);
    console.log(`${totalWalkable} walkable of ${totalSquares} squares (${(100 * totalWalkable / totalSquares).toFixed(1)}%)`);
    console.log(mismatch.length ? `DIMENSION MISMATCHES (${mismatch.length}):\n  ${mismatch.slice(0, 15).join('\n  ')}`
                                : 'every .roo grid matches its room object dimensions');
    if (failed.length) console.log(`could not load ${failed.length}: ${failed.slice(0, 10).join(', ')}`);
    process.exit(mismatch.length || failed.length ? 2 : 0);
  }

  console.error('usage: m59-roo.mjs show <room|file.roo> | path <room> <col,row> <col,row> | stats');
  process.exit(1);
}
