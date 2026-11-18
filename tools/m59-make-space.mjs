// MAKE SPACE: drop what this character was going to sell anyway, until N bulk/weight is free.
//
// Operator, 2026-11-05: "A more general harness fix for anytime anyone needs up to maybe 400
// bulk/weight space: just drop items planned to be sold, it's fine." The incident was Rizzo
// (t19): he conjures his weapons, his pack stood at 97% bulk, and his keeper reported
// `unarmed -- 60 bulk free, needs 70 to hold one` while refusing every journey that could have
// taken him to a merchant. Nothing regenerates pack space, so it was a dead end with a pack full
// of things the keeper itself had already decided to sell.
//
// THE PLAN IS THE ONLY SOURCE. A row may be dropped only when the character's OWN sale plan
// (`inventorySalePlan`, on the same terms the market counter sells on — the keeper's
// `ownSalePlan()`) recommends it, has queued it, and blocks it for no reason. That is what keeps
// out everything the plan already protects: equipped gear, loadout-kept and protected names, what
// the fleet wants, conjured (IA_MADE) items, operator keep vetoes and the keep list. On top of
// that, a floor nobody can talk past: never money, never food, never a bow, arrows or the chalice,
// never a row whose id the keeper is holding back (enchanted, just delivered), and never more of a
// stack than the plan's own `sale_amount` (the rest is a loadout reserve).
//
// LEAST VALUABLE PER UNIT OF WHAT IS SHORT, FIRST. The value is the catalogue estimate
// (m59-item-value.mjs) and the space is the static weight table (m59-items.mjs). An item whose
// value is unknown is dropped only after every known one — unknown is not cheap — and an item the
// weight table does not know is never dropped, because nothing could say what dropping it freed.
//
// JUDGED BY WHAT LEFT THE PACK. Every drop is followed by a fresh inventory read and the id's
// amount is compared; a drop the server did not take frees nothing and is reported as refused.
//
// `sale_plan` (the broker tool) shows these same rows, with `droppable` and `drop_block`, so what
// it shows is exactly what make_space would choose from.
import { weighItem } from './m59-items.mjs';
import { estimateItemSellValue } from './m59-item-value.mjs';
import { dropSpec } from './m59-parse.mjs';

export const MAKE_SPACE_MAX = 400;
// Never dropped whatever the plan says. Food is the larder's to decide; bows and arrows are the
// archers' kit (sold only on Ko'catan, never bought back on the mainland); the chalice is a duty.
const NEVER = /shilling|coin|\bbow\b|\barrows?\b|chalice/i;

function unitValue(name) {
  try { return estimateItemSellValue(name, { quantity: 1 }).sell_value; } catch { return null; }
}

// The target, clamped. Each of bulk and weight is optional; a missing or non-positive one is 0.
export function makeSpaceTarget({ bulk = null, weight = null } = {}) {
  const one = v => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(MAKE_SPACE_MAX, n) : 0;
  };
  return { bulk: one(bulk), weight: one(weight) };
}

// ONE PLAN ROW, ANNOTATED. `droppable` and `drop_block` are make_space's verdict; the rest is the
// plan's own row plus the static weights and the catalogue value.
export function annotateRow(row, { heldBack = new Set() } = {}) {
  const w = weighItem(row.name);
  const value = unitValue(row.name);
  const amount = row.amount > 0 ? row.amount : 1;
  const saleAmount = Math.max(0, Math.min(amount, Number(row.sale_amount) || 0));
  let block = null;
  if (row.equipped) block = 'equipped';
  else if (NEVER.test(row.name)) block = 'never dropped (money, bow, arrows or the chalice)';
  else if (row.role === 'food') block = 'food: the larder decides';
  else if (heldBack.has(Number(row.id))) block = 'held back by the keeper (enchanted or just delivered)';
  else if (row.recommended !== true) block = 'not recommended for sale';
  else if (row.blocked) block = `sale blocked: ${row.blocked}`;
  else if (row.merchant_only) block = 'fleet-wanted overflow is for merchant sale';
  else if (!row.queued) block = row.reason || 'not queued for sale';
  else if (!(saleAmount > 0)) block = 'working stock reserved by the loadout';
  else if (!w) block = 'not in the weight table, so dropping it frees an unknown amount';
  return {
    id: row.id, name: row.name, amount, sale_amount: saleAmount, role: row.role ?? null,
    equipped: !!row.equipped, recommended: row.recommended === true, blocked: row.blocked ?? null,
    queued: !!row.queued, state: row.state ?? null, reason: row.reason ?? null,
    unit: w ? { bulk: w.bulk, weight: w.weight } : null,
    unit_value: value,
    stack_value: value == null ? null : value * amount,
    droppable: !block, drop_block: block,
  };
}

