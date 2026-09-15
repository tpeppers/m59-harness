// IS THE PROCESS UNDER THIS PID STILL THE ONE THAT MADE THE CLAIM?
//
// `isProcessLive` asks `kill(pid, 0)`, which answers "is SOMETHING running under this
// number" and never "is it ours". Pids are reused, and on this machine that difference is
// not theoretical: on 2026-09-08 a broker died holding a fleet lock whose guard pid had
// since been handed to a desktop chat application, and on 2026-09-10 the same thing
// happened again with McAfee's `browserhost.exe` — the shadow fleet's account lease named
// a dead broker guarded by a live pid that had never been a keeper, and
// `inspectFleetLock` therefore reported the lock `live` for ever. Neither guarded adoption
// nor `M59_ALLOW_UNGUARDED_TAKEOVER` covers that shape (the lock HAS guards — they are
// merely dead), so the only remaining recovery was deleting a lock, which this repository
// forbids and which a human then has to be talked through at the exact moment they are
// least able to judge it.
//
// TWO KINDS OF EVIDENCE, AND THEY ARE NOT EQUALLY GOOD.
//
//   START TIME is identity. A pid plus the moment its process started is the checksum
//   m59-which.mjs already uses to tell a genuine claim from a recycled pid wearing the same
//   number. A guard that records it can be checked exactly, and a recycled pid — even a
//   recycled NODE pid — simply fails to match. This is the real fix and it is what new
//   locks carry.
//
//   IMAGE NAME is a fallback for locks written before that field existed. Every keeper this
//   repository starts is `m59-keeper-process.mjs` under node, so a pid positively running
//   something that is not node cannot be one of ours.
//
// THE ASYMMETRY IS WHAT MAKES BOTH SAFE. The dangerous direction is mistaking a LIVE keeper
// for dead and letting a second broker onto the same characters. That needs either a start
// time we recorded wrongly for a process that is still running, or node reporting as
// not-node. Anything we cannot determine returns `null` and the caller keeps refusing, so
// every uncertain case fails closed exactly as it did before.
import { execFileSync } from 'node:child_process';

/** Windows' own clock skew is not the point; these readers are second-granular. */
export const START_TIME_TOLERANCE_MS = 2000;

/**
 * Deliberately generous — any name containing `node` counts — because the cost of a false
 * YES is only that a refusal stands, while a false NO would exclude a real guard.
 */
export function isNodeProcessName(name) {
  return /(^|[\/\\])node(\.exe)?$/i.test(String(name ?? '').trim())
      || /node/i.test(String(name ?? ''));
}

/**
 * The image name running under `pid`, or null when it cannot be determined.
 *
 * Bounded and wrapped in its own try, because it runs inside ownership checks and an
 * ownership check that threw because a DIAGNOSTIC failed would be a worse bug than the one
 * it describes.
 */
export function processImageName(pid, { exec = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const out = exec('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      const name = String(out).trim().split('","')[0]?.replace(/^"/, '') ?? '';
      return name && !/^INFO:/i.test(name) ? name : null;
    }
    const out = exec('ps', ['-p', String(pid), '-o', 'comm='],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out).trim() || null;
  } catch { return null; }
}

/**
 * When each of these pids started, in epoch milliseconds. Missing or unreadable pids map to
 * null rather than being dropped, so a caller iterating the result cannot mistake "I could
 * not tell" for "not running".
 *
 * ONE CALL FOR THE WHOLE SET. A broker lock can name twenty-one guards and this runs inside
 * an ownership check; twenty-one PowerShell startups would put a third of a second on every
 * one of them. Asked only when a pid is live and about to hold a lock, which is the rare
 * path.
 */
export function processStartTimes(pids, { exec = execFileSync } = {}) {
  const wanted = [...new Set((Array.isArray(pids) ? pids : [pids])
    .filter(p => Number.isSafeInteger(p) && p > 0))];
  const out = new Map(wanted.map(p => [p, null]));
  if (!wanted.length) return out;
  try {
    if (process.platform === 'win32') {
      const filter = wanted.map(p => `ProcessId=${p}`).join(' or ');
      const text = exec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter '${filter}' | ` +
        'ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.CreationDate.ToUniversalTime().Ticks }'],
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of String(text).split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (!m) continue;
        // .NET ticks are 100ns since 0001-01-01; 621355968000000000 is the Unix epoch.
        const ms = Number((BigInt(m[2]) - 621355968000000000n) / 10000n);
        if (Number.isSafeInteger(ms) && ms > 0) out.set(Number(m[1]), ms);
      }
      return out;
    }
    const text = exec('ps', ['-o', 'pid=,lstart=', '-p', wanted.join(',')],
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of String(text).split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const ms = Date.parse(m[2]);
      if (Number.isFinite(ms)) out.set(Number(m[1]), ms);
    }
    return out;
  } catch { return out; }
}

export function processStartedAt(pid, options = {}) {
  return processStartTimes([pid], options).get(pid) ?? null;
}

/**
 * THE ONE RULE, IN ONE PLACE: is a live guard pid still the keeper that registered it?
 *
 *   true   — it is ours, or we cannot prove otherwise. The lock holds. (fail closed)
 *   false  — positively not ours: a recorded start time that does not match, or an image
 *            that is not node. The guard is treated as dead.
 *
 * `recordedStart` is what the lock wrote down for this pid, when it wrote anything.
 */
export function guardStillOurs(guardPid, recordedStart, {
  startedAt = null,
  imageName = null,
  toleranceMs = START_TIME_TOLERANCE_MS,
} = {}) {
  if (Number.isSafeInteger(recordedStart) && recordedStart > 0) {
    if (Number.isSafeInteger(startedAt) && startedAt > 0)
      return Math.abs(startedAt - recordedStart) <= toleranceMs
        ? { ours: true, why: 'start time matches' }
        : { ours: false, why: `started ${new Date(startedAt).toISOString()}, ` +
                              `the guard was registered at ${new Date(recordedStart).toISOString()}` };
    // Recorded but unreadable now: fall through to the image check rather than assume.
  }
  if (imageName !== null && !isNodeProcessName(imageName))
    return { ours: false, why: `pid is running ${imageName}, which is not a keeper` };
  return { ours: true, why: 'not positively identified as anything else' };
}
