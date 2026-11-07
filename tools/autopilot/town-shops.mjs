// IN TOWN: reagents, food, selling, guild wants, tithes, restocking, banking.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 14 methods: noteReagentShortfalls, buyReagentsInTown, reagentGapCost, withdrawForFood,
//   sellerHere, foodCarryShort, buyFoodInTown, sellInTown, sellMarketCircuit, contributeGuildWants,
//   depositViaDesk, guildTitheFromSale, restockInTown, bankSurplus
import { restrictPlan } from '../m59-curse-cycle.mjs';
import { contributionPlan, guildPlan } from '../m59-guildwants.mjs';
import { MARKET_KEEP } from '../m59-items.mjs';
import { norm } from '../m59-loadout.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { affordances, buyLines } from '../m59-parse.mjs';
import { purchaseKey, purchasePlan } from '../m59-purchase-plan.mjs';
import { hallVisitConfig, runReagentCoop } from '../m59-reagent-coop-runtime.mjs';
import * as skills from '../m59-skills.mjs';
import { farmSourcesFor, loadSpawns } from '../m59-spawns.mjs';
import { StockpileBook } from '../m59-stockpile.mjs';
import { BOOKMAKERS_HALL_ROOM, StorageCache, chestFullness, chestKey } from '../m59-storage.mjs';
import { TitheBook, payGuildTithe, purseAmount, tithePaymentPlan } from '../m59-tithe.mjs';
import { TICKETS_FILE, TicketBook, readDeskOpen } from '../m59-vault-broker.mjs';
import { FOOD_SHOP, FOOD_SHOPS, FOOD_WORD, REAGENT_BLOCKS, REAGENT_SHOP as REAGENT_SHOP_MAINLAND, SPAWN_FILE, TITHE_FLEET, onIsland, purchaseEnabled, reagentTargetFor, sleep , townTable } from '../m59-autopilot.mjs';
import { inspectDispositionQuality } from '../m59-loot-policy-runtime.mjs';
import { curseErrandNext, farmTownKeep, farmTownSeller, hallDepositPlan, isHallBoundWeapon, sellerMatches } from '../m59-farm-town.mjs';

export class TownShopsPart {
  // @part 1

  /**
   * WHAT THIS CHARACTER WANTS, CANNOT BUY, AND DOES NOT HAVE.
   *
   * Published rather than retried. `reagent_short` carries the item, how many casts it is worth,
   * and — because "you are short of X" is useless without "and here is where X comes from" — the
   * creature and rooms that drop it, so `farm orc teeth` can be dispatched as a task with a
   * destination instead of an aspiration.
   *
   * IT NAMES WHAT STOPS WORKING. A character short of orc teeth is not broken; it is a character
   * that cannot cast super strength. Saying which spell goes quiet is what makes the shortage
   * readable by somebody who is not holding this file open.
   */
  noteReagentShortfalls() {
    const wants = this.chestOnlyWants ?? [];
    if (!wants.length) { this.reagentShort = []; return this.reagentShort; }
    const pack = new Map();
    for (const o of (this.s.client?.inventory ?? []))
      pack.set(norm(this.s.client?.rsc?.get?.(o.nameRsc) ?? o.name ?? ''),
               (pack.get(norm(this.s.client?.rsc?.get?.(o.nameRsc) ?? o.name ?? '')) ?? 0) + (o.amount || 1));
    const spawns = loadSpawns(SPAWN_FILE);
    const short = [];
    for (const w of wants) {
      const held = pack.get(norm(w.item)) ?? 0;
      if (held >= (w.amount ?? 0)) continue;
      // THE CEILING IS THIS CHARACTER'S OWN. A creature at or below max health is one it can
      // plausibly fight; above that is the band it is being advanced THROUGH, not the band it
      // should be sent to for a reagent. Without this the pick is the highest drop rate in the
      // game, which for a sapphire is a level-105 lupogg.
      const ceiling = this.s.client?.vitals?.()?.health?.max ?? null;
      const farm = spawns ? farmSourcesFor(spawns, w.item, { maxLevel: ceiling }) : null;
      const best = farm?.best ?? null;
      short.push({
        item: w.item, wanted: w.amount ?? null, held,
        why: 'not bought by policy, and the stockpile did not cover it',
        blocks: (REAGENT_BLOCKS[norm(w.item)] ?? null),
        farm: best ? { creature: best.creature, level: best.level,
                       per_roll_percent: best.per_roll_percent, rooms: best.rooms.slice(0, 8) } : null,
        farmable: farm?.farmable ?? null,
        // A shortage nobody can act on must say so rather than leaving `farm: null` to be read
        // as "nothing drops it" — those are opposite facts.
        farm_why: best ? null : (farm?.best_why ?? farm?.why ?? null),
      });
    }
    this.reagentShort = short;
    if (short.length) this.note('short of a reagent it may not buy', { short });
    return short;
  }

  async buyReagentsInTown() {
    if (!purchaseEnabled(this.policy, 'reagents')) return;
    const s = this.s, c = s.need();
    const wantEb = reagentTargetFor('elderberry', this.policy.reagentTarget);
    const wantHb = reagentTargetFor('herb', this.policy.reagentTarget);
    const want = wantEb;
    let have = this.reagentCount();

    // THE CHESTS FIRST, AND FOR EVERYTHING THE PLAN WANTS -- not for two hardcoded names.
    //
    // This asked for `elderberry` and `herb` and nothing else, so the three lines that actually
    // cost money were never drawn: orc tooth, sapphire and mushroom, against a chest holding 202,
    // 503 and 460 of them. Robin's plan was 39,124 shillings with a purse of 618 and 86% of it was
    // sapphires and teeth the guild already owned.
    //
    // AND THE CO-OP GATE WAS BACKWARDS. `!this.policy.reagentCoop?.enabled` switched the chest off
    // for every character the co-op was switched ON for. Depositing and drawing are opposite
    // directions through the same door: a fleet that stocks its own chest is precisely the fleet
    // that should be shopping from it. The co-op decides what goes IN and has no opinion about
    // what comes out.
    const chestWants = [
      { item: 'elderberry', amount: Math.max(0, wantEb - have.elderberry) },
      { item: 'herb', amount: Math.max(0, wantHb - have.herbs) },
      // Everything else the plan asked for, including the chest-only items that were filtered
      // out of it -- those have no other source at all.
      ...(this.purchaseRequests?.() ?? []).map(r => ({ item: r.item, amount: r.amount })),
    ].filter(n => n.amount > 0);
    // One entry per item, largest want wins; withdrawFromStockpile takes a want list, not a bag.
    const merged = new Map();
    for (const w of chestWants) {
      const k = norm(w.item);
      if (!merged.has(k) || merged.get(k).amount < w.amount) merged.set(k, w);
    }
    if (this.policy.guildWants?.enabled && merged.size) {
      await this.withdrawFromStockpile([...merged.values()]).catch(error =>
        this.note('stockpile withdrawal failed', { why: error.message }));
      if (this.travelInterrupted()) return;
      have = this.reagentCount();
    }
    // A SHORTAGE IS A STATE TO REPORT, NOT AN ERRAND TO REPEAT.
    //
    // The chest has now had its turn. Anything still wanted that this character is not allowed to
    // buy has no third option left today, so the want is DROPPED and the shortage is published
    // instead. That is the difference between a fleet with eleven characters walking to a counter
    // they cannot afford every five minutes and a fleet with eleven characters farming while a
    // board says "poor orc teeth". The capability that needs it simply does not run.
    this.noteReagentShortfalls();
    // Only the shortfall that stops a cast. Being deep in elderberry and out of herbs is
    // the normal state here, and it is exactly as unable to cook as having neither.
    const plan = this.shoppingPlan({ kind: 'reagents' });
    if (!plan.lines.length && !plan.unpriced.length) return;
    const funded = await this.ensurePurchaseFunds(plan);
    if (!funded.ready) return funded;
    // THE FARM TOWN'S APOTHECARY when a strategy names one (townTable); otherwise the one this always used. A farm town
    // that names none never gets here: purchaseEnabled has already said no.
    const REAGENT_SHOP = (this.policy?.farmTown ? townTable(s.world?.room?.num, this.policy).REAGENT_SHOP : null)
      ?? REAGENT_SHOP_MAINLAND;
    if (s.world?.room?.num !== REAGENT_SHOP.room) {
      const r = await this.travel(REAGENT_SHOP.room, { origin: keeperOrigin('reagent_shopping'), maxHops: 12 })
                          .catch(e => ({ arrived: false, reason: e.message }));
      if (!r?.arrived) {
        this.note('could not reach the apothecary', { to: REAGENT_SHOP.name, have, want, why: r?.reason });
        return { pending: true, reason: r?.reason ?? 'apothecary journey still pending' };
      }
    }
    const pick = await this.sellerHere({ want: /elder\s?berry|^herbs?$/i, named: REAGENT_SHOP.seller ?? null }).catch(() => null);
    if (!pick) {
      this.note('nobody at the apothecary opened a reagent list', { room: REAGENT_SHOP.name });
      return { pending: true, reason: 'waiting for the reagent merchant' };
    }
    const seller = pick.seller;
    const got = await this.restockReagents(seller).catch(e => ({ pending: true, reason: e.message }));
    if (got?.length) this.note('bought reagents in town', {
      at: REAGENT_SHOP.name, bought: got, had: have, target: want });
    return got;
  }

