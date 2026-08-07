#!/usr/bin/env node
// THE BROKER'S LIFECYCLE, OWNED BY SOMETHING THAT IS NOT A CHAT SESSION.
//
//   node tools/m59-service.mjs start   [--fleet prod]
//   node tools/m59-service.mjs stop    [--fleet prod]
//   node tools/m59-service.mjs restart [--fleet prod]
//   node tools/m59-service.mjs status  [--fleet prod]
//   node tools/m59-service.mjs logs    [--fleet prod] [--lines 80] [--follow]
//
// A broker started by hand from a terminal — or by an agent from a shell — belongs to
// that terminal. This one was found running with its whole ancestry dead:
//
//     node.exe (broker)  <-  nohup.exe  <-  <dead>
//
// It survived only because Windows does not cascade-kill children. Nothing supervised
// it, nothing would have restarted it, and its log was being written into a
// session-scoped temp directory that gets cleaned up — so the one record of what it
// did was already gone.
//
// What this gives it instead: a pid file, a log that lives in substrate/ next to
// everything else the fleet writes, and start/stop/status that a person can run.
//
// PER FLEET, ALL OF IT. Two fleets are two brokers on two ports with two rosters, so
// they get two pid files and two logs. `--fleet` selects, exactly as it does for the
// broker itself; naming none manages the default fleet.
//
// It does NOT survive a reboot. That is deliberate — `start` is one command and the
// alternative was a Windows service, which would mean a third-party binary in a
// repository where every other tool is standalone .mjs with no dependencies.

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';
import * as uptime from './m59-uptime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);

const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

let FLEET;
try { FLEET = fleetName(argv); }
catch (e) { console.error(e.message); process.exit(2); }

const LABEL = FLEET || 'default';
const HTTP_PORT = Number(arg('--http', 8901));
const DASH_PORT = Number(arg('--dashboard', 8902));
const SUB = join(REPO, 'substrate');
// Named for the fleet so two of these never collide. Both are gitignored — the log by
// /substrate/*.log, the pid file because it is worthless to anyone else.
const PID_FILE = join(SUB, `broker-${LABEL}.pid`);
const LOG_FILE = join(SUB, `broker-${LABEL}.log`);

const c = process.stdout.isTTY
  ? { ok: s => `\x1b[32m${s}\x1b[0m`, bad: s => `\x1b[31m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` }
  : { ok: s => s, bad: s => s, dim: s => s };

// ---------------------------------------------------------------- identity

// ASK THE BROKER WHO IT IS. Never match on a process name.
//
// More than one checkout of this tooling can be running, and "a node process with
// m59-broker in its command line" is not an identity — treating it as one once killed
// a different repository's broker and logged out its entire fleet. /health reports the
// checkout it belongs to and the fleet it holds, and both have to match before this
// will signal anything.
// node:http, NOT fetch, and `agent: false` so no socket is pooled.
//
// This is a short-lived CLI that ends in process.exit(). Node's built-in fetch keeps
// its connections alive in a global pool afterwards, and exiting with one still open
// trips a libuv assertion on Windows — `!(handle->flags & UV_HANDLE_CLOSING)` — so
// every command that successfully reached the broker printed the right answer and then
// died with exit 127. The failure path exited cleanly, which is a good way to spend an
// afternoon wondering why only the working case is broken.
//
// `agent: false` gives each request its own socket, closed when the response ends.
// Nothing survives the call, so nothing is open at exit.
async function fetchJson(url, { timeoutMs = 2500, method = 'GET', headers = {}, body = null } = {}) {
  const u = new URL(url);
  return new Promise((resolve) => {
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method, headers: { ...headers, connection: 'close' }, agent: false, timeout: timeoutMs,
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', ch => { d += ch; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (body) req.write(body);
    req.end();
  });
}

async function health(port = HTTP_PORT, timeoutMs = 2500) {
  const j = await fetchJson(`http://127.0.0.1:${port}/health`, { timeoutMs });
  return j && j.ok ? j : null;
}

const sameRepo = (h) => {
  if (!h?.root) return false;
  // The broker derives its root from import.meta.url, whose pathname percent-encodes
  // spaces on Windows ("M59%20Bot"). REPO is a native filesystem path. Compare the
  // decoded forms so the service can recognize—and safely stop—its own broker.
  const norm = s => {
    let value = String(s);
    try { value = decodeURIComponent(value); } catch { /* keep malformed input literal */ }
    return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  };
  return norm(h.root) === norm(REPO);
};
const sameFleet = (h) => (h?.fleet || 'default') === LABEL;

