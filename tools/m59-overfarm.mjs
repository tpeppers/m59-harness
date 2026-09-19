// OVERFARMING: SIFT MORE THAN YOU CAN CARRY, AND CARRY THE BEST OF IT.
//
// A pack is a fixed budget and a farming room is an unbounded supply, so the question
// "what did this lap earn?" is decided almost entirely by WHICH hundred percent of the
// pack came home — and the fleet has always answered it by accident, taking whatever was
// nearest first until the pack was full and then walking away from the rest.
//
// The operator's framing, 2026-09-16: fill to 80-90%, then start taking only the most
// expensive and highest-priority drops, run up to 100%, and then keep killing for a while
// longer, dropping the least-wanted thing in the pack whenever something better is on the
// floor. If a monster drops 50/50 A/B and A is preferred, a pack that reached 100% at
// 50/50 should come home about 75/25.
//
// THAT NUMBER IS NOT A TARGET, IT IS AN ARITHMETIC CONSEQUENCE, and it is what fixes the
// unit of `overfarm_percent`. Sift 150% of capacity out of a 50/50 stream and you have
// seen 0.75C of A and 0.75C of B; keep the best 1.0C of it and you carry 0.75C of A and
// 0.25C of B. 75/25, exactly as predicted, from nothing but the ratio. So the percentage
// is measured in BULK SIFTED AGAINST PACK CAPACITY — not in kills, which vary by room, by
// creature and by luck, and which no two characters would agree on.
//
// FOUR THINGS THIS REFUSES TO DO, each of them a trap this repository has already paid for:
//
//   * AN UNKNOWN VALUE IS NOT A VALUE OF ZERO. 209 names are priced and the game has more;
//     `herb` is not in the table because the table calls it `herbs`. Scoring an unpriced
//     item 0 would make the unpriced things the first out of the pack every single time,
//     which is the "a floor of zero is not a floor" mistake with the sign flipped. An item
//     nobody can price is UNRANKABLE: it may be taken, and it is never dropped.
//   * PROTECTED IS PROTECTED. Reagents at their floor, the loadout's keep list, guild-wanted
//     stock and vault items are not drop candidates at any score. The drop set is built by
//     exclusion and the exclusions win.
//   * A PACK HAS TWO CEILINGS. `packFullness` reports the WORSE of weight and bulk, so a
//     cost model that consults one of them says there is room when there is not. Cost here
//     is max(weight, bulk) per unit, the same rule.
//   * A SWAP MUST BE WORTH THE PACKET. Trading a mushroom for a marginally better mushroom
//     costs a drop, a get and two seconds in a room full of monsters. `swap_margin` is the
//     factor the floor item has to beat the worst carried item by before it is worth doing.
//
// PURE. No broker, no socket, no fleet: it takes lists and returns decisions, so the policy
// can be tested offline and cannot disagree with itself between a plan and a run.
// `m59-overfarm-test.mjs` pins the 75/25 case and each of the four refusals above.

import { weighItem, resolveItemName } from './m59-items.mjs';
import { packMax } from './m59-storage.mjs';
import { estimateItemSellValue, normalizeItemName } from './m59-item-value.mjs';

/**
 * The slider positions, and what each one is in.
 *
 * These are the DUM strategy's settings verbatim — the catalogue in
 * `meridian59-dum-bot/src/strategies/catalog.mjs` declares the same ids, ranges and
 * defaults, and the keeper receives them under the `overfarm` policy. Two copies, because
 * neither repository may depend on the other; the test asserts the shape this side.
 */
