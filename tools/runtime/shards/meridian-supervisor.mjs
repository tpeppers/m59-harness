// Parent-side lifecycle for optional Meridian lab shards.
//
// This module imports no Meridian engine code. It forks minimal waiting children, proves
// their exact pids against parent-owned fleet/account claims, and only then sends the
// capability-bearing initialization frame. Children reload the exact roster subset from
// disk, so account passwords never cross IPC. A failed startup or stop targets only the
// ChildProcess handles created here; lease release remains the runner's responsibility,
// and live/uncertain guards therefore stay fail-closed.

import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { immutableStateValue } from '../state/json-value.mjs';
import { isProcessLive } from '../fleet-lock.mjs';
import { authorizeShard, MAX_LAB_SHARDS } from './ownership.mjs';
import { ShardParentController } from './parent-controller.mjs';
import { credentialFreeIpcValue } from './safe-value.mjs';
import { createChildProcessParentTransport } from './transport.mjs';

export const MERIDIAN_SHARD_INIT_SCHEMA = 'm59-meridian-shard-init/v1';
export const MERIDIAN_SHARD_SUPERVISOR_SCHEMA = 'm59-meridian-shard-supervisor/v1';
export const DEFAULT_MERIDIAN_SHARD_CHILD = fileURLToPath(
  new URL('../../m59-lab-shard-child.mjs', import.meta.url),
);

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MIN_INIT_TIMEOUT_MS = 30_000;
const MAX_INIT_TIMEOUT_MS = 10 * 60_000;
const INIT_WAVE_BUDGET_MS = 2_000;
const INIT_FIXED_BUDGET_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_EXIT_TIMEOUT_MS = 2_000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 5_000;

function positiveInteger(value, fallback, label) {
  const result = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw new RangeError(`${label} must be a positive safe integer`);
  return result;
}

export function deriveShardInitTimeoutMs({ actorCounts, startupConcurrency = 2 } = {}) {
  if (!Array.isArray(actorCounts) || !actorCounts.length || actorCounts.some(value =>
    !Number.isSafeInteger(value) || value < 1))
    throw new TypeError('actorCounts must contain positive shard actor counts');
  const concurrency = positiveInteger(startupConcurrency, 2, 'startupConcurrency');
  if (concurrency > 64) throw new RangeError('startupConcurrency must be from 1 to 64 per shard');
  const waves = Math.ceil(Math.max(...actorCounts) / concurrency);
  return Math.min(MAX_INIT_TIMEOUT_MS, Math.max(
    MIN_INIT_TIMEOUT_MS,
    INIT_FIXED_BUDGET_MS + waves * INIT_WAVE_BUDGET_MS,
  ));
}

function boundedInitTimeout(value, fallback) {
  const timeout = positiveInteger(value, fallback, 'initTimeoutMs');
  if (timeout > MAX_INIT_TIMEOUT_MS)
    throw new RangeError(`initTimeoutMs must not exceed ${MAX_INIT_TIMEOUT_MS}`);
  return timeout;
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value))
    throw new TypeError(`${label} must be an absolute path`);
  return resolve(value);
}

function actorId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(value))
    throw new TypeError('shard actor id is invalid');
  return value.trim();
}

function assignmentsFor(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_LAB_SHARDS)
    throw new TypeError(`assignments must contain 1-${MAX_LAB_SHARDS} shards`);
  const allActors = new Set();
  return Object.freeze(values.map((value, index) => {
    if (!Array.isArray(value?.entries) || !value.entries.length)
      throw new TypeError('each shard assignment needs actor entries');
    const entries = Object.freeze([...value.entries]);
    const actorIds = Object.freeze(entries.map(entry => {
      const id = actorId(entry?.id);
      if (allActors.has(id)) throw new TypeError(`actor ${id} is assigned to more than one shard`);
      allActors.add(id);
      return id;
    }));
    if (new Set(actorIds).size !== actorIds.length)
      throw new TypeError('one shard assignment contains duplicate actors');
    return Object.freeze({
      permitId: index + 1,
      shardId: `shard-${index + 1}`,
      actorIds,
      entries,
    });
  }));
}

