// WHICH ROSTER FILE IS "THE FLEET" RIGHT NOW.
//
// One resolver, imported by everything that reads or writes a roster, because the
// broker and the tools that inspect it disagreeing about which file is the fleet is
// not a visible failure — it is a TUI that shows an empty roster while the broker
// plays on, or a shutdown that checkpoints the wrong one.
//
// A roster is per-server. Characters on one server share nothing with characters on
// another, so a file holding both describes a fleet that does not exist. Each fleet
// gets its own file and the filename is the identity:
//
//   --fleet prod   /  M59_FLEET=prod      substrate/fleets/prod.json
//   (nothing)                             substrate/fleet-state.json
//
// Naming nothing keeps the original path, so a checkout that has never heard of
// fleets behaves exactly as it did. M59_STATE_FILE still overrides everything, which
// is what the tests use.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// WHICH FLEET, WHEN THE CALLER DID NOT SAY.
//
// Naming nothing used to mean substrate/fleet-state.json, and on a machine that has
// moved on to a named fleet that default is a trap rather than a convenience: every
// tool run without --fleet quietly addresses a roster for a server that may not even
// be up, reports itself perfectly healthy, and answers questions about a fleet nobody
// is playing. A restart did exactly that — it stopped a live 46-session broker and
// would have brought back a 37-character roster pointed at a dead local server.
//
// So a checkout may record which fleet it actually cares about, in one line:
//
//   substrate/fleet-default        prod
//
// It is deliberately a FILE and not a constant in this repository. `prod` is one
// machine's fleet, its roster is gitignored because it holds passwords, and a clone
// that has never heard of it must keep behaving exactly as it did — so the file is
// gitignored too, and a checkout without one falls back to the unnamed fleet.
//
// Order, most explicit first:
//
//   --fleet <name>          what this invocation said
//   M59_FLEET=<name>        what this shell said
//   substrate/fleet-default what this checkout cares about
//   (nothing)               substrate/fleet-state.json, as it always was
//
// `--fleet -` asks for the unnamed fleet on purpose, which is the only way to get it
// back once a default is recorded. It cannot collide with a real name because a name
// must start with a letter or digit.
export const DEFAULT_FLEET_FILE = join(REPO, 'substrate', 'fleet-default');

const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// A fleet name becomes a filename, so it is validated rather than trusted. Refusing
// is better than sanitising: silently rewriting `../../etc` to `etc` would put the
// roster somewhere the caller did not ask for and would not think to look.
function checked(name, source) {
  if (name && !NAME_OK.test(name)) {
    throw new Error(`bad fleet name ${JSON.stringify(name)} from ${source} — ` +
                    `letters, digits, dash and underscore only`);
  }
  return { name, source };
}

function recordedDefault(env) {
  const path = env.M59_FLEET_DEFAULT_FILE || DEFAULT_FLEET_FILE;
  if (!existsSync(path)) return '';
  try {
    // One name, on the first line that is not blank and not a comment — so the file
    // can carry a note about why without that note becoming a fleet name.
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) return t;
    }
  } catch { /* unreadable is the same as absent — never fail a tool over it */ }
  return '';
}

// The name AND where it came from. Every tool that acts on a fleet should say which
// one out loud, and "because this checkout says so" is a different thing for a reader
// to check than "because you typed it".
export function resolveFleetName(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--fleet');
  const flag = i >= 0 ? String(argv[i + 1] ?? '') : '';
  if (flag === '-') return { name: '', source: '--fleet - (the unnamed fleet, asked for)' };
  if (flag) return checked(flag, '--fleet');
  if (env.M59_FLEET) return checked(env.M59_FLEET, 'M59_FLEET');
  const local = recordedDefault(env);
  if (local) return checked(local, 'substrate/fleet-default');
  return { name: '', source: 'no fleet named' };
}

export function fleetName(argv = process.argv.slice(2), env = process.env) {
  return resolveFleetName(argv, env).name;
}

export function stateFileFor(name, env = process.env) {
  if (env.M59_STATE_FILE) return env.M59_STATE_FILE;
  return name ? join(REPO, 'substrate', 'fleets', `${name}.json`)
              : join(REPO, 'substrate', 'fleet-state.json');
}

// The ledger is per-fleet for the same reason the roster is, and with sharper
// consequences: it is keyed by CHARACTER NAME, and character names are only unique
// within a server. Two fleets writing one directory silently merge two different
// characters that happen to share a name into one row, and the dashboard then reports
// a levels-per-hour figure for a character that does not exist. Worse, it is not
// obviously wrong — it just reads as a fleet doing better than it is.
export function ledgerDirFor(name, env = process.env) {
  if (env.M59_LEDGER_DIR) return env.M59_LEDGER_DIR;
  return name ? join(REPO, 'substrate', 'history', name)
              : join(REPO, 'substrate', 'history');
}

