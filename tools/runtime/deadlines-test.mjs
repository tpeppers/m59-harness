#!/usr/bin/env node
// Deadline propagation, offline. No broker, no socket, no fleet.
//
//   node tools/runtime/deadlines-test.mjs
import assert from 'node:assert/strict';
import { deadlineFrom, recordToolMs, toolP90, shouldAttempt, toolTimings, resetToolTimings,
         recordAbandoned, recordDeclined, recordFailed, unusedTools } from './deadlines.mjs';

// ---------------------------------------------------------------- where a deadline comes from
{
  const now = 1_000_000;
  assert.equal(deadlineFrom({ headers: { 'x-m59-deadline-ms': '2500' } }, now), now + 2500,
    'a header budget is relative to now');
  assert.equal(deadlineFrom({ params: { deadline_ms: 900 } }, now), now + 900,
    'and so is one on the params, which is how stdio callers pass it');
  assert.equal(deadlineFrom({ headers: { 'x-m59-deadline-at': String(now + 400) } }, now), now + 400,
    'an absolute deadline is accepted for anything relaying a budget onward');

  // A BUDGET WINS OVER AN ABSOLUTE ONE. Two machines' clocks are not the same clock, and
  // this is a loopback protocol where the round trip is shorter than the skew.
  assert.equal(deadlineFrom({ headers: { 'x-m59-deadline-ms': '500',
                                         'x-m59-deadline-at': String(now + 90_000) } }, now),
    now + 500, 'the relative budget is preferred');

  // NONSENSE IS ABSENCE, NOT REFUSAL. A confused caller must not be answered by refusing
  // everything it asks for — that turns a bad header into an outage.
  for (const bad of [{ 'x-m59-deadline-ms': '0' }, { 'x-m59-deadline-ms': '-5' },
                     { 'x-m59-deadline-ms': 'soon' }, { 'x-m59-deadline-ms': '99999999' }])
    assert.equal(deadlineFrom({ headers: bad }, now), null, `refused ${JSON.stringify(bad)}`);
  assert.equal(deadlineFrom({ headers: { 'x-m59-deadline-at': String(now - 1) } }, now), null,
    'an absolute deadline already past is a clock disagreement, not a deadline');
  assert.equal(deadlineFrom({}, now), null, 'and no deadline at all is the ordinary case');
}

// ---------------------------------------------------------------- what a tool costs
{
  resetToolTimings();
  assert.equal(toolP90('status'), null, 'no opinion before there is evidence');
  for (let i = 0; i < 7; i++) recordToolMs('status', 100);
  assert.equal(toolP90('status'), null,
    'seven samples is still not an opinion — refusing on two is how one slow first call ' +
    'teaches the broker to stop answering a tool that is usually fast');
  recordToolMs('status', 100);
  assert.equal(toolP90('status'), 100, 'eight is');

  resetToolTimings();
  for (const ms of [10, 10, 10, 10, 10, 10, 10, 10, 10, 4000]) recordToolMs('shop', ms);
  assert.equal(toolP90('shop'), 4000, 'p90 follows the tail, which is the point of using it');

  // Bounded: a tool that gets faster is believed again rather than carrying its worst hour
  // for ever.
  resetToolTimings();
  for (let i = 0; i < 200; i++) recordToolMs('travel', i < 100 ? 9000 : 50);
  assert.ok(toolP90('travel') < 200, `a recovered tool is believed again, got ${toolP90('travel')}`);
}

// ---------------------------------------------------------------- is it worth starting
{
  resetToolTimings();
  const now = 5_000_000;
  // NO DEADLINE MEANS RUN IT. Every existing caller passes nothing, and this must not
  // change what happens to any of them.
  assert.equal(shouldAttempt('status', null, { now }).ok, true);
  assert.equal(shouldAttempt('status', undefined, { now }).ok, true);

  // NO HISTORY MEANS RUN IT. Silence is not knowledge, and the point is to skip work that
  // is KNOWN not to fit.
  assert.equal(shouldAttempt('brand_new_tool', now + 5, { now }).ok, true);

  for (let i = 0; i < 10; i++) recordToolMs('health', 2000);

  // The case that motivated all of this: the Quartermaster's 2.5s abort against a /health
  // that takes 2.5s under load. p90 2000 * 1.2 = 2400 needed.
  const tight = shouldAttempt('health', now + 2500, { now });
  assert.equal(tight.ok, true, 'a caller with 2500ms against a 2000ms p90 is served');
  const tooTight = shouldAttempt('health', now + 2300, { now });
  assert.equal(tooTight.ok, false, 'and one with 2300ms is declined before the work starts');
  assert.match(tooTight.reason, /2000ms at p90/);
  assert.equal(tooTight.remaining, 2300);

  // THE MARGIN IS THE WHOLE JUDGEMENT. Without it a call is started that finishes exactly
  // as the caller hangs up: full cost, no answer, which is the worst of the three outcomes.
  assert.equal(shouldAttempt('health', now + 2100, { now, margin: 1 }).ok, true,
    'margin 1 accepts the call that only just lands');
  assert.equal(shouldAttempt('health', now + 2100, { now }).ok, false,
    'the default asks for headroom instead');

  // An expired deadline is refused whether or not we know the tool.
  assert.equal(shouldAttempt('health', now - 1, { now }).ok, false);
  assert.equal(shouldAttempt('never_seen', now - 1, { now }).ok, false,
    'an expired deadline needs no timing history to be hopeless');
}

// ---------------------------------------------------------------- what it reports
{
  resetToolTimings();
  for (let i = 0; i < 10; i++) { recordToolMs('slow', 3000); recordToolMs('fast', 5); }
  recordToolMs('rare', 999);
  const rows = toolTimings();

  // EVERY TOOL THAT WAS CALLED IS REPORTED, because "is anybody using this" is a different
  // question from "how slow is it" and the declutter pass needs the first one. A tool with
  // too few samples appears with its call count and NO p90 — present, but not pretending to
  // an opinion it has not earned.
  const rare = rows.find(r => r.tool === 'rare');
  assert.equal(rare.calls, 1, 'a rarely-called tool still shows its usage');
  assert.equal(rare.p90_ms, null, 'and no p90, because one sample is not a distribution');
  assert.equal(rows.find(r => r.tool === 'slow').p90_ms, 3000);

  // ABANDONMENT SORTS FIRST. It is the number this whole mechanism exists to drive to zero,
  // so it belongs at the top of the page rather than buried under the slowest tool.
  recordAbandoned('fast'); recordAbandoned('fast');
  recordDeclined('slow'); recordFailed('slow');
  const after = toolTimings();
  assert.equal(after[0].tool, 'fast', 'the most-abandoned tool leads, whatever its p90');
  assert.equal(after[0].abandoned, 2);
  const slow = after.find(r => r.tool === 'slow');
  assert.equal(slow.declined, 1); assert.equal(slow.failed, 1);

  // A DECLUTTER CANDIDATE IS NOT A DEAD TOOL. This answers "not used in THIS window", which
  // is the start of the question and not the end of it — the fleet does not found a guild
  // every hour.
  assert.deepEqual(unusedTools(['slow', 'fast', 'rare', 'never_called', 'also_never']),
    ['also_never', 'never_called'], 'sorted, and only the ones with no calls at all');
  assert.deepEqual(unusedTools([]), [], 'and an empty tool list is answered, not thrown at');
}

// Bookkeeping may never throw: it runs inside the call path.
recordToolMs(null, 5); recordToolMs('x', NaN); recordToolMs('x', -1);
recordAbandoned(null); recordDeclined(undefined); recordFailed(42);
console.log('runtime deadlines: PASS');
