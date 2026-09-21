// EVERY BODY'S PATH THROUGH EVERY ROOM, RECORDED, STRAIGHTENED, AND REUSABLE.
//
// The fleet crosses the same rooms hundreds of times a day and learns nothing from any of
// it. Every trip re-derives the route, rediscovers the same doorway by walking at the wrong
// squares first, and throws the whole traversal away on arrival. Meanwhile the one thing
// that would settle every argument in this repository — where a body ACTUALLY went, in fine
// coordinates, on a walk that worked — is available on every move packet and is not kept.
//
// WHY A RECORDED TRAIL BEATS A PLANNED ROUTE, AND IT IS NOT A MATTER OF TASTE. A plan is a
// claim about a lattice: `path()` searches square to square and `moverStepLands` asks
// whether a body standing on one square's STAND POINT lands on the next one's. A body that
// has actually walked somewhere is not a claim at all — it cannot contain a step the mover
// refuses, because it was made of accepted moves. That is the exact failure this repository
// has been chasing all day: plans expressed on stand points the body never occupies.
//
// AND IT IS NOT ONLY OUR OWN BODIES. `BP_MOVE` carries every object the room can see, so a
// character standing in a room is an instrument for everyone in it — other fleet members, a
// proxied human, a stranger, a monster. That is what makes this serve formations as well as
// travel: a formation is several trails with one clock.
//
// WHAT STRAIGHTENING IS. A recorded trail is what somebody did, which includes the wandering,
// the dodging and the standing still. Three passes turn it into a route:
//
//   * DROP THE STANDING STILL. A sample a body did not move between is not a waypoint.
//   * ELIDE THE LOOPS. A trail that returns to a place did a round trip in between, and the
//     round trip is not part of the route. Same argument as the breadcrumb retreat, and the
//     same function would do if trails were squares — these are fine points, so the key is
//     the point rather than the square.
//   * PULL THE STRING AGAINST THE REAL GEOMETRY. Most of a route is straight line, and a
//     line is only takeable if the mover says it is. Raycast each candidate leg with
//     `traceFineMoveClient` and keep the furthest one that lands; what survives is the
//     corners the geometry actually requires. This is where a forty-sample crossing becomes
//     four waypoints, and it is the difference between replaying a walk and replaying a
//     ROUTE.
//
// The straightened result is checked, not assumed: every leg it keeps was proved by a
// raycast against the same BSP the mover enforces, so a track cannot be a shortcut through
// a wall even if the body that made it was pushed through one by lag.
//
// LEDGER COORDINATES. Recorded point fields x/y are protocol/KOD fine coordinates,
// 64 units per square. Optional named col/row fields are 1-based squares; object
// property order has no tuple meaning.
// Geometry raycasts temporarily convert points to client/BSP units; persisted and
// returned trail points remain in protocol units.
import fs from 'node:fs';
import path from 'node:path';
import { constants as bufferConstants } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { KOD_FINENESS, protocolToClient } from './m59-roo.mjs';
import { fleetName } from './m59-fleetpath.mjs';

// WHICH FLEET, ASKED THE ONE WAY THIS REPOSITORY ASKS IT.
//
// This module used to read the environment directly with a literal fallback, which is
// its own argv/env reading — the exact mistake CLAUDE.md already records against the
// tithe book, where "a broker started with no --fleet but a recorded substrate/fleet-default
// wrote default-t14 while the tool read prod-t14". It happened again here and was visible on
// disk: the prod broker is started with `--fleet prod` as a COMMAND LINE argument, not an
// environment variable, so every trail it recorded went into `default.jsonl` — 14 MB of prod
// under a name no tool would ever look for.
//
// `fleetName` is the resolver every other fleet tool uses: --fleet, then M59_FLEET, then
// substrate/fleet-default, then the unnamed fleet. One answer, one place.
const FLEET = () => fleetName() || 'default';


const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TRAILS_DIR = process.env.M59_TRAILS_DIR || path.join(HERE, '..', 'substrate', 'trails');
export const WALKS_DIR = process.env.M59_WALKS_DIR || path.join(HERE, '..', 'substrate', 'walks');

