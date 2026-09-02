import { RealClock } from './clock/index.mjs';
import { ActorScheduler } from './scheduler/index.mjs';
import {
  AcknowledgedTransitionStream,
  CoalescedStateChannel,
} from './state/index.mjs';

export const FLEET_RUNTIME_SNAPSHOT_SCHEMA = 'm59-fleet-runtime-snapshot/v1';
export const DEFAULT_ACTOR_STATE_SCHEMA = 'm59-runtime-actor-state/v1';

let nextRuntimeId = 0;

function positiveInteger(value, fallback, name) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new RangeError(`${name} must be a positive safe integer`);
  return number;
}

function clockTime(clock) {
  const value = Number(clock.now());
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
    throw new RangeError('clock.now() must return a non-negative finite safe time');
  return Math.floor(value);
}

function defaultIdOf(entry) {
  if (typeof entry === 'string') return entry;
  return entry?.id;
}

function actorId(value) {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError('every fleet entry needs a non-empty string id');
  return value.trim();
}

function errorDetails(error) {
  const fallback = typeof error === 'string' ? error : String(error);
  const name = typeof error?.name === 'string' && error.name ? error.name : 'Error';
  const message = typeof error?.message === 'string' && error.message ? error.message : fallback;
  const code = typeof error?.code === 'string' || typeof error?.code === 'number'
    ? error.code : undefined;
  return Object.freeze({ name, message, ...(code === undefined ? {} : { code }) });
}

function freezeSummary(value) {
  return Object.freeze({
    ...value,
    failures: Object.freeze(value.failures.map(row => Object.freeze(row))),
    ...(value.aborted ? { aborted: Object.freeze([...value.aborted]) } : {}),
  });
}

function validateActor(actor, id) {
  if ((typeof actor !== 'object' || actor === null) && typeof actor !== 'function')
    throw new TypeError(`actorFactory returned no actor for ${id}`);
  for (const method of ['start', 'stop', 'snapshot']) {
    if (actor[method] != null && typeof actor[method] !== 'function')
      throw new TypeError(`actor ${id} has a non-callable ${method}`);
  }
  return actor;
}

