#!/usr/bin/env node

import assert from 'node:assert/strict';
import { DemandSnapshot } from './demand-snapshot.mjs';

let now = 1_000;
let builds = 0;
const cache = new DemandSnapshot(() => ({ generation: ++builds }), {
  maxAgeMs: 2_000,
  now: () => now,
});

assert.equal(builds, 0, 'construction performs no work and owns no timer');
assert.deepEqual(cache.read().value, { generation: 1 });
assert.equal(cache.read().refreshed, false, 'a reader burst shares the projection');
assert.equal(builds, 1);

now = 2_999;
assert.equal(cache.read().value.generation, 1, 'the value remains valid inside its bound');
now = 3_000;
assert.equal(cache.read().value.generation, 2, 'the boundary refreshes on demand');
assert.equal(builds, 2);

assert.equal(cache.read({ fresh: true }).value.generation, 3,
  'an explicit fresh read bypasses the age bound');
cache.invalidate();
assert.equal(cache.read().value.generation, 4, 'invalidation forces the next reader only');

let fail = false;
const resilient = new DemandSnapshot(() => {
  if (fail) throw new Error('projection failed');
  return { okay: true };
}, { maxAgeMs: 5, maxStaleMs: 20, now: () => now });
resilient.read();
now += 10;
fail = true;
const stale = resilient.read();
assert.deepEqual(stale.value, { okay: true }, 'a failed refresh retains the last good value');
assert.match(stale.refreshError.message, /projection failed/);
now += 11;
assert.throws(() => resilient.read(), /projection failed/,
  'a failed refresh cannot serve the last good value beyond the explicit stale bound');

assert.throws(() => new DemandSnapshot(() => null, { maxAgeMs: 5, maxStaleMs: 4 }),
  /no smaller than maxAgeMs/);

assert.throws(() => new DemandSnapshot(() => { throw new Error('first'); }).read(), /first/,
  'a first-build failure remains visible when there is no safe stale value');

console.log('demand-driven snapshot: PASS');
