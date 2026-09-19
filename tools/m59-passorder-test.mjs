#!/usr/bin/env node
// m59-passorder-test.mjs — THE ORDER THE KEEPER DECIDES IN, AND THE RULE THAT STOPS IT
// DECIDING TWICE IN ONE TICK.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// IF WE WANT TO CHANGE THE ORDERING, THIS TEST WILL NEED TO UPDATE ALONG WITH THAT.
// It is not here to say the current order is the right one. It is here to stop the order
// changing by ACCIDENT — because when it does, nothing errors, nothing stalls, and every
// row on the fleet board still reads healthy while a hurt character goes hunting.
// ─────────────────────────────────────────────────────────────────────────────────────
//
// What it is guarding against, specifically. `pass()` used to be one enormous function in
// which `return;` meant "this tick is over". Splitting it into named stages changed that
// contract silently: a bare `return;` yields `undefined`, and the first cut of the caller
// read `undefined` as "carry on to the next stage". The stages that fell through included
//
//   * passUnderworld, having just walked somewhere safe to recover after a death
//   * passFleeAndRest, having just had a rest interrupted by damage
//   * passErrand, having just completed a bank run
//
// all of which continued into passFarm and went hunting in the same tick. Three of the
// four protected faculties, defeated by a falsy return value.
//
// So the verdict is a Symbol now, and this file pins both halves: the ORDER (the array)
// and the SHORT-CIRCUIT (that HANDLED ends the tick and CONTINUE does not). It drives the
// REAL `Autopilot.prototype.runPassLadder` — the method `pass()` actually calls — with the
// stage methods swapped for recorders. Not a copy of the ladder: a test that reimplements
// the thing it is testing would have passed against the broken version.
//
// Offline. Opens no socket, joins nobody, and needs no broker.

import { Autopilot, PASS_STAGES, HANDLED, CONTINUE, STAGE_OVERRAN,
         stageDeadlineMs } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => {
  if (cond) { passed++; console.log('  ok  ', what); }
  else { failed++; console.log('  FAIL', what); }
};

// ------------------------------------------------------------------ the order itself

console.log('\nthe order the keeper decides in');
{
  // Urgency descending. Each line is a claim about what outranks what, and the comment is
  // the reason — change the array and you are changing one of these claims.
  ok('there are nine stages', PASS_STAGES.length === 9);
  ok('being dead is decided first — the Underworld has no graph exits, so a character ' +
     'left there stays there',
     PASS_STAGES[0] === 'passUnderworld');
  ok('then being unarmed, because nothing below this may walk out to hunt without a weapon',
     PASS_STAGES[1] === 'passArm');
  ok('then the playbook, because a player attacking us is the one case the keeper is ' +
     'structurally blind to and the fleet director may have an opinion about',
     PASS_STAGES[2] === 'passPlaybook');
  // THE FIGHT-BACK EDICT IS ABOVE THE LADDER AND DEFERS TO IT. Above, because what it
  // exists to outrank is every wall, pull and walk that kept a character from answering the
  // thing chewing on it for ten seconds; and it steps aside below the flee line itself, so
  // the survival ladder still wins the case that matters. Off unless an operator set it.
  ok('then the fight-back edict, an operator\'s order that is off by default',
     PASS_STAGES[3] === 'passFightBack');
  ok('then danger and being hurt — the survival ladder',
     PASS_STAGES[4] === 'passFleeAndRest');
  // FOLLOWING A PERSON IS BELOW SURVIVAL AND ABOVE EVERYTHING DIRECTIONAL, and both halves
  // of that are claims. Below survival, because being led somewhere is never worth dying on
  // the way to — a leader cannot see a follower's health bar. Above everything directional,
  // because the entire reason to lead a group by hand is that the person in front knows a
  // door the router keeps getting wrong, and an errand or a farm assignment must not be able
  // to peel a follower off mid-room.
  ok('then following a person who is leading us', PASS_STAGES[5] === 'passFollow');
  ok('then whoever else is driving, which owns everything directional from there down',
     PASS_STAGES[6] === 'passOutside');
  ok('then an errand, which outranks farming and is outranked by everything above it',
     PASS_STAGES[7] === 'passErrand');
  ok('and the actual job is last', PASS_STAGES[8] === 'passFarm');

  ok('every stage names a real method on the keeper',
     PASS_STAGES.every(n => typeof Autopilot.prototype[n] === 'function'));
  ok('and no stage is listed twice', new Set(PASS_STAGES).size === PASS_STAGES.length);
}

// ------------------------------------------------------------------ the short circuit

