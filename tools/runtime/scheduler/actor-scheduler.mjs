import { DeadlineHeap } from './deadline-heap.mjs';
import { DirtyReasonSet, mergeDirtyReasons } from './reason-set.mjs';

export const PRIORITY = Object.freeze({ NORMAL: 'normal', SAFETY: 'safety' });

const nativeNow = () => Date.now();
const nativeSetTimer = (fn, ms) => setTimeout(fn, ms);
const nativeClearTimer = handle => clearTimeout(handle);
const nativeDefer = fn => setImmediate(fn);

const positiveInt = (value, fallback, name) => {
  const n = value == null ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`${name} must be a positive integer`);
  return n;
};

const finiteNonNegative = (value, fallback, name) => {
  const n = value == null ? fallback : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`${name} must be a finite non-negative number`);
  return n;
};

// One scheduler can drive a whole fleet. It owns one native deadline timer, while each
// actor owns only small dirty/deadline records. Decisions may overlap across actors but
// never within one actor. Events received during a decision collapse into one rerun.
export class ActorScheduler {
  constructor({
    decide = null,
    coalesceMs = 20,
    maxStartsPerTurn = 8,
    maxConcurrent = Number.POSITIVE_INFINITY,
    maxSafetyBurst = 8,
    now = nativeNow,
    setTimer = nativeSetTimer,
    clearTimer = nativeClearTimer,
    defer = nativeDefer,
    onError = null,
    unrefTimer = true,
  } = {}) {
    if (decide != null && typeof decide !== 'function') throw new TypeError('decide must be a function');
    if (typeof now !== 'function' || typeof setTimer !== 'function' ||
        typeof clearTimer !== 'function' || typeof defer !== 'function')
      throw new TypeError('now, setTimer, clearTimer, and defer must be functions');

    this.defaultDecide = decide;
    this.coalesceMs = finiteNonNegative(coalesceMs, 20, 'coalesceMs');
    this.maxStartsPerTurn = positiveInt(maxStartsPerTurn, 8, 'maxStartsPerTurn');
    this.maxSafetyBurst = positiveInt(maxSafetyBurst, 8, 'maxSafetyBurst');
    this.maxConcurrent = maxConcurrent === Number.POSITIVE_INFINITY
      ? maxConcurrent : positiveInt(maxConcurrent, 1, 'maxConcurrent');
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.defer = defer;
    this.onError = typeof onError === 'function' ? onError : null;
    this.unrefTimer = !!unrefTimer;

    this.actors = new Map();
    this.heap = new DeadlineHeap((a, b) =>
      (a.at - b.at) || (a.priorityRank - b.priorityRank) || (a.sequence - b.sequence));
    this.safetyQueue = [];
    this.normalQueue = [];
    this.safetyHead = 0;
    this.normalHead = 0;
    this.sequence = 0;
    this.actorSequence = 0;
    this.runningCount = 0;
    this.safetyStreak = 0;

    this.timer = null;
    this.timerAt = null;
    this.expiring = false;
    this.drainScheduled = false;
    this.stopped = false;
    this.lifecycle = 1;

    this.counters = {
      wakes: 0,
      safety_wakes: 0,
      coalesced_wakes: 0,
      deadlines_fired: 0,
      decisions_started: 0,
      decisions_completed: 0,
      decision_errors: 0,
      yielded_turns: 0,
      max_running: 0,
      deadline_lateness_samples: 0,
      deadline_lateness_total_ms: 0,
      deadline_lateness_max_ms: 0,
      deadline_lateness_le_1ms: 0,
      deadline_lateness_le_5ms: 0,
      deadline_lateness_le_20ms: 0,
      deadline_lateness_le_100ms: 0,
      deadline_lateness_le_500ms: 0,
      deadline_lateness_le_2000ms: 0,
      deadline_lateness_over_2000ms: 0,
    };
  }

