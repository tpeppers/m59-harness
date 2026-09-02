#!/usr/bin/env node
// Offline shard control-plane invariants. No Meridian import, sockets, roster, or fleet.
//
//   node tools/runtime/shards/shards-runtime-test.mjs

import assert from 'node:assert/strict';

import { RuntimeControlServer } from '../control-server.mjs';
import {
  ShardChildReporter,
  ShardFleetAggregator,
  ShardParentController,
  assertShardFrame,
  createFleetRuntimeShardHooks,
} from './index.mjs';

class FakeEndpoint {
  constructor(name) {
    this.name = name;
    this.peer = null;
    this.messageHandlers = new Set();
    this.closeHandlers = new Set();
    this.errorHandlers = new Set();
    this.heldKinds = new Set();
    this.held = [];
    this.sent = [];
    this.closed = false;
  }

  send(frame) {
    if (this.closed) throw new Error(`${this.name} transport is closed`);
    const copy = structuredClone(frame);
    this.sent.push(copy);
    if (this.heldKinds.has(copy.kind)) this.held.push(copy);
    else queueMicrotask(() => this.peer._deliver(copy));
  }

  _deliver(frame) {
    if (this.closed) return;
    for (const handler of this.messageHandlers) handler(structuredClone(frame));
  }

  releaseOne(kind = null) {
    const index = this.held.findIndex(frame => kind == null || frame.kind === kind);
    if (index < 0) return false;
    const [frame] = this.held.splice(index, 1);
    queueMicrotask(() => this.peer._deliver(frame));
    return true;
  }

  releaseAll() { while (this.releaseOne()) {} }
  onMessage(handler) { this.messageHandlers.add(handler); return () => this.messageHandlers.delete(handler); }
  onClose(handler) { this.closeHandlers.add(handler); return () => this.closeHandlers.delete(handler); }
  onError(handler) { this.errorHandlers.add(handler); return () => this.errorHandlers.delete(handler); }
  close(details = { source: 'fake-close', code: 0, signal: null }) {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler(details);
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true;
      for (const handler of this.peer.closeHandlers) handler(details);
    }
  }
}

function fakePair() {
  const parent = new FakeEndpoint('parent');
  const child = new FakeEndpoint('child');
  parent.peer = child;
  child.peer = parent;
  return { parent, child };
}

async function settle(rounds = 16) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

async function connectedPair({
  shardId = 'shard-1',
  actorIds = ['a', 'b'],
  childOptions = {},
  parentOptions = {},
} = {}) {
  const pair = fakePair();
  const parent = new ShardParentController({
    transport: pair.parent, shardId, expectedActorIds: actorIds,
    transitionWindow: 2, stateWindow: 1,
    ...parentOptions,
  });
  const child = new ShardChildReporter({
    transport: pair.child, shardId, actorIds, bootId: `${shardId}-boot`, processId: 1234,
    maxTransitionInFlight: 2, maxStateInFlight: 1,
    ...childOptions,
  });
  const parentReady = parent.start();
  const childReady = child.start();
  await Promise.all([parentReady, childReady]);
  return { pair, parent, child };
}

// Construction and protocol parsing fail closed.
{
  const pair = fakePair();
  assert.throws(() => new ShardParentController({
    transport: pair.parent, shardId: 'x', expectedActorIds: ['a', 'a'],
  }), /duplicates/);
  assert.throws(() => assertShardFrame({ password: 'do-not-copy' }), /unrecognized/);
}

// A malformed first frame is terminal on either side; readiness rejects instead of
// remaining pending behind a handshake that can never succeed.
{
  const parentPair = fakePair();
  const parent = new ShardParentController({
    transport: parentPair.parent, shardId: 'bad-parent', expectedActorIds: ['a'],
  });
  const parentReady = parent.start();
  parentPair.child.send({ bogus: true });
  await assert.rejects(parentReady, /invalid child IPC frame/);
  await settle();
  assert.match(parent.lifecycle, /crashed|disconnected/);

  const childPair = fakePair();
  const child = new ShardChildReporter({
    transport: childPair.child, shardId: 'bad-child', actorIds: ['a'], bootId: 'bad-boot',
  });
  const childReady = child.start();
  childPair.parent.send({ bogus: true });
  await assert.rejects(childReady, /invalid parent IPC control/);
  await settle();
  assert.match(child.lifecycle, /crashed|disconnected/);
}

// Handshake fixes shard, boot, PID, and exact actor assignment. State is bounded to one
// in-flight plus one replaceable latest slot: revision 2 never crosses the transport.
{
  const { pair, parent, child } = await connectedPair();
  assert.equal(parent.lifecycle, 'ready');
  assert.equal(child.lifecycle, 'ready');
  assert.equal(parent.snapshot().process_id, 1234);
  pair.child.heldKinds.add('state');
  child.publishState('a', { schema: 'actor/v1', value: 1 }, { revision: 1 });
  child.publishState('a', { schema: 'actor/v1', value: 2 }, { revision: 2 });
  child.publishState('a', { schema: 'actor/v1', value: 3 }, { revision: 3 });
  assert.deepEqual(pair.child.sent.filter(frame => frame.kind === 'state').map(frame => frame.revision), [1]);
  pair.child.releaseOne('state');
  await settle();
  assert.deepEqual(pair.child.sent.filter(frame => frame.kind === 'state').map(frame => frame.revision), [1, 3]);
  pair.child.releaseOne('state');
  await settle();
  assert.equal(parent.snapshot().actors.find(row => row.id === 'a').state.value, 3);
  assert.equal(child.counters.state_coalesced, 1);
}

