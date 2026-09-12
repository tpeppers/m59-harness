#!/usr/bin/env node
// SKIP TO A POINT IN AN ERRAND, OR RUN UNTIL ONE — WITHOUT PRETENDING THE SKIPPED PART HAPPENED.
//
//   > dry raid-farnohl skipTo=armed              which steps would run, and which are omitted
//   > go  raid-farnohl skipTo=armed              run from there — if something re-established it
//   > go  raid-farnohl runUntil=at-the-door      stop after that step, and SAY it stopped early
//
// ============================================================ THE RULE THIS EXISTS TO ENFORCE
//
// The house rule in docs/m59-fleetscratch.md: **no auto-skip of steps that succeeded last
// attempt.** The world moved between attempts — conjures evaporate, keepers roam and re-equip,
// a body that was in room 40 logged out and came back in Tos. A skip that simply omits the first
// nine steps is a run whose first nine assumptions are unchecked, and it fails in the tenth step
// in a way that reads as the tenth step being wrong.
//
// So this is not "start at step 9". It is: **a checkpoint asserts the state those steps would
// have produced, and you may resume at most one step past the furthest point a checkpoint
// vouches for.** The operator's version, which is where the design came from: "skip to N-step
// can be baked in with DM-commands onto an arbitrary fleet" — the DM commands are how the
// checkpoint gets established, and `holds` is what makes the shortcut evidence about the walk.
//
// Concretely:
//
//   steps[]         2. travel -> 40      mark: 'at-the-hall'
//                   3. act equip_best    mark: 'armed'
//                   4. act enchant       (no mark)
//                   5. fight             mark: 'engaged'
//
//   setup[]         checkpoint('the fleet is at the hall, armed', {
//                     holds: ...,  establish: { dm, played },  covers: ['at-the-hall', 'armed'],
//                   })
//
//   the furthest covered step is 3 ('armed'), so you may resume at 0..4. `skipTo=engaged` is
//   REFUSED, because step 4 does work nothing re-establishes and nothing would notice it had
//   not been done.
//
// ============================================================ AND WHY A MARK IS NOT A STEP KIND
//
// `mark` is a field on an existing step, never a new `{ do: 'mark' }` entry. The operator was
// explicit that composites are the extension point and new primitives are not, and a mark that
// compiled to a step would be a step the broker has to ignore — one more thing that can be
// mis-sent. A field is inert: fleetScript does not read it, every existing pad keeps working,
// and `dry` renders it.
//
// ============================================================ STOPPING EARLY IS SAFE, AND NOISY
//
// `runUntil` needs no coverage — running FEWER steps cannot violate a guarantee the compiler
// makes about the ones that do run. What it does do is leave the fleet mid-errand, standing in
// a place the errand was going to walk them out of. So a sliced run is marked `partial`, says so
// in its render, and — the part that matters — does not count as evidence for promotion.
// m59-promote.mjs will not promote a pad on the strength of a run that stopped early, because
// "it worked" about the first four steps of an eleven-step errand is a sentence about a
// different errand.
import { isCheckpoint } from './m59-establish.mjs';

/** Every marked step, in order. A mark is a field on a step, never a step. */
export function marksOf(steps) {
  const out = [];
  [].concat(steps ?? []).forEach((st, index) => {
    const mark = st && typeof st === 'object' ? st.mark : null;
    if (mark) out.push({ mark: String(mark), index });
  });
  return out;
}

/** Duplicate marks are a load-time problem, because `skipTo=x` would silently pick the first. */
export function duplicateMarks(steps) {
  const seen = new Map();
  for (const m of marksOf(steps)) seen.set(m.mark, (seen.get(m.mark) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([m]) => m);
}

/**
 * Turn `skipTo=armed` or `skipTo=3` into a step index.
 *
 * A bare integer is accepted and means exactly what it says. It is NOT a loophole: the coverage
 * rule below is stated over indices, so `skipTo=9` is refused for the same reason a mark at step
 * 9 would be. Names are better only because they survive an edit that inserts a step.
 */
export function resolveRef(steps, ref) {
  const all = [].concat(steps ?? []);
  if (ref == null || ref === '') return { error: 'nothing to resolve' };
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) {
    const i = Number(s);
    if (i < 0 || i > all.length)
      return { error: `step ${i} is out of range — this pad compiles to ${all.length} step(s)` };
    return { index: i, by: 'index' };
  }
  const hit = marksOf(all).find(m => m.mark === s);
  if (!hit) {
    const known = marksOf(all).map(m => `${m.mark}@${m.index}`);
    return { error: `no step is marked "${s}"` +
                    (known.length ? ` — this pad marks: ${known.join(', ')}`
                                  : ` — this pad marks nothing. Add \`mark: '${s}'\` to the step ` +
                                    `you want to resume at, and a checkpoint that covers it.`) };
  }
  return { index: hit.index, by: 'mark', mark: hit.mark };
}

/** Which marks do this pad's checkpoints claim to re-establish? */
export function coveredMarks(setup) {
  const out = new Map();
  for (const st of [].concat(setup ?? []).filter(Boolean)) {
    if (!isCheckpoint(st)) continue;
    for (const m of st.covers ?? []) if (!out.has(m)) out.set(m, st.name);
  }
  return out;
}

