// A job's guard travels WITH each queued packet, not with the pacer's pump.
// AsyncLocalStorage keeps ordinary keeper/survival work outside the command scope.
// Capture before queuing; recheck after pacing, immediately before the socket call.
import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();

export function withPacketScope(guard, fn) {
  if (typeof guard !== 'function') throw new Error('packet scope needs a guard');
  return scope.run(guard, fn);
}

export function bindPacketScope(kind, fn) {
  const guard = scope.getStore();
  return () => scope.run(guard, () => {
    if (guard) guard(kind);
    return fn();
  });
}
