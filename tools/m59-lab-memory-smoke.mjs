#!/usr/bin/env node
// Offline memory smoke for the shared-process lab runtime.
//
// Loads the real atlas and constructs real Session/managed-Autopilot objects, but never
// starts them and never opens a socket. All actor-writable paths are redirected into one
// freshly-created OS temporary directory and removed after the measurement.
//
//   node --expose-gc tools/m59-lab-memory-smoke.mjs --actors 100


import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

import { configureLabEnvironment } from './runtime/lab-environment.mjs';

function actorCount(argv = process.argv.slice(2)) {
  if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== '--actors'))
    throw new Error('usage: m59-lab-memory-smoke.mjs [--actors 1..1000]');
  const raw = argv.length ? argv[1] : '100';
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000)
    throw new Error('--actors must be an integer from 1 to 1000');
  return value;
}

const mib = bytes => +(bytes / 1024 / 1024).toFixed(1);
const memory = () => {
  globalThis.gc?.();
  const value = process.memoryUsage();
  return Object.freeze({
    rss_mib: mib(value.rss),
    heap_used_mib: mib(value.heapUsed),
    heap_total_mib: mib(value.heapTotal),
    external_mib: mib(value.external),
  });
};

function delta(after, before) {
  return Object.freeze(Object.fromEntries(Object.keys(after).map(key => [
    key,
    +(after[key] - before[key]).toFixed(1),
  ])));
}

function removeVerifiedScratch(path) {
  const target = resolve(path);
  const root = resolve(tmpdir());
  const below = relative(root, target);
  if (!below || below.startsWith('..' + sep) || below === '..' || basename(target).length < 12)
    throw new Error(`refusing to remove unverified benchmark directory: ${target}`);
  rmSync(target, { recursive: true, force: true });
}

const count = actorCount();
const scratch = mkdtempSync(join(tmpdir(), 'm59-lab-memory-smoke-'));
const controllers = [];
const sessions = [];

try {
  configureLabEnvironment({
    fleet: 'memory-smoke',
    stateFile: join(scratch, 'memory-smoke.json'),
  });
  globalThis.fleetState = new Map();
  globalThis.saveFleetState = () => {};
  globalThis.drainExitGaps = () => {};

  const baseline = memory();
  const importedAt = Date.now();
  const [{ Session, geometryStartupMode }, { ManagedAutopilot, disableSessionRecorder }] = await Promise.all([
    import('./m59-session.mjs'),
    import('./runtime/managed-autopilot.mjs'),
  ]);
  const afterImport = memory();

  const actorsAt = Date.now();
  for (let index = 0; index < count; index++) {
    const session = disableSessionRecorder(new Session(`memory-smoke-${index + 1}`));
    const controller = new ManagedAutopilot(session, { mode: 'survive' });
    sessions.push(session);
    controllers.push(controller);
  }
  const afterActors = memory();
  const actorDelta = delta(afterActors, afterImport);

  console.log(JSON.stringify({
    schema: 'm59-lab-memory-smoke/v1',
    actors: count,
    runtime_profile: process.env.M59_RUNTIME_PROFILE ?? null,
    geometry_startup: geometryStartupMode,
    garbage_collection_forced: typeof globalThis.gc === 'function',
    baseline,
    shared_import: {
      elapsed_ms: actorsAt - importedAt,
      memory: afterImport,
      delta: delta(afterImport, baseline),
    },
    actors_constructed: {
      elapsed_ms: Date.now() - actorsAt,
      memory: afterActors,
      delta: actorDelta,
      average_rss_kib: Math.round(actorDelta.rss_mib * 1024 / count),
      average_heap_used_kib: Math.round(actorDelta.heap_used_mib * 1024 / count),
    },
  }, null, 2));
} finally {
  for (const controller of controllers.reverse()) {
    try { controller.stop('memory smoke complete', { hard: true }); } catch {}
  }
  for (const session of sessions.reverse()) {
    try { session.recorder?.stop?.(); } catch {}
  }
  removeVerifiedScratch(scratch);
}
