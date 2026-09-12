// WAS THIS ROW WATCHED, OR WAS IT INFERRED FROM TWO POLLS? A pure classification, because
// the answer decides what the row may be used for and nothing currently says it out loud.
//
// THE FAILURE THIS EXISTS FOR, 2026-09-12. I measured that `level_lost` rows lag the death
// that caused them by a median of 5.0 minutes, concluded there was a second source, and was
// wrong — there is no second source and no death source either. `level_lost` is a SAMPLED
// DIFF: `m59-ledger.mjs:186` fires it when the polled `level` field is lower than it was last
// poll. The lag is the poll interval, and the p90 is 704 minutes because a character nobody
// sampled for eleven hours gets its diff whenever sampling resumes.
//
// I had already published "forty-nine deaths, forty-nine levels, no exceptions" off a
// three-day window that happened to sit inside the graduated period. Another session put that
// sentence into a code comment before I caught it. The rule that would have stopped both of us
// is one line and it now lives here rather than in one tool's header:
//
//     COUNT SAMPLED ROWS PER CHARACTER. NEVER JOIN THEM BY TIME.
//
// AND `died` IS NOT THE RELIABLE ANCHOR I TOOK IT FOR. It is emitted on a poll too — the
// keeper's death signature changing is what triggers it — so its TIMESTAMP is sample time.
// Its CONTENT is different: the keeper reconstructs where, against what, at what health, and
// stamps that. So the fields are trustworthy and the clock is not, which is a combination
// nothing in the repository distinguished before this file.
//
// WORSE, AND MEASURED ON PROD: of 895 `died` rows, 85% are keeper-reconstructed, 8% carry
// `note: "inferred from sampling"` — no killer, no room, no health trail, written by a
// fallback when the signature never arrived — and 7% are `detail_missing`, caught mid-fill.
// FIFTEEN PER CENT OF DEATH ROWS ARE DEGRADED and nothing downstream can tell. That matters
// most to the one rule this repository will not bend: the critic requires PVP to be SHOWN, a
// named non-fleet player and never an unresolved id. An inferred row has no killer at all, and
// "no killer" read as a fact rather than as an absence is how six trolls became a PVP death.
//
// THE THIRD ANSWER IS THE POINT. `m59-which.mjs` earned it — a port that does not answer is a
// question, not a fleet — and the same shape applies here: a row whose fidelity cannot be
// determined is `unknown`, never `observed`, because the coercion runs one way and it is the
// expensive way.

/** How a row came to exist. */
export const OBSERVED = 'observed';   // the server said so; the row carries what it said
export const SAMPLED = 'sampled';     // derived by diffing two polls; the clock is the poller's
export const COMPUTED = 'computed';   // derived from other rows or from the kod, not from a poll
export const UNKNOWN = 'unknown';     // this file does not know, and says so

// The poll interval the fleet ledger samples at. Written down because every consequence below
// is measured in it: a sampled row's timestamp is accurate to ONE OF THESE and no better.
export const SAMPLE_MS = 5 * 60_000;

// EVERY KIND THIS FILE HAS ACTUALLY CHECKED, and deliberately not a guess for the rest. The
// ledger carries dozens of kinds; an entry here means somebody read the emitter.
const KINDS = Object.freeze({
  // --- sampled diffs. m59-ledger.mjs compares this poll's fleet row against last poll's.
  level_up: { how: SAMPLED, why: 'polled `level` rose since the last sample' },
  level_lost: { how: SAMPLED, why: 'polled `level` fell since the last sample — NOT a death event' },
  strategy_changed: { how: SAMPLED, why: 'polled strategy differs from the last sample' },

  // --- emitted on a poll, but carrying reconstructed content. The split that matters.
  died: { how: SAMPLED, why: 'fired when the keeper\'s death signature changes at a poll; the ' +
                             'FIELDS are reconstructed by the keeper and trustworthy, the ' +
                             'TIMESTAMP is when the poller noticed',
          fieldsObserved: true },

  // --- observed: written at the moment the thing happened, by the code that did it.
  killed: { how: OBSERVED, why: 'written when the kill was seen' },
  looted: { how: OBSERVED, why: 'written when the item was taken' },
  cast: { how: OBSERVED, why: 'written by the cast path' },
  cast_declined: { how: OBSERVED, why: 'written by the refusal itself' },
  fought_back: { how: OBSERVED, why: 'written by the fight-back edict when it fired' },
  stuck_backed_up: { how: OBSERVED, why: 'written by the back-up workaround when it fired' },
  wall_contact: { how: OBSERVED, why: 'an episode closed by the keeper pulse; carries its own began/ended' },
  shuffle: { how: OBSERVED, why: 'an episode closed by the keeper pulse; carries its own began/ended' },
  learn_attempt: { how: OBSERVED, why: 'written by the learn verb around the counter' },
});

/** How this kind came to exist. Unknown kinds answer `unknown`, never `observed`. */
export function evidenceKind(kind) {
  const hit = KINDS[String(kind ?? '')];
  return hit ? hit.how : UNKNOWN;
}

/** The sentence explaining it, for a report that has to justify refusing something. */
export function why(kind) {
  const hit = KINDS[String(kind ?? '')];
  return hit ? hit.why : `"${kind}" is not classified here — read its emitter before trusting its clock`;
}

/**
 * May these rows be correlated BY TIME?
 *
 * Refuses on sampled rows, which is the whole point. `died` and `level_lost` are both sampled,
 * so the five-minute gap between them is the poller's cadence rather than anything the game
 * did — and an analysis that reads it as causation is measuring the instrument.
 */
export function joinableByTime(...kinds) {
  const bad = kinds.filter(k => evidenceKind(k) !== OBSERVED);
  if (!bad.length) return { ok: true };
  return {
    ok: false,
    kinds: bad,
    why: `${bad.map(k => `\`${k}\``).join(' and ')} ` +
         `${bad.length > 1 ? 'are' : 'is'} not observed — ` +
         bad.map(k => why(k)).join('; ') +
         `. A sampled row's timestamp is accurate to one poll (${SAMPLE_MS / 60_000}m) and no ` +
         'better. Count them per character instead.',
  };
}

/**
 * How good is THIS died row, as opposed to the kind in general?
 *
 * `reconstructed` — the keeper rebuilt the death and the fields mean something.
 * `inferred`      — a fallback wrote it from two samples. No killer, no room, no health trail.
 * `thin`          — the signature changed before `last_death` was filled; caught mid-write.
 *
 * MEASURED ON PROD 2026-09-12: 758 / 76 / 61 of 895. Anything reading `killed_by` must check
 * this first, because on an inferred row a null killer means "nobody watched" and not "nothing
 * killed it".
 */
export function deathFidelity(row = {}) {
  if (row?.kind && row.kind !== 'died') return UNKNOWN;
  if (row?.note === 'inferred from sampling') return 'inferred';
  if (row?.detail_missing) return 'thin';
  if (row?.killed_by !== undefined || row?.health_trail !== undefined) return 'reconstructed';
  return UNKNOWN;
}

/** Is this row's `killed_by` an ANSWER, or an absence wearing one? */
export function killerIsMeaningful(row = {}) {
  const f = deathFidelity(row);
  if (f === 'reconstructed') return { ok: true, fidelity: f };
  return { ok: false, fidelity: f,
           why: f === 'inferred'
             ? 'this row was inferred from sampling: it has no killer because nobody watched, ' +
               'which is not the same fact as "killed by nothing"'
             : f === 'thin'
               ? 'the death signature changed before the detail was filled in; the fields are absent, not empty'
               : 'fidelity could not be determined — treat the killer as unknown' };
}
