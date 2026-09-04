#!/usr/bin/env node
// Offline contract for the short-sword / bare-hand farm regimen.
// Opens no socket and joins nobody.

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
     result.ready && result.already && result.equip === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
