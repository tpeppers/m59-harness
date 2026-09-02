#!/usr/bin/env node

import assert from 'node:assert/strict';
import { DeferredLatest } from './deferred-latest.mjs';

class FakeClock {
  constructor() { this.next = 0; this.tasks = new Map(); this.clears = 0; }
  setTimeout(callback, delayMs) {
    const handle = this.next++;
    this.tasks.set(handle, { callback, delayMs });
    return handle;
  }
  clearTimeout(handle) { this.clears++; this.tasks.delete(handle); }
  fire(handle) {
    const task = this.tasks.get(handle);
    this.tasks.delete(handle);
    task?.callback();
  }
}

const clock = new FakeClock();
const committed = [];
const writer = new DeferredLatest(value => committed.push(value), { delayMs: 30_000, clock });

assert.equal(clock.tasks.size, 0, 'construction owns no timer');
assert.equal(writer.push('one'), true);
assert.equal(clock.tasks.size, 1);
assert.equal([...clock.tasks.values()][0].delayMs, 30_000);
assert.equal(writer.push('two'), false, 'a later value reuses the existing timeout');
assert.equal(writer.push('three'), false);
assert.equal(clock.tasks.size, 1);
assert.equal(clock.clears, 0, 'a busy producer does not churn timeout objects');
clock.fire(0); // handle zero deliberately exercises the null-vs-truthiness boundary
assert.deepEqual(committed, ['three'], 'the trailing commit receives only the latest value');
assert.equal(clock.tasks.size, 0);

writer.push('old');
assert.equal(writer.flush('shutdown'), true, 'shutdown may replace and synchronously flush');
assert.deepEqual(committed, ['three', 'shutdown']);
assert.equal(clock.tasks.size, 0);
assert.equal(writer.flush(), false, 'an empty flush is a no-op');

writer.push('discard');
writer.cancel();
assert.equal(clock.tasks.size, 0);
assert.equal(writer.flush(), false, 'cancel discards pending work');

console.log('deferred latest: PASS');