// Meridian-free fleet orchestration. An adapter supplies actorFactory; this class owns
// only lifecycle, one shared scheduler, and the actors' two delivery channels.
export class FleetRuntime {
  constructor({
    entries = [],
    actorFactory,
    idOf = defaultIdOf,
    startupConcurrency = 4,
    clock = new RealClock(),
    schedulerOptions = {},
    safetySchedulerOptions = {},
    snapshotCoalesceMs = 0,
    runtimeId = null,
    stateSchema = DEFAULT_ACTOR_STATE_SCHEMA,
    initialState = null,
    maxPendingTransitions = 1024,
    onStateChanged = null,
    transitionSink = null,
  } = {}) {
    if (typeof actorFactory !== 'function') throw new TypeError('actorFactory is required');
    if (typeof idOf !== 'function') throw new TypeError('idOf must be a function');
    if (!entries || typeof entries[Symbol.iterator] !== 'function' || typeof entries === 'string')
      throw new TypeError('entries must be an iterable of fleet entries');
    if (!clock || typeof clock.now !== 'function' || typeof clock.setTimeout !== 'function' ||
        typeof clock.clearTimeout !== 'function')
      throw new TypeError('clock must provide now(), setTimeout(), and clearTimeout()');
    if (!schedulerOptions || typeof schedulerOptions !== 'object' || Array.isArray(schedulerOptions))
      throw new TypeError('schedulerOptions must be an object');
    if (!safetySchedulerOptions || typeof safetySchedulerOptions !== 'object' ||
        Array.isArray(safetySchedulerOptions))
      throw new TypeError('safetySchedulerOptions must be an object');
    if (typeof stateSchema !== 'string' || !stateSchema.trim())
      throw new TypeError('stateSchema must be a non-empty string');
    if (initialState != null && typeof initialState !== 'function' &&
        (typeof initialState !== 'object' || Array.isArray(initialState)))
      throw new TypeError('initialState must be an object or a function');
    if (onStateChanged != null && typeof onStateChanged !== 'function')
      throw new TypeError('onStateChanged must be a function');
    if (transitionSink != null && typeof transitionSink !== 'function')
      throw new TypeError('transitionSink must be a function');

    this.clock = clock;
    this.actorFactory = actorFactory;
    this.idOf = idOf;
    this.startupConcurrency = positiveInteger(startupConcurrency, 4, 'startupConcurrency');
    this.snapshotCoalesceMs = Number(snapshotCoalesceMs);
    if (!Number.isFinite(this.snapshotCoalesceMs) || this.snapshotCoalesceMs < 0)
      throw new RangeError('snapshotCoalesceMs must be finite and non-negative');
    this.maxPendingTransitions = positiveInteger(
      maxPendingTransitions, 1024, 'maxPendingTransitions');
    this.onStateChanged = onStateChanged;
    this.transitionSink = transitionSink;
    this.lastDeliveryError = null;
    this.stateSchema = stateSchema.trim();
    this.runtimeId = runtimeId == null
      ? `fleet-${clockTime(clock)}-${++nextRuntimeId}`
      : String(runtimeId).trim();
    if (!this.runtimeId) throw new TypeError('runtimeId must be a non-empty string');

    this.scheduler = new ActorScheduler({
      ...schedulerOptions,
      now: () => this.clock.now(),
      setTimer: (fn, delayMs) => this.clock.setTimeout(fn, delayMs),
      clearTimer: handle => this.clock.clearTimeout(handle),
    });
    // Gameplay decisions may legitimately await movement or combat for a long time. A
    // separate, bounded lane means limiting those decisions cannot also starve health,
    // socket, state-publication, or pass-stall work.
    this.safetyScheduler = new ActorScheduler({
      coalesceMs: 0,
      maxConcurrent: 8,
      maxStartsPerTurn: 8,
      ...safetySchedulerOptions,
      now: () => this.clock.now(),
      setTimer: (fn, delayMs) => this.clock.setTimeout(fn, delayMs),
      clearTimer: handle => this.clock.clearTimeout(handle),
    });
    this.abortController = new AbortController();
    this._lifecycle = 'created';
    this._fleetRevision = 0;
    this._startCursor = 0;
    this._startPromise = null;
    this._startSummary = null;
    this._stopPromise = null;
    this._cachedSnapshot = null;
    this._snapshotTimer = null;
    this.records = new Map();
    this.counters = {
      startup_attempts: 0,
      startup_active: 0,
      max_startup_active: 0,
      actors_started: 0,
      startup_failures: 0,
      startup_aborted: 0,
      state_publications: 0,
      state_changes: 0,
      state_delivery_failures: 0,
      transition_publications: 0,
      transition_delivery_failures: 0,
      stop_attempts: 0,
      actors_stopped: 0,
      stop_failures: 0,
    };

    for (const entry of entries) {
      const id = actorId(idOf(entry));
      if (this.records.has(id)) throw new Error(`duplicate fleet actor id: ${id}`);
      const encodedId = encodeURIComponent(id);
      const seed = typeof initialState === 'function'
        ? initialState(entry, id)
        : initialState ?? { schema: this.stateSchema, actor_id: id };
      const stateChannel = new CoalescedStateChannel({
        streamId: `${this.runtimeId}/actor/${encodedId}/state`,
        stateSchema: this.stateSchema,
        initialState: seed,
        observedAtMs: clockTime(this.clock),
      });
      const transitions = new AcknowledgedTransitionStream({
        streamId: `${this.runtimeId}/actor/${encodedId}/transitions`,
        maxPending: this.maxPendingTransitions,
        now: () => clockTime(this.clock),
      });
      const streams = Object.freeze({ stateChannel, transitions });
      const record = {
        id, entry, stateChannel, transitions, streams,
        context: null,
        actor: null,
        phase: 'pending',
        startOutcome: null,
        startError: null,
        stopError: null,
        stopPromise: null,
      };
      record.context = Object.freeze({
        id,
        entry,
        clock: this.clock,
        scheduler: this.scheduler,
        safetyScheduler: this.safetyScheduler,
        signal: this.abortController.signal,
        stateChannel,
        transitions,
        publishState: (value, options = {}) => this.publishState(id, value, options),
        publishTransition: (type, payload = {}, options = {}) =>
          this.publishTransition(id, type, payload, options),
      });
      this.records.set(id, record);
    }
    this._recordList = [...this.records.values()];
    this._rebuildSnapshot(false);
  }

  get lifecycle() { return this._lifecycle; }
  get signal() { return this.abortController.signal; }
  get actorIds() { return Object.freeze(this._recordList.map(record => record.id)); }

  getActor(id) { return this.records.get(id)?.actor ?? null; }
  streamsFor(id) { return this.records.get(id)?.streams ?? null; }
  snapshot() { return this._cachedSnapshot; }

  publishState(id, value, options = {}) {
    const record = this._requireRecord(id);
    this.counters.state_publications++;
    const result = record.stateChannel.publish(value, {
      ...options,
      observedAtMs: options.observedAtMs ?? clockTime(this.clock),
    });
    if (result.changed) {
      this.counters.state_changes++;
      this._scheduleSnapshotRebuild();
      if (this.onStateChanged) {
        const delivery = Object.freeze({
          id: record.id,
          state: record.stateChannel.state,
          revision: record.stateChannel.revision,
          observedAtMs: result.observed_at_ms,
        });
        try {
          const pending = this.onStateChanged(delivery);
          if (pending && typeof pending.then === 'function') {
            Promise.resolve(pending).catch(error => {
              this.counters.state_delivery_failures++;
              this.lastDeliveryError = errorDetails(error);
            });
          }
        } catch (error) {
          this.counters.state_delivery_failures++;
          this.lastDeliveryError = errorDetails(error);
        }
      }
    }
    return result;
  }

