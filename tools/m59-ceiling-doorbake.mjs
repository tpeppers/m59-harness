#!/usr/bin/env node
// EVERY ROOM WHOSE DOORS ARE MOVING CEILINGS, not just the Bookmakers' hall.
//
//   node tools/m59-ceiling-doorbake.mjs            # what it would bake
//   node tools/m59-ceiling-doorbake.mjs --write    # write substrate/m59-ceiling-doors.json
//   node tools/m59-ceiling-doorbake.mjs --room 707 # one room, for a before/after
//
// A Meridian 59 door is usually a sector the room MOVES, and a guild hall's are CEILINGS: the
// floor never changes, the headroom does. The collision bake holds ONE state, so such a room
// bakes as a warren of sealed regions and the router answers `route_progressing_exits_exhausted`
// — true about that state and false about the room. `m59-ceiling-doors.mjs` already fixes this
// at runtime for any room it has a table for; it was this bake that knew only room 714, from a
// hand-written list of five sectors. Twenty-six rooms have moving ceilings.
//
// THE ROOM STATES ARE NOT THE OPERABLE DOORS, and conflating them would have lost one. The door
// table (`substrate/m59-doors.json`) answers "which doors can a character work, and from which
// square" and so holds only `SomethingTryGo` triggers. This asks a different question — what
// states can this room BE in — and the answer includes doors nobody steps on. Room 714's
// SECRET_DOOR opens when a player SAYS the guild password (guildh14.kod `SomeoneSaid` ->
// `OpenSecretDoor`), so it never appears as a trigger and the router still needs its mask.
// Hence the sector list comes from `m59-variable-sectors.json`, which is every sector any kod
// in the room animates, whatever moves it.
//
// Runtime never builds masks and never guesses how independently moving doors compose: a door
// that RISES removes steps, so OR-ing two single-door masks is a wish rather than a state.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { geometryWithSectorHeights, heightKodToClient, STEP_MASK_VERSION } from './m59-roo.mjs';

const here = p => new URL(p, import.meta.url);
const map = JSON.parse(readFileSync(here('../substrate/m59-map.json')));
const routes = JSON.parse(readFileSync(here('../substrate/m59-routes.json')));
const varsectors = JSON.parse(readFileSync(here('../substrate/m59-variable-sectors.json')));
const ROOMS_DIR = join(process.env.M59_ROOT || 'C:/code/Meridian59', 'resource/rooms');

const argv = process.argv.slice(2);
const only = argv.includes('--room') ? Number(argv[argv.indexOf('--room') + 1]) : null;
const b64 = m => Buffer.from(m).toString('base64');

// A DOOR HAS THE POSITIONS IT HAS, AND THERE ARE SOMETIMES THREE.
//
// Two come from the kod — the heights it animates between — and the third is where the .roo
// SHIPS the sector, which the kod need never mention. Room 750's sector 2 ships at kod 520
// against kod heights of 380 and 510: the Caves of Ice rest with that ceiling ten units higher
// than the kod ever opens it. Enumerating only open/closed there would leave the state the
// room is actually in with no key at all, and `applyCeilingDoors` answers null for a key it
// does not hold — so the one room-state that is true every time nobody has touched anything
// would be the one the table could not describe.
const positions = d => [...new Set([d.closed, d.open, d.shipped].filter(h => Number.isFinite(h)))];