/**
 * The furthest step you may resume at, and what vouches for it.
 *
 * A checkpoint covering mark M asserts the world as it stands AFTER the step marked M, so the
 * first step you may run is M+1 — `limit` is that index. With nothing covered the limit is 0,
 * which is "start at the beginning", which is the honest default.
 */
export function resumeLimit(steps, setup) {
  const covered = coveredMarks(setup);
  let best = { limit: 0, mark: null, index: -1, by: null };
  for (const m of marksOf(steps)) {
    if (!covered.has(m.mark)) continue;
    if (m.index > best.index)
      best = { limit: m.index + 1, mark: m.mark, index: m.index, by: covered.get(m.mark) };
  }
  return { ...best, covered };
}

const nameStep = (st) => (st?.do === 'act' ? `act('${st.tool}')` : String(st?.do ?? st));

/**
 * Work out which steps actually run.
 *
 * Pure, and separate from the session, so `dry` can print exactly what `go` would do and a test
 * needs no fleet. Returns the sliced steps plus everything needed to explain the slice.
 */
export function planSlice(steps, { skipTo = null, runUntil = null, setup = [] } = {}) {
  const all = [].concat(steps ?? []);
  const dups = duplicateMarks(all);
  if (dups.length)
    return { ok: false, steps: all, all, from: 0, to: all.length, partial: false,
             why: `two steps share the mark${dups.length > 1 ? 's' : ''} ${dups.join(', ')} — a ` +
                  `skip would silently pick the first. Marks name a point in the errand, so they ` +
                  `have to be unique.` };

  let from = 0, to = all.length;
  const lim = resumeLimit(all, setup);

  if (skipTo != null && skipTo !== '') {
    const r = resolveRef(all, skipTo);
    if (r.error)
      return { ok: false, steps: all, all, from: 0, to: all.length, partial: false, why: r.error };
    from = r.index;
    if (from > lim.limit) {
      const uncovered = all.slice(lim.limit, from)
        .map((st, i) => `${lim.limit + i}. ${nameStep(st)}`);
      return {
        ok: false, steps: all, all, from: 0, to: all.length, partial: false, limit: lim,
        why: `refusing to skip to step ${from}${r.mark ? ` ("${r.mark}")` : ''}: ` +
             (lim.index < 0
               ? `no checkpoint in this pad's setup covers any mark, so nothing re-establishes ` +
                 `what the skipped steps did. Give a checkpoint \`covers: ['<mark>']\` naming ` +
                 `the marks it puts the world past.`
               : `the furthest covered point is step ${lim.index} ("${lim.mark}", by the ` +
                 `checkpoint "${lim.by}"), so you may resume at step ${lim.limit} at the latest.`) +
             `\n  These would be skipped with nothing to re-establish them:\n    ` +
             uncovered.join('\n    ') +
             `\n  A skip that omits work is not a skip, it is a different errand with the same name.`,
      };
    }
  }

  if (runUntil != null && runUntil !== '') {
    const r = resolveRef(all, runUntil);
    if (r.error)
      return { ok: false, steps: all, all, from: 0, to: all.length, partial: false, why: r.error };
    // INCLUSIVE FOR A MARK. "Run until armed" plainly means the fleet ends up armed, so the
    // marked step is the last one that runs. A bare index is exclusive, because an index is
    // already a position between steps rather than a name for one. `dry` prints the exact list,
    // so nobody has to hold this distinction in mind.
    to = r.by === 'index' ? r.index : r.index + 1;
    if (to <= from)
      return { ok: false, steps: all, all, from: 0, to: all.length, partial: false,
               why: `runUntil lands at step ${to}, at or before the skipTo point (${from}) — ` +
                    `that is an empty errand rather than a short one.` };
  }

  const sliced = all.slice(from, to);
  if (!sliced.length)
    return { ok: false, steps: all, all, from, to, partial: false,
             why: `that leaves no steps to run.` };
  return {
    ok: true, steps: sliced, all, from, to, limit: lim,
    partial: from > 0 || to < all.length,
    skipped: all.slice(0, from), stopped: all.slice(to),
    establishedBy: from > 0 ? lim.by : null,
  };
}

/** One render for `dry` and for the line `go` prints before it runs anything. */
export function formatSlice(plan, { render = nameStep, name = 'this errand' } = {}) {
  if (!plan.ok) return `REFUSED — ${plan.why}`;
  if (!plan.partial) return null;                 // a full run needs no explanation
  const out = [];
  out.push(`PARTIAL RUN — steps ${plan.from}..${plan.to - 1} of ${plan.all.length}`);
  if (plan.skipped.length) {
    out.push(`  skipped ${plan.skipped.length}, re-established by the checkpoint ` +
             `"${plan.establishedBy}" rather than assumed:`);
    for (const [i, st] of plan.skipped.entries()) out.push(`    ${i}. ${render(st)}`);
  }
  if (plan.stopped.length) {
    out.push(`  stopping before ${plan.stopped.length} more, so the fleet is left MID-ERRAND:`);
    for (const [i, st] of plan.stopped.entries()) out.push(`    ${plan.to + i}. ${render(st)}`);
  }
  out.push(`  This is not a run of ${name} — a partial run is not evidence for promotion.`);
  return out.join('\n');
}
