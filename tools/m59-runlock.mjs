// ONE THING DRIVING A FLEET AT A TIME, AND A WAY TO FIND OUT WHO.
//
//   import { takeRunLock, readRunLock, releaseRunLock } from './m59-runlock.mjs';
//
// WHY THIS EXISTS. `TaskStop`, Ctrl-C through a wrapper, a broken pipe on stdout — every one
// of them can kill the SHELL that started a fleet-driving script while leaving the `node`
// process itself running. It keeps issuing commands to the broker, for ever, and there is no
// sign of it anywhere except in the fleet's behaviour.
//
// Measured 2026-08-21: three `m59-solo-run.mjs` processes were live at once against the same
// twenty-one shadow characters — one of them sixty-five minutes after it had been "stopped",
// another killed at launch by a `tee` that could not open its output and never noticed. They
// fought each other for the same bodies, and every collision arrived in the transit book as
//
//   movement cancelled by a newer command
//
// which is the SAME SENTENCE a genuine survival interrupt produces. Hours went into a travel
// bug that was partly three copies of the same test elbowing each other.
//
// So: a fleet-driving tool takes this lock, and a second one is refused rather than allowed
// to quietly halve everybody's throughput. This is the same argument the broker's own roster
// lock makes — a second owner is refused before it can serve — one layer up, for the things
// that drive the fleet through it.
//
// A LOCK IS A CLAIM, NOT A FACT. The holder may be gone; a pid may have been recycled onto
// something else entirely. So the pid is corroborated against the process's own START TIME,
// which is the checksum that tells a live claim from a stale number — the same test
// `m59-which.mjs` applies to a broker. A lock whose owner cannot be corroborated is stale and
// is taken over, because refusing for ever on a dead process is its own failure.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// Overridable so a test never touches a real one. Same pattern as the collision tracer.
export const RUN_LOCK_DIR = process.env.M59_RUNLOCK_DIR || join(REPO, 'substrate');

/** Named after the fleet it guards, so two fleets never contend and one fleet always does. */
export function runLockFile(fleet) {
  return join(RUN_LOCK_DIR, `run-${String(fleet || 'default').replace(/[^\w.-]/g, '_')}.lock`);
}

// ---------------------------------------------------------------- is that pid really there
//
// Duplicated from m59-which.mjs rather than imported, and deliberately: that file is a SCRIPT
// with top-level side effects, so importing it to borrow a helper runs it. The same trap as
// importing m59-broker.mjs to check it.
function readProcessStartMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
        `if ($p) { [long](([datetimeoffset]$p.CreationDate).ToUnixTimeMilliseconds()) }`,
      ], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const ms = Number(out);
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      const ticks = Number(fields[19]);
      const btime = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
      if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
      return Math.round((btime + ticks / 100) * 1000);
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}

// Generous, because what this catches is pid RECYCLING — where the disagreement is hours —
// and it must never fire on a process that merely took a moment to write its own lock.
const START_TOLERANCE_MS = 15 * 60 * 1000;

/** What the file says, with no judgement about whether the holder is alive. */
export function readRunLock(fleet) {
  const file = runLockFile(fleet);
  if (!existsSync(file)) return null;
  try { return { ...JSON.parse(readFileSync(file, 'utf8')), file }; }
  catch { return { file, unreadable: true }; }
}

/**
 * Is the lock held by something that is actually running?
 *
 * Three answers, and the third is the one that matters: `held` (someone is driving),
 * `stale` (a lock whose owner is gone or is a different process wearing a recycled pid),
 * and `none`.
 */
export function inspectRunLock(fleet) {
  const lock = readRunLock(fleet);
  if (!lock) return { state: 'none' };
  if (lock.unreadable) return { state: 'stale', lock, why: 'the lock file will not parse' };
  const pid = Number(lock.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'stale', lock, why: 'no pid in the lock' };
  const startedAt = readProcessStartMs(pid);
  if (startedAt === null) return { state: 'stale', lock, why: `pid ${pid} is not running` };
  // THE CHECKSUM. A pid that is alive is not the same as OUR pid being alive — the number
  // gets reused, and a recycled one is a stranger with a matching badge.
  if (Number.isFinite(lock.startedAt) && Math.abs(startedAt - lock.startedAt) > START_TOLERANCE_MS)
    return { state: 'stale', lock, why: `pid ${pid} was recycled — it started ` +
                                        `${new Date(startedAt).toISOString()}, the lock claims ` +
                                        `${new Date(lock.startedAt).toISOString()}` };
  // CORROBORATED FIRST, AND ONLY THEN "MINE". This used to short-circuit on
  // `pid === process.pid` before checking anything, which is wrong in the one case that
  // matters: a lock left by a dead run whose pid the OS has since handed to us. The number
  // matching is not evidence of anything on its own — the start time is.
  if (pid === process.pid) return { state: 'held', lock, mine: true };
  return { state: 'held', lock, ageMs: Date.now() - (lock.at ?? Date.now()) };
}

/**
 * Claim the fleet, or explain who has it.
 *
 * Returns `{ ok: true, release }` or `{ ok: false, holder, why }`. Releasing is wired to
 * process exit as well, because the whole point is a lock that does not outlive its owner —
 * but `exit` does not run on SIGKILL, which is exactly why `inspectRunLock` corroborates the
 * pid instead of trusting the file.
 */
export function takeRunLock(fleet, { label = 'a fleet run', force = false } = {}) {
  const found = inspectRunLock(fleet);
  if (found.state === 'held' && !found.mine && !force)
    return { ok: false, holder: found.lock, why: 'another run is driving this fleet', found };

  const file = runLockFile(fleet);
  mkdirSync(dirname(file), { recursive: true });
  const mine = { pid: process.pid, startedAt: readProcessStartMs(process.pid), at: Date.now(),
                 fleet: String(fleet ?? ''), label,
                 argv: process.argv.slice(1).join(' ').slice(0, 400) };
  writeFileSync(file, JSON.stringify(mine, null, 2));

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // Only ever remove OUR OWN claim. A run that overran and was taken over must not delete
    // the lock of whatever took over from it on the way out.
    try {
      const now = readRunLock(fleet);
      if (now && Number(now.pid) === process.pid) unlinkSync(file);
    } catch { /* a lock that cannot be removed is stale, and stale is recoverable */ }
  };
  process.once('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try { process.once(sig, () => { release(); process.exit(130); }); } catch { /* not on this platform */ }
  }
  return { ok: true, release, lock: mine, tookOverFrom: found.state === 'stale' ? found : null };
}

export function releaseRunLock(fleet) {
  const file = runLockFile(fleet);
  try { if (existsSync(file)) unlinkSync(file); return true; } catch { return false; }
}

/**
 * DIE WHEN NOBODY IS LISTENING ANY MORE.
 *
 * The third of the three orphans was made by a `tee` that could not open its file: the pipe
 * broke, node took `EPIPE` on stdout, and kept running with nowhere to write for an hour.
 * A fleet-driving script whose output goes nowhere is doing damage in silence, so it stops.
 */
export function exitWhenOutputIsGone() {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', err => {
      if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') process.exit(141);
    });
  }
}
