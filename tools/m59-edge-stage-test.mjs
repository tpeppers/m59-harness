#!/usr/bin/env node
// AN EXIT CORNER THAT REFUSES MUST NOT SPEND THE WHOLE BOUNDARY'S BUDGET. Offline: the real
// substrate/m59-map.json, the baked routing table and step masks (as a keeper runs), the real
// walker against a fake client. No socket, no roster.
//
//   node tools/m59-edge-stage-test.mjs
//
// THE INCIDENT, 2026-10-13/14. Outskirts of Tos (596) -> East Ende (61) is an EDGE exit. The bake
// anchors it at r1c1, the NW corner: a six-square pocket behind a one-square passage down column 1.
// The mover's own flood reaches the north wall at r2c42; the ledge r1c17-r1c40 is coarse-only.
// Zheng He (hk2) walked the baked line into the pocket, and `leaveViaAny`'s three-walk budget
// bought r1c1, r2c2, r1c2 -- `object_blocked` at every one, four journeys running, oscillating
// r3c2<->r4c2 among a spider, a soldier and a groundworm; other runs spent it on r1c1, r1c1, r2c2
// (`movement_deviation` at the walk). The crossing on 2026-10-14 03:11Z died at r8c3.
//
// Three things combined, all pinned here:
//   1. `spreadEdges` gave every alternate the primary's `verified`, dropping its `grid_only`;
//   2. `orderExits` sorted the flattened list on distance alone, so coarse-only ledge squares and
//      the anchor's own neighbours came before r2c42;
//   3. nothing moved the budget away from a stage that a body held or the walk never reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'm59-edge-stage-'));
for (const [k, v] of Object.entries({ M59_LEDGER_DIR: 'ledger', M59_TACTICS_DIR: 'tactics', M59_TRAILS_DIR: 'trails',
  M59_SPOT_CLAIMS_DIR: 'claims', M59_SHELTER_DIR: 'shelter', M59_CROSSINGS_LEARNED: 'crossings.json' }))
  process.env[k] = join(scratch, v);
process.env.M59_RUNTIME_PROFILE = 'lab'; process.env.M59_EXIT_FALLBACK = '0'; process.env.M59_EXIT_DEBUG = '0';

const { World, spreadEdges, deferNearRefusedStage } = await import('./m59-world.mjs');
const { Session, orderExits } = await import('./m59-game.mjs');
const { geometryFor } = await import('./m59-safespots.mjs');
const { attachStepMasks, activeRoutes, anchorFor } = await import('./m59-routes.mjs');
const { loadMap } = await import('./m59-map.mjs');
const { configureSpotClaimStore } = await import('./m59-spotclaims.mjs');
configureSpotClaimStore({ enabled: false });

const map = existsSync(join(HERE, '..', 'substrate', 'm59-map.json')) ? loadMap() : null;
const attached = map ? attachStepMasks(map) : null;
const why = !map?.rooms?.[596] ? 'no room 596 in the map on disk'
  : !attached?.ok ? `no routing table attached (${attached?.why})`
  : (anchorFor(activeRoutes(), 596, 61)?.row !== 1 || anchorFor(activeRoutes(), 596, 61)?.col !== 1)
    ? 'the bake no longer anchors 596 -> 61 at r1c1; this incident is about that corner' : null;

const cheb = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
const CORNER = { row: 1, col: 1 };

// The deviation-routing fixture, with the room's resources so `new World` resolves room 596.
function fixture(x, y, spider = null) {
  const geo = geometryFor(map.rooms[596]), packets = [];
  const self = { id: 1, flags: 4, x, y, row: Math.floor(y / 64), col: Math.floor(x / 64), predicted: false };
  const c = { selfId: 1, self, evSeq: 0, rsc: new Map(), roomNameRsc: map.rooms[596].nameRsc, roomRsc: map.rooms[596].roomRsc,
    room: { id: 596, security: geo.security, flags: 0, objects: new Map([[1, self]]) },
    vitals: () => ({ health: { value: 20, max: 20 }, vigor: { value: 200, max: 200 } }), face() {}, stand() {},
    roomContents() { return 1; }, async waitFor() { return { events: [] }; },
    predictSelf(p) { this.self = { ...this.self, ...p, predicted: true }; this.room.objects.set(1, this.self); },
    moveTo(nx, ny) { packets.push({ x: nx, y: ny }); this.predictSelf({ x: nx, y: ny, row: Math.floor(ny / 64), col: Math.floor(nx / 64) }); } };
  if (spider) { c.room.objects.set(2, { id: 2, flags: 9, ...spider, nameRsc: 2 }); c.rsc.set(2, 'spider'); }
  const s = Object.assign(Object.create(Session.prototype), { client: c, movementGeneration: 0, name: 'offline-596',
    need: () => c, moveSpeed: () => 18, movementWasCancelled: g => g !== s.movementGeneration,
    pacer: { async submit(_k, run) { return run(); } }, async confirmPosition() { c.self.predicted = false; return c.self; },
    async _askStrategies() { return null; }, _blinkPointHere: () => null,
    noteTransit() {}, planSameRoomDoors: () => null, async rideTrack() { return { rode: false }; } });
  Object.defineProperty(s, 'live', { value: true }); s.threatsHere = () => [];
  s.world = new World(c, map); s._blockingBodies = Session.prototype._blockingBodies;
  const asked = [];
  s.leaveVia = async function (exit, o) {
    const r = await Session.prototype.leaveVia.call(this, exit, o);
    asked.push({ ...exit.stand_on, stage: r.stage, reason: r.reason, crossing_packet_sent: r.crossing_packet_sent,
                 at: { row: c.self.row, col: c.self.col } });
    return r;
  };
  return { s, c, packets, asked };
}
const say = asked => asked.map(a => `r${a.row}c${a.col}:${a.stage}/${a.reason}`).join(' ');

