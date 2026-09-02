import { finiteDelay, sleepWith } from './internal.mjs';

// The production clock. Its deliberately small interface is also the interface expected
// by ManualClock and ScaledClock, so runtime code never needs to know which one it received.
export class RealClock {
  constructor({
    now = () => Date.now(),
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: cancel = globalThis.clearTimeout,
  } = {}) {
    if (typeof now !== 'function' || typeof schedule !== 'function' || typeof cancel !== 'function')
      throw new TypeError('RealClock requires callable now, setTimeout, and clearTimeout functions');
    this._now = now;
    this._schedule = schedule;
    this._cancel = cancel;
  }

  get kind() { return 'real'; }

  now() {
    const value = Number(this._now());
    if (!Number.isFinite(value)) throw new RangeError('the real clock returned a non-finite time');
    return value;
  }

  setTimeout(callback, delayMs) {
    if (typeof callback !== 'function') throw new TypeError('timer callback must be a function');
    return this._schedule(callback, finiteDelay(delayMs));
  }

  clearTimeout(handle) { this._cancel(handle); }

  sleep(delayMs, options) { return sleepWith(this, delayMs, options); }
}
