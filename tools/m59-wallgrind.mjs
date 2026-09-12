// IS THIS CHARACTER GRINDING AGAINST A WALL, AND FOR HOW LONG — a pure decision, so it can
// be checked without a server and replayed against a recording made months ago.
//
// THE QUESTION THE FLEET COULD NOT ANSWER. Operator, 2026-09-11: *"are units just grinding
// against walls for hours?"* Everything this repository records about being stuck is a POINT
// EVENT — `stuck_backed_up` fires once when the workaround fires, `m59-stucks.mjs` groups those
// by square. That answers "how often" and never "for how long", and the two have different
// fixes: forty bounces in a minute is a rail that wants moving, forty minutes of continuous
// contact is a character that has been standing in a corner since before lunch.
//
// So this emits EPISODES — a `begin`, an `end`, and the duration between them — rather than
// ticks. That is the whole difference.
//
// TWO SHAPES, AND THE SECOND IS THE ONE NOTHING COULD SEE.
//
//   CONTACT   The mover asks for a step, the geometry refuses it, and the character stays put.
//             Repeated against the same square this is a wall being leaned on.
//
//             AND IT IS CURRENTLY NEARLY BLIND, WHICH THE READER MUST BE TOLD RATHER THAN LEFT
//             TO INFER FROM A ZERO. Six hours of prod produced 330 shuffles and ZERO contacts.
//             That is not a clean road. `m59-roo.mjs` returns `{ blocked: true, slid: moved }`
//             — the stock client SLIDES along the first blocking wall rather than refusing —
//             and this detector is fed from `terminalMovement`, which sees only the
//             collision-contract class. A SLIDE IS NOT A REFUSAL, so ordinary wall contact
//             never reaches the hook. The rail session measured mean slide fractions of 0.86
//             on a bad aim against 0.06 on a good one, which is the scale of what is invisible.
//
//             Fixing it means a hook at the mover's step result rather than at the terminal
//             seam. Until then `wall_contact: 0` means NOT MEASURED, and `m59-grinds.mjs` says
//             so in the report rather than letting the number speak.
//
//   SHUFFLE   The character alternates between two or three squares, for ever, going nowhere.
//             CLAUDE.md has carried the warning for months — *"a stall detector that requires
//             STILLNESS misses the commonest way to stand still: a two-square shuffle against a
//             wall resets it on every sample"* — and on 2026-09-11 a search of all 651 tools for
//             "oscillat" returned ZERO. The blind spot was documented and uninstrumented.
//
// WHY A SHUFFLE IS MEASURED BY REVISITS AND NOT BY DISTANCE, OR EVEN BY DISTINCT SQUARES.
//
// The obvious test is "has it moved far enough", and it is wrong: a character crossing a room
// legitimately passes through squares slowly, while a wedged one covers real distance bouncing.
// The second-obvious test is "how many distinct squares in the window", and THAT IS WRONG TOO —
// it was written first and the test suite caught it. A character moving one square every three
// samples shows two or three distinct squares in any six-sample window, exactly like a shuffle,
// so honest slow progress was flagged and the episode never closed.
//
// The thing that actually separates them is whether the body GOES BACK. A simple path through
// k distinct squares has exactly k-1 transitions between them; every revisit adds one more. So
// `transitions > distinct - 1` means the character returned to somewhere it had already been,
// which is the definition of oscillating and is false for any forward walk however slow:
//
//   A B A B A B   distinct 2, transitions 5  ->  5 > 1   shuffle
//   A A A B B B   distinct 2, transitions 1  ->  1 > 1   slow progress, not a shuffle
//   A B C D E F   distinct 6, transitions 5  ->  5 > 5   a walk, not a shuffle
//
// AND IT ONLY COUNTS WHILE THE CHARACTER IS TRYING TO GET SOMEWHERE. A character standing in
// an inn is not grinding, it is resting; one holding a safe wall on purpose is doing the thing
// the safe-wall rule asks of it. Both look identical to a position sampler. `destination` is
// what tells them apart, and a sample without one is dropped rather than guessed at — the same
// rule `m59-which.mjs` follows, where a question that cannot be answered is not an answer.

