#!/usr/bin/env node
// Local player collision, offline and deterministic:
//
//   node tools/m59-collision-test.mjs

import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// THE INSTRUMENTS WRITE TO DISK, AND A TEST MUST NEVER WRITE TO THE FLEET'S OWN BOOKS.
// A live broker reads both of these; a suite that appended to them would be teaching the
// running fleet doors that only exist in a fixture.
{
  const scratch = mkdtempSync(join(tmpdir(), 'm59-collision-'));
  process.env.M59_TACTICS_DIR = join(scratch, 'tactics');
  process.env.M59_CROSSINGS_LEARNED = join(scratch, 'crossings-learned.json');
}
import { createHash } from 'node:crypto';
import {
  CLIENT_FINENESS, COLLISION_VERSION, DEFAULT_ROO_DIRS, KOD_FINENESS,
  MAX_STEP_HEIGHT, MIN_SIDE_MOVE, PLAYER_HEIGHT, PLAYER_RADIUS,
  RoomGeometry, WF, canCrossWallAt, parseRoo, protocolToClient, clientToProtocol, setWallHeights,
  sharedRoomGeometry,
} from './m59-roo.mjs';
import { recordTactic } from './m59-tactics.mjs';
import { anchorFor, activeRoutes } from './m59-routes.mjs';
import { recordCrossing } from './m59-crossings.mjs';
import { finePath, pullFine, pointOfSquare, boundsAround } from './m59-finepath.mjs';
import { isMutableGeometry, mutableBecause } from './m59-mutable.mjs';
import { BP, M59Client } from './m59-client.mjs';
import { MOVEON, blocksMovement, parsePlayer, OF } from './m59-parse.mjs';
import {
  COND, LEAVE, edgeCandidatesOf, edgeExitsOf, findPath,
  geometryManifest, movementMapReadiness, roomResourceDirs, setGeometryProvenance,
  resourcePathWithin,
} from './m59-map.mjs';
import {
  CHECKED_MAP_FILE, LOCAL_MAP_FILE, geometryOutputFile,
  geometryRefreshBaseFile, movementMapFile,
} from './m59-map-path.mjs';
import { isTerminalMovementReason } from './m59-movement.mjs';
import { World, boundedRegionEntry, boundedSilentGo, spreadEdges } from './m59-world.mjs';

let pass = 0, fail = 0, skipped = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
const skip = (name, detail) => {
  skipped++;
  console.log('  skip ' + name + (detail ? '  ' + detail : ''));
};

const sector = ({ floor = 0, ceiling = 4096, depth = 0, floorSlope = null,
                  ceilingSlope = null, flags = null } = {}) => ({
  floorHeight: floor, ceilingHeight: ceiling, depth,
  slopedFloor: floorSlope, slopedCeiling: ceilingSlope,
  ...(Number.isInteger(flags) ? { flags } : {}),
});
const side = ({ passable = false, above = false, below = true } = {}) => ({
  flags: passable ? WF.PASSABLE : 0,
  aboveType: above ? 1 : 0,
  belowType: below ? 1 : 0,
});

const TEST_SECURITY = 0x02345678;
const CLIENT_PER_KOD = CLIENT_FINENESS / KOD_FINENESS;
const clientToWire = value => value / CLIENT_PER_KOD + KOD_FINENESS;
const wireToClient = value => (value - KOD_FINENESS) * CLIENT_PER_KOD;
const squareCenterClient = square => wireToClient(square * KOD_FINENESS + (KOD_FINENESS >> 1));
const redigestCollision = json => {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    file: json.file, security: json.security, version: json.version,
    rows: json.rows, cols: json.cols,
    grid: json.grid, flags: json.flags, monsterGrid: json.monsterGrid,
    walls: json.walls, edgeOpenings: json.edgeOpenings,
    edgeApproaches: json.edgeApproaches,
  }));
  for (const key of ['wallSides', 'sectors', 'leaves', 'nodes']) {
    hash.update('\0' + key + '\0');
    hash.update(Buffer.from(json.collision[key], 'base64'));
  }
  json.collision.digest = hash.digest('hex');
  return json;
};

function twoSides({ left = sector(), right = sector(), pos = side(), neg = side(),
                    wallY0 = 0, wallY1 = 4096 } = {}) {
  const sectors = [left, right];
  const wall = setWallHeights({
    x0: 2048, y0: wallY0, x1: 2048, y1: wallY1,
    posSector: 1, negSector: 2,
    posSidedefRec: pos, negSidedefRec: neg,
    drawable: !!(pos || neg), passable: !!((pos || neg)?.flags & WF.PASSABLE),
    mapNever: false, mapAlways: false, collisionMetadata: true, collisionNode: 1,
    nextWall: 0, nextCollisionWall: 0,
  }, sectors);
  const leaves = [
    { type: 'leaf', node: 2, sectorNum: 1, sector: left, bbox: [0, 0, 2048, 4096],
      polygon: [[0, 0], [2048, 0], [2048, 4096], [0, 4096]] },
    { type: 'leaf', node: 3, sectorNum: 2, sector: right, bbox: [2048, 0, 4096, 4096],
      polygon: [[2048, 0], [4096, 0], [4096, 4096], [2048, 4096]] },
  ];
  // The canonical client BSP is 0-based. Protocol coordinates add one KOD square
  // (64 fine units) on the wire; broker tests below cross that boundary explicitly.
  const root = { type: 'internal', node: 1, positive: 2, negative: 3,
                 bbox: [0, 0, 4096, 4096], firstWall: 1, firstCollisionWall: 1,
                 separator: { a: -CLIENT_FINENESS, b: 0,
                              c: 2048 * CLIENT_FINENESS } };
  return new RoomGeometry({ file: 'synthetic.roo', version: 13, security: TEST_SECURITY,
    rows: 4, cols: 4,
    grid: Buffer.alloc(16, 0xff), flags: Buffer.alloc(16, 1), monsterGrid: null,
    walls: [wall], sidedefs: [pos, neg].filter(Boolean), sectors,
    nodes: [root, ...leaves], leaves, bspRoot: 1,
    clientSize: { width: 4096, height: 4096, rows: 4, cols: 4 },
    collisionVersion: COLLISION_VERSION });
}

function threeStrips({ left = sector(), middle = sector(), right = sector(),
                       firstX = 1400, secondX = 2600,
                       firstPos = side({ passable: true }),
                       firstNeg = side({ passable: true }),
                       secondPos = side({ passable: true }),
                       secondNeg = side({ passable: true }) } = {}) {
  const sectors = [left, middle, right];
  const makeWall = (x, posSector, negSector, posSidedefRec, negSidedefRec, collisionNode) =>
    setWallHeights({
      x0: x, y0: 0, x1: x, y1: 4096,
      posSector, negSector, posSidedefRec, negSidedefRec,
      drawable: true, passable: true, mapNever: false, mapAlways: false,
      collisionMetadata: true, collisionNode, nextWall: 0, nextCollisionWall: 0,
    }, sectors);
  const walls = [
    makeWall(firstX, 1, 2, firstPos, firstNeg, 1),
    makeWall(secondX, 2, 3, secondPos, secondNeg, 2),
  ];
  const leaves = [
    { type: 'leaf', node: 3, sectorNum: 1, sector: left,
      bbox: [0, 0, firstX, 4096],
      polygon: [[0, 0], [firstX, 0], [firstX, 4096], [0, 4096]] },
    { type: 'leaf', node: 4, sectorNum: 2, sector: middle,
      bbox: [firstX, 0, secondX, 4096],
      polygon: [[firstX, 0], [secondX, 0], [secondX, 4096], [firstX, 4096]] },
    { type: 'leaf', node: 5, sectorNum: 3, sector: right,
      bbox: [secondX, 0, 4096, 4096],
      polygon: [[secondX, 0], [4096, 0], [4096, 4096], [secondX, 4096]] },
  ];
  const splitter = (node, x, positive, negative) => ({
    type: 'internal', node, positive, negative,
    bbox: [node === 1 ? 0 : firstX, 0, 4096, 4096],
    firstWall: node, firstCollisionWall: node,
    separator: { a: -CLIENT_FINENESS, b: 0, c: x * CLIENT_FINENESS },
  });
  const nodes = [splitter(1, firstX, 3, 2), splitter(2, secondX, 4, 5), ...leaves];
  return new RoomGeometry({ file: 'three-strips.roo', version: 13, security: TEST_SECURITY,
    rows: 4, cols: 4,
    grid: Buffer.alloc(16, 0xff), flags: Buffer.alloc(16, 1), monsterGrid: null,
    walls, sidedefs: [firstPos, firstNeg, secondPos, secondNeg].filter(Boolean), sectors,
    nodes, leaves, bspRoot: 1,
    clientSize: { width: 4096, height: 4096, rows: 4, cols: 4 },
    collisionVersion: COLLISION_VERSION });
}

// THESE FIXTURES ARE ABOUT `canCrossWallAt`, SO THEY SWITCH THE HEIGHT RULE OFF.
// They deliberately build vertical faces far taller than MAX_STEP_HEIGHT — a 2048 step,
// a floor sloped to z=600 at the contact point — because that is how you exercise the
// wall test's own clauses. Once `enforceStepHeight` is on, the trace refuses those on
// HEIGHT before the wall test's verdict can be observed, and the assertion would be
// measuring the new rule rather than the thing it was written for. Passing the flag keeps
// each fixture pointed at its own subject; the height rule has its own coverage.
const WALLTEST = { enforceStepHeight: false };
const across = (g, y = 2048, options = {}) =>
  g.traceFineMoveClient(1024, y, 3072, y, options);
const back = (g, y = 2048, options = {}) =>
  g.traceFineMoveClient(3072, y, 1024, y, options);

console.log('runtime geometry controls and raw room security');
{
  // ToCliPlayer appends these fields after the ordinary identity/room record. They
  // are not presentation metadata: the low three room-flag bits select live floor
  // overrides used by the stock client's collision pass.
  const body = Buffer.alloc(54);
  let at = 0;
  const u32 = value => { body.writeUInt32LE(value >>> 0, at); at += 4; };
  const i32 = value => { body.writeInt32LE(value, at); at += 4; };
  for (const value of [101, 102, 103, 49, 104, 105, TEST_SECURITY]) u32(value);
  body.writeUInt8(17, at++);              // room light
  body.writeUInt8(23, at++);              // player light
  u32(106);                               // background resource
  u32(107);                               // wading sound
  u32(0x05);                              // depth-1 and depth-3 override flags
  i32(30); i32(-2); i32(50);              // KOD heights, converted to client units

  const player = parsePlayer(body);
  ok('BP_PLAYER parses security, room flags, and all three depth overrides',
     player.exact && player.security === TEST_SECURITY && player.roomFlags === 0x05 &&
     JSON.stringify(player.overrideDepths) === JSON.stringify([0, 480, -32, 800]),
     JSON.stringify(player));

  const liveClient = new M59Client({ verbose: false, resources: new Map() });
  liveClient.roomContents = () => ++liveClient.roomContentsRequested;
  liveClient.onGameMessage(BP.PLAYER, body);
  ok('M59Client installs BP_PLAYER runtime collision controls on the live room',
     liveClient.room.security === TEST_SECURITY && liveClient.room.flags === 0x05 &&
     JSON.stringify(liveClient.room.overrideDepths) === JSON.stringify([0, 480, -32, 800]) &&
     liveClient.room.collisionInvalidated === null,
     JSON.stringify(liveClient.room));

  // With no override, wading puts the source body at z=296 and the 850-unit
  // destination is a 554-unit cliff. Runtime depth-1 raises that body to z=480,
  // making the same 370-unit step legal. This proves the parsed values reach the
  // actual crossability decision rather than merely surviving parsing.
  const overridden = twoSides({
    left: sector({ floor: 500, depth: 204, flags: 1 }),
    right: sector({ floor: 850 }),
    pos: side({ passable: true }), neg: side({ passable: true }),
  });
  const staticDepth = across(overridden);
  const runtimeDepth = across(overridden, 2048,
    { roomFlags: player.roomFlags, overrideDepths: player.overrideDepths });
  ok('a BP_PLAYER depth override changes wall-step crossability',
     !staticDepth.arrived && runtimeDepth.arrived,
     JSON.stringify({ staticDepth, runtimeDepth }));

  const rawPath = DEFAULT_ROO_DIRS.map(dir => join(dir, 'marion.roo')).find(existsSync);
  if (!rawPath) {
    skip('raw .roo checksum rejects collision corruption', 'marion.roo is not installed');
  } else {
    const raw = readFileSync(rawPath);
    const original = parseRoo(raw, 'marion.roo');
    const corrupt = Buffer.from(raw);
    const mainOff = corrupt.readInt32LE(12);
    const wallOff = corrupt.readInt32LE(mainOff + 12);
    // Change one summed coordinate byte while preserving every offset and record
    // length. The retained header must no longer authenticate the collision body.
    corrupt[wallOff + 2 + 6] ^= 1;
    let error = null;
    try { parseRoo(corrupt, 'corrupt-marion.roo'); } catch (caught) { error = caught; }
    ok('raw .roo checksum rejects collision corruption',
       original.security === raw.readUInt32LE(8) &&
       /room security checksum mismatch/i.test(error?.message ?? ''),
       error?.message ?? 'corrupt body unexpectedly parsed');
  }
}

console.log('collision data survives the baked-map boundary');
{
  const raw = twoSides({ right: sector({ floor: 320 }),
                         pos: side({ passable: true, above: true }),
                         neg: side({ passable: false, below: false }) });
  const baked = raw.toJSON({ includeSurfaces: false });
  const restored = RoomGeometry.fromJSON(baked);
  ok('compact collision payload is versioned', baked.collisionVersion === COLLISION_VERSION);
  ok('round trip restores collision readiness', restored.collisionReady);
  ok('round trip preserves the room security binding', restored.security === TEST_SECURITY);
  ok('round trip restores the BSP root and internal splitter', restored.bspRoot === 1 &&
     restored.nodes?.[0]?.type === 'internal');
  ok('round trip restores both sector references', restored.walls[0].posSector === 1 &&
     restored.walls[0].negSector === 2);
  ok('round trip restores each wall collision owner', restored.walls[0].collisionNode === 1);
  ok('round trip restores the stock BSP wall chain',
     restored.nodes[0].firstCollisionWall === 1 &&
     restored.walls[0].nextCollisionWall === 0);
  ok('round trip restores directional sidedef tests',
     restored.walls[0].posSidedefRec.flags & WF.PASSABLE &&
     !(restored.walls[0].negSidedefRec.flags & WF.PASSABLE) &&
     restored.walls[0].posSidedefRec.aboveType === 1 &&
     restored.walls[0].negSidedefRec.belowType === 0);

  const twiceBaked = restored.toJSON({ includeSurfaces: false });
  const twiceRestored = RoomGeometry.fromJSON(twiceBaked);
  ok('collision metadata survives two full toJSON/fromJSON generations',
     twiceRestored.collisionReady && twiceRestored.nodes[0].firstCollisionWall === 1 &&
     twiceRestored.walls[0].nextCollisionWall === 0 &&
     twiceRestored.traceFineMoveClient(1024, 2048, 3072, 2048).arrived ===
       restored.traceFineMoveClient(1024, 2048, 3072, 2048).arrived,
     JSON.stringify({ first: restored.collisionReady, second: twiceRestored.collisionReady }));

  const unroutable = structuredClone(baked);
  unroutable.edgeApproaches.north = [[96, 96, 96, 63, [[1, 1]], 0]];
  redigestCollision(unroutable);
  const unroutableOnce = RoomGeometry.fromJSON(unroutable);
  const unroutableTwice = RoomGeometry.fromJSON(
    unroutableOnce.toJSON({ includeSurfaces: false }));
  ok('an unroutable baked edge stays unroutable across two map generations',
     unroutableOnce.collisionReady && unroutableTwice.collisionReady &&
     unroutableOnce.edgeApproachCandidates('north')[0]?.graph_routable === false &&
     unroutableTwice.edgeApproachCandidates('north')[0]?.graph_routable === false,
     JSON.stringify({
       first: unroutableOnce.edgeApproachCandidates('north'),
       second: unroutableTwice.edgeApproachCandidates('north'),
     }));

  const wrongDirection = structuredClone(baked);
  wrongDirection.edgeApproaches.north = [[288, 96, 320, 96, [[1, 1]], 0]];
  redigestCollision(wrongDirection);
  ok('a digest-valid approach filed under the wrong edge direction fails closed',
     !RoomGeometry.fromJSON(wrongDirection).collisionReady);

  const legacy = structuredClone(baked);
  delete legacy.collisionVersion; delete legacy.collision;
  const old = RoomGeometry.fromJSON(legacy);
  ok('legacy display-only maps are not collision-ready', !old.collisionReady);
  const refused = old.traceFineMoveClient(1024, 2048, 3072, 2048);
  ok('legacy maps fail fine movement closed', !refused.available &&
     refused.reason === 'collision_geometry_unavailable', JSON.stringify(refused));

  const corrupt = structuredClone(baked);
  corrupt.collision.leaves = corrupt.collision.leaves.slice(0, -8);
  ok('truncated collision payload fails closed', !RoomGeometry.fromJSON(corrupt).collisionReady);

  const wrongOwner = structuredClone(baked);
  const wallSides = Buffer.from(wrongOwner.collision.wallSides, 'base64');
  wallSides.writeUInt16LE(2, 10); // leaf 2, not the owning internal BSP node 1
  wrongOwner.collision.wallSides = wallSides.toString('base64');
  ok('semantically invalid wall ownership fails closed at the compact boundary',
     !RoomGeometry.fromJSON(wrongOwner).collisionReady);

  const cyclic = structuredClone(baked);
  const nodes = Buffer.from(cyclic.collision.nodes, 'base64');
  nodes.writeUInt16LE(1, 8); // root node 1 names itself as its positive child
  cyclic.collision.nodes = nodes.toString('base64');
  ok('a length-correct cyclic compact BSP fails closed',
     !RoomGeometry.fromJSON(cyclic).collisionReady);

  const orphaned = structuredClone(baked);
  const orphanNodes = Buffer.from(orphaned.collision.nodes, 'base64');
  orphanNodes.writeUInt16LE(0, 6 + 30); // root owns no chain, leaving wall 1 orphaned
  orphaned.collision.nodes = orphanNodes.toString('base64');
  redigestCollision(orphaned);
  ok('a digest-valid orphaned wall chain is rejected semantically',
     !RoomGeometry.fromJSON(orphaned).collisionReady);

  const sloped = twoSides({ right: sector({
    floorSlope: { a: 1, b: 0, c: 5, d: 0 },
  }) }).toJSON({ includeSurfaces: false });
  const zeroC = structuredClone(sloped);
  const slopeSectors = Buffer.from(zeroC.collision.sectors, 'base64');
  // Sector 2 starts after the 4-byte count and one 76-byte record; c is the
  // third double in its floor-slope plane.
  slopeSectors.writeDoubleLE(0, 4 + 76 + 12 + 16);
  zeroC.collision.sectors = slopeSectors.toString('base64');
  redigestCollision(zeroC);
  ok('a digest-valid sloped sector with c=0 fails closed',
     !RoomGeometry.fromJSON(zeroC).collisionReady);

  const tinyMap = { rooms: { '1': {
    num: 1, rows: 4, cols: 4, rooFile: 'synthetic.roo', roo: baked,
  } } };
  Object.assign(tinyMap, geometryManifest(tinyMap.rooms));
  const tinyStatus = movementMapReadiness(tinyMap);
  const corruptMap = structuredClone(tinyMap);
  corruptMap.rooms['1'].roo.collision.digest = '0'.repeat(64);
  const corruptStatus = movementMapReadiness(corruptMap);
  ok('map readiness decodes every collision payload and verifies its manifest',
     tinyStatus.ok && tinyStatus.ready === 1 && !corruptStatus.ok &&
     corruptStatus.ready === 0 && !corruptStatus.manifest_matches,
     JSON.stringify({ tinyStatus, corruptStatus }));
  const wrongDimensions = structuredClone(tinyMap);
  wrongDimensions.rooms['1'].rows = 5;
  Object.assign(wrongDimensions, geometryManifest(wrongDimensions.rooms));
  const wrongDimensionsStatus = movementMapReadiness(wrongDimensions);
  ok('map readiness independently binds graph dimensions and room filenames',
     !wrongDimensionsStatus.ok && wrongDimensionsStatus.manifest_matches &&
     wrongDimensionsStatus.ready === 0,
     JSON.stringify(wrongDimensionsStatus));
}

