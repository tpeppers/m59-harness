// A FABRICATED VALUE IS INVISIBLE TO ONE SOURCE AND OBVIOUS TO TWO.
//
// THE ARGUMENT I GOT WRONG, AND THE CORRECTION. Four sessions hit one bug class in one night —
// a value that is present, formats perfectly, and is not what it says it is. Three faces have
// reader-side guards: ABSENT (say why you cannot answer), MISTYPED (assert the shape),
// WRONG-PATH (name which reply carries the field). The fourth is FABRICATED, and I argued in
// writing that it can have no reader-side guard: a synthesised value is present, correctly
// typed, in the right field and internally consistent, so there is nothing left for a reader
// to test. I concluded it could only be refused at the point of manufacture.
//
// That is true of ONE source and false of two. Measured on prod 2026-09-12:
//
//     equipment says  hammer            id = -1      (synthesised; KeeperProxy.equipment())
//     inventory says  hammer            id = 8789    (the server's)
//
// The fabrication is undetectable inside the first reply and unmistakable across the pair. And
// it is the same move that found everything else tonight: the rarity field was caught because a
// sweep said "nothing unidentified" while the keeper's own state showed two unidentified items;
// the `look_at` correlation race was caught because the id asked for and the id returned
// disagreed. Nobody spotted any of them by reading one answer harder.
//
// SO THE GUARD IS CORROBORATION, AND THE THREE-VALUED RULE APPLIES TO IT TOO. Two sources that
// agree is evidence. Two that disagree is a finding. ONE SOURCE IS NEITHER — it is
// `uncorroborated`, and calling that "fine" is how a fabricated value passes. This is
// `m59-which.mjs`'s INDETERMINATE, applied to agreement rather than to reachability.
//
// AND ABSENT IS NOT DISAGREEMENT. A field missing from one path and present on another is the
// WRONG-PATH face, not this one — `equipment` dropping `rarity` is a different bug from
// `equipment` inventing an id, and reporting them as the same thing sends the reader to the
// wrong fix. Absence is reported separately and never as a conflict.
//
// PURE ON PURPOSE, SO IT RUNS ANYWHERE. Every function here takes replies that somebody else
// fetched. It opens no socket, names no fleet and assumes no keeper band, so the same code
// checks prod, the shadow fleet, a lab broker, or a recording made months ago — which is the
// only way a guard gets exercised enough to be trusted before it is needed.

export const AGREED = 'agreed';
export const DISAGREED = 'disagreed';
export const UNCORROBORATED = 'uncorroborated';   // one source. Not a pass.
export const ABSENT = 'absent';                   // no source carries it at all.

const norm = v => (v === null || v === undefined ? null : String(v).trim().toLowerCase());

/**
 * Do these sources agree about one value?
 *
 * @param claims `[{ from: 'equipment', value: -1 }, { from: 'inventory', value: 8789 }]`
 *   A claim whose `value` is null/undefined counts as NOT CARRYING the field, which is
 *   different from carrying a different one.
 */
export function corroborate(claims = []) {
  const carried = (claims || []).filter(c => c && c.value !== null && c.value !== undefined);
  const silent = (claims || []).filter(c => !c || c.value === null || c.value === undefined)
    .map(c => c?.from ?? '?');

  if (!carried.length) {
    return { verdict: ABSENT, value: null, sources: [], silent,
             why: silent.length ? `no source carries it (${silent.join(', ')} are silent)`
                                : 'nothing was asked' };
  }
  if (carried.length === 1) {
    // THE STATE THAT MUST NOT READ AS SUCCESS. One source cannot corroborate itself, and a
    // fabricated value looks exactly like a real one from inside its own reply.
    return { verdict: UNCORROBORATED, value: carried[0].value, sources: [carried[0].from], silent,
             why: `only \`${carried[0].from}\` carries it — one source cannot be corroborated, ` +
                  'and a fabricated value is indistinguishable from a real one inside its own reply' };
  }
  const distinct = [...new Set(carried.map(c => norm(c.value)))];
  if (distinct.length === 1) {
    return { verdict: AGREED, value: carried[0].value, sources: carried.map(c => c.from), silent };
  }
  return {
    verdict: DISAGREED, value: null, silent,
    sources: carried.map(c => c.from),
    claims: carried.map(c => ({ from: c.from, value: c.value })),
    why: 'sources disagree: ' + carried.map(c => `\`${c.from}\` says ${JSON.stringify(c.value)}`).join(', '),
  };
}

/**
 * An id is only usable if two sources agree on it — and a negative one never is.
 *
 * The negative test is a TELL rather than the rule. `KeeperProxy.equipment()` happens to count
 * downward, so `-1` gives it away; a synthesiser counting upward would not, and corroboration
 * would still catch it. Both checks are here because the cheap one should fire first and the
 * general one should be what the verdict rests on.
 */
export function usableId(claims = []) {
  const r = corroborate(claims);
  const fabricated = (claims || []).filter(c => Number.isFinite(Number(c?.value)) && Number(c.value) < 0);
  if (fabricated.length) {
    return { ok: false, verdict: DISAGREED, id: null,
             why: `\`${fabricated[0].from}\` returned ${fabricated[0].value} — a negative id is an ` +
                  'array index wearing an id\'s field name, synthesised by the rebuild rather ' +
                  'than reported by the server. It addresses nothing.' };
  }
  if (r.verdict === AGREED) return { ok: true, verdict: AGREED, id: r.value, sources: r.sources };
  return { ok: false, verdict: r.verdict, id: null, why: r.why, claims: r.claims };
}

/**
 * Resolve a worn item's REAL id by corroborating the two paths that describe it.
 *
 * This is the prod case in the header, as a function: `equipment` is authoritative about WHAT
 * is worn and fabricates the id; `inventory` carries the server's id and does not say what is
 * worn. Neither alone is enough, which is exactly why the bug survived.
 */
export function wornItemId(name, { equipment = [], inventory = [] } = {}) {
  const want = norm(name);
  const worn = (equipment || []).find(x => norm(x?.name) === want);
  const held = (inventory || []).filter(x => norm(x?.name) === want);
  if (!worn) return { ok: false, verdict: ABSENT, id: null,
                      why: `\`equipment\` does not list "${name}" as worn` };
  // MORE THAN ONE MATCH IS NOT AN ANSWER. Two hammers in the pack and the name cannot say which
  // one is in hand; picking the first would be a fabrication of our own.
  if (held.length > 1)
    return { ok: false, verdict: DISAGREED, id: null,
             why: `\`inventory\` holds ${held.length} items called "${name}" — a name cannot say ` +
                  'which one is worn, and choosing one would invent the answer' };
  return usableId([
    { from: 'equipment', value: worn.id },
    { from: 'inventory', value: held[0]?.id ?? null },
  ]);
}

/** Did this reply answer the question that was asked? The `look_at` race, as a predicate. */
export function answeredWhatWasAsked({ asked, got, what = 'id' } = {}) {
  if (asked === null || asked === undefined)
    return { ok: false, why: `nothing was asked for, so the reply's ${what} cannot be checked` };
  if (got === null || got === undefined)
    return { ok: false, why: `the reply carries no ${what}, so it cannot be matched to the request` };
  if (norm(asked) === norm(got)) return { ok: true };
  return { ok: false, asked, got,
           why: `asked for ${what} ${JSON.stringify(asked)} and the reply carries ` +
                `${JSON.stringify(got)} — reproduced on prod 2026-09-12, two calls in nine ` +
                'returned the object the PREVIOUS call ended on, each carrying its own wrong id' };
}
