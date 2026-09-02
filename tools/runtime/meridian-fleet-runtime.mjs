// Shared construction policy for one-process and process-sharded Meridian labs.
// This module is atlas-free: the caller supplies the dynamically imported actor factory.

import { RealClock } from './clock/index.mjs';
import { FleetRuntime } from './fleet-runtime.mjs';
import { PRIMARY_STATE_SCHEMA, projectPrimaryState } from './state/index.mjs';

function positiveInteger(value, fallback, label) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new RangeError(`${label} must be a positive safe integer`);
  return number;
}

export function initialMeridianActorState(entry, id, { driver = 'lab-runtime' } = {}) {
  return projectPrimaryState({
    agent: id,
    character: entry?.credentials?.character ?? null,
    connected: false,
    in_game: false,
    socket: { phase: 'pending' },
    activity: {
      driver,
      mode: entry?.autopilot?.mode ?? 'survive',
      running: false,
    },
  });
}

export function createMeridianFleetRuntime({
  entries,
  actorFactory,
  runtimeId,
  startupConcurrency = 2,
  clock = new RealClock(),
  driver = 'lab-runtime',
  onStateChanged = null,
  transitionSink = null,
} = {}) {
  if (!Array.isArray(entries) || !entries.length)
    throw new TypeError('Meridian fleet runtime requires actor entries');
  if (typeof actorFactory !== 'function') throw new TypeError('actorFactory is required');
  const concurrency = positiveInteger(startupConcurrency, 2, 'startupConcurrency');
  return new FleetRuntime({
    runtimeId,
    entries,
    startupConcurrency: concurrency,
    snapshotCoalesceMs: 250,
    clock,
    schedulerOptions: {
      // A pass may await travel while consuming no CPU. Fairness is enforced at launch
      // and per actor; the independent safety scheduler remains bounded below.
      coalesceMs: 25,
      maxStartsPerTurn: 8,
      maxSafetyBurst: 8,
      maxConcurrent: entries.length,
    },
    safetySchedulerOptions: {
      coalesceMs: 0, maxStartsPerTurn: 8, maxSafetyBurst: 8, maxConcurrent: 8,
    },
    stateSchema: PRIMARY_STATE_SCHEMA,
    initialState: (entry, id) => initialMeridianActorState(entry, id, { driver }),
    maxPendingTransitions: 2048,
    actorFactory,
    onStateChanged,
    transitionSink,
  });
}
