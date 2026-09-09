#!/usr/bin/env node
// ONE CLICK, ONE CHARACTER. Writes a desktop shortcut per character that starts
// the real client already pointed at your server and already logged in.
//
//   node tools/m59-shortcuts.mjs               one per character in the roster
//   node tools/m59-shortcuts.mjs Aldric s4     just those
//   node tools/m59-shortcuts.mjs --desktop     also copy them to the Desktop
//   node tools/m59-shortcuts.mjs --proxy       route through the proxy, not the server
//   node tools/m59-shortcuts.mjs --list        what is on file, nothing written
//
// WHAT A SHORTCUT IS HERE. The client takes the whole login on its command line
// (clientd3d/config.c:395-460), and `/Q` skips the splash and the login dialog:
//
//     Meridian.exe /H:host /P:port /U:account /W:password /Q [/S]
//
// so a shortcut is that line, per character, with the four values filled in from
// the roster. `/S` says "this is a Steam install" and stops a Steam build reading
// its download_time of 9999 as a real download and trying to patch itself instead
// of connecting. m59-fleet.mjs and m59-tui.mjs build the same command line — if
// you change the shape of it, change it in all three.
//
// THE SHORTCUTS CONTAIN THE PASSWORD IN PLAIN TEXT. There is no other way to
// pre-fill it: the client has no credential store and no token, only `/W:`. So
// `shortcuts/` is exactly as secret as substrate/fleet-accounts.json — it is
// gitignored, it is written 0600, and nothing here prints a password to the
// terminal unless you ask with --show. The summary masks them, because the
// normal reason to run this is with someone reading over your shoulder or with
// the output going into a transcript.
//
// LOGGING IN BUMPS THE BROKER. Meridian allows one connection per character, so
// a client logging in as a character the broker is driving takes it away from
// the broker — that is not a bug, it is how `m59-fleet.mjs spec` works at all.
// Use --proxy to route the shortcut through m59-proxy.mjs instead, which keeps
// the character drivable while you are inside it.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
         writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveFleet } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const WIN = process.platform === 'win32';

export const STEAM_APPID = '893390';
export const SHORTCUT_DIR = join(REPO, 'shortcuts');

// Fleet-aware, because a shortcut carries a HOST and a PASSWORD on its command line.
// Reading the wrong roster does not fail — it writes a working shortcut into the wrong
// server's account, which is the kind of mistake you find out about from the other end.
const { stateFile: STATE_FILE, label: FLEET_LABEL } = resolveFleet();
const ACCOUNTS_FILE = join(REPO, 'substrate', 'fleet-accounts.json');

