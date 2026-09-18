#!/usr/bin/env node
// THE FIELD COMMAND PAGE, STARTED AND STOPPED WITH THE BROKER.
//
//   node tools/m59-webui.mjs status
//   node tools/m59-webui.mjs install     # npm install, once
//   node tools/m59-webui.mjs start
//   node tools/m59-webui.mjs stop
//
// `maps/m59-strategy-game` is a browser command surface for a fleet this broker already
// owns: it holds no credentials, starts no broker of its own, and turns a small set of
// game-shaped orders into ordinary broker tool calls. It is only useful while a broker is
// up, and it is useless on its own — so `m59-service.mjs` starts it alongside one and
// stops it with one, and this module is where that lives.
//
// IT IS A SEPARATE REPOSITORY AND IT MAY NOT BE HERE, which is the whole reason this is a
// module with an `absent` answer rather than three lines inside the service tool. The
// harness has to keep working for somebody who cloned it on its own, so every function
// below reports what is missing rather than depending on it — the same arrangement the
// terminal's `B` key has with `maps/m59-boswars`. `M59_STRATEGY_DIR` names it when it does
// not live beside us.
//
// ---------------------------------------------------------------------------
// WHAT THIS DELIBERATELY DOES NOT DO
//
//   * IT NEVER BLOCKS THE BROKER. The broker is the thing holding twenty-one
//     irreplaceable sessions; a web page failing to build is not a reason for the fleet
//     not to come up. `start` here is best-effort and says so, and the service tool
//     reports its failure without failing.
//   * IT NEVER CHANGES THE BIND ADDRESS. The app pins itself to 127.0.0.1 on purpose —
//     it is a control plane, not a dashboard, and its own worker refuses non-loopback
//     hosts. Nothing here passes a hostname, so nothing here can widen that by accident.
//   * IT NEVER STOPS SOMETHING IT DID NOT START. The pid file is the authority for
//     stopping. A port that answers with no pid file of ours is reported as somebody
//     else's and left alone — the same rule the broker's own service follows, and for
//     the same reason: more than one checkout of this tooling can be running.

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SUB = join(REPO, 'substrate');

export const STRATEGY_DIR = process.env.M59_STRATEGY_DIR ||
  join(REPO, '..', 'm59-strategy-game');
export const UI_PORT = Number(process.env.M59_STRATEGY_PORT || 3000);

const PID_FILE = join(SUB, 'webui.pid');
const LOG_FILE = join(SUB, 'webui.log');

// The page's own <title>. Enough to tell "our app is here" from "something else has
// 3000", which is the only distinction the port alone can make — and a good deal better
// than assuming. It is NOT enough to tell OUR checkout's copy from another one's, which
// is why nothing is ever killed on the strength of it.
const TITLE = 'M59 Field Command';

/** Is the sibling checkout here, and has it been installed? */
export function state() {
  const dir = STRATEGY_DIR;
  if (!existsSync(join(dir, 'package.json')))
    return { absent: true, dir,
      why: `no package.json at ${dir} — m59-strategy-game is its own repository ` +
           `(maps/m59-strategy-game); set M59_STRATEGY_DIR if it lives elsewhere` };
  return { absent: false, dir, installed: existsSync(join(dir, 'node_modules')) };
}