  register(actorId, decide = this.defaultDecide) {
    if (this.stopped) throw new Error('scheduler is stopped permanently');
    if (actorId == null) throw new TypeError('actorId is required');
    if (this.actors.has(actorId)) throw new Error(`actor is already registered: ${String(actorId)}`);
    if (typeof decide !== 'function') throw new TypeError('an actor needs a decide function');

    const state = {
      id: actorId,
      token: ++this.actorSequence,
      decide,
      stopped: false,
      running: false,
      rerun: false,
      run: 0,
      queuedPriority: null,
      queueToken: 0,
      coalesceToken: null,
      deadlines: new Map(),
      normalReasons: new DirtyReasonSet(),
      safetyReasons: new DirtyReasonSet(),
      abort: new AbortController(),
    };
    this.actors.set(actorId, state);

    // Handles capture the registration, not merely its id. A stale handle cannot mutate a
    // later actor that happens to reuse the same id after this one is unregistered.
    return Object.freeze({
      id: actorId,
      wake: (reason = 'wake', options = {}) => this._wakeState(state, reason, options),
      setDeadline: (key, at, reason = `deadline:${String(key)}`, options = {}) =>
        this._setDeadlineState(state, key, at, reason, options),
      clearDeadline: key => this._clearDeadlineState(state, key),
      stop: () => this._stopState(state),
      get running() { return state.running; },
      get stopped() { return state.stopped; },
      get signal() { return state.abort.signal; },
    });
  }

  wake(actorId, reason = 'wake', options = {}) {
    const state = this.actors.get(actorId);
    return state ? this._wakeState(state, reason, options) : false;
  }

  setDeadline(actorId, key, at, reason = `deadline:${String(key)}`, options = {}) {
    const state = this.actors.get(actorId);
    return state ? this._setDeadlineState(state, key, at, reason, options) : false;
  }

  clearDeadline(actorId, key) {
    const state = this.actors.get(actorId);
    return state ? this._clearDeadlineState(state, key) : false;
  }

  unregister(actorId) {
    const state = this.actors.get(actorId);
    return state ? this._stopState(state) : false;
  }

  get stats() {
    return {
      ...this.counters,
      deadline_lateness_mean_ms: this.counters.deadline_lateness_samples
        ? this.counters.deadline_lateness_total_ms / this.counters.deadline_lateness_samples
        : 0,
      actors: this.actors.size,
      running: this.runningCount,
      deadline_nodes: this.heap.size,
      stopped: this.stopped,
    };
  }

  stop() {
    if (this.stopped) return false;
    // Terminal state is visible before anything is cancelled. A timer/deferred callback
    // already queued by the runtime therefore observes stopped/lifecycle and cannot rearm.
    this.stopped = true;
    this.lifecycle++;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = null;
    this.heap.clear();
    this.safetyQueue.length = 0;
    this.normalQueue.length = 0;
    this.safetyHead = this.normalHead = 0;
    this.drainScheduled = false;
    for (const state of this.actors.values()) this._retireState(state);
    this.actors.clear();
    return true;
  }

  _stateIsLive(state) {
    return !this.stopped && !state.stopped && this.actors.get(state.id) === state;
  }

  _priority(options = {}) {
    const p = options.priority ?? (options.safety ? PRIORITY.SAFETY : PRIORITY.NORMAL);
    if (p !== PRIORITY.NORMAL && p !== PRIORITY.SAFETY)
      throw new TypeError(`unknown scheduler priority: ${String(p)}`);
    return p;
  }

  _wakeState(state, reason = 'wake', options = {}) {
    if (!this._stateIsLive(state)) return false;
    const priority = this._priority(options);
    const bag = priority === PRIORITY.SAFETY ? state.safetyReasons : state.normalReasons;
    bag.add(reason);
    this.counters.wakes++;
    if (priority === PRIORITY.SAFETY) this.counters.safety_wakes++;

    if (state.running) {
      if (state.rerun) this.counters.coalesced_wakes++;
      state.rerun = true;
      return true;
    }

    if (priority === PRIORITY.SAFETY) {
      this._cancelCoalesce(state);
      this._queueState(state, PRIORITY.SAFETY);
      return true;
    }

    if (state.queuedPriority != null || state.coalesceToken != null) {
      this.counters.coalesced_wakes++;
      return true;
    }

    const shouldCoalesce = options.coalesce !== false && this.coalesceMs > 0;
    if (shouldCoalesce) this._scheduleCoalesce(state);
    else this._queueState(state, PRIORITY.NORMAL);
    return true;
  }

