#!/usr/bin/env node
// Compile the public, static m59-map.json graph into a small renderer-neutral
// atlas seam. This tool reads files only when its CLI is invoked. It has no
// network, process-control, broker, gateway, or fleet imports.

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ATLAS_TOPOLOGY_SCHEMA = 'M59ATLAS/1';

export const DEFAULT_ATLAS_TOPOLOGY_LIMITS = Object.freeze({
  max_input_bytes: 64 * 1024 * 1024,
  max_output_bytes: 16 * 1024 * 1024,
  max_json_depth: 64,
  max_json_values: 4 * 1024 * 1024,
  max_rooms: 4096,
  max_exits_per_room: 512,
  max_total_exits: 128 * 1024,
  max_text_bytes: 4096,
  max_dimension: 4096,
});

const TOP_LEVEL_KEYS = new Set([
  'builtAt', 'geometryManifestSha256', 'geometryRoomCount',
  'geometrySource', 'note', 'rooms',
]);
const ROOM_KEYS = new Set([
  'cls', 'cols', 'edgeExits', 'flags', 'goExits', 'name', 'nameRsc',
  'num', 'objId', 'roo', 'rooFile', 'roomRsc', 'rows', 'rsc', 'yellZone',
]);
const EDGE_KEYS = new Set([
  'angleChange', 'arriveCol', 'arriveRow', 'condition', 'leave',
  'leaveName', 'to',
]);
const GO_KEYS = new Set([
  'angleChange', 'arriveCol', 'arriveRow', 'col', 'locked', 'row', 'to',
]);
const CONDITION_KEYS = new Set(['name', 'threshold', 'type']);
const LEAVE_NAMES = new Map([
  [1, 'south'], [2, 'north'], [3, 'west'], [4, 'east'],
]);
const CONDITION_NAMES = new Map([
  [1, 'row>'], [2, 'row<'], [3, 'col>'], [4, 'col<'], [5, 'default'],
]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const JSON_NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const GENERATION_TOKEN = Symbol('AtlasMapGeneration');

export class AtlasTopologyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AtlasTopologyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AtlasTopologyError(code, message);
}

function limitsOf(overrides = {}) {
  if (!isRecord(overrides)) fail('invalid-argument', 'limits must be an object');
  const limits = { ...DEFAULT_ATLAS_TOPOLOGY_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in limits)) fail('invalid-argument', `unknown limit ${key}`);
    if (!Number.isSafeInteger(value) || value < 1)
      fail('invalid-argument', `limit ${key} must be a positive safe integer`);
    limits[key] = value;
  }
  return limits;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail('malformed-input', `${label} must be an object`);
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      fail('malformed-input', `${label} contains unsupported field ${key}`);
  }
}

function exactInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    fail('malformed-input', `${label} is outside ${minimum}..${maximum}`);
  return value;
}

function validUnicodeScalars(value) {
  for (let i = 0; i < value.length; ++i) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++i >= value.length) return false;
      const next = value.charCodeAt(i);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function exactText(value, label, maxBytes, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value) ||
      Buffer.byteLength(value, 'utf8') > maxBytes ||
      /[\u0000-\u001f\u007f]/.test(value) || !validUnicodeScalars(value)) {
    fail('malformed-input', `${label} must be bounded scalar UTF-8 text without controls`);
  }
  return value;
}

function exactRooFile(value, label, maxBytes) {
  const text = exactText(value, label, maxBytes);
  if (text === '.' || text === '..' || /[\\/:]/.test(text) ||
      !text.toLowerCase().endsWith('.roo')) {
    fail('malformed-input', `${label} must be an exact local .roo basename`);
  }
  return text;
}

function optionalInteger(value, label, minimum, maximum) {
  if (value === null || value === undefined) return null;
  return exactInteger(value, label, minimum, maximum);
}