// A keeper stripped to exactly what `pass()` touches before the ladder. Everything the
// preamble does — posting position, reading vitals, the self-missing check — is stubbed to
// something inert, so what this exercises is the ladder and nothing else.
function harness({ verdicts = {} } = {}) {
  const calls = [];
  const notes = [];
  const ap = Object.create(Autopilot.prototype);

  for (const stage of PASS_STAGES) {
    ap[stage] = async () => {
      calls.push(stage);
      return stage in verdicts ? verdicts[stage] : CONTINUE;
    };
  }
  ap.note = (what, detail) => notes.push({ what, detail });
  ap.tally = {};
  return { ap, calls, notes };
}

// THE REAL LADDER, NOT A COPY OF IT. `runPassLadder` is the actual method `pass()` calls;
// it was split out of `pass()` for exactly this reason, so that asserting the order does
// not require standing up a live session — and so that this file cannot drift into
// testing its own reimplementation, which would have passed against the broken version.
const runLadder = (ap) =>
  Autopilot.prototype.runPassLadder.call(ap, { s: null, c: null, room: null, v: null, hp: null });

console.log('\nCONTINUE falls through, HANDLED stops the tick');
{
  const { ap, calls, notes } = harness({});
  await runLadder(ap);
  ok('with every stage returning CONTINUE, all nine run in order',
     JSON.stringify(calls) === JSON.stringify(PASS_STAGES));
  ok('and nothing is reported as missing a verdict', notes.length === 0);
}
{
  const { ap, calls, notes } = harness({ verdicts: { passFleeAndRest: HANDLED } });
  const stopped = await runLadder(ap);
  ok('a stage that returns HANDLED ends the tick', stopped === 'passFleeAndRest');
  ok('nothing after it runs',
     JSON.stringify(calls) ===
     JSON.stringify(['passUnderworld', 'passArm', 'passPlaybook', 'passFightBack', 'passFleeAndRest']));
  ok('and it is not reported as a fault', notes.length === 0);
}

// ------------------------------------------------------------------ the actual bug

console.log('\nthe fall-through this exists to prevent');
{
  // THE REGRESSION, WRITTEN AS A TEST. A stage that does `return;` yields undefined.
  // Before the sentinel, undefined was falsy and the ladder carried on — so a character
  // that had just dealt with a death, a broken rest or a completed bank run went on to
  // farm in the same tick. Now it ends the tick AND says so.
  const { ap, calls, notes } = harness({ verdicts: { passUnderworld: undefined } });
  const stopped = await runLadder(ap);
  ok('a bare `return;` (undefined) ends the tick rather than falling through',
     stopped === 'passUnderworld');
  ok('so recovering after a death cannot continue into farming in the same tick',
     !calls.includes('passFarm'));
  ok('and the stage that did it is named, because being silent is what let this survive',
     notes.length === 1 && notes[0].detail.stage === 'passUnderworld');
}
{
  // The other half of the same rule: `true` and `false` are no longer verdicts. They were
  // the first refactor's contract, so anything left over from it must be loud rather than
  // half-working — `false` in particular used to mean "carry on", and now does not.
  const { ap, calls, notes } = harness({ verdicts: { passErrand: false } });
  const stopped = await runLadder(ap);
  ok('a leftover `return false;` no longer silently means "carry on"',
     stopped === 'passErrand' && !calls.includes('passFarm'));
  ok('and it is reported', notes.length === 1 && notes[0].detail.got === 'false');
}
{
  const { ap, calls, notes } = harness({ verdicts: { passArm: true } });
  await runLadder(ap);
  ok('a leftover `return true;` stops the tick and is reported too',
     !calls.includes('passFarm') && notes.length === 1 && notes[0].detail.got === 'true');
}

// ------------------------------------------------------------------ the sentinels

console.log('\nthe sentinels themselves');
{
  ok('HANDLED and CONTINUE are Symbols, so nothing can arrive as one by accident',
     typeof HANDLED === 'symbol' && typeof CONTINUE === 'symbol');
  ok('and they are not each other', HANDLED !== CONTINUE);
}

// ---------------------------------------------- A RUNG THAT HANGS MUST NOT HOLD THE LADDER
//
// The defect this pins, measured on prod 2026-09-19 over 36 deaths in fourteen hours: 21 of
// them had ONE rung owning more than 80% of the blocked pass (`passFleeAndRest` 10, `passFarm`
// 9, `passOutside` 2), the worst 533 seconds of a 534-second pass inside `passFarm`. The
// ladder awaited each rung with no deadline, so a rung that never returned meant a keeper that
// never decided anything again — including fleeing, because `passFleeAndRest` is a rung like
// any other and cannot run while something above it is still awaiting. `fled_in_time` across
// those deaths ran 0.02 to 0.22 against a 0.68 flee threshold: the flee decision was not
// losing an argument, it was never reached.

