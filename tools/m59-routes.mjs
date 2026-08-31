#!/usr/bin/env node
// THE BAKED EXIT-TO-EXIT ROUTES, READ BACK.
//
//   node tools/m59-routes.mjs                 what is baked, and whether it is current
//   node tools/m59-routes.mjs --verify        every baked route re-walked against the grid
//   node tools/m59-routes.mjs --room 150      one room's anchors and routes
//
// Written by tools/m59-routebake.mjs. This is the read side: a lookup, and the checks that
// decide whether the lookup may be trusted at all.
//
// STALE IS WORSE THAN ABSENT, and that is the whole reason this file is not four lines.
// A routing table baked against a different map is a set of confident answers about a
// world that has changed — a character walking a route through a wall that was a door when
// the bake ran. So the table carries the geometry manifest it was built from, and it is
// refused outright unless that matches the map in play. Absent means "work it out", which
// is exactly what the router did before any of this existed.
//
// SERIALIZED COORDINATE CONTRACT: m59-routes/1 route/reach keys are
// `row,col>row,col`, pivot arrays are `[row,col]`, and direction deltas are
// `(dr,dc)`. Readers restore named `{row,col}` objects; do not migrate by swapping.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES_FILE, replay, BAKE_VERSION } from './m59-routebake.mjs';
import { sharedRoomGeometry, peekSharedRoomGeometry, STEP_MASK_VERSION } from './m59-roo.mjs';
import { registerLazyRoomArtifacts } from './m59-room-artifacts.mjs';

let cache = { mtime: -1, value: null };

function load() {
  const file = ROUTES_FILE();
  let mtime = 0;
  try { mtime = existsSync(file) ? statSync(file).mtimeMs : 0; } catch { mtime = 0; }
  if (cache.mtime === mtime) return cache.value;
  let value = null;
  if (mtime) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      value = (raw && raw.format === 'm59-routes/1' && raw.rooms) ? raw : null;
    } catch { value = null; }
  }
  cache = { mtime, value };
  return value;
}

/**
 * The table, but only if it was built from the map now in play.
 *
 * `mapManifest` is the map's own geometryManifestSha256. A table with no manifest, or one
 * that disagrees, is refused — see the note at the top.
 */
export function routesFor(mapManifest) {
  const t = load();
  if (!t) return null;
  if (!t.geometryManifestSha256 || !mapManifest) return null;
  if (t.geometryManifestSha256 !== mapManifest) return null;
  return t;
}

/**
 * Was this table's mask built by the predicate this build reads it with?
 *
 * THE MANIFEST CANNOT ANSWER THIS AND THAT IS THE WHOLE PROBLEM. It hashes the GEOMETRY,
 * so a table baked by older code against an unchanged map passes every check here and is
 * attached without a word — while every bit in it encodes a question nobody is asking any
 * more. When `moverStepLands` stopped gating on the server's coarse grid, that would have
 * kept the fleet out of hundreds of steps per room, silently, on a table that verified.
 *
 * A mismatch is NOT an error. It degrades to "plan on the coarse grid", which is exactly
 * what a checkout that has never run the bake does, and it says so — because the fix is a
 * rebake and the operator has to be told that rather than left to wonder.
 */
export function stepMaskCurrent(table) {
  return (table?.stepMaskVersion ?? 1) === STEP_MASK_VERSION;
}

/** May a lazy process trust this bake for compact topology and deferred masks? */
export function lazyRoomArtifactsCurrent(table) {
  return !!table && stepMaskCurrent(table) && table.complete === true &&
         Number(table.bakeVersion) === BAKE_VERSION;
}

/**
 * Hand every baked step mask to the geometry that will be planning on it.
 *
 * THIS IS THE ONE CALL THAT CHANGES HOW THE FLEET WALKS. Without it the router plans on
 * the server's coarse one-byte-a-square grid while the mover enforces the client's BSP,
 * and those disagree: measured across the twelve boundaries the exit-gap record complains
 * about most, 59% of walks to an exit ended with a character sliding along a wall,
 * replanning into the same wall, and giving up. With it, `neighbors({collision:true})` is
 * an array index and the router plans the steps the mover will actually make.
 *
 * REFUSED WHOLESALE IF THE MAP HAS MOVED, by the same manifest check as the routes: a mask
 * baked against different geometry is a confident map of the wrong doors. And refused per
 * room if the dimensions disagree, because a mask off by one row would never be noticed.
 *
 * Returns what it did rather than throwing. A missing or stale table is not an error — it
 * means "plan on the grid, exactly as this repository did before any of this existed" —
 * so a fresh clone that has never run the bake behaves precisely as it always has.
 */
