import { diffStateValues, immutableStateValue } from './json-value.mjs';

export const STATE_SNAPSHOT_SCHEMA = 'm59-state-snapshot/v1';

function safeRevision(value, label = 'revision') {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
  return value;
}

function observedAt(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('observedAtMs must be a non-negative safe integer');
  return value;
}

export class SnapshotStore {
  #state;
  #revision;
  #observedAtMs;

  constructor({ stateSchema, initialState, revision = 0, observedAtMs = null } = {}) {
    if (typeof stateSchema !== 'string' || !stateSchema.trim())
      throw new TypeError('stateSchema is required');
    this.stateSchema = stateSchema;
    this.#revision = safeRevision(revision);
    this.#observedAtMs = observedAt(observedAtMs);
    this.#state = immutableStateValue(initialState ?? { schema: stateSchema });
    this.#assertSchema(this.#state);
  }

  #assertSchema(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state))
      throw new TypeError('state must be a plain record');
    if (state?.schema !== undefined && state.schema !== this.stateSchema)
      throw new TypeError(`expected state schema ${this.stateSchema}, got ${state.schema}`);
  }

  get state() { return this.#state; }
  get revision() { return this.#revision; }
  get observedAtMs() { return this.#observedAtMs; }

  commit(nextState, { observedAtMs = null } = {}) {
    const candidate = immutableStateValue(nextState);
    this.#assertSchema(candidate);
    const operations = diffStateValues(this.#state, candidate);
    if (!operations.length) return Object.freeze({ changed: false, revision: this.#revision, operations });
    if (this.#revision === Number.MAX_SAFE_INTEGER) throw new RangeError('state revision exhausted');
    const previousRevision = this.#revision;
    this.#state = candidate;
    this.#revision++;
    this.#observedAtMs = observedAt(observedAtMs);
    return Object.freeze({
      changed: true, previousRevision, revision: this.#revision,
      observed_at_ms: this.#observedAtMs, operations,
    });
  }

  snapshot({ repair = null } = {}) {
    return immutableStateValue({
      schema: STATE_SNAPSHOT_SCHEMA,
      kind: 'snapshot',
      state_schema: this.stateSchema,
      revision: this.#revision,
      observed_at_ms: this.#observedAtMs,
      state: this.#state,
      ...(repair ? { repair } : {}),
    });
  }
}
