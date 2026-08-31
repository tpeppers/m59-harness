// Meridian-aware shard bootstrap. Nothing in this module imports Session/map code; that
// import happens only after the child has reloaded its roster and verified both guards.

import { isAbsolute, resolve } from 'node:path';

import { loadLabSelection } from '../lab-config.mjs';
import { configureLabEnvironment } from '../lab-environment.mjs';
import { installLabGameGlobals } from '../lab-game-globals.mjs';
import { createMeridianFleetRuntime } from '../meridian-fleet-runtime.mjs';
import { verifyShardPermit } from './ownership.mjs';
import { MERIDIAN_SHARD_INIT_SCHEMA } from './meridian-supervisor.mjs';
import { createShardInitResult } from './init-result.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value))
    throw failure('M59_SHARD_INIT_PATH', `${label} must be absolute`);
  return resolve(value);
}

function actorIds(values) {
  if (!Array.isArray(values) || !values.length)
    throw failure('M59_SHARD_INIT_ACTORS', 'actor_ids must be a non-empty array');
  const result = values.map(value => {
    if (typeof value !== 'string' || !SAFE_ID.test(value))
      throw failure('M59_SHARD_INIT_ACTORS', 'actor id is invalid');
    return value;
  });
  if (new Set(result).size !== result.length)
    throw failure('M59_SHARD_INIT_ACTORS', 'actor ids contain duplicates');
  return Object.freeze(result);
}

function sameOrderedValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function startupConcurrency(value) {
  const number = value == null ? 2 : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 64)
    throw failure('M59_SHARD_INIT_CONFIG', 'startupConcurrency must be from 1 to 64');
  return number;
}

export function parseMeridianShardChildArgs(argv = process.argv.slice(2)) {
  let shardId = null;
  let actors = null;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[++index];
    if (value == null || String(value).startsWith('--'))
      throw new Error(`${flag} needs a value`);
    if (flag === '--shard-id') shardId = String(value);
    else if (flag === '--agents') actors = String(value).split(',').map(part => part.trim());
    else throw new Error(`unknown child option ${flag}`);
  }
  if (!shardId || !/^shard-[1-9][0-9]*$/.test(shardId))
    throw new Error('--shard-id must name shard-N');
  const ids = actorIds(actors);
  return Object.freeze({ shardId, actorIds: ids });
}

export function validateMeridianShardInit(payload, { shardId, expectedActorIds } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      payload.schema !== MERIDIAN_SHARD_INIT_SCHEMA)
    throw failure('M59_SHARD_INIT_SCHEMA', 'invalid Meridian shard initialization');
  if (payload.shard_id !== shardId)
    throw failure('M59_SHARD_INIT_IDENTITY', 'shard initialization identity mismatch');
  if (Object.hasOwn(payload, 'entries') || Object.hasOwn(payload, 'credentials'))
    throw failure('M59_SHARD_INIT_SECRET', 'roster credentials must not cross shard IPC');
  if (typeof payload.fleet !== 'string' || !SAFE_ID.test(payload.fleet) ||
      /prod|production|live/i.test(payload.fleet))
    throw failure('M59_SHARD_INIT_FLEET', 'invalid dedicated lab fleet');
  const ids = actorIds(payload.actor_ids);
  const expected = actorIds([...expectedActorIds]);
  if (!sameOrderedValues(ids, expected))
    throw failure('M59_SHARD_INIT_ACTORS', 'shard actor assignment changed');
  const config = payload.config && typeof payload.config === 'object' &&
    !Array.isArray(payload.config) ? payload.config : {};
  return Object.freeze({
    fleet: payload.fleet,
    shardId,
    actorIds: ids,
    stateFile: absolutePath(payload.state_file, 'state_file'),
    lockFile: absolutePath(payload.lock_file, 'lock_file'),
    permit: payload.permit,
    startupConcurrency: startupConcurrency(config.startupConcurrency),
  });
}

export class MeridianShardWorker {
  constructor({
    shardId,
    actorIds: assignedActorIds,
    reporter,
    env = process.env,
    childPid = process.pid,
    loadSelection = loadLabSelection,
    verifyPermit = verifyShardPermit,
    configureEnvironment = configureLabEnvironment,
    installGlobals = installLabGameGlobals,
    loadActorModule = () => import('../meridian-actor.mjs'),
    runtimeFactory = createMeridianFleetRuntime,
    memoryUsage = () => process.memoryUsage(),
  } = {}) {
    if (!reporter || typeof reporter.publishHealth !== 'function' ||
        typeof reporter.createFleetRuntimeHooks !== 'function')
      throw new TypeError('MeridianShardWorker needs a shard reporter');
    this.shardId = String(shardId);
    this.actorIds = actorIds([...assignedActorIds]);
    this.reporter = reporter;
    this.env = env;
    this.childPid = childPid;
    this.loadSelection = loadSelection;
    this.verifyPermit = verifyPermit;
    this.configureEnvironment = configureEnvironment;
    this.installGlobals = installGlobals;
    this.loadActorModule = loadActorModule;
    this.runtimeFactory = runtimeFactory;
    this.memoryUsage = memoryUsage;
    this.runtime = null;
    this.selection = null;
    this.environment = null;
    this.initPromise = null;
    this.stopPromise = null;
    this.runtimeStopPromise = null;
    this.stopRequested = false;
    this.stopReason = null;
  }