// THE TABLE THIS PROCESS IS ACTUALLY PLANNING ON, or null.
//
// Set by `attachStepMasks` and by nothing else, so it is the table that passed the
// manifest check rather than whatever happens to be on disk. `null` is the ordinary answer
// in any tool that never attached masks, and every reader must treat it as "work it out
// live" — the table only ever held the common case, and a checkout that has never run the
// bake has to behave exactly as it did before the bake existed.
// AND IT IS AN ACCESSOR RATHER THAN A FIELD ON THE SUMMARY, which is not a style choice.
// `attachStepMasks` returns a small object that half a dozen tools print verbatim; putting
// the table on it turned `step masks: {...}` into a 1.5 MB dump of base64 masks in every
// one of them at once. A summary is something people look at.
let attachedTable = null;
export const activeRoutes = () => attachedTable;

export function attachStepMasks(map, { geometryOf, lazy = false } = {}) {
  const table = routesFor(map?.geometryManifestSha256 ?? null);
  if (!table) return { attached: 0, rooms: 0, ok: false,
                       why: load() ? 'the routing table was baked from different geometry'
                                   : 'no routing table — run node tools/m59-routebake.mjs' };
  // `rooms` is what the TABLE holds and `masked` is how many of those carry the payload.
  // Two counters rather than one, because "the table is empty" and "the table predates
  // step masks" are different problems with different fixes, and a single counter told
  // the second story with the first one's words.
  attachedTable = table;
  // A MASK FROM A DIFFERENT PREDICATE IS WORSE THAN NO MASK, so it is refused wholesale.
  // See stepMaskCurrent: the manifest hashes GEOMETRY and cannot see the predicate change,
  // so such a table verifies perfectly while encoding the wrong doors.
  //
  // REFUSED, BUT NOT SHORT-CIRCUITED — this loop is how several callers BUILD their
  // geometry. `geometryOf` is not only a lookup, it is a constructor with a cache behind
  // it (m59-stringpull-test, m59-overlay, m59-highlight, m59-hoptest and m59-provewall all
  // populate a Map from inside it), so returning early left every one of them holding an
  // empty cache and a TypeError. Refusing to attach is the decision; not visiting the
  // rooms was an accident of where the decision was made.
  const stale = !stepMaskCurrent(table);
  // LAB-ONLY OPT-IN. A partial/old bake is not an authority for topology, and a custom
  // geometryOf callback is documented construction work whose eager visits must be kept.
  // When any gate fails we deliberately fall through to the old eager loop below.
  const lazyEligible = lazy === true && !geometryOf && lazyRoomArtifactsCurrent(table);
  if (lazyEligible) {
    let attached = 0, deferred = 0, refused = 0, masked = 0;
    let topologyRooms = 0, topologyAnchors = 0;
    const rooms = Object.keys(table.rooms).length;
    for (const [num, baked] of Object.entries(table.rooms)) {
      if (typeof baked?.stepMask === 'string') masked++;
      const room = map?.rooms?.[num] ?? map?.rooms?.[Number(num)];
      if (!room?.roo) continue;
      const registration = registerLazyRoomArtifacts(room, baked);
      if (!registration.registered) {
        if (registration.refused) refused++;
        continue;
      }
      topologyRooms++;
      topologyAnchors += registration.topology;
      if (registration.refused) refused++;
      if (!registration.deferred) continue;
      // Preserve correctness when a room was decoded before this opt-in call: attaching
      // must still happen now, but peeking prevents this branch from constructing it.
      if (peekSharedRoomGeometry(room)) {
        const geometry = sharedRoomGeometry(room);
        if (geometry?.hasStepMask) attached++;
        else refused++;
      } else deferred++;
    }
    return {
      attached, deferred, rooms, masked, refused, ok: attached + deferred > 0,
      view: table.view ?? 'grid', lazy: true,
      topology_rooms: topologyRooms, topology_anchors: topologyAnchors,
      ...(attached + deferred ? {} : { why: !rooms
        ? 'the routing table has no rooms in it'
        : !masked
          ? `the routing table has ${rooms} room(s) and no step masks — it predates them; ` +
            'rerun node tools/m59-routebake.mjs'
          : `${masked} step mask(s) on disk and none of them fit the map in play` }),
    };
  }
  let attached = 0, refused = 0, masked = 0;
  const rooms = Object.keys(table.rooms).length;
  for (const [num, baked] of Object.entries(table.rooms)) {
    if (typeof baked?.stepMask !== 'string') continue;
    masked++;
    const room = map?.rooms?.[num] ?? map?.rooms?.[Number(num)];
    if (!room?.roo) continue;
    const geometry = geometryOf ? geometryOf(room) : sharedRoomGeometry(room);
    if (!geometry) continue;
    if (stale) continue;                 // geometry built above; the mask is not trusted
    const bytes = Buffer.from(baked.stepMask, 'base64');
    if (geometry.attachStepMask(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)))
      attached++;
    else refused++;
  }
  // A TABLE WITH NO MASKS IN IT IS ITS OWN ANSWER, and it is one somebody will actually
  // hit: every table baked before masks existed has all 264 rooms, matches the manifest,
  // and carries nothing the router can use. "No routing table" would send them looking for
  // a file that is sitting right there.
  if (stale)
    return { attached: 0, rooms, masked, refused: 0, ok: false, view: table.view ?? 'grid',
             lazy: false,
             why: `the routing table's step masks were baked by an older predicate ` +
                  `(v${table.stepMaskVersion ?? 1}, this build reads v${STEP_MASK_VERSION}) — ` +
                  `rerun node tools/m59-routebake.mjs` };
  return { attached, rooms, masked, refused, ok: attached > 0, view: table.view ?? 'grid',
           lazy: false,
           ...(attached ? {} : { why: !rooms
             ? 'the routing table has no rooms in it'
             : !masked
               ? `the routing table has ${rooms} room(s) and no step masks — it predates them; ` +
                 'rerun node tools/m59-routebake.mjs'
               : `${masked} step mask(s) on disk and none of them fit the map in play` }) };
}