function boundedReason(value) {
  const reason = String(value ?? 'parent requested stop');
  return reason.length <= 512 ? reason : `${reason.slice(0, 509)}...`;
}

function timeoutError(label) {
  return Object.assign(new Error(`${label} timed out`), { code: 'M59_SHARD_TIMEOUT' });
}

function withTimeout(promise, timeoutMs, label, setTimer, clearTimer) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      rejectPromise(timeoutError(label));
    }, timeoutMs);
    Promise.resolve(promise).then(value => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      resolvePromise(value);
    }, error => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      rejectPromise(error);
    });
  });
}

function waitBounded(promise, timeoutMs, setTimer, clearTimer) {
  return new Promise(resolvePromise => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      resolvePromise(false);
    }, timeoutMs);
    Promise.resolve(promise).then(() => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      resolvePromise(true);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      resolvePromise(false);
    });
  });
}

function scrubChildEnvironment(source) {
  const env = { ...(source ?? {}) };
  // A waiting child receives no roster path or prior keeper capability. Its roster
  // reference and permit arrive in the private init frame after authorization commits.
  for (const key of [
    'M59_STATE_FILE', 'M59_FLEET', 'M59_KEEPER_OWNERSHIP',
    'M59_ACCOUNT', 'M59_PASSWORD', 'M59_CHARACTER',
  ]) delete env[key];
  env.M59_LAB_SHARD_CHILD = '1';
  return env;
}

