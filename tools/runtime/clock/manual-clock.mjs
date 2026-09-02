import { finiteDelay, sleepWith } from './internal.mjs';

const DEFAULT_CALLBACK_LIMIT = 100_000;

// A deterministic clock for scheduler tests. Advancing it runs every deadline crossed,
// including a zero-delay deadline installed by another callback at the same instant.
export class ManualClock {
  constructor({ startMs = 0 } = {}) {
    const start = Number(startMs);
    if (!Number.isFinite(start)) throw new RangeError('startMs must be finite');
    this._now = start;
    this._nextId = 1;
    this._nextOrder = 1;
    this._tasks = new Map();
    this._queue = [];
  }

  get kind() { return 'manual'; }
  get pendingCount() { return this._tasks.size; }
  now() { return this._now; }

  setTimeout(callback, delayMs) {
    if (typeof callback !== 'function') throw new TypeError('timer callback must be a function');
    const task = {
      id: this._nextId++,
      order: this._nextOrder++,
      due: this._now + finiteDelay(delayMs),
      callback,
      cancelled: false,
    };
    const handle = Object.freeze({ clock: this, id: task.id });
    task.handle = handle;
    this._tasks.set(task.id, task);
    this._queue.push(task);
    this._queue.sort((a, b) => a.due - b.due || a.order - b.order);
    return handle;
  }

  clearTimeout(handle) {
    if (!handle || handle.clock !== this) return;
    const task = this._tasks.get(handle.id);
    if (!task) return;
    task.cancelled = true;
    this._tasks.delete(task.id);
  }

  sleep(delayMs, options) { return sleepWith(this, delayMs, options); }

  advanceBy(deltaMs, options) {
    return this.advanceTo(this._now + finiteDelay(deltaMs, 'deltaMs'), options);
  }

  advanceTo(targetMs, { maxCallbacks = DEFAULT_CALLBACK_LIMIT } = {}) {
    const target = Number(targetMs);
    if (!Number.isFinite(target)) throw new RangeError('targetMs must be finite');
    if (target < this._now) throw new RangeError('a ManualClock cannot move backwards');
    const limit = callbackLimit(maxCallbacks);
    let fired = 0;

    for (;;) {
      const next = this._peek();
      if (!next || next.due > target) break;
      if (fired >= limit)
        throw new Error(`ManualClock exceeded its ${limit}-callback advance limit`);
      this._queue.shift();
      if (next.cancelled || !this._tasks.delete(next.id)) continue;
      this._now = next.due;
      fired++;
      next.callback();
    }
    this._now = target;
    return fired;
  }

  // Run exactly one pending callback. Unlike advanceTo(), callbacks sharing its deadline
  // remain queued; this makes stepping a scheduler in a debugger unambiguous.
  runNext() {
    const next = this._peek();
    if (!next) return false;
    this._queue.shift();
    if (next.cancelled || !this._tasks.delete(next.id)) return this.runNext();
    this._now = next.due;
    next.callback();
    return true;
  }

  runUntilIdle({ maxCallbacks = DEFAULT_CALLBACK_LIMIT } = {}) {
    const limit = callbackLimit(maxCallbacks);
    let fired = 0;
    while (this._peek()) {
      if (fired >= limit)
        throw new Error(`ManualClock exceeded its ${limit}-callback idle limit`);
      if (this.runNext()) fired++;
    }
    return fired;
  }

  _peek() {
    while (this._queue.length) {
      const next = this._queue[0];
      if (!next.cancelled && this._tasks.has(next.id)) return next;
      this._queue.shift();
    }
    return null;
  }
}

function callbackLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError('maxCallbacks must be a positive safe integer');
  return limit;
}