// The pid to act on, or a reason not to act. Belt and braces: the pid file is a hint,
// /health is the authority, and they have to agree about the port at least.
async function findBroker() {
  const h = await health();
  if (!h) return { running: false };
  if (!sameRepo(h))
    return { running: true, foreign: true, why: `port ${HTTP_PORT} is held by a broker from ${h.root}` };
  if (!sameFleet(h))
    return { running: true, foreign: true, why: `port ${HTTP_PORT} is held by the "${h.fleet}" fleet, not "${LABEL}"` };
  return { running: true, pid: h.pid, health: h };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// THAT PROCESS, NOT ITS DESCENDANTS.
//
// `taskkill /T` kills the whole tree, and the restart button spawns THIS script from
// inside the broker — so the killer is one of the broker's descendants. With /T it
// killed itself halfway through, having already stopped the broker and not yet started
// the replacement, and the fleet stayed down. The button reported success on its way
// out, because the broker answered before dying.
//
// The broker spawns nothing it needs to take with it, so there is no tree worth
// killing: just the one pid, which is the one identified by /health.
function killPid(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
    return r.status === 0;
  }
  try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}

// ---------------------------------------------------------------- commands

async function cmdStart() {
  const found = await findBroker();
  if (found.foreign) { console.error(c.bad(found.why)); return 1; }
  if (found.running) {
    console.log(c.ok(`already up — pid ${found.pid}, fleet "${LABEL}", ` +
                     `${found.health.sessions?.length ?? 0} session(s)`));
    return 0;
  }
  mkdirSync(SUB, { recursive: true });
  // Append, never truncate: the log is the only account of what the last run did, and
  // a restart is exactly when you want to read it.
  const fd = openSync(LOG_FILE, 'a');
  const args = [join(HERE, 'm59-broker.mjs'), '--http', String(HTTP_PORT),
                '--dashboard', String(DASH_PORT)];
  if (FLEET) args.push('--fleet', FLEET);
  const env = { ...process.env };
  const child = spawn(process.execPath, args,
    // detached + unref is what makes this outlive the shell that ran it. stdio goes to
    // the log rather than 'ignore', which is how the previous arrangement lost every
    // word the broker said.
    { detached: true, stdio: ['ignore', fd, fd], cwd: REPO, env });
  child.unref();
  writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, fleet: LABEL, at: Date.now(),
                                           http: HTTP_PORT, dashboard: DASH_PORT }, null, 2));
  process.stdout.write(`starting broker for "${LABEL}" `);
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const h = await health();
    if (h) {
      console.log(c.ok('up'));
      console.log(`  pid        ${h.pid}`);
      console.log(`  rpc        http://127.0.0.1:${HTTP_PORT}`);
      console.log(`  dashboard  http://127.0.0.1:${DASH_PORT}/fleet`);
      console.log(`  log        ${LOG_FILE}`);
      return 0;
    }
    process.stdout.write('.');
  }
  console.log(c.bad('did not come up'));
  console.error(`  read ${LOG_FILE}, or run it in the foreground:`);
  console.error(`    node tools/m59-broker.mjs --http ${HTTP_PORT} --dashboard ${DASH_PORT}` +
                (FLEET ? ` --fleet ${FLEET}` : ''));
  return 1;
}

