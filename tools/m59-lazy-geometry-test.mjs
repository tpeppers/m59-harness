#!/usr/bin/env node
// Lazy lab geometry startup. Offline: no broker, socket, fleet, or game server.
//
//   node tools/m59-lazy-geometry-test.mjs

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { loadMap, buildReverseEdges, findPath } from './m59-map.mjs';
import {
  attachStepMasks, lazyRoomArtifactsCurrent, routesFor,
} from './m59-routes.mjs';
import { peekSharedRoomGeometry, sharedRoomGeometry } from './m59-roo.mjs';
import { lazyRoomTopology, registerLazyRoomArtifacts } from './m59-room-artifacts.mjs';

let pass = 0, fail = 0;
function ok(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function same(name, actual, expected) {
  try { assert.deepEqual(actual, expected); ok(name, true); }
  catch { ok(name, false, `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`); }
}

const cachedCount = map => Object.values(map.rooms)
  .filter(room => room?.roo && peekSharedRoomGeometry(room)).length;
const reverseRows = map => [...(map.__reverse ?? new Map())]
  .map(([from, exits]) => [Number(from), exits.map(exit => ({
    to: Number(exit.to), direction: exit.direction, leave: exit.leave,
  })).sort((a, b) => a.to - b.to || a.leave - b.leave)])
  .sort((a, b) => a[0] - b[0]);

console.log('current-table gates and zero-decode registration');
const map = loadMap();
const table = routesFor(map.geometryManifestSha256);
ok('the checked routing table is current and complete for lazy adoption',
   lazyRoomArtifactsCurrent(table));
ok('an incomplete table is refused for lazy topology',
   !lazyRoomArtifactsCurrent({ ...table, complete: false }));
ok('an old bake is refused for lazy topology',
   !lazyRoomArtifactsCurrent({ ...table, bakeVersion: Number(table?.bakeVersion) - 1 }));
ok('an old mask predicate is refused for lazy topology',
   !lazyRoomArtifactsCurrent({ ...table, stepMaskVersion: Number(table?.stepMaskVersion) - 1 }));
same('nothing decoded before registration', cachedCount(map), 0);
const bindingRoom = Object.values(map.rooms).find(room => room?.roo && table?.rooms?.[room.num]);
const bindingBake = bindingRoom && table.rooms[bindingRoom.num];
if (bindingRoom && bindingBake) {
  ok('a table row for another room cannot register topology',
     registerLazyRoomArtifacts(bindingRoom, {
       ...bindingBake, room: Number(bindingRoom.num) + 1,
     }).registered === false && lazyRoomTopology(bindingRoom) === null);
  ok('a table row with another room resource security cannot register topology',
     registerLazyRoomArtifacts(bindingRoom, {
       ...bindingBake, security: Number(bindingBake.security) + 1,
     }).registered === false && lazyRoomTopology(bindingRoom) === null);
}

const attachAt = performance.now();
const attached = attachStepMasks(map, { lazy: true });
const attachMs = performance.now() - attachAt;
ok('lazy attachment was selected rather than the eager fallback', attached.lazy === true,
   JSON.stringify(attached));
ok('the real table deferred masks and registered compact topology',
   attached.deferred > 0 && attached.topology_rooms > 0 && attached.topology_anchors > 0,
   JSON.stringify(attached));
same('registration did not decode a room', cachedCount(map), 0);
const topology = Object.values(map.rooms).map(lazyRoomTopology).find(rows => rows?.length);
ok('registered topology cannot be mutated by a caller',
   Object.isFrozen(topology) && topology.every(Object.isFrozen));

console.log('\nreverse graph and a real route remain geometry-bounded');
const reverseAt = performance.now();
buildReverseEdges(map);
const reverseMs = performance.now() - reverseAt;
const afterReverse = cachedCount(map);
ok('reverse construction decodes only exceptional fallback rooms', afterReverse <= 16,
   `decoded ${afterReverse}`);
const pathAt = performance.now();
const route = findPath(map, 587, 2, { danger: false, avoid: null });
const pathMs = performance.now() - pathAt;
const afterPath = cachedCount(map);
ok('a real cross-world route is found through the lazy graph', route.found === true,
   route.reason ?? 'not found');
ok('route expansion does not materialise the atlas', afterPath <= afterReverse + 8,
   `reverse ${afterReverse}, after route ${afterPath}`);

// Compare with the authoritative old computation on fresh room/roo objects. The clone has
// no registered compact topology, so buildReverseEdges must use RoomGeometry throughout.
const reference = JSON.parse(JSON.stringify(map));
buildReverseEdges(reference);
same('lazy startup produces the exact authoritative inferred-reverse graph',
     reverseRows(map), reverseRows(reference));

console.log('\nfirst live room access consumes its deferred mask');
const deferredRoom = Object.values(map.rooms)
  .find(room => room?.roo && !peekSharedRoomGeometry(room));
ok('an untouched room remains available after graph and route work', !!deferredRoom);
if (deferredRoom) {
  const geometry = sharedRoomGeometry(deferredRoom);
  ok('first geometry access decodes the room and attaches its mover mask',
     peekSharedRoomGeometry(deferredRoom) === geometry && geometry.hasStepMask === true);
}

console.log(`\nlazy geometry: ${pass} passed, ${fail} failed`);
console.log(JSON.stringify({
  attach_ms: Math.round(attachMs), reverse_ms: Math.round(reverseMs),
  path_ms: Math.round(pathMs), decoded_after_reverse: afterReverse,
  decoded_after_path: afterPath,
}, null, 2));
if (fail) process.exitCode = 1;