// A window long enough to see a pattern and short enough to still be about NOW. Six samples at
// roughly a second each is five seconds — deliberately the same width as the autopilot's own
// `PULSE_SAMPLES` ring, because that ring is where these samples come from and two different
// widths for one question is how `pennedIn` nearly got switched off by a careless widening.
export const WINDOW = 6;
// How few distinct squares in that window can count as going nowhere. Two is the documented
// shuffle; three catches the triangle version, which is the same failure with more corners.
// This is a CEILING and not the test — see the revisit rule above, which is.
export const SHUFFLE_MAX_SQUARES = 3;
// A single refused step is ordinary — a body in the way, a door that wants the exact square.
// It becomes an episode when it repeats, because the thing worth recording is persistence.
export const CONTACT_MIN_REFUSALS = 3;
// A GAP IN THE SAMPLES IS A NEW STREAM, NOT A LONG EPISODE — and getting this wrong inflates
// the exact number the tool exists to report.
//
// Samples arrive about a second apart while a keeper is running. They stop when it restarts
// (about once a minute), when the character logs out, and whenever a pass blocks — and this
// fleet's passes block for twenty seconds at a time. Carrying the ring across such a gap dates
// an episode's `began` to before it, so a ninety-second shuffle is reported as fifty minutes.
// Caught by the end-to-end check on 2026-09-11, where exactly that happened.
//
// Ten seconds is several pulses — long enough that an ordinary hitch does not split a real
// episode in two, short enough that a keeper restart always does. An episode split across a
// gap is reported as two, which is the honest reading: nobody watched the middle.
export const GAP_MS = 10_000;

const sq = s => `${s?.room}:${s?.row},${s?.col}`;

/**
 * Feed position samples in, get episodes out.
 *
 * A sample is `{ at, room, row, col, refused, destination, doing }`. `refused` is the mover's
 * own reason string when a step was declined and null when it was not; `destination` is the
 * room the character is trying to reach, or null when it is not trying to go anywhere; `doing`
 * is the keeper's own word for what it is up to.
 *
 * WHY `doing` IS CARRIED, AND IT IS THE DIFFERENCE BETWEEN DESCRIBING AND DIAGNOSING. The first
 * version recorded where and how long and nothing else. Six hours of prod later it had 330
 * shuffles, 54 of 57 minutes of them inside the two farm rooms — and the worst square, 39
 * r7c27, turned out to be geometrically perfect: one floor level, uniform across 256 sample
 * points, all eight headings accepted at 64, 256 and 512 units. So it is not a cliff, not a
 * ledge and not a wall, and the instrument could not say what it WAS, because it never recorded
 * what the character was trying to do. An episode that cannot name the intent it interrupted
 * is a description; with the intent it is a bug report.
 *
 * Episodes come back as `{ kind, room, row, col, began, ended, ms, samples, reason, squares }`.
 * Nothing is emitted until an episode ENDS, because an episode without a duration is the
 * point event this exists to replace.
 */
export function makeTracker({ window = WINDOW, shuffleMax = SHUFFLE_MAX_SQUARES,
                              minRefusals = CONTACT_MIN_REFUSALS, gapMs = GAP_MS } = {}) {
  let ring = [];
  let lastAt = null;
  let contact = null;      // the open contact episode, if any
  let shuffle = null;      // the open shuffle episode, if any
  const out = [];

  const closeContact = (at) => {
    if (!contact) return;
    // AN EPISODE SHORTER THAN ITS OWN THRESHOLD NEVER HAPPENED. The counter opens on the first
    // refusal so the `began` timestamp is honest, but one or two refusals is weather and
    // emitting them would bury the real ones — which is the failure mode of every alert that
    // gets switched off.
    if (contact.refusals >= minRefusals) {
      out.push({ kind: 'wall_contact', room: contact.room, row: contact.row, col: contact.col,
                 began: contact.began, ended: at, ms: at - contact.began,
                 samples: contact.samples, reason: contact.reason, squares: 1,
                 doing: contact.doing ?? null });
    }
    contact = null;
  };

  const closeShuffle = (at) => {
    if (!shuffle) return;
    // EVERY INTENT SEEN DURING THE EPISODE, not just the one it ended on. A loop that
    // alternates between two decisions is the hypothesis this field exists to test, and
    // recording only the last one would hide exactly that.
    out.push({ kind: 'shuffle', room: shuffle.room, row: shuffle.row, col: shuffle.col,
               began: shuffle.began, ended: at, ms: at - shuffle.began,
               samples: shuffle.samples, reason: null, squares: shuffle.squares.size,
               doing: [...shuffle.doing].filter(Boolean).sort().join('+') || null });
    shuffle = null;
  };

  return {
    /** One sample. Returns any episodes that ENDED on this sample. */
    push(s) {
      const before = out.length;
      const at = Number(s?.at);
      if (!Number.isFinite(at)) return [];

      // The stream stopped and started again. Close what was open AT ITS OWN LAST SAMPLE --
      // not at `at`, which would charge the episode for the whole silence -- and begin afresh.
      if (lastAt != null && at - lastAt > gapMs) {
        closeContact(lastAt); closeShuffle(lastAt); ring = [];
      }
      lastAt = at;

      // NOT TRYING TO GO ANYWHERE IS NOT GRINDING. Close whatever is open and forget the
      // history: a character that stops travelling and starts again later is two episodes,
      // and joining them across the gap would report a rest as an hour against a wall.
      if (s.destination == null) {
        closeContact(at); closeShuffle(at); ring = [];
        return out.splice(before);
      }

      // ---- contact: same square, mover refusing
      if (s.refused) {
        if (contact && contact.key === sq(s)) {
          contact.refusals += 1; contact.samples += 1;
        } else {
          closeContact(at);
          contact = { key: sq(s), room: s.room, row: s.row, col: s.col, began: at,
                      refusals: 1, samples: 1, reason: String(s.refused), doing: s.doing ?? null };
        }
      } else if (contact) {
        // A step that LANDED ends the contact, wherever it landed. Leaning on a wall and then
        // moving off it is exactly the episode boundary this is for.
        closeContact(at);
      }

      // ---- shuffle: moving, but around the same two or three squares
      ring.push(s);
      if (ring.length > window) ring.shift();
      if (ring.length === window) {
        const keys = ring.map(sq);
        const squares = new Set(keys);
        // Transitions, not samples: standing still for three samples is one place, not three.
        let transitions = 0;
        for (let i = 1; i < keys.length; i++) if (keys[i] !== keys[i - 1]) transitions += 1;
        const moved = squares.size > 1;              // a still body is the OTHER detector's job
        const revisits = transitions > squares.size - 1;
        if (moved && revisits && squares.size <= shuffleMax) {
          if (shuffle) { shuffle.samples += 1; for (const k of squares) shuffle.squares.add(k);
                         if (s.doing) shuffle.doing.add(s.doing); }
          else shuffle = { room: s.room, row: s.row, col: s.col, began: ring[0].at,
                           samples: window, squares: new Set(squares),
                           doing: new Set(ring.map(x => x.doing).filter(Boolean)) };
        } else if (shuffle) {
          closeShuffle(at);
        }
      }
      return out.splice(before);
    },

    /**
     * The stream stopped — the character logged out, the keeper restarted, the recording ended.
     * Close what is open rather than losing it. A keeper restarts about once a minute, so
     * dropping open episodes would systematically discard exactly the long ones this is for.
     */
    flush(at) {
      const before = out.length;
      const t = Number(at) || (ring.length ? ring[ring.length - 1].at : 0);
      closeContact(t); closeShuffle(t); ring = []; lastAt = null;
      return out.splice(before);
    },

    /** What is open right now, for a live board. Never used to decide anything. */
    open() {
      return {
        contact: contact ? { ...contact, squares: undefined } : null,
        shuffle: shuffle ? { room: shuffle.room, began: shuffle.began,
                             squares: shuffle.squares.size } : null,
      };
    },
  };
}

