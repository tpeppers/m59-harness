#!/usr/bin/env node
// A JOURNEY DOES NOT WALK TO AN EDGE THE STEP GUARD WILL REFUSE. Offline: the real map, the real
// World, the real Session.travel / leaveViaAny / leaveVia, against a fake client. No socket, no
// roster; every ledger the walkers touch is redirected to a scratch directory.
//
//   node tools/m59-edge-guard-travel-test.mjs
//
// THE INCIDENT, prod 2026-10-27..31. The largest class of "stuck" in the movement-incident log was
// `not_arrived` with `reason: null`. The keepers' own stdout named it -- `[edge] t16 refused a step
// from 2501 r1c13 into 2508: outside the confinement` (92 lines), 2142 -> 2133 (77), 599 -> 589,
// 2125 -> 2135 -- and the survival-decision log said `could not leave by 2143: edge_out_of_confinement`.
// `Session.edgeCrossingBlock` THROWS from the step that crosses an edge out of the confinement, while
// the router treats a confinement only as a preference (findPath drops `avoid` on its last pass) and
// a caster exit is allowed out of it by Autopilot.travel. So:
//   - 2142 -> 2143 (confined 2142/2143/2144/2101): the south edge's candidates exhausted, the re-plan
//     went through 2133, and the body walked the length of an avar room to r29c1 and threw there;
//   - 2501 -> 2508 (confined 2501, caster_exit): walked to r1c13 and threw, every ten minutes.
// resume_journey re-issued each every ~30 s. These cases reproduce both from the incidents' own start
// squares and pin that travel now asks the guard before it walks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'm59-edge-guard-travel-'));
for (const [k, v] of Object.entries({ M59_LEDGER_DIR: 'ledger', M59_TACTICS_DIR: 'tactics', M59_TRAILS_DIR: 'trails',
  M59_SPOT_CLAIMS_DIR: 'claims', M59_SHELTER_DIR: 'shelter', M59_CROSSINGS_LEARNED: 'crossings.json',
  M59_TRACKS: 'tracks.json' }))
  process.env[k] = join(scratch, v);
process.env.M59_RUNTIME_PROFILE = 'lab'; process.env.M59_EXIT_DEBUG = '0';

const { World } = await import('./m59-world.mjs');
const { Session } = await import('./m59-game.mjs');
const { attachStepMasks } = await import('./m59-routes.mjs');
const { geometryFor } = await import('./m59-safespots.mjs');
const { loadMap, edgeCrossedAt } = await import('./m59-map.mjs');
const { configureSpotClaimStore } = await import('./m59-spotclaims.mjs');
configureSpotClaimStore({ enabled: false });

const map = existsSync(join(HERE, '..', 'substrate', 'm59-map.json')) ? loadMap() : null;
const attached = map ? attachStepMasks(map) : null;
const skip = !map?.rooms?.[2142] || !map?.rooms?.[2501] ? 'rooms 2142/2501 are not in the map on disk'
  : !attached?.ok ? `no routing table attached (${attached?.why})` : false;

// The walker from m59-peninsula-test / m59-edge-stage-test, with the client's `beforeMove` hook.
// The guard installed there is written out independently of Session.edgeCrossingBlock on purpose:
// it is the behaviour prod enforces, and the test must fail against code that ignores it.
function walker(roomNum, x, y, confine) {
  const room = map.rooms[roomNum], geo = geometryFor(room), packets = [], refused = [];
  const self = { id: 1, flags: 4, x, y, row: Math.floor(y / 64), col: Math.floor(x / 64), predicted: false };
  const c = { selfId: 1, self, evSeq: 0, rsc: new Map(), roomNameRsc: room.nameRsc, roomRsc: room.roomRsc,
    room: { id: roomNum, security: geo.security, flags: 0, objects: new Map([[1, self]]) },
    vitals: () => ({ health: { value: 60, max: 119 }, vigor: { value: 200, max: 200 } }), face() {}, stand() {},
    roomContents() { return 1; }, async waitFor() { return { events: [] }; },
    predictSelf(p) { this.self = { ...this.self, ...p, predicted: true }; this.room.objects.set(1, this.self); },
    moveTo(nx, ny) {
      this.beforeMove?.({ x: nx, y: ny });
      packets.push({ x: nx, y: ny, row: Math.floor(ny / 64), col: Math.floor(nx / 64) });
      this.predictSelf({ x: nx, y: ny, row: Math.floor(ny / 64), col: Math.floor(nx / 64) });
    } };
  const s = Object.assign(Object.create(Session.prototype), { client: c, movementGeneration: 0, name: 'offline-edge-guard',
    need: () => c, moveSpeed: () => 18, movementWasCancelled: g => g !== s.movementGeneration,
    pacer: { async submit(_k, run) { return run(); } }, async confirmPosition() { c.self.predicted = false; return c.self; },
    async _askStrategies() { return null; }, _blinkPointHere: () => null,
    noteTransit() {}, planSameRoomDoors: () => null });
  Object.defineProperty(s, 'live', { value: true }); s.threatsHere = () => [];
  s.world = new World(c, map); s._blockingBodies = Session.prototype._blockingBodies;
  s.edgeConfinement = () => confine;   // what autopilotIfAny(name).policy.confineRooms says on a keeper
  if (confine) c.beforeMove = target => {
    const here = s.world?.room;
    if (!here || !confine.includes(Number(here.num))) return;
    const to = edgeCrossedAt(here, Math.floor(target.y / 64), Math.floor(target.x / 64))?.edge?.to;
    if (to == null || confine.includes(Number(to))) return;
    refused.push({ to, x: target.x, y: target.y });
    throw Object.assign(new Error('edge_out_of_confinement'), { code: 'EDGE_OUT_OF_CONFINEMENT' });
  };
  return { s, c, packets, refused };
}
// Autopilot.travel's confinementAvoid for a destination inside the confinement: every other room.
const avoidOutside = (confine, here, to) =>
  Object.keys(map.rooms).map(Number).filter(n => !new Set([...confine, here, to]).has(n));
