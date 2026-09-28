#!/usr/bin/env node
// MAKE ROOM IN THE GUILD CHESTS: evict overstock, rebuyable-in-town first, least valuable first.
//
//   node tools/m59-chest-evict.mjs plan                    what would go, chest by chest (no server writes)
//   node tools/m59-chest-evict.mjs plan --fill 0.7         aim every chest at 70% bulk instead of 80%
//   node tools/m59-chest-evict.mjs run --agent t9          one character draws it out and sells it in town
//   node tools/m59-chest-evict.mjs run --agent t9 --dry    walk through the plan without drawing or selling
//   node tools/m59-chest-evict.mjs run --agent t3 --own herb,elderberry --keep herb:40,elderberry:60
//        the runner's own stock goes in first; what the chests refuse, if cheap and sold in town, is sold
//
// Operator, 2026-09-28, the universal default: "Free room by evicting low overstock first, with an
// absolute preference for overstock that can be rebought in [Barloque] first (whatever town the
// guild chest is in) ... Usually you can sell things the same place you can buy them, make it all
// reusable and generalizable".
//
// WHAT "OVERSTOCK" IS. The guild plan (substrate/guild-plan.json, m59-guildwants) names a target per
// chest per item. Anything a chest holds above its target is overstock; an item with no target is
// overstock entire. Nothing at or under its target is ever touched — the plan is what the guild
// has said it wants, and emptying a chest below it only makes a keeper go and fetch it again.
//
// THE ORDER, and why it is an order and not a score:
//   1. `here`       — sold by a merchant in the chest's own town (Barloque for the Bookmaker's hall).
//                     Evicting it costs nothing that cannot be undone a few doors away, and the same
//                     merchant is where it is sold: "you can sell things the same place you can buy them".
//   2. `elsewhere`  — sold by some merchant in the world, not in this town. Replaceable, at a walk.
//   3. `none`       — nobody sells it. Irreplaceable (gems from drops, magic, unrevealed items).
//                     Never planned unless --allow-irreplaceable; the default can only ever cost a walk.
// Within a tier, the lowest value per unit of bulk goes first (m59-overfarm unitWorth / unitCost), so
// the room is bought with the least money. A tier is exhausted before the next is touched: that is the
// "absolute preference".
//
// WHICH CHESTS. A chest over `fill` (80% of its 24,000 bulk, storebox/chest.kod:29) is brought down to
// it; a chest under it is left alone. ReqNewHold refuses a put past the capacity in silence, which is
// how this was found: Statler's 250 herbs bounced twice at 06:33 on 2026-09-28 with r18c6 at 23,961.
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));

export const CHEST_BULK = 24_000;               // storebox/chest.kod:29 viBulk_hold_max
export const DEFAULTS = Object.freeze({
  fill: 0.8,                                     // bring each chest down to this share of its bulk
  hall_room: 714,                                // the Bookmaker's guild house: its town is the chests' town
  blocked_merchants: Object.freeze(['Meidei']),  // a fence blocks the Bhrama & Falcon's door (operator, 2026-09-28)
  protect: Object.freeze([]),                    // names never evicted, whatever the plan says
  allow_irreplaceable: false,
  cheap_per_bulk: 2.5,                           // at or under this (shillings per bulk), town stock is sold rather than moved
});

const norm = s => String(s ?? '').toLowerCase().trim();

/**
 * Who sells each item, as {item -> [{merchant, room}]}, from the merchant catalogue (classes) and the
 * item table (class -> name). Pure given its inputs. Blocked merchants are left out.
 */
export function sellersByItem({ merchants = [], items = {}, blocked = [] } = {}) {
  const nameOfCls = new Map();
  for (const it of Object.values(items)) if (it?.cls && !nameOfCls.has(it.cls)) nameOfCls.set(it.cls, it.name);
  const bad = new Set(blocked.map(norm));
  const out = new Map();
  for (const m of merchants) {
    if (m.room == null || bad.has(norm(m.name)) || bad.has(norm(m.cls))) continue;
    for (const s of m.sells ?? []) {
      const name = nameOfCls.get(s.cls);
      if (!name) continue;
      const k = norm(name);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push({ merchant: m.name ?? m.cls, room: m.room });
    }
  }
  return out;
}

