#!/usr/bin/env node
// IS THE FLEET BEING DRIVEN RIGHT NOW — and if not, for how long, and does that cost us yet?
//
//   node tools/m59-prodwatch.mjs                  one check. Exit 0 up, 1 down past the alert, 2 cannot tell
//   node tools/m59-prodwatch.mjs --watch          loop, and say something only when the answer CHANGES
//   node tools/m59-prodwatch.mjs --fleet prod --port 8901
//   node tools/m59-prodwatch.mjs --alert-s 180 --penalty-s 600
//
// WHY THIS EXISTS, AND WHY THE NUMBERS ARE NOT ROUND BY ACCIDENT.
//
// `m59-uptime.mjs` already records when nobody was driving, and it is the right ledger for
// "which deaths happened during an outage". What it cannot do is tell you while it is
// happening: it is read afterwards, by somebody who already suspects something. Prod went
// down on 2026-09-16 and stayed down for twenty-five minutes, and the only reason anybody
// found out was that an unrelated command failed with ECONNREFUSED on 8901.
//
// **AFTER TEN MINUTES DOWN, THE GAME STARTS CHARGING US.** Operator, 2026-09-16: in-game
// penalties are applied to characters once they have been left that long. That is the
// number this tool exists to stay ahead of, and it is why the alert fires at THREE — a
// third of the budget, which is enough time to read the line, decide, and run one command.
//
// A stopped keeper is not a pause. The character stands exactly where it was, in whatever
// room it was in, and everything that was already swinging at it carries on — so an outage
// is twenty-three characters being held still in a fight. See the header of m59-uptime.mjs.
//
// WHAT "UP" MEANS HERE IS THE SAME THING `m59-which.mjs` MEANS BY IT, and for the same
// reason: a broker is ours only when its own `/health` names OUR roster file as its state
// path. Two checkouts can each hold a fleet called `prod` and they are not the same
// twenty-three characters, so a matching LABEL proves nothing. This tool re-implements that
// rule rather than importing it because m59-which.mjs is a CLI with no exports; if it ever
// grows them, delete this copy rather than letting the two drift.
//
// AND HERE, UNLIKE IN `m59-which.mjs`, SILENCE IS NOT A QUESTION — IT IS AN ALARM.
//
// That tool answers "which fleet would my next command touch", where guessing wrong is
// worse than refusing, so a port that does not answer is INDETERMINATE and it stops. This
// one answers "is anybody driving", where the cost of a missed outage is measured in
// in-game penalties on twenty-three characters. So an unreachable port counts as DOWN for
// the purposes of the clock, and is reported as `unreachable` rather than `down` so the
// distinction survives into whatever reads it. The exit code still separates them: 2 is
// "could not ask", 1 is "asked, and nobody is there".
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName, stateFileFor } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

export const DEFAULT_ALERT_MS = 3 * 60_000;    // say something while there is still time to act
export const DEFAULT_PENALTY_MS = 10 * 60_000; // operator, 2026-09-16: in-game penalties land here

// ---------------------------------------------------------------- the decision, as a pure function
//
// Separated from the fetching so it can be tested without a socket, which is the only way a
// guard like this gets a test at all. `health` is whatever the port said (or null), `roster`
// is the absolute path we expect it to be holding.
export function verdict({ health, roster, downSince = null, now = Date.now(),
                          alertMs = DEFAULT_ALERT_MS, penaltyMs = DEFAULT_PENALTY_MS } = {}) {
  const same = (a, b) => a && b && resolve(String(a)).toLowerCase() === resolve(String(b)).toLowerCase();
  let state;
  if (health === null) state = 'unreachable';
  else if (!health || health.ok !== true) state = 'down';
  // THE STATE PATH IS THE IDENTITY, NEVER THE LABEL. A broker answering on our port while
  // holding a different roster is not our fleet being up — it is somebody else's fleet
  // wearing our port, which is worse than nothing there, because it reads as healthy.
  else if (!same(health.state, roster)) state = 'foreign';
  else state = 'up';

  const up = state === 'up';
  const since = up ? null : (downSince ?? now);
  const forMs = up ? 0 : Math.max(0, now - since);
  return {
    state, up, down_since: since, down_for_ms: forMs,
    alert: !up && forMs >= alertMs,
    penalty: !up && forMs >= penaltyMs,
    // The whole point of the 3/10 split: how long until it starts costing something.
    penalty_in_ms: up ? null : Math.max(0, penaltyMs - forMs),
    holder: state === 'foreign' ? (health?.state ?? null) : null,
    why: up ? 'the broker on this port is holding our roster'
       : state === 'unreachable' ? 'nothing answered on this port — counted as down, because a ' +
           'missed outage costs in-game penalties and a false alarm costs one command'
       : state === 'foreign' ? 'a broker answered but it is holding a different roster file'
       : 'the broker answered but did not report ok',
  };
}