const c = {
  ok: s => `\x1b[32m${s}\x1b[0m`, bad: s => `\x1b[31m${s}\x1b[0m`,
  warn: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`,
};

// ------------------------------------------------------------------ the client
//
// Shared with setup.mjs, which imports these rather than keeping a second copy —
// a shortcut that points somewhere `doctor` does not look is a shortcut nobody
// can debug.

export const CLIENT_GUESSES = [
  process.env.M59_CLIENT,
  'C:/Program Files (x86)/Steam/steamapps/common/Meridian 59',
  'C:/Program Files/Steam/steamapps/common/Meridian 59',
  join(process.env.HOME || '', '.steam/steam/steamapps/common/Meridian 59'),
  join(process.env.HOME || '', '.local/share/Steam/steamapps/common/Meridian 59'),
  join(process.env.HOME || '', '.var/app/com.valvesoftware.Steam/data/Steam/steamapps/common/Meridian 59'),
  '/run/media/mmcblk0p1/steamapps/common/Meridian 59',
];

export function findClient() {
  for (const g of CLIENT_GUESSES) {
    if (!g) continue;
    const res = join(g, 'resource');
    try {
      if (existsSync(res) && readdirSync(res).some(f => f.toLowerCase().endsWith('.bgf'))) return g;
    } catch { /* unreadable, keep looking */ }
  }
  return null;
}

// The retail build ships Meridian.exe; the source tree produces meridian.exe on a
// case-sensitive filesystem. Either is the same command line.
export function findClientExe(dir) {
  if (process.env.M59_CLIENT_EXE && existsSync(process.env.M59_CLIENT_EXE))
    return process.env.M59_CLIENT_EXE;
  if (!dir) return null;
  for (const name of ['Meridian.exe', 'meridian.exe']) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

// A Steam install, as opposed to a copy of the tree someone unzipped. This decides
// both `/S` and, on Linux, whether Steam can be asked to launch it.
export const isSteamInstall = dir => /steamapps/i.test(dir || '');

// ------------------------------------------------------------------ the roster
//
// Two files, on purpose. fleet-accounts.json is written by m59-makefleet.mjs and
// is the only copy of the passwords, so it is the authority and it is readable
// with no broker running. fleet-state.json is what the broker is holding right
// now, and is the only place the agent id (`s4`) is written down — which is the
// name people actually use for a character.

export function roster() {
  const byAccount = new Map();
  try {
    const j = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
    for (const [account, v] of Object.entries(j.accounts || {}))
      byAccount.set(account, { account, password: v.password, character: v.character || null,
                               host: v.host || null, port: v.port || null, agent: null });
  } catch { /* no fleet made here yet */ }
  try {
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    for (const [agent, v] of Object.entries(j)) {
      const cr = v?.credentials;
      if (!cr?.account) continue;
      const prev = byAccount.get(cr.account) || {};
      byAccount.set(cr.account, {
        account: cr.account,
        password: cr.password || prev.password,
        character: cr.character || prev.character || null,
        // CARRIED, BECAUSE `clientArgs` ASKS FOR THEM AND THE COMMENT THERE IS THE REASON.
        // Dropping these made `e.host` undefined for every entry, so the opts fallback —
        // M59_HOST or 127.0.0.1 — won every time. Every shortcut on this machine pointed at
        // 127.0.0.1:5959 while all 22 roster entries said 76.214.42.186:5959, and the
        // failure is the silent one that comment predicts: the client opens, finds nothing
        // on the port, and waits.
        host: cr.host || prev.host || null,
        port: cr.port || prev.port || null,
        agent,
      });
    }
  } catch { /* broker has never run, or holds nobody */ }
  // No password, no shortcut: the point of the thing is not typing one.
  return [...byAccount.values()].filter(e => e.password);
}

const label = e => e.character || e.account;
const slug = e => label(e).replace(/[^A-Za-z0-9._-]+/g, '-');
const matches = (e, want) => [e.agent, e.character, e.account]
  .filter(Boolean).some(v => v.toLowerCase() === want.toLowerCase());

// ------------------------------------------------------------------ quoting
//
// The password comes out of randomBytes().toString('base64url'), so in practice
// it is [A-Za-z0-9_-] and needs no quoting at all. In practice is not a reason to
// emit something that breaks on the first account somebody names by hand.

// freedesktop.org Desktop Entry spec, §Exec. Values are unescaped TWICE — once as
// a desktop-entry string, then again by the argument splitter — which is why one
// literal backslash has to be written as four.
const EXEC_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
function execArg(s) {
  const quoted = EXEC_SAFE.test(s)
    ? s
    : '"' + s.replace(/\\/g, '\\\\\\\\').replace(/(["`$])/g, '\\\\$1') + '"';
  return quoted.replace(/%/g, '%%');   // a lone % introduces a field code
}

const psQuote = s => `'${String(s).replace(/'/g, "''")}'`;

// ------------------------------------------------------------------ writing

