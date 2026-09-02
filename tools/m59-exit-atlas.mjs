#!/usr/bin/env node
// Compact, immutable edge-approach projections for the optional lab runtime.
//
// A cold RoomGeometry cannot always adopt the edgeApproaches embedded in m59-map.json:
// those rows predate parts of the current collision predicate, and one failed semantic
// check correctly makes the decoder derive the direction live.  That derivation traces
// dozens of fine BSP segments and costs hundreds of milliseconds per direction.  It is
// pure, however, so the lab can bake today's accepted answer once and share it among all
// actors using the same map.
//
// Production never reads this atlas.  Lab use is fail-closed at every static boundary:
// format/predicate version, whole-map geometry manifest, room number, security and
// dimensions must all agree.  A missing or invalid direction simply returns null and the
// caller performs the ordinary authoritative derivation.
//
//   node tools/m59-exit-atlas.mjs build
//   node tools/m59-exit-atlas.mjs status


import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_ATLAS_FORMAT = 'm59-exit-atlas/1';
// Bump whenever edgeCrossingCandidates/edgeApproachCandidates or their semantic
// acceptance rules change.  The geometry manifest deliberately cannot detect a code-only
// predicate change.
export const EXIT_APPROACH_VERSION = 1;

const DIRECTIONS = Object.freeze(['north', 'south', 'west', 'east']);
const KOD_FINENESS = 64;
const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '..', 'substrate', 'm59-exit-atlas.json');

const APPROACHES_BY_ROOM = new WeakMap();
const ATTACHED_MAPS = new WeakMap();
let fileCache = { file: null, mtime: -1, size: -1, value: null };

export function exitAtlasFile() {
  const configured = process.env.M59_EXIT_ATLAS;
  return configured && configured !== '0' ? path.resolve(configured) : DEFAULT_FILE;
}

function loadAtlas(file = exitAtlasFile()) {
  let stat = null;
  try { stat = fs.statSync(file); } catch { /* absent is the normal fallback */ }
  if (!stat) return null;
  if (fileCache.file === file && fileCache.mtime === stat.mtimeMs &&
      fileCache.size === stat.size) return fileCache.value;
  let value = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.format === EXIT_ATLAS_FORMAT &&
        Number(parsed.approachVersion) === EXIT_APPROACH_VERSION &&
        parsed.complete === true && parsed.rooms && typeof parsed.rooms === 'object')
      value = parsed;
  } catch { /* malformed means absent, never partially trusted */ }
  fileCache = { file, mtime: stat.mtimeMs, size: stat.size, value };
  return value;
}

const integer = value => Number.isInteger(value) && Number.isSafeInteger(value);

function fixedCoordinates(direction, rows, cols) {
  const horizontal = direction === 'north' || direction === 'south';
  return {
    horizontal,
    inside: direction === 'north' || direction === 'west'
      ? KOD_FINENESS + (KOD_FINENESS >> 1)
      : ((horizontal ? rows : cols) * KOD_FINENESS) + (KOD_FINENESS >> 1),
    outside: direction === 'north' || direction === 'west'
      ? KOD_FINENESS - 1
      : ((horizontal ? rows : cols) + 1) * KOD_FINENESS,
  };
}

function restoreDirection(direction, encoded, rows, cols) {
  if (!Array.isArray(encoded)) return null;
  const fixed = fixedCoordinates(direction, rows, cols);
  const restored = [];
  for (const row of encoded) {
    if (!Array.isArray(row) || row.length !== 6 ||
        !row.slice(0, 4).every(integer) || !Array.isArray(row[4]) || !row[4].length ||
        !row[4].every(stage => Array.isArray(stage) && stage.length === 2 &&
          integer(stage[0]) && stage[0] >= 1 && stage[0] <= cols &&
          integer(stage[1]) && stage[1] >= 1 && stage[1] <= rows) ||
        (row[5] !== 0 && row[5] !== 1)) return null;
    const [standX, standY, targetX, targetY, stages, graphRoutable] = row;
    const along = fixed.horizontal ? standX : standY;
    const targetAlong = fixed.horizontal ? targetX : targetY;
    if ((fixed.horizontal
      ? standY !== fixed.inside || targetY !== fixed.outside
      : standX !== fixed.inside || targetX !== fixed.outside) ||
      along !== targetAlong || along < KOD_FINENESS ||
      along > (fixed.horizontal ? cols : rows) * KOD_FINENESS + KOD_FINENESS)
      return null;
    restored.push(Object.freeze({
      fine_stand_on: Object.freeze({ x: standX, y: standY }),
      edge_target: Object.freeze({ x: targetX, y: targetY }),
      col: Math.floor(standX / KOD_FINENESS),
      row: Math.floor(standY / KOD_FINENESS),
      stages: Object.freeze(stages.map(([col, stageRow]) => Object.freeze({
        col, row: stageRow,
      }))),
      graph_routable: graphRoutable !== 0,
    }));
  }
  return Object.freeze(restored);
}

