#!/usr/bin/env node
// A DYING BODY DOES NOT WAIT ITS TURN — offline, no fleet, no socket, no roster.
//
//   node tools/m59-survival-preempt-test.mjs
//
// `passFleeAndRest` sits fifth in PASS_STAGES. Everything above it is bounded at fifteen
// seconds, which is the right bound for a HUNG rung and far too long for a dying one: the
// measured loss on these deaths is 2 to 8.2 health per second, so fifteen seconds is 30 to
// 120 damage against characters whose entire bar is 50 to 60. A rung that is merely slow —
// not hung, so no deadline fires and nothing looks wrong — can spend a character's whole
// remaining health before the rung that would have saved it is reached.
//
// So the ladder runs survival FIRST when the body is below its flee line and still losing,
// and the ordinary walk then skips it. This pins that, and pins the three ways it must NOT
// fire, because a rung that preempts on an ordinary resting character would starve every
// directional rung the fleet earns from.
import assert from 'node:assert/strict';
import { Autopilot, PASS_STAGES, HANDLED, CONTINUE, STAGE_OVERRAN } from './m59-autopilot.mjs';

let n = 0;
const ok = (c, why) => { n++; assert.ok(c, why); };
const eq = (a, b, why) => { n++; assert.equal(a, b, why); };

/** A keeper with just enough on it for `runPassLadder` to walk, and nothing else. */
function keeper({ health = 10, max = 100, fleeAt = 0.4, rate = -3, job = null,
                  inFlight = null, verdicts = {} } = {}) {
  const ran = [];
  const cancels = [];
  const k = Object.assign(Object.create(Autopilot.prototype), {
    s: {
      client: { vitals: () => ({ health: { value: health, max } }) },
      world: { room: { num: 599 } },
      job,
      cancelMovement: (tok, why) => { cancels.push(why); if (job) job.done = true; return { cancelled: true }; },
    },
    policy: {}, tally: {}, passes: 1,
    // A frame ring the real `healthRate` can read: two frames, losing `rate` per second.
    recent5: [{ at: Date.now() - 4000, health: health - rate * 4, max },
              { at: Date.now(), health, max }],
    safety: () => ({ fleeAt }),
    note: () => {},
    stageInFlight: inFlight ? new Set([inFlight]) : new Set(),
    travelInterrupted: () => false,
    traceThisPass: () => {},
    runStageBounded: async (stage) => { ran.push(stage); return verdicts[stage] ?? CONTINUE; },
  });
  return { k, ran, cancels };
}

// ---------------------------------------------------------------- it fires
{
  const { k, ran } = keeper({ health: 10, max: 100, fleeAt: 0.4, rate: -3 });
  await k.runPassLadder({});
  eq(ran[0], 'passFleeAndRest',
     'below the flee line and losing, survival runs FIRST — before passUnderworld, passArm, '
     + 'passPlaybook and passFightBack, which are 15s of exposure each');
  eq(ran.filter(x => x === 'passFleeAndRest').length, 1,
     'and exactly once — a rung invoked twice in one pass is the double-invocation the '
     + 'in-flight skip exists to prevent');
  ok(ran.length > 1, 'the ordinary ladder still runs after it when survival has nothing to do');
  eq(k.tally.survival_preempted, 1, 'and it is counted, so the board can show it happening');
}

// ---------------------------------------------------------------- it does not fire
{
  // HEALTHY. The commonest state in the fleet; preempting here would starve every
  // directional rung and the fleet earns nothing.
  const { k, ran } = keeper({ health: 90, max: 100, fleeAt: 0.4, rate: -3 });
  await k.runPassLadder({});
  eq(ran[0], PASS_STAGES[0], 'a healthy character walks the ladder in its ordinary order');
  eq(k.tally.survival_preempted, undefined, 'and nothing is counted');
}
{
  // BELOW THE LINE BUT NOT LOSING — a character resting at a wall, which is where the
  // survival ladder has already put it. It sits here for minutes by design, and firing on
  // it every pass would be an infinite preempt on a character that is already safe.
  const { k, ran } = keeper({ health: 10, max: 100, fleeAt: 0.4, rate: +2 });
  eq(k.mortalDanger(), null, 'gaining health is not mortal danger, however low the bar is');
  await k.runPassLadder({});
  eq(ran[0], PASS_STAGES[0], 'so the ladder is not preempted while it recovers');
}
{
  // LOSING BUT ABOVE THE LINE — an ordinary fight. The keeper is supposed to be in these.
  const { k } = keeper({ health: 80, max: 100, fleeAt: 0.4, rate: -5 });
  eq(k.mortalDanger(), null, 'taking damage above the flee line is a fight, not a death');
}

// ---------------------------------------------------------------- the in-flight rung
{
  // Already running from an earlier pass. The deadline bounds the WAIT and never the WORK,
  // so the previous invocation is still out there walking the body — starting a second one
  // on top of it is worse than the hang it would be fixing.
  const { k, ran } = keeper({ health: 10, max: 100, rate: -3, inFlight: 'passFleeAndRest' });
  await k.runPassLadder({});
  eq(ran.filter(x => x === 'passFleeAndRest').length, 0,
     'a survival rung already in flight is never invoked a second time, even to preempt');
}

// ---------------------------------------------------------------- nothing waits
{
  // A walk chosen by a rung that did not know the body was dying. The survival rung is
  // about to choose a different destination, so waiting for the old one is spent at 2-8
  // health per second and discarded on arrival.
  const job = { kind: 'travel', label: 'to Castle Victoria', done: false };
  const { k, ran, cancels } = keeper({ health: 10, max: 100, rate: -3, job });
  await k.runPassLadder({});
  eq(cancels.length, 1, 'an in-flight walk is cancelled rather than waited out');
  ok(/still losing/.test(cancels[0]), 'and the reason names the damage that triggered it');
  eq(ran[0], 'passFleeAndRest',
     'the cancel and the rung that acts on it happen in the same breath — cancelling and '
     + 'then waiting for a later pass is what left a character walking zero squares in '
     + 'fifteen seconds in Ukgoth');
}
{
  const { k, cancels } = keeper({ health: 10, max: 100, rate: -3, job: null });
  await k.runPassLadder({});
  eq(cancels.length, 0, 'with nothing in flight there is nothing to cancel');
}

// ---------------------------------------------------------------- verdicts are honoured
{
  const { k, ran } = keeper({ health: 10, max: 100, rate: -3,
                              verdicts: { passFleeAndRest: HANDLED } });
  const decided = await k.runPassLadder({});
  eq(decided, 'passFleeAndRest', 'a survival rung that HANDLED the tick ends the pass');
  eq(ran.length, 1, 'and nothing below it runs on top of a body it just moved');
}
{
  const { k, ran } = keeper({ health: 10, max: 100, rate: -3,
                              verdicts: { passFleeAndRest: STAGE_OVERRAN } });
  const decided = await k.runPassLadder({});
  eq(decided, 'passFleeAndRest', 'and one that overran the deadline ends it too');
  eq(ran.length, 1, 'rather than stacking the next rung on a rung still running');
}

console.log(`m59-survival-preempt-test: ${n} assertions passed`);
