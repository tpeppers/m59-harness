// WHAT ONE TOWN STOP SHOULD SELL, KEEP AND BUY — the pack we have against the pack we want.
//
//   import { planTownStop } from './m59-townstop.mjs';
//   const plan = planTownStop(loadout, { items, equipped, settings });
//
// Pure arithmetic. It opens no socket, reads no file and touches no character; everything it
// knows arrives in its arguments, so it can be tested offline and asked hypothetical
// questions ("what would this character sell if it were carrying that?").
//
// WHY IT EXISTS. There were already two answers to "may this be sold" and they did not agree:
//
//   * the LOADOUT — `carry[].min` is a floor and `carry[].max` a ceiling, per character,
//     written by the planner and read by the keeper on every pass; and
//   * `m59-sellrun.mjs` — its own `keep_always.reagent_floor` out of substrate/sellrun.json,
//     plus a hardcoded ['herb', 'elderberry'] in PROTECT.
//
// Two copies of a rule drift, and this pair drifts in the expensive direction: the sell run
// protects two reagent names by hand, so any THIRD reagent a character was told to carry got
// fenced at the first stop and bought back at the last. This file is meant to be the only
// answer, and `sell_all`'s `keep` argument is meant to be fed from it rather than typed.
//
// THE RULE THAT MAKES IT WORTH HAVING: AN ITEM IS NEVER IN BOTH `sell` AND `buy`.
//
// That is not tidiness, it is money. A merchant buys below what it sells — herbs are 14 at
// Frisconar and fetch less than that across the counter — so selling something the same trip
// will buy back pays the spread TWICE and ends where it started. The pack is a quantity per
// item, the loadout is a target quantity per item, and a stop is the difference between them.
// Anything the loadout has no opinion about is fodder, which is the "sell everything else"
// half of the same sentence.
//
// WHAT IT WILL NOT DO, and each of these has a receipt in docs/m59-economy.md:
//   * never offer what is WORN — plUsing is the server's own list and the only honest one.
//   * never offer money.
//   * never sell a stack below its floor, and never sell a reagent it is also topping up.
//   * never invent a ceiling. `max: null` means "no opinion", which is not "sell the lot".
import { norm, entryMatches } from './m59-loadout.mjs';

// The same counting the loadout does, on the same matcher, because a second definition of
// "how many of these am I carrying" is how the two answers above came apart.
const countIn = (items, entry) => (items || [])
  .filter(i => entryMatches(entry, i.name))
  .reduce((t, i) => t + (i.amount ?? i.count ?? 1), 0);

export const MONEY = /shilling|coins/i;

export const DEFAULTS = {
  // A KIND, NOT A LIST OF NAMES. ['herb','elderberry'] is the hardcoding this replaces: it
  // protects the two reagents somebody thought of and fences the third. The loadout already
  // labels each carry line with a kind, so ask that.
  never_sell_kinds: ['reagent'],
  // Extra name fragments this machine never wants offered, whatever the loadout says.
  protect: [],
  // Sell things the loadout has never heard of. This is the "everything else" half; turn it
  // off for a courier that is only shedding surplus.
  sell_unknown: true,
  // Below this the stack is not worth a counter's time.
  min_stack: 1,
};

/**
 * @param loadout  a NORMALISED loadout (m59-loadout.normalise), or null
 * @param items    [{name, amount}] — the pack, as reconcile() reads it
 * @param equipped [{name}] or [name] — what the server says is WORN
 * @returns {{target, keep, sell, buy, keep_fragments, conflicts, ok, summary}}
 *
 * A null loadout returns null, and null means "no opinion — use the behaviour that was
 * already there". It must never be read as "sell nothing" or as "sell everything": both
 * have been shipped by callers treating an absent file as an empty one.
 */
