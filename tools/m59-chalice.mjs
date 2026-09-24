// CHALICE FARMING: A FREE RESCUE HOME FOR EVERY TOWN TRIP, SERVED BY ONE CHARACTER.
//
// The operator's plan, 2026-09-23. One character (the HOLDER) carries the fleet's Chalice of
// the Rain and stands by a STATION room. A farmer starting a town trip walks to the station,
// is handed the Chalice, applies it (one sip starts a power-1 Rescue, chalice.kod:189), drops
// it on the floor, and the holder picks it back up. The farmer lands in the guild hall
// 15-25 seconds later instead of walking home, and pays the holder a small tip if it can.
//
// WHY THE STATION MUST BE A REFILL ROOM. The Chalice refills to its own maximum whenever it
// is picked up off the floor of a room whose `GetShalilleBonus() > 20` — every forest or
// jungle room (chalice.kod:71; m59-research reports/chalice-of-the-rain.md lists all 73). A
// hand-off that ends in drop-and-pick-up in such a room therefore never drains the cup, and
// a cup on its LAST sip is deleted when it is drunk (chalice.kod:189), so a station that
// does not refill would eventually destroy the fleet's only one. Outside Castle Victoria
// (room 2, `castle1c.kod:30`, MOUNTAIN/FOREST) qualifies and is the default.
//
// WHERE RESCUE LANDS FROM THERE. `DoRescue` goes to the guild hall when it is in the same
// region as the drinker (rescue.kod:124-139). Room 2 and every mainland hall return
// RID_DEFAULT from `Room.GetRegion` (room.kod:900-943) — only halls 12, 13 and 15 override
// it, to Ko'catan — so a fleet guilded to the Bookmaker's hall (714) lands in 714.
//
// THE ALTERNATE. The holder has its own trips (a room caster runs out of reagents). Before
// one it hands the cup to the ALTERNATE, who serves in its place and may not start a town
// trip of its own until the holder is back and has the cup again — two keepers both out of
// the castle is a fleet with no chalice at all.
//
// THIS FILE IS PURE PLUS ONE SMALL FILE STORE. The keepers are separate processes and have
// no other way to see each other, so the ticket queue and the duty record live in one JSON
// file under a `wx` lock — the same arrangement m59-spotclaims.mjs uses for walls. Everything
// that talks to the game is in m59-autopilot.mjs; this file decides and remembers.
//
// `m59-chalice-test.mjs` pins the config, the roles, the store and the two plans offline.

import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unitCost, scoreItem } from './m59-overfarm.mjs';

// ------------------------------------------------------------------------------ the item
export const CHALICE = Object.freeze({
  name: 'chalice of the rain',
  match: /chalice/i,
  // chalice.kod: vrName "chalice of the rain", viWeight 20, viBulk 20. Both ceilings count:
  // a pack full by bulk refuses it exactly as a pack full by weight does.
  weight: 20, bulk: 20,
});

// Every room whose terrain makes `GetShalilleBonus() > 20`, i.e. every room a drop and a
// pick-up refills the cup in. From reports/chalice-of-the-rain.md ("Every map that refills
// it"); a station outside this set is refused rather than trusted, because it would drain
// the cup to its last sip and the last sip deletes it.
export const REFILL_ROOMS = Object.freeze(new Set([
  2, 4, 6, 24, 26, 28, 48, 49, 200, 511, 516, 521, 522, 531, 532, 533, 534, 535, 536, 537,
  541, 542, 544, 545, 546, 547, 552, 554, 555, 556, 557, 562, 563, 564, 566, 567, 568, 574,
  575, 576, 583, 584, 586, 587, 593, 596, 597, 603, 712, 1002, 1012,
  2111, 2112, 2113, 2114, 2115, 2121, 2122, 2123, 2124, 2125, 2131, 2132, 2133, 2134, 2135,
  2141, 2142, 2143, 2144, 2151, 2152, 2154,
]));

export const GUILD_HALL_ROOM = 714;

