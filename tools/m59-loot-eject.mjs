// LOOT EJECTION: A FARMER EMPTIES ITS SALE PILE INTO WHOEVER OF OURS IT PASSES WHO CAN CARRY IT TO A COUNTER.
//
// Operator, 2026-10-26: "a 'loot ejection' strategy that puts a strong downward pressure on our farmer packs: when
// passing couriers, they should attempt to offload all sell-planned loot to be sold by that courier. Any service
// stations with cache-usable space can have a default (and first eject) of using spare space for sell-gear 'trade
// goods'", with a courier collecting from the station and selling each lap.
//
// Two halves, both keeper policies, both of the ECONOMY faculty (a bot holding economy turns them off):
//
//   lootEject   on the GIVER.   { enabled, to: ['<character>', ...], every_s, batch }
//               When one of `to` is in the same room, offer it the heaviest rows of this keeper's own sale plan
//               (`inventorySalePlan`, state 'sell': the same rows a market visit would sell, so nothing the plan keeps
//               -- equipped, protected, magic, a fleet reagent, food, a loadout keep -- can leave). `to` is in order of
//               preference: a station first, then a courier. One offer of up to `batch` items per `every_s`; a
//               refusal backs that receiver off for BACKOFF_MS.
//   tradeGoods  on the RECEIVER, inside accept_donations: { enabled, keep_free, from }
//               Take a fleetmate's offer of anything, as long as the pack is still `keep_free` empty afterwards
//               (a station's cache is its SPARE space; the service it runs comes first). `from` limits the givers.
//
// A station passes its trade goods on the same way: it carries `lootEject: { to: ['<courier>'] }`, and the courier
// carries tradeGoods. A courier carries no lootEject, or goods would circulate. Pure; the keeper half is
// Autopilot.ejectLoot / giveItems (tools/autopilot/delivery.mjs) and acceptDonations (tools/autopilot/social.mjs).
import { weighPack, weighItem } from './m59-items.mjs';

export const BACKOFF_MS = 5 * 60_000;
const names = (v, what) => {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) throw new Error(`${what} must be a list of character names`);
  return [...new Set(v.map(x => x.trim()))];
};

/** lootEject: null (off) or { enabled: true, to: [names], every_s: 90, batch: 6 }. Throws with the reason. */
export function normalizeLootEject(v) {
  if (v == null || v.enabled === false) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('lootEject must be null or { enabled, to, every_s, batch }');
  const bad = Object.keys(v).filter(k => !['enabled', 'to', 'every_s', 'batch'].includes(k));
  if (bad.length) throw new Error(`lootEject: ${bad.join(', ')} not known (enabled, to, every_s, batch)`);
  const to = names(v.to ?? [], 'lootEject.to');
  if (!to.length) throw new Error('lootEject.to names nobody to eject to');
  const every_s = v.every_s == null ? 90 : Number(v.every_s);
  if (!Number.isFinite(every_s) || every_s < 20 || every_s > 1800) throw new Error('lootEject.every_s must be 20..1800');
  const batch = v.batch == null ? 6 : Number(v.batch);
  if (!Number.isInteger(batch) || batch < 1 || batch > 12) throw new Error('lootEject.batch must be 1..12');
  return { enabled: true, to, every_s, batch };
}

/** acceptDonations.trade_goods: null or { enabled: true, keep_free: 0.25, from: null | [names] }. */
export function normalizeTradeGoods(v) {
  if (v == null || v === false || v?.enabled === false) return null;
  if (v === true) v = {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('trade_goods must be true, null or { keep_free, from }');
  const keep_free = v.keep_free == null ? 0.25 : Number(v.keep_free);
  if (!Number.isFinite(keep_free) || keep_free < 0 || keep_free > 0.9) throw new Error('trade_goods.keep_free must be 0..0.9');
  return { enabled: true, keep_free, from: v.from == null ? null : names(v.from, 'trade_goods.from').map(n => n.toLowerCase()) };
}

/** Whom to eject to: the first of `to` (in order) standing here and not backed off. */
export function ejectTarget({ present = [], to = [], backoff = new Map(), now = Date.now() } = {}) {
  const here = new Set(present.map(n => String(n).toLowerCase()));
  for (const name of to) {
    const k = String(name).toLowerCase();
    if (here.has(k) && !((backoff.get(k) ?? 0) > now)) return name;
  }
  return null;
}

/**
 * The offer: the sale plan's 'sell' rows, never an equipped one, heaviest first (the point is the pack's load),
 * at most `batch`. -> [{ id, name, amount, whole }]
 */
export function ejectBatch(planItems = [], { batch = 6, weigh = weighItem } = {}) {
  const rows = planItems.filter(i => i && i.state === 'sell' && Number(i.sale_amount) > 0 && !i.equipped && i.id != null && Number(i.id) >= 0)
    .map(i => {
      const w = weigh(i.name);
      const amount = Number(i.sale_amount);
      return { id: i.id, name: i.name, amount, whole: amount >= (Number(i.amount) || 1),
               load: w ? Math.max(w.weight, w.bulk) * amount : 0 };
    });
  rows.sort((a, b) => b.load - a.load);
  return rows.slice(0, batch).map(({ load, ...r }) => r);
}

/**
 * Does an offer fit, leaving `keepFree` of the pack empty? `cap` is skills.carryCapacity(c).
 * Unknown (no might, or an unweighed item on either side) is NOT a yes: the station's own service needs the room.
 */
export function tradeGoodsFit({ offered = [], cap, keepFree = 0.25, weigh = weighPack } = {}) {
  if (!cap?.known || !cap.load) return { fits: false, why: 'this pack has not been weighed yet' };
  if (!cap.load.exact) return { fits: false, why: `this pack holds items the weight table does not know (${(cap.load.unweighed ?? []).slice(0, 3).join(', ')})` };
  const w = weigh(offered.map(o => ({ name: o.name, amount: o.amount })));
  if (!w.exact) return { fits: false, why: `the offer holds items the weight table does not know (${w.unknown.slice(0, 3).join(', ')})` };
  const after = Math.max((cap.load.weight + w.weight) / cap.weight_max, (cap.load.bulk + w.bulk) / cap.bulk_max);
  const limit = 1 - keepFree;
  return after <= limit ? { fits: true, after: Math.round(after * 1000) / 1000 }
    : { fits: false, after: Math.round(after * 1000) / 1000,
        why: `it would fill this pack to ${Math.round(after * 100)}%, over the ${Math.round(limit * 100)}% a station may use for trade goods` };
}
