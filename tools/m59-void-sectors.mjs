#!/usr/bin/env node
// VOID SECTORS: GROUND THE ROUTER CAN STAND ON AND NO BODY CAN EVER REACH.
//
//   node tools/m59-void-sectors.mjs --room 537     one room: sectors, and which are unreachable
//   node tools/m59-void-sectors.mjs                every room with a candidate, worst first
//
// THE FAILURE, room 537 (Faronath, home of the TreeFolk), 2026-09-30. Faronath is a dozen
// "bulbs" -- sectors 2..20 -- inside one big filler sector (sector 1) at the same floor
// height. Every bulb's boundary is a ONE-SIDED wall whose only sidedef faces into the bulb.
// The stock client skips a wall whose facing sidedef is null (move.c `continue`s, and
// canCrossWallAt copies it), so:
//
//     bulb -> filler   refused (the bulb's own sidedef is not passable)
//     filler -> bulb   free    (no sidedef on that side)
//
// Nobody ever stands in the filler. But `_occupiable` found floor there, so `standPoint` put
// 1,627 of the room's 2,450 squares in it; from there every bulb is enterable; and the step
// mask joined the whole room into one open field. The router then planned straight lines --
// r34c24 to r42c12 in twelve steps, through the gap between two bulbs -- and every character
// pressed against the bulb wall at r34c24 for ever, replanning the same line.
//
// WHAT THIS DOES. A DIRECTED flood over sectors, from the sectors bodies actually arrive in
// (every exit into the room, edge and `go`). A sector is entered only across a wall the
// client lets a body cross FROM THE SIDE IT IS ON (canCrossWallAt with that side). A sector the
// flood never reaches, with floor in it, is a candidate: ground that exists in the BSP and
// that no walk into this room can get to.
//
// IT REPORTS, AND substrate/m59-void-sectors.json DECIDES. The flood is sector-level: it uses
// each sector's floor as the standing height and ignores where along a wall the crossing is,
// so a room whose only way into a sector is up a slope can be reported wrongly. A declared
// void deletes ground, and deleted ground is a corridor nobody can use (docs/m59-routing.md),
// so an entry goes into the table only after its room has been looked at. Declaring one
// changes the room's step mask: rebake it (`node tools/m59-routebake.mjs --rooms <n> --resume`).
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap } from './m59-map.mjs';
import { sharedRoomGeometry, canCrossWallAt } from './m59-roo.mjs';

/** Where bodies arrive in each room: every edge and `go` exit INTO it. */
export function arrivalsInto(map) {
  const out = new Map();
  for (const room of Object.values(map.rooms ?? {}))
    for (const e of [...(room.edgeExits ?? []), ...(room.goExits ?? [])]) {
      const to = Number(e?.to);
      if (!(to > 0) || !Number.isFinite(Number(e.arriveRow)) || !Number.isFinite(Number(e.arriveCol))) continue;
      if (!out.has(to)) out.set(to, []);
      out.get(to).push({ row: Number(e.arriveRow), col: Number(e.arriveCol), from: Number(room.num) });
    }
  return out;
}

const sectorNumAt = (geo, x, y) => geo.leafAtClient(x, y)?.sectorNum ?? null;
const floorOf = s => Number(s?.floorHeight ?? s?.floor ?? 0);

/**
 * The directed sector flood. `sectorNum` is the 1-based number the BSP leaves carry.
 * @returns {{ reached: Set<number>, entry: Set<number>, sectors: number }}
 */
export function directedSectorReach(geo, arrivals) {
  const entry = new Set();
  for (const a of arrivals) {
    const x = (a.col - 0.5) * 1024, y = (a.row - 0.5) * 1024;
    const n = sectorNumAt(geo, x, y);
    if (n) entry.add(n);
  }
  // wall.posSector / negSector are 0-based indices; the leaves speak 1-based numbers.
  const edges = new Map();
  const add = (from, to) => { if (!edges.has(from)) edges.set(from, new Set()); edges.get(from).add(to); };
  for (const w of geo.walls ?? []) {
    const p = Number.isInteger(w.posSector) ? w.posSector + 1 : null;
    const n = Number.isInteger(w.negSector) ? w.negSector + 1 : null;
    if (!p || !n || p === n) continue;
    if (canCrossWallAt(w, w.x0, w.y0, floorOf(geo.sectors[p - 1]), 'pos')) add(p, n);
    if (canCrossWallAt(w, w.x0, w.y0, floorOf(geo.sectors[n - 1]), 'neg')) add(n, p);
  }
  const reached = new Set(entry), q = [...entry];
  while (q.length) for (const t of edges.get(q.pop()) ?? []) if (!reached.has(t)) { reached.add(t); q.push(t); }
  return { reached, entry, sectors: geo.sectors?.length ?? 0 };
}

/** One room's candidates: unreached sectors, with how many squares' stand points sit in each. */
export function voidCandidates(map, roomNum, arrivals = arrivalsInto(map).get(Number(roomNum)) ?? []) {
  const room = map.rooms?.[String(roomNum)];
  const geo = room && sharedRoomGeometry(room);
  if (!geo?.sectors?.length || !arrivals.length) return null;
  const { reached, entry, sectors } = directedSectorReach(geo, arrivals);
  const squares = new Map();
  for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
    const sp = geo.standPoint(r, c);
    if (!sp) continue;
    const n = sectorNumAt(geo, sp.x, sp.y);
    if (n && !reached.has(n)) squares.set(n, (squares.get(n) ?? 0) + 1);
  }
  return { room: Number(roomNum), name: room.name, sectors, entry: [...entry], reached: [...reached].sort((a, b) => a - b),
    candidates: [...squares].map(([sector, n]) => ({ sector, squares: n })).sort((a, b) => b.squares - a.squares) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--room');
  const map = loadMap();
  const into = arrivalsInto(map);
  const rooms = i >= 0 ? [Number(argv[i + 1])] : Object.keys(map.rooms).map(Number);
  const rows = [];
  for (const n of rooms) {
    let v = null;
    try { v = voidCandidates(map, n, into.get(n) ?? []); } catch (e) { if (i >= 0) console.error(`${n}: ${e.message}`); }
    if (v && (i >= 0 || v.candidates.length)) rows.push(v);
  }
  rows.sort((a, b) => b.candidates.reduce((s, c) => s + c.squares, 0) - a.candidates.reduce((s, c) => s + c.squares, 0));
  for (const v of rows)
    console.log(`${String(v.room).padStart(4)}  ${String(v.name).slice(0, 36).padEnd(36)}  entry ${v.entry.join(',')}  ` +
      `unreached: ${v.candidates.map(c => `sector ${c.sector} (${c.squares} sq)`).join(', ') || 'none'}`);
  if (!rows.length) console.log('no candidates');
}
