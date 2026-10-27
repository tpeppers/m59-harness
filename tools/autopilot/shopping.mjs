// SHOPPING AND THE BANK RUN.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 14 methods: poorVigorFloor, poorFarmingActive, poorShoppingRetryReady, deferUnaffordableShopping,
//   purchaseRequests, purchaseFoodGap, shoppingPlan, saleRelief, postShoppingPlan,
//   ensurePurchaseFunds, bankRun, walkingFloat, bankAboveNow, purseLeaseStatus
import { readBankerLine } from '../m59-bank.mjs';
import { guildPlan } from '../m59-guildwants.mjs';
import { MARKET_KEEP, isFood, weighPack } from '../m59-items.mjs';
import { bankAboveOf, leaseCarry, walkingFloatOf } from '../m59-purse-lease.mjs';
import { norm } from '../m59-loadout.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { PURCHASE_BANKS, accountBalance, purchaseKey, purchasePlan } from '../m59-purchase-plan.mjs';
import { runReagentCoop } from '../m59-reagent-coop-runtime.mjs';
import * as skills from '../m59-skills.mjs';
import { BANKS, FOOD_SHOP, ITEM_VALUE, MARKET_STOPS, REST_VIGOR_CAP, TITHE_FLEET, VIGOR_CAP, hungerNeedsTown, purchaseEnabled, reagentTargetFor, splitBySourcing, townDestinations } from '../m59-autopilot.mjs';

export class ShoppingPart {
  // @part 1

  poorVigorFloor() {
    const value = Number(this.policy.noFoodVigorFloor ?? 70);
    return Number.isFinite(value) ? Math.min(80, Math.max(0, value)) : 70;
  }

  poorFarmingActive() {
    if (!this.poorSupply || this.policy.poorFarming === false) return false;
    // A new purse or bank receipt can reopen shopping without waiting for the retry timer.
    const bank = accountBalance(this.s.bankKnown?.(), this.poorSupply.account);
    const available = this.purseNow() + (bank ?? this.poorSupply.banked ?? 0);
    return available < this.poorSupply.required_purse;
  }

  poorShoppingRetryReady() {
    if (!this.poorFarmingActive()) return true;
    // A timer alone must not recall a penniless farmer halfway home. Recheck an
    // unchanged balance only when a bank is already here; new sufficient funds
    // reopen the saved shopping task from anywhere.
    return Date.now() >= this.poorSupply.retry_at &&
      PURCHASE_BANKS.some(bank => bank.room === this.s.world?.room?.num);
  }

  deferUnaffordableShopping(plan, bank, balance) {
    this.poorSupply = { since: Date.now(), account: bank.account, banked: balance,
      required_purse: plan.required_purse, retry_at: Date.now() + (this.policy.poorSupplyRetryMs ?? 300000) };
    this.purchaseFunding = { ...this.purchaseFunding, pending: false,
      status: 'unaffordable — returning to farming', available_banked: balance };
    if (this.townTrip) {
      this.deferredShoppingTrip = this.townTrip;
      this.townTrip = null;
    }
    this.note('supplies unaffordable — continue farming', {
      required_purse: plan.required_purse, purse: this.purseNow(), banked: balance,
      assigned_room: this.policy.assignedRoom ?? null, vigor_floor: this.poorVigorFloor() });
    return { ready: false, pending: false, unaffordable: true };
  }

  purchaseRequests() {
    // STOCK FOR THE LAP YOU ARE ACTUALLY GOING TO FARM.
    //
    // A loadout is sized for an ordinary lap: fill the pack, go to town. An overfarming
    // character farms overfarm_percent as long before it next sees a merchant, so it burns
    // that much more of everything it consumes. Buying the ordinary amount sends it out
    // under-stocked, the supply trigger fires mid-lap, and it goes to town anyway -- which
    // MOVES the interruption instead of removing it, while fewer trips is the entire point.
    //
    // The shortfall TRIGGER is deliberately not scaled: that one fires at the real floor and
    // means "cannot work", which is true whatever the plan was. This scales what to BUY.
    const scale = this.overfarmScale();
    const upto = n => Math.max(0, Math.ceil((Number(n) || 0) * scale));
    const have = this.reagentCount();
    const requests = new Map([
      ['elderberry', Math.max(0, upto(reagentTargetFor('elderberry', this.policy.reagentTarget)) - have.elderberry)],
      ['herb', Math.max(0, upto(reagentTargetFor('herb', this.policy.reagentTarget)) - have.herbs)],
    ]);
    const pack = this.packAsItems();
    for (const entry of this.loadout()?.carry ?? []) {
      if (!(entry.min > 0)) continue;
      const held = pack.filter(i => purchaseKey(i.name) === purchaseKey(entry.item))
        .reduce((n, i) => n + i.amount, 0);
      // The ceiling scales with the floor, or a max written for an ordinary lap caps the
      // extra straight back off. A loadout that declares no max keeps using its min.
      const target = upto(Math.max(entry.min, Number(entry.max) || 0));
      requests.set(purchaseKey(entry.item), held < upto(entry.min) ? target - held : 0);
    }
    return [...requests].filter(([, amount]) => amount > 0).map(([item, amount]) => ({ item, amount }));
  }

