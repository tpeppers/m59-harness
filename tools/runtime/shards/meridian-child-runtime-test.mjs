#!/usr/bin/env node
// Offline child bootstrap ordering and fail-closed ownership tests.

import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import {
  MeridianShardWorker,
  parseMeridianShardChildArgs,
  validateMeridianShardInit,
} from './meridian-child-runtime.mjs';
import { MERIDIAN_SHARD_INIT_SCHEMA } from './meridian-supervisor.mjs';
import { SHARD_INIT_RESULT_SCHEMA } from './init-result.mjs';

let assertions = 0;
const check = (actual, expected, message) => {
  assertions++;
  assert.deepEqual(actual, expected, message);
};

const stateFile = resolve('child-runtime-test-roster.json');
const lockFile = `${stateFile}.lock`;
const entries = Object.freeze([{
  id: 'alpha',
  credentials: {
    account: 'account-alpha', password: 'must-never-cross-ipc', character: 'Alice',
    host: '127.0.0.1', port: 15959, lab_runtime: true,
  },
  autopilot: { mode: 'survive', policy: {} },
}]);
const selection = Object.freeze({
  fleet: 'lab-child', stateFile, lockFile, entries,
  roster: { alpha: entries[0] },
});
const payload = Object.freeze({
  schema: MERIDIAN_SHARD_INIT_SCHEMA,
  shard_id: 'shard-1',
  fleet: 'lab-child',
  state_file: stateFile,
  lock_file: lockFile,
  actor_ids: ['alpha'],
  permit: { opaque: 'permit-value' },
  config: { startupConcurrency: 3 },
});

check(parseMeridianShardChildArgs(['--shard-id', 'shard-2', '--agents', 'a,b']), {
  shardId: 'shard-2', actorIds: ['a', 'b'],
}, 'strict child arguments parse');
assertions++;
assert.throws(() => parseMeridianShardChildArgs(['--shard-id', '../2', '--agents', 'a']),
  /shard-N/);
assertions++;
assert.throws(() => validateMeridianShardInit({ ...payload, actor_ids: ['beta'] }, {
  shardId: 'shard-1', expectedActorIds: ['alpha'],
}), /assignment changed/);
assertions++;
assert.throws(() => validateMeridianShardInit({ ...payload, entries }, {
  shardId: 'shard-1', expectedActorIds: ['alpha'],
}), /credentials must not cross/);
assertions++;
assert.throws(() => validateMeridianShardInit({ ...payload, fleet: 'production' }, {
  shardId: 'shard-1', expectedActorIds: ['alpha'],
}), /dedicated lab/);

{
  const order = [];
  const health = [];
  let stopped = 0;
  const reporter = {
    publishHealth(status, details) { health.push({ status, details }); },
    createFleetRuntimeHooks() {
      return { onStateChanged() {}, transitionSink() {} };
    },
  };
  const actorFactory = () => ({});
  const runtime = {
    async start() { order.push('start'); return { total: 1, started: 1, failed: 0 }; },
    async stop() { stopped++; return { ok: true, total: 1, stopped: 1, failed: 0 }; },
  };
  const worker = new MeridianShardWorker({
    shardId: 'shard-1', actorIds: ['alpha'], reporter, env: {}, childPid: 4242,
    loadSelection(config, env) {
      order.push('roster');
      check(config.agents, ['alpha'], 'child reloads only its exact actor ids');
      check(env.M59_STATE_FILE, stateFile, 'child reload uses authorized roster path');
      return selection;
    },
    verifyPermit(options) {
      order.push('verify');
      check(options.childPid, 4242, 'ownership is bound to actual child pid');
      check(options.entries, entries, 'locally reloaded credentials are verified');
      return { ok: true };
    },
    configureEnvironment(value, _env, options) {
      order.push('environment');
      check(value, selection, 'verified selection configures the process');
      check(options.scope, 'shard-1', 'each child receives a private writer scope');
      return { runtimeDir: resolve('scratch-shard-1') };
    },
    installGlobals() { order.push('globals'); },
    async loadActorModule() {
      order.push('import');
      return {
        createMeridianActor: actorFactory,
        installFleetRosterSource(options) {
          order.push('roster-source');
          check(options.multiProcess, true, 'shards enable atomic cross-process spot claims');
        },
      };
    },
    runtimeFactory(options) {
      order.push('runtime');
      check(options.actorFactory, actorFactory, 'verified actor factory reaches runtime');
      check(options.startupConcurrency, 3, 'bounded startup config crosses the control seam');
      check(typeof options.transitionSink, 'function', 'exact reporter sink is installed');
      return runtime;
    },
    memoryUsage: () => ({ rss: 10 * 1024 * 1024, heapUsed: 2 * 1024 * 1024 }),
  });
  const result = await worker.initialize(payload);
  check(result, {
    schema: SHARD_INIT_RESULT_SCHEMA,
    ok: true,
    total: 1,
    started: 1,
    failed: 0,
    actor_ids: ['alpha'],
    started_actor_ids: ['alpha'],
    failures: [],
  }, 'child start summary');
  check(order, [
    'roster', 'verify', 'environment', 'globals', 'import', 'roster-source', 'runtime', 'start',
  ], 'ownership and isolation precede the first Meridian import');
  check(health.map(value => value.status), ['loading', 'running'], 'health lifecycle');
  await worker.stop('test complete');
  await worker.stop('again');
  check(stopped, 1, 'child runtime stop is idempotent');
}

