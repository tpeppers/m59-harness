// INVENTORY: what may not be sold, given or eaten, and the larder.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 13 methods: carryFloors, protectedItemNames, inheritedProtectedNames, stockpileKeptNames,
//   chestSourcedNames, saleProtectedNames, islandSaleRelease, saleLoadout, guildWantedNames, notOursToEat, larder,
//   giveableLarder, uneatableReserve
import { CHALICE } from '../m59-chalice.mjs';
import { restrictPlan } from '../m59-curse-cycle.mjs';
import { spellCost } from '../m59-deskpractice.mjs';
import { guildKeepTest, guildPlan, reagentSource } from '../m59-guildwants.mjs';
import { islandCastReserve, islandSaleLoadout, releaseIslandHolds } from '../m59-island-sale.mjs';
import { listLoadouts, norm } from '../m59-loadout.mjs';
import * as skills from '../m59-skills.mjs';
import { stockpileKeepTest } from '../m59-stockpile.mjs';
import { StorageCache } from '../m59-storage.mjs';
import { onIsland } from '../m59-autopilot.mjs';
import { dispositionNames } from '../m59-loot-policy-runtime.mjs';

export class InventoryPart {
  // @part 1

  /**
   * The loadout's carry MINIMUMS, as {name: min}, for the overfarm eviction.
   *
   * `protectedItemNames()` above answers "may this be given up at all", which is a name and
   * therefore all-or-nothing. This answers "how much of it must stay", which is what lets a
   * reagent OVERFLOW: keep the floor, offer the surplus. Without it a character one tooth
   * over its floor protected the entire stack and could free nothing for anything better.
   *
   * Only positive minimums are reported. A floor of zero is not a floor -- it is an entry
   * with nothing to say -- and emitting it as `0` would read downstream as "all of this is
   * surplus", which is the opposite of silence.
   */
  carryFloors() {
    const out = {};
    for (const row of (this.loadout()?.carry ?? [])) {
      const name = String(row?.item ?? '').trim();
      const min = Number(row?.min);
      if (name && Number.isFinite(min) && min > 0) out[name] = min;
    }
    return out;
  }

  protectedItemNames({ dispositions = true } = {}) {
    return [...new Set([
      ...(dispositions ? dispositionNames(this) : []),
      // A matched loot disposition (m59-loot-policies.mjs) supersedes this old destination preference;
      // hard keeps below remain. Sale planning checks the individual object (quality can differ by ID).
      ...(Array.isArray(this.policy.vaultItems) ? this.policy.vaultItems.filter(name => !this.s.lootDisposition?.({ name })) : []),
      ...(Array.isArray(this.policy.protectedItems) ? this.policy.protectedItems : []),
      ...this.inheritedProtectedNames(),
    ].map(String).filter(Boolean))];
  }

  // Everything protectedItemNames holds back EXCEPT this character's own two keep lists.
  // Split out because the larder needs exactly this: see larder().
  inheritedProtectedNames() {
    return [...new Set([
      // AND WHATEVER THE GUILD IS STILL SHORT OF, which is the half of the overflow rule
      // that has to hold on the sell paths this town trip does not own. The order is
      // pack -> own floor -> guild chests -> sold -> banked, so an item is held back from
      // the vendor exactly while a chest still wants it and becomes sellable the moment
      // the plan is met. Without the release half, a full hall would mean a fleet that
      // could never sell anything again.
      ...this.guildWantedNames(),
      ...this.stockpileKeptNames(),
      ...this.chestSourcedNames(),
      // The fleet's chalice is never sold, eaten or evicted for loot. The hand-off drops it
      // deliberately, by id, which none of the protect lists govern.
      ...(this.chaliceCfg ? [CHALICE.name] : []),
      // AND WHAT THE CURSE CYCLE KEEPS FOR THE GUILD HALL (m59-curse-cycle.mjs `keep`).
      ...(this._curseCycleCfg?.keep ?? []),
      // AND THE HOLDER'S RESTOCK while it is being carried: it is somebody else's.
      ...(this._holderCargo ? Object.keys(this._holderCargo.items) : []),
      // AND THE WEAPON THE ROULETTE IS WORKING TOWARDS. A summon cannot be sold, so every
      // value ranking prices it at nothing, and overfarm's trade-up dropped each conjured
      // hammer between seconds and three minutes after the hit — Animal, Floyd and Sweetums on
      // prod 2026-09-25, all with full packs. Held only while the skill is under 70.
      ...(this.rouletteTarget?.()?.want ? [this.rouletteTarget().want] : []),
    ].map(String).filter(Boolean))];
  }

