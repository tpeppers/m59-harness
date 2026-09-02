#!/usr/bin/env node
// Real fork/IPC/guard lifecycle, entirely offline. No Meridian import and no sockets.
//
//   node tools/runtime/shards/shard-fork-integration-test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccountLeaseRegistry } from '../account-leases.mjs';
import { claimFleetLock, inspectFleetLock, isProcessLive } from '../fleet-lock.mjs';
import {
  MeridianShardSupervisor,
} from './meridian-supervisor.mjs';
import { partitionShardEntries } from './ownership.mjs';

const INIT_SCHEMA = 'm59-noop-shard-init/v1';
const fixture = fileURLToPath(new URL('./fixtures/noop-shard-child.mjs', import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'm59-shard-real-fork-'));
const stateFile = join(temporaryRoot, 'fleet-state-fork-test.json');
const fleetLockFile = `${stateFile}.lock`;
const leaseDir = join(temporaryRoot, 'account-leases');

const entries = [
  {
    id: 'fork-one',
    credentials: {
      account: 'fork-account-one', password: 'temporary-one', character: 'Fork One',
      host: '127.0.0.1', port: 15959, lab_runtime: true,
    },
    autopilot: { mode: 'survive', policy: {} },
  },
  {
    id: 'fork-two',
    credentials: {
      account: 'fork-account-two', password: 'temporary-two', character: 'Fork Two',
      host: '127.0.0.1', port: 15959, lab_runtime: true,
    },
    autopilot: { mode: 'survive', policy: {} },
  },
];

let tokenNumber = 0;
const tokenFactory = () => `fork-integration-token-${process.pid}-${++tokenNumber}`;
let fleetClaim = null;
let accountLeases = null;
let supervisor = null;
let released = false;

try {
  writeFileSync(stateFile, `${JSON.stringify({ entries }, null, 2)}\n`, {
    encoding: 'utf8', flag: 'wx',
  });
  fleetClaim = claimFleetLock(fleetLockFile, {
    pid: process.pid,
    token: tokenFactory(),
    tokenFactory,
    guards: [],
    isPidLive: isProcessLive,
  });
  assert.equal(fleetClaim.ok, true, 'temporary fleet claim is acquired');
  accountLeases = new AccountLeaseRegistry({
    leaseDir,
    pid: process.pid,
    tokenFactory,
    guardChildren: true,
    isPidLive: isProcessLive,
    legacyRosterRoots: [],
  });
  assert.equal(accountLeases.acquireAll(entries).ok, true, 'temporary account claims are acquired');

  supervisor = new MeridianShardSupervisor({
    assignments: partitionShardEntries(entries, 2),
    fleet: 'lab-fork-integration',
    stateFile,
    fleetClaim,
    accountLeases,
    childEntry: fixture,
    handshakeTimeoutMs: 10_000,
    initTimeoutMs: 10_000,
    stopTimeoutMs: 5_000,
    exitTimeoutMs: 5_000,
    terminateTimeoutMs: 5_000,
    initPayloadFactory({ shardId, stateFile: exactStateFile, lockFile, actorIds, permit }) {
      return {
        schema: INIT_SCHEMA,
        shard_id: shardId,
        state_file: exactStateFile,
        lock_file: lockFile,
        lease_dir: leaseDir,
        actor_ids: [...actorIds],
        permit,
      };
    },
  });

  const started = await supervisor.start();
  assert.equal(started.ok, true);
  assert.equal(started.shards, 2);
  assert.equal(supervisor.records.length, 2);
  assert.equal(supervisor.records.every(record => record.pid !== process.pid), true);
  assert.equal(supervisor.records.every(record => isProcessLive(record.pid)), true,
    'both real child processes are live after initialization');

  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.actors.length, 2);
  assert.equal(snapshot.actors.every(actor => actor.state?.ready === true), true,
    'synthetic state crossed the real IPC channels');
  assert.equal(snapshot.actors.every(actor => actor.state?.process_id !== process.pid), true);

  const heldFleet = inspectFleetLock(fleetLockFile, { isPidLive: isProcessLive });
  const childPids = supervisor.records.map(record => record.pid).sort((a, b) => a - b);
  assert.deepEqual([...heldFleet.lock.guards].sort((a, b) => a - b), childPids,
    'fleet claim guards both exact child pids');
  for (const entry of entries) {
    const permit = accountLeases.permitForAgent(entry.id);
    const held = inspectFleetLock(permit.path, { isPidLive: isProcessLive });
    const owner = supervisor.records.find(record => record.assignment.actorIds.includes(entry.id));
    assert.equal(held.lock.guards.includes(owner.pid), true,
      `account claim guards the child assigned ${entry.id}`);
  }

  const stopped = await supervisor.stop('real fork integration complete');
  assert.equal(stopped.ok, true);
  assert.equal(stopped.all_children_confirmed_dead, true);
  assert.equal(stopped.results.length, 2);
  assert.equal(stopped.results.every(result => result.graceful && result.confirmed_dead), true);
  assert.equal(stopped.results.every(result => result.terminated === false), true,
    'graceful children need no forced termination');
  assert.equal(supervisor.records.every(record => record.didExit), true);
  assert.equal(supervisor.records.every(record => record.exit?.code === 0), true,
    'acknowledged stop followed by intentional IPC disconnect exits every child cleanly');
  assert.equal(supervisor.records.every(record => record.child.connected === false), true,
    'the supervisor disconnects every private IPC channel');
  assert.equal(supervisor.records.every(record => !isProcessLive(record.pid)), true,
    'every exact child pid has exited');

  const accountReleases = accountLeases.releaseAll();
  assert.equal(accountReleases.length, 2);
  assert.equal(accountReleases.every(result => result.released), true,
    'account claims release only after child exit');
  assert.equal(fleetClaim.release().released, true,
    'fleet claim releases only after child exit');
  released = true;
} finally {
  if (supervisor && !supervisor.allChildrenConfirmedDead) {
    try { await supervisor.stop('fork integration cleanup'); } catch {}
  }
  if (!released) {
    try { accountLeases?.releaseAll(); } catch {}
    try { fleetClaim?.release(); } catch {}
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('real shard fork integration: PASS');
