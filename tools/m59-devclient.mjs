#!/usr/bin/env node
// LAUNCH THE PATCHED CLIENT, POINTED AT THE RIGHT SERVER, WITH THE OVERLAY SWITCHED ON.
//
//   node tools/m59-devclient.mjs --fleet arena TESTER            write shortcuts/dev-TESTER.bat
//   node tools/m59-devclient.mjs --fleet arena TESTER --launch   write it and start it
//   node tools/m59-devclient.mjs --fleet arena --list            who is in this roster
//   node tools/m59-devclient.mjs --fleet arena TESTER --proxy 5961
//   node tools/m59-devclient.mjs --check                         is a patched client built
//   node tools/m59-devclient.mjs --universal                     write shortcuts/dev.bat alone
//
// THE PATCHED CLIENT IS A DIFFERENT BINARY FROM THE ONE THE SHORTCUTS LAUNCH, and that
// is the trap this tool exists to close. `m59-shortcuts.mjs` finds a client by looking
// for a Steam install, so on this machine every shortcut points at
// `steamapps\common\Meridian 59\Meridian.exe` — a stock retail binary with none of
// clientd3d/m59dbg.c in it. A patched client that nothing ever launches is the most
// expensive possible outcome: it compiles, it passes, and the overlay simply never
// appears, with no error anywhere to explain why.
//
// SO THIS NAMES THE BINARY EXPLICITLY and refuses to guess. `M59_CLIENT` overrides;
// otherwise it is the local build tree's `run/localclient/meridian.exe`, which is where
// the makefiles copy the client they just built.
//
// AND IT TAKES THE HOST AND PORT FROM THE ROSTER ENTRY, NOT FROM A DEFAULT. Every
// credential in a named fleet carries its own `host`/`port`, and the two fleets on this
// machine are on different ports — 15959 for the local test server, 5959 for prod. A
// launcher that assumes one of them connects the wrong character to the wrong world and
// says nothing at all about it, because a client at a login screen looks like a client
// that is loading.
//
// A .BAT RATHER THAN A .LNK, deliberately: the environment variables the overlay reads
// have to be set in the launching process, and a shortcut cannot set one. The file
// carries a PLAINTEXT PASSWORD for the same reason every shortcut here does, so
// `shortcuts/` is gitignored and this masks it on the terminal unless asked.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName, stateFileFor } from './m59-fleetpath.mjs';
import { OVERLAY_DIR } from './m59-overlay.mjs';
import { SIGNAL_PORT } from './m59-signal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// The build tree's own output directory. The client makefile copies meridian.exe here
// as its last step, so this is the freshest patched binary by construction.
export const DEV_CLIENT = () => process.env.M59_CLIENT ||
  join(process.env.M59_SOURCE || 'C:\\code\\Meridian59', 'run', 'localclient', 'meridian.exe');


// WHERE THE ROOM VIEWS ARE SERVED. `m59-roomserve.mjs` listens here, and the patched
// client's help key opens `<this>/<room>` instead of the public guides. Absent from the
// client's environment, that key does exactly what the stock client does — see StartHelp
// in clientd3d/winmsg.c.
export const MAP_URL = process.env.M59_MAP_URL || 'http://127.0.0.1:8977';
export function rosterFor(fleet) {
  const file = stateFileFor(fleet);
  if (!existsSync(file)) return { file, entries: [] };
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const entries = [];
  for (const [agent, v] of Object.entries(j)) {
    const cr = v?.credentials;
    if (!cr?.account || !cr?.password) continue;
    entries.push({ agent, account: cr.account, password: cr.password,
                   character: cr.character || null,
                   host: cr.host || '127.0.0.1', port: Number(cr.port || 5959) });
  }
  return { file, entries };
}

