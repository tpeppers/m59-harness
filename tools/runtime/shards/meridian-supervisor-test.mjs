#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountLeaseRegistry } from '../account-leases.mjs';
import { claimFleetLock, inspectFleetLock } from '../fleet-lock.mjs';
import { ShardChildReporter } from './child-reporter.mjs';
import { createShardInitResult } from './init-result.mjs';
import {
  MERIDIAN_SHARD_INIT_SCHEMA,
  MeridianShardSupervisor,
  deriveShardInitTimeoutMs,
  meridianShardInitPayload,
  spawnMeridianShardChild,
} from './meridian-supervisor.mjs';
import { partitionShardEntries, verifyShardPermit } from './ownership.mjs';

const root = mkdtempSync(join(tmpdir(), 'm59-meridian-supervisor-'));
let assertions = 0;
const check = (actual, expected, message) => {
  assertions++;
  assert.deepEqual(actual, expected, message);
};
const turn = () => new Promise(resolve => setImmediate(resolve));

function entry(id, account, character, partner = null) {
  return {
    id,
    credentials: {
      account,
      password: `password-${id}`,
      character,
      host: '127.0.0.1',
      port: 15959,
      lab_runtime: true,
    },
    autopilot: { mode: 'survive', policy: partner ? { partner } : {} },
  };
}

function transportPair() {
  const parentMessages = new Set();
  const childMessages = new Set();
  const parentCloses = new Set();
  const childCloses = new Set();
  let closed = false;
  const endpoint = (mine, theirs, closes) => Object.freeze({
    send(value) {
      if (closed) return Promise.reject(new Error('test transport is closed'));
      queueMicrotask(() => {
        if (!closed) for (const handler of theirs) handler(value);
      });
      return Promise.resolve();
    },
    onMessage(handler) { mine.add(handler); return () => mine.delete(handler); },
    onClose(handler) { closes.add(handler); return () => closes.delete(handler); },
    onError() { return () => {}; },
    close() { closeBoth(); },
  });
  const closeBoth = (details = { source: 'test-exit', code: 0, signal: null }) => {
    if (closed) return;
    closed = true;
    for (const handler of [...parentCloses]) handler(details);
    for (const handler of [...childCloses]) handler(details);
  };
  return {
    parent: endpoint(parentMessages, childMessages, parentCloses),
    child: endpoint(childMessages, parentMessages, childCloses),
    closeBoth,
  };
}

class FakeChild extends EventEmitter {
  constructor(pid, pair, live, { killSucceeds = true } = {}) {
    super();
    this.pid = pid;
    this.pair = pair;
    this.disconnectCalls = 0;
    this.parentTransport = Object.freeze({
      ...pair.parent,
      close: () => {
        this.disconnectCalls++;
        pair.parent.close();
        queueMicrotask(() => this.finish(0, null));
      },
    });
    this.exitCode = null;
    this.signalCode = null;
    this.killSucceeds = killSucceeds;
    this.killCalls = 0;
    live.add(pid);
    this.live = live;
  }

  kill() {
    this.killCalls++;
    if (!this.killSucceeds) return false;
    this.finish(null, 'SIGTERM');
    return true;
  }

