#!/usr/bin/env node
// BAKE THE BOOKMAKERS HALL: a rail for every door crossing, every chest, and the way out.
//
//   node tools/m59-guildrails.mjs bake            # cut them all, write substrate/rail-714.json
//   node tools/m59-guildrails.mjs show            # what is baked, leg by leg
//   node tools/m59-guildrails.mjs check           # re-verify the baked lines against the map
//   node tools/m59-guildrails.mjs probe r4c28 r2c28 --door 59   # one pair, one door state
//
// WHY A BAKE AND NOT A LIVE PLAN, which is what the hall does today.
//
// `m59-guild-passage.mjs` walks to a door's trigger, sends `go`, waits for the ceiling to lift,
// and then asks the LIVE geometry `path(here, across)` inside a window the comment itself puts at
// five seconds. Every part of that is a race, and on 2026-09-18 Zoot lost it for an hour:
//
//     guild door passage  sector 59  inward false  crossed false
//     reason: "no live path across the open door"   at r4c28, repeated every pass
//
// He was standing ON the trigger — the code says so, `detail_at` is the trigger square — with the
// whole hall's only exit two squares away, and `come-home` gave up with
// `route_progressing_exits_exhausted`. His own status reported all five doors at their CLOSED
// heights, so the geometry it planned across was the shut hall. A plan made inside a 350ms wait
// for a `sector-height` event is a plan that is sometimes made before the event arrives, and the
// failure is silent: "no live path" reads exactly like "there is no way out of this room".
//
// THE HALL'S GEOMETRY IS ENUMERABLE, so none of this has to be discovered at runtime.
// `substrate/m59-ceiling-doors.json` holds all 32 sector-height states of the five ceiling doors,
// keyed by the joined heights. A line across door 59 is a fact about the state where 59 is at its
// OPEN height, and it can be cut now, checked now, and read in microseconds when the ceiling
// actually lifts. That is what this writes.
//
// WHAT IT BAKES, and the three-leg shape is the point:
//
//   approach  anchor(section)  -> trigger      cut on the ALL-CLOSED hall, because that is the
//                                              hall you walk to the trigger in
//   crossing  trigger          -> across       cut on the ONE-DOOR-OPEN hall, because that is the
//                                              only hall the crossing exists in
//   landing   across           -> anchor(next) cut on the ALL-CLOSED hall again: the ceiling comes
//                                              back down behind you and the rest of the walk is
//                                              in the shut hall
//
// Plus the two errands anybody is ever in here for: section 0's anchor to the EXIT square, and
// section 4's anchor to each of the three CHEST squares.
//
// AND THE THING THAT NEARLY MADE THIS BAKE WORTHLESS. `m59-railcut`'s flood takes the caller's
// own edge test, and the obvious one — `traceFineMoveClient`, the mover's trace, which every other
// caller here uses — CANNOT SEE A CEILING DOOR. On door 59's barrier the fine trace accepts the
// step with the ceiling on the floor; so does `path` between the two squares, because A* simply
// routes around the blocked edge locally. Only `moverStepLands`, which reads the step mask the
// ceiling state rewrites, refuses it. So an edge built the usual way cuts rails straight through
// shut doors and the error is INVISIBLE: the rail verifies, because verification uses the same
// blind test, the file looks right, and the body refuses to move. The edge below is both tests.
//
// A COORDINATE CARRIES ITS UNIT. Landmarks are written `rNcM` for people; the rails are CLIENT
// units (1024 to a square), because that is what the mover and `m59-railcut` speak. See
// docs/m59-coordinates.md.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomGeometry, applySectorHeights } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { cutRail, verifyRail, snap, LATTICE } from './m59-railcut.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const MAP = join(REPO, 'substrate', 'm59-map.json');
const DOORS = join(REPO, 'substrate', 'm59-ceiling-doors.json');
export const RAILS = join(REPO, 'substrate', 'rail-714.json');
export const ROOM = 714;

// ---------------------------------------------------------------- the hall

