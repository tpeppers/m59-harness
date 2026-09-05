#!/usr/bin/env node
// THE FOUR LEASE GUARDS ARE STILL IN THE SOURCE. Offline, reads files, touches nothing:
//
//   node tools/m59-lease-guards-test.mjs
//
// WHAT THIS IS, AND WHAT IT IS NOT. This is a FENCE, not a behavioural test. It asserts
// that four specific guards still EXIST in m59-autopilot.mjs. It cannot tell you they
// work. It is here because the way these guards fail is not that they misbehave — it is
// that they get DELETED, and deletion is exactly what a source check catches.
//
// THE INCIDENT, 2026-09-04:
//
//   23:20 UTC  an operator asks one session to "merge origin/main into max-efficiency,
//              resolve there, then also make sure we've pulled in everything shippable
//              from our prod environment, and then push main" — a THREE-WAY reconciliation
//   23:34      700d28d  Merge origin/main into max-efficiency   <- four guards die here
//   23:53      the operator asks a SECOND session to "go double check their work"
//   00:10      e489ba4  restore the three lease guards the three-way merge dropped
//   00:24      36fa82f  restore the fourth lease guard
//
// The guards came back only because a human asked a second agent to review the first. That
// review is the sole control that worked, and it is not a control you can schedule. This
// file is the part that runs every time.
//
// WHY NOT A BEHAVIOURAL TEST. Two of the four are pure functions and ARE covered
// behaviourally in m59-unattended-test.mjs — that is the better kind of test and it is
// where new coverage should go. The other two are control flow inside `passFarm` and
// `passErrand`, which need a room, prey and a policy to reach. Testing those properly
// means extracting the predicate the way `shouldRelocateToAssignedRoom` already was
// ("Taken as a parameter rather than read off the keeper so the rule can be pinned without
// building a world"). That refactor is worth doing and is NOT done here, because it edits
// the live farm-decision path and wants a reviewer. Until then, a fence.
//
// IF A GUARD IS LEGITIMATELY REMOVED, delete its entry here in the same commit, and say in
// the message what replaced it. A fence nobody may edit becomes a fence everybody routes
// around.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n         ' + extra : '')); }
};

// Each guard: what it stops, the anchors that vanish if it is removed, and what it cost.
const GUARDS = [
  {
    name: 'a lease outranks a room assignment',
    restored: 'e489ba4',
    anchors: [/movementLeased\s*=\s*false\s*\)/, /if\s*\(\s*movementLeased\s*\)\s*return false/],
    cost: 'three supply waves bought nothing: a courier with movement leased to a fleet ' +
          'errand was walked back to its assigned room the moment the errand ended',
    also: 'behaviourally covered in m59-unattended-test.mjs',
  },
  {
    name: 'a new instruction retires a suspended journey',
    restored: 'e489ba4',
    anchors: [/retired a suspended journey that a new instruction replaced/,
              /this\.suspendedJourney\s*=\s*null/],
    cost: 'a courier sent to the Tos bank was found walking home to Castle Victoria, the ' +
          'old objective resumed underneath the live instruction — two directions on one body',
  },
  {
    name: 'an economy lease stops banking and vaulting',
    restored: 'e489ba4',
    anchors: [/facultyHeld\(\s*'economy'\s*\)/, /economy is leased/],
    cost: 'banking a purse mid-errand is how a courier arrives at a counter unable to pay',
  },
  {
    name: 'a movement lease stops the keeper choosing a destination',
    restored: '36fa82f',
    anchors: [/facultyHeld\(\s*'movement'\s*\)/, /movement is leased/, /notedMovementOwner/],
    cost: 'Sweetums went 587 -> 598 -> 599 -> 2 -> 39 with the lease held and live the ' +
          'whole way, crossing the killing ground twice for nothing',
  },
];

console.log('\nthe four lease guards, in tools/m59-autopilot.mjs');
for (const g of GUARDS) {
  const missing = g.anchors.filter(rx => !rx.test(src));
  ok(g.name + (g.also ? '  (' + g.also + ')' : ''), missing.length === 0,
     missing.length
       ? `GUARD MISSING. Restored once in ${g.restored}; if it is gone again a merge has ` +
         `probably eaten it.\n         What it cost last time: ${g.cost}\n` +
         `         Absent anchors: ${missing.map(String).join('  ')}`
       : '');
}

// THE GATE MUST STAY NARROW. The guards withhold work, movement and economy. They must
// never withhold the four that keep a character alive, and the cheapest way to be sure is
// to pin the two lists against each other.
console.log('\nand they stay narrow');
{
  const prot = src.match(/PROTECTED_FACULTIES\s*=\s*\[([^\]]*)\]/);
  ok('PROTECTED_FACULTIES is still declared', !!prot);
  if (prot) {
    const names = prot[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
    for (const f of ['identity', 'mortality', 'survival', 'recovery'])
      ok(`${f} is protected`, names.includes(f),
         `PROTECTED_FACULTIES is now [${names.join(', ')}]. A character that cannot be ` +
         `trusted to keep ${f} under a lease is a character an errand can get killed.`);
    for (const f of ['work', 'movement', 'economy'])
      ok(`${f} is NOT protected, so it can still be leased`, !names.includes(f),
         `${f} became protected — every fleet errand that leases it now silently fails.`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nA lease guard is missing. Before "fixing" the test, check git log for a');
  console.log('merge — this has happened once already, on 2026-09-04, and it was found by');
  console.log('a human asking a second agent to review the first.');
}
process.exit(fail ? 1 : 0);
