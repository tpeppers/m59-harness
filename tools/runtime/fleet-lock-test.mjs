#!/usr/bin/env node
// Offline lock tests. Every path is under a fresh OS temp directory; no broker, fleet,
// substrate, or existing runtime lock is inspected or changed.

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  BROKER_FLEET_LOCK_KIND,
  FLEET_LOCK_KIND,
  addFleetLockGuard,
  claimFleetLock,
  finalizeFleetLockAdoption,
  inspectFleetLock,
  isProcessLive,
  releaseFleetLock,
  verifyFleetLockGuard,
} from './fleet-lock.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'm59-fleet-lock-test-'));
const resolvedScratch = resolve(scratch);
const resolvedTemp = resolve(tmpdir());
if (!resolvedScratch.startsWith(resolvedTemp + sep))
  throw new Error(`refusing unsafe test directory ${resolvedScratch}`);

const file = name => join(resolvedScratch, name);
const record = (pid, token, overrides = {}) => ({
  pid, at: 1234, kind: FLEET_LOCK_KIND, token, ...overrides,
});
const writeRecord = (path, value) => writeFileSync(path, JSON.stringify(value), 'utf8');

try {
  // Windows reports EPERM for an existing process the caller cannot signal. Only ESRCH is
  // evidence that the pid is absent.
  {
    const error = code => Object.assign(new Error(code), { code });
    assert.equal(isProcessLive(10, { kill() {} }), true);
    assert.equal(isProcessLive(10, { kill() { throw error('EPERM'); } }), true);
    assert.equal(isProcessLive(10, { kill() { throw error('ESRCH'); } }), false);
    assert.equal(isProcessLive(10, { kill() { throw error('EACCES'); } }), true);
    assert.equal(isProcessLive(0, { kill() { throw new Error('must not run'); } }), false);
  }

  // Inspection is scoped to one exact absolute path and does not derive or search for
  // related locks. A sibling sentinel survives the complete claim/release lifecycle.
  {
    const path = file('exact.lock');
    const sibling = file('exact.lock.sibling');
    writeFileSync(sibling, 'do not touch', 'utf8');
    assert.throws(() => inspectFleetLock('relative.lock'), /absolute/);
    assert.deepEqual(inspectFleetLock(path, { isPidLive: () => false }), {
      state: 'free', path: resolve(path),
    });
    const livePids = new Set([101]);
    const claim = claimFleetLock(path, {
      pid: 101, token: 'owner-token-101', now: () => 9001,
      isPidLive: pid => livePids.has(pid),
    });
    assert.equal(claim.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      pid: 101, at: 9001, kind: 'lab-runtime', token: 'owner-token-101',
    });
    const found = inspectFleetLock(path, { isPidLive: pid => livePids.has(pid) });
    assert.equal(found.state, 'live');
    assert.equal(found.lock.pid, 101);

    const contender = claimFleetLock(path, {
      pid: 202, token: 'owner-token-202', isPidLive: pid => livePids.has(pid),
    });
    assert.equal(contender.ok, false);
    assert.equal(contender.found.state, 'live');
    assert.equal(releaseFleetLock(path, { pid: 101, token: 'wrong-token-101' }).released, false);
    assert.equal(claim.release().released, true);
    assert.deepEqual(claim.release(), { released: false, path: resolve(path), reason: 'free' });
    assert.equal(readFileSync(sibling, 'utf8'), 'do not touch');
  }

  // A valid dead claim is stale. Reclaim rechecks that pid after atomically moving the
  // exact file, then installs the new claim with an exclusive create.
  {
    const path = file('stale.lock');
    writeRecord(path, record(303, 'dead-token-303'));
    let deadChecks = 0;
    const livePids = new Set([404]);
    const isPidLive = pid => {
      if (pid === 303) deadChecks++;
      return livePids.has(pid);
    };
    const stale = inspectFleetLock(path, { isPidLive });
    assert.equal(stale.state, 'stale');
    assert.equal(stale.confirmed_dead, true);
    const claimed = claimFleetLock(path, {
      pid: 404, token: 'new-owner-token-404', now: () => 9002, isPidLive,
    });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.took_over_from.state, 'stale');
    assert.ok(deadChecks >= 3, `dead pid was checked only ${deadChecks} time(s)`);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 404);
    assert.equal(claimed.release().released, true);
  }

  // Broker and lab owners use the same namespace and protocol. A live claim of either kind
  // excludes the other; an old `{pid,at}` broker claim is recognized for safe migration.
  {
    const path = file('cross-runtime.lock');
    const livePids = new Set([451]);
    const broker = claimFleetLock(path, {
      pid: 451, token: 'broker-owner-token-451', kind: BROKER_FLEET_LOCK_KIND,
      guards: [],
      isPidLive: pid => livePids.has(pid),
    });
    assert.equal(broker.ok, true);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).kind, 'broker-runtime');
    const lab = claimFleetLock(path, {
      pid: 452, token: 'lab-owner-token-452', kind: FLEET_LOCK_KIND,
      isPidLive: pid => livePids.has(pid),
    });
    assert.equal(lab.ok, false);
    assert.equal(lab.found.lock.kind, 'broker-runtime');
    assert.equal(broker.release().released, true);

    writeRecord(path, { pid: 453, at: 1234 });
    const oldLive = inspectFleetLock(path, { isPidLive: pid => pid === 453 });
    assert.equal(oldLive.state, 'live');
    assert.equal(oldLive.lock.legacy, true);
    const oldDead = inspectFleetLock(path, { isPidLive: () => false });
    assert.equal(oldDead.state, 'stale');
    const refusedMigration = claimFleetLock(path, {
      pid: 454, token: 'migrated-token-454', kind: BROKER_FLEET_LOCK_KIND,
      isPidLive: () => false,
    });
    assert.equal(refusedMigration.ok, false);
    assert.equal(refusedMigration.found.unguarded_broker, true);
    assert.match(refusedMigration.found.why, /orphan sockets/);
    const migrated = claimFleetLock(path, {
      pid: 454, token: 'migrated-token-454', kind: BROKER_FLEET_LOCK_KIND,
      guards: [], isPidLive: () => false, allowUnguardedBrokerTakeover: true,
    });
    assert.equal(migrated.ok, true);
    assert.equal(migrated.took_over_from.lock.legacy, true);
    assert.equal(migrated.release().released, true);
  }

  // Account claims bind a keeper guard to an opaque subject in addition to the lock
  // pathname and owner token. Supplying that requirement must accept only the exact
  // subject: a different subject, or an older claim with no subject at all, fails closed.
  {
    const path = file('subject-guard.lock');
    const subjectlessPath = file('subjectless-guard.lock');
    const livePids = new Set([460, 461, 462, 463]);
    const subjectClaim = claimFleetLock(path, {
      pid: 460,
      token: 'subject-owner-token-460',
      kind: BROKER_FLEET_LOCK_KIND,
      guards: [461],
      subject: 'opaque-account-subject-460',
      isPidLive: pid => livePids.has(pid),
    });
    assert.equal(subjectClaim.ok, true);
    assert.equal(verifyFleetLockGuard(path, {
      pid: 460,
      token: 'subject-owner-token-460',
      kind: BROKER_FLEET_LOCK_KIND,
      subject: 'opaque-account-subject-460',
      guardPid: 461,
      isPidLive: pid => livePids.has(pid),
    }).ok, true);
    assert.equal(verifyFleetLockGuard(path, {
      pid: 460,
      token: 'subject-owner-token-460',
      kind: BROKER_FLEET_LOCK_KIND,
      subject: 'different-account-subject-460',
      guardPid: 461,
      isPidLive: pid => livePids.has(pid),
    }).ok, false);

    const subjectlessClaim = claimFleetLock(subjectlessPath, {
      pid: 462,
      token: 'subjectless-owner-token-462',
      kind: BROKER_FLEET_LOCK_KIND,
      guards: [463],
      isPidLive: pid => livePids.has(pid),
    });
    assert.equal(subjectlessClaim.ok, true);
    assert.equal(verifyFleetLockGuard(subjectlessPath, {
      pid: 462,
      token: 'subjectless-owner-token-462',
      kind: BROKER_FLEET_LOCK_KIND,
      subject: 'required-account-subject-462',
      guardPid: 463,
      isPidLive: pid => livePids.has(pid),
    }).ok, false);

    livePids.delete(461);
    livePids.delete(463);
    assert.equal(subjectClaim.release().released, true);
    assert.equal(subjectlessClaim.release().released, true);
  }

  // A broker installs each keeper pid into its token claim before that child may log in.
  // When the broker dies but its child survives, the record remains live/non-reclaimable;
  // even the token owner cannot release it until every guard is positively dead.
  {
    const path = file('keeper-guard.lock');
    const livePids = new Set([470]);
    const broker = claimFleetLock(path, {
      pid: 470, token: 'guarded-owner-token-470', kind: BROKER_FLEET_LOCK_KIND,
      guards: [], isPidLive: pid => livePids.has(pid),
    });
    assert.equal(broker.ok, true);
    assert.equal(addFleetLockGuard(path, {
      pid: 470, token: 'wrong-owner-token-470', kind: BROKER_FLEET_LOCK_KIND,
      guardPid: 471,
    }).ok, false);
    assert.equal(addFleetLockGuard(path, {
      pid: 470, token: 'guarded-owner-token-470', kind: BROKER_FLEET_LOCK_KIND,
      guardPid: 471,
    }).ok, true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).guards, [471]);
    assert.equal(verifyFleetLockGuard(path, {
      pid: 470, token: 'guarded-owner-token-470', kind: BROKER_FLEET_LOCK_KIND,
      guardPid: 471, isPidLive: pid => livePids.has(pid),
    }).ok, true);

    livePids.delete(470);
    livePids.add(471);
    const orphaned = inspectFleetLock(path, { isPidLive: pid => livePids.has(pid) });
    assert.equal(orphaned.state, 'live');
    assert.equal(orphaned.owner_dead, true);
    assert.equal(orphaned.guard_pid, 471);
    const contender = claimFleetLock(path, {
      pid: 472, token: 'guard-contender-token-472', kind: FLEET_LOCK_KIND,
      isPidLive: pid => livePids.has(pid),
    });
    assert.equal(contender.ok, false);
    assert.equal(contender.found.guard_pid, 471);
    assert.equal(broker.release().released, false);
    assert.equal(broker.release().reason, 'live-guard');

    // Only a broker on this exact lock path may transfer the dead owner's record. The
    // guarded child set survives the transfer, so account-level adoption can be scoped to
    // precisely this predecessor and these keepers.
    livePids.add(472);
    const adopted = claimFleetLock(path, {
      pid: 472, token: 'guard-adopter-token-472', kind: BROKER_FLEET_LOCK_KIND,
      guards: [], adoptGuardedBroker: true,
      isPidLive: pid => livePids.has(pid),
    });
    assert.equal(adopted.ok, true);
    assert.equal(adopted.adopted_guarded, true);
    assert.equal(adopted.took_over_from.lock.pid, 470);
    assert.deepEqual(adopted.lock.guards, [471]);
    assert.deepEqual(adopted.lock.predecessors, [470]);
    assert.equal(broker.release().reason, 'ownership-mismatch');
    assert.equal(adopted.release().reason, 'live-guard');

    // If this successor dies during account adoption, the next exact-roster broker keeps
    // enough bounded lineage to finish claims still split across either predecessor.
    livePids.delete(472);
    livePids.add(473);
    const recovered = claimFleetLock(path, {
      pid: 473, token: 'guard-recovery-token-473', kind: BROKER_FLEET_LOCK_KIND,
      guards: [], adoptGuardedBroker: true,
      isPidLive: pid => livePids.has(pid),
    });
    assert.equal(recovered.ok, true);
    assert.deepEqual(recovered.lock.predecessors, [472, 470]);
    assert.equal(finalizeFleetLockAdoption(path, {
      pid: 473, token: 'wrong-recovery-token-473', kind: BROKER_FLEET_LOCK_KIND,
    }).reason, 'ownership-mismatch');
    assert.equal(finalizeFleetLockAdoption(path, {
      pid: 473, token: 'guard-recovery-token-473', kind: BROKER_FLEET_LOCK_KIND,
    }).ok, true);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(path, 'utf8')), 'predecessors'), false);

    livePids.delete(471);
    assert.equal(recovered.release().released, true);
  }

  // Restart guards are bounded: positively dead children are pruned, while live or
  // uncertain children remain. An initial record that could not be inspected under the
  // 4096-byte reader bound is rejected rather than writing an instantly bricked lock.
  {
    const path = file('guard-pruning.lock');
    const livePids = new Set([480, 482, 483]);
    const broker = claimFleetLock(path, {
      pid: 480, token: 'pruning-owner-token-480', kind: BROKER_FLEET_LOCK_KIND,
      guards: [481, 482], isPidLive: pid => livePids.has(pid),
    });
    assert.equal(broker.ok, true);
    assert.equal(addFleetLockGuard(path, {
      pid: 480, token: 'pruning-owner-token-480', kind: BROKER_FLEET_LOCK_KIND,
      guardPid: 483, isPidLive: pid => livePids.has(pid),
    }).ok, true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).guards, [482, 483]);
    livePids.delete(482);
    livePids.delete(483);
    assert.equal(broker.release().released, true);

    assert.throws(() => claimFleetLock(file('oversized-guards.lock'), {
      pid: 484, token: 'oversized-owner-token-484', kind: BROKER_FLEET_LOCK_KIND,
      guards: Array.from({ length: 700 }, (_, index) => 1_000_000 + index),
      isPidLive: () => false,
    }), /4096 bytes/);
  }

  // Guarded transfer is serialized by its own exclusive token claim. A second adopter
  // cannot rewrite the main record while the winner holds that gate; after release, the
  // exact broker successor can complete the transfer without making the main path free.
  {
    const path = file('adoption-race.lock');
    writeRecord(path, {
      pid: 490, at: 1234, kind: BROKER_FLEET_LOCK_KIND,
      token: 'old-adoption-owner-490', guards: [491],
    });
    const livePids = new Set([491, 492, 493]);
    const gate = claimFleetLock(`${path}.adopt.lock`, {
      pid: 492, token: 'adoption-gate-token-492', kind: FLEET_LOCK_KIND,
      isPidLive: pid => livePids.has(pid),
    });
    assert.equal(gate.ok, true);
    const blocked = claimFleetLock(path, {
      pid: 493, token: 'blocked-adopter-token-493', kind: BROKER_FLEET_LOCK_KIND,
      guards: [], adoptGuardedBroker: true,
      isPidLive: pid => livePids.has(pid),
    });
    assert.equal(blocked.ok, false);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 490,
      'losing adopter must leave the main guarded claim untouched');
    assert.equal(gate.release().released, true);
    const winner = claimFleetLock(path, {
      pid: 493, token: 'winning-adopter-token-493', kind: BROKER_FLEET_LOCK_KIND,
      guards: [], adoptGuardedBroker: true,
      isPidLive: pid => livePids.has(pid),
    });
    assert.equal(winner.ok, true);
    assert.equal(winner.adopted_guarded, true);
    livePids.delete(491);
    assert.equal(winner.release().released, true);
  }

  // No pid guess means no deletion. Malformed, foreign-kind, and uncertain-liveness files
  // are protected as live/unverifiable, and their bytes remain untouched.
  {
    const malformedPath = file('malformed.lock');
    writeFileSync(malformedPath, 'not json {{{', 'utf8');
    const malformed = inspectFleetLock(malformedPath, { isPidLive: () => false });
    assert.equal(malformed.state, 'live');
    assert.equal(malformed.unverifiable, true);
    assert.equal(claimFleetLock(malformedPath, {
      pid: 501, token: 'owner-token-501', isPidLive: () => false,
    }).ok, false);
    assert.equal(readFileSync(malformedPath, 'utf8'), 'not json {{{');

    const foreignPath = file('foreign.lock');
    const foreign = record(502, 'foreign-token-502', { kind: 'some-other-runtime' });
    writeRecord(foreignPath, foreign);
    assert.equal(inspectFleetLock(foreignPath, { isPidLive: () => false }).unverifiable, true);
    assert.equal(claimFleetLock(foreignPath, {
      pid: 503, token: 'owner-token-503', isPidLive: () => false,
    }).ok, false);
    assert.deepEqual(JSON.parse(readFileSync(foreignPath, 'utf8')), foreign);

    const uncertainPath = file('uncertain.lock');
    writeRecord(uncertainPath, record(504, 'uncertain-token-504'));
    const uncertain = inspectFleetLock(uncertainPath, { isPidLive: () => undefined });
    assert.equal(uncertain.state, 'live');
    assert.equal(uncertain.unverifiable, true);
    assert.equal(claimFleetLock(uncertainPath, {
      pid: 505, token: 'owner-token-505', isPidLive: () => undefined,
    }).ok, false);
    assert.equal(JSON.parse(readFileSync(uncertainPath, 'utf8')).pid, 504);
  }

  // A pathname occupied by something other than a regular file is never followed or
  // deleted. This also covers a caller accidentally passing the lab directory itself.
  {
    const directoryPath = file('not-a-lock');
    mkdirSync(directoryPath);
    const found = inspectFleetLock(directoryPath, { isPidLive: () => false });
    assert.equal(found.state, 'live');
    assert.equal(found.unverifiable, true);
    assert.match(found.why, /not a regular file/);
  }

  // Release re-reads ownership and therefore cannot remove a successor's record, even when
  // the old holder calls its captured release function during shutdown.
  {
    const path = file('ownership.lock');
    const first = claimFleetLock(path, {
      pid: 601, token: 'first-owner-token-601', isPidLive: pid => pid === 601,
    });
    assert.equal(first.ok, true);
    const successor = record(602, 'successor-token-602');
    writeRecord(path, successor);
    const oldRelease = first.release();
    assert.equal(oldRelease.released, false);
    assert.equal(oldRelease.reason, 'ownership-mismatch');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), successor);
    assert.equal(releaseFleetLock(path, {
      pid: 602, token: 'successor-token-602',
    }).released, true);
  }

  console.log('runtime fleet lock: PASS');
} finally {
  rmSync(resolvedScratch, { recursive: true, force: true });
}
