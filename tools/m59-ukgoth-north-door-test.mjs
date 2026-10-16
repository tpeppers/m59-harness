#!/usr/bin/env node
// UKGOTH'S EAST HALF MUST REACH THE NORTH DOOR. Offline: the real substrate/m59-map.json, the
// baked routing table and step masks (as a keeper runs), the real walker against a fake client.
// No socket, no roster.
//
//   node tools/m59-ukgoth-north-door-test.mjs
//
// THE INCIDENT, 2026-10-14 (movement-incidents, room 599 -> 2, exits_exhausted). From the east
// half nobody reached the north door: t1, t9, t10, t14, t15, t18, t20, hk2 all ended at r10c57
// with every candidate (r1c27/r1c28/r2c27, then r1c27/r1c31/r1c34 after 8c87ae79) refused
// `movement_deviation`. Two mechanisms, both pinned here:
//
//   1. THE POCKET POSE. The step r9c56 > r10c57 lands at (3696,656), because r10c57's stand
//      point is not reachable from r9c56. From there r10c57 > r11c57 predicts a 70-unit slide,
//      the pre-send check refuses it, the bounded departure search fails, and walkTo returned.
//      Nothing was learned, so every later walk -- each exit candidate, each journey -- planned
//      the same edge from the same pose and was refused without a packet. `learnDeviationEdge`
//      now blocks that edge for the walk and re-plans.
//   2. THE RAIL HEAD. Bodies in the NE corner were put on r7c64 by the seed departure
//      (pocket plan, and continueDeparture), and followRail ground r6c65 <-> r7c64 for 500-1000
//      packets: the fine check that boards past the broken head (fineRailBoard) ran only when
//      no pocket plan existed. Both departure paths now ask it from where they land.
//
// Offline the fake client never changes room, so "stood on a north-edge stage and sent the
// crossing" (`stage: 'edge'`) is the strongest claim available.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'm59-ukgoth-north-'));
for (const [k, v] of Object.entries({ M59_LEDGER_DIR: 'ledger', M59_TACTICS_DIR: 'tactics', M59_TRAILS_DIR: 'trails',
  M59_SPOT_CLAIMS_DIR: 'claims', M59_SHELTER_DIR: 'shelter', M59_CROSSINGS_LEARNED: 'crossings.json' }))
  process.env[k] = join(scratch, v);
process.env.M59_RUNTIME_PROFILE = 'lab'; process.env.M59_EXIT_FALLBACK = '0'; process.env.M59_EXIT_DEBUG = '0';

const { World } = await import('./m59-world.mjs');
const { Session } = await import('./m59-game.mjs');
const { geometryFor } = await import('./m59-safespots.mjs');
const { attachStepMasks, activeRoutes, anchorFor } = await import('./m59-routes.mjs');
const { loadMap } = await import('./m59-map.mjs');
const { configureSpotClaimStore } = await import('./m59-spotclaims.mjs');
configureSpotClaimStore({ enabled: false });

const ROOM = 599;
const map = existsSync(join(HERE, '..', 'substrate', 'm59-map.json')) ? loadMap() : null;
const attached = map ? attachStepMasks(map) : null;
const anchor = attached?.ok ? anchorFor(activeRoutes(), ROOM, 2) : null;
const why = !map?.rooms?.[ROOM] ? 'no room 599 in the map on disk'
  : !attached?.ok ? `no routing table attached (${attached?.why})`
  : (anchor?.row !== 1 || anchor?.col !== 27) ? 'the bake no longer anchors 599 -> 2 at r1c27; this incident is about that door'
  : null;

function fixture(x, y) {
  const geo = geometryFor(map.rooms[ROOM]), packets = [];
  const self = { id: 1, flags: 4, x, y, row: Math.floor(y / 64), col: Math.floor(x / 64), predicted: false };
  const c = { selfId: 1, self, evSeq: 0, rsc: new Map(), roomNameRsc: map.rooms[ROOM].nameRsc, roomRsc: map.rooms[ROOM].roomRsc,
    room: { id: ROOM, security: geo.security, flags: 0, objects: new Map([[1, self]]) },
    vitals: () => ({ health: { value: 75, max: 75 }, vigor: { value: 200, max: 200 } }), face() {}, stand() {},
    roomContents() { return 1; }, async waitFor() { return { events: [] }; },
    predictSelf(p) { this.self = { ...this.self, ...p, predicted: true }; this.room.objects.set(1, this.self); },
    moveTo(nx, ny) { packets.push({ x: nx, y: ny }); this.predictSelf({ x: nx, y: ny, row: Math.floor(ny / 64), col: Math.floor(nx / 64) }); } };
  const s = Object.assign(Object.create(Session.prototype), { client: c, movementGeneration: 0, name: 'offline-599',
    need: () => c, moveSpeed: () => 18, movementWasCancelled: g => g !== s.movementGeneration,
    pacer: { async submit(_k, run) { return run(); } }, async confirmPosition() { c.self.predicted = false; return c.self; },
    async _askStrategies() { return null; }, _blinkPointHere: () => null,
    noteTransit() {}, planSameRoomDoors: () => null });
  Object.defineProperty(s, 'live', { value: true }); s.threatsHere = () => [];
  s.world = new World(c, map); s._blockingBodies = Session.prototype._blockingBodies;
  const asked = [];
  s.leaveVia = async function (exit, o) {
    const before = packets.length;
    const r = await Session.prototype.leaveVia.call(this, exit, o);
    asked.push({ ...exit.stand_on, stage: r.stage, reason: r.reason, packets: packets.length - before,
                 at: { row: c.self.row, col: c.self.col } });
    return r;
  };
  return { s, c, packets, asked };
}
const say = asked => asked.map(a => `r${a.row}c${a.col}:${a.stage}/${a.reason}@r${a.at.row}c${a.at.col}(${a.packets}pk)`).join(' ');
const north = s => s.world.exits().filter(e => e.kind === 'edge' && Number(e.to) === 2);
const atNorthDoor = a => a.stage === 'edge' && a.at.row <= 1 && a.at.col >= 26 && a.at.col <= 35;

