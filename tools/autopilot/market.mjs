// SELLING: broken gear, what the pack wants sold, and what an item is worth.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 5 methods: restBroken, packWantsMarket, checkIfShouldSell, itemValue, farmCleanupBeforeSale
import { closeIfHealed, mayLogoff, noteLogoff, staysPut } from '../m59-healing-session.mjs';
import { OF } from '../m59-parse.mjs';
import * as skills from '../m59-skills.mjs';
import { orderSkills } from '../m59-standing-orders.mjs';
import { ITEM_VALUE, MARKET_ALONG_AT, MARKET_ALONG_MIN_RELIEF, MARKET_ALONG_RELIEF, SELL_AT_LOAD, SELL_REGARDLESS_AT } from '../m59-autopilot.mjs';

export class MarketPart {
  // @part 1

  // HIT WHILE RESTING. The one response that must never happen is the one that used
  // to: note it and rest again next pass on the same square.
  //
  // Being hit while resting is proof that this is not a place to rest — resting is
  // standing still and not swinging, which is the one thing a working safe spot makes
  // free. So do the two things that change the situation, in the order that makes both
  // of them work:
  //
  //   RECONNECT first. It drops the aggro of whatever is on us and hands back the entry
  //   grace period, so the walk out is made past monsters that have to notice us one at
  //   a time. It costs nothing we were not already losing: health regeneration is gated
  //   on PFLAG_MOVED_SINCE_ENTRY, so we cannot heal until we have moved anyway.
  //
  //   THEN take a real wall, rather than sitting back down where we are. Since we have
  //   to move before we can heal regardless, we may as well move somewhere that holds.
  //
  // Only after both is resting allowed again, and by then it is a different square.
  async restBroken(room, near) {
    this.tally.rests_broken = (this.tally.rests_broken || 0) + 1;
    // ONE LOGOFF PER HEALING SESSION, AND ONE SPOT (m59-healing-session.mjs). Operator, 2026-10-27: "Only one logoff:
    // After, It just sits still and safe after rotating so it can heal." Once this session's logoff is spent, a broken
    // rest neither logs off again, gives up the spot, nor walks to another wall: the body stays where it is and heals.
    const me = String(this.s?.name ?? '');
    { const h = this.s.client?.vitals?.()?.health; closeIfHealed(me, { hp: h?.value, max: h?.max }); }
    const spent = !mayLogoff(me);
    if (spent && staysPut(me, { holding: !!this.hold })) {
      this.note('hit while resting, staying put: this healing session already logged off once', {
        rule: 'one logoff per healing session, one spot, sit still until full' });
      return;
    }
    // A spent session with no spot: no second logoff, but it still flees to the nearest reachable one (below).
    // A BROKEN REST WITH NOTHING NEXT TO US IS NOT EVIDENCE ABOUT THE SQUARE.
    //
    // observe() has always refused this reading — `nothing was in swing range, a quiet
    // window with nothing to be quiet about` — and it refuses it for BOTH verdicts,
    // because a window with no attacker in it says nothing either way. This path never
    // had the guard, and it is the path that fires in a town: a character crosses Tos,
    // sits down, the rest is interrupted by something that is not a monster, and the
    // paving stone it happened to stop on is condemned for ever.
    //
    // It wrote 130 of the book's 474 failures that way — 27% of all the evidence we had
    // — and 116 of those are in five rooms with nothing hostile in them at all: 58 in
    // The Streets of Tos, 17 in the Sparkling Stone Shop, 15 in South Barloque, 14 in
    // Familiars, 12 in Marion. Every recorded square in all five is a phantom, written
    // ten seconds apart along a walking route.
    //
    // Worse than the count is the SHAPE: those squares are open floor, so they poisoned
    // every comparison of one selection rule against another in exactly the direction
    // that flatters "prefer a wall". A metric graded against them scores well for the
    // wrong reason.
    //
    // The rest is still broken, and everything below still runs. All this refuses to do
    // is blame the square when nothing was there to blame it for.
    if (this.hold && !near.length) {
      this.note('rest broken with nothing in reach — not counted against this square', {
        where: { col: this.hold.col, row: this.hold.row }, room: room?.num,
        why: 'a rest can be interrupted by things that are not an attack, and a window ' +
             'with no attacker in it is not a reading. See observe(), which has always ' +
             'refused the same window' });
    }
    // Evidence first, while we still know which square failed.
    if (this.hold && near.length) {
      this.noteFailedRestSpot(this.hold.room, this.hold.col, this.hold.row);
      // (a `book.failed(...)` write stood here; the ledger is retired — see the note at the
      // matching site in the rest-interruption path)
      this.note('THIS IS NOT A SAFE SPOT', {
        where: { col: this.hold.col, row: this.hold.row }, room: room?.num,
        attackers: near.length, proven_against: this.hold.mostAttackers ?? 0,
        why: 'we were hit while resting, which is standing still and not swinging — the ' +
             'one thing that cannot happen in a working spot',
        caveat: 'this keeper temporarily skips the square on its next shelter search; ' +
                'this does not establish whether geometry or another damage source broke the rest' });
      this.releaseHold('we were hit while resting in it');
    } else if (!this.hold) {
      this.note('hit while resting in the open', { room: room?.num, attackers: near.length,
        why: 'there was no wall at our back; this is the case the safe spot exists for' });
    }
    // The third case — holding a spot, rest broken, nothing in reach — is noted above and
    // deliberately falls through without releasing the hold. There is no evidence against
    // the square, so giving it up would throw away a working wall over a hunger tick.

    // Shed the aggro before walking anywhere.
    let dropped = false;
    if (!spent && this.policy.breakOutViaLogoff !== false) {
      noteLogoff(me, { why: 'hit while resting', room: room?.num ?? null });
      const rc = await this.reconnect('hit while resting — shedding aggro before moving')
                           .catch(e => ({ ok: false, why: e.message }));
      dropped = !!rc?.ok;
      this.note(dropped ? 'reconnected to shed aggro' : 'could not reconnect', {
        why: dropped
          ? 'the entry grace period is handed back, so the walk to a real spot is made past ' +
            'monsters that have to notice us one at a time'
          : rc?.why });
    }
    // Then go and get a wall. Not resting again until we have one.
    {
      const got = await this.takeRecoverySpot('hit while resting — need a square that holds')
        .catch(() => false);
      this.note('moving rather than resting again', { got_a_wall: !!got?.took, shed_aggro: dropped,
        why: 'resting again where we were just hit is the loop that kills characters "while resting"' });
    }
    this.progress('left a square that could not be rested in');
  }

