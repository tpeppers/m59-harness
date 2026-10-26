#!/usr/bin/env node
import { readToolSource } from './autopilot/source.mjs';
// A CALL FOR HELP IS AN ORDER TO MOVE BODIES, SO IT MUST COME FROM OUR OWN PEOPLE.
//
//   node tools/m59-conflict-test.mjs
//
// Offline. No socket, no broker, no roster. It writes one throwaway conflict book under a
// test fleet name and deletes it.
//
// ======================== THE INCIDENT THIS SUITE IS BUILT FROM ========================
//
// 2026-08-27, during a five-inn pilgrimage on the SHADOW fleet. Ten characters reached
// Outside Castle Victoria — journeys `ok`, 133 to 139 seconds, objective complete — and then
// eleven minutes later, WITHIN TWO SECONDS OF EACH OTHER, they all crossed back out of it
// into Ukgoth, the most dangerous room on their route. They were idle, `roam: false`,
// `hunt: null`, `assignedRoom: null`. Nothing in their own policy could move them.
//
// The keeper's journal said why, in plain words:
//
//     "Scooter is fighting Morpheus — travelling to assist"
//
// Scooter and Animal are PROD characters. Aaaa and Cccc are SHADOW characters. Different
// accounts, on different servers. And on disk:
//
//     substrate/active-conflicts.json
//     { "Morpheus": { room: 544, "Valley of Ileria", reporter: "Animal", ... } }
//
// ONE FILE, for the whole machine, and two fleets run here. The route from room 2 to room
// 544 passes through Ukgoth, which is exactly how far they got.
//
// TWO INDEPENDENT DEFECTS, and each is enough on its own:
//
//   STORAGE — the book was `active-conflicts.json`, not `active-conflicts-<fleet>.json`,
//     while every other per-fleet artefact here is already named for its fleet.
//   BEHAVIOUR — the candidate filter was `cf.reporter !== myName`, i.e. "not me", and
//     nothing else. Answering a stranger's call is wrong even when the call is in the right
//     file, and this is the same rule `m59-follow.mjs` already applies to "follow me": the
//     speaker is checked against the ROSTER, never against the text.
//
// It should fail the day either half is loosened.
import { readFileSync, existsSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

const AUTOPILOT_SRC = (() => { try { return readToolSource('tools/m59-autopilot.mjs', 'utf8'); }
                               catch { return ''; } })();

// A throwaway fleet name so this never touches the real prod or shadow books.
const FLEET_A = 'conflicttest_a', FLEET_B = 'conflicttest_b';
process.env.M59_FLEET = FLEET_A;
const intel = await import('./m59-intel.mjs');
const bookFor = f => { process.env.M59_FLEET = f; return intel.conflictsPath(); };

console.log('\nTHE BOOK IS PER FLEET');
{
  const a = bookFor(FLEET_A), b = bookFor(FLEET_B);
  ok('two fleets get two different conflict books', a !== b, `${a}\n${b}`);
  ok('and the name carries the fleet, like every other per-fleet artefact here',
     a.includes(FLEET_A) && b.includes(FLEET_B));
  // RESOLVED PER CALL, NOT AT IMPORT. A keeper process and a page can be in one runtime with
  // different fleets in view; a path frozen at module load answers for whoever imported first.
  process.env.M59_FLEET = FLEET_A;
  ok('the path is resolved when it is asked for, not frozen at import',
     intel.conflictsPath() === a);
}

console.log('\nA CALL CARRIES THE FLEET THAT MADE IT');
{
  process.env.M59_FLEET = FLEET_A;
  intel.declareConflict('OurOwn', 'SomeTarget', 544);
  const raw = JSON.parse(readToolSource(intel.conflictsPath(), 'utf8'));
  ok('a declared conflict records which fleet declared it',
     raw.SomeTarget?.fleet === FLEET_A, JSON.stringify(raw.SomeTarget));
  ok('and it is live to the fleet that made it',
     !!intel.activeConflicts().SomeTarget);
}

console.log('\nAND A CALL FROM ANOTHER FLEET IS NOT A CALL');
{
  // The incident exactly: a record written by another fleet, sitting in the book this fleet
  // reads. Before the split that was the SAME file; this reproduces the effect directly.
  process.env.M59_FLEET = FLEET_A;
  const path = intel.conflictsPath();
  const raw = JSON.parse(readToolSource(path, 'utf8'));
  raw.Morpheus = { target: 'Morpheus', room: 544, room_name: 'Valley of Ileria',
                   reporter: 'Animal', fleet: 'prod',
                   started_at: Date.now(), updated_at: Date.now(),
                   expires_at: Date.now() + 120_000 };
  (await import('node:fs')).writeFileSync(path, JSON.stringify(raw));
  const live = intel.activeConflicts();
  ok('a live, unexpired call from ANOTHER fleet is not returned',
     !live.Morpheus, JSON.stringify(Object.keys(live)));
  ok('and our own call beside it still is', !!live.SomeTarget);
  // DROPPED, NOT ADOPTED. Rewriting it under this fleet's name would launder a foreign order
  // into a local one — the bug, with an extra step.
  const after = JSON.parse(readToolSource(path, 'utf8'));
  ok('the foreign call is dropped rather than rewritten as ours',
     !after.Morpheus || after.Morpheus.fleet === 'prod', JSON.stringify(after.Morpheus));
}

console.log('\nTHE BEHAVIOUR, WHICH IS SEPARATE FROM THE STORAGE');
{
  // Source-level, in the style the rest of this repository uses for a rung too deep to
  // instantiate: what matters is that the filter asks the ROSTER, not just "is it me".
  const rung = AUTOPILOT_SRC.slice(AUTOPILOT_SRC.indexOf('const candidates = Object.values(conflicts)'),
                                   AUTOPILOT_SRC.indexOf('if (!candidates.length) return false;'));
  ok('the assist filter asks whether the reporter is one of ours',
     /party\.isFleetmate\(cf\.reporter\)/.test(rung), rung.slice(0, 200));
  ok('and it is no longer satisfied by merely not being me',
     /cf\.reporter !== myName/.test(rung) && /isFleetmate/.test(rung));
  // ABSENT THE PREDICATE, IT REFUSES. A keeper that cannot tell its own people from
  // strangers has no business crossing rooms on their behalf — and `party.isFleetmate` is
  // documented as being dead inside a keeper process that has no roster source, which is
  // exactly the condition under which this must not fire.
  ok('with no fleetmate answer available it refuses rather than assuming',
     /knowsOurOwn/.test(rung) && /typeof party\?\.isFleetmate === 'function'/.test(AUTOPILOT_SRC));
}

for (const f of [FLEET_A, FLEET_B]) {
  const p = bookFor(f);
  if (existsSync(p)) rmSync(p, { force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