export const describe = (v) => {
  const s = Math.round(v.down_for_ms / 1000);
  if (v.up) return 'UP — ' + v.why;
  const head = v.penalty ? 'DOWN, PAST THE PENALTY LINE' : v.alert ? 'DOWN, ALERT' : 'down';
  const tail = v.penalty
    ? `${s}s with nobody driving; in-game penalties apply from ${Math.round(DEFAULT_PENALTY_MS / 1000)}s`
    : `${s}s so far; penalties in ${Math.round(v.penalty_in_ms / 1000)}s`;
  return `${head} (${v.state}) — ${tail}. ${v.why}`;
};

// ============================================================ RUNNING IT AS A SERVICE
//
// A WATCH THAT DIES WITH THE SESSION IS THE FAILURE IT WAS BUILT TO CATCH, ONE LEVEL UP.
//
// The first version of this ran as a chat-session Monitor. It worked, and then the session
// ended and it stopped — silently, leaving production running with nobody looking, which is
// exactly the state the tool exists to detect. That is not a bug in the Monitor; it is the
// wrong lifetime. The broker gets a detached process, a pid file and a log for precisely
// this reason (see m59-service.mjs), so the thing WATCHING the broker gets the same.
//
//   node tools/m59-prodwatch.mjs service start     detached; outlives this terminal
//   node tools/m59-prodwatch.mjs service status    up? and WHEN DID IT LAST LOOK?
//   node tools/m59-prodwatch.mjs service stop
//   node tools/m59-prodwatch.mjs service install   a Windows scheduled task, for reboots
//
// AND THE WATCHER NEEDS ITS OWN LIVENESS SIGNAL, or the blind spot has only moved. A dead
// watcher and a quiet one produce identical output: nothing. So every poll stamps `at` into
// the state file whether or not anything changed, and `service status` reports how long ago
// that was and calls it STALE past three polls. "Nothing has alerted" is only reassuring
// from a watcher that is demonstrably still looking.
//
// AN ALERT NOBODY READS IS NOT AN ALERT. The log is a file on one machine, so two other
// doors exist: every alert and penalty crossing is appended to `prodwatch-alerts.jsonl`,
// which survives the process and can be read afterwards by anything; and `--on-alert
// "<command>"` runs a command of the operator's choosing when the line is crossed. The hook
// is deliberately not a notifier of our own devising — whatever already reaches this
// operator is better than whatever this file could invent.
const svcPaths = (fleet) => ({
  pid: join(REPO, 'substrate', `prodwatch-${fleet}.pid`),
  log: join(REPO, 'substrate', `prodwatch-${fleet}.log`),
  state: join(REPO, 'substrate', `prodwatch-${fleet}.json`),
  alerts: join(REPO, 'substrate', `prodwatch-alerts.jsonl`),
});

