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
  // EMERALDS THE HOLDER NEVER SPENDS ON FORCES OF LIGHT, because they are his way out. His
  // supply trip starts with a Rescue from the post (DUM's `caster-rescue-to-shop`), which
  // costs one emerald (rescue.kod:56) and which DUM refuses unless one survives its own
  // `emerald_reserve` of two -- so three on hand is the least that still rescues. Forces of
  // light takes one emerald a cast and used to take the last one: measured on prod
  // 2026-09-24, two of twelve supply trips walked out to Barloque because the pack held zero
  // emeralds, and the 21:19Z one ended in a death in Ukgoth. 0 switches the floor off.
  rescue_emeralds: 3,
  // REAGENTS THE HOLDER NEVER SPENDS ON A SERVICE, for a job that is not the desk's. Operator,
  // 2026-09-26: Loial keeps at least 21 orc teeth for the ghost raid, so a reveal (3 teeth)
  // stops at 24 rather than eating into them. `{item: count}`, added to the Rescue emeralds in
  // `reagentFloor`, so the desk menu, reveal, forces of light and desk practice all honour it.
  holder_keep: Object.freeze({}),
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

  // THE HUMAN DESK. Operator, 2026-09-25: logging in as the holder used to switch the service
  // off for the whole fleet, because the keeper that served was the thing the login displaced.
  // With this on, a server whose body a person is playing (the broker writes that into this
  // store) stays listed as serving, and a request is sent to that person as a tell instead of
  // waiting for a keeper that is not coming. m59-research design/research-spec-human-service-bot.md.
  human_desk: true,
  // How long a traveller waits for a PERSON to hand the cup over before walking. Shorter than
  // `wait_ms` on purpose: a keeper that has claimed the ticket is coming; a person may be AFK.
  human_wait_ms: 60_000,
  // Each "hold on" from the person buys this much more...
  human_hold_ms: 120_000,
  // ...up to this much in all, counted from the request. Past it the walk is taken whatever
  // was said, because a promise nobody keeps is how a traveller stands in room 2 for an hour.
  human_max_wait_ms: 300_000,
  // How long a BOT server holds its offer open for a PERSON to counter. A keeper counters
  // inside a second; a person has to find the trade window first.
  human_offer_ms: 45_000,
  // One tell per kind per server per this long. Five farmers in room 38 each asking for
  // forces of light is one tell to a person, not five every thirty seconds.
  human_tell_gap_ms: 90_000,
  // HOW LONG A TRAVELLER HOLDING A PERSON'S CUP WAITS FOR A REMOVE CURSE before drinking anyway.
  // Measured on prod 2026-09-25: two riders stood in room 2 with the fleet's cup for 35-45s
  // waiting on a service the person had no reason to know was holding them up.
  human_service_ms: 30_000,
});

// A HUMAN MARK IS LIVE ONLY WHILE IT IS FRESH. The broker refreshes it every thirty seconds
// while the client runs; a broker that died with a mark on disk must not leave the fleet
// telling a person who logged off hours ago.
export const HUMAN_FRESH_MS = 90_000;