  // THE MONEY ONLY EVER FLOWED ONE WAY, AND THE FLEET STARVED ON TOP OF A FORTUNE.
  //
  // bankSurplus deposits and there was no counterpart anywhere in this file — every
  // `withdraw` in it is a combat retreat. So a character's purse could only fall: it banks
  // down to the float, spends on the way, and the float is never topped back up. Measured
  // this pass: 78,508 shillings banked across the fleet, most characters carrying 104-115
  // in hand, ELEVEN of twenty-one with no food and no way to cook any, and EIGHT of those
  // too poor to buy a 45-shilling apple while their own accounts held thousands.
  //
  // bankSurplus already holds food money back when it happens to be at a counter with the
  // money in hand, and that is the cheap case. This is the other one: the money is already
  // gone, and the only way to spend it is to ask for it back.
  //
  // Deliberately AFTER bankSurplus. The two cannot fight — bankSurplus keeps `FLOAT +
  // foodMoney` and returns without depositing when it is under that, so by the time this
  // runs the purse is either already sufficient (and `need` is met, so this does nothing)
  // or genuinely short. Taking the food money out after banking the surplus is one round
  // trip at the counter we are already standing at.
  // WHAT THE SHORTFALL COSTS AT A COUNTER, IN SHILLINGS. One definition, because two
  // callers now need it and they must not disagree: the trip that decides whether a bank
  // has to come first, and the withdrawal that pays for it. A bill computed twice is how a
  // character draws pocket money for an 8,400sh fill and is back on the road inside the
  // hour — see the note on `withdrawMax` below.
  //
  // Counter prices, read off the shelf at Joguer: elderberry 28, herbs 14. Only the two
  // halves of `create food` are priced; a loadout may ask for anything, and being short of
  // a spare shield is not a bank errand.
  reagentGapCost() {
    const l = this.loadout();
    if (!l?.carry?.length) return 0;
    const pack = this.packAsItems();
    let sh = 0;
    for (const entry of l.carry) {
      if (!/elder\s?berry|^herbs?$/i.test(entry.item)) continue;
      const held = pack.filter(i => norm(i.name) === norm(entry.item))
                       .reduce((t, i) => t + i.amount, 0);
      if (held >= entry.min) continue;                   // only when a trip is warranted
      const target = Number.isFinite(entry.max) && entry.max > entry.min ? entry.max : entry.min;
      sh += Math.max(0, target - held) * (/elder/i.test(entry.item) ? 28 : 14);
    }
    return sh;
  }

  async withdrawForFood() {
    return this.ensurePurchaseFunds(this.shoppingPlan());
  }
  // A ROOM CAN HOLD TWO MERCHANTS AND ONLY ONE OF THEM SELLS ANYTHING.
  //
  // Every buying path here picked the FIRST object carrying a `buy` affordance and
  // committed to it. The Bhrama & Falcon holds two: `Parrin Aragone`, who opens no shop
  // list at all, and `Meidei` the bartender, who sells wheel of cheese at 144, meat pie at
  // 144 and a loaf of bread at 108. Parrin is first in the room's object list.
  //
  // So every character that walked to the bread shop asked the wrong one, got nothing back,
  // and filed `the merchant never opened a shop list` — 87 times in one day, against 214
  // purchases of which every single one was a reagent and NOT ONE was food. The fleet went
  // from four characters without food to eighteen and its median vigor from 164 to 81 while
  // standing in a room with bread in it.
  //
  // The affordance is a property of the OBJECT, not evidence that it trades: it means "you
  // may try to buy from this", and the only proof is a list with something on it. So this
  // asks each candidate in turn and takes the first that actually answers, which costs one
  // extra call in the room where it matters and none where the first merchant is the right
  // one. `want` lets a caller insist on a merchant stocking a particular kind — the food
  // leg does not want the reagent counter and vice versa.
  async sellerHere({ want = null, trusted = false, named = null } = {}) {
    const c = this.s.need();
    // `named`: a farm town's counter (m59-farm-town.mjs) -- only that NPC, whoever else stands in the room.
    const cands = [...(c.room?.objects?.values() ?? [])]
      .filter(o => affordances(o.flags).includes('buy'))
      .filter(o => !named || sellerMatches(c.rsc.get(o.nameRsc), named))
      .filter(o => !trusted || skills.trustedBuyer(c.rsc.get(o.nameRsc)));
    for (const o of cands) {
      const before = c.evSeq;
      await this.s.pacer.submit('buy', () => c.buy(o.id)).catch(() => {});
      const ev = await c.waitFor({ since: before, kinds: ['shop', 'message'], timeoutMs: 4000 })
                        .catch(() => ({ events: [] }));
      const shop = ev.events?.find(e => e.kind === 'shop');
      const items = shop?.items ?? [];
      if (!items.length) continue;
      if (want && !items.some(i => want.test(String(i.name ?? '')))) continue;
      return { seller: o, items };
    }
    return null;
  }

  // The food half of a town trip. Only worth the hop when there is actually a gap to
  // fill: vigor above the resting cap has to be EATEN, and everything below it comes
  // back for free by sitting down.
  /** How far below its loadout's FOOD carry floors this character is, in units (0 when not). */
  foodCarryShort() {
    const pack = this.packAsItems();
    let short = 0;
    for (const e of this.loadout()?.carry ?? []) {
      if (!(e.min > 0) || !FOOD_WORD.test(String(e.item))) continue;
      const held = pack.filter(i => purchaseKey(i.name) === purchaseKey(e.item)).reduce((n, i) => n + (i.amount || 1), 0);
      if (held < e.min) short += Math.max(e.min, Number(e.max) || 0) - held;
    }
    return short;
  }