  // MAKE THE TRIP, once there is enough in the purse to be worth it.
  //
  // bankSurplus() only ever fired when a character HAPPENED to be standing in a bank —
  // sound for the strategies that pass through town, and dead code for `fieldrest`,
  // whose whole point is that it never goes. The fleet ran that way for hours and
  // accumulated 35,920 shillings in pockets, single characters holding five thousand,
  // every coin of it on the floor the moment they died.
  //
  // This is what a player does instead: at a few thousand you stop what you are doing
  // and walk to Jasper or Tos, whichever is nearer, because it is the only way a death
  // is a setback rather than a reset. The walk is not free and neither is dying with
  // 5,840 on you.
  //
  // No return leg is needed. A bank is a town room and generates no prey, so the
  // relocation in farm() sends the character back to its assignedRoom on the next pass
  // — the same mechanism that used to scatter the fleet, working for us.
  // SHOULD THIS CHARACTER BREAK OFF AND GO AND SELL? ONE FUNCTION, ONE ANSWER, AND A
  // POLICY CAN REPLACE EITHER THE NUMBERS OR THE WHOLE JUDGEMENT.
  //
  // This used to be four expressions inlined in bankRun(), which meant the only way to
  // change "when do we sell" was to edit the keeper — and the numbers were wrong for this
  // fleet in a way nobody could override: `purse + bank < 500` with four spare stacks sent
  // twenty characters to the same NPC at once, each carrying about ninety shillings of
  // mushroom, during a window they should have been farming.
  //
  // The seam matters more than the defaults. Whoever owns `economy` — DUM, an LLM bot, or
  // an operator setting policy by hand — supplies its own thresholds, and can supply a
  // whole different rule by handing in `policy.shouldSell`, a function of the same shape.
  // The keeper keeps only the part that is a fact about the character rather than a
  // judgement about the fleet: a pack too heavy to pick up what it kills has stopped
  // earning, and that is true whatever anyone is saving for.
  //
  // Call it between tasks — after a kill, before setting off, at the top of a town errand.
  // It reads state and decides; it walks nobody.
  // IS THIS PACK WORTH THE CIRCUIT, WHATEVER OPENED THE TRIP.
  //
  // `checkIfShouldSell` answers "should we set off", and its answer is a TRIGGER — load,
  // stacks, broke, supply, unweighable. The trip builder then read that trigger to decide
  // whether to attach the market stops, and two of the five say no: a `supply` trip is a
  // reagent shortfall and a `broke` trip is a money one. Both are correct about the
  // DESTINATION and neither is evidence about the PACK.
  //
  // So a character out of elderberry walked to Joguer with twenty-six stacks aboard, bought
  // its two reagents, sold the mushrooms Joguer buys, and came home still carrying
  // twenty-one long swords — because Joguer is not a blacksmith and the circuit that would
  // have walked it to one was never attached.
  //
  // Measured on prod 2026-09-19: Pepe and Statler both on `pending_trip.to = 104` with
  // `market_stops: null` and 26 stacks each; 122 long swords across eleven characters.
  //
  // This asked the pack with the SAME threshold the load trigger uses, so a trip could not be
  // attached under one rule and refused under another -- and that is what regressed. Measured on
  // prod 2026-10-02: eleven characters carrying 13-31 long swords each at 72-97% load, 291 food
  // trips in two days, ZERO visits to the Royal Blacksmith (113, who buys weapons: bqSmith.kod
  // ObjectDesired takes IsObjectWeapon), and every trip ending in `sellInTown` at a counter that
  // does not buy swords. The live policy had `sellAtLoad: 0.97`, while holdForCourier and an
  // overfarm hold of 400% keep exactly these packs PLATEAUED just under it (t15: 96.6%), so the
  // circuit was never attached and the load trip that would go to market is held by design.
  //
  // "Should we LEAVE to sell" (the trigger, which the holds may veto) and "since we are going to
  // town anyway, walk the counters" are different questions. This answers the second:
  //   * the pack is near full: MARKET_ALONG_AT (85%, or `marketAlongAt`) or the trigger, whichever
  //     is lower -- unless selling would free almost nothing (a pack of KEPT stock gains no
  //     relief from the walk, the hk2 lesson in checkIfShouldSell);
  //   * or what the counters would take frees at least MARKET_ALONG_RELIEF of capacity, whatever
  //     the fullness -- twenty spare long swords are worth the two rooms from the bread shop.
  packWantsMarket() {
    const c = this.s.client;
    if (!c) return false;
    const cap = skills.carryCapacity(c);
    const frac = (v, max) => (max > 0 && Number.isFinite(v) ? v / max : 0);
    const fullness = cap?.known && cap.load
      ? Math.max(frac(cap.load.weight, cap.weight_max), frac(cap.load.bulk, cap.bulk_max)) : 0;
    const stacks = (c.inventory || []).length;
    const at = this.policy.sellAtLoad ?? SELL_AT_LOAD;
    const configured = Number(this.policy.marketAlongAt);
    const along = Number.isFinite(configured) && configured > 0 ? configured : Math.min(at, MARKET_ALONG_AT);
    const relief = typeof this.saleRelief === 'function' ? this.saleRelief(cap) : null;
    const freed = relief ? Math.max(0, fullness - relief.after) : null;
    if (freed != null && freed >= MARKET_ALONG_RELIEF) return true;
    const near = fullness >= along || stacks >= (this.policy.maxCarry ?? 14);
    // Unknown relief (no capacity or equipment read yet) keeps the old answer.
    return near && (freed == null || freed >= MARKET_ALONG_MIN_RELIEF);
  }

