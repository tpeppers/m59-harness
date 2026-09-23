import assert from 'node:assert/strict';
import { clearConjureHoard } from './m59-conjure-cleanup.mjs';
import { Autopilot } from './m59-autopilot.mjs';

function rig({ descriptions = ['It shimmers insubstantially.', 'A real sword.', null],
  refused = false, protectedId = null, cancelOnLook = false } = {}) {
  const drops = [], looks = [];
  let looking, cancelled = false;
  const c = { inventory: descriptions.map((_, i) => ({ id: i + 1, flags: 16 })), evSeq: 0,
    look(id) { looking = id; looks.push(id); cancelled = cancelOnLook; },
    drop(items) { drops.push(...items); if (!refused) this.inventory = this.inventory.filter(o => !items.includes(o.id)); },
    requestInventory() { looking = null; },
    async waitFor() { return { timedOut: descriptions[looking - 1] == null,
      events: looking ? [{ id: 999, description: 'It shimmers insubstantially.' },
        ...(descriptions[looking - 1] == null ? [] : [{ id: looking, description: descriptions[looking - 1] }])] : [] }; },
  };
  const s = { client: c, pacer: { submit: async (_, fn) => fn() } };
  return { s, drops, looks, run: () => clearConjureHoard(s, [...c.inventory], {
    eligible: o => o.id !== protectedId, cancelled: () => cancelled,
  }) };
}
let r = rig();
let result = await r.run();
assert.deepEqual(result.dropped, [1]);
assert.deepEqual(result.ordinary, [2]);
assert.deepEqual(result.unresolved, [3]);
assert.equal(result.cleared, false);
assert.deepEqual(r.drops, [1]);
assert.equal(r.looks.filter(id => id === 3).length, 2);
r = rig({ descriptions: ['Real sword', 'Another real sword', 'A third real sword'] });
assert.equal((await r.run()).cleared, true); // Real loot is not a failed roulette result.
assert.deepEqual(r.drops, []);
r = rig({ descriptions: ['It shimmers insubstantially.'], refused: true });
assert.equal((await r.run()).cleared, false);
r = rig({ descriptions: ['It shimmers insubstantially.'], protectedId: 1 });
assert.equal((await r.run()).cleared, false);
assert.deepEqual(r.drops, []);
r = rig({ descriptions: ['It shimmers insubstantially.'], cancelOnLook: true });
assert.equal((await r.run()).cleared, false);
assert.deepEqual(r.drops, []);
console.log('conjure cleanup: summons, real loot, unknown/mismatched look, refused drop, protection and cancellation passed');

for (const summoned of [true, false]) {
  const r = rig({ descriptions: Array(3).fill(summoned ? 'It shimmers insubstantially.' : 'A real long sword.') });
  const c = r.s.client;
  c.rsc = { get: () => 'long sword' };
  c.vitals = () => ({ vigor: { value: 200 }, mana: { value: 25 } });
  c.equipment = () => ({ known: true, equipped: [] });
  let checkedSpell = false;
  c.requestSpells = () => { checkedSpell = true; };
  const ban = ['mace', 'sword', 'axe', 'scimitar'];
  const reasons = [];
  const k = { s: r.s, policy: {},
    bannedWeaponsNow: () => ban,
    bannedConjurablesHeld: () => c.inventory.length,
    bareHandedByTraining: () => false,
    bannedWeaponUseless: () => true,
    protectedItemNames: () => [], note() {},
    declinedCast: (_, reason) => { reasons.push(reason); return false; },
  };
  await Autopilot.prototype.makeWeapon.call(k);
  assert.equal(checkedSpell, true, 'roulette resumes past the hoard guard');
  assert.deepEqual(reasons, ['the character does not have the spell']);
  assert.equal(r.drops.length, summoned ? 3 : 0);
}
console.log('makeWeapon integration: summons cleared and ordinary loot retained while hammer roulette resumes');
