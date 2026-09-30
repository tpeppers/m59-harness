// Offline guard: a keeper's status reply (what it hunts, its health, whether it is stuck) and
// its "where did you die" tell go to the fleet's own characters (the operator piloting one)
// and to NOBODY else. 2026-09-30, prod, mid guild war: an NPC's line contained a character's
// name and the character answered it with its quarry and hit points.
//
//   node tools/m59-social-silence-test.mjs
import assert from 'node:assert/strict';
import { Autopilot } from './m59-autopilot.mjs';
import * as party from './m59-party.mjs';

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }
party.setRosterSource(() => new Set(['Kermit', 'Gonzo']));

function keeper(said) {
  const spoken = [];
  const c = { selfId: 1, me: { name: 'Kermit' }, trade: null, evSeq: said.length, inventory: [{ id: 5 }],
    eventsSince: () => said.map(s => ({ kind: 'said', ...s })),
    vitals: () => ({ health: { value: 30, max: 37 } }),
    say: t => spoken.push(t), tell: (id, t) => spoken.push(`tell ${id}: ${t}`) };
  const k = Object.create(Autopilot.prototype);
  k.s = { need: () => c, client: c, view: () => ({ room: { num: 38 } }), credentials: { host: '76.214.42.186' },
    pacer: { submit: async (kind, fn) => fn() }, name: null };
  k.policy = { hunt: ['skeleton'] };
  k.note = () => {};
  return { k, spoken };
}

await test('an NPC saying our name gets silence', async () => {
  const { k, spoken } = keeper([{ speaker: 99, name: 'Marion Guard', text: 'Kermit, move along.' }]);
  await k.social();
  assert.deepEqual(spoken, []);
});

await test('a stranger player asking gets silence', async () => {
  const { k, spoken } = keeper([{ speaker: 77, name: 'Morpheus', text: 'kermit how are you' }]);
  await k.social();
  assert.deepEqual(spoken, []);
});

await test('the operator, piloting a fleet character, still gets the status line', async () => {
  const { k, spoken } = keeper([{ speaker: 2, name: 'Gonzo', text: 'Kermit status?' }]);
  await k.social();
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /^Kermit: hunting .* 30\/37 health/);
});

await test('our own speech echoed back is not a question', async () => {
  const { k, spoken } = keeper([{ speaker: 3, name: 'Kermit', text: 'Kermit here' }]);
  await k.social();
  assert.deepEqual(spoken, []);
});

console.log(`\n${tests} passed`);