// HOW LONG AFTER SWINGING AT A PLAYER THE CUP REFUSES A SIP. `util/settings.kod:88` —
// `piTeleportAttackDelaySec = 10 * 60` — read by `chalice.kod:168`, `rescue.kod:68` and
// `elusion.kod:79` alike. A constant here rather than a guess, and overridable per fleet
// because it is a SERVER setting this harness cannot read: a shard that changed it would
// otherwise make every traveller wait for a ban that had already lapsed, or walk into one
// that had not.
export const PVP_TELEPORT_BLOCK_MS = 10 * 60_000;

// Beside the harness, not the working directory: every keeper of one deploy must share one
// file whatever directory it was started from.
const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', '.chalice');

// ------------------------------------------------------------------------------ config
export const CHALICE_DEFAULTS = Object.freeze({
  enabled: false,
  station_room: 2,
  // Named, never derived: a character name on a shared server is an instruction, and the
  // private strategy file is where this machine keeps its instructions.
  holder: null,
  alternate: null,
  // Where the holder goes back to between hand-offs (a posted caster's own room), and where
  // an on-duty alternate waits. null means "wherever it already is".
  post_room: null,
  // A traveller uses the chalice only when the station is on the way: no further than this
  // many hops away, and nearer than the town it is heading for.
  max_detour_hops: 2,
  // How long a traveller stands at the station waiting for the cup before walking instead.
  wait_ms: 180_000,
  // Rescue lands 15-25s after the sip (rescue.kod:94); past this the walk is taken.
  landing_ms: 45_000,
  // The server's own teleport ban after attacking a player, which the cup obeys. Defaults to
  // what this repository's kod carries; see PVP_TELEPORT_BLOCK_MS. 0 switches the check off,
  // which is only right on a shard that has removed the ban.
  pvp_block_ms: PVP_TELEPORT_BLOCK_MS,
  // How long the server waits for the traveller to show up, and then for the cup to hit
  // the floor, before giving up on that ticket.
  serve_ms: 90_000,
  // THE TIP. Offered after the cup arrives, only out of money the trip does not need.
  tip_amount: 300,
  tip_min: 50,
  // The holder hands the cup to the alternate once its own supply falls this low — a
  // holder that is about to leave must not leave with the fleet's only chalice.
  handover_below_casts: 12,
  // A ticket older than this is abandoned, whoever holds it.
  ticket_ttl_ms: 300_000,
  // FORCES OF LIGHT ON REQUEST. When set, the holder waits at its post and lights THIS room
  // only when a fleetmate standing in it asks -- stepping in, casting until a cast pays, and
  // stepping straight back out. A 20-health caster is safe at the post and not in the room.
  fol_room: null,
  // Ask for a recast this long before the holder's own clock says it lapses.
  fol_lead_ms: 5_000,
  // WHAT THE HOLDER SHOULD CARRY, so the fleet can keep it there instead of the holder
  // walking to town. Travellers donate spares toward it at the station, and restock it from
  // the guild chest when they land in the hall and hand it over on the way back.
  holder_supply: Object.freeze({}),
  // How much of the holder's shortfall one traveller takes on per trip, per item.
  restock_per_trip: 60,
  // WHERE TO BUY WHAT THE HOLDER IS SHORT OF, so a town trip can restock him with money
  // instead of with a chest draw. Keyed by the same names as `holder_supply`:
  //
  //   supply_shops: { elderberry: { room: 104, seller: 'Joguer' },
  //                   emerald:    { room: 109, seller: 'Herbutte' } }
  //
  // WHY BUYING AND NOT ONLY THE CHEST. The chest draw (`chaliceTakeCargo`) runs at exactly one
  // moment: a traveller that rode the chalice and landed in the guild hall. Measured on prod
  // 2026-09-24 the chest held 4,551 elderberries and 2,028 emeralds and had been drawn from
  // ZERO times, because the service had never completed a single ride — so the holder's
  // restock was gated behind the very service the restock exists to keep running. A purchase
  // on the ordinary town trip needs no ride and no landing: every trip that sells can carry
  // some back.
  //
  // It does not replace the chest draw, which is free and is the better source whenever a
  // traveller does land in the hall. Empty is off, and off is the default.
  supply_shops: Object.freeze({}),
  // MOST A TRAVELLER MAY SPEND ON THE HOLDER IN ONE TRIP, after its own restocking and its
  // walking money. A cap rather than a fraction, because what is being protected is the
  // character's ability to buy its OWN food and reagents — which is a floor, not a share.
  restock_budget: 3000,
  // The holder's services at the station, asked for while the traveller holds the cup.
  uncurse: true,
  reveal: true,
  // Unrevealed items one traveller may drop for revealing in one visit (3 orc teeth each).
  reveal_max: 3,
});

