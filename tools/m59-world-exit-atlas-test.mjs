#!/usr/bin/env node
// Lab exit-atlas correctness and cold-path performance. Offline: no broker or server.
//
//   node tools/m59-world-exit-atlas-test.mjs


import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

process.env.M59_RUNTIME_PROFILE = 'lab';

let passed = 0, failed = 0;
function ok(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function same(name, actual, expected) {
  try { assert.deepEqual(actual, expected); ok(name, true); }
  catch (error) { ok(name, false, error.message.slice(0, 500)); }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'm59-exit-atlas-test-'));
try {
  const atlasModule = await import('./m59-exit-atlas.mjs');
  const mapModule = await import('./m59-map.mjs');
  const routesModule = await import('./m59-routes.mjs');
  const rooModule = await import('./m59-roo.mjs');
  const { World } = await import('./m59-world.mjs');

  console.log('artifact validation is fail-closed per room');
  {
    const file = path.join(scratch, 'fixture-atlas.json');
    const encoded = {
      format: atlasModule.EXIT_ATLAS_FORMAT,
      approachVersion: atlasModule.EXIT_APPROACH_VERSION,
      geometryManifestSha256: 'fixture-manifest', complete: true,
      rooms: {
        1: { room: 1, rows: 2, cols: 2, security: 7, directions: {
          north: [[96, 96, 96, 63, [[1, 1]], 1]],
          south: [], west: [], east: [],
        } },
      },
    };
    fs.writeFileSync(file, JSON.stringify(encoded));
    const room = { num: 1, rows: 2, cols: 2, roo: { security: 7 } };
    const map = { geometryManifestSha256: 'fixture-manifest', rooms: { 1: room } };
    const attached = atlasModule.attachLabExitAtlas(map, { file, force: true });
    ok('matching format, predicate, manifest, security and dimensions attach',
      attached.ok && attached.attached === 1 && attached.refused === 0);
    same('attached candidates are restored in ordinary edge-candidate shape',
      atlasModule.labExitApproaches(room, 'north'), [{
        fine_stand_on: { x: 96, y: 96 }, edge_target: { x: 96, y: 63 },
        col: 1, row: 1, stages: [{ col: 1, row: 1 }], graph_routable: true,
      }]);

    const wrongRoom = { num: 1, rows: 2, cols: 2, roo: { security: 8 } };
    const wrong = atlasModule.attachLabExitAtlas({
      geometryManifestSha256: 'fixture-manifest', rooms: { 1: wrongRoom },
    }, { file, force: true });
    ok('a room security mismatch refuses that room',
      !wrong.ok && wrong.attached === 0 && wrong.refused === 1 &&
      atlasModule.labExitApproaches(wrongRoom, 'north') === null);
    const wrongMap = atlasModule.attachLabExitAtlas({
      geometryManifestSha256: 'another-manifest', rooms: { 1: room },
    }, { file, force: true });
    ok('a map manifest mismatch refuses the atlas wholesale', !wrongMap.ok && wrongMap.attached === 0);
  }

  const map = mapModule.loadMap();
  const registration = atlasModule.attachLabExitAtlas(map);
  console.log('\ncommitted atlas and current map agree');
  ok('all map rooms adopted the committed atlas',
    registration.ok && registration.attached === 264 && registration.refused === 0,
    JSON.stringify(registration));
  const onDisk = JSON.parse(fs.readFileSync(atlasModule.exitAtlasFile(), 'utf8'));
  // Parse a distinct map object so its RoomGeometry caches cannot inherit atlas-backed
  // answers through either WeakMap.
  const authoritativeMap = JSON.parse(fs.readFileSync(mapModule.movementMapFile(), 'utf8'));
  const rebuilt = await atlasModule.buildExitAtlas(authoritativeMap);
  same('all 264 rooms and 3,346 approaches reproduce authoritative live derivation',
    rebuilt.rooms, onDisk.rooms);
  same('the exhaustive candidate count is unchanged', rebuilt.summary, onDisk.summary);

  routesModule.attachStepMasks(map, { lazy: true });
  mapModule.buildReverseEdges(map);
  routesModule.attachStepMasks(authoritativeMap, { lazy: true });
  mapModule.buildReverseEdges(authoritativeMap);

  function makeWorld(worldMap, roomNumber, preferred = null) {
    const room = worldMap.rooms[String(roomNumber)];
    const geometry = rooModule.sharedRoomGeometry(room);
    const origin = preferred ?? geometry.nearestWalkable(
      Math.floor(geometry.rows / 2), Math.floor(geometry.cols / 2));
    const client = {
      roomNameRsc: room.nameRsc, roomRsc: room.roomRsc, selfId: 1,
      self: { id: 1, row: origin.row, col: origin.col },
      room: { id: room.objId, objects: new Map() },
      rsc: { get: id => String(id) },
    };
    return { room, geometry, origin, world: new World(client, worldMap) };
  }

  console.log('\nlab World.exits is output-identical to the authoritative live path');
  for (const roomNumber of [27, 545, 576, 599]) {
    const atlasWorld = makeWorld(map, roomNumber);
    const liveWorld = makeWorld(authoritativeMap, roomNumber, atlasWorld.origin);
    same(`room ${roomNumber} returns the exact live exit projection`,
      atlasWorld.world.exits(), liveWorld.world.exits());
  }

  console.log('\na cold large-room call does two origin floods and no BSP approach derivation');
  {
    // A distinct origin bypasses the parity call's shared LRU while retaining only the
    // immutable room geometry/atlas.  This is the real event-loop work paid after moving.
    const fixture = makeWorld(map, 576, { row: 64, col: 45 });
    fixture.world._exitCache = null;
    let neighborCalls = 0, approachCalls = 0;
    const originalNeighbors = fixture.geometry.neighbors.bind(fixture.geometry);
    const originalApproaches = fixture.geometry.edgeApproachCandidates.bind(fixture.geometry);
    fixture.geometry.neighbors = (...args) => { neighborCalls++; return originalNeighbors(...args); };
    fixture.geometry.edgeApproachCandidates = (...args) => {
      approachCalls++; return originalApproaches(...args);
    };
    const started = performance.now();
    const exits = fixture.world.exits();
    const elapsed = performance.now() - started;
    fixture.geometry.neighbors = originalNeighbors;
    fixture.geometry.edgeApproachCandidates = originalApproaches;
    ok('all five declared large-room edges remain offered',
      exits.filter(exit => exit.kind === 'edge').length === 5);
    ok('the atlas avoids every cold fine-BSP boundary derivation', approachCalls === 0);
    ok('the invariant origin grid is traversed at most once per collision view',
      neighborCalls > 0 && neighborCalls <= fixture.geometry.rows * fixture.geometry.cols * 2,
      `${neighborCalls} neighbor calls for ${fixture.geometry.rows}x${fixture.geometry.cols}`);
    // Wide enough for loaded Windows CI, tight enough to catch the old 1.5 second path.
    ok('the formerly multi-second cold projection stays below 750ms', elapsed < 750,
      `${elapsed.toFixed(1)}ms`);
    console.log(`       room 576 cold projection: ${elapsed.toFixed(1)}ms, ` +
      `${neighborCalls} grid expansions`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nworld exit atlas: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
