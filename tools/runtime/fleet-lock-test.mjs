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

  // ============================================================================
  // A LIVE GUARD PID IS NOT A LIVE KEEPER.
  // ============================================================================
  //
  // The incident this pins, twice over: a broker died holding a lock whose guard pid had
  // since been handed to an unrelated program — a desktop chat application on 2026-09-08,
  // McAfee's browserhost.exe on 2026-09-10. `inspectFleetLock` reported `live` on the
  // strength of `kill(pid, 0)` and went on doing so for as long as that program ran, which
  // left deleting a lock as the only recovery and this repository forbids that.
  {
    const ours = (pid, started, image) => ({
      isPidLive: p => p === pid,
      startTimes: pids => new Map(pids.map(p => [p, p === pid ? started : null])),
      imageName: p => (p === pid ? image : null),
    });

    // 1. THE INCIDENT. Owner dead, guard alive, guard is not node.
    {
      const path = file('recycled-guard.lock');
      writeRecord(path, record(900, 'owner-token-900-aaaa', {
        kind: BROKER_FLEET_LOCK_KIND, guards: [28016],
      }));
      const found = inspectFleetLock(path, ours(28016, null, 'browserhost.exe'));
      assert.equal(found.state, 'stale');
      assert.equal(found.reclaimable, true);
      assert.equal(found.recycled_guards.length, 1);
      assert.equal(found.recycled_guards[0].pid, 28016);
      assert.match(found.why, /browserhost\.exe/);
    }

    // 2. A RECYCLED *NODE* PID, which the image check cannot see and the start time can.
    {
      const path = file('recycled-node-guard.lock');
      writeRecord(path, record(901, 'owner-token-901-aaaa', {
        kind: BROKER_FLEET_LOCK_KIND, guards: [5150], guard_started: { 5150: 1_700_000_000_000 },
      }));
      const found = inspectFleetLock(path, ours(5150, 1_700_000_600_000, 'node.exe'));
      assert.equal(found.state, 'stale', 'a node pid that started later is not the guard');
      assert.match(found.why, /the guard was registered at/);
    }

    // 3. THE SAME PROCESS STILL HOLDS IT. This is the direction that must never regress.
    {
      const path = file('surviving-guard.lock');
      writeRecord(path, record(902, 'owner-token-902-aaaa', {
        kind: BROKER_FLEET_LOCK_KIND, guards: [5151], guard_started: { 5151: 1_700_000_000_000 },
      }));
      const found = inspectFleetLock(path, ours(5151, 1_700_000_000_000, 'node.exe'));
      assert.equal(found.state, 'live');
      assert.equal(found.guard_pid, 5151);
      assert.equal(found.owner_dead, true);
    }

    // 4. UNREADABLE IDENTITY FAILS CLOSED, exactly as it did before this existed.
    {
      const path = file('unknown-guard.lock');
      writeRecord(path, record(903, 'owner-token-903-aaaa', {
        kind: BROKER_FLEET_LOCK_KIND, guards: [5152],
      }));
      assert.equal(inspectFleetLock(path, ours(5152, null, null)).state, 'live');
    }

    // 5. A LOCK WRITTEN BEFORE THIS FIELD EXISTED behaves as it always did when its guard
    //    is a live node process. Old and new brokers share these files.
    {
      const path = file('legacy-guard.lock');
      writeRecord(path, record(904, 'owner-token-904-aaaa', {
        kind: BROKER_FLEET_LOCK_KIND, guards: [5153],
      }));
      assert.equal(inspectFleetLock(path, ours(5153, null, 'node.exe')).state, 'live');
    }

    // 6. A DEAD GUARD IS STILL JUST DEAD, and says nothing about identity.
    {
      const path = file('dead-guard.lock');
      writeRecord(path, record(905, 'owner-token-905-aaaa', {
        kind: BROKER_FLEET_LOCK_KIND, guards: [5154], guard_started: { 5154: 1_700_000_000_000 },
      }));
      const found = inspectFleetLock(path, {
        isPidLive: () => false,
        startTimes: pids => new Map(pids.map(p => [p, null])),
        imageName: () => null,
      });
      assert.equal(found.state, 'stale');
      assert.equal(found.recycled_guards, undefined, 'nothing was judged recycled');
    }

    // 7. REGISTRATION RECORDS THE IDENTITY, because that is the only moment it is knowable.
    {
      const path = file('guard-registration.lock');
      const claim = claimFleetLock(path, {
        pid: 906, token: 'owner-token-906-aaaa', kind: BROKER_FLEET_LOCK_KIND,
        guards: [], isPidLive: pid => pid === 906,
      });
      assert.equal(claim.ok, true);
      const added = addFleetLockGuard(path, {
        pid: 906, token: 'owner-token-906-aaaa', kind: BROKER_FLEET_LOCK_KIND,
        guardPid: 7001, isPidLive: pid => pid === 906 || pid === 7001,
        startTimes: pids => new Map(pids.map(p => [p, p === 7001 ? 1_700_000_111_000 : null])),
      });
      assert.equal(added.ok, true);
      const onDisk = JSON.parse(readFileSync(path, 'utf8'));
      assert.deepEqual(onDisk.guards, [7001]);
      assert.deepEqual(onDisk.guard_started, { 7001: 1_700_000_111_000 });
    }

    // 7b. A CALLER THAT ALREADY KNOWS IS NOT MADE TO SHELL OUT FOR IT.
    //
    // `startTimes` is a synchronous PowerShell spawn — 492ms idle on the prod machine, and the
    // broker's stall profiler caught it at 3.2 to 9.2 SECONDS under load, once per keeper, on
    // the event loop that keepers need to answer readiness. A parent holding a live child's
    // handle cannot have that pid recycled underneath it, which is the only thing this field
    // detects, so the broker passes the moment it spawned. The OS path must remain for every
    // caller that did NOT create the process.
    {
      const path = file('guard-known-start.lock');
      assert.equal(claimFleetLock(path, {
        pid: 916, token: 'owner-token-916-aaaa', kind: BROKER_FLEET_LOCK_KIND,
        guards: [], isPidLive: pid => pid === 916,
      }).ok, true);
      let asked = 0;
      const added = addFleetLockGuard(path, {
        pid: 916, token: 'owner-token-916-aaaa', kind: BROKER_FLEET_LOCK_KIND,
        guardPid: 7011, guardStartedAt: 1_700_000_222_000,
        isPidLive: pid => pid === 916 || pid === 7011,
        startTimes: pids => { asked++; return new Map(pids.map(p => [p, 1_700_000_999_000])); },
      });
      assert.equal(added.ok, true);
      assert.equal(asked, 0, 'a supplied start time must not spawn anything');
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).guard_started,
                       { 7011: 1_700_000_222_000 }, 'and it is what gets written');

      // ABSENT, ZERO AND NONSENSE ALL FALL BACK. A caller that cannot say must not be able to
      // write a zero into the field and have it read as "registered at the epoch".
      for (const bogus of [null, 0, -1, 1.5, NaN, '1700000222000']) {
        const p2 = file(`guard-fallback-${String(bogus)}.lock`);
        assert.equal(claimFleetLock(p2, {
          pid: 917, token: 'owner-token-917-aaaa', kind: BROKER_FLEET_LOCK_KIND,
          guards: [], isPidLive: pid => pid === 917,
        }).ok, true);
        let used = 0;
        assert.equal(addFleetLockGuard(p2, {
          pid: 917, token: 'owner-token-917-aaaa', kind: BROKER_FLEET_LOCK_KIND,
          guardPid: 7012, guardStartedAt: bogus,
          isPidLive: pid => pid === 917 || pid === 7012,
          startTimes: pids => { used++; return new Map(pids.map(p => [p, 1_700_000_333_000])); },
        }).ok, true);
        assert.equal(used, 1, `guardStartedAt ${String(bogus)} must fall back to the OS`);
        assert.deepEqual(JSON.parse(readFileSync(p2, 'utf8')).guard_started,
                         { 7012: 1_700_000_333_000 });
      }
    }

    // 8. AND DROPS IT WITH THE GUARD, so the field cannot grow for ever.
    {
      const path = file('guard-pruning.lock');
      writeRecord(path, record(907, 'owner-token-907-aaaa', {
        kind: BROKER_FLEET_LOCK_KIND, guards: [7101],
        guard_started: { 7101: 1_700_000_222_000 },
      }));
      const added = addFleetLockGuard(path, {
        pid: 907, token: 'owner-token-907-aaaa', kind: BROKER_FLEET_LOCK_KIND,
        guardPid: 7102,
        // 7101 is gone, so it is pruned; 7102 is the one being registered.
        isPidLive: pid => pid === 907 || pid === 7102,
        startTimes: pids => new Map(pids.map(p => [p, p === 7102 ? 1_700_000_333_000 : null])),
      });
      assert.equal(added.ok, true);
      const onDisk = JSON.parse(readFileSync(path, 'utf8'));
      assert.deepEqual(onDisk.guards, [7102]);
      assert.deepEqual(onDisk.guard_started, { 7102: 1_700_000_333_000 },
        'the pruned guard took its identity with it');
    }

    // 9. A MALFORMED FIELD INVALIDATES THE RECORD rather than being quietly ignored — a
    //    lock whose identities cannot be trusted must not be read as one with none.
    {
      const path = file('bad-guard-started.lock');
      writeRecord(path, record(908, 'owner-token-908-aaaa', {
        kind: BROKER_FLEET_LOCK_KIND, guards: [7201], guard_started: { 7201: -1 },
      }));
      const found = inspectFleetLock(path, ours(7201, null, 'node.exe'));
      assert.equal(found.lock, undefined, 'an unparseable record is not a claim');
    }
  }

  console.log('runtime fleet lock: PASS');
} finally {
  rmSync(resolvedScratch, { recursive: true, force: true });
}
