// The tactical annotation sidecar: turns "the operator pointed at something in
// the Red Alert viewer" into a mark on the Meridian client's own automap.
//
// WHY THIS EXISTS. Every positional argument in this project has been conducted
// in numbers -- "t3 is fighting a battered skeleton", "the bot is stuck at
// (23,31)" -- and a room routinely holds four battered skeletons. A person
// standing in the world can settle in one glance which one is meant, but only
// if somebody can point. This is the pointing.
//
// WHAT IT IS NOT. It carries no orders. The viewer that sends these datagrams
// holds no order endpoint and its compiled action allowlist refuses movement
// and attack; a datagram here is a request to DRAW, and the worst a malformed
// or hostile one can do is paint a circle in the wrong square.
//
// HOW IT DRAWS. Nothing new was added to the client for this. m59dbg.c has
// carried a `mark` record since it was written -- a 2px ellipse plus a
// horizontal and a vertical line through its centre, which is a circle with
// crosshairs -- and in 498 overlays on disk not one has ever used it. This
// fills in the writer that was missing. Marks are re-rendered through the
// existing writeOverlay(), so the geometry layers under them stay exactly what
// the harness believes; this only adds marks on top.
//
// KNOWN LIMITS, none of which are bugs here:
//   - A mark names a SQUARE, not an object. It is drawn where the creature
//     stood when the operator clicked, and it does not follow anything. For a
//     mark that tracks a moving target the client needs the object-id halo,
//     which is a Meridian59 client change and is not this file.
//   - The client re-stats the overlay about once a second (DBG_STAT_MS), so a
//     mark appears within roughly that.
//   - The ring's radius is one whole square, so it is two squares across and a
//     neighbour falls inside it; the crosshair is what disambiguates.
//   - The file is per-room, so every patched client standing in that room sees
//     the same annotation. There is no per-character overlay path today.
//
// PHASE 2. --client-port also forwards each annotation to a patched Meridian
// client's inbound socket (M59_ANNOTATE_PORT), which keys a highlight on the
// OBJECT rather than a square, so it follows the creature instead of marking
// where it used to stand. That half needs a client rebuild; the minimap half
// above does not, and the two are independent -- run either or both.
//
// Usage:  node tools/m59-annotate.mjs [--port 8919] [--ttl 20000] [--dry-run]
//                                     [--client-port 8920]

import { createSocket } from 'node:dgram';
import { movementMapFile } from './m59-map-path.mjs';
import { OVERLAY_DIR, loadWorld, writeOverlay } from './m59-overlay.mjs';

const DEFAULT_PORT = 8919;
// Well under m59dbg.c's DBG_MAX_MARKS (64). Marks past the cap are silently
// dropped by the client, and a picture that quietly loses the mark you just
// made is worse than one that shows fewer.
const MAX_MARKS_PER_ROOM = 12;
const COLOURS = { attack: 'FF0000', move: '00FF00', point: '00FF00', look: 'FFFF00' };

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback;
};
const port = Number(flag('port', DEFAULT_PORT));
const defaultTtl = Number(flag('ttl', 20000));
const dryRun = argv.includes('--dry-run');
const clientPort = Number(flag('client-port', 0));
const dir = flag('dir', OVERLAY_DIR());

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`--port must be 1..65535, got ${port}`);
  process.exit(2);
}

// room number -> Map(key -> {row, col, colour, label, expires})
const rooms = new Map();

function annotationKey(record) {
  // One mark per (kind, target). Pointing at the same skeleton twice refreshes
  // the mark instead of stacking a second ring on the same square.
  return `${record.kind}:${record.object_id ?? `${record.row},${record.col}`}`;
}

function accept(record) {
  if (!record || record.v !== 1) return null;
  const room = Number(record.room_num);
  if (!Number.isInteger(room) || room <= 0) return null;
  const row = Number(record.row);
  const col = Number(record.col);
  // A mark is a square. Without one there is nothing to draw, whatever else
  // the datagram said.
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
  const kind = typeof record.kind === 'string' ? record.kind : 'point';
  const ttl = Number.isFinite(Number(record.ttl_ms)) ? Number(record.ttl_ms) : defaultTtl;
  const name = typeof record.name === 'string' ? record.name : '';
  return {
    room,
    key: annotationKey({ ...record, kind, row, col }),
    row: Math.max(1, Math.round(row)),
    col: Math.max(1, Math.round(col)),
    colour: COLOURS[kind] ?? COLOURS.point,
    // The client parses a label, stores it, and never draws it -- verified in
    // m59dbg.c, which contains no text call at all. Kept because it costs
    // nothing and reads well when a person opens the .ovl by hand.
    label: `${kind}${name ? ` ${name}` : ''}`.slice(0, 60),
    expires: Date.now() + Math.max(1000, Math.min(600000, ttl)),
  };
}

