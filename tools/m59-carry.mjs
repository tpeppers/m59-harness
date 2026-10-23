// HOW MUCH MORE OF ONE THING A CHARACTER CAN CARRY, FROM THE KOD AND NOTHING ELSE.
//
// A FleetScript helper: pure arithmetic over an `inventory` reply, with no socket of its own.
// The server refuses a hold when piWeight_hold + weight > GetWeightMax, or the same for bulk
// (holder.kod:281 CanHoldWeightAndBulk), and both ceilings are 1700 + might*20
// (player.kod:10456, :10461). The load is not on the wire, so it is added up from every item
// class's viWeight/viBulk (m59-items.mjs, lifted from the kod; NumberItem weighs
// viWeight * piNumber, numbitem.kod GetWeight). The inventory list is the whole of
// plPassive, worn items included (user.kod ToCliInventory), so nothing held is left out.
//
// The point of computing it HERE rather than asking the broker at the counter: an errand that
// sheds part of the pack before it shops (the Ko'catan guard, a vault, a stash) must size the
// order against the pack it will be carrying AFTERWARDS, not the lighter one at the counter.
// Plan from the starting inventory, and the space that was dropped is never filled.
//
//   import { fillPlan, loadOf } from './m59-carry.mjs';
//   const plan = fillPlan({ items: inv.items, max: inv.carry.weight_max, item: 'arrows', cap: 400 });
//   // -> { fit, amount, limited_by, load, after, fullness_after, ... }
import { weighItem } from './m59-items.mjs';

export const carryMax = might => 1700 + 20 * might;

// The load of a list of { name, amount } rows. `exact` false means a LOWER bound: some name is
// not in the table, and room computed from it would be an overestimate.
// Same arithmetic as weighPack (a count of 0 is one item), but each name goes through unitOf.
export function loadOf(items) {
  let weight = 0, bulk = 0;
  const unknown = [];
  for (const i of items ?? []) {
    const w = unitOf(i.name), n = i.amount > 0 ? i.amount : 1;
    if (!w) { unknown.push(i.name); continue; }
    weight += w.weight * n; bulk += w.bulk * n;
  }
  return { weight, bulk, exact: unknown.length === 0, unknown };
}

// One unit of `name`. The table keys the kod's own name resource, which is singular for most
// stacks ("herb", "elderberry") and plural for some ("arrows"), so try both forms.
export function unitOf(name) {
  const n = String(name ?? '').trim();
  const forms = [n, n.replace(/ies$/i, 'y'), n.replace(/es$/i, ''), n.replace(/s$/i, ''), n + 's'];
  for (const f of forms) { const w = weighItem(f); if (w) return w; }
  return null;
}

// The ceiling: from the inventory reply's carry block, or from might.
export function maxFrom({ carry, might } = {}) {
  if (Number.isFinite(carry?.weight_max) && carry.weight_max > 0) return carry.weight_max;
  if (Number.isFinite(carry?.might)) return carryMax(carry.might);
  if (Number.isFinite(might)) return carryMax(might);
  return null;
}

// How many of `item` fit on top of `items` under `max`, then the purse and an explicit cap.
// Paying shillings lightens the pack by the money's own weight (0 in the stock kod, money.kod);
// it is counted anyway so a server with weighted coin is not overfilled.
//   unitCost/purse/keep: omit to plan space only (cost is known only at the counter).
//   warnBelow: fullness (the worse of weight and bulk, over max) after the purchase under which
//              `warn` is set — a trip that came back mostly empty.
export function fillPlan({ items, max, item, unitCost = 0, purse = Infinity, keep = 0, cap = Infinity, warnBelow = 0.7 }) {
  const load = loadOf(items);
  const per = unitOf(item);
  const base = { item, max, load, per, warnBelow };
  if (!(max > 0)) return { ...base, fit: null, amount: 0, why: 'carry ceiling unknown (might has not been read)' };
  if (!load.exact) return { ...base, fit: null, amount: 0,
    why: `load is a lower bound — not in the weight table: ${load.unknown.join(', ')}; ` +
         'rebuild it (node tools/m59-items.mjs build) or leave those items behind' };
  if (!per || !(per.weight > 0 || per.bulk > 0)) return { ...base, fit: null, amount: 0, why: `${item} is not in the weight table` };
  const coin = unitOf('shilling') ?? { weight: 0, bulk: 0 };
  const netW = per.weight - unitCost * coin.weight, netB = per.bulk - unitCost * coin.bulk;
  const roomW = max - load.weight, roomB = max - load.bulk;
  const fits = (room, net) => net > 0 ? Math.floor(room / net) : Infinity;
  const fit = Math.max(0, Math.min(fits(roomW, netW), fits(roomB, netB)));
  const binding = fits(roomW, netW) <= fits(roomB, netB) ? 'weight' : 'bulk';
  const afford = unitCost > 0 && Number.isFinite(purse) ? Math.max(0, Math.floor((purse - keep) / unitCost)) : Infinity;
  const amount = Math.max(0, Math.min(fit, afford, cap));
  const limited_by = [amount === fit && `pack (${binding})`, amount === afford && 'purse', amount === cap && 'cap'].filter(Boolean);
  return { ...base, fit, afford: Number.isFinite(afford) ? afford : null, amount, limited_by, binding,
           ...afterBuying(base, amount, unitCost, coin) };
}

// The load and fullness once `amount` more are carried, against the same starting pack.
export function afterBuying({ load, per, max, warnBelow = 0.7 }, amount, unitCost = 0, coin = unitOf('shilling') ?? { weight: 0, bulk: 0 }) {
  const after = { weight: load.weight + amount * (per.weight - unitCost * coin.weight),
                  bulk: load.bulk + amount * (per.bulk - unitCost * coin.bulk) };
  const fullness_after = Math.max(after.weight, after.bulk) / max;
  return { after, fullness_after, warn: fullness_after < warnBelow };
}

export const pct = x => `${Math.round(x * 100)}%`;
