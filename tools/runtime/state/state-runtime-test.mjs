#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  AcknowledgedTransitionStream,
  CoalescedStateChannel,
  PRIMARY_STATE_SCHEMA,
  SnapshotStore,
  applyStateMessage,
  projectPrimaryState,
} from './index.mjs';

function actor(overrides = {}) {
  return {
    agent: 't1', character: 'Kermit', connected: true, in_game: true,
    socket: { phase: 'game', last_rx_at_ms: 1000, last_tx_at_ms: 900 },
    room: { num: 200, name: 'Marion', object_id: 812 },
    you: { id: 42, col: 10, row: 11, x: 640, y: 704, facing: 90 },
    vitals: {
      health: { value: 101, max: 120 }, mana: { value: 30, max: 40 },
      vigor: { value: 17, max: 25 },
    },
    gold: 75,
    activity: { driver: 'goap', mode: 'farm', running: true, goal: 'survive', action: 'rest' },
    revisions: { events: 7, room: 2, inventory: 4, equipment: 3, trade: 0 },
    ...overrides,
  };
}

// Projection is a whitelist of primitive model facts. Even hostile accessors and familiar
// derived-service names remain untouched.
{
  let accidentalCalls = 0;
  const source = actor({
    route() { accidentalCalls++; throw new Error('route called'); },
    threat() { accidentalCalls++; throw new Error('threat called'); },
  });
  Object.defineProperty(source, 'exits', {
    enumerable: true,
    get() { accidentalCalls++; throw new Error('exits read'); },
  });
  Object.defineProperty(source.room, 'routing', {
    enumerable: true,
    get() { accidentalCalls++; throw new Error('routing read'); },
  });
  const state = projectPrimaryState(source);
  assert.equal(accidentalCalls, 0);
  assert.equal(state.schema, PRIMARY_STATE_SCHEMA);
  assert.deepEqual(state.room, { num: 200, name: 'Marion', object_id: 812 });
  assert.deepEqual(state.vitals.health, { value: 101, max: 120 });
  assert.equal(state.objects, undefined);
  assert.equal(state.exits, undefined);
  assert.equal(state.threat, undefined);
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.vitals));
}

// The snapshot store owns immutable state and advances only for semantic changes.
{
  const initial = projectPrimaryState(actor());
  const store = new SnapshotStore({ stateSchema: PRIMARY_STATE_SCHEMA, initialState: initial, revision: 40 });
  assert.deepEqual(store.commit(projectPrimaryState(actor())), {
    changed: false, revision: 40, operations: [],
  });
  const input = projectPrimaryState(actor({ gold: 76 }));
  const committed = store.commit(input, { observedAtMs: 1234 });
  assert.equal(committed.changed, true);
  assert.equal(committed.previousRevision, 40);
  assert.equal(store.revision, 41);
  assert.equal(store.state.gold, 76);
  assert.equal(store.snapshot().observed_at_ms, 1234);
}

// Multiple publications occupy one slot and produce one delta from the original base to
// the latest value. The consumer can apply that coalesced jump directly.
let channel;
let cursor;
{
  const initial = projectPrimaryState(actor());
  channel = new CoalescedStateChannel({
    streamId: 'prod/t1/run-1', stateSchema: PRIMARY_STATE_SCHEMA, initialState: initial,
  });
  cursor = applyStateMessage(null, channel.fullSnapshot('bootstrap')).cursor;
  channel.publish(projectPrimaryState(actor({ gold: 76 })));
  channel.publish(projectPrimaryState(actor({ gold: 77 })));
  channel.publish(projectPrimaryState(actor({ gold: 78 })));
  assert.equal(channel.revision, 3);
  assert.equal(channel.pendingCount, 1);
  const delta = channel.poll({ streamId: cursor.stream_id, afterRevision: cursor.revision });
  assert.equal(delta.kind, 'delta');
  assert.equal(delta.base_revision, 0);
  assert.equal(delta.revision, 3);
  assert.equal(delta.coalesced_revisions, 3);
  assert.equal(channel.pendingCount, 0);
  const applied = applyStateMessage(cursor, delta);
  assert.equal(applied.applied, true);
  assert.equal(applied.cursor.state.gold, 78);
  cursor = applied.cursor;
  assert.equal(channel.poll({ streamId: cursor.stream_id, afterRevision: cursor.revision }), null);
}

