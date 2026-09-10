#!/usr/bin/env node
// EVERY RELATIVE IMPORT RESOLVES TO A FILE GIT ACTUALLY HAS.
//
//   node tools/m59-imports-test.mjs
//
// Offline, no socket, no fleet, about a second.
//
// THIS EXISTS BECAUSE OF A TWENTY-MINUTE PROD OUTAGE ON 2026-09-09, and it is the cheapest
// insurance in this directory.
//
// `m59-broker.mjs` imported `./m59-native-context-read.mjs`. That file was never `git add`ed
// — not gitignored, just untracked — so it lived in two working trees and in no commit.
// EVERY deploy tag ever cut from main therefore carried a broker that could not start:
//
//     Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...\m59-native-context-read.mjs'
//       imported from ...\tools\m59-broker.mjs
//
// Nobody found out for weeks, because the way tags were being deployed was to hand-copy
// files into the prod worktree, which carried the untracked module along by accident. The
// first deploy done the CORRECT way — moving the worktree onto a tag — is the one that
// broke. The right procedure surfaced a fault the wrong one had been masking.
//
// Then it happened again one import deeper: `m59-native-context-read.mjs` imports
// `m59-perf.mjs`, which was ALSO untracked, and had been parked on a branch an hour earlier
// on the strength of a reference count that said only the RTS gateway used it. Two sessions
// ran that grep and agreed. The grep was correct and the conclusion was wrong, because the
// second importer was itself untracked and therefore invisible to any search over the
// tracked tree. AN UNTRACKED FILE HIDES ITS EDGES, NOT JUST ITSELF — which is why a
// reference count that comes back reassuringly small is the one to distrust.
//
// WHY THE EXISTING TOOLS COULD NOT CATCH IT:
//
//   * `node --check` parses without resolving imports, so a module with a missing
//     dependency syntax-checks perfectly and dies at startup.
//   * Importing it for real is forbidden here — importing `m59-broker.mjs` RUNS it: it
//     takes the fleet lock and starts rejoin timers. So the one check that would have
//     worked is the one nobody may run.
//   * `git status` shows untracked files, but in a tree with dozens of legitimately
//     untracked runtime artefacts, two more lines are not a signal anyone reads.
//
// So this reads the imports statically and asks git — not the filesystem — whether the
// target is a file that a fresh clone would get. Checking `existsSync` alone would have
// passed on the day of the outage, because the files were RIGHT THERE in the working tree.
// That is the whole trap: the developer's disk is not the deploy's disk.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REF = process.argv.includes('--ref')
  ? process.argv[process.argv.indexOf('--ref') + 1] : 'HEAD';

let failures = 0;
const fail = (what) => { console.error(`  FAIL ${what}`); failures++; };
const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8',
                                                  maxBuffer: 64 * 1024 * 1024 });

// IT ASKS GIT, NOT THE DISK, AND THAT IS THE WHOLE DESIGN.
//
// The first version of this test read the working tree, and in a checkout shared by several
// sessions it immediately reported four failures that were somebody's uncommitted work in
// progress — `m59-newchar.mjs` importing an `m59-appearance.mjs` that exists only in one
// person's tree and in no commit. That is a real hazard for them and it is NOT a fact about
// what ships, so a test that mixes the two cries wolf and gets switched off.
//
// The question this file answers is exactly: WOULD A FRESH CLONE OF THIS REF RUN? So it
// reads the ref, never the disk. A developer's uncommitted state cannot make it fail and,
// more importantly, cannot make it pass.
let tracked, hits;
try {
  tracked = new Set(git(['ls-tree', '-r', '--name-only', REF, 'tools/'])
    .split('\n').map(s => s.trim()).filter(Boolean));
  // One call rather than 564: every relative import in the ref, with the file it is in.
  hits = git(['grep', '-h', '-o', '-E', String.raw`from ['"]\./[^'"]+['"]`, REF, '--', 'tools/'])
    .split('\n');
  // `git grep -h` drops the filename, so ask again with it. Cheap, and keeps the two lists
  // aligned by doing the same query twice rather than parsing one output two ways.
  hits = git(['grep', '-n', '-E', String.raw`from ['"]\./[^'"]+['"]`, REF, '--', 'tools/'])
    .split('\n').filter(Boolean);
} catch (e) {
  console.log('\nimports: SKIPPED — not a git tree, or that ref does not exist.');
  console.log('  This is the half that catches a deploy, so do NOT read this as a pass.');
  process.exit(0);
}