const alive = (pid) => {
  if (!Number.isFinite(pid)) return false;
  // Signal 0 asks "does this pid exist and may I signal it" without touching it.
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

const readPidFile = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

function serviceStart(fleet, passthrough) {
  const P = svcPaths(fleet);
  const running = readPidFile(P.pid);
  if (running && alive(running.pid)) {
    console.log(`already watching "${fleet}" — pid ${running.pid}, since ${new Date(running.at).toISOString().slice(0, 19)}`);
    return 0;
  }
  mkdirSync(dirname(P.pid), { recursive: true });
  const fd = openSync(P.log, 'a');
  // detached + unref is what makes it outlive this terminal, and stdio to the log rather
  // than 'ignore' is what makes it possible to find out afterwards what it saw.
  const child = spawn(process.execPath,
    [fileURLToPath(import.meta.url), '--watch', '--fleet', fleet, ...passthrough],
    { detached: true, stdio: ['ignore', fd, fd], cwd: REPO, env: process.env });
  child.unref();
  writeFileSync(P.pid, JSON.stringify({ pid: child.pid, fleet, at: Date.now() }, null, 2));
  console.log(`watching "${fleet}"\n  pid   ${child.pid}\n  log   ${P.log}\n  state ${P.state}`);
  return 0;
}

function serviceStop(fleet) {
  const P = svcPaths(fleet);
  const running = readPidFile(P.pid);
  if (!running || !alive(running.pid)) { console.log(`nothing watching "${fleet}"`); return 0; }
  try { process.kill(running.pid); console.log(`stopped pid ${running.pid}`); }
  catch (e) { console.log(`could not stop pid ${running.pid}: ${e.message}`); return 1; }
  return 0;
}

function serviceStatus(fleet, everyS) {
  const P = svcPaths(fleet);
  const running = readPidFile(P.pid);
  const up = running && alive(running.pid);
  const st = (() => { try { return JSON.parse(readFileSync(P.state, 'utf8')); } catch { return null; } })();
  const ageMs = st?.at ? Date.now() - st.at : null;
  // THREE MISSED POLLS IS STALE. One is a slow broker; three is a watcher that is not
  // looking, and that is the thing this command exists to be able to say out loud.
  const staleAfter = everyS * 3 * 1000;
  console.log(`watcher: ${up ? `UP (pid ${running.pid})` : 'DOWN — nothing is watching this fleet'}`);
  console.log(`last look: ${ageMs == null ? 'never' : `${Math.round(ageMs / 1000)}s ago`}` +
              (ageMs != null && ageMs > staleAfter ? '   << STALE: it is not looking any more' : ''));
  if (st?.down_since) console.log(`broker has been down since ${new Date(st.down_since).toISOString().slice(0, 19)}`);
  console.log(`log: ${P.log}`);
  return up && (ageMs == null || ageMs <= staleAfter) ? 0 : 1;
}

// A SCHEDULED TASK IS THE ONLY PART THAT SURVIVES A REBOOT, and schtasks.exe ships with
// Windows — no third-party binary, which is the bar every other tool here is held to.
// It registers the START, so the watcher comes back after a restart; it does not replace
// the pid file, because a task that is "registered" says nothing about whether a process is
// currently looking.
function serviceInstall(fleet, passthrough) {
  const self = fileURLToPath(import.meta.url);
  const name = `m59-prodwatch-${fleet}`;
  const cmd = `"${process.execPath}" "${self}" service start --fleet ${fleet} ${passthrough.join(' ')}`.trim();
  try {
    execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', name, '/TR', cmd], { stdio: 'pipe' });
    console.log(`registered scheduled task "${name}" — it starts the watcher at logon`);
    console.log(`  remove it with:  schtasks /Delete /F /TN ${name}`);
    return 0;
  } catch (e) {
    console.error(`could not register the task: ${String(e.stderr ?? e.message).trim()}`);
    console.error('Run this from a terminal that can create scheduled tasks, or start it by hand ' +
                  'with service start, which survives the terminal but not a reboot.');
    return 1;
  }
}

// ---------------------------------------------------------------- cli
if (import.meta.filename === process.argv[1]) {
  const fleet = arg('--fleet') || (() => { try { return fleetName(); } catch { return 'prod'; } })();
  const port = Number(arg('--port', 8901));
  const alertMs = Number(arg('--alert-s', DEFAULT_ALERT_MS / 1000)) * 1000;
  const penaltyMs = Number(arg('--penalty-s', DEFAULT_PENALTY_MS / 1000)) * 1000;
  const roster = stateFileFor(fleet);

  // The service verbs are handled before anything probes, so `status` works with the broker
  // down and `stop` works when the watcher is the only thing running.
  if (argv[0] === 'service') {
    const verb = argv[1] ?? 'status';
    // Everything except the verb is handed to the watcher it starts, so --every-s,
    // --alert-s, --port and --on-alert all reach the detached process unchanged.
    const passthrough = argv.slice(2).filter(a => a !== '--fleet' && a !== fleet);
    const everyS = Number(arg('--every-s', 20));
    if (verb === 'start')   process.exit(serviceStart(fleet, passthrough));
    if (verb === 'stop')    process.exit(serviceStop(fleet));
    if (verb === 'status')  process.exit(serviceStatus(fleet, everyS));
    if (verb === 'install') process.exit(serviceInstall(fleet, passthrough));
    console.error(`unknown service verb "${verb}" — start, stop, status, install`);
    process.exit(2);
  }

  // The down-since clock has to survive between invocations or a cron job can never measure
  // a duration — every run would see a fresh outage and never reach three minutes.
  const stateFile = arg('--state', join(REPO, 'substrate', `prodwatch-${fleet}.json`));
  const readSince = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')).down_since ?? null; } catch { return null; } };
  // THE HEARTBEAT. `at` is stamped on EVERY poll, up or down, changed or not, because it is
  // what lets `service status` tell a watcher that is quiet from one that is dead. Those look
  // identical from the outside and only one of them is safe.
  const writeSince = (v, state = null) => {
    try { mkdirSync(dirname(stateFile), { recursive: true });
          writeFileSync(stateFile, JSON.stringify({ down_since: v, at: Date.now(), state }) + '\n'); }
    catch { /* a watcher that cannot write its own clock must still report */ }
  };

  // A durable record, so an alert outlives the process that noticed it.
  const alertsFile = join(REPO, 'substrate', 'prodwatch-alerts.jsonl');
  const recordAlert = (kind, v) => {
    try { appendFileSync(alertsFile,
      JSON.stringify({ at: new Date().toISOString(), fleet, port, kind, state: v.state,
                       down_for_s: Math.round(v.down_for_ms / 1000), why: v.why }) + '\n'); }
    catch { /* the console line is still the primary report */ }
  };
  // And a door out of this machine, chosen by the operator rather than invented here.
  const onAlert = arg('--on-alert', null);
  const runHook = (kind, v) => {
    if (!onAlert) return;
    try { spawn(onAlert, { shell: true, stdio: 'ignore', detached: true,
                           env: { ...process.env, M59_ALERT: kind, M59_FLEET: fleet,
                                  M59_DOWN_FOR_S: String(Math.round(v.down_for_ms / 1000)) } }).unref(); }
    catch { /* a hook that will not run must not stop the watch */ }
  };

  const ask = async () => {
    try {
      // THE PROBE TIMEOUT HAS TO BE LONGER THAN A HEALTHY BROKER'S WORST ANSWER.
      //
      // This was 8s, and it produced a false `unreachable` within an hour of being armed:
      // 2026-09-16T20:32:36Z it reported prod down, and 20:32:59Z reported it up again, with
      // the broker's pid unchanged at 15128 and 23 sessions throughout. Nothing had happened
      // — the event loop was simply busy.
      //
      // That is the documented normal here, not an anomaly. CLAUDE.md measures prod's
      // /health at 1046ms idle and 2573ms under load against 4ms for an idle broker, and
      // m59-service.mjs printed "took 7s to answer /health — its event loop is heavily
      // blocked" twice in this same session. An 8s cap against a 7s reality is a coin toss.
      //
      // Raising it costs nothing that matters: detection is bounded by the POLL interval and
      // the three-minute alert, not by this. A real outage answers instantly with
      // ECONNREFUSED — it does not sit and time out — so the slow path is almost always a
      // busy broker rather than a dead one, and treating those alike is what cried wolf.
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(20000) });
      return await r.json();
    } catch { return null; }
  };

  const once = async (prev) => {
    const v = verdict({ health: await ask(), roster, downSince: prev, alertMs, penaltyMs });
    writeSince(v.down_since, v.state);
    return v;
  };

  if (!has('--watch')) {
    const v = await once(readSince());
    console.log(`${fleet} on ${port}: ${describe(v)}`);
    if (!existsSync(roster)) console.log(`  note: no roster at ${roster} — is --fleet right?`);
    process.exit(v.state === 'unreachable' ? 2 : v.up ? 0 : (v.alert ? 1 : 0));
  }

  // WATCH SAYS SOMETHING ONLY WHEN THE ANSWER CHANGES, or when a threshold trips. A watcher
  // that prints every tick is one nobody reads, which is the same failure as no watcher.
  let last = null, saidAlert = false, saidPenalty = false, since = readSince();
  for (;;) {
    const v = await once(since);
    since = v.down_since;
    if (v.state !== last) { console.log(`[${new Date().toISOString()}] ${fleet}: ${describe(v)}`); last = v.state; }
    if (v.alert && !saidAlert) { console.log(`[${new Date().toISOString()}] ALERT: ${describe(v)}`);
      recordAlert('alert', v); runHook('alert', v); saidAlert = true; }
    if (v.penalty && !saidPenalty) { console.log(`[${new Date().toISOString()}] PENALTY LINE: ${describe(v)}`);
      recordAlert('penalty', v); runHook('penalty', v); saidPenalty = true; }
    if (v.up && (saidAlert || saidPenalty)) recordAlert('recovered', v);
    if (v.up) { saidAlert = false; saidPenalty = false; }
    await new Promise(r => setTimeout(r, Number(arg('--every-s', 20)) * 1000));
  }
}