test('the r10c57 pocket: the refused slide is learned, and a later candidate reaches the north door', { skip: why ?? false }, async () => {
  const { s, asked } = fixture(3696, 656);
  await s.leaveViaAny(north(s));
  // Before: r1c27 r1c31 r1c34 all `movement_deviation` at r10c57, 0-4 packets each.
  assert.ok(asked.some(atNorthDoor), `some candidate stood on the north edge and sent the crossing: ${say(asked)}`);
  assert.ok(!asked.every(a => a.at.row === 10 && a.at.col === 57), `the body left the pocket: ${say(asked)}`);
});

for (const [label, x, y] of [['r6c65, the NE corner', 4192, 416], ['r7c64, the rail head', 4144, 448]]) {
  test(`${label}: boarded past the broken rail head, the FIRST candidate reaches the north door`, { skip: why ?? false }, async () => {
    const { s, asked } = fixture(x, y);
    await s.leaveViaAny(north(s));
    // Before: r1c27 `movement_deviation` at r7c63 after ~1000 packets of r6c65<->r7c64.
    assert.ok(asked.length >= 1 && atNorthDoor(asked[0]), `the first walk arrived at the door: ${say(asked)}`);
    assert.ok(asked[0].packets < 600, `without grinding the rail head: ${say(asked)}`);
  });
}

test('learnDeviationEdge: a confirmed geometry slide is learned once; a body or a stale pose teaches nothing', { skip: why ?? false }, () => {
  const { s, c } = fixture(3696, 656);
  const failure = (over = {}) => ({ reason: 'movement_deviation', deviation: { phase: 'predicted', confirmed: true, room: ROOM,
    requested: { x: 3680, y: 736, row: 11, col: 57 }, position: { x: 3696, y: 656, row: 10, col: 57 },
    geometry: { reason: 'geometry_blocked' }, ...over } });
  const edges = new Set();
  assert.equal(s.learnDeviationEdge(failure(), edges), true);
  assert.deepEqual([...edges], ['10,57>11,57']);
  assert.ok(s.deviationEdges?.get(ROOM)?.get('10,57>11,57') > Date.now(), 'and remembered for the next walk, with an expiry');
  assert.equal(s.learnDeviationEdge(failure(), edges), false, 'an edge already known buys no second replan');
  const fresh = () => new Set();
  assert.equal(s.learnDeviationEdge(failure({ geometry: { reason: 'object_blocked' } }), fresh()), false, 'a troll moves');
  assert.equal(s.learnDeviationEdge(failure({ confirmed: false }), fresh()), false, 'an unconfirmed pose');
  assert.equal(s.learnDeviationEdge(failure({ phase: 'observed' }), fresh()), false, 'an observed slide already moved the body');
  c.self = { ...c.self, x: 3690 };
  assert.equal(s.learnDeviationEdge(failure(), fresh()), false, 'the body is no longer where the refusal was confirmed');
});

// THE HUNT, 2026-10-16. Kermit and Rizzo stood at r9c56-57 for an hour hunting a troll at r31c51:
// every quarry approach was refused (`movement_deviation`, then `object_blocked` with each other
// beside them) and deferred. The coarse approach runs south down column 57, which the fine floor
// does not support; the walk that does is the baked zigzag 1,66>71,2 -- west along rows 8-13 to
// column 29, south, back east to 30,51. planRailDeparture offered rails only toward EXIT anchors,
// so an in-room goal never saw it. Now any baked line passing beside the goal is a candidate.
for (const [label, x, y, mate] of [['Kermit alone at r9c57', 3648, 604, null], ['Kermit beside Rizzo', 3648, 604, [3629, 597]]]) {
  test(`${label}: the quarry approach to r30c50 rides the west-east rail and arrives`, { skip: why ?? false }, async () => {
    const { s, c, packets } = fixture(x, y);
    if (mate) c.room.objects.set(2, { id: 2, flags: 4, x: mate[0], y: mate[1], row: Math.floor(mate[1] / 64), col: Math.floor(mate[0] / 64) });
    c.room.objects.set(3, { id: 3, flags: 9, x: 51 * 64 + 32, y: 31 * 64 + 32, row: 31, col: 51 });
    const a = s.world.approachSquare(51, 31);
    assert.ok(a, 'the troll has an approach square');
    const out = await s.walkTo(a.col, a.row, { maxSteps: a.steps + 8 });
    assert.equal(out.arrived, true, `arrived: ${JSON.stringify(out).slice(0, 300)}`);
    assert.ok(packets.some(p => Math.floor(p.x / 64) <= 31), 'went west along the rail rather than down column 57');
  });
}