// The checked harness map defines this manifest algorithm. Reproducing it here
// lets the compiler reject a partially edited or stale room collection without
// importing harness code or touching its repository.
export function geometryManifestForRooms(rooms) {
  if (!isRecord(rooms)) fail('malformed-input', 'rooms must be an object');
  const entries = Object.entries(rooms).map(([key, room]) => [
    key,
    room?.num ?? null,
    room?.rows ?? null,
    room?.cols ?? null,
    room?.rooFile ?? null,
    room?.roo?.file ?? room?.rooFile ?? null,
    room?.roo?.security ?? null,
    room?.roo?.collision?.digest ?? null,
  ]).sort((left, right) => Number(left[0]) - Number(right[0]));
  return {
    geometryRoomCount: entries.length,
    geometryManifestSha256: createHash('sha256')
      .update(JSON.stringify(entries)).digest('hex'),
  };
}

// JSON.parse accepts duplicate object keys with last-one-wins behavior. That is
// unsuitable for a deterministic build input, so this bounded structural pass
// rejects decoded duplicate keys (including "x" versus "\u0078") first.
export function rejectDuplicateJsonKeys(text, limitOverrides = {}) {
  const limits = limitsOf(limitOverrides);
  if (typeof text !== 'string') fail('malformed-input', 'JSON input must be text');
  let at = 0;
  let values = 0;

  const bad = message => fail('malformed-json', `${message} at character ${at}`);
  const skipWhitespace = () => {
    while (at < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[at])) ++at;
  };
  const scanString = decode => {
    if (text[at] !== '"') bad('expected JSON string');
    const start = at++;
    while (at < text.length) {
      const code = text.charCodeAt(at++);
      if (code === 0x22) {
        if (!decode) return null;
        try { return JSON.parse(text.slice(start, at)); }
        catch { bad('invalid JSON string'); }
      }
      if (code < 0x20) bad('control character in JSON string');
      if (code !== 0x5c) continue;
      if (at >= text.length) bad('truncated JSON escape');
      const escape = text[at++];
      if ('"\\/bfnrt'.includes(escape)) continue;
      if (escape !== 'u') bad('invalid JSON escape');
      if (at + 4 > text.length || !/^[0-9a-fA-F]{4}$/.test(text.slice(at, at + 4)))
        bad('invalid JSON unicode escape');
      at += 4;
    }
    bad('unterminated JSON string');
  };
  const scanValue = depth => {
    if (++values > limits.max_json_values)
      fail('limit-exceeded', `JSON value count exceeds ${limits.max_json_values}`);
    if (depth > limits.max_json_depth)
      fail('limit-exceeded', `JSON depth exceeds ${limits.max_json_depth}`);
    skipWhitespace();
    const token = text[at];
    if (token === '{') {
      ++at;
      const keys = new Set();
      skipWhitespace();
      if (text[at] === '}') { ++at; return; }
      for (;;) {
        skipWhitespace();
        const key = scanString(true);
        if (keys.has(key)) fail('duplicate-input', `duplicate JSON object key at character ${at}`);
        keys.add(key);
        skipWhitespace();
        if (text[at++] !== ':') bad('expected colon after object key');
        scanValue(depth + 1);
        skipWhitespace();
        if (text[at] === '}') { ++at; return; }
        if (text[at++] !== ',') bad('expected comma in object');
      }
    }
    if (token === '[') {
      ++at;
      skipWhitespace();
      if (text[at] === ']') { ++at; return; }
      for (;;) {
        scanValue(depth + 1);
        skipWhitespace();
        if (text[at] === ']') { ++at; return; }
        if (text[at++] !== ',') bad('expected comma in array');
      }
    }
    if (token === '"') { scanString(false); return; }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, at)) { at += literal.length; return; }
    }
    JSON_NUMBER_RE.lastIndex = at;
    const number = JSON_NUMBER_RE.exec(text);
    if (!number) bad('invalid JSON value');
    at = JSON_NUMBER_RE.lastIndex;
  };

  skipWhitespace();
  if (!text.length || at === text.length) bad('empty JSON input');
  scanValue(1);
  skipWhitespace();
  if (at !== text.length) bad('trailing JSON content');
}