// A shard with one failed actor remains useful and returns a credential-safe, exact
// partial result. The failed actor's arbitrary exception message never crosses IPC.
{
  const beta = {
    id: 'beta',
    credentials: {
      account: 'account-beta', password: 'another-private-value', character: 'Beta',
      host: '127.0.0.1', port: 15959, lab_runtime: true,
    },
    autopilot: { mode: 'survive', policy: {} },
  };
  const partialEntries = Object.freeze([entries[0], beta]);
  const partialSelection = Object.freeze({
    ...selection,
    entries: partialEntries,
    roster: { alpha: entries[0], beta },
  });
  const partialPayload = Object.freeze({ ...payload, actor_ids: ['alpha', 'beta'] });
  const health = [];
  const reporter = {
    publishHealth(status, details) { health.push({ status, details }); },
    createFleetRuntimeHooks() { return {}; },
  };
  const runtime = {
    async start() {
      return {
        ok: false,
        total: 2,
        started: 1,
        failed: 1,
        aborted_count: 0,
        failures: [{
          id: 'beta',
          error: {
            name: 'Error',
            code: 'M59_LOGIN_FAILED',
            message: 'password=must-not-cross-startup-result',
          },
        }],
        aborted: [],
      };
    },
    async stop() { return { ok: true, total: 2, stopped: 1, failed: 0, failures: [] }; },
  };
  const worker = new MeridianShardWorker({
    shardId: 'shard-1', actorIds: ['alpha', 'beta'], reporter, childPid: 4242,
    loadSelection: () => partialSelection,
    verifyPermit: () => ({ ok: true }),
    configureEnvironment: () => ({}),
    installGlobals() {},
    loadActorModule: async () => ({
      createMeridianActor() {},
      installFleetRosterSource() {},
    }),
    runtimeFactory: () => runtime,
    memoryUsage: () => ({ rss: 1, heapUsed: 1 }),
  });
  const result = await worker.initialize(partialPayload);
  check(result, {
    schema: SHARD_INIT_RESULT_SCHEMA,
    ok: false,
    total: 2,
    started: 1,
    failed: 1,
    actor_ids: ['alpha', 'beta'],
    started_actor_ids: ['alpha'],
    failures: [{ id: 'beta', code: 'M59_LOGIN_FAILED' }],
  }, 'partial shard result preserves exact counts and actor ids');
  check(health.at(-1).status, 'degraded', 'partial shard health is degraded');
  check(JSON.stringify(result).includes('must-not-cross-startup-result'), false,
    'startup exception messages are not public');
  await worker.stop('partial test complete');
}

// Stop during a deferred module load is a generation barrier: stop waits for the
// in-progress initializer to observe cancellation, and no runtime can be resurrected.
{
  let resolveModule;
  const moduleGate = new Promise(resolvePromise => { resolveModule = resolvePromise; });
  let runtimeCreated = 0;
  const reporter = {
    publishHealth() {},
    createFleetRuntimeHooks() { return {}; },
  };
  const worker = new MeridianShardWorker({
    shardId: 'shard-1', actorIds: ['alpha'], reporter,
    loadSelection: () => selection,
    verifyPermit: () => ({ ok: true }),
    configureEnvironment: () => ({}),
    installGlobals() {},
    loadActorModule: () => moduleGate,
    runtimeFactory: () => {
      runtimeCreated++;
      return { start: async () => ({}), stop: async () => ({ ok: true }) };
    },
  });
  const initializing = worker.initialize(payload);
  await Promise.resolve();
  await Promise.resolve();
  let stopSettled = false;
  const stopping = worker.stop('cancel deferred import').then(value => {
    stopSettled = true;
    return value;
  });
  await Promise.resolve();
  check(stopSettled, false, 'stop waits for the in-flight initializer to reach its barrier');
  resolveModule({ createMeridianActor() {}, installFleetRosterSource() {} });
  assertions++;
  await assert.rejects(initializing, error => error?.code === 'M59_SHARD_STOPPED');
  await stopping;
  check(runtimeCreated, 0, 'cancelled initialization never creates a runtime later');
}

// Failed ownership never configures paths, installs globals, or imports Meridian.
{
  const touched = [];
  const reporter = {
    publishHealth() {},
    createFleetRuntimeHooks() { return {}; },
  };
  const worker = new MeridianShardWorker({
    shardId: 'shard-1', actorIds: ['alpha'], reporter,
    loadSelection: () => selection,
    verifyPermit: () => ({ ok: false, reason: 'fleet-guard-not-held' }),
    configureEnvironment: () => touched.push('environment'),
    installGlobals: () => touched.push('globals'),
    loadActorModule: async () => { touched.push('import'); return {}; },
  });
  assertions++;
  await assert.rejects(worker.initialize(payload), /ownership verification failed/);
  check(touched, [], 'failed ownership has no Meridian or writable-path side effects');
}

console.log(`meridian shard child runtime: PASS (${assertions} assertions)`);
