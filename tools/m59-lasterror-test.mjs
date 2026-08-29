#!/usr/bin/env node
// m59-lasterror-test.mjs — `last_error` MEANS NOW, OR IT MEANS NOTHING.
//
//   node tools/m59-lasterror-test.mjs
//
// Offline. Opens no socket, joins nobody, needs no broker.
//
// ======================== WHAT THIS PINS ========================
//
// The keeper's status snapshot calls `last_error` "the one field worth reading before
// anything else", and everything that reads it — an operator, the hourly strategy review,
// the ten-minute play tick — reads it in the present tense. It was set in two places and
// cleared in exactly one: the constructor. So it did not mean "what is wrong"; it meant
// "the most recent thing that ever went wrong", and after the first blip of a process the
// two stopped being the same sentence.
//
// The blip is not an edge case — it is a survival FEATURE firing. `breakOutViaLogoff`
// leaves a crowded spot by calling reconnect() → rejoin(), which destroys the socket and
// nulls `client` for ~800ms. `live` is false for that window, so any action the in-flight
// pass still attempts throws, and the pass-loop catch — which exists for exactly this,
// "the session may simply have gone away underneath it" — records it. The character heals
// on the next pass. The FIELD did not.
//
// Measured on JohnsSlave / agent `psycho`, fleet `lan`, 2026-08-29, one process:
//
//   07:09Z  activity "NOT IN GAME", last_error `agent "psycho" is not in game — call join
//           first`, three consecutive failed passes, mid-relocation 575 -> 586
//   07:15Z  same process, no operator action: connected, "fighting from a proven safe
//           spot", 23/27 health, 4 kills, 0 deaths — and the identical last_error string
//   58 min  16 breakouts, every one of them a guaranteed client-null window
//
// A reader could not tell "transient, already healed" from "session actually dead", and a
// second poll did not settle it, because healing did not clear the field.
//
// So this pins three claims:
//   1. a completed pass on a LIVE session clears it, and leaves a journal line saying so;
//   2. it is stamped and attributed, so a reader that keeps history can still tell a
//      four-minute-old scar from a live wound in one poll;
//   3. a REPEATING failure — the genuinely dangerous case — is visible as a climbing
//      count rather than as the same flat string it had five minutes ago.
//
// It drives the REAL methods `loop()` calls. They were named and split out for that
// reason: the catch arm sleeps five seconds, so a test that went through `loop()` could
// not ask more than one question a working day.

import { readFileSync } from 'node:fs';
import { Autopilot } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

const AUTOPILOT = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');

// A keeper stripped to exactly what the two bookkeeping methods touch. `s.live` is the
// session's own answer and is the only input that decides whether a completed pass counts
// as a recovery, so it is the knob this harness turns.
function keeper({ live = true } = {}) {
  const notes = [];
  const ap = Object.create(Autopilot.prototype);
  ap.lastError = null;
  ap.lastErrorAt = null;
  ap.lastErrorLive = null;
  ap.consecutivePassFailures = 0;
  ap.s = { get live() { return ap._live; } };
  ap._live = live;
  ap.note = (what, detail) => notes.push({ what, detail });
  return { ap, notes };
}

const fail = (ap, msg) => Autopilot.prototype.notePassFailed.call(ap, new Error(msg));
const succeed = (ap) => Autopilot.prototype.notePassSucceeded.call(ap);

// ------------------------------------------------------------------ 1. the clearing

console.log('\nthe blip, and the recovery that has to clear it');
{
  const { ap, notes } = keeper();
  // The reconnect window: breakOut() nulls the client, so the in-flight pass throws.
  ap._live = false;
  fail(ap, 'agent "psycho" is not in game — call join first');
  ok('the failure is recorded, as it always was',
     ap.lastError === 'agent "psycho" is not in game — call join first');
  ok('and attributed to a session that was NOT live — the self-inflicted kind',
     ap.lastErrorLive === false);
  ok('and the journal line carries that boolean, which is the five-second check',
     notes.at(-1).what === 'pass failed' && notes.at(-1).detail.live === false);

  // 800ms later the rejoin has completed and the next pass runs clean.
  ap._live = true;
  succeed(ap);
  ok('THE BUG: a completed pass on a live session clears the field', ap.lastError === null);
  ok('and clears its stamp with it, so the three never disagree',
     ap.lastErrorAt === null && ap.lastErrorLive === null);
  ok('and the consecutive count goes back to zero', ap.consecutivePassFailures === 0);
  ok('and the recovery is a journal line, not a silent erasure',
     notes.at(-1).what === 'recovered');
  ok('which names the error it recovered from',
     /not in game/.test(notes.at(-1).detail.after));
  ok('and how long the character was unwell for',
     notes.at(-1).detail.unwell_for_s === 0);
  ok('and how many passes it took', notes.at(-1).detail.failed_passes === 1);
}

