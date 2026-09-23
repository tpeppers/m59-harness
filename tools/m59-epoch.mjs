#!/usr/bin/env node
// WHICH CODE PRODUCED THIS EVIDENCE, AND IS IT STILL THE CODE IN PLAY.
//
//   node tools/m59-epoch.mjs              what every domain's epoch is right now
//   node tools/m59-epoch.mjs --json       the same, for a tool
//
// EVERY LEDGER IN THIS REPOSITORY IS A MEASUREMENT OF CODE THAT HAS SINCE CHANGED.
//
// The exit-gap book is where it was caught. Ukgoth's north door read `refused 182,
// crossings 0` — a boundary that had never once been crossed — on a day when that same
// door was crossing in three seconds, six times out of six. Every one of those 182
// refusals was real. None of them was about the code then running, and the number could
// not come down, because a counter that only increments is not a measurement, it is a
// monument. It sends somebody to repair a door that works and buries the one that broke
// this morning under five days of history.
//
// The tactics ledger had the same disease with a different symptom. Asked "what fraction
// of crossings ride a baked rail", the file answered 27% over five days and 48% over the
// last ninety minutes — because a third of the file is a lookup bug that was fixed days
// ago. Reading the whole thing made a solved problem look like the dominant one.
//
// A TIME WINDOW IS THE WRONG FIX, AND IT WAS THE FIRST ONE TRIED HERE. "Older than 48
// hours" is a guess about how fast this repository changes, and it is wrong in both
// directions at once: evidence from a quiet fortnight is still good, and evidence from
// four hours ago is worthless if the mover was rewritten in between. The clock does not
// know what changed. The commit does.
//
// SO EVIDENCE IS SCOPED TO A DECLARED CODE EPOCH, AND THE DECLARATION IS A COMMIT MESSAGE.
//
//     git commit -m "edge exits: walk forward into the spur, not feel for the doorway
//
//     #movement"
//
// A commit whose message carries `#movement` says: how this fleet moves is different from
// here on, so movement evidence recorded before this commit no longer describes the code.
// Ledgers keyed on the movement epoch reset themselves at that commit and start measuring
// the thing that is actually running.
//
// THE PRECEDENT IS STEP_MASK_VERSION, and it is worth reading (m59-roo.mjs). A baked step
// mask is verified against `geometryManifestSha256`, which hashes the GEOMETRY — so a mask
// baked by different CODE against the same map "matches perfectly and is attached without
// a word", and once silently kept the fleet out of 773 steps per room. The answer there
// was a hand-bumped version number rather than a hash, for exactly the reason a hash
// cannot work: only the author knows whether a change to the code changed its MEANING.
// `#movement` is that same declaration, moved from a constant into the commit that makes
// the change, so it cannot be forgotten in a different file.
//
// WHY NOT JUST HASH THE FILES. Because most commits to `m59-game.mjs` are comments, a
// rename, or a fix to something else in an 18,000-line file, and invalidating every
// measurement for those would train everybody to ignore the mechanism. The author says
// when the meaning changed. That is the whole point.
//
// BUT AN UNCOMMITTED EDIT IS ITS OWN EPOCH, and this is not a caveat, it is the common
// case: the movement code is being changed right now, by somebody who has not committed
// yet, and that is precisely when evidence goes stale fastest. So a working tree that
// differs from HEAD in any file the domain owns gets its own epoch id, derived from the
// content of those files. Nobody has to remember anything for that half to work.
//
// NEVER ON THE HOT PATH. `git` is a subprocess and this is called from inside a walk that
// twenty-one sessions share an event loop with. The answer is computed once per process
// and memoised, with a short timeout, and every failure path returns `null` — which means
// "this checkout cannot say", and every consumer falls back to whatever it did before.
// A clone with no `.git` must behave exactly as it always has.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// WHICH FILES A DOMAIN OWNS, and the list is deliberately generous. A file listed here
// only ever costs a false invalidation — evidence discarded that was still good — and a
// file MISSING costs the thing this exists to prevent: a measurement that outlives its
// subject and is believed. When in doubt, list it.
//
// Adding a domain is one entry plus a tag nobody has to configure anywhere else.
export const DOMAINS = Object.freeze({
  movement: Object.freeze({
    tag: '#movement',
    files: Object.freeze([
      'tools/m59-game.mjs',       // leaveVia, walkTo, walkFine, step, followRail, railAcross
      'tools/m59-session-walk.mjs',
      'tools/m59-door-wait.mjs',
      'tools/m59-ceiling-doors.mjs',
      'tools/m59-guild-passage.mjs',
      'tools/m59-movement.mjs',   // the terminal reasons and the packet validator
      'tools/m59-roo.mjs',        // the collision model, step masks, edge crossings
      'tools/m59-routes.mjs',     // the baked table and its accessors
      'tools/m59-routebake.mjs',  // what goes into that table
      'tools/m59-finepath.mjs',   // fine pathing
      'tools/m59-world.mjs',      // exits(), the candidate ranking, wrongExitSquares
      'tools/m59-autopilot.mjs',  // survival movement ownership and replacement choices
      'tools/m59-skills.mjs',     // shelter arrival and cancellation propagation
      'tools/m59-recovery-refuge.mjs',
      'tools/m59-survival-decision.mjs',
    ]),
  }),
  // THE SAFE-SPOT BOOK IS EVIDENCE ABOUT A DEFINITION, AND THE DEFINITION MOVES.
  //
  // Added 2026-08-27 at the operator's instruction, and the reason is a mistake this
  // repository nearly reasoned from an hour earlier: asked whether resting on the road could
  // have prevented 37 deaths, the book was read and answered `held: 0, failed: 180` across
  // the five corridor rooms. Every one of those rows was recorded under a definition of
  // "safe spot" that was already being replaced, so the honest answer to the question was
  // not "the spots do not hold" — it was "this book cannot say".
  //
  // A held/failed tally is a measurement of the PREDICATE that chose the square, exactly as
  // a step mask is a measurement of the predicate that chose the door (STEP_MASK_VERSION,
  // m59-roo.mjs). When the predicate changes, the tallies are about a different question and
  // no amount of them adds up to an answer about this one.
  safespots: Object.freeze({
    tag: '#safespots',
    files: Object.freeze([
      'tools/m59-safespots.mjs',  // what counts as one, and the book itself
      'tools/m59-roo.mjs',        // safeWalls() — the geometry the definition rests on
    ]),
  }),
});

