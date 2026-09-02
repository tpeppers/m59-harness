#!/usr/bin/env node
// Generic FleetRuntime lifecycle invariants. Offline, no server or sockets.
//
//   node tools/runtime/fleet-runtime-test.mjs

import assert from 'node:assert/strict';

import { ManualClock } from './clock/index.mjs';
import {
  DEFAULT_ACTOR_STATE_SCHEMA,
  FLEET_RUNTIME_SNAPSHOT_SCHEMA,
  FleetRuntime,
} from './fleet-runtime.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function until(predicate, rounds = 50) {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition did not settle');
}

// Construction rejects ambiguous rosters before starting any actor.
{
  const factory = () => ({});
  assert.throws(() => new FleetRuntime({ entries: [{ id: 'same' }, { id: 'same' }], actorFactory: factory }), /duplicate/);
  assert.throws(() => new FleetRuntime({ entries: [{}], actorFactory: factory }), /non-empty string id/);
  assert.throws(() => new FleetRuntime({ entries: [], actorFactory: factory, startupConcurrency: 0 }), /positive/);
  assert.throws(() => new FleetRuntime({ entries: [], actorFactory: factory, onStateChanged: true }), /onStateChanged/);
  assert.throws(() => new FleetRuntime({ entries: [], actorFactory: factory, transitionSink: true }), /transitionSink/);
}

// A shard can mirror latest state and hand exact transitions directly to its IPC
// reporter without accumulating an unused child-local acknowledged stream.
{
  const clock = new ManualClock({ startMs: 7000 });
  const states = [];
  const transitions = [];
  let refuseTransition = true;
  const runtime = new FleetRuntime({
    runtimeId: 'external-delivery-test',
    entries: ['a'], clock,
    actorFactory: () => ({}),
    onStateChanged: message => states.push(message),
    transitionSink: message => {
      if (refuseTransition) throw new Error('external window full');
      transitions.push(message);
      return Object.freeze({ accepted: true });
    },
  });
  runtime.publishState('a', {
    schema: DEFAULT_ACTOR_STATE_SCHEMA, actor_id: 'a', value: 1,
  });
  runtime.publishState('a', {
    schema: DEFAULT_ACTOR_STATE_SCHEMA, actor_id: 'a', value: 1,
  });
  assert.equal(states.length, 1, 'only changed state reaches the lossy mirror hook');
  assert.equal(states[0].revision, 1);
  assert.equal(states[0].observedAtMs, 7000);
  assert.equal(states[0].state.value, 1);

  assert.throws(() => runtime.publishTransition('a', 'death', { room: 7 }),
    /external window full/);
  assert.equal(runtime.streamsFor('a').transitions.pendingCount, 0,
    'failed external delivery is not duplicated into the local stream');
  assert.equal(runtime.stats.transition_delivery_failures, 1);
  refuseTransition = false;
  const accepted = runtime.publishTransition('a', 'death', { room: 7 });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(transitions[0], {
    id: 'a', type: 'death', payload: { room: 7 }, stateRevision: 1, atMs: 7000,
  });
  assert.equal(runtime.streamsFor('a').transitions.pendingCount, 0);
  assert.equal(runtime.stats.transition_publications, 1);
  await runtime.stop();
}

