// WHAT A SELL TRIP ON KO'CATAN MAY TAKE TO THE COUNTER -- pure, no socket, no roster.
//
// Prod 2026-10-27: island farmers filled their packs with island reagents (Sweetums 579 dragonfly eyes, Animal 385 eyes
// + 205 rainbow ferns, Waldorf 257 ferns + 192 uncut seraphym, Piggy 273 eyes + 239 ferns + 157 web moss) until they
// could not receive a weapon, conjure one ("unarmed and cannot hold what the spell would make") or loot. Their own sell
// trips sold the kriipa claws and web moss and walked home with the rest, and later trips were dropped outright: "pack
// full of kept stock; a sell trip would not relieve it". By hand at Zala ix'Mecya (2002) the same goods took Animal's
// purse 6446 -> 21452 and Sweetums' 1239 -> 18663. A buyer existed; the sale plan was holding the stock back:
//
//   * DRAGONFLY EYE AND UNCUT SERAPHYM were "protected item": the guild plan's `everyone` list (the dispel illusion
//     reagents, operator 2026-10-19) holds the WHOLE stack, by name, while any hall chest is short -- 4 eyes and 47
//     seraphym short, 579 eyes held -- and the deposit that would release them is a walk to the mainland hall (714)
//     that an islander cannot make. And "wanted by the fleet": Camilla, the dispeller in room 27, declared a dispel
//     illusion shortfall all day, which no islander can hand across the sea.
//   * RAINBOW FERN was a WEAPON: weaponScore's word list matched "rain-BOW fern" on /bow/ (m59-skills.mjs WEAPON_WORDS),
//     so the equipment plan kept it as "best spare weapon within max_weapons" whenever a hand was free. Fixed at the
//     root in weaponScore (a name the item index knows as a non-weapon class scores 0); this module does not need it.
//
// So, on the island only:
//   1. HOLDS FOR A DELIVERY THE ISLAND CANNOT MAKE do not hold an island reagent: the guild hall's wants (the `everyone`
//      list, guild_wants, the stockpile, the co-op's shortfall). The character's OWN lists -- protect_items,
//      vault_items, its loadout's keep and carry rows, the chalice, a holder's cargo -- still win, always.
//   2. A SMALL KEEP INSTEAD OF A HOARD: an island reagent this character can cast with keeps CASTS_KEPT casts' worth;
//      every other unit is surplus. Expressed as a loadout carry CEILING (min 0, max = the keep), the overlay the sale
//      plan already reads, so above it is "surplus above the loadout ceiling" -- which the sale plan sells even when
//      another character's want names it, because nobody on the mainland can be handed it from here. A carry row the
//      character's own loadout already has for the item is never replaced.
//
// Off the island nothing here is consulted: the mainland sale plan is exactly what it was.
//
// WHO BUYS THEM, from the kod: every one of these is a NumberItem, and NumberItem declares
// `viItem_type = ITEMTYPE_REAGENT` (numbitem.kod:40) with only gems, food, ammo and money overriding it -- so uncut and
// polished seraphym are reagents and NOT gems (IsObjectGem is JewelofFroz/Emerald/Ruby/Sapphire/Diamond/Ring,
// monster.kod:4198). Zala ix'Mecya buys any reagent that is not a gem (kcapoth.kod:49), MOB_BUYER at
// MERCHANT_EXPENSIVE (60% of value, monster.kod:3137), with no shelf to fill. Pacal ix'Anoak's store (kcshopk.kod:209)
// pays the same 60% but holds a finite shelf (25 distinct, 5500 of a stack), so the island circuit offers the
// specialists first and the store last (m59-autopilot.mjs ISLAND_MARKET_STOPS).

// What the island's farms drop that Zala buys, from the treasure tables: avart.kod:30 (avar warriors: fern, kriipa claw,
// web moss, uncut seraphym, yrxl sap), dflyt.kod:30 (dragonflies: dragonfly eye, web moss, fern, kriipa claw, yrxl sap),
// avarsht.kod (avar shamans: shaman blood, yrxl sap, web moss, fern, kriipa claw, uncut and polished seraphym).
export const ISLAND_REAGENTS = Object.freeze([
  'dragonfly eye', 'rainbow fern', 'web moss', 'kriipa claw', 'yrxl sap',
  'uncut seraphym', 'polished seraphym', 'shaman blood',
]);