function sums(rows, amountOf) {
  let bulk = 0, weight = 0, value = 0, units = 0, unweighed = 0, unvalued = 0;
  for (const r of rows) {
    const n = amountOf(r);
    if (!(n > 0)) continue;
    units += n;
    if (r.unit) { bulk += r.unit.bulk * n; weight += r.unit.weight * n; } else unweighed++;
    if (r.unit_value != null) value += r.unit_value * n; else unvalued++;
  }
  return { stacks: rows.filter(r => amountOf(r) > 0).length, units, bulk, weight, value,
           ...(unweighed ? { unweighed } : {}), ...(unvalued ? { unvalued } : {}) };
}

// WHAT A TOWN TRIP WOULD SELL AND WHAT IT WOULD KEEP, and what make_space could drop.
export function salePlanSummary(plan, { heldBack = new Set(), capacity = null } = {}) {
  const rows = (plan?.items ?? []).map(r => annotateRow(r, { heldBack }));
  const sold = r => (r.state === 'sell' && r.queued && !heldBack.has(Number(r.id)) ? r.sale_amount : 0);
  return {
    ok: !plan?.error, ...(plan?.error ? { error: plan.error } : {}),
    rows,
    totals: {
      sell: sums(rows, sold),
      keep: sums(rows, r => r.amount - sold(r)),
      droppable: sums(rows, r => (r.droppable ? r.sale_amount : 0)),
    },
    held_for_the_fleet: plan?.held ?? [],
    ...(capacity ? { capacity: capacityView(capacity) } : {}),
  };
}

export function capacityView(cap) {
  if (!cap?.known) return { known: false, why: cap?.why ?? 'capacity unknown' };
  return { known: true, bulk_max: cap.bulk_max, weight_max: cap.weight_max,
           load: cap.load, free: freeOf(cap), exact: !!cap.load?.exact };
}

// Free space. When the load is a lower bound (something unweighed) this is an UPPER bound on the
// free space, which can only make make_space drop too little, never too much.
export function freeOf(cap) {
  if (!cap?.known) return null;
  if (cap.room_for) return { bulk: cap.room_for.bulk, weight: cap.room_for.weight };
  return { bulk: cap.bulk_max - (cap.load?.bulk ?? 0), weight: cap.weight_max - (cap.load?.weight ?? 0) };
}

// WHICH DROPS, AND HOW MANY OF EACH — pure. Greedy on the dimension furthest short: the candidate
// with the lowest value per unit of THAT dimension goes first, as many units as close the gap
// (partial stacks), then the gap is recomputed. Unknown value sorts after every known one.
export function chooseDrops(rows, { free, need }) {
  const short = {
    bulk: Math.max(0, (need?.bulk ?? 0) - (free?.bulk ?? 0)),
    weight: Math.max(0, (need?.weight ?? 0) - (free?.weight ?? 0)),
  };
  const left = new Map(rows.filter(r => r.droppable && r.unit && r.sale_amount > 0)
    .map(r => [r.id, { row: r, units: r.sale_amount }]));
  const picks = new Map();
  let guard = 0;
  while ((short.bulk > 0 || short.weight > 0) && left.size && guard++ < 4096) {
    const dim = short.bulk >= short.weight ? 'bulk' : 'weight';
    const options = [...left.values()].filter(x => x.row.unit[dim] > 0);
    if (!options.length) {
      // Nothing frees this dimension; try the other one if it is still short.
      const other = dim === 'bulk' ? 'weight' : 'bulk';
      if (short[other] > 0 && [...left.values()].some(x => x.row.unit[other] > 0)) { short[dim] = 0; continue; }
      break;
    }
    const cost = x => (x.row.unit_value == null ? Infinity : x.row.unit_value / x.row.unit[dim]);
    options.sort((a, b) => cost(a) - cost(b) || (b.row.unit[dim] - a.row.unit[dim]) || (a.row.id - b.row.id));
    const best = options[0];
    const n = Math.min(best.units, Math.ceil(short[dim] / best.row.unit[dim]));
    const p = picks.get(best.row.id) ?? { row: best.row, amount: 0 };
    p.amount += n;
    picks.set(best.row.id, p);
    best.units -= n;
    if (best.units <= 0) left.delete(best.row.id);
    short.bulk = Math.max(0, short.bulk - best.row.unit.bulk * n);
    short.weight = Math.max(0, short.weight - best.row.unit.weight * n);
  }
  return { picks: [...picks.values()], short_by: short };
}

