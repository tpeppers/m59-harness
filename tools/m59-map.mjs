#!/usr/bin/env node
// The room graph: how an agent gets from anywhere to anywhere.
//
//   node tools/m59-map.mjs build            walk the server, write substrate/m59-map.json
//   node tools/m59-map.mjs refresh-geometry refresh baked .roo collision without the server
//   node tools/m59-map.mjs path <from> <to> shortest route between two room numbers or names
//   node tools/m59-map.mjs room <n>         one room's exits and neighbours
//   node tools/m59-map.mjs stats            what the graph looks like
//
// The room graph is built over the admin socket; collision bytes are refreshed from
// the exact .roo resources used by the server. That split is deliberate: the
// maintenance port has no password and must stay on loopback, but a JSON artifact is
// remote-safe, so the broker needs no privileged access at play time.
//
// Two exit mechanisms, and an agent must use the right one:
//
//   plEdge_Exits — walking PAST the row/col bounds. Room.SomethingMoved calls
//     StandardLeaveDir (room.kod:2645) when new_row > piRows, < 1, or the same for
//     cols. Each element is
//         [ leave_dir, dest_room_num, arrive_row, arrive_col, angle_change,
//           (condition_type, threshold)? ]
//     with leave_dir from blakston.khd:1219 — SOUTH 1, NORTH 2, WEST 3, EAST 4 —
//     and rows growing southward, cols growing eastward. The longer form makes the
//     destination depend on where along the edge you crossed, which is how one
//     boundary leads to two different rooms.
//
//   plExits — standing on a square and sending BP_REQ_GO. Room.SomethingTryGo reads
//         [ exit_row, exit_col, dest_room_num, arrive_row, arrive_col, angle_change ]
//     and the match is `row = First(i) AND col = Nth(i,2)` — an EXACT square, not a
//     radius. An agent one square off gets nothing at all. A dest of
//     ROOM_LOCKED_DOOR (-1) is a locked door, and then element 4 is the refusal
//     message rather than a row.
//
// Destinations are room NUMBERS (piRoom_num), not object ids, so the graph survives
// `save game` and restarts — which object ids do not (see NEXT-STEPS trap 8).
//
// COORDINATE CONTRACT: KOD exit tuples are positional `(row,col)`. This module
// normalizes them immediately into named `{row,col}` fields; movement callers use
// named `{col,row}` and must adapt by name rather than copying a bare tuple.

import net from 'node:net';
import { isMutableGeometry, MUTABLE_TRANSIT_PENALTY } from './m59-mutable.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadRoo, RoomGeometry, sharedRoomGeometry, DEFAULT_ROO_DIRS } from './m59-roo.mjs';
import { lazyRoomTopology } from './m59-room-artifacts.mjs';
import { attachLabExitAtlas, labExitApproaches } from './m59-exit-atlas.mjs';
import { loadCodeExits } from './m59-codeexits.mjs';
import {
  CHECKED_MAP_FILE, LOCAL_MAP_FILE, movementMapFile,
  geometryOutputFile, geometryRefreshBaseFile,
} from './m59-map-path.mjs';
export { CHECKED_MAP_FILE, LOCAL_MAP_FILE, movementMapFile } from './m59-map-path.mjs';

// Exits that exist only as code in the room class — see m59-codeexits.mjs. Built by:
// node tools/m59-codeexits.mjs
const CODE_EXITS_FILE = process.env.M59_CODE_EXITS ||
  path.join(path.dirname(fileURLToPath(import.meta.url)),
            '..', 'substrate', 'm59-codeexits.json');

const HOST = process.env.M59_HOST || '127.0.0.1';
const ADMIN_PORT = Number(process.env.M59_ADMIN_PORT || 9998);
const MAP_FILE = movementMapFile();
const OUTPUT_MAP_FILE = geometryOutputFile();

// blakston.khd:1219-1226. Note LEAVE_x and ENTER_x share numbers with opposite
// meanings, so never mix the two vocabularies.
export const LEAVE = { SOUTH: 1, NORTH: 2, WEST: 3, EAST: 4 };
export const LEAVE_NAME = { 1: 'south', 2: 'north', 3: 'west', 4: 'east' };

// blakston.khd:1212-1216
export const COND = { ROW_GT: 1, ROW_LT: 2, COL_GT: 3, COL_LT: 4, NONE: 5 };
export const COND_NAME = { 1: 'row>', 2: 'row<', 3: 'col>', 4: 'col<', 5: 'default' };

export const ROOM_LOCKED_DOOR = -1;         // blakston.khd:371
export const ROTATE_NONE = 8;               // blakston.khd:1253

// An explicitly named server resource directory is the whole authority. Treating it
// as merely the first hint can fill a missing server room from Steam and produce a
// mixed map whose provenance and collision decisions are both false.
export function roomResourceDirs({ explicit = process.env.M59_ROO_DIR,
                                   defaults = DEFAULT_ROO_DIRS } = {}) {
  return explicit ? [path.resolve(explicit)] : [...defaults];
}

// EXITS THE ROOM GRAPH CANNOT OBSERVE, BUT THE ROOM CLASS DEFINITELY IMPLEMENTS.
//
// TempleQor does not populate plEdge_Exits. Its SomethingMoved override catches
// LEAVE_SOUTH itself and forwards the player to piCurrentExit, which alternates on a
// timer between OutdoorsH9 (589) and OutdoorsI8 (598). The admin map builder therefore
// sees an empty exit list and every consumer calls the temple sealed even though its
// two walkable south-edge squares are the door.
//
// Keep both possible destinations in the graph. They are two descriptions of the SAME
// action, not two physical doors: walk south from the boundary and accept whichever
// outside room is currently open. A travel that expected the other destination simply
// replans from the room actually entered.
const SYNTHETIC_EDGE_EXITS = Object.freeze({
  802: Object.freeze([
    Object.freeze({ leave: LEAVE.SOUTH, leaveName: 'south', to: 589,
      arriveRow: null, arriveCol: null, synthetic: true, dynamic: true }),
    Object.freeze({ leave: LEAVE.SOUTH, leaveName: 'south', to: 598,
      arriveRow: null, arriveCol: null, synthetic: true, dynamic: true }),
  ]),
});

export function edgeExitsOf(room) {
  const declared = Array.isArray(room?.edgeExits) ? room.edgeExits : [];
  const synthetic = SYNTHETIC_EDGE_EXITS[room?.num] ?? [];
  return [...declared, ...synthetic.filter(s =>
    !declared.some(e => e.leave === s.leave && e.to === s.to))];
}

// ------------------------------------------------------------------ admin socket

// The shared helper in m59.mjs paces commands 400ms apart, which is right for
// interactive use and far too slow for a few thousand probes. The maintenance
// socket pipelines happily: write everything, read until it goes quiet.
function adminBatch(cmds, quietMs = 900, capMs = 180000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(ADMIN_PORT, HOST);
    let buf = '', quiet, hard;
    const finish = () => { clearTimeout(quiet); clearTimeout(hard); s.destroy(); resolve(buf); };
    s.on('connect', () => {
      s.write(cmds.join('\r\n') + '\r\n');
      quiet = setTimeout(finish, quietMs);
      hard = setTimeout(finish, capMs);
    });
    s.on('data', d => { buf += d; clearTimeout(quiet); quiet = setTimeout(finish, quietMs); });
    s.on('error', e => { clearTimeout(quiet); clearTimeout(hard); reject(e); });
  });
}

// `show list N` prints nested lists as one INT per line inside bracket lines. Parse
// them into arrays of numbers rather than trying to be clever about the nesting: the
// two lists we care about are both list-of-list-of-int, so depth is known.
function parseListDump(text) {
  const out = [];
  let cur = null, depth = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^:\s?/, '').trim();
    if (line === '[') { depth++; if (depth === 2) cur = []; continue; }
    if (line === ']') { if (depth === 2 && cur) { out.push(cur); cur = null; } depth--; continue; }
    const m = /^(?:INT|OBJECT|RESOURCE)\s+(-?\d+)$/.exec(line);
    if (m) {
      if (depth >= 2 && cur) cur.push(Number(m[1]));
      else if (depth === 1) out.push(Number(m[1]));   // a flat list, e.g. plYell_Zone
    }
  }
  return out;
}

// Split a batched reply into per-object blocks. Every `show object` answer begins
// with a line naming the object and its class.
function splitObjectBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const head = /OBJECT (\d+) is CLASS (\w+)/.exec(raw);
    if (head) { cur = { id: Number(head[1]), cls: head[2], lines: [] }; blocks.push(cur); continue; }
    if (cur) cur.lines.push(raw);
  }
  return blocks;
}

const prop = (lines, name, kind = 'INT') => {
  const re = new RegExp(`${name}\\s+= ${kind} (-?\\d+)`);
  for (const l of lines) { const m = re.exec(l); if (m) return Number(m[1]); }
  return null;
};
const propRsc = (lines, name) => {
  const re = new RegExp(`${name}\\s+= RESOURCE (\\S+)`);
  for (const l of lines) { const m = re.exec(l); if (m) return m[1]; }
  return null;
};

// ------------------------------------------------------------------ build

// SYS keeps the authoritative room registry in `plRooms`, so ask for it rather than
// sweeping object ids. Sweeping both misses and mislead: room objects run past 3498
// here, and a room whose id happens to be outside the swept range silently becomes a
// dangling destination that truncates every route through it.
async function roomObjectIds() {
  const sys = await adminBatch(['show object 0'], 900);
  const listId = prop(sys.split(/\r?\n/), 'plRooms', 'LIST');
  if (!listId) throw new Error('SYS has no plRooms list — cannot enumerate rooms');
  const dump = await adminBatch([`show list ${listId}`], 1500);
  const ids = [];
  for (const raw of dump.split(/\r?\n/)) {
    const m = /^:?\s*OBJECT (\d+)$/.exec(raw.trim());
    if (m) ids.push(Number(m[1]));
  }
  return { listId, ids: [...new Set(ids)] };
}

export function resourcePathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative));
}

