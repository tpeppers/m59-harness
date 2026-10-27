// FARM DELIVERIES: carrying supplies to a fleet-mate in the field.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 17 methods: deliveryCapFor, matchesKind, countOfKind, ownFloorFor, deliverableSpare,
//   deliveryRadius, deliveryNeighbourhood, deliveryRequestOf, prepareFarmDelivery,
//   deliveryCashReserve, cancelFarmDelivery, makeRoomToBuy, buyFarmDeliveryCargo, giveFarmReagents,
//   deliverFarmSupplies, ejectLoot, giveItems
import { norm } from '../m59-loadout.mjs';
import { roomsWithin } from '../m59-map.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { OF, affordances, buyLines } from '../m59-parse.mjs';
import * as skills from '../m59-skills.mjs';
import { MARKET_KEEP } from '../m59-items.mjs';
import * as party from '../m59-party.mjs';
import { BACKOFF_MS, ejectBatch, ejectTarget, normalizeLootEject, noteGone, overflowDrops, readReceived } from '../m59-loot-eject.mjs';
import { REAGENT_SHOP, claimFarmDelivery, purchaseEnabled, reagentTargetFor, releaseFarmDelivery } from '../m59-autopilot.mjs';

export class DeliveryPart {
  // @part 1

  // How many of one kind a courier will carry for one character on one trip. The two named
  // reagents keep their own settings because they are the two the fleet burns continuously;
  // everything else a loadout asks for shares a default. A cap of 0 for a kind is a real
  // answer — "do not fetch this" — so it is honoured rather than replaced by the default.
  deliveryCapFor(kind, cfg = this.policy.farmDelivery) {
    const num = (v, fallback) => (v === undefined || v === null || Number.isNaN(Number(v))
      ? fallback : Math.max(0, Math.floor(Number(v))));
    if (kind === 'herb') return num(cfg?.herbs_per_farmer, 20);
    if (kind === 'elderberry') return num(cfg?.elderberries_per_farmer, 10);
    return num(cfg?.per_farmer_default, 10);
  }

  // A KIND IS A NORMALISED ITEM NAME, and the two reagents also answer to their `shareKind`
  // alias — the server says "herbs" where the board says "herb", and a delivery that
  // matched only one of those spellings would carry the right thing and fail to find it.
  // And the kod catalogue names `enchant weapon`'s reagent `orctooth` (enchwp.kod:65) where the
  // pack says `orc tooth`, so the letters-only key is the one both sides agree on — the broker's
  // reagent check learned this 2026-09-11. Without it Raphael, carrying 30, asked the fleet for
  // orc teeth on every pass (2026-10-20).
  matchesKind(name, kind) {
    const n = String(name || ''), key = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return skills.shareKind(n) === kind || norm(n) === String(kind || '').toLowerCase()
      || (!!key(kind) && key(n) === key(kind));
  }

  countOfKind(kind) {
    return this.packAsItems().reduce((sum, item) =>
      sum + (this.matchesKind(item.name, kind) ? (item.amount || 1) : 0), 0);
  }

  // What this character keeps for ITSELF before anything is spare. The two reagents use the
  // keeper's own target; anything else uses the floor its loadout asked for. Without this a
  // courier would hand over the mushrooms it is carrying because it needs them.
  ownFloorFor(kind) {
    if (kind === 'herb' || kind === 'elderberry')
      return reagentTargetFor(kind, this.policy.reagentTarget);
    const l = this.loadout();
    const entry = l?.carry?.find(c => norm(c.item) === String(kind || '').toLowerCase());
    return entry ? (entry.min || 0) : 0;
  }

  // Everything above that floor, per kind, which is what may be given away.
  deliverableSpare(kinds = null) {
    const want = kinds ?? [...new Set(this.packAsItems()
      .map(item => skills.shareKind(item.name) ?? norm(item.name)).filter(Boolean))];
    const out = {};
    for (const kind of want) {
      const spare = this.countOfKind(kind) - this.ownFloorFor(kind);
      if (spare > 0) out[kind] = spare;
    }
    return out;
  }

