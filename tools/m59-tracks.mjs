// THE MONORAIL: the fastest way anybody has ever actually crossed this room, kept.
//
// 99% of travel is exit to exit. A room has a handful of doors, everyone crossing it is
// going from one of them to another, and the geometry does not change — so there is a best
// way through, it is the same every time, and the fleet has been re-deriving it on every
// trip and then throwing it away.
//
// This combs the trail ledger for those crossings and keeps the quickest one per
// (room, came from, going to). What comes out is not a plan and not a claim: it is what a
// body did, straightened against the same BSP the mover enforces, so it cannot contain a
// step the mover would refuse. That is the property no planner has — `path()` reasons about
// stand points a body may never occupy, and this repository has spent a long day proving how
// badly that goes in tight terrain.
//
// TIME IS THE ONLY RANKING, AND DEATHS ARE NOT EVIDENCE. Monsters wander the coarse grid, so
// which crossing killed somebody is a fact about where a troll was standing, not about the
// route — and ranking on survival would teach the fleet to avoid whichever road it happened
// to be unlucky on. A death simply means that attempt produced no usable track.
//
//   node tools/m59-tracks.mjs                what has been learned
//   node tools/m59-tracks.mjs --room 599     one room in detail
//   node tools/m59-tracks.mjs --save         write substrate/m59-tracks.json
//
// COORDINATE CONTRACT. Input samples and persisted waypoint x/y fields use
// protocol/KOD fine units (64 per square), as do MAX_JUMP_WIRE and other point
// distances. BSP collision checks alone convert them to client units.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSamples, segments, straighten, squareOf, roomIndex, resolveRoom,
         TRAILS_DIR, WALKS_DIR } from './m59-trails.mjs';
import { UNDERWORLD_PORTALS } from './m59-underworld.mjs';
import { protocolToClient } from './m59-roo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TRACKS_FILE = process.env.M59_TRACKS ||
  path.join(HERE, '..', 'substrate', 'm59-tracks.json');

// A crossing has to be a crossing. A segment that starts and ends in the same corner of a
// room is somebody milling about, not a route through it.
// A crossing has to cross something. Four squares was low enough to admit the corner nubs
// described above; a real traversal of even a small room moves further than this, and a
// track shorter than it saves nobody anything anyway.
export const MIN_SPAN_SQUARES = Number(process.env.M59_TRACK_MIN_SPAN || 10);
// And it has to be plausible as a walk. A segment spanning more than this in one sample is a
// teleport, a knockback or a relocate, and joining its ends draws a line through whatever
// happened in between.
export const MAX_JUMP_WIRE = Number(process.env.M59_TRACK_MAX_JUMP || 600);

export const trackKey = (room, from, to) => `${room}:${from ?? '?'}>${to ?? '?'}`;

// WHERE A SEALED ROOM IS KNOWN TO LEAD. Only the Underworld today: five pentagram portals
// with fixed destinations, plus the rip in space, which re-rolls among those same five — so
// the destination SET is the same either way. Empty for any other sealed room, which means
// "nothing is known, accept what is observed" and keeps this from becoming a second, worse
// copy of the room graph.
export const sealedDestinations = new Map([
  [1, new Set(UNDERWORLD_PORTALS.map(p => Number(p.inn)).filter(Number.isFinite))],
]);

/**
 * Turn a stream of samples into crossings: which room, in by which door, out by which.
 *
 * The neighbouring segments are what say where a body came FROM and went TO — the sample
 * stream is continuous, so the room before and the room after are simply the previous and
 * next segments of the same body, when they are close enough in time to be the same journey.
 */
// How close to a way out a body has to be when it leaves, in squares. A real crossing ends
// at the boundary it crosses or on the door tile it uses; a teleport can happen from the
// middle of the floor.
export const LEAVES_FROM_WITHIN = Number(process.env.M59_TRACK_LEAVE_WITHIN || 4);

