import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import {
  AcknowledgedTransitionStream,
  CRITICAL_TRANSITION_SCHEMA,
} from '../state/index.mjs';
import {
  SHARD_INIT_SCHEMA,
  actorIdentifier,
  assertShardFrame,
  assertShardInitFrame,
  frameSequence,
  frameTime,
  normalizedActorIds,
  shardFrame,
  shardIdentifier,
} from './protocol.mjs';
import { assertFrameBytes, safeErrorDetails, safeIpcString, safeIpcValue } from './safe-value.mjs';
import { assertShardTransport } from './transport.mjs';
import { normalizeVerifierInitResult } from './init-result.mjs';

const DEFAULT_STATE_SCHEMA = 'm59-runtime-actor-state/v1';
const SAFE_STOP_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;

function positiveInteger(value, fallback, label) {
  const result = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw new RangeError(`${label} must be a positive safe integer`);
  return result;
}

function currentTime(now) {
  return frameTime(Math.floor(Number(now())), 'clock time');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject, settled: false };
}

function abortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function stopFailure(result) {
  const candidate = result?.code ?? result?.error?.code ?? result?.failures?.[0]?.error?.code;
  const code = typeof candidate === 'string' && SAFE_STOP_CODE.test(candidate)
    ? candidate
    : 'M59_SHARD_STOP_FAILED';
  return Object.assign(new Error('shard runtime stop failed'), { code });
}

export class ShardChildReporter {
  constructor({
    transport,
    shardId,
    actorIds,
    bootId = randomUUID(),
    now = Date.now,
    processId = process.pid,
    maxActors = 1000,
    maxFrameBytes = 1024 * 1024,
    maxPendingTransitionsPerActor = 128,
    maxPendingTransitionsTotal = 4096,
    maxTransitionInFlight = 64,
    maxStateInFlight = 32,
    onStop = async () => {},
    verifyInit = async value => value,
  } = {}) {
    this.transport = assertShardTransport(transport);
    this.shardId = shardIdentifier(shardId);
    this.bootId = shardIdentifier(bootId, 'boot id');
    this.actorIds = normalizedActorIds([...actorIds], { maximum: maxActors });
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof onStop !== 'function') throw new TypeError('onStop must be a function');
    if (typeof verifyInit !== 'function') throw new TypeError('verifyInit must be a function');
    this.now = now;
    this.processId = Number.isSafeInteger(processId) && processId > 0 ? processId : null;
    this.maxFrameBytes = positiveInteger(maxFrameBytes, 1024 * 1024, 'maxFrameBytes');
    this.maxPendingTransitionsPerActor = positiveInteger(
      maxPendingTransitionsPerActor, 128, 'maxPendingTransitionsPerActor');
    this.maxPendingTransitionsTotal = positiveInteger(
      maxPendingTransitionsTotal, 4096, 'maxPendingTransitionsTotal');
    this.configuredTransitionWindow = positiveInteger(
      maxTransitionInFlight, 64, 'maxTransitionInFlight');
    this.configuredStateWindow = positiveInteger(maxStateInFlight, 32, 'maxStateInFlight');
    this.transitionWindow = 0;
    this.stateWindow = 0;
    this.onStop = onStop;
    this.verifyInit = verifyInit;
    this.events = new EventEmitter();
    this.lifecycle = 'created';
    this.records = new Map();
    this.recordList = [];
    this.transitionInFlight = 0;
    this.stateInFlight = 0;
    this.stateCursor = 0;
    this.transitionCursor = 0;
    this.healthRevision = 0;
    this.healthPending = null;
    this.healthInFlight = null;
    this.lastInitRequestId = null;
    this.lastInitAck = null;
    this.initResult = deferred();
    this.readyResult = deferred();
    // Deferred failures are still observable through ready/waitForInit(), but do not
    // become process-level unhandled rejections if a protocol fault wins a startup race.
    void this.initResult.promise.catch(() => {});
    void this.readyResult.promise.catch(() => {});
    this.stopResult = null;
    this.stopPromise = null;
    this.crashFrame = null;
    this.unsubscribers = [];
    this.counters = {
      frames_sent: 0,
      frames_received: 0,
      state_published: 0,
      state_coalesced: 0,
      transition_published: 0,
      transition_acked: 0,
      health_published: 0,
      health_coalesced: 0,
      protocol_errors: 0,
    };

