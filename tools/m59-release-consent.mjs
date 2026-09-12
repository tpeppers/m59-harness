// LANDING A COMMIT IS THE SIGN-OFF. This decides when that is NOT true, and it is a pure
// function so the answer can be checked without cutting a deploy.
//
// THE PROBLEM. Work here is written by many sessions at once — Claude sessions that come and go
// within an afternoon, and at least one Codex agent that appears in no `ListAgents` listing and
// answers no message. Under the old convention, finding an unpushed commit belonging to somebody
// else meant finding THEM: `m59-deploy.mjs --cut` said so in as many words — *"on a machine with
// many worktrees that work is usually somebody else's. Push it first"* — and reading that
// sentence is what stopped a roll on 2026-09-11 with seven perfectly good commits sitting in a
// local branch, four of them movement and guild fixes.
//
// That is a deadlock dressed as politeness. The author is frequently unreachable BY
// CONSTRUCTION: a session that ended cannot consent to anything, so "ask first" resolves to
// "never ship it", and the work rots in a local ref until somebody runs a batch reconciliation —
// which rule 5 exists to say is the worse failure.
//
// SO THE DEFAULT IS INVERTED. Committing to this repository IS consent for anyone to push,
// rebase, cherry-pick, merge and tag that commit into a deploy, at any moment, without
// consulting the author. Not a convention people are asked to remember: the absence of a hold is
// the consent, so the common path requires nobody to do anything.
//
// THE EXCEPTION IS A TRAILER WITH A MANDATORY REASON, shaped after fleetScript's `unsafe` for
// the same argument — people who did not write the rule have to be able to work here, and some
// commits genuinely must not ship yet (a half-landed protocol change, a schema whose migration
// is on another branch). So it is sayable, in the commit itself, where it travels with the work
// and needs no second file to stay in sync:
//
//     Release-Hold: the matching keeper change is not landed; shipping this alone logs out t9
//
// A reason is mandatory and the refusal quotes it, because "I know this must not ship" and "I
// typed a trailer" have to look different to the next person, who will be holding a roll.
//
// A MALFORMED HOLD IS A HOLD. `Release-Hold` with no reason, or `Release Hold`, or a bare
// `Release-Hold:` — anything that looks like somebody reaching for this and missing — refuses.
// The failure directions are not symmetric: reading a typo as CONSENT ships something its author
// tried to stop, silently and with no way to notice, while reading it as a hold costs one person
// one minute and a clearer commit message. Rule 4: a guarantee that cannot be evaluated refuses.
//
// BUT AN EXAMPLE IS NOT A DECISION, AND THAT COST TEN MINUTES TO LEARN. The very commit that
// introduced this feature quoted the trailer in its own message to explain it — and `--verify`
// immediately refused to release it, correctly, by its own rule. Left alone, every commit that
// documents this would block itself, and "a refusal that fires on a healthy tree is one people
// learn to type past" is the argument this whole file is built on.
//
// So a hold must be FLUSH LEFT, which is git's own convention for a trailer, and lines inside a
// fenced block are skipped entirely. Somebody genuinely holding a commit writes the trailer at
// column 0; somebody quoting it indents it or fences it, the way that commit did. That is a
// distinction the writer makes naturally without being taught it, which is the only kind of
// convention worth relying on.

// TWO FORMS, AND THEY GET DIFFERENT BENEFIT OF THE DOUBT — because commit messages here are
// long prose that discusses releases constantly, and a parser that seizes a roll over the
// sentence "do not release the lock until the keeper answers" is a parser somebody switches off.
//
//   PUNCTUATED  `Release-Hold`, `Release_Hold`, `Do-Not-Release` — nobody writes those in a
//               sentence, so they are ALWAYS a hold. A missing colon is a typo, not prose.
//   SPACED      `Release Hold`, `Do not release` — ordinary English, so these count only when
//               a colon immediately follows, which is somebody writing a trailer on purpose.
//
// Both are anchored FLUSH LEFT — no leading whitespace — because an indented line is somebody
// quoting the trailer, not writing one. See the note above about the commit that held itself.
const HOLD_PUNCTUATED = /^(?:release[-_]hold|do[-_]not[-_]release|donotrelease)[ \t]*:?(.*)$/gim;
const HOLD_SPACED = /^(?:release[ ]hold|do[ ]not[ ]release)[ \t]*:(.*)$/gim;

// Lines inside a ``` fence are quoted material. Blanked rather than removed so that nothing
// downstream depends on line numbers shifting.
function stripFences(text) {
  let inFence = false;
  return text.split('\n').map(line => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return ''; }
    return inFence ? '' : line;
  }).join('\n');
}

/**
 * Does this commit message hold itself back from a release?
 *
 * @param {string} body the commit message (subject and body; trailers live in the body)
 * @returns {{held: boolean, reason: string|null, malformed: boolean}}
 *   `held` false and `malformed` false is the ordinary case: consent, by silence.
 *   `held` true with a reason is a deliberate hold.
 *   `held` true with `malformed` is something that reached for a hold and did not land it —
 *   refused for the same reason, and reported differently so it can be fixed.
 */
export function parseHold(body) {
  const text = stripFences(String(body ?? ''));
  let best = null;
  for (const re of [HOLD_PUNCTUATED, HOLD_SPACED]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const reason = (m[1] || '').trim().replace(/^[:\-–—]\s*/, '').trim();
      // Keep the first WELL-FORMED one; otherwise remember that something reached for it.
      if (reason) return { held: true, reason, malformed: false };
      best = { held: true, reason: null, malformed: true };
    }
  }
  return best ?? { held: false, reason: null, malformed: false };
}

/**
 * Which of these commits refuse to be released.
 *
 * @param {Array<{sha?: string, subject?: string, body?: string}>} commits
 * @returns {Array<{sha: string, subject: string, reason: string|null, malformed: boolean}>}
 */
export function holdsIn(commits) {
  const out = [];
  for (const c of commits ?? []) {
    // The whole message is searched, not just a trailer block: a hold written into the body by
    // hand is still somebody saying do not ship this, and a parser that only honours a
    // well-placed trailer is a parser that ignores the message on a technicality.
    const h = parseHold(`${c?.subject ?? ''}\n${c?.body ?? ''}`);
    if (h.held) out.push({
      sha: String(c?.sha ?? '').slice(0, 9),
      subject: String(c?.subject ?? '').slice(0, 80),
      reason: h.reason,
      malformed: h.malformed,
    });
  }
  return out;
}

/**
 * The sentences a refusal should print. Separate from `holdsIn` so the wording can be tested
 * without a git tree, and so the tool has no second copy of it to drift.
 */
export function holdRefusals(holds) {
  return (holds ?? []).map(h => h.malformed
    ? `${h.sha} looks like it is trying to hold itself back from a release but gives no reason ` +
      `("${h.subject}"). A hold needs one, because a typo and a decision have to look different. ` +
      `Fix the message (git commit --amend / git rebase -i) or remove the line.`
    : `${h.sha} asks not to be released: ${h.reason} ("${h.subject}"). Everything else here is ` +
      `pre-authorised by its author having committed it; this one is not. Land whatever it is ` +
      `waiting for, or cut the tag at its parent.`);
}
