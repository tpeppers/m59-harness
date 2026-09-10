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
