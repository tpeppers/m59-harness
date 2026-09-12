// WHO DO I ASK ABOUT THIS — for a file, a commit, or a subject, across BOTH agent systems.
//
//   node tools/m59-whowrote.mjs doctrines/local/prod-weaponcraft-training.jsonc
//   node tools/m59-whowrote.mjs tools/m59-tactical-job.mjs
//   node tools/m59-whowrote.mjs --term "SELL_KEEP"
//   node tools/m59-whowrote.mjs --commit 1bba256
//   node tools/m59-whowrote.mjs --since 6h tools/m59-autopilot.mjs
//
// THE PROBLEM THIS EXISTS FOR. This machine runs many agents against one repository. Closing
// out a piece of work means asking whoever wrote it, and on 2026-09-11 that question took a
// peer session searching its own transcripts by hand to answer ONCE. Two sessions, this one
// included, guessed first and guessed wrong — I reported the wrong owner of a live doctrine
// twice, and both times the file was driving twenty-one characters on a shared server.
//
// THREE REASONS GIT CANNOT ANSWER IT ALONE, and the third is the one that matters:
//
//   * Every commit here is authored by the same person. `git log --author` partitions nothing.
//   * The most consequential state is DELIBERATELY gitignored — `doctrines/local/*`,
//     `substrate/loadouts/*`, `substrate/fleets/*`, `substrate/tuning.json`. Those are ORDERS
//     to a live fleet, they are this machine's rather than the repository's, and git has never
//     seen them. The file that took a manual search to attribute was one of these.
//   * NOT EVERY WRITER IS A CLAUDE SESSION. An OpenAI Codex agent works in this tree, commits
//     into the production checkout, and restarts the fleet. It does not appear in ListAgents,
//     cannot be messaged, and no amount of asking peers finds it — every cross-session
//     negotiation that night was reasoning about a peer set that excluded the actual writer.
//
// WHAT ACTUALLY WORKS is the method that peer used, made repeatable: agents leave transcripts
// on disk, and a transcript that mentions a path is a session that touched it. Both systems
// write JSONL, so one grep spans both:
//
//   Claude   ~/.claude/projects/<project-slug>/*.jsonl
//   Codex    ~/.codex/sessions/**/*.jsonl  and  ~/.codex/archived_sessions/*.jsonl
//
// IT PRINTS METADATA AND NEVER CONTENT, AND THAT IS A SAFETY RULE RATHER THAN A STYLE CHOICE.
// These transcripts contain whatever passed through a session, and on this machine that
// includes `substrate/fleets/prod.json` — the only copy of twenty-three account passwords,
// for which there is no reset and no email on the account. A tool that grepped transcripts and
// echoed the matching LINES would be a credential dump wearing a helpful name. So: which file,
// which session, when it was last active, how many times it came up. Never the match itself.
//
// LAST ACTIVITY IS THE REACHABILITY SIGNAL, and it is a proxy rather than an answer. A
// transcript touched minutes ago is a session worth messaging; one from three days ago is a
// transcript worth reading. Neither is a promise: ListAgents is the only authority on who is
// live, and a name there can be reused or retired between one question and the next — I
// reported a peer as ENDED tonight when the truth was only that its name no longer resolved.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '..');

// Claude keeps one directory per project, named after the path with separators flattened.
// Derived rather than hardcoded, because this tool is as useful from a worktree as from the
// trunk and those are different directories.
export function claudeProjectDirs(home = homedir()) {
  const root = join(home, '.claude', 'projects');
  if (!existsSync(root)) return [];
  // THE REPOSITORY'S NAME, NOT THIS DIRECTORY'S, AND THE DIFFERENCE IS THE WHOLE TOOL.
  //
  // `basename(REPO)` is what the tool asked first, and from a worktree that is the WORKTREE's
  // name -- `land-codex-a3`, `lockwork`, `int-33` -- which matches no project slug at all. The
  // first run found the Codex sessions and reported ZERO Claude ones, for a file six Claude
  // transcripts mention. A clean, confident, wrong answer, and exactly the failure this tool
  // exists to stop: the attribution question has been answered wrongly twice already.
  //
  // `--git-common-dir` points at the MAIN worktree's .git from anywhere, so its parent is the
  // repository proper however deep in a worktree the caller happens to be standing.
  let repoName = basename(REPO);
  try {
    const common = execFileSync('git', ['-C', REPO, 'rev-parse', '--git-common-dir'],
                                { encoding: 'utf8' }).trim();
    if (common) repoName = basename(resolve(REPO, common, '..'));
  } catch { /* not a git tree: fall back to the directory name */ }
  // Every project whose slug mentions it. A worktree and the trunk checkout are DIFFERENT
  // slugs and both are worth reading: the session that wrote the thing you are asking about
  // may well have been working somewhere else entirely.
  const want = repoName.toLowerCase();
  return readdirSync(root)
    .filter(d => d.toLowerCase().includes(want))
    .map(d => join(root, d))
    .filter(d => { try { return statSync(d).isDirectory(); } catch { return false; } });
}

