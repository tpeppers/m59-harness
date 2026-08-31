#!/usr/bin/env node

import assert from 'node:assert/strict';
import { KeeperLiveness, normalizeKeeperCharacter, validateKeeperSample }
  from './keeper-liveness.mjs';

let now = 1_000;
const live = new KeeperLiveness({
  agent: 't1', character: 'Kérmit', phantomAfterMs: 20_000,
  probeEveryMs: 10_000, now: () => now,
});
const sample = (overrides = {}) => ({
  agent: 't1', character: 'Ke\u0301rmit', pid: 123, in_game: true,
  connected: true, connection_revision: 1, ...overrides,
});

assert.equal(normalizeKeeperCharacter(' Ke\u0301rmit '), normalizeKeeperCharacter('Kérmit'));
assert.equal(validateKeeperSample(sample(), { agent: 't1', character: 'Kérmit', pid: 123 }).ok, true);
for (const [bad, reason] of [
  [sample({ agent: 't2' }), 'agent mismatch'],
  [sample({ character: 'Fozzie' }), 'character mismatch'],
  [sample({ pid: 124 }), 'pid mismatch'],
]) assert.match(validateKeeperSample(bad, { agent: 't1', character: 'Kérmit', pid: 123 }).reason,
                 new RegExp(reason));

assert.equal(live.status({ processAlive: true }).live, true,
  'an unanswered but live process is unknown, not reconnectable');
assert.equal(live.status({ processAlive: null }).live, false,
  'absence of both a sample and a recorded PID cannot suppress recovery forever');
assert.equal(live.observe(sample(), { pid: 123 }).ok, true);
assert.equal(live.status({ processAlive: true }).live, true);
assert.equal(live.status({ processAlive: null }).live, false,
  'a historical sample without its recorded PID cannot remain immortal');
assert.equal(live.status({ processAlive: null }).inGame, false,
  'mutation gates require the exact process as well as its historical in-game sample');
assert.equal(live.status({ processAlive: null }).reportedInGame, true);
assert.equal(live.due(), false);

now = 11_000;
assert.equal(live.due(), true);
assert.equal(live.observe(sample({ connected: false }), { pid: 123 }).ok, true);
assert.equal(live.status({ processAlive: true }).phantom, false, 'one false sample gets grace');
now += 19_999;
assert.equal(live.status({ processAlive: true }).live, true);
live.unavailable(new Error('timeout'));
assert.equal(live.status({ processAlive: true }).live, true,
  'HTTP silence with a live PID preserves the last accepted decision');
now += 1;
assert.equal(live.status({ processAlive: true }).phantom, false,
  'silence cannot turn one false sample into a phantom merely by elapsed time');
assert.equal(live.observe(sample({ connected: false }), { pid: 123 }).ok, true);
assert.equal(live.status({ processAlive: true }).phantom, true,
  'a later explicit false sample confirms the sustained disconnection');

assert.equal(live.observe(sample({ connected: false, connection_revision: 2 }), { pid: 123 }).ok, true);
assert.equal(live.status({ processAlive: true }).phantom, false,
  'a new connection revision resets old phantom evidence');
assert.equal(live.status({ processAlive: false }).processDead, true);
assert.equal(live.status({ processAlive: false }).live, false);
assert.equal(live.status({ processAlive: false }).inGame, false);
assert.equal(live.status({ processAlive: false }).reportedInGame, true);

live.resetConnectionEvidence();
const generation = live.generation;
live.dispose();
assert.equal(live.observe(sample(), { pid: 123 }).reason, 'disposed');
assert.equal(live.generation, generation + 1);
assert.equal(live.status({ processAlive: true }).disposed, true);

console.log('keeper liveness: PASS');
