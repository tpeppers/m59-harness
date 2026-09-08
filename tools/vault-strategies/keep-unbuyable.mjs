// KEEP-UNBUYABLE — the default vault strategy, and the only one that ships.
//
// A vault is finite and a fleet's loot is not, so something has to decide what earns a slot.
// This strategy answers with the narrowest defensible rule: KEEP WHAT NO MERCHANT WILL SELL
// YOU BACK. Everything else — arrows, reagents, gems, ordinary weapons — can be replaced with
// shillings, and shillings are what a vault slot costs you the chance to earn.
//
// Two items qualify on the mainland this fleet lives on:
//
//   dark angel feather   4 bulk. Not stocked by any SetForSale in the tree.
//   blue dragon scale   10 bulk. The same.
//
// Each is allowed HALF the vault and no more. Half is not a compromise between them — it is
// the point: either one alone can fill a vault given a long enough night of farming, and a
// vault holding nothing but feathers is as useless as an empty one. The cap makes the shelf
// hold both, and leaves nothing spare, which is honest about what this strategy is for. A
// fleet that wants room for a third thing wants its own strategy.
//
// A FLEET OVERRIDES THIS BY WRITING substrate/dumbot/vault-strategy.mjs, which is gitignored
// and wins by path. That file may export the same three things and nothing else needs to know.

// Bulk of the whole vault, in the game's own units.
export const CAPACITY = 3000;

// The share of the vault ONE kept item may occupy. Half each, exactly.
export const SHARE = 0.5;

// Bulk per piece, from the kod. This is the only reason the caps are numbers and not guesses.
export const BULK = Object.freeze({
  'dark angel feather': 4,          // dafeather.kod
  'blue dragon scale': 10,          // bdscale.kod
});

// Pieces, derived rather than written down, so changing SHARE or CAPACITY cannot leave a
// stale number behind. 1500 bulk buys 375 feathers or 150 scales.
export const CAPS = Object.freeze(Object.fromEntries(
  Object.entries(BULK).map(([name, bulk]) => [name, Math.floor((CAPACITY * SHARE) / bulk)]),
));

const key = (n) => String(n || '').toLowerCase().trim();
export const bulkOf = (name, amount = 1) => (BULK[key(name)] ?? 0) * amount;

/**
 * What should leave this vault, in order, and why.
 *
 * ANYTHING NOT ON THE KEEP LIST IS SURPLUS IN FULL. That is the whole strategy: a vault is
 * for what cannot be re-bought, so a thing that can be is worth more as the shillings it
 * sells for than as the slot it occupies. Items on the list are evicted only down to their
 * cap, never below it.
 *
 * Returns the same shape a fleet's own strategy must: `{ used, capacity, pct, plan, freed }`,
 * where each plan row carries `evict` (pieces), `disposition` and `why`.
 */
export function evictionPlan(items = [], { capacity = CAPACITY } = {}) {
  const rows = (items ?? []).map((i) => ({
    name: i.name, amount: i.amount ?? 1, bulk: bulkOf(i.name, i.amount ?? 1),
  }));
  const used = rows.reduce((n, r) => n + r.bulk, 0);
  const plan = [];

  for (const r of rows) {
    const cap = CAPS[key(r.name)] ?? CAPS[key(r.name).replace(/s$/, '')];
    if (cap == null) {
      // Not on the keep list. Sell it — and say which half of the rule that is, because
      // "why is my emerald gone" is a question this has to be able to answer.
      plan.push({ ...r, evict: r.amount, freed: r.bulk, disposition: 'sell',
                  why: 'buyable somewhere, so a merchant pays more for it than a vault slot is worth' });
      continue;
    }
    if (r.amount > cap) {
      const over = r.amount - cap;
      plan.push({ ...r, evict: over, freed: bulkOf(r.name, over), disposition: 'sell',
                  why: `over the ${cap}-piece cap (${Math.round(SHARE * 100)}% of the vault at `
                     + `${BULK[key(r.name)]} bulk each)` });
    }
  }

  const freed = plan.reduce((n, r) => n + r.freed, 0);
  return { used, capacity, pct: Math.round((used / capacity) * 100), plan, freed,
           after: used - freed };
}
