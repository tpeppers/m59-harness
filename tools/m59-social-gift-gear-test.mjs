import assert from 'node:assert/strict';
import './m59-autopilot.mjs';
import { SocialPart } from './autopilot/social.mjs';

async function socialGift({ neverAttack = false, held = null, claimOnRead = null } = {}) {
  const counters = [], equipped = [], used = [];
  const client = {
    trade: { withId: 17, withName: 'Gonzo', theirs: [{ name: 'orc tooth', amount: 3 }], ours: [] },
    me: { name: 'Statler' }, eventsSince: () => [],
    inventory: [{ id: 11278, nameRsc: 1, rarity: 0 }], rsc: { get: () => 'mace' }, skills: [],
    counterOffer: items => counters.push(items),
    requestInventory: () => { if (claimOnRead) held = claimOnRead; },
    waitFor: async () => ({ events: [] }),
    equipment: () => ({ known: true, equipped }),
    use: id => { used.push(id); equipped.push({ id, name: 'mace' }); },
  };
  const keeper = {
    policy: { neverAttack }, facultyHeld: faculty => faculty === held,
    note() {}, progress() {}, offerWouldDoubleChalice: () => false,
    weaponPriorityNow: () => null, bannedWeaponsNow: () => null,
    s: { client, need: () => client, pacer: { submit: async (_, operation) => operation() } },
  };
  await SocialPart.prototype.social.call(keeper);
  assert.deepEqual(counters, [[]], 'the keeper still counters the gift');
  return used;
}

assert.deepEqual(await socialGift(), [11278], 'ordinary recipients still arm');
assert.deepEqual(await socialGift({ neverAttack: true }), []);
assert.deepEqual(await socialGift({ held: 'work' }), []);
assert.deepEqual(await socialGift({ held: 'economy' }), []);
assert.deepEqual(await socialGift({ claimOnRead: 'work' }), [], 'a claim acquired during the pack read prevents the equip');
console.log('social gift gear: ordinary, never attack, and held work passed');
