// A compact dirty-reason accumulator.
//
// Hot protocol paths normally know their reasons as bit flags; diagnostics and less
// performance-sensitive callers tend to have names. Keeping both avoids allocating a
// Set for every bit-only wake while preserving useful explanations at the decision edge.

export class DirtyReasonSet {
  constructor(seed = null) {
    this.mask = 0;
    this.names = new Set();
    if (seed != null) this.add(seed);
  }

  get empty() { return this.mask === 0 && this.names.size === 0; }

  add(reason) {
    if (reason == null) return this;

    if (typeof reason === 'number') {
      if (!Number.isInteger(reason)) throw new TypeError('a numeric dirty reason must be an integer bit mask');
      this.mask = (this.mask | (reason >>> 0)) >>> 0;
      return this;
    }

    if (typeof reason === 'string') {
      if (reason) this.names.add(reason);
      return this;
    }

    if (Array.isArray(reason) || reason instanceof Set) {
      for (const item of reason) this.add(item);
      return this;
    }

    if (typeof reason === 'object') {
      if (reason.mask != null) this.add(reason.mask);
      const names = reason.names ?? reason.reasons;
      if (names != null) this.add(Array.isArray(names) || names instanceof Set ? names : [names]);
      return this;
    }

    throw new TypeError(`unsupported dirty reason: ${typeof reason}`);
  }

  clear() {
    this.mask = 0;
    this.names.clear();
  }

  snapshot() {
    return { mask: this.mask >>> 0, names: [...this.names] };
  }

  take() {
    const out = this.snapshot();
    this.clear();
    return out;
  }
}

export function mergeDirtyReasons(...parts) {
  const out = new DirtyReasonSet();
  for (const part of parts) out.add(part);
  return out.snapshot();
}