export function bakeRoomGeometry(byNum, {
  dirs = DEFAULT_ROO_DIRS,
  includeSurfaces = 'preserve',
  authoritativeDir = process.env.M59_ROO_DIR ? path.resolve(process.env.M59_ROO_DIR) : null,
} = {}) {
  let baked = 0;
  const missing = [];
  const sources = [];
  // Abstract routing starts each intermediate room at the coordinates published by
  // the hop that entered it. Price edge approaches against the union of those known
  // arrivals so a decorative/disconnected boundary component is not advertised to
  // findPath. Live World.exits still considers the component the character is
  // actually standing in, including unusual operator-placed starts.
  const arrivals = new Map();
  const edgeDirections = new Map();
  const addDirection = (roomNum, direction) => {
    if (!byNum[roomNum] || !direction) return;
    if (!edgeDirections.has(roomNum)) edgeDirections.set(roomNum, new Set());
    edgeDirections.get(roomNum).add(direction);
  };
  // COORDINATE CONTRACT: positional arrival arguments mirror KOD `(row,col)` and
  // are normalized to named fields at this boundary.
  const addArrival = (to, row, col) => {
    if (!byNum[to] || !Number.isInteger(row) || !Number.isInteger(col)) return;
    if (!arrivals.has(to)) arrivals.set(to, []);
    const list = arrivals.get(to);
    if (!list.some(point => point.row === row && point.col === col)) list.push({ row, col });
  };
  for (const room of Object.values(byNum)) {
    for (const exit of edgeExitsOf(room)) {
      addDirection(room.num, exit.leaveName ?? LEAVE_NAME[exit.leave]);
      addArrival(exit.to, exit.arriveRow, exit.arriveCol);
      // inferredExits can use the physically valid reverse boundary when the
      // destination publishes edge exits of its own.
      if ((byNum[exit.to]?.edgeExits || []).length)
        addDirection(exit.to, LEAVE_NAME[OPPOSITE[exit.leave]]);
    }
    for (const exit of room.goExits || [])
      addArrival(exit.to, exit.arriveRow, exit.arriveCol);
    for (const exit of codeExits(room.num))
      addArrival(exit.to, exit.arrive?.row, exit.arrive?.col);
  }
  for (const room of Object.values(byNum)) {
    if (!room.rooFile) { missing.push(room.name); continue; }
    let geo;
    try { geo = loadRoo(room.rooFile, dirs, { strict: true }); }
    catch (error) {
      missing.push(`${room.name} (${room.rooFile}): ${error.message}`);
      continue;
    }
    if (!geo) { missing.push(`${room.name} (${room.rooFile}): file not found`); continue; }
    if (authoritativeDir && !resourcePathWithin(authoritativeDir, geo.file)) {
      missing.push(`${room.name} (${room.rooFile}): resolved outside authoritative directory ` +
        authoritativeDir);
      continue;
    }
    // The movement payload is compact and self-contained. Rich RTS render surfaces
    // remain opt-in; baking 88k pretty-printed leaf objects grows this file by 40 MB.
    const bakeSurfaces = includeSurfaces === true || (includeSurfaces === 'preserve'
      && Array.isArray(room.roo?.sectors) && Array.isArray(room.roo?.leaves));
    const bakedRoo = geo.toJSON({ includeSurfaces: bakeSurfaces,
      graphEntrySquares: arrivals.get(room.num) ?? null,
      edgeDirections: edgeDirections.get(room.num) ?? [] });
    if (!bakedRoo.collisionVersion) {
      missing.push(`${room.name} (${room.rooFile}): collision payload was not emitted`);
      continue;
    }
    // kod's piRows/piCols and the .roo grid must agree or every coordinate from
    // perception indexes the wrong square. A collision artifact with mismatched
    // bounds is unusable, so strict refresh rejects it instead of merely recording
    // a warning that runtime movement cannot safely ignore.
    if (room.rows != null && (geo.rows !== room.rows || geo.cols !== room.cols)) {
      missing.push(`${room.name} (${room.rooFile}): KOD dimensions ${room.rows}x${room.cols} ` +
        `do not match .roo ${geo.rows}x${geo.cols}`);
      continue;
    }
    room.roo = bakedRoo;
    sources.push(geo.file);
    delete room.rooDimensionMismatch;
    baked++;
  }
  return { baked, missing, sources };
}

export function geometryManifest(rooms) {
  const entries = Object.entries(rooms).map(([key, room]) => [
    key, room.num, room.rows ?? null, room.cols ?? null, room.rooFile ?? null,
    room.roo?.file ?? room.rooFile ?? null,
    room.roo?.security ?? null, room.roo?.collision?.digest ?? null,
  ]).sort((a, b) => Number(a[0]) - Number(b[0]));
  return {
    geometryRoomCount: entries.length,
    geometryManifestSha256: crypto.createHash('sha256')
      .update(JSON.stringify(entries)).digest('hex'),
  };
}

export function setGeometryProvenance(map, outputFile, {
  sourceDir = process.env.M59_ROO_DIR,
  sourceRoot = process.env.M59_ROOT,
  now = () => new Date().toISOString(),
} = {}) {
  const checkedReference = path.resolve(outputFile) === path.resolve(CHECKED_MAP_FILE);
  if (checkedReference) {
    // The committed reference is reproducible and reviewable by its semantic manifest.
    // Never leak a maintainer's absolute source path or restamp an unchanged artifact.
    delete map.geometryBuiltAt;
    map.geometrySource = 'portable reference room resources';
  } else {
    map.geometryBuiltAt = now();
    map.geometrySource = sourceDir ? path.resolve(sourceDir)
      : (sourceRoot ? 'M59_ROOT/resource/rooms' : 'auto-discovered room resources');
  }
  return map;
}

// Decode the authority the movement code will actually use, not just its version
// number. This catches a valid-looking header with a bad digest, orphaned wall chain,
// wrong-direction edge approach, or other semantic corruption before the broker can
// advertise itself as healthy.
export function movementMapReadiness(map) {
  const entries = Object.entries(map?.rooms ?? {});
  const rooms = entries.map(([, room]) => room);
  const invalid = [];
  const numbers = new Set();
  for (const [key, room] of entries) {
    const geometry = room.roo && !room.rooDimensionMismatch
      ? sharedRoomGeometry(room) : null;
    const number = Number(room.num);
    const unique = Number.isInteger(number) && !numbers.has(number);
    if (unique) numbers.add(number);
    const keyMatches = String(number) === String(key);
    const dimensionsMatch = geometry && room.rows === geometry.rows && room.cols === geometry.cols;
    const fileMatches = geometry && path.basename(String(room.rooFile ?? '')).toLowerCase() ===
      path.basename(String(geometry.file ?? '')).toLowerCase();
    if (!geometry?.collisionReady || !unique || !keyMatches || !dimensionsMatch || !fileMatches)
      invalid.push(room.num ?? room.name ?? key ?? '?');
  }
  const manifest = geometryManifest(map?.rooms ?? {});
  const manifestMatches = map?.geometryRoomCount === manifest.geometryRoomCount
    && map?.geometryManifestSha256 === manifest.geometryManifestSha256;
  return {
    ok: rooms.length > 0 && invalid.length === 0 && manifestMatches,
    total: rooms.length,
    ready: rooms.length - invalid.length,
    invalid,
    manifest_matches: manifestMatches,
    expected_manifest: manifest.geometryManifestSha256,
    actual_manifest: map?.geometryManifestSha256 ?? null,
  };
}

async function build({ chunk = 300 } = {}) {
  const { listId, ids } = await roomObjectIds();
  process.stderr.write(`  SYS plRooms (list ${listId}) holds ${ids.length} room objects\n`);

  // Pass 1: each room's scalar properties.
  const rooms = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    for (const b of splitObjectBlocks(await adminBatch(slice.map(id => `show object ${id}`)))) {
      const roomNum = prop(b.lines, 'piRoom_num');
      if (roomNum === null) continue;
      rooms.push({
        objId: b.id,
        cls: b.cls,
        num: roomNum,
        rows: prop(b.lines, 'piRows'),
        cols: prop(b.lines, 'piCols'),
        flags: prop(b.lines, 'piRoom_Flags'),
        rsc: propRsc(b.lines, 'prRoom'),
        edgeList: prop(b.lines, 'plEdge_Exits', 'LIST'),
        exitList: prop(b.lines, 'plExits', 'LIST'),
        yellList: prop(b.lines, 'plYell_Zone', 'LIST'),
      });
    }
    process.stderr.write(`\r  pass 1: ${Math.min(i + chunk, ids.length)}/${ids.length} objects, ${rooms.length} rooms`);
  }
  process.stderr.write('\n');

  // Pass 2: the lists, and the display name. vrName is a CLASSVAR, so it is not in
  // `show object` output at all — it has to come from `show class`, and then the
  // resource name has to be resolved to a string. Both are loopback-only, which is
  // exactly why the result gets baked into the file.
  const listIds = new Set();
  for (const r of rooms) for (const l of [r.edgeList, r.exitList, r.yellList]) if (l) listIds.add(l);

  const listCmds = [...listIds].map(l => `show list ${l}`);
  const listText = await adminBatch(listCmds, 1200);
  // Replies come back in order, each starting at its own `show list N` echo.
  const lists = new Map();
  for (const part of listText.split(/(?=show list \d+)/)) {
    const m = /^show list (\d+)/.exec(part.trim());
    if (m) lists.set(Number(m[1]), parseListDump(part));
  }
  process.stderr.write(`  pass 2: ${lists.size}/${listIds.size} lists read\n`);

  const classes = [...new Set(rooms.map(r => r.cls))];
  const classText = await adminBatch(classes.map(c => `show class ${c}`), 1200);
  const nameRscByClass = new Map();
  for (const part of classText.split(/(?=show class \w+)/)) {
    const m = /^show class (\w+)/.exec(part.trim());
    if (!m) continue;
    const n = /vrName\s+= RESOURCE (\S+)/.exec(part);
    // A classvar that a subclass overrode prints as `OVERRIDE <n>` rather than
    // naming the resource, so fall back to kod's own naming convention —
    // `vrName = room_name_<Class>` is how every room in the tree declares it.
    nameRscByClass.set(m[1], n ? n[1] : `room_name_${m[1]}`);
  }
  // Resolve BOTH the display-name resource and the room resource. The latter is the
  // .roo FILENAME (`room_OutdoorsC4 = c4.roo`), which is the only link from a room to
  // its geometry — `show object` reports the resource's name, not its value.
  const nameRscs = [...new Set([...nameRscByClass.values()])];
  const roomRscs = [...new Set(rooms.map(r => r.rsc).filter(Boolean))];
  const rscText = await adminBatch([...nameRscs, ...roomRscs].map(n => `show resource ${n}`), 1500);
  const stringByRsc = new Map();
  for (const line of rscText.split(/\r?\n/)) {
    // "22670   room_name_OutdoorsC4 = Deep Woods of Ileria"
    const m = /^(\d+)\s+(\S+) = (.*)$/.exec(line.trim());
    if (m) stringByRsc.set(m[2], { id: Number(m[1]), text: m[3].trim() });
  }
  process.stderr.write(`  pass 2: ${nameRscs.filter(n => stringByRsc.has(n)).length}/${nameRscs.length} room names, ` +
                       `${roomRscs.filter(n => stringByRsc.has(n)).length}/${roomRscs.length} .roo filenames resolved\n`);

  // Assemble.
  const byNum = {};
  for (const r of rooms) {
    const nameRsc = nameRscByClass.get(r.cls);
    const named = nameRsc && stringByRsc.get(nameRsc);

    const edges = (r.edgeList ? lists.get(r.edgeList) || [] : []).map(e => ({
      leave: e[0], leaveName: LEAVE_NAME[e[0]] || `dir${e[0]}`,
      to: e[1], arriveRow: e[2], arriveCol: e[3], angleChange: e[4],
      // The 5-element form is unconditional. Longer forms make the destination
      // depend on where along the edge you crossed.
      condition: e.length > 5 ? { type: e[5], name: COND_NAME[e[5]] || `cond${e[5]}`, threshold: e[6] } : null,
    }));

    const gos = (r.exitList ? lists.get(r.exitList) || [] : []).map(e => ({
      row: e[0], col: e[1],
      to: e[2], locked: e[2] === ROOM_LOCKED_DOOR,
      arriveRow: e[2] === ROOM_LOCKED_DOOR ? null : e[3],
      arriveCol: e[2] === ROOM_LOCKED_DOOR ? null : e[4],
      angleChange: e[2] === ROOM_LOCKED_DOOR ? null : e[5],
    }));

    // plYell_Zone is a FLAT list of room numbers, unlike the other two.
    const yell = r.yellList ? (lists.get(r.yellList) || []).filter(x => typeof x === 'number') : [];

    const rooRsc = r.rsc && stringByRsc.get(r.rsc);

    byNum[r.num] = {
      num: r.num, objId: r.objId, cls: r.cls, rsc: r.rsc,
      name: named ? named.text : r.cls,
      nameRsc: named ? named.id : null,
      // The room resource id is what BP_PLAYER sends as GetRoomResource, so it is a
      // second protocol-visible key onto this room alongside nameRsc.
      roomRsc: rooRsc ? rooRsc.id : null,
      rooFile: rooRsc ? rooRsc.text : null,
      rows: r.rows, cols: r.cols, flags: r.flags,
      edgeExits: edges, goExits: gos, yellZone: yell,
    };
  }

  // Bake the walkability geometry in. It could be loaded from the game's resource
  // directory at play time instead, but baking it means the broker needs no access
  // to the M59 tree at all — the same reason the resource strings are baked. Three
  // compact sectors, leaves, BSP nodes, directional sidedefs, and reachable boundary
  // approaches. The generated reference artifact is intentionally tens of MB rather
  // than a few unchecked minimap planes.
  // A full build remains the source for the rich RTS scene surfaces. The offline
  // refresh below upgrades collision only and preserves the existing graph payload.
  const { baked, missing } = bakeRoomGeometry(byNum, {
    dirs: roomResourceDirs(), includeSurfaces: true,
  });
  process.stderr.write(`  pass 3: geometry baked for ${baked}/${Object.keys(byNum).length} rooms` +
                       `${missing.length ? `, missing ${missing.length}` : ''}\n`);
  if (missing.length) process.stderr.write(`    missing: ${missing.slice(0, 8).join(', ')}\n`);
  if (missing.length)
    throw new Error('refusing to build a map with incomplete collision geometry');

  return setGeometryProvenance({
    builtAt: new Date().toISOString(),
    ...geometryManifest(byNum),
    note: 'Room numbers (piRoom_num) are stable across save/restart; objId is NOT — ' +
          'it is recorded for admin-socket convenience only and must be re-resolved after a save. ' +
          'nameRsc and roomRsc are protocol-visible (BP_PLAYER) and are the keys a broker ' +
          'should use to identify which room a session is standing in.',
    rooms: byNum,
  }, OUTPUT_MAP_FILE);
}