const nameOfIn = (c, o) => c.rsc?.get?.(o.nameRsc) || o.name || '';

async function readPack(s, c) {
  const since = c.evSeq;
  await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
  await c.waitFor({ since, kinds: ['inventory'], timeoutMs: 3000 }).catch(() => null);
}

// DO IT. `planOf()` is the keeper's own sale plan (called fresh, after a pack read); `capacityOf()`
// is `skills.carryCapacity(c)`. Every drop is by exact id and amount and verified by a re-read.
export async function makeSpace(s, { bulk = null, weight = null, planOf, capacityOf, heldBack = () => new Set(),
                                     maxDrops = 40, why = 'make_space', beforeDrop = null } = {}) {
  const c = s.need ? s.need() : s.client;
  const needed = makeSpaceTarget({ bulk, weight });
  const out = (o) => ({ needed, ...o });
  if (!needed.bulk && !needed.weight) return out({ ok: false, refused: 'no target', why: 'give bulk and/or weight, 1..400',
    freed: { bulk: 0, weight: 0 }, dropped: [], short_by: { bulk: 0, weight: 0 } });
  if (c.trade) return out({ ok: false, refused: 'trading', why: 'a trade is open; nothing is dropped mid-offer',
    freed: { bulk: 0, weight: 0 }, dropped: [], short_by: needed });
  await readPack(s, c);
  const cap0 = capacityOf();
  const free0 = freeOf(cap0);
  if (!free0) return out({ ok: false, refused: 'capacity unknown', why: cap0?.why ?? 'might has not been read',
    freed: { bulk: 0, weight: 0 }, dropped: [], short_by: needed });
  const exact = !!cap0.load?.exact;
  const before = { free: free0, exact };
  const plan = planOf();
  const summary = salePlanSummary(plan, { heldBack: heldBack() });
  if (plan?.error) return out({ ok: false, refused: 'sale plan unavailable', why: plan.error, before,
    freed: { bulk: 0, weight: 0 }, dropped: [], short_by: { bulk: Math.max(0, needed.bulk - free0.bulk),
                                                           weight: Math.max(0, needed.weight - free0.weight) } });
  const { picks } = chooseDrops(summary.rows, { free: free0, need: needed });
  const dropped = [], refused = [];
  const freed = { bulk: 0, weight: 0 };
  for (const p of picks.slice(0, maxDrops)) {
    // RE-READ BEFORE ACTING: the id must still be in the pack and still be the same thing.
    const live = (c.inventory || []).find(o => o.id === p.row.id);
    if (!live || nameOfIn(c, live) !== p.row.name) { refused.push({ name: p.row.name, why: 'gone or changed since the plan' }); continue; }
    const had = live.amount > 0 ? live.amount : 1;
    const amount = Math.min(p.amount, had);
    let prevented = false;
    await s.pacer.submit('drop', () => {
      if (beforeDrop && !beforeDrop()) { prevented = true; return; }
      return c.drop([dropSpec(live, amount)]);
    }).catch(() => {});
    if (prevented) break;
    await readPack(s, c);
    const still = (c.inventory || []).find(o => o.id === p.row.id);
    const gone = Math.max(0, had - (still ? (still.amount > 0 ? still.amount : 1) : 0));
    if (!gone) { refused.push({ name: p.row.name, why: 'the server did not take the drop' }); continue; }
    freed.bulk += p.row.unit.bulk * gone;
    freed.weight += p.row.unit.weight * gone;
    dropped.push({ id: p.row.id, name: p.row.name, amount: gone, why: `${p.row.reason || 'on the sale plan'}` +
      (p.row.unit_value == null ? '; value unknown' : `; ~${p.row.unit_value} each`) });
  }
  const after = freeOf(capacityOf()) ?? { bulk: free0.bulk + freed.bulk, weight: free0.weight + freed.weight };
  const short_by = { bulk: Math.max(0, needed.bulk - after.bulk), weight: Math.max(0, needed.weight - after.weight) };
  const met = !short_by.bulk && !short_by.weight;
  const notes = [
    ...(met ? [] : ['the sale plan could not cover it; nothing outside the plan is ever dropped']),
    ...(exact ? [] : ['the load is a lower bound (something is unweighed), so the free space is an upper bound and ok stays false']),
  ];
  return out({
    ok: met && exact, before, after: { free: after }, freed, dropped, short_by,
    ...(refused.length ? { refused_items: refused } : {}),
    ...(notes.length ? { note: notes.join('; ') } : {}),
    why,
  });
}
