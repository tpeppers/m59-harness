#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'm59-lab-runner-'));
try {
  const stateFile = join(root, 'lab.json');
  const secret = 'runner-secret-must-not-print';
  writeFileSync(stateFile, JSON.stringify({
    t1: { credentials: {
      account: 'account', password: secret, character: 'Lab One',
      host: '127.0.0.1', port: 15959, lab_runtime: true,
    }, autopilot: { mode: 'survive', policy: {} } },
    t2: { credentials: {
      account: 'account-two', password: 'second-runner-secret', character: 'Lab Two',
      host: '127.0.0.1', port: 15959, lab_runtime: true,
    }, autopilot: { mode: 'survive', policy: {} } },
  }));
  const invoke = (...args) => spawnSync(process.execPath, [
    fileURLToPath(new URL('./m59-lab-runner.mjs', import.meta.url)), ...args,
  ], {
    encoding: 'utf8',
    env: { ...process.env, M59_STATE_FILE: stateFile, M59_TIME_SCALE: '1' },
  });

  const checked = invoke('--fleet', 'lab-one', '--check');
  assert.equal(checked.status, 0, checked.stderr);
  const body = JSON.parse(checked.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.selection.count, 2);
  assert.equal(body.design.decisions, 'event/deadline driven');
  assert.equal((checked.stdout + checked.stderr).includes(secret), false);
  assert.equal(existsSync(`${stateFile}.lock`), false, '--check does not claim the fleet');

  const shardCheck = invoke('--fleet', 'lab-one', '--check', '--shards', '2');
  assert.equal(shardCheck.status, 0, shardCheck.stderr);
  const shardBody = JSON.parse(shardCheck.stdout);
  assert.equal(shardBody.design.shards, 2);
  assert.equal(shardBody.design.assignments.length, 2);
  assert.match(shardBody.design.atlas, /per isolated shard process/);
  assert.equal((shardCheck.stdout + shardCheck.stderr).includes('second-runner-secret'), false);

  writeFileSync(`${stateFile}.lock`, JSON.stringify({
    pid: 2147483646, at: 1, kind: 'broker-runtime', token: 'unguarded-stale-token',
  }));
  const guardedCheck = invoke('--fleet', 'lab-one', '--check');
  assert.equal(guardedCheck.status, 2, guardedCheck.stderr);
  const guardedBody = JSON.parse(guardedCheck.stdout);
  assert.equal(guardedBody.ok, false,
    'a dead broker record without keeper guards is not reported as safe to run');
  assert.equal(guardedBody.lock.reclaimable, false);
  assert.equal(guardedBody.lock.unguarded_broker, true);
  assert.match(guardedBody.lock.why, /surviving sockets cannot be ruled out/);
  rmSync(`${stateFile}.lock`);

  const redirectedRun = invoke('--fleet', 'lab-one', '--run');
  assert.notEqual(redirectedRun.status, 0);
  assert.match(redirectedRun.stderr, /refuses ambient M59_STATE_FILE/);
  assert.equal(existsSync(`${stateFile}.lock`), false,
    'a redirected run is refused before roster or account ownership is claimed');

  const partitionedRun = spawnSync(process.execPath, [
    fileURLToPath(new URL('./m59-lab-runner.mjs', import.meta.url)),
    '--fleet', 'lab-one', '--run',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      M59_STATE_FILE: '',
      M59_ACCOUNT_LEASE_DIR: join(root, 'partitioned-leases'),
      M59_TIME_SCALE: '1',
    },
  });
  assert.notEqual(partitionedRun.status, 0);
  assert.match(partitionedRun.stderr, /refuses ambient M59_ACCOUNT_LEASE_DIR/);
  assert.equal(existsSync(join(root, 'partitioned-leases')), false,
    'namespace override is refused before a second ownership directory is created');

  const scaled = invoke('--fleet', 'lab-one', '--check', '--time-scale', '10');
  assert.notEqual(scaled.status, 0);
  assert.match(scaled.stderr, /server simulation time is not accelerated/);
  const prod = invoke('--fleet', 'prod', '--check');
  assert.notEqual(prod.status, 0);
  assert.match(prod.stderr, /production-like/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('lab runner check mode: PASS');