function desktopFile(e, cmd, opts) {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=Meridian 59 — ${label(e)}`,
    `Comment=Log in as ${label(e)} (${e.account}) on ${opts.host}:${opts.port}`,
    `Exec=${cmd}`,
    'Terminal=false',
    'Categories=Game;RolePlaying;',
    'StartupWMClass=meridian.exe',
  ];
  lines.splice(5, 0, `Icon=${steamIcon() || 'applications-games'}`);
  return lines.join('\n') + '\n';
}

// Steam drops steam_icon_<appid>.png into the icon theme when it makes its own
// shortcut for a title; use that rather than shipping artwork. Which size
// directory it lands in varies, so look through them rather than guessing at one.
function steamIcon() {
  const theme = join(process.env.HOME || '', '.local/share/icons/hicolor');
  const name = `steam_icon_${STEAM_APPID}`;
  try {
    for (const size of readdirSync(theme))
      if (existsSync(join(theme, size, 'apps', `${name}.png`))) return name;
  } catch { /* no icon theme here */ }
  return null;
}

// PowerShell's WScript.Shell COM object is how a .lnk is made without a
// dependency. If it is unavailable we fall back to a .cmd, which is uglier in
// Explorer but launches the identical process.
function writeWindowsShortcut(path, e, exe, args, opts) {
  const ps = [
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(path)})`,
    `$s.TargetPath=${psQuote(exe)}`,
    `$s.Arguments=${psQuote(args.join(' '))}`,
    `$s.WorkingDirectory=${psQuote(dirname(exe))}`,
    `$s.IconLocation=${psQuote(exe + ',0')}`,
    `$s.Description=${psQuote(`Meridian 59 as ${label(e)} (${e.account}) on ${opts.host}:${opts.port}`)}`,
    '$s.Save()',
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
                      { encoding: 'utf8', timeout: 30000 });
  if (!r.error && r.status === 0 && existsSync(path)) return path;

  const cmdPath = path.replace(/\.lnk$/, '.cmd');
  // LAUNCH IT FROM ITS OWN DIRECTORY. The client resolves `resource\` against the
  // working directory and takes an access violation loading a module without it.
  writeFileSync(cmdPath, [
    '@echo off',
    `cd /d "${dirname(exe)}"`,
    `start "" "${exe}" ${args.map(a => `"${a}"`).join(' ')}`,
    '',
  ].join('\r\n'));
  return cmdPath;
}

// The four values, in the order the client's own parser takes them. /Q is what
// makes it a shortcut rather than a form to fill in.
// Exported because m59-tui.mjs's L key starts the same client with the same
// arguments. Two copies of this list is how /S goes missing from one of them and a
// Steam build quietly tries to patch itself instead of connecting.
//
// Callers that have ALREADY resolved a host and port — the TUI does, because a swarm
// launch points the client at the proxy rather than the game server — must pass them
// on the entry, not only in opts, or the roster's own host wins and the override is
// silently discarded.
export function clientArgs(e, opts, steam) {
  // EACH CHARACTER'S OWN SERVER. The roster records the host and port every entry was
  // joined against, and one broker can hold characters on more than one — so a single
  // host for the whole run is wrong as soon as that is true, and quietly: the shortcut
  // opens a client that finds nothing on the port and waits.
  const host = e.host || opts.host;
  const port = String(e.port || opts.port);
  const args = [`/H:${host}`, `/P:${port}`, `/U:${e.account}`, `/W:${e.password}`, '/Q'];
  if (steam) args.push('/S');
  return args;
}

