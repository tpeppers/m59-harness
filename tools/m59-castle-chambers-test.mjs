#!/usr/bin/env node
// Offline: real Castle geometry, all chamber pairs, and keeper dispatch.
import assert from 'node:assert/strict';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { sameRoomDoorPlan } from './m59-world.mjs';
import { Autopilot, quarryPermittedByConfinement } from './m59-autopilot.mjs';

const map = loadMap();
attachStepMasks(map);
const room = map.rooms[38], geo = sharedRoomGeometry(room);
const body = p => ({ ...p, x: p.col * 64 + 32, y: p.row * 64 + 32 });
const hall = { row: 12, col: 18 };
const chambers = [4, 10, 26, 32].map(col => ({ row: 7, col }));
let routes = 0;
{
  // Statler's observed prod body and quarry, 2026-09-22. Square proximity to
  // the skeleton is not access through the northeast chamber's wall.
  const plan = sameRoomDoorPlan(map, 38, geo,
    { row: 9, col: 28, x: 1795, y: 616 }, { row: 7, col: 30 });
  assert.deepEqual(plan?.doors.map(({ row, col }) => ({ row, col })), [{ row: 9, col: 32 }]);
}
for (const from of [hall, ...chambers]) for (const to of [hall, ...chambers]) {
  const plan = sameRoomDoorPlan(map, room.num, geo, body(from), to);
  assert.ok(plan, `route from r${from.row}c${from.col} to r${to.row}c${to.col}`);
  const expected = from === to ? [] : [
    ...(from === hall ? [] : [{ row: 8, col: from.col }]),
    ...(to === hall ? [] : [{ row: 9, col: to.col }]),
  ];
  assert.deepEqual(plan.doors.map(({ row, col }) => ({ row, col })), expected);
  assert.equal(plan.walkable, expected.length === 0);
  assert.ok(plan.doors.every(d => d.to === 38), 'the route stays on the ground floor');
  routes++;
}

function keeper({ fails = false, cancel = false, refused = false } = {}) {
  const k = Object.create(Autopilot.prototype), crossed = [], deferred = [], events = [];
  const s = {
    world: { map, room, geometry: geo },
    client: { self: body(chambers[0]) }, movementGeneration: 7,
    movementWasCancelled: () => false,
    async crossSameRoomDoor(door, options) {
      crossed.push(door);
      assert.equal(options.movementGeneration, 7);
      events.push('door');
      if (cancel) return { cancelled: true };
      if (fails) return { crossed: false, reason: 'go_did_nothing' };
      s.client.self = body({ row: door.arriveRow, col: door.arriveCol });
      return { crossed: true, at: s.client.self };
    },
  };
  Object.assign(k, {
    s, policy: { requireSafeWall: false, confineRooms: [38] },
    async leaveHold() { events.push('release'); return { refused }; },
    async crossSameRoomIsland() { assert.fail('internal rooms must not use upstairs bridging'); },
    deferPullTarget: (...args) => deferred.push(args),
    progress() {}, noProgress() {}, note() {},
  });
  return { k, crossed, deferred, events };
}
const quarry = { id: 123, ...chambers[2] };
{
  const { k, crossed, events } = keeper();
  assert.equal(await k.bridgeToQuarry(quarry), true);
  assert.equal(crossed.length, 1, 'one crossing per pass, even for a two-door route');
  assert.deepEqual(events, ['release', 'door']);
  assert.deepEqual({ row: crossed[0].row, col: crossed[0].col }, { row: 8, col: 4 });
  assert.equal(k.foeId, quarry.id, 'retain the selected quarry across door legs');
  assert.equal(await k.bridgeToQuarry(quarry), true);
  assert.equal(crossed.length, 2);
  assert.deepEqual({ row: crossed[1].row, col: crossed[1].col }, { row: 9, col: 26 });
  assert.equal(await k.bridgeToQuarry(quarry), false, 'combat continues on the reached side');
  assert.equal(crossed.length, 2, 'no return-door loop after arriving');
}
{
  const { k, crossed } = keeper();
  await k.bridgeToQuarry(quarry);
  assert.equal(await k.bridgeToQuarry({ ...quarry, ...hall }), false,
    'replan the moved quarry instead of executing a stale second door');
  assert.equal(crossed.length, 1);
  assert.equal(await k.bridgeToQuarry(undefined), false, 'absent quarry causes no movement');
}
for (const option of ['fails', 'cancel', 'refused']) {
  const { k, crossed, deferred } = keeper({ [option]: true });
  assert.equal(await k.bridgeToQuarry(quarry), true);
  assert.equal(crossed.length, option === 'refused' ? 0 : 1);
  assert.equal(deferred.length, option === 'fails' ? 1 : 0,
    'door refusal cools the target; cancellation and recovery do not');
}
// A neighbouring-room shortcut must not exclude a confined target reachable
// through a self-room door. This fixture makes both alternatives explicit.
{
  const split = { rooms: {
    1: { num: 1, goExits: [
      { row: 2, col: 2, to: 1, arriveRow: 2, arriveCol: 20 },
      { row: 2, col: 3, to: 2 },
    ] },
    2: { num: 2, goExits: [{ row: 1, col: 1, to: 1, arriveRow: 2, arriveCol: 20 }] },
  } };
  const g = { walkable: () => true,
    path: (_r, c, _tr, tc) => ({ found: (c < 10) === (tc < 10), steps: [] }) };
  assert.equal(quarryPermittedByConfinement({ map: split, room: 1, geo: g,
    from: { row: 2, col: 1 }, target: { row: 3, col: 20 }, confineRooms: [1] }), true);
}
console.log(`${routes} Castle chamber routes and keeper crossing regressions passed`);
