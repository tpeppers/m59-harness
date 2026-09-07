// WHAT IS IN THE PACK DECIDES WHERE THE TRIP GOES.
import { readFileSync } from 'node:fs';
import { foodValue } from './m59-items.mjs';
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

// A MUSHROOM IS USUALLY A REAGENT AND SOMETIMES A MEAL, and only the name tells you which.
// Five grow in this world. `mushroom` — the one players call a "brown", and note it carries
// no adjective at all — plus `red mushroom` and `blue mushroom` are casting reagents.
// `edible mushroom` and `Inky-cap mushroom` are in the game's own Food class tree, at
// nutrition 5 and 50 (m59-items.json; the other three are absent from it entirely).
//
// The reagent pattern cannot help matching all five, because `mushroom` is a substring of
// `edible mushroom`. So FOOD is tested FIRST in classifyPack and names the two edible ones
// explicitly. Before that, an `edible mushroom` was filed as sellable stock, and the
// Inky-cap — fifty vigor a bite, the best food this fleet can carry — escaped being sold
// only by accident, because VAULTABLE happens to contain `inky`.
const REAGENT = /\b(herb|elderberry|mushroom|dragon scale|silver|orb)\b/i;
// FOOD IS NOT A WORD LIST HERE ANY MORE. It was, and the list drifted from the game.
//
// `spider eye`, `bunch of grapes` and `fortune cookie` are all Food in the class tree and
// all three were filed as `other` — sellable stock — by the pattern below. The spider eye is
// the expensive one: it is one of the seven things the Duke's tables hand out, nutrition 9,
// the same as a slice of pork, and the fleet was carrying six hundred of them.
//
// The keeper's own eating has always asked `isFood`, with a comment saying that guessing by
// name is the mistake. This is that comment applied here. The table is built from the game's
// Food class tree, so it cannot miss one and cannot be argued with.
//
// The regex survives as a NARROW fallback for a name the table does not know — a renamed
// item, a fresh extraction, a caller passing a description rather than a name — because a
// classifier that goes blind when its table is stale is worse than one that guesses.
const FOOD_FALLBACK = /\b(bread|cheese|pie|apple|grape|drumstick|turkey|pork|soup|wine|stout|ale|brew|water skin|snack|edible mushroom|inky-?cap mushroom|spider eye|fortune cookie)\b/i;
const isFoodName = (n) => {
  try { if (foodValue(n)) return true; } catch { /* fall through to the pattern */ }
  return FOOD_FALLBACK.test(n);
};

// Worth more kept than sold. Read off the Castle Victoria loot survey: wands and scrolls have
// their spoil timer disabled (piGoBadTime = -1) so they never rot, the ring of invisibility
// only spends charges while worn, and the rose is not consumed when used.
const VAULTABLE = /\b(wand|scroll|rose|ring of invisibility|mystic sword|true lute|dragon scale|angel feather|shrunken head|inky)\b/i;

// AND WHATEVER ELSE THIS FLEET HAS LEARNED IS WORTH KEEPING.
//
// The list above is a MECHANIC -- those items do not rot (piGoBadTime = -1), so keeping them
// is a fact about the game and belongs in git. WHICH magical items a particular fleet
// recognises on a particular server is a BET that changes as it learns, and editing a tracked
// regex to record it puts this repository's history in the middle of somebody's loot table.
//
// So `substrate/dumbot/magical-items.local.json` may add names. ABSENT IS NOT EMPTY: an
// absent file is the shipped list unchanged, the rule every other overlay here follows
// (policy.local.json, watchdog.local.json, the loadouts). It can only ADD -- a private file
// cannot make a wand sellable, because the reason wands are kept is that they do not rot,
// and that reason is not ours to overrule.
//
// Names are ESCAPED rather than pasted into a pattern. A stray bracket in a hand-edited list
// would otherwise throw at import and take the classifier with it, and a classifier that
// throws here routes every trip as though the pack were empty -- which is a road death, not
// a syntax error.
const PRIVATE_VAULTABLE = (() => {
  try {
    const file = new URL('../substrate/dumbot/magical-items.local.json', import.meta.url);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const names = (doc.keep || doc.vaultable || [])
      .filter((n) => typeof n === 'string' && n.trim());
    if (!names.length) return null;
    const esc = names.map((n) => n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp('(?:' + esc.join('|') + ')', 'i');
  } catch { return null; }
})();

/** Kept rather than sold: the shipped mechanic, plus whatever this fleet has added. */
export function isVaultable(name) {
  return VAULTABLE.test(name) || (PRIVATE_VAULTABLE ? PRIVATE_VAULTABLE.test(name) : false);
}

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
    if (isVaultable(n)) { out.vaultable.push(n); continue; }
    if (WEAPON.test(n) || WEARABLE.test(n)) { out.smithOnly.push(n); continue; }
    if (GEM.test(n)) { out.gems.push(n); continue; }
    // FOOD BEFORE REAGENT — the overlap is one-way and only this order resolves it. See the
    // note on the two patterns: three mushrooms are reagents, two are meals, and the reagent
    // pattern matches all five whatever it says.
    if (isFoodName(n)) { out.food.push(n); continue; }
    if (REAGENT.test(n)) { out.reagents.push(n); continue; }
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
