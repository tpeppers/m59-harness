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
import { openSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, statSync,
         readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName, lockFileFor } from './m59-fleetpath.mjs';
import * as uptime from './m59-uptime.mjs';
import * as webui from './m59-webui.mjs';
import { movementMapFile } from './m59-map-path.mjs';
import { loadMap, movementMapReadiness } from './m59-map.mjs';

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
// The GOAP supervisor (m59-goap.mjs) is a second, smaller service on the same
// machine: a 60-second planning loop over the broker's HTTP port. It holds no
// sessions and takes no lock, so it has nothing to collide with the broker over —
// but it dies exactly the same death a hand-started terminal process does, so it
// gets the same treatment: a pid file, a log in substrate/, and start/stop.
// Per fleet too: the loop is scoped to one broker, and two fleets are two brokers.
const GOAP_PID = join(SUB, `goap-${LABEL}.pid`);
const GOAP_LOG = join(SUB, `goap-${LABEL}.log`);

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

// A BROKER TOO BUSY TO ANSWER IN 2.5s IS THE ONE YOU MOST NEED TO STOP.
//
// This probed once, for 2500ms, and treated silence as "not ours" — so `stop` refused to
// stop the exact broker whose wedged event loop was the reason for stopping it. Measured on
// prod: `/health` answered correctly, with the right fleet, roster and root, after 45
// SECONDS. The refusal said "not answering on 8901", which reads as a dead port and is
// nothing of the kind.
//
// This is the same trap `m59-which.mjs` was fixed for and this file never was. CLAUDE.md
// states it plainly: prod's /health was 1046ms idle and 2573ms under load against 4ms for
// an idle broker, so a 2500ms probe sat ON the documented under-load figure — the busiest
// broker is the one most likely to be missed, and it is always the one that matters.
//
// Fast probe first, so an idle broker still answers in milliseconds and nothing gets slower
// in the common case. Only on silence does it ask again with real patience, because at that
// point the question has changed from "who is there" to "is anyone there at all", and that
// answer is worth waiting for. M59_HEALTH_TIMEOUT_MS overrides the patient one.
const HEALTH_PATIENT_MS = Number(process.env.M59_HEALTH_TIMEOUT_MS || 60000);