export function planTownStop(loadout, { items = [], equipped = [], settings = {} } = {}) {
  if (!loadout) return null;
  const s = { ...DEFAULTS, ...(settings || {}) };
  const worn = new Set((equipped || []).map(e => norm(e?.name ?? e)));
  const neverSell = new Set((s.never_sell_kinds || []).map(k => String(k).toLowerCase()));

  const target = [], keep = [], sell = [], buy = [], conflicts = [], withheld = [];
  const spokenFor = [];              // every entry that has an opinion, for the fodder pass

  const onSellList = (name) => (loadout.sell || []).some(x => entryMatches({ item: x }, name));

  for (const c of loadout.carry || []) {
    const have = countIn(items, c);
    const kind = String(c.kind ?? '').toLowerCase();
    spokenFor.push(c);

    // A CEILING BELOW A FLOOR IS A LOOP. normalise() is supposed to have raised it already;
    // if one reaches us anyway, believe the FLOOR — buying up to a floor is recoverable and
    // selling under one is not.
    const floor = Number(c.min) || 0;
    let ceiling = c.max == null ? null : Number(c.max);
    if (ceiling != null && ceiling < floor) {
      conflicts.push({ item: c.item, why: `ceiling ${ceiling} is under floor ${floor}; using the floor` });
      ceiling = floor;
    }

    // THE WHOLE POINT, IN ONE BRANCH. A reagent we are topping up is not surplus at any
    // quantity: selling it here and buying it back at the next counter pays the spread twice.
    //
    // A KIND PROTECTS THE KIND, AND IT IS NOT CONDITIONAL ON THE FLOOR. This read
    // `neverSell.has(kind) && floor > 0` for about an hour, on the reasoning that "reagents
    // it would otherwise buy" means the ones under a floor. On this fleet that made the
    // setting protect NOTHING: every reagent floor is 0, zeroed deliberately on 2026-08-27
    // because bread and cheese at min 4 were unsatisfiable and re-opened a town trip for
    // ever. So `never_sell_kinds: ['reagent']` would have been a line of configuration that
    // did nothing, on a fleet whose reagents it was written to save — the exact failure
    // shape this repository keeps paying for. The floor/ceiling arithmetic below already
    // guarantees nothing is sold and bought in one stop; this is the stronger, separate
    // stance that some kinds are not fodder at any quantity.
    const protectedKind = neverSell.has(kind);

    target.push({ item: c.item, match: c.match, floor, ceiling, have, kind: c.kind ?? null });
    if (floor > 0 || protectedKind)
      keep.push({ item: c.item, match: c.match, upto: protectedKind ? null : floor, have,
                  why: protectedKind
                    ? `${c.kind} this character is topping up — selling it here and buying ` +
                      'it back pays the spread twice'
                    : `${have} held against a floor of ${floor}` });

    if (have < floor) {
      buy.push({ item: c.item, have, want: floor, short: floor - have, kind: c.kind ?? null,
                 why: c.why ?? `under its floor of ${floor}` });
      // A thing we are BUYING must never also be sold, and the sell list is the one route by
      // which that can still happen. Say so rather than silently picking a side.
      if (onSellList(c.item))
        conflicts.push({ item: c.item, why: 'on the sell list AND under its floor — keeping it, ' +
                                            'because selling then re-buying is a loss' });
    } else if (ceiling != null && have > ceiling) {
      const amount = have - ceiling;
      // A CEILING THAT DOES NOT APPLY MUST SAY SO. `never_sell_kinds` outranks `max`, which
      // means a number somebody wrote in the loadout stops having an effect — and a setting
      // that silently does nothing is exactly how `purpose` sat outside a schema for a year
      // with every keeper's audit switched off. So the surplus is REPORTED as withheld
      // rather than quietly not appearing in the sell list.
      if (protectedKind)
        withheld.push({ item: c.item, have, ceiling, over: amount, kind: c.kind ?? null,
                        why: `${amount} over the ${ceiling} ceiling, kept anyway because ` +
                             `never_sell_kinds covers ${c.kind}` });
      else if (amount >= s.min_stack)
        sell.push({ item: c.item, match: c.match, have, keep_back: ceiling, amount,
                    why: `above the ${ceiling} this character asked for` });
    }
  }

  // GEAR IS KEPT, NEVER FENCED. `gearFor` in reconcile() decides which one is best; here it
  // is enough that every named candidate is protected, because selling the spare mace that a
  // broken one is about to be replaced by is the same mistake as selling the reagent.
  for (const w of loadout.gear?.weapon || []) {
    keep.push({ item: w, upto: null, why: 'a weapon this character fights with' });
    spokenFor.push({ item: w });
  }
  for (const [slot, list] of Object.entries(loadout.gear?.slots || {}))
    for (const g of list) {
      keep.push({ item: g, upto: null, why: `this character's ${slot}` });
      spokenFor.push({ item: g });
    }
  for (const k of loadout.keep || []) {
    keep.push({ item: k, upto: null, why: 'on the keep list' });
    spokenFor.push({ item: k });
  }
  for (const p of s.protect || []) {
    keep.push({ item: p, match: 'contains', upto: null, why: 'protected at this stop' });
    spokenFor.push({ item: p, match: 'contains' });
  }

  // THE SELL LIST — things this character has said it does not want, as opposed to things it
  // merely has no opinion about. Skipped when the same item is under a floor, above.
  for (const x of loadout.sell || []) {
    const have = countIn(items, { item: x });
    if (!have) continue;
    if (buy.some(b => norm(b.item) === norm(x))) continue;   // never sell what we are buying
    if (keep.some(k => k.upto == null && entryMatches({ item: k.item, match: k.match }, x))) continue;
    spokenFor.push({ item: x });
    if (have >= s.min_stack)
      sell.push({ item: x, have, keep_back: 0, amount: have, why: 'on the sell list' });
  }

  // AND EVERYTHING ELSE. Anything worn, anything that is money, and anything already spoken
  // for above is excluded; what is left is loot, and loot is why the trip is worth making.
  if (s.sell_unknown) {
    const seen = new Set();
    for (const it of items || []) {
      const name = it?.name; if (!name) continue;
      const n = norm(name);
      if (seen.has(n)) continue; seen.add(n);
      if (MONEY.test(name)) continue;
      if (worn.has(n)) continue;
      if (spokenFor.some(e => entryMatches(e, name))) continue;
      const have = it.amount ?? it.count ?? 1;
      if (have >= s.min_stack)
        sell.push({ item: name, have, keep_back: 0, amount: have,
                    why: 'loot — the loadout has no opinion' });
    }
  }

  // EXACTLY WHAT `sell_all` WANTS. Its `keep` is a list of lowercase substrings it refuses to
  // offer, so this is the plan in that tool's own vocabulary — the point being that nobody
  // types it a second time.
  const keep_fragments = [...new Set(keep.map(k => norm(k.item)).filter(Boolean))];

  return {
    character: loadout.character ?? null,
    target, keep, sell, buy, keep_fragments, conflicts, withheld,
    ok: !sell.length && !buy.length,
    summary: [sell.length ? `${sell.length} to sell` : null,
              buy.length ? `${buy.length} to buy` : null,
              withheld.length ? `${withheld.length} over ceiling, kept` : null,
              conflicts.length ? `${conflicts.length} conflict(s)` : null]
      .filter(Boolean).join(', ') || 'nothing to do here',
  };
}

/** The invariant this module exists to hold, as a function, so callers can assert it too. */
export function neverSellsWhatItBuys(plan) {
  if (!plan) return { ok: true, both: [] };
  const both = plan.sell.filter(s => plan.buy.some(b => norm(b.item) === norm(s.item)))
                        .map(s => s.item);
  return { ok: !both.length, both };
}