export function writeShortcuts(opts = {}) {
  const host = opts.host || process.env.M59_HOST || '127.0.0.1';
  const port = String(opts.port || process.env.M59_PORT || 5959);
  const o = { ...opts, host, port };

  const dir = findClient();
  const exe = findClientExe(dir);
  if (!exe) return { ok: false, why: 'no-client', written: [] };

  const people = roster();
  if (!people.length) return { ok: false, why: 'no-roster', written: [], exe };
  const wanted = opts.only?.length ? people.filter(p => opts.only.some(w => matches(p, w))) : people;
  if (!wanted.length) return { ok: false, why: 'no-match', written: [], exe };
  // Asking for four names and getting three shortcuts is worth saying out loud;
  // the one that did not match is a typo, and silence reads as success.
  const missed = (opts.only || []).filter(w => !people.some(p => matches(p, w)));

  mkdirSync(SHORTCUT_DIR, { recursive: true });
  try { chmodSync(SHORTCUT_DIR, 0o700); } catch { /* Windows ACLs, not modes */ }

  const steam = isSteamInstall(dir);
  const written = [];
  for (const e of wanted) {
    const args = clientArgs(e, o, steam);
    let path;
    if (WIN) {
      path = writeWindowsShortcut(join(SHORTCUT_DIR, `m59-${slug(e)}.lnk`), e, exe, args, o);
    } else {
      // On Linux the client is a Windows binary under Proton, and Proton is
      // Steam's. `steam -applaunch <appid> <args>` is the one supported way to
      // start it with arguments of our own; running the .exe directly would mean
      // building a compatibility environment by hand, which is not a shortcut.
      if (!steam) return { ok: false, why: 'linux-not-steam', written, exe, dir };
      const cmd = ['steam', '-applaunch', STEAM_APPID, ...args].map(execArg).join(' ');
      path = join(SHORTCUT_DIR, `m59-${slug(e)}.desktop`);
      writeFileSync(path, desktopFile(e, cmd, o));
    }
    // 0700 rather than 0600 on Linux: a .desktop that is not executable is one
    // the file manager refuses to launch.
    try { chmodSync(path, WIN ? 0o600 : 0o700); } catch { /* Windows ACLs, not modes */ }
    written.push({ ...e, path, args });
  }

  const copied = opts.desktop ? copyToDesktop(written) : [];
  return { ok: true, written, copied, missed, dir, exe, steam, host, port };
}

function desktopDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return null;
  const d = join(home, 'Desktop');
  return existsSync(d) ? d : null;
}

function copyToDesktop(written) {
  const dest = desktopDir();
  if (!dest) return [];
  const out = [];
  for (const w of written) {
    const to = join(dest, basename(w.path));
    try {
      copyFileSync(w.path, to);
      chmodSync(to, WIN ? 0o600 : 0o700);
      // KDE and GNOME refuse to run a .desktop they do not trust, silently or with
      // a dialog. Nothing here depends on this working — it is a courtesy.
      if (!WIN) spawnSync('gio', ['set', to, 'metadata::trusted', 'true'], { timeout: 10000 });
      out.push(to);
    } catch { /* a read-only Desktop is not a failure of the shortcut */ }
  }
  return out;
}

// ------------------------------------------------------------------ reporting

// Everything user-facing goes through this. A shortcut's whole content is a
// credential, and the terminal is the one place it does not need to appear.
const mask = args => args.map(a => a.startsWith('/W:') ? '/W:••••••••' : a).join(' ');

function explain(res, opts) {
  switch (res.why) {
    case 'no-client':
      console.log(c.warn('no Meridian 59 client install found — nothing to make a shortcut to.'));
      console.log('\n  https://store.steampowered.com/app/' + STEAM_APPID + '/Meridian_59/');
      console.log('  already own it?   steam://install/' + STEAM_APPID);
      console.log('\nor point at an install directly:');
      console.log('  M59_CLIENT="/path/to/Meridian 59" node tools/m59-shortcuts.mjs');
      console.log(c.dim('\nA fleet does not need this. Agents speak the protocol directly;'));
      console.log(c.dim('the client, and so this, is for watching them by hand.'));
      return 0;
    case 'no-roster':
      console.log(c.warn(`no characters on file for fleet "${FLEET_LABEL}".`));
      console.log(`  ${STATE_FILE}`);
      console.log('  node tools/setup.mjs fleet 10          makes some');
      console.log('  node tools/m59-shortcuts.mjs --fleet <name>   a different fleet');
      return 0;
    case 'no-match':
      console.log(c.warn(`nothing in the roster matches: ${opts.only.join(', ')}`));
      console.log('  node tools/m59-shortcuts.mjs --list    shows the names it knows');
      return 1;
    case 'linux-not-steam':
      console.log(c.warn(`the client at ${res.dir} is not a Steam install.`));
      console.log('\nOn Linux the client is a Windows binary and needs Proton, which is');
      console.log('Steam\'s — so a shortcut here can only be `steam -applaunch`. Install the');
      console.log('title through Steam and run this again, or launch it yourself with:');
      console.log(c.dim(`\n  ${res.exe} /H:… /P:… /U:… /W:… /Q`));
      return 1;
    default:
      console.log(c.bad('could not write shortcuts: ' + res.why));
      return 1;
  }
}

