// Terminal cleanup for a real shard process. A failed runtime teardown must keep a
// referenced hard-exit watchdog: closing IPC alone cannot prove Meridian sockets died.

function exitStatus(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 1;
}

export function createShardChildShutdown({
  stop,
  close,
  resolveTerminal,
  processTarget = process,
  hardExitMs = 15_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof stop !== 'function' || typeof close !== 'function' ||
      typeof resolveTerminal !== 'function')
    throw new TypeError('shard child shutdown callbacks are required');
  if (!Number.isSafeInteger(hardExitMs) || hardExitMs < 1)
    throw new RangeError('hardExitMs must be a positive safe integer');

  let shutdownPromise = null;
  return function shutdown(reason, requestedExitCode = 0) {
    if (shutdownPromise) return shutdownPromise;
    const requested = exitStatus(requestedExitCode);
    const watchdog = setTimer(() => processTarget.exit(requested || 1), hardExitMs);
    shutdownPromise = Promise.resolve().then(() => stop(String(reason))).then(
      result => ({ result, clean: result?.ok !== false }),
      () => ({ result: Object.freeze({ ok: false }), clean: false }),
    ).then(({ result, clean }) => {
      processTarget.exitCode = Math.max(processTarget.exitCode ?? 0, requested, clean ? 0 : 1);
      try { close(); } catch {}
      resolveTerminal();
      if (clean) clearTimer(watchdog);
      return result;
    });
    return shutdownPromise;
  };
}