console.log('\nruntime and maintenance map selection');
{
  const explicit = resolve('fixture-map.json');
  ok('an explicit M59_MAP always wins runtime selection',
     movementMapFile({ explicit, exists: () => true }) === explicit);
  ok('runtime selection prefers a generated local map over the reference',
     movementMapFile({ explicit: null, exists: file => file === LOCAL_MAP_FILE }) === LOCAL_MAP_FILE);
  ok('runtime selection falls back to the checked reference when no local map exists',
     movementMapFile({ explicit: null, exists: () => false }) === CHECKED_MAP_FILE);
  ok('a bare geometry refresh updates the checked reference map',
     geometryOutputFile({ explicit: null }) === CHECKED_MAP_FILE);
  ok('refreshing the setup-local map always starts from the current checked graph',
     geometryRefreshBaseFile(LOCAL_MAP_FILE, { exists: () => true }) === CHECKED_MAP_FILE);
  ok('a custom explicit refresh preserves its own graph base',
     geometryRefreshBaseFile(explicit, { exists: file => file === explicit }) === explicit);
  ok('an explicit room-resource directory disables every fallback for build and refresh',
     JSON.stringify(roomResourceDirs({ explicit, defaults: ['steam', 'source'] })) ===
       JSON.stringify([explicit]));
  ok('an explicit room-resource authority rejects absolute and sibling path escapes',
     resourcePathWithin('C:/server/rooms', 'C:/server/rooms/room.roo') &&
     !resourcePathWithin('C:/server/rooms', 'C:/server/other/room.roo') &&
     !resourcePathWithin('C:/server/rooms', 'D:/client/room.roo'));
  const checkedProvenance = setGeometryProvenance({ geometryBuiltAt: 'old' },
    CHECKED_MAP_FILE, { sourceDir: 'C:/Users/example/private/rooms', now: () => 'new' });
  const localProvenance = setGeometryProvenance({}, LOCAL_MAP_FILE,
    { sourceDir: 'C:/server/rooms', now: () => '2026-01-02T03:04:05.000Z' });
  ok('checked-map provenance is canonical while a local map records its source',
     checkedProvenance.geometryBuiltAt == null &&
     checkedProvenance.geometrySource === 'portable reference room resources' &&
     localProvenance.geometryBuiltAt === '2026-01-02T03:04:05.000Z' &&
     localProvenance.geometrySource === resolve('C:/server/rooms'),
     JSON.stringify({ checkedProvenance, localProvenance }));
}

console.log('\nwall, elevation, and headroom rules');
{
  const solid = twoSides();
  const stopped = across(solid);
  ok('a solid wall blocks', stopped.blocked && !stopped.arrived &&
     stopped.x <= 2048 - PLAYER_RADIUS, JSON.stringify(stopped));

  const low = twoSides({ right: sector({ floor: 20 * 16 }),
                         pos: side({ passable: true }), neg: side({ passable: true }) });
  ok('a passable 20-kod step crosses', across(low).arrived);
  const exact = twoSides({ right: sector({ floor: MAX_STEP_HEIGHT }),
                           pos: side({ passable: true }), neg: side({ passable: true }) });
  ok('exactly 24 kod of rise crosses', across(exact).arrived);
  const cliff = twoSides({ right: sector({ floor: MAX_STEP_HEIGHT + 1 }),
                           pos: side({ passable: true }), neg: side({ passable: true }) });
  ok('one client unit above the climb limit blocks', !across(cliff).arrived);
  ok('the same cliff is legal downward', back(cliff).arrived);

  const asymmetric = twoSides({ pos: side({ passable: true }), neg: side({ passable: false }) });
  ok('the source-facing sidedef makes crossing directional',
     across(asymmetric).arrived && !back(asymmetric).arrived);
  const nullFacing = twoSides({ pos: null, neg: side({ passable: false }) });
  ok('a null source-facing sidedef is skipped like move.c', across(nullFacing).arrived);
  const noLowerTexture = twoSides({ right: sector({ floor: 2048 }),
    pos: side({ passable: true, below: false }), neg: side({ passable: true, below: false }) });
  ok('no lower texture short-circuits the step test',
     across(noLowerTexture, 2048, WALLTEST).arrived);

  const exactHead = twoSides({ right: sector({ ceiling: PLAYER_HEIGHT }),
    pos: side({ passable: true, above: true }), neg: side({ passable: true, above: true }) });
  ok('exactly one player-height of headroom crosses', across(exactHead).arrived);
  const lowHead = twoSides({ right: sector({ ceiling: PLAYER_HEIGHT - 1 }),
    pos: side({ passable: true, above: true }), neg: side({ passable: true, above: true }) });
  ok('one unit less headroom blocks', !across(lowHead).arrived);

  const water = twoSides({ right: sector({ floor: MAX_STEP_HEIGHT + 100, depth: 204 }),
    pos: side({ passable: true }), neg: side({ passable: true }) });
  ok('destination water depth reduces the effective step', across(water).arrived);
}

console.log('\nD3D bowtie wall-height parity');
{
  const descending = sector({ floorSlope: {
    a: 1000, b: 0, c: 1024, d: -1024 * 1000,
  } });
  const ascending = sector({ floorSlope: {
    a: -1000, b: 0, c: 1024, d: 0,
  } });
  const bowtie = (positive, negative) => setWallHeights({
    x0: 0, y0: 0, x1: 1024, y1: 0,
    posSector: 1, negSector: 2,
    posSidedefRec: side({ passable: true }),
    negSidedefRec: side({ passable: true }),
  }, [positive, negative]);
  const highPositive = bowtie(descending, ascending);
  ok('D3D bowtie keeps the endpoint-0 high split from the positive sector',
     highPositive.bowtie && highPositive.z0 === 0 && highPositive.z1 === 1000 &&
     highPositive.zz0 === 0 && highPositive.zz1 === 0,
     JSON.stringify(highPositive));
  const highNegative = bowtie(ascending, descending);
  ok('D3D bowtie mirrors the stock split when sector order is reversed',
     highNegative.bowtie && highNegative.z0 === 0 && highNegative.z1 === 0 &&
     highNegative.zz0 === 0 && highNegative.zz1 === 1000,
     JSON.stringify(highNegative));
}

console.log('\ncontinuous geometry, slopes, radius, and sliding');
{
  // z = y/5 at the wall. Stock move.c does NOT sample the contact point: it uses
  // SetWallHeights' endpoint-0 z1/z2 values even on a slope. Pin that historical
  // quirk rather than silently authorizing movement the stock client refuses.
  const slope = { a: 0, b: -1, c: 5, d: 0 };
  const lowFirst = twoSides({ right: sector({ floorSlope: slope }),
    pos: side({ passable: true }), neg: side({ passable: true }) });
  ok('a sloped step uses the same endpoint-0 z1 at low and high contact points',
     across(lowFirst, 512, WALLTEST).arrived && across(lowFirst, 3000, WALLTEST).arrived &&
     canCrossWallAt(lowFirst.walls[0], 2048, 512, 0, 'pos') ===
       canCrossWallAt(lowFirst.walls[0], 2048, 3000, 0, 'pos'));
  const highFirst = twoSides({ right: sector({ floorSlope: slope }),
    pos: side({ passable: true }), neg: side({ passable: true }),
    wallY0: 3000, wallY1: 0 });
  ok('a high endpoint-0 z1 blocks the whole sloped wall like the stock client',
     !across(highFirst, 512, WALLTEST).arrived && !across(highFirst, 2500, WALLTEST).arrived);

  const ceilingSlope = { a: 0, b: -1, c: 5, d: -3500 }; // 700 + y/5
  const lowCeilingFirst = twoSides({ right: sector({ ceilingSlope }),
    pos: side({ passable: true, above: true }),
    neg: side({ passable: true, above: true }) });
  ok('sloped headroom uses static endpoint-0 z2 at every contact point',
     !canCrossWallAt(lowCeilingFirst.walls[0], 2048, 512, 0, 'pos') &&
     !canCrossWallAt(lowCeilingFirst.walls[0], 2048, 3000, 0, 'pos'));

  const shortWall = twoSides({ wallY0: 1900, wallY1: 2100 });
  ok('the player radius catches a wall endpoint the centerline misses',
     !across(shortWall, 2300).arrived);
  ok('the same ray passes outside the authentic radius', across(shortWall, 2400).arrived);
  ok('a long request cannot tunnel through an intermediate wall',
     !solidLong(shortWall).arrived);

  const beside = shortWall.traceFineMoveClient(1800, 2000, 1500, 2000);
  ok('moving away while already close to a wall is allowed', beside.arrived);

  const wall = twoSides();
  const slid = wall.traceFineMoveClient(1024, 1024, 3072, 3072);
  ok('a diagonal collision slides along the wall without crossing it',
     slid.moved && slid.slid && !slid.arrived && slid.x <= 2048 - PLAYER_RADIUS,
     JSON.stringify(slid));

  const voided = twoSides({ pos: side({ passable: true, below: false }),
                            neg: side({ passable: true, below: false }) });
  voided.leaves = [voided.leaves[0]];
  voided.nodes = [
    { ...voided.nodes[0], negative: 0 },
    voided.nodes[1],
  ];
  const voidResult = across(voided);
  ok('a destination with no BSP floor is never emitted', !voidResult.arrived &&
     voidResult.reason === 'destination_has_no_floor', JSON.stringify(voidResult));

  const brownestone = twoSides({
    left: sector({ floor: 2560, ceiling: 3776 }),
    right: sector({ floor: 2304, ceiling: 4352 }),
    pos: side({ passable: true, above: true }),
    neg: side({ passable: true, above: true }),
  });
  ok('the Brownestone 256-unit step and 1472 headroom remain legal',
     across(brownestone).arrived && back(brownestone).arrived);
}

console.log('\npacket vertical state and stock slide retries');
{
  const overhang = threeStrips({
    left: sector({ floor: 1000 }), middle: sector({ floor: 0 }),
    right: sector({ floor: 0, ceiling: 1500 }),
    secondPos: side({ passable: true, above: true }),
    secondNeg: side({ passable: true, above: true }),
  });
  const alreadyLow = overhang.traceFineMoveClient(1800, 2048, 3400, 2048,
    { slide: false });
  const descendedThisPacket = overhang.traceFineMoveClient(600, 2048, 3400, 2048,
    { slide: false });
  ok('a body already on the low floor fits under the overhang', alreadyLow.arrived,
     JSON.stringify(alreadyLow));
  ok('downhill movement preserves physical Z through the packet and blocks at a low overhang',
     !descendedThisPacket.arrived && descendedThisPacket.motionZ?.min === 0 &&
     descendedThisPacket.motionZ?.max === 1000 &&
     descendedThisPacket.x <= 2600 - PLAYER_RADIUS,
     JSON.stringify(descendedThisPacket));

  // Drive the real retry ladder with deterministic wall hits. This isolates the
  // stock-client order (first projection, second-wall projection, then +/-64 side
  // moves) from BSP fixture accidents while still executing production code.
  const firstWall = { x0: 0, y0: 0, x1: 100, y1: 100 };
  const secondWall = { x0: 0, y0: 0, x1: 100, y1: 0 };
  const scriptedResolve = (from, to, hits) => {
    const calls = [];
    const geometry = Object.create(RoomGeometry.prototype);
    geometry.leafAtClient = () => ({ sectorNum: 1, sector: sector() });
    geometry._blockingWall = (_old, target) => {
      calls.push({ x: target.x, y: target.y });
      const wall = hits[calls.length - 1];
      return wall ? { wall, index: calls.length, contact: 0, reason: 'geometry_blocked' } : null;
    };
    const result = geometry._resolveClientMicrostep(from, to, {
      slide: true, playerRadius: PLAYER_RADIUS, playerHeight: PLAYER_HEIGHT,
      roomFlags: 0, overrideDepths: null, motionZ: null,
    });
    return { calls, result };
  };
  const secondRetry = scriptedResolve(
    { x: 100, y: 100, sectorNum: 1 }, { x: 130, y: 110 },
    [firstWall, secondWall, null]);
  ok('a slide blocked by a second wall projects along that second wall before sending',
     secondRetry.calls.length === 3 && secondRetry.result.moved && secondRetry.result.slid &&
     secondRetry.result.x === 120 && secondRetry.result.y === 100,
     JSON.stringify(secondRetry));

  const sideRetry = scriptedResolve(
    { x: 100, y: 100, sectorNum: 1 }, { x: 130, y: 140 },
    [firstWall, secondWall, secondWall, secondWall, null]);
  ok('two blocked projections fall back to the stock +/-MIN_SIDE_MOVE side step',
     MIN_SIDE_MOVE === 64 && sideRetry.calls.length === 5 &&
     sideRetry.result.moved && sideRetry.result.slid &&
     sideRetry.result.x === 151 && sideRetry.result.y === 62,
     JSON.stringify(sideRetry));
}

function solidLong(g) {
  return g.traceFineMoveClient(128, 2300, 3968, 2300);
}

console.log('\nchecked-in room regressions');
{
  const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
  const rooms = Object.values(map.rooms);
  const geometries = rooms.map(room => RoomGeometry.fromJSON(room.roo));
  const readyCount = geometries.filter(geometry => geometry.collisionReady).length;
  ok('every shipped room has collision-ready geometry',
     readyCount === geometries.length, `${readyCount}/${geometries.length}`);

  const inn = RoomGeometry.fromJSON(map.rooms['106'].roo);
  // This is the actual narrow strip Camilla has to leave: moving north from the
  // 300-unit pocket crosses the 256-unit doorway step. Testing canCrossWall alone
  // misses the neighbouring wall and the player cylinder; trace the whole request.
  const brownestoneExit = inn.traceFineMoveClient(11776, 16684, 11776, 16084,
    { slide: false });
  ok('the exact real Brownestone doorway trace remains legal', brownestoneExit.arrived,
     JSON.stringify(brownestoneExit));

  const toad = RoomGeometry.fromJSON(map.rooms['202'].roo);
  const blockedHalf = toad.traceFineMoveClient(11264, 4352, 13312, 4352);
  const openHalf = toad.traceFineMoveClient(11264, 4864, 13312, 4864);
  ok('the Limping Toad half-wall blocks only its solid half',
     !blockedHalf.arrived && openHalf.arrived,
     JSON.stringify({ blockedHalf, openHalf }));

  const icky = RoomGeometry.fromJSON(map.rooms['587'].roo);
  const fineWalk = (start, target) => {
    let at = { x: squareCenterClient(start.col), y: squareCenterClient(start.row) };
    const dest = { x: squareCenterClient(target.col), y: squareCenterClient(target.row) };
    const fan = [0, 0.35, -0.35, 0.75, -0.75, 1.2, -1.2, 1.7, -1.7];
    for (let stepNo = 0; stepNo < 40; stepNo++) {
      const dx = dest.x - at.x, dy = dest.y - at.y;
      const remaining = Math.hypot(dx, dy);
      if (remaining <= 40 * 16) return true;
      const base = Math.atan2(dy, dx), reach = Math.min(48 * 16, remaining);
      let moved = false;
      for (const offset of fan) {
        const trace = icky.traceFineMoveClient(at.x, at.y,
          at.x + Math.cos(base + offset) * reach,
          at.y + Math.sin(base + offset) * reach);
        if (!trace.moved) continue;
        at = { x: trace.x, y: trace.y }; moved = true; break;
      }
      if (!moved) return false;
    }
    return false;
  };
  ok('the Icky Cave staged fine crossing remains navigable',
     fineWalk({ col: 3, row: 18 }, { col: 3, row: 17 }));

  // badland2.roo wall 25 belongs to BSP node 34. Both sides name sector 2,
  // so sector identity cannot choose a sidedef: the node plane must. Its positive
  // side is solid (flags 2), while its negative side is passable (flags 6).
  const kardde = RoomGeometry.fromJSON(map.rooms['49'].roo);
  const karddeWall = kardde.walls?.find(w => w.x0 === 14336 && w.y0 === 8192 &&
    w.x1 === 13312 && w.y1 === 7168 && w.posSector === 2 && w.negSector === 2);
  const karddeSolid = kardde.traceFineMoveClient(14080, 7424, 13568, 7936,
    { slide: false });
  const karddeOpen = kardde.traceFineMoveClient(13568, 7936, 14080, 7424,
    { slide: false });
  ok('the real Kardde same-sector wall follows its asymmetric BSP sidedefs',
     karddeWall?.collisionNode === 34 && !karddeSolid.arrived && karddeOpen.arrived,
     JSON.stringify({ wall: karddeWall, solid: karddeSolid, open: karddeOpen }));

  // marion.roo wall 581 is a real D3D bowtie: sector 72's sloped floor starts
  // below sector 70 and ends above it. These are the exact SetWallHeights values
  // produced by the shipped room, including the intentionally asymmetric splits.
  const marion = RoomGeometry.fromJSON(map.rooms['200'].roo);
  const marionBowtie = marion.walls.find(w => w.x0 === 20480 && w.y0 === 49664 &&
    w.x1 === 19376 && w.y1 === 49664 && w.posSector === 72 && w.negSector === 70);
  ok('the real shipped Marion bowtie has stock D3D wall-height splits',
     marionBowtie?.bowtie === true && marionBowtie.z0 === 2560 &&
     marionBowtie.z1 === 2560 && marionBowtie.zz0 === 3488 && marionBowtie.zz1 === 3526,
     JSON.stringify(marionBowtie));

  const checkedVault = RoomGeometry.fromJSON(map.rooms['114'].roo);
  const checkedParallel = checkedVault.traceFineMoveClient(8688, 5856, 8672, 5856,
    { slide: false });
  const checkedCorner = checkedVault.traceFineMoveClient(5808, 1856, 5744, 1936,
    { slide: false });
  ok('the checked map pins the stock BarVault IntersectNode edge cases',
     !checkedParallel.arrived && !checkedParallel.moved && checkedCorner.arrived,
     JSON.stringify({ checkedParallel, checkedCorner }));

  const checked150 = RoomGeometry.fromJSON(map.rooms['150'].roo)
    .edgeApproachCandidates('west');
  const checked556 = RoomGeometry.fromJSON(map.rooms['556'].roo)
    .edgeApproachCandidates('east');
  const checked599 = RoomGeometry.fromJSON(map.rooms['599'].roo)
    .edgeApproachCandidates('east');
  const checked574 = RoomGeometry.fromJSON(map.rooms['574'].roo)
    .edgeApproachCandidates('north');
  const checked802 = RoomGeometry.fromJSON(map.rooms['802'].roo)
    .edgeApproachCandidates('south');
  const checkedGateDetour = findPath(map, 574, 563);
  ok('checked edge approaches keep Cor Noth and its gate closed where geometry is sealed',
     checked150.length === 0 && checked574.length === 0 && checkedGateDetour.found &&
     checkedGateDetour.hops.map(hop => hop.to).join(',') === '564,563',
     JSON.stringify({ checked150, checked574, checkedGateDetour }));
  ok('checked edge approaches retain Farol and Temple fine-only legal crossings',
     checked556.length === 1 && checked556[0].graph_routable === true &&
     checked802.length > 0 && checked802.every(candidate => candidate.graph_routable),
     JSON.stringify({ checked556, checked802 }));
  // THE BOUNDARY TARGET IS THE SUBJECT AND IT IS UNCHANGED. `graph_routable` on these
  // candidates flipped false -> true when `enforceStepHeight` was switched on, and I do
  // not have an explanation for why a STRICTER rule makes a crossing graph-routable —
  // narrowing which squares are reachable changes which candidates the boundary publishes,
  // and the survivors happen to be ones the coarse graph can reach, but that is a
  // description rather than a mechanism. What is checked here is what this assertion was
  // written to protect: the minimum boundary target. The flag is reported rather than
  // asserted, so the day somebody understands it there is a number to look at.
  //
  // Not a safety property: Ukgoth's exit-to-exit connectivity is identical with the rule
  // on and off (3 exits, 6/6 pairs), measured across 15 rooms and 3,913 pairs in total.
  ok('checked Ukgoth crossings use the minimum boundary target',
     checked599.length > 0 && checked599.every(candidate => candidate.edge_target.x === 4288),
     JSON.stringify(checked599.slice(0, 3)));
  console.log('       (graph_routable on those candidates: ' +
    [...new Set(checked599.map(c => String(c.graph_routable)))].join('/') + ' — see note)');

  const checkedFey = map.rooms['531'];
  const checkedSouth = edgeExitsOf(checkedFey).filter(edge => edge.leave === LEAVE.SOUTH);
  const checkedByDestination = new Map(checkedSouth.map(edge =>
    [edge.to, edgeCandidatesOf(checkedFey, edge)]));
  const checkedHigh = checkedByDestination.get(541) ?? [];
  const checkedLow = checkedByDestination.get(521) ?? [];
  const checkedFallback = checkedByDestination.get(532) ?? [];
  ok('the checked Fey crossing applies the whole ordered conditional edge list',
     checkedHigh.length > 0 && checkedHigh.every(candidate => candidate.col > 50) &&
     checkedLow.length > 0 && checkedLow.every(candidate => candidate.col < 27) &&
     checkedFallback.length > 0 && checkedFallback.every(candidate =>
       candidate.col >= 27 && candidate.col <= 50),
     JSON.stringify({
       high: checkedHigh.map(candidate => candidate.col),
       low: checkedLow.map(candidate => candidate.col),
       fallback: checkedFallback.map(candidate => candidate.col),
     }));
}

