#!/usr/bin/env node
// PROD IS A VERSIONED DEPLOY OF MAIN. NOTHING IS EVER COMMITTED TO IT.
//
//   node tools/m59-deploy.mjs --status    # where prod is relative to main
//   node tools/m59-deploy.mjs --verify    # exit 1 if prod has drifted. For CI and for cron.
//   node tools/m59-deploy.mjs --cut       # tag main and move prod onto that tag
//   ... --no-fetch                        # do not refresh origin/main first (offline, or CI)
//
// THE MODEL. Work lands on `main`. A deploy is a TAG on main and a checkout of that tag —
// a photograph of main at a moment, not a place work happens. main runs ahead; when it is
// worth shipping, cut another tag. Rolling back is checking out the previous tag.
//
// WHAT WENT WRONG WITHOUT IT, measured 2026-09-05:
//
//   * prod was SIX COMMITS AHEAD of the development repo — 2,428 insertions across 20
//     files, including new FleetScript guarantees and their tests, invisible to anyone
//     working in m59-harness.
//   * plus six uncommitted files, four named `.superseded-handcopy` or `.before-<thing>` —
//     hand-copying, which is what people do when the tool will not carry the change.
//   * it had happened before: commit f732112, "adopt the five tools that only existed on
//     the prod deploy branch".
//   * `Merge remote-tracking branch 'origin/max-efficiency' into deploy-2026-09-02` appears
//     NINE times. The deploy ref was not a deploy, it was a long-lived integration branch.
//   * the repository has 86 branches and ZERO tags.
//
// THE MECHANISM, IN ONE LINE: a deploy tracked as a BRANCH is an invitation to commit to
// it; a deploy tracked as a TAG is a fact about main. Everything above follows from that
// one choice, which is why this tool refuses branches rather than merely preferring tags.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const HARNESS = process.env.M59_HARNESS || process.cwd();
const PROD = process.env.M59_PROD_DEPLOY || 'C:/code/m59-lab/prod-deploy';
const TRUNK = process.env.M59_TRUNK || 'main';

