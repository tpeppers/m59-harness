// WHAT A GUILD CHEST GIVES UP FIRST WHEN IT HAS TO MAKE ROOM, AND WHAT HAS ALREADY LEFT IT.
//
// Two questions the /inventory board asks of every chest it draws, answered without I/O so
// `m59-chest-eviction-test.mjs` can pin them.
//
// THE SERVER NEVER EVICTS FROM A CHEST. `chest.kod:29` is a 24,000-bulk ceiling with no weight
// limit and no timer; a full chest REFUSES the next deposit and says nothing more about it. So
// "what will be evicted" is not a fact read off the game. It is the ORDER THE GUILD PLAN IMPLIES,
// worked out here so that a person can see it before the chest is full, and so that whatever
// finally does the evicting (a hall run, a supply co-op) has one ranking to obey rather than
// inventing its own. Until something acts on it, the board says it is a ranking and not a log.
//
// THE RANKING, in three tiers, cheapest loss first:
//
//   1. unplanned  this chest's plan does not name it. All of it may go.
//   2. surplus    the plan names it, and the chest holds more than the target. Only the excess.
//   3. (kept)     up to the target, and anything on NEVER_EVICT. Never ranked, never offered.
//
// Within a tier: least value per bulk first, because bulk is the only thing a chest runs out of
// and value is what the guild loses by letting it go. An item with NO PRICE sorts after every
// priced one in its tier, never as zero. 160 of 249 items have no price in the table
// (`m59-values.json`), and "we do not know what it is worth" must not be read as "it is worth
// nothing". The same goes for an item with no bulk in the table: it frees an unknown amount of
// room, so it goes after everything whose effect we can state.
//
// HISTORY IS A DIFF OF TWO READINGS, NOT A RECORD OF WHO TOOK WHAT. A chest is read whole, once
// per visit (`StorageCache.writeChest`), so what vanished between two readings is all that can
// be known. It can be a fleet-mate's withdrawal, a guildmate's, or a real player in the same
// guild. The board calls it "left the chest between readings" and never "evicted by".
import { weighItem } from './m59-items.mjs';
import { loadItemValues, normalizeItemName } from './m59-item-value.mjs';

// Never ranked for eviction whatever the plan says. Shillings are the guild's rent money and
// weigh nothing (a chest is bulk-bound), so evicting them would free no room at all.
export const NEVER_EVICT = Object.freeze(['shilling']);

const norm = normalizeItemName;

/** Sum a chest's stacks by name. A count of zero is one item, the same rule as `weighPack`. */
export function tally(items = []) {
  const out = new Map();
  for (const i of items ?? []) {
    const name = norm(i?.name);
    if (!name) continue;
    const n = Number(i.amount) > 0 ? Number(i.amount) : 1;
    out.set(name, (out.get(name) ?? 0) + n);
  }
  return out;
}

const defaultBulkOf = (name) => weighItem(name)?.bulk ?? null;
const defaultPriceOf = (name) => {
  const v = loadItemValues()?.[norm(name)];
  return Number.isFinite(v) ? v : null;
};

/**
 * The order this chest would give things up in, and why.
 *
 * `planItems` is this chest's list from `normalisePlan` (`[{item, target}]`), or null when the
 * guild has no plan at all. With no plan every stack is `unplanned`, and the ranking is still
 * useful: it is what the chest holds, cheapest per unit of room first.
 *
 * Returns `{ rows, kept, freeable_bulk, unknown_bulk }`. Each row is `{ rank, name, evict,
 * tier, bulk_each, value_each, bulk, why }`. `evict` is the number of pieces this tier would
 * take, not the whole holding.
 */
export function evictionOrder(chest, planItems = null,
                              { bulkOf = defaultBulkOf, priceOf = defaultPriceOf } = {}) {
  const held = tally(chest?.items);
  const target = new Map((planItems ?? []).map(p => [norm(p.item), Number(p.target) || 0]));
  const rows = [], kept = [];
  for (const [name, amount] of held) {
    if (NEVER_EVICT.includes(name)) { kept.push({ name, amount, why: 'never evicted' }); continue; }
    const planned = target.has(name);
    const want = planned ? target.get(name) : 0;
    const evict = Math.max(0, amount - want);
    if (planned && want > 0)
      kept.push({ name, amount: Math.min(amount, want), why: `plan target ${want}` });
    if (!evict) continue;
    const bulk_each = bulkOf(name), value_each = priceOf(name);
    rows.push({
      name, evict, held: amount,
      tier: planned ? 'surplus' : 'unplanned',
      bulk_each, value_each,
      bulk: bulk_each == null ? null : bulk_each * evict,
      why: planned
        ? `${amount} held against a target of ${want}`
        : (planItems ? 'not in this chest\'s plan' : 'the guild has no plan'),
    });
  }
  const tierRank = { unplanned: 0, surplus: 1 };
  // Least value per bulk first. Unknown bulk or unknown value sorts LAST in its tier, never as
  // zero: an unpriced item may be the most valuable thing in the chest.
  const perBulk = r => (r.bulk_each > 0 && r.value_each != null) ? r.value_each / r.bulk_each : null;
  rows.sort((a, b) => {
    if (a.tier !== b.tier) return tierRank[a.tier] - tierRank[b.tier];
    const pa = perBulk(a), pb = perBulk(b);
    if ((pa == null) !== (pb == null)) return pa == null ? 1 : -1;
    if (pa != null && pa !== pb) return pa - pb;
    return (b.bulk ?? -1) - (a.bulk ?? -1) || a.name.localeCompare(b.name);
  });
  rows.forEach((r, i) => { r.rank = i + 1; });
  return {
    rows, kept,
    freeable_bulk: rows.reduce((n, r) => n + (r.bulk ?? 0), 0),
    unknown_bulk: rows.filter(r => r.bulk == null).map(r => r.name),
  };
}

/**
 * What changed between two readings of one chest, by name. `left` is what went out and
 * `arrived` what came in, each `[{name, amount}]`, largest first. Either reading may be null
 * (the first reading of a chest has nothing to compare with), and then there is no diff at all
 * rather than a diff that claims the whole chest arrived.
 */
export function chestDiff(prev, next) {
  if (!prev || !next || !Array.isArray(prev.items) || !Array.isArray(next.items)) return null;
  const a = tally(prev.items), b = tally(next.items);
  const left = [], arrived = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const d = (b.get(name) ?? 0) - (a.get(name) ?? 0);
    if (d < 0) left.push({ name, amount: -d });
    else if (d > 0) arrived.push({ name, amount: d });
  }
  const big = (x, y) => y.amount - x.amount || x.name.localeCompare(y.name);
  return { left: left.sort(big), arrived: arrived.sort(big) };
}