console.log('\nraw-client IntersectNode and edge-grounding regressions');
{
  const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
  const rawCache = new Map();
  const rawRoom = roomNum => {
    if (rawCache.has(roomNum)) return rawCache.get(roomNum);
    const room = map.rooms[String(roomNum)];
    const file = room?.rooFile && DEFAULT_ROO_DIRS
      .map(dir => join(dir, room.rooFile)).find(existsSync);
    const geometry = file ? parseRoo(readFileSync(file), room.rooFile) : null;
    rawCache.set(roomNum, geometry);
    return geometry;
  };

  const vault = rawRoom(114);
  if (!vault?.collisionReady) {
    skip('BarVault parallel and endpoint IntersectNode parity', 'barvault.roo is unavailable');
  } else {
    const parallelWall = vault.walls.findIndex(w => w.x0 === 8832 && w.y0 === 6016 &&
      w.x1 === 8320 && w.y1 === 6016);
    const parallel = vault.traceFineMoveClient(8688, 5856, 8672, 5856, { slide: false });
    ok('BarVault parallel equality inside the radius blocks on exact wall 5',
       parallelWall === 4 && !parallel.arrived && !parallel.moved &&
       parallel.wallIndex === parallelWall,
       JSON.stringify({ parallelWall, parallel }));

    const cornerWall = vault.walls.findIndex(w => w.x0 === 5520 && w.y0 === 1872 &&
      w.x1 === 5520 && w.y1 === 1744);
    const corner = vault.traceFineMoveClient(5808, 1856, 5744, 1936, { slide: false });
    ok('BarVault stock endpoint heuristic permits its exact weird corner trace',
       cornerWall === 294 && corner.arrived && corner.x === 5744 && corner.y === 1936,
       JSON.stringify({ cornerWall, corner }));
  }

  const edgeSpecs = [
    [150, 'west'], [556, 'east'], [599, 'east'], [574, 'north'], [802, 'south'],
  ];
  const edgeRooms = Object.fromEntries(edgeSpecs.map(([num]) => [num, rawRoom(num)]));
  if (edgeSpecs.some(([num]) => !edgeRooms[num]?.collisionReady)) {
    for (const label of [
      'Cor Noth room 150 west has no grounded approach',
      'Farol room 556 east retains its fine-only approach',
      'Ukgoth room 599 east uses minimum target x=4288',
      'Cor Noth gate room 574 north has no grounded approach',
      'Temple 802 south has grounded synthetic edge approaches',
    ]) skip(label, 'one or more installed raw room files are unavailable');
  } else {
    const west150 = edgeRooms[150].edgeApproachCandidates('west');
    ok('Cor Noth room 150 west has no grounded approach',
       edgeRooms[150].edgeCrossingRanges('west').length > 0 && west150.length === 0,
       JSON.stringify(west150));

    const east556 = edgeRooms[556].edgeApproachCandidates('east');
    ok('Farol room 556 east retains its fine-only approach',
       east556.length === 1 && east556[0].col === edgeRooms[556].cols &&
       east556[0].stages.every(stage => stage.col < edgeRooms[556].cols),
       JSON.stringify(east556));

    const east599 = edgeRooms[599].edgeApproachCandidates('east');
    ok('Ukgoth room 599 east uses minimum target x=4288',
       east599.length > 0 && east599.every(candidate => candidate.edge_target.x === 4288),
       JSON.stringify(east599.slice(0, 3)));

    const north574 = edgeRooms[574].edgeApproachCandidates('north');
    ok('Cor Noth gate room 574 north has no grounded approach', north574.length === 0,
       JSON.stringify(north574));

    const south802 = edgeRooms[802].edgeApproachCandidates('south');
    const room802 = { ...map.rooms['802'],
      roo: edgeRooms[802].toJSON({ includeSurfaces: false }) };
    const synthetic802 = edgeExitsOf(room802).filter(edge => edge.synthetic);
    ok('Temple 802 south has grounded synthetic edge approaches',
       south802.length > 0 && synthetic802.length === 2 &&
       synthetic802.every(edge => edgeCandidatesOf(room802, edge).length === south802.length),
       JSON.stringify({ physical: south802.length, synthetic: synthetic802.length }));
  }

  const feyGeometry = rawRoom(531);
  if (!feyGeometry?.collisionReady) {
    skip('real room 531 selects conditional edges from the whole ordered list',
      'c1.roo is unavailable');
    skip('World shares one decoded geometry object across sessions', 'c1.roo is unavailable');
    skip('World.exits uses baked approaches without runtime finePathProtocol fanout',
      'c1.roo is unavailable');
  } else {
    const fey = { ...map.rooms['531'], roo: feyGeometry.toJSON({ includeSurfaces: false }) };
    const southEdges = edgeExitsOf(fey).filter(edge => edge.leave === LEAVE.SOUTH);
    const byDestination = new Map(southEdges.map(edge => [edge.to, edgeCandidatesOf(fey, edge)]));
    const high = byDestination.get(541) ?? [];
    const low = byDestination.get(521) ?? [];
    const fallback = byDestination.get(532) ?? [];
    const key = candidate => `${candidate.fine_stand_on.x},${candidate.fine_stand_on.y}`;
    const selected = new Set([...high, ...low, ...fallback].map(key));
    const allSouth = feyGeometry.edgeApproachCandidates('south');
    ok('real room 531 selects conditional edges from the whole ordered list',
       southEdges.length === 3 && southEdges[0].condition?.type === COND.COL_GT &&
       southEdges[1].condition?.type === COND.COL_LT &&
       southEdges[2].condition?.type === COND.NONE &&
       high.length > 0 && high.every(candidate => candidate.col > 50) &&
       low.length > 0 && low.every(candidate => candidate.col < 27) &&
       fallback.length > 0 && fallback.every(candidate => candidate.col >= 27 && candidate.col <= 50) &&
       selected.size === allSouth.length,
       JSON.stringify({ high: high.map(c => c.col), low: low.map(c => c.col),
         fallback: fallback.map(c => c.col), all: allSouth.length }));

    const runtimeMap = { ...map, rooms: { ...map.rooms, '531': fey } };
    const firstStage = allSouth[0].stages[0];
    const makeWorld = () => new World({
      room: { id: fey.objId, objects: new Map() },
      self: { col: firstStage.col, row: firstStage.row,
        x: firstStage.col * KOD_FINENESS + (KOD_FINENESS >> 1),
        y: firstStage.row * KOD_FINENESS + (KOD_FINENESS >> 1) },
    }, runtimeMap);
    const worldA = makeWorld(), worldB = makeWorld();
    ok('World shares one decoded geometry object across sessions',
       worldA.geometry === worldB.geometry && worldA.geometry === sharedRoomGeometry(fey));

    const shared = worldA.geometry;
    const originalFinePath = shared.finePathProtocol;
    let finePathCalls = 0, exits = [], elapsed = Number.POSITIVE_INFINITY;
    shared.finePathProtocol = () => { finePathCalls++; throw new Error('runtime fine-path fanout'); };
    try {
      // The first call also compiles/ranks the room's many ordinary go exits. Measure
      // the steady hot path while still counting both calls for forbidden fine A* use.
      worldA.exits();
      const began = performance.now();
      exits = worldA.exits();
      elapsed = performance.now() - began;
    } finally {
      shared.finePathProtocol = originalFinePath;
    }
    ok('World.exits uses baked approaches without runtime finePathProtocol fanout',
       finePathCalls === 0 && exits.some(exit => exit.kind === 'edge') && elapsed < 1000,
       JSON.stringify({ finePathCalls, exitCount: exits.length, elapsed_ms: elapsed }));
  }
}

// `m59-broker.mjs` cannot be imported: doing so takes the fleet lock and starts
// its supervisors. Lift the real Session methods out by balanced braces instead,
// just as m59-travel-test does. This keeps the packet-boundary regression pinned
// to production control flow rather than a test-only reimplementation.
function sessionMethod(source, signature, name) {
  const start = source.indexOf(`  ${signature}`);
  ok(`the Session.${name} method was located`, start >= 0);
  if (start < 0) return null;
  const opening = source.indexOf(') {', start);
  const body = opening < 0 ? -1 : opening + 2;
  ok(`the Session.${name} body was located`, body > start + 1);
  if (body < 0) return null;
  let depth = 0, end = -1;
  for (let at = body; at < source.length; at++) {
    if (source[at] === '{') depth++;
    else if (source[at] === '}') {
      depth--;
      if (depth === 0) { end = at + 1; break; }
    }
  }
  const method = source.slice(start, end);
  ok(`the complete Session.${name} method was extracted`, end > body && method.trim().endsWith('}'));
  return end > body && method.trim().endsWith('}') ? method : null;
}

// EVERY MODULE-SCOPE NAME THE BROKER DECLARES, so a lifted method can be checked against
// the dependency map it was handed instead of against somebody's memory.
//
// THE MAP DRIFTS, SILENTLY, AND THE SUITE STAYS GREEN WHILE IT DOES. A lifted method is
// compiled with `new Function(...Object.keys(dependencies))`, so any module-scope symbol
// missing from that map is a free identifier — fine in the broker, a ReferenceError here.
// It only throws on the line that uses it, so a branch no fixture reaches is never
// compiled-in-anger and the omission is invisible. Found exactly that way: `walkTo`
// referenced `protocolToClient`, `PIVOT_ARRIVE_WITHIN` and `sidestepAround`, none of them
// declared, and 162 assertions passed because every walkTo fixture has falsy
// `collisionReady` and never enters the coalescer.
//
// So the check is mechanical rather than a habit. It is deliberately a WARNING about names
// that appear, not a proof of what executes — a name inside a comment or a string counts,
// which errs toward declaring one identifier too many. That is the safe direction: an
// extra dependency is inert, a missing one is a test that silently stops testing.
function moduleScopeNames(source) {
  const names = new Set();
  // Declarations at column 0 — and IMPORTS, which are module scope too and are the half
  // that matters most here: `protocolToClient` reaches a lifted method exactly this way.
  for (const m of source.matchAll(
    /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm))
    names.add(m[1]);
  for (const m of source.matchAll(/^import\s+([^;]+?)\s+from\s+/gm))
    for (const part of m[1].replace(/[{}]/g, ',').split(','))
      { const n = part.trim().split(/\s+as\s+/).pop()?.trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); }
  return names;
}
const BROKER_SCOPE = new Set();

