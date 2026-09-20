#!/usr/bin/env node
// PUT WHAT THE ROUTER BELIEVES ON THE AUTOMAP OF A CLIENT A PERSON IS STANDING IN.
//
//   node tools/m59-overlay.mjs 587                 write substrate/overlay/587.ovl
//   node tools/m59-overlay.mjs --all               every room the bake knows
//   node tools/m59-overlay.mjs 587 --layers safe,trap,disagree
//   node tools/m59-overlay.mjs 587 --route 23,31 10,48    draw a planned route
//   node tools/m59-overlay.mjs --legend            what the colours mean
//   node tools/m59-overlay.mjs --list              which rooms have anything to show
//
// CLI CONTRACT: `--route` and `--mark` square pairs are `row,col`
// (KOD/RoomGeometry order).
//
// OFFLINE. No server, no broker, no logins — this reads the same baked geometry the
// broker plans on and writes a text file. The client reads it (clientd3d/m59dbg.c) and
// paints it under the walls of its own minimap.
//
// WHY THE PICTURE IS EXPORTED RATHER THAN DERIVED IN THE CLIENT. The client has the BSP
// in memory and could compute most of this itself, and that is exactly the trap: the
// question being asked is "what does the ROUTER think", and a second implementation in
// C would be a THIRD map. A disagreement between the picture and the bot would then
// prove nothing at all, which is the one thing this tool must never do. Everything drawn
// here comes from the same `RoomGeometry` the broker walks on, through the same
// `neighbors({collision:true})` the router plans with.
//
// AND THAT IS THE WHOLE POINT OF IT EXISTING. Every geometric claim in this repository
// has been wrong at least once — "another machine is holding the fleet", then "travel is
// frozen", then "both maps agree there is no floor" — and each was settled by a person
// logging in and saying what they saw. Ten minutes of that beat hours of telemetry,
// because every wrong hypothesis predicted the same numbers. The expensive part was
// getting the model's claim and the human's eye into the same picture. This is that.
//
// SEVEN LAYERS, AND THEY ANSWER DIFFERENT QUESTIONS. Do not read them as one hazard map:
//
//   fortress   a SAFE WALL — the red squares: no monster-reach square has line of sight
//              and we have a free shot. The keeper chooses from exactly this set
//   (`safe`, `burned` and `lucky` were painted from the retired safe-spot book and are gone;
//    `walls` is the answer now — see the note in layersFor)
//   was-safe   REMOVED: a square the fleet had STOOD ON and taken nothing — the recorded book
//   burned     a square that held at least once AND failed at least once
//   trap       the body can walk IN and cannot walk back OUT. The one that costs a
//              character, and the one the fleet walks into on purpose
//   isolated   the body can neither enter nor leave. Usually a doorway or a ledge
//   detour     cannot be entered from the body but can be left. Harmless
//   disagree   the coarse grid offers a neighbour the mover refuses. This is the safe
//              wall MECHANISM rather than an outcome, and it is dose-responsive
//
// POCKETS ARE NOT TRAPS AND THE COUNT EVERYONE QUOTES IS THE WRONG ONE. `m59-routes.mjs`
// reports 17,402 "pockets", which is a count of strongly-connected COMPONENTS — a room
// in 68 pieces is 67 of them. The number that names places a character can be stuck in
// is 4,823, and room 587, the room this whole investigation was named after, has
// **zero traps**: 0 traps, 65 detours, 23 isolated. Drawing them apart is why the layers
// are separate, and quoting the pocket count as a hazard figure is wrong by 3.6x and
// wrong in kind.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomGeometry, protocolToClient } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { wedgesIn } from './m59-wedges.mjs';
import { safeWalls } from './m59-safespots.mjs';
import { movementMapFile } from './m59-map-path.mjs';
import { WALKS_DIR } from './m59-crossings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OVERLAY_DIR = () => join(HERE, '..', 'substrate', 'overlay');

