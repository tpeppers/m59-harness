// THE TOWN TRIP.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 21 methods: openTownTrip, townTripHeld, townTripCommand, townTripStillWanted, reassessTownTrip,
//   abandonTownTrip, dropTownTrip, townTripControlStatus, askTownStrategy, openRequestedTownTrip,
//   countNamed, gatherTownFavors, buyFavorCargo, deliverTownFavors, packSaleValue,
//   minSellTripValue, continueTownTrip, detailEvent, hitDamageTotal, purseNow, tradeFact
import { balancesFor } from '../m59-bank.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { siftValue } from '../m59-overfarm.mjs';
import { buyLines } from '../m59-parse.mjs';
import { purchasePlan } from '../m59-purchase-plan.mjs';
import { runReagentCoop } from '../m59-reagent-coop-runtime.mjs';
import * as skills from '../m59-skills.mjs';
import { detailSettings, recordStrategyStat } from '../m59-strategy-stats.mjs';
import * as townFavors from '../m59-town-favors.mjs';
import { completeTownIncome, recordTownTrade } from '../m59-town-income.mjs';
import { addTradeFact, newTripTrade, packCounts, tripLedgerFields } from '../m59-towntrip-ledger.mjs';
import { BANKS, FOOD_SHOPS, MARKETS, MARKET_STOPS, MIN_SELL_TRIP_VALUE, REAGENT_SHOP, TITHE_FLEET, TRIP_PURPOSE, VIGOR_CAP, hungerNeedsTown, townDestinations , townTable } from '../m59-autopilot.mjs';

export class TownTripPart {
  // @part 1

  // EVERY TOWN TRIP OPENS HERE, AND SAYS WHY. Operator, 2026-09-27: "group up all such code and
  // put it through a 'make town trips' telemetry/bookkeeping method, so we can understand
  // conceptually these things to better sort out bugs vs intentional decisions". A trip used to
  // leave only `town_trip_completed` — its cash, never its cause — so a hunter making a
  // three-hundred-shilling trip every twenty minutes and a character lapping a road with nothing
  // to sell looked the same as a full pack going to market. `town_trip_opened` names the
  // trigger, the purpose it serves, and what the pack was estimated to fetch when it left;
  // `town_trip_completed` carries the same fields, so the two pair up by `trip_started_at`.
  openTownTrip(target, { sellCall = {}, errand = null, wantsMarket = false, supplyTrip = false,
                         starving = false, needsCashFirst = false, brokeWithGoods = false } = {}) {
    const startedAt = Date.now();
    const trigger = sellCall.trigger ?? (starving ? 'food' : 'bank');
    const purpose = TRIP_PURPOSE[trigger] ?? (supplyTrip ? 'restock' : starving ? 'food' : 'other');
    const value = this.packSaleValue();
    // THE PACK GOING IN, and a book for what the trade paths say they did on the way (see
    // m59-towntrip-ledger.mjs). Both close into `town_trip_completed` beside the pack coming out.
    let packIn = null;
    try { packIn = Array.isArray(this.s.client?.inventory) ? packCounts(this.packAsItems()) : null; } catch { packIn = null; }
    this.townTrip = { target, nextService: -1, startedAt, trigger, purpose,
      // The connection this trip was judged on; a different one means "ask again" (reassessTownTrip).
      client: this.s.client ?? null,
      packIn, trade: newTripTrade(),
      estimatedValue: value.value,
      marketStops: wantsMarket ? townTable(this.s.world?.room?.num).MARKET_STOPS.filter(m => !this.bansDestination(m.room)) : null };
    try {
      this.ledgerEvent('town_trip_opened', { trip_started_at: startedAt, trigger, purpose,
        errand, why: sellCall.why ?? null, to: target?.room ?? null, to_name: target?.name ?? null,
        fullness: Number.isFinite(sellCall.fullness) ? Number(sellCall.fullness.toFixed(3)) : null,
        stacks: (this.s.client?.inventory ?? []).length,
        estimated_value: value.value, unpriced_stacks: value.unpriced,
        min_sell_value: this.minSellTripValue(),
        missing: sellCall.missing ?? null, market_circuit: !!wantsMarket,
        // WHICH ITEMS COULD NOT BE WEIGHED, so the weight table can be filled from the kod rather
        // than an unweighable pack sending a hunter to town whatever it is worth.
        unweighed: sellCall.unweighed ?? null,
        pack_in: packIn,
        supply_trip: !!supplyTrip, needs_cash_first: !!needsCashFirst,
        broke_with_goods: !!brokeWithGoods,
        room: this.s.world?.room?.num ?? null });
    } catch { /* never let accounting interrupt play */ }
    return this.townTrip;
  }