// FULL COMBINATIONS UNTIL THEY STOP BEING AFFORDABLE, THEN THE ONES THAT HAPPEN.
//
// The product of those positions is a room's state space, and room 707 has ten doors — 1024
// masks at ~3.5KB each on a room that size, which is megabytes of derived data in git. The cap
// is 64 states, which covers twenty-three of the twenty-six rooms exactly.
//
// Above it the table holds the states a character actually meets: where the room rests, each
// door moved by itself from there, and everything open or everything shut. That is not a
// compression of the full set and must not be read as one — a missing key falls through to the
// behaviour this tool improves on, so a partial room is no worse than before in the states it
// omits and right in the ones it has. `partial` says which.
const MAX_FULL_STATES = 64;
function statesFor(doors) {
  const each = doors.map(positions);
  const full = each.reduce((n, p) => n * p.length, 1);
  if (full <= MAX_FULL_STATES) {
    let out = [[]];
    for (const ps of each) out = out.flatMap(prefix => ps.map(h => [...prefix, h]));
    return { heights: out, partial: false };
  }
  // THE BASE IS WHERE THE ROOM RESTS, NOT WHERE IT IS SHUT — see `shipped`. Basing the singles
  // on `closed` would enumerate states the room is never in and omit the one it is in most of
  // the time.
  const rest = d => d.shipped ?? d.closed;
  const out = [doors.map(rest), doors.map(d => d.open), doors.map(d => d.closed)];
  for (let i = 0; i < doors.length; i++)
    for (const h of positions(doors[i]))
      out.push(doors.map((d, j) => (i === j ? h : rest(d))));
  const seen = new Set();
  return { heights: out.filter(h => !seen.has(h.join(',')) && seen.add(h.join(','))), partial: true };
}

