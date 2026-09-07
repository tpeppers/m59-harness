import assert from 'node:assert/strict';
import { Autopilot, HANDLED } from './m59-autopilot.mjs';

const order = [];
let armed = false;
const client = { equipment: () => ({ known: true, equipped: armed ? [{ name: 'mace' }] : [] }) };
const keeper = Object.assign(Object.create(Autopilot.prototype), {
  s: { client }, policy: {}, trainingStyleFor: () => 'melee',
  sweepBroken: async () => { order.push('clear broken gear'); },
  armSelf: async () => { order.push('make replacement'); armed = true; return true; },
  progress() {},
});
assert.equal(await keeper.passArm({ c: client, s: keeper.s }), HANDLED);
assert.deepEqual(order, ['clear broken gear', 'make replacement']);

const dropped = [];
const c = { inventory: [{ id: 1, nameRsc: 1 }, { id: 2, nameRsc: 2 }],
  using: new Set(), _brokenWeapons: new Set([1, 2]),
  rsc: { get: id => id === 1 ? 'helmet' : 'collection relic' },
  drop: specs => dropped.push(...specs.map(x => x.id)), requestInventory() {},
  waitFor: async () => ({}),
};
const sweep = Object.assign(Object.create(Autopilot.prototype), {
  policy: { dropJunk: true, vaultItems: ['collection relic'] },
  s: { need: () => c, pacer: { submit: async (_kind, fn) => fn() } },
  dropSpec: x => ({ id: x.id }), note() {},
});
await sweep.sweepBroken();
assert.deepEqual(dropped, [1], 'cleanup preserves the director collection policy');
sweep.policy.dropJunk = false;
assert.equal(await sweep.sweepBroken(), null, 'the existing drop switch still controls cleanup');
console.log('rearming cleans broken gear before replacement and preserves collection cargo');
