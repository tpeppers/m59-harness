import { applyStateOperations, diffStateValues, immutableStateValue } from './json-value.mjs';
import { SnapshotStore, STATE_SNAPSHOT_SCHEMA } from './snapshot-store.mjs';

export const STATE_DELTA_SCHEMA = 'm59-state-delta/v1';

function revision(value, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('afterRevision must be a non-negative safe integer or null');
  return value;
}

function queryParts(query = {}) {
  return {
    streamId: typeof query.streamId === 'string' ? query.streamId : null,
    afterRevision: revision(query.afterRevision, { nullable: true }),
  };
}

function abortError() {
  const error = new Error('state read aborted');
  error.name = 'AbortError';
  return error;
}

// Single-consumer latest-value channel. Intermediate observational states are intentionally
// lossy: while one slot is pending, newer publications are re-diffed against its original
// base. A consumer whose cursor cannot use that slot receives an authoritative snapshot.
export class CoalescedStateChannel {
  #store;
  #slot = null;
  #waiter = null;
  #closedError = null;

  constructor({ streamId, stateSchema, initialState, revision = 0, observedAtMs = null } = {}) {
    if (typeof streamId !== 'string' || !streamId.trim()) throw new TypeError('streamId is required');
    this.streamId = streamId;
    this.#store = new SnapshotStore({ stateSchema, initialState, revision, observedAtMs });
  }

  get revision() { return this.#store.revision; }
  get state() { return this.#store.state; }
  get pendingCount() { return this.#slot ? 1 : 0; }

  publish(nextState, options = {}) {
    if (this.#closedError) throw this.#closedError;
    const baseState = this.#store.state;
    const baseRevision = this.#store.revision;
    const result = this.#store.commit(nextState, options);
    if (!result.changed) return result;
    if (!this.#slot) this.#slot = { baseState, baseRevision };
    this.#wake();
    return result;
  }

  #snapshot(reason, requestedRevision) {
    const snapshot = this.#store.snapshot({ repair: {
      reason,
      requested_revision: requestedRevision,
      authoritative_revision: this.#store.revision,
    } });
    return immutableStateValue({ ...snapshot, stream_id: this.streamId });
  }

  #message(query, consume) {
    const { streamId, afterRevision } = queryParts(query);
    let message = null;
    if (streamId !== this.streamId) {
      message = this.#snapshot(streamId === null ? 'initial-snapshot' : 'stream-changed', afterRevision);
    } else if (afterRevision === this.#store.revision) {
      return null;
    } else if (this.#slot && afterRevision === this.#slot.baseRevision) {
      message = immutableStateValue({
        schema: STATE_DELTA_SCHEMA,
        kind: 'delta',
        stream_id: this.streamId,
        state_schema: this.#store.stateSchema,
        base_revision: this.#slot.baseRevision,
        revision: this.#store.revision,
        observed_at_ms: this.#store.observedAtMs,
        coalesced_revisions: this.#store.revision - this.#slot.baseRevision,
        operations: diffStateValues(this.#slot.baseState, this.#store.state),
      });
    } else {
      const reason = afterRevision !== null && afterRevision > this.#store.revision
        ? 'consumer-ahead'
        : 'sequence-gap';
      message = this.#snapshot(reason, afterRevision);
    }
    if (consume) this.#slot = null;
    return message;
  }

  poll(query = {}) {
    if (this.#closedError) throw this.#closedError;
    return this.#message(query, true);
  }

  next(query = {}, { signal } = {}) {
    if (this.#closedError) return Promise.reject(this.#closedError);
    const immediate = this.#message(query, true);
    if (immediate) return Promise.resolve(immediate);
    if (this.#waiter) return Promise.reject(new Error('only one state-channel read may wait at a time'));
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
    const message = this.#message(waiter.query, true);
    if (!message) return;
    this.#waiter = null;
    waiter.resolve(message);
  }

  close(error = new Error('state channel closed')) {
    if (this.#closedError) return;
    this.#closedError = error;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter.reject(error);
    }
  }

  fullSnapshot(reason = 'requested') {
    return this.#snapshot(reason, null);
  }
}

// Consumer-side validation is deliberately fail-closed. A delta is applicable only to its
// exact stream and base revision; any gap leaves the cursor untouched and asks for a full
// snapshot. Full snapshots repair stream restarts as well as dropped/coalesced deliveries.
export function applyStateMessage(cursor, message) {
  if (!message || typeof message !== 'object') throw new TypeError('state message is required');
  if (message.schema === STATE_SNAPSHOT_SCHEMA && message.kind === 'snapshot') {
    if (!Number.isSafeInteger(message.revision) || message.revision < 0)
      throw new TypeError('snapshot revision is invalid');
    if (typeof message.stream_id !== 'string' || typeof message.state_schema !== 'string')
      throw new TypeError('snapshot stream identity is invalid');
    if (!message.state || typeof message.state !== 'object' || Array.isArray(message.state) ||
        (message.state.schema !== undefined && message.state.schema !== message.state_schema))
      throw new TypeError('snapshot state schema is invalid');
    return Object.freeze({
      applied: true,
      needs_snapshot: false,
      cursor: immutableStateValue({
        stream_id: message.stream_id,
        state_schema: message.state_schema,
        revision: message.revision,
        state: message.state,
      }),
    });
  }
  if (message.schema !== STATE_DELTA_SCHEMA || message.kind !== 'delta')
    throw new TypeError('unrecognized state message schema');
  if (!Number.isSafeInteger(message.base_revision) || message.base_revision < 0 ||
      !Number.isSafeInteger(message.revision) || message.revision <= message.base_revision)
    throw new TypeError('delta revision range is invalid');
  if (!cursor || cursor.stream_id !== message.stream_id ||
      cursor.state_schema !== message.state_schema) {
    return Object.freeze({ applied: false, needs_snapshot: true, reason: 'stream-mismatch', cursor });
  }
  if (message.revision <= cursor.revision) {
    return Object.freeze({ applied: false, needs_snapshot: false, reason: 'stale', cursor });
  }
  if (message.base_revision !== cursor.revision) {
    return Object.freeze({ applied: false, needs_snapshot: true, reason: 'sequence-gap', cursor });
  }
  const state = applyStateOperations(cursor.state, message.operations);
  return Object.freeze({
    applied: true,
    needs_snapshot: false,
    cursor: immutableStateValue({
      stream_id: message.stream_id,
      state_schema: message.state_schema,
      revision: message.revision,
      state,
    }),
  });
}
