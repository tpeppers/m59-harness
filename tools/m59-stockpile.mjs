// THE LIVE REAGENT STOCKPILE — the half of the guild chests that gives things BACK.
//
// The fleet already has the outbound half and it works: `guildKeepTest` marks an item the
// guild is short of as KEEP rather than sell (m59-guildwants.mjs:219, wired at
// m59-autopilot.mjs:3662), and `contributionPlan` deposits it on the next town trip while
// leaving the contributor its own loadout floor. What has never existed is the RECIPROCAL:
// a character that needs elderberry walks past a chest holding three hundred of them and
// buys more at the apothecary.
//
// That is the whole feature. Every unit that moves donor -> chest -> recipient instead of
// donor -> merchant -> recipient saves the SPREAD: the buy price avoided plus the sell price
// forgone. A hall costing 12,000 a day has to be paid for in something, and this is the only
// mechanism here that pays it in a number rather than in sentiment.
//
// WHO WANTS WHAT IS NOT A FILE. `substrate/guild-plan.json` is a curated per-slot target
// list, and it cannot know that Beaker is four elderberry short this afternoon. The wants
// here are DERIVED from what each character is actually short of against its own loadout
// floor, which is the same floor `contributionPlan` already refuses to take from. One
// quantity, read the same way on both sides — a donor's floor and a recipient's want are
// the same number seen from opposite ends, and they must never be computed differently or
// the fleet will ship elderberry back and forth for ever.
//
// THE MENAGERIE COUNTS AS THE FLEET FOR STORAGE AND NOT FOR ANYTHING ELSE. Marco Polo and
// Loial cannot enter the hall — see `canEnterHall` — but their wants are real and their
// supplies are real, so they are unioned into the stockpile's accounting and served through
// `Help_Outsider`. This is deliberately the one place the menagerie is not held at arm's
// length: "the fleet" never means them for ORDERS, and a reagent is not an order.
//
// AND THE DOOR IS NOT ABOUT HEALTH. `CanEnter` (ghall.kod:1039) tests guild membership (or
// an ally guild) AND `GetRank(who) >= RANK_SIR` — its own docstring says "but not their
// apprentices". So a brand-new member at rank 1 is locked out of the hall it just joined,
// which is a case worth naming because nothing announces it. Sub-30-max-health characters
// are excluded transitively rather than directly: they cannot be guild members at all
// (PFLAG_PKILL_ENABLE, invitat.kod:174), so they fail the membership half, not a door check.
import { RANK } from './m59-guild.mjs';
import { CHEST_BULK_MAX } from './m59-storage.mjs';

export const REAGENTS = Object.freeze(['elderberry', 'herbs']);

const norm = (s) => String(s ?? '').trim().toLowerCase();
const countIn = (items, item) => (items ?? [])
  .filter(i => norm(i.name ?? i.item) === norm(item))
  .reduce((n, i) => n + (Number(i.amount ?? i.count ?? 1) || 0), 0);

// ---------------------------------------------------------------- who is short of what
//
// A WANT IS A SHORTFALL AGAINST THE CHARACTER'S OWN FLOOR, never an appetite. The floor is
// `loadout.carry[].min`, which is exactly what `contributionPlan` protects when it decides
// what a donor may part with. Reading it the same way on both sides is the only thing
// stopping a donor giving away the elderberry it is about to want back.
export function reagentWants({ characters = [], reagents = REAGENTS } = {}) {
  const wants = new Map();
  for (const c of characters) {
    if (c?.in_game === false) continue;
    for (const item of reagents) {
      const key = norm(item);
      const floor = Math.max(0, Number(
        (c.loadout?.carry ?? []).find(r => norm(r.item) === key)?.min ?? 0) || 0);
      if (!floor) continue;
      const have = countIn(c.pack, key);
      const short = Math.max(0, floor - have);
      if (!short) continue;
      const row = wants.get(key) ?? { item: key, want: 0, by: [] };
      row.want += short;
      row.by.push({ agent: c.agent ?? null, character: c.character ?? null,
                    short, floor, have, menagerie: !!c.menagerie });
      wants.set(key, row);
    }
  }
  return wants;
}