console.log('\na pass that completes while the session is NOT live is not a recovery');
{
  // The distinction the fix turns on. A pass can finish without touching the wire, and
  // the error class being cleared is precisely "the session went away" — so clearing on
  // "the pass returned" alone would advertise health that has not been demonstrated.
  const { ap, notes } = keeper({ live: false });
  fail(ap, 'agent "psycho" is not in game — call join first');
  succeed(ap);
  ok('the error stands', ap.lastError !== null);
  ok('and nothing claims a recovery', !notes.some(n => n.what === 'recovered'));
  ok('but the consecutive count still resets, because this pass did not fail',
     ap.consecutivePassFailures === 0);
}

// ------------------------------------------------------------------ 2. the stamp

console.log('\nstamped and attributed, so one poll is enough');
{
  const { ap } = keeper();
  const before = Date.now();
  fail(ap, 'boom');
  ok('the set site records when', ap.lastErrorAt >= before && ap.lastErrorAt <= Date.now());
  ok('and whether the session was awake for it', ap.lastErrorLive === true);

  // The status snapshot is what every reader actually sees, so the fields have to be on it.
  ok('status publishes the age in seconds rather than a raw epoch',
     /last_error_age_s: this\.lastErrorAt/.test(AUTOPILOT));
  ok('and the liveness attribution', /last_error_live: this\.lastError \? this\.lastErrorLive : null,/.test(AUTOPILOT));
  ok('both null whenever last_error is null, so the three tell one story',
     /last_error_live: this\.lastError \?/.test(AUTOPILOT));
  ok('and the field\'s own comment now says what it means',
     /the most recent error THAT HAS NOT SINCE BEEN RECOVERED FROM/.test(AUTOPILOT));
  ok('the crash path stamps too — it is the other set site',
     /this\.loop\(\)\.catch\(e => \{ this\.lastError = e\.message; this\.lastErrorAt = Date\.now\(\);/.test(AUTOPILOT));
  ok('and m59-trace carries the new fields, or the tool that samples keepers cannot see them',
     /'last_error_age_s', 'last_error_live'/.test(
       readFileSync(new URL('./m59-trace.mjs', import.meta.url), 'utf8')));
}

// ------------------------------------------------------------------ 3. the real fault

console.log('\na repeating failure is the dangerous one, and it now stands out');
{
  const { ap, notes } = keeper();
  for (let i = 0; i < 4; i++) fail(ap, 'agent "psycho" is not in game — call join first');
  ok('four failures in a row count as four', ap.consecutivePassFailures === 4);
  ok('and each journal line says which one it was',
     notes.map(n => n.detail.consecutive).join(',') === '1,2,3,4');
  // BEFORE THE FIX THESE TWO STATES WERE IDENTICAL — same string, no age, no count. That
  // is what made a healed blip and a stuck keeper indistinguishable without a second poll
  // that also could not tell them apart.
  const healed = keeper();
  healed.ap._live = false;
  fail(healed.ap, 'agent "psycho" is not in game — call join first');
  healed.ap._live = true;
  succeed(healed.ap);
  ok('while a healed blip reports no error at all',
     healed.ap.lastError === null && ap.lastError !== null);
  ok('so the two are distinguishable from one snapshot',
     healed.ap.consecutivePassFailures !== ap.consecutivePassFailures);
}

console.log('\nthe loop still calls both, or none of the above happens');
{
  ok('a completed pass reports its outcome',
     /await this\.pass\(\);\n {10}this\.spend\(Date\.now\(\) - began\);\n {10}this\.notePassSucceeded\(\);/.test(AUTOPILOT));
  ok('and a throw reports its own, before the five-second sleep',
     /this\.notePassFailed\(e\);\n {10}await sleep\(5000\);/.test(AUTOPILOT));
  ok('and the catch still does not kill the keeper',
     /A pass that throws must not kill the keeper/.test(AUTOPILOT));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