const NUMBERS = {
  station_room: [1, 100_000], max_detour_hops: [0, 20], wait_ms: [10_000, 900_000],
  landing_ms: [20_000, 120_000], serve_ms: [20_000, 600_000], tip_amount: [0, 100_000],
  tip_min: [0, 100_000], handover_below_casts: [0, 1000], ticket_ttl_ms: [60_000, 3_600_000],
  fol_lead_ms: [0, 60_000], restock_per_trip: [0, 1000], reveal_max: [0, 10],
  restock_budget: [0, 100_000], pvp_block_ms: [0, 3_600_000],
};

/**
 * Normalise a strategy's answer. Unknown keys and unusable values are REPORTED, and an
 * unusable value keeps the default rather than unsetting it (docs/m59-policy.md).
 */
export function normalizeChalice(cfg = null) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg))
    return { ...CHALICE_DEFAULTS, problems: [] };
  const out = { ...CHALICE_DEFAULTS, enabled: cfg.enabled !== false };
  const problems = [];
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'enabled') continue;
    if (!Object.hasOwn(CHALICE_DEFAULTS, k)) { problems.push(`unrecognised key ${k}, not applied`); continue; }
    if (k === 'holder' || k === 'alternate') { out[k] = v == null ? null : String(v).trim() || null; continue; }
    if (k === 'uncurse' || k === 'reveal') { out[k] = v !== false; continue; }
    if (k === 'holder_supply') {
      const supply = {};
      if (v && typeof v === 'object' && !Array.isArray(v))
        for (const [item, n] of Object.entries(v)) {
          const want = Math.floor(Number(n));
          if (String(item).trim() && Number.isFinite(want) && want > 0) supply[String(item).trim().toLowerCase()] = want;
          else problems.push(`holder_supply.${item} must be a positive count`);
        }
      else if (v != null) problems.push('holder_supply must be {item: count}');
      out.holder_supply = supply;
      continue;
    }
    if (k === 'supply_shops') {
      const shops = {};
      if (v && typeof v === 'object' && !Array.isArray(v))
        for (const [item, where] of Object.entries(v)) {
          const room = Math.floor(Number(where?.room));
          const seller = String(where?.seller ?? '').trim();
          // A COUNTER WITH NO ROOM OR NO NAME IS A PURCHASE NOBODY CAN MAKE, and one that
          // silently did nothing would read on the board as a fleet restocking the holder
          // while he ran dry. Refused per item, so one bad entry does not lose the others.
          if (!String(item).trim()) { problems.push('supply_shops has an unnamed item'); continue; }
          if (!Number.isFinite(room) || room <= 0 || !seller) {
            problems.push(`supply_shops.${item} needs {room, seller}`);
            continue;
          }
          shops[String(item).trim().toLowerCase()] = { room, seller,
            // Optional: the pattern the shelf is searched with, when the merchant spells it
            // differently from the item name. `ElderBerry`, `elderberry` and `Elder Berry` are
            // all the same shelf.
            ...(where.match ? { match: String(where.match) } : {}) };
        }
      else if (v != null) problems.push('supply_shops must be {item: {room, seller}}');
      out.supply_shops = shops;
      continue;
    }
    if (k === 'post_room' || k === 'fol_room') {
      if (v == null) { out[k] = null; continue; }
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) out[k] = n; else problems.push(`${k} must be a room number`);
      continue;
    }
    const n = Number(v), [lo, hi] = NUMBERS[k];
    if (!Number.isFinite(n) || n < lo || n > hi) { problems.push(`${k} must be between ${lo} and ${hi} (kept ${CHALICE_DEFAULTS[k]})`); continue; }
    out[k] = n;
  }
  if (!REFILL_ROOMS.has(out.station_room)) {
    problems.push(`station_room ${out.station_room} does not refill the chalice, so every sip ` +
                  'would drain it toward the last one, which deletes it — chalice farming is OFF');
    out.enabled = false;
  }
  if (!out.holder) { problems.push('no holder named — chalice farming is OFF'); out.enabled = false; }
  if (out.alternate && sameName(out.alternate, out.holder)) {
    problems.push('the alternate is the holder — no alternate'); out.alternate = null;
  }
  if (out.tip_min > out.tip_amount) out.tip_min = out.tip_amount;
  return { ...out, problems };
}

