#!/usr/bin/env node
// A STATION IS AN ORDER, AND A KEEPER THAT IS NOT AT ITS STATION HAS TO WALK THERE.
//
//   node tools/m59-station-test.mjs        # offline, opens no socket, touches no roster
//
// WHAT THIS PINS, AND WHAT IT COST TO NOT HAVE IT.
//
// `roam: false` does not mean "go to your station and stay there". It means idle wherever
// you happen to be standing. So a character whose journey ended anywhere short of its
// destination stood there for ever — and nothing reported it, because every detector we
// have is looking for a character that CANNOT move and this one simply had nothing telling
// it to. On the board it reads `activity: idle`, `stalled: false`, `busy` unset,
// `committed: null`: a perfectly healthy character doing nothing on purpose.
//
// Measured on prod 2026-09-05. Twelve characters dispatched to the Duke's feast hall were
// standing in the Graveyard of Tos, the Cragged Mountains, Ukgoth, the Underworld and their
// own home room, every one with `assigned_room: 953`, `roam: false` and `activity: idle`.
// The feast trip arrived 56 times out of 438. That 13% is where the fleet's food went, and
// it also starved the Barloque sell circuit — cleaning up after a failed journey is an
// errand, and an errand wins the fleet pass exactly like a dispatch does.
//
// The "go back to work" branch existed and fired only in a sanctuary or in a room that
// cannot produce our quarry. Both are good reasons; neither covers the commonest one.

import { Autopilot } from './m59-autopilot.mjs';
import { readFileSync } from 'node:fs';

const AUTOPILOT = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  — ' + extra : '')); }
};

// Just enough of a keeper for the predicate. It reads `this.policy` and nothing else.
const keeper = (policy = {}) => {
  const ap = Object.create(Autopilot.prototype);
  ap.policy = policy;
  return ap;
};

console.log('\nawayFromStation — an explicit order, and only an explicit one');
{
  ok('given a station and standing somewhere else: yes',
     keeper({ assignedRoom: 953 }).awayFromStation({ num: 39 }) === true);
  ok('standing in it: no',
     keeper({ assignedRoom: 953 }).awayFromStation({ num: 953 }) === false);
  // NO ORDER IS NOT AN ORDER TO GO ANYWHERE. A character nobody has stationed must not be
  // walked "back" to a room it merely happens to have settled in — that would move
  // characters nobody asked to move, on every pass, for ever.
  ok('no station at all: no, and never homeRoom',
     keeper({}).awayFromStation({ num: 39 }) === false);
  ok('a null station is not a room number',
     keeper({ assignedRoom: null }).awayFromStation({ num: 39 }) === false);
  ok('nor is a string that looks like one',
     keeper({ assignedRoom: '953' }).awayFromStation({ num: 39 }) === false);
  // Room 0 is falsy and is a real room number; a truthiness test would skip it.
  ok('room 0 is a room, not an absence',
     keeper({ assignedRoom: 0 }).awayFromStation({ num: 39 }) === true);
  ok('...and standing in room 0 is being home',
     keeper({ assignedRoom: 0 }).awayFromStation({ num: 0 }) === false);
  // AN UNKNOWN ROOM READS AS AWAY, DELIBERATELY, and it is worth saying why because the
  // opposite convention holds a few hundred lines up: `wedgeHere` treats "I do not know
  // where I am" as NOT evidence of having moved, because there the unknown authorises
  // giving up on a record. Here the unknown authorises a `travel` to the station — and a
  // travel to the room we are already standing in costs a no-op, while the other way round
  // costs a character idling for ever. The outer guard agrees with this reading already:
  // `home !== room?.num` is true for a null room whatever this predicate says.
  ok('an unknown room reads as away, so the walk is still attempted',
     keeper({ assignedRoom: 953 }).awayFromStation(null) === true);
}

console.log('\nthe pass consults it, and keeps the two older reasons');
{
  // A SOURCE CHECK, because the branch is inline in `pass()` and the failure it guards is
  // deletion rather than logic: the whole fix is one disjunct, and a future edit that tidies
  // the condition back to its old two-reason form restores the bug in full silence.
  ok('the branch asks the seam rather than re-deriving it',
     /\bconst awayFromStation = this\.awayFromStation\(room\)/.test(AUTOPILOT));
  ok('and it is one of THREE reasons, not a replacement for the other two',
     /if \(\(inSanctuary \|\| !producesQuarry \|\| awayFromStation\) && this\.emptyPasses >= 2\)/
       .test(AUTOPILOT));
  // The note has to say WHICH reason fired: a sanctuary means we died or shopped, a barren
  // room means the orders and the spawn table disagree, and a station means a journey ended
  // short. Three different fixes behind one sentence is how this went unnoticed.
  ok('the note names which of the three fired',
     /reason: inSanctuary \? 'sanctuary' : !producesQuarry \? 'no_quarry' : 'away_from_station'/
       .test(AUTOPILOT));
  // STILL BEHIND THE HEALTH GATE. Going back to work hurt and bare-handed is what killed
  // Zoot, Piggy and Rizzo inside twenty minutes, and this new reason fires far more often
  // than the two it joins — so it must not have become a way around that check.
  const branch = AUTOPILOT.slice(AUTOPILOT.indexOf('awayFromStation) && this.emptyPasses'));
  ok('the walk is still gated on being fit to leave',
     branch.indexOf('readyToLeaveSanctuary') > 0 &&
     branch.indexOf('readyToLeaveSanctuary') < branch.indexOf('this.travel('));
}

