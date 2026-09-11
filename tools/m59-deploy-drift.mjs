// IS PROD AHEAD OF THE TRUNK BY WORK, OR ONLY BY HASH? A pure decision, so it can be checked.
//
// `m59-deploy.mjs --verify` exists to answer one question: does the production worktree hold a
// change that nothing else holds — work that dies the next time somebody moves it onto a tag.
// It asked `rev-list --left-right`, which answers a narrower question: does prod hold a COMMIT
// OBJECT the trunk ref cannot reach. On a repository with one branch and one worktree those are
// the same sentence. On this machine — twenty-two worktrees, several sessions rebasing the same
// work onto origin at once — they come apart constantly, and always in the direction that cries
// wolf.
//
// MEASURED 2026-09-11. `--verify` reported **"prod is 37 commit(s) AHEAD of main. A deploy is
// never ahead of the trunk — that work is stranded until somebody notices and adopts it by
// hand."** Every word of that is alarming and none of it was true: prod was 2 commits ahead of
// `origin/main`, both cherry-equivalent to commits already pushed, and the 37 came from
// comparing against the LOCAL `main` ref, which was itself a partly-duplicated line 46 commits
// behind origin. Nothing was stranded. Nothing had been lost at any point.
//
// Why that matters more than a wrong number. This tool's refusal is the thing standing between a
// `--cut` and burying somebody's work, and a refusal that fires on a healthy tree every single
// day is a refusal people learn to type past — the same argument the `#movement` epoch rule
// makes about counters that cannot come down. The check has to be able to come down.
//
// SO ASK ABOUT PATCHES, NOT HASHES, AND ASK BOTH REFS. `git cherry <base> <head>` marks each
// commit `-` when an equivalent change is already on the base and `+` when it is genuinely
// absent. And when the local trunk ref and origin have diverged, NEITHER ONE ALONE IS THE
// TRUNK: a change is stranded only if it is missing from both. That second half is not
// theoretical here — it is the exact shape this machine was in when the false alarm fired.
//
// `null` IS AN ANSWER AND IT IS NOT "FINE". If `git cherry` cannot be run — a broken object, a
// ref that does not resolve, git missing — this returns `null`, and the caller must fall back to
// the raw count and keep refusing. A guarantee that cannot be evaluated refuses; it does not
// quietly pass. That rule is in docs/m59-git-process.md because breaking it is how the
// pre-commit hook sat silently inert for an afternoon while reporting nothing wrong.

/**
 * Which of prod's commits carry a change no trunk ref has.
 *
 * @param {object}   o
 * @param {string}   o.prodHead    the commit production is checked out at
 * @param {string}   o.trunkHead   the ref `--verify` compared against (local, usually)
 * @param {string|null} o.remoteRef `origin/<trunk>`, or null when there is no remote
 * @param {string|null} o.trunkRef  the NAME of trunkHead, so we can tell it from remoteRef
 * @param {(base: string, head: string) => string|null} o.cherry
 *        runs `git cherry base head`; returns its stdout, or null if it could not run
 * @returns {string[]|null} the stranded shas, [] when nothing is stranded, null when unevaluable
 */
export function strandedCommits({ prodHead, trunkHead, remoteRef = null, trunkRef = null, cherry }) {
  const missingAgainst = (base) => {
    const out = cherry(base, prodHead);
    if (out === null || out === undefined) return null;
    return String(out).split('\n')
      .filter(l => l.trimStart().startsWith('+'))
      .map(l => l.trim().slice(1).trim())
      .filter(Boolean);
  };

  const vsTrunk = missingAgainst(trunkHead);
  if (vsTrunk === null) return null;          // cannot say — the caller keeps refusing
  if (!vsTrunk.length) return [];             // the whole gap is other people's rebases

  // Only one ref to consult, or both names denote the same one.
  if (!remoteRef || remoteRef === trunkRef) return vsTrunk;

  // Two refs that disagree. Stranded means absent from BOTH; anything origin already has is
  // safe however the local branch looks. An unevaluable second opinion does not clear the
  // first one — it leaves the alarm exactly where it was.
  const vsRemote = missingAgainst(remoteRef);
  if (vsRemote === null) return vsTrunk;
  return vsTrunk.filter(sha => vsRemote.includes(sha));
}
