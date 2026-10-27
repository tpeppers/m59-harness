// LOOT EJECTION: A FARMER EMPTIES ITS SALE PILE INTO WHOEVER OF OURS IT PASSES WHO CAN CARRY IT TO A COUNTER.
//
// Operator, 2026-10-26: "a 'loot ejection' strategy that puts a strong downward pressure on our farmer packs: when
// passing couriers, they should attempt to offload all sell-planned loot to be sold by that courier. Any service
// stations with cache-usable space can have a default (and first eject) of using spare space for sell-gear 'trade
// goods'", with a courier collecting from the station and selling each lap.
//
// Two halves, both keeper policies, both of the ECONOMY faculty (a bot holding economy turns them off):
//
//   lootEject   on the GIVER.   { enabled, to: ['<character>', ...], every_s, batch, extra, merchant, overflow_at,
//                                 drop_max, only_received }
//               When one of `to` is in the same room, offer it the heaviest rows of this keeper's own sale plan
//               (`inventorySalePlan`, state 'sell': the same rows a market visit would sell, so nothing the plan keeps
//               -- equipped, protected, magic, a fleet reagent, food, a loadout keep -- can leave). `to` is in order of
//               preference: a station first, then a courier. One offer of up to `batch` items per `every_s`, the BEST
//               shillings per unit of pack first (valued at the courier's `merchant` tier); a refusal backs that receiver
//               off for BACKOFF_MS. `extra` names items to eject that the plan would keep (gems the fleet keeps as
//               reagents, say). OVERFLOW: over `overflow_at` fullness with nobody to take it, the WORST value per unit of
//               pack is dropped where it stands (at most `drop_max` a pass; never an unpriced or `extra` item). Operator:
//               "The whole purpose is maximum income, if there's an overflow of loot just drop worst performing
//               bulk/weight to value ratio". `only_received`: a station passes on only what it was given as trade goods.
//   tradeGoods  on the RECEIVER, inside accept_donations: { enabled, keep_free, from }
//               Take a fleetmate's offer of anything, as long as the pack is still `keep_free` empty afterwards
//               (a station's cache is its SPARE space; the service it runs comes first). `from` limits the givers.
//
// A station passes its trade goods on the same way: it carries `lootEject: { to: ['<courier>'] }`, and the courier
// carries tradeGoods. A courier carries no lootEject, or goods would circulate. Pure; the keeper half is
// Autopilot.ejectLoot / giveItems (tools/autopilot/delivery.mjs) and acceptDonations (tools/autopilot/social.mjs).
import { weighPack, weighItem } from './m59-items.mjs';
import { scoreItem } from './m59-overfarm.mjs';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKOFF_MS = 5 * 60_000;
const names = (v, what) => {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) throw new Error(`${what} must be a list of character names`);
  return [...new Set(v.map(x => x.trim()))];
};