// A ONE-SHOT GET THAT ALWAYS SETTLES, and the first version did not.
//
// It capped the body by calling `req.destroy()` past 4KB — and a destroyed request emits
// no `end`, so the promise it was holding never resolved and never rejected. The caller
// awaited it for ever. Node says so on exit if it happens to be the last thing running
// ("Detected unsettled top-level await") and says NOTHING at all if it does not, which is
// how a status line quietly stops printing.
//
// So the cap stops APPENDING rather than stopping the request — the page is a few KB and
// reading the rest of it costs nothing — and there is a hard timer underneath everything,
// because `req.on('timeout')` only covers socket inactivity and not a server that dribbles
// bytes for ever.
function get(path = '/', timeoutMs = 2000) {
  return new Promise((res) => {
    let done = false;
    const settle = (v) => { if (!done) { done = true; clearTimeout(hard); res(v); } };
    const hard = setTimeout(() => { try { req.destroy(); } catch { /* already gone */ } settle(null); },
                            timeoutMs + 500);
    const req = http.request({ hostname: '127.0.0.1', port: UI_PORT, path, method: 'GET',
                               agent: false, timeout: timeoutMs,
                               headers: { connection: 'close' } }, (r) => {
      let d = '';
      r.setEncoding('utf8');
      r.on('data', ch => { if (d.length < 65536) d += ch; });
      r.on('end', () => settle({ status: r.statusCode, body: d }));
      r.on('error', () => settle(null));
      r.on('aborted', () => settle(null));
    });
    req.on('timeout', () => { req.destroy(); settle(null); });
    req.on('error', () => settle(null));
    req.on('close', () => settle(null));      // the backstop: nothing can leave it pending
    req.end();
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function readPid() {
  try {
    const j = JSON.parse(readFileSync(PID_FILE, 'utf8'));
    return (j && Number.isFinite(j.pid) && alive(j.pid)) ? j : null;
  } catch { return null; }
}

/** Up, down, or somebody else's. */
export async function status() {
  const s = state();
  const ours = readPid();
  const served = await get('/');
  const isApp = !!served && typeof served.body === 'string' && served.body.includes(TITLE);
  if (ours && isApp) return { ...s, running: true, ours: true, pid: ours.pid, port: UI_PORT };
  if (isApp) return { ...s, running: true, ours: false, port: UI_PORT,
    why: `something is serving ${TITLE} on ${UI_PORT} and this checkout did not start it` };
  if (served) return { ...s, running: false, blocked: true, port: UI_PORT,
    why: `port ${UI_PORT} is answering and it is not ${TITLE}` };
  return { ...s, running: false, port: UI_PORT };
}

/** `npm install`, run in the sibling. Synchronous and slow; only setup calls it. */
export function install({ log = console.error } = {}) {
  const s = state();
  if (s.absent) { log(s.why); return { ok: false, ...s }; }
  log(`installing ${s.dir} …`);
  const r = spawnSync('npm', ['install'], { windowsHide: true, cwd: s.dir, stdio: 'inherit', shell: process.platform === 'win32' });
  const ok = !r.error && r.status === 0;
  if (!ok) log(`npm install failed in ${s.dir}${r.error ? ` — ${r.error.message}` : ` (exit ${r.status})`}`);
  return { ok, ...state() };
}

/**
 * Start it, detached, logging into substrate/ beside everything else.
 *
 * BEST EFFORT, ALWAYS. Every failure here returns rather than throws, because the only
 * caller that matters is the one bringing a fleet up.
 */
export async function start({ log = console.error, waitMs = 60_000 } = {}) {
  const now = await status();
  if (now.absent) { log(now.why); return { ok: false, ...now }; }
  if (now.running && now.ours) { log(`field command already up on ${UI_PORT} (pid ${now.pid})`); return { ok: true, ...now }; }
  if (now.running) { log(now.why); return { ok: false, ...now }; }
  if (now.blocked) { log(now.why); return { ok: false, ...now }; }
  if (!now.installed) {
    // NOT INSTALLED IS NOT BROKEN, and it is not this function's job to spend two minutes
    // on npm while a fleet waits to come up. Say the one command that fixes it.
    log(`field command is not installed — run: node tools/m59-webui.mjs install`);
    return { ok: false, ...now, why: 'node_modules is absent' };
  }

  mkdirSync(SUB, { recursive: true });
  const fd = openSync(LOG_FILE, 'a');
  // `npm run dev` and not a bare vite/next binary: the sibling's own predev step is what
  // refreshes its generated world and room maps out of this harness, and skipping it
  // serves a map of whatever the harness looked like whenever somebody last built.
  const args = ['run', 'dev'];
  if (UI_PORT !== 3000) args.push('--', '--port', String(UI_PORT));
  const child = spawn('npm', args, { windowsHide: true,
    cwd: STRATEGY_DIR, detached: true, stdio: ['ignore', fd, fd],
    shell: process.platform === 'win32',
    env: { ...process.env, M59_BROKER_URL: process.env.M59_BROKER_URL || 'http://127.0.0.1:8901' },
  });
  child.unref();
  writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port: UI_PORT, at: Date.now(),
                                           dir: resolve(STRATEGY_DIR) }, null, 2));

  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 1000));
    const r = await get('/');
    if (r && typeof r.body === 'string' && r.body.includes(TITLE))
      return { ok: true, running: true, ours: true, pid: child.pid, port: UI_PORT, log: LOG_FILE };
    if (!alive(child.pid)) break;
  }
  log(`field command did not answer on ${UI_PORT} — read ${LOG_FILE}`);
  return { ok: false, running: false, port: UI_PORT, log: LOG_FILE };
}

/** Stop only what we started. */
export async function stop({ log = console.error } = {}) {
  const ours = readPid();
  if (!ours) {
    const now = await status();
    if (now.running && !now.ours) { log(now.why); return { ok: false, ...now }; }
    return { ok: true, running: false, why: 'nothing of ours was running' };
  }
  // The dev server is `npm` with a child; signalling the group is what actually stops
  // both. A bare kill leaves vite orphaned and holding the port, which then reads as
  // "somebody else's" for ever after.
  try { process.kill(-ours.pid, 'SIGTERM'); } catch { try { process.kill(ours.pid, 'SIGTERM'); } catch { /* gone */ } }
  for (let i = 0; i < 20 && alive(ours.pid); i++) await new Promise(r => setTimeout(r, 250));
  if (alive(ours.pid)) { try { process.kill(-ours.pid, 'SIGKILL'); } catch { try { process.kill(ours.pid, 'SIGKILL'); } catch { /* gone */ } } }
  try { unlinkSync(PID_FILE); } catch { /* already gone */ }
  return { ok: true, running: false, stopped: ours.pid };
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const cmd = process.argv[2] || 'status';
  const show = (s) => {
    if (s.absent) { console.log(`field command  ABSENT`); console.log(`  ${s.why}`); return; }
    console.log(`field command  ${s.running ? (s.ours ? 'UP' : 'UP (not ours)') : 'down'}`);
    console.log(`  dir        ${s.dir}`);
    console.log(`  installed  ${s.installed ? 'yes' : 'no — node_modules is absent'}`);
    console.log(`  url        http://127.0.0.1:${s.port ?? UI_PORT}`);
    if (s.pid) console.log(`  pid        ${s.pid}`);
    if (s.why) console.log(`  note       ${s.why}`);
  };
  if (cmd === 'install') process.exit(install().ok ? 0 : 1);
  else if (cmd === 'start') { const r = await start(); show(await status()); process.exit(r.ok ? 0 : 1); }
  else if (cmd === 'stop') { const r = await stop(); console.log(r.stopped ? `stopped pid ${r.stopped}` : (r.why || 'nothing to stop')); process.exit(r.ok ? 0 : 1); }
  else if (cmd === 'status') { show(await status()); process.exit(0); }
  else { console.error('usage: m59-webui.mjs status | install | start | stop'); process.exit(2); }
}