  // Cheap on the common path: no plan, or the flag off, returns [] without touching disk
  // beyond the mtime stat `guildPlan` already does.
  // WHAT THE FLEET USES, KEPT FROM THE MERCHANT — on top of what the guild plan is short of.
  //
  // `guildKeepTest` alone keeps an item only while a chest target is unmet, so the moment the
  // target is reached the next character sells its elderberry and the fleet buys it back at
  // the spread a day later. A want is a moment; a use is a standing fact. This adds the
  // standing half: anything ANY character in the fleet declares a floor for — in its loadout
  // or in its reagentTarget policy — is never sold while there is a chest to hold it.
  stockpileKeptNames() {
    if (this.policy.reagentCoop?.enabled) return [];
    if (!this.policy.guildWants?.enabled) return [];
    try {
      const store = new StorageCache();
      const chests = store.allChests();
      // The same availability gate the deposit half uses: with no usable store this must get
      // out of the way rather than fill every pack with unsellable herbs.
      const available = chests.some(ch => ch && !ch.never_opened);
      const characters = listLoadouts()
        .filter(l => l.loadout)
        .map(l => ({ loadout: l.loadout }));
      // This character's own policy target counts too — it is the signal that actually drives
      // buying, and on this fleet most loadout floors are zero while the targets are live.
      characters.push({ loadout: this.loadout() ?? { carry: [] }, policy: this.policy });
      const test = stockpileKeepTest({ characters, available });
      return [...(test.inUse ?? new Set())];
    } catch { return []; }
  }

  /**
   * REAGENTS THE GUILD SOURCES FROM ITS OWN CHEST, KEPT AWAY FROM EVERY MERCHANT.
   *
   * The other half of `chest`, and the half that was missing. `guildWantedNames` protects what the
   * chest is SHORT of, which is a want about quantity and goes away the moment a target is met.
   * This is about DIRECTION and does not: a guild that buys its sapphires out of its own chest
   * must never be selling sapphires at 60% on the same trip, whatever the chest holds this minute.
   *
   * IT IS NOT GATED ON `reagentCoop.enabled`, unlike its two neighbours, and that is deliberate
   * rather than an oversight. That gate is backwards — it switched the chest off for exactly the
   * characters the co-op was switched ON for — when depositing and drawing are opposite directions
   * through the same door. A fleet that stocks its own chest is precisely the fleet that should be
   * shopping from it.
   */
  chestSourcedNames() {
    try {
      const plan = guildPlan();
      if (!plan) return [];
      const named = new Set();
      // Everything this character has an opinion about, plus everything the guild names. A
      // guild-wide `default: "chest"` cannot be enumerated — it applies to reagents nobody has
      // written down — so the list is what is ASKED for, resolved one at a time at the call site.
      for (const r of (this.purchaseRequests?.() ?? [])) named.add(String(r.item));
      for (const c of (this.loadout()?.carry ?? [])) if (c?.item) named.add(String(c.item));
      return [...named].filter(item => reagentSource(item, { plan, policy: this.policy }) === 'chest');
    } catch { return []; }
  }