  initialize(payload) {
    if (this.initPromise) return this.initPromise;
    if (this.stopRequested)
      return Promise.reject(failure('M59_SHARD_STOPPED', 'shard initialization was stopped'));
    this.initPromise = this._initialize(payload).catch(async error => {
      try { await this._stopRuntime('shard initialization failed'); } catch {}
      throw error;
    });
    return this.initPromise;
  }

  _assertStarting() {
    if (this.stopRequested)
      throw failure('M59_SHARD_STOPPED', 'shard initialization was stopped');
  }

  async _initialize(payload) {
    const init = validateMeridianShardInit(payload, {
      shardId: this.shardId,
      expectedActorIds: this.actorIds,
    });
    const selection = this.loadSelection({
      fleet: init.fleet,
      action: 'check',
      agents: init.actorIds,
      shards: 1,
    }, { M59_STATE_FILE: init.stateFile, M59_TIME_SCALE: '1' });
    if (resolve(selection.stateFile) !== init.stateFile || resolve(selection.lockFile) !== init.lockFile)
      throw failure('M59_SHARD_ROSTER_PATH', 'reloaded roster path does not match authorization');
    const verified = this.verifyPermit({
      permit: init.permit,
      entries: selection.entries,
      childPid: this.childPid,
      expectedStateFile: init.stateFile,
      expectedLockFile: init.lockFile,
    });
    if (!verified?.ok)
      throw failure('M59_SHARD_OWNERSHIP', 'shard ownership verification failed');
    this._assertStarting();

    // This must precede the dynamic Meridian import: module-level map/evidence choices are
    // process-wide and must bind to the shard's private writer tree on first evaluation.
    this.environment = this.configureEnvironment(selection, this.env, { scope: this.shardId });
    this.installGlobals(selection);
    this._assertStarting();
    this.selection = selection;
    this.reporter.publishHealth('loading', {
      actors: selection.entries.length,
      geometry: 'lab-lazy',
    });
    const actorModule = await this.loadActorModule();
    this._assertStarting();
    if (typeof actorModule?.createMeridianActor !== 'function' ||
        typeof actorModule?.installFleetRosterSource !== 'function')
      throw failure('M59_SHARD_ACTOR_MODULE', 'Meridian actor module is incomplete');
    actorModule.installFleetRosterSource({
      roster: selection.roster,
      stateFile: selection.stateFile,
      entries: selection.entries,
      multiProcess: true,
    });
    this._assertStarting();
    const hooks = this.reporter.createFleetRuntimeHooks();
    this.runtime = this.runtimeFactory({
      runtimeId: `${selection.fleet}-${this.shardId}-${this.childPid}-${Date.now()}`,
      entries: selection.entries,
      startupConcurrency: init.startupConcurrency,
      actorFactory: actorModule.createMeridianActor,
      driver: 'lab-shard',
      ...hooks,
    });
    if (this.stopRequested) {
      await this._stopRuntime(this.stopReason ?? 'shard stopped during initialization');
      this._assertStarting();
    }
    const started = await this.runtime.start();
    if (this.stopRequested) {
      await this._stopRuntime(this.stopReason ?? 'shard stopped during initialization');
      this._assertStarting();
    }
    const failedById = new Map((started.failures ?? []).map(row => [row.id, {
      id: row.id,
      code: row.error?.code,
    }]));
    for (const id of started.aborted ?? [])
      failedById.set(id, { id, code: 'M59_ACTOR_START_ABORTED' });
    const startedActorIds = init.actorIds.filter(id => !failedById.has(id));
    const summary = createShardInitResult({
      actorIds: init.actorIds,
      startedActorIds,
      failures: init.actorIds.filter(id => failedById.has(id)).map(id => failedById.get(id)),
    });
    if (summary.started !== started.started || summary.total !== started.total)
      throw failure('M59_SHARD_START_RESULT', 'shard runtime startup result is inconsistent');
    const memory = this.memoryUsage();
    const health = summary.started === 0 ? 'failed' : summary.failed ? 'degraded' : 'running';
    this.reporter.publishHealth(health, {
      actors: summary.total,
      started: summary.started,
      failed: summary.failed,
      rss_mib: Math.round(Number(memory.rss ?? 0) / 1024 / 1024),
      heap_mib: Math.round(Number(memory.heapUsed ?? 0) / 1024 / 1024),
    });
    if (summary.started === 0)
      throw failure('M59_SHARD_NO_ACTORS', 'no shard actor started successfully');
    return summary;
  }

  stop(reason = 'shard stopped') {
    this.stopRequested = true;
    this.stopReason ??= String(reason);
    if (this.stopPromise) return this.stopPromise;
    const immediate = this.runtime ? this._stopRuntime(this.stopReason) : null;
    this.stopPromise = (async () => {
      if (immediate) await immediate;
      if (this.initPromise) {
        try { await this.initPromise; } catch {}
      }
      return this._stopRuntime(this.stopReason);
    })();
    return this.stopPromise;
  }

  _stopRuntime(reason) {
    if (this.runtimeStopPromise) return this.runtimeStopPromise;
    if (!this.runtime)
      return Promise.resolve(Object.freeze({
        ok: true, total: 0, stopped: 0, failed: 0, failures: [],
      }));
    this.runtimeStopPromise = Promise.resolve(this.runtime.stop(String(reason))).then(result =>
      result ?? Object.freeze({ ok: true, total: 0, stopped: 0, failed: 0, failures: [] }));
    return this.runtimeStopPromise;
  }
}