export function crossings(samples, { joinWithinMs = 15000, neighbours = null, exitsNear = null,
                                     traversable = null } = {}) {
  const segs = segments(samples);
  // Group by body so "the segment before" means the same body's previous room.
  const byBody = new Map();
  for (const s of segs) {
    const list = byBody.get(s.body) ?? [];
    list.push(s); byBody.set(s.body, list);
  }
  const out = [];
  for (const list of byBody.values()) {
    list.sort((a, b) => a.from - b.from);
    for (let i = 0; i < list.length; i++) {
      const seg = list[i], prev = list[i - 1], next = list[i + 1];
      let cameFrom = prev && (seg.from - prev.to) <= joinWithinMs ? prev.room : null;
      const goingTo = next && (next.from - seg.to) <= joinWithinMs ? next.room : null;
      if (goingTo == null) continue;               // a crossing needs a far side
      // AND THE FAR SIDE HAS TO BE A DIFFERENT ROOM. A body whose samples were cut by a gap
      // produces two segments in the SAME room, and joining them reads as a crossing from a
      // room to itself — which then keys a track nobody can ever use and hides the real one
      // behind it. Same for the near side.
      if (goingTo === seg.room) continue;
      // COMING FROM THIS ROOM MEANS WE DO NOT KNOW THE DOOR, NOT THAT THIS IS NOT A
      // CROSSING. A segment can be cut inside a room — by a teleport, or by a gap longer
      // than the rejoin window — and the piece after the cut then has the same room
      // "before" it. Discarding those threw away the Cor Noth inn-to-gate crossing five
      // times over, each a clean 35-point traversal ending one square from the door.
      // Forgetting the entry door files it under the `?` key, which is exactly what that
      // key is for: the approach any arrival with no exact match is offered.
      if (cameFrom === seg.room) cameFrom = null;
      // IN AND BACK OUT THE SAME DOOR IS NOT A CROSSING.
      //
      // A bot that bounces at a boundary is seen leaving to the room it just came from, and
      // the trail is a couple of squares in a corner. Those are real observations and
      // useless as routes — and because the comb keeps the FASTEST, a three-second nub beats
      // every honest traversal of the room. Worse, it lands on the `?` key, which is the
      // FALLBACK any arrival with no exact entry match is handed. Measured live: the
      // Western border of the Twisted Wood offered `587:?>576` as two waypoints spanning
      // four squares of a 55x67 room, so a character bound for The King's Way boarded a nub
      // in the corner, rode it, did not leave, and went round again. That is a fleet
      // character stuck on prod.
      if (cameFrom != null && cameFrom === goingTo) continue;
      // AND THE DOORS HAVE TO EXIST.
      //
      // `goingTo` is simply the next room this body was seen in, and after a teleport that
      // is wherever the harness put it — so a "crossing" appeared from the Western border
      // of the Twisted Wood into the Streets of Tos, which do not touch. Left in, those
      // become tracks nobody can ever ride, sorted to the top by their absurdly short times,
      // and they are the first thing a reader picks up. A crossing is only a crossing
      // between rooms that share a door.
      if (neighbours) {
        const out = neighbours.get(Number(seg.room));
        // A ROOM WITH NO DOORS AT ALL LEAVES BY SOMETHING ELSE, AND THAT IS THE POINT.
        //
        // The filter above exists to throw away the harness's own teleports, which look
        // exactly like crossings. It would also throw away every PORTAL hop, and the
        // Underworld is the case that matters: it publishes no exits whatsoever — "six
        // teleporters, and that is all" — so the router cannot plan a single step of it and
        // a recorded walk is the only thing that ever could. When a room declares nothing,
        // every real transition out of it is necessarily a teleporter, so there is nothing
        // for the filter to protect against and it stands aside.
        const sealed = !out || out.size === 0;
        // A SEALED ROOM STILL HAS A KNOWN SET OF WAYS OUT, WHERE ANYBODY HAS WRITTEN ONE
        // DOWN. Standing the filter aside entirely let the harness's own relocations back
        // in: the Underworld grew "crossings" to The Streets of Tos and East Merchant Way,
        // which are not portal destinations and which nothing can ever ride. The pentagram's
        // five inns are documented in m59-underworld.mjs with their kod citations, so the
        // exception is narrowed to them rather than to anything at all.
        if (sealed) {
          const known = sealedDestinations.get(Number(seg.room));
          if (known && !known.has(Number(goingTo))) continue;
        } else if (!out.has(Number(goingTo))) continue;
        if (cameFrom != null && !sealed) {
          const back = neighbours.get(Number(cameFrom));
          // Arriving from a sealed room is a teleporter landing, which is legitimate for
          // the same reason.
          if (back && back.size && !back.has(Number(seg.room))) continue;
        }
      }
      // The crossing itself still needs a real trail; a one-sample segment can say where a
      // body WENT without being a route through anywhere.
      if (seg.points.length < 2) continue;
      const a = squareOf(seg.points[0]), b = squareOf(seg.points[seg.points.length - 1]);
      const span = Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
      if (span < MIN_SPAN_SQUARES) continue;
      // A jump between consecutive samples is not a walk.
      // A LONG MOVE IS NOT A TELEPORT, AND DISTANCE CANNOT TELL THEM APART.
      //
      // One packet moves a body as far as it says; the walker coalesces hops and rides
      // pulled track legs, so eleven squares between two samples is an ordinary walk.
      // Measured: the Cor Noth inn-to-gate crossing was rejected as a teleport on jumps of
      // 604 and 724 wire units against a flat 600 limit — every clean traversal of that
      // room, thrown away, while the fleet piled up on the porch it describes the way out
      // of.
      //
      // Geometry can tell them apart. A walked jump has a clear line under it; a teleport
      // does not, because it went through whatever was in the way. So the caller passes the
      // same trace the mover enforces, and the flat distance is only the fallback for a
      // reader with no map.
      let teleported = false;
      for (let k = 1; k < seg.points.length; k++) {
        const p = seg.points[k], q = seg.points[k - 1];
        const far = Math.hypot(p.x - q.x, p.y - q.y);
        if (far <= MAX_JUMP_WIRE) continue;
        if (traversable) { if (traversable(Number(seg.room), q, p)) continue; }
        teleported = true; break;
      }
      if (teleported) continue;
      // A CROSSING LEAVES FROM A WAY OUT. A TELEPORT DOES NOT.
      //
      // The operator saw this before it bit: being ferried from the Western border of the
      // Twisted Wood to The King's Way looks exactly like walking between them, because
      // those two really do share a door — so the room-graph check above passes and a track
      // is forged out of an instant that involved no walking at all. Rooms that do NOT
      // border each other were already caught; this catches the ones that do.
      //
      // Geometry decides it rather than intent: whatever moved the body, it was either
      // standing at the edge it left by, or it was not. `exitsNear` is the caller's
      // predicate so this module stays testable without a map.
      if (exitsNear && !exitsNear(Number(seg.room), b, Number(goingTo))) continue;
      out.push({ room: seg.room, cameFrom, goingTo, body: seg.body, name: seg.name,
                 ms: seg.to - seg.from, points: seg.points, entered: a, left: b });
    }
  }
  return out;
}