export function report(res, opts = {}) {
  if (!res.ok) return explain(res, opts);
  console.log(c.ok(`${res.written.length} shortcut(s) in ${SHORTCUT_DIR}`));
  console.log(c.dim(`client ${res.exe}`));
  console.log(c.dim(`each one logs in to ${res.host}:${res.port} and skips the login dialog`));
  console.log('');
  const w = Math.max(...res.written.map(x => label(x).length));
  for (const x of res.written) {
    console.log(`  ${label(x).padEnd(w)}  ${c.dim(basename(x.path))}  ` +
                `${opts.show ? x.args.join(' ') : c.dim(mask(x.args))}`);
  }
  if (res.missed?.length)
    console.log(c.warn(`\nnothing in the roster matches: ${res.missed.join(', ')}`));
  if (res.copied?.length) console.log(c.ok(`\ncopied to ${dirname(res.copied[0])}`));
  else console.log(c.dim('\n  --desktop  copies them to your Desktop as well'));
  console.log(c.warn('\nThese hold the account passwords in plain text. shortcuts/ is'));
  console.log(c.warn('gitignored for that reason — treat it like fleet-accounts.json.'));
  if (res.steam && !WIN) {
    console.log(c.dim('\nSteam Game Mode shows no .desktop files. For one character there,'));
    console.log(c.dim('put its arguments in the title\'s Properties → Launch Options as'));
    console.log(c.dim('  %command% /H:… /P:… /U:… /W:… /Q'));
    console.log(c.dim('  node tools/m59-shortcuts.mjs <name> --show   prints the real values'));
  }
  return 0;
}

// ------------------------------------------------------------------ main

const USAGE = `usage: node tools/m59-shortcuts.mjs [name…] [options]

  name…        agent id, character or account; default is every character
  --desktop    copy the shortcuts to your Desktop as well
  --proxy      point them at m59-proxy.mjs (5961) so the broker keeps driving
  --host H     --port N    override either explicitly
  --show       print the real command lines, passwords and all
  --list       show the roster and write nothing`;

// Options and names are told apart by taking the value after --host/--port out of
// the list first; anything left that is not a flag is somebody's name.
function parseArgs(argv) {
  const flags = new Set();
  const vals = {};
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host' || a === '--port') vals[a.slice(2)] = argv[++i];
    else if (a.startsWith('-')) flags.add(a);
    else only.push(a);
  }
  return { flags, vals, only };
}

function main(argv) {
  const { flags, vals, only } = parseArgs(argv);
  const flag = n => flags.has(n);

  if (flag('--help') || flag('-h')) { console.log(USAGE); return 0; }

  if (flag('--list')) {
    const people = roster();
    if (!people.length) { console.log(c.warn('no characters on file.')); return 0; }
    for (const e of people)
      console.log(`  ${(e.agent || '-').padEnd(6)} ${(e.character || '?').padEnd(14)} ${c.dim(e.account)}`);
    return 0;
  }

  // Through the proxy the broker keeps its connection and you get DUAL rather
  // than a bump; straight at the server is the plain case and the default.
  const proxy = flag('--proxy');
  const opts = {
    only,
    desktop: flag('--desktop'),
    show: flag('--show'),
    host: vals.host || (proxy ? (process.env.M59_PROXY_HOST || '127.0.0.1') : undefined),
    port: vals.port || (proxy ? (process.env.M59_PROXY_PORT || 5961) : undefined),
  };
  return report(writeShortcuts(opts), opts);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  process.exit(main(process.argv.slice(2)));
