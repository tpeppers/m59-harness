// A HARNESS-SIDE SUPERVISOR'S IDENTITY CARD FOR DUM'S SUPERVISOR REGISTRY.
//
//   import { supervisorHeartbeat } from './m59-supervisor-heartbeat.mjs';
//   const hb = supervisorHeartbeat({ id: 'ocean-courier', fleet, entry: import.meta.url, paths: [...] });
//   hb.start();  ...  if (hb.stopRequested()) ...  ...  hb.stop();
//
// A DUM doctrine may declare a supervisor it depends on (meridian59-dum-bot docs/supervisors.md): `must` = DUM starts it
// when it is down and withholds the stations that need it; `optional` = DUM warns. DUM decides "is it running, and from
// which commit" by reading ONE file, `<state dir>/<id>.supervisor.json`, and stops it by writing `<state dir>/<id>.stop`.
// Supervisors built on DUM's base class write that file themselves; this is the same contract for long-running harness
// processes that are not (the Ocean courier first), so they can be declared without being rewritten.
//
// THE CONTRACT (schema 1): {schema, id, pid, started_at, heartbeat_at, fleet, entry, repo, commit, dirty, status}
// written atomically (tmp + rename) at start and every `everyMs` (default 10 s; DUM calls it stale after 60 s), status
// running | stopping | stopped. `dirty` is whether any of `paths` differs from HEAD (or is untracked) in `repo`, because
// a pin satisfied by a commit the running file no longer matches is not satisfied.
//
// STATE DIR: M59_SUPERVISOR_STATE_DIR, else <harness>/substrate/supervisors. ID: M59_SUPERVISOR_ID (DUM passes the id the
// doctrine declared), else the caller's default.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = fileURLToPath(new URL('..', import.meta.url));

export function supervisorStateDir(env = process.env) {
  return env.M59_SUPERVISOR_STATE_DIR || join(HARNESS, 'substrate', 'supervisors');
}

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

/** What the running code IS: repo top level, HEAD, and whether the named paths still match HEAD. Pure given `run`. */
export function codeIdentity(entryPath, paths = [], run = git) {
  const dir = dirname(entryPath);
  const repo = run(dir, ['rev-parse', '--show-toplevel']);
  if (!repo) return { repo: null, commit: null, dirty: null };
  const commit = run(dir, ['rev-parse', 'HEAD']);
  const rel = [entryPath, ...paths].map(p => relative(repo, p).replace(/\\/g, '/'));
  const porcelain = run(repo, ['status', '--porcelain', '--', ...rel]);
  return { repo, commit, dirty: porcelain == null ? null : porcelain !== '' };
}

export function supervisorHeartbeat({ id, fleet, entry, paths = [], everyMs = 10_000, env = process.env,
  now = () => new Date(), run = git } = {}) {
  const sid = env.M59_SUPERVISOR_ID || id;
  if (!sid) throw new Error('a supervisor heartbeat needs an id');
  const dir = supervisorStateDir(env);
  const file = join(dir, `${sid}.supervisor.json`), stopFile = join(dir, `${sid}.stop`);
  const entryPath = entry.startsWith('file:') ? fileURLToPath(entry) : entry;
  const identity = { schema: 1, id: sid, pid: process.pid, started_at: now().toISOString(), fleet: fleet ?? null,
    entry: entryPath, ...codeIdentity(entryPath, paths, run),
    ...(env.M59_SUPERVISOR_REQUESTED_BY ? { requested_by: env.M59_SUPERVISOR_REQUESTED_BY } : {}) };
  let timer = null, status = 'running';
  const write = () => {
    try {
      mkdirSync(dir, { recursive: true });
      const next = `${file}.next`;
      writeFileSync(next, JSON.stringify({ ...identity, heartbeat_at: now().toISOString(), status }, null, 1));
      renameSync(next, file);
      return true;
    } catch { return false; }
  };
  return {
    id: sid, file, stopFile, identity,
    /** Clears a stale stop request (a DUM start means "run"), writes the card, keeps it fresh. */
    start() { if (existsSync(stopFile)) rmSync(stopFile); write(); timer = setInterval(write, everyMs); timer.unref?.(); return this; },
    stopRequested: () => existsSync(stopFile),
    stopping() { status = 'stopping'; write(); },
    stop() { if (timer) clearInterval(timer); timer = null; status = 'stopped'; write(); },
    write,
  };
}