  async buyFoodInTown() {
    if (!purchaseEnabled(this.policy, 'food')) return;
    const s = this.s, c = s.need();
    // A LOADOUT'S FOOD FLOOR OPENS THE TRIP TOO (the courier carries bread OUT to the crew: it is
    // stock, not its own supper, and its own vigor gap may be zero). The counter already buys carry
    // floors — shoppingPlan's restock lines — once the character is standing at one.
    const want = Math.max(this.purchaseFoodGap(), this.foodCarryShort());
    if (want <= 0) return;
    const funded = await this.ensurePurchaseFunds(this.shoppingPlan({ kind: 'food' }));
    if (!funded.ready) return funded;
    // TRY THE DOOR MORE THAN ONCE — IT IS THE DOOR, NOT THE ROUTE.
    //
    // The fleet went from four characters without food to eighteen, and median vigor from
    // 164 to 81, while buying 214 things — every one of them a reagent and not one of them
    // food. The buying logic was fine. `travel(103)` was simply failing, and this gave up
    // on the first attempt and filed a note nobody reads.
    //
    // The route is not the problem: `map` finds it in two hops and the last one is a `go`
    // through a door. Walked by hand the same trip succeeds — the character reached North
    // Barloque, then stepped into The Bhrama & Falcon on the next call. It is the known
    // Meridian door behaviour: a door needs the EXACT square, the arrival square and the
    // departure square deliberately do not line up, and a single attempt is a coin toss.
    // The earlier 108/110 investigation measured the same thing at 52-69% per attempt.
    //
    // So three attempts, which turns a coin toss into a near-certainty, and the failure
    // note now says how many were made — a note reading "could not reach" after one try
    // and after three are different facts about the world.
    // THE NEAREST ROUTABLE SHOP, then the next. Three attempts across them, as before.
    const hops = shop => { try { const r = s.world?.route?.(shop.room); return r?.found ? (r.hops?.length ?? 99) : Infinity; } catch { return Infinity; } };
    // THE FOOD SHOPS FOR WHERE WE STAND (the island has its own: m59-autopilot.mjs townTable).
    const town = townTable(s.world?.room?.num, this.policy);
    const shops = town.FOOD_SHOPS.map(sh => ({ ...sh, hops: hops(sh) })).filter(sh => Number.isFinite(sh.hops))
      .sort((a, b) => a.hops - b.hops);
    const atShop = () => town.FOOD_SHOPS.some(sh => sh.room === s.world?.room?.num);
    const shopHere = () => town.FOOD_SHOPS.find(sh => sh.room === s.world?.room?.num) ?? town.FOOD_SHOP;
    if (!atShop()) {
      let got = null;
      for (let i = 0; i < 3 && !atShop() && shops.length; i++) {
        if (this.travelInterrupted() || this.suspendedJourney)
          return { pending: true, reason: 'paused for survival' };
        const target = shops[Math.min(i, shops.length - 1)];
        got = await this.travel(target.room, { origin: keeperOrigin('food_shopping'), maxHops: 14 })
                        .catch(e => ({ arrived: false, reason: e.message }));
        if (got?.arrived) break;
      }
      if (!atShop()) {
        this.note('could not reach the bread shop', {
          to: shops.map(sh => sh.name), short_by: want, attempts: 3, why: got?.reason ?? (shops.length ? null : 'no food shop is routable'),
          note: 'the route exists and the last hop is a door; three refusals in a row is ' +
                'about this room rather than about the map' });
        return { pending: true, reason: got?.reason ?? 'bread shop journey still pending' };
      }
    }
    // The one that actually sells FOOD, not merely the first that can be bought from.
    // `mushroom` ON ITS OWN IS A REAGENT, NOT FOOD, AND THIS MATCHER USED TO SAY OTHERWISE.
    // The brown one players call a "brown" is named just `mushroom` in the game, and the
    // red and blue ones are reagents too — only `edible mushroom` and `Inky-cap mushroom`
    // are in the Food class tree (m59-items.json: nutrition 5 and 50; the rest are absent).
    // A bare /mushroom/ therefore matched every herbalist's stock and could pick the
    // REAGENT seller as "the one that actually sells FOOD", which is the exact thing the
    // line below this was written to avoid.
    // A FARM TOWN'S BREAD SHOP IS ITS NAMED COUNTER (Tova, not whoever else stands in the inn); what is bought there is
    // cut to the listed items by restockReagents (farmTownMenu).
    const pick = await this.sellerHere({ want: /cheese|pie|bread|apple|grape|edible mushroom|inky.?cap|stew|drumstick/i,
                                         named: town.farmTown ? (shopHere()?.seller ?? null) : null })
                        .catch(() => null);
    if (!pick) {
      this.note('nobody in the bread shop opened a food list', {
      at: shopHere().name, short_by: want,
      note: 'the room can hold more than one merchant and only one of them trades' });
      return { pending: true, reason: 'waiting for the food merchant' };
    }
    const got = await this.restockReagents(pick.seller).catch(e => ({ pending: true, reason: e.message }));
    if (got?.length) this.note('bought food in town', { at: shopHere().name, bought: got, was_short: want,
                                                        from: c.rsc.get(pick.seller.nameRsc) });
    return got;
  }

  // SELL WHAT NOBODY IS SHORT OF. `sellable` already consults this character's own
  // loadout, and sellAll already refuses to sell anything a crewmate has declared a want
  // for — but nothing was passing the loadout in, so a character's own list could not
  // protect its reagents and the fleet register was doing all the work alone. Both are
  // consulted now: either one saying "keep" is enough, which is what makes it safe to
  // sell everything else.
  async sellInTown({ maxStack = null, seller = null } = {}) {
    const s = this.s, c = s.need();
    await inspectDispositionQuality(this);
    // "BUYS ANYTHING" IS USUALLY A TRICK, AND IT NEARLY COST THE FLEET EVERYTHING.
    //
    // The merchant index reports `buys_anything: true` for the bankers, and the affordance
    // flags say `buy`. Both are true and neither means what it looks like: Skivlat TAKES
    // whatever you hand over, says thank you, and gives you nothing. It is a trick played
    // on new players, and this keeper was one town trip away from doing it to twenty-one
    // characters carrying 1,864 units of loot between them.
    //
    // So a sale is made only to a merchant on the trusted list. Anyone else is left alone
    // however generous their flags look — being wrong about a buyer costs the whole pack,
    // and being wrong about a walk costs a walk. See SELL_TO in m59-skills.mjs.
    //
    // A FARM TOWN NAMES ITS BUYER (m59-farm-town.mjs), and that is the one exception: the stop's `seller`, which SELL_TO
    // need not list (neither Marion man is on it). Never a NEVER_SELL_TO name, and sellAll still refuses a sale with no
    // quoted price, so a named counter that pays nothing costs a refused offer, never the item.
    const farmTown = this.policy?.farmTown ?? null;
    const buyers = [...c.room.objects.values()].filter(o => affordances(o.flags).includes('buy'));
    const buyer = seller
      ? farmTownSeller({ seller }, buyers.filter(o => !skills.NEVER_SELL_TO.some(re => re.test(c.rsc.get(o.nameRsc) || ''))),
                       o => c.rsc.get(o.nameRsc))
      : buyers.find(o => skills.trustedBuyer(c.rsc.get(o.nameRsc)));
    if (!buyer) return null;
    this.doing = 'trading';
    // saleLoadout: the character's own loadout, plus on Ko'catan the island-reagent ceilings (m59-island-sale.mjs).
    const r = await skills.sellAll(s, { merchant: buyer.id, loadout: this.saleLoadout ? this.saleLoadout() : this.loadout(), keep: MARKET_KEEP,
                                       // A farm town's `keep` is never offered at its counters: a sale exclusion, not
                                       // `protect`, so a kept reagent is still a spare a fleet-mate may be handed.
                                       protect: farmTown && seller ? farmTownKeep(farmTown, this.saleProtectedNames()) : this.saleProtectedNames(),
                                       maxWeapons: this.policy.maxWeapons,
                                       weaponPriority: this.weaponPriorityNow(), maxStack,
                                       // A FARM TOWN'S HALL CARGO AND CURSED WEAPON are never offered (saleExcludeIds).
                                       exclude: this.saleExcludeIds?.() ?? null })
                          .catch(e => ({ error: e.message }));
    if (r.error) { this.note('could not sell in town', { why: r.error }); return null; }
    if (r.sold?.length) {
      this.tally.sold = (this.tally.sold || 0) + r.sold.length;
      this.tradeFact({ earned: r.total_received, sold: r.sold });
      this.note('sold in town', { to: c.rsc.get(buyer.nameRsc), items: r.sold.length,
        earned: r.total_received, kept_for_the_fleet: r.kept_for_the_fleet?.map(k => k.name) });
    }
    return r;
  }

