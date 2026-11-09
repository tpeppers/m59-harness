// A FARM'S OWN TOWN: WHICH COUNTERS A TOWN TRIP USES, AND WHAT IT MAY BUY AT THEM.
//
//   import { normalizeFarmTown, farmTownTable, farmTownAllowsKind, farmTownMenu,
//            farmTownSeller, farmTownOutfit } from './m59-farm-town.mjs';
//
// Operator, 2026-11-07, of the Farol mollusk farmers (546 Deep in the Forest of Farol): "buy/sell in marion for
// shopping (allowed: axes & leather armor from colhorr, bread from tova in the inn, also create food from reagents ...)".
//
// Until this, the keeper's town was decided by WHERE IT STOOD (m59-autopilot.mjs townTable): the Avar Village's trading
// post, Ko'catan on the island, and Barloque/Tos/Jasper everywhere else -- so a farmer in the Forest of Farol, two rooms
// from Marion, walked to Barloque to sell and to Tos for bread. A strategy now names its town:
//
//   town: {
//     name: 'Marion',
//     sell: [{ seller: 'Morrigan', room: 202 }, { seller: 'Colhorr', room: 201 }],
//     buy: {
//       food:    [{ seller: 'Tova', room: 202, items: ['loaf of bread'] }],
//       weapons: [{ seller: 'Colhorr', room: 201, items: ['axe'] }],
//       armor:   [{ seller: 'Colhorr', room: 201, items: ['leather armor'] }],
//     },
//     bank: null,
//     keep: ['elderberry', 'herbs', 'edible mushroom'],
//     sellReserve: { mushroom: 48, 'red mushroom': 24 },
//   }
//
// WHAT IT CHANGES, AND ONLY THAT (silence is the old townTable, exactly):
//   * every town trip on the MAINLAND goes to these counters and no others -- the sell circuit is `sell` in order, the
//     food shops are `buy.food`, the apothecary is `buy.reagents[0]`, the bank is `bank` (none: the purse rides, as in the
//     Avar Village). The island and the Avar Village keep their own towns: a trip from there never crosses back.
//   * a kind with no counter is not bought at all (purchaseEnabled): no reagents line above means no reagent purchase,
//     anywhere, which is the operator's "allowed" list read as an allowlist rather than a preference.
//   * a counter sells only its listed items to us (farmTownMenu), whoever else stands in the room;
//   * a sale goes to the NAMED seller (farmTownSeller), not to the SELL_TO allowlist -- which names neither Marion man.
//     Both quote a price before taking anything (sellAll refuses an unquoted sale), so naming a counter that pays nothing
//     costs a refused offer, never the item;
//   * `keep` is never offered at these counters. It is a SALE exclusion only, not `protect`: a kept elderberry is still a
//     spare a fleet-mate who ran dry may be handed (m59-sharing.mjs), which `protect` would forbid.
//   * `sellReserve` makes only excess units available at those counters and enables pack-triggered sales without a banking threshold.
//
// WHOLE ITEM NAMES, like lootOnly and the supply tool: "loaf of bread", not "bread" (the broker's resolveItemName refuses
// the abbreviation and says what it meant). Seller names match the NPC's own name case-blind, as a word sequence, so
// "Colhorr" is the smith and "Tova" the bartender.
//
// PURE. No client, no session, no file: the keeper and the outfit errand hand in rows and get back decisions.
import { itemNameKey } from './m59-items.mjs';

