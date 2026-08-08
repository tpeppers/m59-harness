#!/usr/bin/env node
// Room geometry: the walkability grid a .roo file carries, which is the same data
// the player's minimap is drawn from.
//
//   node tools/m59-roo.mjs show <file.roo|roomName>     render the room as a minimap
//   node tools/m59-roo.mjs path <room> <c1,r1> <c2,r2>  route through the geometry
//   node tools/m59-roo.mjs stats                        parse every room, report
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
// way in (blakserv/ccode.c:1504), so a kod row R is grid row R-1. Everything this
// file exposes publicly uses kod's 1-based convention, because that is what the
// protocol speaks and what an agent will have in hand from perception.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Where the .roo files live. The server tree and the client tree are separate copies
// and can differ (a mismatch black-screens the real client in that room), so prefer
// the server's, which is the one the geometry checks actually run against.
export const DEFAULT_ROO_DIRS = [
  'C:/code/meridian59/resource/rooms',
  'C:/code/meridian59/run/localclient/resource',
];

export class RoomGeometry {
  constructor({ file, version, rows, cols, grid, flags, monsterGrid, walls, sidedefs, sectors, clientSize }) {
    Object.assign(this, { file, version, rows, cols, grid, flags, monsterGrid, walls, sidedefs, sectors, clientSize });
  }

  // The relief, as a spread rather than a per-square lookup — a per-square answer needs
  // the BSP leaf a point falls in, which is task "BSP nodes" and not yet built. This is
  // enough to tell a flat room from a stepped one and to prove the parse is sane.
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
  monsterCanReach(fromRow, fromCol, toRow, toCol, { los = 0, maxNodes = 200000 } = {}) {
    const fine = RoomGeometry.monsterUsesFine(los);
    const r = this.path(fromRow, fromCol, toRow, toCol, { fine, maxNodes });
    return { reachable: !!r.found, steps: r.found ? r.steps.length : null,
             grid: fine ? 'fine' : 'coarse', los,
             ...(r.found ? {} : { why: r.reason }) };
  }

  inBounds(row, col) { return row >= 1 && row <= this.rows && col >= 1 && col <= this.cols; }

  // Is there floor on this square? kod-style 1-based.
  walkable(row, col) {
    if (!this.inBounds(row, col)) return false;
    return (this.flags[(row - 1) * this.cols + (col - 1)] & ROOM_FLAG_WALKABLE) !== 0;
  }

  // The eight direction bits of the square you are standing on.
  openDirections(row, col, { fine = true } = {}) {
    if (!this.inBounds(row, col)) return [];
    const g = (fine ? this.moveGrid : this.grid)[(row - 1) * this.cols + (col - 1)];
    return DIRS.filter(d => (g & d.mask) !== 0);
  }

  // CanMoveInRoom, faithfully — including its two surprising allowances: a move to
  // a square OUTSIDE the grid is not rejected here (that is how you leave a room),
  // and a jump of more than one square is waved through as a teleport.
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
  neighbors(row, col, { fine = true } = {}) {
    const out = [];
    for (const d of this.openDirections(row, col, { fine })) {
      const r = row + d.dr, c = col + d.dc;
      if (!this.inBounds(r, c)) continue;          // leaving the room is a separate act
      if (!this.walkable(r, c)) continue;
      out.push({ row: r, col: c, dir: d.name, diagonal: d.dr !== 0 && d.dc !== 0 });
    }
    return out;
  }

  // The nearest square with floor on it, for when something has put us somewhere the
  // geometry says is solid. That happens: an admin teleport, an in-game teleporter
  // whose landing square the .roo disagrees about, or a room whose grid and object
  // positions were authored slightly apart. From such a square NOTHING is reachable,
  // because every route starts by leaving it, so a caller that cannot get off it is
  // stuck for good.
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