function percentEncode(value) {
  const bytes = Buffer.from(value, 'utf8');
  let encoded = '';
  for (const byte of bytes) {
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
        (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2e ||
        byte === 0x5f || byte === 0x7e) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return encoded;
}

function staticToken(room, label, maxTextBytes) {
  const security = room.roo.security;
  if (security !== null && security !== undefined) {
    if (!Number.isSafeInteger(security) || security < 0 || security > 0xffffffff)
      fail('malformed-input', `${label}.roo.security must be an unsigned 32-bit integer`);
    return { kind: 'roo-security-u32', value: String(security) };
  }
  const digest = room.roo?.collision?.digest;
  if (typeof digest === 'string' && SHA256_RE.test(digest)) {
    exactText(digest, `${label}.roo.collision.digest`, maxTextBytes);
    return { kind: 'collision-sha256', value: digest };
  }
  fail('malformed-input', `${label} lacks a bounded ROO security or collision content token`);
}

function validateCondition(condition, label, dimensions, maxTextBytes) {
  if (condition === null) return null;
  requireRecord(condition, label);
  rejectUnknownKeys(condition, CONDITION_KEYS, label);
  const type = exactInteger(condition.type, `${label}.type`, 1, 5);
  const expectedName = CONDITION_NAMES.get(type);
  const name = exactText(condition.name, `${label}.name`, maxTextBytes);
  if (name !== expectedName)
    fail('malformed-input', `${label}.name does not match its condition type`);
  let threshold = null;
  if (type === 5) {
    if (Object.hasOwn(condition, 'threshold') && condition.threshold !== null)
      fail('malformed-input', `${label}.threshold must be absent or null for default`);
  } else {
    const maximum = type <= 2 ? dimensions.rows + 1 : dimensions.cols + 1;
    threshold = exactInteger(condition.threshold, `${label}.threshold`, 0, maximum);
  }
  return { type, name, threshold };
}

function validateRoomIdentity(key, room, limits) {
  requireRecord(room, `rooms.${key}`);
  rejectUnknownKeys(room, ROOM_KEYS, `rooms.${key}`);
  const num = exactInteger(room.num, `rooms.${key}.num`, 1, 0x7fffffff);
  if (key !== String(num))
    fail('duplicate-input', `room object key ${key} does not exactly match room number ${num}`);
  const roomResource = exactInteger(room.roomRsc, `rooms.${key}.roomRsc`, 1, 0xffffffff);
  const resourceSymbol = exactText(room.rsc, `rooms.${key}.rsc`, limits.max_text_bytes);
  const rooFile = exactRooFile(room.rooFile, `rooms.${key}.rooFile`, limits.max_text_bytes);
  const rows = exactInteger(room.rows, `rooms.${key}.rows`, 1, limits.max_dimension);
  const cols = exactInteger(room.cols, `rooms.${key}.cols`, 1, limits.max_dimension);
  const roo = requireRecord(room.roo, `rooms.${key}.roo`);
  if (exactRooFile(roo.file, `rooms.${key}.roo.file`, limits.max_text_bytes) !== rooFile)
    fail('malformed-input', `rooms.${key} ROO filenames do not match exactly`);
  if (roo.rows !== rows || roo.cols !== cols)
    fail('malformed-input', `rooms.${key} ROO dimensions do not match exactly`);
  const digest = roo?.collision?.digest;
  if (digest !== null && digest !== undefined &&
      (typeof digest !== 'string' || !SHA256_RE.test(digest))) {
    fail('malformed-input', `rooms.${key}.roo.collision.digest must be lowercase SHA-256`);
  }
  return {
    key, num, roomResource, resourceSymbol, rooFile, rows, cols,
    token: staticToken(room, `rooms.${key}`, limits.max_text_bytes),
    source: room,
    edges: [],
    gos: [],
  };
}

function validateEdge(room, raw, sourceIndex, limits) {
  const label = `rooms.${room.key}.edgeExits[${sourceIndex}]`;
  requireRecord(raw, label);
  rejectUnknownKeys(raw, EDGE_KEYS, label);
  const leave = exactInteger(raw.leave, `${label}.leave`, 1, 4);
  const leaveName = exactText(raw.leaveName, `${label}.leaveName`, limits.max_text_bytes);
  if (leaveName !== LEAVE_NAMES.get(leave))
    fail('malformed-input', `${label}.leaveName does not match its leave code`);
  return {
    kind: 'EDGE', sourceIndex,
    to: exactInteger(raw.to, `${label}.to`, 1, 0x7fffffff),
    leave,
    leaveName,
    arriveRow: exactInteger(raw.arriveRow, `${label}.arriveRow`, 0, limits.max_dimension + 1),
    arriveCol: exactInteger(raw.arriveCol, `${label}.arriveCol`, 0, limits.max_dimension + 1),
    angleChange: exactInteger(raw.angleChange, `${label}.angleChange`, -0x7fffffff, 0x7fffffff),
    condition: validateCondition(raw.condition, `${label}.condition`, room, limits.max_text_bytes),
  };
}

function validateGo(room, raw, sourceIndex, limits) {
  const label = `rooms.${room.key}.goExits[${sourceIndex}]`;
  requireRecord(raw, label);
  rejectUnknownKeys(raw, GO_KEYS, label);
  if (typeof raw.locked !== 'boolean')
    fail('malformed-input', `${label}.locked must be boolean`);
  for (const field of ['arriveRow', 'arriveCol', 'angleChange']) {
    if (!Object.hasOwn(raw, field))
      fail('malformed-input', `${label}.${field} must be present`);
  }
  const result = {
    kind: 'GO', sourceIndex,
    to: exactInteger(raw.to, `${label}.to`, -1, 0x7fffffff),
    // KOD go coordinates are authoritative trigger provenance. A handful of
    // public-map records deliberately sit beyond the collision grid (for
    // example a scripted portal), so bound them globally without rewriting or
    // pretending they are ordinary in-grid cells.
    row: exactInteger(raw.row, `${label}.row`, 0, limits.max_dimension + 1),
    col: exactInteger(raw.col, `${label}.col`, 0, limits.max_dimension + 1),
    arriveRow: optionalInteger(raw.arriveRow, `${label}.arriveRow`, 0, limits.max_dimension + 1),
    arriveCol: optionalInteger(raw.arriveCol, `${label}.arriveCol`, 0, limits.max_dimension + 1),
    angleChange: optionalInteger(raw.angleChange, `${label}.angleChange`, -0x7fffffff, 0x7fffffff),
    locked: raw.locked,
  };
  if (result.locked) {
    if (result.to !== -1 || result.arriveRow !== null || result.arriveCol !== null ||
        result.angleChange !== null) {
      fail('malformed-input', `${label} locked marker must use to=-1 and null arrival/angle`);
    }
  } else if (result.to < 1 || result.arriveRow === null || result.arriveCol === null ||
             result.angleChange === null) {
    fail('malformed-input', `${label} unlocked exit requires a positive destination, arrival, and angle`);
  }
  return result;
}

function validateDestinations(rooms, byNumber) {
  for (const room of rooms) {
    for (const exit of [...room.edges, ...room.gos]) {
      if (exit.to < 1) continue;
      const destination = byNumber.get(exit.to);
      if (!destination)
        fail('malformed-input', `room ${room.num} exit ${exit.kind}:${exit.sourceIndex} has an unknown destination`);
      const boundaryAllowance = exit.kind === 'EDGE' ? 1 : 0;
      if (exit.arriveRow < 1 || exit.arriveCol < 1 ||
          exit.arriveRow > destination.rows + boundaryAllowance ||
          exit.arriveCol > destination.cols + boundaryAllowance) {
        fail('malformed-input', `room ${room.num} exit ${exit.kind}:${exit.sourceIndex} arrival is outside its destination`);
      }
    }
  }
}

function optionalField(value) {
  return value === null ? '' : String(value);
}

function emitArtifact(sourceManifest, rooms, limits) {
  const edgeCount = rooms.reduce((count, room) => count + room.edges.length, 0);
  const goCount = rooms.reduce((count, room) => count + room.gos.length, 0);
  const header = 'M59ATLAS\t1';
  const sourceWithHashPlaceholder = [
    'SOURCE', 'geometry-manifest-sha256', sourceManifest.geometryManifestSha256,
    'topology-records-sha256', '0'.repeat(64),
    sourceManifest.geometryRoomCount,
  ].join('\t');
  const end = `END\t${rooms.length}\t${edgeCount}\t${goCount}`;
  let bytes = [header, sourceWithHashPlaceholder, end]
    .reduce((count, line) => count + Buffer.byteLength(line, 'utf8') + 1, 0);
  if (bytes > limits.max_output_bytes)
    fail('limit-exceeded', `compiled artifact exceeds ${limits.max_output_bytes} bytes`);

  const records = [];
  const topologyRecordsHash = createHash('sha256');
  const appendRecord = fields => {
    const record = fields.join('\t');
    const recordBytes = Buffer.byteLength(record, 'utf8') + 1;
    if (bytes + recordBytes > limits.max_output_bytes)
      fail('limit-exceeded', `compiled artifact exceeds ${limits.max_output_bytes} bytes`);
    bytes += recordBytes;
    topologyRecordsHash.update(record).update('\n');
    records.push(record);
  };
  for (const room of rooms) {
    appendRecord([
      'ROOM', room.num, room.roomResource, percentEncode(room.resourceSymbol),
      percentEncode(room.rooFile), room.token.kind, room.token.value,
      room.rows, room.cols,
    ]);
    for (const edge of room.edges) {
      appendRecord([
        'EDGE', room.num, edge.sourceIndex, edge.to, edge.leave,
        percentEncode(edge.leaveName), edge.arriveRow, edge.arriveCol,
        edge.angleChange, optionalField(edge.condition?.type ?? null),
        edge.condition ? percentEncode(edge.condition.name) : '',
        optionalField(edge.condition?.threshold ?? null),
      ]);
    }
    for (const go of room.gos) {
      appendRecord([
        'GO', room.num, go.sourceIndex, go.to, go.row, go.col,
        optionalField(go.arriveRow), optionalField(go.arriveCol),
        optionalField(go.angleChange), go.locked ? 1 : 0,
      ]);
    }
  }
  const topologyRecordsSha256 = topologyRecordsHash.digest('hex');
  const lines = [
    header,
    ['SOURCE', 'geometry-manifest-sha256', sourceManifest.geometryManifestSha256,
      'topology-records-sha256', topologyRecordsSha256,
      sourceManifest.geometryRoomCount].join('\t'),
    ...records,
    end,
  ];
  const artifact = `${lines.join('\n')}\n`;
  return {
    artifact,
    summary: {
      schema: ATLAS_TOPOLOGY_SCHEMA,
      rooms: rooms.length,
      edge_exits: edgeCount,
      go_exits: goCount,
      bytes,
      sha256: createHash('sha256').update(artifact).digest('hex'),
      source_geometry_manifest_sha256: sourceManifest.geometryManifestSha256,
      source_topology_records_sha256: topologyRecordsSha256,
    },
  };
}

function compileAtlasTopologyInternal(map, limitOverrides = {}) {
  const limits = limitsOf(limitOverrides);
  requireRecord(map, 'map');
  rejectUnknownKeys(map, TOP_LEVEL_KEYS, 'map');
  const roomObject = requireRecord(map.rooms, 'map.rooms');
  const roomEntries = Object.entries(roomObject);
  if (!roomEntries.length) fail('malformed-input', 'map.rooms must not be empty');
  if (roomEntries.length > limits.max_rooms)
    fail('limit-exceeded', `room count exceeds ${limits.max_rooms}`);

  if (!Number.isSafeInteger(map.geometryRoomCount) || map.geometryRoomCount !== roomEntries.length)
    fail('malformed-input', 'geometryRoomCount does not match map.rooms');
  if (typeof map.geometryManifestSha256 !== 'string' || !SHA256_RE.test(map.geometryManifestSha256))
    fail('malformed-input', 'geometryManifestSha256 must be lowercase SHA-256');
  const computedManifest = geometryManifestForRooms(roomObject);
  if (computedManifest.geometryManifestSha256 !== map.geometryManifestSha256)
    fail('malformed-input', 'geometry manifest does not match room identities');

  const seenNumbers = new Set();
  const rooms = [];
  for (const [key, rawRoom] of roomEntries) {
    const numeric = rawRoom?.num;
    if (Number.isSafeInteger(numeric) && seenNumbers.has(numeric))
      fail('duplicate-input', `duplicate room number ${numeric}`);
    if (Number.isSafeInteger(numeric)) seenNumbers.add(numeric);
    rooms.push(validateRoomIdentity(key, rawRoom, limits));
  }
  rooms.sort((left, right) => left.num - right.num);
  const byNumber = new Map(rooms.map(room => [room.num, room]));

  let totalExits = 0;
  for (const room of rooms) {
    const edges = room.source.edgeExits;
    const gos = room.source.goExits;
    if (!Array.isArray(edges) || !Array.isArray(gos))
      fail('malformed-input', `rooms.${room.key} exit collections must be arrays`);
    if (edges.length + gos.length > limits.max_exits_per_room)
      fail('limit-exceeded', `room ${room.num} exit count exceeds ${limits.max_exits_per_room}`);
    totalExits += edges.length + gos.length;
    if (totalExits > limits.max_total_exits)
      fail('limit-exceeded', `total exit count exceeds ${limits.max_total_exits}`);
    room.edges = edges.map((edge, index) => validateEdge(room, edge, index, limits));
    room.gos = gos.map((go, index) => validateGo(room, go, index, limits));
  }
  validateDestinations(rooms, byNumber);
  return { ...emitArtifact(computedManifest, rooms, limits), rooms };
}

export function compileAtlasTopology(map, limitOverrides = {}) {
  const { artifact, summary } = compileAtlasTopologyInternal(map, limitOverrides);
  return { artifact, summary };
}

function parseAtlasTopologyJson(jsonText, limits) {
  if (typeof jsonText !== 'string') fail('malformed-input', 'JSON input must be text');
  const inputBytes = Buffer.byteLength(jsonText, 'utf8');
  if (inputBytes < 1 || inputBytes > limits.max_input_bytes)
    fail('limit-exceeded', `input must be between 1 and ${limits.max_input_bytes} bytes`);
  rejectDuplicateJsonKeys(jsonText, limits);
  try { return JSON.parse(jsonText); }
  catch (error) { fail('malformed-json', `invalid JSON: ${error.message}`); }
}

export function compileAtlasTopologyJson(jsonText, limitOverrides = {}) {
  const limits = limitsOf(limitOverrides);
  return compileAtlasTopology(parseAtlasTopologyJson(jsonText, limits), limits);
}

function readAtlasTopologyMapFile(inputPath, limitOverrides = {}) {
  const limits = limitsOf(limitOverrides);
  if (typeof inputPath !== 'string' || !inputPath)
    fail('invalid-argument', 'input path is required');
  const path = resolve(inputPath);
  let link;
  try { link = lstatSync(path); }
  catch { fail('io-error', `input file was not found: ${path}`); }
  if (link.isSymbolicLink()) fail('io-error', `input must not be a symbolic link: ${path}`);
  if (!link.isFile()) fail('io-error', `input is not a regular file: ${path}`);

  let descriptor = null;
  let raw;
  try {
    descriptor = openSync(path, 'r');
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail('io-error', `input is not a regular file: ${path}`);
    if (before.dev !== link.dev || before.ino !== link.ino ||
        before.size !== link.size || before.mtimeMs !== link.mtimeMs ||
        before.ctimeMs !== link.ctimeMs) {
      fail('io-error', 'input changed before it could be opened');
    }
    if (before.size < 1 || before.size > limits.max_input_bytes)
      fail('limit-exceeded', `input must be between 1 and ${limits.max_input_bytes} bytes`);

    // Read through the already inspected descriptor and reserve exactly one byte
    // beyond its accepted size. A concurrent grow is detected without ever
    // allocating or reading an unbounded replacement.
    const capacity = Math.min(before.size + 1, limits.max_input_bytes + 1);
    const storage = Buffer.allocUnsafe(capacity);
    let length = 0;
    while (length < capacity) {
      const count = readSync(descriptor, storage, length, capacity - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limits.max_input_bytes)
      fail('limit-exceeded', `input must be between 1 and ${limits.max_input_bytes} bytes`);

    const after = fstatSync(descriptor);
    if (length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs) {
      fail('io-error', 'input changed while it was being read');
    }
    raw = storage.subarray(0, length);
  } catch (error) {
    if (error instanceof AtlasTopologyError) throw error;
    fail('io-error', `could not read input: ${error.message}`);
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { }
    }
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { fail('malformed-input', 'input is not valid UTF-8'); }
  return { map: parseAtlasTopologyJson(text, limits), limits };
}

export function compileAtlasTopologyFile(inputPath, limitOverrides = {}) {
  const { map, limits } = readAtlasTopologyMapFile(inputPath, limitOverrides);
  return compileAtlasTopology(map, limits);
}

function cloneMapValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined ||
      typeof value === 'string' || typeof value === 'number' ||
      typeof value === 'boolean') return value;
  if (typeof value !== 'object')
    fail('malformed-input', 'map contains a non-JSON value');
  if (seen.has(value)) fail('malformed-input', 'map contains a cyclic value');
  seen.add(value);
  let clone;
  if (Array.isArray(value)) {
    clone = value.map(item => cloneMapValue(item, seen));
  } else {
    clone = {};
    for (const key of Object.keys(value)) clone[key] = cloneMapValue(value[key], seen);
  }
  seen.delete(value);
  return clone;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function lookupRoomNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff)
    fail('invalid-argument', 'room number must be an integer in 1..2147483647');
  return value;
}

