// LEAVING KO'CATAN BY THE EAST TOWER WITH ONLY WHAT THE GUARD ALLOWS, AND GETTING THE REST BACK.
//
// The captain in the East Guard Tower (2013) checks everyone stepping onto the exit to KA5
// (koctower.kod SomethingTryGo, rows 2-3 cols 40-41) and refuses more than two weapons, a
// second suit of armour, helmet, pair of gauntlets or shield, any alcohol, and raw nerudite
// (kocatwn.kod CanPass). Nobody is checked coming back in. So an errand into the jungle drops
// the excess at a fixed spot in the tower, goes out, comes back, and picks it up.
//
// This is the chalice refill's stash (m59-island-chalice.mjs) lifted out so any errand can
// use it across several FleetScript steps: the same classifier, the same drop/retrieve with
// save-renumbering handled, the same equipment restore, and the same lock — receipts live in
// the chalice's directory on purpose, so a refill and an errand never stash identical items at
// the same spot together. A traveller with nothing to drop takes no lock and drops nothing.
//
//   const stash = await stashForJungle(ctx, { record, save });   // standing in 2013
//   ... walk out, do the errand, walk back to 2013 ...
//   await recoverJungleStash(ctx, { record, save });
import { jungleStashPlan, jungleItemClassifier, acquireStashLease, releaseStashLease,
         pack, freshPackItem, dropItem, retrieve, restoreEquipment, identity } from './m59-island-chalice.mjs';
import { location } from './m59-island-route.mjs';

export const GUARD_TOWER = 2013, STASH_SPOT = { row: 4, col: 40 };
export const STASH_DIR = 'substrate/island-chalice';

// What the guard would make this pack leave behind. Pure apart from the classifier's table.
export function guardDrops(items, equipped = []) {
  return jungleStashPlan(items, { equipped, classify: jungleItemClassifier() }).drop;
}

export async function stashForJungle(ctx, { record, save, spot = STASH_SPOT, queueBudgetMs } = {}) {
  const { agent, call } = ctx;
  let here = location(await call('look', { agent }));
  if (here.room !== GUARD_TOWER) throw Error(`stash_requires_guard_tower (in ${here.room})`);
  const inv = await pack(ctx), eq = await call('equipment', { agent });
  if (!eq.known) throw Error('equipment_unknown');
  const drop = guardDrops(inv, eq.equipped ?? []);
  if (!drop.length) { record.stash = { room: GUARD_TOWER, items: [], none_needed: true }; save(); return record.stash; }
  // Hold the spot before walking onto it; the lease outlives this step and is released only
  // once everything dropped has been picked up again.
  record.stash_token = await acquireStashLease(ctx, record, queueBudgetMs ? { budgetMs: queueBudgetMs } : {});
  save();
  await call('walk_to', { agent, row: spot.row, col: spot.col, max_steps: 100, arrive_within: 4 }, 180000);
  here = location(await call('look', { agent }));
  if (here.room !== GUARD_TOWER || Math.abs(here.row - spot.row) + Math.abs(here.col - spot.col) > 1)
    throw Error('stash_position_not_reached');
  const floor = (await call('look', { agent })).objects ?? [];
  if (floor.some(o => drop.some(i => identity(i) === identity(o)) && Math.abs(o.row - here.row) <= 1 && Math.abs(o.col - here.col) <= 1))
    throw Error('stash_area_already_contains_matching_items');
  record.stash = { room: GUARD_TOWER, position: here, exclusive: true, keepItems: true,
                   items: drop.map(i => ({ ...i, floor: { row: here.row, col: here.col }, dropped: false, recovered: false })) };
  save();
  for (const item of record.stash.items) {
    if (item.was_equipped) { await freshPackItem(ctx, item); await call('act', { agent, verb: 'unuse', target: item.id }); item.unused = true; save(); }
    await dropItem(ctx, item); item.dropped = true; save();
  }
  if (guardDrops(await pack(ctx)).length) throw Error('contraband_remains');
  return record.stash;
}

// Standing in the tower again: pick up everything dropped, re-equip what was worn, release.
export async function recoverJungleStash(ctx, { record, save }) {
  const { agent, call } = ctx;
  const owed = (record.stash?.items ?? []).filter(i => i.dropped && (!i.recovered || i.was_equipped && !i.reequipped));
  if (owed.length) {
    const here = location(await call('look', { agent }));
    if (here.room !== GUARD_TOWER) throw Error(`stash_recovery_requires_guard_tower (in ${here.room})`);
    const at = record.stash.position;
    await call('walk_to', { agent, row: at.row, col: at.col, max_steps: 100, arrive_within: 4 }, 180000);
    for (const item of owed) {
      if (!item.recovered) { await retrieve(ctx, item, record.stash.items); item.recovered = true; save(); }
      await restoreEquipment(ctx, item, save);
    }
  }
  if (record.stash_token) { releaseStashLease(record, record.stash_token); delete record.stash_token; save(); }
  return owed.length;
}

// A stash some earlier run left on the floor: true while anything dropped is still owed.
export const stashOwed = record => (record?.stash?.items ?? []).some(i => i.dropped && (!i.recovered || i.was_equipped && !i.reequipped));
