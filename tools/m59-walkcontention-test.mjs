#!/usr/bin/env node
// A REFUSED WALK IS NOT A FAILED WALK — offline: no broker, no server, no network, no roster.
//
//   node tools/m59-walkcontention-test.mjs
//
// THE INCIDENT, prod 2026-09-10. Beaker ran a resupply with `home = 370`, and his keeper's
// `assignedRoom` was ALSO 370. The errand's final `walk(home)` and the keeper's own convergence
// therefore wanted the identical destination and starved each other:
//
//     19:19:40 t6 walking 373 -> 370, budget 188s
//     19:22:58 t6 walking 382 -> 370, budget 180s
//     19:26:04 t6 walking 382 -> 370, budget 180s
//     19:29:05 t6 step 5 (walk) failed: did not reach 370 in three attempts — unwinding
//
// Nine minutes and three attempts on a hop that takes seven and a half seconds. Every travel in
// that window was refused `t6 is busy: walk to Yonder Inn of Jasper` — the keeper's re-issued
// journey holding the body while the errand held the faculties. It happened three times in one
// evening on the same pair, and a travel issued straight after a cancel did it in 5554ms.
//
// TWO DEFECTS, and the second is the one that made it invisible:
//
//  1. `holdKeeper` cancels the keeper's in-flight journey at CLAIM time, which is right and is
//     not enough. By the time an errand reaches its last walk, the keeper has had the whole
//     errand to notice the character is away from `assignedRoom` and start walking it back. The
//     cancel belongs before EVERY walk. (A claim takes the FACULTIES; a journey is a JOB and
//     outlives it — the rule CLAUDE.md already states and this call site did not honour.)
//
//  2. THE REPLY WAS THROWN AWAY. `await call('travel', ...).catch(() => ({}))` discarded it, so
//     `started: false` was followed by polling the character's room for the entire budget. Three
//     minutes of waiting for a walk that never sent a packet, three times — and then a message
//     reading `did not reach 370 in three attempts`, which is what a MOVER failure looks like.
//     `#movement` ledgers are keyed on that distinction being right, so filing contention as a
//     mover defect corrupts the evidence, not just the log line.
//
// Same family as the fourteen origins that all got one fabricated hazard sentence: an instrument
// that cannot produce the value that would show the problem produces a confident wrong one.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_DIR = mkdtempSync(join(tmpdir(), 'm59-wc-'));
process.env.M59_RUNLOCK_DIR = LOCK_DIR;
process.env.M59_CONTROL_URL = 'http://127.0.0.1:1/';   // never actually reached
// The loop under test waits 2.5s between cancel/re-issue passes, measured against the live
// fleet. Shortened here so the suite exercises four passes in a moment.
process.env.M59_BUSY_RACE_MS = '5';

const { stateFileFor } = await import('./m59-fleetpath.mjs');
const { fleetScript, walk } = await import('./m59-fleetscript.mjs');

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const quiet = () => {};

// ---------------------------------------------------------------- the fake broker
//
// Deliberately smaller than m59-fleetscript-test's: the only interesting question here is what
// `travel` answers and what the runner does about it. `replies` is a per-call script — one entry
// consumed per travel — so a test can say "refused busy twice, then it takes".
function fakeBroker({ room = 39, replies = [], arriveAt = null }) {
  const sent = [];
  globalThis.fetch = async (_url, opts) => {
    if (!opts || opts.method !== 'POST')
      return { json: async () => ({ ok: true, fleet: 'testfleet',
                                    state: stateFileFor('testfleet') }) };
    const body = JSON.parse(opts.body);
    const { name, arguments: a } = body.params;
    sent.push({ name, ...a });
    let payload = { ok: true };
    if (name === 'status') payload = { where: { num: room, name: 'room' },
                                       hp: { value: 50, max: 50 }, gold: null };
    else if (name === 'travel_estimate') payload = { ms: 1000, hops: 2 };
    else if (name === 'travel') {
      const scripted = replies.length ? replies.shift() : { started: true };
      // A STARTED WALK MOVES THE BODY; A REFUSED ONE DOES NOT. That asymmetry is the whole
      // subject: the old code could not tell the two apart, so it waited for both.
      if (scripted.started === true) room = arriveAt ?? a.to;
      payload = scripted;
    }
    return { json: async () => ({ result: { content: [{ text: JSON.stringify(payload) }] } }) };
  };
  return sent;
}

const BUSY = { started: false, error: 't6 is busy: walk to Yonder Inn of Jasper' };
// `results[agent]` is the agent's row — `{ ok, at, step, why, ... }` on a failure — and the
// per-step results hang off `state` keyed `<index>:<verb>`. Both are asserted here: the row is
// what a caller reads, the step is what the runner recorded.
const rowOf = (r, agent = 'a1') => r.results?.[agent] ?? {};
const stepOf = (r, agent = 'a1') => Object.values(rowOf(r, agent).state ?? {})[0] ?? {};
// THE BUDGET IS SHRUNK, NOT WAIVED. A walk that really sets out and fails has to be waited for
// -- that patience is guarantee 8 and the reason a failing walk once took nine minutes to reach
// its verdict -- so the suite keeps the waiting and makes it short. 180s x 3 attempts is nine
// minutes of real time, which is not a test anyone would run.
const run = (steps, onLog = quiet, opts = {}) =>
  fleetScript({ name: 'contention', fleet: 'testfleet', agents: ['a1'], steps, onLog,
                pollMs: 5, budgetFloorMs: 40, budgetCapMs: 60, ...opts });