  // How far a courier will walk off its destination to hand things over. Bounded at 3
  // because this is a detour taken while carrying somebody else's goods, not a patrol.
  deliveryRadius(cfg = this.policy.farmDelivery) {
    const n = Number(cfg?.radius_rooms);
    return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.floor(n))) : 2;
  }

  // The rooms this delivery serves: the destination and its neighbourhood, nearest first.
  deliveryNeighbourhood(room, cfg = this.policy.farmDelivery) {
    const map = this.s.world?.map;
    const radius = this.deliveryRadius(cfg);
    if (!map || !radius) return new Map([[Number(room), 0]]);
    try { return roomsWithin(map, Number(room), radius); }
    catch { return new Map([[Number(room), 0]]); }
  }

  // Sum a list of demands into one shopping list, capped per kind per character.
  deliveryRequestOf(demands, cfg = this.policy.farmDelivery) {
    const requested = {};
    for (const rec of demands)
      for (const [kind, amount] of Object.entries(rec.needs || {})) {
        const want = Math.min(amount, this.deliveryCapFor(kind, cfg));
        if (want > 0) requested[kind] = (requested[kind] || 0) + want;
      }
    return requested;
  }

  prepareFarmDelivery(room) {
    const cfg = this.policy.farmDelivery;
    if (!cfg?.enabled || this.mode !== 'farm' || room == null || this.pendingFarmDelivery) return null;
    // POLLED OVER THE NEIGHBOURHOOD AND ACROSS EVERY KIND ANYONE ASKS FOR. Both halves of
    // that used to be narrower: one room, and the two reagents that happened to have a
    // target. A loadout now puts quantities on the board (see `declareInterest`), so the
    // list a courier buys is whatever the people out there are actually short of.
    const within = this.deliveryNeighbourhood(room, cfg);
    const demands = skills.interest.demandsNear(within, { except: this.name ?? this.s.name })
      .slice(0, Math.max(1, Math.min(12, Number(cfg.max_recipients) || 4)))
      .map(rec => ({ ...rec, needs: Object.fromEntries(Object.entries(rec.needs)
        .map(([kind, amount]) => [kind, Math.min(amount, this.deliveryCapFor(kind, cfg))])
        .filter(([, amount]) => amount > 0)) }))
      .filter(rec => Object.keys(rec.needs).length);
    if (!demands.length || !claimFarmDelivery(room, this.name ?? this.s.name)) return null;
    const requested = this.deliveryRequestOf(demands, cfg);
    this.pendingFarmDelivery = { room: Number(room), room_name: this.s.world?.room?.name ?? null,
      radius: this.deliveryRadius(cfg), polled: demands, requested, bought: {},
      cargo: {}, claimed_at: Date.now() };
    this.coordination.delivery.trips++;
    this.coordination.delivery.farmers_polled += demands.length;
    for (const [kind, amount] of Object.entries(requested))
      this.coordination.delivery.requested[kind] = (this.coordination.delivery.requested[kind] || 0) + amount;
    this.note('claimed the return supply run', { to_room: room, radius: this.deliveryRadius(cfg),
      rooms_polled: [...within.keys()],
      farmers: demands.map(rec => ({ agent: rec.agent, character: rec.character,
        room: rec.room, needs: rec.needs })), requested });
    return this.pendingFarmDelivery;
  }

  deliveryCashReserve() {
    const p = this.pendingFarmDelivery;
    if (!p) return 0;
    // Vendor costs vary around viValue. Twenty per unit is deliberately an upper-bound
    // reserve, capped so coordination can never turn banking off for a wealthy courier.
    return Math.min(2500, 20 * Object.values(p.requested).reduce((sum, n) => sum + n, 0));
  }

  cancelFarmDelivery(why = 'strategy disabled') {
    const p = this.pendingFarmDelivery;
    if (!p) return false;
    releaseFarmDelivery(p.room, this.name ?? this.s.name);
    this.pendingFarmDelivery = null;
    this.note('cancelled the farm delivery', { to_room: p.room, why, retained: p.cargo ?? {} });
    return true;
  }

  // SELL BEFORE YOU BUY, because a full pack refuses the purchase by SPEAKING, not by
  // erroring. Joguer says "I'm unable to give you the elderberry. Perhaps you carry too
  // much?" — a sentence to the room, which is the same class of silence as the Izzio and
  // Skivlat refusals, and the buy call itself reports nothing wrong. Rizzo spent whole
  // reagent trips walking to a counter, being refused item by item, and walking home.
  //
  // So every buying path asks this first. It is cheap on the common path — a capacity
  // reading it already has — and does nothing at all when there is room.
  //
  // Selling comes before dropping deliberately: the pack is full of things worth
  // shillings, and a merchant standing right there converts them. Dropping is the fallback
  // for a counter that will not buy, never the first move.
  async makeRoomToBuy(merchantId = null, { wantSlots = 6 } = {}) {
    const s = this.s, c = s.need();
    const cap = skills.carryCapacity(c);
    const slotsLeft = Math.max(0, (this.policy.maxCarry ?? 50) - (c.inventory?.length ?? 0));
    // room_for is withheld when the pack holds anything unweighed, and that is deliberately
    // treated as "make room" rather than "there is room" — guessing light is the direction
    // that produces exactly the refusal this exists to prevent.
    const tight = slotsLeft < wantSlots ||
      (cap.known && (!cap.room_for || cap.room_for.weight < 200 || cap.room_for.bulk < 200));
    if (!tight) return null;

    const buyer = merchantId != null && skills.trustedBuyer(
      c.rsc.get([...c.room.objects.values()].find(o => o.id === merchantId)?.nameRsc) || '')
      ? merchantId
      : [...(c.room?.objects?.values?.() ?? [])]
          .find(o => affordances(o.flags).includes('buy') &&
                     skills.trustedBuyer(c.rsc.get(o.nameRsc)))?.id ?? null;

    let sold = null;
    if (buyer) {
      sold = await skills.sellAll(s, { merchant: buyer, loadout: this.loadout(),
        protect: this.saleProtectedNames(), maxWeapons: this.policy.maxWeapons,
        weaponPriority: this.weaponPriorityNow() }).catch(e => ({ error: e.message }));
      // A SALE TO MAKE ROOM IS STILL A SALE, and was the one path that told no ledger.
      if (sold?.sold?.length) this.tradeFact({ earned: sold.total_received, sold: sold.sold });
    }
    // Still tight, or nobody here buys: shed what is provably worthless.
    const dead = skills.junkAndBroken(c);
    const dropped = [];
    if (dead.length && (c.inventory?.length ?? 0) >= (this.policy.maxCarry ?? 50) - wantSlots) {
      for (const d of dead.slice(0, 4)) {
        await s.pacer.submit('drop', () => c.drop([this.dropSpec(d)])).catch(() => {});
        await new Promise(r => setTimeout(r, 600));
        dropped.push(d.name);
      }
    }
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
    this.note('made room before buying', { slots_left_before: slotsLeft,
      sold: sold?.sold?.length ?? 0, received: sold?.total_received ?? 0, dropped,
      why: 'a full pack refuses a purchase out loud and the buy call reports nothing wrong' });
    return { sold, dropped };
  }

  async buyFarmDeliveryCargo() {
    const p = this.pendingFarmDelivery;
    if (!p || !this.policy.farmDelivery?.enabled) return null;
    const s = this.s, c = s.need();
    if (!purchaseEnabled(this.policy, 'reagents')) {
      const spare = this.deliverableSpare(Object.keys(p.requested));
      p.bought = {};
      p.cargo = Object.fromEntries(Object.entries(p.requested)
        .map(([kind, want]) => [kind, Math.min(want, spare[kind] || 0)])
        .filter(([, n]) => n > 0));
      this.note('farm delivery used carried spares without buying reagents', {
        to_room: p.room, requested: p.requested, cargo: p.cargo,
        why: 'the Buy Reagents strategy is disabled' });
      return p;
    }
    const funded = await this.ensurePurchaseFunds(this.shoppingPlan({ kind: 'delivery' }));
    if (!funded.ready) return funded;
    if (s.world?.room?.num !== REAGENT_SHOP.room) {
      const walked = await this.travel(REAGENT_SHOP.room, { origin: keeperOrigin('farm_supply_buy'), maxHops: 12 })
        .catch(error => ({ arrived: false, reason: error.message }));
      if (!walked?.arrived) {
        this.coordination.delivery.failed++;
        this.note('could not reach the apothecary for the farm delivery', { why: walked?.reason, to: p.room });
        return null;
      }
    }
    const kinds = Object.keys(p.requested);
    const pick = await this.sellerHere({ want: /elder\s?berry|^herbs?$/i }).catch(() => null);
    if (!pick) { this.coordination.delivery.failed++; return null; }
    // A courier carries a delivery's worth on top of its own pack, so this is the path most
    // likely to be refused for space — and the refusal is a sentence, not an error.
    await this.makeRoomToBuy(pick.seller?.id ?? pick.seller,
      { wantSlots: Math.max(6, Object.values(p.requested).length * 2) }).catch(() => {});
    const before = Object.fromEntries(kinds.map(k => [k, this.countOfKind(k)]));
    const spare = this.deliverableSpare(kinds);
    const need = Object.fromEntries(kinds.map(k =>
      [k, Math.max(0, p.requested[k] - (spare[k] || 0))]));
    const start = c.evSeq;
    await s.pacer.submit('buy', () => c.buy(pick.seller.id ?? pick.seller));
    const ev = await c.waitFor({ since: start, kinds: ['shop', 'message'], timeoutMs: 4000 })
      .catch(() => ({ events: [] }));
    const shop = ev.events?.find(row => row.kind === 'shop');
    if (!shop) { this.coordination.delivery.failed++; return null; }
    const quote = this.shoppingPlan({ kind: 'delivery', items: shop.items ?? [] });
    if (quote.unpriced.length) return { pending: true, reason: 'waiting for delivery prices' };
    const paid = await this.ensurePurchaseFunds(quote);
    if (!paid.ready || paid.moved) return { pending: true, reason: paid.reason ?? 'return after banking' };
    let purse = this.purseNow();
    const floor = this.walkingFloat();
    // A KIND THIS COUNTER DOES NOT STOCK IS REPORTED, NOT SILENTLY DROPPED. The reagent run
    // that exposed all of this failed exactly here — one counter had no elderberry, another
    // no herbs — and the trip still reported itself loaded, so the fleet learned nothing
    // from a walk it had already paid for.
    const unstocked = [];
    for (const kind of kinds) {
      if (!need[kind]) continue;
      const entry = (shop.items || []).find(item => this.matchesKind(item.name, kind));
      // `entry.amount` IS NOT STOCK. It is the quantity the counter offers by default —
      // every apothecary lists "Herbs x4" and none of them runs out — so how many we buy is
      // decided by `need` and the purse, never by the listed number.
      if (!entry) { unstocked.push(kind); continue; }
      const unit = entry.cost || 0;
      const affordable = unit > 0 ? Math.max(0, Math.floor((purse - floor) / unit)) : need[kind];
      const take = Math.min(need[kind], affordable);
      if (!take) continue; // buyLines intentionally treats a missing quantity as one
      // ONE LINE WITH A COUNT. A bare id buys nothing at all for a stackable — the server's
      // parallel number list arrives empty and the merchant's Buy has no quantity to pair
      // with the item (see buyLines in m59-parse.mjs). Every reagent this loop exists to
      // fetch is a stackable, so the unit-at-a-time version could not have worked.
      for (const line of buyLines([{ id: entry.id, amount: take }])) {
        if (this.travelInterrupted() || this.suspendedJourney || s.world?.room?.num !== REAGENT_SHOP.room)
          return { pending: true, reason: 'delivery purchase interrupted' };
        await s.pacer.submit('buy', () => c.buyItems(shop.sellerId, [line]));
        await new Promise(resolve => setTimeout(resolve, 700));
        purse -= unit * line.amount;
        for (let n = 0; n < line.amount; n++)
          this.recordPurchase(entry.name, entry.cost, { item_kind: kind,
            from: c.rsc.get(pick.seller.nameRsc) ?? null, why: `farm delivery for room ${p.room}` });
      }
    }
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
    p.bought = {}; p.cargo = {};
    for (const kind of kinds) {
      const gained = Math.max(0, this.countOfKind(kind) - before[kind]);
      if (gained) p.bought[kind] = gained;
      const carry = Math.min(p.requested[kind], (spare[kind] || 0) + gained);
      if (carry > 0) p.cargo[kind] = carry;
      this.coordination.delivery.bought[kind] = (this.coordination.delivery.bought[kind] || 0) + gained;
    }
    this.note('loaded the farm delivery', { to_room: p.room, requested: p.requested,
      bought: p.bought, fleet_spares_used: spare, cargo: p.cargo,
      ...(unstocked.length ? { counter_did_not_stock: unstocked } : {}) });
    return p;
  }

  async giveFarmReagents(recipient, wanted) {
    const s = this.s, c = s.need();
    const kinds = Object.keys(wanted).filter(k => (Number(wanted[k]) || 0) > 0);
    const them = [...(c.room?.objects?.values?.() ?? [])].find(o => (o.flags & OF.PLAYER) &&
      (c.rsc.get(o.nameRsc) || '').toLowerCase() === String(recipient.character || '').toLowerCase());
    if (!them) return { gave: {}, why: 'farmer left the room or is dead' };
    const beforeCounts = Object.fromEntries(kinds.map(k => [k, this.countOfKind(k)]));
    const offers = [], planned = {};
    for (const kind of kinds) {
      let left = Math.max(0, Number(wanted[kind]) || 0);
      for (const item of (c.inventory || []).filter(o => this.matchesKind(c.rsc.get(o.nameRsc) || '', kind))) {
        if (!left) break;
        const amount = Math.min(left, item.amount || 1);
        offers.push(amount < (item.amount || 1) ? { id: item.id, amount } : item.id);
        planned[kind] = (planned[kind] || 0) + amount; left -= amount;
      }
    }
    if (!offers.length) return { gave: planned, why: 'courier has no requested cargo left' };
    const before = c.evSeq;
    await s.pacer.submit('trade', () => c.offer(them.id, offers));
    const ev = await c.waitFor({ since: before, kinds: ['countered', 'trade-ended'], timeoutMs: 8000 })
      .catch(() => ({ events: [] }));
    if (!ev.events?.some(row => row.kind === 'countered')) {
      await s.pacer.submit('trade', () => c.cancelOffer()).catch(() => {});
      return { gave: {}, why: 'farmer did not counter the gift' };
    }
    const acceptingAt = c.evSeq;
    await s.pacer.submit('trade', () => c.acceptOffer());
    await c.waitFor({ since: acceptingAt, kinds: ['trade-ended'], timeoutMs: 4000 }).catch(() => {});
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
    // WHAT LEFT THE PACK, not what the offer was asked to contain. A trade that handshakes
    // and moves nothing is the same family as a merchant that says thank you and pays
    // nothing, and only the count can tell the two apart.
    const gave = {};
    for (const kind of kinds) {
      const moved = Math.min(planned[kind] || 0, Math.max(0, beforeCounts[kind] - this.countOfKind(kind)));
      if (moved > 0) gave[kind] = moved;
    }
    return { gave, ...(Object.keys(gave).length ? {}
      : { why: 'trade handshake ended but no requested item left the courier pack' }) };
  }

  async deliverFarmSupplies() {
    const p = this.pendingFarmDelivery;
    if (!p) return false;
    if (this.s.world?.room?.num !== p.room) {
      this.doing = 'travelling';
      if ((await this.leaveHold('returning with the shared farm delivery')).refused) return true;
      const walked = await this.travel(p.room, { origin: keeperOrigin('farm_supply_delivery'), maxHops: 24 })
        .catch(error => ({ arrived: false, reason: error.message }));
      if (!walked?.arrived) {
        p.failures = (p.failures || 0) + 1;
        this.coordination.delivery.failed++;
        this.note('could not return with the farm delivery', {
          to_room: p.room, attempt: p.failures, why: walked?.reason,
          cargo_retained: p.cargo });
        // Two failures means the route itself is unavailable. Keep the goods and let a
        // later courier claim the room instead of retiring this one into an endless trip.
        if (p.failures >= 2) this.cancelFarmDelivery('destination could not be reached twice');
      }
      return true;
    }
    // ------------------------------------------------------------------ the hand-out
    //
    // A DELIVERY IS ADDRESSED TO A PLACE, NOT TO A LIST OF PEOPLE. The recipients polled at
    // pickup decided WHAT to buy; they do not decide who gets it. By the time a courier has
    // walked to the apothecary and back, minutes have passed and the fleet has moved — and
    // the old code, which iterated the frozen list and looked each name up in the room,
    // answered "farmer left the room or is dead" and carried the goods home. The people
    // standing here now want the same things for the same reason.
    //
    // So the board is re-read on arrival and the cargo goes to whoever is present and short,
    // polled first, unpolled, or polled-for-somewhere-else alike.
    const remaining = { ...p.cargo };
    const left = () => Object.values(remaining).some(n => n > 0);
    const deliveries = [], visited = [];
    const served = new Set();

    const handOutHere = async () => {
      this.doing = 'trading';
      await this.s.pacer.submit('read', () => this.s.need().roomContents()).catch(() => {});
      await this.s.client.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 }).catch(() => {});
      const here = this.s.world?.room?.num ?? null;
      visited.push(here);
      const takers = skills.interest.demandsNear(new Map([[Number(here), 0]]),
        { except: this.name ?? this.s.name }).filter(rec => !served.has(rec.agent));
      for (const recipient of takers) {
        if (!left()) break;
        const wanted = {};
        for (const [kind, amount] of Object.entries(recipient.needs))
          if (remaining[kind] > 0) wanted[kind] = Math.min(amount, remaining[kind]);
        if (!Object.keys(wanted).length) continue;
        const result = await this.giveFarmReagents(recipient, wanted)
          .catch(error => ({ gave: {}, why: error.message }));
        for (const [kind, n] of Object.entries(result.gave || {})) {
          remaining[kind] -= n;
          this.coordination.delivery.delivered[kind] = (this.coordination.delivery.delivered[kind] || 0) + n;
        }
        if (Object.keys(result.gave || {}).length) served.add(recipient.agent);
        if (result.why) this.coordination.delivery.failed++;
        deliveries.push({ agent: recipient.agent, character: recipient.character, room: here,
          was_polled: p.polled.some(rec => rec.agent === recipient.agent),
          requested: wanted, delivered: result.gave, why: result.why });
      }
    };

    await handOutHere();

    // THEN WALK THE NEIGHBOURHOOD WHILE ANYTHING IS LEFT. Trading needs the same room, so
    // "deliver to anyone nearby" is a short circuit, nearest first, and it stops the moment
    // the cargo is gone. Each leg is bounded and a leg that fails is skipped rather than
    // retried — the goods keep, and a courier stuck bouncing between two rooms is worse for
    // the fleet than one that goes back to work carrying a little.
    if (left() && p.radius > 0) {
      const within = this.deliveryNeighbourhood(p.room);
      const elsewhere = skills.interest.demandsNear(within, { except: this.name ?? this.s.name })
        .filter(rec => !served.has(rec.agent) && rec.room !== p.room &&
          Object.keys(rec.needs).some(kind => remaining[kind] > 0));
      const stops = [...new Set(elsewhere.map(rec => rec.room))].slice(0, 3);
      for (const stop of stops) {
        if (!left()) break;
        if ((await this.leaveHold('carrying the rest of the delivery to the next room')).refused) break;
        const walked = await this.travel(stop, { origin: keeperOrigin('farm_supply_delivery'), maxHops: 6 })
          .catch(error => ({ arrived: false, reason: error.message }));
        if (!walked?.arrived) {
          this.note('could not reach a nearby farmer with the rest of the delivery',
            { room: stop, why: walked?.reason, still_carrying: remaining });
          continue;
        }
        await handOutHere();
      }
    }

    for (const [kind, n] of Object.entries(remaining))
      if (n > 0) this.coordination.delivery.retained[kind] = (this.coordination.delivery.retained[kind] || 0) + n;
    const event = { to_room: p.room, room_name: p.room_name, radius: p.radius,
      rooms_served: visited, requested: p.requested, bought: p.bought, cargo: p.cargo,
      polled: p.polled.map(rec => rec.agent), delivered: deliveries, retained: remaining };
    this.detailEvent('farm_delivery', 'trip', event);
    this.note('farm delivery finished', event);
    releaseFarmDelivery(p.room, this.name ?? this.s.name);
    this.pendingFarmDelivery = null;
    this.progress('resupplied the farmers');
    return true;
  }

  // LOOT EJECTION (m59-loot-eject.mjs): hand the sale pile to a station or courier of ours standing in this room.
  // Operator, 2026-10-26: "a strong downward pressure on our farmer packs". The rows are this keeper's own sale plan,
  // so nothing a market visit would keep can leave. Returns true when goods moved this pass.
  async ejectLoot() {
    let cfg = null;
    try { cfg = normalizeLootEject(this.policy.lootEject); } catch (e) {
      if (this._ejectBad !== e.message) { this._ejectBad = e.message; this.note('loot ejection misconfigured', { why: e.message }); }
      return false;
    }
    if (!cfg) return false;
    const now = Date.now();
    if (now - (this._ejectAt ?? 0) < cfg.every_s * 1000) return false;
    const c = this.s?.client;
    if (!c || !this.running || this.inert || c.trade) return false;
    if (this.facultyHeld('economy')) return false;           // a bot holds trading
    const v = c.vitals?.();
    if (!(v?.health?.max > 0) || v.health.value / v.health.max < 0.8) return false;
    if ((this.frozenUntil && now < this.frozenUntil) || this.threat?.()?.landing > 0) return false;
    this._ejectAt = now;
    if (!skills.equippedNow(c)) return false;               // unknown equipment blocks every row of the plan
    const plan = skills.inventorySalePlan(this.s, { keep: MARKET_KEEP, protect: this.protectedItemNames(),
      loadout: this.loadout(), maxWeapons: this.policy.maxWeapons, weaponPriority: this.weaponPriorityNow() });
    if (plan?.error) return false;
    const items = plan?.items ?? [];
    const me = String(this.s.name ?? '');
    const received = cfg.only_received ? readReceived(me) : null;
    const present = [...(c.room?.objects?.values?.() ?? [])]
      .filter(o => (o.flags & OF.PLAYER) && o.id !== c.selfId)
      .map(o => c.rsc?.get?.(o.nameRsc) || o.name || '')
      .filter(n => n && n.toLowerCase() !== me.toLowerCase() && party.isFleetmate(n));
    this._ejectBackoff ??= new Map();
    const target = cfg.to.length ? ejectTarget({ present, to: cfg.to, backoff: this._ejectBackoff, now }) : null;
    if (target) {
      const rows = ejectBatch(items, { batch: cfg.batch, extra: cfg.extra, received, merchant: cfg.merchant });
      if (rows.length) {
        this.doing = 'trading';
        const r = await this.giveItems(target, rows);
        if (r.moved.length) {
          if (cfg.only_received) noteGone(me, r.moved);
          this.tally.loot_ejected = (this.tally.loot_ejected || 0) + r.moved.reduce((t, m) => t + m.amount, 0);
          this.note('ejected loot', { to: target, moved: r.moved, room: this.s.world?.room?.num ?? null,
            why: 'sale goods ride with a station or courier, best value first, so the farmer keeps farming' });
          try { this.ledgerEvent?.('loot_ejected', { to: target, items: r.moved, room: this.s.world?.room?.num ?? null }); } catch {}
          this.progress(`ejected ${r.moved.length} kinds of loot to ${target}`);
          return true;
        }
        this._ejectBackoff.set(target.toLowerCase(), Date.now() + BACKOFF_MS);
        this.note('loot ejection refused', { to: target, offered: rows.map(x => x.name), why: r.why });
      }
    }
    // OVERFLOW: nobody here took it and the pack is over the line. Drop the worst value per unit of pack where it stands.
    // Operator: "if there's an overflow of loot just drop worst performing bulk/weight to value ratio for selling".
    if (cfg.overflow_at == null || cfg.only_received) return false;
    const cap = skills.carryCapacity(c);
    if (!cap?.known || !cap.load) return false;
    const fullness = Math.max(cap.load.weight / cap.weight_max, cap.load.bulk / cap.bulk_max);
    const drops = overflowDrops(items, { fullness, capMax: cap.weight_max, overflowAt: cfg.overflow_at,
      max: cfg.drop_max, merchant: cfg.merchant });
    if (!drops.length) return false;
    const dropped = [];
    for (const d of drops) {
      const o = (c.inventory || []).find(x => x.id === d.id);
      if (!o) continue;
      await this.s.pacer.submit('drop', () => c.drop([this.dropSpec(o, d.whole ? null : d.amount)])).catch(() => {});
      dropped.push({ name: d.name, amount: d.amount });
    }
    if (!dropped.length) return false;
    this.tally.loot_overflow_dropped = (this.tally.loot_overflow_dropped || 0) + dropped.reduce((t, m) => t + m.amount, 0);
    this.note('dropped overflow loot', { dropped, fullness: Math.round(fullness * 100) / 100, overflow_at: cfg.overflow_at,
      why: 'no station or courier here to take it; the worst shillings per unit of pack go, so the pack keeps room for better loot' });
    try { this.ledgerEvent?.('loot_overflow_dropped', { items: dropped, room: this.s.world?.room?.num ?? null }); } catch {}
    return true;
  }

  // A ONE-WAY GIFT OF CHOSEN ITEMS to a fleetmate standing here: offer, wait for its (empty) counter, accept, and count
  // what actually left the pack by id. The receiver has to counter by itself (acceptDonations with trade_goods).
  async giveItems(character, rows) {
    const s = this.s, c = s.need();
    const them = [...(c.room?.objects?.values?.() ?? [])].find(o => (o.flags & OF.PLAYER) &&
      (c.rsc.get(o.nameRsc) || '').toLowerCase() === String(character).toLowerCase());
    if (!them) return { moved: [], why: `${character} is not in the room` };
    const held = id => { const o = (c.inventory || []).find(x => x.id === id); return o ? (o.amount > 0 ? o.amount : 1) : 0; };
    const before = new Map(rows.map(r => [r.id, held(r.id)]));
    const offers = rows.map(r => (r.whole ? r.id : { id: r.id, amount: r.amount }));
    const at = c.evSeq;
    await s.pacer.submit('trade', () => c.offer(them.id, offers));
    const ev = await c.waitFor({ since: at, kinds: ['countered', 'trade-ended'], timeoutMs: 8000 }).catch(() => ({ events: [] }));
    if (!ev.events?.some(e => e.kind === 'countered')) {
      await s.pacer.submit('trade', () => c.cancelOffer()).catch(() => {});
      return { moved: [], why: `${character} did not take the offer (no counter in 8s: not accepting trade goods, or no room)` };
    }
    const acceptingAt = c.evSeq;
    await s.pacer.submit('trade', () => c.acceptOffer());
    await c.waitFor({ since: acceptingAt, kinds: ['trade-ended'], timeoutMs: 4000 }).catch(() => {});
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
    // WHAT LEFT THE PACK, by id: a handshake that moves nothing must not read as a delivery.
    const moved = rows.map(r => ({ name: r.name, amount: Math.min(r.amount, Math.max(0, before.get(r.id) - held(r.id))) }))
      .filter(m => m.amount > 0);
    return { moved, ...(moved.length ? {} : { why: 'the trade ended but nothing left the pack' }) };
  }
  // @end 1
}