  checkIfShouldSell({ windowOpen = false } = {}) {
    const c = this.s.client;
    if (!c) return { sell: false, trigger: null, why: 'no client' };

    // An outside owner may replace the entire judgement.
    if (typeof this.policy.shouldSell === 'function') {
      const r = this.policy.shouldSell({ autopilot: this, client: c, windowOpen });
      if (r && typeof r === 'object') return { trigger: 'policy', ...r };
    }

    // A STANDING ORDER NOBODY HAS STARTED IS A REASON TO GO TO TOWN NOW. Operator,
    // 2026-09-25: "have anyone who can buy their next level of weaponcraft go take a town
    // trip". Without this an order waited for the pack to fill, which on a quiet station is
    // hours. It fires ONCE per order: `fundStandingOrder` writes a status on the trip, and a
    // status is what switches this off, so a character that cannot be funded does not lap.
    const order = this.standingOrderUnstarted();
    if (order)
      return { sell: true, trigger: 'standing_order', order: order.id,
               why: `standing order ${order.id}: ${orderSkills(order).join(', ')} from ${order.teacher}` };

    const inv = c.inventory || [];
    const stacks = inv.length;
    const carried = inv.filter(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''))
                       .reduce((t, o) => t + (o.amount || 1), 0);
    const banked = this.s.bankKnown?.()?.balance ?? 0;

