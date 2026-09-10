#!/usr/bin/env node
// NOTHING MAKES A CHARACTER RUN ANY MORE. THERE IS NO FLEE RUNG AT ALL.
//
//   node tools/m59-fleeline-test.mjs
//
// Offline. No socket, no broker, no roster.
//
// WHAT CHANGED AND WHY. `passFleeAndRest` used to withdraw on `hp < fleeBelow && near.length`,
// and `near` is built with `!(o.flags & OF.PLAYER)` — so the flee rung fired for CREATURES
// ONLY, which is exactly backwards from what running is good for.
//
// Running does not work on a monster. Vision is 4 + difficulty/2 squares (monster.kod:1676)
// and they follow, so a withdrawal spends several seconds being hit to reach a square no
// safer than the one it left and arrives with less health than it started with. Being bitten
// on the road is the ordinary condition of travel here, and the answer already in the ladder
// is a wall a creature cannot path to, and rest.
//
// A person is the opposite case and not a matter of degree. A safe spot works BECAUSE a
// creature cannot path to it; that says nothing whatever about somebody who can walk to the
// same square, swing first and take the pack. Dying to the troll costs the walk back, dying
// to the player costs everything carried — so distance is the answer to a person and only to
// a person.
//
// The threshold itself survives for the things that are NOT flight: when to stop swinging,
// when a wall outranks a journey, and when the watchdog interrupts a blind walk so the ladder
// can think with fresh numbers. This suite is about the one thing it no longer does.
//
// It should fail the day a monster can make a character run again.

import { Autopilot, PASS_STAGES } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';
import * as party from './m59-party.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// A monster carries ATTACKABLE and not PLAYER; a person carries both. Built from the real
// flags rather than invented numbers — a fixture with its own bits would build a room the
// code under test cannot classify and then pass every assertion.
const monster = (id, col = 25, row = 5) => ({ id, flags: OF.ATTACKABLE, col, row, nameRsc: 1 });
const person  = (id, col = 25, row = 5) => ({ id, flags: OF.PLAYER | OF.ATTACKABLE, col, row, nameRsc: 2 });

const keeper = ({ health = 10, max = 50, objects = [], names = {} } = {}) => {
  const notes = [];
  const self = { id: 1, col: 25, row: 5 };
  const k = Object.assign(Object.create(Autopilot.prototype), {
    journal: notes, notes, policy: { fleeBelow: 0.45 }, claims: new Map(), passes: 1,
    tally: { withdrawals: 0, breakoffs: 0 },
    book: { save: () => {} },
    watch: { pulses: [], wedges: 0 },
    note: (what, detail) => notes.push({ what, detail }),
    progress: () => {}, noProgress: () => {}, recordFrame: () => {}, ledgerEvent: () => {},
    armed: () => true,
    safety: () => ({ fleeAt: 0.45 }),
    s: {
      name: null,
      world: { room: { num: 535, name: 'West Merchant Way' } },
      client: {
        selfId: 1, self,
        rsc: { get: r => names[r] ?? null },
        room: { objects: new Map(objects.map(o => [o.id, o])) },
        vitals: () => ({ health: { value: health, max }, vigor: { value: 80 } }),
      },
    },
  });
  return k;
};

console.log('');
console.log('a stranger is a PERSON who is not one of ours');
{
  // One filter, used by the rung that decides whether to run. It was written out by hand in
  // three places before this and they must not be allowed to drift, because the whole ladder
  // now turns on creature-versus-person.
  const k = keeper({ objects: [monster(10), person(90)], names: { 2: 'Somebody Else' } });
  const found = k.strangersInReach();
  ok('a monster beside us is not a stranger', !found.some(o => o.id === 10));
  ok('a player beside us is', found.some(o => o.id === 90), JSON.stringify(found.map(o => o.id)));

  // BOTH FLAGS. `PF_*` is an enum rather than a bitmask, so a naive PLAYER test is true for
  // things that are not people.
  const half = keeper({ objects: [{ id: 91, flags: OF.PLAYER, col: 25, row: 5, nameRsc: 2 }] });
  ok('PLAYER without ATTACKABLE is not a stranger either', half.strangersInReach().length === 0);

  // Distance. Somebody across the room is not on us.
  const far = keeper({ objects: [person(92, 25, 60)], names: { 2: 'Far Away' } });
  ok('a person out of reach is not a stranger', far.strangersInReach().length === 0);

  // A FLEETMATE IS NOT AN ATTACKER, and the roster is populated one keeper at a time — so
  // this can call one of ours a stranger for a few seconds after a restart. Being wrong that
  // way costs a walk, never a fight.
  const known = party.knownCharacters?.() ?? null;
  ok('the fleetmate test is the shared one rather than a local guess',
     typeof party.isFleetmate === 'function', String(known));
}

