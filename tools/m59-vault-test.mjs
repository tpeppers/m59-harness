#!/usr/bin/env node
import assert from 'node:assert/strict';
import { BP, M59Client } from './m59-client.mjs';
import { depositInVault, itemIsProtected, itemNameMatches } from './m59-skills.mjs';
import { resolveItemNames } from './m59-items.mjs';

assert.equal(itemNameMatches('Inky-cap mushroom', 'inky cap mushrooms'), true);
assert.equal(itemNameMatches('dark angel feather', 'Dark Angel Feathers'), true);
assert.equal(itemIsProtected('purple mushroom', ['inky cap mushroom']), false);
assert.equal(itemIsProtected('mushroom', ['inky cap mushroom']), false);
assert.equal(itemIsProtected('Inky-cap mushroom', ['mushroom']), false);
assert.equal(itemIsProtected('red mushroom', ['mushroom']), false);
assert.deepEqual(resolveItemNames(['inky cap mushrooms', 'arrow', 'nerudite arrow']),
  ['Inky-cap mushroom', 'arrows', 'nerudite arrows']);
assert.deepEqual(resolveItemNames(['mushroom']), ['mushroom']);
assert.throws(() => resolveItemNames(['mush']), /does not resolve/);
assert.throws(() => resolveItemNames(['inkycap mushroom']), /does not resolve/);

const sent = [];
M59Client.prototype.depositItems.call({ send: (...args) => sent.push(args) }, 4321,
  [{ id: 77, amount: 4 }, 88]);
assert.equal(sent[0][0], BP.REQ_DEPOSIT);
assert.equal(sent[0][1].readUInt32LE(0), 4321);
assert.equal(sent[0][2].readUInt16LE(0), 2);
assert.equal(sent[0][2].readUInt32LE(2) >>> 28, 1);
assert.equal(sent[0][2].readUInt32LE(6), 4);

const names = new Map([[1, 'Inky-cap mushroom'], [2, 'dark angel feather'], [3, 'purple mushroom']]);
const client = {
  inventory: [
    { id: 71, nameRsc: 1, amount: 5 },
    { id: 72, nameRsc: 2, amount: 0 },
    { id: 73, nameRsc: 3, amount: 2 },
  ],
  rsc: { get: id => names.get(id) },
  evSeq: 0,
  requestInventory() {},
  depositItems(vaultman, items) {
    assert.equal(vaultman, 9001);
    assert.deepEqual(items, [{ id: 71, amount: 5 }, 72]);
    this.inventory = this.inventory.filter(item => item.id === 73);
  },
  async waitFor({ kinds }) {
    return { events: kinds.includes('message') ? [{ kind: 'message', text: 'stored' }] : [] };
  },
};
const session = { need: () => client, pacer: { submit: async (_kind, fn) => fn() } };
const result = await depositInVault(session, {
  vaultman: 9001,
  items: ['inky cap mushrooms', 'dark angel feathers'],
});
assert.equal(result.verified, true);
assert.deepEqual(result.deposited, [
  { name: 'Inky-cap mushroom', amount: 5 },
  { name: 'dark angel feather', amount: 1 },
]);
assert.equal(client.inventory[0].id, 73);

client.inventory = [{ id: 71, nameRsc: 2, amount: 0 }, { id: 72, nameRsc: 2, amount: 0 }];
client.depositItems = function (_vaultman, specs) {
  assert.deepEqual(specs, [71, 72]);
  this.inventory = this.inventory.filter(o => o.id === 72);
};
const partial = await depositInVault(session, { vaultman: 9001, items: ['dark angel feather'] });
assert.deepEqual(partial.deposited, [{ name: 'dark angel feather', amount: 1 }]);
assert.deepEqual(partial.refused, ['dark angel feather']);
client.depositItems = () => {};
const refused = await depositInVault(session, { vaultman: 9001, items: ['dark angel feather'] });
assert.equal(refused.verified, false);
assert.deepEqual(refused.deposited, []);
assert.deepEqual(refused.refused, ['dark angel feather']);
console.log('vault: inventory removal and singleton refusals verified');
