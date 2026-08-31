#!/usr/bin/env node
import assert from 'node:assert/strict';
import { configuredPartyPlan, installConfiguredParties } from './party-roster.mjs';

const entry = (id, partner = null) => ({ id, autopilot: { policy: { partner } } });
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (error) { console.error('  FAIL ' + name + ': ' + error.message); process.exitCode = 1; }
};

test('unilateral selected pair becomes symmetric', () => {
  assert.deepEqual(configuredPartyPlan([entry('a', 'b'), entry('b')]).pairs, [['a', 'b']]);
});
test('mutual declarations install once', () => {
  assert.deepEqual(configuredPartyPlan([entry('a', 'b'), entry('b', 'a')]).pairs, [['a', 'b']]);
});

for (const [name, entries, pattern] of [
  ['missing selected entries refused', undefined, /requires actor entries/],
  ['omitted partner refused', [entry('a', 'b')], /not selected/],
  ['self partner refused', [entry('a', 'a')], /itself/],
  ['invalid partner refused', [entry('a', 7)], /invalid partner/],
  ['duplicate id refused', [entry('a'), entry('a')], /duplicated/],
  ['contradictory chain refused', [entry('a', 'b'), entry('b', 'c'), entry('c')], /conflicting/],
  ['shared partner refused', [entry('a', 'b'), entry('b'), entry('c', 'b')], /conflicting/],
]) test(name, () => assert.throws(() => configuredPartyPlan(entries), pattern));

test('validation precedes register mutation', () => {
  const calls = [];
  const party = {
    unpair: id => calls.push(['unpair', id]),
    pair: (a, b) => calls.push(['pair', a, b]),
  };
  assert.throws(() => installConfiguredParties([entry('a', 'missing')], party), /not selected/);
  assert.deepEqual(calls, []);
  installConfiguredParties([entry('a', 'b'), entry('b'), entry('solo')], party);
  assert.deepEqual(calls, [
    ['unpair', 'a'], ['unpair', 'b'], ['unpair', 'solo'], ['pair', 'a', 'b'],
  ]);
});

if (!process.exitCode) console.log('party roster: PASS (' + passed + ')');
