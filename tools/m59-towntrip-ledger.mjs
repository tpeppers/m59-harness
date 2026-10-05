// WHAT A TOWN TRIP DID, ITEM BY ITEM: the pack going in, what was sold, bought, deposited and
// drawn, and the pack coming out.
//
// Operator, 2026-10-05: "Town trip records should ... link to all relevant trade ledgers ... pack
// going in, buying selling, pack going out, so a summary can be generated and reviewed/filtered".
// `town_trip_completed` carried cash and totals and no items, and the town-income ledger carries
// `vendor_sales` as a number -- so "did anybody sell purple mushrooms while the hall was short"
// had no answer anywhere (2026-10-05: 810 looted in 79 h, 38 in the hall, no record of a sale).
//
// Two kinds of evidence, kept apart on purpose:
//   trade      what the trade paths SAID they did (tradeFact): sold, bought, vaulted (Barloque vault),
//              guild_deposited (hall chests: the co-op, the tithe's shillings, guild wants, the stash),
//              withdrawn (hall chests), and the bank: banked / bank_withdrawn shillings.
//   pack_delta pack_out minus pack_in, which is what actually happened -- including anything
//              a path that does not report (a coop deposit, a chalice hand-off, eating) moved.
// A reader that wants to know whether a sale was recorded compares the two.
//
// Pure: no I/O, no client. The keeper calls these at trip open, on each trade fact, and at close.

const MAX_ROWS = 60;
/** The item books of a trip's trade, in reading order. */
export const TRADE_KINDS = Object.freeze(['sold', 'bought', 'vaulted', 'guild_deposited', 'withdrawn']);               // a ledger row has to stay a row, not a pack dump

const norm = s => String(s ?? '').trim().toLowerCase();

/** A pack as { name: count }. An unstackable item reports amount 0, which means ONE. */
export function packCounts(items = [], nameOf = i => i?.name) {
  const out = {};
  for (const it of items ?? []) {
    const name = norm(nameOf(it));
    if (!name) continue;
    out[name] = (out[name] ?? 0) + (Number(it?.amount) || 1);
  }
  return out;
}

export function newTripTrade() {
  return { earned: 0, spent: 0, banked: 0, bank_withdrawn: 0,
           sold: {}, bought: {}, vaulted: {}, guild_deposited: {}, withdrawn: {}, facts: 0 };
}

const bump = (book, name, amount, money = 0) => {
  const k = norm(name);
  if (!k) return;
  const row = book[k] ??= { amount: 0, shillings: 0 };
  row.amount += Number(amount) || 1;
  row.shillings += Number(money) || 0;
};

/**
 * Fold one tradeFact into a trip's trade. Shapes, as the trade paths send them:
 *   sold      [{ name, amount, price }]            (skills.sellAll)
 *   bought    [{ what, cost, amount? }]            (buy paths)
 *   deposited       [{ name|item, amount }]        (the Barloque vault -> `vaulted`)
 *   guild_deposited [{ name|item, amount }]        (hall chests)
 *   withdrawn       [{ name|item, amount }]        (hall chests)
 *   banked / bank_withdrawn                        (shillings)
 */
export function addTradeFact(trade, fact = {}) {
  if (!trade) return trade;
  trade.facts++;
  for (const key of ['earned', 'spent', 'banked', 'bank_withdrawn']) trade[key] = (trade[key] ?? 0) + (Number(fact[key]) || 0);
  for (const s of [].concat(fact.sold ?? [])) bump(trade.sold, s?.name ?? s?.item ?? s?.what, s?.amount, s?.price);
  for (const b of [].concat(fact.bought ?? [])) bump(trade.bought, b?.what ?? b?.name ?? b?.item, b?.amount, b?.cost);
  for (const d of [].concat(fact.deposited ?? [])) bump(trade.vaulted ??= {}, d?.name ?? d?.item ?? d, d?.amount);
  for (const d of [].concat(fact.guild_deposited ?? [])) bump(trade.guild_deposited ??= {}, d?.name ?? d?.item ?? d, d?.amount);
  for (const w of [].concat(fact.withdrawn ?? [])) bump(trade.withdrawn, w?.name ?? w?.item ?? w, w?.amount);
  return trade;
}

/** pack_out - pack_in, nonzero entries only, largest movement first. */
export function packDelta(before = {}, after = {}) {
  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const rows = [...names].map(n => [n, (after?.[n] ?? 0) - (before?.[n] ?? 0)]).filter(([, d]) => d !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return Object.fromEntries(rows.slice(0, MAX_ROWS));
}

const cap = obj => Object.fromEntries(Object.entries(obj ?? {})
  .sort((a, b) => (b[1]?.amount ?? b[1]) - (a[1]?.amount ?? a[1])).slice(0, MAX_ROWS));

/** The fields `town_trip_completed` gains. Absent halves are null, never {}: "not read" is not "empty". */
export function tripLedgerFields({ packIn = null, packOut = null, trade = null } = {}) {
  return {
    pack_in: packIn ? cap(packIn) : null,
    pack_out: packOut ? cap(packOut) : null,
    pack_delta: packIn && packOut ? packDelta(packIn, packOut) : null,
    trade: trade ? { earned: trade.earned, spent: trade.spent, banked: trade.banked,
      bank_withdrawn: trade.bank_withdrawn ?? 0, facts: trade.facts,
      sold: cap(trade.sold), bought: cap(trade.bought), vaulted: cap(trade.vaulted),
      guild_deposited: cap(trade.guild_deposited), withdrawn: cap(trade.withdrawn) } : null,
  };
}

/** Did this trip move `item` (by name substring), and how? For filters and summaries. */
export function tripTouches(row, item) {
  const k = norm(item);
  const has = obj => Object.keys(obj ?? {}).some(n => n.includes(k));
  const t = row?.trade ?? {};
  return TRADE_KINDS.some(kind => has(t[kind])) || has(row?.pack_delta);
}