  // ================================================================== TOWN TRIPS ON DEMAND
  //
  // Start, drop, hold, and "while you're in town" favors. The rules and the operator's order are in
  // m59-town-favors.mjs (pure, tested); this is the half that touches the trip and the game.
  // Commands only SET STATE and return: the trip is driven by the pass loop (passErrand -> bankRun ->
  // continueTownTrip) as every other trip is, so a command never holds the keeper's command lock
  // through a walk.

  townTripHeld(now = Date.now()) { return townFavors.holdActive(this.townTripHold, now); }

  townTripCommand(args = {}) {
    const cmd = townFavors.normalizeTripCommand(args);
    if (!cmd.ok) return { ok: false, why: cmd.why, status: this.townTripControlStatus() };
    const by = String(args.by ?? 'operator');
    const now = Date.now();
    this.townFavorList ??= [];
    switch (cmd.op) {
      case 'start': {
        if (this.townTrip) return { ok: true, started: false, why: 'already on a town trip', status: this.townTripControlStatus() };
        this.townTripHold = null;
        this.operatorTripRequest = { town: cmd.town, why: cmd.why, by, at: now };
        this.note('town trip requested', { town: cmd.town, by, why: cmd.why ?? null });
        return { ok: true, started: false, queued: true,
                 note: 'opens on the next keeper pass, through the same trip machinery as any other', status: this.townTripControlStatus() };
      }
      case 'drop': return { ok: true, ...this.dropTownTrip({ why: cmd.why, holdMs: cmd.holdMs, by }), status: this.townTripControlStatus() };
      case 'allow': {
        const was = this.townTripHold; this.townTripHold = null;
        return { ok: true, lifted: was, status: this.townTripControlStatus() };
      }
      case 'favor': {
        const f = townFavors.normalizeFavor(args, { now, by });
        if (!f.ok) return { ok: false, why: f.why, status: this.townTripControlStatus() };
        const r = townFavors.addFavors(this.townFavorList, [f.favor]);
        if (r.added.length) this.note('town favor added', { id: f.favor.id, item: f.favor.item, amount: f.favor.amount, to: f.favor.to, by });
        return { ok: r.added.length > 0, ...r, status: this.townTripControlStatus() };
      }
      case 'drop_favor': {
        const f = this.townFavorList.find(x => x.id === cmd.id);
        if (!f) return { ok: false, why: `no favor ${cmd.id}`, status: this.townTripControlStatus() };
        f.status = 'dropped'; f.notes.push(`dropped by ${by}${cmd.why ? `: ${cmd.why}` : ''}`);
        return { ok: true, dropped: cmd.id, status: this.townTripControlStatus() };
      }
      default: return { ok: true, status: this.townTripControlStatus() };
    }
  }

  // IS THE REASON THIS TRIP WAS OPENED STILL TRUE? Asked when the trip resumes on a NEW CONNECTION.
  //
  // Operator, 2026-10-06: "cancel Statler's plans for a town trip, I took the mushrooms off him. In
  // fact, we probably want it to re-assess making a town trip vs 'continuing to farm' if I log into a
  // character interrupting the town trip and modify their inventory then log out." On a keeper-backed
  // character a person logging in only bumps the keeper's socket; the keeper process lives on with the
  // trip in memory and resumes it when the client closes. Statler opened a sell trip at 98% load
  // (21:52Z), the operator emptied his mushrooms, and the trip carried on to Barloque regardless.
  //
  // A new client object is every reconnect, a pilot's or the server's, and each is a moment the pack
  // may have changed under us. The pack is read FRESH first: a reconnect that has not been sent its
  // inventory yet reads as empty, and an empty pack drops every sell trip. Only the needs this keeper
  // opened on its own are re-judged; an operator's, a strategy's or a standing order's trip was asked
  // for on purpose and is left alone. A dropped trip sets NO hold: the next pass may open a new one
  // the ordinary way if the pack still calls for it.
  townTripStillWanted(trip) {
    switch (trip.purpose) {
      case 'sell': {
        const call = this.checkIfShouldSell();
        return call.sell && call.trigger !== 'supply' && TRIP_PURPOSE[call.trigger] === 'sell'
          ? { wanted: true } : { wanted: false, why: `the pack no longer calls for a market (${call.why ?? call.trigger ?? 'no trigger'})` };
      }
      case 'restock': {
        const call = this.checkIfShouldSell();
        return call.sell && call.trigger === 'supply' ? { wanted: true }
          : { wanted: false, why: 'no longer short of its own supply floor' };
      }
      case 'food': {
        const c = this.s.client, reag = this.reagentCount();
        const needs = hungerNeedsTown(this.wantedFightFloor(), c?.vitals?.()?.vigor?.scale_max ?? VIGOR_CAP);
        if (!needs) return { wanted: false, why: 'its fight floor is one resting reaches' };
        if (this.larder(c).length) return { wanted: false, why: 'it has food now' };
        if (this.foodCookingAllowed?.() !== false && reag.elderberry >= 2 && reag.herbs >= 2) return { wanted: false, why: 'it can cook now' };
        return { wanted: true };
      }
      case 'bank': {
        const above = this.bankAboveNow();
        return above && this.purseNow() > above ? { wanted: true }
          : { wanted: false, why: `the purse is no longer over the banking threshold (${above})` };
      }
      default: return { wanted: true, why: 'opened on purpose; not re-judged' };
    }
  }