export const sameName = (a, b) => a != null && b != null &&
  String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * WHAT THE HOLDER IS SHORT OF, net of what other travellers have already pledged to bring.
 * Pure. A pledge older than an hour is a traveller that never came back and counts for
 * nothing.
 */
/**
 * WHICH COUNTERS TO VISIT FOR THE HOLDER, and how much to ask for at each.
 *
 * Pure: the keeper supplies the shortfall and the config, and gets back a shopping list
 * grouped by counter. Prices are not here on purpose — a price is only knowable once the
 * shop is open, so the amount this returns is what is WANTED and the clamping to purse,
 * weight and bulk happens at the counter, where the answer is real.
 *
 * ONE COUNTER PER ITEM, because the two halves of a room enchantment are not sold by the
 * same merchant: the apothecary has the berries and does not stock a gem. A list that
 * assumed one shop would come home able to keep the holder casting exactly as long as it
 * left (see `supply_shops`).
 */
export function restockBuyPlan({ shortfall = {}, cfg = null, perTrip = null } = {}) {
  const shops = cfg?.supply_shops ?? {};
  // `perTrip != null` FIRST, because `Number(null)` is 0 and 0 is finite — so a plain
  // `Number.isFinite(Number(perTrip))` accepts the default and caps every line at nothing.
  // The same trap `buyLines` in m59-parse.mjs carries its own note about.
  const cap = perTrip != null && Number.isFinite(Number(perTrip)) ? Number(perTrip)
            : Number(cfg?.restock_per_trip ?? CHALICE_DEFAULTS.restock_per_trip);
  const stops = [];
  for (const [item, short] of Object.entries(shortfall)) {
    const where = shops[String(item).toLowerCase()];
    // An item nobody sells is not a gap in this plan: it is donated, drawn from the chest,
    // or farmed. Skipped silently rather than reported, because the ordinary case for a
    // fleet is that most of `holder_supply` has no counter at all.
    if (!where) continue;
    const amount = Math.max(0, Math.min(Math.floor(short), Math.floor(cap)));
    if (!amount) continue;
    const stop = stops.find(s => s.room === where.room && s.seller === where.seller);
    const line = { item, amount, match: where.match ?? item };
    if (stop) stop.lines.push(line);
    else stops.push({ room: where.room, seller: where.seller, lines: [line] });
  }
  // Nearest room number first is not a route, and is not pretending to be one: it only makes
  // the plan deterministic so two runs of the same shortfall visit the counters in the same
  // order and a test can say what it expects.
  return stops.sort((a, b) => a.room - b.room);
}

export function holderShortfall(supply = {}, { now = Date.now(), except = null } = {}) {
  const out = {};
  const pledged = {};
  for (const p of supply.pledged ?? [])
    if (now - (p.at ?? 0) < 60 * 60_000 && !sameName(p.by, except))
      pledged[p.item] = (pledged[p.item] ?? 0) + (p.amount ?? 0);
  for (const [item, target] of Object.entries(supply.target ?? {})) {
    const short = target - (supply.have?.[item] ?? 0) - (pledged[item] ?? 0);
    if (short > 0) out[item] = short;
  }
  return out;
}

/**
 * What a traveller can spare toward the holder: what it carries beyond its own floor, capped
 * by what the holder is short of. Pure. `floors` is the traveller's own keep-at-least counts.
 */
export function donationPlan({ have = {}, floors = {}, shortfall = {} } = {}) {
  const out = {};
  for (const [item, short] of Object.entries(shortfall)) {
    const spare = Math.max(0, (have[item] ?? 0) - (floors[item] ?? 0));
    const give = Math.min(spare, short);
    if (give > 0) out[item] = give;
  }
  return out;
}

/**
 * Should a character standing in the forces-of-light room ask for a cast? Pure. The holder's
 * clock is the only one there is -- occupants cannot see the enchantment, only hear it -- so
 * "lapsed by that clock, or never recorded" is the whole test.
 */
