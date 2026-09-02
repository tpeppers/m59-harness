// One character as an interrupt/deadline-driven actor.
//
// Gameplay decisions use the fleet's bounded normal scheduler. Health, socket,
// watchdog, critical-delivery, and cheap state-projection work use a separate reserved
// scheduler so a handful of long actions cannot blind the rest of the fleet.

import { classifyClientEvent, primaryVitalSnapshot } from './primary-source.mjs';

const nativeClock = Object.freeze({ now: () => Date.now() });
const CRITICAL_EVENT_KINDS = new Set(['death', 'disconnected', 'closed']);

function positive(value, fallback, name) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new RangeError(`${name} must be positive`);
  return n;
}

function nonNegative(value, fallback, name) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isFinite(n) || n < 0)
    throw new RangeError(`${name} must be finite and non-negative`);
  return n;
}

function actorStopped(id) {
  const error = new Error(`actor ${id} stopped while an asynchronous operation was pending`);
  error.name = 'AbortError';
  error.code = 'M59_ACTOR_STOPPED';
  return error;
}

function transitionPayload(event, reason) {
  const payload = { reason };
  for (const [from, to = from] of [
    ['seq'], ['at'], ['room'], ['roomName', 'room_name'], ['name'], ['value'],
  ]) {
    const value = event?.[from];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value))
      payload[to] = value;
  }
  return payload;
}