  purchaseFoodGap() {
    const c = this.s.client, v = c.vitals?.()?.vigor;
    const food = this.larder(c).reduce((n, f) => n + f.food.nutrition * (f.o.amount || 1), 0);
    const max = v?.scale_max ?? 200;
    return Math.max(0, food === 0 ? (this.policy.fightAboveVigor ?? 140) - REST_VIGOR_CAP * max : 0,
      (this.policy.vigorWant ?? 0.9) * max - (v?.value ?? max) - food);
  }

  shoppingPlan({ kind = 'all', items = null } = {}) {
    // A FOOD CARRY FLOOR IS A FOOD LINE, NOT A REAGENT ONE. purchaseRequests() lists every loadout
    // floor, and they all used to ride the reagent gate and the guild-plan sourcing below — so a
    // courier with reagent buying off (or bread chest-sourced) walked to a bread shop on its bread
    // floor, dropped the bread line, and bought its own supper instead: cheapest vigor per
    // shilling, apples (2026-09-28: two trips, ~22 apples, 0 bread, against a floor of 30).
    const all = ['all', 'reagents', 'restock', 'food'].includes(kind) ? this.purchaseRequests() : [];
    const foodLines = purchaseEnabled(this.policy, 'food') && ['all', 'food', 'restock'].includes(kind)
      ? all.filter(r => isFood(r.item)) : [];
    let requests = purchaseEnabled(this.policy, 'reagents') && ['all', 'reagents', 'restock'].includes(kind)
      ? all.filter(r => !isFood(r.item)) : [];
    // The stockpile is the only source for these, so they never reach a price. Removed here
    // rather than at the counter: a merchant refusal is a sentence spoken to the room, and an
    // unaffordable TOTAL is what opens the loop this exists to close.
    const split = splitBySourcing(requests, { policy: this.policy, plan: guildPlan() });
    requests = [...split.buy, ...foodLines];
    this.chestOnlyWants = split.stockpile;
    this.reagentsOff = split.off;
    if (purchaseEnabled(this.policy, 'reagents') && ['all', 'delivery'].includes(kind)
        && this.policy.farmDelivery?.enabled && this.pendingFarmDelivery) {
      const wanted = this.pendingFarmDelivery.requested;
      const spare = this.deliverableSpare(Object.keys(wanted));
      for (const [item, amount] of Object.entries(wanted))
        if (amount > (spare[item] || 0)) requests.push({ item, amount: amount - (spare[item] || 0) });
    }
    const foodGap = purchaseEnabled(this.policy, 'food') && ['all', 'food', 'restock'].includes(kind)
      ? this.purchaseFoodGap() : 0;
    const defaults = { elderberry: 28, herb: 14, 'loaf of bread': 108 };
    const menu = items ?? [...new Set([...requests.map(r => r.item), 'loaf of bread'])].map(name => {
      const key = purchaseKey(name);
      const value = ITEM_VALUE[norm(name)] ?? ITEM_VALUE[key];
      return { name, cost: this.purchasePrices?.get(key) ?? defaults[key]
        ?? (value > 0 ? Math.ceil(value * 2) : null) };
    });
    return purchasePlan({ requests, menu, foodGap, estimated: items == null,
      reserve: requests.length || foodGap > 0 ? Math.max(0, this.policy.shopFloor ?? 0,
        ['all', 'delivery'].includes(kind) && this.pendingFarmDelivery ? this.walkingFloat() : 0) : 0 });
  }