    // FULL IS A WEIGHT, NOT A COUNT. Measured in one pass: eleven stacks at 4% of capacity
    // against six stacks at 87%. `weight_max = 1700 + might*20` (player.kod:10456); weight
    // and bulk share the formula and either can bind, so the fuller of the two decides.
    const cap = skills.carryCapacity(c);
    const frac = (v, max) => (max > 0 && Number.isFinite(v) ? v / max : 0);
    const fullness = cap?.known && cap.load
      ? Math.max(frac(cap.load.weight, cap.weight_max), frac(cap.load.bulk, cap.bulk_max)) : 0;
    // Protected or refused cargo may remain heavy after every counter. Give the
    // farmer a working interval rather than immediately repeating the same circuit.
    const saleCooling = Date.now() - (this.lastMarketServiceAt ?? 0) < 600_000;

    // An inexact load is a LOWER bound — carryCapacity withholds room_for rather than
    // guess. "Make room" is the safe reading; "there is room" is how items get deleted.
    if (!saleCooling && cap?.known && cap.load?.exact === false)
      return { sell: true, trigger: 'unweighable', unweighed: cap.load?.unweighed ?? null,
               why: 'the pack holds something not in the weight table, so its load is a ' +
                    'lower bound — treat that as make room, never as there is room' };