  // TAX ONLY WHAT THIS TOWN TRIP JUST EARNED. Existing purse, bank balances and the
  // walking reserve are not a guild treasury. Partial payments accumulate in a durable
  // per-character daily book and the next sale trip finishes the day's configured sum.
  // GUILD WANTS — the fleet's shared demand, answered by whoever is passing.
  //
  // A CHECK-IN, NOT AN ERRAND, exactly like the rent tithe beside it: it runs on every town
  // trip, and the walk is skipped whenever there is nothing to carry. That is the whole
  // reason the plan is an END STATE — "chest 2 should hold 300 mushrooms" shrinks as other
  // characters contribute, so a met plan silently produces no work instead of sending
  // twenty-one characters to look at a full chest.
  async sellMarketCircuit(trip) {
    trip.marketIndex ??= 0;
    trip.marketSale ??= { sold: [], total_received: 0 };
    while (trip.marketIndex < trip.marketStops.length) {
      const stop = trip.marketStops[trip.marketIndex];
      if (this.travelInterrupted() || this.suspendedJourney) return { pending: true };
      if (Number(this.s.world?.room?.num) !== stop.room) {
        const result = await this.travel(stop.room, { origin: keeperOrigin('sell_circuit'), maxHops: 20 });
        if (!result.arrived || this.travelInterrupted()) return { pending: true };
      }
      const sale = await this.sellInTown({ maxStack: stop.maxStack, seller: stop.seller ?? null });
      if (this.travelInterrupted()) return { pending: true };
      // A STOP THAT CANNOT SELL COMPLETES AS "SOLD NOTHING" AND THE CIRCUIT MOVES ON. Prod, 2026-10-27: every island sell
      // trip hung for ever at the Ko'catan smithy -- no counter there was on SELL_TO, so sellInTown answered null and this
      // returned pending every five seconds, holding the body off the farm. A trip that cannot fix the thing that opened
      // it must not run for ever: no trusted buyer here ends the stop at once; a failed sale is retried once, then ends it.
      if (!sale || sale.error) {
        const c = this.s.client;
        const buyerHere = c?.room?.objects && [...c.room.objects.values()]
          .some(o => affordances(o.flags).includes('buy') &&
                     (stop.seller ? sellerMatches(c.rsc.get(o.nameRsc), stop.seller) : skills.trustedBuyer(c.rsc.get(o.nameRsc))));
        trip.marketStopTries ??= {};
        const tries = trip.marketStopTries[trip.marketIndex] = (trip.marketStopTries[trip.marketIndex] ?? 0) + 1;
        if (buyerHere && tries < 2) return { pending: true };
        this.note('sold nothing at this stop, moving on', { room: stop.room, stop: stop.name ?? null, tries,
          why: buyerHere ? 'the sale failed twice' : 'no trusted buyer here (SELL_TO)' });
        trip.marketIndex++;
        continue;
      }
      trip.marketSale.sold.push(...(sale.sold ?? []));
      trip.marketSale.total_received += sale.total_received ?? 0;
      trip.marketIndex++;
    }
    return trip.marketSale;
  }