export function codexSessionDirs(home = homedir()) {
  return [join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')]
    .filter(existsSync);
}

// Every .jsonl under a directory, recursively. Codex nests by year/month/day; Claude is flat.
function transcripts(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) transcripts(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// COUNT THE MENTIONS, CARRY NOTHING OUT. `hits` is how strong the association is — a session
// that names a path forty times wrote it; one that names it once may only have been told about
// it, which is exactly the difference between an author and a bystander.
function countMentions(file, needle) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return 0; }
  const lower = text.toLowerCase(), want = needle.toLowerCase();
  let n = 0, i = 0;
  while ((i = lower.indexOf(want, i)) !== -1) { n++; i += want.length; }
  return n;
}

export function searchTranscripts(needle, { home = homedir(), sinceMs = 0 } = {}) {
  const rows = [];
  const scan = (files, system) => {
    for (const f of files) {
      let mtime = 0;
      try { mtime = statSync(f).mtimeMs; } catch { continue; }
      if (sinceMs && mtime < sinceMs) continue;
      const hits = countMentions(f, needle);
      if (hits) rows.push({ system, file: f, session: basename(f).replace(/\.jsonl$/, ''), hits, mtime });
    }
  };
  for (const d of claudeProjectDirs(home)) scan(transcripts(d), 'claude');
  for (const d of codexSessionDirs(home)) scan(transcripts(d), 'codex');
  return rows.sort((a, b) => b.mtime - a.mtime);
}

// THE GIT HALF, which is the cheap and certain one when the file is tracked. 39 of the last 40
// commits on this repository carry a `Claude-Session:` trailer, so for anything in git the
// answer is usually already written down and needs no searching at all.
export function gitAuthors(pathOrCommit, { commit = false } = {}) {
  const run = (...args) => {
    try { return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }); }
    catch { return ''; }
  };
  const log = commit
    ? run('show', '-s', '--format=%H%x01%ad%x01%s%x01%b', '--date=iso', pathOrCommit)
    : run('log', '-8', '--format=%H%x01%ad%x01%s%x01%b', '--date=iso', '--', pathOrCommit);
  const out = [];
  for (const block of log.split('\n').join('').split(/\n(?=[0-9a-f]{40})/)) {
    const [sha, date, subject, body = ''] = block.split('');
    if (!sha || !/^[0-9a-f]{7,40}$/.test(sha.trim())) continue;
    const m = body.match(/Claude-Session:\s*(\S+)/i);
    out.push({ sha: sha.trim().slice(0, 9), date, subject, session: m ? m[1] : null });
  }
  return out;
}

const parseSince = (s) => {
  const m = /^(\d+)([hdm])$/.exec(String(s || ''));
  if (!m) return 0;
  const mult = { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
  return Date.now() - Number(m[1]) * mult;
};

function main(argv) {
  const flag = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
  const has = (n) => argv.includes('--' + n);
  const sinceMs = parseSince(flag('since'));
  const commitArg = flag('commit');
  const term = flag('term');
  const target = commitArg || term || argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--since');

  if (!target) {
    console.log('usage: m59-whowrote.mjs <path> | --term <text> | --commit <sha> [--since 6h]');
    return 2;
  }

  console.log('');
  if (!term) {
    const commits = gitAuthors(target, { commit: !!commitArg });
    console.log(commits.length ? 'IN GIT — the trailer is the answer when there is one' : 'IN GIT — nothing (untracked, gitignored, or never committed)');
    for (const c of commits)
      console.log(`  ${c.sha}  ${String(c.date).slice(0, 16)}  ${c.session ? c.session.replace(/^https?:\/\/\S*?session_/, 'session ') : 'NO SESSION TRAILER'}\n            ${String(c.subject).slice(0, 88)}`);
    console.log('');
  }

  const needle = term || basename(target);
  const rows = searchTranscripts(needle, { sinceMs });
  console.log(`ON DISK — sessions whose transcript mentions "${needle}"${sinceMs ? ', recently' : ''}`);
  if (!rows.length) {
    console.log('  nothing. Either nobody has discussed it, or it predates the transcripts kept here.');
  }
  for (const r of rows.slice(0, has('all') ? 999 : 12)) {
    const age = Math.round((Date.now() - r.mtime) / 60000);
    const when = age < 90 ? `${age}m ago` : age < 2880 ? `${Math.round(age / 60)}h ago` : `${Math.round(age / 1440)}d ago`;
    console.log(`  ${r.system.padEnd(6)} ${String(r.hits).padStart(4)} mention(s)  last active ${when.padEnd(9)} ${r.session.slice(0, 44)}`);
  }
  console.log('');
  console.log('  Content is never printed: these transcripts carry whatever passed through a');
  console.log('  session, including the roster that is the only copy of the account passwords.');
  console.log('  A `claude` row that is minutes old is worth a SendMessage — ask ListAgents for the');
  console.log('  name, it is the only authority on who is live. A `codex` row cannot be messaged at');
  console.log('  all; read the transcript, or expect that work to keep arriving unannounced.');
  console.log('');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
