#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ATLAS_TOPOLOGY_SCHEMA,
  AtlasMapGeneration,
  AtlasTopologyError,
  compileAtlasTopology,
  compileAtlasTopologyJson,
  geometryManifestForRooms,
} from './m59-atlas-topology.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TOOL = join(HERE, 'm59-atlas-topology.mjs');
const CHECKED_MAP = join(REPO, 'substrate', 'm59-map.json');

function room({
  num, roomRsc, rsc, rooFile, rows, cols, security, digest,
  edgeExits = [], goExits = [],
}) {
  return {
    num,
    rsc,
    roomRsc,
    rooFile,
    rows,
    cols,
    edgeExits,
    goExits,
    roo: {
      file: rooFile,
      security,
      rows,
      cols,
      collision: {
        digest,
        wallSides: 'GEOMETRY_MUST_NOT_ESCAPE',
      },
      grid: 'GRID_MUST_NOT_ESCAPE',
      walls: [{ id: 123, proprietary: 'MUST_NOT_ESCAPE' }],
    },
  };
}

function withManifest(rooms) {
  return {
    ...geometryManifestForRooms(rooms),
    geometrySource: 'synthetic offline test only',
    rooms,
  };
}

function fixture({ reverseRooms = false } = {}) {
  const first = room({
    num: 1,
    roomRsc: 22001,
    rsc: 'room_α',
    rooFile: 'one hall.roo',
    rows: 3,
    cols: 3,
    security: 4294967295,
    digest: '11'.repeat(32),
    edgeExits: [{
      leave: 4,
      leaveName: 'east',
      to: 2,
      arriveRow: 1,
      arriveCol: 1,
      angleChange: 0,
      condition: { type: 1, name: 'row>', threshold: 1 },
    }],
    goExits: [{
      row: 2,
      col: 2,
      to: 2,
      locked: false,
      arriveRow: 2,
      arriveCol: 2,
      angleChange: 8,
    }, {
      row: 3,
      col: 3,
      to: -1,
      locked: true,
      arriveRow: null,
      arriveCol: null,
      angleChange: null,
    }],
  });
  const second = room({
    num: 2,
    roomRsc: 22002,
    rsc: 'room_two',
    rooFile: 'two.roo',
    rows: 4,
    cols: 4,
    security: undefined,
    digest: '22'.repeat(32),
    edgeExits: [{
      leave: 3,
      leaveName: 'west',
      to: 1,
      arriveRow: 1,
      arriveCol: 3,
      angleChange: 0,
      condition: { type: 5, name: 'default' },
    }, {
      leave: 3,
      leaveName: 'west',
      to: 1,
      arriveRow: 2,
      arriveCol: 3,
      angleChange: 0,
      condition: null,
    }],
  });
  const rooms = reverseRooms ? { 2: second, 1: first } : { 1: first, 2: second };
  return withManifest(rooms);
}