  async contributeGuildWants({ duringTownTrip = false } = {}) {
    // THE GUARD COULD NOT TELL ITS TWO CALLERS APART, AND ONE OF THEM WAS THE TOWN TRIP.
    //
    // The intent was right: the town scheduler owns donation opportunities, so a STANDALONE
    // pass must not resurrect a skipped final tithe or interrupt the next trip. But
    // `contributeGuildWants` is step 0 OF THAT SCHEDULER, and it is the same method, so with
    // `reagentCoop` enabled it returned `{ skipped: true }` on the town trip as well —
    // every time, for ever. Nothing in `coopBusiness` covers the gap either: the coop path
    // donates REAGENTS to the coop, which is a different thing from filling a chest plan.
    //
    // Measured on prod 2026-09-17: three characters farmed room 27 for seven hours with
    // `guild_wants` on, looted 87 orc teeth between them against a chest plan wanting 738,
    // and deposited NOTHING. The chest cache had not been written since 06:33 — nobody had so
    // much as opened a chest — while the teeth rode around in their packs and the surplus was
    // sold to merchants. Every board read "guild_wants: on" throughout.
    //
    // So the caller says which it is, and only the standalone path is skipped.
    if (this.policy.reagentCoop?.enabled && !duringTownTrip)
      return { skipped: true, why: 'the town scheduler owns donation opportunities; ' +
                                   'this is a standalone pass' };
    // NOT FROM KO'CATAN. The hall (714) and the vault desk are on the mainland and a trip from the island never leaves it
    // (m59-autopilot.mjs townTable). With the dispel reagents on the plan's `everyone` list, every island sell trip began
    // by planning a walk to the hall; on the island those reagents are sold instead (islandSaleRelease).
    if (onIsland(this.s?.world?.room?.num))
      return { skipped: true, why: "the guild hall is on the mainland; a trip from Ko'catan never leaves the island" };
    const cfg = this.policy.guildWants;
    // THE CURSE CYCLE'S HALL RUN rides this path with guild_wants OFF, narrowed to its own names
    // (`hall`), so carrying rings to the hall does not also switch on every other line of the plan.
    // AND THE PLAN'S `everyone` ITEMS, which every character carries home whatever its own guild_wants
    // (operator, 2026-10-19: "have everyone ... send [the dispel illusion reagents] back to the guild hall").
    // OUR GUILD'S PLAN, OUR HALL'S CHESTS, OUR GUILD'S RENT (guildStores) -- with two guilds in the
    // roster the other hall's plan is the other guild's business.
    const mine = this.guildStores();
    let plan = this.guildContributionPlan ? this.guildContributionPlan(mine.plan) : mine.plan;
    const hallOnly = cfg?.enabled ? null : [...(this.curseCycleHall() ?? []), ...(plan?.everyone ?? [])];
    if (!cfg?.enabled && !hallOnly.length) return null;
    if (!plan) return null;                       // no plan is not an empty plan
    if (hallOnly) plan = restrictPlan(plan, hallOnly);
    const store = mine.store;
    const chests = mine.chests, rent = mine.rent;

    // THE CONTRIBUTOR KEEPS ITS OWN FLOOR. A guild is not entitled to the elderberry a
    // caster eats with, so the loadout's own minimum comes off the top before anything is
    // offered — the same rule farm delivery follows for the same reason.
    const l = this.loadout();
    const keepFloor = (item) => {
      // A named loot disposition must not silently take the guild-chest detour instead.
      const carried = this.s.client?.inventory?.find(o => norm(this.s.client.rsc.get(o.nameRsc) || '') === item);
      if (carried && this.s.lootDisposition?.(carried)) return Infinity;
      const entry = l?.carry?.find(cRow => norm(cRow.item) === item);
      return entry ? (entry.min || 0) : 0;
    };
    const pack = this.packAsItems();
    const want = contributionPlan({ plan, chests, pack, keepFloor, rent });

    // THE BEFORE SNAPSHOT. Taken before the walk, because a run that never arrives is
    // exactly the case the record has to be able to show.
    // NEVER THROWS. A snapshot is a description of the run, and a description that can fail
    // the thing it describes is worse than no description -- the first version of this called
    // a helper that did not exist, outside any try, which would have broken every deposit.
    const snapshot = () => { try { return {
      at: Date.now(),
      pack: Object.fromEntries((want.chests ?? []).flatMap(ch => (ch.give ?? []).map(g => g.item))
        .filter((v, i, a) => a.indexOf(v) === i)
        .map(item => [item, this.packAsItems().filter(x => norm(x.name) === item)
          .reduce((t, x) => t + (x.amount || 1), 0)])),
      chests: Object.fromEntries((store.allChests({ room: mine.hall }) ?? []).map(ch =>
        [ch.slot, { rows: (ch.items ?? []).length, bulk: chestFullness(ch.items ?? []).bulk }])),
    }; } catch (e) { return { at: Date.now(), error: e?.message ?? String(e) }; } };
    if (!want.enabled) { this.note('guild wants are off', { why: want.why }); return want; }
    if (!want.walk) {
      // Deliberately quiet and deliberately not a walk. This is the common case on most
      // trips and it must stay free.
      this.note('nothing to contribute to the guild chests', { total: 0 });
      return want;
    }
    // THE SNAPSHOT THE COMMENT ABOVE PROMISED, AND NOTHING TOOK. `before` was named in both
    // recordHallRun calls and declared nowhere, so in this module (strict) each threw a
    // ReferenceError: a trip that did not arrive threw at its record, and the town scheduler reads a
    // thrown stage as "pending" and runs it again five seconds later; a trip that DID deposit threw
    // after depositing and ran again. Found 2026-09-28 wiring the vault desk in.
    const before = snapshot();

    // THE CONCIERGE FIRST (operator, 2026-09-28: "Make it so those chest routings are automatic, like
    // the same path someone would normally route to try to deposit, it checks for the 'concierge
    // service'"). With the vault desk open, a contributor does not walk into the hall: it goes to the
    // desk's town room, files a deposit ticket and hands the goods to the go-between, who carries
    // them across the window. The hall walk below is the fallback, never removed — a desk that does
    // not answer costs one wait, and the next trip within the hour does not ask it again.
    const desk = this.policy.useVaultDesk === false ? null : readDeskOpen(TITHE_FLEET);
    if (desk && !(Date.now() - (this._deskMissedAt ?? 0) < 3600_000)) {
      const viaDesk = await this.depositViaDesk(want, desk)
        .catch(e => ({ contributed: 0, why: e?.message ?? String(e) }));
      if (viaDesk.contributed > 0) {
        this.tally.guild_contributed = (this.tally.guild_contributed || 0) + viaDesk.contributed;
        this.recordHallRun({ before, after: snapshot(), want, contributed: viaDesk.contributed, done: [],
          hall: { ok: true, via: 'vault desk', ticket: viaDesk.ticket ?? null, room: viaDesk.room ?? null } });
        this.note('contributed to the guild chests through the vault desk', viaDesk);
        this.progress('stocked the guild hall through the vault desk');
        return { ...want, contributed: viaDesk.contributed, done: [], via: 'vault desk' };
      }
      this._deskMissedAt = Date.now();
      this.note('the vault desk did not take the contribution — walking into the hall instead', viaDesk);
    }

    this.doing = 'travelling';
    const trip = await this.travel(mine.hall, { origin: keeperOrigin('guild_wants'), maxHops: 14 })
      .catch(error => ({ arrived: false, reason: error.message }));
    if (!trip.arrived) {
      this.note('could not reach the guild hall to contribute', {
        want: want.total, why: trip.reason || 'travel refused' });
      this.recordHallRun({ before, after: before, want, contributed: 0, done: [],
        hall: { ok: false, why: trip.reason || 'travel refused', arrived: false } });
      return { ...want, contributed: 0, reason: trip.reason || 'travel refused' };
    }

    this.doing = 'trading';
    const s = this.s, c = s.need();
    // THE WALL COMES BEFORE THE CHESTS. Room contents list what is IN the room, so a chest
    // behind a shut secret door still appears here — which is exactly why this is not
    // optional and not conditional on "can I see a chest". The reachability, not the
    // visibility, is what the password buys.
    // SAME FOYER PROBLEM AS THE WITHDRAW PATH, and this is the one that was costing us.
    // `reachHallChests` steps out of the box, speaks, waits for the slow door and reads the
    // room back — and returns WHY when any of that fails, which is what `recordHallRun`
    // writes down. See the note on reachHallChests.
    const hall = await this.reachHallChests().catch(e => ({ ok: false, why: e?.message ?? String(e) }));

    // A CHEST IS ADDRESSED BY OBJECT ID, and the cache is what knows which id is which
    // slot. Falling back to the order chests appear in the room would be a guess that
    // silently files chest 3's contents into chest 1 — so a slot whose id is not in the
    // room is skipped and named rather than substituted.
    // EVERY CHEST IN THIS ROOM, EACH NAMED BY ITS OWN SQUARE. No mapping, no ordering and no
    // completeness requirement: the name is read off the object, so a chest seen at r18c6 is
    // r18c6 and a reading that shows two chests is a reading of two chests. An object id is
    // a handle the server recycles — 23% of stored ids named a different object three days
    // later — and nothing here uses one to address anything.
    const here = new Map();
    for (const o of c.room?.objects?.values?.() ?? []) {
      if (!/chest/i.test(c.rsc.get(o.nameRsc) || '')) continue;
      const key = chestKey(o);
      // A chest whose position did not arrive cannot be named, and an unnamed chest must not
      // be guessed at — that is the whole mis-filing hazard, in one branch.
      if (!key) { this.note('a chest here has no readable position', { id: o.id }); continue; }
      here.set(key, { id: o.id, row: o.row, col: o.col, key });
    }
    const book = new StockpileBook({ fleet: TITHE_FLEET });
    const done = [];
    let contributed = 0;
    for (const chest of want.chests) {
      if (!chest.total) continue;
      const target = here.get(String(chest.slot)) ?? null;
      if (!target) {
        // SAY IT LOUDLY, not just into the return value. The plan names a square and this
        // room has no chest on it — which is a real disagreement worth seeing, not a silence.
        this.note('no chest stands on that square', { chest: chest.slot,
          chests_in_room: [...here.keys()],
          why: 'the guild plan names a chest at that square and this room has none there' });
        done.push({ slot: chest.slot, put: 0, why: 'no chest stands on that square' });
        continue;
      }
      let intoThisChest = 0;
      for (const give of chest.give) {
        if (!give.amount) continue;
        const held = (c.inventory || []).filter(o =>
          norm(c.rsc.get(o.nameRsc) || '') === give.item);
        let left = give.amount;
        for (const item of held) {
          if (left <= 0) break;
          const before = this.packAsItems()
            .filter(x => norm(x.name) === give.item)
            .reduce((t, x) => t + (x.amount || 1), 0);
          // A STACK NEEDS A SPEC. `c.put(item.id, ...)` is a bare id, and the coop runtime
          // states the rule outright: "Bare IDs are only for non-stackables." Orc teeth come
          // off an orc in stacks of 3 and 6, so every tooth deposit completed its handshake
          // and moved nothing, while shields, a helm, a hammer and a scroll -- all singles --
          // went in fine. That is exactly the chest contents we measured.
          const spec = this.dropSpec(item, Math.min(left, item.amount || 1));
          await s.pacer.submit('trade', () => c.put(spec, target.id)).catch(() => {});
          await new Promise(r => setTimeout(r, 400));
          await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
          await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
          // WHAT LEFT THE PACK, not what the put was asked to move. A container refusal in
          // this game is a sentence spoken to the room, never an error on the wire, so a
          // `put` that reports nothing is not a `put` that worked.
          const after = this.packAsItems()
            .filter(x => norm(x.name) === give.item)
            .reduce((t, x) => t + (x.amount || 1), 0);
          const moved = Math.max(0, before - after);
          left -= moved; contributed += moved; intoThisChest += moved;
          // THE INBOUND HALF OF THE LEDGER, and only the verified pack delta. Kept out of
          // `moves` on purpose: the saving is realised when somebody WITHDRAWS, so counting
          // a unit here and again there would double the volume the hall is judged on.
          if (moved) book.deposit({ item: give.item, amount: moved, slot: chest.slot,
                                    by: this.name ?? s.name });
          if (moved) this.tradeFact({ guild_deposited: [{ name: give.item, amount: moved }] });
          if (!moved) break;                      // it refused; stop hammering the chest
        }
        done.push({ slot: chest.slot, item: give.item, wanted: give.amount,
                    put: give.amount - Math.max(0, left) });
      }
      // ONE READING PER CHEST, not one per stack: the character is standing here, the
      // contents just changed, and this is the only moment anything can learn them.
      if (intoThisChest)
        await this.refreshChestCache(target, chest.slot,
          { store, why: `deposited ${intoThisChest}` });
    }
    this.tally.guild_contributed = (this.tally.guild_contributed || 0) + contributed;
    this.recordHallRun({ before, after: snapshot(), want, contributed, done, hall });
    this.note('contributed to the guild chests', { contributed, planned: want.total, done,
      hall: hall?.ok ? 'chests reachable' : (hall?.why ?? 'unknown') });
    if (contributed) this.progress('stocked the guild hall');
    return { ...want, contributed, done };
  }