// A hot early actor cannot monopolize a small state window: admission rotates across
// actors even when that actor already has another latest snapshot waiting.
{
  const { pair, child } = await connectedPair();
  pair.child.heldKinds.add('state');
  child.publishState('a', { schema: 'actor/v1', value: 1 });
  child.publishState('b', { schema: 'actor/v1', value: 1 });
  child.publishState('a', { schema: 'actor/v1', value: 2 });
  pair.child.releaseOne('state');
  await settle();
  assert.deepEqual(pair.child.sent.filter(frame => frame.kind === 'state')
    .map(frame => frame.actor_id), ['a', 'b']);
}

// Critical transitions are exact, per actor, and bounded by the negotiated global
// window. Parent receipt does not free child memory; the local stream ACK does.
{
  const { parent, child } = await connectedPair();
  const one = child.publishTransition('a', 'room-entered', { room: 1 });
  const two = child.publishTransition('a', 'room-entered', { room: 2 });
  const three = child.publishTransition('a', 'room-entered', { room: 3 });
  assert.deepEqual([one.sequence, two.sequence, three.sequence], [1, 2, 3]);
  await settle();
  const transitions = parent.streamsFor('a').transitions;
  assert.equal(transitions.pendingCount, 2, 'third event remains in child behind window');
  assert.throws(() => transitions.acknowledge(1), /undelivered/);
  const firstBatch = transitions.read({
    streamId: transitions.streamId, afterSequence: 0, limit: 1,
  });
  assert.deepEqual(firstBatch.transitions.map(row => row.payload.room), [1]);
  transitions.acknowledge(1);
  await settle();
  assert.equal(transitions.pendingCount, 2, 'ack propagates and admits third event');
  const rest = transitions.read({
    streamId: transitions.streamId, afterSequence: 1, limit: 10,
  });
  assert.deepEqual(rest.transitions.map(row => row.payload.room), [2, 3]);
  transitions.acknowledge(3);
  await settle();
  assert.equal(child.pendingTransitionCount, 0);
  assert.equal(parent.stats.pending_transitions, 0);
  // A delayed duplicate ACK is idempotent and cannot inflate the child's in-flight count.
  const staleAck = structuredClone(parent.transport.sent
    .find(frame => frame.kind === 'transition-ack' && frame.through_sequence === 1));
  parent.transport.send(staleAck);
  await settle();
  assert.equal(child.transitionInFlight, 0);
}

// Throwing sinks are retryable: frame-size validation happens before sequence/pending
// mutation, so an oversized publication leaves no phantom first attempt behind.
{
  const { child } = await connectedPair({ childOptions: { maxFrameBytes: 512 } });
  const record = child.records.get('a');
  const beforeCount = child.counters.transition_published;
  assert.throws(() => child.publishTransition('a', 'oversized', {
    value: 'x'.repeat(4000),
  }), /exceeds 512 bytes/);
  assert.equal(record.transitions.publishedThrough, 0);
  assert.equal(record.transitions.pendingCount, 0);
  assert.equal(child.pendingTransitionCount, 0);
  assert.equal(child.counters.transition_published, beforeCount);
  assert.equal(child.publishTransition('a', 'retry-small', { value: 1 }).sequence, 1);
}

// Producer pressure is explicit rather than lossy. No unacknowledged exact event is
// evicted to make room for a later event.
{
  const { pair, child } = await connectedPair({
    childOptions: { maxPendingTransitionsPerActor: 2 },
  });
  pair.child.heldKinds.add('transition');
  child.publishTransition('a', 'one');
  child.publishTransition('a', 'two');
  assert.throws(() => child.publishTransition('a', 'three'), /backpressure/);
  assert.equal(child.records.get('a').transitions.pendingCount, 2);
}

// Telemetry is projected before crossing the boundary. Credential-shaped fields and
// labelled strings cannot appear in parent snapshots, transition payloads, or errors.
{
  const { parent, child } = await connectedPair();
  child.publishState('a', {
    schema: 'actor/v1', password: 'hunter2', nested: { access_token: 'state-secret' },
    note: 'Bearer state-bearer',
  });
  child.publishTransition('a', 'login-observed', {
    credential: 'transition-secret', note: 'token=transition-labelled',
  });
  child.publishHealth('ok', { cookie: 'health-secret' });
  child.reportCrash(Object.assign(new Error('password=exception-secret'), { code: 'E_FAKE' }), {
    origin: 'test', fatal: false,
  });
  await settle();
  const stateText = JSON.stringify(parent.snapshot());
  assert.doesNotMatch(stateText, /hunter2|state-secret|state-bearer|health-secret|exception-secret/);
  assert.match(stateText, /\[redacted\]/);
  const transitions = parent.streamsFor('a').transitions;
  const batch = transitions.read({ streamId: transitions.streamId, afterSequence: 0 });
  const transitionText = JSON.stringify(batch);
  assert.doesNotMatch(transitionText, /transition-secret|transition-labelled/);
  assert.match(transitionText, /\[redacted\]/);
}

