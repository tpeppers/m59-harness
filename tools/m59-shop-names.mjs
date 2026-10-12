// BUY BY NAME: TURN [{name, amount}] INTO THE SELLER'S buy_ids, AGAINST THE OFFER JUST READ.
//
//   import { resolveBuyNames } from './m59-shop-names.mjs';
//   const { buy_ids, unmatched } = resolveBuyNames(shop.items, [{ name: 'elderberry', amount: 60 }]);
//
// An errand's steps are fixed when it is planned, and a shop's offer ids exist only once the counter
// is open, so a planner that cannot see the counter (DUM's Jasper elderberry run, 2026-10-12) needs to
// name what it wants. Pure, so the `shop` tool can use it without the broker being importable.
// A name matches exactly or in its plural/singular form (elderberry ~ elderberries, herb ~ herbs);
// one the seller does not offer is returned in `unmatched`, never guessed — the same rule
// m59-itemclass.mjs keeps for an ambiguous name.
const key = v => String(v ?? '').trim().toLowerCase();
const forms = n => new Set([n, `${n}s`, `${n}es`, n.replace(/y$/, 'ies'), n.replace(/ies$/, 'y'),
  n.replace(/es$/, ''), n.replace(/s$/, '')]);

export function resolveBuyNames(items = [], wants = []) {
  const buy_ids = [], unmatched = [];
  for (const want of wants ?? []) {
    const name = key(want?.name ?? want);
    const amount = Math.max(1, Math.floor(Number(want?.amount) || 1));
    const f = forms(name);
    const hit = name ? (items ?? []).find(i => f.has(key(i?.name))) : null;
    if (hit) buy_ids.push({ id: Number(hit.id), amount });
    else unmatched.push(want?.name ?? want);
  }
  return { buy_ids, unmatched };
}