  path(fromRow, fromCol, toRow, toCol,
       { fine = true, maxNodes = 200000, avoid = null, threats = null, threatCost = null } = {}) {
    threatCost = threatCost ?? this.threatField(threats);
    if (!this.inBounds(fromRow, fromCol)) return { found: false, reason: 'start is outside the room grid' };
    if (!this.inBounds(toRow, toCol)) return { found: false, reason: 'goal is outside the room grid' };
    if (!this.walkable(toRow, toCol)) return { found: false, reason: 'goal square has no floor' };
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
    // to it. Fine movement covers that first hop — the server judges it, not the grid.
    let start = { row: fromRow, col: fromCol }, lead = null;
    if (!this.walkable(fromRow, fromCol)) {
      const near = this.nearestWalkable(fromRow, fromCol);
      if (!near) return { found: false, reason: 'no floor anywhere near the starting square', stuck: true };
      start = near;
      lead = { row: near.row, col: near.col, dir: null, recovered: true };
      if (near.row === toRow && near.col === toCol) return { found: true, steps: [lead] };
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
          steps.push({ row: rr, col: cc, dir: prev.dir });
          rr = prev.row; cc = prev.col; at = key(rr, cc);
        }
        steps.reverse();
        // `lead` is the recovery step onto believable floor, when we started somewhere
        // the grid does not think exists. It is first because it happened first.
        return { found: true, steps: lead ? [lead, ...steps] : steps, expanded,
                 ...(lead ? { recovered_from: { row: start.row, col: start.col } } : {}) };
      }
      for (const n of this.neighbors(cur.r, cur.c, { fine })) {
        const nk = key(n.row, n.col);
        if (closed.has(nk)) continue;
        // Never the GOAL, only the way there: if the destination itself is occupied we
        // still want the route, because whatever is standing on it will move and the
        // caller would otherwise be told the square is unreachable for ever.
        if (avoid && !(n.row === toRow && n.col === toCol) && avoid.has(`${n.row},${n.col}`)) continue;
        const cost = (gScore.get(ck) ?? Infinity) + (n.diagonal ? 1.4142 : 1)
                   + (threatCost ? threatCost(n.row, n.col) : 0);
        if (cost >= (gScore.get(nk) ?? Infinity)) continue;
        gScore.set(nk, cost);
        came.set(nk, { row: cur.r, col: cur.c, dir: n.dir });
        push({ r: n.row, c: n.col, f: cost + h(n.row, n.col) });
      }
    }
    return { found: false, reason: expanded >= maxNodes ? 'search budget exhausted' : 'no route through the geometry', expanded };
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

  // Compact enough to bake into JSON: three base64 byte planes. A 60x60 room is
  // about 4.8kB this way, so the whole world fits in a couple of megabytes and the
  // broker needs no access to the game's resource directory at all.
  toJSON({ includeWalls = true } = {}) {
    const out = {
      file: path.basename(this.file || ''),
      version: this.version, rows: this.rows, cols: this.cols,
      grid: Buffer.from(this.grid).toString('base64'),
      flags: Buffer.from(this.flags).toString('base64'),
      monsterGrid: this.monsterGrid ? Buffer.from(this.monsterGrid).toString('base64') : null,
    };
    if (includeWalls && this.walls) {
      // Only what the minimap needs: the segment and the three flags that decide how
      // it is drawn. Texture ids and offsets are for rendering a 3D view, which no
      // agent is doing, and they would triple the size of the file.
      out.walls = this.walls.filter(w => w.drawable).map(w =>
        [Math.round(w.x0), Math.round(w.y0), Math.round(w.x1), Math.round(w.y1),
         (w.passable ? 1 : 0) | (w.mapNever ? 2 : 0) | (w.mapAlways ? 4 : 0)]);
    }
    return out;
  }

  static fromJSON(j) {
    return new RoomGeometry({
      file: j.file, version: j.version, rows: j.rows, cols: j.cols,
      grid: Buffer.from(j.grid, 'base64'),
      flags: Buffer.from(j.flags, 'base64'),
      monsterGrid: j.monsterGrid ? Buffer.from(j.monsterGrid, 'base64') : null,
      walls: j.walls ? j.walls.map(([x0, y0, x1, y1, f]) => ({
        x0, y0, x1, y1, drawable: true,
        passable: !!(f & 1), mapNever: !!(f & 2), mapAlways: !!(f & 4),
      })) : null,
    });
  }
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
// The heights are read into a `WORD` by the client and then shifted left 4. They are
// genuinely SIGNED — floors below the nominal zero are ordinary — and C's implicit
// conversion of a WORD into the `int` parameter of HeightKodToClient is what makes
// that work there. readInt16LE is the same thing said deliberately.
const SLOPE_BYTES = 4 * 4 + 4 + 4 + 4 + 3 * 6;   // plane a,b,c,d | p0.x p0.y | angle | junk