// A body has moved if it has moved more than this. Below it, the samples are the same place
// reported twice — the server pushes position on a timer, not only on a change.
// A body has moved if it has moved more than this, in wire units, where a square is 64.
//
// 8 rather than 24: the samples this drops are the small corrective moves — the shuffle at a
// doorway, the slide along a wall — and those are precisely the ones worth keeping, because
// they happen exactly where the square lattice cannot express the route. Measured, our own
// characters already sample coarsely (a median of 116 wire units between samples, nearly two
// squares) because the walker moves in coalesced hops; there is no point discarding the fine
// detail on top of that. The server re-reporting a standing body is still dropped, which is
// what this threshold is really for.
export const MOVED_AT_LEAST = Number(process.env.M59_TRAIL_MOVED || 8);
// How long a gap in the samples before the trail is cut. A body that vanished for six
// seconds and reappeared did something we did not see, and joining the two ends would draw
// a line through whatever it was.
export const GAP_MS = Number(process.env.M59_TRAIL_GAP_MS || 6000);
// How long a body must be unseen IN THE SAME ROOM before the trail is cut rather than
// treated as a pause. Long enough that a character could have left, done something and
// come back — anything shorter is standing still, which is most of what a fleet does.
export const REJOIN_MS = Number(process.env.M59_TRAIL_REJOIN_MS || 120000);
// The fastest a body plausibly travels, in wire units a second. A client runs about five
// squares a second and a square is 64 wire units, so 320 is the real pace; this is doubled
// so a burst of coalesced movement is never mistaken for a teleport. Anything beyond it did
// not walk.
export const MAX_WIRE_PER_SECOND = Number(process.env.M59_TRAIL_MAX_SPEED || 640);

// THE SIZE AT WHICH A LEDGER STOPS BEING READABLE, WHICH IS A FACT ABOUT V8 AND NOT A TASTE.
//
// `readSamples` below reads a whole file into a string, and V8's MAX_STRING_LENGTH is
// 536,870,888 characters. One byte past that the read cannot succeed — but it does not fail
// FAST, and that is the whole reason this constant exists.
//
// Measured on prod, 2026-09-20, against this fleet's own trail:
//
//     readFileSync('substrate/trails/prod.jsonl', 'utf8')  ->  ERR_STRING_TOO_LONG
//     elapsed: 102,639 ms      size: 26.15 GB      node v25.2.1
//
// Node reads all 26 GB — a hundred and two seconds of blocked event loop, at 255 MB/s — and
// only then fails converting the buffer to a string. In a process that is also a fleet's
// broker, a hundred seconds of silence is long enough for blakserv to log every character out
// (INACTIVE_GAME is 30s), and the fleet earns nothing while it happens.
//
// Nothing rotated this file for weeks because nothing here ever has. So: the WRITER rotates at
// the size the READER can still hold, which keeps the two ends of this file honest with each
// other, and makes the cap one number rather than two that can drift apart.
// Taken from the RUNTIME rather than written down: MAX_STRING_LENGTH is 536,870,888 here
// and is a V8 build constant that has moved before. A hand-typed 512MiB is 536,870,912 —
// twenty-four bytes OVER the ceiling, which is a cap that does not cap.
export const MAX_TRAIL_BYTES =
  Number(process.env.M59_TRAIL_MAX_BYTES || bufferConstants.MAX_STRING_LENGTH);

export function trailsFile(fleet = FLEET()) {
  return path.join(TRAILS_DIR, String(fleet).replace(/[^\w.-]/g, '_') + '.jsonl');
}

/**
 * Move the active trail aside once it passes the size a reader can hold. Returns the name it
 * was rotated to, or null when nothing needed doing.
 *
 * ROTATED, NEVER TRUNCATED. A trail is evidence about walks that really happened, and the
 * readers here already enumerate every `.jsonl` in the directory, so a rotated file stays in
 * the answer. What is lost by rotating is only the ability to read the whole history in ONE
 * string, which is exactly the thing that was not possible anyway.
 *
 * It never throws: a rotation that fails leaves the append to carry on into the big file,
 * which is the behaviour that was there before this existed.
 */
