#!/usr/bin/env node
// THE DOORS THAT ARE FLOORS — every sector the world MOVES, and which of them gate a step.
//
//   node tools/m59-varsectors.mjs                 # the table, worst first
//   node tools/m59-varsectors.mjs --write         # rebuild substrate/m59-variable-sectors.json
//   node tools/m59-varsectors.mjs --gating        # only the ones that block a character
//
// WHY THIS EXISTS. A Meridian 59 door is often not a wall and not an object — it is a
// FLOOR that lifts. `SetSector` raises a sector's height, and a character cannot climb
// more than MAX_STEP_HEIGHT (384 client units), so a floor at 420 is a locked door and the
// same floor at 356 is an open one. Nothing about it looks like a door to a collision
// model: it is the same square, with the same walls, at a different height.
//
// AND OUR BAKE IS A SNAPSHOT. `substrate/m59-map.json` reduces each room to a static
// collision grid taken from the .roo, which carries the AUTHORED height — for a door, the
// state it was drawn in. The mover then enforces that snapshot, so a door baked shut is
// shut for ever, whatever the server says. This repository's own rule is that the
// collision map is evidence about a server and never authority over one; a moving floor
// is where that rule bites hardest, because the map cannot even be wrong loudly. It is
// simply a wall that was never there.
//
// WHAT IT COST. The Duke's Feast Hall (953) is entered from Blackstone Keep (951) through
// FEAST_DOOR_CLOSED/FEAST_DOOR_OPEN, which lift between 356 and 420 — one either side of
// the step limit. On 2026-09-04 a fleet walked eleven hops to the hall four separate
// times, arrived at 951, and could not take the last step: `m59-walksim` says `no route,
// plan 0 steps` from r9c14 to the door square, and every square west of column 13 on that
// row is unreachable in the bake. The doctrine driving it concluded THE HALL IS LOCKED,
// because a journey that never arrives is the only symptom it has — and it said so for a
// day while the hall stood open. The operator had to say "it is genuinely open" before
// anybody looked at the floor.
//
// SO THE POINT OF THE TABLE IS THAT THE BAKE STOPS BEING SILENT. A room in here is a room
// whose geometry is a claim with a timestamp, not a fact, and `gates` marks the sectors
// where being wrong means a character cannot move rather than a character mis-steps.
//
// DERIVED, NOT MAINTAINED. Every row comes from the kod with its file and line, because a
// hand-kept list of doors is a list that is wrong the first time somebody adds one.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The same constant the walker enforces, restated with its citation rather than imported,
// so this tool still runs against a checkout whose mover has been refactored.
// m59-roo.mjs: MAX_STEP_HEIGHT_KOD = 24, heightKodToClient shifts by 4.
export const MAX_STEP_HEIGHT = 384;

const KOD_ROOT = process.env.M59_ROOT
  ? join(process.env.M59_ROOT, 'kod')
  : 'C:/code/Meridian59/kod';

/** RID_* -> room number, out of the game's own header. */
export function readRoomIds(kodRoot = KOD_ROOT) {
  const src = readFileSync(join(kodRoot, 'include/blakston.khd'), 'utf8');
  const out = new Map();
  for (const m of src.matchAll(/^\s*(RID_[A-Z0-9_]+)\s*=\s*(\d+)/gm)) out.set(m[1], Number(m[2]));
  return out;
}

const kodFiles = (dir) => {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.kod')) out.push(p);
    }
  })(dir);
  return out;
};

/**
 * Every `SetSector` in one kod file, with the sector resolved through the file's own
 * constants. A sector named by a constant is the ordinary case and the name is worth
 * keeping — `FEAST_DOOR_CLOSED` says what the number is for, and the number does not.
 */