export class SessionActor {
  constructor({
    id,
    session,
    controller,
    scheduler,
    safetyScheduler = scheduler,
    project,
    publish = null,
    publishTransition = null,
    clock = nativeClock,
    reconcileMs = 8000,
    disconnectedReconcileMs = 30000,
    passWatchMs = 8000,
    statePublishMs = 1000,
    decisionMinMs = null,
    decisionFailureBackoffMs = 5000,
    reconnect = true,
    reconnectBaseMs = 5000,
    reconnectMaxMs = 120000,
    contentionWindowMs = 90000,
    contentionBaseMs = 30000,
    contentionMaxMs = 900000,
    transitionRetryMs = 250,
    criticalBacklogTripLimit = 256,
    classifyEvent = classifyClientEvent,
  } = {}) {
    if (!id) throw new TypeError('SessionActor requires id');
    if (!session) throw new TypeError('SessionActor requires session');
    if (!controller) throw new TypeError('SessionActor requires controller');
    if (!scheduler?.register) throw new TypeError('SessionActor requires an ActorScheduler');
    if (!safetyScheduler?.register)
      throw new TypeError('SessionActor requires a safety ActorScheduler');
    if (typeof project !== 'function') throw new TypeError('SessionActor requires project()');
    if (publish != null && typeof publish !== 'function')
      throw new TypeError('publish must be a function');
    if (publishTransition != null && typeof publishTransition !== 'function')
      throw new TypeError('publishTransition must be a function');

    this.id = id;
    this.session = session;
    this.controller = controller;
    this.scheduler = scheduler;
    this.safetyScheduler = safetyScheduler;
    this.project = project;
    this.publish = publish;
    this.publishTransition = publishTransition;
    this.clock = clock;
    this.reconcileMs = positive(reconcileMs, 8000, 'reconcileMs');
    this.disconnectedReconcileMs = positive(
      disconnectedReconcileMs, 30000, 'disconnectedReconcileMs');
    this.passWatchMs = positive(passWatchMs, 8000, 'passWatchMs');
    this.statePublishMs = positive(statePublishMs, 1000, 'statePublishMs');
    this.decisionMinMs = decisionMinMs == null
      ? null : nonNegative(decisionMinMs, 1000, 'decisionMinMs');
    // The legacy keeper slept five seconds after a thrown pass. ManagedAutopilot
    // returns that failure instead of throwing it, so the actor must retain the same
    // ordinary-lane brake or an accumulated rerun can turn a fault into a hot loop.
    this.decisionFailureBackoffMs = positive(
      decisionFailureBackoffMs, 5000, 'decisionFailureBackoffMs');
    this.reconnectEnabled = reconnect !== false;
    this.reconnectBaseMs = positive(reconnectBaseMs, 5000, 'reconnectBaseMs');
    this.reconnectMaxMs = positive(reconnectMaxMs, 120000, 'reconnectMaxMs');
    this.contentionWindowMs = nonNegative(
      contentionWindowMs, 90000, 'contentionWindowMs');
    this.contentionBaseMs = positive(contentionBaseMs, 30000, 'contentionBaseMs');
    this.contentionMaxMs = positive(contentionMaxMs, 900000, 'contentionMaxMs');
    this.transitionRetryMs = positive(transitionRetryMs, 250, 'transitionRetryMs');
    this.criticalBacklogTripLimit = positive(
      criticalBacklogTripLimit, 256, 'criticalBacklogTripLimit');
    if (this.reconnectMaxMs < this.reconnectBaseMs)
      throw new RangeError('reconnectMaxMs must be at least reconnectBaseMs');
    if (this.contentionMaxMs < this.contentionBaseMs)
      throw new RangeError('contentionMaxMs must be at least contentionBaseMs');
    this.classifyEvent = classifyEvent;

    this.started = false;
    this.stopped = false;
    this.lifecycleGeneration = 1;
    this.startPromise = null;
    this.reconnectPromise = null;
    this.lastHealth = null;
    this.lastVitals = primaryVitalSnapshot(session.client?.vitals?.() ?? {});
    this.lastEvent = null;
    this.lastDecision = null;
    this.lastDecisionStartedAt = null;
    this.decisionFailureNotBefore = 0;
    this.lastPublished = null;
    this.lastEventError = null;
    this.lastTransitionError = null;
    this.credentials = null;
    this.reconnectAttempts = 0;
    this.reconnectNotBefore = 0;
    this.contentionStrikes = 0;
    this.connectionGeneration = session.live ? 1 : 0;
    this.lastDisconnectedGeneration = null;
    this.lastConnectedAt = session.live ? this.clock.now() : null;
    this.decisionInFlight = false;
    this.pendingDecisionReasons = new Set();
    this.pendingStateReasons = new Set();
    this.pendingStateForce = false;
    this.statePublishAt = null;
    this.criticalBacklog = [];
    this.pausedSocket = null;
    this.closedClients = new WeakSet();
    this.clientEventOwner = null;
    this.previousClientEvent = null;
    this.clientSocketOwner = null;
    this.clientSocketClose = null;

    this.schedulerId = `session-actor:${encodeURIComponent(id)}`;
    this.decisionHandle = scheduler.register(
      `${this.schedulerId}:decision`, input => this._decide(input));
    this.safetyHandle = safetyScheduler.register(
      `${this.schedulerId}:safety`, input => this._safety(input));
    this.stateHandle = safetyScheduler.register(
      `${this.schedulerId}:state`, input => this._publishStateLane(input));
  }

  start(options = {}) {
    if (this.stopped) return Promise.reject(actorStopped(this.id));
    if (this.started) return Promise.resolve(this.snapshot());
    if (this.startPromise) return this.startPromise;
    const generation = this.lifecycleGeneration;
    let pending;
    pending = (async () => {
      try { return await this._start(options, generation); }
      finally { if (this.startPromise === pending) this.startPromise = null; }
    })();
    this.startPromise = pending;
    return pending;
  }

  async _start({ credentials = null, join = true } = {}, generation) {
    this.credentials = credentials ?? this.credentials;
    if (join) {
      if (!credentials) throw new TypeError(`actor ${this.id} needs credentials to join`);
      await this.session.join(credentials);
      this._assertActive(generation);
    }
    this._assertActive(generation);
    this._attachClientEvents();
    this.lastVitals = primaryVitalSnapshot(this.session.client?.vitals?.() ?? {});
    const health = Number(this.lastVitals.health?.value);
    if (Number.isFinite(health)) this.lastHealth = health;
    await this.controller.start?.();
    this._assertActive(generation);
    this.started = true;
    if (this.session.live) this._markConnected();
    this.publishPrimary('started', { force: true });
    this._wakeDecision('started', { immediate: true });
    return this.snapshot();
  }