/**
 * Keep the quickest crossing per (room, from, to), straightened.
 *
 * `geoFor` is injected rather than imported so this stays testable without a map — a caller
 * with no geometry still gets loop-elided trails, which are worse tracks and not wrong ones.
 */
// HOW MANY OF THESE LEGS COULD ACTUALLY BE SENT? `rideTrack` sends each leg as the single
// validated move `straighten` proved it to be, so the honest question about a track is that
// same `lands` test, leg by leg.
//
// It is worth asking because `straighten` DOES emit legs that fail it. When no long leg
// raycasts from the current anchor it falls back to `best = anchor + 1` and pushes the next
// raw sample WITHOUT proving it -- and consecutive trail samples can be seconds and several
// squares apart, around a corner a straight line does not survive. Measured on this fleet's
// book: 105 of 321 tracks carry at least one such leg, 19.5% of all legs, and in 578 The
// Cragged Mountains it is 14 legs of 18. A track that cannot be sent is not a fast crossing;
// it is `walkFine` groping between waypoints, which is the behaviour the track existed to
// replace.
export function unprovedLegs(geo, points) {
  if (!geo?.collisionReady || typeof geo.traceFineMoveClient !== 'function') return 0;
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    const a2 = points[i - 1], b2 = points[i];
    const t = geo.traceFineMoveClient(protocolToClient(a2.x), protocolToClient(a2.y),
                                      protocolToClient(b2.x), protocolToClient(b2.y), { slide: true });
    if (!t || Math.hypot(t.x - protocolToClient(b2.x), t.y - protocolToClient(b2.y)) > 40) n++;
  }
  return n;
}

