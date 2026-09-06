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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