// WHERE THE EVIDENCE IS WRITTEN, WHICH IS NOT NECESSARILY WHERE THE CODE IS.
//
// Every ledger in this repository resolved its own path as `HERE/../substrate/...` — one
// line each, in six files, and correct for as long as there was one checkout. On
// 2026-08-30 prod was pinned to a commit-locked worktree (C:/code/m59-lab/prod-deploy) so
// that keepers stop respawning onto half-finished edits, which is a good change and broke
// this: keepers spawn from `join(HERE, ...)`, so every ledger followed the CODE into the
// deploy tree.
//
// Measured within the hour: the same characters had two transit files being written at
// once — Clifford.json at 11:13 in the checkout and 11:36 in the deploy tree — and a
// `m59-transits` report run from the checkout answered for shadow alone and said nothing
// about it. That is the failure this repository keeps paying for: not a wrong number, a
// number that is quietly about less than you think. `--since` filtering everything except
// the table people read was the same shape, the same week.
//
// So the location is a decision, resolved in one place, and the DEFAULT IS EXACTLY WHAT IT
// WAS — `<repo>/substrate` — so a checkout that has never heard of a pinned deploy behaves
// identically and nothing migrates. A pinned tree sets M59_EVIDENCE_DIR back at the
// canonical substrate and the evidence reconverges.
//
// It is deliberately NOT `ledgerDirFor`, which is per-FLEET and lives under
// `substrate/history/<fleet>`. That split is about character names colliding between
// servers; this one is about two trees of the same fleet. A tool wanting a per-fleet
// ledger still wants `ledgerDirFor`; a tool wanting "the substrate that owns this
// machine's evidence" wants this.
// AND IT RESOLVES ITSELF, because a fix that needs the deploy to set a variable is a fix
// that does nothing until somebody restarts prod — while the evidence forks in the meantime.
//
// A linked git worktree has a `.git` FILE, not a directory, holding
// `gitdir: <main>/.git/worktrees/<name>`. Three dirnames up from that is the checkout the
// worktree was cut from. So a pinned deploy writes its evidence HOME without being told,
// and picks it up on the next keeper respawn rather than on a restart.
//
// Only when that substrate actually exists — a worktree cloned somewhere with no checkout
// beside it keeps its own, which is the right answer for a stranger and for CI.
function checkoutSubstrate() {
  try {
    const dotgit = join(REPO, '.git');
    if (!existsSync(dotgit) || statSync(dotgit).isDirectory()) return null;   // the checkout
    const m = /gitdir:\s*(.+)/.exec(readFileSync(dotgit, 'utf8'));
    if (!m) return null;
    const main = dirname(dirname(dirname(m[1].trim())));   // .../worktrees/<n> -> .git -> repo
    const sub = join(main, 'substrate');
    return existsSync(sub) ? sub : null;
  } catch { return null; }
}

let resolved;
export function evidenceDirFor(env = process.env) {
  if (env.M59_EVIDENCE_DIR) return env.M59_EVIDENCE_DIR;
  if (resolved === undefined) resolved = checkoutSubstrate();
  return resolved ?? join(REPO, 'substrate');
}

export function strategyStatsDirFor(name, env = process.env) {
  if (env.M59_STRATEGY_STATS_DIR) return env.M59_STRATEGY_STATS_DIR;
  return name ? join(REPO, 'substrate', 'strategy-stats', name)
              : join(REPO, 'substrate', 'strategy-stats', 'default');
}

// The lock is named after the roster it guards, so a named fleet and the unnamed one
// can be held at once without either believing it owns the other. Anything cleaning up
// a lock must derive it the same way, or it deletes the wrong checkout's claim.
export function lockFileFor(name, env = process.env) {
  return stateFileFor(name, env) + '.lock';
}