function createGeneration(ownedMap, limits) {
  deepFreeze(ownedMap);
  const compiled = compileAtlasTopologyInternal(ownedMap, limits);
  return new AtlasMapGeneration(GENERATION_TOKEN, compiled);
}

// A generation owns one deeply frozen map snapshot and the exact atlas bytes
// compiled from it. Consumers can therefore build scenes and serve the
// content-addressed artifact without mixing independently loaded map versions.
export class AtlasMapGeneration {
  #artifact;
  #summary;
  #mapBuildIdentity;
  #bindings;
  #sources;
  #roomNumbers;
  #legacySceneMap;

  constructor(token, compiled) {
    if (token !== GENERATION_TOKEN)
      fail('invalid-argument', 'use AtlasMapGeneration.fromFile or .fromMap');
    this.#artifact = compiled.artifact;
    this.#summary = Object.freeze({ ...compiled.summary });
    this.#mapBuildIdentity = [
      ATLAS_TOPOLOGY_SCHEMA,
      this.#summary.source_geometry_manifest_sha256,
      this.#summary.source_topology_records_sha256,
      this.#summary.sha256,
    ].join(':');
    this.#bindings = new Map();
    this.#sources = new Map();
    const legacyRooms = {};
    for (const room of compiled.rooms) {
      const security = room.token.kind === 'roo-security-u32'
        ? Number(room.token.value)
        : null;
      this.#bindings.set(room.num, Object.freeze({
        room_num: room.num,
        room_resource_id: room.roomResource,
        room_resource_symbol: room.resourceSymbol,
        roo_file: room.rooFile,
        static_token_kind: room.token.kind,
        static_token_value: room.token.value,
        rows: room.rows,
        cols: room.cols,
        roo_security_u32: security,
      }));
      this.#sources.set(room.num, room.source);
      legacyRooms[String(room.num)] = room.source;
    }
    this.#roomNumbers = Object.freeze(compiled.rooms.map(room => room.num));
    this.#legacySceneMap = Object.freeze({ rooms: Object.freeze(legacyRooms) });
    Object.freeze(this);
  }

  static fromFile(inputPath, limitOverrides = {}) {
    const { map, limits } = readAtlasTopologyMapFile(inputPath, limitOverrides);
    return createGeneration(map, limits);
  }

  static fromMap(map, limitOverrides = {}) {
    const limits = limitsOf(limitOverrides);
    return createGeneration(cloneMapValue(map), limits);
  }

  get artifact() {
    return this.#artifact;
  }

  get summary() {
    return this.#summary;
  }

  get map_build_identity() {
    return this.#mapBuildIdentity;
  }

  get room_numbers() {
    return this.#roomNumbers;
  }

  getRoomBinding(roomNumber) {
    return this.#bindings.get(lookupRoomNumber(roomNumber)) ?? null;
  }

  getRoomSource(roomNumber) {
    return this.#sources.get(lookupRoomNumber(roomNumber)) ?? null;
  }

  artifactForSha256(exactHash) {
    return exactHash === this.#summary.sha256 ? this.#artifact : null;
  }

  legacySceneMap() {
    return this.#legacySceneMap;
  }
}

