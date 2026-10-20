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

// Stage identity follows awaits and paced callbacks; it is not a mutable current-rung label.
export function withBodyStage(session,stage,fn,token=null){
 const parent=scope.getStore(),same=parent?.session===session;
 return scope.run({...same?parent:{epoch:session.combatEpoch??0,owner:null},session,stage,stageToken:token??(same?parent.stageToken:null)},fn);
}

// A keeper's active recovery must not spend its escape window behind a
// diagnostic read backlog. Preserve the enclosing authority and epoch: this
// changes queue order only, never who may command the body.
export function withRecoveryCommand(session, fn) {
  const parent=scope.getStore(),same=parent?.session===session;
  return scope.run({...same?parent:{},session,epoch:same?parent.epoch:session.combatEpoch??0,
    owner:same?parent.owner:null,priority:1},fn);
}

export function bodyAuthority(session) {
  const context = scope.getStore();
  const epoch = context?.session === session ? context.epoch : session.combatEpoch ?? 0;
  const owner = context?.session === session ? context.owner : null;
  return {
    stage: context?.session===session?context.stage??null:null,
    priority: Math.max(owner ? 2 : 0, context?.session===session ? context.priority??0 : 0),
    bind: fn => () => scope.run(context, fn),
    guard() {
      if (context?.session === session && context.stageToken?.cancelled) {
        const error = new Error("ordinary body stage preempted by survival");
        error.code = "STAGE_PREEMPTED"; throw error;
      }
      if (epoch !== (session.combatEpoch ?? 0) ||
          (session.combat?.active && owner !== session.combat.active.id))
        throw new BodyCommandPreempted();
    },
  };
}