/**
 * Roll episodes up into the thing that is kept for ever.
 *
 * THE RETENTION ARGUMENT, BECAUSE IT IS THE POINT OF THE WHOLE FILE. Operator: fine data need
 * not outlive 24 hours. Agreed for traces — they are large and they are about a moment. But the
 * stated goal is *"look back at historical movement code through newer analysis lenses"*, and a
 * window that drops everything after a day cannot answer a question asked next month.
 *
 * So: traces expire, AGGREGATES DO NOT, and every aggregate is keyed by the `#movement` epoch
 * that produced it. That is what makes "was this worse before that commit" a lookup instead of
 * an argument — and it is the same mechanism the exit-gap book already uses, for the same
 * reason: a counter that spans a rewrite of the mover is a monument, not a measurement.
 *
 * THE HONEST LIMIT, STATED HERE SO NOBODY IS SURPRISED BY IT LATER: an aggregate answers only
 * questions somebody thought of in advance. A lens invented next month cannot be applied to a
 * bucket; it can only be applied to a RECORDING. That is why the scratch space keeps fixtures
 * as well as counts, and why "keep more fixtures" is the real answer to the operator's ask.
 */
export function aggregate(episodes = [], { epoch = null } = {}) {
  const buckets = new Map();
  for (const e of episodes) {
    if (!e || !Number.isFinite(e.ms)) continue;
    const key = [epoch ?? 'unknown', e.kind, e.room, e.row, e.col, e.reason ?? ''].join('|');
    let b = buckets.get(key);
    if (!b) {
      b = { epoch: epoch ?? 'unknown', kind: e.kind, room: e.room, row: e.row, col: e.col,
            reason: e.reason ?? null, count: 0, ms_total: 0, ms_max: 0, samples: [] };
      buckets.set(key, b);
    }
    b.count += 1; b.ms_total += e.ms; b.ms_max = Math.max(b.ms_max, e.ms);
    b.samples.push(e.ms);
  }
  // p50 and p90 rather than a mean, because these distributions are the shape where a mean
  // lies: hundreds of two-second bounces and one forty-minute grind average to nothing
  // remarkable, and the forty-minute one is the entire finding.
  for (const b of buckets.values()) {
    const s = b.samples.sort((x, y) => x - y);
    b.ms_p50 = s[Math.floor(s.length * 0.5)] ?? 0;
    b.ms_p90 = s[Math.floor(s.length * 0.9)] ?? s[s.length - 1] ?? 0;
    delete b.samples;
  }
  return [...buckets.values()].sort((a, b) => b.ms_total - a.ms_total);
}