console.log('\nthe deadlines themselves');
{
  ok('every stage has a deadline', PASS_STAGES.every(s => stageDeadlineMs(s) > 0));
  ok('the survival rungs are bounded tightest — they decide at the one-second clock',
     stageDeadlineMs('passFleeAndRest') <= stageDeadlineMs('passFarm'));
  ok('an override of 0 restores the old unbounded behaviour exactly, for a bisect',
     stageDeadlineMs('passFarm', { M59_STAGE_DEADLINE_MS: '0' }) === 0);
  // AN UNUSABLE VALUE KEEPS THE COMMITTED ONE. A typo must not silently unbound the ladder.
  ok('and an unparseable override is ignored rather than applied',
     stageDeadlineMs('passFarm', { M59_STAGE_DEADLINE_MS: 'soon' }) === stageDeadlineMs('passFarm'));
}

console.log('\na rung that hangs is abandoned by the LADDER and not by the WORK');
{
  const { ap, calls, notes } = harness({});
  let release; const hang = new Promise(r => { release = r; });
  let farmFinished = false;
  ap.passFarm = async () => { calls.push('passFarm'); await hang; farmFinished = true; return CONTINUE; };
  process.env.M59_STAGE_DEADLINE_MS = '40';

  const stopped = await runLadder(ap);
  ok('the pass ends on the rung that overran', stopped === 'passFarm');
  ok('and every rung ABOVE it got its turn first',
     JSON.stringify(calls) === JSON.stringify(PASS_STAGES));
  ok('the overrun is reported, not silent',
     notes.some(n => /overran the ladder deadline/.test(n.what)));
  ok('and the note says the work was not cancelled',
     notes.some(n => /STILL RUNNING/.test(String(n.detail?.why ?? ''))));
  ok('the rung really is still running — nothing cancelled it', farmFinished === false);

  // THE SECOND PASS IS THE WHOLE POINT: survival runs again while the stuck rung finishes.
  calls.length = 0;
  await runLadder(ap);
  ok('the next pass runs the survival ladder again',
     calls.includes('passFleeAndRest'));
  ok('and does NOT invoke the stuck rung a second time — two shopping trips on one body is ' +
     'worse than the hang', !calls.includes('passFarm'));
  ok('the skip is counted', ap.tally.stage_skipped_in_flight >= 1);

  // And once it settles, the rung is available again.
  release(CONTINUE);
  await hang.then(() => {}).catch(() => {});
  await new Promise(r => setTimeout(r, 10));
  calls.length = 0;
  await runLadder(ap);
  ok('once the rung finally returns it is callable again', calls.includes('passFarm'));
  delete process.env.M59_STAGE_DEADLINE_MS;
}

console.log('\nthe bound is invisible to a rung that answers in time');
{
  const { ap, calls } = harness({ verdicts: { passFleeAndRest: HANDLED } });
  process.env.M59_STAGE_DEADLINE_MS = '5000';
  const stopped = await runLadder(ap);
  ok('a prompt HANDLED still ends the tick exactly as before', stopped === 'passFleeAndRest');
  ok('and nothing below it ran', !calls.includes('passFarm'));
  delete process.env.M59_STAGE_DEADLINE_MS;
}

console.log('\na rung that throws still throws — the bound must not swallow a fault');
{
  const { ap } = harness({});
  ap.passArm = async () => { throw new Error('the arm rung blew up'); };
  process.env.M59_STAGE_DEADLINE_MS = '5000';
  let caught = null;
  try { await runLadder(ap); } catch (e) { caught = e; }
  ok('the throw propagates as it always did', /the arm rung blew up/.test(String(caught)));
  delete process.env.M59_STAGE_DEADLINE_MS;
}

console.log('\nan abandoned rung that throws later cannot crash the keeper');
{
  const { ap } = harness({});
  let boom; const later = new Promise((_, rej) => { boom = rej; });
  ap.passFarm = async () => { await later; };
  process.env.M59_STAGE_DEADLINE_MS = '30';
  let unhandled = null;
  const onUnhandled = e => { unhandled = e; };
  process.on('unhandledRejection', onUnhandled);
  await runLadder(ap);
  boom(new Error('abandoned rung failed five minutes later'));
  await new Promise(r => setTimeout(r, 60));
  process.off('unhandledRejection', onUnhandled);
  ok('the late rejection is swallowed rather than taking the process down', unhandled === null);
  delete process.env.M59_STAGE_DEADLINE_MS;
}


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