function expectError(fn, code, pattern) {
  assert.throws(fn, error => {
    assert.ok(error instanceof AtlasTopologyError);
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

function testExactArtifactAndDeterminism() {
  const forwardMap = fixture();
  const reversedMap = fixture({ reverseRooms: true });
  const forward = compileAtlasTopology(forwardMap);
  const reversed = compileAtlasTopology(reversedMap);
  assert.equal(forward.artifact, reversed.artifact,
    'room-object insertion order must not affect the artifact');
  assert.equal(forward.summary.schema, ATLAS_TOPOLOGY_SCHEMA);
  assert.deepEqual({
    rooms: forward.summary.rooms,
    edge_exits: forward.summary.edge_exits,
    go_exits: forward.summary.go_exits,
  }, { rooms: 2, edge_exits: 3, go_exits: 2 });

  const manifest = geometryManifestForRooms(forwardMap.rooms);
  const expectedRecords = [
    'ROOM\t1\t22001\troom_%CE%B1\tone%20hall.roo\troo-security-u32\t4294967295\t3\t3',
    'EDGE\t1\t0\t2\t4\teast\t1\t1\t0\t1\trow%3E\t1',
    'GO\t1\t0\t2\t2\t2\t2\t2\t8\t0',
    'GO\t1\t1\t-1\t3\t3\t\t\t\t1',
    `ROOM\t2\t22002\troom_two\ttwo.roo\tcollision-sha256\t${'22'.repeat(32)}\t4\t4`,
    'EDGE\t2\t0\t1\t3\twest\t1\t3\t0\t5\tdefault\t',
    'EDGE\t2\t1\t1\t3\twest\t2\t3\t0\t\t\t',
  ];
  const topologyRecordsSha256 = createHash('sha256')
    .update(`${expectedRecords.join('\n')}\n`).digest('hex');
  const expected = [
    'M59ATLAS\t1',
    ['SOURCE', 'geometry-manifest-sha256', manifest.geometryManifestSha256,
      'topology-records-sha256', topologyRecordsSha256, 2].join('\t'),
    ...expectedRecords,
    'END\t2\t3\t2',
    '',
  ].join('\n');
  assert.equal(forward.artifact, expected);
  assert.equal(forward.summary.source_topology_records_sha256, topologyRecordsSha256);
  for (const forbidden of [
    'GEOMETRY_MUST_NOT_ESCAPE', 'GRID_MUST_NOT_ESCAPE', 'MUST_NOT_ESCAPE',
    'wallSides', '"walls"', '"grid"',
  ]) assert.ok(!forward.artifact.includes(forbidden), `${forbidden} leaked into topology`);
}

function testDuplicateAndMalformedRejection() {
  expectError(
    () => compileAtlasTopologyJson('{"x":1,"\\u0078":2}'),
    'duplicate-input', /duplicate JSON object key/,
  );

  const duplicateRooms = fixture();
  duplicateRooms.rooms['3'] = { ...duplicateRooms.rooms['2'], num: 2 };
  Object.assign(duplicateRooms, geometryManifestForRooms(duplicateRooms.rooms));
  expectError(() => compileAtlasTopology(duplicateRooms), 'duplicate-input', /duplicate room number 2/);

  const unknownExitField = fixture();
  unknownExitField.rooms['1'].edgeExits[0].reverse = true;
  expectError(() => compileAtlasTopology(unknownExitField), 'malformed-input', /unsupported field reverse/);

  const dangling = fixture();
  dangling.rooms['1'].edgeExits[0].to = 99;
  expectError(() => compileAtlasTopology(dangling), 'malformed-input', /unknown destination/);

  const wrongManifest = fixture();
  wrongManifest.geometryManifestSha256 = '00'.repeat(32);
  expectError(() => compileAtlasTopology(wrongManifest), 'malformed-input', /manifest does not match/);

  const pathEscape = fixture();
  pathEscape.rooms['1'].rooFile = '../one.roo';
  pathEscape.rooms['1'].roo.file = '../one.roo';
  Object.assign(pathEscape, geometryManifestForRooms(pathEscape.rooms));
  expectError(() => compileAtlasTopology(pathEscape), 'malformed-input', /local \.roo basename/);

  const badLocked = fixture();
  badLocked.rooms['1'].goExits[1].to = 2;
  expectError(() => compileAtlasTopology(badLocked), 'malformed-input', /locked marker/);

  const missingArrivalProvenance = fixture();
  delete missingArrivalProvenance.rooms['1'].goExits[1].angleChange;
  expectError(() => compileAtlasTopology(missingArrivalProvenance),
    'malformed-input', /angleChange must be present/);
}

function testTopologySourceBindingAndBounds() {
  const original = compileAtlasTopology(fixture());
  const changedResource = fixture();
  changedResource.rooms['1'].rsc = 'room_changed';
  const resourceResult = compileAtlasTopology(changedResource);
  assert.equal(resourceResult.summary.source_geometry_manifest_sha256,
    original.summary.source_geometry_manifest_sha256);
  assert.notEqual(resourceResult.summary.source_topology_records_sha256,
    original.summary.source_topology_records_sha256);

  const changedExit = fixture();
  changedExit.rooms['1'].edgeExits[0].condition.threshold = 2;
  const exitResult = compileAtlasTopology(changedExit);
  assert.notEqual(exitResult.summary.source_topology_records_sha256,
    original.summary.source_topology_records_sha256);

  expectError(() => compileAtlasTopology(fixture(), { max_rooms: 1 }),
    'limit-exceeded', /room count/);
  expectError(() => compileAtlasTopology(fixture(), { max_exits_per_room: 2 }),
    'limit-exceeded', /exit count/);
  expectError(() => compileAtlasTopologyJson(JSON.stringify(fixture()), { max_input_bytes: 10 }),
    'limit-exceeded', /input must be between/);
  assert.equal(
    compileAtlasTopology(fixture(), { max_output_bytes: original.summary.bytes }).artifact,
    original.artifact,
    'the exact artifact-byte ceiling must remain accepted',
  );
  expectError(
    () => compileAtlasTopology(fixture(), { max_output_bytes: original.summary.bytes - 1 }),
    'limit-exceeded', /compiled artifact/,
  );

  const hugeDimension = fixture();
  hugeDimension.rooms['1'].rows = 4097;
  hugeDimension.rooms['1'].roo.rows = 4097;
  Object.assign(hugeDimension, geometryManifestForRooms(hugeDimension.rooms));
  expectError(() => compileAtlasTopology(hugeDimension), 'malformed-input', /outside 1\.\.4096/);

  const fullUint32Resource = fixture();
  fullUint32Resource.rooms['1'].roomRsc = 0xffffffff;
  assert.match(compileAtlasTopology(fullUint32Resource).artifact,
    /^ROOM\t1\t4294967295\t/m);

  const oversizedResource = fixture();
  oversizedResource.rooms['1'].roomRsc = 0x100000000;
  expectError(() => compileAtlasTopology(oversizedResource),
    'malformed-input', /outside 1\.\.4294967295/);
}

function testFrozenGenerationApi() {
  const input = fixture();
  const generation = AtlasMapGeneration.fromMap(input);
  assert.ok(Object.isFrozen(generation));
  assert.ok(Object.isFrozen(generation.summary));
  assert.ok(Object.isFrozen(generation.room_numbers));
  assert.deepEqual(generation.room_numbers, [1, 2]);

  const binding = generation.getRoomBinding(1);
  assert.ok(Object.isFrozen(binding));
  assert.deepEqual(binding, {
    room_num: 1,
    room_resource_id: 22001,
    room_resource_symbol: 'room_α',
    roo_file: 'one hall.roo',
    static_token_kind: 'roo-security-u32',
    static_token_value: '4294967295',
    rows: 3,
    cols: 3,
    roo_security_u32: 4294967295,
  });
  assert.equal(generation.getRoomBinding(2).roo_security_u32, null);
  assert.equal(generation.getRoomBinding(3), null);
  assert.equal(generation.getRoomSource(3), null);
  expectError(() => generation.getRoomBinding('1'), 'invalid-argument', /room number/);
  expectError(() => generation.getRoomSource(0), 'invalid-argument', /room number/);

  const source = generation.getRoomSource(1);
  assert.ok(Object.isFrozen(source));
  assert.ok(Object.isFrozen(source.roo));
  assert.ok(Object.isFrozen(source.edgeExits));
  assert.throws(() => { source.rsc = 'mutated'; }, TypeError);
  input.rooms['1'].rsc = 'changed after generation';
  assert.equal(source.rsc, 'room_α', 'fromMap must retain an owned snapshot');

  assert.equal(generation.artifactForSha256(generation.summary.sha256), generation.artifact);
  assert.equal(generation.artifactForSha256(generation.summary.sha256.toUpperCase()), null);
  assert.equal(generation.artifactForSha256('00'.repeat(32)), null);
  assert.equal(generation.map_build_identity, [
    ATLAS_TOPOLOGY_SCHEMA,
    generation.summary.source_geometry_manifest_sha256,
    generation.summary.source_topology_records_sha256,
    generation.summary.sha256,
  ].join(':'));

  const legacy = generation.legacySceneMap();
  assert.ok(Object.isFrozen(legacy));
  assert.ok(Object.isFrozen(legacy.rooms));
  assert.strictEqual(legacy.rooms['1'], source,
    'legacy scene construction must reuse the retained source');
  assert.throws(() => { legacy.rooms['3'] = source; }, TypeError);
}

function testStrictFileAndOfflineCli() {
  const temp = mkdtempSync(join(tmpdir(), 'm59-atlas-topology-'));
  try {
    const input = join(temp, 'synthetic-map.json');
    const output = join(temp, 'synthetic-atlas.m59atlas');
    const inputText = JSON.stringify(fixture());
    const inputBytes = Buffer.byteLength(inputText, 'utf8');
    writeFileSync(input, inputText, 'utf8');
    const fromFile = AtlasMapGeneration.fromFile(input);
    assert.equal(fromFile.artifact, compileAtlasTopology(fixture()).artifact);
    assert.equal(
      AtlasMapGeneration.fromFile(input, { max_input_bytes: inputBytes }).artifact,
      fromFile.artifact,
      'the descriptor reader must accept an input exactly at its byte ceiling',
    );
    expectError(
      () => AtlasMapGeneration.fromFile(input, { max_input_bytes: inputBytes - 1 }),
      'limit-exceeded', /input must be between/,
    );

    const duplicate = join(temp, 'duplicate.json');
    writeFileSync(duplicate, '{"rooms":{},"\\u0072ooms":{}}', 'utf8');
    expectError(() => AtlasMapGeneration.fromFile(duplicate),
      'duplicate-input', /duplicate JSON object key/);

    const invalidUtf8 = join(temp, 'invalid-utf8.json');
    writeFileSync(invalidUtf8, Buffer.from([0xc3, 0x28]));
    expectError(() => AtlasMapGeneration.fromFile(invalidUtf8),
      'malformed-input', /valid UTF-8/);

    const run = spawnSync(process.execPath, [TOOL, '--input', input, '--output', output], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(output, 'utf8'), fromFile.artifact);
    assert.equal(JSON.parse(run.stdout).sha256, fromFile.summary.sha256);

    const overwrite = spawnSync(process.execPath, [TOOL, '--input', input, '--output', output], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, /output already exists/);
    assert.equal(readFileSync(output, 'utf8'), fromFile.artifact);
    assert.deepEqual(readdirSync(temp).sort(), [
      'duplicate.json', 'invalid-utf8.json',
      'synthetic-atlas.m59atlas', 'synthetic-map.json',
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function testCheckedPublicVector() {
  const generation = AtlasMapGeneration.fromFile(CHECKED_MAP);
  assert.deepEqual({
    schema: generation.summary.schema,
    rooms: generation.summary.rooms,
    edge_exits: generation.summary.edge_exits,
    go_exits: generation.summary.go_exits,
    bytes: generation.summary.bytes,
    sha256: generation.summary.sha256,
    geometry: generation.summary.source_geometry_manifest_sha256,
    topology: generation.summary.source_topology_records_sha256,
  }, {
    schema: 'M59ATLAS/1',
    rooms: 264,
    edge_exits: 280,
    go_exits: 1063,
    bytes: 58168,
    sha256: 'b07950b3d7859b75deb36c3d81a0edc4e9930e3f40ac3a5b753547d7d70480c3',
    geometry: '45c33b6979cf02ba5b7a742b26bc559b6f464d28eaead736475d4dd65aa95f9c',
    topology: '6e000561e772bef4f409e72b187b2e416df8ab088b6f26fda7bfacd4bc110077',
  });
  assert.equal(generation.map_build_identity,
    'M59ATLAS/1:45c33b6979cf02ba5b7a742b26bc559b6f464d28eaead736475d4dd65aa95f9c:' +
    '6e000561e772bef4f409e72b187b2e416df8ab088b6f26fda7bfacd4bc110077:' +
    'b07950b3d7859b75deb36c3d81a0edc4e9930e3f40ac3a5b753547d7d70480c3');
  assert.equal(generation.room_numbers.length, 264);
  assert.ok(generation.room_numbers.every((value, index, all) =>
    index === 0 || all[index - 1] < value));
}

testExactArtifactAndDeterminism();
testDuplicateAndMalformedRejection();
testTopologySourceBindingAndBounds();
testFrozenGenerationApi();
testStrictFileAndOfflineCli();
testCheckedPublicVector();
console.log('m59 atlas topology tests: PASS');
