#!/usr/bin/env node
// Offline 100-actor live-state stress. Uses the real fleet/state channels with synthetic
// actors only: no roster credentials, Meridian Session import, server, or socket.
//
//   node tools/runtime/fleet-live-state-stress-test.mjs

import assert from 'node:assert/strict';

import { ManualClock } from './clock/index.mjs';
import {
  DEFAULT_ACTOR_STATE_SCHEMA,
  FleetRuntime,
} from './fleet-runtime.mjs';
import { applyStateMessage } from './state/index.mjs';

const ACTOR_COUNT = 100;
const UPDATES_PER_ACTOR = 100;
const TRANSITION_INTERVAL = 25;
const SNAPSHOT_COALESCE_MS = 250;

const entries = Array.from({ length: ACTOR_COUNT }, (_, index) => ({
  id: `synthetic-${String(index + 1).padStart(3, '0')}`,
}));

function syntheticState(id, generation) {
  const actor = Number(id.slice(-3));
  return {
    schema: DEFAULT_ACTOR_STATE_SCHEMA,
    actor_id: id,
    connected: true,
    in_game: true,
    room: {
      num: 500 + (actor % 9),
      col: (actor + generation) % 64,
      row: (actor * 3 + generation) % 64,
    },
    vitals: {
      health: { value: 120 - (generation % 20), max: 120 },
      mana: { value: generation % 40, max: 40 },
      vigor: { value: 80 + (generation % 20), max: 100 },
    },
    event_revision: generation,
  };
}

const clock = new ManualClock({ startMs: 10_000 });
const contexts = new Map();
let stoppedActors = 0;

const runtime = new FleetRuntime({
  runtimeId: 'offline-100-actor-live-state',
  entries,
  idOf: entry => entry.id,
  startupConcurrency: 10,
  clock,
  snapshotCoalesceMs: SNAPSHOT_COALESCE_MS,
  maxPendingTransitions: Math.ceil(UPDATES_PER_ACTOR / TRANSITION_INTERVAL),
  initialState: (_entry, id) => syntheticState(id, 0),
  actorFactory(entry, context) {
    // Entries intentionally contain identity only. This keeps the stress path independent
    // of a real roster and makes accidental credential dependence fail visibly.
    assert.deepEqual(Object.keys(entry), ['id']);
    contexts.set(entry.id, context);
    return {
      start() {},
      stop() { stoppedActors++; },
    };
  },
});

const started = await runtime.start();
assert.deepEqual(
  { ok: started.ok, total: started.total, started: started.started, failed: started.failed },
  { ok: true, total: ACTOR_COUNT, started: ACTOR_COUNT, failed: 0 },
);
assert.equal(contexts.size, ACTOR_COUNT);

const baselineSnapshot = runtime.snapshot();
const baselineRevision = baselineSnapshot.revision;
const cursors = new Map(entries.map(({ id }) => {
  const channel = runtime.streamsFor(id).stateChannel;
  return [id, applyStateMessage(null, channel.fullSnapshot('stress-bootstrap')).cursor];
}));

for (let generation = 1; generation <= UPDATES_PER_ACTOR; generation++) {
  for (const { id } of entries) {
    const context = contexts.get(id);
    context.publishState(syntheticState(id, generation), {
      observedAtMs: 10_000 + generation,
    });
    if (generation % TRANSITION_INTERVAL === 0) {
      context.publishTransition('safety-checkpoint', { generation }, {
        atMs: 10_000 + generation,
      });
    }
  }
}

const expectedPublications = ACTOR_COUNT * UPDATES_PER_ACTOR;
const expectedTransitions = ACTOR_COUNT * (UPDATES_PER_ACTOR / TRANSITION_INTERVAL);
assert.equal(runtime.stats.state_publications, expectedPublications);
assert.equal(runtime.stats.state_changes, expectedPublications);
assert.equal(runtime.stats.pending_state_messages, ACTOR_COUNT,
  'each actor retains at most one coalesced observational update');
assert.equal(runtime.stats.pending_transitions, expectedTransitions,
  'critical transitions remain exact until acknowledged');
assert.equal(runtime.snapshot(), baselineSnapshot,
  'the aggregate snapshot is not rebuilt for every publication in the burst');

clock.advanceBy(SNAPSHOT_COALESCE_MS - 1);
assert.equal(runtime.snapshot(), baselineSnapshot,
  'the aggregate snapshot remains cached until its exact deadline');
clock.advanceBy(1);

const aggregate = runtime.snapshot();
assert.equal(aggregate.revision, baselineRevision + 1,
  'the whole 10,000-update burst causes one aggregate rebuild');
assert.equal(aggregate.total, ACTOR_COUNT);
assert.equal(aggregate.actors.length, ACTOR_COUNT);
for (const actor of aggregate.actors) {
  assert.equal(actor.status, 'running');
  assert.equal(actor.state.event_revision, UPDATES_PER_ACTOR);
  assert.deepEqual(actor.state, syntheticState(actor.id, UPDATES_PER_ACTOR));
}

for (const { id } of entries) {
  const { stateChannel, transitions } = runtime.streamsFor(id);
  const cursor = cursors.get(id);
  const message = stateChannel.poll({
    streamId: cursor.stream_id,
    afterRevision: cursor.revision,
  });
  assert.equal(message.kind, 'delta');
  assert.equal(message.base_revision, 0);
  assert.equal(message.revision, UPDATES_PER_ACTOR);
  assert.equal(message.coalesced_revisions, UPDATES_PER_ACTOR);
  const applied = applyStateMessage(cursor, message);
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.cursor.state, syntheticState(id, UPDATES_PER_ACTOR));

  const batch = transitions.read({
    streamId: transitions.streamId,
    afterSequence: 0,
  });
  assert.deepEqual(
    batch.transitions.map(row => row.payload.generation),
    [25, 50, 75, 100],
  );
  assert.deepEqual(
    batch.transitions.map(row => row.state_revision),
    [25, 50, 75, 100],
  );
  transitions.acknowledge(batch.transitions.at(-1).sequence);
}

assert.equal(runtime.stats.pending_state_messages, 0);
assert.equal(runtime.stats.pending_transitions, 0);
assert.equal(runtime.stats.state_delivery_failures, 0);
assert.equal(runtime.stats.transition_delivery_failures, 0);

const stopped = await runtime.stop('offline stress complete');
assert.equal(stopped.ok, true);
assert.equal(stopped.stopped, ACTOR_COUNT);
assert.equal(stoppedActors, ACTOR_COUNT);

console.log(
  `fleet live-state stress: PASS (${ACTOR_COUNT} actors, ` +
  `${expectedPublications} state changes, ${expectedTransitions} critical transitions)`,
);