// ------------------------------------------------------------------ graph

// MEMOIZED PER FILE (+ mtime/size, so a rewritten fixture still reloads in tests).
// loadMap() used to JSON.parse on EVERY call, returning a fresh object each time — and
// every consumer then paid its own lazy builds on that private instance: the reverse-edge
// table (~11s), the geometry parse, the step-mask attach. The keeper's startup warm built
// `__reverse` on the map IT loaded, then `new Router({ session })` called loadMap() again,
// got a different object, and the first route search re-paid the whole build ON THE TICK
// (the recurring 11s stall). One shared map per process means one build, paid wherever the
// process chooses to pay it (startup, via the eager warms).
const _loadMapCache = new Map();
export function loadMap(file = MAP_FILE) {
  const resolved = path.resolve(file);
  let st = null;
  try { st = fs.statSync(resolved); } catch { /* fall through: the read below reports it */ }
  if (st) {
    const key = `${resolved}\0${st.mtimeMs}\0${st.size}`;
    const hit = _loadMapCache.get(key);
    if (hit) {
      attachLabExitAtlas(hit);
      return hit;
    }
    const map = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    attachLabExitAtlas(map);
    if (_loadMapCache.size > 8) _loadMapCache.clear();  // a handful of fixtures is the real ceiling
    _loadMapCache.set(key, map);
    return map;
  }
  const map = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  attachLabExitAtlas(map);
  return map;
}

export function writeMapAtomic(file, map) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, JSON.stringify(map, null, 1));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(temp, file);
  } finally {
    if (fd != null) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* renamed successfully, or never created */ }
  }
}

function edgeConditionAllows(condition, candidate) {
  if (!condition) return true;
  const { type, threshold } = condition;
  if (type === COND.ROW_GT) return candidate.row > threshold;
  if (type === COND.ROW_LT) return candidate.row < threshold;
  if (type === COND.COL_GT) return candidate.col > threshold;
  if (type === COND.COL_LT) return candidate.col < threshold;
  return true;
}

// StandardLeaveDir evaluates the complete ordered plEdge_Exits list. A default
// (NO_OTHER_CONDITIONS) is remembered but does not stop the scan; a later matching
// condition or unconditional entry wins. Simulate that selection so a crossing
// grounded for Fey's default south exit cannot actually send the character east.
export function selectedEdgeAt(room, direction, candidate) {
  let selected = null;
  for (const edge of edgeExitsOf(room)) {
    if ((edge.leaveName ?? LEAVE_NAME[edge.leave]) !== direction || edge.synthetic) continue;
    if (edge.condition?.type === COND.NONE) { selected = edge; continue; }
    if (!edge.condition || edgeConditionAllows(edge.condition, candidate)) {
      selected = edge;
      break;
    }
  }
  return selected;
}

// Exact BSP-validated crossings for a declared server edge. Keeping this beside the
// graph makes an impossible direct edge disappear before route search chooses it;
// execution revalidates the selected coordinates against live room state.
export function edgeCandidatesOf(room, edgeOrDirection, condition = null, { live = false } = {}) {
  if (!room?.roo || room.rooDimensionMismatch) return [];
  const direction = typeof edgeOrDirection === 'string'
    ? edgeOrDirection : edgeOrDirection?.leaveName ?? LEAVE_NAME[edgeOrDirection?.leave];
  const edgeCondition = typeof edgeOrDirection === 'object'
    ? edgeOrDirection.condition : condition;
  // The optional lab atlas is a precomputed answer to this exact immutable geometry
  // question. It is registered only after format/predicate/manifest/security/dimension
  // validation; null means any one of those gates failed and preserves the authoritative
  // live path below. Production never registers it.
  const atlasApproaches = labExitApproaches(room, direction);
  const geo = atlasApproaches ? null : sharedRoomGeometry(room);
  if (!atlasApproaches && !geo?.collisionReady) return [];
  const approaches = (atlasApproaches ?? geo.edgeApproachCandidates(direction))
    .filter(candidate => live || candidate.graph_routable !== false);
  if (typeof edgeOrDirection !== 'object' || edgeOrDirection.synthetic)
    return approaches.filter(candidate => edgeConditionAllows(edgeCondition, candidate));
  const declared = edgeExitsOf(room).includes(edgeOrDirection);
  if (!declared) return approaches.filter(candidate => edgeConditionAllows(edgeCondition, candidate));
  return approaches.filter(candidate => selectedEdgeAt(room, direction, candidate) === edgeOrDirection);
}

// Every way out of a room, as one uniform list, because an agent should not have to
// care which mechanism a given door uses — only what it has to do.
export function exitsOf(room) {
  const out = [];
  for (const e of edgeExitsOf(room)) {
    // Hand-authored/diagnostic graph fixtures without any geometry remain useful for
    // abstract route search. Once a room carries a .roo payload, however, a declared
    // edge with no validated approach is physically non-routable and must disappear.
    if (room?.roo && !topologyProvesEdgeCandidate(room, e) &&
        !edgeCandidatesOf(room, e).length) continue;
    out.push({
      kind: 'edge', to: e.to, direction: e.leaveName,
      how: `walk ${e.leaveName} past the room edge` +
           (e.synthetic ? ' (synthetic from the room class; destination changes on its timer)' : '') +
           (e.condition ? ` (only when ${e.condition.name}${e.condition.threshold})` : ''),
      arriveRow: e.arriveRow, arriveCol: e.arriveCol,
      condition: e.condition,
      ...(e.synthetic ? { synthetic: true } : {}),
      ...(e.dynamic ? { dynamic_destination: true } : {}),
    });
  }
  for (const g of room.goExits) {
    if (g.locked) {
      out.push({ kind: 'locked', to: null, row: g.row, col: g.col,
                 how: `locked door at r${g.row}c${g.col} (row=${g.row}, col=${g.col})` });
      continue;
    }
    out.push({
      kind: 'go', to: g.to, row: g.row, col: g.col,
      how: `stand exactly on r${g.row}c${g.col} (row=${g.row}, col=${g.col}) then go`,
      arriveRow: g.arriveRow, arriveCol: g.arriveCol,
    });
  }
  return out;
}

// Breadth-first, because every edge costs about the same to an agent: one walk plus
// possibly one `go`, and the real cost is dominated by the one-move-per-second pace
// rather than by distance inside a room.
// THE REVERSE OF EVERY EDGE EXIT, WHICH THE BUILDER NEVER SAW.
//
// Room definitions declare where walking off an edge takes you, and the builder
// records exactly that. But it only ever learns a room's exits from the room's own
// definition, so the graph came out almost entirely one-directional: from Marion,
// 9 rooms of 264 were reachable, and `travel` answered "no route in the graph" for
// most of the world. That is what stranded three characters in a temple for twenty
// minutes with a perfectly correct idea of where the rats were.
//
// Edge exits are geometry, and geometry is symmetric: if walking north out of A
// lands in B, then B's south edge is A. So the reverse can be inferred, and the
// direction to walk is known, which makes it actionable rather than a bare edge.
//
// ONLY edge exits. A `go` exit is a door or a teleporter and is under no obligation
// to be reversible — the museum portal out of the newbie zone is deliberately
// one-way, and inferring a way back into a sealed region would be worse than having
// no edge at all.
const OPPOSITE = { [LEAVE.NORTH]: LEAVE.SOUTH, [LEAVE.SOUTH]: LEAVE.NORTH,
                   [LEAVE.WEST]: LEAVE.EAST,  [LEAVE.EAST]: LEAVE.WEST };