const git = (repo, ...args) => {
  try {
    // stderr ignored: several of these are ASKS, not assertions — `describe --exact-match`
    // failing just means "no tag here", and its fatal: line is not news.
    return execFileSync('git', ['-C', repo, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return null;
  }
};

// A STALE LOCAL TRUNK MAKES THIS TOOL LIE, AND THE OBVIOUS FIX BREAKS THE DEV TREE.
//
// This compared prod against the LOCAL `main` ref. That ref only moves when somebody in this
// checkout commits, merges or pulls — so after a push from any other checkout it is stale, and
// this tool reports drift that does not exist. It did, twice in one day, reporting prod as
// "5 ahead, 2 behind" when prod's HEAD was exactly `origin/main`. Both times the reading was
// believed before it was checked, and the second time it nearly stopped a deploy.
//
// THE OBVIOUS FIX IS `git update-ref refs/heads/main origin/main`, AND IT IS A TRAP. That is
// what was run by hand to silence the false reading, and it cost the shared dev tree: refs are
// shared across every worktree of a repository, `update-ref` is plumbing with NO worktree
// safety, and `prod-deploy` is a worktree of this same repo. So a ref moved from prod-deploy
// silently advanced `main` under the development checkout that had it checked out — leaving
// that tree's index and working files at the OLD commit while HEAD pointed at the new one.
// `git status` showed 12 files staged with 438 lines of deletions, and the next commit anyone
// made there would have reverted a deployed merge. `git branch -f` refuses exactly this;
// `update-ref` does it without a word.
//
// So: fetch (which only ever moves remote-tracking refs, and is safe under any worktree), then
// compare against whichever of the two refs is actually further along, and say which one
// answered. Move the local ref only when nothing has it checked out — and never silently.
function trunkCheckedOutIn() {
  const out = git(HARNESS, 'worktree', 'list', '--porcelain') || '';
  let dir = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice('worktree '.length).trim();
    else if (line.trim() === `branch refs/heads/${TRUNK}`) return dir;
  }
  return null;
}

function resolveTrunk({ fetch = true } = {}) {
  const note = [];
  // `--quiet` and no refspec write: this updates refs/remotes/origin/<trunk> and nothing else.
  if (fetch && git(HARNESS, 'fetch', '--quiet', 'origin', TRUNK) === null)
    note.push(`could not reach origin — comparing against the refs already in this checkout, ` +
              `which may be stale. (--no-fetch to stop trying.)`);

  const local = git(HARNESS, 'rev-parse', '-q', '--verify', `refs/heads/${TRUNK}`);
  const remote = git(HARNESS, 'rev-parse', '-q', '--verify', `refs/remotes/origin/${TRUNK}`);
  if (!remote) return { head: local, ref: TRUNK, note };
  if (!local) return { head: remote, ref: `origin/${TRUNK}`, note };
  if (local === remote) return { head: local, ref: TRUNK, note };

  // Local has commits origin does not: unpushed work, which is NOT staleness. Compare against
  // the local ref — a deploy cut from it would be real — and say it needs pushing.
  if (git(HARNESS, 'merge-base', '--is-ancestor', local, remote) === null) {
    note.push(`local ${TRUNK} has commit(s) origin/${TRUNK} does not. Comparing against the ` +
              `local ref; push it before cutting a deploy or the tag names a commit nobody else has.`);
    return { head: local, ref: TRUNK, note };
  }

  // Strictly behind — the case that produced the false drift.
  const heldBy = trunkCheckedOutIn();
  if (heldBy) {
    note.push(`local ${TRUNK} is stale; compared against origin/${TRUNK} instead. Not advancing ` +
              `the ref: ${TRUNK} is checked out in ${heldBy}, and moving a ref under a worktree ` +
              `leaves its index and files at the old commit. Update it there with a pull.`);
    return { head: remote, ref: `origin/${TRUNK}`, note };
  }
  // Nothing has it checked out, so advancing it is safe. Compare-and-swap on the old value, so
  // a concurrent change refuses instead of being clobbered.
  const moved = git(HARNESS, 'update-ref', `refs/heads/${TRUNK}`, remote, local) !== null;
  note.push(moved
    ? `local ${TRUNK} was stale and nothing had it checked out — fast-forwarded it to origin/${TRUNK}.`
    : `local ${TRUNK} is stale and could not be advanced; compared against origin/${TRUNK}.`);
  return { head: remote, ref: moved ? TRUNK : `origin/${TRUNK}`, note };
}

function survey({ fetch = true } = {}) {
  if (!existsSync(PROD)) return { error: `no prod checkout at ${PROD}` };
  const prodHead = git(PROD, 'rev-parse', 'HEAD');
  const trunk = resolveTrunk({ fetch });
  const trunkHead = trunk.head;
  const trunkRef = trunk.ref, trunkNote = trunk.note;
  if (!prodHead || !trunkHead) return { error: 'not a git checkout, or no such ref' };

  // Ask the DEVELOPMENT repo about both commits. If it has never heard of prod's HEAD, that
  // is itself the finding — work exists that main cannot see.
  const known = git(HARNESS, 'cat-file', '-e', `${prodHead}^{commit}`) !== null;
  let ahead = null, behind = null;
  if (known) {
    const counts = git(HARNESS, 'rev-list', '--left-right', '--count', `${prodHead}...${trunkHead}`);
    if (counts) {
      const [a, b] = counts.split(/\s+/).map(Number);
      ahead = a;    // commits prod has that main does not — MUST be zero
      behind = b;   // commits main has that prod does not — fine, that is main running ahead
    }
  }
  const ref = git(PROD, 'rev-parse', '--abbrev-ref', 'HEAD');
  // RUNTIME STATE IS NOT DRIFT. The fleet rewrites its own learning continuously —
  // safespots, sector readings, ledgers — so counting those as a problem makes this check
  // red forever, and a check that is always red is a check nobody reads. Only modified CODE
  // and hand-copied backups count. Untracked files still count wherever they are: a
  // `.superseded-handcopy` sitting in production is exactly what this tool exists to catch.
  // Parsed by REGEX, not by column. `git()` trims its output, which strips the leading space
  // off the first porcelain line — so a fixed slice(3) is off by one on exactly that line and
  // silently fails to match it. The bug reported the file it was meant to exempt.
  const RUNTIME = /^substrate\/[^\s]*\.(json|ndjson|log)$/;
  const PORC = /^\s*([MADRCU?!]{1,2})\s+(.+)$/;
  const all = (git(PROD, 'status', '--porcelain') || '').split('\n').filter(Boolean);
  const dirty = all.filter(l => {
    const m = PORC.exec(l);
    if (!m) return true;                       // unparsed lines are always suspicious
    return !(m[1] === 'M' && RUNTIME.test(m[2].trim()));
  });
  const runtime = all.length - dirty.length;
  const tag = git(PROD, 'describe', '--tags', '--exact-match') || null;
  return { prodHead, trunkHead, trunkRef, trunkNote, known, ahead, behind, ref, dirty, runtime, tag };
}

function report(s) {
  // NAME THE REF THAT ANSWERED. The whole failure this guards against was a number computed
  // against a ref nobody realised was stale, so the reading has to carry its own provenance.
  console.log(`trunk   ${s.trunkRef} @ ${s.trunkHead?.slice(0, 8)}  (${HARNESS})`);
  for (const n of s.trunkNote || []) console.log(`        ${n}`);
  console.log(`prod    ${s.prodHead?.slice(0, 8)}  (${PROD})`);
  console.log(`        checked out as: ${s.ref === 'HEAD' ? `detached${s.tag ? ` at tag ${s.tag}` : ''}` : `BRANCH ${s.ref}`}`);
  if (!s.known) {
    console.log('        UNKNOWN TO MAIN — prod is running commits the development repo has never seen.');
    return;
  }
  console.log(`        ${s.ahead} commit(s) main does not have, ${s.behind} commit(s) behind main`);
  if (s.dirty.length) console.log(`        ${s.dirty.length} uncommitted file(s)`);
  if (s.runtime) console.log(`        ${s.runtime} runtime state file(s) (expected, not drift)`);
}

// What must be true for prod to be a deploy rather than a fork.
function problems(s) {
  const bad = [];
  if (!s.known)
    bad.push('prod is running commits main has never seen. Land them on main first: ' +
             `git -C "${HARNESS}" fetch "${PROD}" ${s.ref} && git -C "${HARNESS}" merge --ff-only FETCH_HEAD`);
  else if (s.ahead > 0)
    bad.push(`prod is ${s.ahead} commit(s) AHEAD of ${TRUNK}. A deploy is never ahead of the ` +
             'trunk — that work is stranded until somebody notices and adopts it by hand.');
  if (s.ref !== 'HEAD')
    bad.push(`prod is on BRANCH "${s.ref}". A deploy should be a detached checkout of a TAG; ` +
             'a branch is an invitation to commit to it, which is how it gets ahead.');
  if (!s.tag && s.ref === 'HEAD')
    bad.push('prod is detached but not at a tag, so the deployed version has no name and ' +
             'cannot be rolled back to by name.');
  if (s.dirty.length)
    bad.push(`prod has ${s.dirty.length} uncommitted file(s). Whatever they are, they are ` +
             'running in production and are in no repository:\n      ' + s.dirty.join('\n      '));
  return bad;
}

// --no-fetch is for an offline run or a tight CI loop. It is opt-OUT rather than opt-in
// because the reading is only worth having when the ref it is computed from is current.
const noFetch = process.argv.includes('--no-fetch');
const mode = process.argv.find(a => a.startsWith('--') && a !== '--no-fetch') || '--status';

const s = survey({ fetch: !noFetch });
if (s.error) { console.error(s.error); process.exit(2); }

if (mode === '--status' || mode === '--verify') {
  report(s);
  const bad = problems(s);
  if (bad.length) {
    console.log(`\n${bad.length} problem(s):\n`);
    for (const b of bad) console.log(`  * ${b}\n`);
  } else {
    console.log('\nprod is a clean versioned deploy of the trunk.');
  }
  process.exit(mode === '--verify' && bad.length ? 1 : 0);
}

if (mode === '--cut') {
  // REFUSE BEFORE ACTING. Cutting a deploy while prod is ahead would bury the stranded work
  // rather than land it, which is the failure this tool exists to make impossible.
  const bad = problems(s).filter(b => /AHEAD|never seen|uncommitted/.test(b));
  if (bad.length) {
    console.error('refusing to cut a deploy:\n');
    for (const b of bad) console.error(`  * ${b}\n`);
    process.exit(1);
  }
  const day = new Date().toISOString().slice(0, 10);
  let tag = `deploy-${day}`;
  for (let n = 2; git(HARNESS, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`); n++)
    tag = `deploy-${day}-${n}`;
  // Tag the ref that ANSWERED, not the constant. When the local trunk was stale and held by a
  // worktree, `main` here still points at the old commit — tagging it would name a version of
  // the code nobody asked to deploy, and the tag would look perfectly correct.
  console.log(`would cut ${tag} at ${s.trunkRef} @ ${s.trunkHead.slice(0, 8)} and move prod onto it:`);
  console.log(`  git -C "${HARNESS}" tag -a ${tag} ${s.trunkRef} -m "deploy ${day}"`);
  console.log(`  git -C "${PROD}" fetch "${HARNESS}" ${TRUNK} && git -C "${PROD}" checkout ${tag}`);
  console.log('\nNot run: cutting a deploy restarts a live fleet. Run those two lines when ready.');
  process.exit(0);
}

console.error(`unknown mode ${mode} — try --status, --verify or --cut`);
process.exit(2);
