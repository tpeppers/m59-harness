#!/usr/bin/env node
// ONLY ONE THING MAY DRIVE A FLEET, AND A DEAD CLAIM MUST NOT BLOCK A LIVE ONE.
//
//   node tools/m59-runlock-test.mjs
//
// Offline. No socket, no broker, no roster — and it never touches a real lock, because
// M59_RUNLOCK_DIR is pointed at scratch before the module is imported.
//
// WHAT THIS GUARDS. On 2026-08-21 three copies of `m59-solo-run.mjs` were driving the same
// twenty-one shadow characters at once. One had been "stopped" sixty-five minutes earlier
// through a wrapper that killed the shell and left the node process; one had been killed at
// launch by a `tee` that could not open its output, took EPIPE on stdout, and carried on for
// an hour with nowhere to write. They fought over the same bodies, and every collision
// arrived in the transit book as
//
//   movement cancelled by a newer command
//
// which is exactly what a genuine survival interrupt looks like. A long investigation into a
// travel bug was, in part, an investigation into three copies of itself.
//
// The two properties below are the fix, and both of them erode silently:
//
//   1. A SECOND RUN IS REFUSED, by name, while a first is genuinely alive.
//   2. A STALE CLAIM IS TAKEN OVER, because refusing for ever on a dead process is its own
//      failure — and `exit` handlers do not run on SIGKILL, so stale claims are normal.
//
// It should fail the day a fleet tool stops taking the lock.

