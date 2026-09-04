// WHAT IS IN THE PACK DECIDES WHERE THE TRIP GOES.
//
//   import { classifyPack, routeFor } from './m59-smartloot.mjs';
//
// A character leaving Castle Victoria for supplies is carrying whatever it killed for, and
// the shape of that pile decides the route:
//
//   * only reagents, food and gems  -> TOS ONLY. Bank, apothecary and inn are all in one
//     town, so the trip is short. Nothing in the pack needs a smith and nothing needs a
//     vault it cannot reach, so the Barloque leg is four or five minutes spent on nothing.
//   * weapons, armour or shields    -> VIA BARLOQUE. Only a smith buys those, and Barloque
//     is the smith we can route to. Barloque also has the vault, so once the detour is
//     forced the vaulting is free — same rooms, no extra stop.
//
// THE POINT IS THE SKIP, NOT THE DETOUR. Deciding to go to Barloque is easy; deciding NOT to
// is what saves the time, and it can only be decided from the pack. Four road deaths in one
// night here came from characters on the roads longer than they needed to be.
//
// PURE. No broker, no fetch, no fleet: it takes a list of item names and returns a decision,
// so it is testable offline and cannot disagree with itself between a plan and a run.

// The kod categories, which are NOT the item kinds and which nothing else groups this way —
// `ObjectDesired` per merchant class, transcribed in m59-buyers.mjs. A smith is the only
// buyer for the first two, and that is the whole routing question.
const WEAPON = /\b(sword|hammer|mace|axe|dagger|scimitar|halberd|staff|club|cudgel|bow|crossbow|sling|falchion|katana|rapier|spear|flail|morning ?star)\b/i;
const WEARABLE = /\b(armor|armour|shield|helm|helmet|gauntlet|pants|leggings|jerkin|breastplate|chain ?mail|scale ?mail|undershirt)\b/i;

// Gems are ALSO reagents, which is why three of the four apothecaries name the exclusion
// explicitly — so a pack of gems cannot be emptied at an apothecary. They are 1 weight and
// 1 bulk though, so the answer is to vault them rather than to route a trip around them.
const GEM = /\b(emerald|sapphire|diamond|ruby|jewel)\b/i;

const REAGENT = /\b(herb|elderberry|mushroom|dragon scale|silver|orb)\b/i;
const FOOD = /\b(bread|cheese|pie|apple|grape|drumstick|turkey|pork|soup|wine|stout|ale|brew|water skin|snack)\b/i;

// Worth more kept than sold. Read off the Castle Victoria loot survey: wands and scrolls have
// their spoil timer disabled (piGoBadTime = -1) so they never rot, the ring of invisibility
// only spends charges while worn, and the rose is not consumed when used.
const VAULTABLE = /\b(wand|scroll|rose|ring of invisibility|mystic sword|true lute|dragon scale|angel feather|shrunken head|inky)\b/i;

// NEVER OFFER, NEVER WIELD. The amulet equips itself and cannot be removed; a cursed weapon
// clings to the hand for the life of the character. Both are handled elsewhere too — this is
// so a classification never quietly counts one as sellable stock.
const NEVER = /\b(amulet of shadows|ring of lethargy)\b|\bcursed\b/i;

const nameOf = i => String(typeof i === 'string' ? i : (i?.name ?? ''));
const countOf = i => (typeof i === 'string' ? 1 : (i?.amount ?? 1));

/**
 * Sort a pack into the piles that decide a route.
 *
 * `smithOnly` is the load-bearing one: it is the set nothing in a reagent town will buy.
 */
export function classifyPack(items = []) {
  const out = { smithOnly: [], reagents: [], gems: [], food: [], vaultable: [], never: [], other: [] };
  for (const item of items) {
    const n = nameOf(item);
    if (!n || /shilling/i.test(n)) continue;          // money is not cargo
    if (NEVER.test(n)) { out.never.push(n); continue; }
    // Vaultable first: a mystic sword is a weapon and a wand is not a reagent, and in both
    // cases what it IS matters less than the fact we are not selling it.
    if (VAULTABLE.test(n)) { out.vaultable.push(n); continue; }
    if (WEAPON.test(n) || WEARABLE.test(n)) { out.smithOnly.push(n); continue; }
    if (GEM.test(n)) { out.gems.push(n); continue; }
    if (REAGENT.test(n)) { out.reagents.push(n); continue; }
    if (FOOD.test(n)) { out.food.push(n); continue; }
    out.other.push(n);
  }
  out.stacks = items.filter(i => nameOf(i) && !/shilling/i.test(nameOf(i))).length;
  out.pieces = items.reduce((n, i) => n + (nameOf(i) && !/shilling/i.test(nameOf(i)) ? countOf(i) : 0), 0);
  return out;
}

/**
 * Where this trip has to go.
 *
 * Returns `{ viaBarloque, why, vaultHere, sellSmith, sellApothecary }`.
 *
 * A caller keeps its own room numbers — this decides the SHAPE, not the map, so a fleet that
 * sells somewhere else changes one table rather than this reasoning.
 */
export function routeFor(pack, { alwaysVault = false } = {}) {
  const needsSmith = pack.smithOnly.length > 0;
  // A vault detour is only worth forcing if we are going anyway. Barloque is four or five
  // minutes each way, and the vault items are small — a wand is 3 weight, a scroll 3, a ring
  // of invisibility 10 — so carrying them one more lap costs almost nothing and a needless
  // lap on these roads has killed people.
  const viaBarloque = needsSmith || (alwaysVault && pack.vaultable.length > 0);
  return {
    viaBarloque,
    why: needsSmith
      ? `${pack.smithOnly.length} item(s) only a smith buys: ${[...new Set(pack.smithOnly)].slice(0, 4).join(', ')}`
      : pack.vaultable.length && alwaysVault
        ? `${pack.vaultable.length} vaultable item(s) and alwaysVault is set`
        : 'nothing needs a smith — the reagent town is enough',
    // Free once the detour is forced: the vault and the smith are the same trip.
    vaultHere: viaBarloque && pack.vaultable.length > 0,
    sellSmith: pack.smithOnly.length,
    // What an apothecary will actually take. Gems are excluded on purpose: they ARE reagents
    // and the apothecaries refuse them anyway, so they ride home to the vault.
    sellApothecary: pack.reagents.length + pack.food.length + pack.other.length,
    carryHome: pack.vaultable.length + pack.gems.length,
  };
}