// A PROXY FOR *THIS* SERVER, NOT JUST ANY PROXY.
//
// Routing a client through the proxy is what lets a person watch a character the broker is
// also driving — the server allows one connection per character, so without it whoever logs
// in second bumps the first. It is also the only place the packets can be seen, which is what
// a `record` window wants and cannot otherwise get.
//
// But "something is listening on 5961" is not the same fact as "a proxy for the world this
// character lives in". This machine already runs two fleets on two different servers, and
// pointing a client through the wrong proxy logs it into the wrong world QUIETLY, because the
// client cannot tell. So `m59-proxy.mjs` publishes what it fronts and this matches on the
// endpoint, checks the pid is still alive, and falls back to a direct connection when there is
// no match. Absent a proxy the launcher is exactly what it was.
export function proxyFor(host, port) {
  const dir = join(REPO, 'substrate', 'proxies');
  let names = [];
  try { names = readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let a;
    try { a = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    if (!a?.listen || !a?.server) continue;
    if (String(a.server.host) !== String(host)) continue;
    if (Number(a.server.port) !== Number(port)) continue;
    // A FILE OUTLIVES THE PROCESS THAT WROTE IT. An advert with a dead pid is a leftover
    // from a proxy that was killed, and routing a client at it is a connection refused
    // wearing the costume of a feature.
    if (a.pid) { try { process.kill(a.pid, 0); } catch { continue; } }
    return { listen: Number(a.listen), server: a.server, pid: a.pid ?? null };
  }
  return null;
}

const matches = (e, want) => [e.agent, e.character, e.account]
  .filter(Boolean).some(v => String(v).toLowerCase() === String(want).toLowerCase());

// THE UNIVERSAL LAUNCHER: ONE FILE, NO CHARACTER IN IT.
//
//     shortcuts\dev.bat <host> <port> <account> <password> [label]
//
// The first version of this tool wrote one self-contained .bat per character, each
// carrying its own copy of the environment block, the endpoint decision and the start
// line. That is the arrangement in which a fix lands in the file somebody regenerated
// and not in the twenty they did not — and it is also why the fleet terminal could not
// use them: `m59-tui.mjs` launches by AGENT, and a per-character file is the wrong
// shape for a key that has already resolved a host, a port and a password of its own.
//
// So everything about HOW the patched client starts lives here, once. The per-character
// files say only WHO, in one `call` line, and the terminal's launch key calls the same
// file with the same five arguments. What the environment already says wins over what
// this file would set — `if not defined` — so a caller can point one launch at another
// overlay directory without regenerating anything.
//
// It still takes a password, on its command line rather than in its body. That is the
// same exposure as the client's own command line, where it has always been readable to
// anything that can list processes; `shortcuts/` stays gitignored regardless.
export const UNIVERSAL_BAT = (dir = join(REPO, 'shortcuts')) => join(dir, 'dev.bat');

export function universalLauncherText({
  client = DEV_CLIENT(), overlayDir = OVERLAY_DIR(), signalPort = SIGNAL_PORT,
  title = true, mapUrl = MAP_URL,
} = {}) {
  // THE WORKING DIRECTORY IS PART OF THE LAUNCH, NOT AN INCIDENTAL.
  //
  // `download.c:23` declares `run_dir = "."` and the resource and download paths are
  // built from it, so the client resolves real files against whatever directory it was
  // started in. A .lnk always carries one — that is what the Working Directory field
  // IS — and a .bat inherits the caller's, which for a tool run out of this repository
  // is the repository. The first version of this file omitted it, and the resulting
  // client sat at the login screen looking exactly like a wrong password.
  const dir = client.replace(/[\\/][^\\/]+$/, '');
  const tool = join(REPO, 'tools', 'm59-devclient.mjs');
  return [
    '@echo off',
    'rem THE UNIVERSAL DEV-CLIENT LAUNCHER. GENERATED by tools/m59-devclient.mjs; edit that,',
    'rem not this, because every launch that goes through here rewrites it when it is stale.',
    'rem',
    'rem   dev.bat <host> <port> <account> <password> [label]',
    'rem',
    'rem No character lives in this file. The dev-<name>.bat files beside it call it with',
    'rem theirs, and so does the fleet terminal (m59-tui.mjs, key L), so there is ONE place',
    'rem that decides which binary starts, what it reads from the environment, and where it',
    'rem connects. It takes a password on its command line, so shortcuts/ stays gitignored.',
    '',
    'if "%~4"=="" (',
    '  echo usage: %~nx0 ^<host^> ^<port^> ^<account^> ^<password^> [label] 1>&2',
    '  exit /b 2',
    ')',
    '',
    'rem The overlay and the signal channel are read from the environment by',
    'rem clientd3d/m59dbg.c. Unset either one and that half goes quiet, which is what',
    'rem makes the patched binary safe to hand to somebody who just wants to play.',
    'rem Whatever the caller already put in the environment wins over these.',
    'if not defined M59_INVENTORY_SERVER set "M59_INVENTORY_SERVER=%~1:%~2"',
    `if not defined M59_OVERLAY_DIR set "M59_OVERLAY_DIR=${overlayDir}"`,
    `if not defined M59_SIGNAL_PORT set "M59_SIGNAL_PORT=${signalPort}"`,
    `if not defined M59_DEBUG_TITLE set "M59_DEBUG_TITLE=${title ? 1 : 0}"`,
    'rem And the help key. Stock it opens the public guides, which is a page for somebody',
    'rem learning to play; here it opens what the HARNESS believes about the room you are',
    'rem standing in. Needs m59-roomserve.mjs running on that port.',
    `if not defined M59_MAP_URL set "M59_MAP_URL=${mapUrl}"`,
    '',
    'rem WHERE TO CONNECT IS DECIDED NOW, NOT WHEN THIS FILE WAS WRITTEN.',
    'rem If a proxy is fronting the server this character belongs to, go through it: the',
    'rem broker can keep driving the character while you watch, and the packets pass',
    'rem through something that can record them. No proxy, or one for a different server,',
    'rem and this connects straight to the game.',
    'set "M59H=" & set "M59P="',
    `for /f "tokens=1,2" %%a in ('node "${tool}" --endpoint %~1 %~2') do (set "M59H=%%a" & set "M59P=%%b")`,
    'if not defined M59H set "M59H=%~1"',
    'if not defined M59P set "M59P=%~2"',
    '',
    'rem For the offline test: say what the FOR line resolved, and start nothing.',
    'if defined M59_DEVCLIENT_DRYRUN (',
    '  echo %M59H% %M59P% %~3 %~5',
    '  exit /b 0',
    ')',
    `if not exist "${client}" (`,
    `  echo no patched client at ${client} -- node tools/m59-devclient.mjs --check 1>&2`,
    '  exit /b 3',
    ')',
    `cd /d "${dir}"`,
    // `start ""` with an empty title because the first quoted argument to `start` is taken
    // as the WINDOW TITLE, so `start "C:\...\meridian.exe"` opens a console window called
    // that and launches nothing — the single most common way a generated .bat silently does
    // the wrong thing on Windows.
    `start "" /D "${dir}" "${client}" /H:%M59H% /P:%M59P% /U:%~3 /W:%~4 /Q`,
    '',
  ].join('\r\n');
}

// Write dev.bat if it is missing or says something other than what this code would say
// now. Every launch that routes through it calls this first, so the file on disk is
// always the current tool's opinion and never a stale one somebody forgot to regenerate.
// Returns the path and whether it was (re)written.
export function ensureUniversalLauncher({ dir = join(REPO, 'shortcuts'), ...opts } = {}) {
  const path = UNIVERSAL_BAT(dir);
  const text = universalLauncherText(opts);
  let current = null;
  try { current = readFileSync(path, 'utf8'); } catch { /* absent */ }
  if (current === text) return { path, written: false };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, text);
  try { chmodSync(path, 0o700); } catch { /* not meaningful on Windows */ }
  return { path, written: true };
}

