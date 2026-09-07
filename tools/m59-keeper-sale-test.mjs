import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as skills from './m59-skills.mjs';
const source = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
const start = source.indexOf("case 'sell_all': {");
const end = source.indexOf('// APPLY IS NOT USE', start);
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const dispatch = new AsyncFunction('session', 'args', 'skills', 'autopilot', 'setTimeout',
  `let result; switch ('sell_all') { ${source.slice(start, end)} } return result;`);
function session({ known = true, accept = true } = {}) {
  const names = new Map([[1, 'axe'], [2, 'long sword'], [3, 'amber'], [4, 'shilling']]);
  const c = {
    inventory: [{ id: 1, nameRsc: 1, amount: 0 }, { id: 2, nameRsc: 2, amount: 0 }, { id: 3, nameRsc: 2, amount: 0 },
      { id: 4, nameRsc: 3, amount: 40 }, { id: 5, nameRsc: 4, amount: 10 }],
    rsc: { get: key => names.get(key) },
    equipment: () => ({ known, equipped: [{ id: 1, name: 'axe' }] }),
    room: { objects: new Map([[99, { id: 99 }]]) }, evSeq: 1, offered: [],
    offer(_merchant, items) { this.offered.push(items[0]); this.pending = items[0]; this.trade = { theirs: [{ amount: 5 }] }; },
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
  return { client: c, pacer: { submit: async (_kind, fn) => fn() } };
}
const run = (s, args = {}) => dispatch(s, { merchant: 99, max_weapons: 1, max_stack: 25, ...args },
  skills, { protectedItemNames: () => [], policy: {} }, fn => fn());
const s = session();
const result = await run(s);
assert.equal(result.sold.filter(o => o.name === 'long sword').length, 2, 'both duplicate spare weapons are sold');
assert.deepEqual(result.sold.filter(o => o.name === 'amber').map(o => o.amount), [25, 15]);
assert.deepEqual(s.client.inventory.map(o => o.id), [1, 5], 'worn weapon and money remain');
const protectedPack = session();
await run(protectedPack, { keep: ['amber'] });
assert.equal(protectedPack.client.inventory.find(o => o.id === 4).amount, 40);
const unknown = session({ known: false });
assert.match((await run(unknown)).error, /equipment is not known/);
assert.equal(unknown.client.offered.length, 0);
const refused = session({ accept: false });
assert.equal((await run(refused)).sold.length, 0, 'an unchanged inventory is not a confirmed sale');
console.log('keeper sales handle equipment, duplicate loot, capped stacks, and inventory receipts');