// Inferred edges that the server refused. Inference is a guess — a sound one, since
// edge exits are geometry — but not every reverse holds: two rooms can share a
// boundary in one direction only, and walking off Marion's north edge toward a room
// that declares an edge INTO Marion simply does nothing. A guess that cannot be
// corrected is worse than no guess, because the planner keeps routing through it and
// every attempt looks like a fresh mystery. So: try it once, and on refusal drop it.
// AND THE REFUSAL HAS TO SURVIVE A RESTART, or it is not a correction, it is a shrug.
//
// This was a bare `new Set()`. Within one process it worked exactly as the comment above
// describes; across processes it forgot everything, and the broker restarts constantly —
// 131 boots in one day. So every boot re-inferred the same dead edges and the fleet paid
// for them again.
//
// It was measurable and it was enormous. Deep Woods of Ileria [534] has no exit to The
// Temple of Shal'ille [48]; the Temple declares an edge east INTO the woods and nothing
// comes back, so the reverse is inferred and refused. Lifetime: 9 successes against 1,645
// failures, 82% of every failed hop in the fleet, while the fleet as a whole spent 75% of
// its time travelling and 6% fighting. One forgotten Set.
const BAD_EXITS_FILE = process.env.M59_BAD_EXITS ||
  path.join(path.dirname(fileURLToPath(import.meta.url)),
            '..', 'substrate', 'm59-badexits.json');

const badInferred = new Set(readBadExits());
// Every cache below describes the effective static routing graph. A refused inferred
// reverse edge changes that graph for every loaded map variant, so one monotonic revision
// is the invalidation token shared with higher-level projections such as World.exits().
// The WeakMaps keep separately loaded/test maps isolated without making the cache own them.
export let routingRevision = 0;
let passableExitCacheByMap = new WeakMap();
let bfsPathCacheByMap = new WeakMap();

const weakKey = value => (typeof value === 'object' && value !== null) ||
  typeof value === 'function';

// Cached exits cross caller boundaries. Clone before freezing so nested condition/region
// records from the source map remain ordinary mutable fixture data while the shared cache
// itself cannot be poisoned by a caller changing an exit in place.
function immutableRouteCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableRouteCopy));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, child] of Object.entries(value)) copy[key] = immutableRouteCopy(child);
    return Object.freeze(copy);
  }
  return value;
}

function invalidateStaticRoutingCaches() {
  routingRevision++;
  passableExitCacheByMap = new WeakMap();
  bfsPathCacheByMap = new WeakMap();
}

function readBadExits() {
  try { return JSON.parse(fs.readFileSync(BAD_EXITS_FILE, 'utf8')).refused ?? []; } catch { return []; }
}
export function forgetInferredExit(from, to) {
  const key = from + '->' + to;
  if (badInferred.has(key)) return;
  badInferred.add(key);
  // `passableExits` contains the inferred edge itself, while bfsPath contains whole
  // answers chosen through it. Both must disappear before the next route query.
  invalidateStaticRoutingCaches();
  try {
    fs.writeFileSync(BAD_EXITS_FILE, JSON.stringify({
      note: 'Inferred reverse edges the server has refused. Written by forgetInferredExit ' +
            'in m59-map.mjs; delete an entry to let the router try it again.',
      refused: [...badInferred],
    }, null, 1));
  } catch { /* a lost note is better than a crashed router */ }
}
export function inferredExitCount() { return badInferred.size; }

// A DECLARED EDGE THAT IS ONE-WAY IN THE ACTUAL GAME HAS HAD NOWHERE TO LIVE.
//
// `badInferred` above only ever filters edges this file INFERRED — reverses it invented
// and the server then refused. An edge the map genuinely declares, which a player
// nonetheless cannot walk, is a different fact and there was no home for it.
//
// The instance that forced this: the operator, who knows the world, states that going
// from *An ancient place, its origin forgotten* [579] to *Ukgoth* [599] **through Under
// the shadow of the Sentinel [589] is impossible for a player**, and that the real way
// round is 578 -> 576 -> 587 -> 597 -> 598. Our router planned the impossible way, in two
// hops, and would have kept planning it for ever: the geometry catches the `599 -> 598`
// half of that corridor (zero routable crossing squares) and misses the `589 -> 599` half,
// which offers four.
//
// SO THE RECORD IS OPERATOR KNOWLEDGE, NOT A MEASUREMENT, and it is committed for exactly
// that reason — it is a fact about the world rather than about this machine, the same
// class of thing as the merchant allowlist. Anything derived from geometry belongs in the
// bake instead; if a future scan can prove the crossing impossible on its own, the entry
// becomes redundant rather than wrong.
//
// DIRECTED, and the direction matters: 599 -> 589 is walkable and only the reverse is not.
// Recording it as a symmetric block would delete a legitimate route.
const ONE_WAY_FILE = process.env.M59_ONE_WAY ||
  path.join(path.dirname(fileURLToPath(import.meta.url)),
            '..', 'substrate', 'm59-oneway.json');

let oneWayCache = null;
export function oneWayBlocks() {
  if (oneWayCache) return oneWayCache;
  const out = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(ONE_WAY_FILE, 'utf8'));
    for (const e of j.blocked ?? [])
      if (Number.isFinite(e?.from) && Number.isFinite(e?.to))
        // KEYED ON THE EXIT, NOT THE ROOM PAIR, when the record says which exit. Two rooms
        // are frequently joined by more than one thing — Cor Noth reaches Main gate to Cor
        // Noth by a dead west EDGE and by a working DOOR — and a block that cannot tell
        // them apart removes both. That is not hypothetical: it routed 150 -> 574 eight
        // hops round the Merchant Ways instead of through the door beside it.
        out.set(e.from + '->' + e.to + (e.leave ? '|' + e.leave : ''),
                e.why ?? 'recorded as unusable');
  } catch { /* no file is "nothing is known", which routes exactly as it used to */ }
  oneWayCache = out;
  return out;
}
// An exit is blocked when the record names the whole pair, or names this exit exactly.
export function isOneWayBlocked(from, to, ex = null) {
  const book = oneWayBlocks();
  if (book.has(from + '->' + to)) return true;                     // whole-pair block
  const dir = ex?.leaveName ?? ex?.leave_name ?? null;
  return dir ? book.has(from + '->' + to + '|' + dir) : false;
}

// The one place both searches ask "where can I go from here", so a rule added here cannot
// be honoured by one of them and not the other — which is how the two would come to
// disagree about which routes exist.
export function passableExits(map, at) {
  const room = map.rooms[at];
  if (!room) return [];
  let rooms = null;
  const key = String(at);
  if (weakKey(map)) {
    rooms = passableExitCacheByMap.get(map);
    if (!rooms) {
      rooms = new Map();
      passableExitCacheByMap.set(map, rooms);
    }
    if (rooms.has(key)) return rooms.get(key);
  }
  const result = immutableRouteCopy(
    [...exitsOf(room), ...inferredExits(map, at), ...codeExits(at)]
      .filter(ex => ex.to != null && !isOneWayBlocked(Number(at), Number(ex.to), ex)));
  rooms?.set(key, result);
  return result;
}

// THE MAP-GLOBAL TABLE OF INFERRED REVERSE-EDGES. Built once, then read forever. The
// build iterates every room and calls edgeCandidatesOf (which touches geometry), so on a
// full map it takes ~10s. It was lazy — built on the first inferredExits() call, which
// landed on a character's first tick and stalled the loop for 24s (the cold-start stall).
// buildReverseEdges() exists so a caller can pay that cost at STARTUP, off the tick path,
// where the keeper is already busy loading geometry and the 10s is invisible.
//
// It is a pure build: no time budget, no truncation, no dropped edges — the same
// computation, just scheduled earlier. inferredExits() still calls it lazily as a fallback
// for any path that reads inferred exits before startup builds them, so nothing depends on
// the call being made.
function topologyProvesEdgeCandidate(room, edgeOrDirection) {
  if (!room?.roo || room.rooDimensionMismatch) return false;
  const topology = lazyRoomTopology(room);
  if (!topology?.length) return false;
  const direction = typeof edgeOrDirection === 'string'
    ? edgeOrDirection : edgeOrDirection?.leaveName ?? LEAVE_NAME[edgeOrDirection?.leave];
  for (const anchor of topology) {
    if (anchor.dir !== direction) continue;
    if (typeof edgeOrDirection === 'object' && Number(anchor.to) !== Number(edgeOrDirection.to))
      continue;
    // Re-run today's ordered edge selection against the baked coordinate. This makes an
    // anchor positive evidence only when it still selects a current declaration; any map
    // graph change therefore falls back to full geometry rather than trusting stale shape.
    const selected = selectedEdgeAt(room, direction, anchor);
    if (typeof edgeOrDirection === 'object') {
      if (selected === edgeOrDirection) return true;
    } else if (selected) return true;
  }
  return false;
}

export function buildReverseEdges(map) {
  if (map.__reverse) return map.__reverse;
  const rev = new Map();
  for (const r of Object.values(map.rooms)) {
    for (const e of r.edgeExits || []) {
      if (e.to == null || e.condition) continue;   // conditional exits are not symmetric
      if (r.roo && !topologyProvesEdgeCandidate(r, e) && !edgeCandidatesOf(r, e).length) continue;
      const back = OPPOSITE[e.leave];
      if (!back) continue;
      // NEVER infer an edge OUT of a room that declares no edge exits at all.
      // StandardLeaveDir reads the destination room's own plEdge_Exits; if that
      // list is empty, walking off any boundary of that room does nothing, and no
      // amount of the neighbour declaring an edge inward changes it. Marion is
      // exactly this: plEdge_Exits = $, entered by walking north off the West
      // Merchant Way, and impossible to walk out of. Inferring the reverse there
      // does not just fail — it invents an escape route that the router then
      // trusts, which is how a nine-room pocket passed every safety check.
      if (!(map.rooms[e.to]?.edgeExits || []).length) continue;
      // Skip if the destination already declares its own way back to us: a real
      // exit always beats an inferred one.
      const declared = (map.rooms[e.to]?.edgeExits || []).some(x => x.to === r.num);
      if (declared) continue;
      // A reverse is only actionable where the destination room's own BSP has a
      // real crossing in that direction. This excludes sealed authored bounds
      // before route search can repeatedly choose them.
      if (map.rooms[e.to]?.roo &&
          !topologyProvesEdgeCandidate(map.rooms[e.to], LEAVE_NAME[back]) &&
          !edgeCandidatesOf(map.rooms[e.to], LEAVE_NAME[back]).length) continue;
      if (!rev.has(e.to)) rev.set(e.to, []);
      if (!rev.get(e.to).some(x => x.to === r.num))
        rev.get(e.to).push({ kind: 'edge', to: r.num, direction: LEAVE_NAME[back],
                             leave: back, inferred: true,
                             how: `walk ${LEAVE_NAME[back]} past the room edge ` +
                                  `(inferred: ${r.name} declares ${LEAVE_NAME[e.leave]} into here)` });
    }
  }
  Object.defineProperty(map, '__reverse', { value: rev, enumerable: false });
  return rev;
}