// IS AN ERRAND MID-FLIGHT?
//
// The errand tools (m59-feed, m59-rearm, m59-outfit) walk characters across the map with
// their keepers held, and every step is an HTTP call to this broker. Stopping it mid-walk
// kills the errand with `fetch failed` and leaves whatever it was carrying undelivered —
// four separate reagent and food runs were lost that way in one session, each one several
// minutes of walking, and every time it was me restarting to deploy something.
//
// Matched on the SCRIPT PATH under this checkout, not on the bare name: more than one
// clone of this tooling can be running, and a stranger's errand is none of our business.
function errandsRunning() {
  if (process.platform !== 'win32') return [];
  // WMIC IS GONE. The first version asked wmic, which Windows 11 no longer ships, so
  // spawnSync returned ENOENT, this returned an empty list, and the guard reported
  // "nothing running" while an errand was plainly mid-walk. A check that cannot fail
  // loudly is worse than no check at all, because it gets trusted.
  const ps = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | " +
             "ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }";
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
                      { encoding: 'utf8' });
  if (r.error || r.status !== 0 || !r.stdout) return [];
  // MATCHED ON THE SCRIPT NAME, AND DELIBERATELY NOT ON THE PATH.
  //
  // Matching the absolute path under this checkout is the more precise thing to want, and
  // it does not work: these are launched as `node tools/m59-feed.mjs`, so the command line
  // holds a RELATIVE path and the prefix never matched. The supervisor outside this
  // repository uses forward slashes in an absolute one, so even normalising separators
  // would not cover it.
  //
  // So this matches the tool name and accepts that another clone's errand would also stop
  // a restart here. That is the safe direction to be wrong in: the cost of a false
  // positive is typing --force, and the cost of a false negative is a killed errand and
  // several minutes of walking thrown away.
  const out = [];
  for (const line of r.stdout.split(String.fromCharCode(10))) {
    const low = line.toLowerCase();
    // One-shot errands only. m59-supervise.mjs runs continuously and is built to survive
    // a broker restart — it restarts stalled keepers afterwards — so counting it would
    // refuse every restart for ever, which is a guard that has to be disabled to work.
    //
    // ALMONER WAS MISSING FROM THIS LIST AND IS THE WORST OMISSION IT COULD HAVE HAD.
    // It was found running during a restart that this guard waved straight through: it
    // drives `supply`, a TWO-SIDED trade protocol between two characters the broker
    // holds, and its own header says a half-finished trade is silent. A killed walk
    // costs the walk; a killed trade can leave goods in an open offer slot with nothing
    // holding either end, and nothing reports it. The guard was written from the three
    // errands that existed when it was written and never revisited when a fourth
    // arrived — so the check that was meant to catch exactly this did not know about it.
    //
    // makefleet is here for the same reason and a worse failure: a character
    // interrupted mid-creation cannot be repaired, only re-rolled (see CLAUDE.md on
    // `create automated`).
    const m = /m59-(feed|rearm|outfit|almoner|makefleet)[.]mjs/.exec(low);
    if (!m) continue;
    const pid = Number((line.split('|')[0] || '').trim());
    out.push({ pid: Number.isFinite(pid) ? pid : null, tool: 'm59-' + m[1] + '.mjs' });
  }
  return out;
}

const FORCE = process.argv.includes('--force');

