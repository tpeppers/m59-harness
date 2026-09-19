// WHAT DO WE CALL THE NEXT DEPLOY? — a pure function, so it can be tested without cutting one.
//
// This is one function and it has its own file for one reason: `m59-deploy.mjs` runs on import.
// It reads `process.argv` at the top level and calls `process.exit` at the bottom, so a test
// that imports it does not test it, it RUNS it — and the modes it would run are the ones that
// move production. A pure decision that lives inside an un-importable script is a decision
// nobody can check, and the bug below is what that costs.
//
// THE BUG, 2026-09-10. The numbering walked upward until it found a name nothing was using:
//
//     let tag = `deploy-${day}`;
//     for (let n = 2; <tag exists>; n++) tag = `deploy-${day}-${n}`;
//
// which stops at the first FREE slot rather than after the last USED one. Today's tags were
// deploy-2026-09-10, -1, -2, -4, -5, -6, with production sitting on -6 and -3 deleted at some
// point in the night. Asked for the next tag it answered **-3** — a name numerically below the
// running deploy, pointing at a commit six ahead of it.
//
// Why that matters more than it looks: rolling back is "check out the previous tag", and the
// previous tag is chosen by reading the numbers. A tag whose number is lower than the running
// one but whose content is newer makes that reading wrong, so the rollback rolls FORWARD — onto
// the code you were trying to get away from, during the incident you were trying to end. The
// mistake is invisible at cut time and reads as a successful deploy.
//
// NUMERIC, NOT LEXICAL. `-10` sorts before `-9` as a string, so a day with ten deploys would
// hand out a number it had already used. This fleet has had six in one night, so that is not a
// theoretical bound.

// The bare `deploy-<day>` is the day's FIRST deploy and counts as 1, which is why an empty day
// answers with the bare name and a day with only the bare name answers `-2`.
export const deployTagNumber = (tag, day) => {
  const m = new RegExp('^deploy-' + day + '(?:-([0-9]+))?$').exec(String(tag).trim());
  if (!m) return null;
  return m[1] ? Number(m[1]) : 1;
};

/**
 * The next tag name for `day`, given every tag that already exists.
 *
 * `tags` may be the raw newline-separated output of `git tag -l` — blank lines and stray
 * whitespace are the normal shape of that, not an error — or an array. Tags for other days, and
 * anything that is not a deploy tag at all, are ignored rather than refused: `git tag -l` is
 * given a glob and a glob can match more than you meant.
 */
export const nextDeployTag = (tags, day) => {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/\r?\n/);
  const highest = list.reduce((hi, t) => {
    const n = deployTagNumber(t, day);
    return n === null ? hi : Math.max(hi, n);
  }, 0);
  return highest === 0 ? `deploy-${day}` : `deploy-${day}-${highest + 1}`;
};

/**
 * CAN THIS DEPLOY BE DATED? — the other pure question about a deploy tag's name.
 *
 * A LIGHTWEIGHT TAG CARRIES NO TAGGER AND NO DATE. `git tag <name> <sha>` writes a plain ref
 * into `refs/tags/`; `git tag -a` (which is what `--cut` does) writes a tag OBJECT with an
 * author and a timestamp. Both check out identically, both deploy identically, and `git
 * describe` reports both — so nothing about a hand-cut deploy looks wrong at the moment it is
 * made, or at any moment after.
 *
 * WHAT IT COST, 2026-09-18/19. Six deploys were cut in one evening and one of them shipped a
 * routing change that planned 258 room pairs — 3.9% of the map — through a door the game seals
 * half the time. Reconstructing the evening afterwards was possible to the SECOND for five of
 * the six, because an annotated tag records when it was made; for the sixth it was not possible
 * at all, and that sixth was the one that shipped the regression. Sixteen deploy tags existed,
 * fifteen annotated, and the one with an empty date column was the one anybody needed to date.
 *
 * The session that cut it did so because `--cut` refused an unpushed trunk and they reached for
 * `git tag` to get past the refusal — so this is not carelessness, it is the shape of every
 * shortcut around a tool: the thing that gets you past the check is the thing that removes the
 * evidence. (`--cut --push` was the supported answer and the refusal printed it.)
 *
 * IT REPORTS AND MUST NOT REFUSE A CUT. `--cut`'s whole job here is to move production onto a
 * NEW annotated tag, which is the remedy — so blocking it would leave the tree stuck on the
 * unauditable tag it is complaining about. The wording below is deliberately clear of the
 * phrases `--cut` filters on, and the test asserts that.
 *
 * `kind` is `git cat-file -t <tag>`: `tag` for annotated, `commit` for lightweight. Anything
 * else — including null, which is what an unreadable ref gives — is NOT taken as a failure,
 * because a guard that cannot read its input has not passed, it has abstained, and reporting an
 * abstention as a problem is how a check earns the reputation that gets it switched off.
 */
export const lightweightTagProblem = ({ ref, tag, kind }) => {
  if (ref !== 'HEAD') return null;        // a branch checkout is rule 1's problem, not this one
  if (!tag) return null;                  // detached at no tag at all is already reported
  if (!/^deploy-/.test(String(tag))) return null;
  if (kind !== 'commit') return null;     // annotated, or unreadable: not a finding either way
  return `prod is on "${tag}", which is a LIGHTWEIGHT tag — a plain ref with no tagger and no ` +
         `date, so this deploy cannot be dated by anything, ever. Re-cut it annotated at the ` +
         `same commit: git tag -a -f ${tag} ${tag} -m "re-cut annotated" && git push --force ` +
         `origin ${tag}   (or move this worktree onto an annotated tag instead).`;
};