export function rotateTrailIfHuge(file, max = MAX_TRAIL_BYTES) {
  try {
    if (!(max > 0)) return null;
    const size = fs.statSync(file).size;
    if (size <= max) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
    const rolled = file.replace(/\.jsonl$/, '') + `-${stamp}.jsonl`;
    fs.renameSync(file, rolled);
    // Said out loud, because a file quietly changing name under a reader is its own trap, and
    // because this line is the only warning anybody gets that a ledger got away from us.
    console.error(`[trails] rotated ${path.basename(file)} at ` +
                  `${(size / 1073741824).toFixed(2)}GB -> ${path.basename(rolled)}`);
    return rolled;
  } catch { return null; }      // no trail file yet, or a reader holding it: not our problem
}

let buffer = [], timer = null, lastOf = new Map();

/**
 * Record where a body was seen. Cheap, buffered, and unable to throw.
 *
 * This is called from the packet path that twenty-one sessions share, so it must never
 * await and never allocate much. Samples that repeat a position are dropped HERE rather
 * than at read time, because the server re-reports a standing body indefinitely and a
 * ledger of somebody standing still is most of the file.
 *
 * The input and stored schema uses protocol/KOD x/y; optional col/row are 1-based.
 */
// WHAT IS WORTH WRITING DOWN. Monsters are recorded only if somebody asks for them.
//
// The recorder captures every body the room can see, which is what makes it an instrument
// for formations and for watching a person walk. It also means twenty-six idle characters
// standing in monster-rich rooms fill the ledger with wandering rats: measured, the trail
// file grew 19 KB in twenty seconds while three of thirty characters were actually walking
// anywhere. None of that teaches a crossing, and all of it is read back on every comb.
//
// Monsters do not walk the routes we are learning — they wander the coarse grid, which is
// the very thing a monorail exists to route around — so they are off by default. Set
// M59_TRAIL_MONSTERS=1 to keep them, which is what a formation or a threat study would
// want.
const RECORD_MONSTERS = process.env.M59_TRAIL_MONSTERS === '1';

export function recordSeen(row = {}, { fleet = FLEET() } = {}) {
  try {
    const id = row.id ?? row.name ?? null;
    if (id == null || !Number.isFinite(row.x) || !Number.isFinite(row.y)) return false;
    // `sent` is our own move, which is a player by construction even before BP_PLAYER has
    // told us our own flags.
    if (!RECORD_MONSTERS && row.player !== true && row.sent !== true) return false;
    const k = String(row.room) + ':' + String(id);
    const prev = lastOf.get(k);
    if (prev && Math.abs(prev.x - row.x) + Math.abs(prev.y - row.y) < MOVED_AT_LEAST) return false;
    lastOf.set(k, { x: row.x, y: row.y });
    buffer.push({
      at: row.at ?? Date.now(),
      room: row.room ?? null,
      // The stable identity — see the note at the recording site. Written when known and
      // preferred on read; the object id stays as a fallback for a client that has not seen
      // a BP_PLAYER yet and for reading back trails recorded before this existed.
      ...(row.room_name_rsc != null ? { room_name_rsc: row.room_name_rsc } : {}),
      ...(row.room_rsc != null ? { room_rsc: row.room_rsc } : {}),
      id, name: row.name ?? null,
      // The observer, so a trail can be told from a sighting — and so a formation knows
      // whose clock it is on.
      by: row.by ?? null,
      player: row.player === true,
      // Where we asked to be, rather than where the server said we were. Kept apart so a
      // reader can prefer confirmed positions when it has both.
      ...(row.sent ? { sent: true } : {}),
      x: row.x, y: row.y,
      ...(Number.isFinite(row.col) ? { col: row.col, row: row.row } : {}),
    });
    if (buffer.length >= 128) flushTrails(fleet);
    else if (!timer) {
      timer = setTimeout(() => flushTrails(fleet), 5000);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return true;
  } catch { return false; }
}

export function flushTrails(fleet = FLEET()) {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!buffer.length) return 0;
  const rows = buffer; buffer = [];
  try {
    fs.mkdirSync(TRAILS_DIR, { recursive: true });
    const file = trailsFile(fleet);
    // Checked on the FLUSH rather than on a timer, because the flush is the only moment this
    // module is guaranteed to run and the only moment the file grows. A stat per 128 samples
    // is nothing against the append it is guarding.
    rotateTrailIfHuge(file);
    fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    return rows.length;
  } catch { return 0; }
}