// THE PALETTE IS A CONTRACT WITH A PERSON'S MEMORY, so it lives in one place and the
// legend, the file and the terminal all read it. The char is what appears in the grid
// block; the client looks it up and draws nothing at all for a char it has no colour
// for, which is what makes adding a layer safe.
export const LAYERS = [
  { key: 'fortress',  ch: 'F', color: 'FF2020', style: 'solid', label: 'SAFE WALL — nothing in monster reach has line of sight, and we have a free shot; exactly what the keeper chooses from' },
  { key: 'safe',      ch: 'S', color: 'FF9090', style: 'solid', label: 'held, and the geometry agrees' },
  { key: 'lucky',     ch: 'L', color: 'FF80C0', style: 'cross', label: 'held ONCE but the geometry does NOT nominate it' },
  { key: 'burned',    ch: 'B', color: '803030', style: 'cross', label: 'held AND failed here' },
  { key: 'trap',      ch: 'T', color: 'FF00FF', style: 'cross', label: 'TRAP — can walk in, cannot walk out' },
  { key: 'isolated',  ch: 'I', color: '9040FF', style: 'diag',  label: 'isolated — cannot enter or leave' },
  { key: 'detour',    ch: 'd', color: 'C0C000', style: 'diag',  label: 'detour — cannot enter, can leave' },
  { key: 'refused',   ch: 'r', color: '0070FF', style: 'cross', label: 'the ROUTER cannot step off here' },
  { key: 'disagree',  ch: 'x', color: '004080', style: 'hatch', label: 'BSP hems this square in — the safe-wall signal' },
  // THE ONLY LAYER HERE THAT IS NOT DERIVED FROM THE SAME .roo AS THE REST, and the only
  // one that is SUPPOSED TO BE EMPTY. Every other layer is our model arguing with itself;
  // this one is our model against a person. It paints a square when a real client was
  // recorded standing in it and `floorBaseAtClient` says there is no floor there at all.
  // Measured over every walk log on this machine, that is 0 of 2092 positions — so a
  // painted square is a REGRESSION, not a picture, and the layer earns its place by
  // staying blank. See walkedVoid for the off-by-one that made it look otherwise.
  { key: 'walked',    ch: 'W', color: '00FFFF', style: 'solid', label: 'A PERSON STOOD HERE AND WE MODEL IT AS VOID — should never appear' },
  { key: 'floor',     ch: '-', color: '303030', style: 'hatch', label: 'walkable floor' },
  { key: 'route',     ch: 'R', color: '00FF80', style: 'solid', label: 'the planned route' },
];

// PAINTED LAST WINS, so this is ordered least specific first. A square that is both a
// trap and a proven safe wall is drawn as the safe wall, because that is the more
// surprising fact and it is the one a person is standing there to check.
const PAINT_ORDER = ['floor', 'disagree', 'refused', 'detour', 'isolated', 'trap',
                     'fortress', 'burned', 'lucky', 'safe', 'walked', 'route'];

export const DEFAULT_LAYERS = ['fortress', 'safe', 'lucky', 'burned',
                               'trap', 'isolated', 'refused', 'disagree'];

const layerOf = key => LAYERS.find(l => l.key === key) ?? null;

/**
 * Squares where the coarse grid offers a neighbour that a stricter view refuses.
 *
 * TWO PREDICATES, TWO FACTS, AND CONFLATING THEM IS HOW THIS LAYER WAS WRONG FIRST TIME.
 * `which: 'tight'` asks `stepAllowedByCollision` — whether the straight line between two
 * square CENTRES arrives with no sliding. `which: 'refused'` asks `moverStepLands` — what
 * `validateFineTarget` will actually do, which slides and quantizes, and is therefore far
 * more permissive. Room 587 comes out at 330 squares under the first and 8 under the
 * second, and neither number is the other one being wrong:
 *
 *   tight    IS THE SAFE-WALL SIGNAL. A square the BSP hems in is one whose lines to the
 *            surrounding floor are broken — and `Room.LineOfSight` is tested for the
 *            monster and never for us. Measured across the recorded book, 44.0% of squares
 *            that HELD sit on one against 23.9% of ordinary floor in the same rooms, and
 *            it is dose-responsive: 28.2% held at zero refused neighbours, 70.5% at four
 *            or more. This is the layer to look at when the book is empty.
 *   refused  IS WHAT THE ROUTER LOSES. These are the edges A* cannot plan through, so this
 *            is the layer that explains a walk that failed.
 *
 * Counted rather than flagged, so a caller can rank. Returns a Map of "row,col" -> count.
 */