/** Is this room's exit set split by geometry, and into how many reachable groups? */
export function regionsOf(table, roomNum) {
  const r = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
  if (!r) return null;
  return { regions: r.regions, anchors: r.anchors, view: r.view ?? 'grid' };
}

/**
 * A baked path between two squares, as steps, or null.
 *
 * Null is the ordinary answer for anything that is not an exit-to-exit trip, and callers
 * must treat it as "work it out yourself" rather than as "there is no route" — the table
 * only ever held the common case.
 */
export function bakedPath(table, roomNum, from, to) {
  const r = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
  if (!r) return null;
  // SERIALIZED CONTRACT: route keys and pivot pairs are `row,col`; callers and
  // results use named `{row,col}` objects. Do not transpose this persisted format.
  const key = `${from.row},${from.col}>${to.row},${to.col}`;
  // THE PIVOTS, WHEN THEY ARE THERE. THEY ALWAYS WERE, AND NOTHING EVER READ THEM.
  //
  // `routes` is one letter per SQUARE, and `followRail` sends one validated move per square
  // of what this returns. So a crossing of Ukgoth was 117 packets covering one square each —
  // which is the "more packets than a person, less ground" this repository measured from the
  // client source and then did anyway.
  //
  // The bake already string-pulled every one of these routes and stored the result beside
  // it. For that same Ukgoth crossing:
  //
  //     routes["1,66>71,2"]   117 squares, one letter each
  //     pivots["1,66>71,2"]    17 squares — [1,66] [6,65] [7,64] [20,51] [23,51] ...
  //
  // `[7,64] -> [20,51]` is a THIRTEEN SQUARE leg. Seventeen moves instead of a hundred and
  // seventeen, on a line the bake proved when it computed it.
  //
  // Safe because nothing downstream trusts this blindly: `followRail` validates every move
  // it sends and falls back to the fine walker on a refusal, so an `unverified` pivot costs
  // one refused packet and a short walk rather than a wrong crossing. The per-square replay
  // stays as the answer when a route has no pivots baked.
  // CAPPED AT WHAT THE CLIENT ITSELF COVERS IN ONE PACKET, WHICH IS ABOUT FIVE SQUARES.
  //
  // Raw pivots go up to twenty-four squares in Ukgoth, and `followRail` sends each leg as a
  // single validated move with `walkFine` as the fallback. A twenty-four square move is
  // refused far more often than it lands, and the fine walker then gropes the whole gap:
  //
  //     raw pivots      850 moves, 142 sent, 708 refused   0.54 sent/s
  //     per-square      463 moves, 395 sent,  68 refused   1.83 sent/s
  //
  // The pivots were right about the ROUTE and wrong about the packet. So the long legs are
  // subdivided along their own straight line — every intermediate point is on a segment the
  // bake already proved, so this adds no new claim about the geometry, only more chances to
  // land one.
  const CAP = 5;
  // SUBDIVIDE ALONG THE ROUTE, NEVER ALONG THE STRAIGHT LINE BETWEEN TWO PIVOTS.
  //
  // This used to cut a long leg by interpolating between its endpoints, on the argument
  // that "every intermediate point is on a segment the bake already proved". That argument
  // is wrong twice: `stringPull` leaves legs it could NOT prove (this room reports two),
  // and even on a proved leg the straight line is only known to ARRIVE — the points along
  // it were never asked about individually.
  //
  // What that cost, on 2026-08-24, with the route itself finally clean: pivot 29,50 in
  // Ukgoth is followed by pivot 29,20, thirty squares away, so the first aim out of 29,50
  // was the interpolated 29,45 — which is rock. `moverStepLands` waves it through, because
  // it gates on `standable`, and `standable` answers yes to all 4,686 squares in that room.
  // So the walker aimed into a rock face and stopped. Bbbb's postmortem: "doing: stalled,
  // moving: false", at 29,50, six of twenty health, eighteen attackers at once, killed by a
  // Guardian of Zjiria. The route was right and the packets were not.
  //
  // The per-square route is the thing that IS proved, square by square, and after bake v3
  // every square of it is ground the coarse grid agrees exists. So a long leg is filled in
  // from the route's own squares: the pivots stay as the anchors, and the points between
  // them are real places the bake walked rather than points on a line over the top of them.
  const pivots = r.pivots?.[key]?.squares;
  const spelled = r.routes?.[key];
  const squares = typeof spelled === 'string' ? replay(from.row, from.col, spelled) : null;
  if (Array.isArray(pivots) && pivots.length > 1 && squares?.length) {
    const indexOf = new Map();
    squares.forEach((sq, i) => {
      const k = `${sq.row},${sq.col}`;
      if (!indexOf.has(k)) indexOf.set(k, i);
    });
    const gap = (x, y) => Math.max(Math.abs(x.row - y.row), Math.abs(x.col - y.col));
    const out = [{ row: pivots[0][0], col: pivots[0][1] }];
    let usable = true;
    for (let i = 1; i < pivots.length && usable; i++) {
      const from2 = { row: pivots[i - 1][0], col: pivots[i - 1][1] };
      const to2 = { row: pivots[i][0], col: pivots[i][1] };
      if (gap(from2, to2) <= CAP) { out.push(to2); continue; }
      // `replay` returns the squares the path STEPS ONTO, so the start square is not in it
      // and the first pivot never will be. It is index -1 by construction, not a mismatch.
      const start = from2.row === from.row && from2.col === from.col;
      const ia = start ? -1 : indexOf.get(`${from2.row},${from2.col}`);
      const ib = indexOf.get(`${to2.row},${to2.col}`);
      // A pivot that is not ON the route it was pulled from means the two disagree, and a
      // guess between them is exactly what this exists to stop. Fall back to the route.
      if (ia === undefined || ib === undefined || ib <= ia) { usable = false; break; }
      let last = ia < 0 ? from2 : squares[ia];
      for (let j = ia + 1; j <= ib; j++) {
        if (gap(squares[j], last) >= CAP || j === ib) {
          out.push({ row: squares[j].row, col: squares[j].col });
          last = squares[j];
        }
      }
    }
    if (usable) return out;
  }
  if (!squares) return null;
  return squares;
}