/** lootEject: null (off) or { enabled: true, to: [names], every_s: 90, batch: 6 }. Throws with the reason. */
export function normalizeLootEject(v) {
  if (v == null || v.enabled === false) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('lootEject must be null or { enabled, to, every_s, batch }');
  const KNOWN = ['enabled', 'to', 'every_s', 'batch', 'extra', 'merchant', 'overflow_at', 'drop_max', 'only_received'];
  const bad = Object.keys(v).filter(k => !KNOWN.includes(k));
  if (bad.length) throw new Error(`lootEject: ${bad.join(', ')} not known (${KNOWN.join(', ')})`);
  const to = names(v.to ?? [], 'lootEject.to');
  const overflow_at = v.overflow_at == null ? null : Number(v.overflow_at);
  if (overflow_at != null && (!Number.isFinite(overflow_at) || overflow_at < 0.3 || overflow_at > 1))
    throw new Error('lootEject.overflow_at must be a pack fullness from 0.3 to 1');
  if (!to.length && overflow_at == null) throw new Error('lootEject.to names nobody to eject to (and no overflow_at)');
  const drop_max = v.drop_max == null ? 4 : Number(v.drop_max);
  if (!Number.isInteger(drop_max) || drop_max < 1 || drop_max > 20) throw new Error('lootEject.drop_max must be 1..20');
  const extra = v.extra == null ? [] : [...new Set(names(v.extra, 'lootEject.extra').map(n => n.toLowerCase()))];
  const merchant = v.merchant == null ? 'normal' : String(v.merchant);
  if (v.only_received != null && typeof v.only_received !== 'boolean') throw new Error('lootEject.only_received must be true or false');
  const every_s = v.every_s == null ? 90 : Number(v.every_s);
  if (!Number.isFinite(every_s) || every_s < 20 || every_s > 1800) throw new Error('lootEject.every_s must be 20..1800');
  const batch = v.batch == null ? 6 : Number(v.batch);
  if (!Number.isInteger(batch) || batch < 1 || batch > 12) throw new Error('lootEject.batch must be 1..12');
  return { enabled: true, to, every_s, batch, extra, merchant, overflow_at, drop_max, only_received: v.only_received === true };
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

// WHAT A UNIT IS WORTH TO THE COURIER, PER UNIT OF PACK IT TAKES (m59-overfarm.mjs scoreItem: shillings at the courier's
// merchant tier over the worse of weight and bulk). Null when it cannot be priced or weighed: unrankable, never worthless.
export function densityOf(name, { merchant = 'normal', score = scoreItem } = {}) {
  try { const r = score(name, { merchant }); return r?.rankable ? r.score : null; } catch { return null; }
}
const byBest = (a, b) => (b.density ?? -1) - (a.density ?? -1) || b.load - a.load;

/**
 * The candidates: the sale plan's 'sell' rows plus anything named in `extra` (the operator's own choice, e.g. gems the
 * plan keeps as fleet reagents), never equipped, never a synthetic (negative) id. With `received` (a station passing
 * on only what it was given), only up to those counts by name. -> [{ id, name, amount, whole, density, load }]
 */
export function ejectCandidates(planItems = [], { extra = [], received = null, merchant = 'normal', weigh = weighItem, score } = {}) {
  const left = received ? new Map(Object.entries(received).map(([k, n]) => [k.toLowerCase(), Number(n) || 0])) : null;
  const out = [];
  for (const i of planItems) {
    if (!i || i.equipped || i.id == null || Number(i.id) < 0) continue;
    const name = String(i.name ?? '');
    const lower = name.toLowerCase();
    const held = Number(i.amount) > 0 ? Number(i.amount) : 1;
    let amount = 0;
    if (left) amount = Math.min(held, left.get(lower) ?? 0);
    else if (i.state === 'sell' && Number(i.sale_amount) > 0) amount = Number(i.sale_amount);
    else if (extra.some(e => lower === e || lower.includes(e))) amount = held;
    if (!(amount > 0)) continue;
    if (left) left.set(lower, (left.get(lower) ?? 0) - amount);
    const w = weigh(name);
    out.push({ id: i.id, name, amount, whole: amount >= held,
               density: densityOf(name, { merchant, ...(score ? { score } : {}) }),
               load: w ? Math.max(w.weight, w.bulk) * amount : 0 });
  }
  return out;
}

/** The offer: the BEST value per unit of pack first (the courier's room is the scarce thing), at most `batch`. */
export function ejectBatch(planItems = [], { batch = 6, ...opts } = {}) {
  return ejectCandidates(planItems, opts).sort(byBest).slice(0, batch).map(({ load, density, ...r }) => r);
}

/**
 * OVERFLOW: nobody came to take it and the pack is over `overflowAt`. Drop the WORST value per unit of pack first, until
 * the pack is back under the line, at most `max` rows. Never an unrankable row (unpriced is not worthless), never an
 * `extra` row (the operator kept it on purpose). `fullness` is the pack's current fraction; `capMax` its ceiling.
 * -> [{ id, name, amount, whole }]
 */
export function overflowDrops(planItems = [], { fullness, capMax, overflowAt, max = 4, merchant = 'normal', weigh = weighItem, score } = {}) {
  if (overflowAt == null || !(fullness >= overflowAt) || !(capMax > 0)) return [];
  const rows = ejectCandidates(planItems.filter(i => i?.state === 'sell'), { merchant, weigh, score })
    .filter(r => r.density != null && r.load > 0)
    .sort((a, b) => a.density - b.density);
  const out = [];
  let f = fullness;
  for (const r of rows) {
    if (f < overflowAt || out.length >= max) break;
    out.push({ id: r.id, name: r.name, amount: r.amount, whole: r.whole });
    f -= r.load / capMax;
  }
  return out;
}

// ------------------------------------------------------------------ what a station was given, by name
// A station passes on ONLY what it received as trade goods (`only_received`), counted by name, because its own pack
// may hold the same names for its own work: Raphael's dedication armoury is long swords, and so is the trade. Ids are
// temporary handles (renumbered on every save), so the count is by name, and it is saved per character.
export const RECEIVED_DIR = process.env.M59_TRADE_GOODS_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', '.trade-goods');
const fileOf = (agent, dir) => join(dir, `${String(agent ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
export function readReceived(agent, dir = RECEIVED_DIR) {
  try { const j = JSON.parse(readFileSync(fileOf(agent, dir), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
function writeReceived(agent, counts, dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const p = fileOf(agent, dir), tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(counts) + '\n'); renameSync(tmp, p);
  } catch { /* the count is a guard, not the goods: a station that cannot save it passes on less, never more */ }
}
/** Add what arrived (`[{ name, amount }]`). */
export function noteReceived(agent, items = [], dir = RECEIVED_DIR) {
  const c = readReceived(agent, dir);
  for (const i of items) { const k = String(i.name ?? '').toLowerCase(); if (k) c[k] = (c[k] ?? 0) + (Number(i.amount) > 0 ? Number(i.amount) : 1); }
  writeReceived(agent, c, dir);
  return c;
}
/** Take away what left (passed on, sold, dropped). */
export function noteGone(agent, items = [], dir = RECEIVED_DIR) {
  const c = readReceived(agent, dir);
  for (const i of items) { const k = String(i.name ?? '').toLowerCase(); if (k in c) { c[k] -= Number(i.amount) || 1; if (c[k] <= 0) delete c[k]; } }
  writeReceived(agent, c, dir);
  return c;
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