export function folWanted({ cfg, here, fol = {}, now = Date.now(), role = null } = {}) {
  if (!cfg?.enabled || cfg.fol_room == null) return false;
  if (role === 'holder') return false;
  if (Number(here) !== cfg.fol_room) return false;
  return !(Number(fol.until) > now + (cfg.fol_lead_ms ?? 0));
}

/** 'holder', 'alternate' or 'traveller'. Everybody not named is a traveller. */
export function roleOf(character, cfg) {
  if (!cfg?.enabled || !character) return null;
  if (sameName(character, cfg.holder)) return 'holder';
  if (sameName(character, cfg.alternate)) return 'alternate';
  return 'traveller';
}

// ------------------------------------------------------------------------------ plans

/**
 * Should THIS town trip go by chalice? Pure: the keeper supplies the facts.
 *
 * `stationHops`/`targetHops` are from where the character stands now. The station has to be
 * on the way — a farmer in the Valley of Ileria does not walk to Castle Victoria to save a
 * walk to Barloque.
 */
export function shouldRide({ cfg, role, stationHops = null, targetHops = null,
                             carrying = false, duty = null, lastPlayerAttackAt = null,
                             now = Date.now() } = {}) {
  if (!cfg?.enabled) return { ride: false, why: 'chalice farming is off' };
  if (role === 'holder') return { ride: false, why: 'the holder serves; its own trips are its own' };
  if (role === 'alternate' && carrying)
    return { ride: false, why: 'the alternate is on duty with the cup' };
  if (carrying) return { ride: false, why: 'already carrying a chalice — nobody needs to hand one over' };
  // THE SERVER WILL REFUSE THE SIP FOR TEN MINUTES AFTER WE SWING AT A PLAYER, so find out
  // here rather than at the counter. `chalice.kod:168-177` is the gate — not the spell's
  // `CanPayCosts`, which an item cast skips — and it is the same clock `rescue.kod:68` and
  // `elusion.kod:79` use: `GetLastPlayerAttackTime + TeleportAttackDelaySec > GetTime()`,
  // where the setting is `10 * 60` seconds (util/settings.kod:88).
  //
  // WHAT IT COSTS TO LEARN THIS LATE. The refusal lands at the very END of the sequence: the
  // traveller has already walked up to `max_detour_hops`, waited out the hand-over, paid the
  // tip, and taken the cup — and then the sip is refused, the cup goes on the floor, and it
  // stands there for `landing_ms` waiting for a rescue that was never started before walking
  // the whole way anyway. Every part of that is wasted, and the holder's cup was out of
  // circulation for the duration.
  //
  // UNKNOWN MEANS GO, AND THAT IS THE OPPOSITE OF THIS REPOSITORY'S USUAL RULE. "Unknown is
  // not zero" is right when the cheap error is to wait; here it is reversed. A keeper that
  // has never swung at a player has nothing to report, so treating silence as a refusal
  // would turn the chalice off for the whole fleet for ever. Being wrong the other way costs
  // one detour.
  const blockMs = Number(cfg.pvp_block_ms ?? PVP_TELEPORT_BLOCK_MS);
  const since = Number(lastPlayerAttackAt);
  if (Number.isFinite(since) && blockMs > 0) {
    const left = blockMs - (Number(now) - since);
    if (left > 0)
      return { ride: false, wait_ms: left,
               why: `attacked a player ${Math.round((Number(now) - since) / 1000)}s ago — the ` +
                    `chalice refuses a sip for ${Math.round(blockMs / 60_000)} minutes after ` +
                    `that (chalice.kod:168), ${Math.ceil(left / 1000)}s left` };
  }
  if (!Number.isFinite(stationHops)) return { ride: false, why: 'no route to the station' };
  if (stationHops > cfg.max_detour_hops)
    return { ride: false, why: `the station is ${stationHops} hops away (limit ${cfg.max_detour_hops})` };
  if (Number.isFinite(targetHops) && stationHops >= targetHops)
    return { ride: false, why: 'the town is no further than the station' };
  const server = servingCharacter(duty, cfg, now);
  if (!server) return { ride: false, why: 'nobody is on chalice duty right now' };
  return { ride: true, server, why: `${server} is on duty at ${cfg.station_room}` };
}