/**
 * The baked square to stand on to leave `roomNum` for `toRoom`, or null.
 *
 * ASK BY DESTINATION, NOT BY DIRECTION — that distinction is the whole point of this
 * accessor. A wall can carry two exits to two different rooms, split by a row or column
 * condition (Western border of the Twisted Wood sends `row<19` to Main gate to the city of
 * Tos and `row>20` to The Twisted Wood, both eastward). A caller that asks "where do I
 * cross going east" gets a square that is right for one destination and silently wrong for
 * the other: the walk succeeds, every leg reports success, and the character is in the
 * wrong room. `exitAnchors` bakes one anchor per declared exit for exactly this reason, so
 * reading it back by direction would throw the distinction away again at the last step.
 *
 * `from_body` is not filtered here. An anchor the room's main body cannot reach is still
 * the right place to leave from — it is reported so a caller can prefer another exit, and
 * a bake must never be the reason a doorway disappears.
 */
export function anchorFor(table, roomNum, toRoom) {
  const r = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
  if (!r?.anchors) return null;
  const want = Number(toRoom);
  const hit = r.anchors.filter(a => Number(a.to) === want);
  if (!hit.length) return null;
  // Two declared exits to the SAME room is ordinary (The King's Way reaches 575 twice).
  // Prefer one the body can walk to; otherwise the first, which is still a real crossing.
  return hit.find(a => a.from_body) ?? hit[0];
}