// Straight out of m59-guild-passage.mjs, and deliberately NOT re-derived: if the passage's idea
// of where a trigger is and this bake's idea ever differ, the rail is a line to somewhere nobody
// stands. Same table, one source, and the test asserts they agree.
export const ANCHORS = [[2, 32], [5, 28], [17, 10], [7, 8], [18, 4]];
export const DOOR_TABLE = [
  { sector: 59, inward: [[3, 28], [5, 28]], outward: [[4, 28], [2, 28]] },
  { sector: 55, inward: [[19, 10], [17, 10]], outward: [[18, 10], [20, 10]] },
  { sector: 53, inward: [[13, 13], [11, 13]], outward: [[11, 13], [13, 13]] },
  { sector: 3, inward: [[7, 8], [7, 4]], outward: [[7, 4], [7, 8]], secret: true },
];
// The way out, and the three chests. `chest_keys` on the reagent-co-op policy names the same
// squares; they are written here in the same rNcM spelling the policy uses.
export const EXIT = [2, 33];
export const CHESTS = [[18, 2], [18, 6], [20, 4]];

/** `rNcM` -> [row, col]. The one spelling humans and the policy both use. */
export const parseSquare = (s) => {
  const m = /^r(\d+)c(\d+)$/i.exec(String(s).trim());
  if (!m) throw new Error(`not a square: "${s}" (want rNcM, e.g. r4c28)`);
  return [Number(m[1]), Number(m[2])];
};
export const sq = ([row, col]) => `r${row}c${col}`;
/** Square centre in CLIENT units. A square is 1024 and the centre is half of that. */
export const centre = ([row, col]) => ({ x: (col - 1) * 1024 + 512, y: (row - 1) * 1024 + 512 });

// ---------------------------------------------------------------- the geometry, per door state

let WORLD = null, DOORDATA = null;
function world() {
  if (!WORLD) { WORLD = JSON.parse(readFileSync(MAP, 'utf8')); attachStepMasks(WORLD); }
  return WORLD;
}
function doorData() {
  if (!DOORDATA) DOORDATA = JSON.parse(readFileSync(DOORS, 'utf8')).rooms[String(ROOM)];
  return DOORDATA;
}

/**
 * The hall with `open` naming the sectors whose ceiling is UP, everything else shut.
 *
 * THE STATE KEY IS THE JOINED HEIGHTS, NOT A BITMASK, and getting that wrong is silent: an absent
 * key would read as "no such hall" and every rail across it would come back unreachable, which is
 * indistinguishable from a locked door. So a missing key throws with the key it looked for.
 */
export function hallGeometry(open = []) {
  const d = doorData();
  const wanted = new Set(open.map(Number));
  // AN UNKNOWN DOOR MUST NOT READ AS "ALL SHUT". Without this, `hallGeometry([58])` when the hall
  // has no door 58 returns the closed hall and every rail across it comes back unreachable — which
  // is indistinguishable from a door that cannot be opened, and is a fact about the world nobody
  // would think to question.
  const known = new Set(d.doors.map(dr => Number(dr.id)));
  const strange = [...wanted].filter(id => !known.has(id));
  if (strange.length)
    throw new Error(`room ${ROOM} has no door(s) ${strange.join(', ')} ` +
                    `(it has ${[...known].join(', ')}); refusing to hand back the shut hall, ` +
                    'which would read as "unreachable" rather than as a typo');
  const key = d.doors.map(dr => (wanted.has(Number(dr.id)) ? dr.open : dr.closed)).join(',');
  const state = d.states[key];
  if (!state) throw new Error(`no baked sector-height state for doors-open [${open.join(',')}] ` +
                              `(looked for "${key}"; the file holds ${Object.keys(d.states).length})`);
  const geo = RoomGeometry.fromJSON(world().rooms[String(ROOM)].roo);
  const mask = Buffer.from(state.mask, 'base64');
  applySectorHeights(geo, state.sectors, { mask });
  geo.attachStepMask(mask);
  return { geo, key };
}