// Startup is bounded across factory/start work, failures are isolated, and state is
// cached only when an actor explicitly publishes or exposes snapshot().
{
  const clock = new ManualClock({ startMs: 1000 });
  const gates = [];
  const actors = new Map();
  let active = 0;
  let maxActive = 0;
  const runtime = new FleetRuntime({
    runtimeId: 'bounded-test',
    entries: ['a', 'b', 'factory-fail', 'start-fail', 'e'],
    startupConcurrency: 2,
    clock,
    actorFactory: async (entry, context) => {
      assert.equal(context.scheduler, runtime.scheduler);
      assert.equal(context.safetyScheduler, runtime.safetyScheduler);
      assert.equal(context.clock, clock);
      assert.equal(context.signal, runtime.signal);
      if (entry === 'factory-fail') throw Object.assign(new Error('factory broke'), { code: 'E_FACTORY' });
      let value = 0;
      const actor = {
        async start(receivedEntry, receivedContext) {
          assert.equal(receivedEntry, entry);
          assert.equal(receivedContext, context);
          active++;
          maxActive = Math.max(maxActive, active);
          const gate = deferred();
          gates.push({ id: entry, gate });
          await gate.promise;
          active--;
          if (entry === 'start-fail') throw new Error('start broke');
          value = 1;
        },
        snapshot() {
          return { schema: DEFAULT_ACTOR_STATE_SCHEMA, actor_id: entry, value };
        },
        publish(valueToPublish) {
          value = valueToPublish;
          return context.publishState({
            schema: DEFAULT_ACTOR_STATE_SCHEMA, actor_id: entry, value,
          });
        },
        transition(type, payload) { return context.publishTransition(type, payload); },
        stopped: 0,
        stop() { this.stopped++; },
      };
      actors.set(entry, actor);
      return actor;
    },
  });

  const initial = runtime.snapshot();
  assert.equal(initial.schema, FLEET_RUNTIME_SNAPSHOT_SCHEMA);
  assert.equal(initial.lifecycle, 'created');
  assert.equal(initial.actors.every(row => row.status === 'pending'), true);
  assert.equal(Object.isFrozen(initial.actors), true);

  const starting = runtime.start();
  assert.equal(starting, runtime.start(), 'concurrent start calls share one promise');
  await until(() => gates.length === 2);
  assert.equal(active, 2);
  assert.equal(gates.length, 2, 'the third actor does not start before capacity frees');

  while (true) {
    const unresolved = gates.splice(0);
    for (const row of unresolved) row.gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    if (runtime.stats.startup_active === 0 &&
        runtime.stats.startup_attempts === runtime.stats.total) break;
  }
  const result = await starting;
  assert.equal(result.ok, false);
  assert.equal(result.started, 3);
  assert.equal(result.failed, 2);
  assert.deepEqual(result.failures.map(row => row.id), ['factory-fail', 'start-fail']);
  assert.equal(result.failures[0].error.code, 'E_FACTORY');
  assert.equal(maxActive, 2);
  assert.equal(runtime.stats.max_startup_active, 2);
  assert.equal(runtime.lifecycle, 'running');

  const beforeMutation = runtime.snapshot();
  assert.equal(beforeMutation.actors.find(row => row.id === 'a').state.value, 1);
  const revision = beforeMutation.revision;
  actors.get('a').publish(7);
  assert.equal(runtime.snapshot().actors.find(row => row.id === 'a').state.value, 7);
  assert.equal(runtime.snapshot().revision, revision + 1);

  const streams = runtime.streamsFor('a');
  const transition = actors.get('a').transition('room-entered', { room: 42 });
  assert.equal(transition.state_revision, streams.stateChannel.revision);
  const batch = streams.transitions.read({
    streamId: streams.transitions.streamId,
    afterSequence: 0,
  });
  assert.deepEqual(batch.transitions.map(row => row.type), ['room-entered']);
  assert.equal(runtime.stats.pending_transitions, 1);
  streams.transitions.acknowledge(transition.sequence);

  const stop = await runtime.stop('test complete');
  assert.equal(stop.ok, true);
  assert.equal(runtime.lifecycle, 'stopped');
  assert.equal(runtime.signal.aborted, true);
  assert.equal(runtime.scheduler.stats.stopped, true);
  assert.equal(runtime.safetyScheduler.stats.stopped, true);
  assert.equal(await runtime.stop('again'), stop, 'stop is idempotent');
  assert.equal(actors.get('a').stopped, 1);
  assert.throws(() => streams.stateChannel.poll(), /test complete/);
  await assert.rejects(runtime.start(), /stopped permanently/);
}

// Aggregate snapshots are allowed to be slightly stale even though each actor channel is
// immediately authoritative. This bounds fleet-size cloning under a 100-actor event burst.
{
  const clock = new ManualClock({ startMs: 3000 });
  let context;
  const runtime = new FleetRuntime({
    runtimeId: 'snapshot-coalesce-test',
    entries: ['a'], clock, snapshotCoalesceMs: 100,
    actorFactory: (_entry, received) => { context = received; return {}; },
  });
  await runtime.start();
  const before = runtime.snapshot();
  context.publishState({ schema: DEFAULT_ACTOR_STATE_SCHEMA, actor_id: 'a', value: 9 });
  assert.equal(runtime.streamsFor('a').stateChannel.state.value, 9,
    'per-actor state is authoritative immediately');
  assert.equal(runtime.snapshot(), before, 'aggregate snapshot stays cached inside its window');
  clock.advanceBy(99);
  assert.equal(runtime.snapshot(), before, 'aggregate rebuild is not polled early');
  clock.advanceBy(1);
  assert.equal(runtime.snapshot().actors[0].state.value, 9,
    'one aggregate rebuild publishes the latest actor state');
  await runtime.stop();
}

// Stop racing an incomplete startup waits for the actor and tears it down exactly once.
{
  const clock = new ManualClock({ startMs: 2000 });
  const gate = deferred();
  let stopCalls = 0;
  const runtime = new FleetRuntime({
    runtimeId: 'stop-race-test',
    entries: [{ id: 'late' }],
    clock,
    actorFactory: () => ({
      async start() { await gate.promise; },
      stop() { stopCalls++; },
    }),
  });
  const start = runtime.start();
  await until(() => runtime.stats.startup_active === 1);
  const stop = runtime.stop('interrupted');
  gate.resolve();
  const startResult = await start;
  const stopResult = await stop;
  assert.equal(startResult.started, 0);
  assert.equal(startResult.aborted_count, 1);
  assert.deepEqual(startResult.aborted, ['late']);
  assert.equal(stopResult.ok, true);
  assert.equal(stopCalls, 1);
  assert.equal(runtime.snapshot().actors[0].status, 'stopped');
}

// Actor stop failures are reported but cannot prevent the rest of the fleet or streams
// from reaching terminal state.
{
  const runtime = new FleetRuntime({
    runtimeId: 'stop-failure-test',
    entries: ['good', 'bad'],
    actorFactory: id => ({
      stop() { if (id === 'bad') throw new Error('cannot stop'); },
    }),
  });
  assert.equal((await runtime.start()).ok, true);
  const stopped = await runtime.stop();
  assert.equal(stopped.ok, false);
  assert.equal(stopped.failed, 1);
  assert.equal(stopped.failures[0].id, 'bad');
  assert.equal(runtime.lifecycle, 'stopped');
  assert.equal(runtime.stats.stop_failures, 1);
}

console.log('fleet runtime: PASS');