function liveMarks(room) {
  const held = rooms.get(room);
  if (!held) return [];
  const now = Date.now();
  for (const [key, mark] of held) if (mark.expires <= now) held.delete(key);
  if (held.size === 0) { rooms.delete(room); return []; }
  // Newest first, then capped, so the thing just pointed at always survives.
  return [...held.values()]
    .sort((a, b) => b.expires - a.expires)
    .slice(0, MAX_MARKS_PER_ROOM)
    .map((m) => ({ row: m.row, col: m.col, color: m.colour, label: m.label }));
}

process.stderr.write('loading the baked map (this takes a few seconds)...\n');
const mapFile = movementMapFile();
const world = loadWorld({ mapFile });
process.stderr.write(`map loaded; overlays go to ${dir}\n`);

function repaint(room) {
  const marks = liveMarks(room);
  if (dryRun) {
    console.log(`[dry-run] room ${room}: ${marks.length} mark(s) ` +
      marks.map((m) => `${m.color}@${m.row},${m.col}`).join(' '));
    return;
  }
  try {
    const result = writeOverlay(world, room, { dir, marks });
    if (!result.written) {
      console.log(`room ${room}: not written (${result.why})`);
      return;
    }
    console.log(`room ${room}: ${marks.length} mark(s) -> ${result.file}` +
      (result.alias ? ` (+${result.alias})` : ''));
  } catch (error) {
    // A debugging aid must never take itself down over one bad room.
    console.log(`room ${room}: overlay write failed: ${error.message}`);
  }
}

// One socket for the whole run rather than one per datagram: this is a hot-ish
// path and a socket per mark would churn handles for no benefit.
const forward = createSocket('udp4');
const socket = createSocket('udp4');
socket.on('message', (datagram) => {
  let record = null;
  try {
    record = JSON.parse(datagram.toString('utf8'));
  } catch {
    return;  // fail quiet: a malformed datagram costs a picture, never a run
  }
  const mark = accept(record);
  if (!mark) return;
  // Forward to the patched client, if one is listening. Key=value rather than
  // JSON because the receiver is C in a game loop; see DebugAnnotationDrain.
  if (clientPort > 0 && Number.isInteger(Number(record.object_id))) {
    const line = `id=${Number(record.object_id)} colour=${mark.colour} ` +
      `ttl=${Math.max(0, mark.expires - Date.now())}`;
    forward.send(Buffer.from(line), clientPort, '127.0.0.1', () => {});
  }
  if (!rooms.has(mark.room)) rooms.set(mark.room, new Map());
  rooms.get(mark.room).set(mark.key, mark);
  console.log(`annotate ${record.kind} "${record.name ?? ''}" ` +
    `room ${mark.room} at ${mark.row},${mark.col}` +
    (record.object_id ? ` object ${record.object_id}` : ''));
  repaint(mark.room);
});

// Expired marks have to be swept even when nothing new arrives, or the last
// annotation in a room stays on screen forever.
const sweep = setInterval(() => {
  for (const room of [...rooms.keys()]) {
    const before = rooms.get(room)?.size ?? 0;
    liveMarks(room);
    const after = rooms.get(room)?.size ?? 0;
    if (after !== before) repaint(room);
  }
}, 2000);
sweep.unref?.();

socket.on('error', (error) => {
  console.error(`annotate socket error: ${error.message}`);
  process.exit(1);
});
socket.bind(port, '127.0.0.1', () => {
  console.log(`m59-annotate listening on 127.0.0.1:${port} (udp)`);
  console.log('point the viewer at it:  -AnnotatePort ' + port);
  console.log('point the client at it:  set M59_OVERLAY_DIR=' + dir);
  if (clientPort > 0) {
    console.log(`forwarding object highlights to 127.0.0.1:${clientPort} ` +
      '(patched client only; set M59_ANNOTATE_PORT there)');
  }
});
