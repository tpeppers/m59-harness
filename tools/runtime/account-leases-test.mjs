#!/usr/bin/env node
// Offline account-lease tests. The lease directory is a fresh guarded OS temp directory;
// no broker, server, roster, account, or live fleet path is read.

import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AccountLeaseError,
  AccountLeaseRegistry,
  DEFAULT_ACCOUNT_LEASE_DIR,
  assertCanonicalAccountLeaseNamespace,
  auditLegacyRosterLocks,
  normalizeAccountId,
  normalizeGameEndpoint,
  planAccountLeases,
} from './account-leases.mjs';
import {
  BROKER_FLEET_LOCK_KIND,
  FLEET_LOCK_KIND,
  claimFleetLock,
  inspectFleetLock,
} from './fleet-lock.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'm59-account-leases-test-'));
const resolvedScratch = resolve(scratch);
if (!resolvedScratch.startsWith(resolve(tmpdir()) + sep))
  throw new Error(`refusing unsafe test directory ${resolvedScratch}`);

let serial = 0;
const tokens = () => `lease_token_${String(++serial).padStart(8, '0')}`;
const credentials = (account, host = '127.0.0.1', port = 5959) => ({ account, host, port });
// Unit registries never inspect the repository's real substrate. Legacy migration cases
// below opt into a fixture root explicitly.
const registry = options => new AccountLeaseRegistry({ legacyRosterRoots: [], ...options });
const lockFilesBelow = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? lockFilesBelow(path) : entry.name.endsWith('.lock') ? [path] : [];
});

