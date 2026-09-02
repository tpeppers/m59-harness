#!/usr/bin/env node
// EVENT/DEADLINE SCHEDULING INVARIANTS. Offline, no server, safe any time:
//
//   node tools/runtime/scheduler/scheduler-test.mjs

// A fake runtime makes timer count and turn boundaries observable. No test sleeps, and
// none depends on the machine being fast enough to hit a narrow real-time window.

import { ActorScheduler, DeadlineHeap, DirtyReasonSet, PRIORITY } from './index.mjs';

class FakeRuntime {
  constructor() {
    this.time = 0;
    this.nextTimer = 0;
    this.timers = new Map();
    this.deferred = [];
    this.maxTimers = 0;
  }

  now = () => this.time;

  setTimer = (fn, delay) => {
    const id = ++this.nextTimer;
    this.timers.set(id, { id, at: this.time + Math.max(0, Number(delay) || 0), fn });
    this.maxTimers = Math.max(this.maxTimers, this.timers.size);
    return id;
  };

  clearTimer = id => { this.timers.delete(id); };
  defer = fn => { this.deferred.push(fn); };

  advance(ms) {
    this.time += ms;
    let guard = 1000;
    while (guard-- > 0) {
      const due = [...this.timers.values()]
        .filter(t => t.at <= this.time)
        .sort((a, b) => (a.at - b.at) || (a.id - b.id))[0];
      if (!due) return;
      this.timers.delete(due.id);
      due.fn();
    }
    throw new Error('fake timer loop did not settle');
  }

  runDeferred(limit = Number.POSITIVE_INFINITY) {
    let ran = 0;
    while (this.deferred.length && ran < limit) {
      this.deferred.shift()();
      ran++;
    }
    return ran;
  }
}

const schedulerFor = (runtime, options = {}) => new ActorScheduler({
  now: runtime.now,
  setTimer: runtime.setTimer,
  clearTimer: runtime.clearTimer,
  defer: runtime.defer,
  unrefTimer: false,
  ...options,
});

async function settle(runtime, rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    const ran = runtime.runDeferred();
    // Decision completion is a promise reaction even when decide() is synchronous.
    await Promise.resolve();
    await Promise.resolve();
    if (!ran && !runtime.deferred.length) return;
  }
  throw new Error('fake deferred queue did not settle');
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