  async reassessTownTrip(trip) {
    const s = this.s, c = s.client;
    try {
      const before = c.evSeq;
      await s.pacer.submit('read', () => c.requestInventory());
      const got = await c.waitFor({ since: before, kinds: ['inventory'], timeoutMs: 3000 });
      // No fresh pack, no verdict: judge again on the next pass rather than on a guess.
      if (!(got?.events ?? []).length && !Array.isArray(c.inventory)) return 'unknown';
    } catch { return 'unknown'; }
    trip.client = c;
    const still = this.townTripStillWanted(trip);
    if (still.wanted) {
      this.note('town trip still wanted after reconnecting', { purpose: trip.purpose, trigger: trip.trigger, to: trip.target?.room ?? null });
      return 'kept';
    }
    this.abandonTownTrip(trip, still.why, 'reassessed');
    return 'dropped';
  }

  /** Drop one trip with NO hold, cancel its walk, and say why in the ledger. */
  abandonTownTrip(trip, why, by) {
    const had = { to: trip.target?.room ?? null, purpose: trip.purpose, trigger: trip.trigger, started_at: trip.startedAt };
    if (this.townTrip === trip) this.townTrip = null;
    if (this.deferredShoppingTrip === trip) this.deferredShoppingTrip = null;
    if (this.purchaseFunding) this.purchaseFunding = { ...this.purchaseFunding, pending: false, status: 'trip no longer wanted' };
    try { this.s.cancelMovement?.(null, `town trip dropped (${by}): ${why}`, { origin: keeperOrigin(`town_trip_${by}`) }); } catch {}
    this.note(`town trip dropped (${by})`, { why, had });
    try { this.ledgerEvent('town_trip_dropped', { by, why, had, hold_ms: 0, room: this.hereRoom() }); } catch {}
  }

  /** End the trip and the set-aside one, cancel the walk, and hold new trips. */
  dropTownTrip({ why = null, holdMs = townFavors.DEFAULT_HOLD_MS, by = 'operator' } = {}) {
    const now = Date.now();
    const had = { active: this.townTrip ? { to: this.townTrip.target?.room ?? null, purpose: this.townTrip.purpose,
                                            started_at: this.townTrip.startedAt } : null,
                  deferred: !!this.deferredShoppingTrip, requested: !!this.operatorTripRequest };
    this.townTrip = null;
    this.deferredShoppingTrip = null;
    this.operatorTripRequest = null;
    if (this.purchaseFunding) this.purchaseFunding = { ...this.purchaseFunding, pending: false, status: 'trip dropped' };
    this.townTripHold = holdMs > 0 ? { until: now + holdMs, why, by, at: now } : null;
    let cancelled = null;
    try { cancelled = this.s.cancelMovement?.(null, `town trip dropped${why ? `: ${why}` : ''}`, { origin: keeperOrigin('town_trip_drop') }) ?? null; }
    catch (e) { cancelled = { error: e.message }; }
    this.note('town trip dropped', { by, why, had, hold_until: this.townTripHold?.until ?? null });
    try { this.ledgerEvent('town_trip_dropped', { by, why, had, hold_ms: holdMs, room: this.hereRoom() }); } catch {}
    return { dropped: had, hold: this.townTripHold, walk_cancelled: !!cancelled?.cancelled };
  }

  townTripControlStatus(now = Date.now()) {
    return {
      trip: this.townTrip ? { to: this.townTrip.target?.room ?? null, purpose: this.townTrip.purpose,
                              trigger: this.townTrip.trigger, next_service: this.townTrip.nextService } : null,
      deferred: !!this.deferredShoppingTrip,
      requested: this.operatorTripRequest ?? null,
      hold: this.townTripHeld(now) ? this.townTripHold : null,
      favors: townFavors.favorSummary(this.townFavorList),
    };
  }