// ------------------------------------------------ a foreground travel must WAIT for the walk
//
// A KEEPER-BACKED `travelJob` DECIDES HOW TO ASK THE KEEPER FROM ONE WORD.
//
//     background: opts.foreground !== true
//
// and the travel tool never passed `foreground`, so `undefined !== true` was true and every
// travel went to the keeper as a background action — including the ones whose entire purpose
// was to block until arrival. `await startTravel().promise` then awaited an acknowledgement
// rather than a walk and came back in about four milliseconds with no `arrived` in it.
//
// Nothing errored. What broke was every caller that asks "did it get there": an errand step
// with `expect: 'arrived'` never matched, and every step carrying `needs:` that label was
// skipped in silence. On prod 2026-09-06 the Barloque circuit walked to the vault and the
// smith and neither deposited nor sold, the street giveaway never dropped or yelled, and
// `sell`, `vault`, `bank` and `drop_all` were called ZERO times in a day of dispatches.
//
// Source-level because the two halves live in different objects and the bug is the ABSENCE
// of an argument — there is no value to assert on, only a call site that must pass it.
console.log('\na foreground travel waits for the journey, not for an acknowledgement');
{
  const BROKER = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  ok('the keeper-backed job still reads `foreground` to decide',
     BROKER.includes('background: opts.foreground !== true'));
  ok('and the travel tool now passes it, inverted from `background`',
     BROKER.includes('foreground: !a.background,'));
  // A foreground caller awaits the promise; that line is what the fix makes meaningful.
  ok('the foreground path still awaits the journey', BROKER.includes('await startTravel().promise'));

  // AND THE SECOND LAYER, which the first fix exposed. `keeperAction` capped EVERY keeper
  // action at 60s and its catch returns `{ error }` as a VALUE rather than throwing — so an
  // aborted action reports as a successful call carrying an error field, and the JSON-RPC
  // reply is `ok`. The shortest leg this fleet walks is 659s, so every foreground journey
  // was aborted at sixty seconds and reported as fine.
  ok('keeperAction takes a per-call timeout with a 60s default',
     BROKER.includes('async function keeperAction(agent, index, name, args, { timeoutMs = 60_000 } = {})'));
  ok('...and uses it rather than a constant',
     BROKER.includes('signal: AbortSignal.timeout(timeoutMs)'));
  ok('a foreground travel asks for longer than any leg takes',
     BROKER.includes('timeoutMs: foreground ? 20 * 60_000 : 60_000'));
  // An abort has to be distinguishable from a refusal, which it was not.
  ok('and an abort says it was an abort', BROKER.includes('timed_out_after_ms: timeoutMs'));
}

// ------------------------------------------------ a pull is a lap of the melee in a crowd
//
// ROWLF, ROOM 39, 2026-09-06 04:55. Six battered skeletons in reach on every one of the last
// sixteen frames (ten at peak), `doing: fighting` on all of them, oscillating 23,8 - 24,8 -
// 23,8 - 22,8 while health went 34 -> 6. Gross fifteen squares travelled, NET ONE. That
// oscillation was not a stall: it was `pull`, walking out three squares to fetch a skeleton
// and walking back, once per pass. He died on 23,8 — a square the book has never recorded,
// i.e. open floor — one square from the wall he had left.
//
// His flee threshold was 36 of 53 and he was under it for the whole minute, still pulling.
// The last two decisions before the death broadcast are "pulled it to the wall, went 3" and
// "waiting for it at the wall, follow_window_ms 8000".
//
// `pull` had neither guard every other aggressive rung carries. Its own comment argues that
// distance does not make a pull more dangerous, which is true of ONE monster — the walk out
// happens before it has noticed us — and false of six, because then the walk is through
// their reach and they have already noticed.
console.log('\nthe pull refuses a crowd and refuses to run below the flee line');
{
  const AP = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const at = AP.indexOf('  async pull(want) {');
  const body = AP.slice(at, AP.indexOf("this.doing = 'fighting'", at));
  ok('it asks crowded() before walking anywhere', body.includes('if (this.crowded())'));
  ok('...and says so in the ledger rather than refusing in silence',
     body.includes("noteCrowdRefusal('pulling quarry to the wall')"));
  ok('it refuses below the flee line', body.includes('frac < this.safety().fleeAt'));
  ok('...and the refusal names both numbers so a reader can tell which line it hit',
     body.includes('below the flee line'));
}

// --------------------------------------------- the postmortem must name the verdict, not the tally
//
// The report read the raw failure TALLY. Since 2026-09-02 the tally and the verdict disagree
// on purpose, and room 39 square 24,7 is the case that proves it — the very square this
// death was reported against:
//
//   held 1, failed 309, failed_via "fight", failed_by { fight: 309 },
//   verified true, verified_by an operator, "marked in game by the operator"
//
// It is not discredited, for THREE independent reasons: a person verified it, geometry says
// nothing can reach it (can_reach_you 0), and every one of the 309 failures was recorded
// while SWINGING from it — which is what `discreditedForPull` is for and is not what
// condemns a place to heal.
//
// It nevertheless announced itself as "DISCREDITED — failed 319 time(s) here ... should not
// have been offered" in the postmortem, which is the first line a reader sees. It sent this
// session hunting a bug in the offering code that does not exist, while the actual killer —
// an unguarded pull in a crowd — sat two lines further down the same trail.
console.log('\nthe safe-spot report asks the verdict, not the tally');
{
  const AP = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the verdict is computed from the book, with the live geometry',
     AP.includes('const condemned = this.book.discredited(known, { reachable: spot.can_reach_you ?? null })'));
  ok('the headline branches on the verdict', AP.includes('proven_before: condemned ?'));
  ok('and so does the explanation', AP.includes('note: condemned'));
  // The tally is still SHOWN — it is real evidence about the square, just not a verdict —
  // and the line now says why it is not being obeyed.
  ok('a sound square with failures explains why they do not count',
     AP.includes('so those are not the wall'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