  _assertActive(generation) {
    if (!this.stopped && generation === this.lifecycleGeneration) return;
    this._destroySessionClient();
    throw actorStopped(this.id);
  }

  _attachClientEvents() {
    const client = this.session.client;
    if (!client || client === this.clientEventOwner) return;
    this._detachClientEvents();
    const previous = client.onEvent;
    this.clientEventOwner = client;
    this.previousClientEvent = previous;
    const wrapper = event => {
      try { previous?.(event); }
      finally {
        try { this.onClientEvent(event); }
        catch (error) {
          this.lastEventError = { at: this.clock.now(), message: error?.message ?? String(error) };
        }
      }
    };
    wrapper.__runtimeActor = this;
    client.onEvent = wrapper;
    const socket = client.sock;
    if (socket?.on) {
      const onClose = () => {
        try { this.onClientEvent({ kind: 'closed', at: this.clock.now() }); }
        catch (error) {
          this.lastEventError = { at: this.clock.now(), message: error?.message ?? String(error) };
        }
      };
      socket.on('close', onClose);
      this.clientSocketOwner = socket;
      this.clientSocketClose = onClose;
    }
  }

  _detachClientEvents() {
    if (this.clientEventOwner?.onEvent) {
      const owner = this.clientEventOwner;
      if (owner.onEvent.__runtimeActor === this) owner.onEvent = this.previousClientEvent;
    }
    this.clientEventOwner = null;
    this.previousClientEvent = null;
    if (this.clientSocketOwner && this.clientSocketClose) {
      if (typeof this.clientSocketOwner.off === 'function')
        this.clientSocketOwner.off('close', this.clientSocketClose);
      else this.clientSocketOwner.removeListener?.('close', this.clientSocketClose);
    }
    this.clientSocketOwner = null;
    this.clientSocketClose = null;
  }

  onClientEvent(event) {
    if (this.stopped) return false;
    const classified = this.classifyEvent(event, this.lastHealth, {
      previousVitals: this.lastVitals,
      currentVitals: event?.kind === 'stat'
        ? (this.session.client?.vitals?.() ?? {}) : this.lastVitals,
      policy: this.controller?.policy ?? {},
    });
    this.lastHealth = classified.health;
    this.lastVitals = classified.vitals ?? this.lastVitals;
    this.lastEvent = { at: this.clock.now(), kind: classified.kind, reason: classified.reason };
    this._schedulePrimary(classified.reason, { immediate: classified.safety });

    if (CRITICAL_EVENT_KINDS.has(classified.kind))
      this._publishCritical(classified.kind, transitionPayload(event, classified.reason));
    if (classified.kind === 'disconnected' || classified.kind === 'closed')
      this._noteDisconnected(classified.reason);

    if (classified.safety) {
      this.safetyHandle.wake(classified.reason, { safety: true, coalesce: false });
      this._wakeDecision(classified.reason, { safety: true, immediate: true });
    } else if (classified.decision !== false) {
      this._wakeDecision(classified.reason);
    }
    return true;
  }

  _decisionInterval() {
    if (this.decisionMinMs != null) return this.decisionMinMs;
    return nonNegative(this.controller?.policy?.decideMs, 1000, 'controller policy decideMs');
  }

  _wakeDecision(reason, { safety = false, immediate = false } = {}) {
    if (this.stopped) return false;
    this.pendingDecisionReasons.add(String(reason));
    if (safety || immediate) {
      this.decisionHandle.clearDeadline('ordinary-cooldown');
      return this.decisionHandle.wake(reason, {
        safety, coalesce: (safety || immediate) ? false : undefined,
      });
    }
    const now = this.clock.now();
    const intervalReadyAt = this.lastDecisionStartedAt == null
      ? now : this.lastDecisionStartedAt + this._decisionInterval();
    const earliest = Math.max(intervalReadyAt, this.decisionFailureNotBefore);
    if (!this.decisionInFlight && earliest <= now) return this.decisionHandle.wake(reason);
    return this.decisionHandle.setDeadline(
      'ordinary-cooldown', Math.max(now, earliest), 'ordinary-cooldown');
  }