// The five arguments dev.bat wants, in order, for one roster entry — shared with the
// terminal so the two callers cannot disagree about which is the port and which the
// account.
export function universalLauncherArgs(entry, { host = null, port = null } = {}) {
  return [String(host ?? entry.host), String(port ?? entry.port),
          String(entry.account), String(entry.password),
          String(entry.character || entry.agent || entry.account)];
}

/**
 * A per-character launcher: WHO, in one line, and the universal file does the rest.
 *
 * An explicit host/port (a `--proxy`) is written into the call; otherwise the entry's own
 * endpoint is, and dev.bat decides at start-up whether a proxy is fronting it.
 */
export function launcherText(entry, { host = null, port = null } = {}) {
  const args = universalLauncherArgs(entry, { host, port });
  const [h, p] = args;
  return [
    '@echo off',
    `rem ${entry.character || entry.account} (${entry.agent}) on ${h}:${p}`,
    'rem GENERATED by tools/m59-devclient.mjs. Contains a plaintext password;',
    'rem shortcuts/ is gitignored and this must stay that way.',
    'rem Everything about HOW the client starts is in dev.bat beside this file.',
    `call "%~dp0dev.bat" ${args.map(a => `"${a}"`).join(' ')}`,
    '',
  ].join('\r\n');
}