function readSlope(buf, p, version) {
  const val = q => version >= 13 ? buf.readFloatLE(q) : buf.readInt32LE(q);
  // bspload.c LoadSlopeInfo. c === 0 is a vertical plane, which the client rejects and
  // replaces rather than dividing by zero; do the same so GetFloorHeight cannot NaN.
  let a = val(p), b = val(p + 4), c = val(p + 8), d = val(p + 12);
  if (c === 0) { a = 0; b = 0; c = 1024; d = 0; }
  return { a, b, c, d, x0: val(p + 16), y0: val(p + 20) };
}

export function parseRooSectors(buf, version, sectorOff) {
  const sectors = [];
  if (!(sectorOff > 0 && sectorOff + 2 <= buf.length)) return sectors;
  let q = sectorOff;
  const n = buf.readUInt16LE(q); q += 2;
  const fixed = 19 + (version >= 10 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    if (q + fixed > buf.length) break;
    const flags = buf.readInt32LE(q + 15);
    const s = {
      serverId: buf.readInt16LE(q),
      floorType: buf.readInt16LE(q + 2),
      ceilingType: buf.readInt16LE(q + 4),
      tx: buf.readInt16LE(q + 6), ty: buf.readInt16LE(q + 8),
      // Kept in CLIENT units, because that is the space every comparison happens in.
      floorHeight: heightKodToClient(buf.readInt16LE(q + 10)),
      ceilingHeight: heightKodToClient(buf.readInt16LE(q + 12)),
      light: buf.readUInt8(q + 14),
      flags,
      speed: version >= 10 ? buf.readUInt8(q + 19) : 0,
      depth: SECTOR_DEPTHS[sectorDepth(flags)],
      slopedFloor: null, slopedCeiling: null,
    };
    q += fixed;
    if (flags & SF.SLOPED_FLOOR) {
      if (q + SLOPE_BYTES > buf.length) break;
      s.slopedFloor = readSlope(buf, q, version); q += SLOPE_BYTES;
    }
    if (flags & SF.SLOPED_CEILING) {
      if (q + SLOPE_BYTES > buf.length) break;
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
  return Math.round((-s.a * x - s.b * y - s.d) / s.c);
}
export function ceilingHeightAt(x, y, sector) {
  if (!sector) return CLIENT_FINENESS;
  const s = sector.slopedCeiling;
  if (!s) return sector.ceilingHeight;
  return Math.round((-s.a * x - s.b * y - s.d) / s.c);
}

// bspload.c SetWallHeights (line 1324), the non-bowtie path. z0/z1 are the bottom and
// top of the LOWER wall at endpoint 0 — the step — and z2/z3 the normal/upper split,
// which is the headroom. zz* are the same four at endpoint 1.
//
// Bowties (a wall where which sector is higher SWAPS between its two endpoints) get
// the same z1/z0 assignment as the normal case in the non-D3D branch, so for a
// movement check — which only ever asks "how high is the step here" — treating them
// as normal is faithful. The D3D branch differs only in what it draws.
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

  const f1a = floorHeightAt(wall.x0, wall.y0, S1), f2a = floorHeightAt(wall.x0, wall.y0, S2);
  const f1b = floorHeightAt(wall.x1, wall.y1, S1), f2b = floorHeightAt(wall.x1, wall.y1, S2);
  if (f1a > f2a) {
    wall.z1 = f1a; wall.zz1 = (f1b >= f2b) ? f1b : f2b;
    wall.z0 = f2a; wall.zz0 = (f1b >= f2b) ? f2b : f1b;
    wall.bowtie = !(f1b >= f2b);
  } else {
    wall.z1 = f2a; wall.zz1 = (f2b >= f1b) ? f2b : f1b;
    wall.z0 = f1a; wall.zz0 = (f2b >= f1b) ? f1b : f2b;
    wall.bowtie = !(f2b >= f1b);
  }

  const c1a = ceilingHeightAt(wall.x0, wall.y0, S1), c2a = ceilingHeightAt(wall.x0, wall.y0, S2);
  const c1b = ceilingHeightAt(wall.x1, wall.y1, S1), c2b = ceilingHeightAt(wall.x1, wall.y1, S2);
  if (c1a < c2a) { wall.z3 = c2a; wall.zz3 = c2b; wall.z2 = c1a; wall.zz2 = c1b; }
  else           { wall.z3 = c1a; wall.zz3 = c1b; wall.z2 = c2a; wall.zz2 = c2b; }
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
    for (let i = 0; i < n && q + 13 <= buf.length; i++) {
      sidedefs.push({
        serverId: buf.readInt16LE(q),
        normalType: buf.readInt16LE(q + 2),
        aboveType: buf.readInt16LE(q + 4),
        belowType: buf.readInt16LE(q + 6),
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
    for (let i = 0; i < n && q + recBytes <= buf.length; i++) {
      const posNum = buf.readUInt16LE(q + 2);
      const negNum = buf.readUInt16LE(q + 4);
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
        posSidedef: posNum, negSidedef: negNum,
        // Both sidedefs kept, not just the drawing one: a crossing test asks about the
        // side it is approaching from, and `sd` above is whichever the MAP prefers.
        posSidedefRec: pos, negSidedefRec: neg,
        flags: sd ? sd.flags : 0,
        drawable: !!sd,
        passable: !!(sd && (sd.flags & WF.PASSABLE)),
        mapNever: !!(sd && (sd.flags & WF.MAP_NEVER)),
        mapAlways: !!(sd && (sd.flags & WF.MAP_ALWAYS)),
        posSector: buf.readInt16LE(q + recBytes - 4),
        negSector: buf.readInt16LE(q + recBytes - 2),
      });
      q += recBytes;
    }
  }

  // Sectors last, because the heights they carry are what turns a wall list into a
  // relief map — and then straight back onto the walls, which is where every
  // movement check reads them from.
  const sectors = parseRooSectors(buf, version, sectorOff);
  for (const w of walls) setWallHeights(w, sectors);

  return {
    width, height,
    cols: width >> LOG_CLIENT_FINENESS, rows: height >> LOG_CLIENT_FINENESS,
    offsets: { nodeOff, wallOff, sidedefOff, sectorOff },
    sidedefs, walls, sectors,
  };
}

export function parseRoo(buf, file = '') {
  if (buf.length < 20 || !buf.subarray(0, 4).equals(ROO_MAGIC))
    throw new Error('not a .roo file (bad magic)');
  const version = buf.readInt32LE(4);
  if (version < ROO_MIN_VERSION) throw new Error(`.roo version ${version} below minimum ${ROO_MIN_VERSION}`);
  // security(8..12) is not needed here; the server uses it to verify the client's copy.
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

  return new RoomGeometry({ file, version, rows, cols, grid, flags, monsterGrid,
                            walls: client ? client.walls : null,
                            sidedefs: client ? client.sidedefs : null,
                            sectors: client ? client.sectors : null,
                            clientSize: client ? { width: client.width, height: client.height,
                                                   rows: client.rows, cols: client.cols } : null });
}

// ------------------------------------------------------------------- loading

const cache = new Map();

export function loadRoo(nameOrPath, dirs = DEFAULT_ROO_DIRS) {
  if (cache.has(nameOrPath)) return cache.get(nameOrPath);
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
      const g = parseRoo(fs.readFileSync(c), c);
      cache.set(nameOrPath, g);
      return g;
    } catch (e) {
      if (e.code !== 'ENOENT') { /* a real parse failure is worth surfacing */ }
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
  const mapPath = process.env.M59_MAP ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'substrate', 'm59-map.json');
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