  _schedulePrimary(reason, { immediate = false, force = false } = {}) {
    if (this.stopped) return false;
    this.pendingStateReasons.add(String(reason));
    this.pendingStateForce ||= force;
    if (immediate) {
      this.statePublishAt = null;
      this.stateHandle.clearDeadline('publish');
      return this.stateHandle.wake(reason, { safety: true, coalesce: false });
    }
    if (this.statePublishAt != null) return true;
    this.statePublishAt = this.clock.now() + this.statePublishMs;
    return this.stateHandle.setDeadline('publish', this.statePublishAt, 'state-coalesced');
  }

  _publishStateLane() {
    if (this.stopped) return;
    this.statePublishAt = null;
    const reasons = [...this.pendingStateReasons];
    const force = this.pendingStateForce;
    this.pendingStateReasons.clear();
    this.pendingStateForce = false;
    return this.publishPrimary(reasons.join(',') || 'state-coalesced', { force });
  }

  async _decide(input) {
    if (!this.started || this.stopped) return;
    this._attachClientEvents();
    const reasons = new Set([...input.reasons.names, ...this.pendingDecisionReasons]);
    this.pendingDecisionReasons.clear();
    // ActorScheduler deliberately turns events accumulated during a pass into one
    // immediate rerun. After a failed pass, consume that rerun cheaply and preserve its
    // reasons behind a deadline. Safety-priority work may retry early; health and death
    // must not wait behind an ordinary fault backoff.
    if (input.priority !== 'safety' && this.clock.now() < this.decisionFailureNotBefore) {
      for (const reason of reasons) this.pendingDecisionReasons.add(reason);
      this.decisionHandle.setDeadline(
        'decision-failure-backoff', this.decisionFailureNotBefore,
        'decision-failure-backoff');
      return;
    }
    this.lastDecisionStartedAt = this.clock.now();
    if (!this.session.live && !(await this._rejoin())) return;
    if (this.stopped) return;
    this.decisionInFlight = true;
    this.safetyHandle.setDeadline(
      'pass-stall', this.clock.now() + this.passWatchMs, 'pass-stall', { safety: true });
    try {
      this.lastDecision = await this.controller.runDecision?.({
        reason: [...reasons].join(',') || `mask:${input.reasons.mask}`,
        input,
      });
      if (this.lastDecision?.error != null) this._noteDecisionFailure();
      else this._clearDecisionFailure();
    } catch (error) {
      this._noteDecisionFailure();
      throw error;
    } finally {
      this.decisionInFlight = false;
      this.safetyHandle.clearDeadline('pass-stall');
      this._schedulePrimary('decision-complete');
      this._scheduleReconcile();
    }
  }

  _noteDecisionFailure() {
    this.decisionFailureNotBefore = this.clock.now() + this.decisionFailureBackoffMs;
    this.decisionHandle.setDeadline(
      'decision-failure-backoff', this.decisionFailureNotBefore,
      'decision-failure-backoff');
  }

  _clearDecisionFailure() {
    this.decisionFailureNotBefore = 0;
    this.decisionHandle.clearDeadline('decision-failure-backoff');
  }

  _markConnected() {
    this.lastVitals = primaryVitalSnapshot(this.session.client?.vitals?.() ?? {});
    const health = this.lastVitals.health?.value;
    if (Number.isFinite(health)) this.lastHealth = health;
    this.connectionGeneration++;
    this.lastDisconnectedGeneration = null;
    this.lastConnectedAt = this.clock.now();
    this.reconnectAttempts = 0;
    this.reconnectNotBefore = 0;
    this.decisionHandle.clearDeadline('reconnect');
  }

