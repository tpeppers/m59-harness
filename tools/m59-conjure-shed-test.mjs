// OFFLINE. Pins Autopilot.shedUnusedConjures: unused conjured weapons are dropped whether or not they
// are banned; the weapon in hand, one spare of the training weapon, looted weapons and protected
// names stay; it is throttled and stands down while something is hitting us.
// `node tools/m59-conjure-shed-test.mjs`.
import assert from 'node:assert/strict';
import { Autopilot } from './m59-autopilot.mjs';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok', name); };

function rig({ items, equipped = [], descriptions = {}, trainingWeapon = 'axe', protect = [], landing = 0 }) {
  const drops = [];
  let looking = null;
  const c = {
    inventory: items.map(([id, name]) => ({ id, name, flags: 16 })), evSeq: 0,
    rsc: { get: () => undefined },
    equipment: () => ({ known: true, equipped: equipped.map(id => ({ id })) }),
    look(id) { looking = id; },
    drop(list) { for (const spec of list) { const id = spec?.id ?? spec; drops.push(id); this.inventory = this.inventory.filter(o => o.id !== id); } },
    requestInventory() { looking = null; },
    async waitFor() { return { events: looking ? [{ id: looking, description: descriptions[looking] ?? 'It shimmers insubstantially.' }] : [] }; },
  };
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, { s: { client: c, movementGeneration: 1, pacer: { submit: async (_, fn) => fn() } },
    policy: { trainingWeapon }, tally: {}, journal: [], note(what, d) { this.journal.push({ what, ...d }); },
    threat: () => ({ landing }), protectedItemNames: () => protect });
  return { k, c, drops };
}

await test('drops unused conjured weapons of any allowed kind, keeps hand + one training spare + loot', async () => {
  const { k, drops } = rig({
    items: [[1, 'axe'], [2, 'axe'], [3, 'axe'], [4, 'long sword'], [5, 'long sword'], [6, 'long sword'], [7, 'hammer']],
    equipped: [1], descriptions: { 6: 'A well-balanced long sword.' } });
  await k.shedUnusedConjures();
  assert.ok(!drops.includes(1), 'the axe in hand stays');
  assert.equal([2, 3].filter(id => drops.includes(id)).length, 1, 'exactly one spare axe is kept');
  assert.ok(drops.includes(4) && drops.includes(5) && drops.includes(7), 'conjured swords and hammer go');
  assert.ok(!drops.includes(6), 'a looted long sword (no shimmer) stays as sale stock');
  assert.equal(k.tally.conjures_shed, 4);
  assert.ok(k.journal.some(n => n.what === 'dropped conjured weapons nobody is using'));
  assert.ok(k.ordinaryBannedIds.has(6), 'the looted one is remembered, not looked at again');
});

await test('protected names stay, and it is throttled', async () => {
  const { k, drops } = rig({ items: [[1, 'long sword'], [2, 'mace']], protect: ['mace'] });
  await k.shedUnusedConjures();
  assert.deepEqual(drops, [1]);
  const again = rig({ items: [[3, 'long sword']] });
  again.k._conjureShedAt = Date.now();
  await again.k.shedUnusedConjures();
  assert.deepEqual(again.drops, [], 'not again within the gap');
});

await test('stands down while something is hitting us, and when dropJunk is off', async () => {
  let r = rig({ items: [[1, 'long sword']], landing: 1 });
  await r.k.shedUnusedConjures();
  assert.deepEqual(r.drops, []);
  r = rig({ items: [[1, 'long sword']] });
  r.k.policy.dropJunk = false;
  await r.k.shedUnusedConjures();
  assert.deepEqual(r.drops, []);
});

// THE LOOTED PILE (2026-10-07): Castle Victoria's skeletons drop worn long swords; maxWeapons was
// applied only when selling or clearing a full pack, so 20-29 rode along in every pack.
await test('field cap: spares over maxWeapons go, duplicates first, and are remembered as shed', async () => {
  const items = [[1, 'axe'], [2, 'axe'], ...Array.from({ length: 6 }, (_, i) => [10 + i, 'long sword']), [20, 'mace']];
  const desc = Object.fromEntries(items.map(([id]) => [id, 'A real weapon.']));     // none conjured
  const { k, drops } = rig({ items, equipped: [1], descriptions: desc });
  k.policy.maxWeapons = 2;
  await k.shedUnusedConjures();
  // spares: axe#2 is the kept training spare; 6 swords + mace = 7 counted, cap 2 -> 5 dropped
  assert.equal(drops.length, 5, `dropped ${drops.length}`);
  assert.ok(!drops.includes(1) && !drops.includes(2), 'hand and training spare kept');
  assert.ok(!drops.includes(20), 'the single mace outranks a fifth duplicate sword');
  assert.ok(drops.every(id => k.s._shedIds.has(id)), 'every shed id is remembered for the looter');
  assert.equal(k.fieldSpareWeapons().length, 2);
  const cap = k.fieldWeaponCap();
  assert.equal(cap.max, 2); assert.equal(cap.count(), 2, 'the looter sees the cap is reached');
});

await test('no cap configured, or dropJunk off: nothing is shed by the cap and the looter is not limited', async () => {
  const items = Array.from({ length: 5 }, (_, i) => [i + 1, 'long sword']);
  const desc = Object.fromEntries(items.map(([id]) => [id, 'A real weapon.']));
  let r = rig({ items, descriptions: desc });
  delete r.k.policy.maxWeapons;
  await r.k.shedUnusedConjures();
  assert.deepEqual(r.drops, []); assert.equal(r.k.fieldWeaponCap(), null);
  r = rig({ items, descriptions: desc });
  r.k.policy.maxWeapons = 1; r.k.policy.dropJunk = false;
  await r.k.shedUnusedConjures();
  assert.deepEqual(r.drops, []); assert.equal(r.k.fieldWeaponCap(), null);
});

console.log(`${passed} conjure-shed cases passed`);
