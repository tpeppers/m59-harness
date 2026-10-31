#!/usr/bin/env node
// A SURVIVAL EXIT MAY LEAVE THE CONFINEMENT -- ONE ROOM, ONE JOURNEY, NEVER INTO A BANNED OR PVP ROOM. Offline: the
// pure verdict, the PvP-room reader against a scratch hold directory, and the real Session guard on the real map
// (2501, the room t16's caster exits threw in). No socket, no roster.
//
//   node tools/m59-survival-edge-test.mjs
//
// PROBATIONARY since 2026-10-30, revisit 2026-11-30 (operator: "if we don't have PVP problems with it in the next
// month we can revisit it"). See m59-survival-edge.mjs and docs/m59-boundary.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'm59-survival-edge-'));
for (const [k, v] of Object.entries({ M59_LEDGER_DIR: 'ledger', M59_TACTICS_DIR: 'tactics', M59_TRAILS_DIR: 'trails',
  M59_SPOT_CLAIMS_DIR: 'claims', M59_SHELTER_DIR: 'shelter', M59_CROSSINGS_LEARNED: 'crossings.json',
  M59_TRACKS: 'tracks.json', M59_PVP_HOLD_DIR: 'pvp-holds' }))
  process.env[k] = join(scratch, v);
process.env.M59_RUNTIME_PROFILE = 'lab'; process.env.M59_EXIT_DEBUG = '0';

const { survivalEdgeVerdict, isSurvivalExit, pvpWindowMs, SURVIVAL_EDGE_REVISIT } = await import('./m59-survival-edge.mjs');
const { recentPvpDeathRooms, PVP_RETURN_DELAY_MS_DEFAULT } = await import('./m59-pvp-return.mjs');
const { World } = await import('./m59-world.mjs');
const { Session } = await import('./m59-game.mjs');
const { attachStepMasks } = await import('./m59-routes.mjs');
const { geometryFor } = await import('./m59-safespots.mjs');
const { loadMap } = await import('./m59-map.mjs');
const { configureSpotClaimStore } = await import('./m59-spotclaims.mjs');
configureSpotClaimStore({ enabled: false });

// ---------------------------------------------------------------- the decision
test('verdict: out into an ordinary room is allowed, and says it is probationary', () => {
  const v = survivalEdgeVerdict({ to: 2508, policy: { confineRooms: [2501] } });
  assert.equal(v.allowed, true);
  assert.match(v.why, /probationary since 2026-10-30/);
  assert.equal(SURVIVAL_EDGE_REVISIT, '2026-11-30');
});

test('verdict: never into a banned destination, never into a recent PvP-death room', () => {
  assert.equal(survivalEdgeVerdict({ to: 2133, policy: { bannedDestinations: [2133, 2] } }).allowed, false);
  assert.equal(survivalEdgeVerdict({ to: 2133, pvpRooms: new Set([2133]) }).allowed, false);
  assert.equal(survivalEdgeVerdict({ to: 2133, pvpRooms: new Set([2115]) }).allowed, true);
  assert.equal(survivalEdgeVerdict({ to: null }).allowed, false);
});

test('which journeys are survival exits: survival_exit, caster_exit, or the caster leg flag -- nothing else', () => {
  assert.equal(isSurvivalExit({ origin: { name: 'survival_exit' } }), true);
  assert.equal(isSurvivalExit({ origin: { name: 'caster_exit' } }), true);
  assert.equal(isSurvivalExit({ casterExit: true }), true);
  for (const name of ['hunt_relocation', 'town_trip', 'recovery_detour', 'shelter'])
    assert.equal(isSurvivalExit({ origin: { name } }), false, name);
  assert.equal(isSurvivalExit({}), false);
});

test('the PvP window is the fleet\'s own return hold', () => {
  assert.equal(pvpWindowMs({ pvpReturnDelayMs: 7_200_000 }), 7_200_000);
  assert.equal(pvpWindowMs({ pvpReturnDelayMs: 0 }), PVP_RETURN_DELAY_MS_DEFAULT, '0 disables the return hold, not this check');
  assert.equal(pvpWindowMs(null), PVP_RETURN_DELAY_MS_DEFAULT);
});

test('recentPvpDeathRooms: hold records inside the window, fleet-mate kills and pvp:false excluded', () => {
  const dir = process.env.M59_PVP_HOLD_DIR; mkdirSync(dir, { recursive: true });
  const now = Date.now(), put = (agent, rec) => writeFileSync(join(dir, `${agent}.json`), JSON.stringify({ agent, ...rec }));
  put('t1', { died_at: now - 30 * 60_000, room_num: 2115, basis: 'player_in_room', killers: ['Optimus Prime'] });
  put('t2', { died_at: now - 5 * 3600_000, room_num: 2133, basis: 'player_in_room' });
  put('t3', { died_at: now - 60_000, room_num: 2143, basis: 'fleetmate', killers: ['Kermit'] });
  put('t4', { died_at: now - 60_000, room_num: 2144, pvp: false });
  writeFileSync(join(dir, 't5.json'), '{ torn');
  const rooms = recentPvpDeathRooms({ now, ttlMs: 0 });
  assert.deepEqual([...rooms], [2115]);
  assert.deepEqual([...recentPvpDeathRooms({ now, ttlMs: 0, withinMs: 6 * 3600_000 })].sort(), [2115, 2133]);
});