  _scheduleCoalesce(state) {
    const token = ++this.sequence;
    state.coalesceToken = token;
    this.heap.push({
      kind: 'coalesce', actorId: state.id, actorToken: state.token, token,
      at: this.now() + this.coalesceMs, priority: PRIORITY.NORMAL,
      priorityRank: 1, sequence: token,
    });
    this._armTimer();
  }

  _cancelCoalesce(state) {
    if (state.coalesceToken == null) return;
    state.coalesceToken = null; // heap node is discarded lazily
    this._compactHeapIfNeeded();
    this._armTimer();
  }

  _setDeadlineState(state, key, at, reason, options = {}) {
    if (!this._stateIsLive(state)) return false;
    if (key == null) throw new TypeError('deadline key is required');
    const when = Number(at);
    if (!Number.isFinite(when)) throw new TypeError('deadline time must be finite epoch milliseconds');
    const priority = this._priority(options);
    const token = ++this.sequence;
    const deadline = { token, at: when, reason, priority };
    state.deadlines.set(key, deadline);
    this.heap.push({
      kind: 'deadline', actorId: state.id, actorToken: state.token, key, token,
      at: when, reason, priority, priorityRank: priority === PRIORITY.SAFETY ? 0 : 1,
      sequence: token,
    });
    this._compactHeapIfNeeded();
    this._armTimer();
    return true;
  }

  _clearDeadlineState(state, key) {
    if (!this._stateIsLive(state)) return false;
    const deleted = state.deadlines.delete(key);
    if (deleted) {
      this._compactHeapIfNeeded();
      this._armTimer();
    }
    return deleted;
  }

  _compactHeapIfNeeded() {
    // Replacing a keyed deadline invalidates its old node lazily. Without compaction, a
    // moving actor that continually rearms one far-future deadline could retain every old
    // version behind an unrelated nearer deadline. Keep lazy cancellation cheap while
    // bounding stale storage to a small multiple of live entries.
    let active = 0;
    for (const state of this.actors.values())
      active += state.deadlines.size + (state.coalesceToken == null ? 0 : 1);
    if (this.heap.size <= Math.max(64, active * 2 + 16)) return;
    const fresh = new DeadlineHeap(this.heap.compare);
    for (const node of this.heap.items) if (this._validHeapNode(node)) fresh.push(node);
    this.heap = fresh;
  }

  _validHeapNode(node) {
    const state = this.actors.get(node.actorId);
    if (!state || state.stopped || state.token !== node.actorToken) return false;
    if (node.kind === 'coalesce') return state.coalesceToken === node.token;
    return state.deadlines.get(node.key)?.token === node.token;
  }

  _peekValidDeadline() {
    while (this.heap.size && !this._validHeapNode(this.heap.peek())) this.heap.pop();
    return this.heap.peek();
  }

  _armTimer() {
    if (this.stopped || this.expiring) return;
    const next = this._peekValidDeadline();
    const at = next?.at ?? null;
    if (this.timer != null && this.timerAt === at) return;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = null;
    if (at == null) return;

    const lifecycle = this.lifecycle;
    const handle = this.setTimer(() => {
      if (this.stopped || lifecycle !== this.lifecycle) return;
      this.timer = null;
      this.timerAt = null;
      this._expireDeadlines();
    }, Math.max(0, at - this.now()));
    this.timer = handle;
    this.timerAt = at;
    if (this.unrefTimer) handle?.unref?.();
  }