export function comb(crossingList, geoFor = () => null) {
  const best = new Map();
  // Every straightened walk per key, kept so the good halves can be stitched together —
  // see stitch(). The fastest whole walk is still what the entry is BUILT from, because it
  // decides where the crossing starts and ends; the stitch only improves the middle.
  const seenWalks = new Map();
  for (const c of crossingList) {
    const key = trackKey(c.room, c.cameFrom, c.goingTo);
    const had = best.get(key);
    const geo = geoFor(c.room);
    const points = straighten(geo, c.points);
    if (points.length >= 2) {
      const list = seenWalks.get(key) ?? [];
      list.push({ points, ms: c.ms });
      seenWalks.set(key, list);
    }
    if (points.length < 2) continue;

    // RIDABILITY OUTRANKS TIME. This used to keep whichever crossing was quickest, on the
    // argument that monsters wander so a death says nothing about a route -- which is right
    // about deaths and silent about whether the route can be SENT. A crossing whose legs do
    // not raycast is not quick; it is `walkFine` feeling its way between the waypoints, and
    // it wins the time comparison only because the body that walked it was lucky. So the
    // track with fewer refused legs wins, and time decides between equals.
    const unproved = unprovedLegs(geo, points);
    if (had && (had.unproved ?? 0) <= unproved
             && !((had.unproved ?? 0) === unproved && c.ms < had.ms)) { had.seen++; continue; }
    // WHICH STATIONS ARE SHELTER.
    //
    // The tight squares that make these crossings awkward are the SAME squares a monster
    // cannot reach — that is what a safe wall is, measured: the coarse grid offering a
    // neighbour the mover refuses. So a track already runs past the best places in the room
    // to stop and bleed quietly, and marking them costs nothing. A traveller that is hurt
    // mid-crossing does not need to reach a town; it needs the next station with a wall at
    // its back.
    //
    // The dose is what matters rather than the fact: at zero refused neighbours 28% of
    // tested squares held, at four or more 70.5%. Three is the threshold where the signal
    // is clearly present and the squares are still common enough to be on a route.
    const safeAt = [];
    if (geo && typeof geo.walkable === 'function') {
      points.forEach((p, i) => {
        // LEGACY COMPATIBILITY ANOMALY: like trails.squareOf(), this adds one to
        // an already-KOD point. Persisted shelter indexes depend on the existing
        // result; see docs/m59-coordinates.md before changing it.
        const row = Math.floor(p.y / 64) + 1, col = Math.floor(p.x / 64) + 1;
        let refused = 0;
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]) {
          const nr = row + dr, nc = col + dc;
          if (!geo.inBounds?.(nr, nc) || !geo.walkable(nr, nc)) continue;
          if (!geo.moverStepLands?.(row, col, nr, nc)) refused++;
        }
        if (refused >= 3) safeAt.push(i);
      });
    }
    best.set(key, { room: c.room, from: c.cameFrom, to: c.goingTo, ms: c.ms,
                    waypoints: points.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
                    ...(safeAt.length ? { shelter: safeAt } : {}),
                    entered: c.entered, left: c.left,
                    samples: c.points.length, seen: (had?.seen ?? 0) + 1,
                    ...(unproved ? { unproved } : {}),
                    straightened: geo ? true : false });
  }
  // STITCH, WHERE THERE IS ANYTHING TO STITCH. A key seen once is its own best walk; a key
  // seen several times can usually be beaten by neither of them alone.
  for (const [key, entry] of best) {
    const walks = (seenWalks.get(key) ?? []).sort((a, b) => a.ms - b.ms);
    if (walks.length < 2) continue;
    const geo = geoFor(entry.room);
    const sewn = stitch(walks.map(w => w.points), geo);
    if (!sewn || sewn.length < 2) continue;
    const length = pts => { let n = 0; for (let i = 1; i < pts.length; i++)
      n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return n; };
    // Only if it is actually shorter than the best single walk. A stitch that ties is not
    // worth preferring: the walked one has been ridden and this one has not.
    // A STITCH THAT IS SHORTER AND LESS RIDABLE IS NOT AN IMPROVEMENT. Every sewn leg is
    // meant to pass the mover's raycast; where it does not, taking it would trade a route
    // that can be sent for one that has to be groped, which is the same mistake ranking on
    // time alone was making.
    const sewnUnproved = unprovedLegs(geo, sewn);
    if (sewnUnproved > (entry.unproved ?? 0)) continue;
    if (length(sewn) < length(entry.waypoints) * 0.98) {
      // KEEP THE WALKED ROUTE. A STITCH IS PROVED ON PAPER, NOT IN PRACTICE.
      //
      // Every stitched leg passes the same raycast the mover enforces, which is a real
      // guarantee — and this session has been wrong about paper guarantees repeatedly, most
      // recently about a step `moverStepLands` called legal that no body could make from
      // where bodies actually stand. The walked route has been ridden by something with a
      // health bar; the sewn one has not. Discarding the first for the second is exactly the
      // wrong way round, so both are kept and the stitch carries `proven: false` until a
      // ride completes on it. A bad stitch then costs one slow crossing instead of replacing
      // the only route we know works.
      entry.stitched_from = walks.length;
      entry.walked = entry.waypoints;
      entry.walked_length = Math.round(length(entry.waypoints));
      entry.waypoints = sewn.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
      entry.stitched_length = Math.round(length(sewn));
      if (sewnUnproved) entry.unproved = sewnUnproved; else delete entry.unproved;
      entry.proven = false;
    }
  }
  return best;
}