/**
 * DID THE BAKE'S BFS JOIN THESE TWO EXIT SQUARES — regardless of whether it could spell the
 * steps. Returns true, false, or null when the table cannot say.
 *
 * This exists because `bakedPath` conflated two questions and one of them is the one
 * callers actually ask. A route is stored as one letter per step in the eight unit
 * directions, and a FALL is a single move of two or three squares, so any route containing
 * one cannot be written down and used to produce no entry at all. `bakedPath` then answered
 * null, and `m59-world.mjs` read that as "walking cannot join these exits".
 *
 * Ukgoth is where it was found: the 83-step route from the Castle Victoria doorway to the
 * Sentinel doorway BEGINS with a fall, 2,26 -> 5,23, so the whole crossing was refused by a
 * table that had walked it. Ask this when the question is "is there a way"; ask `bakedPath`
 * only when the question is "which squares".
 *
 * A table baked before this existed carries no `reach` map at all, and answers null rather
 * than false — "the table cannot say" and "the table says no" are different, and only the
 * first is safe to fall back from.
 */
export function anchorReach(table, roomNum, from, to) {
  const r = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
  if (!r) return null;
  // SERIALIZED CONTRACT: reach-map keys are `row,col>row,col`.
  if (!r.reach) return bakedPath(table, roomNum, from, to) ? true : null;
  return !!r.reach[`${from.row},${from.col}>${to.row},${to.col}`];
}

/**
 * WALKING, BLINKING, OR NEITHER — and the caller is told which, because they are not the
 * same offer.
 *
 * `anchorReach` answers about WALKING and its meaning must not drift: it is what the router
 * plans on and what `transitOk` refuses a hop over. This is the wider question, for a caller
 * that has already run out of walking answers.
 *
 * Blink teleports the caster to one fixed square per room (`viTeleport_row`/`col` in the kod)
 * from anywhere in the room, so every anchor that square can walk to is reachable from
 * anywhere a character can cast. It is NOT free — mana, possibly a rest to afford it, and a
 * cast that can fail and need repeating — which is exactly why this returns the word 'blink'
 * rather than folding it into a boolean. A caller that treats the two as interchangeable will
 * plan a route that needs a spell and report it as a walk.
 *
 * Measured over the whole map, this changes the answer in 8 rooms and in none of the rest.
 * West Jasper is the one that matters: a body entering from the north edge can walk to ONE of
 * seven doors and blink to all seven.
 *
 * Returns 'walk', 'blink', false, or null when the table cannot say.
 */
export function anchorReachVia(table, roomNum, from, to) {
  const walk = anchorReach(table, roomNum, from, to);
  if (walk) return 'walk';
  const r = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
  if (!r) return null;
  if (!r.blink?.reaches) return walk === null ? null : false;
  // The destination must be somewhere the blink point can walk to. Where we are standing does
  // not matter at all, which is the whole point of a portal you can cast from anywhere.
  return r.blink.reaches.includes(`${to.row},${to.col}`) ? 'blink' : (walk === null ? null : false);
}

/**
 * A baked route as PIVOTS — the corners a walker actually has to aim at — or null.
 *
 * Same contract as `bakedPath`: null means "the table does not cover this", never "there
 * is no route". The difference is what the caller then does with it. A route handed over
 * as 73 grid squares is 73 chances to end up somewhere the plan did not expect, because a
 * step that SLIDES lands off-plan and the walker replans from a square it never chose;
 * measured in the Western border of the Twisted Wood, 218 of 311 grid steps failed and 200
 * of those did not move the character at all. The same route as 21 pivots is 21 aimed
 * moves, each already checked offline to ARRIVE rather than slide.
 *
 * `unverified` counts the legs the string pull could not prove. They are still emitted —
 * the underlying grid route is real — but a caller that cares can fall back rather than
 * trust a long leg through geometry nobody confirmed.
 */
