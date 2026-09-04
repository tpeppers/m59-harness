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
// m59-roo.mjs: PLAYER_HEIGHT = 3 * CLIENT_FINENESS / 4 (game.c:262). A ceiling that drops
// below this stops a character fitting through, which is a door made of headroom.
export const PLAYER_HEIGHT = 768;
// blakston.khd:2372
export const ANIMATE_FLOOR_LIFT = 4, ANIMATE_CEILING_LIFT = 5;

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
// A kod file's `constants:` block, which is where a door's sector number is almost always
// written. Separate from the scan because a caller looking at ONE BLOCK of a file still
// needs the whole file's constants — see groupsInSource, where not passing them resolved
// `FEAST_DOOR_OPEN` to nothing and lost the Duke's feast hall from the group list.
export function constantsInSource(src) {
  const consts = new Map();
  for (const c of src.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\s*$/gm))
    consts.set(c[1], Number(c[2]));
  return consts;
}

export function sectorsInSource(src, { consts = constantsInSource(src) } = {}) {
  const bySector = new Map();
  // `#height` does not always follow `#sector` immediately — the animation argument sits
  // between them — so this spans a bounded gap rather than requiring adjacency.
  //
  // CASE-INSENSITIVE, AND THAT IS NOT PEDANTRY. kod is not case-sensitive about message
  // names and the world's authors were not consistent: i8.kod writes `@setsector` in lower
  // case, and matching only `@SetSector` silently dropped the Temple of Qor door — the one
  // the operator named first, in a room this fleet crosses daily. A scanner that misses a
  // door is worse than no scanner, because the empty result reads as "no doors here".
  for (const m of src.matchAll(/@setsector\s*,\s*#sector\s*=\s*([A-Za-z0-9_]+)[\s\S]{0,200}?#height\s*=\s*(-?\d+)/gi)) {
    const raw = m[1];
    const sector = /^\d+$/.test(raw) ? Number(raw) : consts.get(raw);
    if (sector == null) continue;          // a sector we cannot resolve is not a claim
    const line = src.slice(0, m.index).split('\n').length;
    // WHICH SURFACE IS MOVING decides what "blocked" even means. A floor gates by the step
    // a character can climb; a ceiling gates by whether it can fit underneath. Reading a
    // ceiling with the floor's rule is how the Qor door read as harmless scenery.
    const kind = /ANIMATE_CEILING_LIFT/i.test(m[0]) ? 'ceiling'
      : /ANIMATE_FLOOR_LIFT/i.test(m[0]) ? 'floor' : 'unknown';
    if (!bySector.has(sector))
      bySector.set(sector, { sector, name: /^\d+$/.test(raw) ? null : raw,
                             heights: new Set(), kinds: new Set(), lines: [] });
    bySector.get(sector).heights.add(Number(m[2]));
    bySector.get(sector).kinds.add(kind);
    bySector.get(sector).lines.push(line);
  }
  return [...bySector.values()].map(s => ({
    sector: s.sector, name: s.name,
    // 'unknown' only survives when nothing else was seen — a sector set by both is a floor
    // and a ceiling and must be judged by both rules.
    kind: s.kinds.has('floor') && s.kinds.has('ceiling') ? 'both'
      : s.kinds.has('ceiling') ? 'ceiling' : s.kinds.has('floor') ? 'floor' : 'unknown',
    heights: [...s.heights].sort((a, b) => a - b),
    cite_lines: s.lines.slice(0, 4),
  }));
}

/**
 * The sector states this world sets TOGETHER — one entry per kod message that moves more
 * than one sector at once.
 *
 * WHY THIS IS NOT AN EMBELLISHMENT. `duke2.kod`'s `Open()` sets sector 3 to 356 and sector
 * 4 to 419 in the same breath, so the Duke's feast door has a state in which BOTH are off
 * the height the .roo shipped. Measured 2026-09-04: the mask for that pair is not the mask
 * for either sector alone, and is not the baseline — it is its own thing. A bake holding
 * only single-sector variants therefore has no mask for the state the live server is
 * actually in, and picking the closest one would be a confident map of a room nobody is
 * standing in. This is what lets the bake hold the real states.
 *
 * A state is one BRACE BLOCK's worth of sends — see the note in the body for why the
 * enclosing message is far too coarse a unit to find them.
 */
export function groupsInSource(src) {
  // BRACE BLOCKS, NOT MESSAGES, and the difference is the whole answer. duke2.kod puts
  // every door in one `SomethingTryGo`, and the feast hall's two states are the two halves
  // of an if/else inside it: opening sends `{3:356, 4:419}` and closing sends
  // `{3:420, 4:356}` — the same pair of sectors, swapped. Grouped by message those four
  // sends are one indistinguishable heap and every sector has two heights, which is how a
  // first attempt at this found ZERO states in a file that has two.
  //
  // kod comments run from `%` to the end of the line and may contain braces, so they are
  // skipped rather than counted; a brace inside a comment would nest the whole file.
  const consts = constantsInSource(src);
  const blocks = [];                      // { start, end } for every {...}, innermost last
  const stack = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '%') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '"') { i++; while (i < src.length && src[i] !== '"') i++; continue; }
    if (ch === '{') stack.push(i);
    else if (ch === '}' && stack.length) blocks.push({ start: stack.pop(), end: i });
  }
  blocks.sort((a, b) => (a.end - a.start) - (b.end - b.start));

  const seen = new Set();
  const out = [];
  for (const m of src.matchAll(/@setsector/gi)) {
    // The innermost block containing this send — `blocks` is shortest-first, so the first
    // hit is it. Two sends in the same branch resolve to the same block and become a state.
    const block = blocks.find(b => m.index > b.start && m.index < b.end);
    if (!block || seen.has(block.start)) continue;
    seen.add(block.start);
    // THE WHOLE FILE'S CONSTANTS, against a single block's text. `FEAST_DOOR_OPEN = 4` is
    // declared in duke2.kod's header and used two hundred lines later; resolving names from
    // the block alone found nothing and quietly dropped the one door this was written for.
    const states = sectorsInSource(src.slice(block.start, block.end), { consts })
      // ONE HEIGHT PER SECTOR, or this is a sequence rather than a position. A branch that
      // sets the same sector twice is animating it, and picking one of the two would be
      // baking a state the room is never at rest in.
      .filter(s => s.heights.length === 1)
      .map(s => ({ sector: s.sector, height: s.heights[0], name: s.name, kind: s.kind }));
    if (states.length < 2) continue;
    out.push({ line: src.slice(0, block.start).split('\n').length,
               states: states.sort((a, b) => a.sector - b.sector) });
  }
  return out;
}

