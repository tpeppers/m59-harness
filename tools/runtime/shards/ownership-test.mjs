#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountLeaseRegistry } from '../account-leases.mjs';
import { claimFleetLock, inspectFleetLock } from '../fleet-lock.mjs';
import {
  authorizeShard,
  partitionShardEntries,
  verifyShardPermit,
} from './ownership.mjs';

const root = mkdtempSync(join(tmpdir(), 'm59-shard-ownership-'));
let assertions = 0;
const check = (actual, expected, message) => {
  assertions++;
  assert.deepEqual(actual, expected, message);
};

function entry(id, account, character, partner = null) {
  return {
    id,
    credentials: {
      account,
      password: `secret-${id}`,
      character,
      host: '127.0.0.1',
      port: 15959,
      lab_runtime: true,
    },
    autopilot: { mode: 'survive', policy: partner ? { partner } : {} },
  };
}

try {
  const entries = [
    entry('alpha', 'account-alpha', 'Alice', 'beta'),
    entry('beta', 'account-beta', 'Bob', 'alpha'),
    entry('gamma', 'account-gamma', 'Gina'),
    entry('delta', 'account-delta', 'Dan'),
  ];
  const shards = partitionShardEntries(entries, 3);
  check(shards.length, 3, 'requested non-empty shard count is preserved');
  const alphaShard = shards.find(shard => shard.actorIds.includes('alpha'));
  check(alphaShard.actorIds.includes('beta'), true, 'configured partner pair is co-located');
  check(shards.map(shard => shard.entries.length).sort(), [1, 1, 2],
    'independent groups are load-balanced');
  check(partitionShardEntries(entries, 3).map(shard => shard.actorIds),
    shards.map(shard => shard.actorIds), 'partitioning is deterministic');
  assertions++;
  assert.throws(() => partitionShardEntries(entries, 4), /independent actor\/partner groups/,
    'partner groups are never split merely to create an empty/extra shard');

  const parentPid = 41001;
  const childPid = 41002;
  const live = new Set([parentPid, childPid]);
  const isPidLive = pid => live.has(pid);
  let token = 0;
  const tokenFactory = () => `shard-test-token-${++token}`;
  const fleetPath = join(root, 'fleet.json.lock');
  const fleetClaim = claimFleetLock(fleetPath, {
    pid: parentPid,
    token: tokenFactory(),
    guards: [],
    isPidLive,
    tokenFactory,
  });
  check(fleetClaim.ok, true, 'parent holds guard-capable fleet claim');
  const leases = new AccountLeaseRegistry({
    leaseDir: join(root, 'leases'),
    pid: parentPid,
    guardChildren: true,
    isPidLive,
    tokenFactory,
    legacyRosterRoots: [],
  });
  check(leases.acquireAll(entries).ok, true, 'parent holds all account claims before shards');

  const assigned = alphaShard.entries;
  const authorized = authorizeShard({
    shardId: alphaShard.id,
    stateFile: join(root, 'fleet.json'),
    entries: assigned,
    childPid,
    fleetClaim,
    accountLeases: leases,
    isPidLive,
  });
  check(authorized.ok, true, 'live child is authorized after exact claims are held');
  const encoded = JSON.stringify(authorized.permit);
  for (const forbidden of ['secret-alpha', 'secret-beta', 'account-alpha', 'Alice', 'Bob']) {
    assertions++;
    assert.equal(encoded.includes(forbidden), false, `permit does not disclose ${forbidden}`);
  }
  const fleetAfter = inspectFleetLock(fleetPath, { isPidLive });
  check(fleetAfter.lock.guards.includes(childPid), true, 'fleet guard is the authorization commit');
  for (const actor of assigned.map(value => value.id)) {
    const permit = leases.permitForAgent(actor);
    const found = inspectFleetLock(permit.path, { isPidLive });
    check(found.lock.guards.includes(childPid), true, `assigned account ${actor} names shard guard`);
  }
  const unassigned = entries.find(value => !assigned.includes(value));
  const untouched = inspectFleetLock(leases.permitForAgent(unassigned.id).path, { isPidLive });
  check(untouched.lock.guards.includes(childPid), false, 'unassigned account does not name shard guard');

  const verified = verifyShardPermit({
    permit: authorized.permit,
    entries: assigned,
    childPid,
    expectedStateFile: join(root, 'fleet.json'),
    expectedLockFile: fleetPath,
    leaseDir: join(root, 'leases'),
    isPidLive,
  });
  check(verified.ok, true, 'child verifies every assigned account and fleet guard');
  check(verified.actorIds, assigned.map(value => value.id), 'verified actor order is exact');
  check(verifyShardPermit({
    permit: authorized.permit, entries: assigned, childPid: childPid + 1,
    leaseDir: join(root, 'leases'), isPidLive,
  }).reason, 'guard-pid-mismatch', 'a permit cannot authorize another child pid');

  const changedCharacter = assigned.map(value => value.id === 'alpha'
    ? { ...value, credentials: { ...value.credentials, character: 'Mallory' } } : value);
  check(verifyShardPermit({
    permit: authorized.permit, entries: changedCharacter, childPid,
    leaseDir: join(root, 'leases'), isPidLive,
  }).reason, 'account-identity-mismatch', 'character edits cannot adopt a guarded child');
  const changedAccount = assigned.map(value => value.id === 'alpha'
    ? { ...value, credentials: { ...value.credentials, account: 'different-account' } } : value);
  check(verifyShardPermit({
    permit: authorized.permit, entries: changedAccount, childPid,
    leaseDir: join(root, 'leases'), isPidLive,
  }).reason, 'account-identity-mismatch', 'account edits cannot reuse another claim');
  live.delete(parentPid);
  check(verifyShardPermit({
    permit: authorized.permit, entries: assigned, childPid,
    leaseDir: join(root, 'leases'), isPidLive,
  }).reason, 'parent-not-live', 'child refuses startup if parent died during authorization');
  live.add(parentPid);

  check(fleetClaim.release().reason, 'live-guard', 'parent cannot release while a shard may own sockets');
  live.delete(childPid);
  check(leases.releaseAll().every(result => result.released), true,
    'dead shard guards permit orderly account release');
  check(fleetClaim.release().released, true, 'dead shard guard permits fleet release');

  // A non-guard-capable account registry creates only partial account writes. The fleet
  // guard is never committed, so a waiting child cannot pass the full verifier.
  const child2 = 42002;
  live.add(parentPid);
  live.add(child2);
  const fleetPath2 = join(root, 'partial.json.lock');
  const fleetClaim2 = claimFleetLock(fleetPath2, {
    pid: parentPid, token: tokenFactory(), guards: [], isPidLive, tokenFactory,
  });
  const unguardedLeases = new AccountLeaseRegistry({
    leaseDir: join(root, 'unguarded-leases'),
    pid: parentPid,
    isPidLive,
    tokenFactory,
    legacyRosterRoots: [],
  });
  check(unguardedLeases.acquireAll([entries[2]]).ok, true, 'ordinary lab account claim is acquired');
  const partial = authorizeShard({
    shardId: 1,
    stateFile: join(root, 'partial.json'),
    entries: [entries[2]],
    childPid: child2,
    fleetClaim: fleetClaim2,
    accountLeases: unguardedLeases,
    isPidLive,
  });
  check(partial.reason, 'account-claim-not-held',
    'authorization preflight rejects an account claim without guard protocol');
  check(inspectFleetLock(fleetPath2, { isPidLive }).lock.guards.includes(child2), false,
    'partial failure never writes the fleet commit guard');
  live.delete(child2);
  check(unguardedLeases.releaseAll()[0].released, true, 'failed child leaves reclaimable dead state');
  check(fleetClaim2.release().released, true, 'uncommitted fleet claim releases normally');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`shard ownership: PASS (${assertions} assertions)`);