  /**
   * ASK A PRIVATE `townTrip` STRATEGY. Throttled (60 s) when merely considering; asked once, unthrottled,
   * as a trip opens (`opening`). It may start a trip and/or add favors. Never throws.
   */
  async askTownStrategy({ opening = null } = {}) {
    const now = Date.now();
    if (!opening && this._townAskAt && now - this._townAskAt < 60_000) return null;
    if (!opening) this._townAskAt = now;
    let answer = null;
    try {
      answer = await this.s?._askStrategies?.('townTrip', {
        agent: this.s?.name ?? null, character: this.who(), room: this.hereRoom(),
        assigned_room: this.policy.assignedRoom ?? null, purse: this.purseNow?.() ?? null,
        opening, held: this.townTripHeld(now), favors: townFavors.favorSummary(this.townFavorList),
      });
    } catch { answer = null; }
    if (!answer?.answer) return null;
    const by = `strategy:${answer.strategy}`;
    const t = townFavors.normalizeTownAnswer(answer.answer, { now, by });
    if (t.problems.length) this.note('townTrip strategy answer problems', { strategy: answer.strategy, problems: t.problems });
    if (t.favors.length) {
      this.townFavorList ??= [];
      const r = townFavors.addFavors(this.townFavorList, t.favors);
      if (r.added.length) this.note('town favors added by a strategy', { strategy: answer.strategy, added: r.added, refused: r.refused });
    }
    // A strategy may start a trip, but never through an operator's hold.
    if (t.start && !opening && !this.townTrip && !this.townTripHeld(now) && !this.operatorTripRequest)
      this.operatorTripRequest = { town: t.start.town, why: t.start.why, by, at: now };
    return t;
  }

  /** Open the requested trip: the same destination table, opener and shopping plan as any other trip. */
  async openRequestedTownTrip() {
    const req = this.operatorTripRequest;
    this.operatorTripRequest = null;
    const town = req.town ?? 'market';
    const destinations = townDestinations({ packFull: town === 'market', richEnoughToBank: town === 'bank',
                                            starving: town === 'food', supplyTrip: town === 'supply',
                                            table: townTable(this.s.world?.room?.num) })
      .filter(b => !this.bansDestination(b.room));
    const options = destinations
      .map(b => { const r = this.s.world?.route?.(b.room); return { ...b, hops: r?.found ? r.hops.length : Infinity }; })
      .sort((x, y) => x.hops - y.hops);
    const target = options[0];
    if (!target || !Number.isFinite(target.hops)) {
      this.note('requested town trip cannot start', { town, by: req.by, why: target ? 'no route' : 'every destination is banned' });
      return false;
    }
    const trigger = String(req.by).startsWith('strategy:') ? 'strategy' : 'operator';
    await this.askTownStrategy({ opening: { purpose: TRIP_PURPOSE[trigger], trigger, to: target.room } });
    this.doing = 'travelling';
    this.openTownTrip(target, { sellCall: { trigger, why: req.why ?? `${trigger} asked for a ${town} trip` },
      errand: `going to town (${req.by})`, wantsMarket: town === 'market' || this.packWantsMarket(),
      supplyTrip: town === 'supply', starving: town === 'food' });
    this.postShoppingPlan(this.shoppingPlan());
    return this.continueTownTrip();
  }

  // ------------------------------------------------------------------ favors: in town, and home

  /** How many of `item` the pack holds, singular or plural. */
  countNamed(item) {
    const c = this.s.client; const want = String(item).toLowerCase().replace(/s$/, '');
    return (c?.inventory || []).filter(o => String(c.rsc.get(o.nameRsc) || '').toLowerCase().replace(/s$/, '') === want)
      .reduce((n, o) => n + (o.amount || 1), 0);
  }

  /** The trip step: load every open favor, from the hall chests and/or a shop. Never blocks the trip. */
  async gatherTownFavors() {
    const open = (this.townFavorList ?? []).filter(f => f.status === 'open');
    for (const f of open) {
      let need = f.amount - f.loaded;
      if (need > 0 && f.source !== 'buy') {
        const before = this.countNamed(f.item);
        const r = await this.withdrawFromStockpile([{ item: f.item, amount: need }]).catch(e => ({ took: [], why: e.message }));
        await this.s.pacer.submit('read', () => this.s.need().requestInventory()).catch(() => {});
        await this.s.need().waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
        const got = Math.max(0, this.countNamed(f.item) - before);
        f.loaded += got; need -= got;
        f.notes.push(`hall: ${got} of ${got + need}${r?.why && !got ? ` (${String(r.why).slice(0, 80)})` : ''}`);
      }
      if (need > 0 && f.source !== 'hall' && f.shop_room != null) {
        const got = await this.buyFavorCargo(f, need).catch(e => { f.notes.push(`buy failed: ${e.message}`); return 0; });
        f.loaded += got; need -= got;
      }
      f.status = f.loaded > 0 ? 'loaded' : 'unloaded';
      if (need > 0) f.notes.push(`short by ${need}`);
      this.note('town favor loaded', { id: f.id, item: f.item, wanted: f.amount, loaded: f.loaded, to: f.to });
    }
    return null;
  }