// THE FINE TRACE DOES NOT MODEL A CEILING DOOR, AND ON ITS OWN IT CUTS RAILS STRAIGHT THROUGH
// SHUT ONES. Measured here, 2026-09-18, on door 59's outward crossing:
//
//     r4c28 -> r2c28   geo.path()                shut = FALSE   door 59 open = true
//     r4c28 -> r2c28   geo.traceFineMoveClient() shut = true    door 59 open = true
//
// The two authorities disagree, and they disagree in the direction that matters: the fine trace
// says yes to a doorway whose ceiling is on the floor. That is consistent with what this
// repository already knows — the server is two-dimensional and every height rule is the client's
// — but `traceFineMoveClient` models the FLOOR's 24-unit step limit, not headroom, and a ceiling
// door is entirely a headroom fact. `geo.path()` reads the step mask, which the ceiling state
// rewrites, so it is the one that knows.
//
// So the edge is BOTH, and neither is redundant. The fine trace is what stops a rail crossing a
// ledge the coarse grid calls walkable — "THE FINE GRID IS THE REALITY. A SQUARE IS A SUMMARY" —
// and the coarse path is what stops it walking under a shut ceiling. A rail cut on either one
// alone is wrong in a way nothing downstream can detect, because both failures present as the
// mover simply refusing.
//
// THE COARSE HALF IS `moverStepLands`, AND IT TOOK THREE TRIES TO GET THE AUTHORITY RIGHT.
// Measured on door 59's barrier, which sits between r4c28 and r3c28:
//
//     shut        door 59 open
//     -------     ------------
//     true        true          traceFineMoveClient  — never sees the ceiling
//     true        true          path(r3c28, r2c28)   — A* routes locally AROUND it
//     FALSE       true          moverStepLands(r4c28, r3c28)  — reads the step mask
//
// `path` between two ADJACENT squares is not a barrier test: the search finds a way round the
// blocked edge inside the neighbourhood and answers "found", so an edge built on it is a no-op.
// `moverStepLands` is the square-to-square test the mover itself enforces, and the ceiling state
// rewrites the step mask it reads. CLAUDE.md already names it: "the router must plan on the map
// the mover enforces (`moverStepLands`, not `stepAllowedByCollision`)". It is the same sentence,
// arriving through a ceiling instead of a cliff.
//
// It is cached per ordered square pair anyway: the flood crosses the same handful of square
// boundaries thousands of times.
const squareOf = (p) => [Math.floor(p.y / 1024) + 1, Math.floor(p.x / 1024) + 1];
export const edgeOf = (geo) => {
  const lands = new Map();
  const crosses = (a, b) => {
    const [ar, ac] = squareOf(a), [br, bc] = squareOf(b);
    if (ar === br && ac === bc) return true;          // inside one square, the fine trace decides
    const k = `${ar},${ac}>${br},${bc}`;
    if (!lands.has(k)) {
      let ok = false;
      try { ok = !!geo.moverStepLands(ar, ac, br, bc); } catch { ok = false; }
      lands.set(k, ok);
    }
    return lands.get(k);
  };
  return (a, b) => {
    try {
      const t = geo.traceFineMoveClient(a.x, a.y, b.x, b.y);
      if (!(t && (t.ok ?? t.moved ?? t.arrived))) return false;
    } catch { return false; }
    return crosses(a, b);
  };
};
const floorOf = (geo) => (x, y) => {
  try { const l = geo.leafAtClient(x, y); return l?.sector ? geo.floorBaseAtClient(x, y, l) : null; }
  catch { return null; }
};