  /**
   * Hand a guild contribution to the vault desk rather than walking into the hall. Walks to the
   * desk's town room, files a deposit ticket naming exactly what `want` gives, and waits for the
   * go-between to take it (the desk walks to a bot standing in one of its town rooms and trades).
   * Returns { contributed, ticket, room, status, why } — `contributed` is read off the pack, never
   * off the ticket, because a ticket that says done while the goods are still here is not done.
   */
  async depositViaDesk(want, desk) {
    const items = new Map();
    for (const ch of want?.chests ?? []) for (const g of ch.give ?? [])
      if (g.amount > 0) items.set(g.item, (items.get(g.item) ?? 0) + g.amount);
    if (!items.size) return { contributed: 0, why: 'nothing to give' };
    const room = Number(desk?.meet_room) || 106;
    this.doing = 'travelling';
    const trip = await this.travel(room, { origin: keeperOrigin('desk_deposit'), maxHops: 14 })
      .catch(error => ({ arrived: false, reason: error.message }));
    if (!trip.arrived) return { contributed: 0, room, why: `could not reach room ${room}: ${trip.reason || 'travel refused'}` };
    const count = name => this.packAsItems().filter(x => norm(x.name) === name)
      .reduce((t, x) => t + (x.amount || 1), 0);
    const start = new Map([...items.keys()].map(k => [k, count(k)]));
    const book = new TicketBook(TICKETS_FILE(TITHE_FLEET));
    const t = book.request({ kind: 'deposit', from: this.name ?? this.s.name,
      items: [...items].map(([item, amount]) => ({ item, amount })), where: room });
    this.note('filed a vault desk deposit', { ticket: t.id, room, items: Object.fromEntries(items) });
    this.doing = 'waiting for the vault desk';
    const until = Date.now() + (Number(this.policy.vaultDeskWaitMs) || 8 * 60_000);
    const moved = () => [...start].reduce((n, [k, v]) => n + Math.max(0, v - count(k)), 0);
    let status = 'open';
    while (Date.now() < until && !this.stopping) {
      await sleep(Number(this.policy.vaultDeskPollMs) || 10_000);
      status = book.read().tickets.find(x => x.id === t.id)?.status ?? status;
      if (!['open', 'working'].includes(status)) break;
    }
    const contributed = moved();
    if (!contributed && ['open', 'working'].includes(status))
      try { book.update(t.id, { status: 'expired', why: 'the contributor left: nobody took it' }); status = 'expired'; } catch {}
    return { contributed, ticket: t.id, room, status };
  }

  async guildTitheFromSale(sale) {
    const cfg = this.policy.guildTithe;
    const proceeds = Math.max(0, Math.floor(Number(sale?.total_received) || 0));
    if (!cfg?.enabled || !proceeds) return null;
    const c = this.s.need();
    await this.s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
    const book = new TitheBook({ agent: this.name ?? this.s.name, fleet: TITHE_FLEET });
    const plan = tithePaymentPlan({ dailyAmount: cfg.daily_amount,
      paidToday: book.paidToday(), saleProceeds: proceeds, purse: purseAmount(c),
      walkingMoney: this.walkingFloat() });
    if (!plan.amount) {
      this.note(plan.remaining > 0
        ? 'guild tithe retained for a later sale'
        : 'daily guild tithe already paid', plan);
      return { ...plan, paid: 0 };
    }

    this.doing = 'travelling';
    // A FARM TOWN WITH A HALL walks to Frular on the hall road (past the confinement, m59-farm-town.mjs farmTownRoadRooms);
    // from Marion it is 11 rooms, not 12-or-fewer from Barloque's own streets.
    const trip = await this.travel(700, { origin: keeperOrigin('guild_tithe'),
      maxHops: this.policy?.farmTown?.hall ? 20 : 12, ...(this.policy?.farmTown?.hall ? { townRoad: true } : {}) })
      .catch(error => ({ arrived: false, reason: error.message }));
    if (!trip.arrived) {
      this.note('could not reach the guildmaster for tithe', { amount: plan.amount,
        why: trip.reason || 'travel refused' });
      return { ...plan, paid: 0, reason: trip.reason || 'travel refused' };
    }
    this.doing = 'trading';
    const result = await payGuildTithe(this.s, { amount: plan.amount });
    if (result.paid > 0) {
      book.record(result.paid, { detail: { target: plan.target,
        proceeds: plan.proceeds, credit_after: result.credit ?? null,
        due_after: result.due ?? null, rent_checked_at: result.rent_checked_at,
        rent_check_ok: result.rent_check_ok } });
      this.tally.guild_tithe = (this.tally.guild_tithe || 0) + result.paid;
      this.note('paid guild tithe from town-sale proceeds', { paid: result.paid,
        daily_target: plan.target, paid_today: plan.paid + result.paid,
        credit_after: result.credit ?? null, due_after: result.due ?? null,
        rent_checked_at: result.rent_checked_at, rent_check_ok: result.rent_check_ok,
        ...(result.rent_check_error ? { rent_check_error: result.rent_check_error } : {}) });
    } else this.note('guildmaster refused tithe', { offered: plan.amount,
      said: result.frular_said, due: result.due ?? null });
    return { ...plan, ...result };
  }

  // AND SPEND IT ON THE TWO THINGS THAT RUN OUT. restockReagents buys elderberry, herbs
  // and food, and until now was reachable only from makeRoom for the same dead reason.
  async restockInTown() {
    if (!purchaseEnabled(this.policy, 'food') && !purchaseEnabled(this.policy, 'reagents')) return;
    const s = this.s, c = s.need();
    // ASK THE ONE THAT ACTUALLY TRADES. This took the first object flagged `buy` and
    // committed to it, which is how the fleet spent a day asking Parrin Aragone for bread
    // in a room where Meidei was selling it. The same mistake is cheaper here — this runs
    // wherever a town trip happened to end, usually a bank or Roq, and neither stocks a
    // reagent — but it is still the single largest decline in the ledger: "the merchant
    // never opened a shop list", 269 times in six hours, which reads like a broken shop
    // and is a wrong question.
    const pick = await this.sellerHere().catch(() => null);
    if (!pick) return;
    const seller = pick.seller;
    const got = await this.restockReagents(seller).catch(e => ({ pending: true, reason: e.message }));
    if (got?.length) this.note('restocked in town', { bought: got });
    return got;
  }

  // BANK THE MONEY BEFORE GOING BACK OUT.
  //
  // Dying drops your ENTIRE inventory on a corpse you usually cannot return to, and
  // shillings are inventory. Bank deposits are not. This fleet has already proved the
  // point the expensive way: twenty-three deaths, and an audit afterwards found
  // nineteen of twenty-five characters wearing nothing and most carrying no money at
  // all — everything they had earned was lying on corpses across the world.
  //
  // With a balance, a death costs a point of maximum health and an errand. Without
  // one it costs everything and the character restarts from nothing, which is the
  // difference between a setback and a spiral. Jasper and Tos share one banking
  // system, so either counter will do.
  //
  // Keep a float in hand for flasks and food; bank the rest.
  async bankSurplus() {
    const s = this.s, c = s.need();
    if (this.coopVisit?.mode === 'tithe') {
      const resumed = await runReagentCoop(this, 'tithe', {}, TITHE_FLEET);
      if (resumed.pending) return resumed;
    }
    const FLOAT = this.walkingFloat();
    const room = s.world?.room;
    if (!room) return;
    // A BANK IS A ROOM THE TOWN TABLE SAYS IS ONE, OR A BANKER BY NAME -- not only a name containing "bank". Prod
    // 2026-10-27: Ko'catan's bank is "The Hungry Vaults" and its banker Huital ko'Nosak, neither says "bank" (and no
    // object ever carries a 'bank' affordance), so every island bank trip returned here silently and Scooter opened one
    // every two minutes with 25,113 in his purse.
    const BANKER_NAME = /bank|skivlat|yevitan|setag|huital/i;
    const teller = [...c.room.objects.values()]
      .find(o => BANKER_NAME.test(c.rsc.get(o.nameRsc) || '') ||
                 affordances(o.flags).includes('bank'));
    const bankRoom = townTable(room.num, this.policy).BANKS.some(b => Number(b.room) === Number(room.num));
    // Only when we happen to be standing in a bank — a special trip is not worth the
    // walk, and the trader/wellfed loops already pass through town.
    if (!teller && !bankRoom && !/bank/i.test(room.name || '')) return;

    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
    const purse = c.inventory.find(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''));
    const carried = purse?.amount ?? 0;