const git = (args) => {
  try {
    return execFileSync('git', args, { windowsHide: true,
      cwd: REPO, encoding: 'utf8', timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
};

const cache = new Map();

/**
 * The epoch for one domain, or a `{ id: null }` shape when this checkout cannot say.
 *
 * `id` is what a ledger row stores and what two rows are compared on. Everything else is
 * for a human reading a report: which commit declared it, what that commit said, and
 * whether the tree has drifted from it since.
 */
export function epochFor(domain = 'movement', { refresh = false } = {}) {
  if (!refresh && cache.has(domain)) return cache.get(domain);
  const spec = DOMAINS[domain];
  const answer = { domain, id: null, ref: null, subject: null, at: null, dirty: false, why: null };
  if (!spec) { answer.why = `no such domain "${domain}"`; cache.set(domain, answer); return answer; }
  try {
    // `--fixed-strings` because the tag contains `#`, and a tag read as a regex is a tag
    // that matches things nobody wrote.
    const line = git(['log', '-1', '--fixed-strings', `--grep=${spec.tag}`,
                      '--format=%H%x00%s%x00%cI']);
    if (line) {
      const [ref, subject, at] = line.split('\0');
      answer.ref = ref; answer.subject = subject; answer.at = at;
    } else {
      // NO DECLARATION YET IS NOT "NO EPOCH". A repository that has never used the tag
      // still has a code identity, and pinning it to HEAD means the mechanism starts
      // working the day somebody adopts it rather than the day they backfill history.
      const head = git(['rev-parse', 'HEAD']);
      if (!head) { answer.why = 'not a git checkout, or git is unavailable'; cache.set(domain, answer); return answer; }
      answer.ref = head;
      answer.subject = `(no ${spec.tag} commit yet — pinned to HEAD)`;
      answer.at = git(['log', '-1', '--format=%cI']) || null;
    }
    // AND THE UNCOMMITTED HALF. `--` limits the status to the files this domain owns, so
    // editing a doc or another subsystem does not throw movement evidence away.
    const status = git(['status', '--porcelain', '--', ...spec.files]);
    if (status) {
      answer.dirty = true;
      const h = createHash('sha256');
      for (const rel of spec.files) {
        try { h.update(readFileSync(join(REPO, rel))); } catch { h.update('\0missing\0'); }
      }
      answer.id = answer.ref.slice(0, 12) + '+' + h.digest('hex').slice(0, 8);
    } else {
      answer.id = answer.ref.slice(0, 12);
    }
  } catch (e) {
    answer.why = `could not read the code epoch: ${e.message}`;
  }
  cache.set(domain, answer);
  return answer;
}

/** The bare id a ledger row stores, or null when this checkout cannot say. */
export const epochId = (domain = 'movement') => epochFor(domain).id;

/**
 * IS THIS ROW STILL ABOUT THE CODE IN PLAY.
 *
 * Three answers, and the third is the one that keeps a fresh clone working: true, false,
 * and `null` for "cannot say" — which a caller must treat as "keep whatever rule you had",
 * never as stale. A checkout with no git must lose no evidence at all.
 */
export function sameEpoch(rowEpoch, domain = 'movement') {
  const now = epochId(domain);
  if (now == null || rowEpoch == null) return null;
  return rowEpoch === now;
}

if (process.argv[1] && process.argv[1].endsWith('m59-epoch.mjs')) {
  const out = Object.keys(DOMAINS).map(d => epochFor(d));
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
  else for (const e of out) {
    console.log(`${e.domain.padEnd(10)} ${e.id ?? '(cannot say — ' + e.why + ')'}`);
    if (e.ref) console.log(`           declared by ${e.ref.slice(0, 12)}  ${e.at ?? ''}`);
    if (e.subject) console.log(`           ${e.subject}`);
    if (e.dirty) console.log(`           WORKING TREE DIFFERS — uncommitted ${DOMAINS[e.domain].tag} code is its own epoch`);
  }
}