// Casts' worth of a reagent a caster keeps back from the counter. Small on purpose: the island's farms drop these by the
// hundred, and a caster that wants a real stock says so in its loadout, which wins.
export const CASTS_KEPT = 10;

// The spell catalogue spells reagents as class names ("yrxlsap", "fire sand"), the pack as item names ("yrxl sap").
const compact = name => String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ISLAND_KEYS = new Map(ISLAND_REAGENTS.map(n => [compact(n), n]));

/** The island reagent this name is, or null. */
export function islandReagent(name) {
  return ISLAND_KEYS.get(compact(name)) ?? null;
}

/**
 * How much of each island reagent this character keeps for its own casting: CASTS_KEPT casts of the dearest known spell
 * that uses it. `spells` are the names the server says the character knows; `cost(name)` answers
 * `{ reagents: [[item, n], ...] }` or null (m59-deskpractice.mjs spellCost). An unknown spell list keeps nothing.
 *
 * `keep` is { spell: casts } that must outlast a sale -- the PvP reserve plus the training stock
 * (m59-reagent-reserve.mjs keptCastsFor). A spell named there keeps the larger of the two. Operator, 2026-10-30:
 * "training should be the second-to-highest priority use of reagents (after PVP) ... selling is behind vaulting": Robin's
 * sell trip at Wulfgang sold 10 kriipa claws a minute before 28 more were handed to it for deflect practice.
 */
export function islandCastReserve(spells = [], { cost, casts = CASTS_KEPT, keep = {} } = {}) {
  const out = {};
  if (typeof cost !== 'function') return out;
  for (const spell of spells ?? []) {
    let c = null;
    try { c = cost(String(spell ?? '')); } catch { c = null; }
    for (const [item, n] of c?.reagents ?? []) {
      const r = islandReagent(item);
      if (!r) continue;
      const want = Math.max(casts, Number(keep?.[String(spell ?? '').trim().toLowerCase()]) || 0);
      out[r] = Math.max(out[r] ?? 0, Math.max(1, Number(n) || 1) * want);
    }
  }
  return out;
}

const sameItem = (a, b) => compact(a) === compact(b);

/**
 * The loadout a sale plan reads on the island: the character's own, plus a carry ceiling for every island reagent it has
 * no row for (min 0, max = its cast reserve, usually 0). A null loadout becomes one that says nothing but those rows.
 */
export function islandSaleLoadout(loadout, reserve = {}) {
  const base = loadout ?? null;
  const carry = [...(base?.carry ?? [])];
  const rows = [];
  for (const item of ISLAND_REAGENTS) {
    if (carry.some(row => sameItem(row?.item, item))) continue;
    const keep = Math.max(0, Math.floor(Number(reserve?.[item]) || 0));
    rows.push({ item, min: 0, max: keep, match: 'exact', kind: 'reagent', island_sale: true,
                why: keep ? `island sale: ${keep} kept for this character's own casting` :
                            'island sale: surplus goes to Zala ix\'Mecya (2002)' });
  }
  if (!rows.length) return base;
  return {
    ...(base ?? { keep: [], sell: [], gear: { weapon: [], slots: {} }, character: null }),
    keep: base?.keep ?? [], sell: base?.sell ?? [], gear: base?.gear ?? { weapon: [], slots: {} },
    carry: [...carry, ...rows],
  };
}

/**
 * The protect list a sale reads on the island: `protect` without the island reagents that only an unreachable delivery
 * holds. `own` is every name the character's own orders protect; an island reagent named there stays protected.
 */
export function releaseIslandHolds(protect = [], own = []) {
  const mine = new Set((own ?? []).map(compact));
  return (protect ?? []).filter(name => !islandReagent(name) || mine.has(compact(name)));
}
