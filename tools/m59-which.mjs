#!/usr/bin/env node
// WHICH FLEET AM I ABOUT TO ACT ON, AND IS IT THE ONE THAT IS RUNNING?
//
//   node tools/m59-which.mjs [--fleet <name>] [--port 8901]
//
// Every fleet tool takes --fleet and every one of them is silent about it, which is
// the whole problem: passing the wrong one, or none, operates on the wrong fleet and
// does so quietly. A restart once stopped a live 46-session broker and would have
// brought back a different roster pointed at a server that was down — nothing in the
// output of any step said which fleet was meant.
//
// So this says it, out loud, before anything is touched. It is the first line of every
// slash command for that reason, and it is a TOOL rather than twenty lines of node -e
// pasted into each command file, because those files exist in two repositories and the
// copies drift.
//
// It changes nothing. Read-only, safe at any time.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { resolveFleet } from './m59-fleetpath.mjs';
import { BROKER_FLEET_LOCK_KIND, inspectFleetLock } from './runtime/fleet-lock.mjs';

const argv = process.argv.slice(2);
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(arg('--port', process.env.M59_BROKER_PORT || 8901));

// ONE PORT IS NOT A SEARCH, AND "NOTHING FOUND" IS THE ANSWER THAT GETS PEOPLE HURT.
// This used to ask 8901 and nothing else, so a broker started anywhere else was invisible
// and the report read `not answering on 8901 - nothing is holding a fleet` with exit 0.
// That is a FALSE ALL-CLEAR from the one tool whose entire job is to refuse one, and it is
// the same shape as the failure this file was written after: every step reporting success
// while a live 46-session broker was stopped. Measured on this machine, with the shadow
// fleet held on 8971 by a broker with 21 characters in game.
//
// m59-service.mjs writes substrate/broker-<fleet>.pid with the port it started on, which is
// how m59-fleets.mjs finds brokers on any port. Ask the same places: the default first,
// because one broker on the default port is the ordinary case, then every port a pid file
// names. A pid file that is stale merely costs one refused connection.
const SUBSTRATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate');
const portOk = p2 => Number.isInteger(p2) && p2 > 0 && p2 < 65536;
function candidatePorts() {
  const ports = portOk(PORT) ? [PORT] : [];
  try {
    for (const file of readdirSync(SUBSTRATE)) {
      if (!/^broker-.+\.pid$/.test(file)) continue;
      try {
        const port = Number(JSON.parse(readFileSync(join(SUBSTRATE, file), 'utf8'))?.http);
        if (portOk(port)) ports.push(port);
      } catch { /* a pid file we cannot read is only a lost hint */ }
    }
  } catch { /* no substrate directory is an ordinary answer */ }
  return [...new Set(ports)];
}

// ASK OVER `node:http`, NOT `fetch`, AND THE REASON IS THIS TOOL'S ONLY CONTRACT.
//
// What this file is FOR is its exit code: every `/m59*` command runs it first and gates on
// it, and `m59-fleets.mjs` documents the same probe as `connection: close, agent: false`.
// The `fetch` version was measured crashing on the way out:
//
//     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
//
// ...with exit 127, AFTER printing entirely correct output. Reproduced on this machine at
// a sharp, deterministic threshold — with three or more ports answering /health it fails
// 60 times out of 60, and with two or fewer it never fails at all:
//
//     0 live -> 0/15    1 live -> 0/15    2 live -> 0/15    3 live -> 15/15
//
// That threshold is why it stayed hidden. The old single-port probe could only ever have
// ONE connection open, so the bug was unreachable; the multi-port probe that made this
// tool honest about brokers on other ports is also what made three of them answer at once.
// The report that found it saw the "also up" line printed immediately before the crash,
// which is exactly the ≥3 case.
//
// The mechanism is `fetch` plus `process.exit()`: each successful call leaves a KEEP-ALIVE
// socket in undici's global pool and an un-cancelled `AbortSignal.timeout` timer, and
// exiting abruptly tears those down mid-close. `agent: false` with `connection: close`
// leaves no pooled socket to tear down and needs no abort timer, so there is nothing left
// holding the loop and nothing left in a closing state. It also never rejects — an
// unreachable port is an ordinary answer here, not an error.
//
// A FAILED PROBE AND AN EMPTY PORT ARE DIFFERENT ANSWERS, and conflating them is what
// produced the bug fixed below, so this reports WHICH. `ECONNREFUSED` is a definite
// "nothing is listening there"; a timeout is "I do not know", and this tool may never
// turn "I do not know" into a statement about a fleet.
//
// PATIENT ON PURPOSE, for the same reason m59-service.mjs is: a broker mid-rejoin with
// twenty-one characters in game genuinely takes longer than a couple of seconds to answer
// /health. Measured on this machine while the prod broker served fleet snapshots, its
// /health went to 1046ms idle and 2573ms under modest load, against 4ms for an idle
// broker on another port — so the busiest broker, which is always the one that matters
// most, is the one most likely to be missed by an impatient probe. A dead port still
// costs nothing: ECONNREFUSED comes back immediately.
//
// The timeout is overridable ONLY so the offline test can drive the slow-answer case in
// milliseconds instead of minutes. Nothing in normal use sets it.
const PROBE_MS = Number(process.env.M59_WHICH_TIMEOUT_MS) > 0
  ? Number(process.env.M59_WHICH_TIMEOUT_MS) : 15000;
