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
export function planTownStop(loadout, { items = [], equipped = [], settings = {},
                                        allies = [] } = {}) {
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

  // ---------------------------------------------------------------- the give pass
  //
  // AN ALLY WHO NEEDS IT BEATS A MERCHANT WHO WILL BUY IT, and it is the same money argument
  // this module already makes about `sell` and `buy`. A merchant buys below what it sells, so
  // selling a herb here and having a fleetmate buy one back at the next counter pays the
  // spread TWICE and ends with the herb in the same pack it could have been handed to. The
  // only difference from the sell/buy rule is that the two packs belong to different
  // characters, which is a fact about bookkeeping rather than about cost.
  //
  // IT DRAWS FROM BOTH SURPLUS PILES, AND `withheld` IS THE INTERESTING ONE.
  //
  // `never_sell_kinds` protects a reagent from the COUNTER, not from the fleet. A reagent over
  // its ceiling that we refuse to sell is the best possible thing to hand to a character who
  // is short of that exact reagent — refusing to do so would be reading "do not waste this" as
  // "do not use this". That matters more than it sounds: every reagent floor on this fleet is
  // zero (deliberately, since 2026-08-27), so on a `never_sell_kinds: ['reagent']` fleet the
  // withheld pile is where nearly all the spare reagents are, and a give pass that only drew
  // from `sell` would find almost nothing to give.
  //
  // WHAT IT WILL NOT DO:
  //   * never give below our own floor — both piles are already surplus by construction, and
  //     loot the loadout has no opinion about has no floor to be under.
  //   * never give what we are BUYING. Being short of something ourselves outranks an ally
  //     being short of it; the alternative is two characters handing one herb back and forth.
  //   * never give what is worn, or money. Neither pile can contain them.
  //
  // The caller decides priority by the ORDER it passes allies in, and says how it worked that
  // out. This module will not rank fleetmates: who deserves the last sapphire is a judgement
  // about the fleet, and it does not belong in arithmetic.
  const give = [];
  // WHAT WAS SPARE BEFORE ANY OF IT WAS PROMISED, so the invariant below can do arithmetic
  // rather than pattern-matching on names. See neverSellsWhatItGives for why that distinction
  // is the whole difference between a useful check and one that forbids a partial give.
  const spare_before = {};
  for (const sEntry of sell)
    spare_before[norm(sEntry.item)] = (spare_before[norm(sEntry.item)] || 0) + (Number(sEntry.amount) || 0);
  for (const w of withheld)
    spare_before[norm(w.item)] = (spare_before[norm(w.item)] || 0) + (Number(w.over) || 0);

  if (Array.isArray(allies) && allies.length) {
    const buying = new Set(buy.map(b => norm(b.item)));

    // Every unit we could part with, tagged with where it came from so the caller can see
    // whether a give came out of loot or out of a protected reagent.
    const pools = [];
    for (const sEntry of sell)
      pools.push({ pile: sEntry.keep_back === 0 ? 'loot' : 'surplus', entry: sEntry,
                   item: sEntry.item, left: Number(sEntry.amount) || 0 });
    for (const w of withheld)
      pools.push({ pile: 'withheld', entry: w, item: w.item, left: Number(w.over) || 0 });

    for (const ally of allies) {
      const who = ally?.character ?? ally?.agent ?? null;
      if (!who) continue;
      for (const want of (ally.wants || [])) {
        const name = want?.item;
        let short = Number(want?.short ?? want?.amount ?? 0) || 0;
        if (!name || short <= 0) continue;
        if (buying.has(norm(name))) {
          conflicts.push({ item: name,
                           why: `${who} is short of it and so are we — keeping it. Two ` +
                                'characters passing one item back and forth is not a supply run' });
          continue;
        }
        for (const p of pools) {
          if (short <= 0) break;
          if (p.left <= 0) continue;
          if (!entryMatches({ item: p.item, match: p.entry.match }, name)
              && norm(p.item) !== norm(name)) continue;
          const amount = Math.min(short, p.left);
          p.left -= amount;
          short -= amount;
          give.push({ item: p.item, to: who, amount, from: p.pile,
                      why: p.pile === 'withheld'
                        ? `${who} is short ${want.short ?? amount}; this was over our ceiling ` +
                          'and protected from the counter, which does not protect it from the fleet'
                        : `${who} is short ${want.short ?? amount}; this was going to a merchant, ` +
                          'and a merchant buys below what it sells' });
        }
      }
    }

    // THE SELL LIST IS REDUCED BY WHAT WAS GIVEN, which is what makes "never sells what it
    // gives" structural rather than a rule somebody has to remember. An entry drained to zero
    // leaves the list entirely: a sell of nothing is a call that reports success and moves
    // nothing, and this repository has enough of those.
    for (const p of pools) {
      if (p.pile === 'withheld') { p.entry.given = (Number(p.entry.over) || 0) - p.left; continue; }
      p.entry.amount = p.left;
    }
    for (let i = sell.length - 1; i >= 0; i--) if (!(Number(sell[i].amount) > 0)) sell.splice(i, 1);
  }

  // EXACTLY WHAT `sell_all` WANTS. Its `keep` is a list of lowercase substrings it refuses to
  // offer, so this is the plan in that tool's own vocabulary — the point being that nobody
  // types it a second time.
  const keep_fragments = [...new Set(keep.map(k => norm(k.item)).filter(Boolean))];

  return {
    character: loadout.character ?? null,
    target, keep, sell, buy, give, keep_fragments, conflicts, withheld, spare_before,
    // `ok` means "nothing to do here". A give is something to do, so it counts — otherwise a
    // stop whose only job was handing a fleetmate its reagents would report itself idle.
    ok: !sell.length && !buy.length && !give.length,
    summary: [sell.length ? `${sell.length} to sell` : null,
              buy.length ? `${buy.length} to buy` : null,
              give.length ? `${give.length} to hand over` : null,
              withheld.length ? `${withheld.length} over ceiling, kept` : null,
              conflicts.length ? `${conflicts.length} conflict(s)` : null]
      .filter(Boolean).join(', ') || 'nothing to do here',
  };
}


