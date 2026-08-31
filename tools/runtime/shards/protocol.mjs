import { cloneStateValue, deepFreezeState, immutableStateValue } from '../state/json-value.mjs';
import { safeIpcString, safeIpcValue } from './safe-value.mjs';

export const SHARD_IPC_SCHEMA = 'm59-shard-ipc/v1';
export const SHARD_INIT_SCHEMA = 'm59-shard-init/v1';
export const SHARD_PROTOCOL_VERSION = 1;

export const CHILD_FRAME_KINDS = Object.freeze(new Set([
  'hello', 'init-ack', 'state', 'transition', 'health', 'stop-result', 'crash', 'pong',
]));
export const PARENT_FRAME_KINDS = Object.freeze(new Set([
  'hello-ack', 'state-ack', 'transition-ack', 'health-ack', 'stop', 'ping',
]));

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a non-negative safe integer`);
  return value;
}

export function shardIdentifier(value, label = 'shard id') {
  return safeIpcString(value, { label, maximum: 160 });
}

export function actorIdentifier(value) {
  return safeIpcString(value, { label: 'actor id', maximum: 160 });
}

export function shardFrame(direction, kind, {
  shardId,
  bootId,
  ...fields
} = {}) {
  if (direction !== 'child' && direction !== 'parent')
    throw new TypeError('IPC frame direction must be child or parent');
  const kinds = direction === 'child' ? CHILD_FRAME_KINDS : PARENT_FRAME_KINDS;
  if (!kinds.has(kind)) throw new TypeError(`unsupported ${direction} IPC frame kind`);
  return immutableStateValue({
    schema: SHARD_IPC_SCHEMA,
    protocol_version: SHARD_PROTOCOL_VERSION,
    direction,
    kind,
    shard_id: shardIdentifier(shardId),
    boot_id: shardIdentifier(bootId, 'boot id'),
    ...safeIpcValue(fields),
  });
}

// Initialization is intentionally outside the telemetry schema. Its permit is private
// launch material: callers must never pass it through generic frame logging, snapshots,
// or error serialization. The receiving reporter consumes and drops payload promptly.
export function shardInitFrame({ shardId, bootId, requestId, payload } = {}) {
  return deepFreezeState({
    schema: SHARD_INIT_SCHEMA,
    protocol_version: SHARD_PROTOCOL_VERSION,
    direction: 'parent',
    kind: 'init',
    shard_id: shardIdentifier(shardId),
    boot_id: shardIdentifier(bootId, 'boot id'),
    request_id: safeIpcString(requestId, { label: 'init request id', maximum: 160 }),
    payload: cloneStateValue(payload),
  });
}

export function assertShardInitFrame(value, { shardId, bootId } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.schema !== SHARD_INIT_SCHEMA || value.protocol_version !== SHARD_PROTOCOL_VERSION ||
      value.direction !== 'parent' || value.kind !== 'init')
    throw new TypeError('unrecognized shard initialization frame');
  if (value.shard_id !== shardId || value.boot_id !== bootId)
    throw new TypeError('shard initialization identity mismatch');
  safeIpcString(value.request_id, { label: 'init request id', maximum: 160 });
  return deepFreezeState(cloneStateValue(value));
}

// Direction and identity are checked before any kind-specific payload is inspected.
// Controllers then validate the fields they consume, refusing rather than guessing at
// malformed cursors. The immutable copy also prevents post-validation mutation.
export function assertShardFrame(value, {
  direction,
  shardId = null,
  bootId = null,
} = {}) {
  const frame = safeIpcValue(value);
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) ||
      frame.schema !== SHARD_IPC_SCHEMA ||
      frame.protocol_version !== SHARD_PROTOCOL_VERSION)
    throw new TypeError('unrecognized shard IPC frame');
  if (direction && frame.direction !== direction)
    throw new TypeError('shard IPC frame has the wrong direction');
  const kinds = frame.direction === 'child' ? CHILD_FRAME_KINDS
    : frame.direction === 'parent' ? PARENT_FRAME_KINDS : null;
  if (!kinds?.has(frame.kind)) throw new TypeError('shard IPC frame kind is invalid');
  shardIdentifier(frame.shard_id);
  shardIdentifier(frame.boot_id, 'boot id');
  if (shardId !== null && frame.shard_id !== shardId)
    throw new TypeError('shard IPC frame identity mismatch');
  if (bootId !== null && frame.boot_id !== bootId)
    throw new TypeError('shard IPC frame boot identity mismatch');
  return frame;
}

export function frameSequence(value, label = 'sequence') {
  return nonNegativeInteger(value, label);
}

export function frameTime(value, label = 'frame time') {
  return nonNegativeInteger(value, label);
}

export function normalizedActorIds(values, { maximum = 1000 } = {}) {
  if (!Array.isArray(values)) throw new TypeError('actor_ids must be an array');
  if (values.length > maximum) throw new RangeError(`actor_ids exceeds ${maximum}`);
  const ids = values.map(actorIdentifier);
  if (new Set(ids).size !== ids.length) throw new TypeError('actor_ids contains duplicates');
  return Object.freeze(ids);
}

export function sameActorSet(left, right) {
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
