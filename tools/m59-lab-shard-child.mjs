#!/usr/bin/env node
// Minimal waiting child for the optional process-sharded lab. It imports no Meridian
// engine until MeridianShardWorker has verified the parent-installed ownership guards.

import {
  ShardChildReporter,
  createShardChildShutdown,
  createChildProcessWorkerTransport,
} from './runtime/shards/index.mjs';
import {
  MeridianShardWorker,
  parseMeridianShardChildArgs,
} from './runtime/shards/meridian-child-runtime.mjs';

let transport = null;
let reporter = null;
let worker = null;
let terminalResolve;
const terminal = new Promise(resolve => { terminalResolve = resolve; });
const shutdown = createShardChildShutdown({
  stop: reason => worker?.stop(reason),
  close: () => transport?.close?.(),
  resolveTerminal: () => terminalResolve(),
});

try {
  if (process.env.M59_LAB_SHARD_CHILD !== '1' || typeof process.send !== 'function')
    throw new Error('lab shard children may only be started by the shard supervisor');
  const launch = parseMeridianShardChildArgs();
  transport = createChildProcessWorkerTransport(process);
  reporter = new ShardChildReporter({
    transport,
    shardId: launch.shardId,
    actorIds: launch.actorIds,
    verifyInit: payload => worker.initialize(payload),
    onStop: reason => worker.stop(reason),
  });
  worker = new MeridianShardWorker({
    shardId: launch.shardId,
    actorIds: launch.actorIds,
    reporter,
  });
  reporter.on('disconnect', details => {
    const expected = details?.previous === 'stopped';
    void shutdown('parent IPC disconnected', expected ? 0 : 1);
  });
  process.once('SIGINT', () => { void shutdown('SIGINT', 0); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM', 0); });

  await reporter.start();
  await reporter.waitForInit();
  console.error(`[lab-shard] ${launch.shardId} managing ${launch.actorIds.length} actor(s)`);
  await terminal;
} catch (error) {
  try { reporter?.reportCrash(error, { origin: 'child-main', fatal: true }); } catch {}
  console.error('[lab-shard] startup or runtime failed');
  await shutdown('child failure', 1);
}