export const OVERFARM_DEFAULTS = Object.freeze({
  // Below this, take everything: a half-empty pack has no reason to be choosy, and the
  // cheapest item still beats the empty space it would otherwise occupy.
  selective_at: 85,
  // Stop the lap once this much of capacity has been SIFTED. 100 disables overfarming
  // proper and leaves only the selective phase; 150 is the operator's default.
  overfarm_percent: 150,
  // Names ranked up and down. Matched on the resolved item name, so `orc teeth` and
  // `orc tooth` are the same entry.
  prefer: Object.freeze([]),
  avoid: Object.freeze([]),
  // ITEMS NO MERCHANT WILL SELL BACK, evicted last whatever they are worth. Named
  // EXPLICITLY rather than derived from the merchant catalogue, because that catalogue
  // indexes standard shop inventories only and misses every LIBACT_CONDITIONAL
  // say-the-word entry. Orc teeth are the worked example: `merchants sells:"orc tooth"`
  // returns nothing, and yet Marion Elder sells 4 for 350 (MrElder.kod:82), the Tos Inn
  // Keeper 2 for 650 and the Kocatan Weapons Master 2 for 750. Deriving "un-buyable" by
  // ABSENCE from an index with a known systematic gap would quietly protect the wrong
  // things and call it evidence -- the same error as scoring an unpriced item zero.
  unbuyable: Object.freeze([]),
  prefer_multiplier: 4,
  avoid_multiplier: 0.25,
  // How much better a floor item must be than the worst droppable carried item before the
  // swap is worth a drop, a get and the seconds they cost in a monster room.
  swap_margin: 1.25,
  // The merchant tier the value estimate assumes. It scales every item identically, so it
  // changes the reported shillings and never the ranking.
  merchant: 'normal',
});

const RANGES = Object.freeze({
  selective_at: { min: 0, max: 100 },
  overfarm_percent: { min: 100, max: 400 },
  prefer_multiplier: { min: 1, max: 20 },
  avoid_multiplier: { min: 0.01, max: 1 },
  swap_margin: { min: 1, max: 10 },
});

/**
 * Normalise a policy object, keeping the committed default for anything unusable.
 *
 * Follows `docs/m59-policy.md`: silence means the behaviour that was already there, an
 * unusable value keeps the default rather than unsetting it, and an unrecognised key is
 * REPORTED rather than dropped — a setting that silently does nothing is how `purpose`
 * stayed out of a schema for a year.
 */