  // WHAT THE GUILD PLAN IS SHORT OF, KEPT FROM THE FLOOR AND THE MERCHANT UNTIL IT IS DEPOSITED.
  //
  // THE CO-OP OWNS ITS REAGENTS AND NOTHING ELSE. This returned [] for every co-op member, so a
  // guild want that is not a co-op reagent — armour, weapons, raid stock — was unprotected for
  // exactly the characters the co-op switched on: dropped as a banned weapon or sold on the
  // next trip before the deposit could take it. Same backwards gate chestSourcedNames already
  // records. Measured 2026-09-25: 7 of the 8 Icky Cave crew are co-op members, and the order
  // was "drop scimitars as needed, but deposit 20+ in the guild chest" — scimitars are banned
  // for them, so without this every one was dropped. Now only the co-op's own reagent list
  // is excluded, and everything else the plan is short of is protected while it is short.
  // WHAT A MERCHANT MAY NOT HAVE, which is a little more than what may not leave the pack.
  //
  // Operator, 2026-10-05: purple mushrooms "never sell unless overstocked versus plan on the hall
  // chests". guildWantedNames already says exactly that -- except for the co-op's own reagents,
  // which it leaves to the co-op because the co-op deposits them. But the co-op deposits only
  // when it visits the hall, and a co-op member standing at Joguer or Herbutte with purple in
  // its pack could sell them while the hall was 388 short of the plan (38 of 426).
  //
  // So the SALE paths also hold back every co-op reagent the plan is short of. Only the sale
  // paths: protectedItemNames() is also the co-op's deposit filter, and adding them THERE is the
  // 2026-09-17 deadlock (unsellable and undepositable). Over the plan, they sell as before.
  saleProtectedNames() {
    const base = this.protectedItemNames({ dispositions: false });
    // On Ko'catan, less the holds the island cannot deliver (islandSaleRelease). Off the island, the identity.
    const release = names => (typeof this.islandSaleRelease === 'function' ? this.islandSaleRelease(names) : names);
    if (!this.policy.reagentCoop?.enabled) return release(base);
    try {
      const plan = guildPlan();
      if (!plan) return release(base);
      const coop = new Set((this.policy.reagentCoop.reagents ?? []).map(r => norm(r)));
      const store = new StorageCache();
      const test = guildKeepTest({ plan, chests: store.allChests(), rent: store.readRent() });
      const short = [...(test.shortfall ?? new Map())].filter(([item, n]) => n > 0 && coop.has(norm(item)))
        .map(([item]) => item);
      return release([...new Set([...base, ...short])]);
    } catch { return release(base); }
  }

  // ON KO'CATAN, A HOLD FOR A DELIVERY THE ISLAND CANNOT MAKE DOES NOT HOLD AN ISLAND REAGENT (m59-island-sale.mjs).
  // The guild's wants -- the plan's `everyone` dispel reagents, guild_wants, the stockpile, the co-op's shortfall -- are
  // deposited in the mainland hall (714), and a trip from the island never leaves it. Prod 2026-10-27: 4 dragonfly eyes
  // short in a hall chest held 579 in Sweetums' pack, by name, and his sell trips walked home with them. This
  // character's OWN orders still protect: protect_items, vault_items, its loadout's keep list, the guild-chest
  // direction (chestSourcedNames), the chalice, a holder's cargo, the roulette's weapon. Off the island: unchanged.
  islandSaleRelease(names) {
    if (!onIsland(this.s?.world?.room?.num)) return names;
    const own = [
      ...(Array.isArray(this.policy.vaultItems) ? this.policy.vaultItems : []),
      ...(Array.isArray(this.policy.protectedItems) ? this.policy.protectedItems : []),
      ...(this.loadout?.()?.keep ?? []),
      ...this.chestSourcedNames(),
      ...(this.chaliceCfg ? [CHALICE.name] : []),
      ...(this._curseCycleCfg?.keep ?? []),
      ...(this._holderCargo ? Object.keys(this._holderCargo.items) : []),
      ...(this.rouletteTarget?.()?.want ? [this.rouletteTarget().want] : []),
    ];
    return releaseIslandHolds(names, own);
  }

  // THE LOADOUT A SALE PLAN READS. Off the island, the character's own (this.loadout()) -- unchanged. On Ko'catan, the
  // same plus a carry CEILING for each island reagent it has no row for: the casts it can make with it kept
  // (islandCastReserve, from the spells the server says it knows), the rest "surplus above the loadout ceiling", which the
  // sale plan sells to the counter that buys it even while a mainland character's want names it -- nobody there can be
  // handed it from here. Every path that SELLS reads this; what the character carries and asks the fleet for does not.
  saleLoadout() {
    const own = this.loadout?.() ?? null;
    if (!onIsland(this.s?.world?.room?.num)) return own;
    const c = this.s?.client;
    const spells = (c?.spells ?? []).map(sp => c?.rsc?.get?.(sp.nameRsc) ?? sp?.name).filter(Boolean);
    return islandSaleLoadout(own, islandCastReserve(spells, { cost: spellCost }));
  }