/**
 * THE PLAN. Pure.
 *   chests:   [{slot, items: [{name, amount}]}]
 *   targets:  Map(slot -> Map(itemLower -> target))
 *   sellers:  Map(itemLower -> [{merchant, room}])   (sellersByItem)
 *   townRooms: the rooms of the chests' town
 *   worth(name) -> shillings per unit or null;  bulk(name) -> bulk per unit or null
 *
 * FOR EACH CHEST OVER ITS GOAL, IN THIS ORDER (operator, 2026-09-28: "Over stocking the unfull chests
 * also works, particularly for items of value" — move before selling, sell only what is cheap and
 * rebuyable in town, or whatever still won't fit):
 *   1. MOVE overstock into chests under their goal — the most valuable per bulk first, and anything
 *      nobody sells (a move is not a loss). Cheap town-rebuyable stock is not moved: it would only
 *      spend another chest's room on something the town sells back.
 *   2. SELL cheap overstock (value per bulk <= cheapPerBulk) that a merchant in this town sells,
 *      least valuable first.
 *   3. SELL WHATEVER STILL WON'T FIT: the remaining overstock that somebody sells, town first, least
 *      valuable first. Nothing nobody sells is ever sold unless allowIrreplaceable.
 * Returns {chests: [{slot, bulk, goal, need, freed, short, moves, evict}], total, moves}.
 */
export function planEviction({ chests = [], targets = new Map(), sellers = new Map(), townRooms = [],
                               worth = () => null, bulk = () => null, fill = DEFAULTS.fill,
                               capacity = CHEST_BULK, protect = [], allowIrreplaceable = false,
                               cheapPerBulk = DEFAULTS.cheap_per_bulk } = {}) {
  const town = new Set(townRooms.map(Number));
  const guard = new Set(protect.map(norm));
  const TIER = { here: 0, elsewhere: 1, none: 2 };
  const goal = Math.floor(capacity * fill);
  const merge = ch => {
    const m = new Map();
    for (const it of ch.items ?? []) {
      const k = norm(it.name);
      m.set(k, { name: it.name, amount: (m.get(k)?.amount ?? 0) + (Number(it.amount) > 0 ? Number(it.amount) : 1) });
    }
    return m;
  };
  const state = chests.map(ch => {
    const merged = merge(ch);
    const used = [...merged.values()].reduce((n, it) => n + (bulk(it.name) ?? 0) * it.amount, 0);
    return { slot: ch.slot, merged, used, room: Math.max(0, goal - used) };
  });
  const out = [], allMoves = [];
  for (const d of state) {
    const need = Math.max(0, d.used - goal);
    const want = targets.get(d.slot) ?? new Map();
    const cands = [];
    for (const [k, it] of d.merged) {
      if (guard.has(k)) continue;
      const over = it.amount - (want.get(k) ?? 0);
      const b = bulk(it.name);
      if (over <= 0 || !(b > 0)) continue;
      const who = sellers.get(k) ?? [];
      const tier = who.some(s => town.has(Number(s.room))) ? 'here' : who.length ? 'elsewhere' : 'none';
      const v = worth(it.name);
      const perBulk = v == null ? null : v / b;
      cands.push({ item: it.name, over, left: over, unit_bulk: b, unit_value: v, per_bulk: perBulk, tier,
                   cheap_here: tier === 'here' && perBulk != null && perBulk <= cheapPerBulk,
                   sell_at: who.find(s => town.has(Number(s.room))) ?? who[0] ?? null,
                   target: want.get(k) ?? 0, have: it.amount });
    }
    let left = need;
    const moves = [], evict = [];
    const take = (c, n) => { c.left -= n; left -= n * c.unit_bulk; };
    // 1. MOVE: valuables (and the irreplaceable) into chests with room, most valuable per bulk first.
    const movable = cands.filter(c => !c.cheap_here)
      .sort((a, b) => (b.per_bulk ?? Infinity) - (a.per_bulk ?? Infinity));
    for (const c of movable) {
      while (left > 0 && c.left > 0) {
        const to = state.filter(r => r !== d && r.room >= c.unit_bulk).sort((a, b) => b.room - a.room)[0];
        if (!to) break;
        const n = Math.min(c.left, Math.ceil(left / c.unit_bulk), Math.floor(to.room / c.unit_bulk));
        if (n <= 0) break;
        to.room -= n * c.unit_bulk;
        moves.push({ item: c.item, amount: n, from: d.slot, to: to.slot, bulk: n * c.unit_bulk, per_bulk: c.per_bulk, tier: c.tier });
        take(c, n);
      }
      if (left <= 0) break;
    }
    // 2 and 3. SELL: cheap town stock first, then whatever still won't fit (town first).
    const sellable = cands.filter(c => c.left > 0 && (c.tier !== 'none' || allowIrreplaceable))
      .sort((a, b) => (b.cheap_here - a.cheap_here) || TIER[a.tier] - TIER[b.tier]
        || (a.per_bulk ?? Infinity) - (b.per_bulk ?? Infinity));
    for (const c of sellable) {
      if (left <= 0) break;
      const n = Math.min(c.left, Math.ceil(left / c.unit_bulk));
      evict.push({ ...c, amount: n, bulk: n * c.unit_bulk, value: c.unit_value == null ? null : n * c.unit_value,
                   why: c.cheap_here ? 'cheap and sold in this town' : 'still would not fit' });
      take(c, n);
    }
    allMoves.push(...moves);
    out.push({ slot: d.slot, bulk: Math.round(d.used), capacity, goal, need: Math.round(need),
               freed: Math.round(need - Math.max(0, left)), short: Math.round(Math.max(0, left)), moves, evict });
  }
  const total = new Map();
  for (const c of out) for (const e of c.evict) {
    const t = total.get(norm(e.item)) ?? { item: e.item, amount: 0, bulk: 0, value: 0, tier: e.tier, sell_at: e.sell_at };
    t.amount += e.amount; t.bulk += e.bulk; t.value += e.value ?? 0;
    total.set(norm(e.item), t);
  }
  return { chests: out, total: [...total.values()], moves: allMoves };
}