/** Read samples with protocol/KOD x/y and optional 1-based col/row from either ledger shape. */
export function readSamples(file) {
  // REFUSED OUT LOUD, BECAUSE THE ALTERNATIVE IS A HUNDRED SECONDS AND A SILENCE.
  //
  // A file over MAX_TRAIL_BYTES cannot be read into a string at all, and finding that out
  // costs a full read of it — 102.6 s and 26 GB on prod on 2026-09-20 — after which the
  // `catch` below returned `[]` and the caller reported "no samples". Empty and unreadable
  // are not the same answer and must not look the same, so this says which it is, names the
  // size, and does not spend the hundred seconds discovering it.
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_TRAIL_BYTES) {
      console.error(`[trails] ${path.basename(file)} is ` +
                    `${(size / 1073741824).toFixed(2)}GB, past the ` +
                    `${(MAX_TRAIL_BYTES / 1073741824).toFixed(2)}GB a reader can hold — ` +
                    `skipped. Rotate it, or raise M59_TRAIL_MAX_BYTES and expect to wait.`);
      return [];
    }
  } catch { /* no file is an ordinary answer; let the read below settle it */ }
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    // A read that failed is a fact about this run, not a trail with nothing in it.
    if (e?.code !== 'ENOENT') console.error(`[trails] cannot read ${path.basename(file)}: ${e?.code ?? e?.message}`);
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line */ }
  }
  return out;
}

/**
 * Split a stream of samples into one segment per continuous stay in one room, per body.
 *
 * A segment is what a track is made of: entered here, left there, and everything between.
 * Cut on a room change, on a body change, and on a gap — see GAP_MS.
 */
export function segments(samples) {
  const runs = new Map();     // body -> current segment
  const out = [];
  // A ROOM PASSED THROUGH IN ONE SAMPLE IS STILL A ROOM YOU WENT TO.
  //
  // Dropping single-point segments loses the fact that the body was ever there, and the
  // next reader then reads the room AFTER it as the destination. Measured: the Cor Noth
  // inn-to-gate crossing was recorded perfectly — 35 points, span 19 — and thrown away,
  // because the body's one sample in the gate room vanished and the room it went to next
  // looked like the room it had come from, which the bounce rule then rejected. Kept, and
  // whether a segment is long enough to BE a crossing is asked separately by the comber.
  const close = (k) => { const s = runs.get(k); if (s && s.points.length >= 1) out.push(s); runs.delete(k); };
  for (const s of samples) {
    const k = String(s.id ?? s.name ?? 'self');
    const cur = runs.get(k);
    // A PAUSE IS NOT A ROOM CHANGE, AND CUTTING ON ONE SHREDS EVERY VISIT.
    //
    // Standing still produces no samples — `recordSeen` drops a body that has not moved —
    // so a character that stops to fight, or waits at a door, looks exactly like a gap. Cut
    // on that and one room visit becomes several fragments, none of which has a far side:
    // measured, 618 of 658 candidate crossings were rejected as "the next segment is the
    // same room", the median segment was THREE samples, and 24,520 samples yielded 14
    // crossings. The room number is the real boundary and it is authoritative, so that is
    // what cuts. A gap is only allowed to cut when it is long enough that the body could
    // have left and come back — which is a different claim from "it paused".
    const gap = cur ? s.at - cur.lastAt : 0;
    // A TELEPORT IS A CUT, NOT A CORRUPTION. Merging across pauses means a relocate inside
    // one room now lands INSIDE a segment, and a straight line drawn through it would claim
    // a traversal nobody made. Cutting there keeps both halves usable, where discarding the
    // segment threw away the walking either side of it — which is most of a training run,
    // since the harness places its subjects by teleport.
    const last = cur?.points[cur.points.length - 1];
    const moved = last ? Math.hypot(s.x - last.x, s.y - last.y) : 0;
    const couldHaveWalked = MAX_WIRE_PER_SECOND * Math.max(1, gap / 1000) + MOVED_AT_LEAST;
    const teleported = !!last && moved > couldHaveWalked;
    if (cur && (cur.room !== s.room || gap > REJOIN_MS || teleported)) close(k);
    else if (cur && gap > GAP_MS) cur.paused = (cur.paused ?? 0) + gap;
    const seg = runs.get(k) ?? { body: k, name: s.name ?? null, player: s.player === true,
                                 room: s.room, from: s.at, points: [] };
    seg.points.push({ x: s.x, y: s.y, at: s.at });
    seg.lastAt = s.at;
    seg.to = s.at;
    runs.set(k, seg);
  }
  for (const k of [...runs.keys()]) close(k);
  return out;
}