export function bakedPivots(table, roomNum, from, to) {
  const r = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
  // SERIALIZED CONTRACT: keys and stored pivot arrays are `row,col`; the return
  // value restores named `{row,col}` objects.
  const p = r?.pivots?.[`${from.row},${from.col}>${to.row},${to.col}`];
  if (!p?.squares?.length) return null;
  return { squares: p.squares.map(([row, col]) => ({ row, col })),
           unverified: p.unverified ?? 0 };
}

// A CLIENT REPORTS ITS POSITION ABOUT ONCE A SECOND, so what a room crossing COSTS is
// packets, not squares. Measured in Western border of the Twisted Wood, a six-route sample
// is 311 grid squares and 66 pivots; charging the squares overstates the trip by 4.7x and,
// worse, overstates it UNEVENLY — a long straight hall costs one pivot and a short
// switchback costs eight, so ranking candidate routes on square count prefers exactly the
// rooms that are slowest to walk.
const SECONDS_PER_PIVOT = 1.0;

/**
 * What crossing this room between these two exits should cost, in seconds, or null.
 *
 * Null means the table does not cover this pair, and a caller must read it as "no
 * estimate" rather than "free" — a zero here would make an unbaked room the most
 * attractive one on every route. This is an estimate of WALKING and nothing else: it
 * cannot know about a monster standing in a doorway, and it is not a promise.
 */
export function transitCost(table, roomNum, from, to) {
  const p = bakedPivots(table, roomNum, from, to);
  if (!p) return null;
  // The first pivot is where we already are, so the moves are the gaps between them.
  return { seconds: Math.max(0, p.squares.length - 1) * SECONDS_PER_PIVOT,
           pivots: p.squares.length, unverified: p.unverified };
}