export function disagreements(geometry, { which = 'tight' } = {}) {
  const out = new Map();
  if (!geometry) return out;
  const strict = which === 'refused'
    ? (r, c, n) => geometry.moverStepLands(r, c, n.row, n.col)
    : (r, c, n) => geometry.stepAllowedByCollision(r, c, n.row, n.col);
  for (let row = 1; row <= geometry.rows; row++) {
    for (let col = 1; col <= geometry.cols; col++) {
      if (!geometry.walkable(row, col)) continue;
      let refused = 0;
      for (const n of geometry.neighbors(row, col, { collision: false }))
        if (!strict(row, col, n)) refused++;
      if (refused > 0) out.set(`${row},${col}`, refused);
    }
  }
  return out;
}

/**
 * Build the per-square layer assignment for one room.
 *
 * Pure, and it takes the geometry rather than a room number so a test can hand it a
 * fixture — the same reason `wedgesIn` does.
 */
/**
 * Squares in this room a real client was recorded standing in and we model as void.
 *
 * Returns a Map of "row,col" -> how many recorded positions, empty when there are no walk
 * logs — which is the ordinary state of a fresh clone and must read as "nothing observed"
 * rather than "nothing wrong". Room is matched by the SERVER's object id, because that is
 * what a client reports; the harness room number is our word for it and the two are
 * different namespaces.
 *
 * OVER EVERY WALK LOG ON THIS MACHINE THIS RETURNS NOTHING, 0 OF 2092 POSITIONS, AND THAT
 * IS THE POINT OF IT. It is a regression guard rather than a picture.
 *
 * IT ONCE RETURNED 478, AND EVERY ONE OF THOSE WAS THE CONVERSION BELOW DONE BY HAND.
 * A recorded position is in KOD units (64 to the square) and `floorBaseAtClient` wants
 * client units (1024), so the obvious conversion is `x * 16`. It is wrong by exactly one
 * square: `protocolToClient` is `(x - 64) * 16`, because the wire is 1-based and the
 * leaves are 0-based. Done by hand, 23% of the positions a person had demonstrably walked
 * through came back as void — and it is convincing, because the missing squares cluster in
 * the corridors where the fleet really does get stuck, half of them land more than half a
 * square from any leaf polygon (so it does not look like an epsilon bug), and NONE of them
 * land exactly on a polygon edge. It survived a distance histogram and a per-room coverage
 * count before an offset sweep put dx=dy=-1024 at exactly zero.
 *
 * Two lessons worth more than the layer. **A whole-map coordinate error looks like a local
 * geometry defect**, because it fails hardest exactly where the geometry is tightest — a
 * one-square error in open ground still lands on floor. And **there is a converter for
 * this**; use it. Every measurement in this repository that reads a recorded position must
 * go through `protocolToClient`, never through a scale factor written at the call site.
 */