/**
 * Straighten a recorded trail into the corners the geometry actually requires.
 *
 * `points` are in WIRE units (64 to the square) as the packets carry them; the geometry
 * speaks client units, so they are converted for the raycast and returned in wire units,
 * which is what every mover entry point here takes.
 */
export function straighten(geo, points, { arriveWithin = 40 } = {}) {
  if (!Array.isArray(points) || points.length < 2) return points ?? [];
  // 1. drop the samples a body did not move between
  const moved = [points[0]];
  for (const p of points.slice(1)) {
    const last = moved[moved.length - 1];
    if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) >= MOVED_AT_LEAST) moved.push(p);
  }
  // 2. elide loops — a return to a place makes everything between it a round trip
  const cell = p => Math.round(p.x / 32) + ',' + Math.round(p.y / 32);
  const seenAt = new Map(); const tidy = [];
  for (const p of moved) {
    const k = cell(p);
    const had = seenAt.get(k);
    if (had !== undefined) {
      for (let i = had + 1; i < tidy.length; i++) seenAt.delete(cell(tidy[i]));
      tidy.length = had + 1;
      continue;
    }
    seenAt.set(k, tidy.length);
    tidy.push(p);
  }
  // 3. pull the string, raycasting every candidate leg against the real BSP
  if (!geo?.collisionReady || typeof geo.traceFineMoveClient !== 'function') return tidy;
  const lands = (a, b) => {
    const t = geo.traceFineMoveClient(protocolToClient(a.x), protocolToClient(a.y),
                                      protocolToClient(b.x), protocolToClient(b.y), { slide: true });
    if (!t) return false;
    return Math.hypot(t.x - protocolToClient(b.x), t.y - protocolToClient(b.y)) <= arriveWithin;
  };
  const out = [tidy[0]];
  let anchor = 0;
  while (anchor < tidy.length - 1) {
    let best = anchor + 1;
    for (let j = tidy.length - 1; j > anchor + 1; j--) {
      if (lands(tidy[anchor], tidy[j])) { best = j; break; }
    }
    out.push(tidy[best]);
    anchor = best;
  }
  return out;
}

// WHAT THE PACKETS CALL A ROOM IS ITS OBJECT ID, NOT ITS NUMBER.
//
// The client holds the room the server named it by, which is the object id — 1590 rather
// than 599 — and everything else in this repository speaks room NUMBERS. Recording the id is
// right (it is what the packet path has, and resolving on the hot path would mean loading a
// 27 MB map into the client), but a reader that does not resolve it sees a world of rooms it
// has never heard of. That is exactly what happened to the operator's own walk logs: 412 of
// 430 segments were filed as "a room we have no geometry for", and every one of them was a
// room we know perfectly well.
export function roomIndex(map) {
  // THREE SEPARATE INDEXES, BECAUSE THE THREE KEYS ARE NOT INTERCHANGEABLE AND MERGING THEM
  // IS EXACTLY THE BUG THIS FUNCTION ALREADY SHIPPED ONCE.
  //
  //   nameRsc / roomRsc — unique per room, protocol-visible on BP_PLAYER, and STABLE across
  //                       a save. These are the keys m59-world already identifies rooms by,
  //                       calling object ids "the fallback, not the key".
  //   objId            — convenient, and renumbered by every `save game`, which is every
  //                       fifteen minutes here. It is also ambiguous within a single boot:
  //                       30 of the 264 object ids are ALSO a room number, so room 1's objId
  //                       of 6 is indistinguishable from room 6.
  //
  // The first version wrote objId -> num AND num -> num into one map, "in case it is already
  // a room number". Room 1 is the Underworld, room 6 is The Deep Dark Woods of Marion, and
  // whichever landed last won — so every Underworld sample was filed under the woods, and
  // the best straightening result this session reported was the Underworld wearing the
  // woods' name. Keeping the maps apart is what makes that unsayable rather than unlikely.
  const byName = new Map(), byRsc = new Map(), byObj = new Map();
  for (const key of Object.keys(map?.rooms ?? {})) {
    const r = map.rooms[key];
    const num = Number(r?.num);
    if (!Number.isFinite(num)) continue;
    if (r.nameRsc != null) byName.set(Number(r.nameRsc), num);
    if (r.roomRsc != null) byRsc.set(Number(r.roomRsc), num);
    if (r.objId != null) byObj.set(Number(r.objId), num);
  }
  // `get` is kept so a caller holding a bare object id still works; it is the object-id
  // index, which is what every such caller was passing anyway.
  return { byName, byRsc, byObj, get: (k) => byObj.get(Number(k)) };
}

