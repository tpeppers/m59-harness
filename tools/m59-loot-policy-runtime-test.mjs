import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(), 'm59-loot-runtime-test-'));
process.env.M59_FLEET = 'loot-policy-offline-test';
process.env.M59_LEDGER_DIR = join(scratch, 'ledger');
process.env.M59_INVENTORY_INTENT_DIR = join(scratch, 'intent');
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const { Session } = await import('./m59-game.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const { OF } = await import('./m59-parse.mjs');
const skills = await import('./m59-skills.mjs');
const { saleBlocked } = await import('./m59-inventory-intent.mjs');
const { blankLootPolicies } = await import('./m59-loot-policies.mjs');
const { dropTownDispositions, dispositionBlock } = await import('./m59-loot-policy-runtime.mjs');

function fixture(action = 'vault') {
  const document = blankLootPolicies(); document.profiles.test = { name: 'Test', rules: [{ item: 'purple mushroom', action }] }; document.assignments.fleet = 'test';
  const s = new Session('test');
  const objects = new Map(), events = [], got = [], notes = [], deposits = [];
  let seq = 0;
  const c = { me: { name: 'Example' }, using: new Set(), selfId: 1, self: { col: 10, row: 10 }, room: { objects }, inventory: [],
    rsc: { get: name => name || '' }, get evSeq() { return seq; }, roomContents() {}, requestInventory() {},
    equipment: () => ({ known: true, equipped: [] }),
    waitFor: async ({ since = 0, kinds = [] }) => ({ events: events.filter(e => e.seq > since && kinds.includes(e.kind)) }),
    get: id => { got.push(id); c.inventory.push(objects.get(id)); objects.delete(id); events.push({ seq: ++seq, kind: 'got', id }); },
    drop: specs => { const ids = specs.map(x => typeof x === 'number' ? x : x.id); c.inventory = c.inventory.filter(o => !ids.includes(o.id)); },
    depositItems: (_id, specs) => { deposits.push(...specs); c.drop(specs); } };
  s.client = c; s.need = () => c; s.pacer = { submit: async (_key, fn) => fn() }; s.world = { room: { num: 54, name: 'town' } };
  s.lootPolicyStore = { read: () => document };
  const item = (id, name = 'purple mushroom') => ({ id, nameRsc: name, col: 10, row: 10, flags: OF.GETTABLE, amount: 1 });
  const ap = { s, policy: { maxWeapons: 2 }, weaponPriorityNow: () => null, inheritedProtectedNames: () => [], loadout: () => null,
    travelInterrupted: () => false, note: (...args) => notes.push(args) };
  return { s, c, ap, item, document, objects, got, deposits, notes };
}
test('real lootFloor permits a vault rule over ignore and per-creature filters', async () => {
  const w = fixture(); w.objects.set(2, w.item(2)); w.s.setLootIgnore(['purple mushroom']); w.s.setLootOnly({ spider: ['emerald'] });
  await w.s.lootFloor({ kill: { name: 'spider', before: [] } }); assert.deepEqual(w.got, [2]);
});
test('real lootFloor refuses leave and keeps the cursed pickup guard above policy', async () => {
  const w = fixture('leave'); w.objects.set(2, w.item(2)); await w.s.lootFloor(); assert.deepEqual(w.got, []);
  w.document.profiles.test.rules = [{ item: 'ring of lethargy', action: 'vault' }]; w.objects.clear(); w.objects.set(3, w.item(3, 'ring of lethargy'));
  await w.s.lootFloor(); assert.deepEqual(w.got, []);
});
test('sale plan and final sale guard agree on vault/keep/leave/drop and allow sell', () => {
  const w = fixture(); w.c.inventory = [w.item(2)];
  for (const action of ['vault', 'keep', 'leave', 'drop_town']) {
    w.document.profiles.test.rules[0].action = action;
    const plan = skills.inventorySalePlan(w.s); assert.equal(plan.items[0].queued, false, action);
    assert.ok(saleBlocked(w.s, { id: 2, name: 'purple mushroom' }), action);
  }
  w.document.profiles.test.rules[0].action = 'sell';
  assert.equal(skills.inventorySalePlan(w.s).items[0].queued, true);
  w.c.using.add(2); assert.equal(skills.inventorySalePlan(w.s).items[0].queued, false, 'equipped wins');
});
test('vault deposition verifies inventory delta and never deposits a keep disposition', async () => {
  const w = fixture(); w.c.inventory = [w.item(2)];
  const result = await skills.depositInVault(w.s, { vaultman: 99, items: ['purple mushroom'], allowItem: o => !dispositionBlock(w.ap, o) });
  assert.equal(result.deposited[0].amount, 1);
  w.document.profiles.test.rules[0].action = 'keep'; w.c.inventory = [w.item(3)];
  const second = await skills.depositInVault(w.s, { vaultman: 99, items: ['purple mushroom'] });
  assert.deepEqual(second.deposited, []); assert.equal(w.c.inventory.length, 1);
});
test('end-of-trip drop refuses wrong rooms, fights, equipped gear and carry reserves', async () => {
  const w = fixture('drop_town'); w.c.inventory = [w.item(2)];
  await dropTownDispositions(w.ap, [99]); assert.equal(w.c.inventory.length, 1);
  w.s.combat = { active: true }; await dropTownDispositions(w.ap, [54]); assert.equal(w.c.inventory.length, 1); w.s.combat.active = false;
  w.c.using.add(2); await dropTownDispositions(w.ap, [54]); assert.equal(w.c.inventory.length, 1); w.c.using.clear();
  w.ap.loadout = () => ({ carry: [{ item: 'purple mushroom', min: 1, max: 1 }], keep: [], sell: [], gear: { weapon: [], slots: {} } });
  await dropTownDispositions(w.ap, [54]); assert.equal(w.c.inventory.length, 1);
  w.ap.loadout = () => null;
  const result = await dropTownDispositions(w.ap, [54]); assert.equal(result.dropped[0].amount, 1); assert.equal(w.c.inventory.length, 0);
  assert.ok(w.s._shedIds.has(2), 'do not immediately re-loot a designated drop');
});
test('condition unknown keeps an item out of both sale and vault', async () => {
  const w = fixture(); w.c.inventory = [w.item(2)]; Object.assign(w.document.profiles.test.rules[0], { min_condition: 3, otherwise: 'sell' });
  assert.equal(skills.inventorySalePlan(w.s).items[0].queued, false);
  const result = await skills.depositInVault(w.s, { vaultman: 99, items: ['purple mushroom'] }); assert.deepEqual(result.deposited, []);
});

test('same-name quality variants are sold or vaulted per object, not protected as one name', () => {
  const w = fixture(); w.c.inventory = [w.item(2), w.item(3)];
  Object.assign(w.document.profiles.test.rules[0], { min_condition: 3, otherwise: 'sell' });
  w.c._lootCondition = new Map([[2, { name: 'purple mushroom', level: 4, at: Date.now() }], [3, { name: 'purple mushroom', level: 2, at: Date.now() }]]);
  w.ap.policy.vaultItems = ['purple mushroom'];
  w.ap.protectedItemNames = Autopilot.prototype.protectedItemNames;
  const protect = Autopilot.prototype.saleProtectedNames.call(w.ap);
  const plan = skills.inventorySalePlan(w.s, { protect });
  assert.equal(plan.items.find(o => o.id === 2).queued, false);
  assert.equal(plan.items.find(o => o.id === 3).queued, true);
});