export function inferredExits(map, roomNum) {
  // READ the reverse table; build it ONCE if it is missing (the standalone/test case where
  // nothing called buildReverseEdges at startup). The table is stable for the life of the
  // map, so a per-call rebuild (the old behaviour) re-paid ~13s of edge work on every
  // inferredExits call — which is exactly the 13s stall that hit the first room the router
  // ever expanded. buildReverseEdges is idempotent and no-ops when map.__reverse exists.
  if (!map.__reverse) buildReverseEdges(map);
  return (map.__reverse.get(roomNum) || []).filter(x => !badInferred.has(roomNum + '->' + x.to));
}

// A room class can override SomethingMoved and hand you to a neighbour when you walk
// into a region of the floor. Marion's only two ways out are written that way, which
// is why the town read as sealed from every data source. These are real exits and
// the router must know about them.
export function codeExits(roomNum) {
  const idx = loadCodeExits(CODE_EXITS_FILE);
  const list = idx?.rooms?.[roomNum];
  if (!list) return [];
  return list.map(e => ({
    kind: 'region', to: e.to, when: e.when, arrive: e.arrive,
    how: 'walk into the part of this room where ' +
         e.when.map(c => `${c.axis} ${c.op} ${c.value}`).join(' and ') +
         ' — the room moves you across by itself, there is nothing to press',
  }));
}

// ROOMS TO WALK AROUND WHEN THERE IS ANY OTHER WAY, MEASURED RATHER THAN GUESSED.
//
// Deep Woods of Ileria is not the deadliest room because the fleet hunts there. Of the
// fleet's 24 recorded deaths, 8 are in 534 — and SIX OF THOSE EIGHT happened with the
// keeper `travelling`, against eight travelling deaths in the whole world. So three
// quarters of every death this fleet has suffered in transit happened in one room, which
// is the room every route between the hunting grounds and town happens to cross.
//
// It is a corridor, not a destination: Piggy walked into it at 42 of 43 health and was
// dead four samples later, with FOUR living trees and two spiders on her and ten threats
// counted at once. Nothing about that is a hunting decision — she was passing through on
// the way somewhere else, and the room she was passing through chose the fight.
//
// Checked before adding it: 534 is NOT a cut vertex. Valley -> bread shop, Source of the
// Ille -> bread shop and Valley -> Jasper bank all still connect with it removed, so
// avoiding it costs hops rather than reachability.
export const AVOID_IN_TRANSIT = new Set([534]);

// ROOMS THAT KILL BY A RULE, NOT BY A FIGHT — AND THE BLOCK ON THEM IS NOT NEGOTIABLE.
//
// `AVOID_IN_TRANSIT` is a PREFERENCE: findPath tries to route around 534 and, if there is
// no other way, goes through it anyway. That is right for a room that is merely dangerous
// — a corridor full of monsters is survivable, and refusing to cross it would strand a
// character. It is exactly wrong for a room whose hazard is arithmetic.
//
// 555, The Forest Shrine, is a gas-field puzzle. `OutdoorsE5.PunishPlayer` (e5.kod:452)
// charges `GetBaseMaxHealth / 3` as ATCK_SPELL_ACID for every step onto a wrong square,
// and when that reduction kills you it calls `@killed` outright — "The acid steam melts
// the flesh from your bones." Three bad steps kill anything in this fleet from full
// health, and NOTHING ABOUT THE ROOM IS VISIBLE TO A ROUTER: the safe row is chosen at
// random by `InitPuzzle`, it MOVES as you cross, and the only way to learn it is to ask
// the NPC (LadyPheonix) for protection and be told, one row at a time. A bot that has not
// been taught the protocol is not taking a risk in there; it is walking a fixed number of
// steps to its death. Statler died in it this session, in transit.
//
// So these are removed from the graph on EVERY pass, including the permissive fallback
// that exists so a route is always found. "No route" is the correct answer here — an
// errand that cannot be done without crossing a death room is an errand that should fail
// and say so, loudly, rather than succeed at the cost of a character.
//
// Two exceptions, both narrow and both necessary:
//   - THE ORIGIN IS NEVER BLOCKED. A character that is somehow standing in one must be
//     able to walk out, and that is the one moment routing through it is the whole point.
//   - THE DESTINATION IS BLOCKED UNLESS SOMEBODY ASKS FOR IT BY NAME, via
//     `allowHazardDestination`. An operator sending a character there deliberately is a
//     decision a person can make; a keeper choosing it while roaming is not, and the
//     keeper never passes the flag. This is the "are you sure?" that defaults to no.
export const NEVER_ENTER = new Map([
  [555, 'The Forest Shrine — acid gas puzzle, kills outright (e5.kod:452 PunishPlayer); ' +
        'the safe row is random and moves, and is only learnable by asking LadyPheonix'],
]);
export const hazardReason = (room) => NEVER_ENTER.get(Number(room)) ?? null;

// EVERY ROOM WITHIN `radius` HOPS, the destination itself first. Farm delivery reads this
// to answer "who is near enough to be worth walking to", which one room number cannot.
//
// It walks the same three exit sources `bfsPath` does — declared, inferred and code — so a
// room the router can reach is a room this reports, and the two cannot drift into
// disagreeing about what "next door" means. `avoid` is honoured for rooms passed THROUGH,
// never for the origin, exactly as the router does it.
//
// The result is hop counts, not a bare set: a courier with cargo for two rooms should
// serve the nearer one first, and that ordering is the difference between one short walk
// and crossing the destination twice. Note the caveat this repository has learned the hard
// way — an edge from A to B does not put you where the edge back to A starts — so a hop
// count is a routing estimate and never a promise about walking distance.
export function roomsWithin(map, fromNum, radius = 2, { avoid = AVOID_IN_TRANSIT } = {}) {
  const out = new Map([[Number(fromNum), 0]]);
  if (!(radius > 0)) return out;
  let frontier = [Number(fromNum)];
  for (let depth = 1; depth <= radius && frontier.length; depth++) {
    const next = [];
    for (const at of frontier) {
      const room = map.rooms[at];
      if (!room) continue;
      for (const ex of [...exitsOf(room), ...inferredExits(map, at), ...codeExits(at)]) {
        if (ex.to == null || out.has(ex.to)) continue;
        if (avoid && avoid.has(ex.to) && ex.to !== Number(fromNum)) continue;
        out.set(ex.to, depth);
        next.push(ex.to);
      }
    }
    frontier = next;
  }
  return out;
}

