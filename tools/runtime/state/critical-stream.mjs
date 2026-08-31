import { immutableStateValue } from './json-value.mjs';

export const CRITICAL_TRANSITION_SCHEMA = 'm59-critical-transition/v1';
export const CRITICAL_BATCH_SCHEMA = 'm59-critical-batch/v1';

function safeSequence(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a non-negative safe integer`);
  return value;
}

function abortError() {
  const error = new Error('critical transition read aborted');
  error.name = 'AbortError';
  return error;
}

// Single-consumer acknowledged stream for transitions that may not be coalesced: deaths,
// room changes, connection loss, and job completion are typical callers. Unacknowledged
// entries are never evicted; reaching maxPending applies producer backpressure instead.
export class AcknowledgedTransitionStream {
  #pending = [];
  #publishedThrough;
  #ackedThrough;
  #deliveredThrough;
  #lastStateRevision = 0;
  #waiter = null;
  #closedError = null;

  constructor({ streamId, sequence = 0, maxPending = 1024, now = Date.now } = {}) {
    if (typeof streamId !== 'string' || !streamId.trim()) throw new TypeError('streamId is required');
    if (!Number.isSafeInteger(maxPending) || maxPending < 1)
      throw new RangeError('maxPending must be a positive safe integer');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.streamId = streamId;
    this.maxPending = maxPending;
    this.now = now;
    this.#publishedThrough = safeSequence(sequence, 'sequence');
    this.#ackedThrough = this.#publishedThrough;
    this.#deliveredThrough = this.#publishedThrough;
  }

  get publishedThrough() { return this.#publishedThrough; }
  get acknowledgedThrough() { return this.#ackedThrough; }
  get pendingCount() { return this.#pending.length; }

  publish(type, payload = {}, { stateRevision = this.#lastStateRevision, atMs = this.now() } = {}) {
    if (this.#closedError) throw this.#closedError;
    if (typeof type !== 'string' || !type.trim()) throw new TypeError('critical transition type is required');
    safeSequence(stateRevision, 'stateRevision');
    safeSequence(atMs, 'atMs');
    if (stateRevision < this.#lastStateRevision)
      throw new RangeError('critical transition state revisions must be monotonic');
    if (this.#pending.length >= this.maxPending) {
      const error = new Error(
        `critical transition backpressure: ${this.maxPending} unacknowledged`);
      error.code = 'M59_TRANSITION_BACKPRESSURE';
      error.pending = this.#pending.length;
      error.limit = this.maxPending;
      throw error;
    }
    if (this.#publishedThrough === Number.MAX_SAFE_INTEGER)
      throw new RangeError('critical transition sequence exhausted');
    const transition = immutableStateValue({
      schema: CRITICAL_TRANSITION_SCHEMA,
      stream_id: this.streamId,
      sequence: ++this.#publishedThrough,
      state_revision: stateRevision,
      at_ms: atMs,
      type: type.trim(),
      payload,
    });
    this.#lastStateRevision = stateRevision;
    this.#pending.push(transition);
    this.#wake();
    return transition;
  }

  #batch(query = {}) {
    const streamId = typeof query.streamId === 'string' ? query.streamId : null;
    const after = query.afterSequence === undefined || query.afterSequence === null
      ? this.#ackedThrough : safeSequence(query.afterSequence, 'afterSequence');
    const limit = query.limit === undefined ? this.maxPending : safeSequence(query.limit, 'limit');
    if (limit < 1) throw new RangeError('limit must be at least 1');
    let gap = null;
    if (streamId !== this.streamId) gap = {
      reason: streamId === null ? 'initial-cursor' : 'stream-changed',
      requested_sequence: after,
      resume_after_sequence: this.#ackedThrough,
      requires_snapshot: true,
    };
    else if (after < this.#ackedThrough) gap = {
      reason: 'sequence-gap', requested_sequence: after,
      resume_after_sequence: this.#ackedThrough, requires_snapshot: true,
    };
    else if (after > this.#publishedThrough) gap = {
      reason: 'consumer-ahead', requested_sequence: after,
      resume_after_sequence: this.#ackedThrough, requires_snapshot: true,
    };
    else if (after > this.#deliveredThrough) gap = {
      reason: 'undelivered-cursor', requested_sequence: after,
      resume_after_sequence: this.#ackedThrough, requires_snapshot: true,
    };
    const transitions = gap ? [] : this.#pending.filter(row => row.sequence > after).slice(0, limit);
    if (!gap && transitions.length)
      this.#deliveredThrough = Math.max(this.#deliveredThrough, transitions.at(-1).sequence);
    return immutableStateValue({
      schema: CRITICAL_BATCH_SCHEMA,
      stream_id: this.streamId,
      acknowledged_through: this.#ackedThrough,
      published_through: this.#publishedThrough,
      transitions,
      ...(gap ? { gap } : {}),
    });
  }

  read(query = {}) {
    if (this.#closedError) throw this.#closedError;
    return this.#batch(query);
  }

  wait(query = {}, { signal } = {}) {
    if (this.#closedError) return Promise.reject(this.#closedError);
    const immediate = this.#batch(query);
    if (immediate.gap || immediate.transitions.length) return Promise.resolve(immediate);
    if (this.#waiter) return Promise.reject(new Error('only one critical-stream read may wait at a time'));
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter = { query, resolve: null, reject: null };
      const onAbort = () => {
        if (this.#waiter !== waiter) return;
        this.#waiter = null;
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiter.resolve = value => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
      waiter.reject = error => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        };
      this.#waiter = waiter;
    });
  }

  #wake() {
    if (!this.#waiter) return;
    const waiter = this.#waiter;
    const batch = this.#batch(waiter.query);
    if (!batch.gap && !batch.transitions.length) return;
    this.#waiter = null;
    waiter.resolve(batch);
  }

  acknowledge(throughSequence) {
    const through = safeSequence(throughSequence, 'throughSequence');
    if (through < this.#ackedThrough) return this.#ackedThrough;
    if (through > this.#deliveredThrough)
      throw new RangeError(`cannot acknowledge undelivered sequence ${through}`);
    this.#ackedThrough = through;
    while (this.#pending.length && this.#pending[0].sequence <= through) this.#pending.shift();
    return this.#ackedThrough;
  }

  close(error = new Error('critical transition stream closed')) {
    if (this.#closedError) return;
    this.#closedError = error;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter.reject(error);
    }
  }
}