  guildWantedNames() {
    // WITHOUT GUILD WANTS OF ITS OWN a character still holds back the plan's `everyone` items while a chest is
    // short of them (m59-guildwants.mjs normaliseEveryone; operator 2026-10-19, the dispel illusion reagents).
    const full = guildPlan();
    const everyone = this.policy.guildWants?.enabled ? null : (full?.everyone ?? []);
    if (everyone && !everyone.length) return [];
    const plan = everyone ? restrictPlan(full, everyone) : full;
    if (!plan) return [];
    const coopOwns = this.policy.reagentCoop?.enabled
      ? new Set((this.policy.reagentCoop.reagents ?? []).map(r => norm(r))) : null;
    try {
      const store = new StorageCache();
      const test = guildKeepTest({ plan, chests: store.allChests(), rent: store.readRent() });
      return [...(test.shortfall ?? new Map())].filter(([, short]) => short > 0).map(([item]) => item)
        .filter(item => !coopOwns?.has(norm(item)));
    } catch { return []; }
  }

  // The keeper's usable larder. Centralising the filter is what keeps hunger, town-trip
  // decisions and the actual eat call in agreement.
  //
  // VAULTED AND PROTECTED IS NOT UNEATABLE. `vaultItems` and `protectedItems` say what must
  // not be sold, dropped or evicted; they never meant "not food". Excluding them here made
  // every inky-cap invisible to the keeper, because the vault strategy lists them to cap the
  // vault at fifty — measured on prod 2026-09-27: 22 of 24 characters listed them, 12 of 21
  // sat at the 80 resting cap, several carrying 2-10 inkies, and `has_food` read false on
  // Beaker holding eight. WHEN to spend a scarce food is the food preference's job
  // (larderOf's `held`), not the keep lists'. What still excludes is everything that is not
  // this character's to eat: the guild's shortfall, the chalice, the holder's cargo.
  // WHAT IS NOT THIS CHARACTER'S TO EAT: the fleet's chalice, a holder's cargo (somebody else's
  // restock), the weapon the roulette is working towards. NOT the sell protections — guild wants,
  // the stockpile, chest-sourced reagents keep an item from a MERCHANT, and eating it is spending
  // it on the character that owns it (see giveableLarder). 2026-09-28: a bread floor on one
  // loadout made bread fleet "stockpile" stock, the larder excluded it, and the whole troll crew
  // sat at 80 vigor with bread aboard ("out of food" after the pies, 9 of 14 overdrives).
  notOursToEat() {
    return [...new Set([
      ...(this.chaliceCfg ? [CHALICE.name] : []),
      ...(this._holderCargo ? Object.keys(this._holderCargo.items) : []),
      ...(this.rouletteTarget?.()?.want ? [this.rouletteTarget().want] : []),
    ].map(String).filter(Boolean))];
  }

  larder(c = this.s.client) {
    return skills.larderOf(c, { exclude: this.notOursToEat() });
  }

  // What this character may hand to someone else. Eating an inky is spending it on the
  // character that owns it; giving one away is a different decision, and the keep lists
  // still govern that one.
  giveableLarder(c = this.s.client) {
    return skills.larderOf(c, { exclude: this.protectedItemNames() });
  }

  // THE BIGGEST THING IN THE PACK THAT CANNOT BE EATEN YET, or null. "Cannot be eaten"
  // means eating it would carry vigor past the 200 cap, which is the one case where
  // holding more food does not help and waiting cannot clear.
  //
  // Returns the largest such item rather than the first: it is the one that most justifies
  // going to burn vigor, and it is the one the character is saving anyway.
  uneatableReserve(vigor) {
    if (vigor == null) return null;
    let best = null;
    for (const item of this.larder(this.s.client)) {
      const n = Number(item.food?.nutrition ?? item.nutrition ?? 0);
      if (!(n > 0)) continue;
      if (vigor + n <= 200) return null;      // something fits: eat it instead of fighting
      if (!best || n > best.nutrition) best = { name: item.name, nutrition: n };
    }
    return best;
  }
  // @end 1
}