// The search itself. Unchanged except that it can be told to pretend some rooms are not
// there — `avoid` is consulted for rooms we would PASS THROUGH, never for where we are or
// where we are going.
// bfsPath cache. The room graph is static (264 rooms, fixed exits), so a BFS from
// (fromNum, toNum) with a given avoid-set has the SAME answer every time it is called.
// The first call is ~13s (it walks a large fraction of the graph and builds each visited
// room's passable-exit list), and it was re-paid on the second call for the same pair
// (tick 1 and tick 2 both cost 13s). Caching by (from, to, avoid) makes every repeat
// call instant. The graph never changes within a process (the .map is loaded once and
// never mutated), so the cache is safe for the life of the process. Bounded: the number
// of distinct (from, to, avoid) pairs the fleet actually routes is small (a few hundred),
// well under the cap.
const _bfsPathCacheCap = 2000;
function _bfsPathCacheFor(map) {
  if (!weakKey(map)) return null;
  let cache = bfsPathCacheByMap.get(map);
  if (!cache) {
    cache = new Map();
    bfsPathCacheByMap.set(map, cache);
  }
  return cache;
}
function _bfsCacheKey(fromNum, toNum, avoid) {
  // The default avoid set (AVOID_IN_TRANSIT) and "no avoid" are the only ones the router
  // uses in practice. Encode the avoid set as a sorted join of its room numbers so any
  // set of rooms is stably keyed; null when there is no avoid.
  const av = avoid && avoid.size ? [...avoid].sort((a, b) => a - b).join(',') : '';
  return `${fromNum}>${toNum}|${av}`;
}
function bfsPath(map, fromNum, toNum, avoid, transitOk = null, blockedHops = null,
                 crossCost = null, availableFirstHops = null) {
  // Cache only the plain form. `transitOk` and `crossCost` are FUNCTIONS: two
  // callers can pass different predicates that are textually identical, so they
  // cannot be keyed, and a wrong hit here would be a route through a room the
  // caller had just forbidden. Those calls skip the cache entirely.
  const _cacheable = !transitOk && !crossCost && !blockedHops && !availableFirstHops;
  const _key = _cacheable ? _bfsCacheKey(fromNum, toNum, avoid) : null;
  const _cache = _key ? _bfsPathCacheFor(map) : null;
  if (_cache) { const hit = _cache.get(_key); if (hit) return hit; }
  // WITH A TRANSIT PREDICATE THE STATE IS (ROOM, DOOR YOU CAME IN BY), NOT THE ROOM.
  //
  // Whether you can cross a room depends on which side you entered it from, so keying
  // `seen` on the room alone would let the first arrival at R close it off for every other
  // approach — including the one that could have crossed. That turns a constraint meant to
  // remove impossible routes into one that removes possible ones.
  const key = transitOk ? (from, at) => `${from}>${at}` : (_from, at) => String(at);
  const seen = new Set([key(null, fromNum)]);
  const q = [[fromNum, [], null]];
  // WHAT A ROUTE COSTS ON THE GROUND, summed over the rooms it crosses. `null` from the
  // callback means "the table cannot say", which must not read as free — an unbaked room
  // would otherwise win every tie by being unmeasured. Half the room's longer side is the
  // honest stand-in: it is what a crossing of an ordinary room costs.
  const routeCost = (hops) => {
    if (!crossCost) return 0;
    let total = 0;
    for (let i = 0; i < hops.length; i++) {
      const at = hops[i].from, cameFrom = i === 0 ? null : hops[i - 1].from;
      if (cameFrom == null) continue;              // the first room is entered from nowhere
      const c = crossCost(at, cameFrom, hops[i].to);
      if (Number.isFinite(c)) { total += c; continue; }
      const r = map.rooms[at];
      total += Math.round(Math.max(Number(r?.rows) || 0, Number(r?.cols) || 0) / 2) || 30;
    }
    return total;
  };
  let best = null, bestDepth = Infinity;
  const pick = (a, b) => {
    if (!a) return b;
    if (b.length !== a.length) return b.length < a.length ? b : a;
    return routeCost(b) < routeCost(a) ? b : a;
  };
  while (q.length) {
    const [at, sofar, cameFrom] = q.shift();
    // Everything at this depth has been considered, and nothing deeper can be shorter.
    if (best && sofar.length >= bestDepth) break;
    const room = map.rooms[at];
    if (!room) continue;
    for (const ex of passableExits(map, at)) {
      if (ex.to == null) continue;
      // THE FIRST STEP HAS TO BE SOMETHING THE EXECUTOR CAN ACTUALLY SEE.
      //
      // This is deliberately keyed on path depth rather than `at === fromNum`. With a
      // transit predicate the search state includes the door we arrived through, so a
      // legitimate route may revisit the origin later by a different door. The live exit
      // list describes only the character's position NOW; it must constrain expansion zero
      // and must not turn that room into a permanent graph-wide restriction.
      //
      // `null` means the caller has no authoritative live answer. An empty Set is the
      // authoritative answer that no executable first hop was offered.
      if (sofar.length === 0 && availableFirstHops !== null
          && !availableFirstHops.has(Number(ex.to))) continue;
      if (blockedHops?.has(`${at}>${ex.to}`)) continue;
      // Can this room be walked from the door we arrived by to the one we want? Only
      // an explicit FALSE refuses: no table, no anchors, no answer all mean "carry on".
      if (transitOk && cameFrom != null && transitOk(at, cameFrom, ex.to) === false) continue;
      const k = key(at, ex.to);
      if (seen.has(k)) continue;
      const hop = { from: at, fromName: room.name, to: ex.to,
                    toName: map.rooms[ex.to]?.name || `room ${ex.to}`, ...ex };
      const next = [...sofar, hop];
      if (ex.to === toNum) {
        // SAME NUMBER OF ROOMS IS NOT THE SAME JOURNEY.
        //
        // `findPath` counts ROOMS, so two routes of equal length are indistinguishable to it
        // and it returns whichever exit order happened to reach the destination first. On the
        // ground they are not equal at all: crossing a room is tens of squares of walking, and
        // the baked table already knows how many for every exit pair.
        //
        // Tos to Castle Victoria is the worked example. Both ways are seven rooms:
        //
        //   via the Main gate     587 Western border  65 steps    total 310
        //   via East Ende         596 Outskirts       55 steps    total 298
        //
        // The second is shorter on every leg where they differ — a smaller room AND a shorter
        // walk — and it also avoids the one room on this road whose east edge carries two
        // exits. The router had no way to prefer it and picked the other by accident.
        //
        // So the first arrival no longer wins outright: the rest of ITS OWN DEPTH is drained
        // and the cheapest route of that depth is returned. Depth still dominates — this can
        // never return a longer route — and with no cost function it behaves exactly as it
        // did, because every candidate then scores zero.
        best = pick(best, next);
        bestDepth = next.length;
        continue;
      }
      seen.add(k);
      if (avoid?.has(ex.to)) continue;         // reachable, just not walked THROUGH
      q.push([ex.to, next, at]);
    }
  }
  // STORE ON BOTH PATHS. A "no route" is as stable an answer as a route for a static
  // graph, and not caching it was how a repeated impossible query re-paid the whole
  // search every time it was asked.
  if (best) {
    const _hit = immutableRouteCopy({ found: true, hops: best, walk_cost: routeCost(best) });
    if (_cache) { if (_cache.size >= _bfsPathCacheCap) _cache.clear();
                  _cache.set(_key, _hit); }
    return _hit;
  }
  const _miss = immutableRouteCopy({
    found: false, hops: [], reason: `no route from ${fromNum} to ${toNum} in the graph`,
  });
  if (_cache) { if (_cache.size >= _bfsPathCacheCap) _cache.clear();
                _cache.set(_key, _miss); }
  return _miss;
}

// HOW DANGEROUS EACH ROOM IS TO WALK THROUGH, FROM THE SPAWN TABLE.
//
// A ROUTE IS AS DANGEROUS AS ITS WORST ROOM, so this is the MAXIMUM attack rating a room
// can generate and never an average. Averaging is the tempting mistake and it is wrong in
// the fatal direction: a corridor of six harmless rooms and one narthyl worm room averages
// to something mild, and the fleet dies in the one room.
//
// Attack rating rather than level, for the reason CLAUDE.md gives at length: level is what
// a blow costs and difficulty is how often one lands, so a level-50 fungus beast at 210 is
// a safer room than a level-30 centipede at 390. `GetAttackAbility = 3*viLevel +
// 60*viDifficulty` is the number that actually describes danger.
//
// Only `huntable` generators count. A room's placed-once residents — a blacksmith, a
// statue — are not what makes a corridor lethal, and counting them would rate every shop
// in the game as hostile.
const SPAWNS_FILE = process.env.M59_SPAWNS ||
  path.join(path.dirname(fileURLToPath(import.meta.url)),
            '..', 'substrate', 'm59-spawns.json');

let dangerCache = null;
export function roomDanger({ refresh = false } = {}) {
  if (dangerCache && !refresh) return dangerCache;
  const danger = new Map();
  try {
    const spawns = JSON.parse(fs.readFileSync(SPAWNS_FILE, 'utf8'));
    for (const [num, list] of Object.entries(spawns.rooms ?? {})) {
      const worst = (list ?? [])
        .filter(x => x?.huntable && Number.isFinite(Number(x.attack_rating)))
        .reduce((max, x) => Math.max(max, Number(x.attack_rating)), 0);
      if (worst > 0) danger.set(Number(num), worst);
    }
  } catch { /* no spawn table is "nothing is known", which routes exactly as it used to */ }
  dangerCache = danger;
  return danger;
}

// A room nothing is known about rates 0 — NOT "unknown, therefore avoid". Most of the
// world's rooms generate nothing and are the safe ones; treating silence as hazardous
// would make every town square look like a battlefield and route around all of them.
// A ROOM WHOSE GEOMETRY MOVES IS HARDER TO WALK RELIABLY, WHICH IS A DIFFERENT AXIS FROM
// WHAT LIVES IN IT — AND IT IS PRICED HERE ANYWAY, DELIBERATELY.
//
// Keeping it separate would mean a second bottleneck search and a second budget, for a
// preference the operator described in one sentence: never route over those spots unless
// you have to. That is exactly what a small addition to this number already expresses, and
// it inherits the property that matters — `findPath` walks through a soft hazard when there
// is no other way, which is required here, because the only road to Castle Victoria runs
// through the Cragged Mountains and there is no alternative at all.
//
// It is small (120 against room ratings of 390-750) so it can break a tie and cannot buy a
// detour of its own; the proportionate-detour rule above then prices any wandering it does
// suggest. See m59-mutable.mjs for the list, the citations and the failure direction.
const dangerOf = (danger, room) => (danger.get(Number(room)) ?? 0)
  + (isMutableGeometry(room) ? MUTABLE_TRANSIT_PENALTY : 0);

// HOW FAR OUT OF ITS WAY A CHARACTER MAY GO TO AVOID A ROOM.
//
// A detour is not free, and this is the whole reason the safer path is bounded rather than
// simply preferred: EVERY EXTRA ROOM IS ANOTHER ROOM THAT CAN CHOOSE A FIGHT. That is what
// the 534 note below is about — the deaths were in a corridor nobody meant to fight in —
// so a route that crosses nine mild rooms instead of three has traded one known hazard for
// six new chances at an unknown one. Doubling plus two hops is generous enough to walk
// around a bad room or a bad pair, and tight enough that nothing crosses the world twice.
/**
 * WHAT A ROUTE COSTS ON THE GROUND, summed over the rooms it crosses.
 *
 * `null` from the callback means the table cannot say, which must not read as free — an
 * unbaked room would otherwise win every tie by being unmeasured. Half the room's longer
 * side stands in: it is roughly what crossing an ordinary room costs.
 */
function walkOf(map, hops, crossCost) {
  let total = 0;
  for (let i = 1; i < hops.length; i++) {
    const at = hops[i].from, cameFrom = hops[i - 1].from;
    const c = crossCost(at, cameFrom, hops[i].to);
    if (Number.isFinite(c)) { total += c; continue; }
    const r = map.rooms[at];
    total += Math.round(Math.max(Number(r?.rows) || 0, Number(r?.cols) || 0) / 2) || 30;
  }
  return total;
}

const DETOUR_FACTOR = 2;
const DETOUR_SLACK = 2;

/**
 * The least-dangerous route, where "least dangerous" means the lowest worst room on it.
 *
 * This is a bottleneck (minimax) search rather than a sum-of-weights one, because danger
 * does not add up along a path — walking through two rooms rated 300 is not worse than
 * walking through one rated 700. Ties on the bottleneck are broken by hop count, so the
 * answer is the SHORTEST of the SAFEST routes.
 *
 * `avoid` stays a hard exclusion on top, because it is a measured fact about specific
 * rooms that the spawn table cannot express: 534 is deadly in transit because of how many
 * things gang up in it, not because its worst single generator is remarkable.
 */