/**
 * Build one good crossing out of several imperfect ones.
 *
 * KEEPING THE FASTEST WHOLE WALK CANNOT REACH NEAR-OPTIMAL, and that is not a tuning
 * problem, it is arithmetic: if every observed crossing wanders somewhere different, the
 * best of them still wanders. Waiting for one lucky perfect run is the only way that ever
 * improves, and on a route walked ten times a day with monsters in it that run may never
 * come.
 *
 * So the good halves are stitched instead. Every point anybody reached in this room, on any
 * crossing between these two doors, becomes a node; consecutive points on the same walk
 * become edges, because a body actually made that move. Then — and this is the stitching —
 * every pair of points from DIFFERENT walks is offered an edge, and kept only if a raycast
 * against the baked BSP says a body can make it. The shortest path through the union is a
 * route nobody has walked end to end and every leg of which is either something somebody
 * walked or something the geometry proves.
 *
 * IT CANNOT INVENT A TRAVERSAL. That is the whole argument for doing this here rather than
 * planning: an original leg was accepted by the mover at the time, and a stitched leg has to
 * pass the same trace the mover enforces. What it can do is skip the wandering, because a
 * shortcut between two walks is exactly the wander that both of them took.
 */
export function stitch(walks, geo, { arriveWithin = 40 } = {}) {
  const usable = (walks ?? []).filter(w => Array.isArray(w) && w.length >= 2);
  if (usable.length < 2) return usable[0] ?? null;
  if (!geo?.collisionReady || typeof geo.traceFineMoveClient !== 'function') return null;

  // One node per distinct point, snapped so two walks over the same ground share it.
  const SNAP = 16;
  const key = p => Math.round(p.x / SNAP) + ',' + Math.round(p.y / SNAP);
  const nodes = [], byKey = new Map();
  const nodeOf = p => {
    const k = key(p);
    if (byKey.has(k)) return byKey.get(k);
    byKey.set(k, nodes.length); nodes.push({ x: p.x, y: p.y });
    return nodes.length - 1;
  };
  const edges = new Map();                       // from -> Map(to -> cost)
  const link = (a, b) => {
    if (a === b) return;
    const cost = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
    const row = edges.get(a) ?? new Map();
    if (!(row.get(b) <= cost)) row.set(b, cost);
    edges.set(a, row);
  };
  const walked = usable.map(w => w.map(nodeOf));
  for (const path of walked) for (let i = 1; i < path.length; i++) link(path[i - 1], path[i]);

  // THE STITCH. Cross-walk shortcuts, proved rather than assumed.
  const lands = (a, b) => {
    const t = geo.traceFineMoveClient(protocolToClient(nodes[a].x), protocolToClient(nodes[a].y),
                                      protocolToClient(nodes[b].x), protocolToClient(nodes[b].y),
                                      { slide: true });
    if (!t) return false;
    return Math.hypot(t.x - protocolToClient(nodes[b].x), t.y - protocolToClient(nodes[b].y)) <= arriveWithin;
  };
  const MAX_NODES_FOR_STITCH = Number(process.env.M59_STITCH_MAX_NODES || 160);
  if (nodes.length <= MAX_NODES_FOR_STITCH) {
    for (let a = 0; a < nodes.length; a++) for (let b = 0; b < nodes.length; b++) {
      if (a === b) continue;
      if (edges.get(a)?.has(b)) continue;
      if (lands(a, b)) link(a, b);
    }
  }

  // Enter where the walks entered, leave where they left. Both ends are taken from the
  // FASTEST walk, so a stitched route still starts and finishes where a traveller does.
  const start = walked[0][0], goal = walked[0][walked[0].length - 1];
  const dist = new Array(nodes.length).fill(Infinity), prev = new Array(nodes.length).fill(-1);
  dist[start] = 0;
  const seen = new Set();
  for (;;) {
    let at = -1, best = Infinity;
    for (let i = 0; i < nodes.length; i++) if (!seen.has(i) && dist[i] < best) { best = dist[i]; at = i; }
    if (at < 0 || at === goal) break;
    seen.add(at);
    for (const [to, cost] of (edges.get(at) ?? new Map())) {
      if (dist[at] + cost < dist[to]) { dist[to] = dist[at] + cost; prev[to] = at; }
    }
  }
  if (!Number.isFinite(dist[goal])) return null;
  const out = [];
  for (let at = goal; at !== -1; at = prev[at]) out.push({ x: Math.round(nodes[at].x), y: Math.round(nodes[at].y) });
  out.reverse();
  return out.length >= 2 ? out : null;
}