export function normalizeOverfarm(policy = null) {
  if (policy == null) return { enabled: false, ...OVERFARM_DEFAULTS, unknown: [], rejected: [] };
  if (typeof policy !== 'object' || Array.isArray(policy))
    return { enabled: false, ...OVERFARM_DEFAULTS, unknown: [], rejected: ['overfarm must be an object'] };

  const out = { enabled: policy.enabled === true, ...OVERFARM_DEFAULTS };
  const unknown = [], rejected = [];
  for (const [key, value] of Object.entries(policy)) {
    if (key === 'enabled') continue;
    if (!Object.hasOwn(OVERFARM_DEFAULTS, key)) { unknown.push(key); continue; }
    if (key === 'prefer' || key === 'avoid' || key === 'unbuyable') {
      if (!Array.isArray(value)) { rejected.push(`${key} must be a list of item names`); continue; }
      out[key] = [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
      continue;
    }
    if (key === 'merchant') { out.merchant = String(value || 'normal'); continue; }
    const n = Number(value);
    const range = RANGES[key];
    if (!Number.isFinite(n)) { rejected.push(`${key} must be a number`); continue; }
    if (range && (n < range.min || n > range.max)) {
      rejected.push(`${key} must be between ${range.min} and ${range.max} (kept ${OVERFARM_DEFAULTS[key]})`);
      continue;
    }
    out[key] = n;
  }
  // A selective threshold at or above the overfarm target would never fire, and an overfarm
  // target below 100 would ask for a lap that goes home before the pack is full. Both are
  // accepted as written and reported, because refusing a whole policy over one number is
  // how a fleet ends up with no policy at all.
  if (out.overfarm_percent < 100)
    rejected.push(`overfarm_percent ${out.overfarm_percent} is below 100, so the lap ends before the pack fills`);
  return { ...out, unknown, rejected };
}

// `resolveItemName` THROWS on a name it does not know, and the test found that by asking
// about an item the datastore has never heard of. Every caller here is on the keeper's
// looting path, where the input is a name read off the floor of a monster room — exactly
// the place a name the table has never seen shows up — so an unresolvable name has to be
// an unranked item and never an exception.
const safeResolve = (name) => { try { return resolveItemName(name) ?? null; } catch { return null; } };

/** What one unit of an item costs against the pack's binding ceiling. */
export function unitCost(name) {
  const w = safeWeigh(name) ?? safeWeigh(safeResolve(name));
  if (!w) return { cost: null, weight: null, bulk: null, known: false };
  // THE WORSE OF THE TWO, because either ceiling full means the pack is full. This is the
  // same rule `packFullness` uses to report `percent`, and a cost model that disagreed
  // with the fullness model would free space the pack does not believe it has.
  return { cost: Math.max(w.weight, w.bulk), weight: w.weight, bulk: w.bulk, known: true };
}

// THE TWO TABLES DISAGREE ABOUT THE SINGULAR, and it is the same split that once made every
// reagent column on the fleet board read zero. `resolveItemName` canonicalises to `herb`;
// `substrate/m59-values.json` keys the same reagent as `herbs`. Neither is wrong on its own
// terms — they were extracted from different places — but a lookup that consults only one
// spelling prices `herb` at nothing and then, because an unpriced item is unrankable, holds
// it in the pack for ever. So both spellings are tried, in both tables.
const spellings = (name) => {
  const out = [];
  for (const base of [name, safeResolve(name)]) {
    if (!base) continue;
    const b = String(base);
    out.push(b, /s$/i.test(b) ? b.replace(/s$/i, '') : `${b}s`);
  }
  return [...new Set(out.filter(Boolean))];
};

/** What one unit of an item is worth, in shillings, at the configured merchant tier. */
export function unitWorth(name, { merchant = 'normal' } = {}) {
  for (const candidate of spellings(name)) {
    let e;
    try { e = estimateItemSellValue(candidate, { quantity: 1, merchant }); } catch { continue; }
    if (e.sell_value != null) return { value: e.sell_value, known: true, priced_as: normalizeItemName(candidate) };
  }
  return { value: null, known: false, priced_as: null };
}

const listHas = (list, name) => {
  const want = normalizeItemName(safeResolve(name) ?? name);
  return (list ?? []).some(entry => normalizeItemName(safeResolve(entry) ?? entry) === want);
};

// `weighItem` throws on an unknown name for the same reason and in the same place.
const safeWeigh = (name) => {
  if (!name) return null;
  try { return weighItem(name) ?? null; } catch { return null; }
};

/**
 * Rank one item.
 *
 * `score` is shillings per unit of binding cost, multiplied by the operator's preference.
 * It is NULL — not zero — when the item cannot be priced or cannot be weighed, and every
 * caller here treats null as "do not rank this", never as "worthless".
 */
export function scoreItem(name, policy = OVERFARM_DEFAULTS) {
  const p = policy.enabled === undefined ? policy : policy;
  const cost = unitCost(name);
  const worth = unitWorth(name, { merchant: p.merchant ?? 'normal' });
  const tier = listHas(p.prefer, name) ? 'prefer' : listHas(p.avoid, name) ? 'avoid' : 'neutral';
  const multiplier = tier === 'prefer' ? (p.prefer_multiplier ?? 4)
                   : tier === 'avoid'  ? (p.avoid_multiplier ?? 0.25) : 1;
  if (!cost.known || !worth.known || !(cost.cost > 0))
    return { name, tier, multiplier, score: null, value: worth.value, cost: cost.cost,
             rankable: false,
             why: !cost.known ? 'not in the weight table' : 'not in the value table' };
  return { name, tier, multiplier, value: worth.value, cost: cost.cost, rankable: true,
           score: (worth.value / cost.cost) * multiplier };
}

/**
 * Which phase a character is in, and what it should be doing.
 *
 * `sifted` is the running total of binding cost that has passed through this lap's hands —
 * everything picked up, INCLUDING what has since been dropped. That is the whole point of
 * measuring it: the dropped items are the evidence that overfarming happened.
 */
export function overfarmPhase({ packPercent = null, sifted = 0, capacity = null,
                                policy = OVERFARM_DEFAULTS } = {}) {
  const p = policy;
  if (p.enabled !== true) return { phase: 'off', why: 'the overfarm strategy is not enabled' };
  if (capacity == null || !(capacity > 0))
    return { phase: 'fill', why: 'pack capacity is unknown, so selectivity cannot be sized — take everything' };
  const siftedPercent = Math.round((sifted / capacity) * 100);
  if (siftedPercent >= (p.overfarm_percent ?? 150))
    return { phase: 'done', sifted_percent: siftedPercent,
             why: `sifted ${siftedPercent}% of capacity against a target of ${p.overfarm_percent}% — go and deliver` };
  if (packPercent == null)
    return { phase: 'fill', sifted_percent: siftedPercent, why: 'pack fullness is unknown' };
  if (packPercent >= 100)
    return { phase: 'overfarm', sifted_percent: siftedPercent,
             why: `the pack is full at ${packPercent}% and ${siftedPercent}% of capacity has been sifted — ` +
                  `keep killing and trade up` };
  if (packPercent >= (p.selective_at ?? 85))
    return { phase: 'selective', sifted_percent: siftedPercent,
             why: `the pack is ${packPercent}% full, past the ${p.selective_at}% selectivity threshold — ` +
                  `take only what outranks what is already in it` };
  return { phase: 'fill', sifted_percent: siftedPercent,
           why: `the pack is ${packPercent}% full, below the ${p.selective_at}% threshold — take everything` };
}

/**
 * Decide what to do with a floor full of drops.
 *
 * @param {object}   opts
 * @param {object[]} opts.floor     `{ id, name, amount }` — what is gettable
 * @param {object[]} opts.pack      `{ name, amount }` — what is carried
 * @param {object}   opts.policy    a normalised overfarm policy
 * @param {string[]} opts.protect   names that may never be dropped, whatever they score
 * @param {number}   opts.might     for the pack ceiling; `capacity` overrides it
 * @param {number}   opts.capacity  the ceiling directly, when the caller already has it
 * @param {number}   opts.sifted    binding cost sifted so far this lap
 * @returns {{phase, take, leave, swaps, room, sifted_percent, why}}
 */
export function planPickup({ floor = [], pack = [], policy = OVERFARM_DEFAULTS,
                             protect = [], floors = null, unbuyable = null,
                             might = null, capacity = null, sifted = 0 } = {}) {
  const p = policy;
  const max = capacity ?? (might == null ? null : packMax(might));
  const carriedCost = pack.reduce((n, it) => {
    const c = unitCost(it.name);
    return n + (c.known ? c.cost * (Number(it.amount) || 1) : 0);
  }, 0);
  const packPercent = max > 0 ? Math.round((carriedCost / max) * 100) : null;
  const phase = overfarmPhase({ packPercent, sifted, capacity: max, policy: p });

  const rank = (name) => scoreItem(name, p);
  const room = max == null ? null : Math.max(0, max - carriedCost);

  // OFF AND `fill` ARE THE SAME ANSWER, and it is today's behaviour: take everything the
  // floor has. Saying so explicitly matters — a strategy that is switched off must leave
  // the fleet doing exactly what it did before, never an empty policy.
  if (phase.phase === 'off' || phase.phase === 'fill')
    return { phase: phase.phase, take: floor.map(o => ({ ...o, why: phase.why })), leave: [], swaps: [],
             room, pack_percent: packPercent, sifted_percent: phase.sifted_percent ?? null, why: phase.why };

  if (phase.phase === 'done')
    return { phase: 'done', take: [], leave: floor.map(o => ({ ...o, why: phase.why })), swaps: [],
             room, pack_percent: packPercent, sifted_percent: phase.sifted_percent, why: phase.why };

  // The floor, best first. An unrankable item sorts LAST among the takeable but is still
  // takeable: not knowing what a thing is worth is not evidence that it is worthless.
  const ranked = floor.map(o => ({ ...o, rank: rank(o.name) }))
    .sort((a, b) => (b.rank.score ?? -1) - (a.rank.score ?? -1));

  const take = [], leave = [], swaps = [];
  let free = room ?? Infinity;

  // WHAT MAY BE GIVEN UP, AND HOW MUCH OF IT.
  //
  // `protect` is a NAME list and a name is all-or-nothing: one orc tooth over the floor
  // protected the whole stack, so a character sitting on three hundred of them against a
  // floor of twelve could not free a single one for anything better. `floors` makes the
  // question a QUANTITY -- keep the floor, offer the OVERAGE. A protected name with NO
  // floor stays protected entire, which is the old behaviour and the right one for a vault
  // item: there is no such thing as a surplus dragon scale.
  //
  // This is the half of the overflow rule that lets a reagent accumulate at all. The other
  // half is `guildKeepTest`, which holds an item back from the vendor exactly while a chest
  // still wants it and releases it the moment the plan is met.
  const floorOf = (name) => {
    if (!floors) return null;
    for (const [k, v] of Object.entries(floors))
      if (listHas([k], name)) return Math.max(0, Number(v) || 0);
    return null;
  };
  const spareOf = (it) => {
    const held = Number(it.amount) || 1;
    const f = floorOf(it.name);
    if (f == null) return listHas(protect, it.name) ? 0 : held;
    return Math.max(0, held - f);
  };
  // UN-BUYABLE IS EVICTED LAST, WHATEVER IT IS WORTH.
  //
  // Sell value is what a merchant PAYS, and for anything no merchant sells that number says
  // nothing about the cost of losing it: it cannot be replaced at any price. Orc teeth are
  // the case in hand -- 325 each from Paddock when he has them, mined from a 40%/roll drop
  // when he does not -- and the ranking would otherwise shed them first precisely because
  // they are cheap per unit of bulk.
  //
  // ONLY A POSITIVE ABSENCE COUNTS. `unbuyable` is null when the merchant catalogue is not
  // on this machine, and an unknown is treated as BUYABLE rather than as protected --
  // the other way round protects everything and evicts nothing, which is the "a floor of
  // zero is not a floor" mistake with the sign flipped.
  const noRebuy = unbuyable ?? (p.unbuyable?.length ? p.unbuyable : null);
  const cannotRebuy = (name) => !!noRebuy && listHas(noRebuy, name);
  const droppable = pack
    .map(it => ({ ...it, spare: spareOf(it) }))
    .filter(it => it.spare > 0)
    .map(it => ({ ...it, amount: it.spare, rank: rank(it.name) }))
    .filter(it => it.rank.rankable)          // never drop what cannot be ranked
    .sort((a, b) => (cannotRebuy(a.name) ? 1 : 0) - (cannotRebuy(b.name) ? 1 : 0)
                 || a.rank.score - b.rank.score);

  for (const o of ranked) {
    const cost = (o.rank.cost ?? 0) * (Number(o.amount) || 1);
    // SELECTIVE AND OVERFARM DIFFER ONLY IN WHETHER THE PACK IS FULL. In both phases an
    // item that simply fits is taken; the swap machinery only runs when it does not.
    if (cost > 0 && cost <= free) {
      // In the selective phase, being able to afford it is not enough: the space is nearly
      // gone and what goes into it should beat what is already there. The bar is the worst
      // thing carried, which is exactly the thing this item would otherwise be displacing
      // later in the lap.
      const floorBar = droppable.length ? droppable[0].rank.score : null;
      if (phase.phase === 'selective' && o.rank.rankable && floorBar != null &&
          o.rank.score < floorBar) {
        leave.push({ ...o, why: `scores ${o.rank.score.toFixed(2)} against the ${droppable[0].name} ` +
                                `already carried at ${floorBar.toFixed(2)} — not worth the last of the pack` });
        continue;
      }
      take.push({ ...o, why: o.rank.rankable
        ? `scores ${o.rank.score.toFixed(2)} (${o.rank.value}sh / ${o.rank.cost} cost, ${o.rank.tier})`
        : `${o.rank.why} — taken anyway, an unrankable item is not a worthless one` });
      free -= cost;
      continue;
    }

    if (!o.rank.rankable) {
      leave.push({ ...o, why: `${o.rank.why}, and there is no room for it` });
      continue;
    }

    // NO ROOM. Trade up if the pack holds something meaningfully worse.
    let gained = 0;
    const giving = [];
    for (const held of droppable) {
      if (gained >= cost - free) break;
      if (held.rank.score * (p.swap_margin ?? 1.25) >= o.rank.score) break;  // not worth the packets
      const heldCost = held.rank.cost * (Number(held.amount) || 1);
      giving.push(held);
      gained += heldCost;
    }
    if (gained >= cost - free && giving.length) {
      for (const g of giving) {
        droppable.splice(droppable.indexOf(g), 1);
        free += g.rank.cost * (Number(g.amount) || 1);
      }
      swaps.push({ take: o, drop: giving.map(g => ({ name: g.name, amount: g.amount, score: g.rank.score })),
        why: `${o.name} scores ${o.rank.score.toFixed(2)} against ` +
             `${giving.map(g => `${g.name} at ${g.rank.score.toFixed(2)}`).join(' + ')} — ` +
             `clears the ${p.swap_margin}x swap margin` });
      take.push({ ...o, why: `swapped in for ${giving.map(g => g.name).join(' + ')}` });
      free -= cost;
      continue;
    }
    leave.push({ ...o, why: droppable.length
      ? `scores ${o.rank.score.toFixed(2)}; the worst droppable thing carried is ` +
        `${droppable[0].name} at ${droppable[0].rank.score.toFixed(2)}, which it does not beat by ${p.swap_margin}x`
      : 'no room, and nothing in the pack may be dropped' });
  }

  return { phase: phase.phase, take, leave, swaps, room, pack_percent: packPercent,
           sifted_percent: phase.sifted_percent ?? null, why: phase.why };
}

/**
 * WHAT THE OVERFARMING WAS WORTH.
 *
 * Given the ordered stream of everything this lap's hands passed over, the value impact is
 * the difference between two packs: the one a greedy lap would have carried home — take in
 * encounter order until full, which is exactly what the fleet did before this existed —
 * and the one selection actually produced.
 *
 * Both halves are computed from the SAME stream, so the comparison is against what this
 * character actually met rather than against an average room. That is the only form of the
 * claim that survives the room being unlucky.
 */
export function siftValue({ stream = [], capacity = null, policy = OVERFARM_DEFAULTS } = {}) {
  const rows = stream.map(o => ({ ...o, rank: scoreItem(o.name, policy),
                                  amount: Number(o.amount) || 1 }));
  const costOf = r => (r.rank.cost ?? 0) * r.amount;
  const valueOf = r => (r.rank.value ?? 0) * r.amount;

  const fill = (ordered) => {
    let used = 0, value = 0; const kept = [];
    for (const r of ordered) {
      const c = costOf(r);
      if (c <= 0) continue;
      if (capacity != null && used + c > capacity) continue;
      used += c; value += valueOf(r); kept.push(r);
    }
    return { used, value, kept };
  };

  const greedy = fill(rows);
  // Best-first by score, which is what the phase machine converges on over a lap.
  const chosen = fill([...rows].sort((a, b) => (b.rank.score ?? -1) - (a.rank.score ?? -1)));
  const sifted = rows.reduce((n, r) => n + costOf(r), 0);
  const unpriced = rows.filter(r => !r.rank.rankable).map(r => r.name);

  return {
    sifted, capacity,
    sifted_percent: capacity > 0 ? Math.round((sifted / capacity) * 100) : null,
    baseline: { value: greedy.value, used: greedy.used, items: greedy.kept.length },
    kept: { value: chosen.value, used: chosen.used, items: chosen.kept.length },
    gain: chosen.value - greedy.value,
    gain_percent: greedy.value > 0 ? Math.round(((chosen.value - greedy.value) / greedy.value) * 100) : null,
    // NAMED, because an estimate whose inputs are partly unknown has to say so. These
    // contributed cost and no value, which understates both halves equally.
    unpriced: [...new Set(unpriced)],
    mixture: mixtureOf(chosen.kept),
    estimated: true,
  };
}

/** The A/B/C shape of a pack, by share of binding cost — the thing the operator reads. */
export function mixtureOf(items = []) {
  const byName = new Map();
  let total = 0;
  for (const it of items) {
    const rank = it.rank ?? scoreItem(it.name, OVERFARM_DEFAULTS);
    const cost = (rank.cost ?? 0) * (Number(it.amount) || 1);
    if (!(cost > 0)) continue;
    total += cost;
    byName.set(it.name, (byName.get(it.name) ?? 0) + cost);
  }
  return [...byName.entries()]
    .map(([name, cost]) => ({ name, cost, percent: total > 0 ? Math.round((cost / total) * 100) : 0 }))
    .sort((a, b) => b.cost - a.cost);
}
