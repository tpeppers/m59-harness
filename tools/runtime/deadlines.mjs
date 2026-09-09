// WORK NOBODY IS WAITING FOR ANY MORE.
//
// Every caller of this broker sets a timeout and none of them tell the broker what it is.
// `AbortSignal.timeout(2500)` hangs up on the socket; it does not reach across and cancel
// anything. So the broker computes the whole answer — for a 21-character fleet a `/health`
// enumerates every session — and finds nobody there. Under load that is not merely wasted:
// it is wasted at exactly the moment the queue is longest, which makes the next caller
// slower, which makes IT hang up, and so on.
//
// It has bitten this repository in at least four places on one day:
//
//   * the Quartermaster polled at a flat 1Hz with 2.5s/3.5s aborts against a broker measured
//     at 1046ms idle and 2573ms under load, so under load every single poll was thrown away
//   * `m59-which.mjs` read a slow `/health` as "no answer" and named the wrong fleet, roughly
//     one run in four
//   * the RTS gateway serves nothing versioned for 30s after missing its 3s aggregate
//   * `m59-friendly-reboot` reported `unknown` for eleven of twenty-one characters because
//     twenty-one parallel reads ate an eight-second budget against a recovering broker
//
// THE FIX IS TO TELL THE BROKER THE DEADLINE AND LET IT DECLINE. A request that arrives with
// 300ms left against a tool whose p90 is 2.4 seconds is not going to be answered in time
// whatever anyone does; the only question is whether the broker finds that out before or
// after doing the work. Declining costs nothing and leaves the queue shorter for the caller
// who CAN still be served.
//
// DECLINING IS NOT FAILING, and the difference has to survive to the caller. A refusal here
// means "not attempted, and here is why" — the caller may retry with a longer budget, and
// nothing was half-done. That is the opposite of a timeout, which leaves you knowing neither.

// Rolling per-tool durations. Bounded, because this is a hint for scheduling and not a
// metrics system: sixty-four samples is enough for a stable p90 and small enough that a
// tool whose cost changes is believed again quickly.
const SAMPLES = 64;
const seen = new Map();

/** Record how long a tool actually took. Never throws; this is bookkeeping. */
export function recordToolMs(name, ms) {
  if (typeof name !== 'string' || !Number.isFinite(ms) || ms < 0) return;
  let row = seen.get(name);
  if (!row) { row = []; seen.set(name, row); }
  row.push(ms);
  if (row.length > SAMPLES) row.shift();
}

/**
 * The p90 for a tool, or null when we have not seen it enough to have an opinion.
 *
 * NULL IS AN ANSWER AND IT MEANS "RUN IT". A tool nobody has timed is not a tool we may
 * refuse: the whole point is to skip work that is KNOWN not to fit, and silence is not
 * knowledge. Eight samples, because refusing on the strength of two is how a slow first
 * call teaches the broker to stop answering a tool that is usually fast.
 */
export function toolP90(name, { minSamples = 8 } = {}) {
  const row = seen.get(name);
  if (!row || row.length < minSamples) return null;
  const sorted = [...row].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}

/**
 * Where a caller's deadline comes from, in the two places a caller can put it.
 *
 * `deadline_ms` is a BUDGET — "I will wait this long from now" — and is what almost every
 * caller already has, because it is the number they passed to AbortSignal.timeout. An
 * absolute `deadline_at` is accepted too for anything relaying a budget onward, but a
 * relative one is preferred: two machines' clocks are not the same clock, and this is a
 * loopback protocol where the round trip is shorter than the skew.
 *
 * Refuses nonsense rather than guessing. A negative or absurd budget means the caller is
 * confused, and the safe reading of a confused caller is that it has no deadline at all.
 */
export function deadlineFrom({ headers = {}, params = {} } = {}, now = Date.now()) {
  const pick = (...values) => {
    for (const v of values) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0 && n <= 3_600_000) return n;
    }
    return null;
  };
  const budget = pick(headers['x-m59-deadline-ms'], params?.deadline_ms);
  if (budget != null) return now + budget;
  const at = pick(headers['x-m59-deadline-at'], params?.deadline_at);
  // An absolute deadline already in the past is not a deadline, it is a clock disagreement.
  // Treat it as absent rather than refusing everything the caller asks for.
  if (at != null && at > now) return at;
  return null;
}

/**
 * Is this call worth starting?
 *
 * `{ ok: true }` when there is no deadline, no opinion about the tool, or enough time left.
 * `{ ok: false, ... }` names the numbers so the refusal can explain itself — a refusal that
 * cannot say why it fired gets deleted by the next person in a hurry.
 *
 * THE MARGIN IS THE WHOLE JUDGEMENT. Comparing against p90 alone accepts a call that will
 * finish exactly as the caller hangs up, which is the worst outcome: full cost, no answer.
 * The default asks for the p90 plus a fifth, so a call is started when it will PROBABLY be
 * read, not when it might just land.
 */
export function shouldAttempt(name, deadlineAt, { now = Date.now(), margin = 1.2,
                                                  p90 = toolP90(name) } = {}) {
  if (!Number.isFinite(deadlineAt)) return { ok: true, reason: 'no deadline' };
  const remaining = deadlineAt - now;
  if (remaining <= 0)
    return { ok: false, remaining, p90, reason: 'the caller\'s deadline has already passed' };
  if (p90 == null) return { ok: true, remaining, p90: null, reason: 'no timing history yet' };
  const need = Math.ceil(p90 * margin);
  if (remaining >= need) return { ok: true, remaining, p90, need };
  return { ok: false, remaining, p90, need,
           reason: `${name} takes ${p90}ms at p90 and only ${remaining}ms remain` };
}

/** What the broker knows about its own costs, for /health. Sorted slowest first. */
export function toolTimings({ minSamples = 8 } = {}) {
  const rows = [];
  for (const [name, row] of seen) {
    if (row.length < minSamples) continue;
    rows.push({ tool: name, samples: row.length, p90_ms: toolP90(name, { minSamples }) });
  }
  return rows.sort((a, b) => b.p90_ms - a.p90_ms);
}

/** Test seam only: forget every measurement. */
export function resetToolTimings() { seen.clear(); }