// --------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-devclient.mjs')) {
  // ASKED BY THE LAUNCHER AT START-UP, not baked in when the launcher was written.
  //
  //   node tools/m59-devclient.mjs --endpoint 127.0.0.1 15959   ->  127.0.0.1 5961
  //
  // A proxy that starts AFTER the .bat was generated is the normal case — you decide to
  // watch a character halfway through an evening — so resolving this at generation time
  // would mean regenerating the launcher every time, which nobody would remember to do.
  // Prints the endpoint to use and nothing else, so `FOR /F` can read it.
  const ep = process.argv.indexOf('--endpoint');
  if (ep >= 0) {
    const host = process.argv[ep + 1], port = Number(process.argv[ep + 2]);
    const via = proxyFor(host, port);
    console.log(via ? `127.0.0.1 ${via.listen}` : `${host} ${port}`);
    process.exit(0);
  }

  const argv = process.argv.slice(2);
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const at = argv.indexOf('--' + n);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };

  const client = DEV_CLIENT();
  const built = existsSync(client);

  if (has('check') || !built) {
    console.log(`patched client: ${client}`);
    console.log(built ? '  present' : '  NOT BUILT — nothing to launch');
    if (!built) {
      console.log('\nbuild it with:');
      console.log('  cd C:\\code\\Meridian59');
      // vcvars64, not 32: the objects already in clientd3d\release are x64, and one x86
      // logoff.obj among them fails the link with LNK1112 rather than a wrong binary.
      console.log('  "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools' +
                  '\\VC\\Auxiliary\\Build\\vcvars64.bat" && nmake /nologo RELEASE=1 Bclient');
      process.exit(2);
    }
    if (has('check')) process.exit(0);
  }

  // --universal writes dev.bat and nothing else. No roster needed: the file names no
  // character, so it is the one launcher a fresh clone can have before it has a fleet.
  if (has('universal')) {
    const uni = ensureUniversalLauncher({
      client,
      overlayDir: flag('overlay-dir', OVERLAY_DIR()),
      signalPort: Number(flag('signal-port', SIGNAL_PORT)),
      title: !has('no-title'),
    });
    console.log(`${uni.written ? 'wrote' : 'kept'} ${uni.path}`);
    console.log('  dev.bat <host> <port> <account> <password> [label]');
    process.exit(0);
  }

  const fleet = fleetName();
  const { file, entries } = rosterFor(fleet);
  if (!entries.length) {
    console.error(`no roster with passwords at ${file} — is --fleet right?`);
    process.exit(2);
  }

  if (has('list')) {
    console.log(`fleet ${fleet || '(unnamed)'} — ${entries.length} slots in ${file}\n`);
    console.log('agent      character     server');
    for (const e of entries)
      console.log(`${e.agent.padEnd(10)} ${String(e.character || '?').padEnd(13)} ${e.host}:${e.port}`);
    process.exit(0);
  }

  const want = argv.find(a => !a.startsWith('--') &&
                              argv[argv.indexOf(a) - 1] !== '--fleet' &&
                              argv[argv.indexOf(a) - 1] !== '--proxy' &&
                              argv[argv.indexOf(a) - 1] !== '--port');
  if (!want) {
    console.error('name a character, or --list. e.g. --fleet arena TESTER');
    process.exit(2);
  }
  const entry = entries.find(e => matches(e, want));
  if (!entry) {
    console.error(`no "${want}" in fleet ${fleet || '(unnamed)'} — try --list`);
    process.exit(2);
  }

  // THE PROXY IS A DIFFERENT PORT ON THE SAME HOST, and it is what lets a broker keep
  // driving a character while a person watches it. Passing it explicitly rather than
  // guessing: a client silently pointed at a proxy that is not running fails at the
  // login screen and looks exactly like a wrong password.
  const proxy = flag('proxy');
  const dir = join(REPO, 'shortcuts');
  const uni = ensureUniversalLauncher({
    dir, client,
    overlayDir: flag('overlay-dir', OVERLAY_DIR()),
    signalPort: Number(flag('signal-port', SIGNAL_PORT)),
    title: !has('no-title'),
  });
  console.log(`${uni.written ? 'wrote' : 'kept'} ${uni.path}`);
  const text = launcherText(entry, { port: proxy ? Number(proxy) : null });
  const out = join(dir, `dev-${(entry.character || entry.account).replace(/[^A-Za-z0-9._-]+/g, '-')}.bat`);
  writeFileSync(out, text);
  try { chmodSync(out, 0o700); } catch { /* not meaningful on Windows */ }

  console.log(`wrote ${out}`);
  // The password is the fourth argument of the call line; never echo it.
  console.log(text.split('\r\n').filter(l => l && !l.startsWith('rem'))
                  .map(l => '  ' + l.replace(/^(call "[^"]*"(?: "[^"]*"){3}) "[^"]*"/, '$1 "***"'))
                  .join('\n'));

  if (has('launch')) {
    console.log('\nlaunching...');
    const child = spawn('cmd.exe', ['/c', out], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log('  started. The caption names the account, the room and the square.');
    console.log(`  overlay files: ${flag('overlay-dir', OVERLAY_DIR())}`);
    console.log(`  listen for F5: node tools/m59-signal.mjs`);
  }
}