async function cmdStop({ quiet = false, force = false } = {}) {
  const busy = force ? [] : errandsRunning();
  if (busy.length) {
    console.error(c.bad(`${busy.length} errand(s) are mid-flight and talking to this broker:`));
    for (const b of busy) console.error(`    ${b.tool}${b.pid ? ` (pid ${b.pid})` : ''}`);
    console.error('  Stopping now kills them with "fetch failed" and leaves what they were');
    console.error('  carrying undelivered, with their walk wasted. Wait, or pass --force.');
    return 1;
  }
  const found = await findBroker();
  if (found.foreign) { console.error(c.bad(found.why)); return 1; }
  if (!found.running) {
    if (!quiet) console.log(`no broker for "${LABEL}" on ${HTTP_PORT}`);
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    return 0;
  }
  const n = found.health.sessions?.length ?? 0;
  if (!quiet) console.log(`stopping pid ${found.pid} ("${LABEL}", ${n} session(s))`);
  // SAY IT WAS DELIBERATE BEFORE KILLING IT.
  //
  // taskkill /F gives the broker no chance to run markStopped(), so the active-lock file
  // outlives it and the next boot reads a live lock with a dead pid — which is the exact
  // signature of a crash. Thirteen "crashes" were recorded in five hours on that basis
  // and every one of them was a restart somebody asked for, three of them mine.
  //
  // The outage itself is real and stays in the ledger: the keepers genuinely are down
  // between the kill and the resume, which is what death attribution needs. What was
  // wrong was the cause, and a cause of "crashed" sends the next person hunting a
  // stability bug that does not exist.
  uptime.markStopped();
  killPid(found.pid);
  for (let i = 0; i < 20; i++) {
    if (!alive(found.pid) && !(await health())) {
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
      if (!quiet) console.log(c.ok('stopped'));
      return 0;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.error(c.bad(`pid ${found.pid} did not stop`));
  return 1;
}

async function cmdStatus() {
  const h = await health();
  if (!h) {
    console.log(c.bad(`broker "${LABEL}"  DOWN`) + c.dim(`  (nothing answering on ${HTTP_PORT})`));
    if (existsSync(PID_FILE)) {
      const p = JSON.parse(readFileSync(PID_FILE, 'utf8'));
      console.log(c.dim(`  last started pid ${p.pid} at ${new Date(p.at).toLocaleString()}`));
    }
    if (existsSync(LOG_FILE)) console.log(c.dim(`  log ${LOG_FILE}`));
    console.log(`  start it:  node tools/m59-service.mjs start${FLEET ? ' --fleet ' + FLEET : ''}`);
    return 1;
  }
  if (!sameRepo(h) || !sameFleet(h)) {
    console.log(c.bad('PORT HELD BY SOMEONE ELSE'));
    console.log(`  ${HTTP_PORT} answers for fleet "${h.fleet}" from ${h.root}`);
    console.log(c.dim('  not signalling it — that is how another repository\'s fleet gets logged out'));
    return 1;
  }
  // How many are actually playing, which is the question status is really asked for.
  let inGame = null, agents = h.sessions?.length ?? 0;
  try {
    const j = await fetchJson(`http://127.0.0.1:${HTTP_PORT}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, timeoutMs: 20000,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name: 'fleet', arguments: {} } }) });
    const f = JSON.parse(j.result.content[0].text);
    agents = f.agents ?? agents;
    inGame = agents - (f.stalled_count ?? 0);
  } catch { /* the broker is up; the fleet call is a nicety */ }
  console.log(c.ok(`broker "${LABEL}"  UP`) + `  pid ${h.pid}`);
  console.log(`  rpc        http://127.0.0.1:${HTTP_PORT}`);
  console.log(`  dashboard  http://127.0.0.1:${DASH_PORT}/fleet`);
  console.log(`  roster     ${h.state}`);
  console.log(`  characters ${inGame == null ? agents + ' registered' : `${inGame}/${agents} in game`}`);
  console.log(`  log        ${existsSync(LOG_FILE) ? LOG_FILE : '(none yet)'}`);
  if (inGame != null && agents && inGame < agents)
    console.log(c.bad(`  ${agents - inGame} character(s) are not in game`) +
                c.dim(' — the broker rejoins them on its own; watch the log'));
  return 0;
}

function cmdLogs() {
  if (!existsSync(LOG_FILE)) { console.error(`no log at ${LOG_FILE}`); return 1; }
  const lines = Number(arg('--lines', 80));
  const show = () => readFileSync(LOG_FILE, 'utf8').split('\n').slice(-lines).join('\n');
  console.log(show());
  if (!has('--follow')) return 0;
  let size = statSync(LOG_FILE).size;
  setInterval(() => {
    try {
      const s = statSync(LOG_FILE).size;
      if (s > size) {
        const buf = readFileSync(LOG_FILE, 'utf8');
        process.stdout.write(buf.slice(buf.length - (s - size)));
        size = s;
      } else if (s < size) size = s;          // rotated or truncated under us
    } catch { /* keep waiting */ }
  }, 1000);
  return null;                                 // follow never returns
}

// ---------------------------------------------------------------- main

const cmd = argv.find(a => !a.startsWith('-')) || 'status';
let code = 0;
switch (cmd) {
  case 'start':   code = await cmdStart(); break;
  case 'stop':    code = await cmdStop({ force: FORCE }); break;
  case 'restart': {
    // A refused stop must abort the restart. Falling through to cmdStart() would find the
    // broker still up, print "already up", and exit 0 — reporting success for a restart
    // that did not happen.
    const st = await cmdStop({ quiet: false, force: FORCE });
    code = st === 0 ? await cmdStart() : st;
    break;
  }
  case 'status':  code = await cmdStatus(); break;
  case 'logs':    code = cmdLogs(); break;
  default:
    console.error(`unknown command "${cmd}"`);
    console.error('usage: m59-service.mjs start|stop|restart|status|logs [--fleet <name>]');
    code = 2;
}
if (code !== null) process.exit(code);