  /**
   * What a market visit could take off this pack: the counter's own sale plan, weighed. Null when
   * the plan cannot say (equipment unknown, intent unreadable, no weights) — the caller then goes
   * to town as it always did, because "I cannot tell" is not "there is nothing to sell".
   */
  saleRelief(cap = skills.carryCapacity(this.s.client)) {
    try {
      if (!cap?.known || !cap.load) return null;
      // Unknown equipment blocks every line of the plan, which would read as "nothing to sell".
      if (!skills.equippedNow(this.s.client)) return null;
      const plan = skills.inventorySalePlan(this.s, { keep: MARKET_KEEP, protect: this.protectedItemNames(),
        loadout: this.loadout(), maxWeapons: this.policy.maxWeapons, weaponPriority: this.weaponPriorityNow() });
      if (plan?.error) return null;
      const sold = (plan?.items ?? []).filter(i => i.state === 'sell' && i.sale_amount > 0);
      const w = weighPack(sold.map(i => ({ name: i.name, amount: i.sale_amount })));
      const freedStacks = sold.filter(i => i.sale_amount >= (i.amount || 1)).length;
      const frac = (v, max) => (max > 0 && Number.isFinite(v) ? v / max : 0);
      const after = Math.max(frac(cap.load.weight - (w?.weight ?? 0), cap.weight_max),
                             frac(cap.load.bulk - (w?.bulk ?? 0), cap.bulk_max));
      const stacksAfter = (this.s.client?.inventory?.length ?? 0) - freedStacks;
      return {
        after, stacksAfter,
        // Under the trigger, or at least a quarter of the pack's capacity freed: a trip that
        // takes a hunter from 97% to 75% is still worth the road.
        fixesLoad: (at, now = 1) => after < at || now - after >= 0.25,
        fixesStacks: (max, now = Infinity) => stacksAfter < max || now - stacksAfter >= 5,
        summary: { fullness: Number(after.toFixed(3)), stacks: stacksAfter, sellable_stacks: sold.length },
      };
    } catch { return null; }
  }

  postShoppingPlan(plan) {
    const purse = this.purseNow();
    const signature = JSON.stringify([plan.lines, plan.reserve, plan.unpriced, plan.estimated]);
    this.purchaseFunding = { ...plan, purse, shortfall: Math.max(0, plan.required_purse - purse),
      pending: plan.lines.length > 0 || plan.unpriced.length > 0,
      status: purse >= plan.required_purse ? 'funded' : 'bank required',
      // A LINE THAT VANISHES SILENTLY IS INDISTINGUISHABLE FROM ONE NOBODY WANTED. If the plan
      // is smaller because the guild chest owns these, the reader has to be able to see that.
      ...(this.chestOnlyWants?.length
        ? { from_stockpile: this.chestOnlyWants,
            from_stockpile_why: 'not bought by policy — these come from the guild chest, a vault, ' +
                                'or a kill: the guild plan reagents block, or policy.reagentSource' }
        : {}) };
    if (this.townTrip) this.townTrip.purchasePlan = plan;
    if (signature !== this.lastPurchasePlanSignature) {
      this.lastPurchasePlanSignature = signature;
      this.note('shopping cost posted', this.purchaseFunding);
    }
    return this.purchaseFunding;
  }

