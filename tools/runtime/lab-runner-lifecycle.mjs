// Small, Meridian-free lifecycle helpers for the optional lab CLI. Keeping this
// seam separate makes terminal shard behavior testable without loading an atlas,
// reading a roster, or claiming a fleet.

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function safeCode(value) {
  return typeof value === 'string' && SAFE_CODE.test(value)
    ? value
    : 'M59_SHARD_RUNTIME_FAILED';
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : null;
}

export function publicRuntimeFailure(value) {
  return Object.freeze({
    code: safeCode(value?.code),
    ...(safeId(value?.shard_id) ? { shard_id: value.shard_id } : {}),
  });
}

// Supervisor `failure` can be followed by crash/close/exit notifications for the
// same child. Deliver only the first terminal cause to the runner's stop latch.
export function watchRuntimeFailure(runtime, onFailure) {
  if (!runtime || typeof runtime.on !== 'function') return () => {};
  if (typeof onFailure !== 'function') throw new TypeError('onFailure must be a function');
  let delivered = false;
  const unsubscribe = runtime.on('failure', value => {
    if (delivered) return;
    delivered = true;
    onFailure(publicRuntimeFailure(value));
  });
  return typeof unsubscribe === 'function' ? unsubscribe : () => {};
}

export function publicStartupFailure(value) {
  return Object.freeze({
    id: safeId(value?.id) ?? 'unknown',
    code: safeCode(value?.code ?? value?.error?.code),
    ...(safeId(value?.shard_id) ? { shard_id: value.shard_id } : {}),
  });
}
