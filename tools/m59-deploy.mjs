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

import { nextDeployTag } from './m59-deploytag.mjs';

import { strandedCommits } from './m59-deploy-drift.mjs';
import { holdsIn, holdRefusals } from './m59-release-consent.mjs';
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
    // BUT "AHEAD" AND "DIVERGED" ARE DIFFERENT FACTS, AND ONLY ONE OF THEM IS LOST WORK.
    //
    // Strictly ahead means somebody committed and has not pushed: the local ref is the real
    // trunk and the note below is exactly right. DIVERGED — ahead AND behind — is usually the
    // other thing entirely on a machine with twenty-two worktrees: the same work, rebased onto
    // origin by another session, so the local branch is a DUPLICATE LINE of commits that are
    // already pushed under different hashes. `git cherry` is the arbiter, because it compares
    // patches rather than hashes: `-` means origin already has this change.
    //
    // Measured 2026-09-11: local main was 31 ahead and 46 behind, every one of the 31
    // cherry-equivalent to something on origin, and comparing prod against that line reported
    // **"prod is 37 commits AHEAD of main"** — an emergency about stranded production work, when
    // prod was 2 ahead of origin/main and both of those were cherry-equivalent too. Nothing was
    // stranded and nothing was lost. A check that reports a false emergency is worse than one
    // that stays quiet, because the next real one reads identically and gets waved past; the
    // whole argument for `#movement` epochs is that a counter which cannot come down is a
    // monument rather than a measurement, and this is the same failure in the deploy check.
    const behindOrigin = git(HARNESS, 'merge-base', '--is-ancestor', remote, local) === null;
    if (behindOrigin) {
      const cherry = git(HARNESS, 'cherry', `origin/${TRUNK}`, TRUNK) || '';
      const missing = cherry.split('\n').filter(l => l.startsWith('+'));
      if (!missing.length) {
        // A duplicate line. Origin holds every change, so origin IS the trunk to compare against.
        note.push(`local ${TRUNK} has diverged from origin/${TRUNK}, but every commit on it is ` +
                  `already on origin under a different hash (git cherry: nothing missing) — a ` +
                  `duplicate line, most likely another session's rebase of the same work. ` +
                  `Compared against origin/${TRUNK}. Reset this checkout when it is quiet: ` +
                  `git -C "${HARNESS}" reset --hard origin/${TRUNK}`);
        return { head: remote, ref: `origin/${TRUNK}`, note, duplicateLine: true };
      }
      note.push(`local ${TRUNK} has DIVERGED from origin/${TRUNK} and ${missing.length} of its ` +
                `commit(s) are on neither — not a rebase, genuinely unpushed work on a branch ` +
                `that is also behind. Compared against the local ref.`);
      return { head: local, ref: TRUNK, note, unpushed: true };
    }
    note.push(`local ${TRUNK} has commit(s) origin/${TRUNK} does not. Comparing against the ` +
              `local ref; push it before cutting a deploy or the tag names a commit nobody else has.`);
    // AND IT IS A PROBLEM, NOT A NOTE. See `problems()` — this line has been advisory since the
    // tool was written, and on 2026-09-11 three sessions independently walked up to it and only
    // two stopped. The note is exactly right and is read past, because everything either side of
    // it is routine and the commands to run are printed underneath it.
    return { head: local, ref: TRUNK, note, unpushed: true };
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
  const trunkRef = trunk.ref, trunkNote = trunk.note, trunkUnpushed = !!trunk.unpushed;
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

  // AHEAD BY HASH IS NOT AHEAD BY WORK, AND ONLY ONE OF THEM IS AN EMERGENCY.
  //
  // The whole point of this check is "does prod hold a change nothing else holds" — work that
  // dies the next time somebody moves the worktree onto a tag. `rev-list` answers a narrower
  // question: does prod hold a COMMIT OBJECT the trunk ref cannot reach. Those differ every
  // time anybody rebases, and on this machine somebody always has: measured 2026-09-11, this
  // said **"prod is 37 commit(s) AHEAD of main"** with 35 of the 37 cherry-equivalent to
  // commits already on origin and the other 2 equivalent as well. Nothing was stranded.
  //
  // So ask `git cherry`, which compares PATCHES. And ask it against origin as well as the local
  // ref, because when the two have diverged neither one alone is the trunk: a change is only
  // stranded if it is absent from BOTH. The raw count is still printed — a big gap is a real
  // signal that the worktree wants moving — but the refusal now fires on lost work alone.
  //
  // The decision lives in `m59-deploy-drift.mjs` and not here, for the reason `nextDeployTag`
  // does: THIS FILE RUNS ON IMPORT — it reads argv at the top level and calls process.exit at
  // the bottom — so a test that imported it would execute the modes that move production. A
  // pure decision buried in an un-importable script is a decision nobody can check, which is
  // how the tag-picker shipped a rollback that rolled forward.
  let strandedShas = null;
  if (known && ahead > 0) {
    const remoteRef = git(HARNESS, 'rev-parse', '-q', '--verify', `refs/remotes/origin/${TRUNK}`)
      ? `origin/${TRUNK}` : null;
    strandedShas = strandedCommits({
      prodHead, trunkHead, trunkRef, remoteRef,
      cherry: (base, head) => git(HARNESS, 'cherry', base, head),
      // THE THIRD OPINION, AND THE ONE RULE 5 ACTUALLY PRESCRIBES. A patch-id is still a hash:
      // rebase a change onto different surrounding lines and `git cherry` calls it missing. Five
      // of seven commits read as genuinely unpushed that way on 2026-09-11 and were already on
      // origin under other subjects-identical hashes. `--fixed-string` because these subjects
      // are prose full of regex metacharacters -- backticks, parentheses, question marks.
      subjectSeen: (sha) => {
        const subject = git(HARNESS, 'log', '--format=%s', '-1', sha);
        if (!subject) return null;                 // cannot say: leaves the commit stranded
        for (const ref of [trunkRef, remoteRef].filter(Boolean)) {
          const hit = git(HARNESS, 'log', '--format=%h', '--fixed-strings',
                          `--grep=${subject}`, '-1', ref);
          if (hit === null) return null;
          if (hit) return true;
        }
        return false;
      },
    });
  }
  // WHAT THIS CUT WOULD NEWLY SHIP, and whether any of it asks not to be shipped.
  //
  // Landing a commit here IS the sign-off — see docs/m59-git-process.md rule 8. So this does NOT
  // ask who wrote something or whether they are reachable; it asks only whether the commit
  // itself says do not ship me. The range is everything on the trunk that production is not
  // already running, because that is exactly the set a new tag would put in front of the fleet.
  let holds = [];
  if (known) {
    const raw = git(HARNESS, 'log', '--format=%H%x01%s%x01%b%x02', `${prodHead}..${trunkHead}`);
    if (raw !== null) {
      holds = holdsIn(raw.split('\x02').map(rec => {
        const [sha, subject, body] = rec.replace(/^\s+/, '').split('\x01');
        return sha ? { sha, subject, body } : null;
      }).filter(Boolean));
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
  return { prodHead, trunkHead, trunkRef, trunkNote, trunkUnpushed,
           known, ahead, behind, stranded: strandedShas, holds, ref, dirty, runtime, tag };
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
  if (s.ahead > 0 && Array.isArray(s.stranded))
    console.log(`        of those ${s.ahead}, ${s.stranded.length} carr${s.stranded.length === 1 ? 'ies' : 'y'} ` +
                `a change no trunk ref has (the rest are the same work under other hashes)`);
  if (s.holds?.length) console.log(`        ${s.holds.length} commit(s) in the range ASK NOT TO BE RELEASED`);
  if (s.dirty.length) console.log(`        ${s.dirty.length} uncommitted file(s)`);
  if (s.runtime) console.log(`        ${s.runtime} runtime state file(s) (expected, not drift)`);
}

// What must be true for prod to be a deploy rather than a fork.
function problems(s) {
  const bad = [];
  if (!s.known)
    bad.push('prod is running commits main has never seen. Land them on main first: ' +
             `git -C "${HARNESS}" fetch "${PROD}" ${s.ref} && git -C "${HARNESS}" merge --ff-only FETCH_HEAD`);
  // Ahead by hash and by nothing else: a rebase somewhere else, seen from here. Not a problem,
  // and the status block above has already said so in as many words — pushing a "problem" that
  // resolves to "nothing is stranded" is how the next REAL one gets waved past.
  else if (s.ahead > 0 && Array.isArray(s.stranded) && !s.stranded.length) { /* nothing to refuse */ }
  else if (s.ahead > 0)
    bad.push(`prod is ${Array.isArray(s.stranded) ? s.stranded.length : s.ahead} commit(s) AHEAD of ${TRUNK}. A deploy is never ahead of the ` +
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
  // A TAG MUST NAME A COMMIT SOMEBODY ELSE CAN FETCH.
  //
  // This was an advisory note for as long as the tool has existed, and the note says the whole
  // thing -- "push it before cutting a deploy or the tag names a commit nobody else has". It is
  // read past anyway, because it sits between routine lines with the commands to run printed
  // directly underneath it.
  //
  // MEASURED 2026-09-11, and it is why this is a refusal now. `--cut` proposed tagging LOCAL
  // main while that ref was seven commits BEHIND origin and carrying ten unpushed commits
  // belonging to a different session. The proposed tag would have shipped prod WITHOUT the
  // conjure-loop fix the roll existed for, and it fails silently in both directions: the tag
  // cuts cleanly, prod checks out cleanly, and the broker comes up healthy running the wrong
  // tree. Three sessions walked up to this in one night and only two of them stopped.
  //
  // UNPUSHED IS NOT STALE, which is why resolveTrunk compares against the local ref rather than
  // origin -- a deploy cut from it WOULD be real, just unfetchable by anyone else. The right
  // answer is to refuse and let a person push, not to quietly prefer the other ref and ship
  // something nobody asked for.
  if (s.trunkUnpushed)
    // NOT "ASK WHOSE IT IS". That sentence used to end "...on a machine with many worktrees that
    // work is usually somebody else's", and reading it is what held a roll on 2026-09-11 with
    // seven good commits — four of them movement and guild fixes — sitting in a local branch
    // whose authors were mostly sessions that had already ended. Committing is the sign-off
    // (rule 8), so the remaining problem is purely mechanical: a tag must name a fetchable
    // commit. `--push` does it, and needs nobody's permission.
    bad.push(`local ${TRUNK} has commit(s) origin/${TRUNK} does not, so a tag cut here would ` +
             'name a commit nobody else can fetch. Landing a commit here is consent to ship it, ' +
             'so this needs no author\'s sign-off -- it just needs pushing: ' +
             `node tools/m59-deploy.mjs --cut --push   (or: git -C "${HARNESS}" push origin ${TRUNK})`);
  for (const r of holdRefusals(s.holds)) bad.push(r);
  return bad;
}

// --no-fetch is for an offline run or a tight CI loop. It is opt-OUT rather than opt-in
// because the reading is only worth having when the ref it is computed from is current.
const noFetch = process.argv.includes('--no-fetch');
const doPush = process.argv.includes('--push');
const mode = process.argv.find(a => a.startsWith('--') && a !== '--no-fetch' && a !== '--push')
  || '--status';

let s = survey({ fetch: !noFetch });
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
  // --push: DO THE THING THAT NO LONGER NEEDS ASKING.
  //
  // An unpushed trunk is a real problem -- a tag must name a commit somebody else can fetch
  // (rule 3) -- but under rule 8 it is a MECHANICAL one. Every commit here was signed off for
  // release by being committed, so there is nobody to consult and the fix is one push. Held
  // commits are checked FIRST and block the push as well as the cut: pushing a hold to origin
  // is handing it to the next person who cuts, which is the thing the hold exists to stop.
  if (doPush && s.trunkUnpushed) {
    const held = holdRefusals(s.holds);
    if (held.length) {
      console.error('refusing to push: a commit in this range asks not to be released.\n');
      for (const b of held) console.error(`  * ${b}\n`);
      process.exit(1);
    }
    console.log(`pushing ${s.trunkRef} to origin (committing here is the sign-off -- rule 8)...`);
    const out = git(HARNESS, 'push', 'origin', TRUNK);
    if (out === null) {
      console.error(`could not push ${TRUNK}. Another session may have landed work since the ` +
                    'fetch: pull --rebase and run this again.');
      process.exit(1);
    }
    // RE-SURVEY RATHER THAN ASSUME. The push changed the very refs every number here was
    // computed from, and reporting the pre-push reading would be the same class of mistake as
    // trusting a restart loaded what you wrote.
    s = survey({ fetch: true });
    if (s.error) { console.error(s.error); process.exit(2); }
  }

  // REFUSE BEFORE ACTING. Cutting a deploy while prod is ahead would bury the stranded work
  // rather than land it, which is the failure this tool exists to make impossible.
  const bad = problems(s).filter(b =>
    /AHEAD|never seen|uncommitted|nobody else can fetch|asks not to be released|no reason/.test(b));
  if (bad.length) {
    console.error('refusing to cut a deploy:\n');
    for (const b of bad) console.error(`  * ${b}\n`);
    process.exit(1);
  }
  const day = new Date().toISOString().slice(0, 10);
  // THE SUFFIX IS MAX+1, NOT THE FIRST FREE SLOT.
  //
  // This used to walk n upward until it found a name nothing was using, which fills GAPS. On
  // 2026-09-10 the tags were deploy-2026-09-10, -1, -2, -4, -5, -6 with prod sitting on -6 and
  // -3 deleted, and the old loop proposed cutting -3 at a commit six AHEAD of -6. A tag whose
  // number is lower than the running one but whose content is newer inverts the only thing a
  // deploy tag has to mean, and the way you find that out is a rollback that rolls forward.
  //
  // Numeric max, not lexical, and the decision lives in m59-deploytag.mjs so it can be tested
  // without cutting a deploy -- this file runs on import, so nothing here is reachable from a
  // test. m59-deploytag-test.mjs carries the gap case that caused this.
  // A FAILED LOOKUP IS NOT AN EMPTY DAY. `git()` returns null when the command fails, and
  // `|| ''` would turn that into "no tags today" -- which proposes the day's FIRST name on a
  // day that may already have six. `git tag -a` would then refuse it, so it fails safe rather
  // than quietly, but the message would be about a name collision instead of about git not
  // answering, and that is a wrong signpost during a deploy.
  const existing = git(HARNESS, 'tag', '-l', `deploy-${day}*`);
  if (existing === null) {
    console.error(`refusing to cut a deploy: could not list existing deploy-${day} tags.`);
    console.error('Without them the next number cannot be chosen, and guessing it risks');
    console.error('naming a tag below the one production is running.');
    process.exit(1);
  }
  const tag = nextDeployTag(existing, day);
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