/** Can walking join these two exits at all? `null` when the table cannot say. */
export function sameRegion(table, roomNum, a, b) {
  const r = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
  if (!r) return null;
  const find = s => r.anchors.find(x => x.row === s.row && x.col === s.col);
  const x = find(a), y = find(b);
  if (!x || !y || x.region < 0 || y.region < 0) return null;
  return x.region === y.region;
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const val = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const t = load();
  if (!t) { console.error(`no usable table at ${ROUTES_FILE()} — run node tools/m59-routebake.mjs`); process.exit(1); }

  const { loadMap } = await import('./m59-map.mjs');
  const { movementMapFile } = await import('./m59-map-path.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const map = loadMap(movementMapFile());
  const current = t.geometryManifestSha256 === map.geometryManifestSha256;

  if (val('--room')) {
    const n = Number(val('--room'));
    const r = t.rooms[n] ?? t.rooms[String(n)];
    if (!r) { console.error(`room ${n} is not in the table`); process.exit(1); }
    console.log(`room ${n} — ${r.rows}x${r.cols}, ${r.regions} region(s), view ${r.view ?? 'grid'}`);
    for (const a of r.anchors)
      console.log(`  ${a.kind.padEnd(5)} ${(a.dir ?? '').padEnd(6)} to ${String(a.to ?? '?').padEnd(6)}` +
                  ` at ${a.col},${a.row}  region ${a.region}`);
    console.log(`  ${Object.keys(r.routes).length} baked route(s)`);
    process.exit(0);
  }

  if (argv.includes('--verify')) {
    // EVERY STORED ROUTE RE-WALKED. A path is only worth having if each step is one the
    // grid actually permits and it lands exactly on the square it claims — a table that
    // is subtly wrong is worse than none, because nothing downstream re-checks it.
    // CHECK WITH THE PREDICATE THE TABLE WAS BAKED WITH, NOT THE OTHER ONE.
    //
    // This used to ask `walkable()` — the COARSE one-byte grid — of every step. A table
    // baked with `view: collision` is planned on the MOVER's fine BSP view, and the whole
    // reason that view exists is that the two disagree: a safe wall IS the disagreement,
    // measured, and there are 17,402 squares world-wide where they differ. So a
    // collision-view route legitimately steps on squares the coarse grid calls solid, and
    // checking one against the other reports a healthy table as broken.
    //
    // MEASURED, on the table in play: 1358 of 16293 routes "invalid" by the coarse
    // predicate and ZERO by the mover's. Every one of those 1358 was a false alarm — and
    // they were not harmless. They were read as "we have baked routes that walk through
    // solid rock", which is the opposite of what the table says and sent an investigation
    // into rewriting a bake that was correct.
    //
    // This is the same two-maps mistake the router itself was fixed for, committed one
    // layer up in the tool that is supposed to catch it. A verifier that checks the wrong
    // predicate does not merely fail to find bugs; it manufactures them.
    const strict = !argv.includes('--coarse');
    const view = t.view ?? 'grid';
    // A grid-view table really is a grid artifact and must be checked as one.
    const useMover = strict && view === 'collision';
    let checked = 0, bad = 0, badRooms = new Set();
    for (const [num, r] of Object.entries(t.rooms)) {
      const room = map.rooms[num] ?? map.rooms[Number(num)];
      if (!room?.roo) continue;
      const g = sharedRoomGeometry(room);
      for (const [pair, path] of Object.entries(r.routes)) {
        const [a, b] = pair.split('>');
        const [fr, fc] = a.split(',').map(Number);
        const [tr, tc] = b.split(',').map(Number);
        const steps = replay(fr, fc, path);
        checked++;
        let ok = steps.length > 0;
        let pr = fr, pc = fc;
        for (const s of steps) {
          const legal = useMover
            ? g.moverStepLands(pr, pc, s.row, s.col)
            : (g.walkable(s.row, s.col) &&
               Math.abs(s.row - pr) <= 1 && Math.abs(s.col - pc) <= 1);
          if (!legal) { ok = false; break; }
          pr = s.row; pc = s.col;
        }
        if (ok && (pr !== tr || pc !== tc)) ok = false;
        if (!ok) { bad++; badRooms.add(num); }
      }
    }
    console.log(`re-walked ${checked} baked route(s) against the ` +
                `${useMover ? 'MOVER (moverStepLands)' : 'coarse grid (walkable)'} predicate` +
                ` — table view "${view}"`);
    console.log(`  ${checked - bad} valid, ${bad} invalid` +
                (bad ? ` across ${badRooms.size} room(s)` : ''));
    if (!useMover && view === 'collision')
      console.log('  --coarse asked for the grid predicate on a collision table: expect ' +
                  'false alarms wherever the two views disagree, which is where safe walls are');
    process.exit(bad ? 1 : 0);
  }

  const rooms = Object.values(t.rooms);
  const routes = rooms.reduce((n, r) => n + Object.keys(r.routes).length, 0);
  console.log(`${rooms.length} room(s), ${routes} baked route(s), view ${t.view ?? 'grid'}`);
  console.log(`built ${t.builtAt}`);
  console.log(current ? 'manifest MATCHES the map in play — the table is usable'
                      : 'manifest DOES NOT match the map in play — the table is refused, ' +
                        'run node tools/m59-routebake.mjs');
  // NOT "REGIONS", AND NOT "BLINK". This line used to count rooms whose exits fall in more
  // than one region and call those unwalkable. Both halves were wrong. A region is a
  // strongly connected component, and an exit square is very often a pocket BY DESIGN —
  // you step into the doorway and cannot step back off it — so "more than one region" is
  // the normal shape of a room with two doors in it. What can be said is one-directional:
  // how many exits the body of the room cannot walk to. Even that is a claim about this
  // MODEL, which is stricter than the client it models; the one place in the world
  // genuinely joined only by blink is the Cragged Mountains cliff (578, 598).
  const masked = rooms.filter(r => typeof r.stepMask === 'string').length;
  console.log(`${masked} room(s) carry a step mask — the part the router actually plans on`);
  const stranded = rooms.reduce((n, r) => n + (r.stranded_exits ?? 0), 0);
  const anchors = rooms.reduce((n, r) => n + r.anchors.length, 0);
  const pockets = rooms.reduce((n, r) => n + (r.pockets ?? 0), 0);
  console.log(`${pockets} pocket(s) off the main body across the world — these are the ` +
              `safe-spot candidates, not damage`);
  console.log(`${stranded} of ${anchors} exit anchor(s) this model cannot walk to from ` +
              `their own room's body — go and look before believing any one of them`);
}