// ---------------------------------------------------------------- may this one open it
//
// ghall.kod:1039. Membership (or an ALLY guild) AND rank >= SIR. Returned as a reason
// rather than a boolean, because every caller wants to say WHY somebody is being served by
// a courier instead of walking in themselves.
export function canEnterHall({ guildId = null, rank = null, hallGuildId = null,
                               allyGuildIds = [] } = {}) {
  if (hallGuildId == null) return { ok: true, why: 'the hall has no owner, so it is open' };
  if (guildId == null)
    return { ok: false, why: 'not in a guild — CanEnter refuses a non-member (ghall.kod:1039)' };
  const mine = guildId === hallGuildId || allyGuildIds.includes(guildId);
  if (!mine)
    return { ok: false, why: 'in a different guild, and not an ally of the hall owner' };
  if (!(Number(rank) >= RANK.SIR))
    return { ok: false, rank,
             why: `rank ${rank} is below SIR (${RANK.SIR}) — CanEnter admits members but ` +
                  `"not their apprentices" (ghall.kod:1039). Promote before expecting entry` };
  return { ok: true, why: null };
}

// ---------------------------------------------------------------- take, or buy
//
// THE POINT OF THE WHOLE FEATURE, and the direction that did not exist. Ask the chests
// before the merchant, take what is there, buy only the remainder.
//
// AN UNOPENED CHEST IS NOT AN EMPTY ONE. Chest contents are never pushed by the server, so
// the cache is only ever as good as the last look — and `never_opened` means nobody has
// EVER looked. Treating that as empty would send a character to buy what it is standing on;
// treating it as full would send it home empty. So it is reported as unknown and the buy
// goes ahead, which is the safe direction: buying something you already own wastes money,
// and not buying something you do not own wastes the trip AND the casting.
export function sourcePlan({ need = [], chests = [], available = true, why = null } = {}) {
  const fromChest = [], toBuy = [], notes = [];
  if (!available) {
    for (const n of need) toBuy.push({ item: norm(n.item), amount: n.amount });
    return { fromChest, toBuy, unknown: [],
             why: why ?? 'the guild store is not available', consulted: false };
  }
  const unknown = [];
  // One pool per hall, so a slot that has been read is spent down as claims are made
  // against it and cannot promise the same stack twice.
  const left = new Map();
  for (const c of chests) {
    if (!c || c.never_opened || !Array.isArray(c.items)) { unknown.push(c?.slot ?? null); continue; }
    for (const it of c.items) {
      const k = `${c.slot}:${norm(it.name ?? it.item)}`;
      left.set(k, (left.get(k) ?? 0) + (Number(it.amount ?? 1) || 0));
    }
  }
  for (const n of need) {
    const item = norm(n.item);
    let want = Math.max(0, Number(n.amount) || 0);
    if (!want) continue;
    for (const c of chests) {
      if (want <= 0) break;
      if (!c || c.never_opened || !Array.isArray(c.items)) continue;
      const k = `${c.slot}:${item}`;
      const have = left.get(k) ?? 0;
      if (have <= 0) continue;
      const take = Math.min(have, want);
      fromChest.push({ slot: c.slot, item, amount: take });
      left.set(k, have - take);
      want -= take;
    }
    if (want > 0) toBuy.push({ item, amount: want });
  }
  if (unknown.length) notes.push(
    `chest slot(s) ${unknown.join(', ')} have never been opened, so what they hold is ` +
    `unknown and was NOT counted — the shortfall is being bought rather than assumed`);
  return { fromChest, toBuy, unknown, consulted: true,
           why: notes.length ? notes.join('; ') : null };
}

// ---------------------------------------------------------------- what it saved
//
// THE SPREAD, NOT THE PRICE. A unit taken from the chest avoids a purchase AND forgoes a
// sale, and the saving is both halves — that is the number that has to beat 12,000 a day.
//
// PRICES ARE OBSERVED, NEVER ASSUMED. A merchant's price is a live quote and this module
// has no business inventing one, so an unknown price contributes ZERO to the saving and is
// recorded as unpriced. A ledger that guessed would be a ledger that always justified the
// hall, which is precisely the question it exists to answer honestly.
export function savingsOf({ item, amount, buyPrice = null, sellPrice = null } = {}) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  const buy = Number.isFinite(Number(buyPrice)) && buyPrice !== null ? Number(buyPrice) : null;
  const sell = Number.isFinite(Number(sellPrice)) && sellPrice !== null ? Number(sellPrice) : null;
  const buy_avoided = buy === null ? 0 : buy * n;
  const sell_forgone = sell === null ? 0 : sell * n;
  return { item: norm(item), amount: n, buy_avoided, sell_forgone,
           saved: buy_avoided + sell_forgone,
           unpriced: buy === null || sell === null,
           ...(buy === null || sell === null
             ? { why: 'a missing price contributes ZERO rather than a guess — an optimistic ' +
                      'ledger would always justify the hall it is meant to be judging' }
             : {}) };
}

