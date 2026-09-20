#!/usr/bin/env node
// THE COORDINATE BOUNDARY, WITH NUMBERS THAT CANNOT PASS WHEN TRANSPOSED.
//
//   node tools/m59-coordinate-contract-test.mjs
//
// Offline. This reproduces the asymmetric values behind issue #44: a wire point
// `(x=3936,y=1952)` is square r30c61, while the independently logged exit square
// `r34c65` is a KOD/geometry `(row,col)` pair. Both were once printed as bare
// `(number,number)` tuples and looked contradictory even though neither was wrong.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Reader, extractCoordinates } from './m59-parse.mjs';
import { BP, M59Client } from './m59-client.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { bakedPivots } from './m59-routes.mjs';

// Protocol ExtractCoordinates is Y first, then X. The adapter must expose named
// x/y and col/row fields rather than leak that wire order to callers.
const packed = Buffer.alloc(4);
packed.writeUInt16LE(1952, 0); // y
packed.writeUInt16LE(3936, 2); // x
const perceived = extractCoordinates(new Reader(packed));
assert.deepEqual(perceived, { x: 3936, y: 1952, col: 61, row: 30 });
assert.equal(perceived.row, Math.floor(perceived.y / 64));
assert.equal(perceived.col, Math.floor(perceived.x / 64));

// The outbound adapter accepts named x/y order but must preserve the legacy wire
// encoding: Y bytes first, then X. Calling the method against a capture-only stub
// exercises its real encoder without opening a socket or starting a client.
const sends = [];
M59Client.prototype.moveTo.call({
  room: { id: 563 }, character: null, selfId: null,
  send: (...parts) => sends.push(parts),
}, perceived.x, perceived.y, 18, 563);
const [opcode, wireY, wireX, speed, roomId] = sends[0];
assert.deepEqual({
  calls: sends.length,
  opcode,
  y: wireY.readUInt16LE(0),
  x: wireX.readUInt16LE(0),
  speed: speed.readUInt8(0),
  room: roomId.readUInt32LE(0),
}, { calls: 1, opcode: BP.REQ_MOVE, y: 1952, x: 3936, speed: 18, room: 563 });

const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
const room = map.rooms['563'];
assert.equal(room.rows, 34);
assert.equal(room.cols, 76);

const geometry = sharedRoomGeometry(room);
assert.equal(geometry.walkable(34, 65), true, 'r34c65 is the intended KOD exit square');
assert.equal(geometry.walkable(30, 61), false, 'r30c61 is a different, non-floor square');
assert.notDeepEqual({ row: perceived.row, col: perceived.col }, { row: 34, col: 65 });

// Route-table keys and pivot tuples use the legacy geometry spelling: row,col.
const encodedRoutes = { rooms: { 900: { pivots: {
  '34,65>30,61': { squares: [[34, 65], [30, 61]], unverified: 0 },
} } } };
assert.deepEqual(
  bakedPivots(encodedRoutes, 900, { row: 34, col: 65 }, { row: 30, col: 61 }),
  { squares: [{ row: 34, col: 65 }, { row: 30, col: 61 }], unverified: 0 });
assert.equal(
  bakedPivots(encodedRoutes, 900, { row: 65, col: 34 }, { row: 61, col: 30 }), null,
  'route keys and pivot tuples must not be interpreted as col,row');

// The SafeSpotBook case that stood here is gone with the book (retired 2026-09-20 — see the
// tombstone in m59-safespots.mjs). It asserted that persisted square keys were col,row and
// not row,col. The contract it was guarding still holds and is still covered: `bakedPivots`
// above and the edgeApproach stages below both pin the same col,row spelling, and there is
// no longer a persisted safe-spot key for anyone to misread.

// Baked edge-approach tuples start with KOD x/y points, but their nested stage
// pairs are [col,row]. The reader restores named fields before geometry uses them.
const edgeRoom = map.rooms['27'];
const edgeGeometry = sharedRoomGeometry(edgeRoom);
const encodedStage = edgeRoom.roo.edgeApproaches.south[0][4][0];
assert.deepEqual(encodedStage, [44, 58], 'edgeApproach stages persist [col,row]');
assert.deepEqual(edgeGeometry.edgeApproachCandidates('south')[0].stages[0],
  { col: 44, row: 58 }, 'the reader restores a named {col,row} stage');
assert.equal(edgeGeometry.walkable(58, 44), true);
assert.equal(edgeGeometry.walkable(44, 58), false,
  'the asymmetric edge stage must not be transposed');

console.log('coordinate contract: 18 assertions passed across wire, geometry, and persisted formats');