let pass = 0, fail = 0;
const ok = (name, condition, extra = '') => {
  if (condition) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

console.log('dirty reasons and heap');
{
  const dirty = new DirtyReasonSet();
  dirty.add(1).add(4).add('room').add('room').add({ mask: 2, names: ['inventory'] });
  const got = dirty.take();
  ok('numeric reasons combine as an unsigned bit mask', got.mask === 7, JSON.stringify(got));
  ok('named reasons deduplicate without losing insertion order',
     got.names.join(',') === 'room,inventory', JSON.stringify(got));
  ok('take atomically empties the accumulator', dirty.empty);

  const heap = new DeadlineHeap((a, b) => (a.at - b.at) || (a.seq - b.seq));
  heap.push({ at: 30, seq: 3 }); heap.push({ at: 10, seq: 2 }); heap.push({ at: 10, seq: 1 });
  ok('deadline heap returns time order with stable tie-breaking',
     [heap.pop().seq, heap.pop().seq, heap.pop().seq].join(',') === '1,2,3');
}

console.log('\nburst coalescing');
{
  const runtime = new FakeRuntime();
  const calls = [];
  const scheduler = schedulerFor(runtime, { coalesceMs: 20 });
  const actor = scheduler.register('kermit', input => { calls.push(input); });

  actor.wake(1);
  actor.wake(2);
  actor.wake('inventory');
  actor.wake('inventory');
  ok('a burst owns only one native timer', runtime.timers.size === 1 && runtime.maxTimers === 1);
  runtime.advance(19);
  await settle(runtime);
  ok('normal work waits for the coalescing edge', calls.length === 0);
  runtime.advance(1);
  await settle(runtime);
  ok('the whole burst makes one decision', calls.length === 1, 'calls=' + calls.length);
  ok('the decision receives every bit and one copy of each name',
     calls[0]?.reasons.mask === 3 && calls[0]?.reasons.names.join(',') === 'inventory',
     JSON.stringify(calls[0]?.reasons));
  scheduler.stop();
}

console.log('\nsafety priority and fairness');
{
  const runtime = new FakeRuntime();
  const calls = [];
  const scheduler = schedulerFor(runtime, { coalesceMs: 50, maxSafetyBurst: 2,
                                                   maxStartsPerTurn: 20 });
  const mixed = scheduler.register('mixed', input => { calls.push(`mixed:${input.priority}`); });
  mixed.wake('ordinary');
  ok('ordinary work starts a coalesce deadline', runtime.timers.size === 1);
  mixed.wake('health-down', { safety: true });
  ok('safety invalidates that actor\'s coalesce timer', runtime.timers.size === 0);
  await settle(runtime);
  ok('safety bypasses the burst delay and carries ordinary dirt with it',
     calls.join(',') === 'mixed:safety', calls.join(','));

  for (const id of ['s1', 's2', 's3', 'normal'])
    scheduler.register(id, () => { calls.push(id); });
  scheduler.wake('normal', 'work', { coalesce: false });
  scheduler.wake('s1', 'danger', { safety: true });
  scheduler.wake('s2', 'danger', { safety: true });
  scheduler.wake('s3', 'danger', { safety: true });
  await settle(runtime);
  ok('safety goes first but its burst cap admits waiting normal work',
     calls.slice(1).join(',') === 's1,s2,normal,s3', calls.join(','));
  scheduler.stop();
}

console.log('\none running decision and one rerun');
{
  const runtime = new FakeRuntime();
  const gate = deferred();
  const calls = [];
  const scheduler = schedulerFor(runtime, { coalesceMs: 0 });
  const actor = scheduler.register('piggy', input => {
    calls.push(input);
    return calls.length === 1 ? gate.promise : undefined;
  });

  actor.wake('initial');
  await settle(runtime);
  ok('the first decision is running', calls.length === 1 && actor.running);
  actor.wake(1);
  actor.wake(2);
  actor.wake('objects');
  actor.wake('health-down', { priority: PRIORITY.SAFETY });
  await settle(runtime);
  ok('events cannot start a concurrent decision for the actor', calls.length === 1);
  gate.resolve();
  await settle(runtime);
  ok('all events received while running collapse into exactly one rerun', calls.length === 2);
  ok('the rerun is promoted to safety and preserves accumulated dirt',
     calls[1]?.priority === PRIORITY.SAFETY && calls[1]?.reasons.mask === 3 &&
       calls[1]?.reasons.names.join(',') === 'objects,health-down' &&
       calls[1]?.safety.names.join(',') === 'health-down',
     JSON.stringify(calls[1]));
  scheduler.stop();
}

console.log('\ndeadlines and the single timer');
{
  const runtime = new FakeRuntime();
  const calls = [];
  const scheduler = schedulerFor(runtime, { coalesceMs: 10 });
  scheduler.register('a', input => { calls.push(`a:${input.reasons.names.join('+')}`); });
  scheduler.register('b', input => { calls.push(`b:${input.reasons.names.join('+')}`); });

  scheduler.setDeadline('a', 'job', 100, 'old');
  scheduler.setDeadline('b', 'job', 50, 'cancelled');
  scheduler.setDeadline('a', 'job', 40, 'replacement');
  ok('replacing and adding deadlines still owns one native timer',
     runtime.timers.size === 1 && runtime.maxTimers === 1);
  runtime.advance(40);
  await settle(runtime);
  ok('a replacement deadline fires at its new time only', calls.join(',') === 'a:replacement', calls.join(','));
  ok('a pending deadline can be cancelled', scheduler.clearDeadline('b', 'job') === true);
  runtime.advance(60);
  await settle(runtime);
  ok('cancelled and superseded heap nodes never wake an actor', calls.length === 1, calls.join(','));

  scheduler.setDeadline('a', 'same', 120, 'normal-at-120');
  scheduler.setDeadline('b', 'same', 120, 'safety-at-120', { safety: true });
  runtime.advance(20);
  await settle(runtime);
  ok('safety deadlines win ties at the decision queue',
     calls.slice(1).join(',') === 'b:safety-at-120,a:normal-at-120', calls.join(','));
  ok('the scheduler never had more than one native timer armed', runtime.maxTimers === 1,
     'max=' + runtime.maxTimers);

  // A moving actor may continually push out one liveness deadline. Old keyed versions
  // are invalid, and must not sit behind another nearer live deadline for ever.
  scheduler.setDeadline('b', 'anchor', 500, 'anchor');
  for (let i = 0; i < 500; i++) scheduler.setDeadline('a', 'moving', 1000 + i, 'latest');
  ok('rearming one keyed deadline keeps lazy heap garbage bounded',
     scheduler.stats.deadline_nodes < 70, 'nodes=' + scheduler.stats.deadline_nodes);
  scheduler.stop();
}

console.log('\nturn budget');
{
  const runtime = new FakeRuntime();
  const calls = [];
  const scheduler = schedulerFor(runtime, { coalesceMs: 0, maxStartsPerTurn: 2 });
  for (let i = 0; i < 5; i++) {
    scheduler.register(i, () => { calls.push(i); });
    scheduler.wake(i, 'work');
  }
  runtime.runDeferred(1);
  ok('one event-loop turn starts no more than its fairness budget', calls.length === 2,
     calls.join(','));
  ok('remaining actors are deferred to another turn', runtime.deferred.length === 1);
  runtime.runDeferred(1);
  ok('the second turn observes the same budget', calls.length === 4, calls.join(','));
  runtime.runDeferred(1);
  ok('the final actor runs on a third turn', calls.length === 5, calls.join(','));
  await settle(runtime);
  ok('budget exhaustion is exposed in scheduler telemetry', scheduler.stats.yielded_turns === 2,
     JSON.stringify(scheduler.stats));
  scheduler.stop();
}

console.log('\ndeadline lateness telemetry');
{
  const runtime = new FakeRuntime();
  const scheduler = schedulerFor(runtime, { coalesceMs: 0 });
  scheduler.register('late', () => {});
  scheduler.setDeadline('late', 'sample', 10, 'sample');
  runtime.advance(37);
  await settle(runtime);
  const stats = scheduler.stats;
  ok('the existing fleet timer measures event-loop deadline delay without a sampler timer',
     stats.deadline_lateness_samples === 1 && stats.deadline_lateness_max_ms === 27 &&
       stats.deadline_lateness_total_ms === 27 && stats.deadline_lateness_mean_ms === 27 &&
       stats.deadline_lateness_le_100ms === 1,
     JSON.stringify(stats));
  scheduler.stop();
}

console.log('\nterminal stop and stale callbacks');
{
  const runtime = new FakeRuntime();
  const calls = [];
  const scheduler = schedulerFor(runtime, { coalesceMs: 20 });
  const actor = scheduler.register('animal', () => { calls.push('ran'); });
  actor.wake('normal');                         // arms timer
  actor.wake('danger', { safety: true });      // queues deferred callback
  scheduler.setDeadline('animal', 'later', 10, 'later');
  ok('stop succeeds once and is terminal', scheduler.stop() === true && scheduler.stop() === false);
  runtime.advance(100);
  await settle(runtime);
  ok('timer and deferred callbacks queued before stop cannot resurrect work', calls.length === 0);
  ok('stale handles become inert', actor.wake('again') === false && actor.setDeadline('x', 1) === false);
  let threw = false;
  try { scheduler.register('new', () => {}); } catch { threw = true; }
  ok('a stopped scheduler cannot be restarted by registering an actor', threw);
}

{
  const runtime = new FakeRuntime();
  const gate = deferred();
  const calls = [];
  const scheduler = schedulerFor(runtime, { coalesceMs: 0 });
  const actor = scheduler.register('fozzie', input => {
    calls.push(input.run);
    return gate.promise;
  });
  actor.wake('first');
  await settle(runtime);
  actor.wake('rerun');
  scheduler.setDeadline('fozzie', 'wake', 1, 'deadline');
  scheduler.stop();
  ok('stopping aborts the actor lifetime signal', actor.signal.aborted === true);
  gate.resolve();
  runtime.advance(10);
  await settle(runtime);
  ok('completion of an in-flight decision after stop cannot schedule its rerun',
     calls.length === 1, calls.join(','));
}

{
  const runtime = new FakeRuntime();
  const oldGate = deferred();
  const calls = [];
  const scheduler = schedulerFor(runtime, { coalesceMs: 0 });
  const old = scheduler.register('same-id', () => { calls.push('old'); return oldGate.promise; });
  old.wake('first');
  await settle(runtime);
  old.stop();
  const replacement = scheduler.register('same-id', () => { calls.push('new'); });
  replacement.wake('first');
  await settle(runtime);
  oldGate.resolve();
  await settle(runtime);
  ok('an old actor completion cannot affect a replacement with the same id',
     calls.join(',') === 'old,new', calls.join(','));
  ok('a stale actor handle cannot wake the replacement', old.wake('stale') === false);
  scheduler.stop();
}

{
  const runtime = new FakeRuntime();
  const gate = deferred();
  const calls = [];
  const scheduler = schedulerFor(runtime, { coalesceMs: 0, maxConcurrent: 1 });
  const old = scheduler.register('blocking', () => { calls.push('blocking'); return gate.promise; });
  scheduler.register('waiting', () => { calls.push('waiting'); });
  old.wake('first');
  scheduler.wake('waiting', 'first');
  await settle(runtime);
  ok('a finite concurrency slot holds later actors while its decision runs',
     calls.join(',') === 'blocking', calls.join(','));
  old.stop();
  gate.resolve();
  await settle(runtime);
  ok('settling a stopped actor releases its slot and drains the fleet queue',
     calls.join(',') === 'blocking,waiting', calls.join(','));
  scheduler.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