// Sum a run of transfers into the figure the hall is judged on.
export function stockpileLedger(entries = []) {
  const out = { moves: 0, units: 0, buy_avoided: 0, sell_forgone: 0, saved: 0,
                unpriced_moves: 0, by_item: {} };
  for (const e of entries) {
    out.moves++; out.units += e.amount || 0;
    out.buy_avoided += e.buy_avoided || 0;
    out.sell_forgone += e.sell_forgone || 0;
    out.saved += e.saved || 0;
    if (e.unpriced) out.unpriced_moves++;
    const row = out.by_item[e.item] ?? { units: 0, saved: 0 };
    row.units += e.amount || 0; row.saved += e.saved || 0;
    out.by_item[e.item] = row;
  }
  return out;
}

// Does the stockpile pay for the hall? Stated as a rate against the rent it has to beat.
export function paysForHall({ saved = 0, days = 1, rentPerDay = 12_000 } = {}) {
  const d = Math.max(days, 1 / 24);
  const perDay = saved / d;
  return { per_day: Math.round(perDay), rent_per_day: rentPerDay,
           covers: perDay >= rentPerDay,
           shortfall_per_day: Math.max(0, Math.round(rentPerDay - perDay)) };
}

// ---------------------------------------------------------------- Help_Outsider
//
// SOMEBODY WHO CANNOT OPEN THE DOOR STILL NEEDS THE ELDERBERRY. The courier is whoever is
// next going through the hall's town anyway — the errand is a hand-over bolted onto a trip
// that was already happening, never a trip of its own, because a dedicated round trip for
// two reagents costs more than the reagents.
//
// A REQUEST IS SERVED BY SOMEBODY WHO CAN ACTUALLY GET IN, which is not the same as "in the
// guild": an apprentice is a member and is refused at the door (ghall.kod:1039). So the
// courier is checked with `canEnterHall` exactly like anyone else, and a fleet whose members
// are all apprentices can serve nobody — worth saying out loud, because the symptom would
// otherwise be requests that silently never clear.
export function outsiderPlan({ requests = [], couriers = [], chests = [],
                               available = true } = {}) {
  const able = [], unable = [];
  for (const c of couriers) {
    const entry = canEnterHall(c);
    (entry.ok ? able : unable).push({ ...c, why: entry.why });
  }
  if (!able.length)
    return { served: [], unserved: requests.map(r => ({ ...r,
               why: 'nobody available can get through the hall door' })),
             couriers: { able, unable },
             why: unable.length
               ? `every candidate courier is refused at the door (${unable[0].why})`
               : 'no couriers offered' };

  // One courier per pass takes the whole queue it can fill: the walk is already paid for,
  // and splitting a queue across couriers means two characters standing in the same chest.
  const courier = able[0];
  const plan = sourcePlan({ need: requests.map(r => ({ item: r.item, amount: r.amount })),
                            chests, available });
  const taken = new Map();
  for (const f of plan.fromChest) taken.set(f.item, (taken.get(f.item) ?? 0) + f.amount);

  const served = [], unserved = [];
  for (const r of requests) {
    const item = norm(r.item);
    const have = taken.get(item) ?? 0;
    const give = Math.min(have, r.amount);
    if (give > 0) { taken.set(item, have - give); served.push({ ...r, item, give, by: courier.agent }); }
    if (give < r.amount)
      unserved.push({ ...r, item, short: r.amount - give,
                      why: 'the chests do not hold enough, and this errand does not buy' });
  }
  return { courier: courier.agent, served, unserved, withdraw: plan.fromChest,
           couriers: { able, unable },
           note: 'the courier hands these over in person after its own town business — an ' +
                 'outsider errand never justifies a trip of its own' };
}

export { CHEST_BULK_MAX };