// ------------------------------------------------------------------ the live inputs
export async function liveInputs({ root = here('..'), hallRoom = DEFAULTS.hall_room, blocked = DEFAULTS.blocked_merchants } = {}) {
  const { StorageCache } = await import('./m59-storage.mjs');
  const { guildPlan } = await import('./m59-guildwants.mjs');
  const { townOfRoom } = await import('./m59-profiles.mjs');
  const { unitWorth, unitCost } = await import('./m59-overfarm.mjs');
  const chests = new StorageCache().allChests().filter(c => Number(c.room) === Number(hallRoom))
    .map(c => ({ slot: c.slot, items: c.items ?? [], observed_at: c.observed_at ?? null }));
  const plan = guildPlan();
  const targets = new Map();
  for (const [slot, items] of plan?.chests ?? new Map()) targets.set(slot, new Map(items.map(i => [norm(i.item), Number(i.target) || 0])));
  const merchants = JSON.parse(readFileSync(join(root, 'substrate', 'm59-merchants.json'), 'utf8')).merchants ?? [];
  const items = JSON.parse(readFileSync(join(root, 'substrate', 'm59-items.json'), 'utf8')).items ?? {};
  const town = townOfRoom(hallRoom);
  return {
    chests, targets, town,
    sellers: sellersByItem({ merchants, items, blocked }),
    townRooms: town?.rooms ?? [],
    worth: n => unitWorth(n).value,
    bulk: n => { const c = unitCost(n); return c.known ? c.bulk : null; },
  };
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const has = n => argv.includes(`--${n}`);
  const verb = argv[0];
  const fill = Number(arg('fill', DEFAULTS.fill));
  const inputs = await liveInputs();
  const plan = planEviction({ ...inputs, fill, allowIrreplaceable: has('allow-irreplaceable'), protect: DEFAULTS.protect });
  const say = (...a) => console.log(...a);

  if (verb === 'plan' || verb === 'run') {
    say(`chests in ${inputs.town?.name ?? '?'} (room ${DEFAULTS.hall_room}), aiming at ${Math.round(fill * 100)}% of ${CHEST_BULK} bulk each:`);
    for (const c of plan.chests) {
      say(`\n${c.slot}: ${c.bulk} bulk (${Math.round(c.bulk / c.capacity * 100)}%)` +
          (c.need ? ` -> free ${c.need}${c.short ? `, SHORT ${c.short} (nothing more it is allowed to evict)` : ''}` : ' — under the goal, left alone'));
      for (const m of c.moves ?? [])
        say(`   MOVE ${String(m.amount).padStart(5)} ${m.item.padEnd(22)} -> ${m.to}  ${String(m.bulk).padStart(6)} bulk` +
            `  (${m.per_bulk == null ? '?' : m.per_bulk.toFixed(1)} sh/bulk, ${m.tier})`);
      for (const e of c.evict)
        say(`   SELL ${String(e.amount).padStart(5)} ${e.item.padEnd(22)} ${e.tier.padEnd(9)} ${String(e.bulk).padStart(6)} bulk` +
            `  ${e.value == null ? '   ? sh' : `${String(e.value).padStart(6)} sh`}  (has ${e.have}, target ${e.target})` +
            (e.sell_at ? `  sell: ${e.sell_at.merchant} @${e.sell_at.room}` : ''));
    }
    const sum = plan.total.reduce((a, t) => ({ bulk: a.bulk + t.bulk, value: a.value + t.value }), { bulk: 0, value: 0 });
    say(`\ntotal: ${plan.total.length} items, ${sum.bulk} bulk freed, about ${sum.value} shillings at sale.`);
    say('(bulk is from the cached chest readings; an item the table cannot weigh counts zero, so a chest can be fuller than it reads.)');
  } else {
    say('usage: plan [--fill 0.8] [--allow-irreplaceable] | run --agent <a> [--dry]');
    process.exit(2);
  }
  if (verb === 'run') {
    const { runEviction } = await import('./m59-chest-evict-run.mjs');
    // --keep "herb:40,elderberry:60": what the runner keeps of its OWN stock of a planned item.
    const keep = Object.fromEntries(String(arg('keep', '')).split(',').filter(Boolean).map(x => { const [k, v] = x.split(':'); return [k.trim().toLowerCase(), Number(v) || 0]; }));
    // --own "herb,elderberry": the runner's OWN stock to put in; what the chests refuse is sold if it is
    // cheap (<= cheap_per_bulk) and sold in this town, else it stays carried.
    const own = String(arg('own', '')).split(',').map(x => x.trim()).filter(Boolean);
    const sellAt = name => {
      const who = inputs.sellers.get(String(name).toLowerCase()) ?? [];
      const at = who.find(x => (inputs.townRooms ?? []).includes(Number(x.room)));
      const v = inputs.worth(name), b = inputs.bulk(name);
      return at && v != null && b > 0 && v / b <= DEFAULTS.cheap_per_bulk ? at : null;
    };
    // --borrow: take the runner from its training runner by the yield protocol (fresh ack only), and
    // give it back however the run ends.
    let loan = null;
    if (has('borrow') && !has('dry')) {
      const { borrow } = await import('./m59-yield.mjs');
      const ydir = fileURLToPath(new URL('../substrate/history/prod/training-yield', import.meta.url));
      say(`borrowing ${arg('agent')} from its training runner…`);
      loan = await borrow({ dir: ydir, agent: arg('agent'), why: `chest-evict:${process.pid} — making room in the guild chests` });
      say('yielded');
    }
    try { await runEviction({ plan, agent: arg('agent'), dry: has('dry'), log: say, keep, own, sellAt }); }
    finally { loan?.release(); if (loan) say('released'); }
  }
}