    for (const id of this.actorIds) {
      const streamId = `${this.bootId}/actor/${encodeURIComponent(id)}/transitions`;
      const record = {
        id,
        stateRevision: 0,
        statePending: null,
        stateInFlight: null,
        sentThrough: 0,
        transitions: new AcknowledgedTransitionStream({
          streamId,
          maxPending: this.maxPendingTransitionsPerActor,
          now: () => currentTime(this.now),
        }),
      };
      this.records.set(id, record);
      this.recordList.push(record);
    }
  }

  on(event, handler) {
    this.events.on(event, handler);
    return () => this.events.off(event, handler);
  }

  get ready() { return this.readyResult.promise; }

  start() {
    if (this.lifecycle !== 'created') return this.ready;
    this.lifecycle = 'handshaking';
    this.unsubscribers.push(this.transport.onMessage(frame => this._receive(frame)));
    this.unsubscribers.push(this.transport.onClose(details => this._transportClosed(details)));
    if (typeof this.transport.onError === 'function')
      this.unsubscribers.push(this.transport.onError(error => this._transportFailed(error)));
    this._send(shardFrame('child', 'hello', {
      shardId: this.shardId,
      bootId: this.bootId,
      at_ms: currentTime(this.now),
      actor_ids: this.actorIds,
      ...(this.processId === null ? {} : { process_id: this.processId }),
      max_transition_window: this.configuredTransitionWindow,
      max_state_window: this.configuredStateWindow,
      max_pending_transitions_per_actor: this.maxPendingTransitionsPerActor,
    }));
    return this.ready;
  }

  waitForInit({ signal } = {}) {
    if (!signal) return this.initResult.promise;
    if (signal.aborted) return Promise.reject(abortError('shard initialization aborted'));
    return Promise.race([
      this.initResult.promise,
      new Promise((_, reject) => signal.addEventListener(
        'abort', () => reject(abortError('shard initialization aborted')), { once: true })),
    ]);
  }

  publishState(actorId, state, {
    revision = null,
    observedAtMs = currentTime(this.now),
    stateSchema = state?.schema ?? DEFAULT_STATE_SCHEMA,
  } = {}) {
    const record = this._record(actorId);
    const nextRevision = revision == null ? record.stateRevision + 1
      : frameSequence(revision, 'state revision');
    if (nextRevision <= record.stateRevision)
      throw new RangeError('state revisions must increase monotonically');
    const frame = shardFrame('child', 'state', {
      shardId: this.shardId,
      bootId: this.bootId,
      actor_id: record.id,
      revision: nextRevision,
      observed_at_ms: frameTime(observedAtMs, 'state observation time'),
      state_schema: safeIpcString(stateSchema, { label: 'state schema', maximum: 160 }),
      state: safeIpcValue(state),
    });
    assertFrameBytes(frame, this.maxFrameBytes, 'state frame');
    if (record.statePending) this.counters.state_coalesced++;
    record.stateRevision = nextRevision;
    record.statePending = frame;
    this.counters.state_published++;
    this._pumpState();
    return Object.freeze({ accepted: true, revision: nextRevision });
  }

  publishTransition(actorId, type, payload = {}, {
    stateRevision = 0,
    atMs = currentTime(this.now),
  } = {}) {
    const record = this._record(actorId);
    if (this.pendingTransitionCount >= this.maxPendingTransitionsTotal) {
      const error = new Error('shard transition backpressure: total pending limit reached');
      error.code = 'M59_SHARD_TRANSITION_BACKPRESSURE';
      error.pending = this.pendingTransitionCount;
      error.limit = this.maxPendingTransitionsTotal;
      throw error;
    }
    const safeType = safeIpcString(type, { label: 'transition type', maximum: 160 });
    const safePayload = safeIpcValue(payload);
    const safeStateRevision = frameSequence(stateRevision, 'transition state revision');
    const safeAtMs = frameTime(atMs, 'transition time');
    if (record.transitions.publishedThrough === Number.MAX_SAFE_INTEGER)
      throw new RangeError('critical transition sequence exhausted');
    // Size validation must happen before the durable stream is mutated. SessionActor may
    // retry any throwing sink; leaving an oversized first attempt pending would duplicate it.
    const predicted = {
      schema: CRITICAL_TRANSITION_SCHEMA,
      stream_id: record.transitions.streamId,
      sequence: record.transitions.publishedThrough + 1,
      state_revision: safeStateRevision,
      at_ms: safeAtMs,
      type: safeType,
      payload: safePayload,
    };
    const probe = shardFrame('child', 'transition', {
      shardId: this.shardId,
      bootId: this.bootId,
      actor_id: record.id,
      transition: predicted,
    });
    assertFrameBytes(probe, this.maxFrameBytes, 'transition frame');
    const transition = record.transitions.publish(safeType, safePayload, {
      stateRevision: safeStateRevision,
      atMs: safeAtMs,
    });
    this.counters.transition_published++;
    this._pumpTransitions();
    return transition;
  }

  publishHealth(status, details = {}, { atMs = currentTime(this.now) } = {}) {
    const revision = ++this.healthRevision;
    const frame = shardFrame('child', 'health', {
      shardId: this.shardId,
      bootId: this.bootId,
      revision,
      at_ms: frameTime(atMs, 'health time'),
      status: safeIpcString(status, { label: 'health status', maximum: 80 }),
      details: safeIpcValue(details),
    });
    assertFrameBytes(frame, this.maxFrameBytes, 'health frame');
    if (this.healthPending) this.counters.health_coalesced++;
    this.healthPending = frame;
    this.counters.health_published++;
    this._pumpHealth();
    return revision;
  }

  reportCrash(error, { origin = 'runtime', fatal = true } = {}) {
    if (this.crashFrame) return this.crashFrame;
    this.crashFrame = shardFrame('child', 'crash', {
      shardId: this.shardId,
      bootId: this.bootId,
      at_ms: currentTime(this.now),
      fatal: Boolean(fatal),
      error: safeErrorDetails(error, { origin }),
    });
    if (fatal && this.lifecycle !== 'disconnected') this.lifecycle = 'crashed';
    try { this._send(this.crashFrame); } catch { /* crash reporting is best effort */ }
    this.events.emit('crash', this.crashFrame);
    return this.crashFrame;
  }

  get pendingTransitionCount() {
    let total = 0;
    for (const record of this.recordList) total += record.transitions.pendingCount;
    return total;
  }

  createFleetRuntimeHooks() {
    return Object.freeze({
      onStateChanged: ({ id, state, revision, observedAtMs }) =>
        this.publishState(id, state, { revision, observedAtMs }),
      transitionSink: ({ id, type, payload, stateRevision, atMs }) =>
        this.publishTransition(id, type, payload, { stateRevision, atMs }),
    });
  }

  _record(id) {
    const record = this.records.get(actorIdentifier(id));
    if (!record) throw new Error(`actor is outside this shard: ${id}`);
    return record;
  }

  _send(frame) {
    if (this.lifecycle === 'disconnected') throw new Error('shard transport is disconnected');
    this.counters.frames_sent++;
    try {
      const result = this.transport.send(frame);
      if (result && typeof result.then === 'function')
        void result.catch(error => this._transportFailed(error));
    } catch (error) {
      this._transportFailed(error);
      throw error;
    }
  }

  _receive(raw) {
    this.counters.frames_received++;
    try {
      if (raw?.schema === SHARD_INIT_SCHEMA) {
        this._receiveInit(assertShardInitFrame(raw, {
          shardId: this.shardId,
          bootId: this.bootId,
        }));
        return;
      }
      const frame = assertShardFrame(raw, {
        direction: 'parent', shardId: this.shardId, bootId: this.bootId,
      });
      if (frame.kind !== 'hello-ack' && this.lifecycle === 'handshaking')
        throw new Error('parent control arrived before hello acknowledgement');
      switch (frame.kind) {
        case 'hello-ack': this._acceptHello(frame); break;
        case 'state-ack': this._acceptStateAck(frame); break;
        case 'transition-ack': this._acceptTransitionAck(frame); break;
        case 'health-ack': this._acceptHealthAck(frame); break;
        case 'stop':
          void this._acceptStop(frame).catch(error => this._protocolFailed(error));
          break;
        case 'ping':
          this._send(shardFrame('child', 'pong', {
            shardId: this.shardId, bootId: this.bootId,
            request_id: safeIpcString(frame.request_id, { label: 'ping request id' }),
            at_ms: currentTime(this.now),
          }));
          break;
        default: throw new Error('unsupported parent control frame');
      }
    } catch (error) {
      this._protocolFailed(error);
    }
  }

  _acceptHello(frame) {
    if (this.lifecycle !== 'handshaking') throw new Error('duplicate hello acknowledgement');
    const transitionWindow = positiveInteger(frame.transition_window, null, 'transition_window');
    const stateWindow = positiveInteger(frame.state_window, null, 'state_window');
    if (transitionWindow > this.configuredTransitionWindow || stateWindow > this.configuredStateWindow)
      throw new Error('parent requested a window above the child limit');
    this.transitionWindow = transitionWindow;
    this.stateWindow = stateWindow;
    this.lifecycle = 'ready';
    this.readyResult.settled = true;
    this.readyResult.resolve(Object.freeze({
      shard_id: this.shardId, boot_id: this.bootId,
      transition_window: transitionWindow, state_window: stateWindow,
    }));
    this.events.emit('ready');
    this._pumpState();
    this._pumpTransitions();
    this._pumpHealth();
  }

  _receiveInit(frame) {
    if (this.lifecycle !== 'ready') throw new Error('shard init arrived before handshake');
    if (this.lastInitRequestId) {
      if (frame.request_id !== this.lastInitRequestId) throw new Error('shard was initialized twice');
      if (this.lastInitAck) this._send(this.lastInitAck);
      return;
    }
    this.lastInitRequestId = frame.request_id;
    const rawPayload = frame.payload;
    void Promise.resolve().then(() => this.verifyInit(rawPayload, Object.freeze({
      shardId: this.shardId,
      bootId: this.bootId,
      actorIds: this.actorIds,
    }))).then(result => ({
      result,
      publicResult: normalizeVerifierInitResult(result, { expectedActorIds: this.actorIds }),
    })).then(({ result, publicResult }) => {
      this.lastInitAck = shardFrame('child', 'init-ack', {
        shardId: this.shardId, bootId: this.bootId,
        request_id: frame.request_id, ok: true, at_ms: currentTime(this.now),
        init_result: publicResult,
      });
      assertFrameBytes(this.lastInitAck, this.maxFrameBytes, 'initialization result frame');
      this._send(this.lastInitAck);
      this.initResult.settled = true;
      this.initResult.resolve(result);
    }, error => {
      this.lastInitAck = shardFrame('child', 'init-ack', {
        shardId: this.shardId, bootId: this.bootId,
        request_id: frame.request_id, ok: false, at_ms: currentTime(this.now),
        error: safeErrorDetails(error, { origin: 'init-verification' }),
      });
      this._send(this.lastInitAck);
      this.initResult.settled = true;
      this.initResult.reject(error);
    }).catch(error => this._protocolFailed(error));
  }

  _acceptStateAck(frame) {
    const record = this._record(frame.actor_id);
    const through = frameSequence(frame.through_revision, 'state acknowledgement');
    if (!record.stateInFlight) return;
    if (through < record.stateInFlight.revision) return;
    if (through > record.stateInFlight.revision)
      throw new Error('parent acknowledged unsent state');
    record.stateInFlight = null;
    this.stateInFlight--;
    this._pumpState();
  }

  _acceptTransitionAck(frame) {
    const record = this._record(frame.actor_id);
    const through = frameSequence(frame.through_sequence, 'transition acknowledgement');
    const before = record.transitions.acknowledgedThrough;
    if (through > record.sentThrough) throw new Error('parent acknowledged an unsent transition');
    const acknowledged = record.transitions.acknowledge(through);
    const released = acknowledged - before;
    this.transitionInFlight -= released;
    this.counters.transition_acked += released;
    this._pumpTransitions();
  }

  _acceptHealthAck(frame) {
    const through = frameSequence(frame.through_revision, 'health acknowledgement');
    if (!this.healthInFlight || through < this.healthInFlight.revision) return;
    if (through > this.healthInFlight.revision)
      throw new Error('parent acknowledged unsent health');
    this.healthInFlight = null;
    this._pumpHealth();
  }

  async _acceptStop(frame) {
    const requestId = safeIpcString(frame.request_id, { label: 'stop request id' });
    if (this.stopPromise) {
      await this.stopPromise;
      if (this.stopResult) this._send(this.stopResult);
      return;
    }
    this.lifecycle = 'stopping';
    const reason = typeof frame.reason === 'string' ? frame.reason : 'parent requested stop';
    this.publishHealth('stopping', { reason });
    this.stopPromise = Promise.resolve().then(() => this.onStop(reason, Object.freeze({
      requestId,
      deadlineMs: frame.deadline_ms == null ? null : frameTime(frame.deadline_ms, 'stop deadline'),
    }))).then(result => {
      if (result?.ok === false) throw stopFailure(result);
      return result;
    }).then(() => {
      this.lifecycle = 'stopped';
      this.stopResult = shardFrame('child', 'stop-result', {
        shardId: this.shardId, bootId: this.bootId,
        request_id: requestId, ok: true, at_ms: currentTime(this.now),
      });
      this._send(this.stopResult);
      this.events.emit('stopped', this.stopResult);
      return this.stopResult;
    }, error => {
      this.lifecycle = 'stop-failed';
      this.stopResult = shardFrame('child', 'stop-result', {
        shardId: this.shardId, bootId: this.bootId,
        request_id: requestId, ok: false, at_ms: currentTime(this.now),
        error: safeErrorDetails(error, { origin: 'stop' }),
      });
      this._send(this.stopResult);
      this.events.emit('stop-failed', this.stopResult);
      return this.stopResult;
    });
    await this.stopPromise;
  }

  _pumpState() {
    if (this.lifecycle !== 'ready' || !this.stateWindow || !this.recordList.length) return;
    let misses = 0;
    while (this.stateInFlight < this.stateWindow && misses < this.recordList.length) {
      const record = this.recordList[this.stateCursor++ % this.recordList.length];
      if (record.stateInFlight || !record.statePending) {
        misses++;
        continue;
      }
      const frame = record.statePending;
      record.statePending = null;
      record.stateInFlight = frame;
      this.stateInFlight++;
      misses = 0;
      this._send(frame);
    }
  }

  _pumpTransitions() {
    if (this.lifecycle !== 'ready' || !this.transitionWindow || !this.recordList.length) return;
    let misses = 0;
    while (this.transitionInFlight < this.transitionWindow && misses < this.recordList.length) {
      const record = this.recordList[this.transitionCursor++ % this.recordList.length];
      if (record.sentThrough >= record.transitions.publishedThrough) {
        misses++;
        continue;
      }
      const batch = record.transitions.read({
        streamId: record.transitions.streamId,
        afterSequence: record.sentThrough,
        limit: 1,
      });
      const transition = batch.transitions[0];
      if (!transition) {
        misses++;
        continue;
      }
      const frame = shardFrame('child', 'transition', {
        shardId: this.shardId, bootId: this.bootId,
        actor_id: record.id, transition,
      });
      record.sentThrough = transition.sequence;
      this.transitionInFlight++;
      misses = 0;
      this._send(frame);
    }
  }

  _pumpHealth() {
    if (this.lifecycle === 'handshaking' || this.lifecycle === 'created' ||
        this.healthInFlight || !this.healthPending) return;
    const frame = this.healthPending;
    this.healthPending = null;
    this.healthInFlight = frame;
    this._send(frame);
  }

  _protocolFailed(error) {
    this.counters.protocol_errors++;
    const terminal = Object.assign(new Error('invalid parent IPC control'), {
      name: 'ProtocolError', code: 'M59_SHARD_PROTOCOL', cause: error,
    });
    this.reportCrash(terminal, { origin: 'protocol' });
    if (!this.readyResult.settled) {
      this.readyResult.settled = true;
      this.readyResult.reject(terminal);
    }
    if (!this.initResult.settled) {
      this.initResult.settled = true;
      this.initResult.reject(terminal);
    }
    for (const record of this.recordList) record.transitions.close(terminal);
    queueMicrotask(() => {
      try { this.transport.close?.(); } catch { /* terminal already recorded */ }
    });
  }

  _transportFailed(error) {
    if (this.lifecycle === 'disconnected') return;
    this._finishDisconnected(error);
  }

  _transportClosed(details) {
    if (this.lifecycle === 'disconnected') return;
    const error = Object.assign(new Error('shard IPC transport closed'), {
      name: 'TransportClosedError', code: details?.code ?? 'M59_SHARD_TRANSPORT_CLOSED',
    });
    this._finishDisconnected(error);
  }

  _finishDisconnected(error) {
    const previous = this.lifecycle;
    this.lifecycle = 'disconnected';
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe?.();
    for (const record of this.recordList) record.transitions.close(error);
    if (!this.readyResult.settled) {
      this.readyResult.settled = true;
      this.readyResult.reject(error);
    }
    if (!this.initResult.settled) {
      this.initResult.settled = true;
      this.initResult.reject(error);
    }
    this.events.emit('disconnect', Object.freeze({ previous }));
  }
}

export function createFleetRuntimeShardHooks(reporter) {
  if (!(reporter instanceof ShardChildReporter))
    throw new TypeError('reporter must be a ShardChildReporter');
  return reporter.createFleetRuntimeHooks();
}