function safestPath(map, fromNum, toNum, avoid, danger, budget, transitOk = null,
                    blockedHops = null, crossCost = null, availableFirstHops = null) {
  // Dijkstra on (worst room so far, hops). The frontier is small enough — the whole world
  // is a few hundred rooms — that a sorted insert beats a heap in both speed and reading.
  // Same keying argument as bfsPath: with a transit predicate the state carries the door
  // we came in by, because that is what decides whether the room can be crossed at all.
  const key = transitOk ? (from, at) => `${from}>${at}` : (_from, at) => String(at);
  const best = new Map([[key(null, fromNum), { worst: 0, hops: 0 }]]);
  const queue = [{ at: fromNum, worst: 0, hops: 0, path: [], cameFrom: null }];
  let answer = null;
  while (queue.length) {
    queue.sort((a, b) => a.worst - b.worst || a.hops - b.hops);
    const cur = queue.shift();
    // Once a complete answer exists, anything whose bottleneck is already worse than it
    // cannot improve on it — and neither can anything longer than the detour budget.
    if (answer && (cur.worst > answer.worst ||
        (cur.worst === answer.worst && cur.hops >= answer.hops))) continue;
    if (budget != null && cur.hops > budget) continue;
    const room = map.rooms[cur.at];
    if (!room) continue;
    for (const ex of passableExits(map, cur.at)) {
      if (ex.to == null) continue;
      // Same depth-zero rule as bfsPath. A later re-entry to the origin is a graph state,
      // not the live position from which `availableFirstHops` was observed.
      if (cur.path.length === 0 && availableFirstHops !== null
          && !availableFirstHops.has(Number(ex.to))) continue;
      if (blockedHops?.has(`${cur.at}>${ex.to}`)) continue;
      // Only an explicit FALSE refuses — see bfsPath.
      if (transitOk && cur.cameFrom != null
          && transitOk(cur.at, cur.cameFrom, ex.to) === false) continue;
      const hop = { from: cur.at, fromName: room.name, to: ex.to,
                    toName: map.rooms[ex.to]?.name || `room ${ex.to}`, ...ex };
      const path = [...cur.path, hop];
      if (ex.to === toNum) {
        // THE ARRIVING HOP COUNTS AGAINST THE BUDGET TOO. Checking only `cur.hops` lets a
        // route one hop over the limit through, because the last step is taken here rather
        // than by the loop below — which made a seven-hop detour pass a budget of six.
        if (budget != null && path.length > budget) continue;
        // The destination's own danger is not counted: a character sent to a hunting room
        // is meant to be in it, and counting it would make every route to a good farm look
        // like a bad route.
        // AND WHEN THE DANGER AND THE ROOM COUNT BOTH TIE, THE SHORTER WALK WINS.
        //
        // Ranking was (worst room, hops) and stopped there, so two equally safe routes of
        // equal length were settled by whichever exit order arrived first. On the ground they
        // are not equal: crossing a room is tens of squares, and the baked table knows how
        // many. Tos to Castle Victoria is seven rooms either way — 310 baked steps by the
        // Western border of the Twisted Wood, 298 by the Outskirts of Tos — and the planner
        // took the longer one by accident.
        //
        // Third in the order, never first: a shorter walk may not buy a more dangerous room
        // or a longer route, which is what keeps this from quietly undoing the bottleneck
        // search above.
        const cheaper = () => {
          if (!crossCost || !answer) return false;
          return walkOf(map, path, crossCost) < walkOf(map, answer.path, crossCost);
        };
        if (!answer || cur.worst < answer.worst ||
            (cur.worst === answer.worst && path.length < answer.hops) ||
            (cur.worst === answer.worst && path.length === answer.hops && cheaper()))
          answer = { worst: cur.worst, hops: path.length, path };
        continue;
      }
      if (avoid?.has(ex.to)) continue;
      const worst = Math.max(cur.worst, dangerOf(danger, ex.to));
      const k = key(cur.at, ex.to);
      const seen = best.get(k);
      if (seen && (seen.worst < worst || (seen.worst === worst && seen.hops <= path.length)))
        continue;
      best.set(k, { worst, hops: path.length });
      queue.push({ at: ex.to, worst, hops: path.length, path, cameFrom: cur.at });
    }
  }
  return answer
    ? { found: true, hops: answer.path, worst_rating: answer.worst }
    : { found: false, hops: [], reason: `no route from ${fromNum} to ${toNum} in the graph` };
}

// TRY THE SAFER WAY FIRST, THEN THE ONLY WAY.
//
// Two passes rather than edge weights, deliberately. A weighted search is the textbook
// answer and it changes the route for every pair in the world at once; this changes a
// route only when a hazard-free one exists, and falls back to exactly the path it would
// have returned before. So the worst case is today's behaviour, which is the property
// worth having in the most load-bearing function in the repository.
function _findPathImpl(map, fromNum, toNum,
                         { avoid = AVOID_IN_TRANSIT, danger = true,
                           allowHazardDestination = false,
                           // CAN THIS ROOM BE WALKED FROM THE DOOR I CAME IN BY TO THE ONE
                           // I WANT? `(room, cameFrom, goingTo) => boolean|null`.
                           //
                           // This function has always planned over ROOMS, which assumes a
                           // room can be crossed between any two of its doors. Frequently it
                           // cannot: the Cragged Mountains basin reaches exactly one of its
                           // five exits on foot, and West Merchant Way is the same shape
                           // inverted — you enter from Marion at the TOP, walk down, and
                           // cannot climb back, with no blink route out either. The
                           // operator's words: "some exits aren't reachable from others".
                           //
                           // A route that ignores that is not merely long, it is a plan to
                           // walk a character into a hole. The regions this needs are
                           // already baked per anchor in substrate/m59-routes.json.
                           transitOk = null,
                           // ONE DIRECTED EDGE, NOT A ROOM. `avoid` cannot say "not from
                           // here to there": it excludes rooms, and it deliberately never
                           // excludes the destination — so a caller standing in a room
                           // whose door to the TARGET cannot be walked to had no way to ask
                           // for the long way round. Strings of the form `from>to`.
                           blockedHops = null,
                           // HOW MANY SQUARES IT IS ACROSS A ROOM, from the door you came in
                           // by to the one you want: `(room, cameFrom, goingTo) => steps|null`.
                           // Used only to break ties between routes of the SAME room count,
                           // so it can never lengthen a journey. `null` means the table cannot
                           // say and is charged a plain crossing rather than nothing.
                           crossCost = null,
                           // DESTINATIONS THE LIVE EXECUTOR ACTUALLY OFFERS FROM THE ORIGIN.
                           // This is harder evidence than a permissive graph fallback: a raw
                           // exit absent from an authoritative `exits()` result cannot be
                           // executed at all. It constrains expansion zero only. `null` means
                           // no authoritative answer; an empty Set means there is no
                           // executable first hop.
                           //
                           // NOT THE SAME KIND OF THING AS `blockedHops`, WHICH IS WHY THE
                           // TWO-PASS BELOW DROPS ONE AND KEEPS THE OTHER. A blocked hop is a
                           // preference: the permissive pass gives it up rather than refuse a
                           // journey outright. An absent first hop is not a preference — it is
                           // the absence of any action the executor could take.
                           availableFirstHops = null,
                           // internal: the strict half of the two-pass below
                           strictTransit = false } = {}) {
  if (fromNum === toNum) return { found: true, hops: [] };

  // TWO PASSES, AND THE SECOND IS EXACTLY WHAT THIS FUNCTION DID BEFORE.
  //
  // The transit view is a MODEL of somebody else's server and it is stricter than the
  // world — the same argument the step mask carries, and the same failure if inverted: a
  // bake must never be the reason a journey becomes impossible. So a route that only
  // exists through a transit the table dislikes is still returned, flagged
  // `transit_unverified`, rather than refused. Being wrong about a crossing costs a walk;
  // refusing costs the errand, silently.
  if ((transitOk || blockedHops?.size) && !strictTransit) {
    const strict = findPath(map, fromNum, toNum,
      { avoid, danger, allowHazardDestination, transitOk, blockedHops, crossCost,
        availableFirstHops, strictTransit: true });
    if (strict.found) return { ...strict, transit_checked: true };
    const loose = findPath(map, fromNum, toNum,
      { avoid, danger, allowHazardDestination, transitOk: null, blockedHops: null,
        crossCost, availableFirstHops });
    return loose.found ? { ...loose, transit_unverified: true } : loose;
  }
  const crossing = strictTransit ? transitOk : null;
  const blocked = strictTransit ? blockedHops : null;

  // THE HARD BLOCK, APPLIED BEFORE ANYTHING ELSE AND NEVER RELAXED. See NEVER_ENTER: the
  // permissive fallback at the bottom of this function is what makes `avoid` a preference,
  // and a preference is not what a room that kills by arithmetic needs.
  if (!allowHazardDestination && hazardReason(toNum))
    return { found: false, hops: [], hazard: Number(toNum),
             reason: `refusing to route to ${toNum}: ${hazardReason(toNum)}` };
  const forbidden = new Set([...NEVER_ENTER.keys()].filter(r => r !== Number(fromNum) &&
                                                                r !== Number(toNum)));

  // Never avoid where we are or where we are going: a character standing IN a hazard has
  // to be able to leave it, and one sent to it has to be able to arrive.
  const soft = avoid && avoid.size
    ? [...avoid].filter(r => r !== fromNum && r !== toNum) : [];
  const skip = (soft.length || forbidden.size) ? new Set([...soft, ...forbidden]) : null;

  // THE ORDER HERE IS THE SAFETY ARGUMENT, and it is the same one the two-pass version
  // made: every step down this list is strictly more permissive than the one above, and
  // the last of them is exactly what this function returned before danger existed. So the
  // worst case is unchanged behaviour, which is the property worth having in the most
  // load-bearing function in the repository.
  //
  // The shortest route is computed first only to price the detour — a bottleneck search
  // with no length bound will happily cross the world to shave one rating point, and the
  // rooms it crosses to do it are rooms that can each choose a fight.
  if (danger !== false) {
    const table = danger instanceof Map ? danger : roomDanger();
    if (table.size) {
      const shortest = bfsPath(map, fromNum, toNum, skip?.size ? skip : null,
                               crossing, blocked, crossCost, availableFirstHops);
      if (shortest.found) {
        const budget = shortest.hops.length * DETOUR_FACTOR + DETOUR_SLACK;
        const safest = safestPath(map, fromNum, toNum, skip, table, budget,
                                  crossing, blocked, crossCost, availableFirstHops);
        // A DETOUR HAS TO BE WORTH WHAT IT COSTS, AND THE BOTTLENECK SEARCH CANNOT SEE THE
        // COST AT ALL.
        //
        // `safestPath` minimises the worst room and breaks ties on hops, so ANY improvement
        // in the bottleneck — one rating point — buys the whole budget, which is twice the
        // shortest route plus two. That is not a hypothetical: measured across 870 routable
        // pairs of the rooms this fleet travels between, 37% take a danger detour and they
        // cost 704 extra hops between them, a mean of +2.19 rooms each.
        //
        // The fleet's main road is the case that shows why it matters. The Flatlands to Tos
        // is THREE hops — 584 -> 585 -> 586 -> 50 — and the router was returning SEVEN, out
        // through Main gate to Cor Noth, Cor Noth, both halves of The King's Way and the
        // Western border of the Twisted Wood, to drop the worst room from 750 to 510. It
        // bought a 32% reduction in the worst SINGLE generator for 2.3x the rooms: 27
        // seconds of optimal walking became 76.
        //
        // And an extra room is not free danger-wise either, which is the part the minimax
        // misses. Every additional room is another floor to cross, another doorway to fumble
        // at, and everything living in it — the CLAUDE.md note on 534 says exactly this
        // about a room that is deadly "because of how many things gang up in it, not because
        // its worst single generator is remarkable". The seven-hop detour above runs through
        // 587, where 19 of 85 prod deaths happened in eight hours and where a naked runner
        // was measured taking five minutes to cross a room it walks in forty seconds when
        // nothing is in the way.
        //
        // So the length of a detour must be PROPORTIONATE to the danger it actually removes.
        // A route that halves the bottleneck may be half again as long; one that shaves a
        // few points may not wander at all. A reduction of ~1 (avoiding something lethal for
        // something harmless) still gets the old doubling, which is the case the budget was
        // written for.
        if (safest.found) {
          const worstOf = hops => hops.reduce((max, h) => Math.max(max, dangerOf(table, h.to)),
                                              dangerOf(table, fromNum));
          const worstShort = worstOf(shortest.hops), worstSafe = worstOf(safest.hops);
          const bought = worstShort > 0 ? (worstShort - worstSafe) / worstShort : 0;
          const extra = safest.hops.length - shortest.hops.length;
          // At least one hop is always allowed, so a one-room sidestep around something
          // genuinely worse is never refused on arithmetic.
          const allowed = Math.max(1, Math.ceil(shortest.hops.length * bought));
          if (extra > allowed) return { ...shortest,
            walk_cost: crossCost ? walkOf(map, shortest.hops, crossCost) : undefined,
            shortest_hops: shortest.hops.length, detoured: false,
            detour_declined: { extra_hops: extra, allowed, worst_taken: worstShort,
                               worst_avoided: worstSafe,
                               why: `a ${extra}-hop detour to reduce the worst room by ` +
                                    `${Math.round(bought * 100)}% is not proportionate` } };
          return { ...safest,
            walk_cost: crossCost ? walkOf(map, safest.hops, crossCost) : undefined,
            shortest_hops: shortest.hops.length,
            detoured: safest.hops.length > shortest.hops.length };
        }
        return shortest;
      }
    }
  }

  if (skip?.size) {
    const safer = bfsPath(map, fromNum, toNum, skip, crossing, blocked,
                          crossCost, availableFirstHops);
    if (safer.found) return safer;
  }
  // THE LAST RESORT STILL HONOURS THE HARD BLOCK. This line used to pass `null`, which is
  // what made every avoid a preference — and it is the line Statler's route came down.
  // A soft hazard is dropped here; a NEVER_ENTER room is not, so a journey that needs one
  // comes back `found: false` and names the room rather than walking a character into it.
  const last = bfsPath(map, fromNum, toNum, forbidden.size ? forbidden : null,
                       crossing, blocked, crossCost, availableFirstHops);
  if (!last.found && forbidden.size)
    return { ...last, blocked_by_hazard: [...forbidden],
             reason: `${last.reason} without crossing ${[...forbidden]
               .map(r => `${r} (${hazardReason(r)})`).join('; ')}` };
  return last;
}

