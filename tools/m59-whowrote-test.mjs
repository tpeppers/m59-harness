#!/usr/bin/env node
// THE ATTRIBUTION TOOL, AGAINST FIXTURES. Offline, no transcripts of its own read, safe any time:
//
//   node tools/m59-whowrote-test.mjs
//
// WHY THIS EXISTS AT ALL. `m59-whowrote.mjs` answers "who do I ask about this", and its first
// version answered it CONFIDENTLY AND WRONGLY: run from a worktree it derived the Claude project
// slug from `basename(REPO)` — the worktree's name, not the repository's — matched no project
// directory, and reported ZERO Claude sessions for a file six Claude transcripts mention. It
// found the Codex sessions, printed a tidy table, and looked entirely healthy.
//
// That is the failure the tool exists to prevent, committed by the tool. An attribution answer
// gets acted on: on 2026-09-11 a wrong one was relayed to the wrong session twice, about a file
// driving twenty-one characters on a shared server. So the two things that can silently go wrong
// — which directories it looks in, and whether it ever carries content out — are pinned here.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectDirs, codexSessionDirs, searchTranscripts } from './m59-whowrote.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
};

// A fake home with both agent systems' stores in it, so nothing here reads the real ones.
const home = mkdtempSync(join(tmpdir(), 'm59-whowrote-test-'));
const claudeRoot = join(home, '.claude', 'projects');
const codexRoot = join(home, '.codex', 'sessions');
mkdirSync(join(claudeRoot, 'C--code-mindmap-maps-m59-harness'), { recursive: true });
mkdirSync(join(claudeRoot, 'C--somewhere-else-entirely'), { recursive: true });
mkdirSync(join(codexRoot, '2026', '09', '11'), { recursive: true });

const SECRET = 'password-that-must-never-be-printed';
writeFileSync(join(claudeRoot, 'C--code-mindmap-maps-m59-harness', 'aaa.jsonl'),
  `{"t":"mentions doctrines/local/thing.jsonc twice: doctrines/local/thing.jsonc"}\n` +
  `{"t":"and carries a ${SECRET} the way a real transcript does"}\n`);
writeFileSync(join(claudeRoot, 'C--somewhere-else-entirely', 'bbb.jsonl'),
  `{"t":"a project that is not this repository, mentioning doctrines/local/thing.jsonc"}\n`);
writeFileSync(join(codexRoot, '2026', '09', '11', 'rollout-x.jsonl'),
  `{"t":"doctrines/local/thing.jsonc"}\n`);

console.log('\nwhich directories it looks in');
{
  const dirs = claudeProjectDirs(home);
  // THE BUG THAT SHIPPED. From a worktree the repo name must still resolve to m59-harness, or
  // every Claude session is invisible and the tool reports Codex alone as though that were the
  // whole answer.
  ok('the repository\'s project directory is found from a worktree',
     dirs.some(d => d.includes('m59-harness')), JSON.stringify(dirs.map(d => d.split(/[\\/]/).pop())));
  ok('and an unrelated project is not swept in',
     !dirs.some(d => d.includes('somewhere-else-entirely')));
  ok('codex stores are found as well as claude ones',
     codexSessionDirs(home).some(d => d.includes('.codex')));
}

console.log('\nwhat it reports');
{
  const rows = searchTranscripts('doctrines/local/thing.jsonc', { home });
  ok('both systems answer, not just one',
     new Set(rows.map(r => r.system)).size === 2, JSON.stringify(rows.map(r => r.system)));
  // The count is what separates an author from a bystander — 2,293 mentions in a Codex rollout
  // against 37 in a session that merely discussed the file is the whole signal.
  const claude = rows.find(r => r.system === 'claude');
  ok('mentions are COUNTED, so an author outranks a bystander', claude?.hits === 2,
     String(claude?.hits));
  ok('nested codex day-directories are walked', rows.some(r => r.system === 'codex'));
  ok('newest first, because recency is the reachability hint',
     rows.every((r, i) => i === 0 || rows[i - 1].mtime >= r.mtime));
}

console.log('\nand what it must never carry out');
{
  // THE SAFETY RULE. These transcripts hold whatever passed through a session, and on this
  // machine that includes the roster — the only copy of twenty-three account passwords, with no
  // reset and no email on the account. A row that carried the matching LINE would be a
  // credential dump wearing a helpful name.
  const rows = searchTranscripts('password-that-must-never', { home });
  ok('a match is reported at all', rows.length > 0);
  const blob = JSON.stringify(rows);
  ok('but no transcript CONTENT appears in the result', !blob.includes(SECRET));
  ok('and the row carries only metadata',
     rows.every(r => Object.keys(r).sort().join(',') === 'file,hits,mtime,session,system'),
     JSON.stringify(Object.keys(rows[0] ?? {})));
}

console.log('\nwhen there is nothing to find');
{
  ok('an unknown term is empty rather than an error',
     searchTranscripts('nothing-mentions-this-string-anywhere', { home }).length === 0);
  ok('a home with no agent stores at all answers empty',
     claudeProjectDirs(mkdtempSync(join(tmpdir(), 'm59-empty-'))).length === 0);
}

rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