const travelOrError = async (s, to, opts) => {
  try { return await s.travel(to, { allowRescue: false, ...opts }); }
  catch (e) { return { threw: e }; }
};

test('2501 -> 2508, confined to 2501 (t16 caster_exit, from r10c29): refused before a single step, no throw', { skip }, async () => {
  const { s, packets, refused } = walker(2501, 1888, 654, [2501]);
  const out = await travelOrError(s, 2508, { maxHops: 2 });
  assert.equal(out.threw, undefined, `travel threw: ${out.threw?.stack}`);
  assert.equal(refused.length, 0, 'the step guard was never asked to refuse a crossing');
  assert.equal(packets.length, 0, `nothing walked: ${packets.length} moves, last ${JSON.stringify(packets.at(-1))}`);
  assert.equal(out.arrived, false);
  assert.equal(out.reason, 'route_progressing_exits_exhausted');
  const hops = out.log?.filter(l => l.reason === 'edge_out_of_confinement').map(l => l.blocked_hop) ?? [];
  assert.ok(hops.includes('2501>2508'), `the refused hop is named: ${JSON.stringify(hops)}`);
});

test('2501 -> 2508, confined to 2501, standing under the door at r2c13: still no crossing packet, no throw', { skip }, async () => {
  const { s, packets, refused } = walker(2501, 880, 160, [2501]);
  const out = await travelOrError(s, 2508, { maxHops: 2 });
  assert.equal(out.threw, undefined, `travel threw: ${out.threw?.stack}`);
  assert.equal(refused.length, 0);
  assert.equal(packets.length, 0);
  assert.equal(out.reason, 'route_progressing_exits_exhausted');
});

test('2142 -> 2143, confined to 2142/2143/2144/2101 (Sweetums survival_exit, from r36c24): no walk to the 2133 edge, no throw', { skip }, async () => {
  const confine = [2142, 2143, 2144, 2101];
  const { s, c, packets, refused } = walker(2142, 1544, 2366, confine);
  const out = await travelOrError(s, 2143, { maxHops: 1, avoid: avoidOutside(confine, 2142, 2143) });
  assert.equal(out.threw, undefined, `travel threw: ${out.threw?.stack}`);
  assert.equal(refused.length, 0, `the step guard was never asked to refuse a crossing: ${JSON.stringify(refused)}`);
  // Offline the south edge never changes room, so its candidates are exhausted exactly as on prod.
  // Before: the re-plan went 2142 -> 2133 and walked r40c27 .. r30c2 -> r29c1 (kod 96,1904).
  assert.ok(!packets.some(p => p.col <= 4 && p.row >= 25 && p.row <= 33),
    `walked toward the west edge: ${packets.map(p => `r${p.row}c${p.col}`).join(' ')}`);
  assert.ok(c.self.row >= 40, `the body stayed by the south edge it tried: r${c.self.row}c${c.self.col}`);
  assert.equal(out.arrived, false);
  assert.equal(out.reason, 'route_progressing_exits_exhausted');
});

// From r2c13, under the door. (From r10c29 the offline walker is refused geometry_blocked at r12c15 on its way north,
// where prod's bodies reached r1c13 -- a separate divergence, not this test's subject.)
test('control: unconfined, 2501 -> 2508 from r2c13 still walks to the north edge and sends the crossing', { skip }, async () => {
  const { s, packets } = walker(2501, 880, 160, null);
  const out = await travelOrError(s, 2508, { maxHops: 1 });
  assert.equal(out.threw, undefined, `travel threw: ${out.threw?.stack}`);
  assert.ok(packets.some(p => p.y < 64), `a crossing packet went past the north edge: ${JSON.stringify(packets.slice(-3))}`);
});

test('Session.edgeIntoRefused is the guard\'s own rule: only out of the confinement, only from inside it', { skip }, () => {
  const { s } = walker(2142, 1544, 2366, [2142, 2143]);
  assert.equal(s.edgeIntoRefused(2133), true);
  assert.equal(s.edgeIntoRefused(2143), false);
  assert.equal(s.edgeIntoRefused(null), false);
  assert.equal(s.edgeIntoRefused(2133, null), false, 'no confinement, no guard');
  assert.equal(s.edgeIntoRefused(2133, [2143, 2144]), false, 'a body outside its confinement is on its way home');
  // And edgeCrossingBlock reads the same confinement: the west edge at r29c0 is refused, the south edge is not.
  assert.equal(s.edgeCrossingBlock({ x: 63, y: 1904 })?.to, 2133);
  assert.equal(s.edgeCrossingBlock({ x: 2480, y: 2944 }), null);
});