/** Cut one leg and say, in one object, everything needed to believe or disbelieve it. */
export function cutLeg(from, to, { open = [], geo = null, key = null } = {}) {
  const g = geo ?? hallGeometry(open).geo;
  const k = key ?? hallGeometry(open).key;
  const edge = edgeOf(g);
  const a = centre(from), b = centre(to);
  const cut = cutRail(a, b, { edge, bounds: { w: g.cols * 1024, h: g.rows * 1024 },
                              floorAt: floorOf(g), lattice: LATTICE });
  const leg = { from: sq(from), to: sq(to), doors_open: open, state_key: k,
                ok: cut.ok, legs: cut.legs ?? null, visited: cut.visited };
  if (!cut.ok) {
    leg.why = cut.why;
    // WITHOUT THE PHASE, "not reached" AND "unreachable" ARE THE SAME SENTENCE. A 64-unit flood
    // from a seed at x mod 64 = 48 can never land on a goal at x mod 64 = 0; the first cut of the
    // room-49 rail lost an hour to exactly that. Square centres are 512 mod 1024, so both ends are
    // 0 mod 64 here and the phases always agree — which is worth recording rather than assuming.
    leg.phase = { from: { x: a.x % LATTICE, y: a.y % LATTICE }, to: { x: b.x % LATTICE, y: b.y % LATTICE } };
    leg.seed = cut.seed; leg.target = cut.target;
    return leg;
  }
  leg.waypoints = cut.waypoints;
  const v = verifyRail(cut.waypoints, { edge, lattice: LATTICE });
  leg.verified = v?.ok ?? null;
  if (v && v.ok === false) leg.verify = v;
  return leg;
}

/** Every leg this hall needs, in the order the passage walks them. */
export function plan() {
  const legs = [];
  const push = (kind, from, to, open, note) => legs.push({ kind, from, to, open, note });

  for (let i = 0; i < DOOR_TABLE.length; i++) {
    const d = DOOR_TABLE[i];
    const before = ANCHORS[i], after = ANCHORS[i + 1];
    const [inTrigger, inAcross] = d.inward, [outTrigger, outAcross] = d.outward;
    const tag = `door ${d.sector}${d.secret ? ' (secret — spoken, not stepped)' : ''}`;
    // INWARD: deeper into the hall.
    push('approach', before, inTrigger, [], `${tag} inward: walk to the trigger, hall shut`);
    push('crossing', inTrigger, inAcross, [d.sector], `${tag} inward: cross while the ceiling is up`);
    push('landing', inAcross, after, [], `${tag} inward: on to the next anchor, hall shut again`);
    // OUTWARD: back towards the door, and towards the exit. This is the direction that stranded
    // Zoot for an hour, and it is the one nothing had a baked answer for.
    push('approach', after, outTrigger, [], `${tag} outward: walk to the trigger, hall shut`);
    push('crossing', outTrigger, outAcross, [d.sector], `${tag} outward: cross while the ceiling is up`);
    push('landing', outAcross, before, [], `${tag} outward: on to the previous anchor, hall shut`);
  }
  push('exit', ANCHORS[0], EXIT, [], 'the hall\'s only `go` exit, to North Barloque (101)');
  push('exit', EXIT, ANCHORS[0], [], 'and back in from the doorway');
  for (const c of CHESTS) {
    push('chest', ANCHORS[4], c, [], `guild chest at ${sq(c)}`);
    push('chest', c, ANCHORS[4], [], `back from the chest at ${sq(c)}`);
  }
  return legs;
}

export function bake({ onLeg = null } = {}) {
  // One geometry per door state, built once. Thirty-odd floods against four geometries, not
  // thirty-odd geometries.
  const cache = new Map();
  const geoFor = (open) => {
    const id = open.join(',');
    if (!cache.has(id)) cache.set(id, hallGeometry(open));
    return cache.get(id);
  };
  const out = [];
  for (const p of plan()) {
    const { geo, key } = geoFor(p.open);
    const leg = cutLeg(p.from, p.to, { open: p.open, geo, key });
    leg.kind = p.kind; leg.note = p.note;
    out.push(leg);
    onLeg?.(leg);
  }
  return { version: 1, room: ROOM, lattice: LATTICE, cut: new Date().toISOString(),
           anchors: ANCHORS.map(sq), exit: sq(EXIT), chests: CHESTS.map(sq),
           doors: DOOR_TABLE.map(d => ({ sector: d.sector, secret: !!d.secret })),
           legs: out };
}