// If a delivered delta is dropped, the next read from the old cursor cannot accidentally
// apply against the wrong base. It receives a full authoritative repair snapshot.
{
  channel.publish(projectPrimaryState(actor({ gold: 79 })));
  const dropped = channel.poll({ streamId: cursor.stream_id, afterRevision: cursor.revision });
  assert.equal(dropped.kind, 'delta');
  channel.publish(projectPrimaryState(actor({ gold: 80 })));
  const repair = channel.poll({ streamId: cursor.stream_id, afterRevision: cursor.revision });
  assert.equal(repair.kind, 'snapshot');
  assert.equal(repair.repair.reason, 'sequence-gap');
  const repaired = applyStateMessage(cursor, repair);
  assert.equal(repaired.cursor.state.gold, 80);
  assert.equal(repaired.cursor.revision, 5);
  cursor = repaired.cursor;
}

// A blocked read wakes on a publication rather than polling.
{
  const waiting = channel.next({ streamId: cursor.stream_id, afterRevision: cursor.revision });
  queueMicrotask(() => channel.publish(projectPrimaryState(actor({ gold: 81 }))));
  const message = await waiting;
  assert.equal(message.kind, 'delta');
  assert.equal(message.revision, 6);
  cursor = applyStateMessage(cursor, message).cursor;
}

// Waits are cancellable without leaving a hidden reader that consumes the next update.
{
  const aborter = new AbortController();
  const waiting = channel.next(
    { streamId: cursor.stream_id, afterRevision: cursor.revision },
    { signal: aborter.signal },
  );
  aborter.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
}

// A syntactically valid delta with the wrong base is rejected without mutating the cursor.
{
  const staleCursor = { ...cursor, revision: cursor.revision - 1 };
  channel.publish(projectPrimaryState(actor({ gold: 82 })));
  const message = channel.poll({ streamId: cursor.stream_id, afterRevision: cursor.revision });
  const rejected = applyStateMessage(staleCursor, message);
  assert.equal(rejected.applied, false);
  assert.equal(rejected.needs_snapshot, true);
  assert.equal(rejected.reason, 'sequence-gap');
  cursor = applyStateMessage(cursor, message).cursor;
}

// Critical transitions are retained separately, delivered in order, and removed only by
// acknowledgement. Capacity exhaustion refuses the producer instead of losing an event.
{
  let now = 5000;
  const critical = new AcknowledgedTransitionStream({
    streamId: 'prod/t1/critical-1', maxPending: 3, now: () => now++,
  });
  const firstPayload = { room: 200 };
  critical.publish('room-left', firstPayload, { stateRevision: 6 });
  firstPayload.room = 999;
  critical.publish('room-entered', { room: 201 }, { stateRevision: 7 });
  critical.publish('job-finished', { ok: true }, { stateRevision: 7 });
  assert.equal(critical.pendingCount, 3);
  assert.throws(() => critical.publish('death', {}, { stateRevision: 8 }), /backpressure/);

  const firstBatch = critical.read({
    streamId: 'prod/t1/critical-1', afterSequence: 0, limit: 2,
  });
  assert.deepEqual(firstBatch.transitions.map(row => row.type), ['room-left', 'room-entered']);
  assert.equal(firstBatch.transitions[0].payload.room, 200);
  assert.throws(() => critical.acknowledge(3), /undelivered/);
  assert.equal(critical.acknowledge(2), 2);
  assert.equal(critical.pendingCount, 1);
  assert.throws(() => critical.publish('bad-revision', {}, { stateRevision: 6 }), /monotonic/);

  const oldCursor = critical.read({ streamId: 'prod/t1/critical-1', afterSequence: 0 });
  assert.equal(oldCursor.gap.reason, 'sequence-gap');
  assert.equal(oldCursor.gap.requires_snapshot, true);

  const skipped = critical.read({ streamId: 'prod/t1/critical-1', afterSequence: 3 });
  assert.equal(skipped.gap.reason, 'undelivered-cursor');
  const remaining = critical.read({ streamId: 'prod/t1/critical-1', afterSequence: 2 });
  assert.deepEqual(remaining.transitions.map(row => row.type), ['job-finished']);
  assert.equal(critical.acknowledge(3), 3);

  const waiting = critical.wait({ streamId: 'prod/t1/critical-1', afterSequence: 3 });
  critical.publish('death', { room: 201 }, { stateRevision: 8 });
  const nextBatch = await waiting;
  assert.deepEqual(nextBatch.transitions.map(row => row.type), ['death']);
  assert.equal(critical.acknowledge(4), 4);
  assert.equal(critical.pendingCount, 0);
}

channel.close();
console.log('runtime state projection/channels: PASS');