/** Who is carrying the cup and serving, per the duty record. null when nobody is. */
export function servingCharacter(duty, cfg, now = Date.now()) {
  const d = duty ?? {};
  if (!d.with) return cfg?.holder ?? null;          // never recorded: the holder, by default
  if (d.lost) return null;
  if (d.paused) return null;                         // its body is somebody else's right now
  // A record nobody has refreshed for a long while is a keeper that stopped, not a server.
  if (Number.isFinite(d.seen_at) && now - d.seen_at > 15 * 60_000) return null;
  return d.with;
}

/** Whoever should receive the holder's restock: the server on duty, else the holder. */
export function servingOrHolder(duty, cfg) {
  return servingCharacter(duty, cfg) ?? cfg?.holder ?? null;
}

/**
 * The tip: `tip_amount`, cut to what the trip can spare, or nothing below `tip_min`.
 * `keep` is what the trip needs to hold on to — walking money and the shopping bill.
 */
export function tipPlan({ purse = 0, keep = 0, cfg = CHALICE_DEFAULTS } = {}) {
  const spare = Math.max(0, Math.floor(Number(purse) || 0) - Math.max(0, Number(keep) || 0));
  const amount = Math.min(Number(cfg.tip_amount) || 0, spare);
  if (amount <= 0 || amount < (Number(cfg.tip_min) || 0))
    return { amount: 0, why: spare <= 0 ? 'no money beyond what the trip needs — offer-nothing'
                                       : `only ${spare} spare, under the ${cfg.tip_min} minimum — offer-nothing` };
  return { amount, why: amount < cfg.tip_amount ? `cut to ${amount}: that is all the trip can spare` : 'the standard tip' };
}

/**
 * WHAT TO PUT DOWN SO THE CUP FITS.
 *
 * After overfarming a pack is full by design, and an enfeeble lowers might and with it the
 * capacity (1700 + might*20, player.kod:10456), so a pack that fitted at the farm may not
 * at the station. The chalice needs 20 weight AND 20 bulk.
 *
 * Candidates are ranked by the overfarm score — shillings per unit of binding cost times the
 * operator's preference — cheapest first, exactly the order overfarming evicts in. Protected
 * items, unrankable items (no price or no weight: unknown is not worthless) and anything
 * named in `never` are not candidates at any score. A partial stack is dropped when that is
 * enough. Returns `{drops, freed, enough}`; `enough: false` means even every candidate would
 * not make room, and the caller should walk instead of giving its whole pack away.
 */
export function planRoom({ pack = [], roomFor = null, need = CHALICE, protect = [],
                           never = [], policy = undefined } = {}) {
  if (!roomFor) return { drops: [], freed: { weight: 0, bulk: 0 }, enough: null,
                         why: 'capacity is unreadable — try the hand-off and walk if it is refused' };
  const short = { weight: Math.max(0, need.weight - roomFor.weight),
                  bulk: Math.max(0, need.bulk - roomFor.bulk) };
  if (short.weight <= 0 && short.bulk <= 0)
    return { drops: [], freed: { weight: 0, bulk: 0 }, enough: true, why: 'already room' };
  const barred = [...protect, ...never].map(x => String(x).toLowerCase());
  const isBarred = n => barred.some(b => b && n.includes(b));
  const ranked = [];
  for (const it of pack) {
    const name = String(it.name ?? '').toLowerCase();
    if (!name || CHALICE.match.test(name) || /shilling/.test(name) || it.equipped || isBarred(name)) continue;
    const s = scoreItem(name, policy);
    const c = unitCost(name);
    if (!s.rankable || !c.known) continue;
    ranked.push({ ...it, name, score: s.score, weight: c.weight, bulk: c.bulk });
  }
  ranked.sort((a, b) => a.score - b.score);
  const drops = [];
  const freed = { weight: 0, bulk: 0 };
  for (const it of ranked) {
    if (freed.weight >= short.weight && freed.bulk >= short.bulk) break;
    const have = Math.max(1, Number(it.amount) || 1);
    let take = have;
    // As few units as covers the worse of the two shortfalls.
    const perW = it.weight || 0, perB = it.bulk || 0;
    const needW = Math.max(0, short.weight - freed.weight), needB = Math.max(0, short.bulk - freed.bulk);
    const units = Math.max(perW > 0 ? Math.ceil(needW / perW) : 0, perB > 0 ? Math.ceil(needB / perB) : 0);
    if (units > 0) take = Math.min(have, units);
    drops.push({ id: it.id, name: it.name, amount: take, partial: take < have, score: it.score });
    freed.weight += take * perW; freed.bulk += take * perB;
  }
  const enough = freed.weight >= short.weight && freed.bulk >= short.bulk;
  return { drops: enough ? drops : [], freed, enough, short,
           why: enough ? `drop ${drops.length} cheapest item(s) to fit the chalice`
                       : 'nothing droppable would make room — walk instead' };
}