console.log('');
console.log('A BUSY REFUSAL IS A RACE, AND THE WAY TO WIN IT IS TO CANCEL AND RE-ISSUE');
{
  // Two refusals then a launch: exactly Beaker's shape, except that this now costs three
  // sends instead of two 188-second waits.
  const sent = fakeBroker({ room: 373, replies: [BUSY, BUSY, { started: true }] });
  const t0 = Date.now();
  const r = await run([walk(370)]);
  const took = Date.now() - t0;
  const travels = sent.filter(c => c.name === 'travel');

  ok('the errand succeeds', r.ok === true, JSON.stringify(r.results ?? r));
  ok('and it re-issued rather than waiting', travels.length === 3, `${travels.length} travel(s)`);
  ok('every one of them asked for the same room', travels.every(c => c.to === 370));
  // The old code polled `budget` (188s live, and here the estimate makes it the floor) after a
  // refusal. The claim is that a refusal is now noticed at once.
  ok('and the whole thing took seconds, not budgets', took < 20_000, `${took}ms`);
}

console.log('');
console.log('   the race is BOUNDED, and a body that is never released is reported as CONTENTION');
{
  // Every send refused. The old message was `did not reach 370 in three attempts`, which reads
  // as a mover failure; there is no mover in this test at all.
  const sent = fakeBroker({ room: 373, replies: Array.from({ length: 40 }, () => BUSY) });
  const logs = [];
  const r = await run([walk(370)], (_a, m) => logs.push(String(m)));
  const travels = sent.filter(c => c.name === 'travel');

  ok('the step fails', r.ok === false);
  const step = stepOf(r), row = rowOf(r);
  ok('and it says the walk NEVER STARTED, on the step', step.never_started === true,
     JSON.stringify(step));
  // THE FLAG HAS TO REACH THE CALLER, not just the step record: a ledger that has to parse a
  // sentence to tell contention from a mover failure will get it wrong.
  ok('and on the row a caller actually reads', row.never_started === true, JSON.stringify(row));
  ok('and names contention rather than a mover failure',
     /CONTENTION, not a mover failure/.test(step.why ?? ''), step.why);
  ok('and quotes the refusal it kept getting', /is busy/.test(step.why ?? ''), step.why);
  ok('and lists every refusal it collected', (step.refusals ?? []).length >= 3,
     JSON.stringify(step.refusals));
  // 3 outer attempts x (1 send + 2 races) = 9. The bound is the point: an unbounded retry
  // against a keeper that will not yield is a different failure with the same footprint. And
  // the retry count is deliberately small — one clean cancel wins the race, so a long grind
  // here would be treating a measurement error as a mechanism.
  ok('the sends are bounded', travels.length > 3 && travels.length <= 9,
     `${travels.length} travel(s)`);
  ok('and it said out loud that it was cancelling the keeper journey',
     logs.some(m => /keeper is holding the body/.test(m)), logs.join(' | ').slice(0, 200));
  ok('and that it refused to wait out a budget for a walk that never began',
     logs.some(m => /NOT STARTED/.test(m) && /never began/.test(m)),
     logs.filter(m => /NOT STARTED/.test(m)).join(' | ').slice(0, 200));
}

console.log('');
console.log('A NAMED REFUSAL IS AN ANSWER — waiting cannot change it, and neither can retrying');
{
  // The broker's own journey gate. Retrying this is not a race, it is a loop: the destination
  // will still be unreachable and the body will still be hurt on the next pass.
  const gated = { started: false, refused: 'too_hurt',
                  why: 'at 20%, below the 35% floor this character sets out at' };
  const sent = fakeBroker({ room: 373, replies: [gated, { started: true }] });
  const r = await run([walk(370)]);
  const travels = sent.filter(c => c.name === 'travel');

  ok('the step fails at once', r.ok === false);
  ok('and it did NOT retry a decision', travels.length === 1, `${travels.length} travel(s)`);
  const step = stepOf(r);
  ok('it reports the broker\'s own reason verbatim',
     /below the 35% floor/.test(step.why ?? ''), step.why);
  ok('and carries the machine-readable code on the step and the row',
     step.refused === 'too_hurt' && rowOf(r).refused === 'too_hurt',
     JSON.stringify({ step: step.refused, row: rowOf(r).refused }));
}

console.log('');
console.log('AND A WALK THAT REALLY DOES SET OUT AND FAIL IS STILL REPORTED AS THAT');
{
  // The polarity that must not be lost: if the sends all succeed and the body does not arrive,
  // that IS a mover failure and has to keep reading as one. `arriveAt` keeps the body still
  // while every travel reports success.
  const sent = fakeBroker({ room: 373, arriveAt: 373 });
  const r = await run([walk(370)]);
  const travels = sent.filter(c => c.name === 'travel');
  const step = stepOf(r);

  ok('the step fails', r.ok === false);
  ok('it set out three times', travels.length === 3, `${travels.length} travel(s)`);
  ok('and the verdict says so, with the count',
     /did not reach 370 in three attempts/.test(step.why ?? '') &&
     /3 of them actually set out/.test(step.why ?? ''), step.why);
  ok('and it is NOT filed as contention',
     !step.never_started && !rowOf(r).never_started, JSON.stringify(step));
}

rmSync(LOCK_DIR, { recursive: true, force: true });
console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