// SLOW-CALL CANARY around the load-bearing route search. The first findPath per process
// was the cold-start stall we hunted for days; this line makes a regression visible in
// the keeper log the moment it reappears (anything over 1s is a stall worth a look).
export function findPath(map, fromNum, toNum, opts) {
  const t0 = Date.now();
  try {
    return _findPathImpl(map, fromNum, toNum, opts);
  } finally {
    const ms = Date.now() - t0;
    if (ms > 1000) console.error(`[slow-findpath] ${fromNum}->${toNum} took ${ms}ms`);
  }
}

// Name or number in, room number out. Agents think in names.
export function resolveRoom(map, needle) {
  if (needle === undefined || needle === null) return null;
  const s = String(needle).trim();
  if (/^\d+$/.test(s) && map.rooms[s]) return Number(s);
  const low = s.toLowerCase();
  const all = Object.values(map.rooms);
  const exact = all.find(r => r.name.toLowerCase() === low);
  if (exact) return exact.num;
  const partial = all.filter(r => r.name.toLowerCase().includes(low) || r.cls.toLowerCase().includes(low));
  if (partial.length === 1) return partial[0].num;
  if (partial.length > 1) {
    const err = new Error(`"${s}" matches ${partial.length} rooms: ` +
      partial.slice(0, 8).map(r => `${r.name} (${r.num})`).join(', '));
    err.ambiguous = partial.map(r => ({ num: r.num, name: r.name }));
    throw err;
  }
  return null;
}

// ------------------------------------------------------------------ cli

if (import.meta.filename === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'build') {
    console.log('walking the server over the admin socket...');
    const map = await build();
    writeMapAtomic(OUTPUT_MAP_FILE, map);
    const rooms = Object.values(map.rooms);
    const edges = rooms.reduce((n, r) => n + exitsOf(r).filter(e => e.to != null).length, 0);
    console.log(`\nwrote ${OUTPUT_MAP_FILE}`);
    console.log(`${rooms.length} rooms, ${edges} directed exits`);
    console.log(`${rooms.filter(r => !r.edgeExits.length && !r.goExits.length).length} rooms with no exits at all`);
    console.log(`${rooms.reduce((n, r) => n + r.goExits.filter(g => g.locked).length, 0)} locked doors`);
    // A destination that is not itself a room in the graph means the scan range
    // missed something, which would silently truncate every route through it.
    const nums = new Set(rooms.map(r => r.num));
    const dangling = new Set();
    for (const r of rooms) for (const e of exitsOf(r)) if (e.to != null && !nums.has(e.to)) dangling.add(e.to);
    console.log(dangling.size
      ? `WARNING: ${dangling.size} exits point at rooms not in the graph: ${[...dangling].slice(0, 20).join(', ')}\n` +
        `  widen the scan range: node tools/m59-map.mjs build <maxObjectId>`
      : 'every exit destination is present in the graph');
    process.exit(0);
  }

  // Re-bake only the .roo payload without touching room ids, exits, names, or the
  // admin socket. This is the safe upgrade path when the geometry schema changes.
  if (cmd === 'refresh-geometry') {
    // A setup-specific M59_MAP starts from the committed room graph, then receives
    // collision bytes from the exact source tree the local server was built from.
    const map = loadMap(geometryRefreshBaseFile(OUTPUT_MAP_FILE));
    // An explicit directory is an authority, not just the first search hint. Mixing
    // server and Steam/client ROOs can produce a map whose provenance label is false.
    const exclusiveDir = process.env.M59_ROO_DIR ? path.resolve(process.env.M59_ROO_DIR) : null;
    const dirs = roomResourceDirs();
    const { baked, missing, sources } = bakeRoomGeometry(map.rooms, { dirs });
    if (exclusiveDir) {
      const outside = sources.filter(source => {
        const relative = path.relative(exclusiveDir, path.resolve(source));
        return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
      });
      if (outside.length) missing.push(`room resources escaped authoritative directory ${exclusiveDir}`);
    }
    if (missing.length) {
      console.error(`could not load ${missing.length} room file(s): ${missing.slice(0, 8).join(', ')}`);
      process.exit(1);
    }
    setGeometryProvenance(map, OUTPUT_MAP_FILE, { sourceDir: exclusiveDir });
    Object.assign(map, geometryManifest(map.rooms));
    writeMapAtomic(OUTPUT_MAP_FILE, map);
    console.log(`refreshed collision geometry for ${baked}/${Object.keys(map.rooms).length} rooms`);
    console.log(`wrote ${OUTPUT_MAP_FILE}`);
    process.exit(0);
  }

  const map = loadMap();

  if (cmd === 'path') {
    const a = resolveRoom(map, rest[0]), b = resolveRoom(map, rest.slice(1).join(' '));
    if (a == null) { console.error(`unknown room "${rest[0]}"`); process.exit(1); }
    if (b == null) { console.error(`unknown room "${rest.slice(1).join(' ')}"`); process.exit(1); }
    const r = findPath(map, a, b);
    if (!r.found) { console.log(r.reason); process.exit(1); }
    console.log(`${map.rooms[a].name} (${a}) -> ${map.rooms[b].name} (${b}): ${r.hops.length} hop(s)`);
    for (const h of r.hops) console.log(`  ${h.how.padEnd(44)} -> ${h.toName} (${h.to})`);
    process.exit(0);
  }

  if (cmd === 'room') {
    const n = resolveRoom(map, rest.join(' '));
    if (n == null) { console.error(`unknown room "${rest.join(' ')}"`); process.exit(1); }
    const r = map.rooms[n];
    console.log(`${r.name} — room ${r.num}, class ${r.cls}, ${r.rows}x${r.cols}, flags ${r.flags}`);
    for (const e of exitsOf(r)) console.log(`  ${e.how.padEnd(46)} -> ${e.to == null ? '(locked)' : `${map.rooms[e.to]?.name || '?'} (${e.to})`}`);
    if (r.yellZone.length) console.log(`  yell reaches: ${r.yellZone.map(y => map.rooms[y]?.name || y).join(', ')}`);
    process.exit(0);
  }

  if (cmd === 'stats') {
    const rooms = Object.values(map.rooms);
    console.log(`built ${map.builtAt}`);
    console.log(`${rooms.length} rooms`);
    const deg = rooms.map(r => exitsOf(r).filter(e => e.to != null).length);
    console.log(`exits: ${deg.reduce((a, b) => a + b, 0)} total, mean ${(deg.reduce((a, b) => a + b, 0) / rooms.length).toFixed(1)}, max ${Math.max(...deg)}`);
    // Connectivity is the property that decides whether `travel` can work at all.
    const nums = rooms.map(r => r.num);
    const comp = new Map();
    let cid = 0;
    for (const start of nums) {
      if (comp.has(start)) continue;
      cid++;
      const q = [start]; comp.set(start, cid);
      while (q.length) {
        const at = q.pop();
        for (const e of exitsOf(map.rooms[at] || { edgeExits: [], goExits: [] })) {
          if (e.to == null || comp.has(e.to) || !map.rooms[e.to]) continue;
          comp.set(e.to, cid); q.push(e.to);
        }
      }
    }
    const sizes = [...comp.values()].reduce((m, c) => (m[c] = (m[c] || 0) + 1, m), {});
    const sorted = Object.entries(sizes).sort((a, b) => b[1] - a[1]);
    console.log(`${sorted.length} connected component(s) (forward reachability), largest ${sorted[0][1]} rooms`);
    console.log(`isolated rooms: ${sorted.filter(([, n]) => n === 1).length}`);
    process.exit(0);
  }

  console.error('usage: m59-map.mjs build [maxObjectId] | refresh-geometry | ' +
                'path <from> <to> | room <n|name> | stats');
  process.exit(1);
}