// ------------------------------------------------------------------------------ the store
//
// ONE FILE, READ-MODIFY-WRITE UNDER A LOCK, because every writer is a different process.
//
//   { v: 1,
//     duty:    { with, since, seen_at, lost, holder_away, why },
//     tickets: [{ id, traveller, room, at, status, by, updated_at, note }] }
//
// `status`: open -> claimed -> handed -> dropped -> done, or abandoned. A relief ticket
// (`kind: 'relief'`) is the holder asking the alternate to take the cup.

const LOCK_TIMEOUT_MS = 3_000;
const BROKEN_LOCK_MS = 5_000;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

export class ChaliceStore {
  constructor({ directory = DEFAULT_DIR, namespace = 'default' } = {}) {
    this.dir = join(resolve(String(directory)), String(namespace).replace(/[^\w.-]+/g, '_'));
    this.path = join(this.dir, 'state.json');
    this.lockPath = join(this.dir, '.lock');
  }

  read() {
    try {
      const s = JSON.parse(readFileSync(this.path, 'utf8'));
      return { v: 1, duty: s.duty ?? {}, fol: s.fol ?? {}, supply: s.supply ?? {},
               tickets: Array.isArray(s.tickets) ? s.tickets : [] };
    } catch { return { v: 1, duty: {}, fol: {}, supply: {}, tickets: [] }; }
  }

  /** Apply `fn(state) -> result` atomically. `fn` mutates the state it is given. */
  update(fn, now = Date.now()) {
    mkdirSync(this.dir, { recursive: true });
    const fd = this.#lock();
    try {
      const state = this.read();
      const result = fn(state, now);
      // Old tickets go, so the file cannot grow for ever.
      state.tickets = state.tickets.filter(t =>
        now - (t.updated_at ?? t.at ?? 0) < 60 * 60_000 &&
        !(['done', 'abandoned'].includes(t.status) && now - (t.updated_at ?? 0) > 10 * 60_000));
      const tmp = this.path + '.' + process.pid + '.tmp';
      writeFileSync(tmp, JSON.stringify(state, null, 1));
      renameSync(tmp, this.path);
      return result;
    } finally {
      try { closeSync(fd); } catch {}
      try { unlinkSync(this.lockPath); } catch {}
    }
  }

