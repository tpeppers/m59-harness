// Shared validation and Promise plumbing for the clock implementations.

export function finiteDelay(value, label = 'delayMs') {
  const delay = Number(value);
  if (!Number.isFinite(delay) || delay < 0)
    throw new RangeError(`${label} must be a finite number greater than or equal to zero`);
  return delay;
}

export function positiveScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale <= 0)
    throw new RangeError('scale must be a finite number greater than zero');
  return scale;
}

export function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error(reason == null ? 'The operation was aborted' : String(reason));
  error.name = 'AbortError';
  return error;
}

export function sleepWith(clock, delayMs, { signal } = {}) {
  const delay = finiteDelay(delayMs);
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));

  return new Promise((resolve, reject) => {
    let settled = false;
    let handle = null;
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (handle != null) clock.clearTimeout(handle);
      cleanup();
      reject(abortError(signal.reason));
    };

    handle = clock.setTimeout(finish, delay);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    // An AbortSignal can be tripped by unusual user code while addEventListener is
    // installing. Checking again closes that otherwise tiny lost-wakeup window.
    if (signal?.aborted) onAbort();
  });
}
