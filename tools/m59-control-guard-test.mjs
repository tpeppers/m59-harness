#!/usr/bin/env node
// A SCRIPT DRIVES WHAT IT DECLARED, AND THE LOCK COVERS EXACTLY THAT.
//
//   node tools/m59-control-guard-test.mjs
//
// Offline. No socket, no broker, no roster — the guard is a pure function and the lock is
// pointed at a scratch directory before the module is imported, so this never touches a
// real claim.
//
// WHAT THIS GUARDS, in two halves.
//
// THE LOCK. FleetScript took one claim over the whole fleet for every errand. Measured
// 2026-09-10: minor heal had to be bought for Pepe and then Statler one after the other —
// disjoint characters, same teacher, nothing shared between them — because the fleet was
// the unit of exclusion. Narrowing it is only correct if the two scopes still SEE each
// other, which is the property most likely to be lost in a later refactor: a whole-fleet
// driver and a per-character errand must still contend over the characters they share, or
// this is a hole rather than a refinement.
//
// THE DECLARATION. Operator, 2026-09-10: "scripts should only lock characters it's using",
// with "an error/warning for trying to order around/control a character in a script that
// isn't called out as locked at the top of the file". The failure that catches is invisible
// in a log — a script that touches a body it never declared, and therefore never locked,
// while somebody else holds it. `act` is the hole it exists for: it forwards arbitrary
// arguments to any broker tool, so a script naming only t2 can drive t7 through it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'm59-control-'));
process.env.M59_RUNLOCK_DIR = scratch;

const { declaredControl, controlViolation, controlViolations } =
  await import('./m59-control-guard.mjs');
const { takeAgentLocks, takeRunLock, runLockFile, agentLockFiles, releaseRunLock } =
  await import('./m59-runlock.mjs');