async function health(port = HTTP_PORT, timeoutMs = 2500) {
  const quick = await fetchJson(`http://127.0.0.1:${port}/health`, { timeoutMs });
  if (quick && quick.ok) return quick;
  if (HEALTH_PATIENT_MS <= timeoutMs) return null;
  const began = Date.now();
  const slow = await fetchJson(`http://127.0.0.1:${port}/health`, { timeoutMs: HEALTH_PATIENT_MS });
  if (slow && slow.ok) {
    // SAID OUT LOUD, because a broker that needs this long is not healthy even though it
    // answered, and the number is the only warning anybody gets before it stops answering.
    console.error(`  note: the broker on ${port} took ${Math.round((Date.now() - began) / 1000)}s ` +
                  `to answer /health — its event loop is heavily blocked`);
    return slow;
  }
  return null;
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
// THE ROSTER LOCK IS THE AUTHORITY ON WHO HOLDS THE FLEET, AND IT DOES NOT CARE ABOUT PORTS.
//
// `health()` asks one port -- 8901 unless told otherwise -- and a broker started by hand on
// any other port is invisible to it. `start` then concludes nothing is running and starts a
// SECOND broker on the fleet, which is the failure CLAUDE.md is most emphatic about: the
// second is refused the lock, comes up healthy and EMPTY, and answers every question about a
// fleet of nobody while the real one plays on. Measured here, and not hypothetically:
//
//     no broker for "shadow" on 8901
//     starting broker for "shadow" .up   pid 28792   rpc http://127.0.0.1:8901
//
// while pid 16216 sat on 8971 holding all 21 characters.
//
// The answer was on disk the whole time. `m59-broker.mjs` writes the pid that owns a fleet
// into a lock named after the roster it guards, so this reads that first and only then goes
// looking for a port to talk to it on -- the default, then every port a broker pid file
// names, the way m59-fleets.mjs and m59-which.mjs do. A lock whose pid is dead is a stale
// lock and means nothing, which is what `alive` is for.
function lockHolder() {
  try {
    const rec = JSON.parse(readFileSync(lockFileFor(FLEET), 'utf8'));
    const pid = Number(rec?.pid);
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
  } catch { return null; }        // no lock, or one we cannot read, is not a claim
}

function candidatePorts() {
  const ports = [HTTP_PORT];
  try {
    for (const f of readdirSync(SUB)) {
      if (!/^broker-.+\.pid$/.test(f)) continue;
      try {
        const port = Number(JSON.parse(readFileSync(join(SUB, f), 'utf8'))?.http);
        if (Number.isInteger(port) && port > 0 && port < 65536) ports.push(port);
      } catch { /* an unreadable pid file is only a lost hint */ }
    }
  } catch { /* no substrate directory */ }
  return [...new Set(ports)];
}

async function findBroker() {
  const h = await health();
  if (!h) {
    // Nothing on our port. Before concluding the fleet is free, ask the lock.
    const held = lockHolder();
    if (held) {
      for (const port of candidatePorts()) {
        if (port === HTTP_PORT) continue;
        // PATIENT ON PURPOSE. The default probe is 2.5s, and a broker mid-rejoin with
        // twenty-one characters in game genuinely takes longer than that to answer. One did,
        // and this path then reported the fleet held by a pid it could not reach and refused
        // a restart that was perfectly safe. Refusing is the right direction to fail in, but
        // failing there for a slow answer is a bug rather than caution.
        const other = await health(port, 15000);
        if (other && Number(other.pid) === held)
          return { running: true, pid: held, port, health: other, elsewhere: true };
      }
      // Held by a live pid we cannot reach. Refusing is still right: starting a second
      // broker would take no sessions and answer for a fleet of nobody.
      return { running: true, foreign: true, pid: held,
               why: `the roster lock for "${LABEL}" is held by live pid ${held}, which is not `
                  + `answering on ${candidatePorts().join(', ')}. Stop that broker before `
                  + `starting another, or delete the lock only if that pid is genuinely gone.` };
    }
    return { running: false };
  }
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
    console.log(c.ok(`already up — pid ${found.pid}` +
                     (found.elsewhere ? ` on ${found.port}` : '') + `, fleet "${LABEL}", ` +
                     `${found.health.sessions?.length ?? 0} session(s)`));
    // AND STILL CHECK THE PAGE. "The broker is up" and "everything is up" are different
    // answers, and returning the first for the second is how `start` becomes a command
    // that silently does nothing about the half that is actually down.
    if (!has('--no-ui')) {
      const r = await webui.start({ log: (m) => console.log(c.dim(`  field cmd  ${m}`)) });
      if (r.ok) console.log(`  field cmd  http://127.0.0.1:${r.port}`);
    }
    return 0;
  }
  // THE COLLISION MAP IS CHECKED HERE, AND A STALE ONE IS A WARNING RATHER THAN A REFUSAL.
  //
  // This gate used to `return 1` — no broker at all — and that is the wrong trade for a
  // reason worth writing down, because the instinct behind it is a good one.
  //
  // THE PER-MOVE VALIDATOR ALREADY FAILS CLOSED, PER ROOM. `m59-broker.mjs` refuses any
  // move whose room has no baked geometry, whose geometry changed live, or whose security
  // value does not match what the server announced — `collision_geometry_unavailable`,
  // `room_geometry_mismatch` and friends are terminal and never retried. So the safety
  // property this gate was protecting is enforced one room at a time, at the moment it
  // matters, against the server's own answer.
  //
  // What refusing to start adds is not safety, it is BLAST RADIUS. A map that has drifted
  // in four rooms costs four rooms; refusing to start costs twenty-one characters, every
  // room, and everything that is not movement — fighting, resting, banking, being visible
  // on the board at all.
  //
  // AND PROD IS SOMEBODY ELSE'S SERVER. It can be patched on a Tuesday without telling us,
  // which is precisely when the baked map goes stale — so a gate like this converts
  // somebody else's routine update into our total outage, at the exact moment we would
  // most want the fleet up to find out what changed. The map is baked from a local source
  // tree; it is evidence about the server, never authority over it.
  //
  // `--require-map` (or M59_REQUIRE_MAP=1) restores the refusal for anyone who wants a
  // machine that will not run a fleet it cannot fully validate. Opt in, because the
  // failure it prevents is smaller than the one it causes.
  const mapFile = movementMapFile();
  let mapStatus = null;
  try { mapStatus = movementMapReadiness(loadMap(mapFile)); } catch { /* reported below */ }
  const strictMap = has('--require-map') || process.env.M59_REQUIRE_MAP === '1';
  if (!mapStatus?.ok) {
    const line = mapStatus
      ? `${mapStatus.ready}/${mapStatus.total} rooms ready; ` +
        `manifest ${mapStatus.manifest_matches ? 'matches' : 'does not match'}`
      : 'the map could not be read at all';
    if (strictMap) {
      console.error(c.bad('broker not started: its collision map is missing, corrupt, or obsolete'));
      console.error(`  ${line}`);
      console.error('  run node tools/setup.mjs server, or set M59_MAP to a validated server-matched map');
      console.error('  (this refusal is --require-map; without it the broker starts and movement');
      console.error('   fails closed only in the rooms that actually mismatch)');
      return 1;
    }
    console.log(c.bad('COLLISION MAP IS NOT FULLY VALID') + c.dim(` — ${line}`));
    console.log(c.dim('  starting anyway: movement fails closed per room, so this costs the rooms'));
    console.log(c.dim('  that drifted and not the fleet. Refresh with node tools/setup.mjs server,'));
    console.log(c.dim('  or pass --require-map to make this a refusal.'));
  }
  mkdirSync(SUB, { recursive: true });
  // Append, never truncate: the log is the only account of what the last run did, and
  // a restart is exactly when you want to read it.
  const fd = openSync(LOG_FILE, 'a');
  const args = [join(HERE, 'm59-broker.mjs'), '--http', String(HTTP_PORT),
                '--dashboard', String(DASH_PORT)];
  if (FLEET) args.push('--fleet', FLEET);
  // WHICH KEEPER ARRANGEMENT, PASSED THROUGH RATHER THAN ASSUMED.
  //
  // The broker runs one keeper PROCESS per character by default, which is what took the
  // event loop's p99 from 500ms to 17ms. `--in-process` puts them back inside the broker.
  // That is not merely a preference yet: the keeper proxy is incomplete — the keeper serves
  // /health and /state but has no /action, and the proxy's `world` is a cached snapshot
  // rather than a World — so a broker tool that drives a character (`travel` is the one that
  // bites) fails with `s.world.route is not a function`. Until that is finished, a COMMANDED
  // fleet needs this flag and a self-driving one does not.
  if (process.argv.includes('--in-process')) args.push('--in-process');
  // Setup's server-matched local map remains authoritative across ordinary service
  // restarts. An explicit M59_MAP still wins; otherwise selection is local-then-reference.
  const env = { ...process.env, M59_MAP: mapFile };
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
      // AND THE PAGE, IF IT IS HERE. Started AFTER the broker answers, because it exists
      // only to talk to one and a page that comes up first spends its first seconds
      // reporting a fleet that is not there yet.
      //
      // NEVER FATAL. This function's contract is "the fleet is up", and it already is by
      // the time we get here — twenty-one sessions do not depend on a web server. So an
      // absent sibling, an uninstalled one and a failed build are all REPORTED and the
      // exit code stays 0. `--no-ui` skips it entirely.
      if (!has('--no-ui')) {
        const r = await webui.start({ log: (m) => console.log(c.dim(`  field cmd  ${m}`)) });
        if (r.ok) console.log(`  field cmd  http://127.0.0.1:${r.port}`);
      }
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
  // THE PAGE GOES FIRST, and it goes even when the broker is already down. It is a view
  // of a broker; leaving it running after one is stopped leaves a control surface whose
  // every button fails, which reads as the fleet being broken rather than absent. Only
  // ever stops what this checkout started — see m59-webui.mjs.
  if (!has('--no-ui')) {
    const r = await webui.stop({ log: (m) => { if (!quiet) console.log(c.dim(`  field cmd  ${m}`)); } });
    if (r.stopped && !quiet) console.log(c.dim(`  field cmd  stopped pid ${r.stopped}`));
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
    // DOWN ON THIS PORT IS NOT DOWN. Same trap as `start`, and worse here, because a person
    // reads this line and decides what to do next: it once said DOWN while pid 16216 sat on
    // 8971 with all 21 characters in game. The lock names whoever holds the roster.
    const held = lockHolder();
    if (held) {
      for (const port of candidatePorts()) {
        if (port === HTTP_PORT) continue;
        // PATIENT ON PURPOSE. The default probe is 2.5s, and a broker mid-rejoin with
        // twenty-one characters in game genuinely takes longer than that to answer. One did,
        // and this path then reported the fleet held by a pid it could not reach and refused
        // a restart that was perfectly safe. Refusing is the right direction to fail in, but
        // failing there for a slow answer is a bug rather than caution.
        const other = await health(port, 15000);
        if (other && Number(other.pid) === held) {
          console.log(c.ok(`broker "${LABEL}"  UP`) +
                      c.dim(`  pid ${held} on ${port} — not ${HTTP_PORT}, which is why this said DOWN`));
          console.log(c.dim(`  ${other.sessions?.length ?? 0} session(s); ask it directly: ` +
                            `node tools/m59-service.mjs status --fleet ${LABEL} --http ${port}`));
          return 0;
        }
      }
      console.log(c.bad(`broker "${LABEL}"  HELD`) +
                  c.dim(`  the roster lock names live pid ${held}, not answering on ` +
                        `${candidatePorts().join(', ')}`));
      console.log(c.dim('  that pid owns this fleet; find its port before starting anything'));
      return 1;
    }
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
  let inGame = null, stalled = 0, agents = h.sessions?.length ?? 0, orphans = [];
  try {
    const j = await fetchJson(`http://127.0.0.1:${HTTP_PORT}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, timeoutMs: 20000,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name: 'fleet', arguments: {} } }) });
    const f = JSON.parse(j.result.content[0].text);
    agents = f.agents ?? agents;
    // NOT "IN GAME". This is agents MINUS the ones the stall detector has flagged, and a
    // flagged character is nearly always logged in and busy: `ms_since_moved` measures the
    // KEEPER, so it climbs right through a multi-minute travel and through any errand that
    // holds the keeper inert by design.
    //
    // Labelled "in game" it read as five characters having fallen out of the world, which
    // is the one thing it does not mean — checked at the moment this was written: 21
    // sessions, 0 reporting `in_game: false`, and the five "missing" were two travelling
    // and three hunting. A number under a wrong name sends you looking for a fault that
    // is not there, which is expensive at exactly the moment status is being read.
    stalled = f.stalled_count ?? 0;
    // ONLY ROSTER ROWS ARE COUNTED, BECAUSE ONLY ROSTER ROWS CAN BE REJOINED.
    //
    // The remediation printed below — "the broker rejoins them on its own" — is a claim
    // about the 45s sweep, and that sweep iterates the ROSTER. A session with no roster
    // entry is outside its jurisdiction by construction, so counting it as a dropped
    // character told the operator to wait for a recovery that cannot happen. One mistyped
    // agent name used to produce exactly that, for the life of the broker process.
    //
    // `in_roster` is undefined on a broker predating it: fail OPEN and count the row, so
    // an older broker reads exactly as it did before rather than reporting an empty fleet.
    const rows = f.fleet ?? [];
    orphans = rows.filter(r => r.in_roster === false).map(r => r.agent);
    const mine = rows.filter(r => r.in_roster !== false);
    agents = mine.length || agents;
    inGame = mine.filter(r => r.in_game !== false).length || null;
  } catch { /* the broker is up; the fleet call is a nicety */ }
  console.log(c.ok(`broker "${LABEL}"  UP`) + `  pid ${h.pid}`);
  console.log(`  rpc        http://127.0.0.1:${HTTP_PORT}`);
  console.log(`  dashboard  http://127.0.0.1:${DASH_PORT}/fleet`);
  console.log(`  roster     ${h.state}`);
  console.log(`  characters ${inGame == null ? agents + ' registered' : `${inGame}/${agents} in game`}` +
              (stalled ? c.dim(`  ·  ${stalled} flagged by the stall detector` +
                               ` (a travelling character trips it — see ms_since_moved)`) : ''));
  console.log(`  log        ${existsSync(LOG_FILE) ? LOG_FILE : '(none yet)'}`);
  // HAS PROD MOVED UNDER US? The baked collision map is evidence about somebody else's
  // server, and that server can be patched without telling us. Every room where the live
  // security value disagreed with the bake is listed here, so "they changed a room" is a
  // named condition on the status line rather than a character that mysteriously will not
  // walk. Silence means no room has disagreed — which is the ordinary answer.
  const drift = Array.isArray(h.geometry_drift) ? h.geometry_drift : [];
  if (drift.length)
    console.log(c.bad(`  geometry  ${drift.length} room(s) DRIFTED from the baked map`) +
                c.dim(` — ${drift.slice(0, 6).map(d => d.room).join(', ')}` +
                      `${drift.length > 6 ? ' …' : ''}; movement fails closed in those rooms.`) +
                c.dim(' Refresh: node tools/setup.mjs server'));
  const ui = await webui.status();
  console.log(`  field cmd  ${ui.absent ? c.dim('absent — maps/m59-strategy-game is not beside this checkout')
    : ui.running ? (ui.ours ? `http://127.0.0.1:${ui.port}  pid ${ui.pid}`
                            : c.dim(`http://127.0.0.1:${ui.port} — up, but this checkout did not start it`))
    : !ui.installed ? c.dim('not installed — node tools/m59-webui.mjs install')
    : c.dim(`down — node tools/m59-webui.mjs start`)}`);
  if (inGame != null && agents && inGame < agents)
    console.log(c.bad(`  ${agents - inGame} character(s) are not in game`) +
                c.dim(' — the broker rejoins them on its own; watch the log'));
  // A DIFFERENT FAULT WITH A DIFFERENT REMEDY, so it gets its own line rather than being
  // folded into the count above. Nothing will rejoin these; they go away on a restart.
  if (orphans.length)
    console.log(c.bad(`  ${orphans.length} session(s) are not roster characters`) +
                c.dim(` — ${orphans.slice(0, 6).join(', ')}${orphans.length > 6 ? ' …' : ''};` +
                      ' the rejoin sweep iterates the roster and cannot see these.' +
                      ' Usually a mistyped agent name; they clear on a broker restart.'));
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

// ---------------------------------------------------------------- goap service

// The goap process owns its own pid file (it removes it on clean exit), so
// identity is the pid file plus a process liveness check — the same belt and
// braces as the broker, minus a /health endpoint it does not have.
async function findGoap() {
  if (!existsSync(GOAP_PID)) return { running: false };
  try {
    const { pid } = JSON.parse(readFileSync(GOAP_PID, 'utf8'));
    return alive(pid) ? { running: true, pid } : { running: false, stale: pid };
  } catch { return { running: false, stale: true }; }
}

async function cmdGoapStart() {
  const found = await findGoap();
  if (found.running) { console.log(c.ok(`goap already up — pid ${found.pid}`)); return 0; }
  if (found.stale) console.log(c.dim(`  (removed stale pid ${found.stale} — the process is gone)`));
  mkdirSync(SUB, { recursive: true });
  const fd = openSync(GOAP_LOG, 'a');
  const child = spawn(process.execPath, [join(HERE, 'm59-goap.mjs')],
    { detached: true, stdio: ['ignore', fd, fd], cwd: REPO, env: { ...process.env } });
  child.unref();
  // The goap writes its own pid file from within; wait for it rather than trusting
  // the spawn-time pid, which can be re-used before the child starts.
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    const f = await findGoap();
    if (f.running && f.pid !== child.pid) break;
    if (f.running) { f.pid = child.pid; break; }
  }
  // A second live goap means THIS child refused to take the lock and exited — the
  // other one is who is serving, and saying "up" about this dead child would be a lie.
  const final = await findGoap();
  if (final.running && final.pid !== child.pid) {
    console.log(c.ok(`already up — pid ${final.pid} took the lock; this child exited`));
    console.log(`  log ${GOAP_LOG}`);
    return 0;
  }
  if (!final.running) {
    console.log(c.bad('did not come up'));
    console.error(`  read ${GOAP_LOG}`);
    return 1;
  }
  console.log(c.ok(`goap up — pid ${child.pid}, fleet "${LABEL}"`));
  console.log(`  log ${GOAP_LOG}`);
  return 0;
  console.log(c.bad('did not come up'));
  console.error(`  read ${GOAP_LOG}`);
  return 1;
}

async function cmdGoapStop() {
  const found = await findGoap();
  if (!found.running) {
    console.log(`no goap for "${LABEL}"`);
    if (existsSync(GOAP_PID)) unlinkSync(GOAP_PID);
    return 0;
  }
  console.log(`stopping goap pid ${found.pid} ("${LABEL}")`);
  killPid(found.pid);
  for (let i = 0; i < 20; i++) {
    if (!alive(found.pid)) {
      if (existsSync(GOAP_PID)) unlinkSync(GOAP_PID);
      console.log(c.ok('stopped'));
      return 0;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  console.error(c.bad(`pid ${found.pid} did not stop`));
  return 1;
}

async function cmdGoapStatus() {
  const found = await findGoap();
  if (!found.running) {
    console.log(c.bad(`goap "${LABEL}"  DOWN`));
    if (existsSync(GOAP_LOG)) console.log(c.dim(`  log ${GOAP_LOG}`));
    console.log(`  start it:  node tools/m59-service.mjs goap start${FLEET ? ' --fleet ' + FLEET : ''}`);
    return 1;
  }
  console.log(c.ok(`goap "${LABEL}"  UP`) + `  pid ${found.pid}`);
  console.log(`  log   ${existsSync(GOAP_LOG) ? GOAP_LOG : '(none yet)'}`);
  return 0;
}

function cmdGoapLogs() {
  if (!existsSync(GOAP_LOG)) { console.error(`no log at ${GOAP_LOG}`); return 1; }
  const lines = Number(arg('--lines', 80));
  console.log(readFileSync(GOAP_LOG, 'utf8').split('\n').slice(-lines).join('\n'));
  return has('--follow') ? cmdLogs() : 0;
}

// ---------------------------------------------------------------- main

const sub = argv.find(a => !a.startsWith('-'));
const goapMode = sub === 'goap';
const cmd = goapMode
  ? (argv.find(a => a !== 'goap' && !a.startsWith('-')) || 'status')
  : (sub || 'status');
let code = 0;
if (goapMode) {
  switch (cmd) {
    case 'start':   code = await cmdGoapStart(); break;
    case 'stop':    code = await cmdGoapStop(); break;
    case 'restart': {
      const st = await cmdGoapStop();
      code = st === 0 ? await cmdGoapStart() : st;
      break;
    }
    case 'status':  code = await cmdGoapStatus(); break;
    case 'logs':    code = cmdGoapLogs(); break;
    default:
      console.error(`unknown goap command "${cmd}"`);
      console.error('usage: m59-service.mjs goap start|stop|restart|status|logs [--fleet <name>]');
      code = 2;
  }
} else switch (cmd) {
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
