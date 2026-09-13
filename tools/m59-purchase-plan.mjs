// Pure shopping arithmetic. Prices without a live quote are explicitly estimates.
import { foodValue } from './m59-items.mjs';

export const purchaseKey = name => String(name ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  .replace(/^elder\s+berry$/, 'elderberry').replace(/^herbs$/, 'herb');

export function purchasePlan({ requests = [], menu = [], foodGap = 0, reserve = 0,
                               estimated = false } = {}) {
  const lines = [], unpriced = [], unavailable = [];
  const add = (item, amount) => {
    if (!(amount > 0)) return;
    const cost = item.cost;
    lines.push({ item: item.name, id: item.id ?? null, amount,
      unit_cost: cost, cost: amount * cost });
  };
  for (const request of requests) {
    if (!(request.amount > 0)) continue;
    const item = menu.find(i => purchaseKey(i.name) === purchaseKey(request.item));
    if (!item) { (estimated ? unpriced : unavailable).push(request); continue; }
    if (!Number.isFinite(item.cost) || item.cost < 0) { unpriced.push(request); continue; }
    add(item, Math.ceil(request.amount));
  }
  const food = menu.filter(i => Number.isFinite(i.cost) && i.cost >= 0
      && (foodValue(i.name)?.nutrition ?? 0) > 0)
    .sort((a, b) => a.cost / foodValue(a.name).nutrition - b.cost / foodValue(b.name).nutrition);
  if (foodGap > 0 && food.length) add(food[0], Math.ceil(foodGap / foodValue(food[0].name).nutrition));
  else if (foodGap > 0) (estimated ? unpriced : unavailable).push({ item: 'food', nutrition: foodGap });
  const known_cost = lines.reduce((n, l) => n + l.cost, 0);
  return { lines, expected_cost: unpriced.length ? null : known_cost, known_cost,
    reserve: Math.max(0, reserve), required_purse: known_cost + Math.max(0, reserve),
    estimated, unpriced, unavailable };
}

export const PURCHASE_BANKS = [
  { room: 54, name: 'Royal Bank of Tos', account: 'jasper-tos-barloque' },
  { room: 376, name: 'Royal Bank of Jasper', account: 'jasper-tos-barloque' },
  { room: 2005, name: 'Hungry Vault', account: 'kocatan' },
];

export function accountBalance(known, account) {
  const amount = known?.accounts?.[account] ?? (known?.account === account ? known.balance : null);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}
