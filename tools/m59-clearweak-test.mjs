#!/usr/bin/env node
// IS CLEARING THE SPAWN CAP A REASON TO STOP GOING SOMEWHERE?
//
//   node tools/m59-clearweak-test.mjs
//
// Offline. Reads source; opens no socket, starts no broker.
//
// WHY THIS FILE EXISTS. `clearWeak` kills whatever is holding a room's spawn cap even when
// it is not the prey, and the argument for it is sound: the cap is a room-wide TOTAL
// (monsroom.kod:242), so the creatures declined are exactly what stops the prey appearing.
//
// That argument is about THE ROOM WE FARM. It says nothing about a room a character is
// standing in on its way somewhere else — there is no stake in that room's generator, and
// killing its occupants buys nothing at all. And it does not merely waste the pass:
// clearing ISSUES MOVEMENT, and a new command cancels the walk already in flight.
//
// Measured on prod 2026-08-27. Clifford, assigned to room 39, stranded in "Off the beaten
// path" (567) with eight giant rats and none of his prey:
//
//     p1322 | clearing the room so it can spawn again
//             killing: giant rat, of_them 8, at_cap 9/9, prey_present 0
//     placement: aimed_at_assignment 3 · returned_to_assignment 0 · failed 3
//                why_not: [{room: 39, why: "movement cancelled by a newer command"} x3]
//
// 1,322 passes, two a second, eighteen minutes at full health. He tried to walk home three
// times and his own clearing cancelled it every time. Nothing was wrong with him and
// nothing said anything was.
//
// So the law: clearing applies only where the character is assigned, an unassigned
// character keeps the old behaviour everywhere (every room is its room), and the refusal
// is SAID ONCE rather than being another silent no-op.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const pilot = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8');
const broker = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

console.log('clearing is gated on being in the room we farm');
{
  ok('the gate exists and is computed from the assignment',
     /const farmingHere = this\.policy\.assignedRoom == null\s*\n?\s*\|\| Number\(room\?\.num\) === Number\(this\.policy\.assignedRoom\);/
       .test(pilot));
  ok('and the clearing block is behind it',
     /if \(farmingHere && this\.policy\.clearWeak !== false\) \{/.test(pilot));
  // The bare `if (this.policy.clearWeak !== false) {` that used to guard it must be gone,
  // or the gate is decorative.
  ok('the ungated version is gone',
     !/\n\s*if \(this\.policy\.clearWeak !== false\) \{\n\s*const capped = this\.capBlockers\(room\);/.test(pilot),
     'an ungated clearWeak block still exists');
}

console.log('\nan UNASSIGNED character is unaffected');
{
  // This matters: most characters in this fleet have no assignment for most of their life,
  // and for them every room genuinely is the room they farm. Narrowing that would switch
  // off a mechanic that works, to fix a case they are not in.
  ok('no assignment means every room counts as ours',
     /this\.policy\.assignedRoom == null/.test(pilot));
}

console.log('\nand the refusal is said out loud, once');
{
  ok('there is a note for it',
     /not clearing this room — it is not the one we farm/.test(pilot));
  // Once per room, not once per pass: this loop ran twice a second, and a note per pass
  // would bury the journal it exists to explain.
  ok('rate-limited to one per room',
     /this\.clearWeakElsewhere !== room\?\.num/.test(pilot) &&
     /this\.clearWeakElsewhere = room\?\.num;/.test(pilot));
  ok('and it resets on arriving where we belong',
     /if \(farmingHere\) this\.clearWeakElsewhere = null;/.test(pilot));
}

console.log('\nand the setting can finally be reached from the broker');
{
  // It had no argument at all: a `clear_weak` passed to the autopilot tool was silently
  // dropped, which is the failure mode this repository keeps paying for — a setting that
  // reads as applied and does nothing.
  ok('clear_weak is declared in the autopilot schema', /clear_weak: \{ type: 'boolean',/.test(broker));
  ok('and it is actually applied to the policy',
     /if \(a\.clear_weak !== undefined\) p\.policy\.clearWeak = !!a\.clear_weak;/.test(broker));
  ok('the description says it is scoped to the assigned room',
     /applies ONLY to the room this character/.test(broker));
}

console.log('\na cap full of our own prey is not a reason to leave');
{
  // 2026-09-27, Ukgoth: 18/15 was three Guardians of Zjiria and fifteen trolls. The denial
  // fired and two troll hunters walked out mid-streak for room 516 — the cap was full of the
  // very thing they were killing, and every kill freed a slot.
  const at = pilot.indexOf("this.note('this room is capped by things we will not fight'");
  const gate = at < 0 ? '' : pilot.slice(Math.max(0, at - 900), at);
  ok('the capped-room denial is still findable', at > 0);
  ok('it fires only when none of our prey is present',
     /capped\.blocked\.length\s*&& !\(capped\.prey_present > 0\)/.test(gate));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