test('596 north: the mover-reachable stage is not hidden behind coarse-only ledge squares', { skip: why ?? false }, () => {
  const { s } = fixture(128, 240);
  const north = s.world.exits().filter(e => e.kind === 'edge' && Number(e.to) === 61);
  assert.ok(north.length, '596 publishes its north edge to 61');
  const spread = spreadEdges(north);
  const ledge = spread.filter(e => e.stand_on.row <= 2 && e.stand_on.col >= 17 && e.stand_on.col <= 40);
  assert.ok(ledge.length && ledge.every(e => e.grid_only === true),
    `the r1c17-r1c40 ledge is coarse-only and must say so after spreading: ${ledge.map(e => `r${e.stand_on.row}c${e.stand_on.col}:${e.grid_only}`)}`);
  const order = orderExits(spread);
  const firstGuess = order.findIndex(e => e.grid_only === true);
  const ne = order.findIndex(e => e.stand_on.col >= 41 && e.stand_on.row <= 2);
  assert.ok(ne >= 0 && (firstGuess < 0 || ne < firstGuess),
    `a walkable NE stage ranks before every coarse-only one: ${order.map(e => `r${e.stand_on.row}c${e.stand_on.col}${e.grid_only ? '(g)' : ''}`)}`);
});

for (const [label, spider] of [['a spider beside the pocket at r3c1', { x: 110, y: 214, row: 3, col: 1 }],
                               ['a spider parked in the exit corner', { x: 96, y: 96, row: 1, col: 1 }],
                               ['nothing in the way', null]]) {
  test(`596 from r3c2, ${label}: the second walk leaves the corner and reaches the north edge`, { skip: why ?? false }, async () => {
    const { s, asked } = fixture(128, 240, spider);
    const north = s.world.exits().filter(e => e.kind === 'edge' && Number(e.to) === 61);
    await s.leaveViaAny(north);
    // Before: r1c1 r2c2 r1c2 (or r1c1 r1c1 r2c2) -- the whole budget inside one corner.
    assert.ok(asked.length >= 2, say(asked));
    assert.equal(cheb(asked[0], CORNER), 0, `the baked anchor is still asked first: ${say(asked)}`);
    assert.ok(cheb(asked[1], CORNER) > 2, `the second try left the corner: ${say(asked)}`);
    // Offline the fake client never changes room, so "reached the edge and sent the crossing" is
    // the strongest claim available; the walk out of the pocket is what the incident never did.
    const out = asked[1];
    assert.equal(out.stage, 'edge', `the walk to r${out.row}c${out.col} arrived at the boundary: ${say(asked)}`);
    assert.ok(out.at.row <= 1 && out.at.col >= 41, `and the body is on the north edge, NE: ${JSON.stringify(out.at)}`);
  });
}

test('a refusal AT the crossing does not defer neighbours (Kardde: r1c21 refused, r1c22 crosses)', { skip: why ?? false }, async () => {
  const { s } = fixture(128, 240);
  const north = s.world.exits().filter(e => e.kind === 'edge' && Number(e.to) === 61);
  const asked = [];
  s.recentreInSquare = async () => false;
  s.leaveVia = async exit => { asked.push(exit.stand_on);
    return { left: false, reason: 'geometry_blocked', stage: 'edge', crossing_packet_sent: false }; };
  await s.leaveViaAny(north);
  assert.ok(asked.length >= 2 && cheb(asked[1], asked[0]) <= 2,
    `neighbour order kept: ${asked.map(p => `r${p.row}c${p.col}`).join(' ')}`);
});

test('deferNearRefusedStage: defers near, keeps order, drops nothing, leaves the head alone', () => {
  const e = (row, col) => ({ stand_on: { row, col } });
  const list = [e(1, 1), e(2, 2), e(1, 2), e(1, 20), e(1, 4), e(2, 42), { kind: 'edge' }];
  const out = deferNearRefusedStage(list, 1, { row: 1, col: 1 });
  assert.equal(out.length, list.length);
  assert.equal(out[0], list[0]);
  assert.deepEqual(out.map(x => x.stand_on ? `r${x.stand_on.row}c${x.stand_on.col}` : '-'),
    ['r1c1', 'r1c20', 'r1c4', 'r2c42', '-', 'r2c2', 'r1c2']);
  assert.deepEqual(deferNearRefusedStage(list, 1, null), list);
  assert.deepEqual(deferNearRefusedStage(null, 0, { row: 1, col: 1 }), []);
});