  async buyFavorCargo(f, need) {
    const s = this.s, c = s.need();
    if (this.hereRoom() !== f.shop_room) {
      const walked = await this.travel(f.shop_room, { origin: keeperOrigin('town_favor_buy'), maxHops: 16 })
        .catch(error => ({ arrived: false, reason: error.message }));
      if (!walked?.arrived) { f.notes.push(`could not reach shop room ${f.shop_room}: ${walked?.reason ?? '?'}`); return 0; }
    }
    const re = new RegExp(`^${f.item.replace(/s$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?$`, 'i');
    const pick = await this.sellerHere({ want: re }).catch(() => null);
    if (!pick) { f.notes.push(`nobody in room ${f.shop_room} sells ${f.item}`); return 0; }
    const start = c.evSeq;
    await s.pacer.submit('buy', () => c.buy(pick.seller.id ?? pick.seller));
    const ev = await c.waitFor({ since: start, kinds: ['shop'], timeoutMs: 4000 }).catch(() => ({ events: [] }));
    const shop = ev.events?.find(row => row.kind === 'shop');
    const entry = shop?.items?.find(item => re.test(String(item.name ?? '').trim()));
    if (!entry) { f.notes.push(`room ${f.shop_room}'s counter does not list ${f.item}`); return 0; }
    const unit = entry.cost || 0, floor = this.walkingFloat();
    const take = Math.min(need, unit > 0 ? Math.max(0, Math.floor((this.purseNow() - floor) / unit)) : need);
    if (!take) { f.notes.push(`cannot afford ${f.item} at ${unit} above the ${floor} float`); return 0; }
    const before = this.countNamed(f.item);
    for (const line of buyLines([{ id: entry.id, amount: take }])) {
      await s.pacer.submit('buy', () => c.buyItems(shop.sellerId, [line]));
      await new Promise(resolve => setTimeout(resolve, 700));
      for (let n = 0; n < line.amount; n++)
        this.recordPurchase(entry.name, entry.cost, { why: `town favor ${f.id} for ${f.to.join(', ')}` });
    }
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
    const got = Math.max(0, this.countNamed(f.item) - before);
    f.notes.push(`bought ${got} at ${unit} in room ${f.shop_room}`);
    return got;
  }

  /**
   * HOME AGAIN: hand each loaded favor to its recipients, in its room. Called from passErrand once no
   * trip is in flight. A recipient who is not there is retried later (60 s), never skipped silently.
   * Returns true when it did something this pass.
   */
  async deliverTownFavors() {
    const now = Date.now();
    const due = (this.townFavorList ?? []).filter(f => f.status === 'loaded' && !(f.nextTryAt > now));
    if (!due.length || this.townTrip) return false;
    for (const f of due) {
      const room = f.room ?? this.policy.assignedRoom ?? null;
      if (room != null && this.hereRoom() !== room) {
        const walked = await this.travel(room, { origin: keeperOrigin('town_favor_deliver'), maxHops: 20 })
          .catch(error => ({ arrived: false, reason: error.message }));
        if (!walked?.arrived) { f.nextTryAt = now + 60_000; f.notes.push(`could not reach room ${room}: ${walked?.reason ?? '?'}`); return true; }
      }
      const c = this.s.need();
      for (const [name, n] of Object.entries(townFavors.sharesFor(f, this.countNamed(f.item)))) {
        if (!this.playerHere(name)) { f.notes.push(`${name} is not in room ${this.hereRoom()}`); continue; }
        const stack = (c.inventory || []).find(o => String(c.rsc.get(o.nameRsc) || '').toLowerCase().replace(/s$/, '') === f.item.replace(/s$/, ''));
        if (!stack) break;
        const before = this.countNamed(f.item);
        const r = await this.chaliceGive(name, [{ id: stack.id, amount: n }], { stillHave: () => this.countNamed(f.item) >= before });
        const gave = Math.max(0, before - this.countNamed(f.item));
        if (gave) f.delivered[name] = (f.delivered[name] ?? 0) + gave;
        f.notes.push(r.gave ? `gave ${name} ${gave}` : `${name}: ${r.why}`);
      }
      // Nothing left to hand over (given out, eaten by a death, traded away) also closes it.
      if (!townFavors.favorDone(f) && this.countNamed(f.item) === 0) f.notes.push('nothing left in the pack to give');
      if (townFavors.favorDone(f) || this.countNamed(f.item) === 0) {
        f.status = 'delivered'; f.delivered_at = Date.now();
        this.note('town favor delivered', { id: f.id, item: f.item, delivered: f.delivered });
        try { this.ledgerEvent('town_favor_delivered', { id: f.id, item: f.item, delivered: f.delivered, by: f.by }); } catch {}
      } else f.nextTryAt = Date.now() + 60_000;
    }
    return true;
  }

