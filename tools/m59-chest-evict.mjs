#!/usr/bin/env node
// MAKE ROOM IN THE GUILD CHESTS: evict overstock, rebuyable-in-town first, least valuable first.
//
//   node tools/m59-chest-evict.mjs plan                    what would go, chest by chest (no server writes)
//   node tools/m59-chest-evict.mjs plan --fill 0.7         aim every chest at 70% bulk instead of 80%
//   node tools/m59-chest-evict.mjs run --agent t9          one character draws it out and sells it in town
//   node tools/m59-chest-evict.mjs run --agent t9 --dry    walk through the plan without drawing or selling
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
 * Returns {chests: [{slot, bulk, capacity, over, evict: [...]}], total}.
 */
export function planEviction({ chests = [], targets = new Map(), sellers = new Map(), townRooms = [],
                               worth = () => null, bulk = () => null, fill = DEFAULTS.fill,
                               capacity = CHEST_BULK, protect = [], allowIrreplaceable = false } = {}) {
  const town = new Set(townRooms.map(Number));
  const guard = new Set(protect.map(norm));
  const TIER = { here: 0, elsewhere: 1, none: 2 };
  const out = [];
  for (const ch of chests) {
    const merged = new Map();
    for (const it of ch.items ?? []) {
      const k = norm(it.name);
      merged.set(k, { name: it.name, amount: (merged.get(k)?.amount ?? 0) + (Number(it.amount) > 0 ? Number(it.amount) : 1) });
    }
    const used = [...merged.values()].reduce((n, it) => n + (bulk(it.name) ?? 0) * it.amount, 0);
    const goal = Math.floor(capacity * fill);
    const need = Math.max(0, used - goal);
    const want = targets.get(ch.slot) ?? new Map();
    const cands = [];
    for (const [k, it] of merged) {
      if (guard.has(k)) continue;
      const over = it.amount - (want.get(k) ?? 0);
      const b = bulk(it.name);
      if (over <= 0 || !(b > 0)) continue;             // at or under target, or weightless / unknown bulk
      const who = sellers.get(k) ?? [];
      const tier = who.some(s => town.has(Number(s.room))) ? 'here' : who.length ? 'elsewhere' : 'none';
      if (tier === 'none' && !allowIrreplaceable) continue;
      const v = worth(it.name);
      cands.push({ item: it.name, over, unit_bulk: b, unit_value: v, per_bulk: v == null ? null : v / b, tier,
                   sell_at: who.find(s => town.has(Number(s.room))) ?? who[0] ?? null,
                   target: want.get(k) ?? 0, have: it.amount });
    }
    // Tier first (the absolute preference), then least value per bulk; unknown value goes last in its tier.
    cands.sort((a, b) => TIER[a.tier] - TIER[b.tier]
      || (a.per_bulk ?? Infinity) - (b.per_bulk ?? Infinity));
    const evict = [];
    let left = need;
    for (const c of cands) {
      if (left <= 0) break;
      const amount = Math.min(c.over, Math.ceil(left / c.unit_bulk));
      evict.push({ ...c, amount, bulk: amount * c.unit_bulk, value: c.unit_value == null ? null : amount * c.unit_value });
      left -= amount * c.unit_bulk;
    }
    out.push({ slot: ch.slot, bulk: Math.round(used), capacity, goal, need: Math.round(need),
               freed: Math.round(need - Math.max(0, left)), short: Math.round(Math.max(0, left)), evict });
  }
  const total = new Map();
  for (const c of out) for (const e of c.evict) {
    const t = total.get(norm(e.item)) ?? { item: e.item, amount: 0, bulk: 0, value: 0, tier: e.tier, sell_at: e.sell_at };
    t.amount += e.amount; t.bulk += e.bulk; t.value += e.value ?? 0;
    total.set(norm(e.item), t);
  }
  return { chests: out, total: [...total.values()] };
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
      for (const e of c.evict)
        say(`   ${String(e.amount).padStart(5)} ${e.item.padEnd(22)} ${e.tier.padEnd(9)} ${String(e.bulk).padStart(6)} bulk` +
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
    await runEviction({ plan, agent: arg('agent'), dry: has('dry'), log: say });
  }
}