// A TRACK THAT FAILS WITH NOTHING IN THE WAY IS A BAD TRACK.
//
// The operator's heuristic, and it is sharper than any offline check could be. A ride that
// fails while a monster is standing on it says nothing about the route — bodies wander the
// coarse grid and that is the whole reason a monorail exists. A ride that fails with NOBODY
// in the way is the route itself being wrong: a degenerate segment kept because it happened
// to be the fastest, a stitch whose legs are individually legal and collectively not, a
// crossing recorded before a wall moved.
//
// Three in a row, because one is noise — a lag spike, a door mid-animation, a character
// arriving further off the station than usual — and three is a pattern. Consecutive, so a
// track that works most of the time is never retired for an occasional bad day: any success
// clears the count.
//
// STRIKES LIVE APART FROM THE BOOK, because the book is REGENERATED from the trails on
// every comb and would forget them. This file is the only place a judgement about a track
// survives its rebuild.
export const STRIKES_FILE = process.env.M59_TRACK_STRIKES ||
  path.join(HERE, '..', 'substrate', 'm59-track-strikes.json');
export const STRIKES_BEFORE_REJECT = Number(process.env.M59_TRACK_STRIKES_MAX || 3);

// A BOOK READ ON EVERY CALL IS READ ON EVERY CALL, AND THE DEFAULT PARAMETER HID IT.
//
// `recallTrack(room, from, to, tracks = loadTracks(), strikes = loadStrikes())` evaluates both
// defaults EVERY time a caller omits them, and the broker's only call site omits them
// (m59-broker.mjs, the track recall in the movement tool). So a crossing lookup — which reads
// nothing and decides nothing — was a synchronous read and a full `JSON.parse` of two files,
// on the event loop, per call. A default parameter looks like a fallback and is a function
// call; that is the whole reason this went unnoticed.
//
// Cached exactly the way `loadMap` already does it (m59-map.mjs:523): keyed on path, mtime and
// size, so an external edit is still picked up on the next call and a `saveStrikes` from this
// process invalidates itself through the same key. Same pattern, same file tree, so there is
// one way to think about "a book on disk that code re-reads" rather than two.
//
// SCALE, MEASURED 2026-09-20, so nobody over-claims this as the fix for the wedge: the books
// are 0.18 MB and 0.01 MB. This is a real and pointless cost and it is NOT 86 MB/s — the
// broker's read storm is a separate, still-unattributed caller. Fixing this does not close
// that, and saying so here is cheaper than somebody re-measuring to find out.
const _bookCache = new Map();
function readBook(file, pick) {
  let st = null;
  try { st = fs.statSync(file); } catch { return {}; }
  const key = `${path.resolve(file)}\0${st.mtimeMs}\0${st.size}`;
  const hit = _bookCache.get(key);
  if (hit) return hit;
  let value = {};
  try { value = pick(JSON.parse(fs.readFileSync(file, 'utf8'))) ?? {}; } catch { return {}; }
  // One entry per file: a book that changed is a new key, and the old one is dead weight.
  for (const k of _bookCache.keys()) if (k.startsWith(`${path.resolve(file)}\0`)) _bookCache.delete(k);
  _bookCache.set(key, value);
  return value;
}

export function loadStrikes(file = STRIKES_FILE) {
  return readBook(file, doc => doc.strikes);
}

function saveStrikes(strikes, file = STRIKES_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      note: 'Consecutive failures of a track replay in which nothing living was in the way. ' +
            'A ride blocked by a body is not counted — that is traffic, not a bad route. ' +
            'Any success clears the count. At ' + STRIKES_BEFORE_REJECT + ' the track is ' +
            'refused and the crossing is planned as it always was.',
      written: new Date().toISOString(), strikes,
    }, null, 1) + String.fromCharCode(10));
  } catch { /* a judgement that cannot be written is one the next ride re-earns */ }
}

/** A ride failed with nothing in the way. Returns the new count. */
export function strikeTrack(room, from, to, { file = STRIKES_FILE } = {}) {
  // READERS SHARE THE CACHED BOOK, WRITERS TAKE A COPY. `loadStrikes` now returns the cached
  // object rather than a fresh parse, so mutating it in place would edit what every other
  // reader sees — and if `saveStrikes` then failed (it swallows its own errors) the cache
  // would hold a count that is not on disk. One spread is cheaper than that class of bug.
  const strikes = { ...loadStrikes(file) };
  const key = trackKey(room, from, to);
  strikes[key] = (strikes[key] ?? 0) + 1;
  saveStrikes(strikes, file);
  return strikes[key];
}

/** A ride worked. Forget the strikes — they are consecutive by definition. */
export function clearStrikes(room, from, to, { file = STRIKES_FILE } = {}) {
  const key = trackKey(room, from, to);
  if (!loadStrikes(file)[key]) return 0;      // the common case: read, decide, touch nothing
  const strikes = { ...loadStrikes(file) };   // copy only when about to write — see strikeTrack
  delete strikes[key];
  saveStrikes(strikes, file);
  return 0;
}

