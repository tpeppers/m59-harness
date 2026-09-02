// Persist or publish the newest value after one quiet-independent batching window.
//
// `push()` never resets an existing timer: a busy producer therefore owns one timeout,
// not one clear/allocate pair per event. Values within the window coalesce to the latest.

const systemClock = Object.freeze({
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle),
});

export class DeferredLatest {
  constructor(commit, { delayMs = 30_000, clock = systemClock } = {}) {
    if (typeof commit !== 'function') throw new TypeError('commit must be a function');
    if (!Number.isFinite(delayMs) || delayMs < 0)
      throw new RangeError('delayMs must be a non-negative finite number');
    for (const method of ['setTimeout', 'clearTimeout']) {
      if (typeof clock?.[method] !== 'function')
        throw new TypeError(`clock.${method} must be a function`);
    }
    this.commit = commit;
    this.delayMs = delayMs;
    this.clock = clock;
    this.timer = null;
    this.pending = undefined;
    this.hasPending = false;
  }

  push(value) {
    this.pending = value;
    this.hasPending = true;
    if (this.timer !== null) return false;

    let handle = null;
    const fire = () => {
      // A fake clock or an already-queued native timeout may invoke a cancelled
      // callback. Only the currently owned handle may consume the pending value.
      if (this.timer !== handle) return;
      this.timer = null;
      this.flush();
    };
    handle = this.clock.setTimeout(fire, this.delayMs);
    this.timer = handle;
    handle?.unref?.();
    return true;
  }

  flush(value) {
    if (arguments.length) {
      this.pending = value;
      this.hasPending = true;
    }
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (!this.hasPending) return false;
    const pending = this.pending;
    this.pending = undefined;
    this.hasPending = false;
    this.commit(pending);
    return true;
  }

  cancel() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.pending = undefined;
    this.hasPending = false;
  }
}