let pass = 0, fail = 0;
const ok = (what, cond) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}`); }
};

const KNOWN = new Map([
  ['t2', 't2'], ['pepe', 't2'],
  ['t3', 't3'], ['statler', 't3'],
  ['t7', 't7'], ['janice', 't7'],
]);

console.log('\nthe declaration');
{
  const derived = declaredControl({}, ['t2', 't3']);
  ok('an absent `controls` derives the set from the agents', derived.names.join() === 't2,t3');
  ok('and says it was derived, so callers can warn instead of refusing', derived.declared === false);

  const declared = declaredControl({ controls: ['t3', 't2'] }, ['t2']);
  ok('a declared set is used instead of the agents', declared.names.join() === 't2,t3');
  ok('and is SORTED, which is what stops two overlapping errands deadlocking',
     declared.names[0] === 't2');
  ok('and is marked declared', declared.declared === true);

  const one = declaredControl({ controls: 't9' }, []);
  ok('a bare string is accepted as a one-character declaration', one.names.join() === 't9');

  const star = declaredControl({ controls: '*' }, ['t1', 't2']);
  ok('`*` is the deliberate whole-fleet script', star.wildcard === true);
  ok('and it still locks the agents it runs with', star.names.join() === 't1,t2');

  const dupes = declaredControl({ controls: ['t2', 't2', ' t3 ', ''] }, []);
  ok('duplicates, padding and blanks are cleaned out', dupes.names.join() === 't2,t3');
}

console.log('\nthe guard refuses an undeclared character');
{
  const control = declaredControl({ controls: ['t2'] }, ['t2']);

  ok('a step for the declared character is allowed',
     controlViolation({ step: { do: 'walk', to: 39 }, agent: 't2', control, known: KNOWN }) === null);

  const bad = controlViolation({ step: { do: 'walk', to: 39 }, agent: 't7', control, known: KNOWN });
  ok('a step RUN FOR an undeclared character is refused', bad !== null);
  ok('and the refusal names the character rather than the fleet', bad.named === 't7');
  ok('and tells you exactly what to add', /controls: \['t2', 't7'\]/.test(bad.error));

  // THE CASE THIS FILE EXISTS FOR.
  const viaAct = controlViolation({
    step: { do: 'act', tool: 'supply', args: { from: 't7', to: 't2', what: 'sapphire' } },
    agent: 't2', control, known: KNOWN });
  ok('`act` naming another character in its ARGS is caught', viaAct?.named === 't7');

  const deep = controlViolation({
    step: { do: 'act', tool: 'x', args: { plan: [{ crew: ['t2', { lead: 'Statler' }] }] } },
    agent: 't2', control, known: KNOWN });
  ok('and it is caught at depth, and by CHARACTER name as well as agent slot',
     deep?.named === 'Statler' && deep?.slot === 't3');
  ok('the refusal prints BOTH the name as written and the slot it resolves to',
     /"Statler \(t3\)"/.test(deep.error));

  ok('a name inside a free-text field is talked about, not commanded',
     controlViolation({ step: { do: 'walk', to: 39, why: 'because Janice asked' },
                        agent: 't2', control, known: KNOWN }) === null);

  ok('a string that is not a character on this fleet is not flagged',
     controlViolation({ step: { do: 'act', tool: 'rescue', args: { mode: 'rescue' } },
                        agent: 't2', control, known: KNOWN }) === null);
}

console.log('\nderived and wildcard sets do not refuse');
{
  const derived = declaredControl({}, ['t2']);
  ok('an undeclared script is not refused — it is warned about elsewhere',
     controlViolation({ step: { do: 'walk', to: 1 }, agent: 't7', control: derived, known: KNOWN }) === null);
  const star = declaredControl({ controls: '*' }, ['t2']);
  ok('a whole-fleet script may drive anything',
     controlViolation({ step: { do: 'walk', to: 1 }, agent: 't7', control: star, known: KNOWN }) === null);
}

console.log('\na whole plan is checked before anything walks');
{
  const control = declaredControl({ controls: ['t2'] }, ['t2']);
  const found = controlViolations(
    [{ do: 'walk', to: 39 }, { do: 'act', tool: 'supply', args: { from: 't7' } }],
    { control, known: KNOWN, agent: 't2' });
  ok('a violation in a LATER step is reported before the first one moves a body',
     found.length === 1 && found[0].named === 't7');
}

console.log('\nthe lock covers exactly the declared characters');
{
  const F = 'testfleet';
  const a = takeAgentLocks(F, ['t3', 't2'], { label: 'errand A' });
  ok('a per-character claim succeeds', a.ok === true);
  ok('and acquires in sorted order', a.agents.join() === 't2,t3');
  ok('one lock file per character, not one for the fleet',
     agentLockFiles(F).map(x => x.agent).sort().join() === 't2,t3');

  // THE WHOLE POINT: a disjoint errand runs at the same time.
  const b = takeAgentLocks(F, ['t7'], { label: 'errand B' });
  ok('a DISJOINT errand is not blocked — this is the bug being fixed', b.ok === true);
  b.release();

  a.release();
  ok('releasing removes the claims', agentLockFiles(F).length === 0);
}

console.log('\nall or nothing, and both scopes still see each other');
{
  const F = 'testfleet2';
  // A FOREIGN HOLDER, FABRICATED HONESTLY. A claim taken in THIS process reads as `mine`
  // and never contends, so the interesting cases cannot be reached by taking locks here.
  // `inspectRunLock` calls a lock held when the pid is alive and either the recorded start
  // time matches or there is none, so a file naming our PARENT — alive, and not us — is
  // exactly what a second driver looks like from in here.
  const foreign = (agent) => writeFileSync(runLockFile(F, agent), JSON.stringify(
    { pid: process.ppid, at: Date.now(), fleet: F, agent, label: 'somebody else' }));

  foreign('t3');
  const blocked = takeAgentLocks(F, ['t2', 't3'], { label: 'errand' });
  ok('a claim over a character somebody else holds is refused', blocked.ok === false);
  ok('and the refusal NAMES the contended character', blocked.agent === 't3');
  ok('and says so in words rather than blaming the fleet',
     /character "t3" is already being driven/.test(blocked.why ?? ''));
  // ALL OR NOTHING. t2 was free and was claimed first (sorted order); it must not be left
  // behind, or the next errand is blocked by a lock nobody is holding.
  ok('ALL-OR-NOTHING: the lock it did take on t2 is released',
     agentLockFiles(F).map(x => x.agent).sort().join() === 't3');
  rmSync(runLockFile(F, 't3'), { force: true });

  // CROSS-SCOPE, the direction that would otherwise be a hole: m59-solo-run takes the
  // FLEET lock, and a per-character errand must still see it.
  writeFileSync(runLockFile(F), JSON.stringify(
    { pid: process.ppid, at: Date.now(), fleet: F, label: 'solo-run' }));
  const underFleetLock = takeAgentLocks(F, ['t2'], { label: 'errand' });
  ok('a per-character claim is blocked by a whole-fleet driver', underFleetLock.ok === false);
  ok('and says the fleet is the thing being driven',
     /whole fleet/.test(underFleetLock.why ?? ''));
  rmSync(runLockFile(F), { force: true });

  // AND THE OTHER WAY ROUND.
  foreign('t9');
  const wholeFleet = takeRunLock(F, { label: 'solo-run', agent: null });
  ok('a whole-fleet claim is blocked by ANY live per-character claim', wholeFleet.ok === false);
  ok('and names which character stopped it', /character "t9"/.test(wholeFleet.why ?? ''));
  rmSync(runLockFile(F, 't9'), { force: true });

  ok('an empty declaration is refused rather than silently locking nothing',
     takeAgentLocks(F, [], {}).ok === false);
  ok('and nothing is left on disk afterwards', agentLockFiles(F).length === 0);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
