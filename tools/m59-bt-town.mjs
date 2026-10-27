// m59-bt-town.mjs -- BT nodes for town business: sell, bank, restock.
//
// This module decomposes the legacy _bankRunShouldGo / bankRun / bankSurplus /
// checkIfShouldSell into a BT subtree that the BTKeeper can tick natively.
//
// DESIGN PRINCIPLE: condition nodes decide, action nodes execute. The tree is a
// selector: the first node that returns SUCCESS or RUNNING wins.
//
// NODE LIST (priority order):
//   1. in_bank        -- standing in a bank? bank the surplus (no trip)
//   2. trip_machine   -- need to go to town? travel, do business, return
//
// The trip_machine is a sequence:
//   should_trip → travel_to_town → do_town_business → return_home
//
// State is tracked in bb._trip:
//   { state: 'idle' | 'travelling' | 'in_town' | 'returning',
//     destination: {room, name}, reason: string }
//
// The legacy methods are the spec: they define WHAT the behavior should be.
// This module defines HOW the BT decides and executes it. The legacy methods
// remain as fallback for non-BT characters.

import { FAILURE, SUCCESS, RUNNING } from './m59-bt.mjs';

// Cooldowns (match the legacy values exactly)
const BANK_TRIP_COOLDOWN_MS = 30 * 60 * 1000;   // 30 min (legacy: 300_000 was 5 min, extended to 30)
const SELL_TRIP_COOLDOWN_MS = 10 * 60 * 1000;   // 10 min (legacy: SELL_TRIP_COOLDOWN_MS = 600_000)
const FOOD_TRIP_COOLDOWN_MS = 5 * 60 * 1000;    // 5 min (legacy: FOOD_TRIP_COOLDOWN_MS = 300_000)

// ─── Helper: is this a bank room? ─────────────────────────────────────────────
function isBankRoom(room, client) {
  if (!room) return false;
  if (/bank/i.test(room.name || '')) return true;
  // Check for a teller object
  const objects = client?.room?.objects?.values?.() || [];
  for (const o of objects) {
    const name = client?.rsc?.get?.(o.nameRsc) || '';
    if (/bank/i.test(name)) return true;
  }
  return false;
}