/** Resolve a recorded `room` (an object id, usually) to a room number, or null. */
/**
 * Resolve a recorded sample to a room NUMBER, stable key first.
 *
 * Takes the whole sample rather than one field, because which key is trustworthy is a
 * property of the sample: one recorded after the stable identity was added carries it, one
 * from before does not, and only the sample knows which it is. Asking for "the room" and
 * letting this decide is what stops the object id being reached for out of habit.
 */
export function resolveRoom(index, sampleOrRoom) {
  if (index == null) return null;
  const s = (sampleOrRoom != null && typeof sampleOrRoom === 'object') ? sampleOrRoom : null;
  if (s) {
    if (s.room_name_rsc != null) {
      const hit = index.byName?.get(Number(s.room_name_rsc));
      if (hit != null) return hit;
    }
    if (s.room_rsc != null) {
      const hit = index.byRsc?.get(Number(s.room_rsc));
      if (hit != null) return hit;
    }
    return index.byObj?.get(Number(s.room)) ?? null;
  }
  return index.byObj?.get(Number(sampleOrRoom)) ?? null;
}

// LEGACY COMPATIBILITY ANOMALY: trail points are already KOD/protocol values, whose
// canonical square conversion is floor(axis / 64) with no offset (see
// extractCoordinates). This historical adapter adds one and therefore shifts the
// derived `entered`/`left` squares written to track records. Preserve it until those
// records receive a versioned migration; do not use it as a general point-to-square
// conversion.
export const squareOf = p => ({ row: Math.floor(p.y / KOD_FINENESS) + 1,
                                col: Math.floor(p.x / KOD_FINENESS) + 1 });

// ---------------------------------------------------------------------------- CLI
const direct = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (direct) {
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const files = [];
  const only = arg('--file');
  if (only) files.push(only);
  else {
    for (const dir of [TRAILS_DIR, WALKS_DIR]) {
      try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) files.push(path.join(dir, f)); }
      catch { /* nothing recorded yet */ }
    }
  }
  if (!files.length) { console.log('no trails or walk logs on this machine'); process.exit(0); }

  const samples = files.flatMap(readSamples);
  const segs = segments(samples);
  console.log(`${files.length} file(s), ${samples.length} sample(s), ${segs.length} room segment(s)\n`);

  const wantRoom = arg('--room') ? Number(arg('--room')) : null;
  const { loadMap } = await import('./m59-map.mjs');
  const { movementMapFile } = await import('./m59-map-path.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const map = loadMap(movementMapFile());

  console.log('room                                 body        samples  straightened  entered   left');
  for (const s of segs.sort((a, b) => b.points.length - a.points.length).slice(0, 30)) {
    if (wantRoom && s.room !== wantRoom) continue;
    const room = map.rooms[s.room];
    let geo = null; try { geo = room?.roo ? sharedRoomGeometry(room) : null; } catch { /* none */ }
    const pulled = straighten(geo, s.points);
    const a = squareOf(s.points[0]), b = squareOf(s.points[s.points.length - 1]);
    console.log(`${String(s.room).padStart(5)} ${String(room?.name ?? '?').slice(0, 30).padEnd(31)} ` +
      `${String(s.name ?? s.body).slice(0, 10).padEnd(11)} ${String(s.points.length).padStart(7)} ` +
      `${String(pulled.length).padStart(13)}  ${(a.row + ',' + a.col).padStart(7)} ${(b.row + ',' + b.col).padStart(6)}`);
  }
}