  publishTransition(id, type, payload = {}, options = {}) {
    const record = this._requireRecord(id);
    const stateRevision = options.stateRevision ?? record.stateChannel.revision;
    const atMs = options.atMs ?? clockTime(this.clock);
    try {
      const transition = this.transitionSink
        ? this.transitionSink(Object.freeze({
          id: record.id, type, payload, stateRevision, atMs,
        }))
        : record.transitions.publish(type, payload, {
          ...options, stateRevision, atMs,
        });
      if (transition && typeof transition.then === 'function')
        throw new TypeError('transitionSink must acknowledge synchronously');
      this.counters.transition_publications++;
      return transition;
    } catch (error) {
      this.counters.transition_delivery_failures++;
      this.lastDeliveryError = errorDetails(error);
      throw error;
    }
  }

  start() {
    if (this._lifecycle === 'stopping' || this._lifecycle === 'stopped')
      return Promise.reject(new Error('fleet runtime is stopped permanently'));
    if (this._startPromise) return this._startPromise;
    this._lifecycle = 'starting';
    this._rebuildSnapshot();
    this._startPromise = this._startAll();
    return this._startPromise;
  }

  async _startAll() {
    const workerCount = Math.min(this.startupConcurrency, this._recordList.length);
    await Promise.all(Array.from({ length: workerCount }, () => this._startupWorker()));

    if (this.signal.aborted) {
      for (const record of this._recordList) {
        if (record.startOutcome !== null) continue;
        record.startOutcome = 'aborted';
        record.phase = 'stopped';
        this.counters.startup_aborted++;
      }
    }
    if (this._lifecycle === 'starting') this._lifecycle = 'running';
    this._rebuildSnapshot();

    const failures = this._recordList
      .filter(record => record.startOutcome === 'failed')
      .map(record => ({ id: record.id, error: record.startError }));
    const aborted = this._recordList
      .filter(record => record.startOutcome === 'aborted')
      .map(record => record.id);
    const started = this._recordList.filter(record => record.startOutcome === 'started').length;
    this._startSummary = freezeSummary({
      ok: failures.length === 0 && aborted.length === 0,
      total: this._recordList.length,
      started,
      failed: failures.length,
      aborted_count: aborted.length,
      failures,
      aborted,
    });
    return this._startSummary;
  }

  async _startupWorker() {
    while (!this.signal.aborted) {
      const index = this._startCursor++;
      if (index >= this._recordList.length) return;
      await this._startOne(this._recordList[index]);
    }
  }

  async _startOne(record) {
    record.phase = 'starting';
    this.counters.startup_attempts++;
    this.counters.startup_active++;
    this.counters.max_startup_active = Math.max(
      this.counters.max_startup_active, this.counters.startup_active);
    this._rebuildSnapshot();
    try {
      const actor = validateActor(
        await this.actorFactory(record.entry, record.context), record.id);
      record.actor = actor;
      if (this.signal.aborted) {
        record.startOutcome = 'aborted';
        this.counters.startup_aborted++;
        await this._stopActor(record, 'fleet runtime stopped during startup');
        record.phase = 'stopped';
        return;
      }
      await actor.start?.(record.entry, record.context);
      if (this.signal.aborted) {
        record.startOutcome = 'aborted';
        this.counters.startup_aborted++;
        await this._stopActor(record, 'fleet runtime stopped during startup');
        record.phase = 'stopped';
        return;
      }
      if (actor.snapshot) {
        const value = await actor.snapshot();
        if (value !== undefined) this.publishState(record.id, value, { reason: 'startup' });
      }
      record.startOutcome = 'started';
      record.phase = 'running';
      this.counters.actors_started++;
    } catch (error) {
      if (this.signal.aborted) {
        record.startOutcome = 'aborted';
        this.counters.startup_aborted++;
        await this._stopActor(record, 'fleet runtime stopped during startup');
        record.phase = 'stopped';
      } else {
        record.startOutcome = 'failed';
        record.startError = errorDetails(error);
        record.phase = 'failed';
        this.counters.startup_failures++;
        await this._stopActor(record, 'actor startup failed');
      }
    } finally {
      this.counters.startup_active--;
      this._rebuildSnapshot();
    }
  }

  stop(reason = 'fleet runtime stopped') {
    if (this._stopPromise) return this._stopPromise;
    this._stopPromise = this._stopAll(String(reason));
    return this._stopPromise;
  }