  async ensurePurchaseFunds(plan = this.shoppingPlan()) {
    const s = this.s, c = s.need();
    const pending = reason => {
      this.purchaseFunding = { ...this.purchaseFunding, status: reason, pending: true };
      if (this.townTrip) this.townTrip.nextTryAt = Date.now() + 5000;
      return { ready: false, pending: true, reason };
    };
    this.postShoppingPlan(plan);
    if (this.policy.reagentCoop?.enabled) {
      const supplied = await runReagentCoop(this, 'supply', { plan }, TITHE_FLEET);
      if (supplied.pending) return pending(supplied.reason);
      plan = supplied.plan ?? plan;
      this.postShoppingPlan(plan);
      // The inventory and merchant IDs may have changed during the visit.
      // Let the caller rebuild its quote before spending private/shared money.
      if (supplied.moved) return { ready: false, pending: true, moved: true };
    }
    if (this.poorFarmingActive() && !this.poorShoppingRetryReady()) {
      if (this.townTrip) { this.deferredShoppingTrip = this.townTrip; this.townTrip = null; }
      this.purchaseFunding.pending = false;
      this.purchaseFunding.status = 'unaffordable — returning to farming';
      return { ready: false, pending: false, unaffordable: true };
    }
    if (this.travelInterrupted() || this.suspendedJourney) return pending('paused for survival');
    const inventoryBefore = c.evSeq;
    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ since: inventoryBefore, kinds: ['inventory'], timeoutMs: 3000 });
    const funding = this.postShoppingPlan(plan);
    if (this.travelInterrupted() || this.suspendedJourney) return pending('paused for survival');
    if (!funding.shortfall) {
      if (!this.poorFarmingActive()) this.poorSupply = null;
      return { ready: true, moved: false };
    }
    const known = s.bankKnown?.() ?? null;
    const options = PURCHASE_BANKS.filter(b => !this.bansDestination(b.room)).map(b => {
      const here = Number(s.world?.room?.num) === b.room;
      const route = here ? { found: true, hops: [] } : s.world?.route?.(b.room);
      return { ...b, hops: route?.found ? route.hops.length : Infinity,
        balance: accountBalance(known, b.account) };
    }).filter(b => Number.isFinite(b.hops) && b.hops <= 30)
      // A known funded account is useful. An unknown account is not evidence of
      // funds and must not pull a mainland shopper all the way to Ko'catan.
      .sort((a, b) => Number(b.balance >= funding.shortfall)
        - Number(a.balance >= funding.shortfall) || a.hops - b.hops);
    const bank = options[0];
    if (!bank) return pending('no reachable bank for purchase funding');
    this.purchaseFunding.bank = { room: bank.room, account: bank.account };
    const moved = Number(s.world?.room?.num) !== bank.room;
    if (moved) {
      this.note('bank withdrawal is required before shopping', {
        expected_cost: plan.expected_cost, reserve: plan.reserve, purse: funding.purse,
        shortfall: funding.shortfall, bank: bank.room, account: bank.account });
      const r = await this.travel(bank.room, { origin: keeperOrigin('purchase_funds'), maxHops: 30 });
      if (!r?.arrived || Number(s.world?.room?.num) !== bank.room)
        return pending(r?.reason ?? 'bank journey still pending');
    }
    if (this.travelInterrupted() || this.suspendedJourney) return pending('paused for survival');
    // Ask THIS account now; a cached balance from another island cannot fund this purchase.
    const before = c.evSeq;
    await s.pacer.submit('bank', () => c.balance());
    const reply = await c.waitFor({ since: before, kinds: ['message'], timeoutMs: 3000 });
    const balance = (reply.events ?? []).map(e => readBankerLine(e.text))
      .find(r => r?.observed && r.balance != null)?.balance;
    if (balance == null) return pending('waiting for a confirmed bank balance');
    if (Number(s.world?.room?.num) !== bank.room) return pending('left the bank before withdrawal');
    const gap = Math.max(0, plan.required_purse - this.purseNow());
    if (!gap) return { ready: true, moved };
    if (balance < gap) {
      this.purchaseFunding.available_banked = balance;
      if (this.policy.poorFarming !== false)
        return this.deferUnaffordableShopping(plan, bank, balance);
      return pending('insufficient bank funds for the posted purchase');
    }
    if (this.travelInterrupted() || this.suspendedJourney) return pending('paused for survival');
    const withdrawBefore = c.evSeq;
    const purseBeforeWithdraw = this.purseNow();
    await s.pacer.submit('bank', () => c.withdraw(gap));
    await c.waitFor({ since: withdrawBefore, kinds: ['message'], timeoutMs: 3000 });
    const refreshBefore = c.evSeq;
    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ since: refreshBefore, kinds: ['inventory'], timeoutMs: 3000 });
    // WHAT CAME OUT OF THE BANK, read off the purse rather than the amount asked for.
    const drewFromBank = this.purseNow() - purseBeforeWithdraw;
    if (drewFromBank > 0) this.tradeFact({ bank_withdrawn: drewFromBank });
    const now = this.postShoppingPlan(plan);
    this.note('purchase funding checked after withdrawal', {
      asked_for: gap, purse: now.purse, required_purse: plan.required_purse,
      funded: now.shortfall === 0, account: bank.account });
    if (now.shortfall) return pending('withdrawal did not fund the purchase');
    this.poorSupply = null;
    return { ready: true, moved };
  }

  async bankRun() {
    if (this.townTrip) return this.continueTownTrip();
    // DROPPED MEANS DROPPED (m59-town-favors.mjs): no resumed trip and no new one while the hold lasts.
    if (this.townTripHeld()) return false;
    // ASKED FOR, by the operator or a `townTrip` strategy: open it now, past the thresholds below.
    await this.askTownStrategy().catch(() => null);
    if (this.operatorTripRequest) return this.openRequestedTownTrip();
    // NO TOWN TRIPS OF ITS OWN (policy.townTrips === false). Operator, 2026-10-06: "Set Raphael to not
    // do any town trips, selling, etc., we want him to be locked in room 2 if I'm not logged in on him
    // for now." The thresholds below each have their own number and none of them means "never"; the
    // town-trip hold (m59-town-favors.mjs) does, but it lives in this process and is gone at the next
    // keeper restart. This is the roster's answer. An operator's or a strategy's request, above, still opens.
    if (this.policy.townTrips === false) { this.deferredShoppingTrip = null; return false; }
    // A hunger trip parked as unaffordable is dropped, not resumed, once food is no reason to go.
    if (this.deferredShoppingTrip?.purpose === 'food' && !hungerNeedsTown(this.wantedFightFloor(),
          this.s.client?.vitals?.()?.vigor?.scale_max ?? VIGOR_CAP))
      this.deferredShoppingTrip = null;
    if (this.deferredShoppingTrip && this.poorShoppingRetryReady()) {
      this.townTrip = this.deferredShoppingTrip;
      this.deferredShoppingTrip = null;
      this.townTrip.nextTryAt = 0;
      this.townTrip.purchasePlan = this.shoppingPlan();
      return this.continueTownTrip();
    }
    const above = this.bankAboveNow();
    if (!above) return false;                       // 0 or null turns the trips off
    const s = this.s, c = s.need();
    const room = s.world?.room;
    if (!room || BANKS.some(b => b.room === room.num)) return false;   // already there
    // Wait for the reply, not just the request. Reading c.inventory straight after
    // submitting reads the PREVIOUS snapshot, which is the whole family of bugs this
    // file keeps re-learning.
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
    const carried = (c.inventory || [])
      .filter(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''))
      .reduce((t, o) => t + (o.amount || 1), 0);
    // A FULL PACK IS ALSO A REASON TO GO TO TOWN, AND WITHOUT IT THE LOOP CANNOT START.
    //
    // The trip fired on money alone: carry more than bankAbove and go and deposit it.
    // But the money comes from SELLING, selling happens in town, and the fleet had no
    // way to get there — twenty-one characters sat between 0 and 491 shillings against
    // a threshold of 500, hauling 1,864 units of mushroom, gem and tooth they could not
    // convert. Rich enough to bank was the only door, and it was the door on the far
    // side of the thing they needed to do.
    //
    // So a pack at or over its cap opens the same trip. The walk pays for itself the
    // moment the goods are sold, which is the whole point of going.
    // FULL IS A WEIGHT, NOT A COUNT OF STACKS, AND THE TWO DISAGREE COMPLETELY.
    //
    // Measured across the fleet in one pass: Kermit held ELEVEN stacks at 99 of 2400 —
    // four per cent loaded — while Statler held SIX at 2084 of 2400, nearly full. Counting
    // stacks sent the empty character to market and left the loaded one in the field, which
    // is exactly backwards, and it is why the fleet was seen queueing at Roq with almost
    // nothing to sell.
    //
    // The server gives the real numbers: `weight_max = 1700 + might * 20` (player.kod:10456)
    // and an exact `load`, both weight and bulk. Either can bind, so the fuller of the two
    // decides. The stack cap is kept as a ceiling — the pack does hold about fourteen — but
    // it is now the second test rather than the only one.
    const stacks = (c.inventory || []).length;
    const cap = this.policy.maxCarry ?? 14;
    // `carryCapacity` is the one place that knows the formula, and it REFUSES to guess:
    // when an item is not in the weight table the load it returns is a lower bound and
    // `room_for` comes back null. Reading it as "there is room" is the failure direction,
    // so an inexact load is treated as a reason to go and sell rather than a reason to
    // carry on — the same rule that file states for making room.
    // ONE DEFINITION, ASKED HERE. `checkIfShouldSell` above owns both the thresholds and
    // the override seam; duplicating the arithmetic at the call site is how a quantity in
    // this repository ends up with two answers.
    const sellCall = this.checkIfShouldSell();
    // A SUPPLY SHORTFALL IS NOT A FULL PACK, AND SENDING IT TO A MARKET IS THE SAME
    // MISTAKE AS SENDING A FULL PACK TO A BANKER — THE ONE THIS FUNCTION ALREADY RECORDS.
    //
    // `supply` was added to checkIfShouldSell long after bankRun learned to read that
    // function's answer as "the pack is full", and the two triggers have OPPOSITE
    // remedies. A full pack becomes money the moment it reaches Roq, which is why the
    // cooldown note below says this trip "cannot spin, because it always achieves
    // something". A reagent shortfall becomes nothing at all there: it is fixed by BUYING,
    // and the money for that is usually in a bank.
    //
    // Measured on the live fleet, 2026-08-16: Fozzie held 2 shillings against a bank
    // balance of 27,282 and made the 110 -> 104 round trip every thirty-five seconds for
    // more than five hours — 155 `buy_declined` in one day, every one of them reading
    // `spendable: 2` — with 0 kills in the last half hour and its purse never once above
    // 13. Twelve of twenty-one characters were in the same loop, while the fleet sat on
    // 666,540 banked shillings. Nothing errored, nothing stalled, and the board said
    // "travelling", which is what it always says.
    //
    // So the trigger is separated here and routed like hunger already is: the character is
    // not poor, it is ILLIQUID, and `needsCashFirst` is the door that was built for
    // exactly that and never wired to this trigger.
    const poor = this.poorFarmingActive();
    const supplyShort = !poor && sellCall.sell && sellCall.trigger === 'supply';
    const packFull = sellCall.sell && sellCall.trigger !== 'supply';

    // AND AN EMPTY LARDER IS THE THIRD REASON, FOR EXACTLY THE REASON THE PACK WAS THE
    // SECOND: the food is in town and the only doors to town were money and a full pack.
    //
    // Everything needed to buy food already worked. restockReagents ranks a shop's menu by
    // vigor per shilling and buys until the gap closes; buyFoodInTown walks the last hop to
    // 103. Neither ever ran, because both hang off the end of a bank trip and the trip
    // needs 500 shillings or fourteen stacks to start. The fleet settles at a 400-shilling
    // walking float and six to twelve stacks, so neither door opens: measured this pass,
    // THREE of twenty-one keepers had any spending recorded at all, while thirteen of
    // twenty-one carried no food. The buying was never the problem; the arriving was.
    //
    // Casting is the cheaper route and stays the first one — but it needs 2 elderberry and
    // 2 herbs in the same pack, and this fleet's reagents segregate by which room each
    // character farms. Five passes running, the almoner has redistributed them and they
    // have re-separated by the next. So the test is "no food AND no way to make any",
    // which is precisely the state a shop fixes and nothing else in the field does.
    //
    // A hunger trip aims at the BREAD SHOP, not a bank. Sending it to a counter that sells
    // no food is the same mistake as aiming a full pack at a banker — the one this file
    // already records as leaving Camilla and Floyd standing at Jasper with sixteen stacks
    // and nobody who would pay for any of it.
    const reag = this.reagentCount();
    const canCook = this.foodCookingAllowed?.() !== false && reag.elderberry >= 2 && reag.herbs >= 2;
    // ENOUGH TO BUY SOMETHING AFTER THE FLOAT IS TAKEN OUT, AND NOT MORE OFTEN THAN THE
    // SHELF CAN CHANGE.
    //
    // The first version of this asked only for 60 shillings, reasoning that the cheapest
    // thing on that shelf is an apple at 45. That ignored the float: restockReagents keeps
    // `hungryFloor` (100) back for the walk home and spends only what is above it, so a
    // character holding 108 arrives with a budget of 8, buys nothing, walks back still
    // starving, and sets off again on the very next pass. It is a closed loop with a walk
    // across the world in it, and it ran: FIVE characters logged one town trip per keeper
    // pass — t13 made 386 trips in 386 passes — until this was capped. The whole fleet's
    // time went into it and the board still said "travelling", which is what it always
    // says.
    //
    // So the test is what will be SPENDABLE on arrival, not what is in the purse, plus a
    // cooldown so a shelf that had nothing affordable is not re-checked every eight
    // seconds. Selling is what fixes a poor character, and the pack-full door already
    // takes it to a market to do that.
    const spendable = carried - (this.policy.hungryFloor ?? 100);
    const FOOD_TRIP_COOLDOWN_MS = 300_000;
    const triedRecently = Date.now() - (this.foodTripAt ?? 0) < FOOD_TRIP_COOLDOWN_MS;
    // A BALANCE IS ALSO MONEY, PROVIDED SOMETHING GOES AND FETCHES IT.
    //
    // Requiring 60 spendable in HAND made the door useless to exactly the characters that
    // needed it: eight of the eleven with no food and no way to cook were carrying 104-115
    // against a 100 float, while holding thousands in the bank. They are not poor, they are
    // illiquid — and withdrawForFood() is now the thing that fixes that, at a counter.
    const balance = s.bankKnown?.()?.balance ?? 0;
    const canFetch = balance >= 200;
    // ...and only when food is what stands between this character and its fight floor. See
    // hungerNeedsTown: a floor resting reaches makes an empty larder no reason to travel.
    const needsFood = hungerNeedsTown(this.wantedFightFloor(),
                                      c.vitals?.()?.vigor?.scale_max ?? VIGOR_CAP);
    const starving = !poor && needsFood && purchaseEnabled(this.policy, 'food') &&
                     !this.larder(c).length && !canCook &&
                     (spendable >= 60 || canFetch) && !triedRecently;
    // AND THE SAME QUESTION FOR REAGENTS, WHICH IS THE ONE NOBODY ASKED.
    //
    // The bill is what this character's own floors are short of at counter prices, so it
    // is the loadout's number rather than a constant — a caster wanting 200 of each and a
    // fighter wanting six are not on the same errand. `withdrawForFood` sizes its draw from
    // the identical call, so the trip and the withdrawal cannot disagree about what it
    // costs.
    //
    // A COOLDOWN AS WELL AS A DESTINATION, because the destination fix assumes there is a
    // balance to fetch. With an empty bank too, the shortfall is real and unfixable this
    // hour, and the character should be farming rather than walking — the trip is bounded
    // instead of being tried again on the very next pass. Ten minutes, matching the sell
    // trip, because both answer "this walk achieved nothing; do not repeat it immediately".
    const supplyBill = supplyShort ? this.reagentGapCost() : 0;
    const SUPPLY_TRIP_COOLDOWN_MS = 600_000;
    const supplyTriedRecently = Date.now() - (this.supplyTripAt ?? 0) < SUPPLY_TRIP_COOLDOWN_MS;
    const supplyTrip = supplyShort && !supplyTriedRecently;
    // Which counter first. With money in hand the bread shop is the whole trip; without
    // it, the bank comes first and buyFoodInTown walks the last hop afterwards.
    const needsCashFirst = (starving && spendable < 60 && canFetch) ||
                           (supplyTrip && carried < supplyBill && canFetch);

    // NO "BROKE WITH GOODS" DOOR: being broke never opens a sell trip (operator, 2026-10-06; see
    // checkIfShouldSell). A heavy pack is the only reason to go and sell.
    if (poor && !packFull) return false;
    if (starving && !this.notedStarving) {
      this.notedStarving = true;
      this.note('out of food and cannot cook — going to town for some', {
        purse: carried, reagents: reag, to: FOOD_SHOP.name,
        why: 'resting stops at 80 vigor and everything above it has to be eaten; with no ' +
             'food and not both reagents, a shop is the only source in reach' });
    }
    if (!starving) this.notedStarving = false;

    if (carried <= above && !packFull && !starving && !supplyTrip) {
      // Say what we saw, occasionally. A threshold that never trips is indistinguishable
      // from one that is never checked, and that cost an eight-minute run to find out.
      if (carried > 0 && (!this.notedPurse || Date.now() - this.notedPurse > 120_000)) {
        this.notedPurse = Date.now();
        this.note('carrying, but under the banking threshold', { carrying: carried, banks_at: above, stacks, pack_cap: cap });
      }
      return false;
    }

    // Jasper and Tos share one account, so the only question is which is nearer.
    // world.route() returns {found, hops:[...]}, NOT an array — taking .length off it
    // gives undefined, every bank scores Infinity, and the character stands in a field
    // with 5,840 shillings reporting that it cannot reach a bank seven hops away.
    // A FULL PACK GOES TO THE MARKET; MONEY GOES TO THE BANK. Aiming a pack-driven trip
    // at a bank is what left Camilla and Floyd standing at the Jasper counter with
    // sixteen stacks each and nobody there who would pay for any of it — the banker
    // being the one NPC that takes goods and gives nothing back.
    // A full pack goes to the market, money goes to the bank, and an empty larder goes to
    // the bread shop — but only when hunger is the ONLY reason. A character that is also
    // rich or also full has business at the counter that pays, and buyFoodInTown runs at
    // the end of that trip anyway, so it gets both out of one walk.
    const destinations = townDestinations({ needsCashFirst, supplyTrip, starving, packFull,
                                            richEnoughToBank: carried > above })
      .filter(b => !this.bansDestination(b.room));
    if (!destinations.length) {
      if (!this.warnedBannedTrip) {
        this.warnedBannedTrip = true;
        this.note('not making this trip — every destination for it is banned for this character', {
          banned: this.policy.bannedDestinations, carrying: carried, stacks,
          why: 'banned_destinations struck every counter this errand could use; the errand is dropped ' +
               'rather than routed to a room the operator said not to enter',
        });
      }
      return false;
    }
    this.warnedBannedTrip = false;
    const options = destinations
      .map(b => { const r = s.world?.route?.(b.room);
                  return { ...b, hops: r?.found ? r.hops.length : Infinity }; })
      .sort((x, y) => x.hops - y.hops);
    const target = options[0];
    if (!Number.isFinite(target.hops)) {
      if (!this.warnedNoBank) {
        this.warnedNoBank = true;
        this.note("cannot reach a market or bank", { carrying: carried, stacks, tried: options.map(o => o.name) });
      }
      return false;
    }

    // Claim the return cargo while the destination is still unambiguous: this is the
    // farming room the seller is leaving, not whichever shop the town leg ends in.
    this.prepareFarmDelivery(room.num);
    if (packFull) await this.farmCleanupBeforeSale().catch(error => {
      this.coordination.cleanup.refused++;
      this.note('farm clean-up could not finish', { why: error.message, consequence: 'selling trip continues' });
    });

    this.doing = 'travelling';
    // Stamp the attempt, not the success — the cooldown exists to stop a walk that buys
    // nothing from repeating, and "bought nothing" is the case that would otherwise never
    // set it.
    if (starving) this.foodTripAt = Date.now();
    if (supplyTrip) this.supplyTripAt = Date.now();
    // SAY WHICH ERRAND THIS IS, BECAUSE THE LABEL WAS PART OF WHAT HID THE LOOP.
    //
    // Every trip that was not the food one said "going to the bank" — including the ones
    // walking to a market and, until the fix above, the ones walking to a market for
    // reagents. So a character ping-ponging between Roq and the apothecary logged "going
    // to the bank" thirty times an hour, and the RECENT panel read as a fleet doing its
    // banking. It was the only line an operator had, and it named neither the destination
    // nor the reason.
    const errand = supplyTrip
        ? (needsCashFirst ? 'going to the bank to pay for reagents' : 'going to the apothecary')
      : starving && !packFull && carried <= above ? 'going to town for food'
      : needsCashFirst ? 'going to the bank for food money'
      : packFull && carried <= above ? 'going to market'
      : 'going to the bank';
    this.note(errand, {
      carrying: carried, to: target.name, hops: target.hops, keeping: this.walkingFloat(),
      trigger: sellCall.trigger, bill: supplyTrip ? supplyBill : undefined,
      banked: supplyTrip || needsCashFirst ? balance : undefined,
      why: supplyTrip
        ? 'below its own reagent floor with no meals aboard; the shortfall is fixed by ' +
          'buying, so this needs a counter and the money to spend at one'
        : starving && !packFull && carried <= above
        ? 'no food and not both reagents, so the only vigor above the resting cap is bought'
        : packFull && carried <= above
        ? 'make pack room at the equipment, gem and reagent specialists'
        : 'everything carried is dropped on death and usually unrecoverable; a balance is not' });
    // The shopping objective survives every recovery stop. Save the exact service
    // cursor rather than relying on need thresholds and cooldowns to rediscover it.
    // THE CIRCUIT IS ATTACHED ON THE PACK, NOT ON WHICHEVER NEED OPENED THE TRIP. A reagent
    // run and a full pack are not alternatives — a character is routinely both, and it is
    // already walking past the specialists. See `packWantsMarket`.
    const wantsMarket = packFull || this.packWantsMarket();
    this.openTownTrip(target, { sellCall, errand, wantsMarket, supplyTrip, starving,
      needsCashFirst });
    if (wantsMarket && !packFull)
      this.note('carrying enough to be worth the circuit while we are here', {
        trigger: sellCall.trigger, stops: MARKET_STOPS.map(m => m.name),
        why: 'the trip was opened by something other than the pack, and the pack is at its ' +
             'ceiling anyway — the equipment and gem counters are on the way' });
    this.postShoppingPlan(this.shoppingPlan());
    return this.continueTownTrip();
  }
  // THE FLOAT EVERY BANKING RULE KEEPS, AND THE PURSE LEASE THAT RAISES IT (m59-purse-lease.mjs). Every deposit path
  // reads its float here, so an errand's leased carry cannot be banked by a standing rule while the lease holds: the
  // chalice holder's deposit, the bank trip, the town trip and the coop alike. It lapses back to walkingMoney by itself.
  walkingFloat() { return walkingFloatOf(this.policy); }
  bankAboveNow() { return bankAboveOf(this.policy); }
  purseLeaseStatus(now = Date.now()) {
    const l = this.policy?.purseLease;
    if (!l) return null;
    const live = leaseCarry(this.policy, now) > 0;
    return { carry: l.carry, owner: l.owner ?? null, until: l.until ?? null, live,
             ...(live ? { left_min: Math.round((l.until - now) / 6000) / 10 } : { lapsed: 'back to the standard float' }) };
  }
  // @end 1
}