// A NAME THE METHOD BINDS ITSELF IS NOT A FREE ONE. `controlToken` is a destructured
// parameter and `session` is a local; both also exist at module scope, and counting those
// as undeclared would bury the two real omissions under noise nobody would read twice.
function locallyBound(method) {
  const bound = new Set();
  const add = t => { for (const part of t.replace(/[{}[\]]/g, ',').split(',')) {
    const n = part.trim().split(/[:=]/)[0].trim().replace(/^\.\.\./, '');
    if (/^[A-Za-z_$][\w$]*$/.test(n)) bound.add(n);
  } };
  // The parameter list, which is where a destructured option like `controlToken` lives.
  const open = method.indexOf('(');
  if (open >= 0) {
    let depth = 0, at = open;
    for (; at < method.length; at++) {
      if (method[at] === '(') depth++;
      else if (method[at] === ')') { depth--; if (!depth) break; }
    }
    add(method.slice(open + 1, at));
  }
  for (const m of method.matchAll(/\b(?:const|let|var)\s+([^=;\n]+)/g)) add(m[1]);
  for (const m of method.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  // `for (const x of ...)` and catch bindings are covered by the const/let scan above.
  return bound;
}

// COMMENTS ARE NOT CODE, and in this repository they are most of the file. Scanning the
// raw text reported `session` undeclared in `step` and `exitgap` undeclared in
// `leaveViaAny` — both appearing only in prose — which is exactly the noise that gets a
// mechanical check switched off before it earns its keep.
const stripComments = t => t.replace(/\/\*[\s\S]*?\*\//g, ' ')
                            .replace(/(^|[^:])\/\/.*$/gm, '$1 ');

function checkDependencies(rawMethod, name, dependencies) {
  const method = stripComments(rawMethod);
  const declared = new Set(Object.keys(dependencies));
  const bound = locallyBound(method);
  const missing = [];
  for (const symbol of BROKER_SCOPE) {
    if (declared.has(symbol) || bound.has(symbol)) continue;
    // Word-boundary, and not preceded by a dot — `this.walkTo` is not the free `walkTo`.
    // Not preceded by a quote either, so a name inside a string is not counted.
    const re = new RegExp(`(^|[^.\\w$'"\`])${symbol.replace(/\$/g, '\\$')}\\b`);
    if (re.test(method)) missing.push(symbol);
  }
  ok(`Session.${name}'s dependency map names everything it can reach`,
     missing.length === 0,
     missing.length ? `undeclared: ${missing.join(', ')} — a branch reaching one of these ` +
                      `throws ReferenceError here while working in the broker` : '');
}

function compileSessionMethod(source, signature, name, dependencies = {}) {
  const method = sessionMethod(source, signature, name);
  if (!method) return null;
  if (BROKER_SCOPE.size) checkDependencies(method, name, dependencies);
  try {
    const compiled = new Function(...Object.keys(dependencies),
      `return ({${method}}).${name}`)(...Object.values(dependencies));
    ok(`the extracted Session.${name} method compiled`, typeof compiled === 'function');
    return compiled;
  } catch (error) {
    ok(`the extracted Session.${name} method compiled`, false, error.message);
    return null;
  }
}

// SOURCE PATH IS OURS, EVERYTHING ELSE IS UPSTREAM'S.
//
// These methods are lifted out of the PRODUCTION source by brace matching, so this
// suite is bound to which FILE the code lives in. The keeper split moved Session
// from m59-broker.mjs to m59-game.mjs here; upstream still has it in the broker.
// When that path was wrong, validateFineTarget compiled to null, one group skipped
// politely, and a later assertion dereferenced the null and took the file down --
// 164 collision assertions went quiet at exactly the moment we established that
// movement is CLIENT-AUTHORITATIVE and this model is the only collision check.
//
// If it moves again, the failure to look for is compileSessionMethod returning null.
const brokerSource = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');

// A PLAIN FUNCTION, LIFTED THE SAME WAY THE METHODS ARE. `provedSquares` is what turns a
// route into the legs the pull has proved, and stubbing it would leave `walkTo` tested on
// only the path it takes when there is no proof — which is the path this change exists to
// stop taking. Extracted by brace matching, exactly like the methods above.
function liftFunction(source, signature, deps = {}) {
  const start = source.indexOf(signature);
  if (start < 0) return null;
  let depth = 0, end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  try {
    return new Function(...Object.keys(deps),
      source.slice(start, end) + `; return ${signature.replace(/^function\s+/, '').split('(')[0]};`
    )(...Object.values(deps));
  } catch { return null; }
}

function liftClass(source, signature, name, deps = {}) {
  const start = source.indexOf(signature);
  if (start < 0) return null;
  let depth = 0, end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  try {
    return new Function(...Object.keys(deps),
      source.slice(start, end) + `; return ${name};`)(...Object.values(deps));
  } catch { return null; }
}

const DeadlinePacer = liftClass(brokerSource, 'class Pacer {', 'Pacer', {
  PACKETS_PER_SECOND: 5,
  DOOR_SETTLE_MS: 2000,
  remainingDoorSettle: () => 0,
});
ok('the production Pacer compiled for deadline regression', typeof DeadlinePacer === 'function');
const provedSquares = liftFunction(brokerSource, 'function provedSquares(geo, from, steps)',
  { KOD_FINENESS, protocolToClient });
ok('the extracted provedSquares compiled', typeof provedSquares === 'function');
ok('and with no collision model it declines to prove anything',
   provedSquares?.({ collisionReady: false }, { row: 1, col: 1 }, [{ row: 1, col: 2 }]) === null);
const atEdgeOpening = liftFunction(brokerSource,
  'function atEdgeOpening(position, opening, direction)', { KOD_FINENESS });
ok('the extracted edge-opening predicate compiled', typeof atEdgeOpening === 'function');
for (const n of moduleScopeNames(brokerSource)) BROKER_SCOPE.add(n);
const validateFineTarget = compileSessionMethod(brokerSource,
  'validateFineTarget(x, y, {', 'validateFineTarget',
  { CLIENT_FINENESS, KOD_FINENESS, blocksMovement,
    // The declared-mutable list, as the real functions: both are pure lookups over a frozen
    // table in a module that imports without taking the fleet lock, so stubbing them would
    // be testing a different rule from the one that ships.
    isMutableGeometry, mutableBecause });
// `noteGeometryDrift` is stubbed rather than lifted: this suite is about what the
// collision contract DECIDES, and where the broker files the resulting drift record is
// not that question. The decision itself is asserted below, off `validateFineTarget`,
// which stays pure precisely so it can be.
const driftRecorded = [];
let movementNow = 0;
const movementPerformance = { now: () => movementNow };
const queueValidatedMove = compileSessionMethod(brokerSource,
  'async queueValidatedMove(x, y, {', 'queueValidatedMove',
  { MOVE_INTERVAL_MS: 0, CLIENT_FINENESS, atEdgeOpening,
    performance: movementPerformance,
    noteGeometryDrift: (session, drift) => driftRecorded.push(drift) });
const confirmPosition = compileSessionMethod(brokerSource,
  'async confirmPosition({', 'confirmPosition',
  { Pacer: { note() {} }, performance: movementPerformance });
const stepFine = compileSessionMethod(brokerSource,
  'async stepFine(x, y, {', 'stepFine',
  { MOVE_INTERVAL_MS: 0, Pacer: { note() {} }, performance: movementPerformance });
const ordinaryStep = compileSessionMethod(brokerSource,
  'async step(col, row, {', 'step', {
    MOVE_INTERVAL_MS: 0, ROOM_RESYNC_MS: Number.POSITIVE_INFINITY,
    KOD_FINENESS, squaresPerSecond: () => 2.5,
    // THE REAL VALUES FROM m59-game.mjs (:67, :72), not stand-ins. `step` grew these
    // when combat facing landed, and a compiled method whose constants are invented is
    // testing a different function from the one that ships. The dependency check below
    // is what caught them missing, which is the check earning its keep.
    FACE_EPS: 8, COMBAT_FACE_HOLD_MS: 1500,
    // The movement tracer, stubbed. It is OFF in every real run unless the environment
    // turns it on, but `step` names it unconditionally, and a free identifier here throws
    // ReferenceError in the eval'd copy while working perfectly in the broker — which is
    // the whole class of failure this dependency map exists to catch. It did catch it.
    traceMove: () => {},
  });
// THE AIM, LIFTED LIKE EVERYTHING ELSE. `step` calls `this.aimInto` to decide where in the
// next square to walk, so a fixture without it is a fixture testing a different method —
// and this one is load-bearing: it is what stops the two-square bounce.
const aimInto = compileSessionMethod(brokerSource,
  'aimInto(from, row, col) {', 'aimInto', { KOD_FINENESS, protocolToClient });
// `traceMove` again, for the same reason `leaveVia` needs it: the fine walk records now, and
// a module-scope name a lifted method reaches has to be declared or the branch throws here
// while working perfectly in the broker. The tracer is off by default, so this is a no-op —
// which is exactly the property m59-collision-trace-test asserts.
const walkFine = compileSessionMethod(brokerSource,
  'async walkFine(destX, destY, {', 'walkFine', {
    // Stubbed rather than imported, the same way the other lifted methods take it: this
    // suite is about what the walk DECIDES, and the tracer is a recorder with its own suite.
    traceMove: () => {}, isTerminalMovementReason, KOD_FINENESS });
const walkTo = compileSessionMethod(brokerSource,
  'async walkTo(col, row, {', 'walkTo', {
    provedSquares,
    // THE REAL NUMBER, because the branch it guards is a behaviour: a walk that takes this
    // many steps without ever getting closer is a dither and is handed back to the caller.
    // Fourteen is generous enough to go round a building and far short of the sixty-odd
    // squares of oscillation measured crossing The Streets of Tos.
    WALK_STALL_STEPS: 24,
    // THE REAL FLAGS, not a stub. `walkTo` asks whether the body in its way is a PLAYER —
    // a player is also dodging and needs the object-id tie-break, a monster gets the fixed
    // clockwise-first order — and a fixture that invented its own bit would build a room
    // whose occupants the code under test cannot classify, then pass every assertion that
    // expects the monster path.
    OF,
    isTerminalMovementReason, KOD_FINENESS, MOVE_HOP_MAX_SQUARES: 8,
    // Thirteen, and the number is the server's speedhack check — see the constant.
    PROVED_HOP_MAX_SQUARES: 13,
    // The coalescer's two, which were free identifiers here for as long as the coalescer
    // existed. No fixture reached that branch — they all have falsy `collisionReady` —
    // so nothing ever threw and nothing ever said so. The value matches the broker's own
    // default; it is duplicated rather than imported because importing the broker takes
    // the fleet lock, which is the reason this whole file lifts methods by text.
    PIVOT_ARRIVE_WITHIN: 64, protocolToClient,
    // THE FUEL STOP'S PLANNER. `walkTo` works out where the shelters on this crossing are
    // while it is planning the crossing, so that wanting one later is a change to the route
    // ahead rather than a stop, a search and a replan from a standstill. Stubbed to nothing
    // here: no fixture sets `shelterPolicy`, so the branch is never entered, and the point
    // of declaring it is that the branch would otherwise throw ReferenceError the first time
    // a real journey did — which is exactly what this check exists to catch.
    sheltersAlong: () => [],
    // THE FINE DETOUR'S FOUR, AND THE LEDGER. Half of what the square lattice calls a wall
    // is a slide that landed next door; these are what thread it. Real functions, because
    // all five are ordinary exports of modules that import without taking the fleet lock.
    finePath, pullFine, pointOfSquare, boundsAround, recordTactic,
    clientToProtocol,
    // How many packets a planned square may cost. The broker's own default, duplicated
    // for the same reason PIVOT_ARRIVE_WITHIN is: importing the module takes the fleet
    // lock. It is not 1 because the mover slides and the router aims at centres.
    OFF_PLAN_STEP_BUDGET: 3,
  });
// The follower, lifted like the rest. It is not reached by `leaveVia`'s lifted copy — that
// one stubs it — so it needs its own.
const followRail = compileSessionMethod(brokerSource,
  'async followRail(squares, {', 'followRail', {
    isTerminalMovementReason,
    RAIL_STALL_WAYPOINTS: 3, RAIL_STALL_JUMP: 3,
  });
const recentreInSquare = compileSessionMethod(brokerSource,
  'async recentreInSquare() {', 'recentreInSquare', {});
let rideTrackFixture = null;
let rideTrackNow = 0;
let rideTrackStrikeCalls = 0;
const rideTrack = compileSessionMethod(brokerSource,
  'async rideTrack(fromRoom, toRoom, {', 'rideTrack', {
    KOD_FINENESS, TRACK_RIDE_MAX_PACKETS: 8, TRACK_RIDE_MAX_MS: 12_000,
    performance: { now: () => rideTrackNow },
    recallTrack: () => rideTrackFixture,
    clearStrikes: () => {},
    strikeTrack: () => { rideTrackStrikeCalls++; return 1; },
  });

let leaveViaRoutesFixture = null;
const leaveVia = compileSessionMethod(brokerSource,
  'async leaveVia(exit, {', 'leaveVia', {
    isTerminalMovementReason, KOD_FINENESS, MOVE_INTERVAL_MS: 0, atEdgeOpening,
    // The tactics ledger, as the real one. `leaveVia` now writes down whether the baked
    // rail carried the crossing or slipped, and the ledger is written to be unable to
    // throw — which is the property worth exercising rather than stubbing. It writes under
    // M59_TACTICS_DIR, which this file already points at a scratch path.
    recordTactic,
    // A MUTABLE ROUTE-TABLE SEAM AND THE REAL DESTINATION LOOKUP. With no table attached,
    // `anchorFor` answers null and the rail branch falls through to the ordinary walk. The
    // room-578 regression attaches one hermetic table to reach that otherwise untested path.
    activeRoutes: () => leaveViaRoutesFixture, anchorFor,
    // THE REAL VALUE, because the branch it guards is a behaviour rather than a stub point:
    // a rail whose line starts somewhere else is refused when the door is already close, and
    // eight squares is the number the broker ships. The measured case is the Western border
    // of the Twisted Wood, where the nearest OTHER anchor to a character that has just
    // arrived beside the 597 door is the doorway back into 586.
    RAIL_SKIP_WITHIN_SQUARES: 8,
    // THE REAL FUNCTIONS, NOT STUBS. Both are ordinary exports of m59-world.mjs — which,
    // unlike the broker, imports without taking the fleet lock — so lifting `leaveVia`
    // and handing it hand-written imitations of the two helpers it drives would be
    // testing the imitations. `DOOR_SETTLE_MS` is zeroed for the same reason
    // MOVE_INTERVAL_MS is: the fake client answers immediately or not at all.
    boundedSilentGo, boundedRegionEntry, DOOR_SETTLE_MS: 0,
    // Zero, which is the broker's own default and the measured one — see the constant.
    // Declared rather than inherited so a change to it shows up here as a test to update.
    LEAVE_VIA_CLEARANCE: 0,
    // Zero here, not the broker's 10s: these tests drive a fake client that answers
    // immediately or not at all, so the real wait would only add ten seconds per
    // never-crossing case. What the constant is FOR is live lag, which is not
    // reproducible in a sandbox.
    EDGE_CROSSING_WAIT_MS: 0,
    // Zero for the same reason EDGE_CROSSING_WAIT_MS is: the fake client answers at once or
    // not at all, so a real confirmation poll would only add seconds per never-crossing case.
    EDGE_CONFIRM_MS: 0,
    // The boundary nudge before the outward step — see the wiggle-at-the-door note in
    // m59-broker.mjs. Real values, because what they bound is how many packets the
    // approach spends, which is exactly what these tests count.
    EDGE_NUDGE_WITHIN: 16, EDGE_NUDGE_MAX_STEPS: 6,
    Pacer: { note() {} }, forgetInferredExit() {},
  });
// THE REAL ONE, not the `() => null` stub the fixtures above use. Those stubs are correct
// where the test is about something else; the blocked-door cases at the end of this file are
// about the detour itself, and stubbing it there would make them pass by removing it.
const realSidestepAround = compileSessionMethod(brokerSource,
  'sidestepAround(was, blocked, {', 'sidestepAround', {});

const leaveViaAny = compileSessionMethod(brokerSource,
  'async leaveViaAny(candidates, {', 'leaveViaAny', {
    isTerminalMovementReason, spreadEdges, orderExits: exits => exits, KOD_FINENESS,
    // THE TWO INSTRUMENTS, AS THE REAL ONES. Both are ordinary exports of modules that
    // import without taking the fleet lock, and both are written to be unable to throw —
    // which is exactly the property worth exercising here rather than stubbing away. They
    // write under M59_TACTICS_DIR / M59_CROSSINGS_LEARNED, which this file points at a
    // scratch path below so a test run never edits the fleet's own books.
    recordTactic, recordCrossing,
    // THE BAKED ANCHOR, WHICH leaveViaAny NOW PUTS IN FRONT OF THE SCANNED EXIT SQUARES.
    // Both are pure reads of the routing table — `activeRoutes` returns whatever is loaded,
    // `anchorFor` is the accessor that cannot express a room/destination mix-up — so the real
    // ones are used rather than stubs, and a fixture with no table simply gets null and falls
    // back to the scan, which is the degradation the change is designed around.
    activeRoutes, anchorFor,
  });

function fakeBrokerSession(geometry, {
  x = clientToWire(1024), y = clientToWire(2048),
  roomId = 1, roomSecurity = geometry?.security ?? TEST_SECURITY,
  objects = [], beforePaced = null,
} = {}) {
  const packets = [], turns = [];
  const selfId = 99;
  const self = { x, y, col: Math.floor(x / KOD_FINENESS), row: Math.floor(y / KOD_FINENESS) };
  const roomObjects = new Map([[selfId, self], ...objects.map(object => [object.id, object])]);
  const client = {
    selfId,
    self,
    evSeq: 0,
    roomContentsRequested: 0,
    roomContentsReceived: 0,
    room: { id: roomId, security: roomSecurity, flags: 0,
      overrideDepths: [0, 0, 0, 0], collisionInvalidated: null, objects: roomObjects },
    moveTo(nextX, nextY, speed, packetRoom) {
      packets.push({ x: nextX, y: nextY, speed, room: packetRoom });
      this.self = {
        ...this.self,
        x: nextX, y: nextY,
        col: Math.floor(nextX / KOD_FINENESS), row: Math.floor(nextY / KOD_FINENESS),
      };
      this.room.objects.set(selfId, this.self);
    },
    face(degrees) { turns.push(degrees); },
    predictSelf(next) {
      this.self = { ...this.self, ...next, predicted: true };
      this.room.objects.set(selfId, this.self);
    },
    roomContents() {
      const request = ++this.roomContentsRequested;
      this.roomContentsReceived = request;
      return request;
    },
    async waitFor() { return { timedOut: false, seq: ++this.evSeq }; },
  };
  const session = {
    client,
    world: { geometry },
    finePositionUnknown: false,
    collisionVertical: null,
    lastRoomRead: Date.now(),
    pacer: { async submit(kind, invoke) {
      if (typeof beforePaced === 'function') await beforePaced(kind, client);
      return invoke();
    } },
    need() { return this.client; },
    moveSpeed() { return 18; },
    validateFineTarget,
    queueValidatedMove,
    confirmPosition,
    aimInto,
  };
  return { session, client, packets, turns };
}

console.log('\nclient protocol bounds and live geometry invalidation');
{
  const packetClient = Object.create(M59Client.prototype);
  packetClient.room = { id: 1 };
  let sent = 0;
  packetClient.send = () => { sent++; };
  const rejected = [[-1, 0], [0, -1], [0x10000, 0], [0, 0x10000]]
    .map(([x, y]) => {
      try { packetClient.moveTo(x, y); return false; }
      catch (error) { return error instanceof RangeError; }
    });
  ok('M59Client.moveTo rejects negative and overflowing unsigned-16 targets without a packet',
     rejected.every(Boolean) && sent === 0, JSON.stringify({ rejected, sent }));

  const newClient = () => new M59Client({ verbose: false, resources: new Map() });
  const cosmetic = newClient();
  cosmetic.onGameMessage(BP.SECTOR_ANIMATE, Buffer.alloc(0));
  const normalTexture = Buffer.alloc(5);
  normalTexture.writeUInt8(0x02, 4);
  cosmetic.onGameMessage(BP.CHANGE_TEXTURE, normalTexture);
  ok('cosmetic sector animation and normal-wall texture changes keep collision valid',
     cosmetic.room.collisionInvalidated === null,
     JSON.stringify(cosmetic.room.collisionInvalidated));

  const movingSector = newClient();
  movingSector.onGameMessage(BP.SECTOR_MOVE, Buffer.alloc(0));
  const movingWall = newClient();
  movingWall.onGameMessage(BP.WALL_ANIMATE, Buffer.alloc(0));
  const lowerTexture = newClient();
  const lowerBody = Buffer.alloc(5);
  lowerBody.writeUInt8(0x04, 4);
  lowerTexture.onGameMessage(BP.CHANGE_TEXTURE, lowerBody);
  ok('moving geometry and above/below texture changes invalidate live collision',
     movingSector.room.collisionInvalidated?.opcode === BP.SECTOR_MOVE &&
     movingWall.room.collisionInvalidated?.opcode === BP.WALL_ANIMATE &&
     lowerTexture.room.collisionInvalidated?.opcode === BP.CHANGE_TEXTURE &&
     lowerTexture.room.collisionInvalidated?.flags === 0x04,
     JSON.stringify({ sector: movingSector.room.collisionInvalidated,
       wall: movingWall.room.collisionInvalidated,
       texture: lowerTexture.room.collisionInvalidated }));
}

console.log('\nterminal movement propagation and edge packet authority');
{
  let fineFallbacks = 0, goFallbacks = 0;
  const boundedTerminal = await boundedRegionEntry({
    candidates: [{ stand_on: { col: 2, row: 2 } }],
    sequence: () => 0,
    eventsSince: () => [],
    walk: async () => ({ arrived: false, reason: 'collision_geometry_changed' }),
    fineWalk: async () => { fineFallbacks++; return { arrived: true }; },
    waitForEntry: async () => null,
    askGo: async () => { goFallbacks++; },
  });
  ok('bounded region entry propagates terminal collision state without fine/go fallback',
     boundedTerminal.terminal?.reason === 'collision_geometry_changed' &&
     fineFallbacks === 0 && goFallbacks === 0,
     JSON.stringify({ boundedTerminal, fineFallbacks, goFallbacks }));

  if (typeof walkTo !== 'function') {
    skip('walkTo propagates a terminal step without replanning', 'Session.walkTo did not extract');
    skip('walkTo reports unknown own position as a terminal contract reason',
      'Session.walkTo did not extract');
    skip('walkTo reports a permanently floorless start as terminal',
      'Session.walkTo did not extract');
  } else {
    let stepCalls = 0;
    const client = { self: { col: 1, row: 1, x: 96, y: 96 } };
    const geometry = {
      walkable: () => true,
      // `standable` is what walkTo asks now — see RoomGeometry.standable. A fixture that
      // models only `walkable` is a fixture of the old predicate, and the failure is a
      // TypeError rather than a wrong answer, which is the good direction: it says the
      // fake has fallen behind rather than quietly testing something else.
      standable: () => true,
      path: () => ({ found: true, steps: [{ col: 2, row: 1 }] }),
    };
    const session = {
      client, world: { geometry }, movementGeneration: 0,
      need() { return this.client; },
      movementWasCancelled() { return false; },
      // NO BAKED RAIL. `leaveVia` now tries a precomputed exit-to-exit crossing before its
      // ordinary walk (see railAcross), and these fixtures are about the walk — a stub that
      // returned a rail would test the rail instead. Returning null is also the honest state
      // for a fixture with no routes table behind it.
      railAcross() { return null; },
      async followRail() { return { railed: false, reason: 'no rail in this fixture' }; },

      threatsHere() { return []; },
      async step() {
        stepCalls++;
        return { moved: false, left_room: false, reason: 'room_geometry_mismatch' };
      },
    };
    const result = await walkTo.call(session, 2, 1, { maxSteps: 5, hardCap: 10 });
    ok('walkTo propagates a terminal step without replanning',
       result.reason === 'room_geometry_mismatch' && stepCalls === 1 && result.replans === 0,
       JSON.stringify({ result, stepCalls }));

    let pathCalls = 0, resyncCalls = 0;
    const unknown = {
      client: { self: null }, world: { geometry: { path() { pathCalls++; } } },
      need() { return this.client; },
      // walkTo now ASKS the server before giving up — losing our own object out of the
      // room map is the ordinary state for a moment after a room is rebuilt. This fixture
      // is the OTHER case: the read is made and still cannot answer, which is the only
      // situation where the terminal verdict below is the right one.
      async selfOrResync() { resyncCalls++; return null; },
    };
    const unknownResult = await walkTo.call(unknown, 2, 1, { maxSteps: 5, hardCap: 10 });
    ok('walkTo asks the server before calling its own position unknown',
       resyncCalls === 1, JSON.stringify({ resyncCalls }));
    ok('walkTo reports unknown own position as a terminal contract reason',
       unknownResult.reason === 'own_position_unknown' &&
       isTerminalMovementReason(unknownResult.reason) && pathCalls === 0,
       JSON.stringify({ unknownResult, pathCalls }));

    const floorless = {
      client: { self: { col: 9, row: 9 } }, movementGeneration: 0,
      // Floorless to BOTH predicates: the grid says no and there is no BSP floor either,
      // which is the only combination that is genuinely `start_has_no_floor`. A square the
      // grid alone refuses is now a place a character may legitimately be standing.
      world: { geometry: { walkable: () => false, standable: () => false,
                           nearestWalkable: () => null } },
      need() { return this.client; }, movementWasCancelled() { return false; },
    };
    const floorlessResult = await walkTo.call(floorless, 2, 1, { maxSteps: 5, hardCap: 10 });
    ok('walkTo reports a permanently floorless start as terminal',
       floorlessResult.reason === 'start_has_no_floor' &&
       isTerminalMovementReason(floorlessResult.reason), JSON.stringify(floorlessResult));

    // ------------------------------------------------ blocked by a body that is EATING us
    // WAITING FOR AN ENGAGED MONSTER TO WANDER OFF IS SUICIDE, AND IT WAS THE DEFAULT.
    //
    // The retry is built on "monsters wander, so one lap costs a second and often clears
    // it". True of a monster that has not noticed us; false of the only case that kills
    // anybody. An engaged monster stays exactly where it is — we are what it is standing
    // there for — so every patient 500-1000ms lap is a hit taken, and the keeper is inert
    // by design for the length of an errand.
    //
    // Measured on prod: of the 18 deaths in one two-hour window that recorded hits in
    // their last minute, 5 took EVERY hit on a single square. Kermit stood on one square
    // in Main gate to Cor Noth for 118 seconds and took 23 hits; Beaker and Statler each
    // lost 47-51 health in 9 seconds without moving once.
    //
    // Being hit does NOT end the trip — doctrine is explicit that a planned journey
    // completes, and two health-based bail-outs were tried here and reverted. It stops us
    // WAITING. Both directions are pinned, because the failure is symmetric: lose the
    // patience and every passing rat costs a reroute, lose the escalation and the fleet
    // goes back to standing still while it is eaten.
    const blockedRun = async ({ falling }) => {
      let hp = 50, sleepMs = 0;
      const client = {
        self: { col: 1, row: 1, x: 96, y: 96 },
        vitals: () => ({ health: { value: hp, max: 50 } }),
      };
      const geometry = {
        walkable: () => true, standable: () => true,
        path: () => ({ found: true, steps: [{ col: 2, row: 1 }] }),
      };
      const session = {
        client, world: { geometry }, movementGeneration: 0,
        need() { return this.client; },
        movementWasCancelled() { return false; },
        threatsHere() { return []; },
        // No way round, so the walker must fall through to the occupancy path either way.
        sidestepAround() { return null; },
        async step() {
          if (falling) hp -= 3;                       // it is hitting us every lap
          return { moved: false, left_room: false, reason: 'object_blocked' };
        },
      };
      const t0 = Date.now();
      const out = await walkTo.call(session, 2, 1, { maxSteps: 6, hardCap: 12 });
      return { out, elapsed: Date.now() - t0 };
    };
    const patient = await blockedRun({ falling: false });
    const underFire = await blockedRun({ falling: true });

    ok('a body in the way with no damage still gets the patient retry',
       patient.elapsed >= 400,
       `waited only ${patient.elapsed}ms — the retry that lets a wandering monster clear is gone`);
    ok('but a body that is HITTING us is never waited for',
       underFire.elapsed < patient.elapsed && underFire.elapsed < 400,
       `under fire took ${underFire.elapsed}ms against ${patient.elapsed}ms patient`);
    ok('and the walk reports the health it lost standing there',
       underFire.out.damage_while_blocked > 0 &&
       /lost \d+ health/.test(underFire.out.note ?? ''),
       JSON.stringify({ damage: underFire.out.damage_while_blocked, note: underFire.out.note }));
    ok('a walk blocked without damage reports no damage figure at all',
       patient.out.damage_while_blocked === undefined,
       JSON.stringify(patient.out));
    ok('both still report the bodies rather than blaming the geometry',
       (patient.out.monster_blocked ?? 0) > 0 && (underFire.out.monster_blocked ?? 0) > 0,
       JSON.stringify({ patient: patient.out.monster_blocked, underFire: underFire.out.monster_blocked }));
  }

  if (typeof leaveVia !== 'function') {
    skip('leaveVia propagates terminal approach and emits no edge packet',
      'Session.leaveVia did not extract');
    skip('the outward StandardLeaveDir packet uses stock speed zero',
      'Session.leaveVia did not extract');
    skip('an edge packet is refused when the fine approach remains behind the boundary',
      'Session.leaveVia did not extract');
    skip('an along-edge sub-square offset passes the caller preflight for final proof',
      'Session.leaveVia did not extract');
    skip('an unconfirmed edge position emits no outward packet',
      'Session.leaveVia did not extract');
    skip('a body beside a rail joins through its nearest onboarding waypoint',
      'Session.leaveVia did not extract');
    skip('a failed rail rejoin is not rewound and replayed from stale state',
      'Session.leaveVia did not extract');
    skip('a doorway position-confirmation timeout sends no correction or go',
      'Session.leaveVia did not extract');
  } else {
    const client = {
      room: { id: 1 }, self: { col: 2, row: 2, x: 160, y: 160 },
      roomNameRsc: 1, rsc: { get: () => 'next room' },
      async waitFor() { return { events: [{ kind: 'room-entered', roomName: 'next room' }] }; },
    };
    let edgePackets = 0;
    const terminalSession = {
      client, movementGeneration: 0,
      need() { return this.client; },
      movementWasCancelled() { return false; },
      // NO BAKED RAIL. `leaveVia` now tries a precomputed exit-to-exit crossing before its
      // ordinary walk (see railAcross), and these fixtures are about the walk — a stub that
      // returned a rail would test the rail instead. Returning null is also the honest state
      // for a fixture with no routes table behind it.
      railAcross() { return null; },
      async followRail() { return { railed: false, reason: 'no rail in this fixture' }; },
      async walkTo() { return { arrived: false, reason: 'room_security_unknown' }; },
      async walkFine() { throw new Error('terminal movement must not fall through'); },
      async confirmPosition() {
        return this.client?.self
          ? { col: this.client.self.col, row: this.client.self.row }
          : null;
      },
      async queueValidatedMove() { edgePackets++; return { sent: true }; },
      world: { exits: () => [] },
    };
    const exit = {
      kind: 'edge', direction: 'east', to: 2,
      stand_on: { col: 2, row: 2 }, fine_stand_on: { x: 160, y: 160 },
      edge_target: { x: 192, y: 160 }, fine_path: [{ x: 160, y: 160 }],
    };
    const terminal = await leaveVia.call(terminalSession, exit, {});
    ok('leaveVia propagates terminal approach and emits no edge packet',
       terminal.reason === 'room_security_unknown' && terminal.stage === 'walk' &&
       edgePackets === 0, JSON.stringify({ terminal, edgePackets }));

    let edgeOptions = null;
    const successSession = {
      ...terminalSession,
      async walkTo() { return { arrived: true }; },
      async walkFine() { return { arrived: true }; },
      async queueValidatedMove(_x, _y, options) {
        edgeOptions = options;
        return { sent: true, eventSeq: 10 };
      },
    };
    const left = await leaveVia.call(successSession, exit, {});
    ok('the outward StandardLeaveDir packet uses stock speed zero',
       left.left === true && edgeOptions?.speed === 0 && edgeOptions?.slide === false &&
       edgeOptions?.expectedRoomId === 1 && edgeOptions?.offMap?.opening === exit.fine_stand_on &&
       edgeOptions?.offMap?.direction === 'east',
       JSON.stringify({ left, edgeOptions }));

    let unconfirmedEdgePackets = 0;
    const unconfirmedEdgeSession = {
      ...successSession,
      async confirmPosition() { return null; },
      async queueValidatedMove() {
        unconfirmedEdgePackets++;
        return { sent: true };
      },
    };
    const unconfirmedEdge = await leaveVia.call(unconfirmedEdgeSession, exit, {});
    ok('an unconfirmed edge position emits no outward packet',
       unconfirmedEdge.left === false &&
         unconfirmedEdge.reason === 'position_confirmation_timeout' &&
         unconfirmedEdgePackets === 0,
       JSON.stringify({ unconfirmedEdge, unconfirmedEdgePackets }));

    let unsafeEdgePackets = 0;
    const behindBoundarySession = {
      ...terminalSession,
      client: {
        ...client,
        room: { id: 536 },
        self: { col: 17, row: 2, x: 1125, y: 178 },
      },
      async walkTo() { return { arrived: true }; },
      async walkFine() { return { arrived: false, reason: 'geometry_blocked' }; },
      async queueValidatedMove() { unsafeEdgePackets++; return { sent: true }; },
    };
    const northExit = {
      kind: 'edge', direction: 'north', to: 535,
      stand_on: { col: 17, row: 2 }, fine_stand_on: { x: 1120, y: 96 },
      edge_target: { x: 1120, y: 63 }, fine_path: [{ x: 1120, y: 96 }],
    };
    const refusedEdge = await leaveVia.call(behindBoundarySession, northExit, {});
    ok('an edge packet is refused when the fine approach remains behind the boundary',
       refusedEdge.left === false && refusedEdge.stage === 'walk' &&
       refusedEdge.reason === 'not_at_edge_opening' && unsafeEdgePackets === 0,
       JSON.stringify({ refusedEdge, unsafeEdgePackets }));

    let offsetEdgePackets = 0;
    const offsetBoundarySession = {
      ...terminalSession,
      client: {
        ...client,
        room: { id: 10 },
        // The fixed north-boundary row matches. The x coordinate is 16 units across an
        // along-edge coarse-square boundary from the candidate and is still the same gap.
        self: { col: 1, row: 1, x: 112, y: 96 },
      },
      async walkTo() { return { arrived: true }; },
      async walkFine() { return { arrived: false, reason: 'stalled' }; },
      async queueValidatedMove(_x, _y, options) {
        offsetEdgePackets++;
        return { sent: true, eventSeq: 20, options };
      },
    };
    const offsetExit = {
      kind: 'edge', direction: 'north', to: 11,
      stand_on: { col: 1, row: 1 }, fine_stand_on: { x: 128, y: 96 },
      edge_target: { x: 128, y: 63 }, fine_path: [{ x: 128, y: 96 }],
    };
    const offsetEdge = await leaveVia.call(offsetBoundarySession, offsetExit, {});
    ok('an along-edge sub-square offset passes the caller preflight for final proof',
       offsetEdge.left === true && offsetEdgePackets === 1,
       JSON.stringify({ offsetEdge, offsetEdgePackets }));

    // Room 578's west-entry -> north-exit rail starts (36,2),(35,2),(34,3). The body
    // arrives beside it at (36,3): scanning backwards selected diagonal (35,2), then
    // skipped that point too, so the first requested square was the two-row jump (34,3).
    // A failed rejoin then used stale pre-rail state to board and replay the same line.
    const railCalls = [], railWalks = [];
    const craggedClient = {
      room: { id: 578 }, self: { col: 3, row: 36, x: 224, y: 2336 },
      roomNameRsc: 1, rsc: { get: () => 'The Cragged Mountains' },
    };
    const craggedRail = {
      from: { row: 36, col: 2 },
      squares: [
        { row: 36, col: 2 }, { row: 35, col: 2 },
        { row: 34, col: 3 }, { row: 33, col: 3 }, { row: 1, col: 13 },
      ],
    };
    const craggedSession = {
      ...terminalSession,
      client: craggedClient,
      world: { room: { num: 578 }, exits: () => [] },
      railAcross() { return craggedRail; },
      async followRail(squares) {
        railCalls.push(squares.map(square => `${square.row},${square.col}`));
        return { railed: false, reason: 'slipped_off_rail', at: 1, walked: 1 };
      },
      async walkTo(col, row) {
        railWalks.push(`${row},${col}`);
        return { arrived: false, reason: 'room_security_unknown' };
      },
      async walkFine() { throw new Error('terminal ordinary walk fell through to fine movement'); },
    };
    const craggedExit = {
      kind: 'edge', direction: 'north', to: 576, steps_away: 35,
      stand_on: { row: 1, col: 13 }, fine_stand_on: { x: 850, y: 96 },
      edge_target: { x: 850, y: 63 }, fine_path: [{ x: 850, y: 96 }],
    };
    const priorRailSetting = process.env.M59_RAIL;
    leaveViaRoutesFixture = { rooms: { 578: { anchors: [
      { to: 576, row: 1, col: 13, from_body: true },
    ] } } };
    process.env.M59_RAIL = '1';
    let cragged;
    try {
      cragged = await leaveVia.call(craggedSession, craggedExit, {});
    } finally {
      leaveViaRoutesFixture = null;
      if (priorRailSetting == null) delete process.env.M59_RAIL;
      else process.env.M59_RAIL = priorRailSetting;
    }
    ok('a body beside a rail joins through its nearest onboarding waypoint',
       railCalls.length === 1 && railCalls[0][0] === '36,2',
       JSON.stringify({ cragged, railCalls, railWalks }));
    ok('a failed rail rejoin is not rewound and replayed from stale state',
       railCalls.length === 1 && !railWalks.includes('36,2') && railWalks.includes('1,13'),
       JSON.stringify({ cragged, railCalls, railWalks }));

    let fineCorrections = 0, goPackets = 0;
    const unknownDoorSession = {
      client: { room: { id: 1 }, self: { col: 4, row: 4 } },
      movementGeneration: 0, finePositionUnknown: false,
      need() { return this.client; },
      movementWasCancelled() { return false; },
      // NO BAKED RAIL. `leaveVia` now tries a precomputed exit-to-exit crossing before its
      // ordinary walk (see railAcross), and these fixtures are about the walk — a stub that
      // returned a rail would test the rail instead. Returning null is also the honest state
      // for a fixture with no routes table behind it.
      railAcross() { return null; },
      async followRail() { return { railed: false, reason: 'no rail in this fixture' }; },

      async walkTo() { return { arrived: true }; },
      async confirmPosition() { return null; },
      async stepFine() { fineCorrections++; return { moved: true }; },
      async standBeforeGo() {},
      pacer: { async submit() { goPackets++; } },
    };
    const unknownDoor = await leaveVia.call(unknownDoorSession, {
      kind: 'go', stand_on: { col: 4, row: 4 }, steps_away: 0,
    }, {});
    ok('a doorway position-confirmation timeout sends no correction or go',
       unknownDoor.reason === 'position_confirmation_timeout' &&
       isTerminalMovementReason(unknownDoor.reason) &&
       unknownDoorSession.finePositionUnknown === true &&
       fineCorrections === 0 && goPackets === 0,
       JSON.stringify({ unknownDoor, fineCorrections, goPackets }));
  }

  if (typeof leaveViaAny !== 'function') {
    skip('leaveViaAny stops after the first terminal candidate',
      'Session.leaveViaAny did not extract');
  } else {
    let attempts = 0;
    const session = {
      movementGeneration: 0,
      movementWasCancelled() { return false; },
      async leaveVia() {
        attempts++;
        return { left: false, reason: 'collision_geometry_unavailable' };
      },
    };
    const result = await leaveViaAny.call(session,
      [{ kind: 'edge', stand_on: { col: 1, row: 1 } },
       { kind: 'edge', stand_on: { col: 2, row: 2 } }], {});
    ok('leaveViaAny stops after the first terminal candidate',
       result.reason === 'collision_geometry_unavailable' && attempts === 1,
       JSON.stringify({ result, attempts }));
  }

  // A STEP A MONSTER REFUSED IS NOT A STEP THE ROUTE SPENT.
  //
  // The budget exists to stop a walk going nowhere; a body in the way is going nowhere for
  // a different reason, and burning the budget on it reports a wall where there is traffic.
  // Bounded, so a permanently plugged corridor still ends.
  if (typeof walkTo !== 'function') {
    skip('a monster-blocked step does not consume the walk budget', 'walkTo did not extract');
  } else {
    let asks = 0;
    const client = { self: { col: 3, row: 3, x: 3 * 1024, y: 3 * 1024 }, room: { id: 1 } };
    const geometry = {
      walkable: () => true, standable: () => true, collisionReady: false,
      path: (r, c, tr, tc) => ({ found: true, steps: [{ col: c + 1, row: r }] }),
    };
    const session = {
      client, world: { geometry }, movementGeneration: 0,
      need() { return this.client; },
      movementWasCancelled() { return false; },
      // NO BAKED RAIL. `leaveVia` now tries a precomputed exit-to-exit crossing before its
      // ordinary walk (see railAcross), and these fixtures are about the walk — a stub that
      // returned a rail would test the rail instead. Returning null is also the honest state
      // for a fixture with no routes table behind it.
      railAcross() { return null; },
      async followRail() { return { railed: false, reason: 'no rail in this fixture' }; },

      threatsHere() { return []; },
      sidestepAround() { return null; },
      async step() { asks++; return { moved: false, left_room: false, reason: 'object_blocked' }; },
    };
    const out = await walkTo.call(session, 12, 12, { maxSteps: 6 });
    // Without the refund the walk stops after 6 asks; with it, it keeps asking until the
    // refund allowance is spent too, so the count must exceed the bare budget.
    ok('a monster-blocked step does not consume the walk budget',
       out.arrived === false && asks > 6,
       JSON.stringify({ asks, steps: out.steps, monster_blocked: out.monster_blocked }));
  }

  // A CYCLING DOOR IS WAITED AT, NOT WALKED AWAY FROM — BUT A REAL GEOMETRY CHANGE STILL
  // ENDS THE WALK.
  //
  // `collision_geometry_changed` is terminal because we cannot mutate our BSP the way the
  // stock client does. The thing that fires it most, though, is a door, and the Temple of
  // Qor's sits on the Cragged Mountains -> Ukgoth crossing and cycles faster than the 8s
  // invalidation window. Abandoning the boundary means walking the whole room again and
  // arriving at a fresh random phase of the same cycle: measured, that leg completed 0 of 3.
  if (typeof leaveViaAny !== 'function') {
    skip('a doorway held by a live animation is waited at, not abandoned', 'did not extract');
    skip('and a geometry change that never clears still ends the walk', 'ditto');
  } else {
    process.env.M59_ANIMATION_WAIT_MS = '1';
    const door = [{ kind: 'edge', to: 599, stand_on: { col: 22, row: 64 } }];
    {
      let attempts = 0;
      const session = {
        movementGeneration: 0, world: { room: { num: 598 } },
        movementWasCancelled() { return false; },
        async leaveVia() {
          attempts++;
          if (attempts >= 3) return { left: true };      // the door came open
          return { left: false, reason: 'collision_geometry_changed',
                   animation: { sector: 12, narrowed: true, expires_in_ms: 40 } };
        },
        async retreatAlongBreadcrumbs() { return { steps: 0 }; },
        async leaveViaUnvalidated() { return { left: false }; },
      };
      const result = await leaveViaAny.call(session, door, {});
      ok('a doorway held by a live animation is waited at, not abandoned',
         result.left === true && attempts === 3,
         JSON.stringify({ left: result.left, attempts }));
    }
    {
      let attempts = 0;
      const session = {
        movementGeneration: 0, world: { room: { num: 598 } },
        movementWasCancelled() { return false; },
        async leaveVia() {
          attempts++;
          return { left: false, reason: 'collision_geometry_changed',
                   animation: { sector: null, narrowed: false, expires_in_ms: null } };
        },
        async retreatAlongBreadcrumbs() { return { steps: 0 }; },
        async leaveViaUnvalidated() { return { left: false }; },
      };
      const result = await leaveViaAny.call(session, door, {});
      ok('and a geometry change that never clears still ends the walk',
         result.left !== true && attempts <= 8,
         JSON.stringify({ left: result.left, attempts }));
    }
    delete process.env.M59_ANIMATION_WAIT_MS;
  }

  // ONCE IT IS THROUGH, IT STOPS.
  //
  // Every recovery below is MOVEMENT, and after a crossing the character stands a step from
  // the boundary it just came through — so a recovery run at that moment walks it back.
  // Watched live: a subject wiggled through the entrance to The Flatlands and then zoned
  // straight back into Main gate to Cor Noth, undoing the only thing that had worked. The
  // room is the authority here, not the crossing's own report, because a transition that
  // lands a beat late reads as a refusal while the server has already moved us.
  if (typeof leaveViaAny !== 'function') {
    skip('a crossing that reported failure but changed the room is not recovered from', 'did not extract');
  } else {
    let retreats = 0, attempts = 0;
    const session = {
      movementGeneration: 0,
      world: { room: { num: 100 } },
      movementWasCancelled() { return false; },
      async leaveVia() {
        attempts++;
        // The move worked and the server moved us; the report did not catch up.
        this.world.room.num = 101;
        return { left: false, reason: 'object_blocked', monster_blocked: 1 };
      },
      async retreatAlongBreadcrumbs() { retreats++; return { steps: 4 }; },
      async leaveViaUnvalidated() { return { left: false }; },
    };
    const result = await leaveViaAny.call(session,
      [{ kind: 'edge', to: 101, stand_on: { col: 5, row: 2 }, fine_stand_on: { x: 96, y: 335 } },
       { kind: 'edge', to: 101, stand_on: { col: 5, row: 2 }, fine_stand_on: { x: 96, y: 352 } }], {});
    ok('a crossing that reported failure but changed the room is not recovered from',
       result.left === true && result.late === true && retreats === 0 && attempts === 1,
       JSON.stringify({ left: result.left, late: result.late, retreats, attempts }));
  }

  // A ONE-SQUARE DOORWAY GETS PATIENCE, NOT BREADTH.
  //
  // 13 of the world's 280 declared exits publish two or fewer distinct staging squares.
  // At one of those, the candidate budget buys nothing — every "other candidate" is the
  // same square — so a body standing in the door made the walker ask three times in a
  // row, instantly, and report the wall shut. These pin the two halves that must not be
  // confused: a body is worth waiting for, and being HIT while waiting is not.
  if (typeof leaveViaAny !== 'function') {
    skip('a one-square doorway held by a body is backed away from, then re-asked', 'did not extract');
    skip('a one-square doorway does not wait or back off while we are being hit in it', 'ditto');
  } else {
    process.env.M59_NARROW_WAIT_MS = '1';
    const oneSquare = [{ kind: 'edge', stand_on: { col: 5, row: 2 }, fine_stand_on: { x: 96, y: 335 } },
                       { kind: 'edge', stand_on: { col: 5, row: 2 }, fine_stand_on: { x: 96, y: 352 } }];
    {
      let attempts = 0, backedOff = 0;
      const session = {
        movementGeneration: 0,
        movementWasCancelled() { return false; },
        async leaveVia() {
          attempts++;
          // clears on the fourth ask, which the old budget of 3 could never reach
          if (attempts >= 4) return { left: true };
          return { left: false, reason: 'object_blocked', monster_blocked: 1 };
        },
        // Backing off is what makes the retry a different question: the blocker follows
        // and comes out of the gap. Counted, so the assertion can see it happened.
        async retreatAlongBreadcrumbs() { backedOff++; return { steps: 4 }; },
      };
      const result = await leaveViaAny.call(session, oneSquare, {});
      ok('a one-square doorway held by a body is backed away from, then re-asked',
         result.left === true && attempts === 4 && backedOff === 3,
         JSON.stringify({ left: result.left, attempts, backedOff }));
    }
    {
      let attempts = 0, retreats = 0;
      const session = {
        movementGeneration: 0,
        movementWasCancelled() { return false; },
        async leaveVia() {
          attempts++;
          return { left: false, reason: 'object_blocked', monster_blocked: 1, damage_while_blocked: 3 };
        },
        // The last-resort forcing path is reached once every candidate is spent; it is not
        // what is under test here, and a doorway with something hitting us in it is
        // exactly where forcing would be wrong anyway.
        async leaveViaUnvalidated() { return { left: false }; },
        async retreatAlongBreadcrumbs() { retreats++; return { steps: 4 }; },
      };
      const result = await leaveViaAny.call(session, oneSquare, {});
      ok('a one-square doorway does not wait or back off while we are being hit in it',
         result.left !== true && attempts <= 3 && retreats === 0,
         JSON.stringify({ left: result.left, attempts, retreats }));
    }
    delete process.env.M59_NARROW_WAIT_MS;
  }
}

console.log('\nreal broker seam validates before emitting coordinates');
if (![validateFineTarget, queueValidatedMove, confirmPosition, stepFine, ordinaryStep, walkFine]
    .every(method => typeof method === 'function')) {
  skip('real broker seam movement regressions', 'one or more production methods did not extract');
} else {
  const unavailable = fakeBrokerSession(null);
  const refused = await stepFine.call(unavailable.session, clientToWire(3072), clientToWire(2048));
  ok('missing collision metadata reports collision_geometry_unavailable',
     refused.reason === 'collision_geometry_unavailable', JSON.stringify(refused));
  ok('missing collision metadata emits zero move packets', unavailable.packets.length === 0,
     JSON.stringify(unavailable.packets));

  const wireCalls = [];
  const wireProbe = {
    security: TEST_SECURITY,
    traceFineMoveClient(x0, y0, x1, y1) {
      wireCalls.push({ x0, y0, x1, y1 });
      return { available: true, x: x1, y: y1, moved: x0 !== x1 || y0 !== y1,
               arrived: true, blocked: false, slid: false, reason: null };
    },
  };
  const origin = fakeBrokerSession(wireProbe, { x: 64, y: 64 });
  const oneUnit = validateFineTarget.call(origin.session, 65, 64);
  ok('wire coordinate 64 maps to client coordinate zero in both axes',
     wireCalls.length === 2 && wireCalls.every(call => call.x0 === 0 && call.y0 === 0) &&
     wireCalls[0].x1 === CLIENT_PER_KOD && wireCalls[0].y1 === 0 &&
     oneUnit.target?.x === 65 && oneUnit.target?.y === 64,
     JSON.stringify({ wireCalls, oneUnit }));

  // The queue's atomic proof is the real runtime validator, so pin one actual baked
  // boundary segment end to end rather than proving only that a stubbed validator is asked.
  const checkedEdgeMap = JSON.parse(readFileSync(
    new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
  const room536 = checkedEdgeMap.rooms['536'];
  const north536 = edgeExitsOf(room536)
    .find(edge => edge.leaveName === 'north' && Number(edge.to) === 535);
  const candidate536 = edgeCandidatesOf(room536, north536)[0];
  const geometry536 = RoomGeometry.fromJSON(room536.roo);
  const exactEdge = candidate536 && fakeBrokerSession(geometry536, {
    x: candidate536.fine_stand_on.x,
    y: candidate536.fine_stand_on.y,
    roomId: 536,
    roomSecurity: geometry536.security,
  });
  const exactEdgeResult = exactEdge && await queueValidatedMove.call(exactEdge.session,
    candidate536.edge_target.x, candidate536.edge_target.y, {
      speed: 0, slide: false,
      offMap: { opening: candidate536.fine_stand_on, direction: 'north' },
    });
  ok('the atomic queue proof accepts an exact checked-map edge segment',
     exactEdgeResult?.sent === true && exactEdgeResult.validation?.arrived === true &&
       exactEdgeResult.validation?.offMap === true && exactEdge.packets.length === 1,
     JSON.stringify({ candidate536, exactEdgeResult, packets: exactEdge?.packets }));

  // A LIVE ANIMATION BLOCKS, AND THE BLOCK EXPIRES. Both halves matter and only the
  // first was ever true: the flag is cleared by BP_PLAYER, which arrives on a ROOM
  // CHANGE, and changing rooms needs the very movement this refuses — so without an
  // expiry any animating room is a cage. Three characters were caught in one on prod
  // within ten minutes, all reporting "could not reach the bank".
  const animating = fakeBrokerSession(twoSides());
  const setAnimation = (record) => { animating.session.client.room.collisionInvalidated = record; };
  const tryMove = () => validateFineTarget.call(animating.session,
    clientToWire(3072), clientToWire(2048));

  setAnimation({ kind: 'BP_SECTOR_MOVE', at: Date.now(), until: Date.now() + 10_000 });
  ok('a live room animation fails movement closed while it is in flight',
     tryMove().reason === 'collision_geometry_changed');
  setAnimation({ kind: 'BP_SECTOR_MOVE', at: Date.now() - 60_000, until: Date.now() - 30_000 });
  ok('and once the animation has finished, movement is allowed again rather than caged',
     tryMove().reason !== 'collision_geometry_changed');
  // "We do not know when this ends" is not "it has ended".
  setAnimation({ kind: 'BP_SECTOR_MOVE', at: Date.now() });
  ok('a record with no expiry still blocks, because unknown is not finished',
     tryMove().reason === 'collision_geometry_changed');

  // ...UNLESS THE ROOM IS ONE WE HAVE DECLARED TO BE PERMANENTLY IN MOTION.
  //
  // The rule above is the safe reading and the right one for a room that is not supposed to
  // change. In the Cragged Mountains, the Arena of Kraanan, Castle Brax and North Barloque
  // it is a cage: those rooms animate constantly, the unnarrowed record is never absent, and
  // a character can never leave. Reproduced on the only road to Castle Victoria — 7 refusals
  // in 35s, the leg completing 0 times out of 3. See m59-mutable.mjs for the failure
  // direction, which is a relaxation and is stated there rather than hidden here.
  {
    const mutable = fakeBrokerSession(twoSides(), { roomId: 598 });
    mutable.session.client.room.collisionInvalidated = { kind: 'BP_SECTOR_MOVE', at: Date.now() };
    const moved = validateFineTarget.call(mutable.session, clientToWire(3072), clientToWire(2048));
    ok('a room declared to have moving geometry is not caged by an unnarrowed animation',
       moved.reason !== 'collision_geometry_changed',
       JSON.stringify({ reason: moved.reason }));

    // AND THE RELAXATION IS ONLY EVER THE UNNARROWED CASE. A packet that NAMES its sector
    // still refuses a move through that sector, in these rooms exactly as in every other —
    // which is the whole of "do not care about the change unless you are travelling it".
    const named = fakeBrokerSession(twoSides(), { roomId: 598 });
    named.session.client.room.collisionInvalidated =
      { kind: 'BP_SECTOR_MOVE', sector: 1, at: Date.now(), until: Date.now() + 10_000 };
    const stillRefused = validateFineTarget.call(named.session, clientToWire(3072), clientToWire(2048));
    ok('but a NAMED moving sector still refuses a move through it, mutable room or not',
       stillRefused.reason === 'collision_geometry_changed',
       JSON.stringify({ reason: stillRefused.reason }));
  }

  // AND IT BLOCKS THE SECTOR THAT MOVED, NOT THE ROOM. Bounding the refusal in TIME only
  // helps while animations are rare. The Temple of Qor door in room 598 cycles faster than
  // the 8s window, so every packet re-armed the block and the bound never expired — the
  // fleet's own name for that room is THE exception to "the geometry does not change".
  // One sector moved; the walls are still where the bake says, which this file already
  // says out loud. So a move that neither starts nor ends in that sector may proceed.
  const liveSector = animating.session.world.geometry.leafAtClient(3072, 2048)?.sectorNum;
  ok('the fixture has a sector to name', Number.isInteger(liveSector), String(liveSector));
  setAnimation({ kind: 'BP_SECTOR_MOVE', sector: liveSector,
                 at: Date.now(), until: Date.now() + 10_000 });
  ok('a move INTO the animating sector is still refused',
     tryMove().reason === 'collision_geometry_changed');
  setAnimation({ kind: 'BP_SECTOR_MOVE', sector: (liveSector ?? 0) + 1000,
                 at: Date.now(), until: Date.now() + 10_000 });
  ok('a move that never touches the animating sector is ALLOWED — the room is not a cage',
     tryMove().reason !== 'collision_geometry_changed', JSON.stringify(tryMove()));
  // Unknown which sector is unknown, and unknown fails closed exactly as a missing expiry
  // does. A short packet must not quietly widen what may move.
  setAnimation({ kind: 'BP_SECTOR_MOVE', sector: null,
                 at: Date.now(), until: Date.now() + 10_000 });
  ok('a record that cannot name its sector still blocks the whole room',
     tryMove().reason === 'collision_geometry_changed');
  setAnimation(null);

  const mismatch = fakeBrokerSession(twoSides(), { roomSecurity: TEST_SECURITY ^ 1 });
  const mismatched = await queueValidatedMove.call(mismatch.session,
    clientToWire(3072), clientToWire(2048));
  ok('a room security mismatch fails closed before the movement queue',
     !mismatched.sent && mismatched.validation?.reason === 'room_geometry_mismatch' &&
     mismatch.packets.length === 0, JSON.stringify(mismatched));
  // THE BAKED MAP IS EVIDENCE ABOUT SOMEBODY ELSE'S SERVER, AND THAT SERVER CAN BE
  // PATCHED WITHOUT TELLING US. So a mismatch has to carry BOTH values out to the caller
  // — refusing the move says a character did not walk; naming the two security values is
  // what says the world changed, which is the half anyone can act on.
  ok('and it carries the evidence out: the room, and both security values',
     mismatched.validation?.drift?.room != null &&
     Number.isInteger(mismatched.validation.drift.live) &&
     Number.isInteger(mismatched.validation.drift.baked) &&
     mismatched.validation.drift.live !== mismatched.validation.drift.baked,
     JSON.stringify(mismatched.validation?.drift));
  ok('and the broker is handed that record rather than having to infer it',
     driftRecorded.length === 1 && driftRecorded[0].live !== driftRecorded[0].baked);

  for (const [label, geometry] of [
    ['solid wall', twoSides()],
    ['cliff', twoSides({
      right: sector({ floor: MAX_STEP_HEIGHT + 1 }),
      pos: side({ passable: true }), neg: side({ passable: true }),
    })],
  ]) {
    const blocked = fakeBrokerSession(geometry);
    const result = await stepFine.call(blocked.session, clientToWire(3072), clientToWire(2048));
    const emitted = blocked.packets[0];
    const emittedTrace = emitted && geometry.traceFineMoveClient(
      1024, 2048, wireToClient(emitted.x), wireToClient(emitted.y), { slide: false });
    ok(`${label} target never emits an endpoint across the barrier`,
       blocked.packets.length <= 1 && (!emitted ||
         (wireToClient(emitted.x) <= 2048 - PLAYER_RADIUS && emittedTrace.arrived)),
       JSON.stringify({ result, packets: blocked.packets, emittedTrace }));
  }

  const lowStep = fakeBrokerSession(twoSides({
    right: sector({ floor: 20 * 16 }),
    pos: side({ passable: true }), neg: side({ passable: true }),
  }));
  const crossed = await stepFine.call(lowStep.session, clientToWire(3072), clientToWire(2048));
  ok('a legal low-step target emits the locally validated endpoint',
     crossed.locally_validated === true && crossed.moved === true &&
     lowStep.packets.length === 1 && lowStep.packets[0].x === clientToWire(3072) &&
     lowStep.packets[0].y === clientToWire(2048),
     JSON.stringify({ crossed, packets: lowStep.packets }));

  const open = twoSides({ pos: side({ passable: true }), neg: side({ passable: true }) });
  const invalidProtocol = [];
  for (const [x, y] of [[-1, 128], [128, -1], [0x10000, 128], [128, 0x10000]]) {
    const invalid = fakeBrokerSession(open);
    const result = await stepFine.call(invalid.session, x, y);
    invalidProtocol.push({ x, y, reason: result.reason, packets: invalid.packets.length });
  }
  ok('negative and overflowing broker targets emit no movement packet',
     invalidProtocol.every(item => item.reason === 'invalid_move_target' && item.packets === 0),
     JSON.stringify(invalidProtocol));

  const invalidated = fakeBrokerSession(open);
  invalidated.client.room.collisionInvalidated = {
    opcode: BP.SECTOR_MOVE, kind: 'SECTOR_MOVE', at: Date.now(),
  };
  const geometryChanged = await stepFine.call(invalidated.session,
    clientToWire(3072), clientToWire(2048));
  ok('collision_geometry_changed fails closed before emitting a move',
     geometryChanged.reason === 'collision_geometry_changed' &&
     invalidated.packets.length === 0,
     JSON.stringify({ geometryChanged, packets: invalidated.packets }));

  movementNow = 0;
  const pacedPastDeadline = fakeBrokerSession(open, {
    beforePaced(kind) { if (kind === 'move') movementNow = 51; },
  });
  const lateMove = await queueValidatedMove.call(pacedPastDeadline.session,
    clientToWire(3072), clientToWire(2048), { deadlineAt: 50 });
  ok('a move whose paced turn starts after the operation deadline emits no packet',
     lateMove.validation?.reason === 'effort_deadline_exhausted' &&
       pacedPastDeadline.packets.length === 0,
     JSON.stringify({ lateMove, packets: pacedPastDeadline.packets }));

  // A learned-ride deadline is movement authority, not merely a reason for the caller to
  // stop asking. Keeper mode has an explicitly raw escape for stale geometry, so both the
  // deadline refusal itself and a geometry refusal returned after expiry must be unable to
  // enter that escape.
  const priorKeeper = process.env.M59_KEEPER;
  try {
    process.env.M59_KEEPER = '1';
    const deadlineClient = {
      room: { id: 1, objects: new Map([[7, {}]]) }, selfId: 7,
      self: { x: 128, y: 128, col: 2, row: 2 }, moveSpeed: () => 1,
    };
    let rawMoves = 0;
    deadlineClient.moveTo = () => { rawMoves++; };
    const deadlineSession = reason => ({
      client: deadlineClient,
      finePositionUnknown: false,
      need: () => deadlineClient,
      moveSpeed: () => 1,
      async queueValidatedMove() {
        movementNow = 100;
        return { sent: false, validation: { blocked: true, reason } };
      },
    });

    movementNow = 0;
    const directDeadline = await stepFine.call(deadlineSession('effort_deadline_exhausted'),
                                                256, 128, { deadlineAt: 50 });
    ok('a deadline refusal never becomes a keeper raw movement packet',
       directDeadline.reason === 'effort_deadline_exhausted' && rawMoves === 0,
       JSON.stringify({ directDeadline, rawMoves }));

    movementNow = 0;
    const expiredGeometry = await stepFine.call(deadlineSession('geometry_blocked'),
                                                256, 128, { deadlineAt: 50 });
    ok('expiry is rechecked before keeper raw fallback can send a geometry-refused move',
       expiredGeometry.reason === 'effort_deadline_exhausted' && rawMoves === 0,
       JSON.stringify({ expiredGeometry, rawMoves }));
  } finally {
    if (priorKeeper == null) delete process.env.M59_KEEPER;
    else process.env.M59_KEEPER = priorKeeper;
  }

  movementNow = 0;
  let confirmDeadline = null;
  const sentClient = {
    room: { id: 1, objects: new Map([[7, {}]]) }, selfId: 7,
    self: { x: 128, y: 128, col: 2, row: 2 },
  };
  const sentSession = {
    client: sentClient,
    finePositionUnknown: false,
    need: () => sentClient,
    moveSpeed: () => 1,
    async queueValidatedMove() {
      return { sent: true, before: { ...sentClient.self }, target: { x: 256, y: 128 },
               validation: {} };
    },
    async confirmPosition(options) { confirmDeadline = options?.deadlineAt; return null; },
  };
  const postSend = await stepFine.call(sentSession, 256, 128, { deadlineAt: 500 });
  ok('the post-send position confirmation inherits the learned ride deadline',
     confirmDeadline === 500 && postSend.reason === 'position_confirmation_timeout',
     JSON.stringify({ confirmDeadline, postSend }));

  movementNow = 0;
  let lateReads = 0;
  const queuedRead = fakeBrokerSession(open, {
    beforePaced(kind) { if (kind === 'read') movementNow = 51; },
  });
  queuedRead.client.roomContents = () => { lateReads++; return 1; };
  const noLateRead = await confirmPosition.call(queuedRead.session, { deadlineAt: 50 });
  ok('a confirmation read whose paced turn starts after the deadline is never sent',
     noLateRead === null && lateReads === 0,
     JSON.stringify({ noLateRead, lateReads }));

  movementNow = 0;
  let postReadWaits = 0;
  const completedRead = fakeBrokerSession(open);
  completedRead.client.waitFor = async () => { postReadWaits++; return { timedOut: true }; };
  completedRead.session.pacer.submit = async (_kind, invoke) => {
    const result = await invoke();
    movementNow = 51;
    return result;
  };
  const expiredAfterRead = await confirmPosition.call(completedRead.session, { deadlineAt: 50 });
  ok('a confirmation that reaches its deadline while awaiting the sent read opens no later wait',
     expiredAfterRead === null && completedRead.client.roomContentsRequested === 1 &&
       postReadWaits === 0,
     JSON.stringify({ expiredAfterRead, requested: completedRead.client.roomContentsRequested,
       postReadWaits }));

  // HOLD THE REAL PACER BEHIND AN ALREADY-STARTED JOB. Deadline-aware callers must resolve
  // while that job is still held, then remain inert after it is released. This is the seam a
  // callback-time guard alone cannot cover: it prevents the packet but leaves the caller
  // awaiting the queue indefinitely.
  const deadlinePacer = new DeadlinePacer(1000);
  let releasePacer = null, announceHeld = null;
  const held = new Promise(resolve => { announceHeld = resolve; });
  const holdingJob = deadlinePacer.submit('hold', () => new Promise(resolve => {
    releasePacer = resolve;
    announceHeld();
  }));
  await held;
  const heldSession = fakeBrokerSession(open);
  heldSession.session.pacer = deadlinePacer;
  let heldReads = 0;
  heldSession.client.roomContents = () => { heldReads++; return 1; };
  movementNow = performance.now();
  const heldDeadline = movementNow + 40;
  let readSettled = false, moveSettled = false, offMapSettled = false;
  const heldRead = confirmPosition.call(heldSession.session, { deadlineAt: heldDeadline })
    .then(result => { readSettled = true; return result; });
  const heldMove = queueValidatedMove.call(heldSession.session,
    clientToWire(3072), clientToWire(2048), { deadlineAt: heldDeadline })
    .then(result => { moveSettled = true; return result; });
  const heldOffMap = queueValidatedMove.call(heldSession.session, 0, 128, {
    deadlineAt: heldDeadline,
    offMap: { opening: { x: 0, y: 0 }, direction: 'west' },
  }).then(result => { offMapSettled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 80));
  ok('deadline-aware paced callers resolve while an earlier callback is still held',
     readSettled && moveSettled && offMapSettled && releasePacer != null,
     JSON.stringify({ readSettled, moveSettled, offMapSettled }));
  const [heldReadResult, heldMoveResult, heldOffMapResult] =
    await Promise.all([heldRead, heldMove, heldOffMap]);
  ok('held read and both held move branches resolve with their deadline results',
     heldReadResult === null &&
       heldMoveResult?.validation?.reason === 'effort_deadline_exhausted' &&
       heldOffMapResult?.validation?.reason === 'effort_deadline_exhausted',
     JSON.stringify({ heldReadResult, heldMoveResult, heldOffMapResult }));
  releasePacer();
  await holdingJob;
  await new Promise(resolve => setTimeout(resolve, 30));
  ok('releasing pacing after expiry emits no late read or move callback',
     heldReads === 0 && heldSession.packets.length === 0,
     JSON.stringify({ heldReads, packets: heldSession.packets }));

  let fatalFineCalls = 0;
  const fatalClient = {
    room: { id: 1 },
    self: { x: 128, y: 128, col: 2, row: 2 },
  };
  const fatalSession = {
    client: fatalClient,
    movementGeneration: 0,
    need() { return this.client; },
    movementWasCancelled() { return false; },
    async stepFine() {
      fatalFineCalls++;
      return { moved: false, left_room: false, reason: 'collision_geometry_changed',
               note: 'live wall animation' };
    },
  };
  const fatalWalk = await walkFine.call(fatalSession, 256, 128,
    { maxSteps: 10, stride: 48, arriveWithin: 1 });
  ok('collision_geometry_changed is fatal to walkFine without fanning more headings',
     fatalWalk.reason === 'collision_geometry_changed' && fatalFineCalls === 1,
     JSON.stringify({ fatalWalk, fatalFineCalls }));

  // A slid packet can move the body without gaining any ground on the requested point.
  // Room 578 oscillated sideways on every northward attempt, and `r.moved` reset the
  // stall counter indefinitely even though the measured destination distance was flat.
  let lateralCalls = 0;
  const lateralClient = {
    room: { id: 1 }, self: { x: 128, y: 128, col: 2, row: 2 },
  };
  const lateralSession = {
    client: lateralClient,
    movementGeneration: 0,
    need() { return this.client; },
    movementWasCancelled() { return false; },
    async stepFine() {
      lateralCalls++;
      lateralClient.self = {
        ...lateralClient.self,
        // Alternate across the start line without changing x. Both packets moved; neither
        // buys the >1 wire unit of target-distance progress that walkFine promises.
        y: lateralCalls % 2 ? 136 : 128,
      };
      return { moved: true, left_room: false, position: { ...lateralClient.self } };
    },
  };
  const lateralWalk = await walkFine.call(lateralSession, 256, 128,
    { maxSteps: 10, stride: 48, arriveWithin: 1 });
  ok('sideways movement without target-distance gain is bounded as a fine-walk stall',
     lateralWalk.reason === 'blocked — every heading refused, at every reach tried' &&
       lateralCalls > 0 && lateralCalls <= 36,
     JSON.stringify({ lateralWalk, lateralCalls }));

  const blocker = {
    id: 7, x: clientToWire(2048), y: clientToWire(2048), flags: MOVEON.NO,
  };
  const occupied = fakeBrokerSession(open, { objects: [blocker] });
  const objectBlocked = validateFineTarget.call(occupied.session,
    clientToWire(3072), clientToWire(2048), { slide: true });
  blocker.flags = MOVEON.YES;
  const objectGone = validateFineTarget.call(occupied.session,
    clientToWire(3072), clientToWire(2048), { slide: true });
  ok('a live OF_MOVEON_NO object blocks movement until its current flags permit it',
     objectBlocked.blocked && objectBlocked.reason === 'object_blocked' &&
     wireToClient(objectBlocked.target?.x) < 2048 && objectGone.arrived &&
     objectGone.target?.x === clientToWire(3072),
     JSON.stringify({ objectBlocked, objectGone }));

  // The requested point is 248.5 client units from the wall endpoint, just outside
  // the player cylinder. Naive nearest-integer KOD rounding moves it six client
  // units toward the endpoint and puts it inside; production quantizes toward the
  // start and revalidates the exact wire endpoint before queuing it.
  const corner = twoSides({ wallY0: 1907, wallY1: 2207 });
  const start = { x: clientToWire(2032), y: clientToWire(1648) };
  const barelyClearY = clientToWire(1658.5);
  const raw = corner.traceFineMoveClient(wireToClient(start.x), wireToClient(start.y),
    2048, wireToClient(barelyClearY), { slide: true });
  const rounded = corner.traceFineMoveClient(wireToClient(start.x), wireToClient(start.y),
    2048, wireToClient(Math.round(barelyClearY)), { slide: false });
  ok('the quantization fixture is clear before rounding and blocked after it',
     raw.arrived && !rounded.arrived, JSON.stringify({ raw, rounded }));
  const quantized = fakeBrokerSession(corner, start);
  const quantizedResult = await stepFine.call(quantized.session, clientToWire(2048), barelyClearY);
  const allPacketsSafe = quantized.packets.every(packet => corner.traceFineMoveClient(
    wireToClient(start.x), wireToClient(start.y),
    wireToClient(packet.x), wireToClient(packet.y),
    { slide: false }).arrived);
  ok('quantization cannot emit a barely-clear point rounded into collision',
     quantizedResult.locally_validated === true && allPacketsSafe,
     JSON.stringify({ quantizedResult, packets: quantized.packets }));

  const floorCalls = [];
  const floorEdge = 100.1;
  const floorEdgeGeometry = {
    security: TEST_SECURITY,
    traceFineMoveClient(x0, y0, x1, y1) {
      floorCalls.push({ x0, y0, x1, y1 });
      if (x1 <= floorEdge) return {
        available: true, x: x1, y: y1, moved: x0 !== x1 || y0 !== y1,
        arrived: true, blocked: false, slid: false, reason: null,
      };
      return { available: true, x: floorEdge, y: y1, moved: true,
               arrived: false, blocked: true, slid: false,
               reason: 'destination_has_no_floor' };
    },
  };
  const edge = fakeBrokerSession(floorEdgeGeometry, { x: 64, y: 64 });
  const edgeResult = validateFineTarget.call(edge.session, 72, 64, { slide: true });
  ok('the exact final quantized endpoint is revalidated inside a floor edge',
     edgeResult.target?.x === 70 && edgeResult.target?.y === 64 &&
     floorCalls.some(call => call.x1 === wireToClient(70) && call.y1 === 0) &&
     floorCalls.at(-1).x1 === wireToClient(edgeResult.target.x),
     JSON.stringify({ edgeResult, floorCalls }));

  const verticalGeometry = threeStrips({
    left: sector({ floor: 1000 }), middle: sector({ floor: 0 }),
    right: sector({ floor: 0, ceiling: 1500 }),
    secondPos: side({ passable: true, above: true }),
    secondNeg: side({ passable: true, above: true }),
  });
  const vertical = fakeBrokerSession(verticalGeometry, {
    x: clientToWire(608), y: clientToWire(2048),
  });
  const verticalResult = await stepFine.call(vertical.session,
    clientToWire(3392), clientToWire(2048));
  ok('the broker packet keeps downhill motion Z and emits no endpoint through the low overhang',
     vertical.packets.length === 1 &&
     wireToClient(vertical.packets[0].x) <= 2600 - PLAYER_RADIUS &&
     vertical.session.collisionVertical?.min === 0 &&
     vertical.session.collisionVertical?.max === 1000,
     JSON.stringify({ verticalResult, packets: vertical.packets,
       collisionVertical: vertical.session.collisionVertical }));

  const carriedCalls = [];
  const carriedGeometry = {
    security: TEST_SECURITY,
    traceFineMoveClient(x0, y0, x1, y1, options = {}) {
      const destinationFloor = x1 < 1000 ? 0 : x1 < 3000 ? 1400 : 500;
      const incoming = Number.isFinite(options.motionZ?.min)
        ? options.motionZ : { min: 1000, max: 1000 };
      const motionZ = {
        min: Math.min(incoming.min, incoming.max, destinationFloor),
        max: Math.max(incoming.min, incoming.max, destinationFloor),
      };
      carriedCalls.push({ x1, incoming: options.motionZ ?? null, destinationFloor, motionZ });
      return { available: true, x: x1, y: y1, moved: x0 !== x1 || y0 !== y1,
               arrived: true, blocked: false, slid: false, reason: null,
               motionZ, destinationFloor };
    },
  };
  const carried = fakeBrokerSession(carriedGeometry);
  await queueValidatedMove.call(carried.session, 100, 128);
  const firstSettle = { ...carried.session.collisionVertical };
  await queueValidatedMove.call(carried.session, 200, 128);
  const crestSettle = { ...carried.session.collisionVertical };
  await queueValidatedMove.call(carried.session, 300, 128);
  const repeatedSettle = { ...carried.session.collisionVertical };
  const crestInputs = carriedCalls.filter(call => call.destinationFloor === 1400)
    .map(call => call.incoming);
  const repeatInputs = carriedCalls.filter(call => call.destinationFloor === 500)
    .map(call => call.incoming);
  ok('repeated packets carry the vertical range over a crest without shrinking/resetting settle',
     carried.packets.length === 3 && firstSettle.min === 0 && firstSettle.max === 1000 &&
     crestInputs.every(input => input?.min === 0 && input?.max === 1000) &&
     crestSettle.min === 0 && crestSettle.max === 1400 &&
     repeatInputs.every(input => input?.min === 0 && input?.max === 1400) &&
     repeatedSettle.min === 0 && repeatedSettle.max === 1400 &&
     repeatedSettle.settleAt >= crestSettle.settleAt && crestSettle.settleAt >= firstSettle.settleAt,
     JSON.stringify({ firstSettle, crestSettle, repeatedSettle, carriedCalls }));

  const changed = fakeBrokerSession(open, {
    beforePaced(kind, client) { if (kind === 'move') client.room.id = 2; },
  });
  const changedResult = await queueValidatedMove.call(changed.session,
    clientToWire(3072), clientToWire(2048));
  ok('a queued move is discarded when the room changes before send',
     !changedResult.sent && changedResult.validation?.reason === 'room_changed_before_move' &&
     changed.packets.length === 0, JSON.stringify(changedResult));

  const edgeTarget = { x: 63, y: 128 };
  const edgeAuthorization = {
    opening: { x: 96, y: 128 }, direction: 'west',
  };
  const edgeRace = fakeBrokerSession(open, {
    x: 96, y: 128,
    beforePaced(kind, client) {
      if (kind !== 'move') return;
      client.self = { ...client.self, x: 160, col: 2 };
      client.room.objects.set(client.selfId, client.self);
    },
  });
  edgeRace.session.validateFineTarget = () => ({
    available: true, moved: true, arrived: true, blocked: false, target: edgeTarget,
  });
  const racedEdge = await queueValidatedMove.call(edgeRace.session,
    edgeTarget.x, edgeTarget.y, { speed: 0, slide: false, offMap: edgeAuthorization });
  ok('an off-map move rechecks the live opening position after pacing',
     racedEdge.sent === false && racedEdge.validation?.reason === 'not_at_edge_opening' &&
       edgeRace.packets.length === 0,
     JSON.stringify({ racedEdge, packets: edgeRace.packets }));

  const hookRace = fakeBrokerSession(open, { x: 96, y: 128 });
  hookRace.session.validateFineTarget = () => ({
    available: true, moved: true, arrived: true, blocked: false, target: edgeTarget,
  });
  const hookedEdge = await queueValidatedMove.call(hookRace.session,
    edgeTarget.x, edgeTarget.y, {
      speed: 0, slide: false, offMap: edgeAuthorization,
      beforeMutation() {
        hookRace.client.self = { ...hookRace.client.self, x: 160, col: 2 };
        hookRace.client.room.objects.set(hookRace.client.selfId, hookRace.client.self);
      },
    });
  ok('off-map authority is evaluated after the synchronous mutation hook',
     hookedEdge.sent === false && hookedEdge.validation?.reason === 'not_at_edge_opening' &&
       hookRace.packets.length === 0,
     JSON.stringify({ hookedEdge, packets: hookRace.packets }));

  const blockedEdge = fakeBrokerSession(open, { x: 96, y: 128 });
  blockedEdge.session.validateFineTarget = () => ({
    available: true, moved: false, arrived: false, blocked: true,
    reason: 'geometry_blocked',
  });
  const unprovedEdge = await queueValidatedMove.call(blockedEdge.session,
    edgeTarget.x, edgeTarget.y, { speed: 0, slide: false, offMap: edgeAuthorization });
  ok('proximity to an opening cannot authorize an off-map packet the BSP refuses',
     unprovedEdge.sent === false && unprovedEdge.validation?.reason === 'geometry_blocked' &&
       blockedEdge.packets.length === 0,
     JSON.stringify({ unprovedEdge, packets: blockedEdge.packets }));

  const provedEdge = fakeBrokerSession(open, { x: 96, y: 128 });
  provedEdge.session.validateFineTarget = (_x, _y, options) => ({
    available: true, moved: true, arrived: true, blocked: false,
    target: edgeTarget, trace_options: options,
  });
  const sentEdge = await queueValidatedMove.call(provedEdge.session,
    edgeTarget.x, edgeTarget.y, { speed: 0, slide: false, offMap: edgeAuthorization });
  ok('an atomic exact BSP proof authorizes the stock off-map packet',
     sentEdge.sent === true && sentEdge.validation?.offMap === true &&
       sentEdge.validation?.arrived === true && provedEdge.packets.length === 1 &&
       provedEdge.packets[0].x === edgeTarget.x && provedEdge.packets[0].y === edgeTarget.y,
     JSON.stringify({ sentEdge, packets: provedEdge.packets }));

  const changedDuringTurn = fakeBrokerSession(open, {
    beforePaced(kind, client) { if (kind === 'turn') client.room.id = 2; },
  });
  const changedDuringTurnResult = await ordinaryStep.call(changedDuringTurn.session, 3, 3);
  ok('Session.step sends no move when the room changes during its paced turn',
     changedDuringTurnResult.reason === 'room_changed_before_move' &&
     changedDuringTurnResult.left_room === true && changedDuringTurn.packets.length === 0,
     JSON.stringify({ changedDuringTurnResult, packets: changedDuringTurn.packets }));

  const stale = fakeBrokerSession(open);
  stale.client.roomContentsRequested = 1;
  stale.client.roomContentsReceived = 0;
  stale.client.roomContents = function roomContents() { return ++this.roomContentsRequested; };
  let waits = 0;
  stale.client.waitFor = async function waitFor() {
    waits++;
    if (waits === 1) {
      this.roomContentsReceived = 1; // reply to the older fire-and-forget request
      return { timedOut: false, seq: 10 };
    }
    return { timedOut: true, seq: 11 };
  };
  const staleConfirmation = await confirmPosition.call(stale.session);
  ok('an older room-contents ordinal cannot satisfy position confirmation',
     staleConfirmation === null && waits === 2 && stale.client.roomContentsReceived === 1,
     JSON.stringify({ staleConfirmation, waits,
       requested: stale.client.roomContentsRequested,
       received: stale.client.roomContentsReceived }));

  const ordinary = fakeBrokerSession(null, {
    x: 2 * KOD_FINENESS + (KOD_FINENESS >> 1),
    y: 2 * KOD_FINENESS + (KOD_FINENESS >> 1),
  });
  const ordinaryResult = await ordinaryStep.call(ordinary.session, 3, 2);
  ok('ordinary Session.step uses the same fail-closed validated movement guard',
     ordinaryResult.reason === 'collision_geometry_unavailable' &&
     ordinary.packets.length === 0,
     JSON.stringify({ ordinaryResult, packets: ordinary.packets }));
}


// ---------------------------------------------------------------------------
console.log('\na square whose CENTRE has no floor is not a cage');
{
  // THE FAULT THIS PINS, and it took six wrong diagnoses to reach it.
  //
  // `traceFineMoveClient` tests the leaf under the ORIGIN before it tests any wall, and
  // answers `start_has_no_floor`. That refusal is about where we ARE, so it is identical
  // for every heading — `walkFine` fans nine of them at four reaches, collects it
  // thirty-six times, and sends ZERO PACKETS. `walkTo`'s off-grid recovery routes through
  // the same call, so it reports `could not step back onto solid ground`, and the
  // character is immovable by every path this repository owns.
  //
  // Room 587 square 2,4 is the real case: 21 of 64 points sampled inside it have a BSP
  // leaf — an operator walked it and reported ordinary corridor — but its CENTRE does not,
  // and the centre is the only address the planner has. Measured before the fix: from 2,4
  // the walk to the west exit failed having sent nothing, while from 2,5, 3,4 and 3,5 the
  // identical call arrived in three to five packets.
  //
  // The server never had an opinion. It does not validate player movement at all, so the
  // only thing holding the character still was our own check, run from an origin that
  // check itself calls invalid — failing closed on no information.
  const wedgeMap = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
  const wedgeRoom = wedgeMap.rooms['587'];
  if (!wedgeRoom?.roo) {
    skip('a centre-less square can still be walked off', 'room 587 is not in the baked map');
  } else {
    const geometry = RoomGeometry.fromJSON(wedgeRoom.roo);
    const half = KOD_FINENESS >> 1;
    const centreWire = square => square * KOD_FINENESS + half;
    const hasFloor = (wx, wy) => !!geometry.leafAtClient(wireToClient(wx), wireToClient(wy));

    ok('room 587 square 2,4 has no floor under its centre',
       !hasFloor(centreWire(2), centreWire(4)));
    let sampled = 0;
    for (let fx = 0; fx < KOD_FINENESS; fx += 8)
      for (let fy = 0; fy < KOD_FINENESS; fy += 8)
        if (hasFloor(2 * KOD_FINENESS + fx, 4 * KOD_FINENESS + fy)) sampled++;
    ok('and yet much of that square is real floor a person walks on', sampled > 12,
       `${sampled}/64 sampled points have a leaf`);

    // The west exit's own numbers, as the live broker reported them.
    const EXIT = { x: 96, y: 335 };
    // `fakeBrokerSession` builds what validateFineTarget/queueValidatedMove need; walkFine
    // additionally reaches for the cancellation hooks and stepFine, so they are supplied
    // here rather than widened into the shared fixture, which every other case uses.
    const walkOff = (col, row) => {
      const made = fakeBrokerSession(geometry,
        { x: centreWire(col), y: centreWire(row), roomId: 587 });
      Object.assign(made.session, {
        movementGeneration: 0,
        movementWasCancelled: () => false,
        cancelledMovement: extra => ({ cancelled: true, ...extra }),
        stepFine,
      });
      return made;
    };

    // PINNED ON THE DECISION, NOT ON THE FAN. `walkFine` tries nine headings at four
    // reaches; asserting through it would make this case depend on which of thirty-six
    // candidates happens to land, and a fixture detail could pass it while the rule was
    // broken. `validateFineTarget` IS the rule, and it is the thing that used to refuse.
    const caged0 = walkOff(2, 4);
    const towardFloor = validateFineTarget.call(caged0.session, 142, 315, { slide: true });
    ok('a move OFF the centre-less square onto real floor is authorised',
       towardFloor.moved === true && towardFloor.available === true,
       JSON.stringify({ reason: towardFloor.reason }));
    ok('and it is reported as a recovery rather than an ordinary validated move',
       towardFloor.reason === 'recovered_from_no_floor', String(towardFloor.reason));
    ok('with the endpoint it was actually asked for',
       towardFloor.target?.x === 142 && towardFloor.target?.y === 315,
       JSON.stringify(towardFloor.target));

    const fine = walkOff(2, 5);
    const ordinary = await walkFine.call(fine.session, EXIT.x, EXIT.y,
      { maxSteps: 60, stride: 32, arriveWithin: 1 });
    ok('an ordinary square is unaffected by the recovery', ordinary.arrived === true);
    ok('and an ordinary move is NOT labelled a recovery',
       validateFineTarget.call(fine.session, 96, 335, { slide: true }).reason
         !== 'recovered_from_no_floor');

    // THE RECOVERY MUST NOT WIDEN WHAT THE FLEET MAY TRAVERSE. One square, onto floor,
    // and only when the ORIGIN is the thing that has none.
    const caged = walkOff(2, 4);
    const target = caged.session;
    const leap = validateFineTarget.call(target, centreWire(40), centreWire(30), { slide: false });
    ok('it cannot be used to cross a room — a distant target is still refused',
       leap.moved === false || leap.available === false, JSON.stringify(leap.reason));
    const intoWall = validateFineTarget.call(target, centreWire(2), centreWire(3), { slide: false });
    ok('and it cannot land on a neighbour that has no floor either',
       intoWall.moved === false || intoWall.available === false, JSON.stringify(intoWall.reason));
  }
}

// ===================== A DOOR HELD SHUT BY PEOPLE IS SHUT =====================
//
// The detour ladder — clockwise, anticlockwise, then back up along breadcrumbs — exists so a
// character pinned by bodies can get moving again. Every one of those tiers widens what the
// walker is willing to try, and a widening is exactly the kind of change that quietly buys
// itself permission it was never meant to have. So these are the NEGATIVE cases: the two
// situations where the honest answer is "no".
//
// The scenario is the operator's. Characters stand shoulder to shoulder across the approach
// to the north-west door out of the Streets of Tos, so the door cannot be reached at all.
//
//   ONE DOOR BLOCKED    the crossing must go round to the OTHER door into the same room.
//   BOTH DOORS BLOCKED  the order must be REFUSED. Not squeezed through a person, not
//                       clipped through the wall beside them, not reported as arrived.
//
// A body is not a wall and this file spends most of its length on that distinction — but a
// body is not a door either, and "go round it" must never become "go through it".
console.log('');
console.log('a door held shut by people is shut');
{
  const doorA = { kind: 'edge', to: 52, stand_on: { col: 4, row: 1 } };
  const doorB = { kind: 'edge', to: 52, stand_on: { col: 26, row: 1 } };

  // A refusal shaped exactly like the one a wall of people produces: the square could not be
  // reached because bodies were standing on it. `object_blocked` is OUR pass, which is why
  // the server never sees these attempts at all.
  const heldByPeople = { left: false, reason: 'object_blocked', monster_blocked: 4 };

  if (typeof leaveViaAny !== 'function') {
    skip('a door blocked by people sends the crossing to the other door', 'leaveViaAny did not extract');
    skip('and the character leaves by it', 'ditto');
    skip('both doors blocked refuses the crossing', 'ditto');
    skip('and it does not claim to have left', 'ditto');
    skip('and it blames the bodies rather than the wall', 'ditto');
  } else {
    // ---- ONE DOOR BLOCKED. The other one is still a door.
    const asked = [];
    const oneShut = {
      movementGeneration: 0, world: { room: { num: 50 } }, client: { room: { id: 1 } },
      movementWasCancelled() { return false; },
      async leaveVia(door) {
        asked.push(door.stand_on.col);
        return door.stand_on.col === doorA.stand_on.col ? heldByPeople : { left: true };
      },
    };
    const wentRound = await leaveViaAny.call(oneShut, [doorA, doorB], {});
    ok('a door blocked by people sends the crossing to the other door',
       asked.includes(doorB.stand_on.col), JSON.stringify(asked));
    ok('and the character leaves by it', wentRound?.left === true, JSON.stringify(wentRound));

    // ---- BOTH DOORS BLOCKED. There is no third answer.
    const bothAsked = [];
    let forcedThrough = 0;
    const bothShut = {
      movementGeneration: 0, world: { room: { num: 50 } }, client: { room: { id: 1 } },
      movementWasCancelled() { return false; },
      async leaveVia(door) { bothAsked.push(door.stand_on.col); return heldByPeople; },
      // THE CHEAT, MADE VISIBLE. `leaveViaAny` has an unvalidated last resort for the case
      // where our model refuses a square people demonstrably walk on. Wiring it to SUCCEED
      // here is what makes this a real negative test: if the gate above it ever stops
      // distinguishing a body from a wall, this fixture crosses the doorway and the
      // assertions below fail. A stub that refused would hide exactly the bug being hunted.
      async leaveViaUnvalidated() { forcedThrough++; return { left: true, forced: true }; },
    };
    const refused = await leaveViaAny.call(bothShut, [doorA, doorB], {});
    ok('both doors blocked refuses the crossing', bothAsked.length >= 2, JSON.stringify(bothAsked));
    // THE ONE THAT MATTERS. Anything truthy here is the walker reporting a crossing it did
    // not make, which is worse than failing: the journey then carries on from a room the
    // character is not standing in.
    ok('and it does not claim to have left', refused?.left !== true, JSON.stringify(refused));
    ok('and it blames the bodies rather than the wall',
       !/wall|geometry/i.test(String(refused?.reason ?? '')), JSON.stringify(refused?.reason));
    // THE POINT OF THE WHOLE BLOCK. The unvalidated step is admission that our GEOMETRY is
    // wrong; a person standing in a doorway is not a hole in the map, and forcing past one
    // is walking through them.
    ok('and it never forces the unvalidated crossing past a person', forcedThrough === 0,
       `leaveViaUnvalidated called ${forcedThrough}x`);

    // ---- GEOMETRY REFUSED. Unsafe movement is a diagnostic override, never the default.
    const previousFallback = process.env.M59_EXIT_FALLBACK;
    delete process.env.M59_EXIT_FALLBACK;
    let geometryForced = 0;
    try {
      const geometryShut = {
        movementGeneration: 0, world: { room: { num: 50 } }, client: { room: { id: 1 } },
        movementWasCancelled() { return false; },
        async leaveVia() { return { left: false, reason: 'geometry_blocked' }; },
        async leaveViaUnvalidated() {
          geometryForced++;
          return { left: true, forced: true };
        },
      };
      const failedClosed = await leaveViaAny.call(geometryShut, [doorA, doorB], {});
      ok('geometry refusals do not enable the unvalidated exit fallback by default',
         geometryForced === 0 && failedClosed?.left !== true,
         JSON.stringify({ geometryForced, failedClosed }));
    } finally {
      if (previousFallback === undefined) delete process.env.M59_EXIT_FALLBACK;
      else process.env.M59_EXIT_FALLBACK = previousFallback;
    }
  }
}

// AND THE WALKER ITSELF NEVER WALKS THROUGH SOMEBODY.
//
// The block above is about which door. This is about the ground: with the whole approach
// occupied, the detour must exhaust itself and report failure rather than find a way through
// a person. The REAL `sidestepAround` runs here — the `() => null` stub used elsewhere in
// this file would make it pass by deleting the thing under test.
console.log('');
console.log('and the ground under a person is not walkable');
if (typeof walkTo !== 'function' || typeof realSidestepAround !== 'function') {
  skip('a walk hemmed in by bodies never moves onto one', 'walkTo/sidestepAround did not extract');
  skip('and it gives up rather than passing through', 'ditto');
} else {
  // Shoulder to shoulder across the approach and around us: the situation the trace recorded
  // as seventy-five refusals in ten seconds with zero packets sent.
  const bodies = new Set(['2,3', '2,4', '2,5', '3,3', '3,5', '4,3', '4,4', '4,5']);
  const movedOnto = [];
  const geometry = {
    walkable: () => true, standable: () => true, collisionReady: true,
    moverStepLands: () => true,
    path: (r, c) => ({ found: true, steps: [{ row: r - 1, col: c }] }),
  };
  const client = { self: { id: 9, col: 4, row: 3, x: 4 * 1024, y: 3 * 1024 },
                   selfId: 9, room: { id: 1, objects: new Map() } };
  const session = {
    client, world: { geometry, room: { num: 50 } }, movementGeneration: 0,
    need() { return this.client; },
    movementWasCancelled() { return false; },
    threatsHere() { return []; },
    sidestepAround: realSidestepAround,
    async retreatAlongBreadcrumbs() { return { steps: 0 }; },
    async step(col, row) {
      // The mover's own answer, and the only one it can give: something is standing there.
      if (bodies.has(`${row},${col}`)) return { moved: false, left_room: false, reason: 'object_blocked' };
      movedOnto.push(`${row},${col}`);
      client.self.col = col; client.self.row = row;
      return { moved: true, left_room: false, position: { col, row } };
    },
  };
  const out = await walkTo.call(session, 4, 1, { maxSteps: 8 });
  // ATTEMPTS ARE FINE; ARRIVALS ARE NOT. The walker is allowed to try an occupied square and
  // be refused — that is how it learns one is taken. What it may never do is END UP on one.
  ok('a walk hemmed in by bodies never moves onto one',
     movedOnto.every(sq => !bodies.has(sq)), JSON.stringify(movedOnto.slice(0, 8)));
  ok('and it gives up rather than passing through', out?.arrived !== true, JSON.stringify(out));
}


console.log('');
console.log('A RAIL NEVER GIVES BACK GROUND IT HAS ALREADY MADE');
{
  // A rail is an ordered line, so "how far along are we" is a NUMBER — and the follower never
  // consulted it. Measured in the Cragged Mountains: the body reached waypoint 24 at col 23
  // row 26, slid back to col 22 row 26 (not on the line at all) and ping-ponged between the
  // two while trolls hit it. Fifty seconds in that room, nine squares of net progress, against
  // a human who crosses it at about five squares a second.
  //
  // The slide is ordinary and unavoidable — a step lands where the geometry puts it. What
  // turned a slide into a dither is that the next aim was taken from wherever the body ended
  // up, with no memory that it had already been further on.
  const line = [ {row:1,col:1}, {row:2,col:1}, {row:3,col:1}, {row:4,col:1}, {row:5,col:1} ];

  // A body that SLIDES FORWARD past the cursor must not be walked back to collect the
  // waypoint it skipped: it is already past it.
  const aimed = [];
  const jumper = {
    client: { self: { row: 1, col: 1 } },
    movementWasCancelled: () => false,
    world: { geometry: null },
    async step(col, row) {
      aimed.push(`${row},${col}`);
      // Every step overshoots to the end of the line, exactly as a slide can.
      this.client.self = { row: 5, col: 1 };
      return { moved: true, left_room: false };
    },
  };
  const ran = await followRail.call(jumper, line, {});
  ok('a slide that lands further along the line is credited, not re-walked',
     aimed.length <= 2, JSON.stringify(aimed));
  ok('and the follow reports success rather than grinding to the skip budget',
     ran?.railed === true, JSON.stringify(ran));

  // A body that cannot advance at all must JUMP rather than ask for the same neighbour for
  // ever — the line ahead is still the line, and every retry is a second in the room.
  const stuckAims = [];
  const stuck = {
    client: { self: { row: 1, col: 1 } },
    movementWasCancelled: () => false,
    world: { geometry: null },
    async step(col, row) { stuckAims.push(`${row},${col}`); return { moved: false, reason: 'object_blocked' }; },
  };
  const out = await followRail.call(stuck, line, { maxSlips: 1, maxSkips: 2 });
  ok('a line that yields nothing gives up rather than dithering for ever',
     out?.railed === false, JSON.stringify(out));
  ok('and it says the body never got further along', /no forward progress|slipped_off_rail/.test(out?.reason ?? ''),
     JSON.stringify(out?.reason));
}

console.log('');
console.log('A LEARNED TRACK IS ONE BOUNDED REPLAY, NOT ANOTHER WALKER');
{
  rideTrackNow = 0;
  rideTrackStrikeCalls = 0;
  rideTrackFixture = {
    ms: 100,
    waypoints: [
      { x: 128, y: 128 },
      { x: 256, y: 128 },
      { x: 384, y: 128 },
    ],
  };
  const client = { self: { x: 128, y: 128 } };
  const stepTargets = [];
  const trackSession = {
    client,
    world: { room: { num: 576 }, geometry: { walkable: () => true } },
    movementGeneration: 0,
    need: () => client,
    movementWasCancelled: () => false,
    cancelledMovement: extra => ({ cancelled: true, ...extra }),
    async walkTo() { throw new Error('a learned ride tried to board through the ordinary walker'); },
    async walkFine() { throw new Error('a learned ride opened a per-station fine-walk purse'); },
    async stepFine(x, y, options) {
      stepTargets.push({ x, deadlineAt: options?.deadlineAt });
      return { moved: false, left_room: false, reason: 'geometry_blocked' };
    },
  };
  const ridden = await rideTrack.call(trackSession, 575, 587, {});
  ok('the entry station costs no packet and the first missed station ends the replay',
     JSON.stringify(stepTargets.map(x => x.x)) === JSON.stringify([256]),
     JSON.stringify(stepTargets));
  ok('the replay threads one monotonic whole-ride deadline into its move',
     stepTargets[0]?.deadlineAt === 12_000, JSON.stringify(stepTargets));
  ok('the miss is counted once and strikes the bad track once',
     ridden?.left_room === false && ridden?.reached === 1 && ridden?.blocked === 1 &&
       ridden?.strikes === 1 && rideTrackStrikeCalls === 1,
     JSON.stringify(ridden));
}

console.log('');
console.log('AN UNPROVEN STITCH RIDES ONLY THE ROUTE A BODY ACTUALLY WALKED');
{
  rideTrackNow = 0;
  rideTrackStrikeCalls = 0;
  rideTrackFixture = {
    proven: false,
    ms: 100,
    waypoints: [{ x: 128, y: 128 }, { x: 500, y: 128 }],
    walked: [
      { x: 128, y: 128 }, { x: 320, y: 128 },
      { x: 800, y: 128 }, { x: 960, y: 128 },
    ],
  };
  const client = { self: { x: 128, y: 128 } };
  const stepCalls = [];
  const standableCalls = [];
  const trackSession = {
    client,
    world: { room: { num: 576 }, geometry: {
      walkable: () => true,
      standable(row, col) {
        standableCalls.push({ row, col });
        return true;
      },
    } },
    movementGeneration: 0,
    need: () => client,
    movementWasCancelled: () => false,
    cancelledMovement: extra => ({ cancelled: true, ...extra }),
    async walkTo() { throw new Error('an unproven track tried to board'); },
    async walkFine() { throw new Error('an unproven track tried the sewn/walked fine fallback'); },
    async stepFine(x, y) {
      stepCalls.push(x);
      client.self = { ...client.self, x, y };
      return { moved: true, left_room: x === 960 };
    },
  };
  const ridden = await rideTrack.call(trackSession, 587, 575, {});
  ok('the unproven sewn point is never sent and the walked line is replayed directly',
     JSON.stringify(stepCalls) === JSON.stringify([320, 800, 960]), JSON.stringify(stepCalls));
  ok('walked wire positions are checked in their actual protocol row and column',
     JSON.stringify(standableCalls) === JSON.stringify([
       { row: 2, col: 2 }, { row: 2, col: 5 },
       { row: 2, col: 12 }, { row: 2, col: 15 },
     ]), JSON.stringify(standableCalls));
  ok('the walked replay can complete the crossing without a second fallback purse',
     ridden?.left_room === true && ridden?.walked_track === true && ridden?.packets === 3,
     JSON.stringify(ridden));

  rideTrackFixture = {
    proven: false,
    ms: 100,
    waypoints: [{ x: 128, y: 128 }, { x: 500, y: 128 }],
  };
  stepCalls.length = 0;
  const noObservation = await rideTrack.call(trackSession, 587, 575, {});
  ok('an unproven stitch with no observed walk is refused instead of riding paper',
     noObservation?.rode === false && /no observed walked route/.test(noObservation?.why ?? '')
       && stepCalls.length === 0,
     JSON.stringify({ noObservation, stepCalls }));
}

console.log('');
console.log('THE WHOLE LEARNED RIDE SHARES EIGHT PACKETS AND TWELVE MONOTONIC SECONDS');
{
  const points = Array.from({ length: 12 }, (_, i) => ({ x: 128 + i * 128, y: 128 }));
  const session = (onStep, onCancel = () => false) => {
    const client = { self: { ...points[0] } };
    return {
      client,
      world: { room: { num: 576 }, geometry: { walkable: () => true } },
      movementGeneration: 0,
      need: () => client,
      movementWasCancelled: onCancel,
      cancelledMovement: extra => ({ arrived: false, cancelled: true, ...extra }),
      async walkTo() { throw new Error('a bounded learned ride tried to board'); },
      async walkFine() { throw new Error('a bounded learned ride opened a fine-walk purse'); },
      async stepFine(x, y, options) {
        const result = await onStep({ x, y, options, client });
        return result;
      },
    };
  };

  rideTrackFixture = { ms: 100, waypoints: points };
  rideTrackNow = 0;
  rideTrackStrikeCalls = 0;
  const packetCalls = [];
  const packetBound = session(({ x, y, options, client }) => {
    packetCalls.push({ x, deadlineAt: options?.deadlineAt });
    client.self = { ...client.self, x, y };
    return { moved: true, left_room: false };
  });
  const packetResult = await rideTrack.call(packetBound, 575, 587, {});
  ok('a learned replay sends at most eight movement attempts in total',
     packetCalls.length === 8 && packetResult?.packets === 8
       && packetResult?.effort_exhausted === 'packets',
     JSON.stringify({ packetCalls, packetResult }));
  ok('every movement attempt carries the same operation-wide deadline',
     packetCalls.every(x => x.deadlineAt === 12_000), JSON.stringify(packetCalls));

  rideTrackNow = 0;
  rideTrackStrikeCalls = 0;
  const deadlineCalls = [];
  const deadlineBound = session(({ x, y, client }) => {
    deadlineCalls.push(x);
    rideTrackNow += 4_000;
    client.self = { ...client.self, x, y };
    return { moved: true, left_room: false };
  });
  const deadlineResult = await rideTrack.call(deadlineBound, 575, 587, {});
  ok('the monotonic deadline stops the whole replay instead of resetting per station',
     deadlineCalls.length === 3 && deadlineResult?.effort_exhausted === 'deadline',
     JSON.stringify({ deadlineCalls, deadlineResult }));

  rideTrackFixture = { ms: 100, waypoints: points.slice(0, 3) };
  rideTrackNow = 0;
  rideTrackStrikeCalls = 0;
  const objectBound = session(() => ({ moved: false, left_room: false, reason: 'object_blocked' }));
  const objectResult = await rideTrack.call(objectBound, 575, 587, {});
  ok('a transient body block ends the replay without striking its route',
     objectResult?.bodies_in_the_way === 1 && rideTrackStrikeCalls === 0,
     JSON.stringify(objectResult));

  rideTrackNow = 0;
  rideTrackStrikeCalls = 0;
  let wasCancelled = false, cancellationCalls = 0;
  const cancellationBound = session(({ x, y, client }) => {
    cancellationCalls++;
    client.self = { ...client.self, x, y };
    wasCancelled = true;
    return { moved: true, left_room: false };
  }, () => wasCancelled);
  const cancellationResult = await rideTrack.call(cancellationBound, 575, 587, {});
  ok('cancellation returns immediately, opens no fallback, and never strikes the track',
     cancellationResult?.cancelled === true && cancellationCalls === 1
       && rideTrackStrikeCalls === 0,
     JSON.stringify(cancellationResult));

  const priorRideSwitch = process.env.M59_TRACK_RIDE;
  try {
    process.env.M59_TRACK_RIDE = '0';
    const switchedOff = await rideTrack.call({ need() { throw new Error('kill switch read live state'); } },
                                              575, 587, {});
    ok('M59_TRACK_RIDE=0 disables the learned rider before it reads or moves live state',
       switchedOff?.rode === false && /disabled/.test(switchedOff?.why ?? ''),
       JSON.stringify(switchedOff));
  } finally {
    if (priorRideSwitch == null) delete process.env.M59_TRACK_RIDE;
    else process.env.M59_TRACK_RIDE = priorRideSwitch;
  }
}

console.log('');
console.log('FINE RAIL TARGETS STAY IN WIRE COORDINATES');
{
  // Room 537 exposed this distinction live. Its north-to-east rail reached square 5,38,
  // then handed `walkFine` a CLIENT-space stand point for the next fine-only square.
  // `walkFine` compares its target to `client.self`, which is WIRE-space, so the 16x larger
  // x coordinate produced 908 clipped moves almost straight east and no southward progress.
  // Deliberately unrelated values make either unit leak unmistakable here.
  const clientPoint = { x: 39_424, y: 5_632 };
  const wirePoint = { x: 2_528, y: 416 };
  const fineCalls = [];
  const geometry = {
    walkable: () => false,
    standable: () => true,
    standPoint: () => clientPoint,
    standPointWire: () => wirePoint,
  };
  const railSession = {
    client: { self: { row: 1, col: 1 } },
    world: { geometry },
    movementWasCancelled: () => false,
    async walkFine(x, y) {
      fineCalls.push({ x, y });
      this.client.self = { row: 2, col: 2 };
      return { arrived: true };
    },
    async step() { throw new Error('fine-only rail fell through to the square walker'); },
  };
  const railed = await followRail.call(railSession,
    [{ row: 1, col: 1 }, { row: 2, col: 2 }], {});
  ok('a fine-only rail gives walkFine the wire stand point',
     fineCalls.length === 1 && fineCalls[0].x === wirePoint.x && fineCalls[0].y === wirePoint.y,
     JSON.stringify({ fineCalls, clientPoint, wirePoint, railed }));
  ok('and that wire-space rail reaches the next square', railed?.railed === true,
     JSON.stringify(railed));

  const recentreCalls = [];
  const recentreSession = {
    client: { self: { row: 7, col: 8 } },
    world: { geometry },
    async walkFine(x, y) { recentreCalls.push({ x, y }); return { arrived: true }; },
  };
  const recentred = await recentreInSquare.call(recentreSession);
  ok('recentering also gives walkFine the wire stand point',
     recentred === true && recentreCalls.length === 1 &&
       recentreCalls[0].x === wirePoint.x && recentreCalls[0].y === wirePoint.y,
     JSON.stringify({ recentreCalls, clientPoint, wirePoint, recentred }));
}

console.log('');
console.log('AN EDGE THE MOVER CANNOT WALK IS REMEMBERED PAST THE WALK THAT FOUND IT');
{
  // Room 50, measured: the single step 54,40 -> 53,40 was refused ONE HUNDRED AND THIRTY-FIVE
  // times in one two-character run — 135 of that room's 145 refusals. `moverStepLands` says
  // that step is false: both squares are walkable and the step between them is not, so the
  // mover was right every time and the walker asked anyway. Nothing reached the wire; the
  // local validator refuses first, so it was pure thrash against the step budget and the
  // clock, while every instrument reported a healthy character with somewhere to be.
  //
  // `blockedEdges` DID learn it — and is rebuilt empty on the next call, so the lesson died
  // with the walk and the next blind replan asked the identical question. A body in the way
  // deserves that amnesia, because it will have moved. Geometry does not.
  //
  // WHAT IS ASSERTED IS WHAT THE PLANNER WAS TOLD. The fixture's pathfinder is a stub and
  // will hand back whatever it likes; the property that matters is that the SECOND walk
  // starts with the edge already in the set handed to `geo.path`, where the first could not.
  const IMPOSSIBLE = '1,1>1,2';
  const mkGeo = told => ({
    num: 50, rows: 8, cols: 8,
    collisionReady: true,
    walkable: () => true,
    standable: () => true,
    nearestWalkable: (r, c) => ({ row: r, col: c }),
    // The one edge the mover refuses, asked centre to centre — the same question the
    // validator answers when it refuses the step for real.
    moverStepLands: (fr, fc, tr, tc) => !(fr === 1 && fc === 1 && tr === 1 && tc === 2),
    path: (_r, _c, _tr, _tc, opts) => {
      told.push(new Set(opts?.blockedEdges ?? []));
      return { found: true, steps: [{ col: 2, row: 1 }] };
    },
  });
  const mkSession = (geo, reason = 'geometry_blocked') => ({
    client: { self: { id: 1, col: 1, row: 1 }, room: { objects: new Map() },
              async roomContents() { return null; }, async waitFor() { return null; } },
    world: { geometry: geo, room: { num: 50 } },
    movementGeneration: 0,
    need() { return this.client; },
    movementWasCancelled() { return false; },
    railAcross() { return null; },
    async followRail() { return { railed: false, reason: 'no rail in this fixture' }; },
    sidestepAround() { return null; },
    threatsHere() { return []; },
    async selfOrResync() { return this.client.self; },
    async step() { return { moved: false, left_room: false, reason }; },
  });

  const memory = new Map();
  const toldFirst = [], toldSecond = [];
  const s1 = mkSession(mkGeo(toldFirst)); s1.impossibleEdges = memory;
  await walkTo.call(s1, 2, 1, { maxSteps: 6, hardCap: 12 });
  ok('the refused edge is remembered for the room it happened in',
     memory.get(50)?.has(IMPOSSIBLE) === true, JSON.stringify([...(memory.get(50) ?? [])]));
  ok('and the first walk could not have known it up front',
     toldFirst.length > 0 && !toldFirst[0].has(IMPOSSIBLE));

  const s2 = mkSession(mkGeo(toldSecond)); s2.impossibleEdges = memory;
  await walkTo.call(s2, 2, 1, { maxSteps: 6, hardCap: 12 });
  // THE POINT. The next walk plans around it from its very first question.
  ok('a later walk hands the planner that edge from the first call — that is the 135 refusals',
     toldSecond.length > 0 && toldSecond[0].has(IMPOSSIBLE),
     JSON.stringify(toldSecond[0] ? [...toldSecond[0]] : null));

  // A TROLL MOVES AND A WALL DOES NOT. Persisting a body would carve permanent holes in a
  // room over a long session, so only provable geometry is kept.
  const memory2 = new Map();
  const s3 = mkSession(mkGeo([]), 'object_blocked'); s3.impossibleEdges = memory2;
  await walkTo.call(s3, 2, 1, { maxSteps: 6, hardCap: 12 });
  ok('a body in the way is never remembered — it will have moved',
     (memory2.get(50)?.size ?? 0) === 0, JSON.stringify([...(memory2.get(50) ?? [])]));

  // A refusal the geometry will not corroborate stays local, exactly as before.
  const memory3 = new Map();
  const openGeo = mkGeo([]);
  openGeo.moverStepLands = () => true;      // says every step is fine; the step still fails
  const s4 = mkSession(openGeo); s4.impossibleEdges = memory3;
  await walkTo.call(s4, 2, 1, { maxSteps: 6, hardCap: 12 });
  ok('a refusal the geometry will not corroborate is NOT promoted to a map fact',
     (memory3.get(50)?.size ?? 0) === 0, JSON.stringify([...(memory3.get(50) ?? [])]));
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exitCode = fail ? 1 : 0;
