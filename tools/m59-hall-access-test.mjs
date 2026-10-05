// Offline guard for tools/m59-hall-access.mjs. A fake broker; no socket, no roster.
//
//   node tools/m59-hall-access-test.mjs
import assert from 'node:assert/strict';
import { withdrawWithRecovery, depositWithRecovery, hallDrawSteps, PASSAGE_REFUSAL, healthFraction } from './m59-hall-access.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };

// A fake broker: a pack, and a scripted list of hall_withdraw replies (each may move items into the pack).
const broker = (replies, pack = { emerald: 0 }) => {
  const calls = [];
  const call = async (name, args) => {
    calls.push(name);
    // Like the real pack: an emptied stack is absent, never listed at amount 0 (0 means ONE unstackable).
    if (name === 'inventory') return { items: Object.entries(pack).filter(([, a]) => a > 0).map(([name, amount]) => ({ name, amount })) };
    if (name === 'status') return { hp: { value: (pack.__hp ??= [100]).length > 1 ? pack.__hp.shift() : pack.__hp[0], max: 100 } };
    if (name === 'hall_withdraw') { const r = replies.shift() ?? { ok: false, why: 'no more replies' };
      for (const [k, v] of Object.entries(r.give ?? {})) pack[k] = (pack[k] ?? 0) + v;
      for (const [k, v] of Object.entries(r.take ?? {})) pack[k] = (pack[k] ?? 0) - v; return r; }
    throw new Error(`unexpected ${name}`);
  };
  return { call, calls };
};
const nap = async () => {};

await ok('a passage refusal is retried once, and the retry that lands is a success', async () => {
  const b = broker([{ ok: false, why: 'guild door 55 trigger not reached (stopped at r6c27, wanted r19c10)' },
                    { ok: true, took: { emerald: 10 }, give: { emerald: 10 } }]);
  const r = await withdrawWithRecovery(b.call, 't3', [{ item: 'emerald', amount: 10 }], { sleepFn: nap });
  assert.equal(r.ok, true); assert.equal(r.attempts, 2); assert.deepEqual(r.arrived, { emerald: 10 });
});
await ok('a refusal of something else is NOT retried (it would only repeat)', async () => {
  const b = broker([{ ok: false, why: 'guild chest key unavailable' }]);
  const r = await withdrawWithRecovery(b.call, 't3', [{ item: 'emerald', amount: 10 }], { sleepFn: nap });
  assert.equal(r.ok, false); assert.equal(r.attempts, 1); assert.match(r.why, /chest key/);
  assert.equal(b.calls.filter(c => c === 'hall_withdraw').length, 1);
});
await ok('two passage refusals: give up with the reason, never a silent took {}', async () => {
  const b = broker([{ ok: false, why: 'guild door 55 trigger not reached' }, { ok: false, why: 'guild door 55 trigger not reached' }]);
  const r = await withdrawWithRecovery(b.call, 't3', [{ item: 'emerald', amount: 10 }], { sleepFn: nap });
  assert.equal(r.ok, false); assert.equal(r.attempts, 2); assert.match(r.why, /door 55/);
});
await ok('the PACK is the evidence: a keeper that says ok but moved nothing is a failure', async () => {
  const b = broker([{ ok: true, took: { emerald: 10 } }]);
  const r = await withdrawWithRecovery(b.call, 't3', [{ item: 'emerald', amount: 10 }], { sleepFn: nap });
  assert.equal(r.ok, false); assert.match(r.why, /nothing arrived/);
});
await ok('a thrown call is a reason, not a crash', async () => {
  const call = async (name) => { if (name === 'inventory') return { items: [] }; throw new Error('broker restarting'); };
  const r = await withdrawWithRecovery(call, 't3', [{ item: 'emerald', amount: 1 }], { sleepFn: nap, retries: 0 });
  assert.equal(r.ok, false); assert.match(r.why, /broker restarting/);
});
await ok('the passage refusals it recognises', async () => {
  for (const w of ['guild door 59 trigger not reached', 'guild position is outside the known passage', 'not in the hall (room 101, want 714)'])
    assert.ok(PASSAGE_REFUSAL.test(w), w);
  assert.ok(!PASSAGE_REFUSAL.test('guild chest key unavailable'));
});
await ok('a deposit: a passage refusal is retried, and the pack says what left', async () => {
  const b = broker([{ ok: false, why: 'guild door 55 trigger not reached' }, { ok: true, take: { 'entroot berry': 120 } }],
                   { 'entroot berry': 120, 'iron sword': 0 });
  const r = await depositWithRecovery(b.call, 't3', ['entroot berry'], { sleepFn: nap });
  assert.equal(r.ok, true); assert.equal(r.attempts, 2); assert.equal(r.left, 120);
});
await ok('a deposit with nothing to put in is not a walk-in failure, and calls nothing', async () => {
  const b = broker([], { 'iron sword': 1 });
  const r = await depositWithRecovery(b.call, 't3', ['entroot berry', 'wand'], { sleepFn: nap });
  assert.equal(r.ok, true); assert.equal(r.left, 0); assert.ok(!b.calls.includes('hall_withdraw'));
});
await ok('a deposit the keeper calls fine but the pack never moved is a failure', async () => {
  const b = broker([{ ok: true }], { 'entroot berry': 40 });
  const r = await depositWithRecovery(b.call, 't3', ['berry'], { sleepFn: nap });
  assert.equal(r.ok, false); assert.match(r.why, /nothing left/);
});
await ok('a survival cancel waits for health, then retries -- not 15 s into the same rest', async () => {
  const b = broker([{ ok: false, why: 'guild door 55 trigger not reached (stopped at r13c18, wanted r19c10: movement cancelled by a newer command, 2 step(s); cancelled by keeper:play_dead (rest at the safe wall instead of logging off))' },
                    { ok: true, give: { emerald: 10 } }], { emerald: 0, __hp: [72, 80, 90, 97] });
  let naps = 0;
  const r = await withdrawWithRecovery(b.call, 't3', [{ item: 'emerald', amount: 10 }], { sleepFn: async () => { naps++; } });
  assert.equal(r.ok, true); assert.equal(r.attempts, 2);
  assert.equal(b.calls.filter(c => c === 'status').length, 4, 'polled health until it was back');
  assert.equal(naps, 3);
});
await ok('the status tool has two shapes, and either reads as a fraction', async () => {
  assert.equal(healthFraction({ hp: { value: 36, max: 50 } }), 0.72);
  assert.equal(healthFraction({ vitals: { health: { value: 50, max: 50 } } }), 1);
  assert.equal(healthFraction({}), null);
});
await ok('hallDrawSteps: chalice first when a holder is named, then the walk, then the draw', async () => {
  assert.deepEqual(hallDrawSteps({ wants: [], holder: 'Loial the Ogier' }).map(s => s.do), ['ride_chalice', 'walk', 'verify']);
  assert.equal(hallDrawSteps({ wants: [], holder: 'x' })[0].optional, true, 'a refused ride falls through to the walk');
  assert.deepEqual(hallDrawSteps({ wants: [] }).map(s => s.do), ['walk', 'verify']);
});

console.log(`\n${n} passed`);