  _noteDisconnected(reason) {
    if (this.lastDisconnectedGeneration === this.connectionGeneration) return;
    this.lastDisconnectedGeneration = this.connectionGeneration;
    if (!this.reconnectEnabled || this.lastConnectedAt == null) return;
    const connectedFor = Math.max(0, this.clock.now() - this.lastConnectedAt);
    if (this.contentionWindowMs > 0 && connectedFor < this.contentionWindowMs) {
      this.contentionStrikes++;
      const exponent = Math.min(30, this.contentionStrikes - 1);
      const delay = Math.min(this.contentionMaxMs, this.contentionBaseMs * (2 ** exponent));
      this.reconnectNotBefore = Math.max(this.reconnectNotBefore, this.clock.now() + delay);
      this.decisionHandle.setDeadline(
        'reconnect', this.reconnectNotBefore, 'reconnect-after-contention');
      this._publishCritical('reconnect-deferred', {
        reason, connected_for_ms: connectedFor, contention_strike: this.contentionStrikes,
        retry_in_ms: delay,
      });
    } else {
      this.contentionStrikes = 0;
      this.reconnectNotBefore = 0;
    }
  }

  _rejoin() {
    if (this.reconnectPromise) return this.reconnectPromise;
    const generation = this.lifecycleGeneration;
    let pending;
    pending = (async () => {
      try { return await this._attemptRejoin(generation); }
      finally { if (this.reconnectPromise === pending) this.reconnectPromise = null; }
    })();
    this.reconnectPromise = pending;
    return pending;
  }