  _expireDeadlines() {
    if (this.stopped) return;
    this.expiring = true;
    try {
      const now = this.now();
      while (true) {
        const node = this._peekValidDeadline();
        if (!node || node.at > now) break;
        this.heap.pop();
        if (!this._validHeapNode(node)) continue;
        this._observeDeadlineLateness(now - node.at);
        const state = this.actors.get(node.actorId);
        if (node.kind === 'coalesce') {
          state.coalesceToken = null;
          this._queueState(state, PRIORITY.NORMAL);
          continue;
        }
        state.deadlines.delete(node.key);
        this.counters.deadlines_fired++;
        this._wakeState(state, node.reason, { priority: node.priority, coalesce: false });
      }
    } finally {
      this.expiring = false;
      this._armTimer();
    }
  }

  _observeDeadlineLateness(value) {
    const lateness = Math.max(0, Number(value) || 0);
    const counters = this.counters;
    counters.deadline_lateness_samples++;
    counters.deadline_lateness_total_ms += lateness;
    counters.deadline_lateness_max_ms = Math.max(counters.deadline_lateness_max_ms, lateness);
    if (lateness <= 1) counters.deadline_lateness_le_1ms++;
    else if (lateness <= 5) counters.deadline_lateness_le_5ms++;
    else if (lateness <= 20) counters.deadline_lateness_le_20ms++;
    else if (lateness <= 100) counters.deadline_lateness_le_100ms++;
    else if (lateness <= 500) counters.deadline_lateness_le_500ms++;
    else if (lateness <= 2_000) counters.deadline_lateness_le_2000ms++;
    else counters.deadline_lateness_over_2000ms++;
  }

  _queueState(state, priority) {
    if (!this._stateIsLive(state)) return;
    if (state.running) { state.rerun = true; return; }
    if (state.queuedPriority === PRIORITY.SAFETY) return;
    if (state.queuedPriority === PRIORITY.NORMAL && priority === PRIORITY.NORMAL) return;

    state.queuedPriority = priority;
    const entry = { state, token: ++state.queueToken, priority };
    if (priority === PRIORITY.SAFETY) this.safetyQueue.push(entry);
    else this.normalQueue.push(entry);
    this._scheduleDrain();
  }

  _validQueueEntry(entry, priority) {
    const state = entry?.state;
    return !!state && this._stateIsLive(state) && !state.running &&
      state.queuedPriority === priority && state.queueToken === entry.token;
  }

  _peekQueue(priority) {
    const queueName = priority === PRIORITY.SAFETY ? 'safetyQueue' : 'normalQueue';
    const headName = priority === PRIORITY.SAFETY ? 'safetyHead' : 'normalHead';
    let queue = this[queueName];
    let head = this[headName];
    while (head < queue.length && !this._validQueueEntry(queue[head], priority)) head++;
    this[headName] = head;
    // Stale upgrades are normally consumed by shift(), but a queue containing only stale
    // entries has nothing to shift. Compact it here as well so normal->safety promotion
    // cannot retain an unbounded dead prefix.
    if (head > 1024 && head * 2 > queue.length) {
      queue = queue.slice(head);
      this[queueName] = queue;
      this[headName] = head = 0;
    }
    return queue[head] ?? null;
  }

  _shiftQueue(priority) {
    const entry = this._peekQueue(priority);
    if (!entry) return null;
    if (priority === PRIORITY.SAFETY) this.safetyHead++;
    else this.normalHead++;
    this._compactQueue(priority);
    return entry;
  }

  _compactQueue(priority) {
    const queueName = priority === PRIORITY.SAFETY ? 'safetyQueue' : 'normalQueue';
    const headName = priority === PRIORITY.SAFETY ? 'safetyHead' : 'normalHead';
    const queue = this[queueName], head = this[headName];
    if (head > 1024 && head * 2 > queue.length) {
      this[queueName] = queue.slice(head);
      this[headName] = 0;
    }
  }

  _nextQueued() {
    const safety = this._peekQueue(PRIORITY.SAFETY);
    const normal = this._peekQueue(PRIORITY.NORMAL);
    if (!safety && !normal) return null;
    // The burst allowance measures bypasses of ACTUALLY WAITING normal work. Safety that
    // ran while the normal queue was empty must not spend the next batch's allowance.
    if (safety && !normal) {
      this.safetyStreak = 0;
      return this._shiftQueue(PRIORITY.SAFETY);
    }
    if (safety && this.safetyStreak < this.maxSafetyBurst) {
      this.safetyStreak++;
      return this._shiftQueue(PRIORITY.SAFETY);
    }
    this.safetyStreak = 0;
    return this._shiftQueue(PRIORITY.NORMAL);
  }