// ─── Node: in_bank ────────────────────────────────────────────────────────────
// If standing in a bank, bank the surplus immediately. No trip needed.
// This runs every pass, so a character passing through a bank will deposit
// the excess without a dedicated trip.
//
// NATIVE IMPLEMENTATION: the legacy bankSurplus() is the spec. This node
// reimplements the keep-calculation and deposit logic directly, so the BT
// owns the decision AND the action.
export function inBankNode(keeper) {
  return {
    async tickAsync(bb) {
      const k = keeper;
      const s = k.s;
      if (!s?.live) return FAILURE;
      const c = s.client;
      const room = s.world?.room;
      if (!isBankRoom(room, c)) return FAILURE;

      // Read the purse.
      if (s.pacer?.submit) {
        await s.pacer.submit('read', () => c.requestInventory?.()).catch(() => {});
        await c.waitFor?.({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
      }
      const purse = c.inventory?.find(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''));
      const carried = purse?.amount ?? 0;

      // Calculate the keep amount: float + food money + delivery money.
      // The float is the walking-money reserve. The food money covers the
      // vigor shortfall (roughly 4.5 sh per vigor point, capped at 900).
      const p = k.policy ?? {};
      const FLOAT = p.walkingMoney ?? 400;
      const vg = c.vitals?.()?.vigor;
      const larder = (k.larder?.(c) ?? []).reduce((t, f) => t + (f.food?.nutrition ?? 0) * (f.o.amount || 1), 0);
      const shortBy = Math.max(0, (p.fightAboveVigor ?? 140) - (vg?.value ?? 0) - larder);
      const foodMoney = (p.buyFood !== false) && shortBy > 20
        ? Math.min(900, Math.round(shortBy * 4.5) + 100) : 0;
      const deliveryMoney = k.deliveryCashReserve?.() ?? 0;
      const keep = FLOAT + foodMoney + deliveryMoney;

      if (carried <= keep) {
        if (foodMoney || deliveryMoney) {
          k.note?.('bt-town: keeping supply money rather than banking', {
            carrying: carried, float: FLOAT, for_food: foodMoney,
            for_delivery: deliveryMoney, short_by: shortBy });
        }
        return FAILURE;   // nothing to bank; fall through to next node
      }

      // Deposit the surplus.
      const put = carried - keep;
      k.doing = 'trading';
      const r = s.pacer?.submit
        ? await s.pacer.submit('bank', () => c.deposit(put))
          .then(() => c.waitFor?.({ kinds: ['message'], timeoutMs: 3000 }) ?? { events: [] })
          .then(ev => ({ said: ev.events?.filter(e => e.text).map(e => e.text).slice(0, 2) }))
          .catch(e => ({ error: e.message }))
        : await c.deposit?.(put).then(() => ({ said: [] })).catch(e => ({ error: e.message }));

      k.note?.(r.error ? 'bt-town: could not bank' : 'bt-town: banked the surplus', {
        deposited: r.error ? undefined : put, kept: keep, float: FLOAT,
        for_food: foodMoney, for_delivery: deliveryMoney,
        why: r.error, said: r.said,
        because: 'money in hand is lost on death; money in the bank is not' });

      if (!r.error) {
        k.tally = k.tally || {};
        k.tally.banked = (k.tally.banked || 0) + put;
        k.progress?.('banked money');
      }
      return SUCCESS;
    },
  };
}

// ─── Node: should_trip ────────────────────────────────────────────────────────
// Decide if a trip to town is needed. Checks the same conditions as the legacy
// _bankRunShouldGo: carried > bankAbove, pack full, starving, broke with goods.
// Sets bb._trip = { state: 'travelling', destination, reason }.
export function shouldTripNode(keeper) {
  return {
    async tickAsync(bb) {
      const k = keeper;
      const s = k.s;
      if (!s?.live) return FAILURE;
      const c = s.client;
      const room = s.world?.room;
      if (!room) return FAILURE;

      // A trip is already in progress: the other trip nodes handle it.
      if (bb._trip) return FAILURE;

      // Already in a bank: the in_bank node handles it.
      if (isBankRoom(room, c)) return FAILURE;

      // Cooldown check. Use the same state fields as the legacy code so the
      // cooldowns are shared between BT and legacy paths (a character that
      // switches between the two won't double-trip).
      const now = Date.now();
      const lastBank = k.bankTripAt ?? 0;
      const lastSell = k.sellTripAt ?? 0;
      const lastFood = k.foodTripAt ?? 0;

      const p = k.policy ?? {};
      const bankAbove = p.bankAbove ?? 0;
      if (!bankAbove) return FAILURE;   // banking disabled

      // Calculate carried shillings.
      const inv = c.inventory || [];
      const carried = inv.filter(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''))
                         .reduce((t, o) => t + (o.amount || 1), 0);

      // Check sell trigger. NATIVE IMPLEMENTATION: the legacy checkIfShouldSell()
      // is the spec. This reimplements the core triggers (load, stacks, value,
      // unarmed_broke, broke) directly.
      let sellTrigger = null;
      try {
        const inv = c.inventory || [];
        const stacks = inv.length;
        const p = k.policy ?? {};

        // Load-based: pack fullness (the fuller of weight and bulk) >= sellAtLoad (default 0.9, SELL_AT_LOAD in m59-autopilot.mjs).
        const { skills } = k.constructor._combatSkills || {};
        const cap = skills?.carryCapacity?.(c);
        const frac = (v, max) => (max > 0 && Number.isFinite(v) ? v / max : 0);
        const fullness = cap?.known && cap.load
          ? Math.max(frac(cap.load.weight, cap.weight_max), frac(cap.load.bulk, cap.bulk_max)) : 0;
        const at = p.sellAtLoad ?? 0.9;
        if (fullness >= at) {
          sellTrigger = 'load';
        } else if (stacks >= (p.maxCarry ?? 14)) {
          sellTrigger = 'stacks';
        } else {
          // Value-based: total value of sellable goods >= sellAtValue (default 300).
          const sellAtValue = p.sellAtValue ?? 300;
          const loadout = k.loadout?.() ?? {};
          const protect = new Set(loadout.protect || []);
          const sellable = inv.filter(o => {
            const name = c.rsc.get(o.nameRsc) || '';
            if (/shilling/i.test(name)) return false;
            if (protect.has(o.id)) return false;
            return (k.itemValue?.(name, o.amount) ?? 0) > 0;
          });
          const totalValue = sellable.reduce((sum, o) =>
            sum + (k.itemValue?.(c.rsc.get(o.nameRsc) || '', o.amount) ?? 0), 0);
          if (totalValue >= sellAtValue) {
            sellTrigger = 'value';
          } else {
            // Survival: unarmed + below walking floor + 4+ non-money items.
            const floor = p.walkingMoney ?? 400;
            const carriedCash = inv.filter(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''))
              .reduce((t, o) => t + (o.amount || 1), 0);
            const spare = inv.filter(o => !/shilling/i.test(c.rsc.get(o.nameRsc) || '')).length;
            if (carriedCash < floor && spare >= 4 && !k.armed?.()) {
              sellTrigger = 'unarmed_broke';
            }
          }
        }
      } catch (e) { /* ignore */ }

      const packFull = sellTrigger && sellTrigger !== 'broke' && sellTrigger !== 'unarmed_broke';
      const brokeWithGoods = (sellTrigger === 'broke' || sellTrigger === 'unarmed_broke');

      // Check starving.
      let starving = false;
      try {
        const reag = k.reagentCount?.() ?? { elderberry: 0, herbs: 0 };
        const canCook = reag.elderberry >= 2 && reag.herbs >= 2;
        const larder = k.larder?.(c) ?? [];
        const hungryFloor = p.hungryFloor ?? 100;
        const spendable = carried - hungryFloor;
        const balance = s.bankKnown?.()?.balance ?? 0;
        const canFetch = balance >= 200;
        starving = (p.buyFood !== false) &&
                   !larder.length && !canCook &&
                   (spendable >= 60 || canFetch) &&
                   (now - lastFood > FOOD_TRIP_COOLDOWN_MS);
      } catch (e) { /* ignore */ }

      // Decide if we should go.
      const go = (carried > bankAbove && now - lastBank > BANK_TRIP_COOLDOWN_MS) ||
                 (packFull && now - lastSell > SELL_TRIP_COOLDOWN_MS) ||
                 starving ||
                 (brokeWithGoods && now - lastSell > SELL_TRIP_COOLDOWN_MS);

      if (!go) return FAILURE;

      // Rank destinations.
      const destinations = rankDestinations(k, { packFull, brokeWithGoods, starving, carried });
      const target = destinations[0];
      if (!target || !Number.isFinite(target.hops)) return FAILURE;

      // Set trip state.
      bb._trip = {
        state: 'travelling',
        destination: { room: target.room, name: target.name },
        reason: starving ? 'food' : (packFull || brokeWithGoods) ? 'sell' : 'bank',
        started: now,
      };

      k.note?.('bt-town: starting trip', {
        to: target.name, reason: bb._trip.reason,
        carried, packFull: !!packFull, starving, brokeWithGoods,
      });

      // Mark cooldown. Use the same state fields as the legacy code.
      if (bb._trip.reason === 'bank') k.bankTripAt = now;
      if (bb._trip.reason === 'sell') k.sellTripAt = now;
      if (bb._trip.reason === 'food') k.foodTripAt = now;

      return SUCCESS;   // trip state set; travel_to_town will run next
    },
  };
}