function restoreRoom(room, encoded) {
  const rows = Number(room?.rows), cols = Number(room?.cols);
  if (!room?.roo || !encoded || Number(encoded.room) !== Number(room.num) ||
      !integer(rows) || !integer(cols) || rows <= 0 || cols <= 0 ||
      Number(encoded.rows) !== rows || Number(encoded.cols) !== cols ||
      room.roo.security == null || encoded.security == null ||
      Number(encoded.security) !== Number(room.roo.security) ||
      !encoded.directions || typeof encoded.directions !== 'object') return null;
  const directions = {};
  for (const direction of DIRECTIONS) {
    const restored = restoreDirection(direction, encoded.directions[direction], rows, cols);
    if (!restored) return null;
    directions[direction] = restored;
  }
  return Object.freeze(directions);
}

function detachMap(map) {
  // The production/default fast path has never attached anything. Avoid turning every
  // cached loadMap() read there into a 264-room sweep merely to prove an empty WeakMap is
  // still empty.
  if (!map || typeof map !== 'object' || !ATTACHED_MAPS.has(map)) return;
  for (const room of Object.values(map?.rooms ?? {})) APPROACHES_BY_ROOM.delete(room);
  ATTACHED_MAPS.delete(map);
}

/**
 * Attach a current atlas to this exact map's room objects.  This is deliberately called
 * from loadMap rather than m59-game, so every optional lab consumer gets one answer while
 * production/default imports remain inert.
 */
export function attachLabExitAtlas(map, { file = exitAtlasFile(), force = false } = {}) {
  // NOT LAB-ONLY ANY MORE. Measured on the shadow fleet, 2026-09-01: every hop of a journey
  // calls `World.route()`, which calls `exits()`, which without this artifact derives the
  // fine-boundary approaches live — 2,281 route searches over one second in a day's keeper
  // logs, 595 over five, 52 over eight, 10.5 s at worst — and a keeper blocked that long is
  // silent, which at blakserv's INACTIVE_GAME of 30 seconds is a logout. The atlas removes
  // that derivation and is proven equal to it by m59-world-exit-atlas-test's exact comparison
  // of all 3,346 approaches. The operator's rule: nothing production relies on may sit behind
  // the lab profile, so the artifact is used whenever it is present and matches the map in
  // play; `M59_EXIT_ATLAS=0` is the only way to refuse it. A missing or stale artifact still
  // falls through to the live derivation exactly as before.
  if (!force && process.env.M59_EXIT_ATLAS === '0') {
    detachMap(map);
    return { ok: false, attached: 0, why: 'the exit atlas is switched off (M59_EXIT_ATLAS=0)' };
  }
  if (!map || typeof map !== 'object') return { ok: false, attached: 0, why: 'no map' };
  const atlas = loadAtlas(file);
  if (!atlas) {
    detachMap(map);
    return { ok: false, attached: 0, why: 'no current exit atlas' };
  }
  if (!atlas.geometryManifestSha256 || !map.geometryManifestSha256 ||
      atlas.geometryManifestSha256 !== map.geometryManifestSha256) {
    detachMap(map);
    return { ok: false, attached: 0, why: 'the exit atlas was baked from different geometry' };
  }
  const prior = ATTACHED_MAPS.get(map);
  if (prior?.atlas === atlas) return prior.summary;

  let attached = 0, refused = 0;
  for (const [num, room] of Object.entries(map.rooms ?? {})) {
    APPROACHES_BY_ROOM.delete(room);
    const restored = restoreRoom(room, atlas.rooms[num]);
    if (!restored) { refused++; continue; }
    APPROACHES_BY_ROOM.set(room, restored);
    attached++;
  }
  const summary = Object.freeze({
    ok: attached > 0,
    attached,
    refused,
    rooms: Object.keys(map.rooms ?? {}).length,
    file,
    approach_version: EXIT_APPROACH_VERSION,
  });
  ATTACHED_MAPS.set(map, { atlas, summary });
  return summary;
}