/**
 * WHO ELSE IS STANDING HERE, AND WHAT ARE THEY SHORT OF.
 *
 * Pure, like everything else in this file: the caller reads the keepers and hands the answers
 * in, so this can be asked hypothetical questions and tested without a fleet.
 *
 * A "want" is a CARRY FLOOR THAT IS NOT MET — the same definition `reconcile` uses for its own
 * buy list, deliberately, because a second definition of "short of" is how the sell filter and
 * the sell run came apart in the first place (see this file's header). A character with no
 * loadout wants nothing: silence is the behaviour that was already there, and an absent loadout
 * has never meant "give it everything".
 *
 * WHO COUNTS AS AN ALLY IS THE CALLER'S DECISION, and that is not laziness. The fleet has two
 * answers to "is this one of ours" and they are different on purpose — `m59-broker.mjs`'s
 * `fleetCharacters()` unions the fleet with the menagerie for the party module, the grudge book
 * and the fleetmate check, and its comment draws the line: *"'Do not shoot' and 'obey a fleet
 * order' are different questions with different answers. Everything that decides who obeys
 * reads fleetState alone."* Restocking is a third question and lands on the WIDE side — the
 * operator wants Loial supplied after he becomes a menagerie host — so the caller passes hosts
 * in, and nothing here has to know what a host is.
 */
export function alliesInRoom(subject = {}, others = []) {
  const room = subject?.room ?? null;
  const me = norm(subject?.character ?? '');
  if (room == null) return [];                 // unknown room: nobody is provably here

  const out = [];
  for (const o of others) {
    if (!o || o.room == null) continue;
    if (String(o.room) !== String(room)) continue;
    const who = o.character ?? o.agent ?? null;
    if (!who || norm(who) === me) continue;
    if (!o.loadout) continue;                  // no orders for it: it wants nothing from us

    const wants = [];
    for (const c of o.loadout.carry || []) {
      const floor = Number(c.min) || 0;
      if (floor <= 0) continue;                // A FLOOR OF ZERO IS NOT A FLOOR
      const have = countIn(o.items || [], c);
      if (have >= floor) continue;
      wants.push({ item: c.item, have, want: floor, short: floor - have,
                   kind: c.kind ?? null, why: c.why ?? `under its floor of ${floor}` });
    }
    if (wants.length) out.push({ agent: o.agent ?? null, character: who, wants });
  }
  // Neediest first, so a pile that cannot serve everyone serves whoever is worst off. The
  // caller may reorder; `planTownStop` honours the order it is given and ranks nobody.
  return out.sort((a, b) => b.wants.reduce((n, w) => n + w.short, 0)
                          - a.wants.reduce((n, w) => n + w.short, 0));
}

/**
 * AND NEVER PROMISES THE SAME UNITS TWICE. The money argument of `neverSellsWhatItBuys`, one
 * pack over: a merchant buys below what it sells, so handing a fleetmate a herb you also sell
 * is not possible — one of the two gets nothing, and whichever it is, the trip lied about it.
 *
 * IT IS ARITHMETIC, NOT A NAME MATCH, and the first version of it was a name match and wrong.
 * Giving an ally four of nine spare rat pelts and selling the other five is correct and costs
 * no spread — the same ITEM appears in both lists and no single unit does. A name-level check
 * flagged that as a violation, which would have forced the give pass to hand over a whole pile
 * or none of it. The real rule is that given + sold may not exceed what was spare to begin
 * with, which is what `spare_before` is recorded for.
 */
export function neverSellsWhatItGives(plan) {
  if (!plan) return { ok: true, over: [] };
  const spare = plan.spare_before || {};
  const tally = {};
  for (const g of plan.give || [])
    tally[norm(g.item)] = (tally[norm(g.item)] || 0) + (Number(g.amount) || 0);
  for (const s2 of plan.sell || [])
    tally[norm(s2.item)] = (tally[norm(s2.item)] || 0) + (Number(s2.amount) || 0);
  const over = Object.entries(tally)
    .filter(([item, promised]) => promised > (spare[item] ?? Infinity))
    .map(([item, promised]) => ({ item, promised, spare: spare[item] ?? null }));
  return { ok: !over.length, over };
}

/** The invariant this module exists to hold, as a function, so callers can assert it too. */
export function neverSellsWhatItBuys(plan) {
  if (!plan) return { ok: true, both: [] };
  const both = plan.sell.filter(s => plan.buy.some(b => norm(b.item) === norm(s.item)))
                        .map(s => s.item);
  return { ok: !both.length, both };
}
