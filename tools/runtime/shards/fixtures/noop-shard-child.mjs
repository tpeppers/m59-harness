#!/usr/bin/env node
// Real child_process.fork fixture for the shard control plane. It verifies temporary
// ownership guards and publishes synthetic state, but imports no Meridian/game modules.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { ShardChildReporter } from '../child-reporter.mjs';
import { verifyShardPermit } from '../ownership.mjs';
import { createChildProcessWorkerTransport } from '../transport.mjs';

const INIT_SCHEMA = 'm59-noop-shard-init/v1';

function argumentsFrom(argv) {
  let shardId = null;
  let actorIds = null;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value == null) throw new Error('noop shard fixture option is missing a value');
    if (flag === '--shard-id') shardId = String(value);
    else if (flag === '--agents') actorIds = String(value).split(',').filter(Boolean);
    else throw new Error('noop shard fixture received an unknown option');
  }
  if (!/^shard-[1-9][0-9]*$/.test(shardId ?? '') || !actorIds?.length ||
      new Set(actorIds).size !== actorIds.length)
    throw new Error('noop shard fixture assignment is invalid');
  return Object.freeze({ shardId, actorIds: Object.freeze(actorIds) });
}

function exactEntries(stateFile, wantedIds) {
  const document = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (!Array.isArray(document?.entries)) throw new Error('noop fixture roster is invalid');
  const byId = new Map(document.entries.map(entry => [entry?.id, entry]));
  const entries = wantedIds.map(id => byId.get(id));
  if (entries.some(entry => !entry)) throw new Error('noop fixture actor is missing');
  return entries;
}

if (process.env.M59_LAB_SHARD_CHILD !== '1' || typeof process.send !== 'function')
  throw new Error('noop shard fixture requires supervised IPC');

const launch = argumentsFrom(process.argv.slice(2));
const transport = createChildProcessWorkerTransport(process);
let reporter;
let resolveClosed;
const closed = new Promise(resolvePromise => { resolveClosed = resolvePromise; });

reporter = new ShardChildReporter({
  transport,
  shardId: launch.shardId,
  actorIds: launch.actorIds,
  verifyInit(payload) {
    if (!payload || payload.schema !== INIT_SCHEMA || payload.shard_id !== launch.shardId ||
        Object.hasOwn(payload, 'entries') || Object.hasOwn(payload, 'credentials'))
      throw Object.assign(new Error('noop shard init was refused'), { code: 'NOOP_INIT_INVALID' });
    if (!Array.isArray(payload.actor_ids) || payload.actor_ids.length !== launch.actorIds.length ||
        payload.actor_ids.some((id, index) => id !== launch.actorIds[index]))
      throw Object.assign(new Error('noop shard assignment changed'), { code: 'NOOP_ACTORS_CHANGED' });
    const stateFile = resolve(payload.state_file);
    const lockFile = resolve(payload.lock_file);
    const entries = exactEntries(stateFile, launch.actorIds);
    const leaseDir = resolve(payload.lease_dir ?? dirname(payload.permit?.accounts?.[0]?.path ?? ''));
    const verified = verifyShardPermit({
      permit: payload.permit,
      entries,
      childPid: process.pid,
      expectedStateFile: stateFile,
      expectedLockFile: lockFile,
      leaseDir,
    });
    if (!verified.ok)
      throw Object.assign(new Error('noop shard ownership verification failed'), {
        code: 'NOOP_OWNERSHIP_REFUSED',
      });
    for (const actorId of launch.actorIds) {
      reporter.publishState(actorId, {
        schema: 'm59-noop-shard-state/v1',
        actor_id: actorId,
        ready: true,
        process_id: process.pid,
      });
    }
    reporter.publishHealth('running', { actors: launch.actorIds.length });
    return Object.freeze({ ok: true });
  },
  onStop() {
    reporter.publishHealth('stopping', { actors: launch.actorIds.length });
  },
});

reporter.on('disconnect', resolveClosed);
await reporter.start();
await reporter.waitForInit();
await closed;