    // OVERFARM USURPS "THE PACK IS FULL" AS A REASON TO GO TO TOWN.
    //
    // Both triggers below are about a full pack, and being full is precisely the moment
    // overfarming BEGINS: from here the character keeps killing and trades the worst thing it
    // carries for a better one on the floor, until it has sifted its target. Letting load fire
    // here is what made the first version pointless -- it left for town at 85% and the
    // overfarm phase never ran at all.
    //
    // ONLY THESE TWO ARE DEFERRED. unweighable above is a safety rule about a load we cannot
    // read, and supply below is the character saying it can no longer work; neither waits.
    // That is also why purchaseRequests buys the scaled amount -- leaving town stocked for an
    // ordinary lap would just move the interruption rather than remove it.
    // HOLD FOR THE COURIER (operator, 2026-09-28: "Hunters in room 2 should strive to overeat and wait
    // for the courier to return"). A crew with a courier unloads to it at the stage room; when it is
    // away, the full hunter waits there — eating to 200 meanwhile — instead of walking its own load to
    // town. Only the load and stack triggers wait, exactly as overfarming's do: unweighable and supply
    // still leave, because those are the character saying it cannot work.
    const courierHold = this.policy.holdForCourier ? { courier: true } : null;
    const hold = this.overfarmHoldsTrip() ?? courierHold;
    const at = this.policy.sellAtLoad ?? SELL_AT_LOAD;
    if (hold?.courier && (fullness >= at || stacks >= (this.policy.maxCarry ?? 14)) &&
        Date.now() - (this._courierHoldNotedAt ?? 0) > 300_000) {
      this._courierHoldNotedAt = Date.now();
      this.note('pack full — waiting for the courier rather than walking to town', { fullness, stacks,
        why: 'holdForCourier: the crew unloads at the stage room, and a walk to town is 31% of its day' });
    }
    if (hold && !hold.courier && (fullness >= at || stacks >= (this.policy.maxCarry ?? 14)))
      this.note('overfarming - holding the town trip', { ...hold,
        why: 'the pack is full, which is when overfarming starts: keep killing and trade up ' +
             'until ' + hold.target_percent + '% of capacity has been sifted' });
    // A SELL TRIP HAS TO BE WORTH THE ROAD (operator, 2026-09-27: "$10k+ if their purpose is for
    // selling"). Below the value, a full-enough pack keeps farming until it is worth more or has
    // no room left at all (SELL_REGARDLESS_AT). The estimate is a floor — most items are unpriced
    // — so a pack of unpriced loot still goes when it is truly full.
    const worth = (fullness >= at || stacks >= (this.policy.maxCarry ?? 14)) ? this.packSaleValue() : null;
    const cheap = worth && worth.value < this.minSellTripValue() && fullness < SELL_REGARDLESS_AT;
    if (cheap && !hold && !saleCooling && Date.now() - (this._cheapTripNotedAt ?? 0) > 600_000 &&
        (this._cheapTripNotedAt = Date.now()))
      this.note('sell trip held: pack worth too little', {
        estimated_value: worth.value, min_sell_value: this.minSellTripValue(),
        unpriced_stacks: worth.unpriced, fullness: Number(fullness.toFixed(3)), stacks,
        why: `the pack would fetch about ${worth.value}, under the ${this.minSellTripValue()} a sell ` +
             `trip should carry; it goes when it is worth that or reaches ${Math.round(SELL_REGARDLESS_AT * 100)}%` });
    // A TRIP THAT CANNOT FIX THE THING THAT OPENED IT RUNS FOR EVER (CLAUDE.md). Both triggers
    // measure the WHOLE pack, and a courier's pack is mostly what it is told to keep — gems,
    // reagents, bread for the crew. 2026-09-28: hk2 at 97% with 10 stacks, every stack kept,
    // walked to Barloque to sell, died on the road seven times in ninety minutes and dropped the
    // guild's gems each time. So a trip opens only when what the counter WOULD sell (the same
    // inventorySalePlan the trip uses) brings the pack back under the trigger that fired.
    const loadDue = !saleCooling && fullness >= at && !hold && !cheap;
    const stacksDue = !saleCooling && stacks >= (this.policy.maxCarry ?? 14) && !hold && !cheap;
    const relief = (loadDue || stacksDue) ? this.saleRelief(cap) : null;
    if (relief && !((loadDue && relief.fixesLoad(at, fullness)) ||
                    (stacksDue && relief.fixesStacks(this.policy.maxCarry ?? 14, stacks)))) {
      if (Date.now() - (this._keepFullNotedAt ?? 0) > 600_000 && (this._keepFullNotedAt = Date.now()))
        this.note('sell trip held: the pack is full of what it keeps', {
          fullness: Number(fullness.toFixed(3)), stacks, after_sale: relief.summary,
          why: 'selling everything the counter would take still leaves the pack over the trigger — ' +
               'the rest is kept, protected or wanted by the guild, and a walk to town cannot move it' });
      return { sell: false, trigger: null, why: 'pack full of kept stock; a sell trip would not relieve it' };
    }
    if (loadDue && !hold)
      return { sell: true, trigger: 'load', fullness, estimated_value: worth?.value,
               why: `pack is ${Math.round(fullness * 100)}% of capacity` };
    if (stacksDue && !hold)
      return { sell: true, trigger: 'stacks', stacks, estimated_value: worth?.value,
               why: `${stacks} stacks, at the pack ceiling` };