const NUMBERS = {
  station_room: [1, 100_000], max_detour_hops: [0, 20], wait_ms: [10_000, 900_000],
  landing_ms: [20_000, 120_000], serve_ms: [20_000, 600_000], tip_amount: [0, 100_000],
  tip_min: [0, 100_000], handover_below_casts: [0, 1000], ticket_ttl_ms: [60_000, 3_600_000],
  fol_lead_ms: [0, 60_000], restock_per_trip: [0, 1000], reveal_max: [0, 10],
  restock_budget: [0, 100_000], pvp_block_ms: [0, 3_600_000], rescue_emeralds: [0, 100],
  human_wait_ms: [10_000, 600_000], human_hold_ms: [10_000, 900_000],
  human_max_wait_ms: [30_000, 1_800_000], human_offer_ms: [8_000, 180_000],
  human_tell_gap_ms: [0, 900_000], human_service_ms: [5_000, 300_000],
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
    if (k === 'uncurse' || k === 'reveal' || k === 'human_desk') { out[k] = v !== false; continue; }
    if (k === 'holder_keep') {
      const keep = {};
      if (v && typeof v === 'object' && !Array.isArray(v))
        for (const [item, n] of Object.entries(v)) {
          const want = Math.floor(Number(n));
          if (String(item).trim() && Number.isFinite(want) && want >= 0) keep[String(item).trim().toLowerCase()] = want;
          else problems.push(`holder_keep.${item} must be a count of zero or more`);
        }
      else if (v != null) problems.push('holder_keep must be {item: count}');
      out.holder_keep = keep;
      continue;
    }
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
          // ORC TEETH ARE FARMED, NEVER BOUGHT (operator, 2026-09-25). No merchant is known to
          // stock them anyway; this makes the rule survive somebody adding one.
          if (/orc\s*tooth|orc\s*teeth/i.test(String(item))) {
            problems.push(`supply_shops.${item} refused: orc teeth come from farming, never a counter`);
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
  if (out.human_max_wait_ms < out.human_wait_ms) out.human_max_wait_ms = out.human_wait_ms;
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

/**
 * What a character must keep back from its own spells, by reagent. Only the holder keeps
 * anything: it is the one whose supply trip starts with a Rescue. See `rescue_emeralds`.
 */
export function reagentFloor(cfg, role) {
  if (role !== 'holder') return {};
  const out = {};
  for (const [item, n] of Object.entries(cfg?.holder_keep ?? {}))
    if (Number(n) > 0) out[item] = Math.floor(Number(n));
  const n = Math.floor(Number(cfg?.rescue_emeralds) || 0);
  if (n > 0) out.emerald = (out.emerald ?? 0) + n;
  return out;
}

/**
 * Casts of a spell the pack can pay for without dipping below `floor`. `have` maps a reagent
 * to the count on hand; `reagents` is the spell's `[[name, per_cast], ...]`.
 */
export function castsAbove(have, reagents, floor = {}) {
  let casts = Infinity;
  for (const [name, per] of reagents) {
    const spare = Math.max(0, (Number(have[name]) || 0) - (Number(floor[name]) || 0));
    casts = Math.min(casts, Math.floor(spare / per));
  }
  return Number.isFinite(casts) ? casts : 0;
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
                             humans = null, now = Date.now() } = {}) {
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
  const desk = servingDesk(duty, cfg, now, humans);
  if (!desk) return { ride: false, why: 'nobody is on chalice duty right now' };
  if (desk.human)
    return { ride: true, server: desk.server, human: true,
             why: `${desk.server} is on duty at ${cfg.station_room}, played by a person — asking by tell` };
  return { ride: true, server: desk.server, why: `${desk.server} is on duty at ${cfg.station_room}` };
}

/** Who is carrying the cup and serving, per the duty record. null when nobody is. */
export function servingCharacter(duty, cfg, now = Date.now(), humans = null) {
  return servingDesk(duty, cfg, now, humans)?.server ?? null;
}

/**
 * `{server, human}` — who is serving, and whether a PERSON is at its controls. null when
 * nobody is.
 *
 * A PERSON PLAYING THE SERVER KEEPS THE DESK OPEN. The login displaces the keeper, so every
 * keeper-written fact about it goes stale at once: `paused` stays wherever it was left and
 * `seen_at` stops moving. Neither is evidence the service stopped — the person is standing
 * there with the cup. Only `lost` still closes it, because a person cannot hand over a cup
 * nobody has.
 */
export function servingDesk(duty, cfg, now = Date.now(), humans = null) {
  const d = duty ?? {};
  const who = d.with || cfg?.holder || null;
  if (!who) return null;
  if (cfg?.human_desk !== false && humanMark(humans, who, now)) {
    if (d.lost) return null;
    return { server: who, human: true };
  }
  if (!d.with) return { server: who, human: false };   // never recorded: the holder, by default
  if (d.lost) return null;
  if (d.paused) return null;                         // its body is somebody else's right now
  // A record nobody has refreshed for a long while is a keeper that stopped, not a server.
  if (Number.isFinite(d.seen_at) && now - d.seen_at > 15 * 60_000) return null;
  return { server: d.with, human: false };
}

/** Whoever should receive the holder's restock: the server on duty, else the holder. */
export function servingOrHolder(duty, cfg, humans = null) {
  return servingCharacter(duty, cfg, Date.now(), humans) ?? cfg?.holder ?? null;
}

// ------------------------------------------------------------------------------ the human desk
//
// The broker is the only process that knows a person is at a client, and the keepers cannot
// ask it (importing the broker RUNS it), so it writes that fact here: one mark per piloted
// character, refreshed while the client lives. Everything below reads those marks.

/** The live mark for `name`, or null. A mark goes dead when stale or when its client exits. */
export function humanMark(humans, name, now = Date.now(), alive = pidAlive) {
  if (!humans || !name) return null;
  const m = humans[String(name).trim().toLowerCase()];
  if (!m) return null;
  if (!(now - (Number(m.seen_at) || 0) < HUMAN_FRESH_MS)) return null;
  if (m.pid && !alive(m.pid)) return null;
  return m;
}

/** The tell a requester sends a person. The operator's format, 2026-09-25. */
export const serviceTellText = (what) => `~B~k[Service Request] ~b ${String(what).trim()}`;
/** And what a server says back to a person who asked it for something. */
export const serviceReplyText = (what) => `~B~k[Service] ~b ${String(what).trim()}`;

// WHAT THE DESK OFFERS, with the reason for anything it cannot do right now. Labels are
// what the person types back, so they are also what `parseDeskRequest` matches.
export const DESK_SERVICES = Object.freeze([
  { kind: 'uncurse', label: 'Remove Curse' },
  { kind: 'reveal', label: 'Reveal' },
  { kind: 'ride', label: 'Chalice' },
  { kind: 'fol', label: 'Forces of Light' },
]);

/**
 * The menu, computed by the server from what it holds. Pure.
 *
 * `have` is reagent counts; `floor` is what the server keeps back (the Rescue emeralds, see
 * `reagentFloor`); `casts` is forces-of-light casts on hand above that floor; `cup` is
 * whether this server carries the chalice. remcurse.kod:55 is one emerald; reveal.kod:55 is
 * three orc teeth.
 */
export function deskMenu({ cfg, have = {}, floor = {}, casts = 0, cup = false } = {}) {
  const spare = (k) => Math.max(0, (Number(have[k]) || 0) - (Number(floor[k]) || 0));
  const out = [];
  for (const s of DESK_SERVICES) {
    if (s.kind === 'uncurse' && cfg?.uncurse === false) continue;
    if (s.kind === 'reveal' && cfg?.reveal === false) continue;
    if (s.kind === 'fol' && cfg?.fol_room == null) continue;
    let why = null;
    if (s.kind === 'uncurse' && spare('emerald') < 1) why = 'Req. reagents';
    if (s.kind === 'reveal' && spare('orc tooth') < 3) why = 'Req. reagents';
    if (s.kind === 'fol' && !(casts >= 1)) why = 'Req. reagents';
    if (s.kind === 'ride' && !cup) why = 'cup is elsewhere';
    out.push({ kind: s.kind, label: s.label, ok: !why, why });
  }
  return out;
}

/** "Remove Curse, Reveal ~r(-Req. reagents)~k, Chalice, Forces of Light" */
export const formatDeskMenu = (menu = []) =>
  menu.map(m => (m.ok ? m.label : `${m.label} ~r(-${m.why})~k`)).join(', ');

const words = (text) => String(text ?? '').toLowerCase().replace(/[.!?,;:"']+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * What a PERSON asked a server for, by tell. The whole message must be the request — this is
 * a desk, not a parser, and "can you remove curse later" is chat. null when it is not one.
 */
export function parseDeskRequest(text) {
  const t = words(text);
  if (!t) return null;
  if (/^(services?|menu|list|what do you (offer|have))$/.test(t)) return { kind: 'menu' };
  if (/^(cancel|never ?mind|nvm|forget it)$/.test(t)) return { kind: 'cancel' };
  if (/^(remove ?curse|uncurse|remcurse)$/.test(t)) return { kind: 'uncurse' };
  if (/^reveal$/.test(t)) return { kind: 'reveal' };
  if (/^(chalice|chalice of the rain|ride|cup)$/.test(t)) return { kind: 'ride' };
  const fol = t.match(/^(forces of light|forces|fol|light)(?: (?:in|into|at|room) ?(\d+))?$/);
  if (fol) return { kind: 'fol', ...(fol[2] ? { room: Number(fol[2]) } : {}) };
  return null;
}

/**
 * What a PERSON serving said back to a requester's tell. `hold`: I am coming, wait for me.
 * `decline`: not now, walk. `done`: served. null: not an answer to a request.
 */
export function parseDeskReply(text) {
  const t = words(text);
  if (!t) return null;
  if (/^(done|served|there you go|all done|lit|cast)$/.test(t)) return { kind: 'done' };
  if (/^(no|nope|can ?t|cannot|not now|busy|walk|go ahead|go|decline|declined|sorry|skip)( .*)?$/.test(t))
    return { kind: 'decline' };
  if (/^(hold on|hold|wait|one sec|1 sec|a sec|sec|one min|1 min|a min|min|moment|coming|brb|on my way|omw|ok|okay|sure|yes|yep)( .*)?$/.test(t))
    return { kind: 'hold' };
  return null;
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
      // THE REST IS KEPT. This used to rebuild the state from four known keys, so any writer
      // on older code erased whatever a newer one had added. `human`, `desk` and `told` are
      // written by the broker and must survive a keeper's read-modify-write.
      return { ...s, v: 1, duty: s.duty ?? {}, fol: s.fol ?? {}, supply: s.supply ?? {},
               human: s.human ?? {}, desk: s.desk ?? {}, told: s.told ?? {},
               tickets: Array.isArray(s.tickets) ? s.tickets : [] };
    } catch { return { v: 1, duty: {}, fol: {}, supply: {}, human: {}, desk: {}, told: {}, tickets: [] }; }
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
  // `human`: a PERSON filed this (the broker, on their tell), so the server answers at a
  // person's pace. `server`: a person is SERVING it, so it was sent to them as a tell.
  request(traveller, { room, kind = 'ride', ttlMs = CHALICE_DEFAULTS.ticket_ttl_ms, items = null,
                       human = false, server = null } = {}, now = Date.now()) {
    return this.update(s => {
      expire(s, now, ttlMs);
      const live = s.tickets.find(t => sameName(t.traveller, traveller) && t.kind === kind && isLive(t));
      if (live) return { ...live, existing: true };
      const t = { id: `${kind}-${now}-${Math.random().toString(36).slice(2, 7)}`, kind, traveller,
                  room, at: now, status: 'open', by: null, updated_at: now, ...(items ? { items } : {}),
                  ...(human ? { human: true } : {}), ...(server ? { human_server: server } : {}) };
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
  // `humanOnly`: only a ticket a PERSON filed. Uncurse and reveal tickets a keeper files are
  // served inside its ride and read as `open` there, so claiming one would take it from that ride.
  claimNext(by, { kind = 'ride', ttlMs = CHALICE_DEFAULTS.ticket_ttl_ms, humanOnly = false } = {}, now = Date.now()) {
    return this.update(s => {
      expire(s, now, ttlMs);
      const t = s.tickets.filter(x => x.kind === kind && x.status === 'open' && !sameName(x.traveller, by)
                                  && (!humanOnly || x.human))
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

  // ---- the human desk: who a person is playing, and what a person said back

  /** Every mark, dead ones included; `humanMark` decides which are live. */
  humans() { return this.read().human ?? {}; }

  /** The broker's record that a person is playing `character`. Refreshed while it lasts. */
  setHuman(character, { agent = null, pid = null, since = null } = {}, now = Date.now()) {
    const key = String(character ?? '').trim().toLowerCase();
    if (!key) return null;
    return this.update(s => {
      const prior = s.human?.[key];
      s.human = { ...(s.human ?? {}),
        [key]: { character, agent, pid, since: since ?? prior?.since ?? now, seen_at: now } };
      return { ...s.human[key] };
    }, now);
  }

  clearHuman(character, now = Date.now()) {
    const key = String(character ?? '').trim().toLowerCase();
    return this.update(s => {
      const was = s.human?.[key] ?? null;
      if (s.human) delete s.human[key];
      return was;
    }, now);
  }

  /**
   * "Hold on": every live ticket from `traveller` waits `ms` longer, never past `maxMs` from
   * when it was filed. Returns the tickets it touched.
   */
  hold(traveller, { by = null, ms = CHALICE_DEFAULTS.human_hold_ms,
                    maxMs = CHALICE_DEFAULTS.human_max_wait_ms } = {}, now = Date.now()) {
    return this.update(s => {
      const out = [];
      for (const t of s.tickets) {
        if (!isLive(t) || !sameName(t.traveller, traveller)) continue;
        const until = Math.min(now + ms, (t.at ?? now) + maxMs);
        Object.assign(t, { hold_until: Math.max(t.hold_until ?? 0, until), holds: (t.holds ?? 0) + 1,
                           held_by: by, updated_at: now });
        out.push({ ...t });
      }
      return out;
    }, now);
  }

  /** "Not now" or "done": close every live ticket from `traveller`, saying who closed it. */
  closeFrom(traveller, status, { by = null, note = null, kinds = null } = {}, now = Date.now()) {
    return this.update(s => {
      const out = [];
      for (const t of s.tickets) {
        if (!isLive(t) || !sameName(t.traveller, traveller)) continue;
        if (kinds && !kinds.includes(t.kind)) continue;
        Object.assign(t, { status, updated_at: now, by: t.by ?? by, note: note ?? t.note ?? null,
                           closed_by: by });
        out.push({ ...t });
      }
      return out;
    }, now);
  }

  /**
   * One tell per `key` per `gapMs`, fleet-wide. True means "you send it"; the stamp is taken
   * in the same locked write, so two keepers cannot both win.
   */
  claimTell(key, gapMs = CHALICE_DEFAULTS.human_tell_gap_ms, now = Date.now()) {
    return this.update(s => {
      s.told = Object.fromEntries(Object.entries(s.told ?? {}).filter(([, at]) => now - at < 60 * 60_000));
      if (now - (s.told[key] ?? 0) < gapMs) return false;
      s.told[key] = now;
      return true;
    }, now);
  }

  /** The server's own menu, so whoever answers "services?" answers from its facts. */
  desk() { return this.read().desk ?? {}; }

  // `limits`: the server's own hold and wait numbers, so the broker honours the strategy's
  // configuration without having to load the strategy itself.
  setDesk(server, { menu = [], room = null, fol_room = null, limits = null } = {}, now = Date.now()) {
    const key = String(server ?? '').trim().toLowerCase();
    if (!key) return null;
    return this.update(s => {
      s.desk = { ...(s.desk ?? {}), [key]: { server, menu, room, fol_room, ...(limits ? { limits } : {}), at: now } };
      return { ...s.desk[key] };
    }, now);
  }
}

const isLive = t => !['done', 'abandoned'].includes(t.status);

function expire(s, now, ttlMs) {
  for (const t of s.tickets)
    if (isLive(t) && now - (t.updated_at ?? t.at) > ttlMs && !(Number(t.hold_until) > now))
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
