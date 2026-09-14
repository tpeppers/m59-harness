// Body authority survives awaits and is checked again at the packet boundary.
// A newer combat order invalidates old work, including its queued cleanup packets.
import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();

export class BodyCommandPreempted extends Error {
  constructor() { super('body command preempted by combat override'); this.code = 'COMBAT_PREEMPTED'; }
}

export function withBodyCommand(session, fn, owner = null) {
  const parent = scope.getStore();
  if (parent?.session === session && owner === null) return fn();
  return scope.run({ session, epoch: session.combatEpoch ?? 0, owner }, fn);
}

export function bodyAuthority(session) {
  const context = scope.getStore();
  const epoch = context?.session === session ? context.epoch : session.combatEpoch ?? 0;
  const owner = context?.session === session ? context.owner : null;
  return {
    priority: owner ? 2 : 0,
    bind: fn => () => scope.run(context, fn),
    guard() {
      if (epoch !== (session.combatEpoch ?? 0) ||
          (session.combat?.active && owner !== session.combat.active.id))
        throw new BodyCommandPreempted();
    },
  };
}