    // RUNNING OUT IS A REASON TO GO. A PART-FULL PACK IS NOT.
    //
    // The two triggers above are both about the pack, and they were the only way a
    // character ever set off for a market — so "when do we stop farming" was answered
    // entirely by how much loot had piled up, which has nothing to do with whether the
    // character can still work. Fullness is already handled where it stands: makeRoom()
    // sells to any local buyer and otherwise drops the biggest pile of junk, keeping
    // money, gems and anything in use.
    //
    // Being out of elderberry and herbs is the fact that actually stops it. `create food`
    // is 2 + 2 from this pack and refuses SILENTLY without them, so an empty pair means no
    // food, and no food means vigor stops at the 80 that resting alone reaches — every
    // fight after that is fought tired, indefinitely, while the keeper reports itself
    // healthy. Measured on this fleet with only the pack triggers live: twenty-one of
    // twenty-one below their reagent floor and NOT ONE on a town errand.
    //
    // THE FLOOR IS THE LOADOUT'S, not a constant here. A caster that burns forty a day and
    // a fighter that burns none should not be sent on the same errand, which is the whole
    // argument for loadouts; `wantsOf` already answers "what is this character short of"
    // against its own floors. With no loadout there is no floor and this trigger stays
    // quiet — silence means the behaviour that was already there, never a new opinion.
    const supply = this.supplyShortfall();
    if (supply.short)
      return { sell: true, trigger: 'supply', missing: supply.missing,
               reagents: supply.reagents, meals: supply.meals,
               why: `out of ${supply.missing.join(' and ')} — cannot make food, so vigor is ` +
                    `capped at what resting gives` };

