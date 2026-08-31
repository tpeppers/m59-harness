import { immutableStateValue } from '../state/json-value.mjs';
import { normalizedActorIds } from './protocol.mjs';

export const SHARD_INIT_RESULT_SCHEMA = 'm59-shard-init-result/v1';

const STARTUP_FIELDS = new Set([
  'total', 'started', 'failed', 'failures', 'actor_ids', 'started_actor_ids',
]);
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;

function exactCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a non-negative safe integer`);
  return value;
}

function sameOrdered(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function failureCode(value) {
  return typeof value === 'string' && FAILURE_CODE.test(value)
    ? value
    : 'M59_ACTOR_START_FAILED';
}

// Construct the only startup result allowed into public IPC. Arbitrary exception names
// and messages are intentionally discarded; a stable actor id + bounded code is enough.
export function createShardInitResult({
  actorIds,
  startedActorIds,
  failures = [],
} = {}) {
  const actors = normalizedActorIds(Array.from(actorIds ?? []));
  const started = normalizedActorIds(Array.from(startedActorIds ?? []));
  const actorSet = new Set(actors);
  const startedSet = new Set(started);
  if (started.some(id => !actorSet.has(id)))
    throw new TypeError('started_actor_ids contains an actor outside the shard');
  if (!sameOrdered(started, actors.filter(id => startedSet.has(id))))
    throw new TypeError('started_actor_ids must retain shard actor order');
  if (!Array.isArray(failures)) throw new TypeError('failures must be an array');
  const failureRows = failures.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        typeof row.id !== 'string' || !actorSet.has(row.id) || startedSet.has(row.id))
      throw new TypeError('startup failure actor is invalid');
    return Object.freeze({ id: row.id, code: failureCode(row.code ?? row.error?.code) });
  });
  if (new Set(failureRows.map(row => row.id)).size !== failureRows.length)
    throw new TypeError('startup failures contain duplicate actors');
  const expectedFailed = actors.filter(id => !startedSet.has(id));
  if (!sameOrdered(failureRows.map(row => row.id), expectedFailed))
    throw new TypeError('startup failures must exactly cover non-started actors in shard order');
  return immutableStateValue({
    schema: SHARD_INIT_RESULT_SCHEMA,
    ok: failureRows.length === 0,
    total: actors.length,
    started: started.length,
    failed: failureRows.length,
    actor_ids: actors,
    started_actor_ids: started,
    failures: failureRows,
  });
}

// Parent-side validation reconstructs the result from the expected assignment. A child
// cannot claim an extra actor, omit an assigned failure, or make counts disagree.
export function validateShardInitResult(value, { expectedActorIds } = {}) {
  const actors = normalizedActorIds(Array.from(expectedActorIds ?? []));
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.schema !== SHARD_INIT_RESULT_SCHEMA || typeof value.ok !== 'boolean')
    throw new TypeError('shard initialization result is invalid');
  const reportedActors = normalizedActorIds(value.actor_ids);
  const reportedStarted = normalizedActorIds(value.started_actor_ids);
  const total = exactCount(value.total, 'startup total');
  const started = exactCount(value.started, 'startup started');
  const failed = exactCount(value.failed, 'startup failed');
  if (!sameOrdered(reportedActors, actors) || total !== actors.length ||
      started !== reportedStarted.length || started + failed !== total ||
      value.ok !== (failed === 0))
    throw new TypeError('shard initialization result counts or actors do not match assignment');
  const normalized = createShardInitResult({
    actorIds: actors,
    startedActorIds: reportedStarted,
    failures: value.failures,
  });
  if (normalized.failed !== failed)
    throw new TypeError('shard initialization failure count does not match failures');
  return normalized;
}

// Ownership-only/noop verifiers historically return no actor startup fields. Preserve
// that useful generic contract as full success, but reject an old/partial startup-shaped
// object rather than silently turning it into "all started" again.
export function normalizeVerifierInitResult(value, { expectedActorIds } = {}) {
  const actors = normalizedActorIds(Array.from(expectedActorIds ?? []));
  if (value?.schema === SHARD_INIT_RESULT_SCHEMA)
    return validateShardInitResult(value, { expectedActorIds: actors });
  if (value && typeof value === 'object' &&
      [...STARTUP_FIELDS].some(key => Object.hasOwn(value, key)))
    throw new TypeError('startup-shaped init result must use the shard init result schema');
  return createShardInitResult({ actorIds: actors, startedActorIds: actors, failures: [] });
}