  // WHAT THE PACK WOULD FETCH, ESTIMATED. Shillings excluded. ITEM_VALUE prices 89 of 249 items, so
  // this is a floor, and `unpriced` says how many stacks it could not price.
  packSaleValue() {
    const c = this.s.client;
    let value = 0, unpriced = 0;
    for (const o of c?.inventory ?? []) {
      const name = String(c.rsc?.get?.(o.nameRsc) ?? '').toLowerCase();
      if (!name || /shilling/.test(name)) continue;
      const v = this.itemValue(name, o.amount);
      if (v > 0) value += v; else unpriced += 1;
    }
    return { value: Math.round(value), unpriced };
  }

  minSellTripValue() {
    const v = Number(this.policy.minSellTripValue);
    return Number.isFinite(v) && v >= 0 ? v : MIN_SELL_TRIP_VALUE;
  }

  async continueTownTrip() {
    const trip = this.townTrip;
    if (!trip) return false;
    if (this.travelInterrupted() || this.suspendedJourney || this.inert?.travelling)
      return true; // still pending; the survival ladder owns this pass
    // A TRIP OF ITS OWN UNDER A ROSTER THAT NOW SAYS NONE (see bankRun) is dropped, not finished.
    if (this.policy.townTrips === false && !['operator', 'strategy'].includes(trip.purpose)) {
      this.abandonTownTrip(trip, 'policy.townTrips is false: no town trips of its own', 'policy');
      return false;
    }
    // A NEW CONNECTION SINCE THIS TRIP WAS LAST JUDGED: ask again whether it is still wanted.
    if (trip.client !== undefined && trip.client !== this.s.client && this.s.client) {
      const still = await this.reassessTownTrip(trip);
      if (still === 'dropped') return false;
    }
    if (Date.now() < (trip.nextTryAt ?? 0)) return true;
    if (trip.nextService < 0) {
      // A sale can raise the cash first. Every other shopping approach must fund
      // its posted bill before walking to a merchant.
      const plan = trip.purchasePlan ?? this.shoppingPlan();
      this.postShoppingPlan(plan);
      if (plan.required_purse > 0 && !townTable(trip.target.room).MARKETS.some(m => m.room === Number(trip.target.room))) {
        const funded = await this.ensurePurchaseFunds(plan);
        if (funded.unaffordable) return false;
        if (!funded.ready) return true;
      }
      if ((await this.leaveHold('continuing the shopping trip')).refused) return true;
      if (this.policy.reagentCoop?.enabled && !trip.coopInitial &&
          !townTable(trip.target.room).BANKS.some(b => b.room === Number(trip.target.room))) {
        const donation = await runReagentCoop(this, 'town', {
          requestId: 'keeper-town:' + trip.startedAt + ':initial', nextRoom: trip.target.room,
          bankable: Math.max(0, this.purseNow() - Math.max(this.walkingFloat(),
            this.shoppingPlan().required_purse ?? 0)),
        }, TITHE_FLEET);
        if (donation.pending) return true;
        trip.coopInitial = true;
        trip.coopOpportunity = 1; // sell is the next real task; do it before retrying
        if (!donation.deferred) trip.coopDone = true;
      }
      // WAND DUTY BEFORE LEAVING CASTLE VICTORIA (operator, 2026-10-06): every wand goes to the
      // bank first, walking home or riding the chalice. A skip is never a failed trip.
      if (!trip.wandDropoffDone && this.wandDutyCfg) {
        const w = await this.wandDropoff(trip).catch(e => ({ skip: true, why: e.message }));
        if (w.pending) return true;
        trip.wandDropoffDone = true;
      }
      // RIDE THE CHALICE HOME when the station is on the way. After the first optional
      // donation and before the walk; a skip is never a failed trip, only the old walk.
      if (!trip.chaliceDecided && this.chaliceCfg) {
        const ride = await this.chaliceRide(trip).catch(e => ({ skip: true, why: e.message }));
        if (ride.pending) return true;
        trip.chaliceDecided = true;
      }
      const alreadyThere = Number(this.s.world?.room?.num) === Number(trip.target.room);
      const r = alreadyThere
        ? { arrived: true }
        : await this.travel(trip.target.room, { origin: keeperOrigin('town_trip'), maxHops: Math.max(12, trip.target.hops + 4) })
          .catch(e => ({ arrived: false, reason: e.message }));
      if (!alreadyThere) this.money.trips++;
      if (!r.arrived || this.travelInterrupted()) {
        // This is a pending trip, never a discarded shopping request. Physical
        // route failures get a short retry delay; rescues resume through the ladder.
        trip.nextTryAt = Date.now() + 5000;
        if (!r.paused && !r.cancelled && !this.travelInterrupted()) {
          this.money.trips_failed++;
          if (this.money.why_not.length < 6)
            this.money.why_not.push({ to: trip.target.room, why: r.reason || 'did not arrive' });
        }
        this.note('shopping trip still pending', { to: trip.target.room,
          why: r.reason ?? 'recovering before continuing', next_service: trip.nextService });
        return true;
      }
      trip.nextService = 0;
    }
    const steps = [
      // `duringTownTrip` because this IS the town trip — see the guard in
      // contributeGuildWants, which without it skipped its own scheduler.
      ['guild contribution', () => this.contributeGuildWants({ duringTownTrip: true })],
      ['sell', async () => {
        const result = trip.marketStops?.length ? await this.sellMarketCircuit(trip) : await this.sellInTown();
        if (result?.pending) return result;
        trip.sale = result;
      }],
      ['guild tithe', () => this.guildTitheFromSale(trip.sale)],
      ['bank surplus', () => this.bankSurplus()],
      // AFTER banking, which keeps the order's price back (`standingOrderReserve`), so the
      // chest is only asked for what the purse genuinely lacks.
      ['standing orders', () => this.fundStandingOrder()],
      ['withdraw shopping money', () => this.ensurePurchaseFunds(this.shoppingPlan())],
      ['restock here', () => this.restockInTown()],
      ['buy food', () => this.buyFoodInTown()],
      ['buy reagents', () => this.buyReagentsInTown()],
      // THE HOLDER'S RESTOCK, BOUGHT OUT OF WHAT IS LEFT. Deliberately after this character's
      // own food and reagents: the tip comes from the surplus, never from the floor. See
      // `chaliceBuyCargo` — it is carried home and handed over at the station by the same
      // path the guild-chest draw uses.
      // THE GUILD CHEST FIRST, on every trip home and not only after a ride (chaliceTownCargo).
      ["draw the holder's restock", () => this.chaliceTownCargo()],
      ["buy the holder's restock", () => this.chaliceBuyCargo()],
      ['buy delivery cargo', () => this.buyFarmDeliveryCargo()],
      // "WHILE YOU'RE IN TOWN" (m59-town-favors.mjs): last of the buying, out of what is left.
      ['town favors', () => this.gatherTownFavors()],
      ['vault', () => this.vaultRunIfPassing()],
      // LAST, ON KO'CATAN: leave town with a pack the East Tower guard will let through (sell / vault / drop;
      // m59-kocatan-gate.mjs). A no-op anywhere else, or when the farm is not past the gate.
      // A failure is noted and passed, never retried: the refusal path in travel() gets another go at it.
      ["clear the Ko'catan gate", () => this.kocatanGateClear({ trigger: 'town trip' })
        .catch(e => { this.note("could not clear the pack for the Ko'catan gate", { why: e.message }); return null; })],
    ];
    const coopBusiness = new Set(['sell', 'restock here', 'buy food', 'buy reagents',
      "buy the holder's restock", 'buy delivery cargo', 'vault']);
    while (trip.nextService < steps.length) {
      const [name, run] = steps[trip.nextService];
      if (this.policy.reagentCoop?.enabled && !trip.coopDone && coopBusiness.has(name) &&
          trip.coopOpportunity !== trip.nextService) {
        // Shopping is never refused for secrecy. A denied chance advances to
        // this service; only another service creates another chance.
        const donation = await runReagentCoop(this, 'town', {
          requestId: 'keeper-town:' + trip.startedAt + ':' + trip.nextService,
          nextRoom: name === 'buy food' ? townTable(this.s.world?.room?.num).FOOD_SHOPS[0].room : name === 'buy reagents' ? townTable(this.s.world?.room?.num).REAGENT_SHOP.room : Number(this.s.world?.room?.num), first: false,
          bankable: Math.max(0, this.purseNow() - Math.max(this.walkingFloat(),
            this.shoppingPlan().required_purse ?? 0)),
        }, TITHE_FLEET);
        if (donation.pending) return true;
        trip.coopOpportunity = trip.nextService;
        if (!donation.deferred) trip.coopDone = true;
      }
      if (this.travelInterrupted() || this.suspendedJourney) return true;
      const result = await run().catch(e => {
        this.note('shopping step failed', { step: name, why: e.message });
        return { pending: true };
      });
      if (result?.unaffordable) return false;
      if (result?.pending || result?.ready === false) {
        trip.nextTryAt = Date.now() + 5000;
        return true;
      }
      if (this.travelInterrupted() || this.suspendedJourney) {
        this.note('shopping trip paused for recovery', { step: name,
          to: this.suspendedJourney?.to ?? null, remaining_steps: steps.length - trip.nextService });
        return true; // retry THIS step once recovered, then continue the shopping list
      }
      trip.nextService++;
    }
    // A LAP ENDS WHERE THE GOODS DO, AND THAT IS HERE.
    //
    // It used to end on any time booked as "trading", which includes BUYING. Measured on
    // prod 2026-09-17: Camilla's first recorded lap ended at 5% of capacity sifted, in
    // Joguer's Herbs and Roots, because she stopped to buy herbs -- so the counter reset
    // constantly and the 150% target was unreachable. A completed town trip is the
    // unambiguous moment: the pack has been emptied at merchants, the vault and the chests.
    if (this.policy.overfarm?.enabled) {
      const lap = this.s?.endOverfarmLap?.();
      if (lap?.stream?.length && detailSettings(this.policy, 'overfarm')) {
        const cap = skills.carryCapacity(this.s?.client);
        const v = siftValue({ stream: lap.stream, policy: this.policy.overfarm,
                              capacity: cap?.known ? cap.weight_max : null });
        this.detailEvent('overfarm', 'lap', {
          ended_at: Date.now(), room: this.s?.world?.room?.num ?? null,
          target_percent: this.policy.overfarm.overfarm_percent,
          selective_at: this.policy.overfarm.selective_at,
          sifted: v.sifted, sifted_percent: v.sifted_percent, capacity: v.capacity,
          picked_up: lap.taken, traded_away: lap.dropped, left_behind: lap.left,
          baseline_value: v.baseline.value, kept_value: v.kept.value,
          gain: v.gain, gain_percent: v.gain_percent,
          mixture: v.mixture.slice(0, 8), unpriced: v.unpriced.slice(0, 8),
          // Every shilling here is viValue_average through a merchant markup, and 160 of the
          // 249 weighable items carry no price at all. The COMPARISON is sound because both
          // halves are blind to the same items; the absolute number is an estimate.
          estimated: true,
        });
      }
    }
    this.townTrip = null;
    this.lastTownServiceAt = Date.now();
    if (trip.marketStops?.length) this.lastMarketServiceAt = this.lastTownServiceAt;
    // Only a finished service circuit closes an income cycle. Survival pauses,
    // deferred unaffordable shopping and intermediate merchant stops do not.
    try {
      const who = this.s.client?.me?.name;
      if (who) {
        const income = completeTownIncome(who, { trip_started_at: trip.startedAt,
          completed_at: this.lastTownServiceAt, room: this.s.world?.room?.num ?? null,
          purse: Array.isArray(this.s.client.inventory) ? this.purseNow() : null,
          accounts: balancesFor(who) });
        let packOut = null;
        try { packOut = Array.isArray(this.s.client?.inventory) ? packCounts(this.packAsItems()) : null; } catch { packOut = null; }
        if (income) this.ledgerEvent('town_trip_completed', { ...income,
          trigger: trip.trigger ?? null, purpose: trip.purpose ?? null,
          estimated_value_at_open: trip.estimatedValue ?? null,
          ...tripLedgerFields({ packIn: trip.packIn ?? null, packOut, trade: trip.trade ?? null }) });
      }
    } catch { /* never let accounting interrupt play */ }
    this.progress('finished the shopping trip');
    return true;
  }