  async _attemptRejoin(generation) {
    if (!this.reconnectEnabled || !this.credentials || this.stopped) return false;
    const now = this.clock.now();
    if (now < this.reconnectNotBefore) {
      this.decisionHandle.setDeadline(
        'reconnect', this.reconnectNotBefore, 'reconnect-after-contention');
      return false;
    }
    try {
      // Session.joinOnce() installs its new M59Client only after login succeeds; it
      // does not own or retire the disconnected client already assigned here.  Drop
      // our callbacks first, then close that old socket before opening a replacement.
      // This stays below the contention gate so a deferred reconnect does not fight a
      // possibly-human-owned login by eagerly tearing down the existing connection.
      this._detachClientEvents();
      this._destroySessionClient();
      await this.session.join(this.credentials);
      this._assertActive(generation);
      this._markConnected();
      this._attachClientEvents();
      this.publishPrimary('reconnected', { force: true });
      this._publishCritical('reconnected', { reason: 'session rejoined' });
      return true;
    } catch (error) {
      if (this.stopped || generation !== this.lifecycleGeneration) {
        this._destroySessionClient();
        return false;
      }
      this.reconnectAttempts++;
      const exponent = Math.min(30, this.reconnectAttempts - 1);
      const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** exponent));
      this.decisionHandle.setDeadline('reconnect', this.clock.now() + delay, 'reconnect');
      this.lastEventError = { at: this.clock.now(), message: error?.message ?? String(error) };
      this._publishCritical('reconnect-failed', {
        reason: this.lastEventError.message, attempt: this.reconnectAttempts,
        retry_in_ms: delay,
      });
      this._schedulePrimary('reconnect-failed');
      return false;
    }
  }

  _publishCritical(type, payload) {
    if (!this.publishTransition || this.stopped) return false;
    const item = { type, payload };
    if (this.criticalBacklog.length) {
      this._enqueueCritical(item, this.lastTransitionError);
      return false;
    }
    try {
      this.publishTransition(this.id, type, payload);
      return true;
    } catch (error) {
      this._enqueueCritical(item, error);
      return false;
    }
  }

  _enqueueCritical(item, error) {
    this.criticalBacklog.push(item);
    this.lastTransitionError = {
      at: this.clock.now(), code: error?.code ?? null,
      message: error?.message ?? String(error ?? 'critical transition is backpressured'),
    };
    const socket = this.clientSocketOwner ?? this.session.client?.sock;
    if (socket && !this.pausedSocket) {
      try { socket.pause?.(); this.pausedSocket = socket; } catch { /* retry still applies */ }
    }
    // Pausing stops new chunks. If one already-parsed chunk crosses the trip limit, close
    // the socket rather than permit an unbounded producer. Captured entries remain queued.
    if (this.criticalBacklog.length > this.criticalBacklogTripLimit) {
      try { socket?.destroy?.(); } catch { /* already closing */ }
    }
    this.safetyHandle.setDeadline(
      'transition-backpressure', this.clock.now() + this.transitionRetryMs,
      'transition-backpressure', { safety: true });
  }

  _flushCriticalBacklog() {
    if (!this.publishTransition || this.stopped) return false;
    while (this.criticalBacklog.length) {
      const item = this.criticalBacklog[0];
      try {
        this.publishTransition(this.id, item.type, item.payload);
        this.criticalBacklog.shift();
      } catch (error) {
        this.lastTransitionError = {
          at: this.clock.now(), code: error?.code ?? null,
          message: error?.message ?? String(error),
        };
        this.safetyHandle.setDeadline(
          'transition-backpressure', this.clock.now() + this.transitionRetryMs,
          'transition-backpressure', { safety: true });
        return false;
      }
    }
    this.lastTransitionError = null;
    if (this.pausedSocket) {
      try { this.pausedSocket.resume?.(); } catch { /* socket may have closed */ }
      this.pausedSocket = null;
    }
    return true;
  }

  async _safety(input) {
    if (this.stopped) return;
    if (input.reasons.names.includes('transition-backpressure'))
      this._flushCriticalBacklog();
    if (!this.started) return;
    const result = await this.controller.runSafetyCheck?.({ input });
    this._schedulePrimary('safety-check');
    if (this.decisionInFlight && input.reasons.names.includes('pass-stall')) {
      this.safetyHandle.setDeadline(
        'pass-stall', this.clock.now() + this.passWatchMs, 'pass-stall', { safety: true });
    }
    return result;
  }

  _scheduleReconcile() {
    if (this.stopped) return;
    const delay = this.session.live ? this.reconcileMs : this.disconnectedReconcileMs;
    this.decisionHandle.setDeadline('reconcile', this.clock.now() + delay, 'reconcile');
  }

  publishPrimary(reason = 'event', { force = false } = {}) {
    if (this.stopped) return this.lastPublished;
    const value = this.project();
    this.lastPublished = value;
    this.publish?.(this.id, value, { reason, force });
    return value;
  }

  snapshot() {
    return this.lastPublished ?? this.project();
  }

  _destroySessionClient() {
    const client = this.session.client;
    if (!client || (typeof client === 'object' && this.closedClients.has(client))) return false;
    if (typeof client === 'object') this.closedClients.add(client);
    try { client.stopKeepalive?.(); } catch {}
    try { client.close?.(); } catch {}
    try { client.sock?.destroy?.(); } catch {}
    if (this.session.client === client) this.session.client = null;
    return true;
  }

  async stop(reason = 'runtime stopped') {
    if (this.stopped) return false;
    this.stopped = true;
    this.lifecycleGeneration++;
    this.decisionHandle.stop();
    this.safetyHandle.stop();
    this.stateHandle.stop();
    this._detachClientEvents();
    try { await this.controller.stop?.(reason, { hard: true }); } catch { /* continue */ }
    try { this.session.recorder?.stop?.(); } catch { /* continue */ }
    this._destroySessionClient();

    // Session.join() owns its private socket until it settles. A late success sees the
    // generation change, closes the newly assigned client, and never attaches/restarts.
    const pending = [this.startPromise, this.reconnectPromise].filter(Boolean);
    if (pending.length) await Promise.allSettled(pending);
    if (this.controller.running) {
      try { await this.controller.stop?.(reason, { hard: true }); } catch { /* continue */ }
    }
    this._detachClientEvents();
    this._destroySessionClient();
    this.criticalBacklog.length = 0;
    this.pausedSocket = null;
    return true;
  }
}
