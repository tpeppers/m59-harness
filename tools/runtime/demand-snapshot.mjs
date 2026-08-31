// A bounded-staleness snapshot with no background timer.
//
// Readers pay for a projection only when the previous one is too old. An idle or
// unobserved actor therefore performs no work, while a burst of readers shares one value.

export class DemandSnapshot {
  constructor(build, { maxAgeMs = 2_000, maxStaleMs = maxAgeMs, now = Date.now } = {}) {
    if (typeof build !== 'function') throw new TypeError('build must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)
      throw new RangeError('maxAgeMs must be a non-negative finite number');
    if (!Number.isFinite(maxStaleMs) || maxStaleMs < maxAgeMs)
      throw new RangeError('maxStaleMs must be finite and no smaller than maxAgeMs');
    this.build = build;
    this.maxAgeMs = maxAgeMs;
    this.maxStaleMs = maxStaleMs;
    this.now = now;
    this.value = undefined;
    this.at = null;
  }

  get hasValue() { return this.at !== null; }

  read({ fresh = false } = {}) {
    const requestedAt = this.now();
    const expired = !this.hasValue || requestedAt - this.at >= this.maxAgeMs;
    let refreshed = false;
    let refreshError = null;
    if (fresh || expired) {
      try {
        const value = this.build();
        const completedAt = this.now();
        this.value = value;
        this.at = completedAt;
        refreshed = true;
      } catch (error) {
        refreshError = error;
        if (!this.hasValue) throw error;
        // A last-good value is useful for a short projection hiccup, but it is not allowed
        // to become an unbounded success response. Callers that need a looser bound choose
        // one explicitly; once it is crossed, the build failure is the result.
        if (this.now() - this.at > this.maxStaleMs) throw error;
      }
    }
    const observedAt = this.now();
    return {
      value: this.value,
      at: this.at,
      ageMs: Math.max(0, observedAt - this.at),
      refreshed,
      refreshError,
    };
  }

  invalidate() { this.at = null; }
}
