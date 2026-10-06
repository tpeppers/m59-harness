#!/usr/bin/env node
// Offline tests for the live broker handover. No broker, socket, roster or real lock is
// touched: lock files live under a fresh OS temp directory, pids are fakes, and the two
// brokers talk over an in-memory channel.
//
// What this pins, and why each matters:
//  * a TRANSFER keeps every keeper guard, so a running keeper still verifies after its
//    broker changed — the whole reason nobody has to log back in;
//  * it is compare-and-swap on the current owner, so a stale or wrong owner cannot move it;
//  * it rolls back with the successor's token alone, so a dead or wedged successor cannot
//    strand the fleet;
//  * a successor that dies AFTER the transfer leaves a lock that ordinary guarded adoption
//    recovers — the existing crash path, not a new one;
//  * account leases move transactionally and are re-derived from the roster on import;
//  * the predecessor never freezes before the successor is warm, never commits before it
//    serves, and on every abort ends unfrozen, owning, and with its held requests run;
//  * the successor never binds a port before it owns the fleet, and takes the ports itself
//    if the predecessor vanishes after the transfer.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  BROKER_FLEET_LOCK_KIND,
  addFleetLockGuard,
  claimFleetLock,
  claimFromTransfer,
  inspectFleetLock,
  transferFleetLock,
  verifyFleetLockGuard,
} from './fleet-lock.mjs';
import { AccountLeaseRegistry } from './account-leases.mjs';
import {
  HANDOVER_PROTOCOL, RequestHold, SUCCESSOR_ENV, handOver, judgeAdoption, successorOf,
  successorSpawnSpec, takeOver,
} from './broker-handover.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'm59-broker-handover-test-'));
if (!resolve(scratch).startsWith(resolve(tmpdir()) + sep)) throw new Error('unsafe scratch dir');
const file = name => join(scratch, name);

let passed = 0;
const ok = (what) => { passed++; if (process.env.VERBOSE) console.log(`  ok  ${what}`); };

// Pids 1001 (old broker), 1002 (new broker), 7001-7002 (keepers) are "alive" unless removed.
const live = new Set([1001, 1002, 7001, 7002]);
const isPidLive = pid => live.has(pid);
// Start times for guards, so guardStillOurs can confirm a live guard without PowerShell.
const START = 1_700_000_000_000;