export function loadTracks(file = TRACKS_FILE) {
  return readBook(file, doc => doc.tracks);
}

/** The track for this crossing, or null — and null means "plan it as you always did". */
export function recallTrack(room, from, to, tracks = loadTracks(), strikes = loadStrikes()) {
  const exact = trackKey(room, from, to), loose = trackKey(room, null, to);
  // A struck-out track is not offered at all. It is left in the book rather than deleted:
  // the walk that produced it really happened, and the next comb may stitch something
  // better out of it even though riding it end to end does not work.
  if ((strikes[exact] ?? 0) < STRIKES_BEFORE_REJECT && tracks[exact]) return tracks[exact];
  if ((strikes[loose] ?? 0) < STRIKES_BEFORE_REJECT && tracks[loose]) return tracks[loose];
  return null;
}

// ---------------------------------------------------------------------------- CLI
const direct = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (direct) {
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const files = [];
  for (const dir of [TRAILS_DIR, WALKS_DIR]) {
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) files.push(path.join(dir, f)); }
    catch { /* nothing recorded yet */ }
  }
  if (!files.length) { console.log('no trails recorded yet'); process.exit(0); }

  // A TRACK IS A CLAIM ABOUT THE WALKER THAT MADE IT, AND THE WALKER KEEPS CHANGING.
  // Baking over everything on disk averages the current code with every version of itself,
  // and this fleet has 1.4 million samples going back to walkers that have since been fixed
  // -- so the whole-history bake both takes twenty minutes and enshrines crossings nobody
  // could repeat. `--since` is the same argument, and the same spelling, as m59-transits.mjs:
  // an ISO timestamp, a millisecond epoch, or a plain age (`--since 45m`, `--since 3h`).
  //
  // It costs nothing to leave off, and leaving it off is still the right thing when the
  // question is "what is the best crossing anybody has EVER made".
  const sinceArg = arg('--since');
  const since = (() => {
    if (!sinceArg) return 0;
    const age = /^(\d+(?:\.\d+)?)([smhd])$/.exec(String(sinceArg));
    if (age) return Date.now() - Number(age[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[age[2]];
    const n = Number(sinceArg);
    if (Number.isFinite(n) && n > 1e11) return n;
    const t = Date.parse(String(sinceArg));
    return Number.isFinite(t) ? t : 0;
  })();
  const all = files.flatMap(readSamples);
  const samples = since ? all.filter(s2 => (s2.at ?? 0) >= since) : all;
  if (since)
    console.log(`${samples.length} of ${all.length} samples are newer than ` +
                `${new Date(since).toISOString()}
`);
  if (!samples.length) { console.log('nothing recorded in that window'); process.exit(0); }

  const { loadMap } = await import('./m59-map.mjs');
  const { movementMapFile } = await import('./m59-map-path.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const { attachStepMasks } = await import('./m59-routes.mjs');
  const map = loadMap(movementMapFile());
  try { attachStepMasks(map); } catch { /* coarse, as everywhere */ }
  const geoFor = num => { const r = map.rooms[num];
    try { return r?.roo ? sharedRoomGeometry(r) : null; } catch { return null; } };

  // Resolve object ids to room numbers, then keep only crossings between rooms that share
  // a door — see the note in crossings(). Samples are rewritten first so the neighbour test
  // is asked in room numbers, which is the only vocabulary the map speaks.
  const index = roomIndex(map);
  for (const s2 of samples) s2.room = resolveRoom(index, s2.room) ?? s2.room;
  const neighbours = new Map();
  for (const key of Object.keys(map.rooms)) {
    const r = map.rooms[key];
    const to = new Set();
    for (const e of (r.edgeExits ?? [])) if (e.to != null) to.add(Number(e.to));
    for (const g of (r.goExits ?? [])) if (g.to != null && !g.locked) to.add(Number(g.to));
    neighbours.set(Number(r.num), to);
  }
  // Where a body may legitimately be standing when it leaves: the room edge for an edge
  // exit, the door tile for a `go` exit. Both come straight off the map.
  const exitsNear = (roomNum, at, toRoom) => {
    const r = map.rooms[roomNum];
    if (!r) return true;                       // unknown room: do not invent a refusal
    const rows = Number(r.rows), cols = Number(r.cols);
    for (const e of (r.edgeExits ?? [])) {
      if (Number(e.to) !== toRoom) continue;
      const d = e.leaveName === 'north' ? at.row - 1
              : e.leaveName === 'south' ? rows - at.row
              : e.leaveName === 'west'  ? at.col - 1
              : e.leaveName === 'east'  ? cols - at.col : Infinity;
      if (d <= LEAVES_FROM_WITHIN) return true;
    }
    for (const g of (r.goExits ?? [])) {
      if (Number(g.to) !== toRoom || g.locked) continue;
      if (Math.max(Math.abs(g.row - at.row), Math.abs(g.col - at.col)) <= LEAVES_FROM_WITHIN) return true;
    }
    // A sealed room leaves by a teleporter, which can be anywhere its portal tile is, and
    // those tiles are not in the room graph at all — so there is nothing to measure against.
    const out = neighbours.get(Number(roomNum));
    return !out || out.size === 0;
  };
  // Did a body plausibly WALK between these two samples? The same raycast the mover uses.
  const traversable = (roomNum, a, b) => {
    const geo = geoFor(roomNum);
    if (!geo?.collisionReady || typeof geo.traceFineMoveClient !== 'function') return false;
    const t = geo.traceFineMoveClient(protocolToClient(a.x), protocolToClient(a.y),
                                      protocolToClient(b.x), protocolToClient(b.y), { slide: true });
    if (!t) return false;
    return Math.hypot(t.x - protocolToClient(b.x), t.y - protocolToClient(b.y)) <= 64;
  };
  const list = crossings(samples, { neighbours, exitsNear, traversable });

  const best = comb(list, geoFor);
  const wantRoom = arg('--room') ? Number(arg('--room')) : null;
  console.log(`${samples.length} sample(s), ${list.length} crossing(s), ${best.size} track(s) learned\n`);
  console.log('room                             from    to     best   samples  waypoints  seen');
  for (const [key, t] of [...best].sort((a, b) => a[1].room - b[1].room)) {
    if (wantRoom && t.room !== wantRoom) continue;
    console.log(`${String(t.room).padStart(5)} ${String(map.rooms[t.room]?.name ?? '?').slice(0, 26).padEnd(27)} ` +
      `${String(t.from ?? '-').padStart(5)} ${String(t.to).padStart(5)} ${String((t.ms / 1000).toFixed(0) + 's').padStart(7)} ` +
      `${String(t.samples).padStart(8)} ${String(t.waypoints.length).padStart(10)} ${String(t.seen).padStart(5)}` +
      (t.straightened ? '' : '   (not straightened — no geometry)'));
  }
  if (process.argv.includes('--save')) {
    const tracks = {};
    for (const [k, t] of best) tracks[k] = t;

    // A STRIKE CONDEMNS A ROUTE, AND THE KEY IS NOT THE ROUTE. Strikes are filed under
    // `room:from>to` -- the pair of doors -- so they outlive the waypoints they were earned
    // against. Re-bake and every new track inherits the old one's failures: 57 of the 209
    // tracks on disk were already at or past STRIKES_BEFORE_REJECT, which means a better
    // crossing learned this afternoon would have arrived pre-condemned and been refused on
    // its first ride, and the whole point of re-baking is lost silently.
    //
    // So a key whose waypoints CHANGED starts clean. A key whose waypoints did not change is
    // the same route that failed, and keeps its record.
    const before = loadTracks();
    const same = (x, y) => JSON.stringify(x?.waypoints ?? null) === JSON.stringify(y?.waypoints ?? null);
    const strikes = loadStrikes();
    let cleared = 0;
    for (const k of Object.keys(strikes))
      if (tracks[k] && !same(tracks[k], before[k])) { delete strikes[k]; cleared++; }
    if (cleared) {
      fs.writeFileSync(STRIKES_FILE, JSON.stringify({
        note: 'Consecutive failures of a track replay in which nothing living was in the way. ' +
              'Cleared for any crossing whose waypoints changed in the last bake, because a ' +
              'strike condemns a route and the key is only a pair of doors.',
        written: new Date().toISOString(), strikes,
      }, null, 1) + String.fromCharCode(10));
      console.log(`
cleared the strike record of ${cleared} crossing(s) whose route changed`);
    }
    fs.writeFileSync(TRACKS_FILE, JSON.stringify({
      note: 'The quickest crossing anybody has actually walked, per room and pair of doors, ' +
            'straightened against the baked BSP. Made of accepted moves, so it cannot contain ' +
            'a step the mover refuses. Ranked on TIME only: monsters wander, so a death says ' +
            'nothing about the route.',
      written: new Date().toISOString(), tracks,
    }, null, 1) + String.fromCharCode(10));
    console.log('\nwrote ' + TRACKS_FILE);
  }
}