  detailEvent(category, event, detail = {}) {
    const settings = detailSettings(this.policy, category);
    const who = this.s.client?.me?.name;
    if (!settings || !who) return null;
    try { return recordStrategyStat(who, category, event,
      { agent: this.name ?? this.s.name ?? undefined, ...detail }, settings); }
    catch { return null; }
  }

  hitDamageTotal() {
    try { return (this.s.hitBook?.()?.segments ?? []).reduce((n, row) => n + (Number(row.lost) || 0), 0); }
    catch { return 0; }
  }

  purseNow() {
    const c = this.s.client;
    return (c?.inventory ?? []).filter(item => /shilling/i.test(c.rsc.get(item.nameRsc) || ''))
      .reduce((n, item) => n + Math.max(0, Number(item.amount ?? 1) || 0), 0);
  }

  tradeFact(fact = {}) {
    try { recordTownTrade(this.s.client?.me?.name, fact); } catch { /* bookkeeping only */ }
    // AND INTO THE OPEN TRIP'S OWN BOOK, item by item (m59-towntrip-ledger.mjs).
    try { if (this.townTrip?.trade) addTradeFact(this.townTrip.trade, fact); } catch { /* bookkeeping only */ }
    this.passTrade ??= { earned: 0, spent: 0, banked: 0, sold: [], bought: [], deposited: [] };
    for (const key of ['earned', 'spent', 'banked'])
      this.passTrade[key] += Number(fact[key]) || 0;
    for (const key of ['sold', 'bought', 'deposited'])
      if (fact[key]) this.passTrade[key].push(...[].concat(fact[key]));
  }
  // @end 1
}