/**
 * Does moving this sector change whether a character can cross it?
 *
 * A sector that only ever moves BELOW the step limit is scenery — a rising platform you
 * can always climb, a floor that ripples. One that crosses the limit is a door, whatever
 * it is called, and a bake that catches it on the wrong side is a wall that does not exist.
 */
export function gatesMovement(heights, kind = 'floor') {
  if (!Array.isArray(heights) || heights.length < 2) return false;
  const lo = Math.min(...heights), hi = Math.max(...heights);
  // ONLY A FLOOR CAN BE DECIDED FROM THE KOD ALONE, and claiming otherwise made this
  // useless. A floor gates when it crosses the step a character can climb, and both
  // numbers are right here. A CEILING gates when `ceiling - floor` drops below
  // PLAYER_HEIGHT — and the kod says nothing about the floor under it, so the same
  // reading applied to a ceiling marked 59 of 109 sectors as doors, which is not a list
  // anybody can act on. See `headroomRisk`: a moving ceiling is a QUESTION for the bake,
  // not an answer from here.
  if (kind === 'ceiling') return false;
  return lo < MAX_STEP_HEIGHT && hi >= MAX_STEP_HEIGHT;
}

/**
 * A moving ceiling MIGHT gate, and only the bake can say.
 *
 * The Temple of Qor door (room 598, i8.kod) lifts its ceiling between 284 and 348. Whether
 * that stops a character depends entirely on the floor beneath it, which is in the .roo and
 * not in the kod. So this marks the sector as one whose passability must be computed at
 * BOTH heights and compared — which is what baking an alternate grid does — rather than
 * predicted here.
 */
export const headroomRisk = (heights, kind) =>
  (kind === 'ceiling' || kind === 'both') && Array.isArray(heights) && heights.length > 1;

/** Every height this sector is ever set to — the states an alternate grid must cover. */
export const statesFor = sector => [...new Set(sector.heights)].sort((a, b) => a - b);

export function scan(kodRoot = KOD_ROOT) {
  const rid = readRoomIds(kodRoot);
  const rooms = [];
  for (const file of kodFiles(kodRoot)) {
    const src = readFileSync(file, 'utf8');
    // CASE-INSENSITIVE HERE TOO. This cheap pre-filter sat in front of a regex that had
    // already been made case-insensitive, and skipped the file before the regex ever ran —
    // so the Temple of Qor door (i8.kod, `@setsector` in lower case) stayed missing after
    // the fix that was supposed to find it. A guard in front of a search has to agree with
    // the search, or it is a second, stricter search nobody remembers writing.
    if (!/@setsector/i.test(src)) continue;
    const sectors = sectorsInSource(src);
    if (!sectors.length) continue;
    const m = /piRoom_num\s*=\s*(RID_[A-Z0-9_]+)/.exec(src);
    rooms.push({
      // A room we cannot number is still reported — it is a door somebody should look at —
      // but it cannot be matched to a bake, and saying so is the point.
      room: m ? (rid.get(m[1]) ?? null) : null,
      rid: m ? m[1] : null,
      file: relative(kodRoot, file).replace(/\\/g, '/'),
      sectors: sectors.map(s => ({ ...s, gates: gatesMovement(s.heights, s.kind),
                                    headroom_risk: headroomRisk(s.heights, s.kind) })),
      // Only groups in which at least two GATING sectors move together are worth a mask —
      // a message that also nudges a bit of scenery is still one door as far as the bake
      // is concerned, and the scenery would multiply the states for nothing.
      groups: groupsInSource(src)
        .map(g => ({ ...g, states: g.states.filter(st =>
              sectors.some(s => s.sector === st.sector && gatesMovement(s.heights, s.kind))) }))
        .filter(g => g.states.length >= 2),
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
  let gating = 0, moving = 0, headroom = 0;

  console.log('room   file                        sector                      kind     heights                 gates?');
  for (const r of rooms) {
    for (const s of r.sectors) {
      moving++;
      if (s.gates) gating++;
      if (s.headroom_risk) headroom++;
      if (gatingOnly && !s.gates && !s.headroom_risk) continue;
      console.log(
        String(r.room ?? '?').padEnd(6),
        r.file.split('/').pop().padEnd(27),
        (String(s.sector) + (s.name ? ` (${s.name})` : '')).padEnd(27),
        (s.kind ?? '?').padEnd(8),
        JSON.stringify(s.heights).padEnd(23),
        s.gates ? 'GATES — a floor across the step limit'
          : s.headroom_risk ? 'headroom — the bake must decide' : '');
    }
  }
  console.log('');
  console.log(`${rooms.length} room(s) move a sector, ${moving} sector(s) in total: ` +
              `${gating} floor(s) cross the ${MAX_STEP_HEIGHT}-unit step limit and definitely gate, ` +
              `and ${headroom} moving ceiling(s) may gate on headroom — only the bake can say.`);
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