    // DO NOT BANK THE MONEY YOU ARE ABOUT TO SPEND ON FOOD.
    //
    // The float is 400 and restockReagents will not spend below a 100 reserve, so a
    // character walks out of the bank able to spend 300 — and then banks down to the
    // float again next trip. Meanwhile an apple is 45, a loaf 108 and a cheese 144. The
    // result was a fleet holding 67,669 shillings between them with twenty of twenty-one
    // characters stuck at the resting cap: rich, hungry, and each half of that caused by
    // the other. Statler had 82 in its purse against 852 in its account.
    //
    // Withdrawing it back would be a second trip. Keeping it is free — this is the one
    // moment the money is in hand and the shop is one hop away, so hold back what the
    // food actually costs and bank the rest.
    const vg = c.vitals?.()?.vigor;
    const larder = this.larder(c).reduce((t, f) => t + (f.food?.nutrition ?? 0) * (f.o.amount || 1), 0);
    const shortBy = Math.max(0, (this.policy.fightAboveVigor ?? 140) - (vg?.value ?? 0) - larder);
    // Roughly 4.5 shillings a vigor point at the Barloque shelf, plus the 100 reserve
    // restockReagents keeps. Capped so a badly-fed character cannot refuse to bank at all.
    const foodMoney = purchaseEnabled(this.policy, 'food') && shortBy > 20
      ? Math.min(900, Math.round(shortBy * 4.5) + 100) : 0;
    const deliveryMoney = this.deliveryCashReserve();
    const keep = Math.max(FLOAT + foodMoney + deliveryMoney + this.standingOrderReserve(),
      this.townTrip?.purchasePlan?.required_purse ?? 0,
      this.purchaseFunding?.pending ? this.purchaseFunding.required_purse : 0);
    if (carried <= keep) {
      if (foodMoney || deliveryMoney) this.note('keeping supply money back rather than banking it', {
        carrying: carried, float: FLOAT, for_food: foodMoney,
        for_farm_delivery: deliveryMoney, short_by: shortBy });
      return;
    }

