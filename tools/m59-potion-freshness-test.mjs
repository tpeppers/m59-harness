// Spoiled potions are dropped on a timer, by looking (m59-potion-freshness.mjs). Offline: a fake session whose LOOK
// answers from a table, the real compiled potion descriptions (substrate/m59-potions.json), a fake clock.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PotionFreshness, SWEEP_MS } from './m59-potion-freshness.mjs';

const potions = JSON.parse(readFileSync(new URL('../substrate/m59-potions.json', import.meta.url), 'utf8')).potions;
const catalogue = () => new Map(potions.map(p => [p.name.toLowerCase(), p]));
const strength = potions.find(p => p.name === 'potion of super strength');
let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log('ok ' + name); };

function session(items, descriptions) {
  const names = new Map(items.map(i => [i.nameRsc, i.name]));
  const c = { state: 'game', evSeq: 0, inventory: items.map(i => ({ id: i.id, nameRsc: i.nameRsc, amount: 1 })),
    rsc: { get: k => names.get(k) }, looks: [], drops: [], events: [],
    look(id) { this.looks.push(id); this.evSeq++; this.events.push({ kind: 'look', id, seq: this.evSeq, description: descriptions[id] }); },
    async waitFor({ since, match }) { return { events: this.events.filter(e => e.seq > since && match(e)) }; },
    drop(specs) { for (const sp of specs) { this.drops.push(sp.id ?? sp); this.inventory = this.inventory.filter(o => o.id !== (sp.id ?? sp)); } } };
  return { client: c, live: true, pacer: { submit: async (_k, fn) => fn() } };
}
const items = [{ id: 11, nameRsc: 1, name: 'potion of super strength' }, { id: 12, nameRsc: 2, name: 'long sword' }];

await test('a spoiled potion (the kod bad description) is dropped; a sword is never looked at', async () => {
  const s = session(items, { 11: strength.bad_description });
  const r = await new PotionFreshness({ catalogue }).tick(s);
  assert.equal(r.action, 'spoiled_dropped'); assert.deepEqual(s.client.drops, [11]); assert.deepEqual(s.client.looks, [11]);
});
await test('a fresh potion is kept, and not looked at again until the sweep interval has passed', async () => {
  let t = 1_000_000; const s = session(items, { 11: strength.good_description });
  const f = new PotionFreshness({ catalogue, now: () => t });
  assert.equal((await f.tick(s)).action, 'fresh');
  assert.equal(await f.tick(s), null); t += SWEEP_MS - 1; assert.equal(await f.tick(s), null);
  t += 1; assert.equal((await f.tick(s)).action, 'fresh');
  assert.deepEqual(s.client.drops, []); assert.equal(s.client.looks.length, 2);
});
await test('an unrecognised description is kept, never dropped on a guess', async () => {
  const s = session(items, { 11: 'This is a glass vial of something.' });
  assert.equal((await new PotionFreshness({ catalogue }).tick(s)).action, 'unknown'); assert.deepEqual(s.client.drops, []);
});
await test('no LOOK reply is not a verdict: nothing dropped', async () => {
  const s = session(items, {}); s.client.waitFor = async () => ({ events: [] });
  assert.equal(await new PotionFreshness({ catalogue }).tick(s), null); assert.deepEqual(s.client.drops, []);
});
await test('nothing happens while the keeper is busy (fighting, held, parked)', async () => {
  const s = session(items, { 11: strength.bad_description });
  assert.equal(await new PotionFreshness({ catalogue }).tick(s, { allowed: () => false }), null);
  assert.deepEqual(s.client.looks, []); assert.deepEqual(s.client.drops, []);
});
await test('one LOOK per tick when several potions are due', async () => {
  const two = [...items, { id: 13, nameRsc: 3, name: 'potion of super strength' }];
  const s = session(two, { 11: strength.good_description, 13: strength.bad_description });
  const f = new PotionFreshness({ catalogue });
  await f.tick(s); assert.equal(s.client.looks.length, 1);
  await f.tick(s); assert.equal(s.client.looks.length, 2); assert.deepEqual(s.client.drops, [13]);
});
console.log(count + ' potion freshness checks passed');