export function walkedVoid(geometry, roomNum) {
  const out = new Map();
  if (!geometry?.collisionReady || !roomNum) return out;
  let map, dir;
  try {
    map = JSON.parse(readFileSync(movementMapFile(), 'utf8'));
    dir = WALKS_DIR;
    if (!existsSync(dir)) return out;
  } catch { return out; }
  const objId = map.rooms?.[String(roomNum)]?.objId;
  if (!objId) return out;
  const rows = geometry.rows, cols = geometry.cols;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    let lines;
    try { lines = readFileSync(join(dir, f), 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line) continue;
      let p;
      try { p = JSON.parse(line); } catch { continue; }
      if (p.room !== objId || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      // The outward step past the boundary is off the map by design — that IS the trigger
      // for leaving — so it has no floor legitimately and is not evidence about anything.
      if (p.row < 1 || p.col < 1 || p.row > rows || p.col > cols) continue;
      if (geometry.floorBaseAtClient(protocolToClient(p.x), protocolToClient(p.y)) != null) continue;
      const k = `${p.row},${p.col}`;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

export function layersFor(geometry, {
  room = 0,
  wedges = null,
  route = null,
  want = DEFAULT_LAYERS,
} = {}) {
  const wanted = new Set(want);
  const cells = new Map();                       // "row,col" -> layer key
  const put = (row, col, key) => {
    if (!wanted.has(key)) return;
    const was = cells.get(`${row},${col}`);
    if (was && PAINT_ORDER.indexOf(was) >= PAINT_ORDER.indexOf(key)) return;
    cells.set(`${row},${col}`, key);
  };

  if (wanted.has('floor'))
    for (let row = 1; row <= geometry.rows; row++)
      for (let col = 1; col <= geometry.cols; col++)
        if (geometry.walkable(row, col)) put(row, col, 'floor');

  if (wanted.has('disagree'))
    for (const at of disagreements(geometry, { which: 'tight' }).keys()) {
      const [row, col] = at.split(',').map(Number);
      put(row, col, 'disagree');
    }

  if (wanted.has('refused'))
    for (const at of disagreements(geometry, { which: 'refused' }).keys()) {
      const [row, col] = at.split(',').map(Number);
      put(row, col, 'refused');
    }

  // ASKED AT THE POSITION THE CLIENT ACTUALLY REPORTED, never at the square centre, and
  // converted with `protocolToClient` rather than by hand. See walkedVoid.
  if (wanted.has('walked'))
    for (const at of walkedVoid(geometry, room).keys()) {
      const [row, col] = at.split(',').map(Number);
      put(row, col, 'walked');
    }

  // THE SQUARE NOTHING CAN REACH — and this is the criterion, stated by an operator
  // standing on one: *"a true safe wall, you could literally sit there forever and not
  // get attacked. If the creature moves around and stops attacking for a second it won't
  // start again."* That is not a claim about damage over a window, it is a claim about
  // RE-ACQUISITION, and it is absolute rather than statistical.
  //
  // `exposureAt().attackers` is exactly that number: how many squares hold something that
  // could reach us, via `Monster.CanReach` -> `Room.LineOfSight` (monster.kod:1782) — the
  // check the monster makes and `Player.TargetWithinSightAndRange` never does. Zero means
  // no square in the room can start a fight with you, ever, which is why it does not decay
  // and does not need a stopwatch.
  //
  // IT IS COMPUTED, NOT REMEMBERED, and that is the whole point of promoting it above the
  // book. The book's evidence turned out to be 256 single ~16-second windows, 80% against
  // one attacker — noise at the level of one square. This is a property of the walls.
  // Validated live in room 575: the square the operator called a real safe wall reads
  // attackers 0 / free_shots 6 / attackers_avoided 28, and the one they correctly rejected
  // reads attackers 6.
  // THE RED SQUARES ARE THE KEEPER'S CANDIDATES, BY CONSTRUCTION. The rule that painted
  // them — coarse-walkable, no attacker in monster reach, a free shot for us — was checked
  // by eye in the client, room by room, and found right. It now lives in ONE function,
  // safeWalls(), which the keeper's search iterates and this layer paints. Corrected
  // 2026-08-27: until then the keeper chose from a different, disjoint set.
  const walls = new Set();
  if (wanted.has('fortress') || wanted.has('safe') || wanted.has('lucky'))
    for (const w of safeWalls(geometry)) walls.add(`${w.row},${w.col}`);
  if (wanted.has('fortress'))
    for (const w of safeWalls(geometry)) put(w.row, w.col, 'fortress');

  const w = wedges ?? wedgesIn(geometry);
  if (w) {
    for (const s of w.detours ?? [])  put(s.row, s.col, 'detour');
    for (const s of w.isolated ?? []) put(s.row, s.col, 'isolated');
    for (const s of w.traps ?? [])    put(s.row, s.col, 'trap');
  }

  // NOMINATED IS THE MODEL'S OPINION AND IT IS NOT AN OBSERVATION. Kept separate from
  // `safe` for exactly that reason: a square the geometry likes and nobody has stood on
  // is a hypothesis, and the whole value of the book is that it is not one.
  //
  // Computed even when the layer is not wanted, because `safe` versus `lucky` turns on
  // it — see below.

  // THE BOOK LAYER IS GONE, AND THE MEASUREMENT THAT KILLED IT IS WORTH KEEPING.
  //
  // Three colours were painted from the safe-spot book here — `safe`, `burned` and `lucky`
  // — and what they were painted from did not support them. Measured over the whole book,
  // 2026-08-17: ALL 256 squares that held and never failed held EXACTLY ONCE. Median hold
  // was 16 seconds and 206 of the 256 faced a SINGLE attacker, so "proven safe wall" meant
  // "one character stood here for a quarter of a minute with one thing swinging at it and
  // was not hit" — and the hit chance is bounded to [10,95]% (battler.kod:331), so a short
  // quiet window is something ordinary floor produces regularly. 114 of the 256 (44.5%)
  // were not in the geometry's top 200 for their own room, and some admitted SEVENTEEN
  // attackers while being painted the same colour as a genuine corner. Nothing in the
  // record separated the two: every false positive had the identical shape to a true one.
  //
  // `lucky` existed precisely to show that disagreement, and it is no longer needed,
  // because there is no second opinion to disagree WITH. The book is retired (tombstone in
  // m59-safespots.mjs: every row was filed against a keeper's HOLD, not the body's
  // position) and the geometry it was being checked against has since been proven in play
  // — 1,290s on `attackers === 0`, not swinging, monsters in reach and moving, zero
  // attacks. The walls layer IS the answer now, so there is nothing to overlay on it.

  for (const s of route ?? []) put(s.row, s.col, 'route');

  return cells;
}

/**
 * The overlay file itself.
 *
 * A LINE-ORIENTED TEXT FORMAT ON PURPOSE. It is read by ninety lines of C in a program
 * that holds live game sessions, it is diffed when a layer looks wrong, and it is the
 * only artefact standing between a claim in this repository and a person's eye. A binary
 * format would save a few kilobytes and cost every one of those.
 *
 * `shift` is the reconciliation between the two square conventions and it is in the FILE
 * rather than in the client, so the day the convention moves is a rewrite of a text file
 * rather than a rebuild of a client. The harness counts squares from 1; the client's own
 * fine coordinates put harness square N at [(N-1)*FINENESS, N*FINENESS).
 */
export function renderOverlay(geometry, cells, {
  room = 0, name = '', marks = [], objId = 0, security = 0,
} = {}) {
  const used = new Set(cells.values());
  const out = [];
  out.push('m59overlay 1');
  out.push(`room ${room}`);
  // TWO NUMBERS NAME A ROOM AND THE CLIENT ONLY KNOWS ONE OF THEM.
  //
  // The harness calls West Merchant Way through Ilerian Woods room 535 — `num` in the
  // bake, the number in every tool, log line and bug report here. The CLIENT calls it
  // 1365, because `player.room_id` is the room OBJECT's id, which is the bake's
  // `objId`. They are different namespaces and neither is wrong. Written down so the
  // file can be found by either, and so nobody has to rediscover it.
  if (objId) out.push(`objid ${objId}`);
  // AND THE SECURITY NUMBER IS THE PROOF, because object ids are reissued on a save.
  // The client checks this against the .roo it actually loaded, so an overlay that has
  // drifted onto the wrong room draws nothing instead of drawing a confident lie.
  if (security) out.push(`security ${security}`);
  if (name) out.push(`name ${name}`);
  out.push(`rows ${geometry.rows}`);
  out.push(`cols ${geometry.cols}`);
  out.push('shift 0');
  for (const key of PAINT_ORDER) {
    if (!used.has(key)) continue;
    const l = layerOf(key);
    out.push(`color ${l.ch} ${l.color} ${l.style} ${l.label}`);
  }
  for (const m of marks)
    out.push(`mark ${m.row} ${m.col} ${m.color ?? 'FFFFFF'} ${m.label ?? ''}`.trimEnd());
  out.push('grid');
  for (let row = 1; row <= geometry.rows; row++) {
    let line = '';
    for (let col = 1; col <= geometry.cols; col++) {
      const key = cells.get(`${row},${col}`);
      line += key ? layerOf(key).ch : '.';
    }
    out.push(line);
  }
  return out.join('\n') + '\n';
}

// --------------------------------------------------------------------------- the world

/**
 * Load the baked map once and hand back a geometry-per-room accessor.
 *
 * THE MASKS ARE THE WHOLE REASON THIS IS SLOW TO START. Without `attachStepMasks` the
 * geometry answers the COARSE grid's question, `wedgesIn` returns null, and every layer
 * that matters is empty — silently, and with a perfectly well-formed file as the output.
 * So a room with no mask is reported rather than written.
 */
export function loadWorld({ mapFile = movementMapFile() } = {}) {
  const map = JSON.parse(readFileSync(mapFile, 'utf8'));
  const byRoom = new Map();
  const attached = attachStepMasks(map, { geometryOf: room => {
    let geometry = byRoom.get(room);
    if (!geometry) { geometry = RoomGeometry.fromJSON(room.roo); byRoom.set(room, geometry); }
    return geometry;
  } });
  return {
    attached,
    manifest: map.geometryManifestSha256 ?? null,
    rooms: map.rooms,
    geometryOf(num) {
      const room = map.rooms?.[String(num)];
      return room ? (byRoom.get(room) ?? null) : null;
    },
    nameOf(num) { return map.rooms?.[String(num)]?.name ?? ''; },
    objIdOf(num) { return map.rooms?.[String(num)]?.objId ?? 0; },
  };
}

export function writeOverlay(world, room, {
  dir = OVERLAY_DIR(), want = DEFAULT_LAYERS, route = null, marks = [],
} = {}) {
  const geometry = world.geometryOf(room);
  if (!geometry) return { room, written: false, why: 'no geometry for that room' };
  if (!geometry.hasStepMask)
    return { room, written: false, why: 'no baked step mask — run node tools/setup.mjs routes' };

  const objId = world.objIdOf(room);
  const cells = layersFor(geometry, { room, route, want });
  const text = renderOverlay(geometry, cells, {
    room, name: world.nameOf(room), marks, objId, security: geometry.security ?? 0 });
  mkdirSync(dir, { recursive: true });

  // WRITTEN UNDER BOTH NAMES, and the duplicate is the point rather than an oversight.
  // The client can only ask by `player.room_id`, which is the objId; a person reading
  // this directory, and every other tool here, thinks in room numbers. One file each
  // costs a couple of kilobytes and removes a whole class of "the overlay is there and
  // the client says there is no overlay".
  const file = join(dir, `${objId || room}.ovl`);
  writeFileSync(file, text);
  const alias = objId && objId !== room ? join(dir, `${room}.ovl`) : null;
  if (alias) writeFileSync(alias, text);

  const counts = {};
  for (const key of cells.values()) counts[key] = (counts[key] ?? 0) + 1;
  return { room, objId, written: true, file, alias, bytes: text.length,
           squares: cells.size, counts };
}

// --------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-overlay.mjs')) {
  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };
  const square = s => {
    const [a, b] = String(s).split(',').map(Number);
    return Number.isFinite(a) && Number.isFinite(b) ? { row: a, col: b } : null;
  };

  if (has('legend')) {
    console.log('m59-overlay layers — the char is what appears in the grid block\n');
    for (const l of LAYERS)
      console.log(`  ${l.ch}  #${l.color}  ${l.style.padEnd(6)}  ${l.key.padEnd(10)} ${l.label}`);
    console.log('\ndefault: ' + DEFAULT_LAYERS.join(','));
    process.exit(0);
  }

  const dir = flag('dir', OVERLAY_DIR());
  const want = (flag('layers') ?? DEFAULT_LAYERS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  for (const key of want)
    if (!layerOf(key)) {
      console.error(`unknown layer "${key}" — try --legend`);
      process.exit(2);
    }

  const mapFile = movementMapFile();
  if (!existsSync(mapFile)) {
    console.error(`no movement map at ${mapFile} — run node tools/setup.mjs server`);
    process.exit(2);
  }

  process.stderr.write('loading the baked map (this takes a few seconds)...\n');
  const world = loadWorld({ mapFile });
  process.stderr.write(`step masks: ${JSON.stringify(world.attached)}\n`);

  const rooms = has('all')
    ? Object.keys(world.rooms).map(Number).sort((a, b) => a - b)
    : argv.filter(a => /^\d+$/.test(a)).map(Number);

  if (has('list')) {
    const rows = [];
    for (const room of Object.keys(world.rooms).map(Number).sort((a, b) => a - b)) {
      const geometry = world.geometryOf(room);
      if (!geometry?.hasStepMask) continue;
      const w = wedgesIn(geometry);
      if (!w) continue;
      rows.push({ room, name: world.nameOf(room), traps: w.traps.length,
                  isolated: w.isolated.length, detours: w.detours.length });
    }
    rows.sort((a, b) => b.traps - a.traps);
    console.log('room  traps  isol  det  name');
    for (const r of rows.slice(0, Number(flag('top', 40))))
      console.log(`${String(r.room).padStart(4)}  ${String(r.traps).padStart(5)}  ` +
                  `${String(r.isolated).padStart(4)}  ${String(r.detours).padStart(3)}  ` +
                  `${r.name}`);
    process.exit(0);
  }

  if (!rooms.length) {
    console.error('name a room number, or --all, or --list. --legend for the colours.');
    process.exit(2);
  }

  // A ROUTE IS PLANNED WITH THE ROUTER'S OWN `path`, not re-implemented, for the same
  // reason the layers are: the picture is only worth anything if it is the thing the bot
  // will actually do.
  let route = null;
  const routeArgs = [];
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === '--route') { routeArgs.push(argv[i + 1], argv[i + 2]); break; }
  if (routeArgs[0] && routeArgs[1] && rooms.length === 1) {
    const from = square(routeArgs[0]), to = square(routeArgs[1]);
    const geometry = world.geometryOf(rooms[0]);
    if (from && to && geometry) {
      const p = geometry.path(from.row, from.col, to.row, to.col);
      if (p.found) {
        route = [from, ...p.steps.map(s => ({ row: s.row, col: s.col }))];
        want.push('route');
        console.log(`route ${from.row},${from.col} -> ${to.row},${to.col}: ` +
                    `${p.steps.length} steps, expanded ${p.expanded}`);
      } else {
        console.log(`NO ROUTE ${from.row},${from.col} -> ${to.row},${to.col}: ${p.reason} ` +
                    `(expanded ${p.expanded}${p.collision_view ? ', collision view' : ''})`);
      }
    }
  }

  const marks = [];
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === '--mark') {
      const s = square(argv[i + 1]);
      if (s) marks.push({ ...s, color: 'FFFFFF', label: argv[i + 2] && !argv[i + 2].startsWith('--') ? argv[i + 2] : '' });
    }

  let wrote = 0, skipped = 0;
  for (const room of rooms) {
    const r = writeOverlay(world, room, { dir, want, route, marks });
    if (!r.written) { skipped++; if (rooms.length === 1) console.log(`${room}: ${r.why}`); continue; }
    wrote++;
    if (rooms.length <= 12) {
      const parts = Object.entries(r.counts).map(([k, n]) => `${k} ${n}`).join(', ');
      console.log(`${r.file}  ${r.squares} squares  (${parts || 'nothing to draw'})`);
    }
  }
  if (rooms.length > 12) console.log(`wrote ${wrote}, skipped ${skipped}, into ${dir}`);
  console.log(`\npoint the client at it:  set M59_OVERLAY_DIR=${dir}`);
}