export function sectorsInSource(src) {
  const consts = new Map();
  for (const c of src.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\s*$/gm))
    consts.set(c[1], Number(c[2]));
  const bySector = new Map();
  // `#height` does not always follow `#sector` immediately — the animation argument sits
  // between them — so this spans a bounded gap rather than requiring adjacency.
  for (const m of src.matchAll(/@SetSector\s*,\s*#sector\s*=\s*([A-Za-z0-9_]+)[\s\S]{0,160}?#height\s*=\s*(-?\d+)/g)) {
    const raw = m[1];
    const sector = /^\d+$/.test(raw) ? Number(raw) : consts.get(raw);
    if (sector == null) continue;          // a sector we cannot resolve is not a claim
    const line = src.slice(0, m.index).split('\n').length;
    if (!bySector.has(sector))
      bySector.set(sector, { sector, name: /^\d+$/.test(raw) ? null : raw, heights: new Set(), lines: [] });
    bySector.get(sector).heights.add(Number(m[2]));
    bySector.get(sector).lines.push(line);
  }
  return [...bySector.values()].map(s => ({
    sector: s.sector, name: s.name,
    heights: [...s.heights].sort((a, b) => a - b),
    cite_lines: s.lines.slice(0, 4),
  }));
}

/**
 * Does moving this sector change whether a character can cross it?
 *
 * A sector that only ever moves BELOW the step limit is scenery — a rising platform you
 * can always climb, a floor that ripples. One that crosses the limit is a door, whatever
 * it is called, and a bake that catches it on the wrong side is a wall that does not exist.
 */
export const gatesMovement = heights =>
  heights.length > 1 && Math.min(...heights) < MAX_STEP_HEIGHT
                     && Math.max(...heights) >= MAX_STEP_HEIGHT;

export function scan(kodRoot = KOD_ROOT) {
  const rid = readRoomIds(kodRoot);
  const rooms = [];
  for (const file of kodFiles(kodRoot)) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('@SetSector')) continue;
    const sectors = sectorsInSource(src);
    if (!sectors.length) continue;
    const m = /piRoom_num\s*=\s*(RID_[A-Z0-9_]+)/.exec(src);
    rooms.push({
      // A room we cannot number is still reported — it is a door somebody should look at —
      // but it cannot be matched to a bake, and saying so is the point.
      room: m ? (rid.get(m[1]) ?? null) : null,
      rid: m ? m[1] : null,
      file: relative(kodRoot, file).replace(/\\/g, '/'),
      sectors: sectors.map(s => ({ ...s, gates: gatesMovement(s.heights) })),
    });
  }
  rooms.sort((a, b) => (a.room ?? 1e9) - (b.room ?? 1e9));
  return rooms;
}

// ---------------------------------------------------------------------------- cli
const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, '/').replace(/^([a-z]):/, (s) => s.toUpperCase());
if (isMain || process.argv[1]?.endsWith('m59-varsectors.mjs')) {
  const argv = process.argv.slice(2);
  const rooms = scan();
  const gatingOnly = argv.includes('--gating');
  let gating = 0, moving = 0;

  console.log('room   file                        sector                      heights                 gates?');
  for (const r of rooms) {
    for (const s of r.sectors) {
      moving++;
      if (s.gates) gating++;
      if (gatingOnly && !s.gates) continue;
      console.log(
        String(r.room ?? '?').padEnd(6),
        r.file.split('/').pop().padEnd(27),
        (String(s.sector) + (s.name ? ` (${s.name})` : '')).padEnd(27),
        JSON.stringify(s.heights).padEnd(23),
        s.gates ? 'GATES — this is a door' : '');
    }
  }
  console.log('');
  console.log(`${rooms.length} room(s) move a sector, ${moving} sector(s) in total, ` +
              `${gating} of which cross the ${MAX_STEP_HEIGHT}-unit step limit and gate movement.`);
  console.log('A gating sector baked on the wrong side is a wall that does not exist, and ' +
              'nothing downstream can tell.');

  if (argv.includes('--write')) {
    const out = fileURLToPath(new URL('../substrate/m59-variable-sectors.json', import.meta.url));
    writeFileSync(out, JSON.stringify({
      note: 'Sectors the world MOVES, derived from the kod by tools/m59-varsectors.mjs. ' +
            'A sector whose height crosses MAX_STEP_HEIGHT (384) is a door: the same square ' +
            'is passable at one height and not at the other, and a static bake cannot tell. ' +
            'Regenerate with --write; do not hand-edit.',
      max_step_height: MAX_STEP_HEIGHT,
      built_at: new Date().toISOString(),
      rooms,
    }, null, 1) + '\n');
    console.log(`\nwrote ${relative(process.cwd(), out).replace(/\\/g, '/')}`);
  }
}