    // BEING BROKE IS NEVER A REASON TO SELL (operator, 2026-10-06: "we never want to sell because
    // we're broke"). The `broke` trigger that stood here (sell_when_broke, off by default since the
    // fleet-wide stampede it caused) is removed; the setting is still ACCEPTED so doctrines that send
    // it keep working, and `true` is overridden to false with a warning (m59-broker.mjs). A pack is
    // sold because it is heavy, never because its carrier is poor.
    return { sell: false, trigger: null, fullness,
             why: windowOpen && fullness < at
               ? `${Math.round(fullness * 100)}% loaded and the window is open — the shift is worth more`
               : `${Math.round(fullness * 100)}% loaded, nothing to do` };
  }

  itemValue(name, amount = 1) {
    return (Number(ITEM_VALUE[String(name || '').toLowerCase()]) || 0) * Math.max(1, Number(amount) || 1);
  }

  // A SELLER IS ALREADY PAYING FOR THE WALK HOME. Spend a bounded moment making that
  // one pack the best return from the room: known dead gear leaves first, protected
  // collection stock boards first, and the remaining attempts are ranked by merchant
  // value with sound gear ahead of ordinary stock. Partial wear is server-private; we
  // never invent it. inspectForBroken and lootFloor ask the server for the condition.
  async farmCleanupBeforeSale() {
    const cfg = this.policy.farmCleanup;
    if (!cfg?.enabled) return null;
    const s = this.s, c = s.need();
    const run = { room: s.world?.room?.num ?? null, room_name: s.world?.room?.name ?? null,
      dropped: [], picked: [], refused: [], protected: [], value: 0 };
    this.coordination.cleanup.runs++;

    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
    const worn = skills.equippedNow(c) ?? new Set();
    const spareGear = (c.inventory || []).filter(o => !worn.has(o.id) &&
      (skills.weaponScore(c.rsc.get(o.nameRsc) || '') > 0 || skills.armourKind(c.rsc.get(o.nameRsc) || '')));
    if (spareGear.length) await skills.inspectForBroken(s, spareGear.map(o => o.id)).catch(() => null);
    const dropAttempts = [];
    for (const dead of skills.junkAndBroken(c).filter(item => !worn.has(item.o?.id ?? item.id))) {
      const id = dead.o?.id ?? dead.id;
      const item = (c.inventory || []).find(o => o.id === id);
      if (!item) continue;
      await s.pacer.submit('drop', () => c.drop([this.dropSpec(item)])).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 900));
      dropAttempts.push({ id, name: dead.name, why: dead.why });
    }
    if (dropAttempts.length) {
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
      const stillHere = new Set((c.inventory || []).map(item => item.id));
      run.dropped = dropAttempts.filter(item => !stillHere.has(item.id))
        .map(({ name, why }) => ({ name, why }));
      run.refused.push(...dropAttempts.filter(item => stillHere.has(item.id))
        .map(item => ({ name: item.name, why: 'server did not remove the requested dead gear from the pack' })));
    }

    await s.pacer.submit('read', () => c.roomContents()).catch(() => {});
    await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 }).catch(() => {});
    const protectedNames = this.protectedItemNames();
    const candidates = [...(c.room?.objects?.values?.() ?? [])]
      .filter(o => o.id !== c.selfId && (o.flags & OF.GETTABLE))
      .map(o => { const name = c.rsc.get(o.nameRsc) || '';
        const protectedItem = skills.itemIsProtected(name, protectedNames);
        const gear = skills.weaponScore(name) > 0 || !!skills.armourKind(name);
        return { o, name, amount: o.amount || 1, protectedItem, gear,
          value: this.itemValue(name, o.amount || 1) }; })
      .sort((a, b) => Number(b.protectedItem) - Number(a.protectedItem) ||
        Number(b.gear) - Number(a.gear) || b.value - a.value);
    const max = Math.max(1, Math.min(40, Number(cfg.max_floor_items) || 12));
    const configuredRoom = Math.max(0, (this.policy.maxCarry ?? 14) -
      (c.inventory?.length ?? 0) - Math.max(0, Number(cfg.keep_free_stacks) || 0));
    const attempt = candidates.slice(0, Math.min(max, Math.max(0, configuredRoom)));
    const protectedIds = attempt.filter(row => row.protectedItem).map(row => row.o.id);
    const ordinaryIds = attempt.filter(row => !row.protectedItem).map(row => row.o.id);
    const take = async ids => ids.length
      ? s.lootFloor({ ids, maxItems: ids.length, explicitIdsOverride: false })
          .catch(error => ({ taken: [], refused: [{ why: error.message }] }))
      : { taken: [], refused: [] };
    const first = await take(protectedIds);
    const second = await take(ordinaryIds);
    run.picked = [...(first.taken || []), ...(second.taken || [])];
    run.refused.push(...(first.refused || []), ...(second.refused || []));
    run.protected = run.picked.filter(item => skills.itemIsProtected(item.name, protectedNames));
    run.value = run.picked.reduce((sum, item) => sum + this.itemValue(item.name, item.amount || 1), 0);
    this.coordination.cleanup.dropped += run.dropped.length;
    this.coordination.cleanup.picked += run.picked.reduce((sum, item) => sum + (item.amount || 1), 0);
    this.coordination.cleanup.picked_value += run.value;
    this.coordination.cleanup.protected_picked += run.protected.reduce((sum, item) => sum + (item.amount || 1), 0);
    this.coordination.cleanup.refused += run.refused.length;
    this.detailEvent('farm_cleanup', 'run', run);
    this.note('cleaned the farm before the sell trip', {
      dropped: run.dropped, picked: run.picked, estimated_value: run.value,
      protected_picked: run.protected, refused: run.refused.length });
    return run;
  }
  // @end 1
}
