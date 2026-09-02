// Adapt the registered Autopilot to an event/deadline driven outer loop.
//
// Session itself calls autopilotIfAny(name) for damage and travel bookkeeping, so a
// separately constructed subclass would be subtly incomplete. This adapter obtains the
// canonical registered object, leaves every gameplay method on that object, and replaces
// only ownership of the fixed-rate loop and watchdog timer. The legacy broker never
// imports this module.

import { autopilotFor, dropAutopilot } from '../m59-autopilot.mjs';

const noopRecorder = Object.freeze({ line() {}, flush() {}, stop() {} });

export function disableSessionRecorder(session) {
  try { session?.recorder?.stop?.(); } catch { /* best effort */ }
  if (session) session.recorder = noopRecorder;
  return session;
}

export class ManagedAutopilot {
  constructor(session, { mode = 'survive', policy = {} } = {}) {
    if (!session?.name) throw new TypeError('ManagedAutopilot requires a named Session');
    this.session = session;
    this.pilot = autopilotFor(session);
    if (this.pilot?.s !== session) {
      throw new Error(
        `autopilot registry already owns ${session.name} for a different Session`);
    }
    this.disposed = false;
    this.managed = true;
    this._managedLoop = null;
    this._finishManagedLoop = null;

    this.pilot.mode = mode;
    Object.assign(this.pilot.policy, policy);

    const pilot = this.pilot;
    const startWatchdog = pilot.startWatchdog.bind(pilot);
    const stopWatchdog = pilot.stopWatchdog.bind(pilot);

    // Let the real initializer create its watch state, then remove the scanning interval.
    // SessionActor invokes watchdogTick for safety events and exact pass deadlines.
    pilot.startWatchdog = () => {
      startWatchdog();
      stopWatchdog();
      return null;
    };
    pilot.stopWatchdog = () => {
      stopWatchdog();
      return null;
    };
    pilot.loop = () => {
      if (!this._managedLoop) {
        this._managedLoop = new Promise(resolve => { this._finishManagedLoop = resolve; });
      }
      return this._managedLoop;
    };
  }

  get mode() { return this.pilot.mode; }
  set mode(value) { this.pilot.mode = value; }
  get policy() { return this.pilot.policy; }
  get running() { return this.pilot.running; }
  get stopping() { return this.pilot.stopping; }
  get doing() { return this.pilot.doing; }
  get lastDoing() { return this.pilot.lastDoing; }
  get passes() { return this.pilot.passes; }
  get stalledSince() { return this.pilot.stalledSince; }
  get stalledWhy() { return this.pilot.stalledWhy; }
  get lastError() { return this.pilot.lastError; }

  start() {
    if (this.disposed) throw new Error('managed autopilot is disposed');
    return this.pilot.start();
  }

  async runDecision({ reason = 'event' } = {}) {
    const pilot = this.pilot;
    if (this.disposed || !pilot.running || pilot.stopping)
      return { ran: false, reason: 'stopped' };
    pilot.passes++;
    const began = Date.now();
    pilot.passStartedAt = began;
    pilot.passDamageStart = pilot.hitDamageTotal();
    pilot.passPurseStart = pilot.purseNow();
    pilot.passTrade = { earned: 0, spent: 0, banked: 0, sold: [], bought: [], deposited: [] };
    try {
      await pilot.pass();
      const elapsedMs = Date.now() - began;
      pilot.spend(elapsedMs);
      pilot.notePassSucceeded();
      return { ran: true, reason, elapsedMs };
    } catch (error) {
      const elapsedMs = Date.now() - began;
      pilot.spend(elapsedMs);
      pilot.notePassFailed(error);
      return { ran: true, reason, elapsedMs, error };
    } finally {
      pilot.passStartedAt = null;
    }
  }

  runSafetyCheck() {
    const pilot = this.pilot;
    if (this.disposed || !pilot.running || pilot.stopping)
      return { ran: false, reason: 'stopped' };
    try {
      pilot.watchdogTick();
      return { ran: true };
    } catch (error) {
      if (pilot.watch) pilot.watch.lastError = error.message;
      return { ran: true, error };
    }
  }

  stop(reason = 'runtime stopped', { hard = true } = {}) {
    if (this.disposed) return false;
    if (!hard) return this.pilot.stop(reason, { hard: false });
    this.disposed = true;
    dropAutopilot(this.session.name);
    this.pilot.running = false;
    const finish = this._finishManagedLoop;
    this._finishManagedLoop = null;
    this._managedLoop = null;
    finish?.();
    return true;
  }
}