console.log('');
console.log('THERE IS NO FLEE RUNG AT ALL — NOT FOR A MONSTER, NOT FOR A PERSON');
{
  const src = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8');
  const stage = src.slice(src.indexOf('async passFleeAndRest'),
                          src.indexOf('async passFollow'));
  // It went in two steps. First for monsters, because running does not work on one — vision
  // is 4 + difficulty/2 squares and they follow, so a withdrawal spends seconds being hit to
  // reach a square no safer than the one it left. Then for people too, which is the
  // operator's call rather than a measurement.
  //
  // What is left is the set of answers that change a situation: a wall a creature cannot
  // path to, resting behind it, PLAYING DEAD when already sheltered, and carrying on.
  // Walking away was never one of them.
  ok('the stage no longer withdraws on a health threshold at all',
     !/this\.tally\.withdrawals\+\+/.test(stage));
  ok('and nothing in it runs for safety any more',
     !/running for safety/.test(stage));
  ok('and it says why, where the rung used to be',
     /THERE IS NO FLEE RUNG AT ALL ANY MORE/.test(stage));
  // AND THE ANSWER BEHIND A WALL IS THE LOGOFF, NOT STANDING STILL. Changed 2026-09-10 on
  // the operator's instruction: "the logoff trick makes the enemy immediately stop attacking,
  // waiting and hoping can let the enemy continue attacking for up to dozens of seconds", and
  // make it "identical to play_dead, such that there's no real point in having flee_below".
  //
  // This assertion used to pin `breaking off without moving` as the thing that survived,
  // because it is not flight — which was the right half of the question and the wrong answer
  // to it. Not running is necessary; standing still is not sufficient. `sheltered` means a
  // wall the BOOK confirmed, and room 39 has 132 squares tested with ZERO that held without
  // later failing, so it means the wall held BEFORE.
  // Matched on the CALL, not the phrase: the comment that explains the removal necessarily
  // contains the old note's text, and a test that cannot tell code from a comment about code
  // reports a false failure — which this one did, against itself, on first run.
  ok('the sheltered answer is now playDead, not standing still',
     /await this\.playDead\(/.test(stage) &&
     !/this\.note\('breaking off without moving'/.test(stage));
  ok('and there is no lesser fallback left, which is what makes flee_below redundant',
     /no LESSER PATH LEFT/i.test(stage) || /no lesser path left/i.test(stage));
}

console.log('');
console.log('what the threshold is still allowed to do');
{
  const src = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8');
  // DELIBERATELY KEPT. None of these is flight, and removing the number outright would take
  // them with it: when to stop swinging, when a wall outranks a journey, and when the
  // watchdog interrupts a long blind walk so the ladder gets to decide with fresh numbers.
  ok('a fight still disengages at the same fraction', /disengageAt: safe\.fleeAt/.test(src));
  ok('a wall still outranks a journey below it', /inRealTrouble = wouldPlayDead/.test(src));
  ok('the watchdog still interrupts a blind walk below it',
     /pulled the character out of a blind walk/.test(src));
  // And the travel guard's own flee rung was ALREADY players-only — it tests `worthEnding`,
  // which under the default `travel_flee_from: 'players'` is the strangers list. The two
  // ladders now agree, which is the point.
  ok('the travel guard rung agrees — it was players-only already',
     /below the flee line with someone adjacent/.test(src));
}

console.log('');
console.log('the ladder still has an answer for a monster');
{
  // The rung declining must not leave a hole. Flee and rest are the SAME stage, so a hurt
  // character with creatures on it falls through to the wall-and-rest half — which is the
  // behaviour the operator asked for: never run from the road, take a wall and carry on.
  const src = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8');
  const stage = src.slice(src.indexOf('async passFleeAndRest'),
                          src.indexOf('async passFollow'));
  ok('resting lives in the same stage as fleeing, so declining is not a dead end',
     /restUntil|rest to full|SIT DOWN PROPERLY/.test(stage));
  ok('and a proven wall is still the monster answer', /safe spot/i.test(stage));
  // PIN THE ORDER, NOT THE INDEX. This read `=== 3` and was correct when it was written
  // (174448a, 2026-08-22). `passFightBack` was then inserted above it (55c4815, 2026-08-27)
  // and the stage moved to 4, so this assertion has been RED for two weeks -- failing on a
  // stage being added rather than on the ordering it meant to protect. An index is a count of
  // everything above it; what actually matters is which side of the ladder this stage sits on,
  // and that is what the four deaths in the retreat note were about.
  const at = PASS_STAGES.indexOf('passFleeAndRest');
  const before = ['passUnderworld', 'passArm', 'passPlaybook'];
  const after = ['passFollow', 'passOutside', 'passErrand', 'passFarm'];
  ok('the stage still runs after the ones that outrank it -- dead, armed, and told what to do',
     at > 0 && before.every(n => {
       const i = PASS_STAGES.indexOf(n);
       return i >= 0 && i < at;
     }), PASS_STAGES.join(','));
  ok('and still ahead of every stage that would send the character somewhere',
     at > 0 && after.every(n => {
       const i = PASS_STAGES.indexOf(n);
       return i >= 0 && i > at;
     }), PASS_STAGES.join(','));
}

console.log('');
console.log('A WITHDRAWAL IS A WALL, OR IT IS FORWARD — NEVER AWAY');
{
  const src = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8');
  const w = src.slice(src.indexOf('async withdraw(threats)'),
                      src.indexOf('async withdraw(threats)') + 7000);
  // The old last resort picked any square six from the nearest threat with no regard for
  // where the journey was going. Bbbb, at 2 health in the Cragged Mountains with no reachable
  // wall, was sent EAST to 38,25 — twenty squares off a rail running down column 18 — and
  // died there.
  ok('there is no square-hunting fallback left', !/const away = \(r, col\)/.test(w), 'the distance search');
  ok('and nothing reports having withdrawn to open floor', !/this\.note\('withdrew',/.test(w));
  ok('a wall is still taken when there is one', /withdrew to a defensible square/.test(w));
  ok('and during a journey it goes to the next wall on the ROUTE',
     /withdrawing FORWARD — the next wall on the route/.test(w));
  ok('otherwise it declines and says the way out is on',
     /nowhere here is safer than here/.test(w) && /carrying on to the objective/.test(w));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
