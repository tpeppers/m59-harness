#!/usr/bin/env node
// The room graph: how an agent gets from anywhere to anywhere.
//
//   node tools/m59-map.mjs build            walk the server, write substrate/m59-map.json
//   node tools/m59-map.mjs path <from> <to> shortest route between two room numbers or names
//   node tools/m59-map.mjs room <n>         one room's exits and neighbours
//   node tools/m59-map.mjs stats            what the graph looks like
//
// Built ONCE over the admin socket, used forever over the game protocol. That split
// is deliberate: the maintenance port has no password and must stay on loopback, but
// a JSON file is remote-safe, so the broker ships the graph as data and never needs
// privileged access at play time.
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

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoo, RoomGeometry } from './m59-roo.mjs';
import { loadCodeExits } from './m59-codeexits.mjs';

// Exits that exist only as code in the room class — see m59-codeexits.mjs. Built by:
// node tools/m59-codeexits.mjs
const CODE_EXITS_FILE = process.env.M59_CODE_EXITS ||
  path.join(path.dirname(fileURLToPath(import.meta.url)),
            '..', 'substrate', 'm59-codeexits.json');

const HOST = process.env.M59_HOST || '127.0.0.1';
const ADMIN_PORT = Number(process.env.M59_ADMIN_PORT || 9998);
const MAP_FILE = process.env.M59_MAP ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'substrate', 'm59-map.json');

// blakston.khd:1219-1226. Note LEAVE_x and ENTER_x share numbers with opposite
// meanings, so never mix the two vocabularies.
export const LEAVE = { SOUTH: 1, NORTH: 2, WEST: 3, EAST: 4 };
export const LEAVE_NAME = { 1: 'south', 2: 'north', 3: 'west', 4: 'east' };

// blakston.khd:1212-1216
export const COND = { ROW_GT: 1, ROW_LT: 2, COL_GT: 3, COL_LT: 4, NONE: 5 };
export const COND_NAME = { 1: 'row>', 2: 'row<', 3: 'col>', 4: 'col<', 5: 'default' };

export const ROOM_LOCKED_DOOR = -1;         // blakston.khd:371
export const ROTATE_NONE = 8;               // blakston.khd:1253

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
  // byte planes per room, base64'd, is a few kB each.
  let baked = 0, missing = [];
  for (const room of Object.values(byNum)) {
    if (!room.rooFile) { missing.push(room.name); continue; }
    const geo = loadRoo(room.rooFile);
    if (!geo) { missing.push(`${room.name} (${room.rooFile})`); continue; }
    room.roo = geo.toJSON();
    // kod's piRows/piCols and the .roo grid must agree or every coordinate from
    // perception indexes the wrong square. Record the disagreement rather than
    // silently preferring one.
    if (room.rows != null && (geo.rows !== room.rows || geo.cols !== room.cols))
      room.rooDimensionMismatch = { kod: [room.rows, room.cols], roo: [geo.rows, geo.cols] };
    baked++;
  }
  process.stderr.write(`  pass 3: geometry baked for ${baked}/${Object.keys(byNum).length} rooms` +
                       `${missing.length ? `, missing ${missing.length}` : ''}\n`);
  if (missing.length) process.stderr.write(`    missing: ${missing.slice(0, 8).join(', ')}\n`);

  return {
    builtAt: new Date().toISOString(),
    note: 'Room numbers (piRoom_num) are stable across save/restart; objId is NOT — ' +
          'it is recorded for admin-socket convenience only and must be re-resolved after a save. ' +
          'nameRsc and roomRsc are protocol-visible (BP_PLAYER) and are the keys a broker ' +
          'should use to identify which room a session is standing in.',
    rooms: byNum,
  };
}

// ------------------------------------------------------------------ graph

export function loadMap(file = MAP_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Every way out of a room, as one uniform list, because an agent should not have to
// care which mechanism a given door uses — only what it has to do.
export function exitsOf(room) {
  const out = [];
  for (const e of room.edgeExits) {
    out.push({
      kind: 'edge', to: e.to, direction: e.leaveName,
      how: `walk ${e.leaveName} past the room edge` +
           (e.condition ? ` (only when ${e.condition.name}${e.condition.threshold})` : ''),
      arriveRow: e.arriveRow, arriveCol: e.arriveCol,
      condition: e.condition,
    });
  }
  for (const g of room.goExits) {
    if (g.locked) { out.push({ kind: 'locked', to: null, row: g.row, col: g.col, how: `locked door at (${g.col},${g.row})` }); continue; }
    out.push({
      kind: 'go', to: g.to, row: g.row, col: g.col,
      how: `stand exactly on (${g.col},${g.row}) then go`,
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
  path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
            '..', 'substrate', 'm59-badexits.json');

const badInferred = new Set(readBadExits());
function readBadExits() {
  try { return JSON.parse(fs.readFileSync(BAD_EXITS_FILE, 'utf8')).refused ?? []; } catch { return []; }
}
export function forgetInferredExit(from, to) {
  const key = from + '->' + to;
  if (badInferred.has(key)) return;
  badInferred.add(key);
  try {
    fs.writeFileSync(BAD_EXITS_FILE, JSON.stringify({
      note: 'Inferred reverse edges the server has refused. Written by forgetInferredExit ' +
            'in m59-map.mjs; delete an entry to let the router try it again.',
      refused: [...badInferred],
    }, null, 1));
  } catch { /* a lost note is better than a crashed router */ }
}
export function inferredExitCount() { return badInferred.size; }

export function inferredExits(map, roomNum) {
  if (!map.__reverse) {
    const rev = new Map();
    for (const r of Object.values(map.rooms)) {
      for (const e of r.edgeExits || []) {
        if (e.to == null || e.condition) continue;   // conditional exits are not symmetric
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
        if (!rev.has(e.to)) rev.set(e.to, []);
        if (!rev.get(e.to).some(x => x.to === r.num))
          rev.get(e.to).push({ kind: 'edge', to: r.num, direction: LEAVE_NAME[back],
                               leave: back, inferred: true,
                               how: `walk ${LEAVE_NAME[back]} past the room edge ` +
                                    `(inferred: ${r.name} declares ${LEAVE_NAME[e.leave]} into here)` });
      }
    }
    Object.defineProperty(map, '__reverse', { value: rev, enumerable: false });
  }
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

export function findPath(map, fromNum, toNum) {
  if (fromNum === toNum) return { found: true, hops: [] };
  const seen = new Set([fromNum]);
  const q = [[fromNum, []]];
  while (q.length) {
    const [at, sofar] = q.shift();
    const room = map.rooms[at];
    if (!room) continue;
    for (const ex of [...exitsOf(room), ...inferredExits(map, at), ...codeExits(at)]) {
      if (ex.to == null || seen.has(ex.to)) continue;
      const hop = { from: at, fromName: room.name, to: ex.to,
                    toName: map.rooms[ex.to]?.name || `room ${ex.to}`, ...ex };
      const next = [...sofar, hop];
      if (ex.to === toNum) return { found: true, hops: next };
      seen.add(ex.to);
      q.push([ex.to, next]);
    }
  }
  return { found: false, hops: [], reason: `no route from ${fromNum} to ${toNum} in the graph` };
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
    fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
    fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 1));
    const rooms = Object.values(map.rooms);
    const edges = rooms.reduce((n, r) => n + exitsOf(r).filter(e => e.to != null).length, 0);
    console.log(`\nwrote ${MAP_FILE}`);
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

  console.error('usage: m59-map.mjs build [maxObjectId] | path <from> <to> | room <n|name> | stats');
  process.exit(1);
}