// WHICH BROKER A SCRIPT TALKS TO, AND WHY THIS CHECKOUT REFUSES TO GUESS.
//
// `M59_CONTROL_URL` names the broker. It has always defaulted to `http://127.0.0.1:8901/`,
// which is correct for a machine running ONE fleet and is a landmine on a machine running
// several: 8901 is production here, so a script that names another fleet, takes that
// fleet's run lock and logs "fleet shadow" on every line still sends every call to prod.
// That is not hypothetical — it happened on 2026-09-09, and it was harmless only because
// the agent name did not exist on the other side.
//
// The fix is NOT to remove the default from the code. A clone with one fleet should keep
// working exactly as it does, and a stranger who has never heard of any of this should not
// have to set a variable to run a script. So the default stays committed, and this
// CHECKOUT's opinion lives in a gitignored file beside the fleet default — the same
// arrangement, for the same reason, as `substrate/fleet-default`:
//
//   substrate/control-url        require            -> no default; naming one is mandatory
//   substrate/control-url        http://…:8971/     -> this checkout's broker, not 8901
//   (absent)                     http://127.0.0.1:8901/, as it always was
//
// The operator's argument for `require` here, which is worth writing down because it
// generalises: a development environment full of one-off prototypes produces mistakes at a
// much higher rate than a production one, so the person who owns it needs STRICTER data
// segmentation than the people who merely use it — not looser. A default is a convenience
// that spends its safety margin on whoever has the most fleets.
export const CONTROL_URL_FILE = join(REPO, 'substrate', 'control-url');
export const DEFAULT_CONTROL_URL = 'http://127.0.0.1:8901/';

export function resolveControlUrl(env = process.env) {
  if (env.M59_CONTROL_URL) return { url: env.M59_CONTROL_URL, source: 'M59_CONTROL_URL' };
  const path = env.M59_CONTROL_URL_FILE || CONTROL_URL_FILE;
  let recorded = '';
  if (existsSync(path)) {
    try {
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith('#')) { recorded = t; break; }
      }
    } catch { /* unreadable is the same as absent — never fail a tool over it */ }
  }
  // REFUSING IS AN ANSWER, and it has to be one this returns rather than throws, so the
  // caller can say which fleet it was about to drive when it refused.
  if (/^(require|none|no-default)$/i.test(recorded))
    return {
      url: null, source: 'substrate/control-url',
      why: `this checkout requires M59_CONTROL_URL to be named explicitly (substrate/control-url ` +
           `says "${recorded}"). There is no default here on purpose: this machine runs more than ` +
           `one fleet, and 8901 is production. Name the broker that holds the fleet you mean:\n` +
           `  M59_CONTROL_URL=http://127.0.0.1:<port>/ ...`,
    };
  if (recorded) return { url: recorded, source: 'substrate/control-url' };
  return { url: DEFAULT_CONTROL_URL, source: 'the built-in default' };
}

// The set, resolved together, for the common case. `source` is carried through so a
// tool can print where the name came from without resolving it twice.
export function resolveFleet(argv = process.argv.slice(2), env = process.env) {
  const { name, source } = resolveFleetName(argv, env);
  return {
    fleet: name,
    label: name || 'default',
    source,
    stateFile: stateFileFor(name, env),
    lockFile: lockFileFor(name, env),
    ledgerDir: ledgerDirFor(name, env),
    strategyStatsDir: strategyStatsDirFor(name, env),
  };
}

// WHERE THIS ROSTER'S CHARACTERS ACTUALLY CONNECT.
//
// A roster is per-server, so the endpoint is a property of the FILE, and it is not the
// same question as "what would this process do with a join that names no host". The
// broker's M59_HOST/M59_PORT answer the second; only the roster answers the first.
//
// Confusing the two is not hypothetical: the broker's startup banner printed the process
// default and so announced `game server 127.0.0.1:5959` while twenty-one shadow sessions
// were established to 127.0.0.1:15959 — on the one fleet whose whole purpose is not being
// prod. Read at banner time this is the only thing that CAN answer, because the HTTP
// listener comes up before the resume and the session table is still empty.
//
// Returns null rather than guessing: an unreadable roster, one with no endpoints, and one
// that MIXES endpoints are all "this file does not name a single server", and a caller
// that wants to fall back to a default should have to say so.
export function rosterGameEndpoint(stateFile) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(stateFile, 'utf8')); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const endpoints = new Map();
  for (const record of Object.values(parsed)) {
    const host = typeof record?.credentials?.host === 'string' ? record.credentials.host.trim() : '';
    const port = Number(record?.credentials?.port);
    if (host && Number.isInteger(port) && port > 0 && port <= 65535)
      endpoints.set(`${host.toLowerCase()}:${port}`, { host, port });
  }
  // A roster mixing endpoints describes a fleet that does not exist. Report the
  // disagreement rather than picking one of them — the same rule m59-fleets.mjs applies.
  return endpoints.size === 1 ? [...endpoints.values()][0] : null;
}
