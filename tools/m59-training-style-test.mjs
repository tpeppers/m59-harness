#!/usr/bin/env node
// Offline contract for the short-sword / bare-hand farm regimen.
// Opens no socket and joins nobody.

import { readFileSync } from 'node:fs';
import { Autopilot, CONTINUE } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => {
  if (cond) { passed++; console.log('  ok  ', what); }
  else { failed++; console.log('  FAIL', what); }
};

console.log('\nalternation belongs to a quarry, not a pass');
{
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { trainingStyle: 'alternate' };
  ok('the first quarry uses a short sword', ap.trainingStyleFor(101) === 'short_sword');
  ok('resuming that quarry keeps its style', ap.trainingStyleFor(101) === 'short_sword');
  ok('the next quarry is unarmed', ap.trainingStyleFor(202) === 'unarmed');
  ok('resuming the second quarry remains unarmed', ap.trainingStyleFor(202) === 'unarmed');
  ap.finishTrainingBout(202);
  ok('the following quarry flips back to short sword', ap.trainingStyleFor(303) === 'short_sword');
}

console.log('\ntraining prey uses the canonical hunt matcher');
{
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { hunt: 'rebel troop' };
  ap.huntMatch = want => name => want === 'rebel troop' && name === 'rebel soldier';
  ok('a canonical alias is accepted', ap.isTrainingPrey('rebel soldier'));
  ok('an unrelated bystander is not training prey', !ap.isTrainingPrey('troll'));
}

console.log('\ndeliberate unarmed work does not trip the arm-first survival gate');
{
  const ap = Object.create(Autopilot.prototype);
  ap.mode = 'farm';
  ap.policy = { trainingStyle: 'unarmed', assignedRoom: 544 };
  const result = await ap.passArm({ s: null, c: null, room: { num: 544 } });
  ok('bare-hand practice falls through on the assigned farm ground', result === CONTINUE);
}

console.log('\npreparation verifies the server use list');
{
  const names = new Map([[1, 'hammer']]);
  const using = new Set([1]);
  const client = {
    inventory: [{ id: 1, nameRsc: 1 }], using, evSeq: 0,
    rsc: { get: id => names.get(id) },
    equipment: () => ({ known: true,
      equipped: [...using].map(id => ({ id, name: names.get(id) })) }),
    unuse: id => { using.delete(id); },
    waitFor: async () => ({ events: [] }),
  };
  const ap = Object.create(Autopilot.prototype);
  ap.s = { client, pacer: { submit: async (_kind, fn) => fn() } };
  ap.note = () => {};
  const result = await ap.prepareTrainingStyle('unarmed', 404);
  ok('the equipped weapon is removed', result.ready && result.removed === 'hammer');
  ok('fight is told not to auto-equip it again', result.equip === false && using.size === 0);
  ok('an unarmed training pass gets exactly one prepared round', result.rounds === 1);
}

{
  const names = new Map([[1, 'hammer']]);
  const using = new Set([1]);
  const client = {
    inventory: [{ id: 1, nameRsc: 1 }], using, evSeq: 0,
    rsc: { get: id => names.get(id) },
    equipment: () => ({ known: true,
      equipped: [...using].map(id => ({ id, name: names.get(id) })) }),
    unuse: () => {},
    waitFor: async () => ({ events: [] }),
  };
  const ap = Object.create(Autopilot.prototype);
  ap.s = { client, pacer: { submit: async (_kind, fn) => fn() } };
  const result = await ap.unuseTrainingWeapon();
  ok('a refused unuse does not claim bare hands', !result.ready && using.has(1));
}

{
  const names = new Map([[2, 'short sword']]);
  const using = new Set([2]);
  const client = {
    inventory: [{ id: 2, nameRsc: 2 }], using,
    rsc: { get: id => names.get(id) },
    equipment: () => ({ known: true, equipped: [{ id: 2, name: 'short sword' }] }),
  };
  const ap = Object.create(Autopilot.prototype);
  ap.s = { client };
  const result = await ap.prepareTrainingStyle('short_sword', 505);
  ok('an exact equipped short sword is accepted without mutation',
     result.ready && result.already && result.equip === false && result.weapon_id === 2);
  ok('a short-sword training pass gets exactly one prepared round', result.rounds === 1);
}

console.log('\nknown-broken short swords are replaced');
{
  const names = new Map([[7, 'short sword'], [8, 'short sword']]);
  const using = new Set();
  const client = {
    inventory: [{ id: 7, nameRsc: 7 }], using, _brokenWeapons: new Set([7]),
    rsc: { get: id => names.get(id) },
    equipment: () => ({ known: true,
      equipped: [...using].map(id => ({ id, name: names.get(id) })) }),
  };
  let made = 0;
  const ap = Object.create(Autopilot.prototype);
  ap.s = { client };
  ap.note = () => {};
  ap.makeWeapon = async () => {
    made++;
    client.inventory.push({ id: 8, nameRsc: 8 });
    using.add(8);
    return true;
  };
  const result = await ap.prepareTrainingStyle('short_sword', 606);
  ok('a known-broken sword does not suppress replacement', made === 1);
  ok('the replacement is the prepared weapon', result.ready && result.weapon_id === 8);
}

console.log('\nbroker preserves incremental keeper policy updates');
{
  const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  const seed = broker.indexOf('const savedAutopilot = fleetState.get(a.agent)?.autopilot;');
  const guard = broker.indexOf('if (s instanceof KeeperProxy && savedAutopilot?.policy)', seed);
  const mutate = broker.indexOf('if (a.training_style !== undefined)', guard);
  ok('training_style is an enumerated broker field',
     /training_style:\s*\{[^}]*enum:\s*\['normal', 'short_sword', 'unarmed', 'alternate'\]/s.test(broker));
  ok('only keeper proxies are seeded from saved roster policy', seed >= 0 && guard > seed);
  ok('saved policy is restored before the incremental field is applied', mutate > guard);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