/** Default Windows-safe fork. The injected test form receives the same public spec. */
export function spawnMeridianShardChild({
  childEntry = DEFAULT_MERIDIAN_SHARD_CHILD,
  shardId,
  actorIds,
  cwd = process.cwd(),
  env = process.env,
  forkProcess = fork,
  spawnOptions = {},
} = {}) {
  if (typeof forkProcess !== 'function') throw new TypeError('forkProcess must be a function');
  const entry = childEntry instanceof URL ? fileURLToPath(childEntry) : String(childEntry ?? '');
  if (!entry) throw new TypeError('childEntry is required');
  const args = ['--shard-id', String(shardId), '--agents', actorIds.map(actorId).join(',')];
  return forkProcess(entry, args, {
    ...spawnOptions,
    cwd,
    env: scrubChildEnvironment(env),
    windowsHide: true,
    detached: false,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}

/** The only object in this module that deliberately carries capability tokens. */
export function meridianShardInitPayload({
  shardId,
  fleet,
  stateFile,
  lockFile,
  actorIds,
  permit,
  config = {},
} = {}) {
  if (typeof fleet !== 'string' || !fleet.trim()) throw new TypeError('fleet is required');
  return {
    schema: MERIDIAN_SHARD_INIT_SCHEMA,
    shard_id: String(shardId),
    fleet: fleet.trim(),
    state_file: absolutePath(stateFile, 'state file'),
    lock_file: absolutePath(lockFile, 'lock file'),
    actor_ids: Object.freeze(actorIds.map(actorId)),
    permit,
    config: credentialFreeIpcValue(config),
  };
}

function childRecord(child, assignment) {
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof child?.on !== 'function' ||
      typeof child?.kill !== 'function')
    throw new TypeError('spawned shard must be a ChildProcess-like object with pid/on/kill');
  let resolveExit;
  const exited = new Promise(resolvePromise => { resolveExit = resolvePromise; });
  const record = {
    assignment,
    child,
    pid,
    controller: null,
    transport: null,
    exited,
    didExit: child.exitCode != null || child.signalCode != null,
    exit: null,
    authorized: false,
    initialized: false,
    initSummary: null,
    terminated: false,
    unsubscribers: [],
  };
  const onExit = (code, signal) => {
    if (record.didExit) return;
    record.didExit = true;
    record.exit = Object.freeze({
      code: Number.isInteger(code) ? code : null,
      signal: typeof signal === 'string' ? signal : null,
    });
    resolveExit(record.exit);
  };
  child.once?.('exit', onExit);
  if (record.didExit) resolveExit(Object.freeze({
    code: Number.isInteger(child.exitCode) ? child.exitCode : null,
    signal: typeof child.signalCode === 'string' ? child.signalCode : null,
  }));
  return record;
}

function safeFailure(code, stage, shardId = null) {
  return Object.freeze({ code, stage, ...(shardId ? { shard_id: shardId } : {}) });
}

export class MeridianShardSupervisor {
  #assignments;
  #fleetClaim;
  #accountLeases;
  #initConfig;

  constructor({
    assignments,
    fleet,
    stateFile,
    fleetClaim,
    accountLeases,
    initConfig = {},
    childEntry = DEFAULT_MERIDIAN_SHARD_CHILD,
    cwd = process.cwd(),
    env = process.env,
    spawnOptions = {},
    spawnShard = spawnMeridianShardChild,
    transportFactory = createChildProcessParentTransport,
    controllerFactory = options => new ShardParentController(options),
    authorize = authorizeShard,
    initPayloadFactory = meridianShardInitPayload,
    terminateChild = child => child.kill(),
    isPidLive = isProcessLive,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    initTimeoutMs = null,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    exitTimeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
    terminateTimeoutMs = DEFAULT_TERMINATE_TIMEOUT_MS,
    runtimeId = `lab-shards-${process.pid}-${Date.now()}`,
  } = {}) {
    this.#assignments = assignmentsFor(assignments);
    if (typeof fleet !== 'string' || !fleet.trim()) throw new TypeError('fleet is required');
    this.fleet = fleet.trim();
    this.stateFile = absolutePath(stateFile, 'state file');
    if (!fleetClaim?.path || !fleetClaim?.lock || !accountLeases)
      throw new TypeError('fleetClaim and accountLeases are required');
    this.#fleetClaim = fleetClaim;
    this.#accountLeases = accountLeases;
    this.#initConfig = initConfig;
    this.startupConcurrencyPerShard = positiveInteger(
      initConfig?.startupConcurrency, 2, 'startupConcurrency');
    if (this.startupConcurrencyPerShard > 64)
      throw new RangeError('startupConcurrency must be from 1 to 64 per shard');
    for (const [name, value] of Object.entries({
      spawnShard, transportFactory, controllerFactory, authorize,
      initPayloadFactory, terminateChild, isPidLive, now, setTimer, clearTimer,
    })) {
      if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
    }
    this.childEntry = childEntry;
    this.cwd = cwd;
    this.env = env;
    this.spawnOptions = spawnOptions;
    this.spawnShard = spawnShard;
    this.transportFactory = transportFactory;
    this.controllerFactory = controllerFactory;
    this.authorize = authorize;
    this.initPayloadFactory = initPayloadFactory;
    this.terminateChild = terminateChild;
    this.isPidLive = isPidLive;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.handshakeTimeoutMs = positiveInteger(
      handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, 'handshakeTimeoutMs');
    const derivedInitTimeout = deriveShardInitTimeoutMs({
      actorCounts: this.#assignments.map(assignment => assignment.actorIds.length),
      startupConcurrency: this.startupConcurrencyPerShard,
    });
    this.initTimeoutMs = boundedInitTimeout(initTimeoutMs, derivedInitTimeout);
    this.stopTimeoutMs = positiveInteger(stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, 'stopTimeoutMs');
    this.exitTimeoutMs = positiveInteger(exitTimeoutMs, DEFAULT_EXIT_TIMEOUT_MS, 'exitTimeoutMs');
    this.terminateTimeoutMs = positiveInteger(
      terminateTimeoutMs, DEFAULT_TERMINATE_TIMEOUT_MS, 'terminateTimeoutMs');
    this.runtimeId = String(runtimeId);
    this.events = new EventEmitter();
    this.records = [];
    this.byActor = new Map();
    this.lifecycle = 'created';
    this.revision = 0;
    this.lastFailure = null;
    this._startPromise = null;
    this._stopPromise = null;
    this._stopRequested = false;
  }

  get actorIds() { return Object.freeze([...this.byActor.keys()]); }
  get allChildrenConfirmedDead() {
    return this.records.every(record => this._confirmedDead(record));
  }
  get stats() {
    return immutableStateValue({
      shards: this.records.length,
      actors: this.#assignments.reduce((sum, value) => sum + value.actorIds.length, 0),
      children_alive: this.records.filter(record => !this._confirmedDead(record)).length,
      children_authorized: this.records.filter(record => record.authorized).length,
      children_initialized: this.records.filter(record => record.initialized).length,
      actors_started: this.records.reduce((sum, record) =>
        sum + Number(record.initSummary?.started ?? 0), 0),
      actors_failed: this.records.reduce((sum, record) =>
        sum + Number(record.initSummary?.failed ?? 0), 0),
      startup_concurrency_per_shard: this.startupConcurrencyPerShard,
      init_timeout_ms: this.initTimeoutMs,
      controllers: this.records.map(record => record.controller?.stats ?? null),
    });
  }

  on(event, handler) {
    this.events.on(event, handler);
    return () => this.events.off(event, handler);
  }

  streamsFor(id) {
    return this.byActor.get(actorId(id))?.controller?.streamsFor(id) ?? null;
  }

  snapshot() {
    const shards = this.records.map(record => record.controller?.snapshot() ?? {
      shard_id: record.assignment.shardId,
      lifecycle: record.didExit ? 'disconnected' : 'starting',
      actors: record.assignment.actorIds.map(id => ({ id, status: 'pending', state: null })),
    });
    const actors = shards.flatMap(shard => (shard.actors ?? []).map(actor => ({
      ...actor,
      shard_id: shard.shard_id,
    })));
    return immutableStateValue({
      schema: MERIDIAN_SHARD_SUPERVISOR_SCHEMA,
      runtime_id: this.runtimeId,
      revision: this.revision,
      observed_at_ms: Math.floor(Number(this.now())),
      lifecycle: this.lifecycle,
      total: actors.length,
      all_children_confirmed_dead: this.allChildrenConfirmedDead,
      ...(this.lastFailure ? { failure: this.lastFailure } : {}),
      shards,
      actors,
    });
  }

  start() {
    if (this._startPromise) return this._startPromise;
    if (this.lifecycle !== 'created')
      return Promise.reject(new Error(`cannot start shard supervisor from ${this.lifecycle}`));
    this.lifecycle = 'starting';
    this._bump();
    this._startPromise = this._startAll();
    return this._startPromise;
  }

  async _startAll() {
    let stage = 'spawn';
    let shardId = null;
    try {
      for (const assignment of this.#assignments) {
        shardId = assignment.shardId;
        const publicSpec = Object.freeze({
          childEntry: this.childEntry,
          shardId: assignment.shardId,
          actorIds: assignment.actorIds,
          cwd: this.cwd,
          env: this.env,
          spawnOptions: this.spawnOptions,
          windowsHide: true,
        });
        const child = this.spawnShard(publicSpec);
        const record = childRecord(child, assignment);
        this.records.push(record);
        for (const id of assignment.actorIds) this.byActor.set(id, record);
        record.transport = this.transportFactory(child);
        record.controller = this.controllerFactory({
          transport: record.transport,
          shardId: assignment.shardId,
          expectedActorIds: assignment.actorIds,
          now: this.now,
          setTimer: this.setTimer,
          clearTimer: this.clearTimer,
        });
        this._watchRecord(record);
        record.ready = record.controller.start();
      }

      stage = 'handshake';
      const ready = await Promise.all(this.records.map(record => withTimeout(
        record.ready,
        this.handshakeTimeoutMs,
        `${record.assignment.shardId} handshake`,
        this.setTimer,
        this.clearTimer,
      )));
      for (let index = 0; index < ready.length; index++) {
        const record = this.records[index];
        shardId = record.assignment.shardId;
        if (ready[index]?.process_id !== record.pid)
          throw Object.assign(new Error('child hello pid does not match spawned process'), {
            code: 'M59_SHARD_PID_MISMATCH',
          });
      }
      if (this._stopRequested) throw Object.assign(new Error('supervisor is stopping'), {
        code: 'M59_SHARD_STOPPING',
      });

      // Complete every ownership authorization before sending any private init permit.
      stage = 'authorization';
      const authorized = [];
      for (const record of this.records) {
        shardId = record.assignment.shardId;
        const result = this.authorize({
          shardId: record.assignment.permitId,
          stateFile: this.stateFile,
          entries: record.assignment.entries,
          childPid: record.pid,
          fleetClaim: this.#fleetClaim,
          accountLeases: this.#accountLeases,
          isPidLive: this.isPidLive,
        });
        if (!result?.ok) throw Object.assign(new Error('shard ownership authorization failed'), {
          code: `M59_SHARD_AUTH_${String(result?.reason ?? 'FAILED').toUpperCase().replace(/-/g, '_')}`,
        });
        record.authorized = true;
        authorized.push({ record, permit: result.permit });
      }
      if (this._stopRequested) throw Object.assign(new Error('supervisor is stopping'), {
        code: 'M59_SHARD_STOPPING',
      });

      stage = 'initialization';
      const initialized = await Promise.all(authorized.map(({ record, permit }) => {
        shardId = record.assignment.shardId;
        let payload;
        try {
          payload = this.initPayloadFactory({
            shardId: record.assignment.shardId,
            fleet: this.fleet,
            stateFile: this.stateFile,
            lockFile: this.#fleetClaim.path,
            actorIds: record.assignment.actorIds,
            permit,
            config: this.#initConfig,
          });
        } catch {
          throw Object.assign(new Error('shard initialization payload could not be built'), {
            code: 'M59_SHARD_INIT_PAYLOAD',
          });
        }
        return withTimeout(
          record.controller.sendInit(payload).then(result => {
            if (result?.initialized !== true || !Number.isSafeInteger(result.started) ||
                result.started < 0 || !Number.isSafeInteger(result.failed) || result.failed < 0 ||
                result.started + result.failed !== record.assignment.actorIds.length)
              throw Object.assign(new Error('shard returned an invalid startup result'), {
                code: 'M59_SHARD_INIT_RESULT',
              });
            if (result.started === 0)
              throw Object.assign(new Error('shard started no assigned actors'), {
                code: 'M59_SHARD_NO_ACTORS',
              });
            record.initialized = true;
            record.initSummary = result;
            return result;
          }),
          this.initTimeoutMs,
          `${record.assignment.shardId} initialization`,
          this.setTimer,
          this.clearTimer,
        );
      }));
      if (this._stopRequested) throw Object.assign(new Error('supervisor is stopping'), {
        code: 'M59_SHARD_STOPPING',
      });
      const total = initialized.reduce((sum, result) => sum + result.total, 0);
      const startedCount = initialized.reduce((sum, result) => sum + result.started, 0);
      const failed = initialized.reduce((sum, result) => sum + result.failed, 0);
      const failures = initialized.flatMap(result => result.failures.map(failure => ({
        id: failure.id,
        code: failure.code,
        shard_id: result.shard_id,
      })));
      const startedActorIds = initialized.flatMap(result => result.started_actor_ids);
      if (total !== this.byActor.size || startedCount + failed !== total ||
          failures.length !== failed)
        throw Object.assign(new Error('aggregate shard startup result is inconsistent'), {
          code: 'M59_SHARD_INIT_RESULT',
        });
      this.lifecycle = failed ? 'degraded' : 'running';
      this._bump();
      const result = immutableStateValue({
        ok: failed === 0,
        shards: this.records.length,
        total,
        started: startedCount,
        failed,
        failures,
        actor_ids: this.actorIds,
        started_actor_ids: startedActorIds,
      });
      this.events.emit('started', result);
      return result;
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'M59_SHARD_START_FAILED';
      this.lastFailure = safeFailure(code, stage, shardId);
      this.events.emit('failure', this.lastFailure);
      await this.stop(`startup failed during ${stage}`);
      const failure = Object.assign(new Error(`sharded lab startup failed during ${stage}`), { code });
      throw failure;
    }
  }

  stop(reason = 'parent requested stop') {
    this._stopRequested = true;
    if (this._stopPromise) return this._stopPromise;
    this._stopPromise = this._stopAll(boundedReason(reason));
    return this._stopPromise;
  }

  async _stopAll(reason) {
    if (this.lifecycle === 'stopped' && this.allChildrenConfirmedDead)
      return this._stopSummary([]);
    this.lifecycle = 'stopping';
    this._bump();
    const graceful = await Promise.all(this.records.map(async record => {
      if (record.didExit) return Object.freeze({ requested: false, ok: true });
      try {
        const result = await record.controller.requestStop(reason, {
          timeoutMs: this.stopTimeoutMs,
        });
        return Object.freeze({ requested: true, ok: result?.ok === true });
      } catch {
        return Object.freeze({ requested: true, ok: false });
      }
    }));

    // A stop acknowledgement means the child runtime has torn down its sockets. Close
    // the private IPC channel so the waiting child entry can exit normally; only a child
    // that remains behind after this bounded path reaches exact-handle termination.
    for (let index = 0; index < this.records.length; index++) {
      const record = this.records[index];
      if (!record.didExit && graceful[index]?.ok && typeof record.transport?.close === 'function') {
        try { record.transport.close(); } catch {}
      }
    }

    await Promise.all(this.records.map(record => record.didExit
      ? true
      : waitBounded(record.exited, this.exitTimeoutMs, this.setTimer, this.clearTimer)));

    for (const record of this.records) {
      if (record.didExit) continue;
      try {
        record.terminated = this.terminateChild(record.child, Object.freeze({
          pid: record.pid,
          shardId: record.assignment.shardId,
        })) !== false;
      } catch {
        record.terminated = false;
      }
    }
    await Promise.all(this.records.map(record => record.didExit
      ? true
      : waitBounded(record.exited, this.terminateTimeoutMs, this.setTimer, this.clearTimer)));

    const results = this.records.map((record, index) => Object.freeze({
      shard_id: record.assignment.shardId,
      pid: record.pid,
      graceful: graceful[index]?.ok === true,
      terminated: record.terminated,
      confirmed_dead: this._confirmedDead(record),
      exit: record.exit,
    }));
    const allDead = results.every(result => result.confirmed_dead);
    this.lifecycle = allDead ? 'stopped' : 'stop-failed';
    if (!allDead && !this.lastFailure)
      this.lastFailure = safeFailure('M59_SHARD_CHILD_STILL_LIVE', 'stop');
    this._bump();
    const summary = this._stopSummary(results);
    this.events.emit('stopped', summary);
    return summary;
  }

  _stopSummary(results) {
    return immutableStateValue({
      ok: this.allChildrenConfirmedDead,
      shards: this.records.length,
      all_children_confirmed_dead: this.allChildrenConfirmedDead,
      results,
    });
  }

  _confirmedDead(record) {
    if (record.didExit) return true;
    let live;
    try { live = this.isPidLive(record.pid); } catch { live = undefined; }
    return live === false;
  }

  _watchRecord(record) {
    const changed = () => this._bump();
    for (const event of ['state', 'transition', 'health', 'initialized', 'stopped'])
      record.unsubscribers.push(record.controller.on(event, changed));
    record.unsubscribers.push(record.controller.on('crash', details => {
      this._unexpectedFailure('M59_SHARD_CRASH', record.assignment.shardId, details);
    }));
    record.unsubscribers.push(record.controller.on('close', details => {
      if (!details?.graceful && !this._stopRequested)
        this._unexpectedFailure('M59_SHARD_DISCONNECTED', record.assignment.shardId);
      this._bump();
    }));
    record.child.once?.('exit', () => {
      if (!this._stopRequested)
        this._unexpectedFailure('M59_SHARD_EXITED', record.assignment.shardId);
      this._bump();
    });
  }

  _unexpectedFailure(code, shardId) {
    if (!this.lastFailure) {
      this.lastFailure = safeFailure(code, 'runtime', shardId);
      this.events.emit('failure', this.lastFailure);
    }
    if (!this._stopRequested) queueMicrotask(() => { void this.stop('shard failure'); });
  }

  _bump() {
    if (this.revision < Number.MAX_SAFE_INTEGER) this.revision++;
    this.events.emit('change', this.revision);
  }
}