/** The baked leg for a pair, or null. What the passage asks at runtime. */
export function railFor(baked, from, to) {
  const f = typeof from === 'string' ? from : sq(from), t = typeof to === 'string' ? to : sq(to);
  return (baked?.legs ?? []).find(l => l.from === f && l.to === t && l.ok) ?? null;
}

// ---------------------------------------------------------------- cli

const isMain = !!process.argv[1] &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cmd = process.argv[2] ?? 'show';
  const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
  const load = () => existsSync(RAILS) ? JSON.parse(readFileSync(RAILS, 'utf8')) : null;
  const line = (l) => `  ${l.ok ? 'ok  ' : 'FAIL'} ${l.kind.padEnd(8)} ${l.from.padEnd(7)} -> ` +
    `${String(l.to).padEnd(7)} ${l.ok ? `${l.legs} legs` : l.why}` +
    `${l.doors_open?.length ? `  [door ${l.doors_open.join(',')} open]` : ''}` +
    `${l.verified === false ? '  VERIFY FAILED' : ''}`;

  if (cmd === 'bake') {
    const baked = bake({ onLeg: (l) => console.log(line(l)) });
    writeFileSync(RAILS, JSON.stringify(baked, null, 1));
    const bad = baked.legs.filter(l => !l.ok);
    console.log(`\n${baked.legs.length - bad.length}/${baked.legs.length} legs cut -> ${RAILS}`);
    if (bad.length) {
      console.log(`${bad.length} could not be cut. A leg that will not cut is a fact about the ` +
                  `hall, not a bug in the bake — read the door state it was cut under:`);
      for (const l of bad) console.log(`   ${l.from} -> ${l.to} under "${l.state_key}": ${l.why}`);
    }
    process.exit(bad.length ? 1 : 0);
  }

  else if (cmd === 'show' || cmd === 'check') {
    const baked = load();
    if (!baked) { console.error(`nothing baked yet at ${RAILS} — run: m59-guildrails.mjs bake`); process.exit(2); }
    console.log(`rail-${baked.room} cut ${baked.cut}, lattice ${baked.lattice}`);
    console.log(`  anchors ${baked.anchors.join(' ')}   exit ${baked.exit}   chests ${baked.chests.join(' ')}`);
    for (const l of baked.legs) console.log(line(l));
    if (cmd === 'check') {
      // RE-VERIFY AGAINST THE MAP ON DISK, not against the file's own claim. A bake is evidence
      // about a map, and the map moves.
      let bad = 0;
      const cache = new Map();
      for (const l of baked.legs.filter(x => x.ok)) {
        const id = (l.doors_open ?? []).join(',');
        if (!cache.has(id)) cache.set(id, hallGeometry(l.doors_open ?? []));
        const v = verifyRail(l.waypoints, { edge: edgeOf(cache.get(id).geo), lattice: baked.lattice });
        if (v && v.ok === false) { bad++; console.log(`  STALE ${l.from} -> ${l.to}: ${JSON.stringify(v).slice(0, 150)}`); }
      }
      console.log(bad ? `\n${bad} baked leg(s) no longer walk on the map on disk — re-bake`
                      : '\nevery baked leg still walks on the map on disk');
      process.exit(bad ? 1 : 0);
    }
  }

  else if (cmd === 'probe') {
    const from = parseSquare(process.argv[3]), to = parseSquare(process.argv[4]);
    const open = String(arg('door', '') || '').split(/[\s,]+/).filter(Boolean).map(Number);
    const leg = cutLeg(from, to, { open });
    console.log(JSON.stringify({ ...leg, waypoints: leg.waypoints ? `[${leg.waypoints.length} points]` : undefined }, null, 1));
    process.exit(leg.ok ? 0 : 1);
  }

  else {
    console.error('usage: m59-guildrails.mjs bake | show | check | probe rNcM rNcM [--door 59]');
    process.exit(2);
  }
}