try {
  assert.equal(normalizeAccountId('  FOO  '), 'foo');
  assert.equal(normalizeAccountId('ＦＯＯ'), 'foo', 'NFKC aliases must collide');
  assert.deepEqual(normalizeGameEndpoint('LOCALHOST.', 5959), {
    host: 'loopback', port: 5959, key: 'loopback:5959',
  });
  assert.deepEqual(normalizeGameEndpoint('[::1]', '5959'), {
    host: 'loopback', port: 5959, key: 'loopback:5959',
  });
  assert.equal(normalizeGameEndpoint('127.255.4.9', 5959).key, 'loopback:5959');
  assert.equal(normalizeGameEndpoint('::ffff:127.0.0.2', 5959).key, 'loopback:5959');
  assert.equal(normalizeGameEndpoint('[0:0:0:0:0:ffff:127.9.8.7]', 5959).key, 'loopback:5959');
  assert.equal(normalizeGameEndpoint(
    '0000:0000:0000:0000:0000:ffff:127.0.0.2', 5959).key, 'loopback:5959');
  assert.equal(normalizeGameEndpoint(
    '0000:0000:0000:0000:0000:0000:0000:0001', 5959).key, 'loopback:5959');
  assert.equal(normalizeGameEndpoint('::ffff:192.0.2.7', 5959).key, '::ffff:c000:207:5959');
  assert.equal(normalizeGameEndpoint('2001:0db8:0:0:0:0:0:1', 5959).key,
    '2001:db8::1:5959');
  assert.throws(() => normalizeGameEndpoint('192.168.001.1', 5959), /ambiguous/);
  assert.throws(() => normalizeGameEndpoint('127.1', 5959), /strict dotted-quad/);
  assert.equal(assertCanonicalAccountLeaseNamespace({}), DEFAULT_ACCOUNT_LEASE_DIR);
  assert.throws(() => assertCanonicalAccountLeaseNamespace({
    M59_ACCOUNT_LEASE_DIR: join(resolvedScratch, 'partitioned-namespace'),
  }), error => error instanceof AccountLeaseError && error.code === 'LEASE_NAMESPACE_OVERRIDE');

  // Alias rejection happens in the pure plan, before the lease directory or any lock file
  // exists. The same account name on a different game endpoint remains independent.
  {
    assert.throws(() => planAccountLeases([
      { agent: 't1', credentials: credentials('Foo', 'localhost', 5959) },
      { agent: 't2', credentials: credentials('  foo  ', '127.0.0.1', 5959) },
    ], { leaseDir: join(resolvedScratch, 'duplicate') }), error =>
      error instanceof AccountLeaseError && error.code === 'DUPLICATE_ACCOUNT');
    const planned = planAccountLeases([
      { agent: 'prod', credentials: credentials('Foo', 'localhost', 5959) },
      { agent: 'test', credentials: credentials('foo', 'localhost', 15959) },
    ], { leaseDir: join(resolvedScratch, 'different-endpoints') });
    assert.equal(planned.length, 2);
    assert.notEqual(planned[0].path, planned[1].path);
    const labShaped = planAccountLeases([
      { id: 'actor-1', credentials: credentials('actor-account') },
    ], { leaseDir: join(resolvedScratch, 'lab-shaped') });
    assert.equal(labShaped[0].agent, 'actor-1');
    assert.throws(() => planAccountLeases([
      { id: 'actor-1', agent: 'someone-else', credentials: credentials('actor-account') },
    ], { leaseDir: join(resolvedScratch, 'ambiguous-actor') }), error =>
      error instanceof AccountLeaseError && error.code === 'INVALID_AGENT');
  }

  // A broker and lab runtime with different roster names still meet on the canonical
  // account lease. The second owner is refused before it can log in.
  {
    const leaseDir = join(resolvedScratch, 'cross-runtime');
    const livePids = new Set([1001, 1002]);
    const common = { leaseDir, isPidLive: pid => livePids.has(pid), tokenFactory: tokens };
    const broker = registry({
      ...common, pid: 1001, kind: BROKER_FLEET_LOCK_KIND,
    });
    const lab = registry({ ...common, pid: 1002, kind: FLEET_LOCK_KIND });
    assert.equal(broker.acquire('prod-alias', credentials('Fleet01', 'localhost', 5959)).ok, true);
    const collision = lab.acquire('copied-alias', credentials('  FLEET01 ', '127.0.0.1', 5959));
    assert.equal(collision.ok, false);
    assert.equal(collision.code, 'ACCOUNT_HELD');
    assert.equal(collision.found.state, 'live');
    assert.equal(lab.size, 0);
    const permit = broker.permitForAgent('prod-alias');
    assert.equal(typeof permit.token, 'string');
    const storedSubject = JSON.parse(readFileSync(permit.path, 'utf8')).subject;
    assert.match(storedSubject, /^[a-f0-9]{64}$/);
    assert.equal(storedSubject.includes('prod-alias'), false,
      'actor/character binding is opaque in the lease file');
    assert.equal(broker.addGuard('prod-alias', 1003).ok, true);
    assert.deepEqual(JSON.parse(readFileSync(permit.path, 'utf8')).guards, [1003]);
    livePids.delete(1001);
    livePids.add(1003);
    const orphanCollision = lab.acquire('copied-alias', credentials('fleet01'));
    assert.equal(orphanCollision.ok, false);
    assert.equal(orphanCollision.found.owner_dead, true);
    assert.equal(orphanCollision.found.guard_pid, 1003);
    livePids.add(1004);
    const wrongSuccessor = registry({
      ...common, pid: 1004, kind: BROKER_FLEET_LOCK_KIND,
      adoptGuardedBroker: { previousPid: 9999, guardPids: [1003] },
    });
    assert.equal(wrongSuccessor.acquire('prod-alias', credentials('fleet01')).ok, false,
      'a broker without the exact fleet predecessor context remains an alias contender');
    const successor = registry({
      ...common, pid: 1004, kind: BROKER_FLEET_LOCK_KIND,
      adoptGuardedBroker: { previousPid: 1001, guardPids: [1003] },
    });
    const adopted = successor.acquire('prod-alias', credentials('fleet01'));
    assert.equal(adopted.ok, true,
      'the exact fleet successor may adopt its predecessor account guard');
    assert.equal(successor.verifyGuard('prod-alias', 1003).ok, true);
    assert.deepEqual(JSON.parse(readFileSync(permit.path, 'utf8')).guards, [1003]);
    assert.equal(broker.releaseAll()[0].reason, 'ownership-mismatch');
    livePids.delete(1003);
    assert.equal(successor.releaseAll()[0].released, true);
    assert.equal(lab.acquire('copied-alias', credentials('fleet01', '::1', 5959)).ok, true);
    assert.equal(lab.releaseAll()[0].released, true);
  }

  // A guarded account takeover rewrites each file before the whole roster commits. If a
  // later account conflicts, provisional release correctly refuses the live keeper guard,
  // leaving some claims on the failed successor pid and later ones on its predecessor.
  // The next exact-roster successor can recover both halves from the fleet's bounded pid
  // lineage; a runtime without that context still cannot adopt either claim.
  {
    const leaseDir = join(resolvedScratch, 'partial-guarded-adoption');
    const livePids = new Set([1501, 1503, 1510, 1511]);
    const common = { leaseDir, isPidLive: pid => livePids.has(pid), tokenFactory: tokens };
    const candidates = [
      { agent: 'partial-one', credentials: credentials('partial-account-one') },
      { agent: 'partial-two', credentials: credentials('partial-account-two') },
      { agent: 'partial-three', credentials: credentials('partial-account-three') },
    ];
    const ordered = planAccountLeases(candidates, { leaseDir });
    const [adoptFirst, conflictSecond, remainOld] = ordered;
    const row = identity => ({ agent: identity.agent, credentials: credentials(identity.account) });

    const old = registry({ ...common, pid: 1501, kind: BROKER_FLEET_LOCK_KIND });
    assert.equal(old.acquireAll([row(adoptFirst), row(remainOld)]).ok, true);
    assert.equal(old.addGuard(adoptFirst.agent, 1510).ok, true);
    assert.equal(old.addGuard(remainOld.agent, 1511).ok, true);
    livePids.delete(1501);

    const blocker = registry({ ...common, pid: 1503, kind: BROKER_FLEET_LOCK_KIND });
    assert.equal(blocker.acquire(conflictSecond.agent, row(conflictSecond).credentials).ok, true);
    livePids.add(1502);
    const failedSuccessor = registry({
      ...common, pid: 1502, kind: BROKER_FLEET_LOCK_KIND,
      adoptGuardedBroker: { previousPids: [1501], guardPids: [1510, 1511] },
    });
    const failed = failedSuccessor.acquireAll(ordered.map(row));
    assert.equal(failed.ok, false);
    assert.equal(failedSuccessor.size, 0);
    assert.equal(JSON.parse(readFileSync(adoptFirst.path, 'utf8')).pid, 1502,
      'live guard makes the provisional adoption intentionally non-releasable');
    assert.equal(JSON.parse(readFileSync(remainOld.path, 'utf8')).pid, 1501,
      'the later predecessor claim was not reached after the conflict');

    blocker.releaseAll();
    livePids.delete(1502);
    livePids.add(1504);
    const recovered = registry({
      ...common, pid: 1504, kind: BROKER_FLEET_LOCK_KIND,
      adoptGuardedBroker: { previousPids: [1502, 1501], guardPids: [1510, 1511] },
    });
    assert.equal(recovered.acquireAll(ordered.map(row)).ok, true);
    assert.equal(JSON.parse(readFileSync(adoptFirst.path, 'utf8')).pid, 1504);
    assert.equal(JSON.parse(readFileSync(remainOld.path, 'utf8')).pid, 1504);
    assert.equal(recovered.finalizeAdoptions().ok, true);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(adoptFirst.path, 'utf8')), 'predecessors'), false);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(remainOld.path, 'utf8')), 'predecessors'), false);
    livePids.delete(1510);
    livePids.delete(1511);
    assert.ok(recovered.releaseAll().every(result => result.released));
    old.releaseAll();
  }

  // Exact-roster guarded takeover is not complete merely because the edited roster's
  // remaining accounts were acquired. Every live inherited fleet guard must map to exactly
  // one selected predecessor account. Truncation/change therefore retains both fleet and
  // account lineage; relabelling an actor is rejected by the account subject binding.
  {
    const leaseDir = join(resolvedScratch, 'roster-drift-adoption');
    const fleetPath = join(resolvedScratch, 'roster-drift.lock');
    const livePids = new Set([1601, 1610, 1611]);
    const isPidLive = pid => livePids.has(pid);
    const common = { leaseDir, isPidLive, tokenFactory: tokens };
    const oldFleet = claimFleetLock(fleetPath, {
      pid: 1601, token: 'roster-drift-fleet-old-1601', kind: BROKER_FLEET_LOCK_KIND,
      guards: [1610, 1611], isPidLive,
    });
    assert.equal(oldFleet.ok, true);
    const oldAccounts = registry({ ...common, pid: 1601, kind: BROKER_FLEET_LOCK_KIND });
    assert.equal(oldAccounts.acquireAll([
      { agent: 'a', credentials: credentials('roster-drift-a') },
      { agent: 'b', credentials: credentials('roster-drift-b') },
    ]).ok, true);
    assert.equal(oldAccounts.addGuard('a', 1610).ok, true);
    assert.equal(oldAccounts.addGuard('b', 1611).ok, true);

    livePids.delete(1601);
    livePids.add(1602);
    const successorFleet = claimFleetLock(fleetPath, {
      pid: 1602, token: 'roster-drift-fleet-new-1602', kind: BROKER_FLEET_LOCK_KIND,
      guards: [], adoptGuardedBroker: true, isPidLive,
    });
    assert.equal(successorFleet.ok, true);
    const successor = registry({
      ...common, pid: 1602, kind: BROKER_FLEET_LOCK_KIND,
      adoptGuardedBroker: { previousPids: [1601], guardPids: [1610, 1611] },
    });
    assert.equal(successor.acquire('a', credentials('roster-drift-a')).ok, true);
    const truncated = successor.finalizeAdoptions();
    assert.equal(truncated.ok, false);
    assert.equal(truncated.reason, 'inherited-fleet-guard-unaccounted');
    assert.equal(truncated.guard_pid, 1611);
    assert.deepEqual(inspectFleetLock(fleetPath, { isPidLive }).lock.predecessors, [1601],
      'fleet lineage remains until the selected roster accounts for every live keeper');
    const accountAPath = successor.permitForAgent('a').path;
    assert.deepEqual(inspectFleetLock(accountAPath, { isPidLive }).lock.predecessors, [1601],
      'coverage is checked before clearing any account lineage');

    const renamed = successor.acquire('c', credentials('roster-drift-b'));
    assert.equal(renamed.ok, false);
    assert.equal(renamed.code, 'ACCOUNT_HELD');
    assert.match(renamed.found.lock.subject, /^[a-f0-9]{64}$/);
    assert.notEqual(renamed.found.lock.subject,
      successor.plan([{ agent: 'c', credentials: credentials('roster-drift-b') }])[0].subject,
      'a surviving keeper/account cannot be silently relabelled to a new actor slot');

    // Changing b's account creates a legitimate fresh lease, but it cannot explain K2;
    // the predecessor b/accountB claim remains guarded and finalization still refuses.
    assert.equal(successor.acquire('b', credentials('roster-drift-b-replacement')).ok, true);
    assert.equal(successor.finalizeAdoptions().reason, 'inherited-fleet-guard-unaccounted');

    livePids.delete(1610);
    livePids.delete(1611);
    successor.releaseAll();
    oldAccounts.releaseAll();
    assert.equal(successorFleet.release().released, true);
  }

  // Same slot/account/endpoint is still not the same live character. A roster edit from
  // Alice to Bob must not adopt Alice's guarded keeper and then erase the only predecessor
  // evidence. NFKC/case-only spelling differences normalize to the same subject.
  {
    const leaseDir = join(resolvedScratch, 'character-drift-adoption');
    const livePids = new Set([1651, 1660]);
    const common = { leaseDir, isPidLive: pid => livePids.has(pid), tokenFactory: tokens };
    const aliceCredentials = { ...credentials('character-drift'), character: 'Alice' };
    const normalizedAlice = { ...credentials('character-drift'), character: ' ＡＬＩＣＥ ' };
    const bobCredentials = { ...credentials('character-drift'), character: 'Bob' };
    const alicePlan = planAccountLeases([
      { agent: 'slot', credentials: aliceCredentials },
    ], { leaseDir });
    const normalizedPlan = planAccountLeases([
      { agent: 'slot', credentials: normalizedAlice },
    ], { leaseDir });
    const bobPlan = planAccountLeases([
      { agent: 'slot', credentials: bobCredentials },
    ], { leaseDir });
    assert.equal(alicePlan[0].subject, normalizedPlan[0].subject);
    assert.notEqual(alicePlan[0].subject, bobPlan[0].subject);

    const old = registry({ ...common, pid: 1651, kind: BROKER_FLEET_LOCK_KIND });
    assert.equal(old.acquire('slot', aliceCredentials).ok, true);
    assert.equal(old.addGuard('slot', 1660).ok, true);
    livePids.delete(1651);
    livePids.add(1652);
    const successor = registry({
      ...common, pid: 1652, kind: BROKER_FLEET_LOCK_KIND,
      adoptGuardedBroker: { previousPids: [1651], guardPids: [1660] },
    });
    const changed = successor.acquire('slot', bobCredentials);
    assert.equal(changed.ok, false);
    assert.equal(changed.code, 'ACCOUNT_HELD');
    assert.equal(changed.found.lock.subject, alicePlan[0].subject);
    assert.equal(Object.hasOwn(changed.found.lock, 'predecessors'), false,
      'character mismatch refuses before rewriting the predecessor account claim');

    livePids.delete(1660);
    old.releaseAll();
  }

  // Definitely dead inherited guards do not force a dead actor to remain in the roster.
  // Uncertain liveness would fail closed; only an exact false is pruned from the equation.
  {
    const leaseDir = join(resolvedScratch, 'dead-inherited-guard');
    const livePids = new Set([1701, 1710]);
    const common = { leaseDir, isPidLive: pid => livePids.has(pid), tokenFactory: tokens };
    const old = registry({ ...common, pid: 1701, kind: BROKER_FLEET_LOCK_KIND });
    assert.equal(old.acquireAll([
      { agent: 'live', credentials: credentials('dead-guard-live') },
      { agent: 'gone', credentials: credentials('dead-guard-gone') },
    ]).ok, true);
    assert.equal(old.addGuard('live', 1710).ok, true);
    assert.equal(old.addGuard('gone', 1711).ok, true);
    livePids.delete(1701);
    livePids.add(1702);
    const successor = registry({
      ...common, pid: 1702, kind: BROKER_FLEET_LOCK_KIND,
      adoptGuardedBroker: { previousPids: [1701], guardPids: [1710, 1711] },
    });
    assert.equal(successor.acquire('live', credentials('dead-guard-live')).ok, true);
    assert.equal(successor.finalizeAdoptions().ok, true,
      'the omitted actor is safe only because its inherited guard is definitely dead');
    livePids.delete(1710);
    successor.releaseAll();
    old.releaseAll();
  }

  // Whole-roster acquisition is transactional. A conflict on either row leaves none of
  // the other row's lease behind, regardless of sorted acquisition order.
  {
    const leaseDir = join(resolvedScratch, 'rollback');
    const livePids = new Set([1101, 1102]);
    const common = { leaseDir, isPidLive: pid => livePids.has(pid), tokenFactory: tokens };
    const blocker = registry({
      ...common, pid: 1101, kind: BROKER_FLEET_LOCK_KIND,
    });
    assert.equal(blocker.acquire('held', credentials('blocked-account')).ok, true);
    const candidate = registry({ ...common, pid: 1102, kind: FLEET_LOCK_KIND });
    const result = candidate.acquireAll([
      { agent: 'free', credentials: credentials('free-account') },
      { agent: 'blocked', credentials: credentials('BLOCKED-ACCOUNT') },
    ]);
    assert.equal(result.ok, false);
    assert.equal(candidate.size, 0);
    const observer = registry({
      ...common, pid: 1102, kind: FLEET_LOCK_KIND,
    });
    assert.equal(observer.acquire('free', credentials('free-account')).ok, true,
      'rollback must release a free lease acquired before the conflict');
    observer.releaseAll();
    blocker.releaseAll();
  }

  // A dead registry leaves reclaimable account locks, using the same two liveness checks as
  // the fleet lock. This fixture simulates death by deliberately not calling releaseAll().
  {
    const leaseDir = join(resolvedScratch, 'stale');
    const first = registry({
      leaseDir, pid: 1201, kind: BROKER_FLEET_LOCK_KIND,
      isPidLive: () => true, tokenFactory: tokens,
    });
    assert.equal(first.acquire('old', credentials('stale-account')).ok, true);
    let checks = 0;
    const replacement = registry({
      leaseDir, pid: 1202, kind: FLEET_LOCK_KIND,
      isPidLive: pid => { if (pid === 1201) checks++; return pid === 1202; },
      tokenFactory: tokens,
    });
    assert.equal(replacement.acquire('new', credentials('STALE-ACCOUNT')).ok, true);
    assert.ok(checks >= 3, `dead account owner was checked only ${checks} time(s)`);
    replacement.releaseAll();
  }

  // Incremental aliases inside one runtime are rejected too; changing one agent to a new
  // account acquires the replacement before releasing its original lease.
  {
    const leaseDir = join(resolvedScratch, 'incremental');
    const accountRegistry = registry({
      leaseDir, pid: 1301, kind: BROKER_FLEET_LOCK_KIND,
      isPidLive: pid => pid === 1301, tokenFactory: tokens,
    });
    assert.equal(accountRegistry.acquire('a', credentials('one')).newly_acquired, true);
    assert.equal(accountRegistry.acquire('a', credentials('ONE')).newly_acquired, false);
    assert.throws(() => accountRegistry.acquire('b', credentials(' one ')), error =>
      error instanceof AccountLeaseError && error.code === 'DUPLICATE_ACCOUNT');
    assert.equal(accountRegistry.acquire('a', credentials('two')).newly_acquired, true);
    assert.equal(accountRegistry.size, 1);
    assert.equal(accountRegistry.releaseAgent('a').released, true);
    assert.equal(accountRegistry.releaseAgent('a').reason, 'not-held');
  }

  // A broker that loaded the old code owns only its roster's `{pid,at}` lock. The default
  // migration audit finds that standard named roster and refuses an alias before creating
  // any account lease. Explicit endpoints compare canonically; an absent legacy endpoint
  // is a wildcard because the old process's M59_HOST/M59_PORT cannot be recovered.
  {
    const root = join(resolvedScratch, 'legacy-audit');
    const fleets = join(root, 'fleets');
    const leaseDir = join(root, 'runtime-account-leases');
    mkdirSync(fleets, { recursive: true });
    const oldRoster = join(fleets, 'old.json');
    writeFileSync(oldRoster, JSON.stringify({
      old: { credentials: credentials(' ＦＬＥＥＴ０１ ', 'localhost', 5959) },
    }));
    writeFileSync(`${oldRoster}.lock`, JSON.stringify({ pid: 1401, at: 1234 }));
    const live = pid => pid === 1401 || pid === 1402;
    const candidate = registry({
      leaseDir, legacyRosterRoots: [root], pid: 1402,
      kind: FLEET_LOCK_KIND, isPidLive: live, tokenFactory: tokens,
    });
    const collision = candidate.acquire('copy', credentials('fleet01', '127.0.0.1', 5959));
    assert.equal(collision.ok, false);
    assert.equal(collision.code, 'LEGACY_ACCOUNT_HELD');
    assert.equal(collision.found.lock.legacy, true);
    assert.equal(collision.legacy_roster, oldRoster);
    assert.equal(candidate.size, 0);
    assert.equal(readdirSync(root).includes('runtime-account-leases'), false,
      'migration refusal must precede lease-directory creation');

    assert.equal(auditLegacyRosterLocks([
      { agent: 'other-server', credentials: credentials('fleet01', 'localhost', 15959) },
    ], {
      leaseDir, legacyRosterRoots: [root], isPidLive: live,
    }).ok, true, 'an explicit different endpoint is independent');

    writeFileSync(oldRoster, JSON.stringify({ old: { credentials: { account: 'fleet01' } } }));
    const wildcard = candidate.acquire('other-server', credentials('fleet01', 'localhost', 15959));
    assert.equal(wildcard.ok, false);
    assert.equal(wildcard.code, 'LEGACY_ACCOUNT_HELD');
    assert.equal(wildcard.legacy_endpoint, null);

    writeFileSync(`${oldRoster}.lock`, JSON.stringify({ pid: 1401, at: 1234, extra: true }));
    const unverifiable = candidate.acquire('copy', credentials('fleet01'));
    assert.equal(unverifiable.ok, false);
    assert.equal(unverifiable.code, 'UNVERIFIABLE_ROSTER_LOCK');

    writeFileSync(oldRoster, JSON.stringify({
      old: { credentials: credentials('fleet01', 'localhost', 5959) },
    }));
    writeFileSync(`${oldRoster}.lock`, JSON.stringify({ pid: 1401, at: 1234 }));
    const deadLegacy = registry({
      leaseDir, legacyRosterRoots: [root], pid: 1402, kind: FLEET_LOCK_KIND,
      isPidLive: pid => pid === 1402, tokenFactory: tokens,
    });
    const staleRefusal = deadLegacy.acquire('copy', credentials('fleet01'));
    assert.equal(staleRefusal.ok, false);
    assert.equal(staleRefusal.code, 'UNGUARDED_STALE_BROKER');
    const aliasRoster = join(fleets, 'alias.json');
    writeFileSync(aliasRoster, JSON.stringify({
      alias: { credentials: credentials('fleet01', 'localhost', 5959) },
    }));
    writeFileSync(`${aliasRoster}.lock`, JSON.stringify({ pid: 1403, at: 1234 }));
    const recovered = registry({
      leaseDir, legacyRosterRoots: [root], pid: 1402, kind: FLEET_LOCK_KIND,
      isPidLive: pid => pid === 1402, tokenFactory: tokens,
      unguardedBrokerRecovery: { previousPid: 1401, rosterPaths: [oldRoster] },
    });
    const aliasStillBlocks = recovered.acquire('copy', credentials('fleet01'));
    assert.equal(aliasStillBlocks.ok, false);
    assert.equal(aliasStillBlocks.code, 'UNGUARDED_STALE_BROKER');
    assert.equal(aliasStillBlocks.legacy_roster, aliasRoster,
      'an override for the selected roster must not exempt another stale alias roster');
    unlinkSync(`${aliasRoster}.lock`);
    assert.equal(recovered.acquire('copy', credentials('fleet01')).ok, true,
      'exact-roster recovery follows an operator orphan audit');
    recovered.releaseAll();

    writeFileSync(`${oldRoster}.lock`, JSON.stringify({ pid: 1401, at: 1234 }));
    const malformedSecret = 'legacy-password-must-not-echo';
    writeFileSync(oldRoster, `{"password":"${malformedSecret}", BROKEN`);
    const unreadable = candidate.acquire('copy', credentials('fleet01'));
    assert.equal(unreadable.ok, false);
    assert.equal(unreadable.code, 'LEGACY_ROSTER_UNVERIFIABLE');
    assert.equal(JSON.stringify(unreadable).includes(malformedSecret), false,
      'JSON parser source excerpts must not expose roster credentials');
    unlinkSync(`${oldRoster}.lock`);
  }

  // Importing the broker would eagerly load the world and was historically unsafe. Assert
  // the integration against source: ownership must be taken before either listener, and
  // every direct login/create path must pass the account guard first.
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const broker = readFileSync(join(here, '..', 'm59-broker.mjs'), 'utf8');
    const keeper = readFileSync(join(here, '..', 'm59-keeper-process.mjs'), 'utf8');
    const main = broker.slice(broker.indexOf('} else if (isMainModule)'));
    assert.ok(main.indexOf('acquireBrokerOwnership()') >= 0);
    assert.ok(main.indexOf('acquireBrokerOwnership()') < main.indexOf('serveHttp('));
    assert.ok(main.indexOf('acquireBrokerOwnership()') < main.indexOf('serveStdio('));
    assert.doesNotMatch(broker, /writeFileSync\(LOCK_FILE/,
      'broker fleet ownership must never regress to check-then-overwrite');
    assert.doesNotMatch(broker, /function fleetOwnedByAnotherProcess/);
    assert.doesNotMatch(broker, /uses normalized account/,
      'broker conflict diagnostics must not disclose normalized account ids');
    assert.match(broker, /requireBrokerAccountLease\(a\.agent, args\);\s*const r = await s\.join\(args\)/);
    assert.match(broker,
      /requireBrokerAccountLease\(a\.agent, s\.credentials\);[\s\S]{0,1800}s\.joinAsNewCharacter/);
    const selftest = broker.slice(broker.indexOf('async function selftest('), broker.indexOf('// ---------------------------------------------------------------- main'));
    assert.ok(selftest.indexOf("requireBrokerAccountLease('test'") < selftest.indexOf("await call('join'"),
      'selftest must explicitly lease its supplied account before login');
    assert.match(broker, /adoptGuardedBroker: true/);
    assert.match(broker, /setGuardedAdoptionContext\(\{/);
    assert.match(broker, /setUnguardedRecoveryContext\(\{[\s\S]{0,300}rosterPaths: \[STATE_FILE\]/);
    const ownership = broker.slice(broker.indexOf('function acquireBrokerOwnership()'),
      broker.indexOf('function fleetClaimStillOurs()'));
    assert.ok(ownership.indexOf('assertCanonicalAccountLeaseNamespace()') >= 0);
    assert.ok(ownership.indexOf('assertCanonicalAccountLeaseNamespace()') <
      ownership.indexOf('claimFleetLock(LOCK_FILE'),
    'broker rejects a partitioned lease namespace before claiming the roster');
    const survivor = broker.slice(broker.indexOf('async function spawnKeeperInner('),
      broker.indexOf("const { spawn } = await import('node:child_process')"));
    assert.match(survivor,
      /if \(expectedCharacter && observedCharacter !== expectedCharacter\)/,
      'a named roster refuses missing or mismatched live keeper character identity');
    assert.doesNotMatch(survivor, /if \(!expectedCharacter \|\|/,
      'an intentionally unnamed roster may still adopt its guarded keeper');
    assert.ok(survivor.indexOf('observedCharacter !== expectedCharacter') <
      survivor.indexOf('keeperProcesses.set(agent'),
    'character identity is verified before keeper adoption is published');
    const childSpawn = broker.slice(broker.indexOf('child = spawn(process.execPath'),
      broker.indexOf('// Wait for the keeper to be ready'));
    assert.ok(childSpawn.indexOf('M59_KEEPER_OWNERSHIP') >= 0);
    assert.ok(childSpawn.indexOf('installKeeperOwnershipGuards(agent, child.pid)') >= 0);
    assert.ok(childSpawn.indexOf('installKeeperOwnershipGuards(agent, child.pid)') <
      childSpawn.indexOf('keeperProcesses.set(agent'),
    'parent must install both guards before publishing/spawning a usable keeper');
    const migration = broker.slice(broker.indexOf('// ONE-TIME MIGRATION FROM PRE-GUARD BROKERS'),
      broker.indexOf('} else {', broker.indexOf('// ONE-TIME MIGRATION FROM PRE-GUARD BROKERS')));
    assert.ok(migration.indexOf('installKeeperOwnershipGuards(agent, pid)') >= 0);
    assert.ok(migration.indexOf('installKeeperOwnershipGuards(agent, pid)') <
      migration.indexOf("fetch(`http://127.0.0.1:${port}/stop`"),
    'legacy survivor is put under both new claims before an addressed stop request');
    assert.doesNotMatch(migration, /process\.kill\(pid/,
      'an adopted legacy survivor is never terminated through a reusable numeric PID');
    const guardInstall = broker.slice(broker.indexOf('function installKeeperOwnershipGuards('),
      broker.indexOf('function keeperOwnershipIsGuarded('));
    assert.ok(guardInstall.indexOf('brokerAccountLeases.addGuard') <
      guardInstall.indexOf('addFleetLockGuard'),
    'account guard is installed first so a partial write still blocks alias rosters');
    const keeperOwnership = keeper.slice(keeper.indexOf('async function requireKeeperOwnership()'),
      keeper.indexOf('try { await requireKeeperOwnership(); }'));
    assert.match(keeperOwnership,
      /const expectedAccount = planAccountLeases\(\[\{ agent, credentials: \{\s*account, character, host: credHost, port: credPort,\s*\} \}\]\)\[0\]/,
      'keeper independently plans the exact account lease from freshly read roster credentials');
    assert.match(keeperOwnership,
      /resolve\(permit\.fleet\.path\) !== resolve\(resolvedFleet\.lockFile\)/,
      'keeper accepts a fleet permit only for this exact resolved roster lock path');
    assert.match(keeperOwnership,
      /resolve\(permit\.account\.path\) !== resolve\(expectedAccount\.path\) \|\|\s*permit\.account\.subject !== expectedAccount\.subject/,
      'keeper requires both the planned account lease path and its opaque subject');
    assert.match(keeperOwnership,
      /subject: claim === permit\.account \? expectedAccount\.subject : null/,
      'account guard verification requires the independently planned subject');
    assert.ok(keeper.indexOf('await requireKeeperOwnership()') < keeper.indexOf('const session = new Session(agent)'),
      'keeper must verify fleet+account guards before constructing Session');
    assert.match(keeper, /const checks = \[permit\.fleet, permit\.account\]/);
    assert.match(keeper, /refused before Session\/login/);
  }

  assert.deepEqual(lockFilesBelow(resolvedScratch), [],
    'all successfully owned leases must be released by the end of the suite');
  console.log('runtime account leases: PASS');
} finally {
  rmSync(resolvedScratch, { recursive: true, force: true });
}