export const FARM_TOWN_KINDS = Object.freeze(['food', 'weapons', 'armor', 'reagents']);
const TOP_KEYS = Object.freeze(['name', 'sell', 'buy', 'bank', 'keep', 'sellReserve', 'hall', 'uncurse']);
// The public door to the Barloque guild halls (the reagent coop enters the hall from here, m59-reagent-coop-runtime.mjs) and
// Frular's room (the rent, m59-tithe.mjs FRULAR_ROOM). A farm town's `hall` road may leave the confinement for these three.
export const NORTH_BARLOQUE = 101;
export const FRULAR_ROOM = 700;
export const HALL_DEFAULTS = Object.freeze({ magicWeapons: true, weaponsTripAt: 3 });
export const REMOVE_CURSE_POTION = 'remove curse potion';
const words = s => String(s ?? '').toLowerCase().replace(/[’`]/g, "'").split(/[^a-z0-9']+/).filter(Boolean);

function room(what, v) {
  const n = Number(v);
  if (typeof v === 'boolean' || !Number.isInteger(n) || n <= 1) throw new Error(`${what} must be a room number above 1`);
  return n;
}
function seller(what, v) {
  if (typeof v !== 'string' || !words(v).length) throw new Error(`${what} must name the NPC (e.g. "Colhorr")`);
  return v.trim().replace(/\s+/g, ' ');
}
function itemList(what, v, resolveItem) {
  if (!Array.isArray(v) || !v.length || v.some(x => typeof x !== 'string' || !itemNameKey(x)))
    throw new Error(`${what} must be a non-empty list of whole item names`);
  if (v.length > 24) throw new Error(`${what} may name at most 24 items`);
  const out = [];
  for (const raw of v) {
    let name = raw.trim();
    if (resolveItem) { try { name = resolveItem(name); } catch (e) { throw new Error(`${what}: ${e.message}`); } }
    if (!out.some(n => itemNameKey(n) === itemNameKey(name))) out.push(name);
  }
  return out;
}
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a strategy's / the broker's `town`. null -> null (no farm town: today's townTable). Throws with the reason on
 * any other bad shape, including an unrecognised key -- a misspelt `sel:` that silently meant "sell nothing" would walk a
 * full pack into town and home again for ever.
 */
export function normalizeFarmTown(v, { resolveItem = null } = {}) {
  if (v === null || v === undefined) return null;
  if (!plain(v)) throw new Error('town must be { name?, sell, buy, bank?, keep?, sellReserve?, hall?, uncurse? } or null');
  for (const k of Object.keys(v)) if (!TOP_KEYS.includes(k)) throw new Error(`town: unrecognised key ${k} (known: ${TOP_KEYS.join(', ')})`);
  const out = { name: null, sell: [], buy: {}, bank: null, keep: [], hall: null, uncurse: null };
  if (v.name != null) { if (typeof v.name !== 'string' || !v.name.trim()) throw new Error('town.name must be a word'); out.name = v.name.trim(); }
  if (v.sell != null) {
    if (!Array.isArray(v.sell)) throw new Error('town.sell must be a list of { seller, room }');
    v.sell.forEach((s, i) => {
      if (!plain(s)) throw new Error(`town.sell[${i}] must be { seller, room }`);
      for (const k of Object.keys(s)) if (!['seller', 'room', 'maxStack'].includes(k)) throw new Error(`town.sell[${i}]: unrecognised key ${k}`);
      const row = { seller: seller(`town.sell[${i}].seller`, s.seller), room: room(`town.sell[${i}].room`, s.room) };
      if (s.maxStack != null) {
        const n = Number(s.maxStack);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`town.sell[${i}].maxStack must be a whole number above 0`);
        row.maxStack = n;
      }
      out.sell.push(row);
    });
  }
  if (v.buy != null) {
    if (!plain(v.buy)) throw new Error(`town.buy must be { ${FARM_TOWN_KINDS.join(', ')} }`);
    for (const [kind, list] of Object.entries(v.buy)) {
      if (!FARM_TOWN_KINDS.includes(kind)) throw new Error(`town.buy: unrecognised kind ${kind} (known: ${FARM_TOWN_KINDS.join(', ')})`);
      if (list === null) continue;
      if (!Array.isArray(list) || !list.length) throw new Error(`town.buy.${kind} must be a non-empty list of { seller, room, items } or null`);
      out.buy[kind] = list.map((c, i) => {
        const at = `town.buy.${kind}[${i}]`;
        if (!plain(c)) throw new Error(`${at} must be { seller, room, items }`);
        for (const k of Object.keys(c)) if (!['seller', 'room', 'items'].includes(k)) throw new Error(`${at}: unrecognised key ${k}`);
        return { seller: seller(`${at}.seller`, c.seller), room: room(`${at}.room`, c.room),
                 items: itemList(`${at}.items`, c.items, resolveItem) };
      });
    }
  }
  if (v.bank != null) {
    if (!plain(v.bank)) throw new Error('town.bank must be { room, name? } or null (null: no bank trips; the purse rides)');
    for (const k of Object.keys(v.bank)) if (!['room', 'name'].includes(k)) throw new Error(`town.bank: unrecognised key ${k}`);
    out.bank = { room: room('town.bank.room', v.bank.room), name: typeof v.bank.name === 'string' && v.bank.name.trim()
      ? v.bank.name.trim() : `bank (room ${room('town.bank.room', v.bank.room)})` };
  }
  if (v.keep != null) out.keep = itemList('town.keep', v.keep, resolveItem);
  if (v.sellReserve != null) {
    if (!plain(v.sellReserve)) throw new Error('town.sellReserve must map whole item names to quantities');
    const entries = Object.entries(v.sellReserve);
    const names = itemList('town.sellReserve', entries.map(([name]) => name), resolveItem);
    if (names.length !== entries.length) throw new Error('town.sellReserve names the same item more than once');
    if (entries.some(([, amount]) => !Number.isSafeInteger(amount) || amount < 0))
      throw new Error('town.sellReserve quantities must be nonnegative whole numbers');
    out.sellReserve = Object.fromEntries(names.map((name, i) => [name, entries[i][1]]));
  }
  // THE GUILD HALL INSTEAD OF A BANK (operator 2026-11-07: "let them deposit in the guild chest instead of banking").
  if (v.hall != null) {
    if (!plain(v.hall)) throw new Error('town.hall must be { room, magicWeapons?, weaponsTripAt? } or null');
    for (const k of Object.keys(v.hall)) if (!['room', 'magicWeapons', 'weaponsTripAt'].includes(k)) throw new Error(`town.hall: unrecognised key ${k}`);
    const h = { room: room('town.hall.room', v.hall.room), ...HALL_DEFAULTS };
    if (v.hall.magicWeapons != null) {
      if (typeof v.hall.magicWeapons !== 'boolean') throw new Error('town.hall.magicWeapons must be true or false');
      h.magicWeapons = v.hall.magicWeapons;
    }
    if (v.hall.weaponsTripAt != null) {
      const n = Number(v.hall.weaponsTripAt);
      if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('town.hall.weaponsTripAt must be a whole number from 1 to 20');
      h.weaponsTripAt = n;
    }
    out.hall = h;
  }
  // A CURSED WEAPON IS LIFTED IN TOWN (operator 2026-11-07): sell, buy a remove curse potion here, drink, drop, then buy.
  if (v.uncurse != null) {
    if (!plain(v.uncurse)) throw new Error('town.uncurse must be { seller, room, item? } or null');
    for (const k of Object.keys(v.uncurse)) if (!['seller', 'room', 'item'].includes(k)) throw new Error(`town.uncurse: unrecognised key ${k}`);
    const item = v.uncurse.item == null ? REMOVE_CURSE_POTION : itemList('town.uncurse.item', [v.uncurse.item], resolveItem)[0];
    out.uncurse = { seller: seller('town.uncurse.seller', v.uncurse.seller), room: room('town.uncurse.room', v.uncurse.room), item };
  }
  if (!out.sell.length && !Object.keys(out.buy).length && !out.bank && !out.hall)
    throw new Error('town names no counter at all (sell, buy or bank); use null for "no farm town"');
  return out;
}

const label = (c, town) => `${c.seller}, ${town?.name ?? 'farm town'} (room ${c.room})`;
const tableCache = new WeakMap();

/**
 * The townTable-shaped answer for a normalised farm town: BANKS, MARKET_STOPS, MARKETS, FOOD_SHOPS, FOOD_SHOP,
 * REAGENT_SHOP, plus `farmTown` itself. A kind with no counter is an EMPTY list / null, never the mainland's.
 */
export function farmTownTable(town) {
  if (!town) return null;
  if (tableCache.has(town)) return tableCache.get(town);
  const stops = town.sell.map(s => ({ room: s.room, name: label(s, town), seller: s.seller,
                                     ...(s.maxStack ? { maxStack: s.maxStack } : {}) }));
  const byRoom = list => {
    const out = [];
    for (const c of list ?? []) if (!out.some(o => o.room === c.room)) out.push({ room: c.room, name: label(c, town), seller: c.seller });
    return out;
  };
  const food = byRoom(town.buy.food), reagents = byRoom(town.buy.reagents);
  const t = Object.freeze({
    region: 'farm-town', name: town.name,
    BANKS: Object.freeze(town.bank ? [{ room: town.bank.room, name: town.bank.name }] : []),
    MARKET_STOPS: Object.freeze(stops),
    // Every sell stop is a market: the trip aims at the nearest and the circuit then visits them in order.
    MARKETS: Object.freeze(stops),
    FOOD_SHOPS: Object.freeze(food),
    FOOD_SHOP: food[0] ?? null,
    REAGENT_SHOP: reagents[0] ?? null,
    farmTown: town,
  });
  tableCache.set(town, t);
  return t;
}

/** Does this farm town let the keeper buy `kind` (food | weapons | reagents | armor) at all? */
export const farmTownAllowsKind = (town, kind) => !!town?.buy?.[kind]?.length;

/** Does the NPC called `name` answer to `want` ("Colhorr" in "Colhorr the smith")? Word sequence, case-blind. */
export function sellerMatches(name, want) {
  const n = words(name), w = words(want);
  if (!n.length || !w.length) return false;
  for (let i = 0; i + w.length <= n.length; i++) if (w.every((x, j) => n[i + j] === x)) return true;
  return false;
}

/** The counters (any kind, or one kind) this NPC name is listed as, [] for a stranger. */
export function countersFor(town, sellerName, kind = null) {
  if (!town) return [];
  return (kind ? [kind] : FARM_TOWN_KINDS).flatMap(k => (town.buy?.[k] ?? []).map(c => ({ ...c, kind: k })))
    .filter(c => sellerName == null || sellerMatches(sellerName, c.seller));
}

/** May this item be bought from this seller (null: from any listed counter)? */
export function farmTownMayBuy(town, item, sellerName = null, kind = null) {
  const key = itemNameKey(item);
  return !!key && countersFor(town, sellerName, kind).some(c => c.items.some(i => itemNameKey(i) === key));
}

/**
 * A shop's shelf (or an estimated menu), cut to what the farm town lets us buy from THIS seller. No farm town: the menu
 * unchanged. Rows are `{ name, ... }`; nothing else is read.
 */
export function farmTownMenu(town, menu, sellerName = null) {
  if (!town || !Array.isArray(menu)) return menu;
  return menu.filter(row => farmTownMayBuy(town, row?.name, sellerName));
}

/** The room object (or name row) among `candidates` that is the listed SELL counter `stop` -- null if it is not here. */
export function farmTownSeller(stop, candidates, nameOf = o => o?.name) {
  if (!stop?.seller) return null;
  return (candidates ?? []).find(o => sellerMatches(nameOf(o), stop.seller)) ?? null;
}

/** Is `name` one of this town's sell counters at all (any room)? */
export const isFarmTownBuyer = (town, name) => !!town?.sell?.some(s => sellerMatches(name, s.seller));

/** The farm town's `keep` list added to a sale's protect list. */
export const farmTownKeep = (town, protect = []) =>
  town?.keep?.length ? [...new Set([...(protect ?? []), ...town.keep])] : protect;

/** Sale-only minima compose with any stricter personal, trip or spell reserve. */
export function farmTownSaleLoadout(town, loadout, spellFloors = new Map()) {
  if (!town?.sellReserve) return loadout;
  const base = loadout ?? { keep: [], sell: [], gear: { weapon: [], slots: {} } };
  const minima = Object.entries(town.sellReserve).map(([item, min]) =>
    ({ item, min: Math.max(min, spellFloors.get(item) ?? 0), match: 'exact' }));
  return { ...base, carry: [...(base.carry ?? []), ...minima] };
}

/**
 * WHAT THE OUTFIT ERRAND (m59-outfit.mjs) MAY BUY, AND WHERE. `wants` are its slot wants `{ slot, re, fallback, what }`
 * (slots armour | shield | weapon). Each slot is cut to the farm town's items for that kind; a slot with none (a shield,
 * here) is dropped; the shop is the counter that sells the first remaining want. No farm town: null (the old errand).
 */
export function farmTownOutfit(town, wants = []) {
  if (!town) return null;
  const kindOf = { armour: 'armor', weapon: 'weapons', shield: 'armor' };
  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = [], dropped = [];
  for (const w of wants) {
    const counters = countersFor(town, null, kindOf[w.slot] ?? null);
    // A shield is listed under armor only when its NAME says shield; leather armour does not satisfy a shield slot.
    const items = counters.flatMap(c => c.items.map(item => ({ item, room: c.room, seller: c.seller })))
      .filter(x => w.slot === 'shield' ? /shield/i.test(x.item) : w.slot === 'armour' ? !/shield/i.test(x.item) : true);
    if (!items.length) { dropped.push({ slot: w.slot, what: w.what, why: `${town.name ?? 'the farm town'} sells no allowed ${w.slot}` }); continue; }
    const named = items.find(x => w.re?.test?.(x.item)) ?? items[0];
    const allowed = new RegExp(items.map(x => `\\b${esc(x.item)}\\b`).join('|'), 'i');
    out.push({ ...w, re: new RegExp(`\\b${esc(named.item)}\\b`, 'i'), fallback: allowed, what: named.item,
               room: named.room, seller: named.seller });
  }
  return { wants: out, dropped, room: out[0]?.room ?? null, seller: out[0]?.seller ?? null };
}

// ---------------------------------------------------------------------------------------------------------------------
// THE HALL ROAD, THE HALL CARGO AND THE CURSE ERRAND (operator, 2026-11-07, of the Farol farmers: "let them deposit in the
// guild chest instead of banking, also set them to tithe for the guild rent" and "pick up magic weapons and deposit them in
// the guild chest if they are not cursed. If they are cursed they should go sell in Marion, then buy a remove curse potion
// from the potion shop and drop their cursed weapon before doing any buying they need and going back out farming").

/** Rooms a hall trip may walk to past the confinement: the public door, the hall, Frular. [] without a hall. */
export function farmTownRoadRooms(town) {
  if (!town?.hall) return [];
  return [...new Set([NORTH_BARLOQUE, town.hall.room, FRULAR_ROOM])];
}

/**
 * Is this pack object LOOT MAGIC that belongs in the guild hall? A weapon the server grades as carrying a hidden attribute
 * (100, unidentified) or an identified magic grade (1 uncommon, 2 rare, 4 legendary; GetRarity item.kod:714-730) -- never 0
 * (mundane, and every Kraanan dedication, whose rarity modifier is 0), never 200 (graded cursed), never a stack. Never what
 * is in hand or worn, never one the server has called cursed, never one this keeper holds back (its own dedicated weapon, a
 * delivery), never its own conjured weapon. `isWeapon(name)` is the session's weapon classifier, handed in.
 */
export function isHallBoundWeapon({ o, name, equipped = null, cursed = false, held = null, ownSummon = false, isWeapon }) {
  if (!o || typeof isWeapon !== 'function' || !isWeapon(name)) return false;
  if ((Number(o.amount) || 0) > 1) return false;
  if (![100, 1, 2, 4].includes(Number(o.rarity))) return false;
  if (equipped?.has?.(o.id) || cursed || ownSummon || held?.has?.(Number(o.id))) return false;
  return true;
}

/**
 * Should a hall visit happen on THIS trip, and what goes in? `purse` and `keep` in shillings (keep = walking money plus the
 * posted shopping bill); `bankAbove` the policy threshold (0/null: never for money alone); `weapons` the hall-bound weapon
 * count. Money goes only when the purse is over bank_above -- the same trigger as a bank walk -- and then everything above
 * `keep`; weapons go when there are `weaponsTripAt` of them, and ride along with any money visit.
 *   -> { go, shillings, weapons, why }
 */
export function hallDepositPlan(town, { purse = 0, keep = 0, bankAbove = null, weapons = 0 } = {}) {
  const h = town?.hall;
  if (!h) return { go: false, shillings: 0, weapons: 0, why: 'no hall on this farm town' };
  const rich = Number(bankAbove) > 0 && purse > Number(bankAbove);
  const shillings = rich ? Math.max(0, Math.floor(purse - keep)) : 0;
  const w = h.magicWeapons ? Math.max(0, Math.floor(Number(weapons) || 0)) : 0;
  if (!shillings && w < h.weaponsTripAt)
    return { go: false, shillings: 0, weapons: 0,
             why: (rich ? 'over bank_above but nothing above the keep' : `purse ${purse} not over bank_above ${bankAbove ?? 'off'}`) +
               (w ? `; ${w} hall weapon(s), under ${h.weaponsTripAt}` : '') };
  return { go: true, shillings, weapons: w,
           why: [shillings ? `purse ${purse} over bank_above ${bankAbove}: ${shillings} to the chests` : null,
                 w ? `${w} magic weapon(s) for the chests` : null].filter(Boolean).join('; ') };
}

/**
 * THE CURSE ERRAND, IN THE OPERATOR'S ORDER, AS A STATE MACHINE. Each call answers the ONE next thing to do; the keeper
 * does it, reads the world back and asks again. Buying (food, axe, armour) waits for 'done' or 'stuck', so it cannot
 * happen first.
 *
 *   cursed   { id, name, wielded } | null   the weapon (null: no curse, the errand is 'none')
 *   sold     the Marion sale for this trip has run (the cursed weapon and everything equipped held out of every offer)
 *   potions  remove curse potions in the pack
 *   inPack   the cursed weapon is still in the pack (re-read, by id)
 *   tries    { buy, drink, drop } attempts so far; CURSE_TRIES of any one is 'stuck', never a loop
 *   -> { step: 'none'|'sell'|'buy_potion'|'drink'|'drop'|'done'|'stuck', why }
 */
export const CURSE_TRIES = 3;
export function curseErrandNext({ cursed = null, sold = false, potions = 0, inPack = true, tries = {} } = {}) {
  if (!cursed) return { step: 'none', why: 'no cursed weapon' };
  if (!inPack) return { step: 'done', why: `the ${cursed.name ?? 'cursed weapon'} is gone from the pack` };
  if (!sold) return { step: 'sell', why: 'sell first, with the cursed weapon and everything equipped held out of the offer' };
  if (cursed.wielded) {
    if (potions > 0) {
      if ((tries.drink ?? 0) >= CURSE_TRIES) return { step: 'stuck', why: `drank ${tries.drink} potion(s) and the hand still holds it` };
      return { step: 'drink', why: 'a remove curse potion unuses every cursed item (RemoveCurseAllItems)' };
    }
    if ((tries.buy ?? 0) >= CURSE_TRIES) return { step: 'stuck', why: `asked for a remove curse potion ${tries.buy} time(s) and got none` };
    return { step: 'buy_potion', why: (tries.drink ?? 0) ? 'the potion did not free the hand: another' : 'the hand will not let go: buy the cure' };
  }
  if ((tries.drop ?? 0) >= CURSE_TRIES) return { step: 'stuck', why: `dropped it ${tries.drop} time(s) and it is still in the pack` };
  return { step: 'drop', why: 'out of the hand: drop it (the curse stays on the item after a remove curse)' };
}