// ─── Destination ranking (same logic as legacy _bankRunRankDestinations) ──────
const BANKS = [
  { room: 54, name: 'First Royal Bank of Tos' },
  { room: 114, name: 'Office of the Barloque Vaultman' },
  { room: 376, name: 'The Royal Bank of Jasper' },
];
const MARKETS = [
  { room: 102, name: 'South Barloque' },
  { room: 101, name: 'North Barloque' },
  { room: 53, name: 'Tos' },
];
const FOOD_SHOP = { room: 52, name: 'Tos Inn' };

function rankDestinations(keeper, ctx) {
  const s = keeper.s;
  const p = keeper.policy ?? {};
  const needsCashFirst = ctx.starving &&
    (ctx.carried - (p.hungryFloor ?? 100)) < 60 &&
    (s.bankKnown?.()?.balance ?? 0) >= 200;

  let dests;
  if (needsCashFirst) dests = BANKS;
  else if (ctx.starving && !ctx.packFull && ctx.carried <= (p.bankAbove ?? 500)) dests = [FOOD_SHOP];
  else if ((ctx.packFull || ctx.brokeWithGoods) && ctx.carried <= (p.bankAbove ?? 500)) dests = MARKETS;
  else dests = BANKS;

  return dests
    .map(b => {
      const r = s.world?.route?.(b.room);
      return { ...b, hops: r?.found ? r.hops.length : Infinity };
    })
    .sort((x, y) => x.hops - y.hops);
}

