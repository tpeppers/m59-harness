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
//
// WHOLE ITEM NAMES, like lootOnly and the supply tool: "loaf of bread", not "bread" (the broker's resolveItemName refuses
// the abbreviation and says what it meant). Seller names match the NPC's own name case-blind, as a word sequence, so
// "Colhorr" is the smith and "Tova" the bartender.
//
// PURE. No client, no session, no file: the keeper and the outfit errand hand in rows and get back decisions.
import { itemNameKey } from './m59-items.mjs';

export const FARM_TOWN_KINDS = Object.freeze(['food', 'weapons', 'armor', 'reagents']);
const TOP_KEYS = Object.freeze(['name', 'sell', 'buy', 'bank', 'keep']);
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
  if (!plain(v)) throw new Error('town must be { name?, sell, buy, bank?, keep? } or null');
  for (const k of Object.keys(v)) if (!TOP_KEYS.includes(k)) throw new Error(`town: unrecognised key ${k} (known: ${TOP_KEYS.join(', ')})`);
  const out = { name: null, sell: [], buy: {}, bank: null, keep: [] };
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
  if (!out.sell.length && !Object.keys(out.buy).length && !out.bank)
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