import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRATCH = join(tmpdir(), `m59-runlock-test-${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });
process.env.M59_RUNLOCK_DIR = SCRATCH;

const HERE = dirname(fileURLToPath(import.meta.url));
const lock = await import('./m59-runlock.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

console.log('');
console.log('the lock is named after the fleet it guards');
{
  ok('a named fleet gets its own file', lock.runLockFile('shadow') !== lock.runLockFile('prod'));
  ok('and it lives under the overridable directory, so a test never touches a real one',
     lock.runLockFile('shadow').startsWith(SCRATCH), lock.runLockFile('shadow'));
  // A fleet name reaches this from a command line, so it must not be able to name a PATH.
  // The property is that the result stays inside the directory — not that the string has no
  // dots in it. `run-.._.._etc_passwd.lock` contains ".." and is a perfectly safe flat
  // filename; asserting on the substring tests the sanitiser's spelling instead of its job.
  const escaped = resolve(lock.runLockFile('../../etc/passwd'));
  ok('a fleet name cannot escape the directory',
     escaped.startsWith(resolve(SCRATCH) + sep), escaped);
  ok('and a separator in the name cannot make a subdirectory either',
     !escaped.slice(resolve(SCRATCH).length + 1).includes(sep), escaped);
}

console.log('');
console.log('one run holds it, and a second is refused rather than allowed to fight');
{
  const first = lock.takeRunLock('shadow', { label: 'the first run' });
  ok('the first claim succeeds', first.ok === true);
  ok('and the file records the pid that owns it',
     lock.readRunLock('shadow')?.pid === process.pid);
  ok('and what it is doing, so a refusal can name it',
     lock.readRunLock('shadow')?.label === 'the first run');

  // THE WHOLE POINT. Same process here, but the code path is the one a second process takes:
  // inspectRunLock reports `held`, and only `mine` lets this one through.
  const found = lock.inspectRunLock('shadow');
  ok('the lock inspects as held', found.state === 'held', JSON.stringify(found));

  ok('a different fleet is not blocked by it',
     lock.takeRunLock('other-fleet', { label: 'unrelated' }).ok === true);

  first.release();
  ok('releasing removes the claim', lock.readRunLock('shadow') === null);
  ok('and releasing twice is harmless', (first.release(), true));
}

console.log('');
console.log('a claim whose owner is gone is STALE, and stale is taken over');
{
  // `exit` handlers do not run on SIGKILL, and TaskStop/Ctrl-C through a wrapper leaves them
  // behind routinely — so a lock file outliving its process is the ORDINARY case, not an
  // error. Refusing for ever on one would replace a fleet that is double-driven with a fleet
  // that cannot be driven at all.
  const dead = { pid: 0x7ffffff0, startedAt: Date.now(), at: Date.now(),
                 fleet: 'shadow', label: 'a process that no longer exists' };
  writeFileSync(lock.runLockFile('shadow'), JSON.stringify(dead));
  const found = lock.inspectRunLock('shadow');
  ok('a lock naming a pid that is not running reads as stale', found.state === 'stale',
     JSON.stringify(found));
  ok('and it says why, because "refused" with no reason is the failure this replaces',
     /not running/.test(found.why ?? ''), found.why);
  const taken = lock.takeRunLock('shadow', { label: 'the run after' });
  ok('so the next run takes it', taken.ok === true);
  ok('and is told it took over rather than starting clean', !!taken.tookOverFrom);
  taken.release();
}

console.log('');
console.log('a RECYCLED pid is not the same process, and the start time is what says so');
{
  // The nastiest case: the pid is alive, but it is somebody else wearing the number. Claimed
  // by this very process, with a start time from a day ago — alive, and provably not ours.
  const recycled = { pid: process.pid, startedAt: Date.now() - 24 * 60 * 60 * 1000,
                     at: Date.now() - 24 * 60 * 60 * 1000, fleet: 'shadow', label: 'yesterday' };
  writeFileSync(lock.runLockFile('shadow'), JSON.stringify(recycled));
  const found = lock.inspectRunLock('shadow');
  ok('a live pid with the wrong start time is stale, not held', found.state === 'stale',
     JSON.stringify(found));
  ok('and the reason names recycling', /recycl/i.test(found.why ?? ''), found.why);
  lock.releaseRunLock('shadow');
}

console.log('');
console.log('an unreadable lock is stale, and never a crash');
{
  writeFileSync(lock.runLockFile('shadow'), 'this is not json {{{');
  const found = lock.inspectRunLock('shadow');
  ok('a lock that will not parse reads as stale rather than throwing', found.state === 'stale');
  ok('and says so', /will not parse/.test(found.why ?? ''), found.why);
  lock.releaseRunLock('shadow');
}

console.log('');
console.log('the fleet-driving tools actually take it');
{
  // The guard is worthless if the tool stops calling it, and that is an easy edit to make by
  // accident. Asserted against the SOURCE so this cannot pass by the tool merely importing it.
  const solo = readFileSync(join(HERE, 'm59-solo-run.mjs'), 'utf8');
  ok('m59-solo-run imports the lock', /from '\.\/m59-runlock\.mjs'/.test(solo));
  ok('and claims the fleet before it drives anything', /takeRunLock\(FLEET/.test(solo));
  ok('and refuses rather than continuing when the claim fails',
     /if \(!claim\.ok\)[\s\S]{0,600}process\.exit\(/.test(solo));
  ok('and offers a way to stop the holder', /--stop/.test(solo) && /inspectRunLock/.test(solo));
  // The third orphan was made this way and nothing else would have caught it.
  ok('and it stops when its own output has gone away', /exitWhenOutputIsGone\(\)/.test(solo));
  // Killing by NAME across all processes once took down a live broker from another checkout.
  ok('the stop path signals a pid rather than matching a process name',
     /process\.kill\(pid/.test(solo) && !/pkill|taskkill \/im/i.test(solo));
}

console.log('');
console.log('AN UNRECOGNISED FLAG IS NOT A REQUEST TO DO THE DEFAULT THING TO A LIVE FLEET');
{
  // Measured 2026-08-23, and it was a watcher script for this very tool that did it:
  //
  //     node tools/m59-solo-run.mjs --help
  //
  // There was no `--help`. The flag was ignored, every other setting fell back to its
  // default, and the tool did what it does — took the fleet lock and walked two characters
  // from Tos to Castle Victoria. One of them died in Ukgoth. The real run, started a second
  // later, was then refused because the fleet was already being driven, and the holder it
  // named had a command line reading `--help`.
  //
  // THE LOCK WORKED PERFECTLY. What was missing sits upstream of it: a tool that drives a
  // live fleet needs a way to ask what it does that does not do it, and a typo — `--agent`
  // for `--agents`, `--stagger 60s` for `--stagger 60` — must not silently become a
  // full run with defaults against a shared server. No error has never meant success here.
  const solo = readFileSync(join(HERE, 'm59-solo-run.mjs'), 'utf8');
  const lockAt = solo.indexOf('takeRunLock(FLEET');
  ok('--help is handled at all', /has\('help'\)/.test(solo));
  ok('and it exits BEFORE the lock is taken',
     solo.indexOf('process.exit(0)') >= 0 && solo.indexOf('process.exit(0)') < lockAt,
     'asking what a tool does must not do it');
  ok('an unknown option is refused rather than ignored',
     /unknown option\(s\)/.test(solo) && /process\.exit\(2\)/.test(solo));
  ok('and that refusal also happens before the lock',
     solo.indexOf('unknown option') < lockAt);
  // The allow-list has to actually list what the tool documents, or the guard becomes a
  // second way to refuse a legitimate run.
  ok('the allow-list names every option the tool takes',
     ['agents', 'tour', 'stagger', 'timeout', 'fleet', 'from', 'to', 'stop', 'force',
      'dry-run', 'wall-below', 'hold-below', 'rest-credit', 'recovery-wait', 'port']
       .every(k => solo.includes(`'${k}'`)));
}

console.log('\nrecycledPid: one-sided');
{
  const { recycledPid } = await import('./m59-runlock.mjs');
  const MIN = 60_000, TOL = 15 * MIN, start = Date.parse('2026-10-12T23:35:46Z');
  ok('a lock taken 54 min after its process started (a warm handover) is NOT a recycled pid',
     recycledPid(start, start + 54 * MIN, TOL) === false);
  ok('a process that started hours after the lock was written IS a recycled pid',
     recycledPid(start + 3 * 60 * MIN, start, TOL) === true);
  ok('within the tolerance either way: not recycled', recycledPid(start + 5 * MIN, start, TOL) === false);
  ok('an unreadable start or lock time never manufactures a verdict',
     recycledPid(null, start, TOL) === false && recycledPid(start, null, TOL) === false);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