/** Frozen current candidates, an empty frozen list, or null when live derivation is due. */
export function labExitApproaches(room, direction) {
  if (!room || typeof room !== 'object') return null;
  return APPROACHES_BY_ROOM.get(room)?.[String(direction ?? '').toLowerCase()] ?? null;
}

function encodeCandidate(candidate) {
  return [
    candidate.fine_stand_on.x, candidate.fine_stand_on.y,
    candidate.edge_target.x, candidate.edge_target.y,
    candidate.stages.map(stage => [stage.col, stage.row]),
    candidate.graph_routable === false ? 0 : 1,
  ];
}

/** Build data in memory. Kept exported so the exhaustive offline test uses the same writer. */
export async function buildExitAtlas(map, { geometryOf } = {}) {
  if (!map?.geometryManifestSha256 || !map?.rooms)
    throw new Error('map has no geometry manifest');
  const getGeometry = geometryOf ??
    (await import('./m59-roo.mjs')).sharedRoomGeometry;
  const rooms = {};
  let candidateCount = 0;
  const entries = Object.entries(map.rooms);
  for (let index = 0; index < entries.length; index++) {
    const [num, room] = entries[index];
    if (!room?.roo || room.rooDimensionMismatch) continue;
    const geometry = getGeometry(room);
    if (!geometry?.collisionReady)
      throw new Error(`room ${num} has no collision-ready geometry`);
    const directions = {};
    for (const direction of DIRECTIONS) {
      const candidates = geometry.edgeApproachCandidates(direction);
      directions[direction] = candidates.map(encodeCandidate);
      candidateCount += candidates.length;
    }
    rooms[num] = {
      room: Number(room.num), rows: Number(room.rows), cols: Number(room.cols),
      security: Number(room.roo.security), directions,
    };
    if ((index + 1) % 25 === 0)
      process.stderr.write(`\r  exit atlas: ${index + 1}/${entries.length} rooms`);
  }
  if (entries.length >= 25) process.stderr.write('\n');
  return {
    format: EXIT_ATLAS_FORMAT,
    approachVersion: EXIT_APPROACH_VERSION,
    geometryManifestSha256: map.geometryManifestSha256,
    complete: Object.keys(rooms).length === entries.filter(([, room]) => room?.roo &&
      !room.rooDimensionMismatch).length,
    builtAt: new Date().toISOString(),
    rooms,
    summary: { rooms: Object.keys(rooms).length, candidates: candidateCount },
  };
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    fs.writeFileSync(descriptor, JSON.stringify(value));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = null;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

async function main() {
  const command = process.argv[2] ?? 'status';
  const file = exitAtlasFile();
  if (command === 'build') {
    // Import after this module has initialized: m59-map's read side imports us too.
    const { loadMap } = await import('./m59-map.mjs');
    const atlas = await buildExitAtlas(loadMap());
    if (!atlas.complete) throw new Error('refusing to write an incomplete exit atlas');
    writeAtomic(file, atlas);
    console.log(`wrote ${file}: ${atlas.summary.rooms} rooms, ` +
      `${atlas.summary.candidates} boundary approaches`);
    return;
  }
  if (command === 'status') {
    const atlas = loadAtlas(file);
    if (!atlas) {
      console.log(`no current exit atlas at ${file}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ file, format: atlas.format,
      approach_version: atlas.approachVersion,
      geometry_manifest: atlas.geometryManifestSha256,
      complete: atlas.complete,
      rooms: Object.keys(atlas.rooms).length,
      candidates: atlas.summary?.candidates ?? null }, null, 2));
    return;
  }
  throw new Error('usage: node tools/m59-exit-atlas.mjs [build|status]');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) ===
  path.resolve(fileURLToPath(import.meta.url));
if (invoked) main().catch(error => {
  console.error(`m59-exit-atlas: ${error.message}`);
  process.exitCode = 1;
});