// ---------------------------------------------------------------- the step guard, on the real map
const map = existsSync(join(HERE, '..', 'substrate', 'm59-map.json')) ? loadMap() : null;
const attached = map ? attachStepMasks(map) : null;
const skip = !map?.rooms?.[2501] ? 'room 2501 is not in the map on disk'
  : !attached?.ok ? `no routing table attached (${attached?.why})` : false;

// The walker of m59-edge-guard-travel-test, with the client's beforeMove wired to the REAL Session guard, so the
// pass under test is the one a keeper runs.
function walker(roomNum, x, y, confine) {
  const room = map.rooms[roomNum], geo = geometryFor(room), packets = [], refused = [];
  const self = { id: 1, flags: 4, x, y, row: Math.floor(y / 64), col: Math.floor(x / 64), predicted: false };
  const c = { selfId: 1, self, evSeq: 0, rsc: new Map(), roomNameRsc: room.nameRsc, roomRsc: room.roomRsc,
    room: { id: roomNum, security: geo.security, flags: 0, objects: new Map([[1, self]]) },
    vitals: () => ({ health: { value: 30, max: 119 }, vigor: { value: 200, max: 200 } }), face() {}, stand() {},
    roomContents() { return 1; }, async waitFor() { return { events: [] }; },
    predictSelf(p) { this.self = { ...this.self, ...p, predicted: true }; this.room.objects.set(1, this.self); },
    moveTo(nx, ny) {
      this.beforeMove?.({ x: nx, y: ny });
      packets.push({ x: nx, y: ny, row: Math.floor(ny / 64), col: Math.floor(nx / 64) });
      this.predictSelf({ x: nx, y: ny, row: Math.floor(ny / 64), col: Math.floor(nx / 64) });
    } };
  const s = Object.assign(Object.create(Session.prototype), { client: c, movementGeneration: 0, name: 'offline-survival-edge',
    need: () => c, moveSpeed: () => 18, movementWasCancelled: g => g !== s.movementGeneration,
    pacer: { async submit(_k, run) { return run(); } }, async confirmPosition() { c.self.predicted = false; return c.self; },
    async _askStrategies() { return null; }, _blinkPointHere: () => null,
    noteTransit() {}, planSameRoomDoors: () => null });
  Object.defineProperty(s, 'live', { value: true }); s.threatsHere = () => [];
  s.world = new World(c, map); s._blockingBodies = Session.prototype._blockingBodies;
  s.edgeConfinement = () => confine;
  c.beforeMove = target => {
    const edge = s.edgeCrossingBlock(target);
    if (edge) { refused.push(edge); throw Object.assign(new Error('edge_out_of_confinement'), { code: 'EDGE_OUT_OF_CONFINEMENT', ...edge }); }
  };
  return { s, c, packets, refused };
}
const travelOrError = async (s, to, opts) => {
  try { return await s.travel(to, { allowRescue: false, ...opts }); }
  catch (e) { return { threw: e }; }
};
const crossedNorth = packets => packets.some(p => p.y < 64);
// Under the north door at r2c13 (kod 880,160): the agent's control walks this to the crossing when unconfined.
const DOOR = [880, 160];

test('2501 -> 2508, confined to 2501, WITH the survival pass: walks out over the north edge', { skip }, async () => {
  const { s, packets, refused } = walker(2501, ...DOOR, [2501]);
  const out = await travelOrError(s, 2508, { maxHops: 1, edgePass: { to: 2508, why: 'test' } });
  assert.equal(out.threw, undefined, `travel threw: ${out.threw?.stack}`);
  assert.equal(refused.length, 0, `the guard refused: ${JSON.stringify(refused)}`);
  assert.ok(crossedNorth(packets), `a crossing packet went past the north edge: ${JSON.stringify(packets.slice(-3))}`);
});

test('the same journey WITHOUT the pass: nothing crosses, no throw', { skip }, async () => {
  const { s, packets, refused } = walker(2501, ...DOOR, [2501]);
  const out = await travelOrError(s, 2508, { maxHops: 1 });
  assert.equal(out.threw, undefined, `travel threw: ${out.threw?.stack}`);
  assert.equal(refused.length, 0);
  assert.ok(!crossedNorth(packets));
  assert.equal(out.arrived, false);
});

test('the pass names ONE room: a pass to another room lets nothing out', { skip }, async () => {
  const { s, packets } = walker(2501, ...DOOR, [2501]);
  await travelOrError(s, 2508, { maxHops: 1, edgePass: { to: 2502 } });
  assert.ok(!crossedNorth(packets));
});

test('the pass dies with its journey: a cancel, the next journey, another room, or two minutes', { skip }, async () => {
  const { s } = walker(2501, ...DOOR, [2501]);
  const arm = () => { s.edgePass = { to: 2508, from: 2501, generation: s.movementGeneration, until: Date.now() + 120_000 }; };
  arm(); assert.equal(s.edgeIntoRefused(2508), false, 'armed: not refused');
  s.movementGeneration++; assert.equal(s.edgeIntoRefused(2508), true, 'a cancel ends it');
  assert.equal(s.edgePass, null, 'and clears it');
  arm(); s.edgePass.until = Date.now() - 1; assert.equal(s.edgeIntoRefused(2508), true, 'expired');
  arm(); s.edgePass.from = 2502; assert.equal(s.edgeIntoRefused(2508), true, 'only from the room it set out from');
  arm(); await travelOrError(s, 2508, { maxHops: 0 });
  assert.equal(s.edgePass, null, 'a journey without a pass clears the last one');
});