const rooms = {};
const report = [];
for (const entry of varsectors.rooms) {
  const num = entry.room;
  if (num == null || (only != null && num !== only)) continue;
  const ceilings = (entry.sectors ?? []).filter(s => s.kind === 'ceiling' && s.heights?.length >= 2);
  if (!ceilings.length) continue;
  const roomEntry = map.rooms[num], routed = routes.rooms[num];
  if (!roomEntry?.rooFile) { report.push({ room: num, skipped: 'not in m59-map.json' }); continue; }
  if (!routed?.stepMask) { report.push({ room: num, skipped: 'no baked route for this room' }); continue; }

  let buf;
  try { buf = readFileSync(join(ROOMS_DIR, roomEntry.rooFile)); }
  catch { report.push({ room: num, skipped: `no ${roomEntry.rooFile} under ${ROOMS_DIR}` }); continue; }

  const base = geometryWithSectorHeights(buf, {}, { mask: false, file: roomEntry.rooFile }).geometry;
  const baseline = b64(base.buildStepMask());
  // THE CHECK THAT MAKES THE REST TRUSTWORTHY, and it refuses ONE ROOM rather than the run.
  // If this tool's mask for the room as shipped is not the routing table's, the two model the
  // room differently and every variant computed here would be a confident map of a different
  // room. The old version threw, which on a 26-room bake would mean one bad room costs the
  // other twenty-five.
  if (baseline !== routed.stepMask) {
    report.push({ room: num, refused: 'baseline mask differs from the routing bake' });
    continue;
  }
  // SORTED BY SECTOR ID, WHICH IS WHAT KEEPS THE KEYS STABLE. A state's key is the door
  // heights joined in door-array order, so the order is part of the file's contract: take it
  // from the kod scan and an unrelated edit to a room's kod reshuffles every key in it. Both
  // readers here derive the key from the table's own `doors` and so would survive that, but
  // `m59-guildrails.mjs` WRITES `state_key` into its baked rails, and a rail looking up a key
  // from a previous ordering misses and throws `no baked sector-height state`. Sorting also
  // happens to reproduce the hand-written 714 list exactly — [3,53,55,58,59] — so the room
  // already in production keeps every one of its 32 keys.
  const doors = ceilings.slice().sort((a, b) => (a.serverId ?? a.sector) - (b.serverId ?? b.sector)).map(s => {
    const id = s.serverId ?? s.sector;
    // ONE SERVER ID, SEVERAL SECTOR RECORDS — the kod addresses the id and the server
    // moves every record carrying it, so all of them are listed. Patching one moves
    // half a door and then enforces the half that moved.
    const indices = base.sectors.flatMap((g, i) => (g.serverId === id ? [i] : []));
    // WHERE THE .roo SHIPS THIS DOOR, WHICH IS NOT ALWAYS SHUT.
    //
    // `applyCeilingDoors` falls back to `closed` for any door the server has not told it
    // about, and on entering a room that is most of them — the replay carries the sectors
    // that have MOVED. Room 714 ships every door shut, so the hand-written bake never met
    // the other case and the fallback looked right. It is not: room 380's sector 4 ships at
    // kod 850, its OPEN height, and 598's at 348, and one of 750's two. Generalising without
    // this would have applied a shut mask to three passages that are standing open — the
    // router would call them sealed, which is precisely the failure this table exists to end,
    // reintroduced by the fix for it. Caught by `m59-ceilingtable-test.mjs` asserting the
    // all-shut mask equals the routing baseline; in those three rooms it does not.
    const shippedKod = Math.round((base.sectors[indices[0]]?.ceilingHeight ?? NaN) / 16);
    return { id, name: s.name ?? null,
             closed: Math.min(...s.heights), open: Math.max(...s.heights),
             shipped: Number.isFinite(shippedKod) ? shippedKod : null, indices };
  }).filter(d => d.indices.length);
  // A shipped height that is neither open nor closed means the kod moves this sector between
  // positions the .roo does not use, and the fallback then has no honest answer — say so
  // rather than picking one.
  for (const d of doors)
    if (d.shipped != null && d.shipped !== d.open && d.shipped !== d.closed)
      report.push({ room: num, note: `sector ${d.id} ships at ${d.shipped}, neither ${d.closed} nor ${d.open}` });
  if (!doors.length) { report.push({ room: num, skipped: 'no ceiling sector of that id in the .roo' }); continue; }

  const { heights: wanted, partial } = statesFor(doors);
  const states = {};
  let inert = 0;
  for (const heights of wanted) {
    const overrides = Object.fromEntries(doors.map((d, i) => [d.id, { ceiling: heights[i] }]));
    const geometry = geometryWithSectorHeights(buf, overrides, { mask: false, file: roomEntry.rooFile }).geometry;
    const mask = b64(geometry.buildStepMask());
    if (mask === baseline && heights.some((h, i) => h !== doors[i].closed)) inert++;
    // KEPT EVEN WHEN THE MASK IS THE BASELINE'S, unlike the floor bake. There the variant was
    // only ever a step mask; here `state.sectors` also carries the CEILING heights the runtime
    // sets on the live geometry, and headroom is read by more than the step mask. Dropping an
    // inert row would make the runtime fall back and leave the ceilings where they were.
    states[heights.join(',')] = { mask,
      sectors: doors.flatMap((d, i) => d.indices.map(index => ({ index, ceiling: heightKodToClient(heights[i]) }))) };
  }
  rooms[num] = { security: base.security, baseline, doors, states, partial };
  report.push({ room: num, name: roomEntry.name ?? '', doors: doors.length,
                states: Object.keys(states).length, inert, partial });
}

// NO TIMESTAMP IN A DERIVED FILE. One would make every re-bake a diff, so "running this
// changed nothing" — the cheapest check there is that a kod change did not move a mask —
// becomes unavailable. Provenance for this file is the commit that changed it.
const table = { version: STEP_MASK_VERSION, rooms };
console.table(report);
const kept = Object.keys(rooms).length;
const total = Object.values(rooms).reduce((a, r) => a + Object.keys(r.states).length, 0);
console.log(`${kept} room(s), ${total} state(s), ${(JSON.stringify(table).length / 1024 | 0)}KB`);
const partials = report.filter(r => r.partial).map(r => r.room);
if (partials.length) console.log(`partial (over ${MAX_FULL_STATES} states, so resting/singles/all-open/all-shut only): ${partials.join(', ')}`);
if (only != null) console.log('--room bakes ONE room; writing would drop the others, so --write is refused.');
else if (argv.includes('--write')) {
  writeFileSync(here('../substrate/m59-ceiling-doors.json'), JSON.stringify(table) + '\n');
  console.log('wrote substrate/m59-ceiling-doors.json');
} else console.log('Pass --write to save the verified masks.');