  #lock() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        fsyncSync(fd);
        return fd;
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e;
        try {
          const owner = JSON.parse(readFileSync(this.lockPath, 'utf8'));
          const dead = owner?.pid && owner.pid !== process.pid && !pidAlive(owner.pid);
          if (dead || Date.now() - statSync(this.lockPath).mtimeMs > BROKEN_LOCK_MS) unlinkSync(this.lockPath);
        } catch {}
        if (Date.now() >= deadline) throw new Error(`chalice store stayed locked for ${LOCK_TIMEOUT_MS}ms`);
        Atomics.wait(LOCK_WAIT, 0, 0, 5);
      }
    }
  }

  // ---- travellers
  request(traveller, { room, kind = 'ride', ttlMs = CHALICE_DEFAULTS.ticket_ttl_ms, items = null } = {}, now = Date.now()) {
    return this.update(s => {
      expire(s, now, ttlMs);
      const live = s.tickets.find(t => sameName(t.traveller, traveller) && t.kind === kind && isLive(t));
      if (live) return { ...live };
      const t = { id: `${kind}-${now}-${Math.random().toString(36).slice(2, 7)}`, kind, traveller,
                  room, at: now, status: 'open', by: null, updated_at: now, ...(items ? { items } : {}) };
      s.tickets.push(t);
      return { ...t };
    }, now);
  }

  ticket(id) { return this.read().tickets.find(t => t.id === id) ?? null; }

  mark(id, status, extra = {}, now = Date.now()) {
    return this.update(s => {
      const t = s.tickets.find(x => x.id === id);
      if (!t) return null;
      Object.assign(t, extra, { status, updated_at: now });
      return { ...t };
    }, now);
  }

  // ---- servers
  /** The oldest open ticket of `kind`, claimed for `by`; null when there is none. */
  claimNext(by, { kind = 'ride', ttlMs = CHALICE_DEFAULTS.ticket_ttl_ms } = {}, now = Date.now()) {
    return this.update(s => {
      expire(s, now, ttlMs);
      const t = s.tickets.filter(x => x.kind === kind && x.status === 'open' && !sameName(x.traveller, by))
        .sort((a, b) => a.at - b.at)[0];
      if (!t) return null;
      Object.assign(t, { status: 'claimed', by, updated_at: now });
      return { ...t };
    }, now);
  }

  openCount(kind = 'ride') { return this.read().tickets.filter(t => t.kind === kind && t.status === 'open').length; }

  /** Open tickets of `kinds` filed by `traveller`, oldest first. */
  openFrom(traveller, kinds = []) {
    return this.read().tickets.filter(t => kinds.includes(t.kind) && t.status === 'open'
      && sameName(t.traveller, traveller)).sort((a, b) => a.at - b.at);
  }

  // ---- duty
  duty() { return this.read().duty ?? {}; }

  setDuty(patch, now = Date.now()) {
    return this.update(s => { s.duty = { ...s.duty, ...patch, seen_at: now }; return { ...s.duty }; }, now);
  }

  // ---- the holder's supply, and the travellers' pledges to restock it
  supply() { return this.read().supply ?? {}; }

  setSupply({ have, target }, now = Date.now()) {
    return this.update(s => {
      s.supply = { ...(s.supply ?? {}), have, target, at: now,
                   pledged: (s.supply?.pledged ?? []).filter(p => now - (p.at ?? 0) < 60 * 60_000) };
      return { ...s.supply };
    }, now);
  }

  /** Take on part of the shortfall. Returns what was granted, never more than is short. */
  pledge(by, wants, now = Date.now()) {
    return this.update(s => {
      const supply = (s.supply ??= {});
      supply.pledged = (supply.pledged ?? []).filter(p => !sameName(p.by, by));
      const short = holderShortfall(supply, { now });
      const granted = {};
      for (const [item, n] of Object.entries(wants)) {
        const g = Math.min(n, short[item] ?? 0);
        if (g > 0) { granted[item] = g; supply.pledged.push({ by, item, amount: g, at: now }); }
      }
      return granted;
    }, now);
  }

  unpledge(by, now = Date.now()) {
    return this.update(s => {
      if (s.supply?.pledged) s.supply.pledged = s.supply.pledged.filter(p => !sameName(p.by, by));
      return true;
    }, now);
  }

  // ---- forces of light: the holder's clock, shared so the room's occupants can ask in time
  fol() { return this.read().fol ?? {}; }

  /** Record a lit room and close every open request for it -- one cast answers them all. */
  litFol({ room, until, by }, now = Date.now()) {
    return this.update(s => {
      s.fol = { room, until, by, at: now };
      for (const t of s.tickets)
        if (t.kind === 'fol' && isLive(t)) Object.assign(t, { status: 'done', updated_at: now, by });
      return { ...s.fol };
    }, now);
  }
}

const isLive = t => !['done', 'abandoned'].includes(t.status);

function expire(s, now, ttlMs) {
  for (const t of s.tickets)
    if (isLive(t) && now - (t.updated_at ?? t.at) > ttlMs)
      Object.assign(t, { status: 'abandoned', note: 'expired', updated_at: now });
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
}

/** The store a keeper should use, scoped to its fleet. */
export function chaliceStoreFor({ fleet = null, directory = null } = {}) {
  return new ChaliceStore({
    directory: directory || process.env.M59_CHALICE_DIR || DEFAULT_DIR,
    namespace: fleet || process.env.M59_FLEET || 'default',
  });
}