// Init uses its own confidential schema. The verifier sees the ownership permit; neither
// acknowledgement nor any parent snapshot echoes it. waitForInit returns verifier output.
{
  let verifiedPayload;
  const { pair, parent, child } = await connectedPair({
    childOptions: {
      verifyInit(payload) {
        verifiedPayload = payload;
        return { verified: true, actors: payload.actorIds.length };
      },
    },
  });
  const childInit = child.waitForInit();
  const parentInit = parent.sendInit({
    fleet: 'lab', stateFile: 'C:/private/fleet-state-lab.json', actorIds: ['a', 'b'],
    permit: { token: 'permit-private-value' },
  });
  assert.deepEqual(await childInit, { verified: true, actors: 2 });
  assert.equal((await parentInit).ok, true);
  assert.equal(verifiedPayload.permit.token, 'permit-private-value');
  assert.doesNotMatch(JSON.stringify(parent.snapshot()), /permit-private-value/);
  const childTelemetry = pair.child.sent.filter(frame => frame.schema !== 'm59-shard-init/v1');
  assert.doesNotMatch(JSON.stringify(childTelemetry), /permit-private-value/);
}

// FleetRuntime hook names and synchronous transition ownership match the runtime seam.
{
  const { child } = await connectedPair();
  const hooks = createFleetRuntimeShardHooks(child);
  assert.deepEqual(Object.keys(hooks).sort(), ['onStateChanged', 'transitionSink']);
  hooks.onStateChanged({
    id: 'a', state: { schema: 'actor/v1', value: 4 }, revision: 1, observedAtMs: 10,
  });
  const transition = hooks.transitionSink({
    id: 'a', type: 'job-complete', payload: { ok: true }, stateRevision: 1, atMs: 11,
  });
  assert.equal(transition.sequence, 1);
}

// Aggregator implements the RuntimeControlServer contract and preserves actor-to-shard
// ownership for stream acknowledgement.
{
  const { parent, child } = await connectedPair({ actorIds: ['actor-one'] });
  const aggregate = new ShardFleetAggregator({ controllers: [parent], runtimeId: 'aggregate-test' });
  assert.equal((await aggregate.start()).ok, true);
  child.publishState('actor-one', { schema: 'actor/v1', value: 8 });
  child.publishTransition('actor-one', 'safe', { value: 1 });
  await settle();
  assert.equal(aggregate.snapshot().actors[0].shard_id, 'shard-1');
  assert.equal(aggregate.stats.actors, 1);
  assert.equal(aggregate.streamsFor('actor-one'), parent.streamsFor('actor-one'));
  assert.equal(aggregate.streamsFor('missing'), null);
  const control = new RuntimeControlServer({ runtime: aggregate, onStop: () => aggregate.stop() });
  await control.close();
}

// Graceful stop reports success before transport close; an unannounced close is surfaced
// as a synthetic crash without copying arbitrary transport error messages.
{
  let stoppedReason;
  const graceful = await connectedPair({
    childOptions: { onStop: reason => { stoppedReason = reason; } },
  });
  const result = await graceful.parent.requestStop('test complete');
  assert.equal(result.ok, true);
  assert.equal(stoppedReason, 'test complete');
  graceful.pair.child.close();
  assert.equal(graceful.parent.lifecycle, 'stopped');
  assert.equal(graceful.parent.snapshot().crash, null);

  const refused = await connectedPair({
    shardId: 'stop-refused',
    childOptions: {
      onStop: async () => ({
        ok: false,
        failures: [{ error: {
          code: 'M59_RUNTIME_STOP_FAILED',
          message: 'password=must-not-cross-stop-result',
        } }],
      }),
    },
  });
  const refusedResult = await refused.parent.requestStop('expected refusal');
  assert.equal(refusedResult.ok, false);
  assert.equal(refusedResult.error.code, 'M59_RUNTIME_STOP_FAILED');
  assert.equal(refused.child.lifecycle, 'stop-failed');
  assert.doesNotMatch(JSON.stringify(refusedResult), /must-not-cross-stop-result/);

  const failed = await connectedPair({ shardId: 'crash-shard' });
  failed.pair.child.close({ source: 'fake-crash', code: 9, signal: 'SIGKILL' });
  assert.equal(failed.parent.lifecycle, 'disconnected');
  assert.equal(failed.parent.snapshot().crash.fatal, true);
  assert.equal(failed.parent.snapshot().crash.close.code, 9);
}

console.log('shard runtime tests: PASS');