    const put = Math.max(0, this.purseNow() - keep);
    if (!put) return;
    this.doing = 'trading';
    // The client speaks to the teller directly; there is no skills wrapper for this.
    const purseBefore = this.purseNow();
    const r = await s.pacer.submit('bank', () => c.deposit(put))
                    .then(() => c.waitFor({ kinds: ['message'], timeoutMs: 3000 }))
                    .then(ev => ({ said: ev.events?.filter(e => e.text).map(e => e.text).slice(0, 2) }))
                    .catch(e => ({ error: e.message }));
    // READ IT BACK: a deposit is a sentence from the banker, and only the purse says it happened.
    if (!r.error) {
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
      if (!(this.purseNow() < purseBefore)) r.error = `the purse did not go down (${purseBefore} before and after)`;
    }
    if (r.error) this._bankedNothingAt = Date.now();
    this.note(r.error ? 'could not bank' : 'banked the surplus', {
      deposited: r.error ? undefined : put, kept: keep, float: FLOAT, for_food: foodMoney,
      for_farm_delivery: deliveryMoney, why: r.error, said: r.said,
      because: 'money in hand is lost on death; money in the bank is not' });
    if (!r.error) {
      this.tally.banked = (this.tally.banked || 0) + put;
      this.tradeFact({ banked: put });
      this.progress('banked money');
    }
  }
  // ================================================================== A FARM TOWN'S HALL AND CURSE ERRAND
  //
  // Operator, 2026-11-07, of the Farol farmers: "let them deposit in the guild chest instead of banking, also set them to
  // tithe for the guild rent", then "pick up magic weapons and deposit them in the guild chest if they are not cursed. If
  // they are cursed they should go sell in Marion, then buy a remove curse potion from the potion shop and drop their cursed
  // weapon before doing any buying they need and going back out farming", and "make sure they don't try to sell the cursed
  // weapon while it's equipped or it cancels the transaction". The decisions are pure (m59-farm-town.mjs); these read the
  // world, act, and read it back.

  /** The cursed weapon this body carries -- wielded first -- as { id, name, wielded }, or null. */
  cursedWeaponCarried(c = this.s?.client) {
    if (!c?.inventory) return null;
    const worn = skills.equippedNow(c);
    const suspect = this._curseSuspect?.certain ? this._curseSuspect : null;
    const rows = (c.inventory || []).map(o => ({ o, name: c.rsc?.get?.(o.nameRsc) || '' }))
      .filter(({ o, name }) => skills.weaponScore(name) > 0 && (Number(o.amount) || 0) <= 1 &&
        (skills.isCursedItem(c, o, name) || Number(o.rarity) === 200 || (suspect && suspect.id === o.id)))
      .map(({ o, name }) => ({ id: o.id, name, wielded: !!worn?.has?.(o.id) }))
      .sort((a, b) => Number(b.wielded) - Number(a.wielded));
    return rows[0] ?? null;
  }

  /** Loot magic weapons bound for the farm town's guild hall (isHallBoundWeapon), by id. [] without a hall. */
  hallBoundWeaponIds(c = this.s?.client, held = null) {
    const hall = this.policy?.farmTown?.hall;
    if (!hall?.magicWeapons || !c?.inventory) return [];
    const worn = skills.equippedNow(c);
    if (!worn) return [];                                // unknown equipment is not "nothing in hand"
    let keep = held;
    if (!keep) { keep = new Set(); try { const book = this.weaponMagicBook(); book.reconcile?.(this.packWeapons(c)); for (const id of book.keepIds()) keep.add(Number(id)); } catch {} }
    return (c.inventory || []).filter(o => {
      const name = c.rsc?.get?.(o.nameRsc) || '';
      return isHallBoundWeapon({ o, name, equipped: worn, held: keep, isWeapon: n => skills.weaponScore(n) > 0,
        cursed: skills.isCursedItem(c, o, name) || (this._curseSuspect?.certain && this._curseSuspect.id === o.id),
        ownSummon: skills.isOwnSummon(c, o) });
    }).map(o => Number(o.id));
  }

  /** What a farm town's sale must never offer: the cursed weapon and the hall's cargo (equipped gear is the sale's own rule). */
  saleExcludeIds() {
    const town = this.policy?.farmTown;
    if (!town?.hall && !town?.uncurse) return null;
    const out = new Set(this.hallBoundWeaponIds());
    const cursed = this.cursedWeaponCarried();
    if (cursed) out.add(Number(cursed.id));
    return out;
  }

  /**
   * Does a farm town errand open a trip by itself? { trigger: 'curse' | 'hall', why } or null. Each is bounded by a
   * cooldown, because a trip that cannot fix what opened it must not open again on the next pass.
   */
  farmTownErrand(carried = this.purseNow(), above = this.bankAboveNow(), now = Date.now()) {
    const town = this.policy?.farmTown;
    if (!town) return null;
    if (town.uncurse && now - (this._curseTripAt ?? 0) > 15 * 60_000 && now >= (this._curseStuckUntil ?? 0)) {
      const cursed = this.cursedWeaponCarried();
      if (cursed) return { trigger: 'curse', why: `${cursed.name} is cursed${cursed.wielded ? ' and in hand' : ''}: sell, then lift it in ${town.name ?? 'town'}` };
    }
    if (town.hall && now - (this._hallTripAt ?? 0) > 30 * 60_000) {
      const plan = hallDepositPlan(town, { purse: carried, keep: this.walkingFloat(), bankAbove: above,
        weapons: this.hallBoundWeaponIds().length });
      if (plan.go) return { trigger: 'hall', why: plan.why };
    }
    return null;
  }

  /** The hall road: every leg of a hall visit is a town trip past the confinement (Autopilot.travel townRoad). */
  hallJourney(origin = 'hall_deposit') {
    return (room, opts = {}) => this.travel(room, { ...opts, townRoad: true, origin: keeperOrigin(origin) });
  }

  /** The town trip's curse step: sold first (the 'sell' step ran), then potion, drink, drop -- and only then buying. */
  async farmTownCurseErrand(trip) {
    const town = this.policy?.farmTown;
    if (!town?.uncurse) return null;
    const s = this.s, c = s.need();
    const st = trip.curse ??= { tries: {}, started: Date.now() };
    if (st.finished) return null;
    const read = async () => {
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await c.waitFor({ kinds: ['inventory', 'equipment'], timeoutMs: 3000 }).catch(() => {});
    };
    const potionRe = new RegExp(`^${town.uncurse.item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?$`, 'i');
    for (let guard = 0; guard < 10; guard++) {
      if (this.travelInterrupted()) return { pending: true };
      if (st.fullUntil && Date.now() < st.fullUntil) return { pending: true };
      await read();
      const cursed = st.id != null
        ? (() => { const o = (c.inventory || []).find(x => x.id === st.id); return o ? { id: o.id, name: c.rsc.get(o.nameRsc) || st.name, wielded: !!skills.equippedNow(c)?.has?.(o.id) } : null; })()
        : this.cursedWeaponCarried(c);
      if (cursed && st.id == null) { st.id = cursed.id; st.name = cursed.name; }
      const potions = (c.inventory || []).filter(o => potionRe.test(c.rsc.get(o.nameRsc) || ''));
      const next = curseErrandNext({ cursed: st.id != null ? (cursed ?? { id: st.id, name: st.name, wielded: false }) : null,
        sold: true, potions: potions.reduce((n, o) => n + (o.amount || 1), 0),
        inPack: st.id != null && !!cursed, tries: st.tries });
      if (next.step === 'none') { st.finished = true; return null; }
      if (next.step === 'done' || next.step === 'stuck') {
        st.finished = true;
        if (next.step === 'stuck') this._curseStuckUntil = Date.now() + 60 * 60_000;
        this.note(next.step === 'done' ? 'CURSED WEAPON GONE — on to the shopping' : 'curse errand stuck — shopping anyway, retry in an hour',
          { weapon: st.name, why: next.why, tries: st.tries });
        try { this.ledgerEvent('farm_town_curse', { outcome: next.step, weapon: st.name, why: next.why, tries: st.tries,
          room: this.hereRoom?.() ?? null }); } catch {}
        if (next.step === 'done') this.clearCurseSuspect?.('the cursed weapon was dropped in town');
        return null;
      }
      if (next.step === 'buy_potion') {
        st.tries.buy = (st.tries.buy ?? 0) + 1;
        if (Number(s.world?.room?.num) !== town.uncurse.room) {
          const walked = await this.travel(town.uncurse.room, { origin: keeperOrigin('town_trip'), maxHops: 12 })
            .catch(e => ({ arrived: false, reason: e.message }));
          if (!walked?.arrived) { if (this.travelInterrupted()) return { pending: true }; continue; }
        }
        const pick = await this.sellerHere({ want: potionRe, named: town.uncurse.seller }).catch(() => null);
        const entry = pick?.items?.find(i => potionRe.test(String(i.name ?? '').trim()));
        if (!entry) { this.note('no remove curse potion on offer', { room: town.uncurse.room, seller: town.uncurse.seller }); continue; }
        if (entry.cost > 0 && this.purseNow() < entry.cost) {
          st.tries.buy = 99;
          this.note('cannot afford a remove curse potion', { cost: entry.cost, purse: this.purseNow() });
          continue;
        }
        const start = c.evSeq;
        await s.pacer.submit('buy', () => c.buy(pick.seller.id)).catch(() => {});
        const ev = await c.waitFor({ since: start, kinds: ['shop'], timeoutMs: 4000 }).catch(() => ({ events: [] }));
        const shop = ev.events?.find(e => e.kind === 'shop');
        const line = shop?.items?.find(i => potionRe.test(String(i.name ?? '').trim()));
        if (!line) continue;
        for (const l of buyLines([{ id: line.id, amount: 1 }]))
          await s.pacer.submit('buy', () => c.buyItems(shop.sellerId, [l])).catch(() => {});
        await new Promise(r => setTimeout(r, 700));
        this.recordPurchase?.(line.name, line.cost, { why: `remove curse for the ${st.name}` });
        continue;
      }
      if (next.step === 'drink') {
        st.tries.drink = (st.tries.drink ?? 0) + 1;
        const since = c.evSeq;
        await s.pacer.submit('act', () => c.apply(potions[0].id, c.selfId)).catch(() => {});
        const ev = await c.waitFor({ since, kinds: ['message'], timeoutMs: 3000 }).catch(() => ({ events: [] }));
        const said = (ev.events ?? []).map(e => String(e.text ?? '')).filter(Boolean);
        // TOO FULL TO DRINK (player.kod ReqEatSomething: a potion fills 10 of a 100 stomach). Not an attempt: wait.
        if (said.some(t => /too full/i.test(t))) {
          st.tries.drink--; st.full = (st.full ?? 0) + 1;
          if (st.full > 5) { st.tries.drink = 99; continue; }
          st.fullUntil = Date.now() + 60_000;
          this.note('too full to drink the remove curse potion — waiting a minute', { said: said.slice(0, 2) });
          return { pending: true };
        }
        await new Promise(r => setTimeout(r, 800));
        continue;
      }
      if (next.step === 'drop') {
        st.tries.drop = (st.tries.drop ?? 0) + 1;
        const o = (c.inventory || []).find(x => x.id === st.id);
        if (o) await s.pacer.submit('drop', () => c.drop([this.dropSpec(o)])).catch(() => {});
        await new Promise(r => setTimeout(r, 700));
        continue;
      }
    }
    return { pending: true };
  }

  /** The town trip's hall step: shillings over bank_above and the loot magic weapons into the guild hall's chests. */
  async farmTownHallVisit(trip) {
    const town = this.policy?.farmTown;
    if (!town?.hall) return null;
    // A visit already under way (survival paused it, or the keeper restarted mid-road) is finished first, on its own config.
    if (this.coopVisit?.cfg?.farmTownHall) {
      const r = await runReagentCoop(this, 'tithe', {}, TITHE_FLEET, this.hallJourney());
      if (r?.pending) return r;
      trip.hallVisitDone = true;
      return this.noteHallVisit(r);
    }
    if (trip.hallVisitDone) return null;
    const c = this.s.need();
    await this.s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory', 'equipment'], timeoutMs: 3000 }).catch(() => {});
    const keep = Math.max(this.walkingFloat() + this.standingOrderReserve(), this.shoppingPlan?.().required_purse ?? 0,
      trip.purchasePlan?.required_purse ?? 0);
    const ids = this.hallBoundWeaponIds(c);
    const plan = hallDepositPlan(town, { purse: this.purseNow(), keep, bankAbove: this.bankAboveNow(), weapons: ids.length });
    // On the way already (the rent tithe walked to Frular): weapons ride along whatever their count.
    const passing = [101, 700, town.hall.room].includes(Number(this.s.world?.room?.num)) && ids.length > 0;
    if (!plan.go && !passing) { trip.hallVisitDone = true; return null; }
    if (Date.now() < (this._hallNothingUntil ?? 0)) { trip.hallVisitDone = true; return null; }
    const returnTo = town.buy?.food?.[0]?.room ?? town.sell?.[0]?.room ?? Number(this.s.world?.room?.num);
    this.note('HALL VISIT — the guild chests instead of a bank', { why: plan.why || 'passing the hall with magic weapons',
      shillings: plan.shillings, weapons: ids.length, hall: town.hall.room, then: returnTo });
    const r = await runReagentCoop(this, 'tithe', { bankable: plan.shillings, returnTo, depositIds: ids,
      requestId: `farm-hall:${trip.startedAt}`, config: { ...hallVisitConfig(town.hall.room), farmTownHall: true } },
      TITHE_FLEET, this.hallJourney());
    if (r?.pending) return r;
    trip.hallVisitDone = true;
    return this.noteHallVisit(r);
  }

  noteHallVisit(r) {
    const moved = Number(r?.shillings ?? 0), weapons = r?.deposited ?? [];
    if (!moved && !weapons.length) this._hallNothingUntil = Date.now() + 30 * 60_000;
    this.note(moved || weapons.length ? 'deposited in the guild hall' : 'hall visit moved nothing', {
      shillings: moved, weapons: weapons.map(w => w.name), reason: r?.reason ?? null, deferred: !!r?.deferred });
    try { this.ledgerEvent('farm_town_hall', { shillings: moved, weapons: weapons.map(w => w.name),
      reason: r?.reason ?? null, deferred: !!r?.deferred }); } catch {}
    return r;
  }

  // @end 1
}
