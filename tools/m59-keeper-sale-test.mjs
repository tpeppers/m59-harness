import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as skills from './m59-skills.mjs';
import { Session } from './m59-game.mjs';
import { saleBlocked } from './m59-inventory-intent.mjs';
import { FLEET_KEEP } from './m59-items.mjs';
import { OF } from './m59-parse.mjs';
const source = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
const start = source.indexOf("case 'sell_all': {");
const end = source.indexOf('// APPLY IS NOT USE', start);
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const dispatch = new AsyncFunction('session', 'args', 'skills', 'autopilot', 'setTimeout', 'FLEET_KEEP', 'saleBlocked',
  `let result; switch ('sell_all') { ${source.slice(start, end)} } return result;`);
function session({ known = true, accept = true } = {}) {
  const names = new Map([[1, 'axe'], [2, 'long sword'], [3, 'amber'], [4, 'shilling']]);
  const c = {
    inventory: [{ id: 1, nameRsc: 1, amount: 0 }, { id: 2, nameRsc: 2, amount: 0 }, { id: 3, nameRsc: 2, amount: 0 },
      { id: 4, nameRsc: 3, amount: 51 }, { id: 5, nameRsc: 4, amount: 10 }],
    rsc: { get: key => names.get(key) },
    using: known ? new Set([1]) : null,
    equipment: () => ({ known, equipped: [{ id: 1, name: 'axe' }] }),
    room: { objects: new Map([[99, { id: 99 }]]) }, evSeq: 1, offered: [],
    offer(_merchant, items) {
      const spec = items[0], id = spec.id ?? spec;
      if (this.inventory.find(o => o.id === id)?.amount > 0)
        assert.ok(spec.amount > 0, 'every NumberItem offer includes its quantity, even one');
      this.offered.push(spec); this.pending = spec; this.trade = { theirs: [{ amount: 5 }] };
    },
    acceptOffer() {
      if (!accept) return;
      const id = this.pending.id ?? this.pending;
      const o = this.inventory.find(o => o.id === id);
      const amount = this.pending.amount ?? 1;
      if ((o.amount || 1) > amount) o.amount -= amount;
      else this.inventory = this.inventory.filter(o => o.id !== id);
    },
    cancelOffer() {}, requestInventory() {},
    waitFor: async () => ({ events: [{ kind: 'countered' }] }),
  };
  return { client: c, need: () => c, movementGeneration: 0, startJob: Session.prototype.startJob,
    runCommand: Session.prototype.runCommand,
    pacer: { submit: async (_kind, fn) => fn() } };
}
const run = (s, args = {}) => dispatch(s, { merchant: 99, max_weapons: 1, max_stack: 25, ...args },
  skills, { protectedItemNames: () => [], policy: {} }, fn => fn(), FLEET_KEEP, saleBlocked);
const s = session();
const result = await run(s);
assert.equal(result.sold.filter(o => o.name === 'long sword').length, 2, 'both duplicate spare weapons are sold');
assert.deepEqual(result.sold.filter(o => o.name === 'amber').map(o => o.amount), [25, 25, 1]);
assert.deepEqual(s.client.inventory.map(o => o.id), [1, 5], 'worn weapon and money remain');
const protectedPack = session();
await run(protectedPack, { keep: ['amber'] });
assert.equal(protectedPack.client.inventory.find(o => o.id === 4).amount, 51);
const unknown = session({ known: false });
assert.match((await run(unknown)).error, /equipment is not known/);
assert.equal(unknown.client.offered.length, 0);
const refused = session({ accept: false });
assert.equal((await run(refused)).sold.length, 0, 'an unchanged inventory is not a confirmed sale');
const batches = session();
let resume = {}, receipts = [], batch;
do {
  batch = await run(batches, { max_offers: 1, ...resume });
  assert.ok(batch.sold.length <= 1, 'each HTTP call has bounded work');
  receipts.push(...batch.sold); resume = batch.resume;
} while (batch.more);
assert.equal(receipts.length, 5, 'all duplicate blades and gem chunks finish across batches');
const occupied = session();
occupied.job = { done: false, label: 'walking' };
assert.match((await run(occupied)).error, /busy: walking/);
assert.equal(occupied.client.offered.length, 0, 'commerce cannot overlap another body job');

const oneStart = source.indexOf("case 'sell_one': {");
const oneEnd = source.indexOf("case 'confirm_position':", oneStart);
const sellOneAction = new AsyncFunction('session', 'args', 'json', 'OF',
  `switch ('sell_one') { ${source.slice(oneStart, oneEnd)} }`);
const one = session();
one.client.room.objects.set(99, { id: 99, flags: OF.BUYABLE });
one.client.room.objects.set(100, { id: 100, flags: OF.PLAYER | OF.BUYABLE });
one._tickLoop = { _frozen: false };
const calls = [];
one.sellOne = async (merchant, item, confirm) => {
  assert.equal(one.job.kind, 'commerce:sell');
  assert.equal(one.job.done, false);
  assert.equal(one._tickLoop._frozen, true);
  calls.push({ merchant, item, confirm });
  return { sold: confirm, offered_price: 5 };
};
const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
const methodStart = broker.indexOf('  async sellOne(');
const methodEnd = broker.indexOf('  async shortHop(', methodStart);
const keeperAction = async (agent, index, name, args) => {
  assert.deepEqual([agent, index, name], ['keeper', 1, 'sell_one']);
  let result;
  await sellOneAction(one, args, value => { result = value; }, OF);
  return result;
};
const KeeperProxy = Function('keeperAction', `return class KeeperProxy {
  name = 'keeper'; _index = 1; need() { return {}; }
  ${broker.slice(methodStart, methodEnd)}
}`)(keeperAction);
const sellStart = broker.indexOf("name: 'sell',");
const runStart = broker.indexOf('run: ', sellStart) + 'run: '.length;
const runEnd = broker.indexOf('\n    },', runStart) + '\n    }'.length;
const proxy = new KeeperProxy();
const sell = Function('session', 'resolveTarget', 'KeeperProxy', `return (${broker.slice(runStart, runEnd)});`)(
  () => proxy, (_, id) => ({ id }), KeeperProxy);
const order = { agent: 'keeper', to: 99, items: [{ id: 4, amount: 3 }] };
assert.deepEqual(await sell({ ...order, confirm: false }), { sold: false, offered_price: 5 });
assert.deepEqual(await sell(order), { sold: true, offered_price: 5 });
assert.deepEqual(calls, [
  { merchant: 99, item: { id: 4, amount: 3 }, confirm: false },
  { merchant: 99, item: { id: 4, amount: 3 }, confirm: true },
]);
assert.equal(one._tickLoop._frozen, false);
await assert.rejects(sell({ ...order, items: [2, 3] }), /one item or stack/);
assert.match((await sell({ ...order, to: 100 })).error, /merchant in this room/);
assert.match((await sell({ ...order, to: 101 })).error, /merchant in this room/);
one.job = { done: false, label: 'walking' };
assert.match((await sell(order)).error, /busy: walking/);
assert.equal(calls.length, 2, 'rejected requests never reach the trade');
console.log('keeper sales handle equipment, duplicate loot, capped stacks, and inventory receipts');
