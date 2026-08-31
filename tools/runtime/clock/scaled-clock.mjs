import { finiteDelay, positiveScale, sleepWith } from './internal.mjs';

const EARLY_EPSILON_MS = 1e-7;

// A continuous simulated-time view over another clock. Deadlines are recorded in
// simulated milliseconds. Changing scale first anchors the current simulated instant,
// then re-arms each outstanding deadline against the new rate; time never jumps.
export class ScaledClock {
  constructor({ clock, scale = 1, startMs = null } = {}) {
    if (!clock || typeof clock.now !== 'function' || typeof clock.setTimeout !== 'function' ||
        typeof clock.clearTimeout !== 'function')
      throw new TypeError('ScaledClock requires a clock with now/setTimeout/clearTimeout');
    this._clock = clock;
    this._scale = positiveScale(scale);
    this._sourceAnchor = clock.now();
    this._simAnchor = startMs == null ? this._sourceAnchor : Number(startMs);
    if (!Number.isFinite(this._simAnchor)) throw new RangeError('startMs must be finite');
    this._nextId = 1;
    this._tasks = new Map();
  }

  get kind() { return 'scaled'; }
  get source() { return this._clock; }
  get scale() { return this._scale; }
  get pendingCount() { return this._tasks.size; }

  now() {
    return this._simAnchor + (this._clock.now() - this._sourceAnchor) * this._scale;
  }

  setScale(value) {
    const scale = positiveScale(value);
    if (scale === this._scale) return this._scale;

    // Read before replacing the old rate: this is the continuity boundary.
    const sourceNow = this._clock.now();
    const simNow = this._simAnchor + (sourceNow - this._sourceAnchor) * this._scale;
    this._sourceAnchor = sourceNow;
    this._simAnchor = simNow;
    this._scale = scale;

    for (const task of this._tasks.values()) {
      if (task.sourceHandle != null) this._clock.clearTimeout(task.sourceHandle);
      task.sourceHandle = null;
      this._arm(task);
    }
    return this._scale;
  }

  setTimeout(callback, delayMs) {
    if (typeof callback !== 'function') throw new TypeError('timer callback must be a function');
    const id = this._nextId++;
    const task = {
      id,
      deadline: this.now() + finiteDelay(delayMs),
      callback,
      sourceHandle: null,
    };
    const handle = Object.freeze({ clock: this, id });
    task.handle = handle;
    this._tasks.set(id, task);
    this._arm(task);
    return handle;
  }

  clearTimeout(handle) {
    if (!handle || handle.clock !== this) return;
    const task = this._tasks.get(handle.id);
    if (!task) return;
    this._tasks.delete(task.id);
    if (task.sourceHandle != null) this._clock.clearTimeout(task.sourceHandle);
    task.sourceHandle = null;
  }

  sleep(delayMs, options) { return sleepWith(this, delayMs, options); }

  snapshot() {
    return Object.freeze({
      kind: this.kind,
      nowMs: this.now(),
      scale: this._scale,
      sourceNowMs: this._clock.now(),
      pending: this._tasks.size,
    });
  }

  _arm(task) {
    if (!this._tasks.has(task.id)) return;
    const remainingSimMs = Math.max(0, task.deadline - this.now());
    task.sourceHandle = this._clock.setTimeout(() => this._wake(task), remainingSimMs / this._scale);
  }

  _wake(task) {
    task.sourceHandle = null;
    if (!this._tasks.has(task.id)) return;
    // A real timer is allowed to fire a fraction early. Never let that make simulated
    // time violate its deadline; re-arm the small remainder instead.
    if (task.deadline - this.now() > EARLY_EPSILON_MS) {
      this._arm(task);
      return;
    }
    this._tasks.delete(task.id);
    task.callback();
  }
}