  _hasQueued() {
    return !!(this._peekQueue(PRIORITY.SAFETY) || this._peekQueue(PRIORITY.NORMAL));
  }

  _scheduleDrain() {
    if (this.stopped || this.drainScheduled) return;
    this.drainScheduled = true;
    const lifecycle = this.lifecycle;
    this.defer(() => {
      if (this.stopped || lifecycle !== this.lifecycle) return;
      this.drainScheduled = false;
      this._drain();
    });
  }

  _drain() {
    if (this.stopped) return;
    let started = 0;
    while (started < this.maxStartsPerTurn && this.runningCount < this.maxConcurrent) {
      const entry = this._nextQueued();
      if (!entry) break;
      entry.state.queuedPriority = null;
      this._startDecision(entry.state);
      started++;
    }
    if (this._hasQueued() && this.runningCount < this.maxConcurrent) {
      this.counters.yielded_turns++;
      this._scheduleDrain();
    }
  }

  _startDecision(state) {
    if (!this._stateIsLive(state) || state.running) return;
    const normal = state.normalReasons.take();
    const safety = state.safetyReasons.take();
    const reasons = mergeDirtyReasons(normal, safety);
    const priority = (safety.mask !== 0 || safety.names.length) ? PRIORITY.SAFETY : PRIORITY.NORMAL;
    state.running = true;
    state.rerun = false;
    state.run++;
    this.runningCount++;
    this.counters.decisions_started++;
    this.counters.max_running = Math.max(this.counters.max_running, this.runningCount);

    const input = Object.freeze({
      actorId: state.id,
      run: state.run,
      priority,
      reasons,
      safety,
      now: this.now(),
      signal: state.abort.signal,
      wake: (reason = 'rerun', options = {}) => this._wakeState(state, reason, options),
      setDeadline: (key, at, reason = `deadline:${String(key)}`, options = {}) =>
        this._setDeadlineState(state, key, at, reason, options),
      clearDeadline: key => this._clearDeadlineState(state, key),
    });

    let outcome;
    try { outcome = state.decide(input); }
    catch (error) { this._finishDecision(state, input, error); return; }
    Promise.resolve(outcome).then(
      () => this._finishDecision(state, input, null),
      error => this._finishDecision(state, input, error),
    );
  }

  _finishDecision(state, input, error) {
    if (!state.running) return;
    state.running = false;
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.counters.decisions_completed++;
    if (error) {
      this.counters.decision_errors++;
      try { this.onError?.(error, input); } catch { /* reporting cannot stop scheduling */ }
    }
    if (!this._stateIsLive(state)) {
      // A stopped actor can still be occupying a finite concurrency slot until its
      // promise settles. Releasing that slot must wake the fleet queue even though this
      // actor's own completion is otherwise stale.
      if (!this.stopped && this._hasQueued()) this._scheduleDrain();
      return;
    }

    if (state.rerun || !state.normalReasons.empty || !state.safetyReasons.empty) {
      const priority = !state.safetyReasons.empty ? PRIORITY.SAFETY : PRIORITY.NORMAL;
      this._queueState(state, priority);
    }
    if (this._hasQueued()) this._scheduleDrain();
  }

  _retireState(state) {
    if (state.stopped) return;
    state.stopped = true;
    state.queueToken++;
    state.queuedPriority = null;
    state.coalesceToken = null;
    state.deadlines.clear();
    state.normalReasons.clear();
    state.safetyReasons.clear();
    state.abort.abort(new Error('actor scheduler stopped'));
  }

  _stopState(state) {
    if (!this._stateIsLive(state)) return false;
    this._retireState(state);
    this.actors.delete(state.id);
    this._compactHeapIfNeeded();
    this._armTimer();
    return true;
  }
}