// ─── Node: travel_to_town ─────────────────────────────────────────────────────
// Travel to the destination set by should_trip. Returns RUNNING while travelling,
// SUCCESS when arrived.
export function travelToTownNode(keeper) {
  return {
    async tickAsync(bb) {
      const trip = bb._trip;
      if (!trip || trip.state !== 'travelling') return FAILURE;
      const k = keeper;
      const s = k.s;
      if (!s?.live) return FAILURE;

      const destRoom = trip.destination.room;
      const currentRoom = s.world?.room?.num;

      // Already there?
      if (currentRoom === destRoom) {
        trip.state = 'in_town';
        return SUCCESS;
      }

      // Travel.
      try {
        const result = await k.travelToRoom?.(destRoom, { maxHops: 20 });
        if (result?.arrived) {
          trip.state = 'in_town';
          return SUCCESS;
        }
        // Travel failed: abort the trip.
        k.note?.('bt-town: travel failed', { to: trip.destination.name, reason: result?.reason });
        bb._trip = null;
        return FAILURE;
      } catch (e) {
        k.note?.('bt-town: travel error', { to: trip.destination.name, why: e.message });
        bb._trip = null;
        return FAILURE;
      }
    },
  };
}

// ─── Node: do_town_business ───────────────────────────────────────────────────
// Execute the town business: sell, bank, restock, buy food.
//
// NATIVE IMPLEMENTATION: the legacy _bankRunDoTownBusiness() is the spec.
// This node reimplements the core sequence directly. The legacy method does
// 9 sub-actions; the BT does the 3 that matter most (sell, bank, restock).
// Guild wants, tithe, vault, and farm delivery are left to the legacy pass()
// fallback (step 6 in the BTKeeper ladder) — they are lower-priority and can
// wait for the next pass.
export function doTownBusinessNode(keeper) {
  return {
    async tickAsync(bb) {
      const trip = bb._trip;
      if (!trip || trip.state !== 'in_town') return FAILURE;
      const k = keeper;
      const s = k.s;
      if (!s?.live) return FAILURE;
      const c = s.client;

      // 1. SELL: find a merchant and sell everything that isn't loadout-protected.
      //    The legacy sellInTown() uses skills.sellAll() which finds a merchant
      //    and sells. We do the same here.
      try {
        const { skills } = k.constructor._combatSkills || {};
        if (skills?.sellAll) {
          // Find a merchant in the current room.
          const merchant = [...c.room?.objects?.values?.() || []]
            .find(o => /merchant|shop|seller|apoth|weaponsmith|blacksmith/i.test(c.rsc.get(o.nameRsc) || ''));
          if (merchant) {
            const loadout = k.loadout?.() ?? {};
            const sold = await skills.sellAll(s, {
              merchant: merchant.id,
              loadout,
              protect: loadout.protect,
            }).catch(() => null);
            if (sold?.sold) {
              k.note?.('bt-town: sold goods in town', {
                items: sold.sold, revenue: sold.revenue ?? 0,
              });
            }
          }
        }
      } catch (e) {
        k.note?.('bt-town: sell failed', { why: e.message });
      }

      // 2. BANK: deposit the surplus. Try to find a bank teller in the room;
      //    if none, skip.
      try {
        const teller = [...c.room?.objects?.values?.() || []]
          .find(o => /bank/i.test(c.rsc.get(o.nameRsc) || ''));
        if (teller || /bank/i.test(s.world?.room?.name || '')) {
          if (s.pacer?.submit) {
            await s.pacer.submit('read', () => c.requestInventory?.()).catch(() => {});
            await c.waitFor?.({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
          }
          const purse = c.inventory?.find(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''));
          const carried = purse?.amount ?? 0;
          const p = k.policy ?? {};
          const FLOAT = p.walkingMoney ?? 400;
          const keep = FLOAT;
          if (carried > keep) {
            const put = carried - keep;
            if (s.pacer?.submit) {
              await s.pacer.submit('bank', () => c.deposit(put)).catch(() => {});
            } else {
              await c.deposit?.(put).catch(() => {});
            }
            k.note?.('bt-town: banked surplus in town', { deposited: put, kept: keep });
            k.tally = k.tally || {};
            k.tally.banked = (k.tally.banked || 0) + put;
          }
        }
      } catch (e) {
        k.note?.('bt-town: bank step failed', { why: e.message });
      }

      // 3. RESTOCK: buy food and reagents if the larder is low.
      try {
        await k.restockInTown?.().catch(() => {});
        await k.buyFoodInTown?.().catch(() => {});
      } catch (e) {
        k.note?.('bt-town: restock failed', { why: e.message });
      }

      trip.state = 'returning';
      k.lastTownServiceAt = Date.now();
      return SUCCESS;
    },
  };
}

// ─── Node: return_home ────────────────────────────────────────────────────────
// Travel back to the assigned room after town business.
export function returnHomeNode(keeper) {
  return {
    async tickAsync(bb) {
      const trip = bb._trip;
      if (!trip || trip.state !== 'returning') return FAILURE;
      const k = keeper;
      const s = k.s;
      if (!s?.live) return FAILURE;

      const assigned = k.policy?.assignedRoom;
      if (!assigned) {
        bb._trip = null;
        return SUCCESS;
      }

      const currentRoom = s.world?.room?.num;
      if (currentRoom === assigned) {
        bb._trip = null;
        k.note?.('bt-town: trip complete', { reason: trip.reason, to: trip.destination.name });
        return SUCCESS;
      }

      try {
        const result = await k.travelToRoom?.(assigned, { maxHops: 20 });
        if (result?.arrived) {
          bb._trip = null;
          k.note?.('bt-town: trip complete', { reason: trip.reason, to: trip.destination.name });
          return SUCCESS;
        }
        // Still travelling: return RUNNING.
        return RUNNING;
      } catch (e) {
        k.note?.('bt-town: return failed', { why: e.message });
        bb._trip = null;
        return FAILURE;
      }
    },
  };
}

// ─── Town tree: selector of all town nodes ────────────────────────────────────
// Flat selector: in_bank → should_trip → travel_to_town → do_town_business → return_home.
// The trip nodes are ordered so they form an implicit sequence: each node only
// fires when the previous one has set the right state in bb._trip. This makes
// all nodes visible to the decision trace (_traceTree in m59-keeper-bt.mjs).
export function getTownTree(keeper) {
  const children = [
    Object.assign(inBankNode(keeper), { _name: 'in_bank' }),
    Object.assign(shouldTripNode(keeper), { _name: 'should_trip' }),
    Object.assign(travelToTownNode(keeper), { _name: 'travel_to_town' }),
    Object.assign(doTownBusinessNode(keeper), { _name: 'do_town_business' }),
    Object.assign(returnHomeNode(keeper), { _name: 'return_home' }),
  ];

  return {
    children,
    async tickAsync(bb) {
      for (const child of children) {
        const r = await child.tickAsync(bb);
        if (r === SUCCESS || r === RUNNING) return r;
      }
      return FAILURE;
    },
  };
}