try {
  // ------------------------------------------------------------- the fleet lock

  {
    const path = file('fleet.lock');
    const claim = claimFleetLock(path, { pid: 1001, kind: BROKER_FLEET_LOCK_KIND,
      token: 'old-token-aaaaaaaa', guards: [], isPidLive });
    assert.ok(claim.ok);
    for (const guardPid of [7001, 7002])
      assert.ok(addFleetLockGuard(path, { pid: 1001, token: 'old-token-aaaaaaaa',
        kind: BROKER_FLEET_LOCK_KIND, guardPid, guardStartedAt: START, isPidLive }).ok);
    const keeperHolds = (owner) => verifyFleetLockGuard(path, { ...owner, kind: BROKER_FLEET_LOCK_KIND,
      guardPid: 7001, isPidLive }).ok;
    const oldOwner = { pid: 1001, token: 'old-token-aaaaaaaa' };
    const newOwner = { pid: 1002, token: 'new-token-bbbbbbbb' };
    assert.ok(keeperHolds(oldOwner));

    // A non-owner cannot move it.
    assert.equal(transferFleetLock(path, { from: { pid: 1001, token: 'forged-token-ccc',
      kind: BROKER_FLEET_LOCK_KIND }, to: newOwner }).reason, 'ownership-mismatch');
    ok('a transfer from anyone but the current owner is refused');

    const moved = transferFleetLock(path, { from: { ...oldOwner, kind: BROKER_FLEET_LOCK_KIND }, to: newOwner });
    assert.ok(moved.ok, JSON.stringify(moved));
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(after.pid, 1002);
    assert.deepEqual(after.guards, [7001, 7002]);
    assert.deepEqual(after.guard_started, { 7001: START, 7002: START });
    ok('a transfer names the successor and keeps every guard and its start time');

    assert.ok(keeperHolds(newOwner), 'the running keeper verifies against the NEW owner');
    assert.equal(keeperHolds(oldOwner), false, 'and no longer against the old one');
    ok('a running keeper verifies against its new broker without being touched');

    const theirs = claimFromTransfer(path, { pid: 1002, token: newOwner.token, kind: BROKER_FLEET_LOCK_KIND, isPidLive });
    assert.ok(theirs.ok);
    assert.equal(claimFromTransfer(path, { pid: 1002, token: 'wrong-token-dddd',
      kind: BROKER_FLEET_LOCK_KIND, isPidLive }).ok, false);
    ok('the successor can only take a claim object for the token it was given');

    // Rollback needs only the successor's token, never the successor.
    live.delete(1002);
    const back = transferFleetLock(path, { from: { ...newOwner, kind: BROKER_FLEET_LOCK_KIND },
      to: oldOwner });
    assert.ok(back.ok);
    assert.ok(keeperHolds(oldOwner));
    ok('rollback works with the successor dead');
    live.add(1002);

    // A successor that dies after the transfer leaves the ordinary crashed-broker shape:
    // owner dead, guards alive — which a third broker recovers by guarded adoption.
    assert.ok(transferFleetLock(path, { from: { ...oldOwner, kind: BROKER_FLEET_LOCK_KIND }, to: newOwner }).ok);
    live.delete(1002);
    const found = inspectFleetLock(path, { isPidLive, startTimes: pids => new Map(pids.map(p => [p, START])),
      imageName: () => 'node.exe' });
    assert.equal(found.state, 'live');
    assert.equal(found.owner_dead, true);
    const third = claimFleetLock(path, { pid: 1003, kind: BROKER_FLEET_LOCK_KIND, token: 'third-token-eeee',
      isPidLive: pid => pid === 1003 || isPidLive(pid),
      adoptGuardedBroker: { previousPids: [1002], guardPids: [7001, 7002] } });
    assert.ok(third.ok && third.adopted_guarded, JSON.stringify(third.found ?? third));
    ok('a successor that dies after the transfer is recovered by ordinary guarded adoption');
    live.add(1002);
  }

  // ------------------------------------------------------------- account leases

  const entries = [
    { agent: 't1', credentials: { account: 'acct-one', character: 'Alpha', host: '127.0.0.1', port: 15959 } },
    { agent: 't2', credentials: { account: 'acct-two', character: 'Bravo', host: '127.0.0.1', port: 15959 } },
  ];
  const registry = (pid, leaseDir) => new AccountLeaseRegistry({
    leaseDir, kind: BROKER_FLEET_LOCK_KIND, pid, isPidLive, legacyRosterRoots: [],
    defaultHost: '127.0.0.1', defaultPort: 15959,
  });
  const guardAll = (reg, pids) => {
    for (const [agent, guardPid] of pids) {
      const permit = reg.permitForAgent(agent);
      assert.ok(addFleetLockGuard(permit.path, { pid: permit.pid, token: permit.token, kind: permit.kind,
        guardPid, guardStartedAt: START, isPidLive }).ok);
    }
  };

  {
    const leaseDir = file('leases-a');
    const old = registry(1001, leaseDir);
    assert.ok(old.acquireAll(entries).ok);
    guardAll(old, [['t1', 7001], ['t2', 7002]]);
    const subject = old.permitForAgent('t1').subject;

    const moved = old.transferAll(1002);
    assert.ok(moved.ok, JSON.stringify(moved));
    assert.equal(old.size, 0, 'the predecessor holds nothing after transferring');
    ok('every account lease transfers, and the predecessor is left holding none');

    const next = registry(1002, leaseDir);
    const tampered = moved.rows.map(r => r.agent === 't2' ? { ...r, path: moved.rows[0].path } : r);
    assert.equal(next.importTransferred(entries, tampered).ok, false);
    ok('an imported row whose file does not match the roster identity is refused');

    assert.ok(next.importTransferred(entries, moved.rows).ok);
    assert.ok(next.verifyGuard('t1', 7001).ok && next.verifyGuard('t2', 7002).ok);
    assert.equal(next.permitForAgent('t1').pid, 1002);
    assert.equal(next.permitForAgent('t1').subject, subject);
    ok('the successor imports the leases and every keeper guard still verifies');

    // A later resume's acquireAll must treat them as already held, not contend for them.
    assert.ok(next.acquireAll(entries).ok);
    assert.equal(next.size, 2);
    ok('a resume after import finds the leases already held');
  }

  {
    const leaseDir = file('leases-b');
    const old = registry(1001, leaseDir);
    assert.ok(old.acquireAll(entries).ok);
    guardAll(old, [['t1', 7001]]);
    const subject = old.permitForAgent('t1').subject;
    assert.ok(old.transferAll(1002).ok);
    const back = old.transferBack();
    assert.ok(back.ok, JSON.stringify(back));
    assert.equal(old.size, 2);
    assert.equal(old.permitForAgent('t1').pid, 1001);
    assert.equal(old.permitForAgent('t1').subject, subject, 'rollback restores the full identity');
    assert.ok(old.verifyGuard('t1', 7001).ok);
    ok('transferBack returns every lease, full identity included');
  }

  {
    const leaseDir = file('leases-c');
    const old = registry(1001, leaseDir);
    assert.ok(old.acquireAll(entries).ok);
    // Sabotage the SECOND lease (in key order) so its transfer fails after the first succeeded.
    const paths = entries.map(e => old.permitForAgent(e.agent).path).sort();
    const victim = paths[1];
    const raw = JSON.parse(readFileSync(victim, 'utf8'));
    writeFileSync(victim, JSON.stringify({ ...raw, token: 'somebody-else-ffff' }));
    const moved = old.transferAll(1002);
    assert.equal(moved.ok, false);
    assert.equal(moved.rolled_back, true);
    assert.equal(JSON.parse(readFileSync(paths[0], 'utf8')).pid, 1001,
      'the lease that DID move was moved back');
    ok('a partial account transfer rolls the moved leases back');
  }

  // ------------------------------------------------------------- holding requests

  {
    const hold = new RequestHold();
    assert.equal(await hold.admit(), 'proceed');
    hold.begin();
    const a = hold.admit(), b = hold.admit();
    assert.equal(hold.held, 2);
    hold.release('forward');
    assert.deepEqual(await Promise.all([a, b]), ['forward', 'forward']);
    assert.equal(await hold.admit(), 'forward', 'after a commit everything goes to the successor');
    ok('held requests are forwarded on commit, and so is everything after it');

    const h2 = new RequestHold();
    h2.begin();
    const c = h2.admit();
    h2.release('local');
    assert.equal(await c, 'proceed');
    assert.equal(await h2.admit(), 'proceed');
    ok('held requests run where they arrived on an abort');
  }

  // ------------------------------------------------------------- spawn spec

  {
    const spec = successorSpawnSpec({ execPath: 'node', execArgv: ['--max-old-space-size=4096'],
      argv: ['C:/x/tools/m59-broker.mjs', '--http', '8901'], env: { M59_STATE_FILE: 'C:/r.json' },
      cwd: 'C:/x', predecessorPid: 1001 });
    assert.deepEqual(spec.args, ['--max-old-space-size=4096', 'C:/x/tools/m59-broker.mjs', '--http', '8901']);
    assert.equal(spec.options.env.M59_STATE_FILE, 'C:/r.json', 'the roster environment is inherited');
    assert.equal(spec.options.env[SUCCESSOR_ENV], '1001');
    assert.equal(spec.options.stdio[3], 'ipc');
    assert.equal(spec.options.serialization, 'advanced');
    assert.equal(spec.options.detached, true);
    assert.equal(successorOf(spec.options.env), 1001);
    assert.equal(successorOf({}), null);
    ok('the successor is the same program, argv and environment, plus a channel');
  }

  // ------------------------------------------------------------- the protocol

  // Two ends of an in-memory channel. Messages are delivered on a later tick, like IPC.
  const pair = (childPid = 1002) => {
    const child = new EventEmitter();
    const self = new EventEmitter();
    let open = true;
    child.pid = childPid; child.exitCode = null; child.signalCode = null;
    child.send = (m, h) => { if (!open) throw new Error('closed'); setImmediate(() => self.emit('message', m, h)); };
    self.send = (m, h) => { if (!open) throw new Error('closed'); setImmediate(() => child.emit('message', m, h)); };
    const close = () => { if (!open) return; open = false; setImmediate(() => { child.emit('disconnect'); self.emit('disconnect'); }); };
    child.kill = () => { if (child.exitCode != null) return; close(); child.exitCode = 1; setImmediate(() => child.emit('exit', 1)); };
    child.disconnect = close;
    child.unref = () => {};
    self.disconnect = close;
    return { child, self, close };
  };

  const predecessorDeps = (child, calls, over = {}) => ({
    canHandOver: () => ({ ok: true }),
    spawnSuccessor: () => child,
    freeze: async () => { calls.push('freeze'); return { ok: true }; },
    unfreeze: () => calls.push('unfreeze'),
    transferOwnership: pid => { calls.push(`transfer:${pid}`); return { ok: true, ownership: { fleet: 'f' } }; },
    transferBack: () => { calls.push('transferBack'); return { ok: true }; },
    snapshot: () => { calls.push('snapshot'); return { keeperProcesses: new Map([['t1', { pid: 7001 }]]) }; },
    listeners: () => [{ name: 'rpc', server: { fake: 'rpc' } }, { name: 'dashboard', server: { fake: 'dash' } }],
    commit: () => calls.push('commit'),
    releaseHeld: v => calls.push(`release:${v}`),
    ...over,
  });
  const successorDeps = (calls, over = {}) => ({
    install: h => { calls.push(`install:${h.snapshot.keeperProcesses instanceof Map}`); return { ok: true }; },
    adopt: async () => { calls.push('adopt'); return { expected: 1, adopted: 1, unadopted_live: [] }; },
    adoptionAcceptable: judgeAdoption,
    listen: async (name, handle) => { calls.push(`listen:${name}:${handle?.fake}`); },
    listenFresh: async () => calls.push('listenFresh'),
    started: () => calls.push('started'),
    ...over,
  });
  const fast = { warmMs: 300, adoptMs: 300, listenMs: 300 };

  {
    const { child, self } = pair();
    const p = [], s = [];
    const [pre, suc] = await Promise.all([
      handOver(predecessorDeps(child, p), fast),
      takeOver(self, successorDeps(s), fast),
    ]);
    assert.ok(pre.ok, JSON.stringify(pre));
    assert.equal(pre.successor_pid, 1002);
    assert.deepEqual(p, ['freeze', 'transfer:1002', 'snapshot', 'commit', 'release:forward']);
    assert.ok(suc.ok && suc.committed);
    assert.deepEqual(s, ['install:true', 'adopt', 'listen:rpc:rpc', 'listen:dashboard:dash', 'started']);
    ok('the happy path runs freeze, transfer, adopt, listen, commit in that order');
  }

  {
    const { child } = pair();          // a successor that never says ready
    const p = [];
    const pre = await handOver(predecessorDeps(child, p), fast);
    assert.equal(pre.ok, false);
    assert.equal(pre.stage, 'warm');
    assert.deepEqual(p, [], 'nothing is frozen or transferred for a successor that never warmed');
    assert.notEqual(child.exitCode, null, 'and the successor is killed');
    ok('a successor that never warms costs nothing but itself');
  }

  {
    const { child, self } = pair();
    const p = [];
    const pre = handOver(predecessorDeps(child, p), fast);
    self.send({ type: 'ready', protocol: HANDOVER_PROTOCOL + 1, pid: 1002 });
    const r = await pre;
    assert.equal(r.stage, 'warm');
    assert.match(r.why, /protocol/);
    assert.deepEqual(p, []);
    ok('a successor speaking another protocol is refused before anything freezes');
  }

  {
    const { child, self } = pair();
    const p = [], s = [];
    const [pre] = await Promise.all([
      handOver(predecessorDeps(child, p), fast),
      takeOver(self, successorDeps(s, {
        adopt: async () => ({ expected: 2, adopted: 1, unadopted_live: ['t2'] }) }), fast),
    ]);
    assert.equal(pre.ok, false);
    assert.equal(pre.stage, 'adopt');
    assert.equal(pre.rolled_back, true);
    assert.deepEqual(p, ['freeze', 'transfer:1002', 'snapshot', 'transferBack', 'unfreeze', 'release:local']);
    assert.notEqual(child.exitCode, null);
    ok('an adoption that leaves a running keeper unmanaged rolls everything back');
  }

  {
    const { child, self } = pair();
    const p = [];
    const pre = handOver(predecessorDeps(child, p), fast);
    self.on('message', m => { if (m.type === 'handover') child.kill(); });
    self.send({ type: 'ready', protocol: HANDOVER_PROTOCOL, pid: 1002 });
    const r = await pre;
    assert.equal(r.stage, 'adopt');
    assert.deepEqual(p.slice(-3), ['transferBack', 'unfreeze', 'release:local']);
    ok('a successor that dies mid-adoption is rolled back');
  }

  {
    const { child, self } = pair();
    const p = [];
    const pre = handOver(predecessorDeps(child, p, { freeze: async () => { p.push('freeze'); return { ok: false, why: 'spawns did not settle' }; } }), fast);
    self.send({ type: 'ready', protocol: HANDOVER_PROTOCOL, pid: 1002 });
    const r = await pre;
    assert.equal(r.stage, 'freeze');
    assert.deepEqual(p, ['freeze', 'unfreeze', 'release:local']);
    ok('a freeze that cannot settle is undone without transferring anything');
  }

  {
    const { child, self } = pair();
    const p = [];
    const pre = handOver(predecessorDeps(child, p, {
      transferOwnership: () => { p.push('transfer'); return { ok: false, why: 'lease moved' }; } }), fast);
    self.send({ type: 'ready', protocol: HANDOVER_PROTOCOL, pid: 1002 });
    const r = await pre;
    assert.equal(r.stage, 'transfer');
    assert.ok(!p.includes('transferBack'), 'a failed transfer rolled itself back already');
    assert.deepEqual(p.slice(-2), ['unfreeze', 'release:local']);
    ok('a failed transfer unfreezes without a second rollback');
  }

  {
    const { child, self } = pair();
    const p = [], s = [];
    const [pre] = await Promise.all([
      handOver(predecessorDeps(child, p), fast),
      takeOver(self, successorDeps(s, { listen: async () => { throw new Error('EADDRINUSE'); } }), fast),
    ]);
    assert.equal(pre.stage, 'listen');
    assert.ok(p.includes('transferBack') && !p.includes('commit'));
    ok('a successor that cannot serve on the sockets is rolled back before commit');
  }

  {
    // The predecessor vanishes after transferring: the successor owns the fleet and must
    // take the ports itself rather than leave the fleet owned by a dead pid.
    const { child, self, close } = pair();
    const s = [];
    const suc = takeOver(self, successorDeps(s, {
      adopt: async () => { s.push('adopt'); close(); return { expected: 1, adopted: 1, unadopted_live: [] }; },
    }), fast);
    child.send({ type: 'handover', protocol: HANDOVER_PROTOCOL, ownership: {}, snapshot: { keeperProcesses: new Map() } });
    const r = await suc;
    assert.ok(r.ok && r.orphaned);
    assert.deepEqual(s, ['install:true', 'adopt', 'listenFresh', 'started']);
    ok('an orphaned successor that owns the fleet binds the ports and carries on');
  }

  {
    const { self } = pair();
    const s = [];
    const r = await takeOver(self, successorDeps(s), fast);   // nobody ever hands over
    assert.equal(r.ok, false);
    assert.equal(r.owns, false);
    assert.deepEqual(s, [], 'a successor that never received the fleet never touched it');
    ok('a successor never binds a port or touches a keeper before it owns the fleet');
  }

  {
    assert.equal(judgeAdoption({ expected: 3, adopted: 3, unadopted_live: [] }).ok, true);
    assert.equal(judgeAdoption({ expected: 3, adopted: 2, unadopted_live: [] }).ok, true,
      'a keeper that had already died is no worse off');
    assert.equal(judgeAdoption({ expected: 3, adopted: 2, unadopted_live: ['t3'] }).ok, false);
    assert.equal(judgeAdoption({ expected: 3, adopted: 0, unadopted_live: [] }).ok, false);
    assert.equal(judgeAdoption({ expected: 0, adopted: 0, unadopted_live: [] }).ok, true);
    assert.equal(judgeAdoption(null).ok, false);
    ok('adoption is refused when any running keeper was left unmanaged');
  }

  console.log(`broker-handover-test: ${passed} passed, 0 failed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
