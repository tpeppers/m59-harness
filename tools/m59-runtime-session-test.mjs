#!/usr/bin/env node
// SESSION ACTORS ARE EVENT/DEADLINE DRIVEN. Offline, no server, safe any time:
//
//   node tools/m59-runtime-session-test.mjs
//
// This uses the real ActorScheduler and a ManualClock. The fake Session never opens a
// socket; advancing time deterministically exercises coalescing, safety priority,
// reconnect policies, lifecycle races, event ownership, and critical backpressure.

import assert from 'node:assert/strict';
import { SessionActor } from './runtime/session-actor.mjs';
import { ManualClock } from './runtime/clock/index.mjs';
import { ActorScheduler, PRIORITY } from './runtime/scheduler/index.mjs';

let pass = 0, fail = 0;
const ok = (name, condition, extra = '') => {
  if (condition) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const same = (name, actual, expected) => {
  try { assert.deepEqual(actual, expected); ok(name, true); }
  catch { ok(name, false, `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`); }
};

function runtime(clock, options = {}) {
  const errors = [];
  const scheduler = new ActorScheduler({
    now: () => clock.now(),
    setTimer: (fn, delay) => clock.setTimeout(fn, delay),
    clearTimer: handle => clock.clearTimeout(handle),
    // A deferred turn is a zero-delay manual-clock task. It is deliberately not a
    // microtask: maxStartsPerTurn must yield between actor batches in production too.
    defer: fn => clock.setTimeout(fn, 0),
    coalesceMs: 20,
    unrefTimer: false,
    onError: (error, input) => errors.push({ error, input }),
    ...options,
  });
  return { scheduler, errors };
}

// Run only work due NOW. We do not use runUntilIdle(): every completed decision installs
// a future reconciliation deadline, so "all future time" is intentionally never idle.
async function flushNow(clock, { maxRounds = 100 } = {}) {
  let quiet = 0;
  for (let round = 0; round < maxRounds; round++) {
    const fired = clock.advanceBy(0);
    // Async controller calls and ActorScheduler completion each add promise reactions.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    quiet = fired === 0 ? quiet + 1 : 0;
    if (quiet >= 3) return;
  }
  throw new Error('manual session runtime did not settle at the current instant');
}

async function advance(clock, ms) {
  clock.advanceBy(ms);
  await flushNow(clock);
}

async function microticks(count = 8) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeSocket() {
  const listeners = new Map();
  return {
    destroyCalls: 0,
    pauseCalls: 0,
    resumeCalls: 0,
    paused: false,
    on(kind, fn) {
      const rows = listeners.get(kind) ?? [];
      rows.push(fn);
      listeners.set(kind, rows);
      return this;
    },
    off(kind, fn) {
      const rows = listeners.get(kind) ?? [];
      listeners.set(kind, rows.filter(row => row !== fn));
      return this;
    },
    removeListener(kind, fn) { return this.off(kind, fn); },
    emit(kind, ...args) {
      for (const fn of [...(listeners.get(kind) ?? [])]) fn(...args);
    },
    listenerCount(kind) { return (listeners.get(kind) ?? []).length; },
    destroy() { this.destroyCalls++; },
    pause() { this.pauseCalls++; this.paused = true; },
    resume() { this.resumeCalls++; this.paused = false; },
  };
}

function fakeClient(name, previous = null) {
  return {
    name,
    state: 'game',
    onEvent: previous,
    closeCalls: 0,
    stopKeepaliveCalls: 0,
    close() { this.closeCalls++; },
    stopKeepalive() { this.stopKeepaliveCalls++; },
    sock: fakeSocket(),
  };
}

function fakeController({ decideMs = 1000 } = {}) {
  return {
    mode: 'test',
    policy: { decideMs },
    running: false,
    startCalls: 0,
    stopCalls: [],
    decisions: [],
    safety: [],
    start() { this.startCalls++; this.running = true; },
    async runDecision(input) {
      this.decisions.push(input);
      return { ran: true, reason: input.reason };
    },
    async runSafetyCheck(input) {
      this.safety.push(input);
      return { ran: true };
    },
    stop(reason, options) {
      this.stopCalls.push({ reason, options });
      this.running = false;
      return true;
    },
  };
}

function hasReasons(decision, ...wanted) {
  const reasons = new Set(String(decision?.reason ?? '').split(','));
  return wanted.every(reason => reasons.has(reason));
}

console.log('coalesced projection, decision throttling, safety, and event ownership');
{
  const clock = new ManualClock({ startMs: 100 });
  const { scheduler, errors } = runtime(clock);
  const chained = [];
  let projectedRoom = null;
  const previous = event => {
    chained.push(event.kind);
    if (event.kind === 'room-entered') projectedRoom = event.room;
  };
  const client = fakeClient('first', previous);
  const session = {
    live: true,
    client,
    recorder: { stopCalls: 0, stop() { this.stopCalls++; } },
    async join() { throw new Error('this scenario starts already joined'); },
  };
  // The explicit minimum intentionally overrides this much shorter policy interval.
  const controller = fakeController({ decideMs: 25 });
  const primary = [];
  const transitions = [];
  let projection = 0;
  const actor = new SessionActor({
    id: 'kermit', session, controller, scheduler, clock,
    reconcileMs: 5000, disconnectedReconcileMs: 9000, passWatchMs: 1000,
    statePublishMs: 100, decisionMinMs: 200,
    project: () => ({ revision: ++projection, connected: session.live, room: projectedRoom }),
    publish: (id, value, options) => primary.push({ at: clock.now(), id, value, options }),
    publishTransition: (id, type, payload) => transitions.push({ id, type, payload }),
  });

  const credentials = {
    account: 'test-account', password: 'not-a-real-password', character: 'Kermit',
  };
  await actor.start({ credentials, join: false });
  await flushNow(clock);
  ok('start chains rather than overwrites an existing client event handler',
     client.onEvent !== previous && typeof client.onEvent === 'function');
  ok('start owns one close listener and activates the controller once',
     client.sock.listenerCount('close') === 1 && controller.startCalls === 1);

  // Drain the startup decision's coalesced state projection before measuring events.
  await advance(clock, 100);
  controller.decisions.length = 0;
  controller.safety.length = 0;
  primary.length = 0;
  transitions.length = 0;
  chained.length = 0;

  client.onEvent({ kind: 'object', seq: 1, at: clock.now() });
  client.onEvent({ kind: 'inventory', seq: 2, at: clock.now() });
  same('the previous handler sees every ordinary event first', chained, ['object', 'inventory']);
  ok('ordinary events do not synchronously project or run the policy',
     primary.length === 0 && controller.decisions.length === 0);
  await flushNow(clock);
  ok('ordinary event work remains asleep before both deadlines',
     primary.length === 0 && controller.decisions.length === 0);
  await advance(clock, 99);
  ok('neither state nor policy polls before its configured minimum',
     primary.length === 0 && controller.decisions.length === 0);
  await advance(clock, 1);
  ok('an ordinary event burst becomes one coalesced state projection at statePublishMs',
     primary.length === 1 && primary[0].at === 300,
     JSON.stringify(primary));
  ok('decisionMinMs overrides the shorter policy interval and permits one full decision',
     controller.decisions.length === 1 &&
       hasReasons(controller.decisions[0], 'client:object', 'client:inventory'),
     JSON.stringify(controller.decisions.map(row => row.reason)));

  controller.decisions.length = 0;
  primary.length = 0;
  client.onEvent({ kind: 'moved', seq: 3, at: clock.now() });
  await advance(clock, 100);
  ok('observation-only movement still reaches the coalesced state channel',
     primary.length === 1 && primary[0].options.reason.includes('client:moved'));
  await advance(clock, 200);
  ok('observation-only movement never wakes a full decision', controller.decisions.length === 0,
     JSON.stringify(controller.decisions.map(row => row.reason)));

  primary.length = 0;
  transitions.length = 0;
  client.onEvent({ kind: 'room-entered', seq: 4, at: clock.now(), room: 77,
                   roomName: 'Old Room', raw: { must: 'not cross' } });
  client.onEvent({ kind: 'room-entered', seq: 5, at: clock.now(), room: 88,
                   roomName: 'Latest Room', text: 'also not transition state' });
  ok('room-entered is not emitted as an exact critical transition', transitions.length === 0);
  await advance(clock, 99);
  ok('room changes wait for the state projection deadline', primary.length === 0);
  await advance(clock, 1);
  ok('room-entered publishes one latest-state projection rather than two event snapshots',
     primary.length === 1 && primary[0].value.room === 88,
     JSON.stringify(primary));

  primary.length = 0;
  const decisionsBeforeDamage = controller.decisions.length;
  const safetyBeforeDamage = controller.safety.length;
  client.onEvent({ kind: 'damage', seq: 6, at: clock.now() });
  ok('safety delivery is queued immediately without synchronous user projection',
     primary.length === 0);
  await flushNow(clock);
  ok('a safety event projects state immediately through the reserved lane',
     primary.some(row => row.options.reason.includes('client:damage')));
  ok('a safety event runs both safety and full decision lanes without the cooldown',
     controller.safety.length === safetyBeforeDamage + 1 &&
       controller.decisions.length === decisionsBeforeDamage + 1);
  ok('both safety wakes carry safety priority',
     controller.safety.at(-1)?.input?.priority === PRIORITY.SAFETY &&
       controller.decisions.at(-1)?.input?.priority === PRIORITY.SAFETY);

  const transitionsBeforeDeath = transitions.length;
  client.onEvent({ kind: 'death', seq: 7, at: clock.now(), room: 88,
                   huge: { never: 'publish the full event' } });
  ok('death is published synchronously on the exact transition channel',
     transitions.length === transitionsBeforeDeath + 1);
  same('death transition is the minimal resumable projection', transitions.at(-1), {
    id: 'kermit', type: 'death',
    payload: { reason: 'client:death', seq: 7, at: clock.now(), room: 88 },
  });
  await flushNow(clock);

  // Leave state and policy deadlines outstanding, then stop before either can run.
  client.onEvent({ kind: 'object', seq: 8, at: clock.now() });
  const copiedWrapper = client.onEvent;
  const beforeStop = {
    decisions: controller.decisions.length,
    safety: controller.safety.length,
    primary: primary.length,
    transitions: transitions.length,
  };
  ok('the first stop succeeds', await actor.stop('test complete') === true);
  ok('stop restores the prior event handler and removes its close listener',
     client.onEvent === previous && client.sock.listenerCount('close') === 0);
  copiedWrapper({ kind: 'damage', seq: 9, at: clock.now() });
  await advance(clock, 10_000);
  same('queued timers, deferred turns, and a copied wrapper cannot resurrect the actor', {
    decisions: controller.decisions.length,
    safety: controller.safety.length,
    primary: primary.length,
    transitions: transitions.length,
  }, beforeStop);
  ok('stop tears down the controller, recorder, client, and socket once',
     controller.stopCalls.length === 1 && session.recorder.stopCalls === 1 &&
       client.stopKeepaliveCalls === 1 && client.closeCalls === 1 &&
       client.sock.destroyCalls === 1);
  ok('stop is idempotent', await actor.stop('again') === false);
  ok('no scheduler callback escaped as an error', errors.length === 0,
     errors.map(row => row.error?.message).join(','));
  scheduler.stop();
}

console.log('\ncontroller policy supplies the ordinary decision minimum by default');
{
  const clock = new ManualClock({ startMs: 0 });
  const { scheduler, errors } = runtime(clock);
  const client = fakeClient('policy-client');
  const session = { live: true, client, recorder: { stop() {} } };
  const controller = fakeController({ decideMs: 150 });
  const actor = new SessionActor({
    id: 'policy', session, controller, scheduler, clock,
    reconcileMs: 5000, disconnectedReconcileMs: 9000, passWatchMs: 1000,
    statePublishMs: 1000,
    project: () => ({ connected: session.live }),
  });
  await actor.start({ credentials: { account: 'p', password: 'p', character: 'P' }, join: false });
  await flushNow(clock);
  controller.decisions.length = 0;
  client.onEvent({ kind: 'object', seq: 1, at: clock.now() });
  await advance(clock, 149);
  ok('policy.decideMs prevents an ordinary decision before its deadline',
     controller.decisions.length === 0);
  await advance(clock, 1);
  ok('policy.decideMs wakes exactly one ordinary decision at its deadline',
     controller.decisions.length === 1 && hasReasons(controller.decisions[0], 'client:object'));
  await actor.stop('policy test complete');
  ok('policy fallback produced no scheduler errors', errors.length === 0);
  scheduler.stop();
}

console.log('\nstat noise stays observational until a vital threshold or reconcile deadline');
{
  const clock = new ManualClock({ startMs: 0 });
  const { scheduler, errors } = runtime(clock, { coalesceMs: 0 });
  const vitals = {
    health: { value: 68, max: 100 },
    mana: { value: 16, max: 20 },
    vigor: { value: 81, scale_max: 200, rest_threshold: 80 },
  };
  const previous = event => {
    if (event?.kind !== 'stat') return;
    const name = String(event.name ?? '').toLowerCase();
    if (vitals[name]) vitals[name].value = event.value;
  };
  const client = fakeClient('stat-bucket-client', previous);
  client.vitals = () => vitals;
  const session = { live: true, client, recorder: { stop() {} } };
  const controller = fakeController({ decideMs: 1000 });
  controller.policy.restBelow = 0.7;
  const primary = [];
  const actor = new SessionActor({
    id: 'stat-buckets', session, controller, scheduler, clock,
    reconcileMs: 8000, disconnectedReconcileMs: 30_000, passWatchMs: 5000,
    statePublishMs: 100,
    project: () => ({
      health: vitals.health.value, mana: vitals.mana.value, vigor: vitals.vigor.value,
    }),
    publish: (id, value, options) => primary.push({ at: clock.now(), id, value, options }),
  });
  await actor.start({
    credentials: { account: 's', password: 's', character: 'Stats' }, join: false,
  });
  await flushNow(clock);
  await advance(clock, 100);
  controller.decisions.length = 0;
  controller.safety.length = 0;
  primary.length = 0;

  client.onEvent({ kind: 'stat', name: 'health', value: 69, max: 100 });
  client.onEvent({ kind: 'stat', name: 'health', value: 69, max: 100 });
  client.onEvent({ kind: 'stat', name: 'mana', value: 17, max: 20 });
  client.onEvent({ kind: 'stat', name: 'vigor', value: 82, max: 80 });
  client.onEvent({ kind: 'stat', name: 'slash', value: 42, max: 100 });
  await flushNow(clock);
  ok('same-bucket upward, no-op, and non-vital stat packets do not run the pilot',
     controller.decisions.length === 0);
  await advance(clock, 99);
  ok('the stat burst still waits for the coalesced state deadline', primary.length === 0);
  await advance(clock, 1);
  ok('observation-only stats publish one latest primary-state snapshot',
     primary.length === 1 && primary[0].value.health === 69 &&
       primary[0].value.mana === 17 && primary[0].value.vigor === 82,
     JSON.stringify(primary));

  client.onEvent({ kind: 'stat', name: 'health', value: 70, max: 100 });
  await advance(clock, 799);
  ok('an upward threshold crossing still respects the ordinary decision cadence',
     controller.decisions.length === 0);
  await advance(clock, 1);
  ok('crossing restBelow wakes one full decision with an explicit reason',
     controller.decisions.length === 1 &&
       hasReasons(controller.decisions[0], 'vital-threshold-crossed:health'));

  controller.decisions.length = 0;
  controller.safety.length = 0;
  client.onEvent({ kind: 'stat', name: 'health', value: 69, max: 100 });
  await flushNow(clock);
  ok('a health decrease bypasses cadence through both safety and decision lanes',
     controller.safety.length === 1 && controller.decisions.length === 1 &&
       controller.decisions[0].input.priority === PRIORITY.SAFETY &&
       hasReasons(controller.decisions[0], 'health-decreased'));

  controller.decisions.length = 0;
  controller.safety.length = 0;
  await advance(clock, 7999);
  ok('no stat polling decision appears before the eight-second reconcile fallback',
     controller.decisions.length === 0);
  await advance(clock, 1);
  ok('the eight-second reconcile deadline still runs a fallback decision',
     controller.decisions.length === 1 && hasReasons(controller.decisions[0], 'reconcile'));
  await actor.stop('stat bucket test complete');
  ok('stat classification flow produced no scheduler errors', errors.length === 0);
  scheduler.stop();
}

console.log('\nfailed decisions back off ordinary reruns while safety may bypass');
{
  const clock = new ManualClock({ startMs: 0 });
  const { scheduler, errors } = runtime(clock, { coalesceMs: 0 });
  const client = fakeClient('failure-backoff-client');
  const session = { live: true, client, recorder: { stop() {} } };
  const first = deferred();
  const controller = fakeController({ decideMs: 0 });
  const attempts = [];
  controller.runDecision = async input => {
    attempts.push({ at: clock.now(), priority: input.input.priority, reason: input.reason });
    if (attempts.length === 1) return first.promise;
    if (attempts.length === 3) return { ran: true, error: new Error('repeatable pass fault') };
    return { ran: true };
  };
  const actor = new SessionActor({
    id: 'failure-backoff', session, controller, scheduler, clock,
    reconcileMs: 50_000, disconnectedReconcileMs: 60_000, passWatchMs: 10_000,
    statePublishMs: 100, decisionMinMs: 0, decisionFailureBackoffMs: 5000,
    project: () => ({ connected: session.live }),
  });
  await actor.start({
    credentials: { account: 'f', password: 'f', character: 'F' }, join: false,
  });
  await flushNow(clock);
  ok('the startup decision is in flight before an ordinary rerun accumulates',
     attempts.length === 1 && actor.decisionInFlight === true);

  client.onEvent({ kind: 'object', seq: 1, at: clock.now() });
  await flushNow(clock);
  first.resolve({ ran: true, error: new Error('first pass fault') });
  await flushNow(clock);
  ok('a managed pass failure does not immediately consume its accumulated ordinary rerun',
     attempts.length === 1, JSON.stringify(attempts));
  await advance(clock, 4999);
  ok('ordinary work remains asleep throughout the bounded failure delay',
     attempts.length === 1, JSON.stringify(attempts));
  await advance(clock, 1);
  ok('ordinary work retries once at five seconds and retains its accumulated reason',
     attempts.length === 2 && attempts[1].at === 5000 &&
       attempts[1].priority === 'normal' && hasReasons(attempts[1], 'client:object'),
     JSON.stringify(attempts));

  client.onEvent({ kind: 'object', seq: 2, at: clock.now() });
  await flushNow(clock);
  ok('a later managed pass fault establishes a fresh ordinary backoff',
     attempts.length === 3 && attempts[2].at === 5000);
  client.onEvent({ kind: 'object', seq: 3, at: clock.now() });
  await flushNow(clock);
  ok('the fresh ordinary event cannot hot-loop the repeatable failure', attempts.length === 3);
  client.onEvent({ kind: 'damage', seq: 4, at: clock.now() });
  await flushNow(clock);
  ok('a safety-priority wake may bypass the ordinary failure backoff',
     attempts.length === 4 && attempts[3].at === 5000 && attempts[3].priority === 'safety',
     JSON.stringify(attempts));

  await actor.stop('failure backoff test complete');
  ok('managed failure results remain handled rather than scheduler errors', errors.length === 0);
  scheduler.stop();
}

console.log('\nlegacy reconnect uses bounded exponential backoff when contention is disabled');
{
  const clock = new ManualClock({ startMs: 1000 });
  const { scheduler, errors } = runtime(clock);
  const oldEvents = [], newEvents = [];
  const oldPrevious = event => oldEvents.push(event.kind);
  const newPrevious = event => newEvents.push(event.kind);
  const oldClient = fakeClient('old-client', oldPrevious);
  const newClient = fakeClient('new-client', newPrevious);
  const joins = [];
  const session = {
    live: true,
    client: oldClient,
    recorder: { stop() {} },
    async join(credentials) {
      joins.push({ at: clock.now(), credentials: { ...credentials } });
      this.live = false;
      if (joins.length <= 4) throw new Error(`offline-${joins.length}`);
      this.live = true;
      this.client = newClient;
      return { joined: true };
    },
  };
  const controller = fakeController();
  const primary = [];
  const transitions = [];
  const credentials = {
    account: 'reconnect-account', password: 'local-only', character: 'Piggy',
  };
  const actor = new SessionActor({
    id: 'piggy', session, controller, scheduler, clock,
    reconcileMs: 8000, disconnectedReconcileMs: 9000, passWatchMs: 1000,
    statePublishMs: 100, reconnectBaseMs: 100, reconnectMaxMs: 250,
    contentionWindowMs: 0,
    project: () => ({ connected: session.live, client: session.client?.name ?? null }),
    publish: (id, value, options) => primary.push({ at: clock.now(), id, value, options }),
    publishTransition: (id, type, payload) => transitions.push({ id, type, payload }),
  });

  await actor.start({ credentials, join: false });
  await flushNow(clock);
  controller.decisions.length = 0;
  controller.safety.length = 0;
  primary.length = 0;
  transitions.length = 0;

  session.live = false;
  oldClient.onEvent({
    kind: 'disconnected', seq: 9, at: 995, room: 88, roomName: 'Lost Socket',
    socket: oldClient.sock, error: new Error('not serializable as transition state'),
  });
  ok('disconnect does not call user projection synchronously', primary.length === 0);
  same('disconnect publishes a minimal critical transition', transitions[0] && {
    id: transitions[0].id, type: transitions[0].type, payload: transitions[0].payload,
  }, {
    id: 'piggy', type: 'disconnected',
    payload: {
      reason: 'client:disconnected', seq: 9, at: 995, room: 88,
      room_name: 'Lost Socket',
    },
  });

  await flushNow(clock);
  ok('disconnect state projects immediately through the scheduler safety lane',
     primary.some(row => row.options.reason.includes('client:disconnected')));
  same('with contention disabled, disconnect tries stored credentials immediately',
       joins.map(row => row.at), [1000]);
  ok('expected reconnect failure is handled, not sent to scheduler onError', errors.length === 0,
     errors.map(row => row.error?.message).join(','));
  ok('disconnected actors do not run the ordinary gameplay controller',
     controller.decisions.length === 0, 'decisions=' + controller.decisions.length);

  await advance(clock, 99);
  same('first reconnect delay is at least reconnectBaseMs', joins.map(row => row.at), [1000]);
  await advance(clock, 1);
  same('first retry fires at the base delay', joins.map(row => row.at), [1000, 1100]);
  await advance(clock, 199);
  same('the second delay doubles rather than polling', joins.map(row => row.at), [1000, 1100]);
  await advance(clock, 1);
  same('second retry fires after the doubled delay', joins.map(row => row.at), [1000, 1100, 1300]);
  await advance(clock, 249);
  same('exponential delay is capped below its next doubling',
       joins.map(row => row.at), [1000, 1100, 1300]);
  await advance(clock, 1);
  same('third retry fires at reconnectMaxMs',
       joins.map(row => row.at), [1000, 1100, 1300, 1550]);
  await advance(clock, 249);
  same('the capped delay remains stable on later failures',
       joins.map(row => row.at), [1000, 1100, 1300, 1550]);
  await advance(clock, 1);
  same('a later retry succeeds without exceeding the cap',
       joins.map(row => row.at), [1000, 1100, 1300, 1550, 1800]);
  ok('every reconnect attempt uses credentials retained by start()',
     joins.length === 5 && joins.every(row => {
       try { assert.deepEqual(row.credentials, credentials); return true; } catch { return false; }
     }));
  ok('successful reconnect reattaches to the replacement client',
     newClient.onEvent !== newPrevious && typeof newClient.onEvent === 'function');
  ok('the replaced client socket and keepalive are retired exactly once',
     oldClient.stopKeepaliveCalls === 1 && oldClient.closeCalls === 1 &&
       oldClient.sock.destroyCalls === 1);
  ok('reattaching restores the old client handler and close-listener ownership',
     oldClient.onEvent === oldPrevious && oldClient.sock.listenerCount('close') === 0 &&
       newClient.sock.listenerCount('close') === 1);

  session.live = false;
  newClient.onEvent({ kind: 'closed', seq: 10, at: clock.now() });
  const joinsBeforeStop = joins.length;
  await actor.stop('reconnect test complete');
  ok('stop restores the replacement client handler too', newClient.onEvent === newPrevious);
  await advance(clock, 10_000);
  ok('stop prevents queued close/reconnect work from resurrecting the session',
     joins.length === joinsBeforeStop, 'joins=' + joins.map(row => row.at).join(','));
  scheduler.stop();
}

console.log('\nrapid drops defer reconnect and double the contention delay');
{
  const clock = new ManualClock({ startMs: 2000 });
  const { scheduler, errors } = runtime(clock);
  const clients = [fakeClient('c1'), fakeClient('c2'), fakeClient('c3')];
  const joins = [];
  const transitions = [];
  let nextClient = 1;
  const session = {
    live: true,
    client: clients[0],
    recorder: { stop() {} },
    async join() {
      joins.push(clock.now());
      this.client = clients[nextClient++];
      this.live = true;
      return { joined: true };
    },
  };
  const controller = fakeController();
  const actor = new SessionActor({
    id: 'contention', session, controller, scheduler, clock,
    reconcileMs: 8000, disconnectedReconcileMs: 9000, passWatchMs: 1000,
    statePublishMs: 100, reconnectBaseMs: 10, reconnectMaxMs: 100,
    contentionWindowMs: 1000, contentionBaseMs: 100, contentionMaxMs: 400,
    project: () => ({ connected: session.live }),
    publishTransition: (id, type, payload) => transitions.push({ id, type, payload }),
  });
  await actor.start({
    credentials: { account: 'c', password: 'c', character: 'C' }, join: false,
  });
  await flushNow(clock);
  controller.decisions.length = 0;
  transitions.length = 0;

  session.live = false;
  clients[0].onEvent({ kind: 'closed', seq: 1, at: clock.now() });
  await flushNow(clock);
  same('first rapid drop does not rejoin immediately', joins, []);
  ok('contention deferral leaves the old client untouched until its deadline',
     clients[0].stopKeepaliveCalls === 0 && clients[0].closeCalls === 0 &&
       clients[0].sock.destroyCalls === 0 && clients[0].sock.listenerCount('close') === 1);
  await advance(clock, 99);
  same('first contention deadline is not polled early', joins, []);
  await advance(clock, 1);
  same('first rapid drop rejoins after contentionBaseMs', joins, [2100]);
  ok('the first deferred replacement retires its old client exactly once',
     clients[0].stopKeepaliveCalls === 1 && clients[0].closeCalls === 1 &&
       clients[0].sock.destroyCalls === 1);

  session.live = false;
  clients[1].onEvent({ kind: 'closed', seq: 2, at: clock.now() });
  await flushNow(clock);
  same('second rapid drop is deferred again', joins, [2100]);
  ok('the doubled contention delay also preserves its client until retry',
     clients[1].stopKeepaliveCalls === 0 && clients[1].closeCalls === 0 &&
       clients[1].sock.destroyCalls === 0 && clients[1].sock.listenerCount('close') === 1);
  await advance(clock, 199);
  same('second contention delay is longer than the first', joins, [2100]);
  await advance(clock, 1);
  same('second contention strike doubles the delay', joins, [2100, 2300]);
  ok('the second replacement retires its old client exactly once',
     clients[1].stopKeepaliveCalls === 1 && clients[1].closeCalls === 1 &&
       clients[1].sock.destroyCalls === 1);
  const deferredTransitions = transitions.filter(row => row.type === 'reconnect-deferred');
  same('contention transitions expose deterministic strike and retry metadata',
       deferredTransitions.map(row => [row.payload.contention_strike, row.payload.retry_in_ms]),
       [[1, 100], [2, 200]]);
  ok('replacement ownership follows each successful reconnect',
     clients[0].sock.listenerCount('close') === 0 &&
       clients[1].sock.listenerCount('close') === 0 &&
       clients[2].sock.listenerCount('close') === 1);
  await actor.stop('contention complete');
  ok('contention flow produced no scheduler errors', errors.length === 0);
  scheduler.stop();
}

console.log('\nstop during a deferred initial join closes the late client and never starts');
{
  const clock = new ManualClock({ startMs: 3000 });
  const { scheduler, errors } = runtime(clock);
  const gate = deferred();
  const previous = () => {};
  const lateClient = fakeClient('late-initial', previous);
  let joinCalls = 0;
  const session = {
    live: false,
    client: null,
    recorder: { stopCalls: 0, stop() { this.stopCalls++; } },
    async join() {
      joinCalls++;
      await gate.promise;
      this.client = lateClient;
      this.live = true;
      return { joined: true };
    },
  };
  const controller = fakeController();
  const primary = [];
  const actor = new SessionActor({
    id: 'late-start', session, controller, scheduler, clock,
    project: () => ({ connected: session.live }),
    publish: (id, value, options) => primary.push({ id, value, options }),
  });
  const starting = actor.start({
    credentials: { account: 'late', password: 'late', character: 'Late' },
  });
  const stopping = actor.stop('cancel initial join');
  gate.resolve();
  const [startOutcome, stopOutcome] = await Promise.allSettled([starting, stopping]);
  ok('the pending start is aborted and stop itself completes',
     startOutcome.status === 'rejected' && startOutcome.reason?.code === 'M59_ACTOR_STOPPED' &&
       stopOutcome.status === 'fulfilled' && stopOutcome.value === true);
  ok('a stopped late join never attaches, starts, decides, or publishes',
     joinCalls === 1 && controller.startCalls === 0 && controller.decisions.length === 0 &&
       primary.length === 0 && lateClient.onEvent === previous && actor.started === false);
  ok('the client assigned by the late join is closed exactly once',
     lateClient.stopKeepaliveCalls === 1 && lateClient.closeCalls === 1 &&
       lateClient.sock.destroyCalls === 1 && session.client === null);
  ok('initial-join cancellation produced no scheduler errors', errors.length === 0);
  scheduler.stop();
}

console.log('\nstop during a deferred rejoin closes the replacement without resurrection');
{
  const clock = new ManualClock({ startMs: 4000 });
  const { scheduler, errors } = runtime(clock);
  const gate = deferred();
  const oldPrevious = () => {};
  const replacementPrevious = () => {};
  const oldClient = fakeClient('old-deferred', oldPrevious);
  const replacement = fakeClient('late-replacement', replacementPrevious);
  let joins = 0;
  const session = {
    live: true,
    client: oldClient,
    recorder: { stop() {} },
    async join() {
      joins++;
      await gate.promise;
      this.client = replacement;
      this.live = true;
      return { joined: true };
    },
  };
  const controller = fakeController();
  const primary = [];
  const transitions = [];
  const actor = new SessionActor({
    id: 'late-rejoin', session, controller, scheduler, clock,
    contentionWindowMs: 0, reconnectBaseMs: 100, reconnectMaxMs: 200,
    project: () => ({ connected: session.live }),
    publish: (id, value, options) => primary.push({ id, value, options }),
    publishTransition: (id, type, payload) => transitions.push({ id, type, payload }),
  });
  await actor.start({
    credentials: { account: 'r', password: 'r', character: 'R' }, join: false,
  });
  await flushNow(clock);
  controller.decisions.length = 0;
  primary.length = 0;
  transitions.length = 0;

  session.live = false;
  oldClient.onEvent({ kind: 'disconnected', seq: 1, at: clock.now() });
  await flushNow(clock);
  ok('the reconnect attempt is in flight before shutdown', joins === 1);
  const stopping = actor.stop('cancel rejoin');
  await microticks();
  gate.resolve();
  ok('stop waits for and settles the privately-owned reconnect socket', await stopping === true);
  ok('the late replacement is never attached or announced as reconnected',
     replacement.onEvent === replacementPrevious && replacement.sock.listenerCount('close') === 0 &&
       !transitions.some(row => row.type === 'reconnected') &&
       !primary.some(row => row.options.reason === 'reconnected'));
  ok('both the old client and late replacement are closed exactly once',
     oldClient.closeCalls === 1 && oldClient.sock.destroyCalls === 1 &&
       replacement.closeCalls === 1 && replacement.sock.destroyCalls === 1);
  const beforeAdvance = { joins, decisions: controller.decisions.length, primary: primary.length };
  await advance(clock, 10_000);
  same('late reconnect completion and stale deadlines cannot resurrect the actor',
       { joins, decisions: controller.decisions.length, primary: primary.length }, beforeAdvance);
  ok('deferred-rejoin cancellation produced no scheduler errors', errors.length === 0);
  scheduler.stop();
}

console.log('\ncritical backpressure preserves exact order and socket flow control');
{
  const clock = new ManualClock({ startMs: 5000 });
  const { scheduler, errors } = runtime(clock);
  const client = fakeClient('backpressure-client');
  const session = { live: true, client, recorder: { stop() {} } };
  const controller = fakeController();
  const attempts = [];
  const delivered = [];
  let accepting = false;
  const actor = new SessionActor({
    id: 'backpressure', session, controller, scheduler, clock,
    reconnect: false, transitionRetryMs: 50,
    project: () => ({ connected: session.live }),
    publishTransition(id, type, payload) {
      attempts.push({ id, type, payload });
      if (!accepting) {
        const error = new Error('transition sink full');
        error.code = 'M59_BACKPRESSURE';
        throw error;
      }
      delivered.push({ id, type, payload });
    },
  });
  await actor.start({
    credentials: { account: 'b', password: 'b', character: 'B' }, join: false,
  });
  await flushNow(clock);

  client.onEvent({ kind: 'death', seq: 1, at: 5000, room: 7,
                   raw: { not: 'part of the transition' } });
  client.onEvent({ kind: 'death', seq: 2, at: 5001, room: 8,
                   text: 'not part of the transition either' });
  ok('first rejected critical transition pauses its owning socket once',
     client.sock.pauseCalls === 1 && client.sock.paused);
  same('later critical transitions queue behind the failed head without overtaking it',
       attempts.map(row => row.payload.seq), [1]);
  await flushNow(clock);
  await advance(clock, 49);
  same('critical delivery is retried only at its deadline',
       attempts.map(row => row.payload.seq), [1]);
  await advance(clock, 1);
  same('a still-full sink retries the exact head and leaves the socket paused',
       attempts.map(row => row.payload.seq), [1, 1]);
  ok('failed retry neither drops nor resumes queued input',
     delivered.length === 0 && client.sock.pauseCalls === 1 &&
       client.sock.resumeCalls === 0 && client.sock.paused);

  accepting = true;
  await advance(clock, 49);
  same('the next retry also waits for its keyed deadline',
       attempts.map(row => row.payload.seq), [1, 1]);
  await advance(clock, 1);
  same('successful retry delivers the head before the queued successor',
       attempts.map(row => row.payload.seq), [1, 1, 1, 2]);
  same('critical payloads remain exact, minimal, and ordered across backpressure', delivered, [
    {
      id: 'backpressure', type: 'death',
      payload: { reason: 'client:death', seq: 1, at: 5000, room: 7 },
    },
    {
      id: 'backpressure', type: 'death',
      payload: { reason: 'client:death', seq: 2, at: 5001, room: 8 },
    },
  ]);
  ok('draining the exact backlog resumes socket input once',
     client.sock.resumeCalls === 1 && !client.sock.paused);
  await actor.stop('backpressure complete');
  ok('backpressure flow produced no scheduler errors', errors.length === 0,
     errors.map(row => row.error?.message).join(','));
  scheduler.stop();
}

console.log(`\nsession runtime: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