  finish(code = 0, signal = null) {
    if (this.exitCode != null || this.signalCode != null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.live.delete(this.pid);
    this.emit('exit', code, signal);
    this.pair.closeBoth({ source: 'exit', code, signal });
  }
}

function ownership(name, entries, live, parentPid, { guardChildren = true } = {}) {
  let counter = 0;
  const tokenFactory = () => `${name}-token-${++counter}-long`;
  const fleetPath = join(root, `${name}.json.lock`);
  const fleetClaim = claimFleetLock(fleetPath, {
    pid: parentPid,
    token: tokenFactory(),
    tokenFactory,
    guards: [],
    isPidLive: pid => live.has(pid),
  });
  assert.equal(fleetClaim.ok, true);
  const leaseDir = join(root, `${name}-leases`);
  const accountLeases = new AccountLeaseRegistry({
    leaseDir,
    pid: parentPid,
    tokenFactory,
    guardChildren,
    isPidLive: pid => live.has(pid),
    legacyRosterRoots: [],
  });
  assert.equal(accountLeases.acquireAll(entries).ok, true);
  return { fleetPath, fleetClaim, leaseDir, accountLeases };
}

function fakeSpawner({
  live,
  parentPid,
  leaseDir,
  fleetPath,
  initPayloads,
  spawnSpecs,
  rosterEntries,
  behavior = 'graceful',
  firstPid = 51000,
  onVerify = null,
  initResult = null,
} = {}) {
  let nextPid = firstPid;
  const children = [];
  const reporters = [];
  const rosterById = new Map(rosterEntries.map(value => [value.id, value]));
  const spawn = spec => {
    spawnSpecs.push(spec);
    const pair = transportPair();
    const child = new FakeChild(nextPid++, pair, live, {
      killSucceeds: behavior !== 'unkillable',
    });
    const reporter = new ShardChildReporter({
      transport: pair.child,
      shardId: spec.shardId,
      actorIds: spec.actorIds,
      processId: child.pid,
      onStop: behavior === 'graceful' ? async () => {} : () => new Promise(() => {}),
      verifyInit: async payload => {
        initPayloads.push(payload);
        onVerify?.({ payload, child, children });
        if (payload?.schema !== MERIDIAN_SHARD_INIT_SCHEMA)
          throw Object.assign(new Error('wrong init schema'), { code: 'BAD_INIT_SCHEMA' });
        const selectedEntries = spec.actorIds.map(id => rosterById.get(id));
        if (selectedEntries.some(value => !value))
          throw Object.assign(new Error('roster actor missing'), { code: 'ROSTER_ACTOR_MISSING' });
        const verified = verifyShardPermit({
          permit: payload.permit,
          entries: selectedEntries,
          childPid: child.pid,
          expectedStateFile: payload.state_file,
          expectedLockFile: fleetPath,
          leaseDir,
          isPidLive: pid => live.has(pid),
        });
        if (!verified.ok)
          throw Object.assign(new Error('ownership verification failed'), {
            code: `VERIFY_${verified.reason}`,
          });
        return typeof initResult === 'function'
          ? initResult({ spec, verified })
          : initResult ?? verified;
      },
    });
    children.push(child);
    reporters.push(reporter);
    queueMicrotask(() => {
      void reporter.start().catch(() => {});
      void reporter.waitForInit().catch(() => {});
    });
    return child;
  };
  return { spawn, children, reporters };
}

function supervisorOptions({ assignments, stateFile, owned, live, spawned, initConfig = {} }) {
  return {
    assignments,
    fleet: 'lab-sharded-test',
    stateFile,
    fleetClaim: owned.fleetClaim,
    accountLeases: owned.accountLeases,
    initConfig,
    spawnShard: spawned.spawn,
    transportFactory: child => child.parentTransport,
    isPidLive: pid => live.has(pid),
    handshakeTimeoutMs: 100,
    initTimeoutMs: 100,
    stopTimeoutMs: 20,
    exitTimeoutMs: 10,
    terminateTimeoutMs: 20,
  };
}

try {
  const hundredBotTimeout = deriveShardInitTimeoutMs({
    actorCounts: [50, 50],
    startupConcurrency: 2,
  });
  check(hundredBotTimeout > 35_000, true,
    '100 actors across two shards receives more than the paced-login floor');
  check(hundredBotTimeout <= 10 * 60_000, true,
    'derived initialization deadline remains bounded');

  // The default fork boundary strips paths/capabilities and forces hidden, attached IPC.
  let forked;
  const sentinel = {};
  const returned = spawnMeridianShardChild({
    childEntry: join(root, 'child.mjs'),
    shardId: 'shard-1',
    actorIds: ['alpha'],
    env: {
      SAFE_VALUE: 'yes',
      M59_PASSWORD: 'must-not-cross',
      M59_STATE_FILE: join(root, 'secret-roster.json'),
      M59_KEEPER_OWNERSHIP: 'old-capability',
    },
    forkProcess: (entryPath, args, options) => {
      forked = { entryPath, args, options };
      return sentinel;
    },
    spawnOptions: { windowsHide: false, detached: true, stdio: 'ignore' },
  });
  check(returned, sentinel, 'default fork returns the exact child handle');
  check(forked.options.windowsHide, true, 'Windows child window is always hidden');
  check(forked.options.detached, false, 'shard child remains attached to parent IPC');
  check(forked.options.stdio, ['ignore', 'inherit', 'inherit', 'ipc'], 'IPC descriptor is mandatory');
  check(forked.options.env.SAFE_VALUE, 'yes', 'non-ownership environment survives');
  check(Object.hasOwn(forked.options.env, 'M59_PASSWORD'), false, 'password env is stripped');
  check(Object.hasOwn(forked.options.env, 'M59_STATE_FILE'), false, 'roster path env is stripped');
  check(Object.hasOwn(forked.options.env, 'M59_KEEPER_OWNERSHIP'), false,
    'old ownership capability env is stripped');
  check(forked.args.includes('password-alpha'), false, 'spawn arguments contain no credentials');
  assertions++;
  assert.throws(() => meridianShardInitPayload({
    shardId: 'shard-1',
    fleet: 'lab-sharded-test',
    stateFile: join(root, 'config-secret.json'),
    lockFile: join(root, 'config-secret.json.lock'),
    actorIds: ['alpha'],
    permit: { token: 'intentional-capability' },
    config: { password: 'must-never-cross' },
  }), error => error?.code === 'M59_SHARD_INIT_NOT_PUBLIC',
  'credential-shaped init config is rejected while the explicit permit remains allowed');

  const parentPid = 50001;
  const live = new Set([parentPid]);
  const entries = [
    entry('alpha', 'account-alpha', 'Alice', 'beta'),
    entry('beta', 'account-beta', 'Bob', 'alpha'),
    entry('gamma', 'account-gamma', 'Gina'),
  ];
  const assignments = partitionShardEntries(entries, 2);
  const owned = ownership('normal', entries, live, parentPid);
  const initPayloads = [];
  const spawnSpecs = [];
  let authorizationBarrierObserved = false;
  const spawned = fakeSpawner({
    live, parentPid, leaseDir: owned.leaseDir, fleetPath: owned.fleetPath,
    initPayloads, spawnSpecs, rosterEntries: entries,
    onVerify: ({ children }) => {
      const fleet = inspectFleetLock(owned.fleetPath, { isPidLive: pid => live.has(pid) });
      authorizationBarrierObserved = children.every(child => fleet.lock.guards.includes(child.pid));
      for (const value of entries) {
        const permit = owned.accountLeases.permitForAgent(value.id);
        const account = inspectFleetLock(permit.path, { isPidLive: pid => live.has(pid) });
        const child = children.find(candidate =>
          assignments.some(assignment => assignment.entries.includes(value) &&
            assignment.id === children.indexOf(candidate) + 1));
        authorizationBarrierObserved &&= Boolean(child && account.lock.guards.includes(child.pid));
      }
    },
  });
  const supervisor = new MeridianShardSupervisor(supervisorOptions({
    assignments,
    stateFile: join(root, 'normal.json'),
    owned,
    live,
    spawned,
    initConfig: { startupConcurrency: 2 },
  }));
  const started = await supervisor.start();
  check(started.ok, true, 'all shards initialize successfully');
  check(started.shards, 2, 'start summary counts shards');
  check(started.total, 3, 'start summary counts actors');
  check(authorizationBarrierObserved, true,
    'every fleet/account guard is installed before the first confidential init');
  check(initPayloads.length, 2, 'one private permit init is sent per initialized shard');
  check(spawnSpecs.every(spec => spec.windowsHide === true), true, 'every spawn spec requires windowsHide');
  check(spawnSpecs.every(spec => !Object.hasOwn(spec, 'entries')), true,
    'spawn specs expose actor ids but not credential entries');
  check(initPayloads.reduce((sum, payload) => sum + payload.actor_ids.length, 0), 3,
    'private init identifies only each locally reloaded roster subset');
  check(initPayloads.every(payload => !Object.hasOwn(payload, 'entries')), true,
    'account credentials never cross IPC, including private initialization');
  const initJson = JSON.stringify(initPayloads);
  check(entries.every(value => !initJson.includes(value.credentials.password)), true,
    'private initialization frames contain no roster passwords');
  const publicJson = JSON.stringify(supervisor.snapshot());
  for (const secret of ['password-alpha', 'password-beta', 'password-gamma', 'account-alpha']) {
    assertions++;
    assert.equal(publicJson.includes(secret), false, `aggregate snapshot omits ${secret}`);
  }

  spawned.reporters[0].publishState(assignments[0].actorIds[0], {
    schema: 'm59-primary-state/v1', actor_id: assignments[0].actorIds[0], in_game: true,
  });
  await turn();
  await turn();
  const aggregate = supervisor.snapshot();
  check(aggregate.actors.some(actor => actor.state?.in_game === true), true,
    'child state is visible through the aggregate snapshot');
  check(Boolean(supervisor.streamsFor(assignments[0].actorIds[0])), true,
    'aggregate routes per-actor streams to the owning controller');
  const stopped = await supervisor.stop('test complete');
  check(stopped.ok, true, 'graceful children are all confirmed dead');
  check(stopped.results.every(result => result.graceful), true, 'every child acknowledged stop');
  check(spawned.children.every(child => child.killCalls === 0), true,
    'gracefully exiting children are not force-terminated');
  check(spawned.children.every(child => child.disconnectCalls === 1), true,
    'graceful stop acknowledgements are followed by explicit IPC disconnect');
  check(owned.accountLeases.releaseAll().every(result => result.released), true,
    'account claims release only after confirmed child exits');
  check(owned.fleetClaim.release().released, true, 'fleet claim releases after confirmed child exits');

  // A useful partial shard stays running and the aggregate reports the exact failed
  // actor instead of laundering every assigned actor into the started count.
  const partialEntries = [
    entry('partial-one', 'account-partial-one', 'Partial One'),
    entry('partial-two', 'account-partial-two', 'Partial Two'),
  ];
  const partialAssignments = partitionShardEntries(partialEntries, 1);
  const partialLive = new Set([parentPid]);
  const partialOwned = ownership('partial', partialEntries, partialLive, parentPid);
  const partialSpawned = fakeSpawner({
    live: partialLive,
    parentPid,
    leaseDir: partialOwned.leaseDir,
    fleetPath: partialOwned.fleetPath,
    initPayloads: [],
    spawnSpecs: [],
    rosterEntries: partialEntries,
    firstPid: 51500,
    initResult: ({ spec }) => createShardInitResult({
      actorIds: spec.actorIds,
      startedActorIds: [spec.actorIds[0]],
      failures: [{
        id: spec.actorIds[1],
        code: 'M59_LOGIN_FAILED',
        message: 'password=must-not-cross-partial-result',
      }],
    }),
  });
  const partialOptions = supervisorOptions({
    assignments: partialAssignments,
    stateFile: join(root, 'partial.json'),
    owned: partialOwned,
    live: partialLive,
    spawned: partialSpawned,
    initConfig: { startupConcurrency: 2 },
  });
  delete partialOptions.initTimeoutMs;
  const partialSupervisor = new MeridianShardSupervisor(partialOptions);
  check(partialSupervisor.initTimeoutMs, deriveShardInitTimeoutMs({
    actorCounts: [2], startupConcurrency: 2,
  }), 'derived initialization deadline is propagated into the supervisor');
  const partialStarted = await partialSupervisor.start();
  check(partialStarted.ok, false, 'partial aggregate does not report full success');
  check([partialStarted.total, partialStarted.started, partialStarted.failed], [2, 1, 1],
    'partial aggregate preserves truthful startup counts');
  check(partialStarted.failures, [{
    id: 'partial-two', code: 'M59_LOGIN_FAILED', shard_id: 'shard-1',
  }], 'partial aggregate exposes only stable actor id and code');
  check(partialSupervisor.lifecycle, 'degraded', 'partial fleet lifecycle is degraded');
  check(partialSupervisor.stats.actors_started, 1, 'partial stats count the started actor');
  check(partialSupervisor.stats.actors_failed, 1, 'partial stats count the failed actor');
  check(partialSupervisor.snapshot().actors.map(actor => [actor.id, actor.status]), [
    ['partial-one', 'running'], ['partial-two', 'failed'],
  ], 'aggregate snapshot distinguishes running and failed actors');
  check(JSON.stringify(partialStarted).includes('must-not-cross-partial-result'), false,
    'partial startup result contains no arbitrary exception message');
  await partialSupervisor.stop('partial test complete');
  check(partialOwned.accountLeases.releaseAll().every(result => result.released), true,
    'partial actor claims release after confirmed child exit');
  check(partialOwned.fleetClaim.release().released, true,
    'partial fleet claim releases after confirmed child exit');

  // A child that ignores the graceful stop deadline is terminated through its exact
  // ChildProcess handle, never by a process-name or tree-wide command.
  const forceEntries = [entry('force', 'account-force', 'Force')];
  const forceLive = new Set([parentPid]);
  const forceOwned = ownership('force', forceEntries, forceLive, parentPid);
  const forceSpawned = fakeSpawner({
    live: forceLive, parentPid, leaseDir: forceOwned.leaseDir, fleetPath: forceOwned.fleetPath,
    initPayloads: [], spawnSpecs: [], rosterEntries: forceEntries,
    behavior: 'hang', firstPid: 52000,
  });
  const forceSupervisor = new MeridianShardSupervisor(supervisorOptions({
    assignments: partitionShardEntries(forceEntries, 1),
    stateFile: join(root, 'force.json'), owned: forceOwned, live: forceLive, spawned: forceSpawned,
  }));
  await forceSupervisor.start();
  const forced = await forceSupervisor.stop('force deadline');
  check(forced.ok, true, 'exact termination confirms an unresponsive child dead');
  check(forced.results[0].graceful, false, 'unresponsive child did not fake a graceful result');
  check(forced.results[0].terminated, true, 'supervisor invoked exact child termination');
  check(forceSpawned.children[0].killCalls, 1, 'only one exact kill is attempted');
  check(forceOwned.accountLeases.releaseAll()[0].released, true,
    'terminated child account guard is releasable');
  check(forceOwned.fleetClaim.release().released, true, 'terminated child fleet guard is releasable');

  // If exact termination cannot prove death, ownership remains guarded and release fails.
  const stuckEntries = [entry('stuck', 'account-stuck', 'Stuck')];
  const stuckLive = new Set([parentPid]);
  const stuckOwned = ownership('stuck', stuckEntries, stuckLive, parentPid);
  const stuckSpawned = fakeSpawner({
    live: stuckLive, parentPid, leaseDir: stuckOwned.leaseDir, fleetPath: stuckOwned.fleetPath,
    initPayloads: [], spawnSpecs: [], rosterEntries: stuckEntries,
    behavior: 'unkillable', firstPid: 53000,
  });
  const stuckSupervisor = new MeridianShardSupervisor(supervisorOptions({
    assignments: partitionShardEntries(stuckEntries, 1),
    stateFile: join(root, 'stuck.json'), owned: stuckOwned, live: stuckLive, spawned: stuckSpawned,
  }));
  await stuckSupervisor.start();
  const stuck = await stuckSupervisor.stop('cannot terminate');
  check(stuck.ok, false, 'uncertain/live child makes stop fail closed');
  check(stuck.all_children_confirmed_dead, false, 'stop explicitly reports unresolved child');
  check(stuckOwned.fleetClaim.release().reason, 'live-guard',
    'fleet claim cannot release around unresolved child guard');
  const stuckAccountPermit = stuckOwned.accountLeases.permitForAgent('stuck');
  check(inspectFleetLock(stuckAccountPermit.path, { isPidLive: pid => stuckLive.has(pid) })
    .lock.guards.includes(stuckSpawned.children[0].pid), true,
  'account claim retains unresolved child guard');
  stuckSpawned.children[0].finish(0, null);
  check(stuckOwned.accountLeases.releaseAll()[0].released, true, 'test cleanup releases dead child account');
  check(stuckOwned.fleetClaim.release().released, true, 'test cleanup releases dead child fleet');

  // Guard protocol failure happens after hello but before any private init frame.
  const deniedEntries = [entry('denied', 'account-denied', 'Denied')];
  const deniedLive = new Set([parentPid]);
  const deniedOwned = ownership('denied', deniedEntries, deniedLive, parentPid, {
    guardChildren: false,
  });
  const deniedInit = [];
  const deniedSpawned = fakeSpawner({
    live: deniedLive, parentPid, leaseDir: deniedOwned.leaseDir, fleetPath: deniedOwned.fleetPath,
    initPayloads: deniedInit, spawnSpecs: [], rosterEntries: deniedEntries, firstPid: 54000,
  });
  const deniedSupervisor = new MeridianShardSupervisor(supervisorOptions({
    assignments: partitionShardEntries(deniedEntries, 1),
    stateFile: join(root, 'denied.json'), owned: deniedOwned, live: deniedLive, spawned: deniedSpawned,
  }));
  assertions++;
  await assert.rejects(deniedSupervisor.start(), /startup failed during authorization/);
  check(deniedInit.length, 0, 'credentials never cross IPC when ownership authorization fails');
  check(inspectFleetLock(deniedOwned.fleetPath, { isPidLive: pid => deniedLive.has(pid) })
    .lock.guards.length, 0, 'failed authorization never commits a fleet guard');
  check(deniedOwned.accountLeases.releaseAll()[0].released, true, 'denied account remains releasable');
  check(deniedOwned.fleetClaim.release().released, true, 'denied fleet remains releasable');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`meridian shard supervisor: PASS (${assertions} assertions)`);
