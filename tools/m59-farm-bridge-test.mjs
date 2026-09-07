#!/usr/bin/env node
// Offline regression: open-ground farming still takes doors between room islands.
import assert from 'node:assert/strict';
import { Autopilot } from './m59-autopilot.mjs';
import { larderOf } from './m59-skills.mjs';

const map = { rooms: {
  39: { num: 39, name: 'Upstairs', goExits: [{ row: 2, col: 2, to: 38 }] },
  38: { num: 38, name: 'Castle', goExits: [
    { row: 1, col: 2, to: 39, arriveRow: 2, arriveCol: 2 },
    { row: 1, col: 20, to: 39, arriveRow: 2, arriveCol: 20 },
  ] },
} };
const geo = {
  walkable: () => true,
  path: (_r, fromCol, _tr, toCol) => ({ found: (fromCol < 10) === (toCol < 10), steps: [] }),
};
const remote = { id: 100, row: 3, col: 20 };
function keeper({ confined = null, fails = false } = {}) {
  const k = Object.create(Autopilot.prototype), plans = [], deferred = [];
  Object.assign(k, {
    policy: { requireSafeWall: false, useSafeSpots: false, confineRooms: confined },
    s: { world: { map, room: map.rooms[39], geometry: geo }, client: { self: { row: 3, col: 3 } } },
    crossSameRoomIsland: async plan => { plans.push(plan); return { arrived: !fails, reason: 'blocked' }; },
    progress() {}, noProgress() {}, note() {},
    deferPullTarget: (...args) => deferred.push(args),
  });
  return { k, plans, deferred };
}
{
  const { k, plans } = keeper();
  assert.equal(await k.bridgeToQuarry(remote), true);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].viaRoom, 38);
  assert.deepEqual(plans[0].returnDoors.map(d => d.arriveCol), [20]);
  assert.equal(await k.bridgeToQuarry({ id: 101, row: 3, col: 5 }), false);
  assert.equal(plans.length, 1, 'reachable prey does not need a round trip');
}
{
  const { k, deferred } = keeper({ fails: true });
  assert.equal(await k.bridgeToQuarry(remote), true, 'a failed bridge still ends the stale pass');
  assert.equal(deferred[0][1], remote.id, 'failed quarry cannot be immediately reissued');
}
{
  const farm = Autopilot.prototype.passFarm.toString();
  assert.ok(farm.indexOf('this.bridgeToQuarry(found[0])') < farm.indexOf('this.holdWorthwhile('),
    'bridge dispatch is upstream of optional wall selection in the actual farming stage');
}
{
  const names = new Map([[1, 'Inky-cap mushroom'], [2, 'loaf of bread']]);
  const c = { inventory: [{ nameRsc: 1, amount: 7 }, { nameRsc: 2, amount: 1 }], rsc: { get: n => names.get(n) } };
  const food = larderOf(c, { exclude: ['inky cap mushroom'] });
  assert.deepEqual(food.map(x => x.name), ['loaf of bread']);
  assert.equal(food.reduce((sum, x) => sum + x.food.nutrition * (x.o.amount || 1), 0), 20);
}
console.log('farm bridge and protected larder regressions passed');