// Git paths are POSIX, always, on every platform. `path.resolve` is Windows-aware here and
// rewrites them with backslashes and a drive letter, which made this test report 264
// failures against a tree that is entirely sound. Two wrong readings in a row from the same
// checker is exactly how a guard loses its credibility, so this does the join by hand.
function joinPosix(dir, spec) {
  const out = dir ? dir.split('/') : [];
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

let edges = 0;
const untracked = new Map();
const sources = new Set();

for (const line of hits) {
  // Shape of a git-grep line: `<ref>:tools/SOME.mjs:12:` then the import text.
  //
  // Written without a literal example of that import text ON PURPOSE: this file scans
  // every module for import specifiers, itself included, so an illustrative `from
  // "./whatever.mjs"` in a comment here is indistinguishable from a real edge and reports
  // a missing module that never existed. It did exactly that on the first tag cut with
  // this check in place — the guard's first finding was itself.
  const m = /^[^:]*:(tools\/[^:]+):\d+:(.*)$/.exec(line);
  if (!m) continue;
  const [, src, text] = m;
  sources.add(src);
  for (const im of text.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
    const spec = im[1];
    if (!/\.(mjs|js|json)$/.test(spec)) continue;
    edges++;
    // RELATIVE TO THE IMPORTING FILE, not to tools/. `tools/runtime/state/index.mjs`
    // importing `./delta-channel.mjs` means `tools/runtime/state/delta-channel.mjs`.
    // Getting this wrong reported 46 failures against a tree that is entirely fine — a
    // reminder that a checker which cries wolf is worse than no checker, because it is
    // the one that gets deleted by the next person in a hurry.
    const target = joinPosix(src.replace(/\/[^/]+$/, ''), spec);
    if (!tracked.has(target)) {
      if (!untracked.has(target)) untracked.set(target, []);
      untracked.get(target).push(src.replace(/^tools\//, ''));
    }
  }
}

// ---------------------------------------------------------------- does the SYMBOL exist?
//
// A FILE THAT EXISTS IS NOT A SYMBOL THAT IS EXPORTED, and the gap between those two shipped
// a broken fleetScript in every tag ever cut. `m59-fleetscript.mjs:105` imported
// `resolveControlUrl` from `m59-fleetpath.mjs`; the committed `m59-fleetpath.mjs` never
// exported it. Found by m59-harness-31 on 2026-09-10, by hand, AFTER the file-existence half
// of this test had passed the same tag — so this is the half that was missing.
//
// The offline suites cannot catch it either, and the reason is the same one that hid the
// untracked modules: THEY RUN FROM THE WORKING TREE, where the function exists. Every test
// passed against a tag whose fleetScript throws on import.
//
// BIASED HARD TOWARD SILENCE, because this checker has already cried wolf twice and a third
// time would end it. Anything it cannot resolve confidently — a re-export chain, a computed
// export, a namespace import — is skipped rather than guessed at.
function exportsOf(src) {
  const names = new Set();
  let starExports = false;
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm))
    names.add(m[1]);
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm))
    for (const part of m[1].split(',')) {
      const as = /(?:\s|^)([A-Za-z_$][\w$]*)\s*$/.exec(part.replace(/\s+as\s+/, ' as '));
      const alias = /\bas\s+([A-Za-z_$][\w$]*)/.exec(part);
      if (alias) names.add(alias[1]);
      else if (as) names.add(as[1]);
    }
  if (/^\s*export\s+default\b/m.test(src)) names.add('default');
  // `export * from './x'` re-exports names this file never mentions. Following the chain is
  // possible but the failure mode of getting it wrong is a false alarm, so a module with one
  // is simply not checked.
  if (/^\s*export\s*\*/m.test(src)) starExports = true;
  return { names, starExports };
}

const missingSymbols = [];
if (!failures) {
  const cache = new Map();
  const read = (path) => {
    if (!cache.has(path)) {
      try { cache.set(path, git(['show', `${REF}:${path}`])); } catch { cache.set(path, null); }
    }
    return cache.get(path);
  };
  // Re-read the import STATEMENTS, which git grep gave us one line at a time. A multi-line
  // `import {\n a,\n b\n} from './x'` is the common shape here, so the single-line grep is
  // not enough and each importing file is read whole.
  for (const src of sources) {
    const text = read(src);
    if (!text) continue;
    for (const im of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"](\.\/[^'"]+)['"]/g)) {
      const spec = im[2];
      if (!/\.(mjs|js)$/.test(spec)) continue;
      const target = joinPosix(src.replace(/\/[^/]+$/, ''), spec);
      const targetSrc = read(target);
      if (!targetSrc) continue;                       // already reported by the half above
      const { names, starExports } = exportsOf(targetSrc);
      if (starExports) continue;
      for (const raw of im[1].split(',')) {
        const want = raw.trim().split(/\s+as\s+/)[0].trim();
        if (!want || !/^[A-Za-z_$][\w$]*$/.test(want)) continue;
        if (!names.has(want))
          missingSymbols.push({ src: src.replace(/^tools\//, ''), target, want });
      }
    }
  }
}

console.log(`\nimport graph at ${REF}: ${sources.size} module(s), ${edges} relative import(s)`);

// THE CHECK. A target the ref does not contain is a module that is not there after a clone
// or a `git checkout <tag>`, however healthy it looks on the machine that wrote it.
if (untracked.size) {
  for (const [target, importers] of untracked)
    fail(`${target} is imported by ${importers.join(', ')} and is NOT IN ${REF} — `
       + 'so it is absent from every clone and every deploy cut from it');
  console.error('\n  Fix by committing the target. Copying it into the deploy tree is what');
  console.error('  hid this for weeks: hand-copied deploys carry untracked files along by');
  console.error('  accident, so the first CORRECT deploy is the one that breaks.');
} else {
  console.log(`  ok   all ${edges} import(s) resolve to files ${REF} actually contains`);
  console.log('  ok   so a fresh clone, and any deploy tag cut from it, can start');
}

// The second half. Only run when the first passed — a missing FILE explains every missing
// symbol in it, and reporting both would bury the cause under its own consequences.
if (!failures) {
  if (missingSymbols.length) {
    for (const { src, target, want } of missingSymbols)
      fail(`${src} imports { ${want} } from ${target}, which does not export it in ${REF} — `
         + 'the file is there and the symbol is not, so this throws on import');
    console.error('\n  The offline suites cannot catch this: they run from the WORKING TREE,');
    console.error('  where the symbol usually exists. Commit the export, not just the caller.');
  } else {
    console.log('  ok   and every named import resolves to a symbol that ref exports');
  }
}

console.log(failures ? `\nimports: ${failures} FAILURE(S)` : '\nimports: PASS');
process.exit(failures ? 1 : 0);