function usage() {
  return 'usage: node tools/m59-atlas-topology.mjs --input <m59-map.json> (--check | --output <new-file>)';
}

function parseArguments(argv) {
  const result = { input: null, output: null, check: false };
  for (let i = 0; i < argv.length; ++i) {
    const arg = argv[i];
    if (arg === '--input' && i + 1 < argv.length) result.input = argv[++i];
    else if (arg === '--output' && i + 1 < argv.length) result.output = argv[++i];
    else if (arg === '--check') result.check = true;
    else fail('usage', `unknown or incomplete argument ${arg}`);
  }
  if (!result.input || result.check === Boolean(result.output)) fail('usage', usage());
  return result;
}

function runCli(argv) {
  const args = parseArguments(argv);
  const result = compileAtlasTopologyFile(args.input);
  if (args.check) {
    process.stdout.write(`${JSON.stringify(result.summary)}\n`);
    return;
  }
  const input = resolve(args.input);
  const output = resolve(args.output);
  if (input === output) fail('io-error', 'output must not replace the input map');
  const temporary = `${output}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor = null;
  let temporaryExists = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    temporaryExists = true;
    writeFileSync(descriptor, result.artifact, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    // A same-directory hard link publishes the already complete bytes without
    // replacing an output that appeared concurrently. The temporary name can
    // then disappear while the final link retains the flushed file.
    linkSync(temporary, output);
    unlinkSync(temporary);
    temporaryExists = false;
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { }
    }
    if (temporaryExists) {
      try { unlinkSync(temporary); } catch { }
    }
    if (error?.code === 'EEXIST') fail('io-error', `output already exists: ${output}`);
    fail('io-error', `could not publish output: ${error.message}`);
  }
  process.stdout.write(`${JSON.stringify({ ...result.summary, output })}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  try { runCli(process.argv.slice(2)); }
  catch (error) {
    const code = error instanceof AtlasTopologyError ? error.code : 'unexpected-error';
    process.stderr.write(`m59-atlas-topology: ${code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
