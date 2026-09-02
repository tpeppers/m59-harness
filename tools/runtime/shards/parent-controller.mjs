import { EventEmitter } from 'node:events';

import { STATE_SNAPSHOT_SCHEMA } from '../state/index.mjs';
import { immutableStateValue } from '../state/json-value.mjs';
import {
  actorIdentifier,
  assertShardFrame,
  frameSequence,
  frameTime,
  normalizedActorIds,
  sameActorSet,
  shardFrame,
  shardIdentifier,
  shardInitFrame,
} from './protocol.mjs';
import { RemoteTransitionStream } from './remote-transition-stream.mjs';
import { safeErrorDetails, safeIpcString } from './safe-value.mjs';
import { assertShardTransport } from './transport.mjs';
import { validateShardInitResult } from './init-result.mjs';

export const SHARD_SNAPSHOT_SCHEMA = 'm59-shard-snapshot/v1';

function positiveInteger(value, fallback, label) {
  const result = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw new RangeError(`${label} must be a positive safe integer`);
  return result;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject, settled: false };
}

function frozenDetails(value) {
  return immutableStateValue(value ?? {});
}

export class ShardParentController {
  constructor({
    transport,
    shardId,
    expectedActorIds,
    transitionWindow = 64,
    stateWindow = 32,
    maxPendingTransitionsPerActor = 128,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.transport = assertShardTransport(transport);
    this.shardId = shardIdentifier(shardId);
    this.actorIds = normalizedActorIds(Array.from(expectedActorIds ?? []));
    if (typeof now !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function')
      throw new TypeError('clock functions are required');
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.configuredTransitionWindow = positiveInteger(transitionWindow, 64, 'transitionWindow');
    this.configuredStateWindow = positiveInteger(stateWindow, 32, 'stateWindow');
    this.maxPendingTransitionsPerActor = positiveInteger(
      maxPendingTransitionsPerActor, 128, 'maxPendingTransitionsPerActor');
    if (this.maxPendingTransitionsPerActor < this.configuredTransitionWindow)
      throw new RangeError('maxPendingTransitionsPerActor must cover transitionWindow');
    this.lifecycle = 'created';
    this.bootId = null;
    this.processId = null;
    this.events = new EventEmitter();
    this.records = new Map();
    this.readyResult = deferred();
    void this.readyResult.promise.catch(() => {});
    this.initResult = null;
    this.initRequestId = null;
    this.initialization = null;
    this.stopDeferred = null;
    this.stopRequestId = null;
    this.stopTimer = null;
    this.stopResult = null;
    this.health = null;
    this.healthRevision = 0;
    this.crash = null;
    this.snapshotRevision = 0;
    this.unsubscribers = [];
    this.counters = {
      frames_sent: 0,
      frames_received: 0,
      state_received: 0,
      state_stale: 0,
      transitions_received: 0,
      transition_duplicates: 0,
      transitions_acknowledged: 0,
      health_received: 0,
      protocol_errors: 0,
      transport_closes: 0,
    };

    for (const id of this.actorIds) {
      const record = {
        id,
        state: null,
        stateSchema: null,
        stateRevision: 0,
        observedAtMs: null,
        transitions: null,
        streams: null,
      };
      record.transitions = new RemoteTransitionStream({
        actorId: id,
        maxPending: this.maxPendingTransitionsPerActor,
        acknowledge: through => this._sendTransitionAck(record, through),
      });
      record.streams = Object.freeze({
        stateChannel: Object.freeze({
          get revision() { return record.stateRevision; },
          get state() { return record.state; },
          fullSnapshot(reason = 'requested') {
            return immutableStateValue({
              schema: STATE_SNAPSHOT_SCHEMA,
              kind: 'snapshot',
              stream_id: `${record.transitions.streamId ?? 'pending'}/state`,
              state_schema: record.stateSchema,
              revision: record.stateRevision,
              observed_at_ms: record.observedAtMs,
              state: record.state,
              repair: { reason },
            });
          },
        }),
        transitions: record.transitions,
      });
      this.records.set(id, record);
    }
  }

  on(event, handler) {
    this.events.on(event, handler);
    return () => this.events.off(event, handler);
  }

  get ready() { return this.readyResult.promise; }

  get stats() {
    let pendingTransitions = 0;
    let actorsWithState = 0;
    for (const record of this.records.values()) {
      pendingTransitions += record.transitions.pendingCount;
      if (record.state) actorsWithState++;
    }
    return immutableStateValue({
      shard_id: this.shardId,
      lifecycle: this.lifecycle,
      actors: this.actorIds.length,
      actors_with_state: actorsWithState,
      pending_transitions: pendingTransitions,
      ...this.counters,
    });
  }

  start() {
    if (this.lifecycle !== 'created') return this.ready;
    this.lifecycle = 'starting';
    this.unsubscribers.push(this.transport.onMessage(frame => this._receive(frame)));
    this.unsubscribers.push(this.transport.onClose(details => this._transportClosed(details)));
    if (typeof this.transport.onError === 'function')
      this.unsubscribers.push(this.transport.onError(error => this._transportFailed(error)));
    return this.ready;
  }

  snapshot() {
    return immutableStateValue({
      schema: SHARD_SNAPSHOT_SCHEMA,
      shard_id: this.shardId,
      boot_id: this.bootId,
      lifecycle: this.lifecycle,
      revision: this.snapshotRevision,
      process_id: this.processId,
      health: this.health,
      initialization: this.initialization,
      crash: this.crash,
      stop_result: this.stopResult,
      actors: this.actorIds.map(id => {
        const record = this.records.get(id);
        return {
          id,
          status: this._actorStatus(record),
          state_schema: record.stateSchema,
          state_revision: record.stateRevision,
          observed_at_ms: record.observedAtMs,
          state: record.state,
          pending_transitions: record.transitions.pendingCount,
        };
      }),
    });
  }

  streamsFor(actorId) {
    return this.records.get(actorIdentifier(actorId))?.streams ?? null;
  }

  sendInit(payload) {
    if (this.lifecycle !== 'ready')
      return Promise.reject(new Error('shard must finish its handshake before initialization'));
    if (this.initResult) return this.initResult.promise;
    this.initRequestId = `${this.bootId}/init/1`;
    this.initResult = deferred();
    // Do not retain this frame: it is the sole private, non-telemetry protocol object.
    const frame = shardInitFrame({
      shardId: this.shardId,
      bootId: this.bootId,
      requestId: this.initRequestId,
      payload,
    });
    this._send(frame);
    return this.initResult.promise;
  }

  requestStop(reason = 'parent requested stop', { deadlineMs = null, timeoutMs = null } = {}) {
    if (this.stopResult) return Promise.resolve(this.stopResult);
    if (this.stopDeferred) return this.stopDeferred.promise;
    if (!this.bootId || this.lifecycle === 'created' || this.lifecycle === 'starting')
      return Promise.reject(new Error('shard is not ready for stop control'));
    this.stopDeferred = deferred();
    this.stopRequestId = `${this.bootId}/stop/1`;
    this.lifecycle = 'stopping';
    const computedDeadline = deadlineMs == null && timeoutMs != null
      ? Math.floor(Number(this.now())) + positiveInteger(timeoutMs, null, 'timeoutMs')
      : deadlineMs;
    this._send(shardFrame('parent', 'stop', {
      shardId: this.shardId, bootId: this.bootId,
      request_id: this.stopRequestId,
      reason: safeIpcString(String(reason), { label: 'stop reason', maximum: 512 }),
      ...(computedDeadline == null ? {} : {
        deadline_ms: frameTime(computedDeadline, 'stop deadline'),
      }),
    }));
    if (timeoutMs != null) {
      this.stopTimer = this.setTimer(() => {
        if (this.stopDeferred?.settled) return;
        this.stopDeferred.settled = true;
        const error = new Error('shard graceful stop timed out');
        error.code = 'M59_SHARD_STOP_TIMEOUT';
        this.stopDeferred.reject(error);
      }, positiveInteger(timeoutMs, null, 'timeoutMs'));
    }
    return this.stopDeferred.promise;
  }

  _actorStatus(record) {
    if (this.lifecycle === 'crashed' || this.lifecycle === 'disconnected') return 'unavailable';
    if (this.lifecycle === 'stopping' || this.lifecycle === 'stopped') return this.lifecycle;
    if (this.initialization?.failures.some(failure => failure.id === record.id)) return 'failed';
    if (this.initialization?.started_actor_ids.includes(record.id)) return 'running';
    return record.state ? 'running' : 'pending';
  }

  _record(id) {
    const record = this.records.get(actorIdentifier(id));
    if (!record) throw new Error('frame names an actor outside its shard');
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
      if (!this.bootId) {
        const hello = assertShardFrame(raw, { direction: 'child', shardId: this.shardId });
        if (hello.kind !== 'hello') throw new Error('first child IPC frame must be hello');
        this._acceptHello(hello);
        return;
      }
      const frame = assertShardFrame(raw, {
        direction: 'child', shardId: this.shardId, bootId: this.bootId,
      });
      switch (frame.kind) {
        case 'hello': throw new Error('duplicate child hello');
        case 'init-ack': this._acceptInitAck(frame); break;
        case 'state': this._acceptState(frame); break;
        case 'transition': this._acceptTransition(frame); break;
        case 'health': this._acceptHealth(frame); break;
        case 'stop-result': this._acceptStopResult(frame); break;
        case 'crash': this._acceptCrash(frame); break;
        case 'pong': this.events.emit('pong', frame); break;
        default: throw new Error('unsupported child IPC frame');
      }
    } catch (error) {
      this._protocolFailed(error);
    }
  }

  _acceptHello(frame) {
    if (this.lifecycle !== 'starting') throw new Error('unexpected child hello');
    const childActors = normalizedActorIds(frame.actor_ids);
    if (!sameActorSet(childActors, this.actorIds))
      throw new Error('child hello actor roster does not match its assignment');
    const childTransitionWindow = positiveInteger(
      frame.max_transition_window, null, 'child transition window');
    const childStateWindow = positiveInteger(frame.max_state_window, null, 'child state window');
    this.bootId = shardIdentifier(frame.boot_id, 'boot id');
    this.processId = Number.isSafeInteger(frame.process_id) && frame.process_id > 0
      ? frame.process_id : null;
    for (const record of this.records.values())
      record.transitions.setStreamId(
        `${this.bootId}/actor/${encodeURIComponent(record.id)}/transitions`);
    const transitionWindow = Math.min(this.configuredTransitionWindow, childTransitionWindow);
    const stateWindow = Math.min(this.configuredStateWindow, childStateWindow);
    this._send(shardFrame('parent', 'hello-ack', {
      shardId: this.shardId, bootId: this.bootId,
      at_ms: Math.floor(Number(this.now())),
      transition_window: transitionWindow,
      state_window: stateWindow,
    }));
    this.lifecycle = 'ready';
    this.snapshotRevision++;
    this.readyResult.settled = true;
    const result = Object.freeze({
      shard_id: this.shardId, boot_id: this.bootId,
      actor_ids: this.actorIds, process_id: this.processId,
      transition_window: transitionWindow, state_window: stateWindow,
    });
    this.readyResult.resolve(result);
    this.events.emit('ready', result);
  }

  _acceptInitAck(frame) {
    if (!this.initResult || frame.request_id !== this.initRequestId)
      throw new Error('unexpected shard initialization acknowledgement');
    if (this.initResult.settled) return;
    if (frame.ok === true) {
      const summary = validateShardInitResult(frame.init_result, {
        expectedActorIds: this.actorIds,
      });
      this.initialization = summary;
      this.initResult.settled = true;
      this.snapshotRevision++;
      const result = immutableStateValue({
        ...summary,
        initialized: true,
        shard_id: this.shardId,
        boot_id: this.bootId,
      });
      this.initResult.resolve(result);
      this.events.emit('initialized', result);
    } else if (frame.ok === false) {
      this.initResult.settled = true;
      const error = Object.assign(new Error('shard initialization verification failed'), {
        code: frame.error?.code ?? 'M59_SHARD_INIT_FAILED',
      });
      this.initResult.reject(error);
      this.events.emit('init-failed', frozenDetails(frame.error));
    } else throw new Error('shard initialization acknowledgement outcome is invalid');
  }

  _acceptState(frame) {
    const record = this._record(frame.actor_id);
    const revision = frameSequence(frame.revision, 'state revision');
    if (revision < 1) throw new Error('state revision must be positive');
    frameTime(frame.observed_at_ms, 'state observation time');
    if (typeof frame.state_schema !== 'string' || !frame.state_schema)
      throw new Error('state schema is required');
    if (frame.state?.schema != null && frame.state.schema !== frame.state_schema)
      throw new Error('state payload schema mismatch');
    if (revision > record.stateRevision) {
      record.state = immutableStateValue(frame.state);
      record.stateSchema = frame.state_schema;
      record.stateRevision = revision;
      record.observedAtMs = frame.observed_at_ms;
      this.counters.state_received++;
      this.snapshotRevision++;
      this.events.emit('state', Object.freeze({ actorId: record.id, revision }));
    } else {
      this.counters.state_stale++;
    }
    this._send(shardFrame('parent', 'state-ack', {
      shardId: this.shardId, bootId: this.bootId,
      actor_id: record.id, through_revision: revision,
    }));
  }

  _acceptTransition(frame) {
    const record = this._record(frame.actor_id);
    const result = record.transitions.accept(frame.transition);
    if (result.accepted) {
      this.counters.transitions_received++;
      this.snapshotRevision++;
      this.events.emit('transition', Object.freeze({
        actorId: record.id, transition: result.transition,
      }));
    } else {
      this.counters.transition_duplicates++;
    }
  }

  _sendTransitionAck(record, through) {
    this.counters.transitions_acknowledged++;
    this._send(shardFrame('parent', 'transition-ack', {
      shardId: this.shardId, bootId: this.bootId,
      actor_id: record.id, through_sequence: through,
    }));
    this.snapshotRevision++;
  }

  _acceptHealth(frame) {
    const revision = frameSequence(frame.revision, 'health revision');
    frameTime(frame.at_ms, 'health time');
    if (revision > this.healthRevision) {
      this.healthRevision = revision;
      this.health = immutableStateValue({
        revision, at_ms: frame.at_ms, status: frame.status, details: frame.details,
      });
      this.counters.health_received++;
      this.snapshotRevision++;
      this.events.emit('health', this.health);
    }
    this._send(shardFrame('parent', 'health-ack', {
      shardId: this.shardId, bootId: this.bootId, through_revision: revision,
    }));
  }

  _acceptStopResult(frame) {
    if (!this.stopDeferred || frame.request_id !== this.stopRequestId)
      throw new Error('unexpected shard stop result');
    if (this.stopTimer) this.clearTimer(this.stopTimer);
    this.stopTimer = null;
    this.stopResult = immutableStateValue({
      ok: frame.ok === true,
      at_ms: frame.at_ms,
      ...(frame.ok === true ? {} : { error: frame.error }),
    });
    this.lifecycle = frame.ok === true ? 'stopped' : 'stop-failed';
    this.snapshotRevision++;
    if (!this.stopDeferred.settled) {
      this.stopDeferred.settled = true;
      this.stopDeferred.resolve(this.stopResult);
    }
    this.events.emit(frame.ok === true ? 'stopped' : 'stop-failed', this.stopResult);
  }

  _acceptCrash(frame) {
    if (!this.crash) {
      this.crash = immutableStateValue({
        reported: true,
        at_ms: frame.at_ms,
        fatal: frame.fatal === true,
        error: frame.error,
      });
      if (frame.fatal === true) this.lifecycle = 'crashed';
      this.snapshotRevision++;
      this.events.emit('crash', this.crash);
    }
  }

  _protocolFailed(error) {
    this.counters.protocol_errors++;
    const terminal = Object.assign(new Error('invalid child IPC frame'), {
      name: 'ProtocolError', code: 'M59_SHARD_PROTOCOL', cause: error,
    });
    this.crash = immutableStateValue({
      reported: false,
      at_ms: Math.floor(Number(this.now())),
      fatal: true,
      error: safeErrorDetails(terminal, { origin: 'protocol' }),
    });
    this.lifecycle = 'crashed';
    this.snapshotRevision++;
    this.events.emit('crash', this.crash);
    if (!this.readyResult.settled) {
      this.readyResult.settled = true;
      this.readyResult.reject(terminal);
    }
    if (this.initResult && !this.initResult.settled) {
      this.initResult.settled = true;
      this.initResult.reject(terminal);
    }
    if (this.stopDeferred && !this.stopDeferred.settled) {
      this.stopDeferred.settled = true;
      this.stopDeferred.reject(terminal);
    }
    queueMicrotask(() => {
      try { this.transport.close?.(); } catch { /* terminal already recorded */ }
    });
  }

  _transportFailed(error) {
    if (this.lifecycle === 'disconnected' || this.lifecycle === 'crashed') return;
    this._finishTransportClose({ source: 'error' }, error);
  }

  _transportClosed(details) {
    if (this.lifecycle === 'disconnected') return;
    this._finishTransportClose(details, Object.assign(new Error('shard transport closed'), {
      name: 'TransportClosedError', code: 'M59_SHARD_TRANSPORT_CLOSED',
    }));
  }

  _finishTransportClose(details, error) {
    this.counters.transport_closes++;
    const graceful = this.lifecycle === 'stopped' && this.stopResult?.ok === true;
    if (!graceful && !this.crash) {
      this.crash = immutableStateValue({
        reported: false,
        at_ms: Math.floor(Number(this.now())),
        fatal: true,
        error: safeErrorDetails(error, { origin: 'transport' }),
        close: {
          source: typeof details?.source === 'string' ? details.source : 'unknown',
          code: Number.isSafeInteger(details?.code) ? details.code : null,
          signal: typeof details?.signal === 'string' ? details.signal : null,
        },
      });
      this.events.emit('crash', this.crash);
    }
    this.lifecycle = graceful ? 'stopped' : 'disconnected';
    this.snapshotRevision++;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe?.();
    if (!this.readyResult.settled) {
      this.readyResult.settled = true;
      this.readyResult.reject(error);
    }
    if (this.initResult && !this.initResult.settled) {
      this.initResult.settled = true;
      this.initResult.reject(error);
    }
    if (this.stopDeferred && !this.stopDeferred.settled) {
      this.stopDeferred.settled = true;
      this.stopDeferred.reject(error);
    }
    this.events.emit('close', Object.freeze({ graceful, shardId: this.shardId }));
  }
}
