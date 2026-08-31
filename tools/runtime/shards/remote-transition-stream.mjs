import {
  CRITICAL_BATCH_SCHEMA,
  CRITICAL_TRANSITION_SCHEMA,
} from '../state/index.mjs';
import { immutableStateValue } from '../state/json-value.mjs';
import { frameSequence } from './protocol.mjs';

// Parent-side half of an exact per-actor stream. Receipt does not acknowledge delivery:
// acknowledge() is intentionally the only operation that sends an ACK to the child.
export class RemoteTransitionStream {
  constructor({ actorId, maxPending = 128, acknowledge } = {}) {
    if (typeof actorId !== 'string' || !actorId) throw new TypeError('actorId is required');
    if (!Number.isSafeInteger(maxPending) || maxPending < 1)
      throw new RangeError('maxPending must be a positive safe integer');
    if (typeof acknowledge !== 'function') throw new TypeError('acknowledge callback is required');
    this.actorId = actorId;
    this.maxPending = maxPending;
    this.onAcknowledge = acknowledge;
    this.streamId = null;
    this.pending = [];
    this.receivedThrough = 0;
    this.deliveredThrough = 0;
    this.acknowledgedThrough = 0;
  }

  setStreamId(streamId) {
    if (typeof streamId !== 'string' || !streamId)
      throw new TypeError('transition stream id is required');
    if (this.streamId && this.streamId !== streamId)
      throw new Error('transition stream identity changed within one child boot');
    this.streamId = streamId;
  }

  accept(transition) {
    if (!transition || typeof transition !== 'object' || Array.isArray(transition) ||
        transition.schema !== CRITICAL_TRANSITION_SCHEMA)
      throw new TypeError('invalid critical transition');
    if (!this.streamId || transition.stream_id !== this.streamId)
      throw new TypeError('critical transition stream identity mismatch');
    const sequence = frameSequence(transition.sequence, 'transition sequence');
    frameSequence(transition.state_revision, 'transition state revision');
    frameSequence(transition.at_ms, 'transition time');
    if (sequence <= this.receivedThrough) {
      if (sequence <= this.acknowledgedThrough)
        this.onAcknowledge(this.acknowledgedThrough);
      return Object.freeze({ accepted: false, duplicate: true, sequence });
    }
    if (sequence !== this.receivedThrough + 1)
      throw new Error('critical transition sequence gap');
    if (this.pending.length >= this.maxPending) {
      const error = new Error('parent transition receive window is full');
      error.code = 'M59_SHARD_PARENT_BACKPRESSURE';
      throw error;
    }
    const copy = immutableStateValue(transition);
    this.pending.push(copy);
    this.receivedThrough = sequence;
    return Object.freeze({ accepted: true, duplicate: false, sequence, transition: copy });
  }

  read(query = {}) {
    const requestedStream = typeof query.streamId === 'string' ? query.streamId : null;
    const after = query.afterSequence == null
      ? this.acknowledgedThrough
      : frameSequence(query.afterSequence, 'afterSequence');
    const limit = query.limit == null ? this.maxPending : frameSequence(query.limit, 'limit');
    if (limit < 1) throw new RangeError('limit must be at least 1');
    let gap = null;
    if (requestedStream !== this.streamId) gap = {
      reason: requestedStream === null ? 'initial-cursor' : 'stream-changed',
      requested_sequence: after,
      resume_after_sequence: this.acknowledgedThrough,
      requires_snapshot: true,
    };
    else if (after < this.acknowledgedThrough) gap = {
      reason: 'sequence-gap', requested_sequence: after,
      resume_after_sequence: this.acknowledgedThrough, requires_snapshot: true,
    };
    else if (after > this.receivedThrough) gap = {
      reason: 'consumer-ahead', requested_sequence: after,
      resume_after_sequence: this.acknowledgedThrough, requires_snapshot: true,
    };
    else if (after > this.deliveredThrough) gap = {
      reason: 'undelivered-cursor', requested_sequence: after,
      resume_after_sequence: this.acknowledgedThrough, requires_snapshot: true,
    };
    const transitions = gap ? [] : this.pending.filter(row => row.sequence > after).slice(0, limit);
    if (!gap && transitions.length)
      this.deliveredThrough = Math.max(this.deliveredThrough, transitions.at(-1).sequence);
    return immutableStateValue({
      schema: CRITICAL_BATCH_SCHEMA,
      stream_id: this.streamId,
      acknowledged_through: this.acknowledgedThrough,
      published_through: this.receivedThrough,
      transitions,
      ...(gap ? { gap } : {}),
    });
  }

  acknowledge(throughSequence) {
    const through = frameSequence(throughSequence, 'throughSequence');
    if (through <= this.acknowledgedThrough) return this.acknowledgedThrough;
    if (through > this.deliveredThrough)
      throw new RangeError(`cannot acknowledge undelivered sequence ${through}`);
    this.acknowledgedThrough = through;
    while (this.pending.length && this.pending[0].sequence <= through) this.pending.shift();
    this.onAcknowledge(through);
    return through;
  }

  get pendingCount() { return this.pending.length; }
  get publishedThrough() { return this.receivedThrough; }
}