function probeHealth(port, timeoutMs = PROBE_MS) {
  return new Promise((done) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/health', method: 'GET',
      headers: { connection: 'close' }, agent: false, timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      // The body is drained even when the status is wrong. A response left unread is a
      // socket left open, which is the same class of leftover handle this replaced.
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300)
          return done({ ok: false, definite: true, why: `HTTP ${res.statusCode}` });
        try { done({ ok: true, health: JSON.parse(body) }); }
        catch { done({ ok: false, definite: true, why: 'unparsable /health' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, definite: false, why: `no answer in ${timeoutMs}ms` }); });
    // ECONNREFUSED/EHOSTUNREACH are definite: nothing is listening. Anything else (a reset
    // mid-read, a socket error) leaves the question open and must not be read as "empty".
    req.on('error', (e) => done({
      ok: false,
      definite: e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH' || e.code === 'EADDRNOTAVAIL',
      why: e.code || e.message,
    }));
    req.end();
  });
}

const c = process.stdout.isTTY
  ? { ok: s => `\x1b[32m${s}\x1b[0m`, bad: s => `\x1b[31m${s}\x1b[0m`,
      warn: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` }
  : { ok: s => s, bad: s => s, warn: s => s, dim: s => s };

let fleet;
try { fleet = resolveFleet(argv); }
catch (e) { console.error(c.bad(e.message)); process.exit(2); }

const short = p => p.replace(/^.*[\\/]substrate[\\/]/, 'substrate/').replace(/\\/g, '/');

// A ROSTER PATH IS AN IDENTITY; A FLEET LABEL IS NOT. Two checkouts can each hold a fleet
// called "prod" and they are not the same 21 characters — CLAUDE.md says so, m59-fleets.mjs
// already matches brokers this way, and this file did not. Same comparison as that one.
const samePath = (a, b) => !!a && !!b &&
  resolve(String(a)).replace(/\\/g, '/').toLowerCase() ===
  resolve(String(b)).replace(/\\/g, '/').toLowerCase();

// WHEN DID THAT PROCESS ACTUALLY START? A pid on its own is not an identity either: pids
// are recycled, and a stale lock naming a recycled pid looks exactly like a live claim.
// Both records this tool reads carry the wall-clock moment they were written, so the
// process's real start time is the checksum that tells a genuine claim from a coincidence.
// Measured here: broker-prod.pid `at` was 1787321476980 and pid 30028 actually started at
// 1787321476979 — ONE MILLISECOND apart, because m59-service.mjs writes the pid file as it
// spawns. The lock is written after the broker takes it, so it lags by a second or two.
//
// Unavailable is not a failure. If the start time cannot be read, the check is skipped and
// said to be skipped; it may only ever REFUTE a claim, never manufacture one.
// Memoised: the common path asks about the same pid twice (once to test the lock, once to
// corroborate the broker answering), and on Windows each miss is a powershell spawn. This
// tool is the first line of every /m59 command, so the round trip is worth saving.
const startMsCache = new Map();
function processStartMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (startMsCache.has(pid)) return startMsCache.get(pid);
  const value = readProcessStartMs(pid);
  startMsCache.set(pid, value);
  return value;
}
function readProcessStartMs(pid) {
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
      // Field 22 is starttime in clock ticks since boot. The comm field can contain spaces
      // and parentheses, so everything up to the LAST ')' is skipped rather than split on.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      const ticks = Number(fields[19]);                       // 22nd field overall
      const btime = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
      if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
      return Math.round((btime + ticks / 100) * 1000);        // USER_HZ is 100 everywhere we run
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}

// A generous window. What this catches is pid RECYCLING, where the disagreement is hours or
// days; it must never fire on a broker that simply took a while to write its lock.
const START_TOLERANCE_MS = 15 * 60 * 1000;

function readRecord(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// What is on disk. A roster that is missing is worth saying plainly rather than as a
// zero, because "no such fleet" and "a fleet with nobody in it" want different answers.
let rosterLine;
if (!existsSync(fleet.stateFile)) {
  rosterLine = c.warn(`no roster at ${short(fleet.stateFile)} — this fleet does not exist yet`);
} else {
  try {
    const raw = readFileSync(fleet.stateFile, 'utf8');
    const names = Object.keys(JSON.parse(raw));
    rosterLine = `${short(fleet.stateFile)} — ${names.length} character(s), ${raw.length} bytes`;
  } catch (e) {
    rosterLine = c.bad(`${short(fleet.stateFile)} — unreadable: ${e.message}`);
  }
}

// THE ROSTER LOCK IS THE AUTHORITY ON WHO HOLDS THIS FLEET, and it does not care about
// ports — the same conclusion m59-service.mjs reached after starting a second broker on a
// fleet that was already held. `m59-broker.mjs` writes the owning pid into a lock named
// after the roster it guards, so read that before believing any port.
const lock = {
  pid: null, at: null, stale: '', held: false, heldWhy: '', guardPid: null,
  unguardedBroker: false, unverifiable: false,
};
const lockFound = inspectFleetLock(fleet.lockFile);
if (lockFound.lock) lock.at = Number(lockFound.lock.at) || null;
if (lockFound.state === 'live') {
  lock.held = true;
  lock.heldWhy = lockFound.why ?? '';
  lock.unverifiable = lockFound.unverifiable === true;
  lock.guardPid = Number(lockFound.guard_pid) || null;
  if (!lockFound.owner_dead && Number.isInteger(Number(lockFound.lock?.pid))) {
    const pid = Number(lockFound.lock.pid);
    // Alive is not enough. A recycled pid is alive and is not our broker; the start-time
    // checksum is what separates them, and without it we keep the claim rather than
    // inventing a reason to drop it.
    const started = processStartMs(pid);
    if (started !== null && lock.at && Math.abs(started - lock.at) > START_TOLERANCE_MS) {
      lock.stale = `lock names pid ${pid}, but that process started ` +
                   `${new Date(started).toISOString()} and the lock was taken ` +
                   `${new Date(lock.at).toISOString()} — a recycled pid, not our broker`;
      lock.held = false;
    } else {
      lock.pid = pid;
    }
  }
} else if (lockFound.state === 'stale') {
  const unguardedBroker = lockFound.lock?.kind === BROKER_FLEET_LOCK_KIND &&
    !Object.hasOwn(lockFound.lock, 'guards');
  if (unguardedBroker) {
    // A dead pre-guard broker is not an all-clear on Windows: its keeper children may
    // still own live game sockets. Standard startup requires the explicit migration path,
    // and this read-only gate must agree rather than advising lock deletion.
    lock.held = true;
    lock.unguardedBroker = true;
    lock.heldWhy = `broker pid ${lockFound.lock.pid} is gone, but this pre-guard record ` +
      'cannot prove that its keeper children are gone';
  } else {
    lock.stale = lockFound.why ?? 'the fleet claim and all keeper guards are dead';
  }
}

// The pid file for THIS fleet, which is the record that carries the port and the tightest
// timestamp. Matched by the fleet it names, never by filename alone.
let pidRec = null;
try {
  for (const file of readdirSync(SUBSTRATE)) {
    if (!/^broker-.+\.pid$/.test(file)) continue;
    const rec = readRecord(join(SUBSTRATE, file));
    if (rec && (rec.fleet || 'default') === fleet.label) { pidRec = rec; break; }
  }
} catch { /* no substrate directory is an ordinary answer */ }

// Who is actually holding a fleet right now. The broker is the authority on this; what
// we resolved is only what the NEXT command would do.
const ports = candidatePorts();
async function probeAll() {
  const answers = await Promise.all(ports.map(p => probeHealth(p)));
  return answers.map((a, i) => ({ port: ports[i], ...a }));
}

let asked = await probeAll();
let live = asked.filter(a => a.ok);
const findOurs = () => live.find(x => samePath(x.health.state, fleet.stateFile)) ?? null;
let ours = findOurs();

// One retry, and only in the case that actually happens: the lock says a live pid holds
// this roster but no answering broker claims it. The overwhelmingly likely cause is that
// the busiest broker on the machine — ours — was slow, not that it vanished between two
// lines of this file. Asking twice is cheap; being wrong here is not.
if (!ours && lock.held) {
  asked = await probeAll();
  live = asked.filter(a => a.ok);
  ours = findOurs();
}

const unknown = asked.filter(a => !a.ok && !a.definite);

console.log(`fleet    ${c.ok(fleet.label)}   ${c.dim('<- ' + fleet.source)}`);
console.log(`roster   ${rosterLine}`);

// Several brokers up at once is normal here and is not itself a problem; being unaware of
// one is. Name every one that is not ours, whatever the verdict below turns out to be.
function listOthers() {
  for (const other of live) {
    if (other === ours) continue;
    console.log(c.dim(`         also up: pid ${other.health.pid} on ${other.port} holding ` +
                      `${other.health.fleet || 'default'}, ${other.health.sessions?.length ?? 0} session(s)` +
                      `${other.health.state ? ` [${short(other.health.state)}]` : ''}`));
  }
  for (const u of unknown)
    console.log(c.warn(`         port ${u.port} did not answer (${u.why}) — cannot say what, if anything, holds it`));
}

if (ours) {
  const held = ours.health.fleet || 'default';
  const n = ours.health.sessions?.length ?? 0;
  console.log(`broker   ${c.ok('UP')} pid ${ours.health.pid} on ${ours.port}, holding ${c.ok(held)}, ${n} session(s)`);
  listOthers();

  // CORROBORATION. The state path already proved this broker is serving OUR roster, which
  // is the claim that matters. These cross-checks exist to catch the case where the records
  // on disk and the process answering the socket disagree — a second broker, a half-cleaned
  // restart, a lock nobody released — because that disagreement means something is wrong
  // even though every individual line reads healthy.
  const notes = [];
  const bpid = Number(ours.health.pid);
  if (lock.pid && bpid && lock.pid !== bpid)
    notes.push(`the roster lock names pid ${lock.pid}, but the broker answering for this roster is pid ${bpid}`);
  if (lock.held && !lock.pid)
    notes.push(lock.heldWhy || 'the roster lock is protected but has no reachable broker owner');
  if (pidRec && Number(pidRec.pid) && bpid && Number(pidRec.pid) !== bpid)
    notes.push(`${short(join(SUBSTRATE, `broker-${fleet.label}.pid`))} names pid ${pidRec.pid}, but pid ${bpid} is answering`);
  if (pidRec && Number(pidRec.http) && Number(pidRec.http) !== ours.port)
    notes.push(`the pid file says port ${pidRec.http}, but this broker answered on ${ours.port}`);
  if (lock.stale) notes.push(lock.stale);

  const started = processStartMs(bpid);
  if (started === null) {
    console.log(c.dim(`         (process start time unavailable here — pid/lock timestamps not corroborated)`));
  } else {
    const at = Number(pidRec?.at) || lock.at || null;
    if (at && Math.abs(started - at) > START_TOLERANCE_MS)
      notes.push(`pid ${bpid} started ${new Date(started).toISOString()} but this fleet's records were ` +
                 `written ${new Date(at).toISOString()} — the records do not describe this process`);
    else if (at)
      console.log(c.dim(`         corroborated: pid ${bpid} started ${new Date(started).toISOString()}, ` +
                        `${Math.abs(started - at)}ms from this fleet's own record`));
  }

  if (notes.length) {
    console.log('');
    console.log(c.bad(`INCONSISTENT: a broker is serving this roster, but the records on disk disagree with it.`));
    for (const note of notes) console.log(c.bad(`  - ${note}`));
    console.log(c.bad(`Do not act until that is explained: it is the shape of a second broker on one fleet.`));
    process.exitCode = 1;
  } else if (ours.health.root && !ours.health.root.replace(/[\\/]+$/, '').endsWith('m59-harness')) {
    console.log(c.warn(`note: that broker's checkout is ${ours.health.root}`));
  }

} else if (lock.held) {
  // Held by a live pid we cannot reach. Refusing is the right direction to fail in — the
  // same call m59-service.mjs makes — because acting now would target a broker we could
  // not find, and starting one would make a second on the same fleet.
  const holder = lock.pid
    ? `live broker pid ${lock.pid}`
    : lock.guardPid
      ? `a dead broker whose keeper pid ${lock.guardPid} is still live`
      : lock.unguardedBroker
        ? 'a dead pre-guard broker whose keeper children cannot be ruled out'
        : 'an unverifiable ownership record';
  console.log(`broker   ${c.warn('UNKNOWN')} — the roster lock for "${fleet.label}" is protected by ${holder}`);
  if (lock.heldWhy) console.log(c.dim(`         ${lock.heldWhy}`));
  listOthers();
  console.log('');
  console.log(c.bad(`INDETERMINATE: "${fleet.label}" may still have live account sessions.`));
  console.log(c.bad(`Do not act on this fleet or delete its ownership record. Use the exact-roster`));
  console.log(c.bad(`broker restart/adoption path; pre-guard records require the documented one-time migration.`));
  process.exitCode = 1;

} else if (unknown.length) {
  // THE BUG THIS REPLACED. A port that failed to answer used to fall through to `live[0]`
  // — literally "some other broker" — which was then printed as "the" broker and compared
  // against the fleet we meant. On this machine that turned one slow answer from the prod
  // broker into `MISMATCH: the broker is holding "shadow"`, naming a fleet of 21 entirely
  // different characters, roughly one run in four. It fails safe by luck rather than by
  // design: the same fallback would report an all-clear the moment the unrelated broker's
  // label happened to match. There is no fallback now. A port we could not reach is a
  // question, and a question is not an answer about a fleet.
  console.log(`broker   ${c.warn('UNKNOWN')} — no broker answering for this roster, and not every port could be asked`);
  listOthers();
  console.log('');
  console.log(c.bad(`INDETERMINATE: cannot say whether "${fleet.label}" is being held.`));
  console.log(c.bad(`Re-run; if a port keeps refusing to answer, find out what is on it before acting.`));
  process.exitCode = 1;

} else if (live.length) {
  // The exact trap this file exists for. Every port gave a definite answer, brokers are up,
  // and not one of them is serving our roster.
  console.log(`broker   ${c.warn('none holding this roster')}`);
  listOthers();
  console.log('');
  const held = live.map(x => `"${x.health.fleet || 'default'}"`).join(', ');
  console.log(c.bad(`MISMATCH: ${live.length === 1 ? 'the broker up is holding' : 'the brokers up are holding'} ${held}, ` +
                    `but this command would act on "${fleet.label}".`));
  // `--fleet default` is not a way to ask for the unnamed fleet; `--fleet -` is. Printing an
  // invocation that does not work is its own small trap in a message about traps.
  const askFor = name => (name && name !== 'default') ? `--fleet ${name}` : '--fleet -';
  const other = live.length === 1 ? askFor(live[0].health.fleet) : '--fleet <the one you meant>';
  console.log(c.bad(`Anything you run now targets the wrong fleet, quietly. Say ${other},`));
  console.log(c.bad(`or say ${askFor(fleet.fleet)} and mean it.`));
  // `exitCode`, NEVER `process.exit()`. Same argument as the probe above: the ONE thing
  // every caller of this file reads is the status, so it must not be decided by what the
  // event loop happens to be doing when the process is yanked. Setting it and letting the
  // loop drain is free here — the probe holds no socket open — and it cannot be raced.
  process.exitCode = 1;

} else {
  // Every candidate port answered definitely, and nothing is listening. This is the one
  // case that is genuinely an all-clear, and it stays exit 0 so `./m59.sh up` still works.
  console.log(`broker   ${c.warn('not answering on ' + ports.join(', '))} — nothing is holding a fleet`);
  if (lock.stale) console.log(c.dim(`         (${lock.stale})`));
}