  async _stopAll(reason) {
    if (this._lifecycle === 'stopped') return this._stopSummary();
    this._lifecycle = 'stopping';
    this.abortController.abort(new Error(reason));
    // Prevent new decisions first; actor-specific teardown then releases all other state.
    this.scheduler.stop();
    this.safetyScheduler.stop();
    for (const record of this._recordList) {
      if (record.phase !== 'failed' && record.phase !== 'stopped') record.phase = 'stopping';
    }
    this._rebuildSnapshot();

    await Promise.all(this._recordList.map(record => this._stopActor(record, reason)));
    if (this._startPromise) await this._startPromise;
    // A pending async factory may have produced its actor while the first sweep ran.
    await Promise.all(this._recordList.map(record => this._stopActor(record, reason)));

    const closed = new Error(reason);
    for (const record of this._recordList) {
      if (record.phase !== 'failed') record.phase = 'stopped';
      record.stateChannel.close(closed);
      record.transitions.close(closed);
    }
    this._lifecycle = 'stopped';
    this._rebuildSnapshot();
    return this._stopSummary();
  }

  async _stopActor(record, reason) {
    if (!record.actor) return false;
    if (record.stopPromise) return record.stopPromise;
    record.stopPromise = (async () => {
      this.counters.stop_attempts++;
      try {
        await record.actor.stop?.(reason);
        this.counters.actors_stopped++;
        return true;
      } catch (error) {
        record.stopError = errorDetails(error);
        this.counters.stop_failures++;
        return false;
      }
    })();
    return record.stopPromise;
  }

  _stopSummary() {
    const failures = this._recordList
      .filter(record => record.stopError)
      .map(record => ({ id: record.id, error: record.stopError }));
    return freezeSummary({
      ok: failures.length === 0,
      total: this._recordList.length,
      stopped: this._recordList.filter(record => record.phase === 'stopped').length,
      failed: failures.length,
      failures,
    });
  }

  _requireRecord(id) {
    const record = this.records.get(id);
    if (!record) throw new Error(`unknown fleet actor: ${String(id)}`);
    return record;
  }

  _rebuildSnapshot(increment = true) {
    if (this._snapshotTimer != null) {
      this.clock.clearTimeout(this._snapshotTimer);
      this._snapshotTimer = null;
    }
    if (increment) {
      if (this._fleetRevision === Number.MAX_SAFE_INTEGER)
        throw new RangeError('fleet snapshot revision exhausted');
      this._fleetRevision++;
    }
    const actors = this._recordList.map(record => Object.freeze({
      id: record.id,
      status: record.phase,
      state_stream_id: record.stateChannel.streamId,
      transition_stream_id: record.transitions.streamId,
      state_revision: record.stateChannel.revision,
      state: record.stateChannel.state,
      ...(record.startError ? { error: record.startError } : {}),
      ...(record.stopError ? { stop_error: record.stopError } : {}),
    }));
    this._cachedSnapshot = Object.freeze({
      schema: FLEET_RUNTIME_SNAPSHOT_SCHEMA,
      runtime_id: this.runtimeId,
      revision: this._fleetRevision,
      observed_at_ms: clockTime(this.clock),
      lifecycle: this._lifecycle,
      total: actors.length,
      actors: Object.freeze(actors),
    });
  }

  _scheduleSnapshotRebuild() {
    if (this.snapshotCoalesceMs === 0) {
      this._rebuildSnapshot();
      return;
    }
    if (this._snapshotTimer != null) return;
    this._snapshotTimer = this.clock.setTimeout(() => {
      this._snapshotTimer = null;
      this._rebuildSnapshot();
    }, this.snapshotCoalesceMs);
    this._snapshotTimer?.unref?.();
  }

  get stats() {
    const statuses = {};
    let pendingStateMessages = 0;
    let pendingTransitions = 0;
    for (const record of this._recordList) {
      statuses[record.phase] = (statuses[record.phase] ?? 0) + 1;
      pendingStateMessages += record.stateChannel.pendingCount;
      pendingTransitions += record.transitions.pendingCount;
    }
    return Object.freeze({
      lifecycle: this._lifecycle,
      total: this._recordList.length,
      startup_concurrency: this.startupConcurrency,
      snapshot_coalesce_ms: this.snapshotCoalesceMs,
      cached_revision: this._fleetRevision,
      pending_state_messages: pendingStateMessages,
      pending_transitions: pendingTransitions,
      statuses: Object.freeze(statuses),
      ...this.counters,
      scheduler: Object.freeze({ ...this.scheduler.stats }),
      safety_scheduler: Object.freeze({ ...this.safetyScheduler.stats }),
      ...(this.lastDeliveryError ? { last_delivery_error: this.lastDeliveryError } : {}),
    });
  }
}
