#!/usr/bin/env node

import assert from 'node:assert/strict';
import { ManualClock, RealClock, ScaledClock } from './index.mjs';

let assertions = 0;
const check = (actual, expected, message) => {
  assertions++;
  assert.deepEqual(actual, expected, message);
};

// Manual deadlines are deterministic, stable at equal times, nestable, and cancellable.
{
  const clock = new ManualClock({ startMs: 100 });
  const seen = [];
  clock.setTimeout(() => seen.push(['a', clock.now()]), 5);
  clock.setTimeout(() => seen.push(['b', clock.now()]), 5);
  clock.setTimeout(() => {
    seen.push(['early', clock.now()]);
    clock.setTimeout(() => seen.push(['nested', clock.now()]), 0);
  }, 2);
  const cancelled = clock.setTimeout(() => seen.push(['cancelled', clock.now()]), 3);
  clock.clearTimeout(cancelled);

  check(clock.advanceBy(4), 2);
  check(seen, [['early', 102], ['nested', 102]]);
  check(clock.now(), 104);
  check(clock.advanceTo(105), 2);
  check(seen.slice(-2), [['a', 105], ['b', 105]], 'equal deadlines retain insertion order');
  check(clock.pendingCount, 0);
  assert.throws(() => clock.advanceTo(104), /cannot move backwards/); assertions++;
}

// Promise sleeps use the same deterministic queue, including AbortSignal cleanup.
{
  const clock = new ManualClock();
  let slept = false;
  const sleeper = clock.sleep(10).then(() => { slept = true; });
  clock.advanceBy(9);
  await Promise.resolve();
  check(slept, false);
  clock.advanceBy(1);
  await sleeper;
  check(slept, true);

  const controller = new AbortController();
  const aborted = clock.sleep(50, { signal: controller.signal });
  controller.abort('test stop');
  await assert.rejects(aborted, error => error.name === 'AbortError' && error.message === 'test stop');
  assertions++;
  check(clock.pendingCount, 0, 'aborting removes the pending timer');
}

// Scale changes preserve the current simulated instant and re-time pending deadlines.
{
  const source = new ManualClock();
  const clock = new ScaledClock({ clock: source, scale: 2, startMs: 1_000 });
  source.advanceBy(10);
  check(clock.now(), 1_020);
  check(clock.setScale(5), 5);
  check(clock.now(), 1_020, 'changing scale must not jump simulated time');
  source.advanceBy(4);
  check(clock.now(), 1_040);

  let firedAt = null;
  clock.setTimeout(() => { firedAt = clock.now(); }, 100);
  source.advanceBy(8);                 // 40 simulated ms at 5x
  check(firedAt, null);
  check(clock.now(), 1_080);
  clock.setScale(2);                   // 60 simulated ms remain => 30 source ms
  check(clock.now(), 1_080);
  source.advanceBy(29);
  check(firedAt, null);
  source.advanceBy(1);
  check(firedAt, 1_140);
  check(clock.pendingCount, 0);
  check(clock.snapshot(), { kind: 'scaled', nowMs: 1_140, scale: 2,
    sourceNowMs: 52, pending: 0 });
}

// A scaled sleep resolves on simulated, not source, duration.
{
  const source = new ManualClock();
  const clock = new ScaledClock({ clock: source, scale: 10 });
  let resolved = false;
  const sleeper = clock.sleep(500).then(() => { resolved = true; });
  source.advanceBy(49);
  await Promise.resolve();
  check(resolved, false);
  source.advanceBy(1);
  await sleeper;
  check(resolved, true);
  check(clock.now(), 500);
  assert.throws(() => clock.setScale(0), /greater than zero/); assertions++;
}

// RealClock is also injectable, which keeps its adapter test offline and instant.
{
  let now = 7;
  let scheduled = null;
  const clock = new RealClock({
    now: () => now,
    setTimeout: (callback, delay) => { scheduled = { callback, delay }; return 11; },
    clearTimeout: handle => { scheduled = { cleared: handle }; },
  });
  check(clock.now(), 7);
  const handle = clock.setTimeout(() => {}, 25);
  check(handle, 11);
  check(scheduled.delay, 25);
  clock.clearTimeout(handle);
  check(scheduled, { cleared: 11 });
  now = 8;
  check(clock.now(), 8);
}

console.log(`clock: ${assertions} assertions passed`);
